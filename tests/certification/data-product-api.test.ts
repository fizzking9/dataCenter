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

const DEVICE_LEDGER = '设备SN,城市,处理量\n  sn-001 ,杭州,3\nsn-002,上海,5\n';
const DEVICE_LEDGER_NEXT = '设备SN,城市,处理量\nsn-001,杭州,4\nsn-002,上海,5\n';

const CONTRACT = {
  title: '设备维修台账',
  description: '按设备序列号组织的维修处理量',
  fields: [
    { name: 'sn', description: '设备序列号' },
    { name: 'city', description: '所属城市' },
    { name: 'handled_count', description: '处理量' },
  ],
  filters: ['city'],
  limit: { default: 100, max: 500 },
};

function publishSomething(
  fixture: PlatformFixture,
  token: string,
  workspaceId: string,
  sourceName = '设备台账',
): string {
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', sourceName, '--type', 'file'],
    { token },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const published = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', {
      identity: ['sn'],
      schema: [
        { name: 'sn', type: 'string' },
        { name: 'city', type: 'string' },
        { name: 'handled_count', type: 'integer' },
      ],
      cleaning: [{ rule: 'trim', field: 'sn' }, { rule: 'uppercase', field: 'sn' }],
      mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' },
    })],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(published.output.integration_configuration_version)],
    { token },
  );
  return sourceId;
}

function acquireAndRelease(fixture: PlatformFixture, token: string, sourceId: string, content: string): Record<string, unknown> {
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, `ledger-${Date.now()}-${Math.random()}.csv`, content)],
    { token },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(released.status, 0, released.stderr);
  return upload.output;
}

interface DataProductPublication {
  data_product_id: string;
  name: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_hash: string;
}

function publishProduct(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  contract: unknown = CONTRACT,
): DataProductPublication {
  const result = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'contract', contract)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as DataProductPublication;
}

interface QueryResponse {
  records: Array<Record<string, unknown>>;
  matched_count: number;
  returned: number;
  truncated: boolean;
  limit: number;
  provenance: {
    dataset_release: number;
    integration_configuration_version: number;
    source: { source_id: string; name: string };
    business_context: { common_business_context_version: number; workspace_business_context_version: number };
    record_count: number;
    acquired_at: string;
    integrated_at: string;
    released_at: string;
  };
}

function query(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): QueryResponse {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'query', { include_totals: true, ...request })],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as QueryResponse;
}

test('Data Product Publication exposes a stable record-query API over one pinned Dataset Release', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const sourceId = publishSomething(fixture, workspaceAdministratorToken, workspaceId);
  const upload = acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, DEVICE_LEDGER);
  const rawId = String((upload['raw_acquisition'] as Record<string, unknown>)['raw_id']);

  const product = publishProduct(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(product.name, '设备维修台账');
  assert.equal(product.data_product_version, 1);
  assert.equal(product.data_product_release, 1);
  assert.equal(product.dataset_release, 1);
  assert.match(String(product.contract_hash), /^[0-9a-f]{64}$/);
  assert.equal(
    product.api_path,
    `/api/workspaces/${workspaceId}/data-products/${product.data_product_id}/query`,
  );

  const listed = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumerToken });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    (listed.output['data_products'] as Array<Record<string, unknown>>).map((entry) => entry['name']),
    ['设备维修台账'],
  );

  const filtered = query(fixture, consumerToken, product.data_product_id, {
    kind: 'records',
    filters: [{ field: 'city', op: 'equals', value: '上海' }],
  });
  assert.deepEqual(filtered.records, [{ sn: 'SN-002', city: '上海', handled_count: 5 }]);
  assert.equal(filtered.matched_count, 1);
  assert.equal(filtered.returned, 1);
  assert.equal(filtered.truncated, false);
  assert.equal(filtered.limit, 100);
  assert.deepEqual(filtered.provenance.source, { source_id: sourceId, name: '设备台账' });
  assert.equal(filtered.provenance.dataset_release, 1);
  assert.equal(filtered.provenance.integration_configuration_version, 1);
  assert.equal(filtered.provenance.record_count, 2);
  assert.deepEqual(filtered.provenance.business_context, {
    common_business_context_version: 0,
    workspace_business_context_version: 0,
  });

  const exposed = JSON.stringify(filtered);
  assert.equal(exposed.includes(rawId), false, 'a Consumer never sees a Raw Acquisition');
  assert.equal(exposed.includes('raw-acquisitions'), false, 'a Consumer never sees a raw object locator');
  assert.equal(exposed.includes('content_hash'), false, 'a Consumer never sees configuration internals');

  const truncated = query(fixture, consumerToken, product.data_product_id, { kind: 'records', limit: 1 });
  assert.equal(truncated.returned, 1);
  assert.equal(truncated.matched_count, 2);
  assert.equal(truncated.truncated, true);

  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, DEVICE_LEDGER_NEXT);
  const pinned = query(fixture, consumerToken, product.data_product_id, { kind: 'records' });
  assert.equal(pinned.provenance.dataset_release, 1);
  assert.deepEqual(pinned.records, [
    { sn: 'SN-001', city: '杭州', handled_count: 3 },
    { sn: 'SN-002', city: '上海', handled_count: 5 },
  ]);

  const republished = publishProduct(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(republished.data_product_id, product.data_product_id);
  assert.equal(republished.api_path, product.api_path, 'the published logical API path never changes');
  assert.equal(republished.data_product_version, 2);
  assert.equal(republished.data_product_release, 2);
  assert.equal(republished.dataset_release, 2);
  assert.equal(query(fixture, consumerToken, product.data_product_id, { kind: 'records' }).records[0]?.['handled_count'], 4);
});

