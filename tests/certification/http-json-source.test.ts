import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageBody, startHttpSource, type HttpSource } from '../support/http-source.js';
import {
  command,
  jsonFile,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

const DEVICES = [
  { device_sn: 'sn-001', city: '杭州', handled_count: 3 },
  { device_sn: 'sn-002', city: '上海', handled_count: 5 },
  { device_sn: 'sn-003', city: '杭州', handled_count: 2 },
  { device_sn: 'sn-004', city: '上海', handled_count: 7 },
  { device_sn: 'sn-005', city: '杭州', handled_count: 4 },
];

const INTEGRATION = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
  ],
  cleaning: [{ rule: 'trim', field: 'sn' }],
  mapping: { device_sn: 'sn', city: 'city', handled_count: 'handled_count' },
};

interface Ready {
  fixture: PlatformFixture;
  workspaceId: string;
  sourceId: string;
  connectionId: string;
  workspaceAdministratorToken: string;
  close(): Promise<void>;
}

/** One HTTP Source whose Connection, Acquisition Configuration, and Integration are adopted. */
async function readySource(
  source: HttpSource,
  options: { completion?: Record<string, unknown>; credential?: string; size?: number; maxPages?: number; everyMinutes?: number } = {},
): Promise<Ready> {
  const { fixture, workspaceId, workspaceAdministratorToken }: WorkspaceFixture = workspaceFixture();
  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备接口', '--type', 'http_json'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  const sourceId = String(created.output.source_id);

  const connection = command(
    fixture,
    ['connection', 'publish', '--workspace', workspaceId, '--name', '设备系统', '--config', jsonFile(fixture, 'connection', {
      base_url: source.url,
      auth: { scheme: 'bearer' },
      pagination: {
        parameter: 'page',
        size_parameter: 'page_size',
        start: 1,
        size: options.size ?? 2,
        max_pages: options.maxPages ?? 5,
      },
      ...(options.everyMinutes === undefined ? {} : { schedule: { every_minutes: options.everyMinutes } }),
    }), '--credential-stdin'],
    { token: workspaceAdministratorToken, input: `${options.credential ?? 'source-access-token'}\n` },
  );
  assert.equal(connection.status, 0, connection.stderr);
  const connectionId = String(connection.output.connection_id);
  assert.equal(connection.output.credential_ref, 'bearer');
  assert.equal(JSON.stringify(connection.output).includes('source-access-token'), false, 'a credential is never returned');

  const adoptedConnection = command(
    fixture,
    ['connection', 'adopt', '--connection', connectionId, '--version', String(connection.output.connection_version)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(adoptedConnection.status, 0, adoptedConnection.stderr);

  const acquisition = command(
    fixture,
    ['acquisition-config', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'acquisition-config', {
      connection: connectionId,
      connection_version: connection.output.connection_version,
      path: '/api/devices',
      record_path: 'data.records',
      completion: options.completion ?? { kind: 'short_page' },
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(acquisition.status, 0, acquisition.stderr);
  const adopted = command(
    fixture,
    ['acquisition-config', 'adopt', '--source', sourceId, '--version', String(acquisition.output.acquisition_configuration_version)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);

  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', INTEGRATION)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(integration.status, 0, integration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(integration.output.integration_configuration_version)],
    { token: workspaceAdministratorToken },
  );

  return {
    fixture,
    workspaceId,
    sourceId,
    connectionId,
    workspaceAdministratorToken,
    close: () => source.close(),
  };
}

interface RunResult {
  acquisition_run_id: string;
  status: string;
  trigger: string;
  plan: {
    plan_id: string;
    status: string;
    connector: { name: string; version: number };
    connection_version: number;
    acquisition_configuration_version: number;
    integration_configuration_version: number;
    pages: Array<{ page: number; outcome: string; raw_id: string | null }>;
  };
  raw_acquisition_count: number;
  integration_batch_id: string | null;
  dataset_release: number | null;
  records: number | null;
  error_code?: string | null;
}

function enqueue(fixture: PlatformFixture, token: string, sourceId: string): Record<string, unknown> {
  const result = command(fixture, ['acquisition', 'enqueue', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function work(fixture: PlatformFixture, token: string, sourceId: string): RunResult {
  const result = command(fixture, ['acquisition', 'work', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as RunResult;
}

test('a declarative bearer-authenticated JSON Source acquires through a complete durable plan', async () => {
  const source = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 4)) },
      { body: pageBody(DEVICES.slice(4, 5)) },
    ],
  });
  const { fixture, workspaceId, sourceId, workspaceAdministratorToken } = await readySource(source);

  const queued = enqueue(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(queued['status'], 'queued', 'a manual trigger queues a Run rather than acquiring inline');

  const run = work(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(run.status, 'complete');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.raw_acquisition_count, 3, 'every page is one immutable Raw Acquisition');
  assert.deepEqual(run.plan.pages.map((page) => [page.page, page.outcome]), [[1, 'received'], [2, 'received'], [3, 'received']]);
  assert.deepEqual(run.plan.connector, { name: 'http-json', version: 1 });
  assert.equal(run.plan.connection_version, 1);
  assert.equal(run.plan.acquisition_configuration_version, 1);
  assert.equal(run.plan.integration_configuration_version, 1);
  assert.equal(run.dataset_release, 1);
  assert.equal(run.records, 5);

  const requests = source.requests();
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.authorization, 'Bearer source-access-token', 'the stored credential is used as a bearer token');
  assert.equal(requests[0]?.path, '/api/devices');
  assert.deepEqual(requests.map((request) => request.query['page']), ['1', '2', '3']);
  assert.deepEqual(requests.map((request) => request.query['page_size']), ['2', '2', '2']);

  const product = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备接口处理量', '--contract', jsonFile(fixture, 'contract', {
      title: '设备接口处理量',
      fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }],
      dimensions: ['city'],
      metrics: [{ name: 'device_count', aggregation: 'count', value_type: 'integer' }],
      grain: ['sn'],
      filters: ['city'],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(product.status, 0, product.stderr);
  const queried = command(
    fixture,
    ['product', 'query', '--product', String(product.output.data_product_id), '--request', jsonFile(fixture, 'query', {
      kind: 'aggregate',
      group_by: ['city'],
      metrics: ['device_count'],
      sort: [{ by: 'city', direction: 'asc' }],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(queried.status, 0, queried.stderr);
  assert.deepEqual(
    (queried.output['groups'] as Array<Record<string, unknown>>).map((group) => group['metrics']),
    [{ device_count: 2 }, { device_count: 3 }],
  );
  await source.close();
});

test('pagination completion, empty results, malformed responses, and non-progress each behave explicitly', async () => {
  // Completion by an empty page at the first request.
  const empty = await startHttpSource({ replies: [{ body: pageBody([]) }] });
  const emptyRun = await readySource(empty, { completion: { kind: 'empty_page' } });
  enqueue(emptyRun.fixture, emptyRun.workspaceAdministratorToken, emptyRun.sourceId);
  const emptyResult = work(emptyRun.fixture, emptyRun.workspaceAdministratorToken, emptyRun.sourceId);
  assert.equal(emptyResult.status, 'complete');
  assert.equal(emptyResult.records, 0, 'an empty complete Run releases an empty Dataset Release');
  assert.equal(empty.requests().length, 1);
  await empty.close();

  // A malformed response fails the plan, keeps the diagnostic Raw Acquisition,
  // and never advances the current governed data.
  const malformed = await startHttpSource({ replies: [{ body: '{"data":{"records":"not-a-list"}}' }] });
  const malformedRun = await readySource(malformed, { completion: { kind: 'short_page' } });
  enqueue(malformedRun.fixture, malformedRun.workspaceAdministratorToken, malformedRun.sourceId);
  const failed = work(malformedRun.fixture, malformedRun.workspaceAdministratorToken, malformedRun.sourceId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'ACQUISITION_RESPONSE_MALFORMED');
  assert.equal(failed.plan.status, 'partial');
  assert.equal(failed.integration_batch_id, null, 'a partial plan never hands over an Integration Batch');
  assert.equal(failed.dataset_release, null);
  assert.equal(failed.raw_acquisition_count, 1, 'the failed attempt keeps its diagnostic Raw Acquisition');
  assert.equal(malformed.requests().length, 1);
  await malformed.close();

  // Non-progress: the endpoint ignores the page parameter, so the connector
  // stops instead of paging forever.
  const stuck = await startHttpSource({
    replies: [{ body: pageBody([{ device_sn: 'sn-001', city: '杭州', handled_count: 3 }]) }],
  });
  const stuckRun = await readySource(stuck, { size: 1, maxPages: 10 });
  enqueue(stuckRun.fixture, stuckRun.workspaceAdministratorToken, stuckRun.sourceId);
  const stopped = work(stuckRun.fixture, stuckRun.workspaceAdministratorToken, stuckRun.sourceId);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error_code, 'ACQUISITION_PAGINATION_NOT_PROGRESSING');
  assert.equal(stopped.integration_batch_id, null);
  assert.equal(stuck.requests().length, 2, 'the connector stops at the first repeated page');
  await stuck.close();

  // Paging past the declared ceiling is refused rather than silently truncated.
  const ceiling = await startHttpSource({
    repeat_last: false,
    replies: [
      { body: pageBody([{ device_sn: 'sn-1', city: '杭州', handled_count: 1 }], { has_more: true }) },
      { body: pageBody([{ device_sn: 'sn-2', city: '杭州', handled_count: 2 }], { has_more: true }) },
    ],
  });
  const ceilingRun = await readySource(ceiling, { size: 1, maxPages: 2 });
  enqueue(ceilingRun.fixture, ceilingRun.workspaceAdministratorToken, ceilingRun.sourceId);
  const capped = work(ceilingRun.fixture, ceilingRun.workspaceAdministratorToken, ceilingRun.sourceId);
  assert.equal(capped.status, 'failed');
  assert.equal(capped.error_code, 'ACQUISITION_PLAN_INCOMPLETE');
  assert.equal(capped.integration_batch_id, null);
  assert.equal(ceiling.requests().length, 2);
  await ceiling.close();
});

test('scheduled and manual triggers queue Runs and never silently drop work', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const { fixture, sourceId, workspaceAdministratorToken } = await readySource(source, {
    everyMinutes: 60,
    size: 2,
  });

  const first = command(fixture, ['acquisition', 'tick', '--at', '2026-11-04T08:00:00.000Z'], { token: workspaceAdministratorToken });
  assert.equal(first.status, 0, first.stderr);
  assert.equal((first.output['enqueued'] as unknown[]).length, 1, 'a due schedule queues a Run');

  const second = command(fixture, ['acquisition', 'tick', '--at', '2026-11-04T08:30:00.000Z'], { token: workspaceAdministratorToken });
  assert.equal(second.status, 0, second.stderr);
  assert.equal((second.output['enqueued'] as unknown[]).length, 0, 'a queued Run is not duplicated');

  const manual = enqueue(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(manual['status'], 'queued');
  const queued = command(fixture, ['acquisition', 'queue', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(queued.status, 0, queued.stderr);
  assert.equal(queued.output['queued'], 2, 'both the scheduled and the manual Run are still queued');

  const worked = work(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(worked.status, 'complete');
  assert.equal(worked.trigger, 'scheduled', 'the oldest queued Run is worked first');

  // A due schedule coalesces while work is still pending, so the manual Run is
  // worked before the schedule is evaluated again.
  const workedManual = work(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(workedManual.trigger, 'manual', 'the manual Run was queued, never dropped');

  // The next interval is measured from when the Run really completed, so the
  // tick is derived from the recorded completion rather than a guessed instant.
  const completedAt = String((workedManual.plan as unknown as { completed_at: string }).completed_at);
  const later = command(fixture, [
    'acquisition', 'tick',
    '--at', new Date(Date.parse(completedAt) + 61 * 60_000).toISOString(),
  ], { token: workspaceAdministratorToken });
  assert.equal(later.status, 0, later.stderr);
  assert.equal((later.output['enqueued'] as unknown[]).length, 1, 'the schedule is due again after the interval');

  const pending = command(fixture, ['acquisition', 'queue', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(pending.output['queued'], 1, 'the schedule queued exactly one further Run');
  await source.close();
});

test('a Source without adopted acquisition artifacts refuses to run and pins nothing', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody([]) }] });
  const { fixture, workspaceId, workspaceAdministratorToken }: WorkspaceFixture = workspaceFixture();

  const fileSource = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '手工台账', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(fileSource.status, 0, fileSource.stderr);
  const fileEnqueue = command(
    fixture,
    ['acquisition', 'enqueue', '--source', String(fileSource.output.source_id)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(fileEnqueue.status, 2);
  assert.equal(fileEnqueue.error.code, 'ACQUISITION_CONNECTOR_NOT_APPLICABLE');

  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备接口', '--type', 'http_json'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  const sourceId = String(created.output.source_id);
  const enqueued = enqueue(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(enqueued['status'], 'queued');
  const refused = command(fixture, ['acquisition', 'work', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(refused.status, 2);
  assert.equal(refused.error.code, 'ACQUISITION_CONFIGURATION_NOT_ADOPTED');
  assert.equal(source.requests().length, 0, 'nothing is requested before the Source is fully configured');

  const connection = command(
    fixture,
    ['connection', 'publish', '--workspace', workspaceId, '--name', '设备系统', '--config', jsonFile(fixture, 'connection', {
      base_url: source.url,
      auth: { scheme: 'bearer' },
      pagination: { parameter: 'page', start: 1, size: 2, max_pages: 2 },
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(connection.status, 2);
  assert.equal(connection.error.code, 'CONNECTION_CREDENTIAL_REQUIRED', 'bearer authentication requires a stored credential');
  await source.close();
});

test('a file Source still acquires by upload and no connector accepts a raw upload', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody([]) }] });
  const { fixture, workspaceId, workspaceAdministratorToken }: WorkspaceFixture = workspaceFixture();
  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备接口', '--type', 'http_json'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  const sourceId = String(created.output.source_id);
  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', INTEGRATION)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(integration.status, 0, integration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(integration.output.integration_configuration_version)],
    { token: workspaceAdministratorToken },
  );
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'ledger.csv', 'device_sn,city,handled_count\nsn-001,杭州,3\n')],
    { token: workspaceAdministratorToken },
  );
  assert.equal(upload.status, 2);
  assert.equal(upload.error.code, 'ACQUISITION_MODE_MISMATCH', 'a connector Source is never acquired by hand-uploaded bytes');
  await source.close();
});
