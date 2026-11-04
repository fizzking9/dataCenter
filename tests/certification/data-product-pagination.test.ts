import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  command,
  createUser,
  createWorkspace,
  jsonFile,
  sessionFor,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

const LEDGER = [
  '设备SN,城市,处理量,负责人',
  'sn-001,杭州,3,张三',
  'sn-002,上海,5,李四',
  'sn-003,杭州,2,王五',
  'sn-004,上海,7,张三',
  'sn-005,杭州,4,李四',
  '',
].join('\n');

const LEDGER_NEXT = [
  '设备SN,城市,处理量,负责人',
  'sn-001,杭州,9,张三',
  'sn-002,上海,5,李四',
  'sn-003,杭州,2,王五',
  'sn-004,上海,7,张三',
  'sn-005,杭州,4,李四',
  '',
].join('\n');

const SCHEMA = [
  { name: 'sn', type: 'string' },
  { name: 'city', type: 'string' },
  { name: 'handled_count', type: 'integer' },
  { name: 'owner', type: 'string' },
];

interface ContractShape {
  title: string;
  fields: Array<{ name: string }>;
  dimensions: string[];
  metrics: Array<Record<string, unknown>>;
  grain: string[];
  filters: string[];
  limit: { default: number; max: number };
}

function contractShape(overrides: Partial<ContractShape> = {}): ContractShape {
  return {
    title: '设备处理量',
    fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }],
    dimensions: ['city'],
    metrics: [
      { name: 'device_count', aggregation: 'count', value_type: 'integer' },
      { name: 'handled_total', aggregation: 'sum', field: 'handled_count', value_type: 'integer' },
    ],
    grain: ['sn'],
    filters: ['city'],
    limit: { default: 100, max: 500 },
    ...overrides,
  };
}

/** The additive change: one exposed field, one dimension, and one filter are added. */
const ADDITIVE_CONTRACT = contractShape({
  fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }, { name: 'owner' }],
  dimensions: ['city', 'owner'],
  filters: ['city', 'owner'],
});

/** The breaking change: a published field and the metric reading it are withdrawn. */
const BREAKING_CONTRACT = contractShape({
  fields: [{ name: 'sn' }, { name: 'city' }],
  metrics: [{ name: 'device_count', aggregation: 'count', value_type: 'integer' }],
});

interface Publication {
  data_product_id: string;
  data_product_version: number;
  data_product_release: number;
  contract_version: { major: number; minor: number };
}

function publishSource(
  fixture: PlatformFixture,
  token: string,
  workspaceId: string,
  name: string,
): string {
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', name, '--type', 'file'],
    { token },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const configuration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `integration-${name}`, {
      identity: ['sn'],
      schema: SCHEMA,
      cleaning: [{ rule: 'trim', field: 'sn' }, { rule: 'uppercase', field: 'sn' }],
      mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count', 负责人: 'owner' },
    })],
    { token },
  );
  assert.equal(configuration.status, 0, configuration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(configuration.output.integration_configuration_version)],
    { token },
  );
  return sourceId;
}

function acquireAndRelease(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  content: string,
): void {
  const uploaded = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, `ledger-${Date.now()}-${Math.random()}.csv`, content)],
    { token },
  );
  assert.equal(uploaded.status, 0, uploaded.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(released.status, 0, released.stderr);
}

function publish(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  contract: ContractShape,
): Publication {
  const result = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备处理量', '--contract', jsonFile(fixture, 'contract', contract)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as Publication;
}

interface PageResponse {
  records: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  matched_count?: number;
  groups_total?: number;
  returned: number;
  truncated: boolean;
  next_cursor: string | null;
  data_product_release: number;
  data_product_version: number;
  contract_version: { major: number; minor: number };
  provenance: { dataset_release: number };
}

function query(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): PageResponse {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'query', request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as PageResponse;
}

function queryFailure(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): string {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'query-failing', request)],
    { token },
  );
  assert.equal(result.status, 2, `expected a structured refusal, got ${result.stdout}`);
  return String(result.error.code);
}

