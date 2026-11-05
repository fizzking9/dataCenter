import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVICES, publishConnection, readySource } from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command, jsonFile, type PlatformFixture } from '../support/platform.js';

/**
 * One Connection's declared schedule and publication targets are Workspace-owned
 * configuration. They state what a scheduled Source promises — how late a Run may
 * start, and how quickly its result must be published — so the same generic
 * engine serves any cadence without naming a business case.
 */
test('a scheduled Connection declares its own start tolerance and publication targets', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const ready = await readySource(source, {
    schedule: { every_minutes: 15, start_tolerance_seconds: 60 },
    publicationTargets: { p95_seconds: 300, p99_seconds: 600 },
  });

  const listed = command(
    ready.fixture,
    ['connection', 'list', '--workspace', ready.workspaceId],
    { token: ready.workspaceAdministratorToken },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const connection = (listed.output['connections'] as Array<Record<string, unknown>>)
    .find((candidate) => candidate['connection_id'] === ready.connectionId);
  const version = (connection?.['versions'] as Array<Record<string, unknown>>).at(-1);
  assert.deepEqual(version?.['schedule'], { every_minutes: 15, start_tolerance_seconds: 60 });
  assert.deepEqual(version?.['publication_targets'], { p95_seconds: 300, p99_seconds: 600 });

  // A tolerance is a duration and a target pair is ordered, so an unusable
  // declaration is refused rather than silently honoured as something else.
  const overTolerance = command(
    ready.fixture,
    [
      'connection', 'publish', '--workspace', ready.workspaceId, '--name', '超时容忍',
      '--config', jsonFile(ready.fixture, 'tolerance', {
        base_url: source.url,
        auth: { scheme: 'bearer' },
        pagination: { parameter: 'page', size: 2, max_pages: 2 },
        schedule: { every_minutes: 15, start_tolerance_seconds: 3601 },
      }),
      '--credential-stdin',
    ],
    { token: ready.workspaceAdministratorToken, input: 'source-access-token\n' },
  );
  assert.equal(overTolerance.status, 2);
  assert.equal(overTolerance.error['code'], 'CONNECTION_CONFIGURATION_INVALID');

  const inverted = command(
    ready.fixture,
    [
      'connection', 'publish', '--workspace', ready.workspaceId, '--name', '目标倒置',
      '--config', jsonFile(ready.fixture, 'targets', {
        base_url: source.url,
        auth: { scheme: 'bearer' },
        pagination: { parameter: 'page', size: 2, max_pages: 2 },
        publication_targets: { p95_seconds: 600, p99_seconds: 300 },
      }),
      '--credential-stdin',
    ],
    { token: ready.workspaceAdministratorToken, input: 'source-access-token\n' },
  );
  assert.equal(inverted.status, 2);
  assert.equal(inverted.error['code'], 'CONNECTION_CONFIGURATION_INVALID');
  await source.close();
});

interface TargetsReport {
  schedule: { every_minutes: number; start_tolerance_seconds: number } | null;
  publication_targets: { p95_seconds: number; p99_seconds: number } | null;
  runs: Array<{
    acquisition_run_id: string;
    scheduled_for: string | null;
    started_at: string | null;
    completed_at: string | null;
    status: string;
    start_latency_seconds: number | null;
    publication_latency_seconds: number | null;
  }>;
  start: {
    samples: number;
    within_tolerance: number;
    late: number;
    maximum_latency_seconds: number | null;
    tolerance_seconds: number;
    met: boolean;
  } | null;
  publication: {
    samples: number;
    failed: number;
    p95_seconds: number | null;
    p99_seconds: number | null;
    p95_target_seconds: number | null;
    p99_target_seconds: number | null;
    met: boolean;
  } | null;
}

