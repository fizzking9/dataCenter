import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const CONTRACT = {
  title: '设备处理量',
  fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }, { name: 'owner' }],
  dimensions: ['city', 'owner'],
  metrics: [
    { name: 'device_count', aggregation: 'count', value_type: 'integer' },
    { name: 'handled_total', aggregation: 'sum', field: 'handled_count', value_type: 'integer' },
  ],
  grain: ['sn'],
  filters: ['city', 'owner'],
  limit: { default: 100, max: 500 },
};

interface Ready {
  fixture: PlatformFixture;
  workspaceId: string;
  sourceId: string;
  productId: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  outsiderToken: string;
}

/** A published Data Product with a Consumer in its Workspace and an outsider outside it. */
function readyProduct(): Ready {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const configuration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', {
      identity: ['sn'],
      schema: [
        { name: 'sn', type: 'string' },
        { name: 'city', type: 'string' },
        { name: 'handled_count', type: 'integer' },
        { name: 'owner', type: 'string' },
      ],
      cleaning: [{ rule: 'trim', field: 'sn' }, { rule: 'uppercase', field: 'sn' }],
      mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count', 负责人: 'owner' },
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(configuration.status, 0, configuration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(configuration.output.integration_configuration_version)],
    { token: workspaceAdministratorToken },
  );
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'ledger.csv', LEDGER)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(released.status, 0, released.stderr);
  const product = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备处理量', '--contract', jsonFile(fixture, 'contract', CONTRACT)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(product.status, 0, product.stderr);

  const deploymentAdministratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, deploymentAdministratorToken, 'outsider@example.invalid', 'outsider-administrator');
  createWorkspace(fixture, deploymentAdministratorToken, '隔离区', 'outsider@example.invalid');
  return {
    fixture,
    workspaceId,
    sourceId,
    productId: String(product.output.data_product_id),
    workspaceAdministratorToken,
    consumerToken,
    outsiderToken: sessionFor(fixture, 'outsider@example.invalid', 'outsider-administrator'),
  };
}

function publishGrant(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: unknown,
  username = 'analyst@example.invalid',
): Record<string, unknown> {
  const result = command(
    fixture,
    ['grant', 'publish', '--product', productId, '--username', username, '--request', jsonFile(fixture, 'grant', request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

interface Page {
  records: Array<Record<string, unknown>>;
  groups?: Array<Record<string, unknown>>;
  matched_count?: number;
  returned: number;
  scanned_records: number;
  next_cursor: string | null;
  cache: { reused: boolean };
  provenance: { dataset_release: number; record_count: number | null; permitted_record_count?: number };
}

function query(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): Page {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'query', request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as Page;
}

function refusal(
  fixture: PlatformFixture,
  token: string,
  args: string[],
  request: Record<string, unknown> | undefined = undefined,
): string {
  const full = request === undefined ? args : [...args, '--request', jsonFile(fixture, 'request', request)];
  const result = command(fixture, full, { token });
  assert.equal(result.status, 2, `expected a structured refusal, got ${result.stdout}`);
  return String(result.error.code);
}

test('a Grant narrows rows and columns before records, aggregates, counts, and rankings', () => {
  const { fixture, workspaceId, productId, workspaceAdministratorToken, consumerToken } = readyProduct();

  void publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'city', op: 'equals', value: '杭州' }],
  });

  const records = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.deepEqual(records.records.map((record) => record['sn']), ['SN-001', 'SN-003', 'SN-005']);
  assert.deepEqual(Object.keys(records.records[0]!), ['sn', 'city']);
  assert.equal(records.matched_count, 3, 'the row filter caps the counted population');
  assert.equal(records.scanned_records, 3, 'the reported scan never discloses the rows the Grant withholds');
  assert.equal(records.provenance.record_count, null, 'the Release total is withheld from a narrowed reader');
  assert.equal(records.provenance.permitted_record_count, 3);

  const grouped = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count'],
    sort: [{ by: 'device_count', direction: 'desc' }],
  });
  assert.deepEqual(grouped.groups, [
    { group: { city: '杭州' }, null_dimensions: [], metrics: { device_count: 3 } },
  ]);

  assert.equal(
    refusal(fixture, consumerToken, ['product', 'query', '--product', productId], {
      kind: 'aggregate',
      metrics: ['handled_total'],
    }),
    'DATA_PRODUCT_QUERY_REFUSED',
    'a metric reading a hidden column is refused',
  );
  assert.equal(
    refusal(fixture, consumerToken, ['product', 'query', '--product', productId], {
      kind: 'records',
      filters: [{ field: 'owner', op: 'equals', value: '张三' }],
    }),
    'DATA_PRODUCT_QUERY_REFUSED',
    'filtering on a hidden column is refused rather than answered',
  );
  assert.equal(
    refusal(fixture, consumerToken, ['product', 'query', '--product', productId], {
      kind: 'aggregate',
      group_by: ['owner'],
    }),
    'DATA_PRODUCT_QUERY_REFUSED',
    'grouping by a hidden column is refused',
  );

  const scoped = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumerToken });
  assert.equal(scoped.status, 0, scoped.stderr);
  const [entry] = scoped.output['data_products'] as Array<Record<string, unknown>>;
  assert.deepEqual(entry?.['fields'], ['sn', 'city'], 'a narrowed Grant also narrows discovery');
  assert.deepEqual((entry?.['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']), ['device_count']);
  assert.deepEqual(entry?.['dimensions'], ['city']);

  const administrator = query(fixture, workspaceAdministratorToken, productId, { kind: 'records' });
  assert.equal(administrator.matched_count, 5, 'a Workspace Administrator is not narrowed by a Consumer Grant');
  assert.equal(administrator.provenance.record_count, 5, 'an unrestricted reader still reads the Release provenance');
  assert.deepEqual(Object.keys(administrator.records[0]!).sort(), ['city', 'handled_count', 'owner', 'sn']);
});

