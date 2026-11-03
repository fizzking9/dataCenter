import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  command,
  jsonFile,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

/**
 * The Reference Workload shape for governed metrics: one record per device,
 * a nullable city dimension, a nullable amount, and both a date and a timestamp
 * arrival field so window precision is exercised against real governed data.
 */
const LEDGER = [
  '设备SN,城市,处理量,结算金额,上报日期,上报时刻',
  'sn-001,杭州,3,120.50,2026-01-05,2026-01-05T09:30:00+08:00',
  'sn-002,上海,5,300.00,2026-01-12,2026-01-12T14:05:00+08:00',
  'sn-003,,2,,2026-01-20,2026-01-20T08:00:00+08:00',
  'sn-004,杭州,7,168.75,2026-02-02,2026-02-02T11:15:00+08:00',
].join('\n');

const INTEGRATION = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
    { name: 'settled_amount', type: 'number' },
    { name: 'reported_on', type: 'date' },
    { name: 'reported_at', type: 'timestamp' },
  ],
  cleaning: [{ rule: 'trim', field: 'sn' }],
  mapping: {
    设备SN: 'sn',
    城市: 'city',
    处理量: 'handled_count',
    结算金额: 'settled_amount',
    上报日期: 'reported_on',
    上报时刻: 'reported_at',
  },
};

const CONTRACT = {
  title: '设备维修台账',
  description: '按设备序列号组织的维修处理量',
  fields: [
    { name: 'sn', description: '设备序列号' },
    { name: 'city', description: '所属城市' },
    { name: 'handled_count', description: '处理量' },
    { name: 'settled_amount', description: '结算金额' },
    { name: 'reported_on', description: '上报日期' },
  ],
  dimensions: ['city'],
  metrics: [
    { name: 'device_count', description: '记录条数', aggregation: 'count', value_type: 'integer' },
    { name: 'handled_total', description: '处理量合计', aggregation: 'sum', field: 'handled_count', value_type: 'integer', unit: '次' },
    { name: 'settled_total', description: '结算金额合计', aggregation: 'sum', field: 'settled_amount', value_type: 'money', currency: 'CNY' },
    { name: 'settled_average', description: '平均结算金额', aggregation: 'avg', field: 'settled_amount', value_type: 'money', currency: 'CNY' },
    { name: 'handled_average', description: '平均处理量', aggregation: 'avg', field: 'handled_count', value_type: 'decimal' },
    { name: 'sn_span', description: '设备跨度', aggregation: 'count', value_type: 'integer', dimensions: [] },
  ],
  grain: ['sn'],
  time: { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' },
  filters: ['city', 'handled_count', 'reported_on'],
  limit: { default: 100, max: 500 },
};

/** The same governed Release read at instant precision instead of whole days. */
const TIMESTAMP_CONTRACT = {
  ...CONTRACT,
  title: '设备上报时刻台账',
  time: { field: 'reported_at', precision: 'timestamp', time_zone: 'Asia/Shanghai' },
};

interface AggregateGroup {
  group: Record<string, string | number | null>;
  null_dimensions: string[];
  metrics: Record<string, string | number | null>;
  comparison?: Record<string, ComparedMetric>;
}

interface ComparedMetric {
  value: string | number | null;
  change: string | number | null;
  change_percent: string | null;
  change_percent_reason?: string;
}

interface WindowView {
  field: string;
  precision: string;
  time_zone: string;
  start: string;
  end: string;
  coverage: { start: string; end: string } | null;
  partial: boolean;
}

interface AggregateResponse {
  kind: string;
  grouped_by: string[];
  metrics: Array<{ name: string; aggregation: string; value_type: string; unit: string | null; currency: string | null }>;
  groups: AggregateGroup[];
  totals: { metrics: Record<string, string | number | null>; comparison?: Record<string, ComparedMetric> } | null;
  groups_total: number;
  returned: number;
  truncated: boolean;
  limit: number;
  scanned_records: number;
  window: WindowView | null;
  comparison_window: WindowView | null;
  provenance: { dataset_release: number };
}

/** Publishes one governed Data Product over the ledger under an exact Contract. */
function publishLedger(
  fixture: PlatformFixture,
  token: string,
  workspaceId: string,
  contract: unknown = CONTRACT,
): { sourceId: string; productId: string } {
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'aggregate-integration', INTEGRATION)],
    { token },
  );
  assert.equal(integration.status, 0, integration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(integration.output.integration_configuration_version)],
    { token },
  );
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'ledger.csv', LEDGER)],
    { token },
  );
  assert.equal(upload.status, 0, upload.stderr);
  assert.equal(command(fixture, ['dataset', 'release', '--source', sourceId], { token }).status, 0);
  const product = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'aggregate-contract', contract)],
    { token },
  );
  assert.equal(product.status, 0, product.stderr);
  return { sourceId, productId: String(product.output.data_product_id) };
}

