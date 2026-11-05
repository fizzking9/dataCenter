import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AI_ACC_AUTH,
  AI_ACC_CONTEXT,
  AI_ACC_CONTRACT,
  AI_ACC_CREDENTIAL,
  AI_ACC_INTEGRATION,
  AI_ACC_PACING,
  AI_ACC_PAGINATION,
  AI_ACC_PATH,
  AI_ACC_PUBLICATION_TARGETS,
  AI_ACC_RECORD_PATH,
  AI_ACC_SCHEDULE,
  AI_ACC_WINDOW,
} from '../fixtures/reference-workload/ai-acc/configuration.js';
import { AI_ACC_DICTIONARY } from '../fixtures/reference-workload/ai-acc/data-dictionary.js';
import { AI_ACC_EXPECTED, type ExpectedGroup } from '../fixtures/reference-workload/ai-acc/expected.js';
import { AI_ACC_FAILED_WINDOW, AI_ACC_WINDOWS } from '../fixtures/reference-workload/ai-acc/windows.js';
import { readySource, type ReadySource } from '../support/acquisition.js';
import { startHttpSource, type SourceRequest } from '../support/http-source.js';
import { command, jsonFile, type PlatformFixture } from '../support/platform.js';

/**
 * The ai-acc reference workload is certified here as configuration plus frozen
 * assets: the source's own columns, its own labels, its own seven-day periods,
 * and figures totalled by hand. Everything the platform does with them is the
 * generic path a customer's declarative HTTP Source already takes.
 */

interface PlanWindow {
  mode: string;
  start: string;
  end: string;
  lookahead?: number;
  lookback_minutes: number;
  end_inclusive: boolean;
  captured_at: string;
}

interface WorkedRun {
  acquisition_run_id: string;
  status: string;
  raw_acquisition_ids: string[];
  raw_acquisition_count: number;
  batch_raw_acquisition_count: number | null;
  integration_batch_id: string | null;
  dataset_release: number | null;
  records: number | null;
  error_code?: string | null;
  plan: {
    plan_id: string;
    status: string;
    window: PlanWindow | null;
    pages: Array<{ page: number; outcome: string; raw_id: string | null }>;
    checkpoint_before: { watermark: string | null; cursor: string | null };
    checkpoint_after: { watermark: string | null; cursor: string | null };
  };
}