function readyProduct(options: { content?: string; contract?: ContractShape } = {}): {
  fixture: PlatformFixture;
  workspaceId: string;
  sourceId: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  productId: string;
} {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId, '设备台账');
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, options.content ?? LEDGER);
  const product = publish(fixture, workspaceAdministratorToken, sourceId, options.contract ?? contractShape());
  return { fixture, workspaceId, sourceId, workspaceAdministratorToken, consumerToken, productId: product.data_product_id };
}

test('a Consumer pages one pinned Release with bounded, tie-broken cursors', () => {
  const { fixture, consumerToken, productId } = readyProduct();

  const first = query(fixture, consumerToken, productId, { kind: 'records', limit: 2 });
  assert.deepEqual(first.records.map((record) => record['sn']), ['SN-001', 'SN-002']);
  assert.equal(first.matched_count, 5);
  assert.equal(first.returned, 2);
  assert.equal(first.truncated, true);
  assert.equal(typeof first.next_cursor, 'string');
  assert.deepEqual(first.contract_version, { major: 1, minor: 0 });

  const second = query(fixture, consumerToken, productId, {
    kind: 'records',
    limit: 2,
    cursor: first.next_cursor,
  });
  assert.deepEqual(second.records.map((record) => record['sn']), ['SN-003', 'SN-004']);

  const third = query(fixture, consumerToken, productId, {
    kind: 'records',
    limit: 2,
    cursor: second.next_cursor,
  });
  assert.deepEqual(third.records.map((record) => record['sn']), ['SN-005']);
  assert.equal(third.truncated, false);
  assert.equal(third.next_cursor, null);

  const paged = [...first.records, ...second.records, ...third.records];
  const oneShot = query(fixture, consumerToken, productId, { kind: 'records', limit: 100 });
  assert.deepEqual(
    paged,
    oneShot.records,
    'paging visits every record once, in the same deterministic order as one page',
  );

  // Changing the page size keeps the cursor: only the query itself pins it.
  const resized = query(fixture, consumerToken, productId, {
    kind: 'records',
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.deepEqual(resized.records.map((record) => record['sn']), ['SN-003']);

  // A cursor never becomes a way around authorization: another Workspace's
  // Consumer reads the same refusal an absent Data Product answers with.
  const deploymentAdministratorToken = sessionFor(
    fixture,
    fixture.administrator.username,
    fixture.administrator.password,
  );
  createUser(fixture, deploymentAdministratorToken, 'intruder@example.invalid', 'intruder-administrator');
  createWorkspace(fixture, deploymentAdministratorToken, '隔离区', 'intruder@example.invalid');
  const intruderToken = sessionFor(fixture, 'intruder@example.invalid', 'intruder-administrator');
  const foreign = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'foreign-cursor', {
      kind: 'records',
      cursor: first.next_cursor,
    })],
    { token: intruderToken },
  );
  assert.equal(foreign.status, 2);
  assert.equal(foreign.error.code, 'DATA_PRODUCT_NOT_AVAILABLE');
});