function targets(fixture: PlatformFixture, token: string, sourceId: string): TargetsReport {
  const result = command(fixture, ['acquisition', 'targets', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as TargetsReport;
}

function tick(fixture: PlatformFixture, token: string, at: string): Array<{ due_at: string }> {
  const result = command(fixture, ['acquisition', 'tick', '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output['enqueued'] as Array<{ due_at: string }>;
}

function workAt(fixture: PlatformFixture, token: string, sourceId: string, at: string): Record<string, unknown> {
  const result = command(fixture, ['acquisition', 'work', '--source', sourceId, '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/**
 * A schedule is certified by the distribution it really produced: how late each
 * scheduled Run started against the tolerance it declared, and how long each
 * result took to become current against the declared p95 and p99 targets.
 */
test('a scheduled Source reports its start latencies and publication distribution against its own targets', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const ready = await readySource(source, {
    schedule: { every_minutes: 15, start_tolerance_seconds: 60 },
    publicationTargets: { p95_seconds: 300, p99_seconds: 600 },
  });
  const { fixture, sourceId, workspaceAdministratorToken: token } = ready;

  // Nineteen Runs start 30, 30, ..., 60, 240, and 540 seconds after the instant
  // their schedule made them due; the first starts as soon as it is due.
  const latencies = [...Array<number>(16).fill(30), 60, 240, 540];
  const firstTick = tick(fixture, token, new Date().toISOString());
  assert.equal(firstTick.length, 1);
  const firstStartedAt = Date.now();
  workAt(fixture, token, sourceId, new Date(firstStartedAt).toISOString());
  let previousStart = firstStartedAt;

  for (const latency of latencies) {
    const due = previousStart + 15 * 60_000;
    const at = new Date(due + latency * 1_000).toISOString();
    const [enqueued] = tick(fixture, token, at);
    assert.equal(enqueued?.due_at, new Date(due).toISOString(), 'the schedule states the instant the Run was due');
    const worked = workAt(fixture, token, sourceId, at);
    assert.equal(worked['status'], 'complete', JSON.stringify(worked));
    previousStart = due + latency * 1_000;
  }

  const report = targets(fixture, token, sourceId);
  assert.deepEqual(report.schedule, { every_minutes: 15, start_tolerance_seconds: 60 });
  assert.deepEqual(report.publication_targets, { p95_seconds: 300, p99_seconds: 600 });
  assert.equal(report.runs.length, 20, 'every scheduled Run is measured');
  assert.equal(
    report.runs.every((run) => run.started_at !== null && run.completed_at !== null && run.scheduled_for !== null),
    true,
    'each measured Run states the instant it was due, started, and published',
  );

  // The 540-second start is far outside the 60-second tolerance and the
  // 240-second one is inside it, so exactly two starts are reported late while
  // the slowest start is reported as it was, not as an average.
  assert.deepEqual(
    { samples: report.start?.samples, within: report.start?.within_tolerance, late: report.start?.late },
    { samples: 20, within: 18, late: 2 },
  );
  assert.equal(report.start?.tolerance_seconds, 60);
  assert.equal(report.start?.maximum_latency_seconds, 540);
  assert.equal(report.start?.met, false, 'a schedule that started a Run nine minutes late does not meet its tolerance');

  // The publication distribution is read at its own two points: the 19th of 20
  // samples is 240 seconds and the slowest is 540, both inside 300 and 600.
  assert.deepEqual(
    {
      samples: report.publication?.samples,
      failed: report.publication?.failed,
      p95: report.publication?.p95_seconds,
      p99: report.publication?.p99_seconds,
    },
    { samples: 20, failed: 0, p95: 240, p99: 540 },
  );
  assert.equal(report.publication?.p95_target_seconds, 300);
  assert.equal(report.publication?.p99_target_seconds, 600);
  assert.equal(report.publication?.met, true);

  // A manual Run is not the schedule's evidence, so measuring again after one
  // leaves every scheduled sample exactly where it was.
  const manual = command(fixture, ['acquisition', 'enqueue', '--source', sourceId], { token });
  assert.equal(manual.status, 0, manual.stderr);
  workAt(fixture, token, sourceId, new Date(previousStart + 60 * 60_000).toISOString());
  const remeasured = targets(fixture, token, sourceId);
  assert.equal(remeasured.runs.length, 20);
  assert.deepEqual(remeasured.publication, report.publication);
  await source.close();
});

/**
 * A Run whose acquisition failed has no result to publish, so the publication
 * measurement reports it as a miss instead of quietly dropping it from the tail
 * an operator reads.
 */
test('a failed scheduled Run is measured as unpublished rather than omitted', async () => {
  const source = await startHttpSource({
    repeat_last: false,
    replies: [
      { body: pageBody(DEVICES.slice(0, 1)) },
      { status: 500, body: '{"error":"source unavailable"}' },
    ],
  });
  const ready = await readySource(source, {
    schedule: { every_minutes: 15, start_tolerance_seconds: 60 },
    publicationTargets: { p95_seconds: 300, p99_seconds: 600 },
    retry: { max_attempts: 1, base_delay_ms: 0, max_delay_ms: 0, retry_on: [] },
  });
  const { fixture, sourceId, workspaceAdministratorToken: token } = ready;

  const [first] = tick(fixture, token, new Date().toISOString());
  const firstStart = Date.parse(first!.due_at) + 30_000;
  assert.equal(workAt(fixture, token, sourceId, new Date(firstStart).toISOString())['status'], 'complete');

  const secondStart = firstStart + 15 * 60_000 + 30_000;
  tick(fixture, token, new Date(secondStart).toISOString());
  const failed = workAt(fixture, token, sourceId, new Date(secondStart).toISOString());
  assert.equal(failed['status'], 'failed');
  assert.equal(failed['integration_batch_id'], null);

  const report = targets(fixture, token, sourceId);
  assert.equal(report.runs.length, 2);
  const published = report.runs.filter((run) => run.publication_latency_seconds !== null);
  assert.deepEqual(published.map((run) => run.status), ['complete'], 'only the Run that published states a publication latency');
  assert.deepEqual(
    { samples: report.publication?.samples, failed: report.publication?.failed, met: report.publication?.met },
    { samples: 1, failed: 1, met: false },
  );
  await source.close();
});