function tick(fixture: PlatformFixture, token: string, at: string): Array<{ due_at: string }> {
  const result = command(fixture, ['acquisition', 'tick', '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output['enqueued'] as Array<{ due_at: string }>;
}

function workAt(ready: ReadySource, at: string): WorkedRun {
  const result = command(
    ready.fixture,
    ['acquisition', 'work', '--source', ready.sourceId, '--at', at],
    { token: ready.workspaceAdministratorToken },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkedRun;
}

function groupOf(response: Record<string, unknown>): ExpectedGroup[] {
  const groups = response['groups'] as Array<{ group: Record<string, string>; metrics: Record<string, number> }>;
  return groups.map((entry) => ({
    group: entry.group,
    record_count: entry.metrics['record_count']!,
    handled_total: entry.metrics['handled_total']!,
  }));
}

function aggregate(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  groupBy: string[],
  slug: string,
): Record<string, unknown> {
  const result = command(
    fixture,
    [
      'product', 'query', '--product', productId,
      '--request', jsonFile(fixture, `ai-acc-${slug}`, {
        kind: 'aggregate',
        group_by: groupBy,
        metrics: ['record_count', 'handled_total'],
        include_totals: true,
      }),
    ],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/** The raw bytes one Raw Acquisition holds, read back exactly as they were stored. */
function rawBytes(fixture: PlatformFixture, rawId: string): string {
  return readFileSync(join(fixture.root, 'raw-acquisitions', `${rawId}.bin`), 'utf8');
}

test('the ai-acc reference workload acquires seven-day windows through the generic connector and reconciles to the validated results', async () => {
  const source = await startHttpSource({
    replies: [
      ...AI_ACC_WINDOWS.map((frozen) => ({ body: frozen.page })),
      { status: 500, body: AI_ACC_FAILED_WINDOW.page },
    ],
    auth: {
      login_path: AI_ACC_AUTH.login_path,
      issued: ['acc-session-1', 'acc-session-2'],
      cookie_name: 'session',
      expire_after_uses: 2,
    },
  });
  const ready = await readySource(source, {
    name: 'ai-acc 受理导出',
    connectionName: 'ai-acc 受理系统',
    auth: AI_ACC_AUTH,
    credential: AI_ACC_CREDENTIAL,
    pagination: AI_ACC_PAGINATION,
    pacing: AI_ACC_PACING,
    schedule: AI_ACC_SCHEDULE,
    publicationTargets: AI_ACC_PUBLICATION_TARGETS,
    window: AI_ACC_WINDOW,
    path: AI_ACC_PATH,
    recordPath: AI_ACC_RECORD_PATH,
    integration: AI_ACC_INTEGRATION,
    completion: { kind: 'short_page' },
  });
  const { fixture, workspaceId, workspaceAdministratorToken: token, sourceId } = ready;

  const context = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', jsonFile(fixture, 'ai-acc-context', AI_ACC_CONTEXT)],
    { token },
  );
  assert.equal(context.status, 0, context.stderr);

  // ---------------------------------------------------------------------------
  // Three scheduled Runs, each starting inside the 60-second tolerance, walk the
  // adjacent seven-day periods. Each period is one immutable Raw Acquisition of
  // its own, and the fourth read is what fails.
  // ---------------------------------------------------------------------------
  const [first] = tick(fixture, token, new Date().toISOString());
  let due = Date.parse(first!.due_at);
  const runs: WorkedRun[] = [];
  for (let index = 0; index < AI_ACC_WINDOWS.length; index += 1) {
    const at = new Date(due + 30_000).toISOString();
    if (index > 0) {
      // The schedule is due again fifteen minutes after the last Run finished.
      const [queued] = tick(fixture, token, at);
      assert.equal(queued?.due_at, new Date(due).toISOString());
    }
    const worked = workAt(ready, at);
    assert.equal(worked.status, 'complete', JSON.stringify(worked));
    runs.push(worked);
    due = Date.parse(at) + AI_ACC_SCHEDULE.every_minutes * 60_000;
  }

  // No window exceeds seven days, consecutive windows neither overlap nor leave
  // a gap, and the endpoint is asked for exactly those half-open intervals.
  const sevenDays = 7 * 24 * 60 * 60_000;
  const windows = runs.map((run) => run.plan.window!);
  assert.deepEqual(
    windows.map((window) => window.end),
    AI_ACC_WINDOWS.map((frozen) => frozen.window.end),
    'each Run reads the next adjacent period',
  );
  assert.deepEqual(
    windows.map((window) => window.start),
    AI_ACC_WINDOWS.map((frozen) => frozen.window.start),
  );
  for (const window of windows) {
    assert.equal(Date.parse(window.end) - Date.parse(window.start), sevenDays, 'a window never exceeds seven days');
  }
  assert.deepEqual(
    windows.slice(1).map((window, index) => window.start === windows[index]!.end),
    [true, true],
    'consecutive windows are contiguous: no period is read twice and none is skipped',
  );
  // The fourth protected request is the one replay after the endpoint expired
  // the session, and it asks for exactly the interval the rejected read named.
  assert.deepEqual(
    source.requests()
      .filter((request: SourceRequest) => request.path === AI_ACC_PATH)
      .map((request: SourceRequest) => [request.query['from'], request.query['to']]),
    [...AI_ACC_WINDOWS.map((frozen) => [frozen.window.start, frozen.window.end]), [
      AI_ACC_WINDOWS.at(-1)!.window.start,
      AI_ACC_WINDOWS.at(-1)!.window.end,
    ]],
    'the export is asked for exactly the half-open interval each Plan captured',
  );

  // Each period is its own immutable fragment: one accepted page per Run, a
  // distinct Raw Acquisition per window, and bytes identical to the frozen
  // snapshot. The session-rejected read is kept too, but as a diagnostic that
  // enters no Integration Batch.
  const accepted = runs.map((run) => run.plan.pages[0]!.raw_id!);
  assert.equal(new Set(runs.flatMap((run) => run.raw_acquisition_ids)).size, 4, 'no Raw Acquisition is rewritten by a later window');
  assert.equal(new Set(accepted).size, AI_ACC_WINDOWS.length, 'each window keeps an accepted fragment of its own');
  runs.forEach((run, index) => {
    assert.equal(run.plan.pages.length, 1);
    assert.equal(run.plan.pages[0]?.outcome, 'received');
    assert.equal(run.batch_raw_acquisition_count, 1);
    const frozen = AI_ACC_WINDOWS[index]!;
    assert.equal(rawBytes(fixture, accepted[index]!), frozen.page, 'the fragment is byte-identical to the snapshot');
    assert.deepEqual(
      Object.keys(JSON.parse(frozen.page)['data']['records'][0] as Record<string, unknown>),
      AI_ACC_DICTIONARY.map((entry) => entry.column),
      'the raw fragment keeps the source columns the dictionary names, not canonical fields',
    );
  });
  const rejectedRead = runs[2]!.raw_acquisition_ids.filter((rawId) => rawId !== accepted[2]);
  assert.deepEqual(rejectedRead.length, 1);
  assert.equal(rawBytes(fixture, rejectedRead[0]!), '{"error":"invalid_token"}', 'the expired-session response is kept as a diagnostic');

  // The session is a bearer token plus its cookie, refreshed once when the
  // endpoint expires it, and the replay is the same half-open window.
  const protectedRequests = source.requests().filter((request) => request.path === AI_ACC_PATH);
  assert.equal(protectedRequests.length, 4, 'three windows plus exactly one replay');
  for (const request of protectedRequests) {
    assert.match(request.authorization ?? '', /^Bearer acc-session-[12]$/u, 'every read carries the bearer token');
    assert.match(request.cookie ?? '', /^session=acc-session-[12]$/u, 'every read carries the login cookie');
    assert.equal(
      request.authorization?.slice('Bearer '.length),
      request.cookie?.slice('session='.length),
      'the token and the cookie are the one session the login issued',
    );
  }
  const logins = source.requests().filter((request) => request.path === AI_ACC_AUTH.login_path);
  assert.equal(logins.length, 2, 'the expired session is refreshed exactly once');
  assert.deepEqual(logins.map((request) => request.method), ['POST', 'POST']);
  const session = command(fixture, ['connection', 'session', '--connection', ready.connectionId], { token });
  assert.equal(session.status, 0, session.stderr);
  assert.deepEqual(
    {
      auth_scheme: session.output['auth_scheme'],
      has_token: session.output['has_access_token'],
      has_cookie: session.output['has_cookie'],
      cookie_name: session.output['cookie_name'],
      generation: session.output['generation'],
      state: session.output['state'],
    },
    { auth_scheme: 'login', has_token: true, has_cookie: true, cookie_name: 'session', generation: 2, state: 'active' },
    'the refreshed session is the one the third window read with',
  );

  // The credential is a protected reference: the Connection Version names a
  // fingerprint of it, and neither the stored password nor the issued session is
  // ever durable plaintext.
  const connections = command(fixture, ['connection', 'list', '--workspace', workspaceId], { token });
  assert.equal(connections.status, 0, connections.stderr);
  const connection = (connections.output['connections'] as Array<Record<string, unknown>>)
    .find((candidate) => candidate['connection_id'] === ready.connectionId);
  const connectionVersion = (connection?.['versions'] as Array<Record<string, unknown>>).at(-1);
  assert.match(String(connectionVersion?.['credential_ref']), /^login:[0-9a-f]{16}$/u, 'the credential is named by reference, not by value');
  const durable = readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8');
  assert.match(durable, /"acquisition_connections"/u, 'the Deployment state is the file being read');
  assert.equal(durable.includes(AI_ACC_CREDENTIAL), false, 'the stored credential never appears in durable plaintext');
  assert.equal(durable.includes('acc-session-2'), false, 'the issued session token is sealed in durable state');

  // The Dataset Release holds exactly the frozen rows, reconciled by 工单号.
  const dataset = command(fixture, ['dataset', 'show', '--source', sourceId], { token });
  assert.equal(dataset.status, 0, dataset.stderr);
  assert.equal(dataset.output['record_count'], AI_ACC_EXPECTED.totals.record_count);
  assert.equal(dataset.output['record_rejection_count'], 0);

  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', AI_ACC_CONTRACT.title, '--contract', jsonFile(fixture, 'ai-acc-contract', AI_ACC_CONTRACT)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  const productId = String(published.output['data_product_id']);
  assert.equal(published.output['dataset_release'], 3, 'the Contract is published over the third Dataset Release');

  // ---------------------------------------------------------------------------
  // Handling volume, takeover behaviour, and the time bands are the business
  // results: every grouping and the grand total reconcile with the hand totals.
  // ---------------------------------------------------------------------------
  const byBand = aggregate(fixture, token, productId, ['time_band'], 'band');
  assert.deepEqual(groupOf(byBand), AI_ACC_EXPECTED.by_time_band);
  assert.deepEqual(byBand['totals'], {
    metrics: {
      record_count: AI_ACC_EXPECTED.totals.record_count,
      handled_total: AI_ACC_EXPECTED.totals.handled_total,
    },
  });

  const byTakeover = aggregate(fixture, token, productId, ['takeover_state'], 'takeover');
  assert.deepEqual(groupOf(byTakeover), AI_ACC_EXPECTED.by_takeover);

  const crossTab = aggregate(fixture, token, productId, ['time_band', 'takeover_state'], 'cross');
  assert.deepEqual(groupOf(crossTab), AI_ACC_EXPECTED.by_time_band_and_takeover);

  // The per-window 处理量 is what each seven-day fragment contributes, so a window
  // that were merged with its neighbour could not reconcile with these totals.
  for (let index = 0; index < AI_ACC_WINDOWS.length; index += 1) {
    const frozen = AI_ACC_WINDOWS[index]!;
    const lastDay = new Date(Date.parse(frozen.window.end) - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const windowed = command(
      fixture,
      [
        'product', 'query', '--product', productId,
        '--request', jsonFile(fixture, `ai-acc-window-${index}`, {
          kind: 'aggregate',
          metrics: ['handled_total'],
          include_totals: true,
          window: { start: frozen.window.start.slice(0, 10), end: lastDay },
        }),
      ],
      { token },
    );
    assert.equal(windowed.status, 0, windowed.stderr);
    const windowTotals = windowed.output['totals'] as { metrics: Record<string, number> };
    assert.equal(
      windowTotals.metrics['handled_total'],
      AI_ACC_EXPECTED.window_handled[index],
      `window ${index + 1} contributes its own 处理量`,
    );
  }

  // The fifteen-minute schedule is measured, not assumed: three sampled starts,
  // all inside the tolerance, and a publication distribution inside its targets.
  const measured = command(fixture, ['acquisition', 'targets', '--source', sourceId], { token });
  assert.equal(measured.status, 0, measured.stderr);
  assert.deepEqual(measured.output['schedule'], AI_ACC_SCHEDULE);
  assert.deepEqual(measured.output['publication_targets'], AI_ACC_PUBLICATION_TARGETS);
  assert.deepEqual(
    {
      runs: (measured.output['runs'] as unknown[]).length,
      start_met: (measured.output['start'] as Record<string, unknown>)['met'],
      within: (measured.output['start'] as Record<string, unknown>)['within_tolerance'],
      publication_met: (measured.output['publication'] as Record<string, unknown>)['met'],
      p95: (measured.output['publication'] as Record<string, unknown>)['p95_seconds'],
      p99: (measured.output['publication'] as Record<string, unknown>)['p99_seconds'],
    },
    { runs: 3, start_met: true, within: 3, publication_met: true, p95: 30, p99: 30 },
  );

  // ---------------------------------------------------------------------------
  // A failed window publishes nothing: the next period's read is refused by the
  // source, no Integration Batch exists for it, the current Release, the answers
  // it serves, and the resume point all stay exactly where they were.
  // ---------------------------------------------------------------------------
  const [failedSchedule] = tick(fixture, token, new Date(due + 30_000).toISOString());
  assert.equal(failedSchedule?.due_at, new Date(due).toISOString());
  const failed = workAt(ready, new Date(due + 30_000).toISOString());
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'ACQUISITION_RESPONSE_STATUS');
  assert.equal(failed.integration_batch_id, null, 'a failed attempt emits no Integration Batch');
  assert.equal(failed.dataset_release, null);
  assert.equal(failed.batch_raw_acquisition_count, null);
  assert.deepEqual(
    failed.plan.checkpoint_after,
    { watermark: AI_ACC_WINDOWS.at(-1)!.window.end, cursor: null },
    'a failed attempt never advances the resume point',
  );
  assert.equal(
    rawBytes(fixture, failed.raw_acquisition_ids[0]!),
    AI_ACC_FAILED_WINDOW.page,
    'the refused response is kept as a diagnostic fragment',
  );

  const afterFailure = command(fixture, ['dataset', 'show', '--source', sourceId], { token });
  assert.equal(afterFailure.status, 0, afterFailure.stderr);
  assert.equal(afterFailure.output['dataset_release'], 3, 'no Release is published from a partial attempt');
  assert.equal(afterFailure.output['record_count'], AI_ACC_EXPECTED.totals.record_count);
  assert.deepEqual(groupOf(aggregate(fixture, token, productId, ['time_band'], 'band-after-failure')), AI_ACC_EXPECTED.by_time_band);

  const measuredAfterFailure = command(fixture, ['acquisition', 'targets', '--source', sourceId], { token });
  assert.equal(measuredAfterFailure.status, 0, measuredAfterFailure.stderr);
  assert.deepEqual(
    {
      failed: (measuredAfterFailure.output['publication'] as Record<string, unknown>)['failed'],
      met: (measuredAfterFailure.output['publication'] as Record<string, unknown>)['met'],
    },
    { failed: 1, met: false },
    'a scheduled Run with nothing to publish is a measured miss',
  );
  await source.close();
});