function query(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: unknown,
): AggregateResponse {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'aggregate-query', request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as AggregateResponse;
}

/** Runs a query that must be refused, and states the structured error it returns. */
function refusal(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: unknown,
  slug: string,
): Record<string, unknown> {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, `refused-${slug}`, request)],
    { token },
  );
  assert.equal(result.status, 2, `expected a structured refusal for ${slug}: ${result.stderr}`);
  assert.equal(result.stdout, '', 'a refused query never returns data');
  assert.equal(typeof result.error['message'], 'string');
  return result.error;
}

/** Publishes one further Data Product over the same Source and Dataset Release. */
function publishOver(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  name: string,
  slug: string,
  contract: unknown,
): string {
  const product = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', name, '--contract', jsonFile(fixture, `contract-${slug}`, contract)],
    { token },
  );
  assert.equal(product.status, 0, product.stderr);
  return String(product.output.data_product_id);
}

test('aggregate queries group published dimensions at one record grain without fanout or double counting', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { productId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);

  const listed = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumerToken });
  assert.equal(listed.status, 0, listed.stderr);
  const published = (listed.output['data_products'] as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(published['dimensions'], ['city']);
  assert.deepEqual(
    (published['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']),
    ['device_count', 'handled_total', 'settled_total', 'settled_average', 'handled_average', 'sn_span'],
  );
  assert.deepEqual(published['grain'], ['sn']);
  assert.deepEqual(published['time'], { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' });

  const grouped = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count', 'handled_total', 'settled_total', 'handled_average'],
    include_totals: true,
  });
  assert.equal(grouped.kind, 'aggregate');
  assert.deepEqual(grouped.grouped_by, ['city']);
  assert.deepEqual(grouped.groups.map((entry) => entry.group), [
    { city: '上海' },
    { city: '杭州' },
    { city: null },
  ]);
  assert.deepEqual(grouped.groups.map((entry) => entry.null_dimensions), [[], [], ['city']]);
  assert.deepEqual(grouped.groups.map((entry) => entry.metrics), [
    { device_count: 1, handled_total: 5, settled_total: '300.00', handled_average: '5.00' },
    { device_count: 2, handled_total: 10, settled_total: '289.25', handled_average: '5.00' },
    { device_count: 1, handled_total: 2, settled_total: '0.00', handled_average: '2.00' },
  ]);
  assert.deepEqual(grouped.totals, {
    metrics: { device_count: 4, handled_total: 17, settled_total: '589.25', handled_average: '4.25' },
  });
  assert.equal(grouped.groups_total, 3);
  assert.equal(grouped.returned, 3);
  assert.equal(grouped.truncated, false);
  assert.equal(grouped.scanned_records, 4);

  const countedInGroups = grouped.groups.reduce((total, entry) => total + Number(entry.metrics['device_count']), 0);
  assert.equal(countedInGroups, 4, 'every record lands in exactly one group, so nothing fans out');
  assert.equal(
    grouped.groups.reduce((total, entry) => total + Number(entry.metrics['handled_total']), 0),
    17,
    'grouped sums add up to the grand total, so nothing is double counted',
  );
  assert.deepEqual(grouped.metrics.map((metric) => [metric['name'], metric['unit'], metric['currency']]), [
    ['device_count', null, null],
    ['handled_total', '次', null],
    ['settled_total', null, 'CNY'],
    ['handled_average', null, null],
  ]);

  const byUndeclaredDimension = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'aggregate-undeclared', {
      kind: 'aggregate',
      group_by: ['handled_count'],
      metrics: ['device_count'],
    })],
    { token: consumerToken },
  );
  assert.equal(byUndeclaredDimension.status, 2);
  assert.equal(byUndeclaredDimension.error.code, 'DATA_PRODUCT_QUERY_REFUSED');

  const byForbiddenDimension = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'aggregate-forbidden', {
      kind: 'aggregate',
      group_by: ['city'],
      metrics: ['sn_span'],
    })],
    { token: consumerToken },
  );
  assert.equal(byForbiddenDimension.status, 2);
  assert.equal(byForbiddenDimension.error.code, 'DATA_PRODUCT_QUERY_REFUSED');

  const records = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'aggregate-records', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(records.status, 0, records.stderr);
  assert.deepEqual(
    (records.output['records'] as Array<Record<string, unknown>>)[0],
    { sn: 'sn-001', city: '杭州', handled_count: 3, settled_amount: 120.5, reported_on: '2026-01-05' },
    'a record query projects published fields only',
  );
});

