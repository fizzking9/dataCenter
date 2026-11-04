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

export interface PublishedProduct extends WorkspaceFixture {
  sourceId: string;
  dataProductId: string;
}

/**
 * Publishes one Data Product over a governed Dataset Release, so a Consumer and
 * an Agent Identity can read exactly the same Artifact through two surfaces.
 */
export function publishLedgerProduct(): PublishedProduct {
  const base: WorkspaceFixture = workspaceFixture();
  const { fixture, workspaceId, workspaceAdministratorToken } = base;
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId);
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'contract', CONTRACT)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  return { ...base, sourceId, dataProductId: String(published.output.data_product_id) };
}

export function publishSource(fixture: PlatformFixture, token: string, workspaceId: string): string {
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const published = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', INTEGRATION)],
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

export function acquireAndRelease(fixture: PlatformFixture, token: string, sourceId: string): void {
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'ledger.csv', LEDGER)],
    { token },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(released.status, 0, released.stderr);
}