test('a cursor is invalidated by a different query, Release, or Contract line', () => {
  const { fixture, consumerToken, productId, workspaceAdministratorToken, sourceId } = readyProduct();
  const first = query(fixture, consumerToken, productId, { kind: 'records', limit: 2 });

  const changedQuery = queryFailure(fixture, consumerToken, productId, {
    kind: 'records',
    limit: 2,
    cursor: first.next_cursor,
    filters: [{ field: 'city', op: 'equals', value: '杭州' }],
  });
  assert.equal(changedQuery, 'DATA_PRODUCT_QUERY_CURSOR_INVALID');

  const changedKind = queryFailure(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    cursor: first.next_cursor,
  });
  assert.equal(changedKind, 'DATA_PRODUCT_QUERY_CURSOR_INVALID');

  const tampered = `${String(first.next_cursor).slice(0, -2)}zz`;
  assert.equal(
    queryFailure(fixture, consumerToken, productId, { kind: 'records', limit: 2, cursor: tampered }),
    'DATA_PRODUCT_QUERY_CURSOR_INVALID',
  );

  const aggregateFirst = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    sort: [{ by: 'city', direction: 'asc' }],
    limit: 1,
  });
  assert.equal(aggregateFirst.groups_total, 2);
  assert.equal(typeof aggregateFirst.next_cursor, 'string');
  const aggregateSecond = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    sort: [{ by: 'city', direction: 'asc' }],
    limit: 1,
    cursor: aggregateFirst.next_cursor,
  });
  assert.deepEqual(
    [aggregateFirst.groups, aggregateSecond.groups].flat().map((group) => group?.['group']),
    [{ city: '上海' }, { city: '杭州' }],
  );

  // A cursor issued at one Release is not a ticket into another.
  const republished = publish(fixture, workspaceAdministratorToken, sourceId, contractShape());
  assert.equal(republished.data_product_release, 2);
  assert.equal(
    queryFailure(fixture, consumerToken, productId, {
      kind: 'records',
      limit: 2,
      cursor: first.next_cursor,
    }),
    'DATA_PRODUCT_QUERY_CURSOR_INVALID',
  );
  assert.deepEqual(
    query(fixture, consumerToken, productId, { kind: 'records', release: 1, limit: 2 }).records.map((record) => record['sn']),
    ['SN-001', 'SN-002'],
  );
});

test('historical Releases stay readable and never fall back to current data', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = workspaceFixture();
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId, '设备台账');
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, LEDGER);
  const product = publish(fixture, workspaceAdministratorToken, sourceId, contractShape());

  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, LEDGER_NEXT);
  const republished = publish(fixture, workspaceAdministratorToken, sourceId, contractShape());
  assert.equal(republished.data_product_release, 2);

  const historical = query(fixture, consumerToken, product.data_product_id, { kind: 'records', release: 1 });
  assert.equal(historical.provenance.dataset_release, 1);
  assert.equal(historical.records[0]?.['handled_count'], 3);

  const current = query(fixture, consumerToken, product.data_product_id, { kind: 'records' });
  assert.equal(current.provenance.dataset_release, 2);
  assert.equal(current.records[0]?.['handled_count'], 9);

  assert.equal(
    queryFailure(fixture, consumerToken, product.data_product_id, { kind: 'records', release: 99 }),
    'DATA_PRODUCT_RELEASE_NOT_FOUND',
  );

  const historicalPage = query(fixture, consumerToken, product.data_product_id, { kind: 'records', release: 1, limit: 2 });
  const historicalRest = query(fixture, consumerToken, product.data_product_id, {
    kind: 'records',
    release: 1,
    limit: 3,
    cursor: historicalPage.next_cursor,
  });
  assert.deepEqual(
    [...historicalPage.records, ...historicalRest.records].map((record) => record['handled_count']),
    [3, 5, 2, 7, 4],
    'every page of a historical query reads the historical Release',
  );
  assert.equal(
    queryFailure(fixture, consumerToken, product.data_product_id, {
      kind: 'records',
      cursor: historicalPage.next_cursor,
    }),
    'DATA_PRODUCT_QUERY_CURSOR_INVALID',
    'a historical cursor never continues against current data',
  );
});