test('dimension and metric filters, null groups, totals, ordering, and aggregate paging follow the settled ordering', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { productId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);

  const byDimension = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count', 'handled_total'],
    filters: [{ field: 'city', op: 'equals', value: '杭州' }],
    include_totals: true,
  });
  assert.deepEqual(byDimension.groups, [
    { group: { city: '杭州' }, null_dimensions: [], metrics: { device_count: 2, handled_total: 10 } },
  ]);
  assert.deepEqual(byDimension.totals, { metrics: { device_count: 2, handled_total: 10 } });

  const nullGroup = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count', 'handled_total'],
    filters: [{ field: 'city', op: 'is_null' }],
  });
  assert.deepEqual(nullGroup.groups, [
    { group: { city: null }, null_dimensions: ['city'], metrics: { device_count: 1, handled_total: 2 } },
  ]);

  const byMetric = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    metric_filters: [{ metric: 'handled_total', op: 'greater_or_equal', value: 5 }],
  });
  assert.deepEqual(byMetric.groups.map((entry) => entry.group), [{ city: '上海' }, { city: '杭州' }]);
  assert.equal(
    byMetric.groups_total,
    2,
    'a metric filter applies after aggregation, so it drops groups rather than records',
  );

  const descending = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    sort: [{ by: 'handled_total', direction: 'desc' }],
  });
  assert.deepEqual(
    descending.groups.map((entry) => [entry.group['city'], entry.metrics['handled_total']]),
    [['杭州', 10], ['上海', 5], [null, 2]],
  );

  const ascending = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    sort: [{ by: 'handled_total', direction: 'asc' }],
  });
  assert.deepEqual(
    ascending.groups.map((entry) => [entry.group['city'], entry.metrics['handled_total']]),
    [[null, 2], ['上海', 5], ['杭州', 10]],
  );

  const tied = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count'],
    sort: [{ by: 'device_count', direction: 'desc' }],
  });
  assert.deepEqual(
    tied.groups.map((entry) => entry.group['city']),
    ['杭州', '上海', null],
    'a tie breaks on the whole dimension tuple, so paging never depends on evaluation order',
  );

  const paged = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    sort: [{ by: 'handled_total', direction: 'desc' }],
    limit: 1,
    include_totals: true,
  });
  assert.equal(paged.returned, 1);
  assert.equal(paged.groups_total, 3);
  assert.equal(paged.truncated, true);
  assert.equal(paged.limit, 1);
  assert.deepEqual(paged.groups.map((entry) => entry.group), [{ city: '杭州' }]);
  assert.deepEqual(
    paged.totals?.metrics,
    { handled_total: 17 },
    'a grand total covers the whole aggregate, never just the returned page',
  );

  const windowedRecords = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'aggregate-typed-filter', {
      kind: 'records',
      filters: [{ field: 'handled_count', op: 'greater_than', value: 4 }],
    })],
    { token: consumerToken },
  );
  assert.equal(windowedRecords.status, 0, windowedRecords.stderr);
  assert.deepEqual(
    (windowedRecords.output['records'] as Array<Record<string, unknown>>).map((record) => record['sn']),
    ['sn-002', 'sn-004'],
    'record queries take the same typed operators, so a numeric field compares numerically',
  );
});