test('grant, membership, and identity changes take effect on the next request, including pagination', () => {
  const { fixture, workspaceId, productId, workspaceAdministratorToken, consumerToken } = readyProduct();

  const grant = publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city', 'handled_count'],
    row_filters: [],
  });
  const first = query(fixture, consumerToken, productId, { kind: 'records', limit: 2 });
  assert.deepEqual(first.records.map((record) => record['sn']), ['SN-001', 'SN-002']);

  const revoked = command(fixture, ['grant', 'revoke', '--grant', String(grant.grant_id)], { token: workspaceAdministratorToken });
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal(
    refusal(fixture, consumerToken, ['product', 'query', '--product', productId], {
      kind: 'records',
      limit: 2,
      cursor: first.next_cursor,
    }),
    'DATA_PRODUCT_QUERY_CURSOR_INVALID',
    'a cursor pinned to a Grant scope never continues under a different one',
  );

  const narrowed = publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'city', op: 'equals', value: '上海' }],
  });
  const afterNarrowing = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.deepEqual(afterNarrowing.records.map((record) => record['sn']), ['SN-002', 'SN-004']);

  command(fixture, ['grant', 'revoke', '--grant', String(narrowed.grant_id)], { token: workspaceAdministratorToken });
  const membership = command(
    fixture,
    ['membership', 'revoke', '--workspace', workspaceId, '--username', 'analyst@example.invalid'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(membership.status, 0, membership.stderr);
  assert.equal(
    refusal(fixture, consumerToken, ['product', 'query', '--product', productId], { kind: 'records' }),
    'DATA_PRODUCT_NOT_AVAILABLE',
    'losing Workspace membership takes effect on the next request',
  );

  const user = command(
    fixture,
    ['user', 'deactivate', '--username', 'analyst@example.invalid'],
    { token: sessionFor(fixture, fixture.administrator.username, fixture.administrator.password) },
  );
  assert.equal(user.status, 0, user.stderr);
  assert.equal(
    refusal(fixture, consumerToken, ['product', 'query', '--product', productId], { kind: 'records' }),
    'SESSION_INVALID',
    'a deactivated identity cannot reuse its session',
  );
});

test('cache reuse requires the complete security and Release context', () => {
  const { fixture, productId, sourceId, workspaceAdministratorToken, consumerToken } = readyProduct();

  const first = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.equal(first.cache.reused, false, 'the first read computes the answer');
  const second = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.equal(second.cache.reused, true, 'an identical read under the same context is reused');
  assert.deepEqual(second.records, first.records);

  const grant = publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city'],
    row_filters: [],
  });
  const afterGrant = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.equal(afterGrant.cache.reused, false, 'a new Grant context never reuses the previous answer');
  assert.deepEqual(Object.keys(afterGrant.records[0]!), ['sn', 'city']);

  command(fixture, ['grant', 'revoke', '--grant', String(grant.grant_id)], { token: workspaceAdministratorToken });
  // The revoked Grant is re-evaluated before anything is reused: the metric it
  // withheld is readable again on the very next request.
  const afterRevocation = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    metrics: ['handled_total'],
  });
  assert.deepEqual(afterRevocation.groups?.[0]?.['metrics'], { handled_total: 21 });
  const widened = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.deepEqual(Object.keys(widened.records[0]!).sort(), ['city', 'handled_count', 'owner', 'sn']);

  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'ledger-2.csv', LEDGER.replace('sn-001,杭州,3', 'sn-001,杭州,9'))],
    { token: workspaceAdministratorToken },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token: workspaceAdministratorToken });
  assert.equal(released.status, 0, released.stderr);
  const republished = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备处理量', '--contract', jsonFile(fixture, 'contract', CONTRACT)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(republished.status, 0, republished.stderr);
  const afterRelease = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.equal(afterRelease.cache.reused, false, 'a new Release is a new cache context');
  assert.equal(afterRelease.records[0]?.['handled_count'], 9);
});

