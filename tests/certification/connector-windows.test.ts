import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVICES, readySource } from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command, type PlatformFixture } from '../support/platform.js';

interface PlanWindow {
  mode: string;
  start: string;
  end: string;
  lookback_minutes: number;
  end_inclusive: boolean;
  captured_at: string;
}

interface WorkResult {
  acquisition_run_id: string;
  status: string;
  plan: {
    status: string;
    window: PlanWindow | null;
    start_cursor: string | null;
    end_cursor: string | null;
    checkpoint_before: { watermark: string | null; cursor: string | null };
    checkpoint_after: { watermark: string | null; cursor: string | null };
    pages: Array<{ page: number; outcome: string }>;
  } | null;
  integration_batch_id: string | null;
  records: number | null;
  error_code?: string | null;
}

function enqueue(fixture: PlatformFixture, token: string, sourceId: string, backfill?: { from: string; to: string }): void {
  const result = command(
    fixture,
    [
      'acquisition', 'enqueue', '--source', sourceId,
      ...(backfill === undefined ? [] : ['--from', backfill.from, '--to', backfill.to]),
    ],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
}

function workAt(fixture: PlatformFixture, token: string, sourceId: string, at: string): WorkResult {
  const result = command(fixture, ['acquisition', 'work', '--source', sourceId, '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkResult;
}

function checkpoint(fixture: PlatformFixture, token: string, sourceId: string): Record<string, unknown> | null {
  const result = command(fixture, ['acquisition', 'checkpoint', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output['checkpoint'] as Record<string, unknown> | null;
}

test('a half-open planner window captures its bound, resumes from the checkpoint, and a backfill never moves it', async () => {
  // ---------------------------------------------------------------------------
  // Incremental windows: half-open, lookback behind the watermark, and a bounded
  // capture so a long gap is walked in consecutive windows, never one open read.
  // ---------------------------------------------------------------------------
  const incrementalServer = await startHttpSource({
    replies: [{ body: pageBody([DEVICES[0]!]) }],
  });
  const advancing = await readySource(incrementalServer, {
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-01-01T00:00:00.000Z',
      maximum_span_minutes: 60,
      lookback_minutes: 30,
    },
  });
  const { fixture, workspaceAdministratorToken: token, sourceId } = advancing;

  // The stated clock is far ahead of the initial start, so the span caps the
  // window rather than the clock extending it, and the lookback widens the start.
  enqueue(fixture, token, sourceId);
  const first = workAt(fixture, token, sourceId, '2026-01-02T00:00:00.000Z');
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.plan?.window, {
    mode: 'incremental',
    start: '2025-12-31T23:30:00.000Z',
    end: '2026-01-01T00:30:00.000Z',
    lookback_minutes: 30,
    end_inclusive: false,
    captured_at: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(first.plan?.checkpoint_before, { watermark: null, cursor: null });
  assert.deepEqual(first.plan?.checkpoint_after, { watermark: '2026-01-01T00:30:00.000Z', cursor: null });

  // The next attempt resumes at the watermark the complete Plan left behind, so a
  // later clock reading cannot re-read or extend the interval already acquired.
  enqueue(fixture, token, sourceId);
  const second = workAt(fixture, token, sourceId, '2026-02-01T00:00:00.000Z');
  assert.equal(second.status, 'complete');
  assert.equal(second.plan?.window?.start, '2026-01-01T00:00:00.000Z');
  assert.equal(second.plan?.window?.end, '2026-01-01T01:00:00.000Z');
  assert.deepEqual(second.plan?.checkpoint_before, { watermark: '2026-01-01T00:30:00.000Z', cursor: null });
  assert.deepEqual(second.plan?.checkpoint_after, { watermark: '2026-01-01T01:00:00.000Z', cursor: null });

  const sent = incrementalServer.requests();
  assert.deepEqual(
    sent.map((request) => [request.query['from'], request.query['to']]),
    [
      ['2025-12-31T23:30:00.000Z', '2026-01-01T00:30:00.000Z'],
      ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'],
    ],
    'the endpoint is asked for exactly the half-open interval the Plan captured',
  );
  const advanced = checkpoint(fixture, token, sourceId);
  assert.deepEqual(
    { watermark: advanced?.['watermark'], cursor_state: advanced?.['cursor_state'] },
    { watermark: '2026-01-01T01:00:00.000Z', cursor_state: 'valid' },
  );
  await incrementalServer.close();

  // ---------------------------------------------------------------------------
  // Fixed windows are read once, and an inclusive end is stated to the endpoint
  // as the last instant inside the half-open bound the Plan keeps.
  // ---------------------------------------------------------------------------
  const fixedServer = await startHttpSource({ replies: [{ body: pageBody([DEVICES[1]!]) }] });
  const fixed = await readySource(fixedServer, {
    window: {
      mode: 'fixed',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-03-01T00:00:00.000Z',
      initial_end: '2026-03-02T00:00:00.000Z',
      end_inclusive: true,
    },
  });
  enqueue(fixed.fixture, fixed.workspaceAdministratorToken, fixed.sourceId);
  const fixedRun = workAt(fixed.fixture, fixed.workspaceAdministratorToken, fixed.sourceId, '2026-06-01T00:00:00.000Z');
  assert.equal(fixedRun.status, 'complete');
  assert.equal(fixedRun.plan?.window?.mode, 'fixed');
  assert.equal(fixedRun.plan?.window?.end, '2026-03-02T00:00:00.000Z');
  assert.equal(fixedRun.plan?.window?.end_inclusive, true);
  assert.equal(fixedRun.plan?.window?.captured_at, '2026-06-01T00:00:00.000Z');
  const fixedRequest = fixedServer.requests()[0];
  assert.equal(fixedRequest?.query['from'], '2026-03-01T00:00:00.000Z');
  assert.equal(fixedRequest?.query['to'], '2026-03-01T23:59:59.999Z', 'an inclusive end names the last instant inside the window');
  assert.equal(
    checkpoint(fixed.fixture, fixed.workspaceAdministratorToken, fixed.sourceId),
    null,
    'a fixed window holds no resume point to advance',
  );
  await fixedServer.close();

  // ---------------------------------------------------------------------------
  // Cursor checkpoints: the exact cursor a complete Plan stopped at is durable,
  // a refused cursor is drift that blocks the Source until it is reset, and the
  // recovery resumes from the declared initial cursor without losing the watermark.
  // ---------------------------------------------------------------------------
  const cursorServer = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2), { next: 'cursor-1' }) },
      { body: pageBody(DEVICES.slice(2, 4), { next: 'cursor-2' }) },
      { body: pageBody(DEVICES.slice(4, 5), { next: 'cursor-3' }) },
      { status: 410, body: '{"error":"cursor_expired"}' },
      { body: pageBody(DEVICES.slice(0, 2), { next: 'cursor-9' }) },
      { body: pageBody(DEVICES.slice(2, 3), { next: null }) },
    ],
  });
  const cursored = await readySource(cursorServer, {
    pagination: {
      mode: 'cursor',
      parameter: 'cursor',
      cursor_path: 'next',
      initial_cursor: 'cursor-0',
      size: 2,
      max_pages: 5,
    },
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-01-01T00:00:00.000Z',
      maximum_span_minutes: 44640,
      lookback_minutes: 0,
    },
  });
  const { fixture: cursorFixture, workspaceAdministratorToken: cursorToken, sourceId: cursorSource } = cursored;

  enqueue(cursorFixture, cursorToken, cursorSource);
  const firstCursored = workAt(cursorFixture, cursorToken, cursorSource, '2026-01-02T00:00:00.000Z');
  assert.equal(firstCursored.status, 'complete');
  assert.equal(firstCursored.plan?.start_cursor, null, 'nothing is resumed before the first checkpoint exists');
  assert.equal(firstCursored.plan?.end_cursor, 'cursor-3');
  assert.deepEqual(
    firstCursored.plan?.checkpoint_after,
    { watermark: '2026-01-02T00:00:00.000Z', cursor: 'cursor-3' },
    'a complete Plan advances both the watermark and the cursor',
  );

  // The endpoint no longer honours the cursor: the attempt fails instead of
  // silently re-reading from the beginning, and the checkpoint is marked invalid.
  enqueue(cursorFixture, cursorToken, cursorSource);
  const refused = workAt(cursorFixture, cursorToken, cursorSource, '2026-01-03T00:00:00.000Z');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error_code, 'ACQUISITION_CHECKPOINT_CURSOR_INVALID');
  assert.equal(refused.plan?.start_cursor, 'cursor-3');
  assert.equal(refused.integration_batch_id, null);
  const blocked = checkpoint(cursorFixture, cursorToken, cursorSource);
  assert.equal(blocked?.['cursor_state'], 'invalid');
  assert.equal(blocked?.['watermark'], '2026-01-02T00:00:00.000Z', 'a refused cursor never rewinds the watermark');

  // The operator's reset clears the refused cursor and keeps the watermark.
  const reset = command(cursorFixture, ['acquisition', 'checkpoint-reset', '--source', cursorSource], { token: cursorToken });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal((reset.output['checkpoint'] as Record<string, unknown>)['cursor'], null);
  assert.equal((reset.output['checkpoint'] as Record<string, unknown>)['watermark'], '2026-01-02T00:00:00.000Z');

  enqueue(cursorFixture, cursorToken, cursorSource);
  const recovered = workAt(cursorFixture, cursorToken, cursorSource, '2026-01-04T00:00:00.000Z');
  assert.equal(recovered.status, 'complete', JSON.stringify(recovered));
  assert.equal(recovered.plan?.start_cursor, null, 'recovery starts again from the declared initial cursor');
  assert.equal(cursorServer.requests().at(-2)?.query['cursor'], 'cursor-0');
  assert.equal(
    checkpoint(cursorFixture, cursorToken, cursorSource)?.['watermark'],
    '2026-01-04T00:00:00.000Z',
    'recovery still advances the watermark of the complete Plan',
  );
  await cursorServer.close();

  // ---------------------------------------------------------------------------
  // A manual backfill re-reads a historical interval without disturbing the
  // resume point: the checkpoint before and after the attempt are identical.
  // ---------------------------------------------------------------------------
  const backfillServer = await startHttpSource({ replies: [{ body: pageBody([DEVICES[2]!]) }] });
  const backfilled = await readySource(backfillServer, {
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-01-01T00:00:00.000Z',
      maximum_span_minutes: 44640,
      lookback_minutes: 0,
    },
  });
  enqueue(backfilled.fixture, backfilled.workspaceAdministratorToken, backfilled.sourceId);
  const live = workAt(backfilled.fixture, backfilled.workspaceAdministratorToken, backfilled.sourceId, '2026-01-02T00:00:00.000Z');
  assert.equal(live.status, 'complete');
  const beforeBackfill = checkpoint(backfilled.fixture, backfilled.workspaceAdministratorToken, backfilled.sourceId);

  enqueue(backfilled.fixture, backfilled.workspaceAdministratorToken, backfilled.sourceId, {
    from: '2025-06-01T00:00:00.000Z',
    to: '2025-06-02T00:00:00.000Z',
  });
  const backfillRun = workAt(backfilled.fixture, backfilled.workspaceAdministratorToken, backfilled.sourceId, '2026-01-03T00:00:00.000Z');
  assert.equal(backfillRun.status, 'complete');
  assert.deepEqual(backfillRun.plan?.window, {
    mode: 'backfill',
    start: '2025-06-01T00:00:00.000Z',
    end: '2025-06-02T00:00:00.000Z',
    lookback_minutes: 0,
    end_inclusive: false,
    captured_at: '2026-01-03T00:00:00.000Z',
  });
  assert.deepEqual(backfillRun.plan?.checkpoint_before, backfillRun.plan?.checkpoint_after);
  assert.equal(backfillRun.plan?.checkpoint_after?.watermark, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(
    checkpoint(backfilled.fixture, backfilled.workspaceAdministratorToken, backfilled.sourceId),
    beforeBackfill,
    'a manual backfill never moves the resume point of the Source',
  );
  const backfillRequest = backfillServer.requests()[1];
  assert.equal(backfillRequest?.query['from'], '2025-06-01T00:00:00.000Z');
  assert.equal(backfillRequest?.query['to'], '2025-06-02T00:00:00.000Z');

  const rejected = command(
    backfilled.fixture,
    ['acquisition', 'enqueue', '--source', backfilled.sourceId, '--from', '2025-06-02T00:00:00.000Z', '--to', '2025-06-01T00:00:00.000Z'],
    { token: backfilled.workspaceAdministratorToken },
  );
  assert.equal(rejected.status, 2, 'a backfill must state an interval that moves forward');
  await backfillServer.close();
});
