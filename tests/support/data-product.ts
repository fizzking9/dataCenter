import assert from 'node:assert/strict';
import {
  command,
  jsonFile,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from './platform.js';

/** Three governed device records, one per device, with a nullable dimension. */
export const LEDGER = [
  '设备SN,城市,处理量,结算金额,上报日期',
  'sn-001,杭州,3,120.50,2026-01-05',
  'sn-002,上海,5,300.00,2026-01-12',
  'sn-003,,2,,2026-01-20',
].join('\n');

const INTEGRATION = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
    { name: 'settled_amount', type: 'number' },
    { name: 'reported_on', type: 'date' },
  ],
  cleaning: [{ rule: 'trim', field: 'sn' }],
  mapping: {
    设备SN: 'sn',
    城市: 'city',
    处理量: 'handled_count',
    结算金额: 'settled_amount',
    上报日期: 'reported_on',
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
  ],
  grain: ['sn'],
  time: { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' },
  filters: ['city', 'handled_count', 'reported_on'],
  limit: { default: 100, max: 500 },
};

/**
 * The same ledger Contract widened additively for Natural-Language Query
 * certification: the device identifier becomes filterable, and an average over
 * a nullable amount can produce a genuinely absent metric value.
 */
export const EXTENDED_LEDGER_CONTRACT = {
  ...CONTRACT,
  metrics: [
    ...CONTRACT.metrics,
    {
      name: 'settled_average',
      description: '平均结算金额',
      aggregation: 'avg',
      field: 'settled_amount',
      value_type: 'money',
      currency: 'CNY',
    },
  ],
  filters: ['sn', ...CONTRACT.filters],
};

/**
 * A second governed ledger in the same Workspace, deliberately covering a later
 * period than the device ledger, so a compound answer has to disclose two
 * different as-of times and two different Releases.
 */
export const REFUND_LEDGER = [
  '退款单号,城市,退款金额,退款日期',
  'rf-001,杭州,88.00,2026-02-03',
  'rf-002,上海,120.00,2026-02-10',
].join('\n');

const REFUND_INTEGRATION = {
  identity: ['refund_id'],
  schema: [
    { name: 'refund_id', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'refund_amount', type: 'number' },
    { name: 'refunded_on', type: 'date' },
  ],
  cleaning: [{ rule: 'trim', field: 'refund_id' }],
  mapping: {
    退款单号: 'refund_id',
    城市: 'city',
    退款金额: 'refund_amount',
    退款日期: 'refunded_on',
  },
};

export const REFUND_CONTRACT = {
  title: '退款台账',
  description: '按退款单号组织的退款金额',
  fields: [
    { name: 'refund_id', description: '退款单号' },
    { name: 'city', description: '所属城市' },
    { name: 'refund_amount', description: '退款金额' },
    { name: 'refunded_on', description: '退款日期' },
  ],
  dimensions: ['city'],
  metrics: [
    { name: 'refund_count', description: '退款笔数', aggregation: 'count', value_type: 'integer' },
    {
      name: 'refund_total',
      description: '退款金额合计',
      aggregation: 'sum',
      field: 'refund_amount',
      value_type: 'money',
      currency: 'CNY',
    },
  ],
  grain: ['refund_id'],
  time: { field: 'refunded_on', precision: 'date', time_zone: 'Asia/Shanghai' },
  filters: ['city', 'refunded_on'],
  limit: { default: 100, max: 500 },
};

export interface PublishedProduct extends WorkspaceFixture {
  sourceId: string;
  dataProductId: string;
}

/**
 * Publishes one Data Product over a governed Dataset Release, so a Consumer and
 * an Agent Identity can read exactly the same Artifact through two surfaces.
 */
export function publishLedgerProduct(contract: unknown = CONTRACT): PublishedProduct {
  const base: WorkspaceFixture = workspaceFixture();
  const { fixture, workspaceId, workspaceAdministratorToken } = base;
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId);
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'contract', contract)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  return { ...base, sourceId, dataProductId: String(published.output.data_product_id) };
}

export function publishSource(
  fixture: PlatformFixture,
  token: string,
  workspaceId: string,
  options: { name?: string; integration?: unknown } = {},
): string {
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', options.name ?? '设备台账', '--type', 'file'],
    { token },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const published = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', options.integration ?? INTEGRATION)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  const adopted = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(published.output.integration_configuration_version)],
    { token },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  return sourceId;
}

export function acquireAndRelease(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  ledger: string = LEDGER,
  fileName = 'ledger.csv',
): void {
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, fileName, ledger)],
    { token },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(released.status, 0, released.stderr);
}

/**
 * Publishes a second Data Product into an existing Workspace, so one compound
 * question can compose two independently governed products.
 */
export function publishRefundProduct(base: WorkspaceFixture): PublishedProduct {
  const { fixture, workspaceId, workspaceAdministratorToken } = base;
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId, {
    name: '退款台账',
    integration: REFUND_INTEGRATION,
  });
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, REFUND_LEDGER, 'refunds.csv');
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '退款台账', '--contract', jsonFile(fixture, 'refund-contract', REFUND_CONTRACT)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  return { ...base, sourceId, dataProductId: String(published.output.data_product_id) };
}
