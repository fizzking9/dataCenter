import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command } from '../support/platform.js';
import { runOperatorAsync } from '../support/operator.js';
import {
  BMS_EXPECTED,
  BMS_SOURCES,
  bmsReplies,
  configureBmsWorkload,
  expectedIdentities,
  type ConfiguredSource,
  type ReferenceWorkload,
} from '../support/reference-workload.js';

/**
 * The Reference Workload at the black-box certification seam: the real business
 * export system is configured through Workspace-owned Artifacts only, and every
 * observation below is a supported external contract — the Operator CLI against
 * a controlled HTTP fixture, never internal state.
 */

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
  trigger: string;
  paced?: boolean;
  pacing_reason?: string | null;
  queue_position?: number;
  not_before?: string | null;
  plan: {
    plan_id: string;
    status: string;
    connector: { name: string; version: number };
    connection_id: string;
    connection_version: number;
    acquisition_configuration_version: number;
    integration_configuration_version: number;
    window: PlanWindow | null;
    pages: Array<{ page: number; outcome: string; raw_id: string | null; record_count: number | null }>;
    checkpoint_before: { watermark: string | null } | null;
    checkpoint_after: { watermark: string | null } | null;
    created_at: string;
    completed_at: string | null;
  } | null;
  raw_acquisition_count: number;
  raw_acquisition_ids: string[];
  batch_raw_acquisition_count: number | null;
  integration_batch_id: string | null;
  dataset_release: number | null;
  records: number | null;
  error_code: string | null;
}

interface TickResult {
  at: string;
  enqueued: Array<{
    source_id: string;
    acquisition_run_id: string;
    due_at: string;
  }>;
}

interface PacingResult {
  queue: Array<{ acquisition_run_id: string; source_id: string }>;
  active: Array<{ acquisition_run_id: string; source_id: string }>;
  last_finished_at: string | null;
  policy: {
    serialization: boolean;
    minimum_interval_seconds: number;
    maximum_requests_per_minute: number | null;
    maximum_concurrent_runs: number;
  };
}

interface DatasetResult {
  source_id: string;
  dataset_release: number;
  record_count: number;
  records: Array<{ identity: string; values: Record<string, string | number | null> }>;
  record_rejection_count: number;
  provenance: {
    batch_ids: string[];
    acquisition_run_ids: string[];
    raw_acquisition_ids: string[];
    acquired_at: string;
    integrated_at: string;
    released_at: string;
  };
}

interface ManifestResult {
  source_id: string;
  acquisition_run_id: string;
  plan: {
    plan_id: string;
    status: string;
    window: PlanWindow | null;
    pages: Array<{ page: number; outcome: string; raw_id: string | null; record_count: number | null }>;
    checkpoint_before: { watermark: string | null; cursor: string | null } | null;
    checkpoint_after: { watermark: string | null; cursor: string | null } | null;
    created_at: string;
    completed_at: string | null;
  };
  raw_acquisitions: Array<{
    raw_id: string;
    content_hash: string;
    byte_length: number;
    received_at: string;
  }>;
}