test('a Consumer reads published Data Products only inside an administered Workspace', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, deploymentAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const sourceId = publishSomething(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, DEVICE_LEDGER);
  const product = publishProduct(fixture, workspaceAdministratorToken, sourceId);

  createUser(fixture, deploymentAdministratorToken, 'outsider@example.invalid', 'outsider-administrator');
  createWorkspace(fixture, deploymentAdministratorToken, 'Isolation', 'outsider@example.invalid');
  const outsiderToken = sessionFor(fixture, 'outsider@example.invalid', 'outsider-administrator');

  const foreign = command(
    fixture,
    ['product', 'query', '--product', product.data_product_id, '--request', jsonFile(fixture, 'query-foreign', { kind: 'records' })],
    { token: outsiderToken },
  );
  const absent = command(
    fixture,
    ['product', 'query', '--product', '00000000-0000-4000-8000-000000000000', '--request', jsonFile(fixture, 'query-absent', { kind: 'records' })],
    { token: outsiderToken },
  );
  assert.equal(foreign.status, 2);
  assert.equal(absent.status, 2);
  assert.deepEqual(foreign.error, absent.error, 'a foreign Data Product answers exactly like an absent one');

  const unauthorized = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'contract', CONTRACT)],
    { token: consumerToken },
  );
  assert.equal(unauthorized.status, 2);
  assert.equal(unauthorized.error.code, 'SOURCE_NOT_AVAILABLE');

  const undeclaredFilter = command(
    fixture,
    ['product', 'query', '--product', product.data_product_id, '--request', jsonFile(fixture, 'query-undeclared', {
      kind: 'records',
      filters: [{ field: 'sn', op: 'equals', value: 'SN-001' }],
    })],
    { token: consumerToken },
  );
  assert.equal(undeclaredFilter.status, 2);
  assert.equal(undeclaredFilter.error.code, 'DATA_PRODUCT_QUERY_REFUSED');

  const overLimit = command(
    fixture,
    ['product', 'query', '--product', product.data_product_id, '--request', jsonFile(fixture, 'query-over-limit', {
      kind: 'records',
      limit: 501,
    })],
    { token: consumerToken },
  );
  assert.equal(overLimit.status, 2);
  assert.equal(overLimit.error.code, 'DATA_PRODUCT_QUERY_LIMIT_EXCEEDED');

  const aggregate = command(
    fixture,
    ['product', 'query', '--product', product.data_product_id, '--request', jsonFile(fixture, 'query-aggregate', {
      kind: 'aggregate',
    })],
    { token: consumerToken },
  );
  assert.equal(aggregate.status, 2);
  assert.equal(aggregate.error.code, 'DATA_PRODUCT_QUERY_REFUSED');
});