test('exports are encrypted, audited, and downloaded through short-lived reauthorized access', () => {
  const { fixture, workspaceId, productId, workspaceAdministratorToken, consumerToken } = readyProduct();
  void publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'city', op: 'equals', value: '杭州' }],
  });

  const exported = command(
    fixture,
    ['export', 'create', '--product', productId, '--request', jsonFile(fixture, 'export-request', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(exported.status, 0, exported.stderr);
  const exportId = String(exported.output.export_id);
  assert.equal(exported.output.row_count, 3);
  assert.deepEqual(exported.output.columns, ['sn', 'city']);
  assert.match(String(exported.output.content_hash), /^[0-9a-f]{64}$/);
  const lifetime = Date.parse(String(exported.output.expires_at)) - Date.parse(String(exported.output.created_at));
  assert.ok(lifetime > 0 && lifetime <= 5 * 60 * 1000, 'export access is short-lived');

  const stored = readFileSync(join(fixture.root, String(exported.output.object_path)), 'utf8');
  assert.equal(stored.includes('杭州'), false, 'a curated export is never stored as plaintext');
  assert.equal(stored.includes('SN-001'), false, 'a curated export is never stored as plaintext');
  assert.equal(JSON.parse(stored).algorithm, 'AES-256-GCM');

  const downloaded = command(fixture, ['export', 'download', '--export', exportId], { token: consumerToken });
  assert.equal(downloaded.status, 0, downloaded.stderr);
  const csv = Buffer.from(String(downloaded.output.content), 'base64').toString('utf8');
  assert.equal(csv, 'sn,city\nSN-001,杭州\nSN-003,杭州\nSN-005,杭州\n');

  const audit = command(fixture, ['audit', 'list', '--workspace', workspaceId], {
    token: workspaceAdministratorToken,
  });
  assert.equal(audit.status, 0, audit.stderr);
  const actions = (audit.output['events'] as Array<Record<string, unknown>>).map((event) => event['action']);
  assert.ok(actions.includes('data_product_export'), 'producing an export is audited');
  assert.ok(actions.includes('data_product_export_download'), 'reading an export is audited');

  void publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['city'],
    row_filters: [{ field: 'city', op: 'equals', value: '杭州' }],
  });
  assert.equal(
    refusal(fixture, consumerToken, ['export', 'download', '--export', exportId]),
    'EXPORT_NO_LONGER_AUTHORIZED',
    'a narrowed Grant refuses a download it no longer permits',
  );
});

test('an export reads every page of the governed answer it was asked for', () => {
  const { fixture, productId, consumerToken, workspaceAdministratorToken } = readyProduct();
  void publishGrant(fixture, workspaceAdministratorToken, productId, { columns: ['sn'], row_filters: [] });

  // One page is all the governed read promises, so a paged answer must still be
  // exported whole rather than silently cut at the first page.
  const exported = command(
    fixture,
    ['export', 'create', '--product', productId, '--request', jsonFile(fixture, 'export-paged', { kind: 'records', limit: 2 })],
    { token: consumerToken },
  );
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(exported.output.row_count, 5, 'every matched row is exported, not only the first page');

  const downloaded = command(fixture, ['export', 'download', '--export', String(exported.output.export_id)], {
    token: consumerToken,
  });
  assert.equal(downloaded.status, 0, downloaded.stderr);
  const csv = Buffer.from(String(downloaded.output.content), 'base64').toString('utf8');
  assert.equal(csv, 'sn\nSN-001\nSN-002\nSN-003\nSN-004\nSN-005\n');
});