interface TargetsResult {
  schedule: { every_minutes: number; start_tolerance_seconds: number } | null;
  publication_targets: { p95_seconds: number; p99_seconds: number } | null;
  runs: Array<{
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

function tick(workload: ReferenceWorkload, at: string): TickResult {
  const result = command(workload.fixture, ['acquisition', 'tick', '--at', at], { token: workload.token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as TickResult;
}

function workAt(workload: ReferenceWorkload, sourceId: string, at: string): WorkResult {
  const result = command(
    workload.fixture,
    ['acquisition', 'work', '--source', sourceId, '--at', at],
    { token: workload.token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkResult;
}

function pacing(workload: ReferenceWorkload): PacingResult {
  const result = command(workload.fixture, ['connection', 'pacing', '--connection', workload.connectionId], { token: workload.token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as PacingResult;
}

function checkpoint(workload: ReferenceWorkload, sourceId: string): Record<string, unknown> | null {
  const result = command(workload.fixture, ['acquisition', 'checkpoint', '--source', sourceId], { token: workload.token });
  assert.equal(result.status, 0, result.stderr);
  return result.output['checkpoint'] as Record<string, unknown> | null;
}

function dataset(workload: ReferenceWorkload, sourceId: string, release?: number): DatasetResult {
  const result = command(
    workload.fixture,
    ['dataset', 'show', '--source', sourceId, ...(release === undefined ? [] : ['--release', String(release)])],
    { token: workload.token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as DatasetResult;
}

/** Reads the immutable Acquisition Plan — the manifest — a Run attempt left behind. */
function manifest(workload: ReferenceWorkload, runId: string): ManifestResult {
  const result = command(
    workload.fixture,
    ['acquisition', 'plan', '--run', runId],
    { token: workload.token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as ManifestResult;
}

/** The first and last instants the nine Sources were configured, in wall clock. */
function creationWindow(workload: ReferenceWorkload): { earliest: number; latest: number } {
  const instants = workload.sources.map((source) => Date.parse(source.createdAt));
  assert.ok(instants.every((instant) => Number.isFinite(instant)), 'every Source states when it was created');
  return { earliest: Math.min(...instants), latest: Math.max(...instants) };
}

/** Reads the schedule and publication distribution one Source really produced. */
function targets(workload: ReferenceWorkload, sourceId: string): TargetsResult {
  const result = command(
    workload.fixture,
    ['acquisition', 'targets', '--source', sourceId],
    { token: workload.token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as TargetsResult;
}

/**
 * Works one Source at the earliest instant its Connection admits it: never
 * before the previous export on that Connection has been closed for the whole
 * minimum interval. Nothing here sleeps; the worker clock is stated, and every
 * call is a fresh process, so durable pacing is what admits it.
 */
function workWhenConnectionIsFree(
  workload: ReferenceWorkload,
  source: ConfiguredSource,
  notEarlier: number,
): WorkResult {
  const state = pacing(workload);
  const free = state.last_finished_at === null
    ? notEarlier
    : Date.parse(state.last_finished_at) + BMS_EXPECTED.interval_seconds * 1_000;
  const result = workAt(workload, source.sourceId, new Date(Math.max(notEarlier, free)).toISOString());
  assert.equal(result.status, 'complete', `${source.name}: ${JSON.stringify(result)}`);
  return result;
}

/**
 * The cold sweep that establishes the first Release of every Source. It is a
 * manual sweep because the nine Sources were just configured together: their
 * first hourly instants are effectively simultaneous, and the Connection's
 * 65-second serialization is what spaces the exports.
 */
function manualSweep(workload: ReferenceWorkload, fromAt: number): WorkResult[] {
  let notEarlier = fromAt;
  return workload.sources.map((source) => {
    const enqueued = command(workload.fixture, ['acquisition', 'enqueue', '--source', source.sourceId], { token: workload.token });
    assert.equal(enqueued.status, 0, enqueued.stderr);
    const result = workWhenConnectionIsFree(workload, source, notEarlier);
    assert.equal(result.trigger, 'manual');
    notEarlier = Date.parse(String(result.plan?.completed_at)) + BMS_EXPECTED.interval_seconds * 1_000;
    return result;
  });
}

/**
 * One hourly sweep as the schedule really runs it: each Source becomes due one
 * hour after its own previous completion, and the sweep starts it 45 seconds
 * later — inside the declared 60-second start tolerance — which the Connection's
 * durable queue admits because the previous export closed 65 seconds earlier.
 */
function scheduledSweep(workload: ReferenceWorkload, previous: WorkResult[]): WorkResult[] {
  return workload.sources.map((source, index) => {
    const due = Date.parse(String(previous[index]?.plan?.completed_at)) + 60 * 60_000;
    const at = new Date(due + 45_000).toISOString();
    const ticked = tick(workload, at);
    assert.equal(ticked.enqueued.length, 1, 'only the Source whose hour has elapsed is due');
    assert.equal(ticked.enqueued[0]?.source_id, source.sourceId);
    assert.equal(ticked.enqueued[0]?.due_at, new Date(due).toISOString());
    const result = workAt(workload, source.sourceId, at);
    assert.equal(result.status, 'complete', `${source.name}: ${JSON.stringify(result)}`);
    assert.equal(result.trigger, 'scheduled');
    return result;
  });
}

test('nine independently configured Sources acquire an hourly full sweep through one serialized Connection', async () => {
  const server = await startHttpSource({ replies: bmsReplies(1) });
  const workload = configureBmsWorkload(server);
  const { fixture, token } = workload;

  // ---------------------------------------------------------------------------
  // One physical system, nine independent datasets: a single Connection Version
  // carries the endpoint, credential, pagination, retry, pacing, and schedule,
  // and every Source pins it while keeping its own acquisition and integration
  // configuration. Nothing about the business system reaches the engine.
  // ---------------------------------------------------------------------------
  assert.equal(workload.sources.length, BMS_EXPECTED.sources);
  const listed = command(fixture, ['source', 'list', '--workspace', workload.workspaceId], { token });
  assert.equal(listed.status, 0, listed.stderr);
  const sources = listed.output['sources'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    sources.map((source) => source['name']),
    BMS_SOURCES.map((source) => source.name),
    'every Source is its own Workspace Artifact with its own name',
  );
  assert.deepEqual(
    sources.map((source) => source['adopted_acquisition_configuration_version']),
    workload.sources.map((source) => source.acquisitionVersion),
    'each Source adopted its own acquisition configuration Version',
  );
  assert.deepEqual(
    workload.sources.map((source) => source.acquisitionVersion),
    workload.sources.map(() => 1),
    'nine independently published configurations, not one shared document',
  );

  const connections = command(fixture, ['connection', 'list', '--workspace', workload.workspaceId], { token });
  assert.equal(connections.status, 0, connections.stderr);
  const connectionList = connections.output['connections'] as Array<Record<string, unknown>>;
  assert.equal(connectionList.length, 1, 'the nine Sources share exactly one Acquisition Connection');
  const versions = connectionList[0]!['versions'] as Array<Record<string, unknown>>;
  assert.deepEqual(versions[0]!['pacing'], {
    serialization: true,
    minimum_interval_seconds: BMS_EXPECTED.interval_seconds,
    maximum_requests_per_minute: null,
    maximum_concurrent_runs: 1,
  });
  assert.deepEqual(versions[0]!['schedule'], {
    every_minutes: 60,
    start_tolerance_seconds: BMS_EXPECTED.start_tolerance_seconds,
  });
  assert.deepEqual(versions[0]!['publication_targets'], {
    p95_seconds: BMS_EXPECTED.publication_p95_seconds,
    p99_seconds: BMS_EXPECTED.publication_p99_seconds,
  });

  // ---------------------------------------------------------------------------
  // The scheduler is external: nothing is due before the first interval has
  // elapsed, and one due sweep queues every Source of the physical system. Each
  // Run's own start and publication latencies are measured in the nightly sweep
  // below, where every Source is started at its own due instant.
  // ---------------------------------------------------------------------------
  const created = creationWindow(workload);
  const early = tick(workload, new Date(created.earliest - 1_000).toISOString());
  assert.deepEqual(early.enqueued, [], 'nothing is queued before the first schedule interval elapses');

  const sweptAt = Date.now();
  const ticked = tick(workload, new Date(created.latest + 45_000).toISOString());
  assert.deepEqual(
    ticked.enqueued.map((entry) => entry.source_id),
    workload.sources.map((source) => source.sourceId),
    'the sweep starts every Source of the physical system, in the order they were configured',
  );
  assert.deepEqual(
    ticked.enqueued.map((entry) => Date.parse(entry.due_at)),
    [...workload.sources.map((source) => Date.parse(source.createdAt))],
    'each Source is due at its own creation instant',
  );

  const queued = pacing(workload);
  assert.deepEqual(
    queued.queue.map((entry) => entry.source_id),
    workload.sources.map((source) => source.sourceId),
    'the Connection queue, not the Source, is the order the sweep drains in',
  );

  const worked = workload.sources.map((source) => workWhenConnectionIsFree(workload, source, Date.parse(ticked.at)));

  // ---------------------------------------------------------------------------
  // Every Run keeps its immutable Plan and export fragment, every Source keeps
  // the resume point the sweep really established, and the whole sweep published
  // its Releases inside the freshness target — all observed externally.
  // ---------------------------------------------------------------------------
  let rawAcquisitions = 0;
  for (const [index, result] of worked.entries()) {
    const source = workload.sources[index]!;
    const expected = BMS_SOURCES[index]!;
    assert.equal(result.trigger, 'scheduled');
    assert.deepEqual(result.plan?.connector, { name: 'http-json', version: 1 });
    assert.equal(result.plan?.connection_id, workload.connectionId);
    assert.equal(result.plan?.connection_version, workload.connectionVersion);
    assert.equal(result.plan?.acquisition_configuration_version, source.acquisitionVersion);
    assert.equal(result.plan?.integration_configuration_version, source.integrationVersion);
    assert.deepEqual(result.plan?.window, {
      mode: 'incremental',
      start: BMS_EXPECTED.sweeps[0]!.window.from,
      end: BMS_EXPECTED.sweeps[0]!.window.to,
      lookback_minutes: 60,
      end_inclusive: false,
      captured_at: result.plan?.created_at,
    });
    assert.equal(result.plan?.status, 'complete');
    assert.equal(result.plan?.pages.length, 1, 'one export fragment completes this Source');
    assert.equal(result.plan?.pages[0]?.outcome, 'received');
    assert.equal(result.plan?.pages[0]?.record_count, BMS_EXPECTED.sweeps[0]!.records_per_source);
    assert.equal(result.raw_acquisition_count, 1);
    assert.equal(result.batch_raw_acquisition_count, 1, 'the complete Plan hands over exactly its fragments');
    assert.equal(result.records, BMS_EXPECTED.sweeps[0]!.records_per_source);
    assert.equal(result.dataset_release, 1);
    assert.equal(result.error_code, null);
    rawAcquisitions += result.raw_acquisition_count;

    const advanced = checkpoint(workload, source.sourceId);
    assert.deepEqual(
      { watermark: advanced?.['watermark'], cursor_state: advanced?.['cursor_state'] },
      { watermark: BMS_EXPECTED.sweeps[0]!.window.to, cursor_state: 'valid' },
      `${source.name} resumes where this complete sweep stopped`,
    );

    const released = dataset(workload, source.sourceId);
    assert.equal(released.record_count, BMS_EXPECTED.sweeps[0]!.records_per_source);
    assert.equal(released.record_rejection_count, 0);
    assert.deepEqual(
      released.records.map((record) => record.identity).sort(),
      expectedIdentities(expected, 0),
      `${source.name} governs the identities its export really carried`,
    );
    assert.deepEqual(released.provenance.acquisition_run_ids, [result.acquisition_run_id]);
    assert.deepEqual(released.provenance.batch_ids, [result.integration_batch_id]);
    assert.deepEqual(released.provenance.raw_acquisition_ids, result.raw_acquisition_ids);
    assert.equal(released.provenance.raw_acquisition_ids.length, 1, 'the export fragment is linked to the Release');
    for (const field of ['acquired_at', 'integrated_at', 'released_at'] as const) {
      assert.ok(Number.isFinite(Date.parse(released.provenance[field])), `${field} is a governed instant`);
    }
    const releasedAt = Date.parse(released.provenance.released_at);
    assert.ok(releasedAt >= sweptAt, 'the Release was published by this sweep');
    assert.ok(
      releasedAt <= sweptAt + BMS_EXPECTED.publication_p95_seconds * 1_000,
      `${source.name} is inside the complete-sweep freshness target`,
    );
    assert.ok(
      released.records.every((record) => typeof record.values['updated_at'] === 'string'),
      'the source-native event time survives curation',
    );

    // A fresh operator process still reads the manifest this attempt left, with
    // the exact fragment and the resume point it captured.
    const stored = manifest(workload, result.acquisition_run_id);
    assert.equal(stored.source_id, source.sourceId);
    assert.equal(stored.plan.status, 'complete');
    assert.deepEqual(stored.plan.window, result.plan?.window);
    assert.equal(stored.plan.pages.length, 1);
    assert.equal(stored.plan.checkpoint_before?.watermark, null, 'the first sweep started from the beginning');
    assert.equal(stored.plan.checkpoint_after?.watermark, BMS_EXPECTED.sweeps[0]!.window.to);
    assert.deepEqual(stored.raw_acquisitions.map((raw) => raw.raw_id), result.raw_acquisition_ids);
    for (const raw of stored.raw_acquisitions) {
      assert.match(raw.content_hash, /^[0-9a-f]{64}$/u);
      assert.ok(raw.byte_length > 0);
      assert.ok(Number.isFinite(Date.parse(raw.received_at)));
    }
  }
  assert.equal(rawAcquisitions, BMS_EXPECTED.sweeps[0]!.raw_acquisitions, 'the sweep kept one fragment per Source');

  // Every Source asked for its own endpoint over the shared Connection, with the
  // half-open window the Plan captured.
  const requests = server.requests();
  assert.equal(requests.length, BMS_EXPECTED.sweeps[0]!.raw_acquisitions);
  assert.deepEqual(
    requests.map((request) => request.path),
    BMS_SOURCES.map((source) => source.path),
    'each Source read its own export, never another dataset',
  );
  assert.deepEqual(
    requests.map((request) => [request.query['from'], request.query['to']]),
    BMS_SOURCES.map(() => [BMS_EXPECTED.sweeps[0]!.window.from, BMS_EXPECTED.sweeps[0]!.window.to]),
    'one half-open window is stated to every export of the sweep',
  );
  assert.deepEqual(
    requests.map((request) => request.api_key),
    BMS_SOURCES.map(() => 'reference-workload-credential'),
    'the pinned credential rides every request of the physical system',
  );
  await server.close();
});

test('one active Run per Connection and 65 seconds between exports survive worker processes', async () => {
  // ---------------------------------------------------------------------------
  // The first export of the sweep is still on the wire in one worker process.
  // A second worker process asks to export the next Source of the same physical
  // system and gets a durable queue position, not a second concurrent Run.
  // ---------------------------------------------------------------------------
  const server = await startHttpSource({
    replies: [
      { body: pageBody(BMS_SOURCES[0]!.exports[0]!), delay_ms: 5_000 },
      { body: pageBody(BMS_SOURCES[1]!.exports[0]!) },
    ],
  });
  const workload = configureBmsWorkload(server);
  const [first, second] = workload.sources;
  assert.ok(first !== undefined && second !== undefined);
  const tickAt = new Date(creationWindow(workload).latest + 30_000).toISOString();
  assert.equal(tick(workload, tickAt).enqueued.length, BMS_EXPECTED.sources);

  const holding = runOperatorAsync(
    [
      'acquisition', 'work', '--source', first.sourceId, '--at', tickAt,
      '--root', workload.fixture.root, '--master-key', workload.fixture.masterKey,
      '--session-token', workload.token,
    ],
    { env: workload.fixture.docker },
  );
  await wait(1_500);
  const refused = workAt(workload, second.sourceId, tickAt);
  assert.equal(refused.status, 'queued', 'a paced Run stays queued rather than failing');
  assert.equal(refused.paced, true);
  assert.equal(refused.pacing_reason, 'serialization', 'the Connection admits one Run at a time');
  assert.equal(refused.error_code, null);
  assert.equal(refused.plan, null, 'a Run that was never admitted plans nothing');
  const whileBusy = pacing(workload);
  assert.deepEqual(
    whileBusy.active.map((entry) => entry.source_id),
    [first.sourceId],
    'exactly one Run of the Connection is active',
  );
  assert.equal(server.requests().length, 1, 'the second worker read nothing while the first held the Connection');

  const held = await holding;
  assert.equal(held.status, 0, held.stderr);
  assert.equal((held.output as unknown as WorkResult).status, 'complete');

  // ---------------------------------------------------------------------------
  // The interval is the Connection's, not the Source's or the worker's: it is
  // decided by durable state alone, so a third worker process honours the same
  // boundary, and the boundary is exactly 65 seconds wide.
  // ---------------------------------------------------------------------------
  const closed = pacing(workload);
  assert.ok(closed.last_finished_at !== null, 'the instant the export closed is durable');
  const earliest = Date.parse(closed.last_finished_at) + BMS_EXPECTED.interval_seconds * 1_000;

  const tooSoon = workAt(workload, second.sourceId, new Date(earliest - 1_000).toISOString());
  assert.equal(tooSoon.status, 'queued');
  assert.equal(tooSoon.pacing_reason, 'interval');
  assert.equal(Date.parse(String(tooSoon.not_before)), earliest, 'the refusal states the exact instant the Connection is free');
  assert.equal(server.requests().length, 1, 'a refused export reads nothing');

  const admitted = workAt(workload, second.sourceId, new Date(earliest).toISOString());
  assert.equal(admitted.status, 'complete', JSON.stringify(admitted));
  assert.equal(admitted.plan?.created_at, new Date(earliest).toISOString());
  assert.equal(server.requests().length, 2, 'the admitted export read exactly once');

  const settled = pacing(workload);
  assert.deepEqual(settled.active, [], 'a finished export releases its slot');
  assert.deepEqual(
    settled.queue.map((entry) => entry.source_id),
    workload.sources.slice(2).map((source) => source.sourceId),
    'the rest of the sweep waits durably rather than being dropped',
  );
  await server.close();
});

test('hourly scheduled sweeps keep start tolerance, publication freshness, and idempotent identities', async () => {
  const server = await startHttpSource({ replies: bmsReplies(3) });
  const workload = configureBmsWorkload(server);
  const created = creationWindow(workload);

  // Sweep one governs the first export of every Source.
  const first = manualSweep(workload, created.latest + 45_000);
  for (const [index, result] of first.entries()) {
    assert.equal(result.raw_acquisition_count, 1, `${workload.sources[index]!.name} kept one export fragment`);
    assert.equal(result.batch_raw_acquisition_count, 1);
    assert.equal(result.records, BMS_EXPECTED.sweeps[0]!.records_per_source);
    assert.equal(result.dataset_release, 1, `${workload.sources[index]!.name} published its first Release`);
    const released = dataset(workload, workload.sources[index]!.sourceId);
    assert.deepEqual(
      released.records.map((record) => record.identity).sort(),
      expectedIdentities(BMS_SOURCES[index]!, 0),
    );
    assert.equal(checkpoint(workload, workload.sources[index]!.sourceId)?.['watermark'], BMS_EXPECTED.sweeps[0]!.window.to);
  }
  assert.equal(
    first.reduce((total, result) => total + (result.records ?? 0), 0),
    BMS_EXPECTED.sweeps[0]!.records,
    'the whole sweep governs the expected number of records',
  );

  // ---------------------------------------------------------------------------
  // The next sweep deliberately re-reads one hour the first sweep already read,
  // and the export carries one edited record and one new record. Nothing is
  // duplicated: the identity of an edited record is the same record, updated.
  // ---------------------------------------------------------------------------
  const second = scheduledSweep(workload, first);
  const before = dataset(workload, workload.sources[0]!.sourceId, 1);
  const after = dataset(workload, workload.sources[0]!.sourceId, 2);
  const editedIdentity = expectedIdentities(BMS_SOURCES[0]!, 0)[0]!;
  assert.deepEqual(
    after.records.map((record) => record.identity).sort(),
    expectedIdentities(BMS_SOURCES[0]!, 1),
    'an overlapping export adds only the records it really added',
  );
  assert.notDeepEqual(
    after.records.find((record) => record.identity === editedIdentity)?.values,
    before.records.find((record) => record.identity === editedIdentity)?.values,
    'the edited record became a new value of the same identity',
  );
  assert.equal(
    second.reduce((total, result) => total + (result.records ?? 0), 0),
    BMS_EXPECTED.sweeps[1]!.records,
  );
  for (const [index, result] of second.entries()) {
    const released = dataset(workload, workload.sources[index]!.sourceId);
    assert.equal(result.raw_acquisition_count, 1, 'the overlapping export really was acquired again');
    assert.equal(result.dataset_release, 2, `${workload.sources[index]!.name} published one further Release`);
    assert.equal(released.record_count, BMS_EXPECTED.sweeps[1]!.records_per_source);
    assert.deepEqual(released.records.map((record) => record.identity).sort(), expectedIdentities(BMS_SOURCES[index]!, 1));
    assert.equal(checkpoint(workload, workload.sources[index]!.sourceId)?.['watermark'], BMS_EXPECTED.sweeps[1]!.window.to);
  }

  // ---------------------------------------------------------------------------
  // A repeated export of the same content reconciles to the same records, so it
  // advances no Release: the sweep is new, the governed data is not.
  // ---------------------------------------------------------------------------
  const third = scheduledSweep(workload, second);
  for (const [index, result] of third.entries()) {
    assert.equal(result.status, 'complete');
    assert.equal(result.trigger, 'scheduled');
    assert.equal(result.raw_acquisition_count, 1, 'the repeated export really was acquired again');
    assert.ok(result.integration_batch_id !== null, 'and handed over its own Integration Batch');
    assert.equal(result.dataset_release, 2, 'but it reconciled to the Release already governed');
    const released = dataset(workload, workload.sources[index]!.sourceId);
    assert.equal(released.dataset_release, 2);
    assert.equal(released.record_count, BMS_EXPECTED.sweeps[2]!.records_per_source);
    assert.deepEqual(
      released.records.map((record) => record.identity).sort(),
      expectedIdentities(BMS_SOURCES[index]!, 2),
      `${workload.sources[index]!.name} keeps stable identities across repetitions`,
    );
    assert.equal(checkpoint(workload, workload.sources[index]!.sourceId)?.['watermark'], BMS_EXPECTED.sweeps[2]!.window.to);
  }
  assert.equal(server.requests().length, BMS_EXPECTED.sources * 3, 'every sweep read every export exactly once');

  // ---------------------------------------------------------------------------
  // The two scheduled sweeps are the evidence the schedule's own promises are
  // measured from: the ledger states each due instant, start, and completion, so
  // start tolerance and complete-sweep publication freshness are read externally
  // rather than assumed.
  // ---------------------------------------------------------------------------
  for (const source of workload.sources) {
    const report = targets(workload, source.sourceId);
    assert.deepEqual(report.schedule, {
      every_minutes: 60,
      start_tolerance_seconds: BMS_EXPECTED.start_tolerance_seconds,
    });
    assert.deepEqual(report.publication_targets, {
      p95_seconds: BMS_EXPECTED.publication_p95_seconds,
      p99_seconds: BMS_EXPECTED.publication_p99_seconds,
    });
    assert.equal(report.runs.length, 2, 'the two scheduled sweeps are the measured evidence');
    assert.deepEqual(
      { samples: report.start?.samples, late: report.start?.late, maximum: report.start?.maximum_latency_seconds },
      { samples: 2, late: 0, maximum: 45 },
      `${source.name} started every scheduled Run inside its 60-second tolerance`,
    );
    assert.equal(report.start?.met, true);
    assert.deepEqual(
      {
        samples: report.publication?.samples,
        failed: report.publication?.failed,
        p95: report.publication?.p95_seconds,
        p99: report.publication?.p99_seconds,
      },
      { samples: 2, failed: 0, p95: 45, p99: 45 },
      `${source.name} published every scheduled sweep inside its freshness targets`,
    );
    assert.equal(report.publication?.met, true);
  }
  await server.close();
});

test('the engine and application hold no business case, only generic configuration', () => {
  // The business system is configuration and frozen certification assets. A
  // business-case-named module, branch, schema key, or special case in the
  // engine or the browser application would mean removing the Reference
  // Workload could not leave a fully functional generic Deployment.
  const BUSINESS_CASE = /\bBMS\b|ai[-_]?acc|\bYKM\b|service-orders|spare-part-issues|warranty-contracts|branch-stock|服务工单|退款单|备件出库|设备档案|上门记录|投诉工单|网点库存|结算单|保修合同|会话明细/u;
  const roots = ['../../../src', '../../../web/src'].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      if (BUSINESS_CASE.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], 'the business case lives only in Workspace configuration and certification assets');
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/u.test(path) ? [path] : [];
  });
}
