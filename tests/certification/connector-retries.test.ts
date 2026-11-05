import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVICES, readySource } from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command, type PlatformFixture } from '../support/platform.js';

interface FailedAttempt {
  raw_id: string | null;
  status: number | null;
  error_code: string;
  retry_after_ms: number | null;
}

interface WorkResult {
  acquisition_run_id: string;
  status: string;
  plan: {
    plan_id: string;
    status: string;
    pages: Array<{ page: number; outcome: string; attempts: number; failed_attempts: FailedAttempt[] }>;
  } | null;
  raw_acquisition_count: number;
  raw_acquisition_ids: string[];
  batch_raw_acquisition_count: number | null;
  integration_batch_id: string | null;
  dataset_release: number | null;
  records: number | null;
  error_code?: string | null;
}

function enqueue(fixture: PlatformFixture, token: string, sourceId: string): string {
  const result = command(fixture, ['acquisition', 'enqueue', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return String(result.output['acquisition_run_id']);
}

function work(fixture: PlatformFixture, token: string, sourceId: string): WorkResult {
  const result = command(fixture, ['acquisition', 'work', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkResult;
}

test('bounded retries honour Retry-After, and no attempt ever merges fragments or partial plans', async () => {
  // ---------------------------------------------------------------------------
  // A retryable refusal is retried, keeps its diagnostic Raw Acquisition, and
  // waits for the Retry-After the endpoint asked for rather than the base delay.
  // ---------------------------------------------------------------------------
  const retriedServer = await startHttpSource({
    replies: [
      { status: 503, body: '{"error":"busy"}', headers: { 'retry-after': '1' } },
      { body: pageBody([DEVICES[0]!]) },
    ],
  });
  const retried = await readySource(retriedServer, {
    retry: { max_attempts: 3, base_delay_ms: 10, max_delay_ms: 50, retry_on: [429, 503] },
  });
  enqueue(retried.fixture, retried.workspaceAdministratorToken, retried.sourceId);
  const retriedRun = work(retried.fixture, retried.workspaceAdministratorToken, retried.sourceId);
  assert.equal(retriedRun.status, 'complete');
  assert.equal(retriedRun.plan?.pages[0]?.attempts, 2, 'the refused attempt and its retry are both recorded on the page');
  assert.deepEqual(retriedRun.plan?.pages[0]?.failed_attempts, [
    { raw_id: retriedRun.plan?.pages[0]?.failed_attempts[0]?.raw_id, status: 503, error_code: 'ACQUISITION_RESPONSE_STATUS', retry_after_ms: 1_000 },
  ]);
  assert.equal(retriedRun.raw_acquisition_count, 2, 'a refused response is still kept as evidence');
  assert.equal(retriedRun.batch_raw_acquisition_count, 1, 'an Integration Batch holds only the accepted fragment');
  const attempts = retriedServer.requests();
  assert.equal(attempts.length, 2);
  assert.ok(
    (attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0) >= 950,
    `the retry waits for Retry-After, not the base delay: ${(attempts[1]?.at ?? 0) - (attempts[0]?.at ?? 0)}ms`,
  );
  await retriedServer.close();

  // ---------------------------------------------------------------------------
  // The attempt count is bounded: an endpoint that never recovers is given up on
  // rather than retried forever, and the checkpoint does not move.
  // ---------------------------------------------------------------------------
  const neverServer = await startHttpSource({
    replies: [{ status: 503, body: '{"error":"busy"}' }],
  });
  const never = await readySource(neverServer, {
    retry: { max_attempts: 2, base_delay_ms: 5, max_delay_ms: 5, retry_on: [503] },
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-01-01T00:00:00.000Z',
      maximum_span_minutes: 60,
      lookback_minutes: 0,
    },
  });
  enqueue(never.fixture, never.workspaceAdministratorToken, never.sourceId);
  const abandoned = work(never.fixture, never.workspaceAdministratorToken, never.sourceId);
  assert.equal(abandoned.status, 'failed');
  assert.equal(abandoned.error_code, 'ACQUISITION_RESPONSE_STATUS');
  assert.equal(abandoned.plan?.pages[0]?.attempts, 2, 'a bounded policy stops at its stated attempt count');
  assert.equal(neverServer.requests().length, 2);
  assert.equal(abandoned.integration_batch_id, null);
  assert.equal(abandoned.dataset_release, null);
  const neverCheckpoint = command(never.fixture, ['acquisition', 'checkpoint', '--source', never.sourceId], {
    token: never.workspaceAdministratorToken,
  });
  assert.equal(neverCheckpoint.output['checkpoint'], null, 'a failed attempt never advances the checkpoint');
  await neverServer.close();

  // ---------------------------------------------------------------------------
  // A plan that breaks on its second page hands over nothing, and its rerun is a
  // new Plan: the batch of the rerun holds its own fragments, never the earlier
  // attempt's, and the partial Plan is never completed later.
  // ---------------------------------------------------------------------------
  const brokenServer = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { status: 502, body: '{"error":"upstream"}' },
      { body: pageBody(DEVICES.slice(0, 1)) },
    ],
  });
  const broken = await readySource(brokenServer, {
    retry: { max_attempts: 1, base_delay_ms: 5, max_delay_ms: 5, retry_on: [503] },
  });
  enqueue(broken.fixture, broken.workspaceAdministratorToken, broken.sourceId);
  const partial = work(broken.fixture, broken.workspaceAdministratorToken, broken.sourceId);
  assert.equal(partial.status, 'failed');
  assert.equal(partial.plan?.status, 'partial');
  assert.deepEqual(partial.plan?.pages.map((page) => page.outcome), ['received', 'failed']);
  assert.equal(partial.batch_raw_acquisition_count, null, 'a partial Plan hands over no Integration Batch');
  assert.equal(partial.integration_batch_id, null);
  assert.equal(partial.dataset_release, null);
  assert.equal(partial.raw_acquisition_count, 2, 'both fragments of the failed attempt stay as evidence');

  enqueue(broken.fixture, broken.workspaceAdministratorToken, broken.sourceId);
  const rerun = work(broken.fixture, broken.workspaceAdministratorToken, broken.sourceId);
  assert.equal(rerun.status, 'complete');
  assert.notEqual(rerun.plan?.plan_id, partial.plan?.plan_id, 'a rerun is its own Plan, never the old one resumed');
  assert.deepEqual(rerun.plan?.pages.map((page) => page.outcome), ['received'], 'the new Plan reads from the start again');
  assert.equal(rerun.batch_raw_acquisition_count, 1, 'the new Batch holds only the new Plan fragments');
  assert.equal(rerun.raw_acquisition_count, 1);
  assert.deepEqual(
    rerun.raw_acquisition_ids.filter((id) => partial.raw_acquisition_ids.includes(id)),
    [],
    'no Raw Acquisition of the failed attempt is merged into the new Batch',
  );
  await brokenServer.close();

  // ---------------------------------------------------------------------------
  // A cancelled Run never becomes a Plan, a Batch, or a Release.
  // ---------------------------------------------------------------------------
  const cancelledServer = await startHttpSource({ replies: [{ body: pageBody([DEVICES[4]!]) }] });
  const cancelled = await readySource(cancelledServer);
  const cancelledRunId = enqueue(cancelled.fixture, cancelled.workspaceAdministratorToken, cancelled.sourceId);
  const cancel = command(cancelled.fixture, ['acquisition', 'cancel', '--run', cancelledRunId], {
    token: cancelled.workspaceAdministratorToken,
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(cancel.output['status'], 'cancelled');

  const empty = command(cancelled.fixture, ['acquisition', 'work', '--source', cancelled.sourceId], {
    token: cancelled.workspaceAdministratorToken,
  });
  assert.equal(empty.status, 2);
  assert.equal(empty.error['code'], 'ACQUISITION_QUEUE_EMPTY', 'a cancelled Run is no longer workable');
  assert.equal(cancelledServer.requests().length, 0, 'a cancelled Run reads nothing');
  await cancelledServer.close();
});