test('a published name cannot be moved to another Source and filter values keep their declared type', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = workspaceFixture();
  const sourceId = publishSomething(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, DEVICE_LEDGER);
  const product = publishProduct(fixture, workspaceAdministratorToken, sourceId);

  const otherSource = publishSomething(fixture, workspaceAdministratorToken, workspaceId, '退款明细');
  acquireAndRelease(fixture, workspaceAdministratorToken, otherSource, DEVICE_LEDGER_NEXT);
  const collided = command(
    fixture,
    ['product', 'publish', '--source', otherSource, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'contract', CONTRACT)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(collided.status, 2);
  assert.equal(collided.error.code, 'DATA_PRODUCT_NAME_TAKEN');
  assert.equal(query(fixture, consumerToken, product.data_product_id, { kind: 'records' }).records[0]?.['handled_count'], 3);

  const mistyped = command(
    fixture,
    ['product', 'query', '--product', product.data_product_id, '--request', jsonFile(fixture, 'query-mistyped', {
      kind: 'records',
      filters: [{ field: 'city', op: 'equals', value: 5 }],
    })],
    { token: consumerToken },
  );
  assert.equal(mistyped.status, 2);
  assert.equal(mistyped.error.code, 'DATA_PRODUCT_QUERY_REFUSED');
});

test('exact totals are opt-in and the Contract envelope follows spec section 15', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const sourceId = publishSomething(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, DEVICE_LEDGER);
  const product = publishProduct(fixture, workspaceAdministratorToken, sourceId);
  const metricProduct = publishProduct(fixture, workspaceAdministratorToken, sourceId, {
    ...CONTRACT,
    title: '设备维修台账计数',
    dimensions: ['city'],
    metrics: [{ name: 'device_count', aggregation: 'count', value_type: 'integer' }],
  });

  const raw = (request: Record<string, unknown>, slug: string, target = product.data_product_id): Record<string, unknown> => {
    const result = command(
      fixture,
      ['product', 'query', '--product', target, '--request', jsonFile(fixture, slug, request)],
      { token: consumerToken },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.output;
  };

  const recordsDefault = raw({ kind: 'records' }, 'records-default');
  assert.equal('matched_count' in recordsDefault, false, 'a record page states no exact population by default');
  const recordsOpted = raw({ kind: 'records', include_totals: true }, 'records-opted');
  assert.equal(recordsOpted['matched_count'], 2);
  const aggregateDefault = raw(
    { kind: 'aggregate', group_by: ['city'], metrics: ['device_count'] },
    'aggregate-default',
    metricProduct.data_product_id,
  );
  assert.equal('groups_total' in aggregateDefault, false, 'an aggregate page states no exact group count by default');
  const aggregateOpted = raw(
    { kind: 'aggregate', group_by: ['city'], metrics: ['device_count'], include_totals: true },
    'aggregate-opted',
    metricProduct.data_product_id,
  );
  assert.equal(aggregateOpted['groups_total'], 2);

  const invalid = (contract: Record<string, unknown>, slug: string): string => {
    const result = command(
      fixture,
      ['product', 'publish', '--source', sourceId, '--name', `契约-${slug}`, '--contract', jsonFile(fixture, `contract-${slug}`, contract)],
      { token: workspaceAdministratorToken },
    );
    assert.equal(result.status, 2, result.stdout);
    return String(result.error['code']);
  };
  assert.equal(invalid({ ...CONTRACT, limit: { default: 100, max: 501 } }, 'page-max'), 'DATA_PRODUCT_CONTRACT_INVALID');
  assert.equal(
    invalid({ ...CONTRACT, limits: { max_scanned_records: 100_000, max_groups: 5_001, max_execution_ms: 5_000 } }, 'groups-max'),
    'DATA_PRODUCT_CONTRACT_INVALID',
  );
  assert.equal(
    invalid({ ...CONTRACT, limits: { max_scanned_records: 100_000, max_groups: 5_000, max_execution_ms: 10_001 } }, 'exec-max'),
    'DATA_PRODUCT_CONTRACT_INVALID',
  );
});