test('inclusive windows, partial periods, zero-base comparisons, and scalars match the Contract', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { sourceId, productId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);
  const timedProductId = publishOver(
    fixture,
    workspaceAdministratorToken,
    sourceId,
    '设备上报时刻台账',
    'timestamp',
    TIMESTAMP_CONTRACT,
  );

  const boundaries = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count', 'handled_total'],
    include_totals: true,
    window: { start: '2026-01-05', end: '2026-01-20' },
  });
  assert.deepEqual(
    boundaries.totals?.metrics,
    { device_count: 3, handled_total: 10 },
    'both boundaries are inclusive at the Contract precision',
  );
  assert.deepEqual(boundaries.window, {
    field: 'reported_on',
    precision: 'date',
    time_zone: 'Asia/Shanghai',
    start: '2026-01-05',
    end: '2026-01-20',
    coverage: { start: '2026-01-05', end: '2026-02-02' },
    partial: false,
  });

  const partial = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count'],
    window: { start: '2026-01-01', end: '2026-01-31' },
  });
  assert.equal(partial.window?.partial, true, 'a window the Release does not cover is labelled partial');
  assert.deepEqual(partial.groups.map((entry) => entry.group), [{ city: '上海' }, { city: '杭州' }, { city: null }]);
  assert.equal(partial.groups_total, 3);

  const exactInstant = query(fixture, consumerToken, timedProductId, {
    kind: 'aggregate',
    metrics: ['device_count'],
    window: { start: '2026-01-12T14:05:00+08:00', end: '2026-01-12T14:05:00+08:00' },
  });
  assert.deepEqual(
    exactInstant.groups[0]?.metrics,
    { device_count: 1 },
    'a timestamp window includes the exact end instant',
  );
  assert.equal(exactInstant.window?.precision, 'timestamp');

  const naiveInstant = command(
    fixture,
    ['product', 'query', '--product', timedProductId, '--request', jsonFile(fixture, 'aggregate-naive-instant', {
      kind: 'aggregate',
      metrics: ['device_count'],
      window: { start: '2026-01-12T14:05:00', end: '2026-01-20T00:00:00' },
    })],
    { token: consumerToken },
  );
  assert.equal(naiveInstant.status, 2);
  assert.equal(naiveInstant.error.code, 'DATA_PRODUCT_QUERY_INVALID', 'an instant must state its own offset');

  const compared = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    include_totals: true,
    window: { start: '2026-02-01', end: '2026-02-28' },
    comparison: { start: '2026-01-01', end: '2026-01-31' },
  });
  assert.deepEqual(compared.groups, [
    {
      group: { city: '上海' },
      null_dimensions: [],
      metrics: { handled_total: 0 },
      comparison: { handled_total: { value: 5, change: -5, change_percent: '-100.00' } },
    },
    {
      group: { city: '杭州' },
      null_dimensions: [],
      metrics: { handled_total: 7 },
      comparison: { handled_total: { value: 3, change: 4, change_percent: '133.33' } },
    },
    {
      group: { city: null },
      null_dimensions: ['city'],
      metrics: { handled_total: 0 },
      comparison: { handled_total: { value: 2, change: -2, change_percent: '-100.00' } },
    },
  ]);
  assert.deepEqual(compared.totals, {
    metrics: { handled_total: 7 },
    comparison: { handled_total: { value: 10, change: -3, change_percent: '-30.00' } },
  });
  assert.equal(compared.comparison_window?.start, '2026-01-01');

  const zeroBase = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    window: { start: '2026-01-01', end: '2026-01-31' },
    comparison: { start: '2026-03-01', end: '2026-03-31' },
  });
  assert.deepEqual(zeroBase.groups[0]?.comparison, {
    handled_total: { value: 0, change: 5, change_percent: null, change_percent_reason: 'zero_base' },
  });
  assert.equal(JSON.stringify(zeroBase).includes('Infinity'), false);
  assert.equal(JSON.stringify(zeroBase).includes('NaN'), false);

  const scalars = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    metrics: ['device_count', 'settled_total', 'settled_average', 'handled_average'],
    include_totals: true,
  });
  assert.deepEqual(scalars.groups[0]?.metrics, {
    device_count: 4,
    settled_total: '589.25',
    settled_average: '196.42',
    handled_average: '4.25',
  }, 'counts stay integers, amounts are strings, and a missing amount is skipped rather than read as zero');
  assert.equal(typeof scalars.groups[0]?.metrics['device_count'], 'number');
  assert.equal(typeof scalars.groups[0]?.metrics['settled_total'], 'string');

  const recordsInWindow = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'aggregate-window-records', {
      kind: 'records',
      window: { start: '2026-01-01', end: '2026-01-31' },
    })],
    { token: consumerToken },
  );
  assert.equal(recordsInWindow.status, 0, recordsInWindow.stderr);
  assert.deepEqual(
    (recordsInWindow.output['records'] as Array<Record<string, unknown>>).map((record) => record['sn']),
    ['sn-001', 'sn-002', 'sn-003'],
    'record queries read the same windows at the Contract precision',
  );
});