test('a Grant narrowed after an export refuses its download, and a widening permits it', () => {
  const { fixture, productId, consumerToken, workspaceAdministratorToken } = readyProduct();
  void publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'city', op: 'equals', value: '杭州' }],
  });

  const exported = command(
    fixture,
    ['export', 'create', '--product', productId, '--request', jsonFile(fixture, 'export-request', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(exported.status, 0, exported.stderr);
  const exportId = String(exported.output.export_id);

  // A second Grant narrows the same reader further: the export still carries
  // rows that Grant now withholds, so the download must be refused.
  void publishGrant(fixture, workspaceAdministratorToken, productId, {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'owner', op: 'equals', value: '张三' }],
  });
  assert.equal(
    refusal(fixture, consumerToken, ['export', 'download', '--export', exportId]),
    'EXPORT_NO_LONGER_AUTHORIZED',
    'a row filter added after the export refuses its download',
  );

  // Revoking both Grants restores the Workspace baseline, which is wider than
  // the scope the export was produced under, so the same download is permitted.
  const grants = command(fixture, ['grant', 'list', '--product', productId], { token: workspaceAdministratorToken });
  assert.equal(grants.status, 0, grants.stderr);
  for (const grant of grants.output['grants'] as Array<Record<string, unknown>>) {
    const revoked = command(fixture, ['grant', 'revoke', '--grant', String(grant['grant_id'])], {
      token: workspaceAdministratorToken,
    });
    assert.equal(revoked.status, 0, revoked.stderr);
  }
  const permitted = command(fixture, ['export', 'download', '--export', exportId], { token: consumerToken });
  assert.equal(permitted.status, 0, permitted.stderr);
  const csv = Buffer.from(String(permitted.output.content), 'base64').toString('utf8');
  assert.equal(csv, 'sn,city\nSN-001,杭州\nSN-003,杭州\nSN-005,杭州\n');
});

test('cross-Workspace substitution and raw or configuration export attempts reveal no existence', () => {
  const { fixture, productId, consumerToken, outsiderToken, workspaceAdministratorToken } = readyProduct();
  void publishGrant(fixture, workspaceAdministratorToken, productId, { columns: ['sn'], row_filters: [] });

  const exported = command(
    fixture,
    ['export', 'create', '--product', productId, '--request', jsonFile(fixture, 'export-request', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(exported.status, 0, exported.stderr);
  const exportId = String(exported.output.export_id);

  assert.equal(
    refusal(fixture, outsiderToken, ['product', 'query', '--product', productId], { kind: 'records' }),
    'DATA_PRODUCT_NOT_AVAILABLE',
  );
  const foreignExport = command(fixture, ['export', 'download', '--export', exportId], { token: outsiderToken });
  const absentExport = command(fixture, ['export', 'download', '--export', '00000000-0000-4000-8000-000000000000'], {
    token: outsiderToken,
  });
  assert.equal(foreignExport.status, 2);
  assert.equal(absentExport.status, 2);
  assert.deepEqual(foreignExport.error, absentExport.error, 'a foreign export answers exactly like an absent one');

  assert.equal(
    refusal(fixture, outsiderToken, ['export', 'create', '--product', productId], { kind: 'records' }),
    'DATA_PRODUCT_NOT_AVAILABLE',
  );
  assert.equal(
    refusal(fixture, consumerToken, ['export', 'create', '--product', productId], {
      kind: 'records',
      raw_acquisitions: true,
    }),
    'DATA_PRODUCT_QUERY_INVALID',
  );
  assert.equal(
    refusal(fixture, consumerToken, ['export', 'create', '--product', productId], {
      kind: 'records',
      select: 'configuration',
    }),
    'DATA_PRODUCT_QUERY_INVALID',
  );
});

test('a Grant only ever narrows what its own Workspace publishes', () => {
  const { fixture, productId, consumerToken, workspaceAdministratorToken } = readyProduct();

  assert.equal(
    refusal(fixture, consumerToken, ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid'], { columns: ['sn'] }),
    'DATA_PRODUCT_NOT_AVAILABLE',
    'a Consumer cannot publish a Grant',
  );
  assert.equal(
    refusal(fixture, workspaceAdministratorToken, ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid'], {
      columns: ['raw_content_hash'],
    }),
    'GRANT_COLUMNS_INVALID',
    'a Grant can only permit columns its Contract publishes',
  );
  assert.equal(
    refusal(fixture, workspaceAdministratorToken, ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid'], {
      columns: ['sn'],
      row_filters: [{ field: 'sn', op: 'equals', value: 'SN-001' }],
    }),
    'GRANT_ROW_FILTER_INVALID',
    'a row filter may only use a filter the Contract publishes',
  );
  assert.equal(
    refusal(fixture, workspaceAdministratorToken, ['grant', 'publish', '--product', productId, '--username', 'stranger@example.invalid'], {
      columns: ['sn'],
    }),
    'GRANT_GRANTEE_NOT_FOUND',
    'a Grant names a Workspace member',
  );
});