test('an additive Contract change keeps its major line and a breaking change opens one', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = workspaceFixture();
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId, '设备台账');
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, LEDGER);

  const first = publish(fixture, workspaceAdministratorToken, sourceId, contractShape());
  assert.deepEqual(first.contract_version, { major: 1, minor: 0 });

  const additive = publish(fixture, workspaceAdministratorToken, sourceId, ADDITIVE_CONTRACT);
  assert.equal(additive.data_product_id, first.data_product_id);
  assert.deepEqual(additive.contract_version, { major: 1, minor: 1 });
  assert.equal(additive.data_product_release, 2);

  const onMajor = query(fixture, consumerToken, first.data_product_id, { kind: 'records', major: 1 });
  assert.equal(onMajor.data_product_release, 2, 'the major line advances its own current Release');
  assert.deepEqual(onMajor.contract_version, { major: 1, minor: 1 });
  assert.equal(onMajor.records[0]?.['owner'], '张三');

  const breaking = publish(fixture, workspaceAdministratorToken, sourceId, BREAKING_CONTRACT);
  assert.deepEqual(breaking.contract_version, { major: 2, minor: 0 });
  assert.equal(breaking.data_product_release, 3);

  const frozen = query(fixture, consumerToken, first.data_product_id, { kind: 'records', major: 1 });
  assert.equal(frozen.data_product_release, 2, 'the previous major line keeps serving its own Release');
  assert.equal(frozen.records[0]?.['handled_count'], 3);

  const newest = query(fixture, consumerToken, first.data_product_id, { kind: 'records' });
  assert.equal(newest.data_product_release, 3, 'a query without a line reads the newest active major');
  assert.equal(newest.records[0]?.['handled_count'], undefined);

  assert.equal(
    queryFailure(fixture, consumerToken, first.data_product_id, { kind: 'records', major: 9 }),
    'DATA_PRODUCT_MAJOR_NOT_FOUND',
  );
  assert.equal(
    queryFailure(fixture, consumerToken, first.data_product_id, { kind: 'records', major: 1, release: 3 }),
    'DATA_PRODUCT_RELEASE_NOT_FOUND',
    'a Release never answers for a major line it does not belong to',
  );

  const releases = command(fixture, ['product', 'releases', '--product', first.data_product_id], { token: consumerToken });
  assert.equal(releases.status, 0, releases.stderr);
  assert.deepEqual(
    (releases.output.releases as Array<Record<string, unknown>>).map((release) => [
      release['release'],
      (release['contract_version'] as { major: number }).major,
    ]),
    [[1, 1], [2, 1], [3, 2]],
  );
});

test('a withdrawn major line stops serving while its governed history stays readable', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = workspaceFixture();
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId, '设备台账');
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, LEDGER);

  const first = publish(fixture, workspaceAdministratorToken, sourceId, contractShape());
  const breaking = publish(fixture, workspaceAdministratorToken, sourceId, BREAKING_CONTRACT);
  const additive = publish(fixture, workspaceAdministratorToken, sourceId, {
    ...BREAKING_CONTRACT,
    fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }],
    metrics: [
      { name: 'device_count', aggregation: 'count', value_type: 'integer' },
      { name: 'handled_total', aggregation: 'sum', field: 'handled_count', value_type: 'integer' },
    ],
  });
  assert.deepEqual(additive.contract_version, { major: 2, minor: 1 });
  assert.equal(query(fixture, consumerToken, first.data_product_id, { kind: 'records' }).data_product_release, 3);

  const withdrawn = command(
    fixture,
    ['product', 'withdraw', '--product', first.data_product_id, '--version', String(breaking.data_product_version + 1)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(withdrawn.status, 0, withdrawn.stderr);

  assert.equal(
    queryFailure(fixture, consumerToken, first.data_product_id, { kind: 'records', major: 2 }),
    'DATA_PRODUCT_MAJOR_WITHDRAWN',
  );
  assert.equal(
    queryFailure(fixture, consumerToken, first.data_product_id, { kind: 'records', release: 3 }),
    'DATA_PRODUCT_VERSION_WITHDRAWN',
  );

  const fallback = query(fixture, consumerToken, first.data_product_id, { kind: 'records' });
  assert.equal(fallback.data_product_release, 1, 'the newest active major line takes over');
  assert.deepEqual(fallback.contract_version, { major: 1, minor: 0 });
  assert.equal(fallback.records[0]?.['handled_count'], 3);

  const unauthorised = command(
    fixture,
    ['product', 'withdraw', '--product', first.data_product_id, '--version', '1'],
    { token: consumerToken },
  );
  assert.equal(unauthorised.status, 2);
  assert.equal(unauthorised.error.code, 'DATA_PRODUCT_NOT_AVAILABLE');
});