test('arbitrary SQL, Consumer formulas or joins, ambiguous semantics, and invalid values are refused', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { sourceId, productId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);
  const untimedProductId = publishOver(
    fixture,
    workspaceAdministratorToken,
    sourceId,
    '设备台账无时间',
    'untimed',
    { ...CONTRACT, title: '设备台账无时间', time: undefined },
  );

  const refusals: Array<[string, string, Record<string, unknown>, string]> = [
    ['sql', productId, { kind: 'aggregate', metrics: ['device_count'], sql: 'select sn from records' }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['expression', productId, { kind: 'aggregate', metrics: ['device_count'], expression: 'handled_count * 2' }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['join', productId, { kind: 'aggregate', metrics: ['device_count'], join: { to: '退款明细' } }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['formula', productId, { kind: 'records', formula: 'settled_amount / handled_count' }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['mixed', productId, { kind: 'aggregate', metrics: ['device_count'], fields: ['sn'] }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['malformed-metrics', productId, { kind: 'aggregate', metrics: 'device_count' }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['unknown-kind', productId, { kind: 'documents' }, 'DATA_PRODUCT_QUERY_INVALID'],
    ['unknown-metric', productId, { kind: 'aggregate', metrics: ['refund_total'] }, 'DATA_PRODUCT_QUERY_REFUSED'],
    ['mistyped-filter', productId, {
      kind: 'aggregate',
      metrics: ['device_count'],
      filters: [{ field: 'handled_count', op: 'equals', value: 'five' }],
    }, 'DATA_PRODUCT_QUERY_REFUSED'],
    ['unknown-sort', productId, {
      kind: 'aggregate',
      group_by: ['city'],
      metrics: ['device_count'],
      sort: [{ by: 'handled_total', direction: 'desc' }],
    }, 'DATA_PRODUCT_QUERY_REFUSED'],
    ['unpaired-comparison', productId, {
      kind: 'aggregate',
      metrics: ['device_count'],
      comparison: { start: '2026-01-01', end: '2026-01-31' },
    }, 'DATA_PRODUCT_QUERY_REFUSED'],
    ['inverted-window', productId, {
      kind: 'aggregate',
      metrics: ['device_count'],
      window: { start: '2026-01-31', end: '2026-01-01' },
    }, 'DATA_PRODUCT_QUERY_REFUSED'],
    ['no-time-field', untimedProductId, {
      kind: 'aggregate',
      metrics: ['device_count'],
      window: { start: '2026-01-01', end: '2026-01-31' },
    }, 'DATA_PRODUCT_QUERY_REFUSED'],
    ['unrequested-metric-filter', productId, {
      kind: 'aggregate',
      metrics: ['device_count'],
      metric_filters: [{ metric: 'handled_total', op: 'greater_than', value: 1 }],
    }, 'DATA_PRODUCT_QUERY_REFUSED'],
  ];

  for (const [slug, target, request, code] of refusals) {
    const error = refusal(fixture, consumerToken, target, request, slug);
    assert.equal(error['code'], code, `${slug} must be refused as ${code}`);
  }

  const stillGoverned = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    metrics: ['device_count'],
  });
  assert.deepEqual(
    stillGoverned.groups[0]?.metrics,
    { device_count: 4 },
    'every refusal leaves the governed Release exactly as it was',
  );
});

test('declared complexity, execution-time, and result-size limits never return truncated output as complete', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { sourceId, productId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);
  const scannedProductId = publishOver(
    fixture,
    workspaceAdministratorToken,
    sourceId,
    '设备台账扫描受限',
    'scan-limited',
    { ...CONTRACT, title: '设备台账扫描受限', limits: { max_scanned_records: 2, max_groups: 10_000, max_execution_ms: 5_000 } },
  );
  const groupedProductId = publishOver(
    fixture,
    workspaceAdministratorToken,
    sourceId,
    '设备台账分组受限',
    'groups-limited',
    { ...CONTRACT, title: '设备台账分组受限', limits: { max_scanned_records: 100_000, max_groups: 2, max_execution_ms: 5_000 } },
  );
  const budgetlessProductId = publishOver(
    fixture,
    workspaceAdministratorToken,
    sourceId,
    '设备台账无执行预算',
    'budgetless',
    { ...CONTRACT, title: '设备台账无执行预算', limits: { max_scanned_records: 100_000, max_groups: 10_000, max_execution_ms: 0 } },
  );

  const tooComplex = refusal(
    fixture,
    consumerToken,
    scannedProductId,
    { kind: 'aggregate', metrics: ['device_count'] },
    'too-complex',
  );
  assert.equal(tooComplex['code'], 'DATA_PRODUCT_QUERY_TOO_COMPLEX');
  assert.equal(typeof tooComplex['next_step'], 'string', 'a bounded query states how to become acceptable');

  const tooLarge = refusal(
    fixture,
    consumerToken,
    groupedProductId,
    { kind: 'aggregate', group_by: ['city'], metrics: ['device_count'] },
    'result-too-large',
  );
  assert.equal(tooLarge['code'], 'DATA_PRODUCT_QUERY_RESULT_TOO_LARGE');

  const tooLargeEvenPaged = refusal(
    fixture,
    consumerToken,
    groupedProductId,
    { kind: 'aggregate', group_by: ['city'], metrics: ['device_count'], limit: 1 },
    'result-too-large-paged',
  );
  assert.equal(
    tooLargeEvenPaged['code'],
    'DATA_PRODUCT_QUERY_RESULT_TOO_LARGE',
    'a page size never hides a result the Contract cannot deliver',
  );

  const timedOut = refusal(
    fixture,
    consumerToken,
    budgetlessProductId,
    { kind: 'aggregate', metrics: ['device_count'] },
    'too-slow',
  );
  assert.equal(timedOut['code'], 'DATA_PRODUCT_QUERY_TIMEOUT');

  const timedOutRecords = refusal(
    fixture,
    consumerToken,
    budgetlessProductId,
    { kind: 'records' },
    'too-slow-records',
  );
  assert.equal(
    timedOutRecords['code'],
    'DATA_PRODUCT_QUERY_TIMEOUT',
    'the execution budget binds every kind of query, not only aggregates',
  );

  const withinBudget = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['device_count'],
  });
  assert.equal(withinBudget.groups_total, 3);
  assert.equal(withinBudget.returned, 3);
  assert.equal(withinBudget.truncated, false, 'a result that fits the Contract is reported as complete');
});

test('a compared window reads the same filtered records as the window it compares against', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { productId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);

  const compared = query(fixture, consumerToken, productId, {
    kind: 'aggregate',
    group_by: ['city'],
    metrics: ['handled_total'],
    filters: [{ field: 'city', op: 'equals', value: '杭州' }],
    window: { start: '2026-02-01', end: '2026-02-28' },
    comparison: { start: '2026-01-01', end: '2026-01-31' },
    include_totals: true,
  });
  assert.deepEqual(
    compared.groups,
    [{
      group: { city: '杭州' },
      null_dimensions: [],
      metrics: { handled_total: 7 },
      comparison: { handled_total: { value: 3, change: 4, change_percent: '133.33' } },
    }],
    'a filter that excludes a group excludes it from both windows',
  );
  assert.deepEqual(
    compared.totals,
    {
      metrics: { handled_total: 7 },
      comparison: { handled_total: { value: 3, change: 4, change_percent: '133.33' } },
    },
    'the compared grand total measures the same filtered population as the queried one',
  );
});

test('a Contract whose declared grain does not identify one record is refused before it can double count', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken }: WorkspaceFixture = workspaceFixture();
  const { sourceId } = publishLedger(fixture, workspaceAdministratorToken, workspaceId);

  const collided = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备台账按城市', '--contract', jsonFile(fixture, 'grain-contract', {
      ...CONTRACT,
      title: '设备台账按城市',
      grain: ['city'],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(collided.status, 2);
  assert.equal(collided.error['code'], 'DATA_PRODUCT_GRAIN_NOT_UNIQUE');

  const listed = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumerToken });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    (listed.output['data_products'] as Array<Record<string, unknown>>).map((entry) => entry['name']),
    ['设备维修台账'],
    'a refused Publication leaves the governed Data Product list unchanged',
  );
});