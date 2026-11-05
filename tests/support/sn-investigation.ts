/**
 * The SN-centred device investigation of the Reference Workload, frozen as a
 * versioned certification asset.
 *
 * Everything business-specific lives here — the seven record sets an operator
 * would configure as Sources, the data-dictionary mapping of their columns, the
 * frozen exports, the Contract that links them, and the golden expected linked
 * records and governed metrics. The application, the connector engine, and the
 * semantic execution layer never learn this case: they learn only that a
 * Contract may declare relationships with a cardinality between Datasets of one
 * Workspace.
 */
import assert from 'node:assert/strict';
import type { SourceReply } from './http-source.js';
import { pageBody } from './http-source.js';
import { command, jsonFile } from './platform.js';
import {
  BMS_WINDOW,
  configureReferenceWorkload,
  type ExportRow,
  type ReferenceFieldType,
  type ReferenceSource,
  type ReferenceWorkload,
} from './reference-workload.js';

type Column = [source: string, field: string, type: ReferenceFieldType];

function columns(entries: Column[]): ReferenceSource['columns'] {
  return entries.map(([source, field, type]) => ({ source, field, type }));
}

/** The device archive: one record per serial number, and the investigation's base. */
const devices: ExportRow[] = [
  { device_sn: 'SN-0001', updated_at: '2026-11-01T00:00:00.000Z', site_name: '杭州一店', service_years: 3.5 },
  { device_sn: 'SN-0002', updated_at: '2026-11-01T00:10:00.000Z', site_name: '上海二店', service_years: 1.25 },
  { device_sn: 'SN-0003', updated_at: '2026-11-01T00:20:00.000Z', site_name: '南京三店', service_years: 0.75 },
  { device_sn: 'SN-0004', updated_at: '2026-11-01T00:30:00.000Z', site_name: '苏州四店', service_years: 2.25 },
];

/** One service plan per device, exactly: the relationship's declared cardinality is one. */
const plans: ExportRow[] = [
  { plan_no: 'PL-2026-1001', device_sn: 'SN-0001', plan_name: '保修计划', plan_status: '生效中', covered_months: 36 },
  { plan_no: 'PL-2026-1002', device_sn: 'SN-0002', plan_name: '延保计划', plan_status: '已到期', covered_months: 12 },
  { plan_no: 'PL-2026-1003', device_sn: 'SN-0003', plan_name: '标准计划', plan_status: '生效中', covered_months: 24 },
];

const orders: ExportRow[] = [
  { order_no: 'SO-2026-0001', device_sn: 'SN-0001', service_status: '已受理', handled_count: 2 },
  { order_no: 'SO-2026-0002', device_sn: 'SN-0001', service_status: '已完工', handled_count: 4 },
  { order_no: 'SO-2026-0003', device_sn: 'SN-0002', service_status: '维修中', handled_count: 1 },
  { order_no: 'SO-2026-0004', device_sn: 'SN-0003', service_status: '已完工', handled_count: 3 },
  { order_no: 'SO-2026-0005', device_sn: 'SN-0002', service_status: '已受理', handled_count: 2 },
];

const refunds: ExportRow[] = [
  { refund_no: 'RF-2026-0101', device_sn: 'SN-0001', refund_status: '已退款', refund_amount: 120.5 },
  { refund_no: 'RF-2026-0102', device_sn: 'SN-0002', refund_status: '待审批', refund_amount: 80 },
  { refund_no: 'RF-2026-0103', device_sn: 'SN-0002', refund_status: '已退款', refund_amount: 260 },
];

const returns: ExportRow[] = [
  { return_no: 'RT-2026-0201', device_sn: 'SN-0001', return_status: '已退货', return_reason: '质量问题' },
  { return_no: 'RT-2026-0202', device_sn: 'SN-0003', return_status: '待退货', return_reason: '型号不符' },
];

const tags: ExportRow[] = [
  { tag_code: 'TG-0001', device_sn: 'SN-0001', tag_name: '重点客户' },
  { tag_code: 'TG-0002', device_sn: 'SN-0001', tag_name: '保修内' },
  { tag_code: 'TG-0003', device_sn: 'SN-0002', tag_name: '重点客户' },
  { tag_code: 'TG-0004', device_sn: 'SN-0003', tag_name: '停用' },
];

const serviceRequests: ExportRow[] = [
  { request_no: 'SR-2026-0301', device_sn: 'SN-0001', request_type: '报修', request_status: '已关闭' },
  { request_no: 'SR-2026-0302', device_sn: 'SN-0001', request_type: '咨询', request_status: '处理中' },
  { request_no: 'SR-2026-0303', device_sn: 'SN-0002', request_type: '报修', request_status: '已关闭' },
  { request_no: 'SR-2026-0304', device_sn: 'SN-0003', request_type: '咨询', request_status: '已关闭' },
];

/** The seven independently configured Sources one investigation links. */
export const SN_SOURCES: ReferenceSource[] = [
  {
    name: '设备档案',
    path: '/exports/devices',
    identity: 'device_sn',
    columns: columns([
      ['device_sn', 'device_sn', 'string'],
      ['updated_at', 'updated_at', 'timestamp'],
      ['site_name', 'site_name', 'string'],
      ['service_years', 'service_years', 'number'],
    ]),
    exports: [devices],
  },
  {
    name: '服务计划',
    path: '/exports/service-plans',
    identity: 'plan_no',
    columns: columns([
      ['plan_no', 'plan_no', 'string'],
      ['device_sn', 'device_sn', 'string'],
      ['plan_name', 'plan_name', 'string'],
      ['plan_status', 'plan_status', 'string'],
      ['covered_months', 'covered_months', 'integer'],
    ]),
    exports: [plans],
  },
  {
    name: '服务工单',
    path: '/exports/service-orders',
    identity: 'order_no',
    columns: columns([
      ['order_no', 'order_no', 'string'],
      ['device_sn', 'device_sn', 'string'],
      ['service_status', 'service_status', 'string'],
      ['handled_count', 'handled_count', 'integer'],
    ]),
    exports: [orders],
  },
  {
    name: '退款单',
    path: '/exports/refunds',
    identity: 'refund_no',
    columns: columns([
      ['refund_no', 'refund_no', 'string'],
      ['device_sn', 'device_sn', 'string'],
      ['refund_status', 'refund_status', 'string'],
      ['refund_amount', 'refund_amount', 'number'],
    ]),
    exports: [refunds],
  },
  {
    name: '退货单',
    path: '/exports/returns',
    identity: 'return_no',
    columns: columns([
      ['return_no', 'return_no', 'string'],
      ['device_sn', 'device_sn', 'string'],
      ['return_status', 'return_status', 'string'],
      ['return_reason', 'return_reason', 'string'],
    ]),
    exports: [returns],
  },
  {
    name: '设备标签',
    path: '/exports/device-tags',
    identity: 'tag_code',
    columns: columns([
      ['tag_code', 'tag_code', 'string'],
      ['device_sn', 'device_sn', 'string'],
      ['tag_name', 'tag_name', 'string'],
    ]),
    exports: [tags],
  },
  {
    name: '服务请求',
    path: '/exports/service-requests',
    identity: 'request_no',
    columns: columns([
      ['request_no', 'request_no', 'string'],
      ['device_sn', 'device_sn', 'string'],
      ['request_type', 'request_type', 'string'],
      ['request_status', 'request_status', 'string'],
    ]),
    exports: [serviceRequests],
  },
];

/** The name the Workspace Administrator publishes the investigation under. */
export const SN_PRODUCT_NAME = '设备全貌';

/** The relationship names the Contract declares, in the order a reader sees them. */
export const SN_RELATIONSHIPS = [
  'service_plan',
  'service_orders',
  'refunds',
  'returns',
  'device_tags',
  'service_requests',
] as const;

/**
 * The Contract an operator publishes: the device record's own grain and metrics,
 * and one declared relationship per linked record set, each with its own grain,
 * cardinality, and valid query capabilities.
 */
export const SN_CONTRACT = {
  title: SN_PRODUCT_NAME,
  description: '以设备序列号为中心，关联服务计划、服务工单、退款、退货、标签与服务请求。',
  fields: [
    { name: 'device_sn', description: '设备序列号' },
    { name: 'site_name', description: '所属门店' },
    { name: 'service_years', description: '使用年限' },
    { name: 'updated_at', description: '最近更新时间' },
  ],
  dimensions: ['site_name'],
  metrics: [
    { name: 'device_count', description: '设备记录条数', aggregation: 'count', value_type: 'integer' },
    {
      name: 'longest_service_years',
      description: '最长使用年限',
      aggregation: 'max',
      field: 'service_years',
      value_type: 'decimal',
      unit: '年',
    },
  ],
  grain: ['device_sn'],
  time: { field: 'updated_at', precision: 'timestamp', time_zone: 'Asia/Shanghai' },
  filters: ['device_sn', 'site_name'],
  relationships: [
    {
      name: 'service_plan',
      description: '服务计划',
      cardinality: 'one',
      on: { device_sn: 'device_sn' },
      fields: [
        { name: 'plan_no', description: '计划编号' },
        { name: 'plan_name', description: '计划名称' },
        { name: 'plan_status', description: '计划状态' },
        { name: 'covered_months', description: '保障月数' },
      ],
      grain: ['plan_no'],
      filters: ['plan_status'],
      limit: 1,
    },
    {
      name: 'service_orders',
      description: '服务工单',
      cardinality: 'many',
      on: { device_sn: 'device_sn' },
      fields: [
        { name: 'order_no', description: '工单编号' },
        { name: 'service_status', description: '工单状态' },
        { name: 'handled_count', description: '处理次数' },
      ],
      grain: ['order_no'],
      filters: ['service_status'],
      limit: 50,
    },
    {
      name: 'refunds',
      description: '退款单',
      cardinality: 'many',
      on: { device_sn: 'device_sn' },
      fields: [
        { name: 'refund_no', description: '退款单号' },
        { name: 'refund_status', description: '退款状态' },
        { name: 'refund_amount', description: '退款金额' },
      ],
      grain: ['refund_no'],
      filters: ['refund_status'],
      limit: 50,
    },
    {
      name: 'returns',
      description: '退货单',
      cardinality: 'many',
      on: { device_sn: 'device_sn' },
      fields: [
        { name: 'return_no', description: '退货单号' },
        { name: 'return_status', description: '退货状态' },
        { name: 'return_reason', description: '退货原因' },
      ],
      grain: ['return_no'],
      filters: ['return_status'],
      limit: 50,
    },
    {
      name: 'device_tags',
      description: '设备标签',
      cardinality: 'many',
      on: { device_sn: 'device_sn' },
      fields: [
        { name: 'tag_code', description: '标签代码' },
        { name: 'tag_name', description: '标签名称' },
      ],
      grain: ['tag_code'],
      filters: [],
      limit: 50,
    },
    {
      name: 'service_requests',
      description: '服务请求',
      cardinality: 'many',
      on: { device_sn: 'device_sn' },
      fields: [
        { name: 'request_no', description: '请求编号' },
        { name: 'request_type', description: '请求类型' },
        { name: 'request_status', description: '请求状态' },
      ],
      grain: ['request_no'],
      filters: ['request_status'],
      limit: 50,
    },
  ],
  limit: { default: 50, max: 200 },
};

export interface GoldenLinks {
  service_plan: string | null;
  service_orders: string[];
  refunds: string[];
  returns: string[];
  device_tags: string[];
  service_requests: string[];
}

export interface SnGoldenCase {
  device_sn: string;
  site_name: string;
  service_years: number;
  links: GoldenLinks;
  /** The governed metrics a query filtered to this device returns, frozen by hand. */
  metrics: { device_count: number; longest_service_years: string };
}

/**
 * The golden cases, written down from the frozen exports rather than recomputed,
 * so a linkage or an aggregate that quietly changed would disagree here instead
 * of agreeing with itself.
 */
export const SN_GOLDEN: SnGoldenCase[] = [
  {
    device_sn: 'SN-0001',
    site_name: '杭州一店',
    service_years: 3.5,
    links: {
      service_plan: 'PL-2026-1001',
      service_orders: ['SO-2026-0001', 'SO-2026-0002'],
      refunds: ['RF-2026-0101'],
      returns: ['RT-2026-0201'],
      device_tags: ['TG-0001', 'TG-0002'],
      service_requests: ['SR-2026-0301', 'SR-2026-0302'],
    },
    metrics: { device_count: 1, longest_service_years: '3.50' },
  },
  {
    device_sn: 'SN-0002',
    site_name: '上海二店',
    service_years: 1.25,
    links: {
      service_plan: 'PL-2026-1002',
      service_orders: ['SO-2026-0003', 'SO-2026-0005'],
      refunds: ['RF-2026-0102', 'RF-2026-0103'],
      returns: [],
      device_tags: ['TG-0003'],
      service_requests: ['SR-2026-0303'],
    },
    metrics: { device_count: 1, longest_service_years: '1.25' },
  },
  {
    device_sn: 'SN-0003',
    site_name: '南京三店',
    service_years: 0.75,
    links: {
      service_plan: 'PL-2026-1003',
      service_orders: ['SO-2026-0004'],
      refunds: [],
      returns: ['RT-2026-0202'],
      device_tags: ['TG-0004'],
      service_requests: ['SR-2026-0304'],
    },
    metrics: { device_count: 1, longest_service_years: '0.75' },
  },
  {
    device_sn: 'SN-0004',
    site_name: '苏州四店',
    service_years: 2.25,
    links: {
      service_plan: null,
      service_orders: [],
      refunds: [],
      returns: [],
      device_tags: [],
      service_requests: [],
    },
    metrics: { device_count: 1, longest_service_years: '2.25' },
  },
];

/** One reply per Source, in the order the sweep reads them. */
export function snReplies(entries: ReferenceSource[] = SN_SOURCES): SourceReply[] {
  return entries.map((source) => ({ body: pageBody(source.exports[0] ?? []) }));
}

export interface SnWorkload extends ReferenceWorkload {
  /** The configured Source of each declared relationship, by Contract name. */
  related: Record<string, string>;
}

/** Configures the seven record sets of the investigation as ordinary Sources. */
export function configureSnWorkload(
  source: { url: string },
  entries: ReferenceSource[] = SN_SOURCES,
): SnWorkload {
  const workload = configureReferenceWorkload(source, entries, { window: BMS_WINDOW });
  const names = new Map(entries.map((entry, index) => [entry.name, workload.sources[index]!.sourceId]));
  const related: Record<string, string> = {
    service_plan: names.get('服务计划')!,
    service_orders: names.get('服务工单')!,
    refunds: names.get('退款单')!,
    returns: names.get('退货单')!,
    device_tags: names.get('设备标签')!,
    service_requests: names.get('服务请求')!,
  };
  return { ...workload, related };
}

/** Acquires and releases one frozen export of every configured Source. */
export function acquireSnSnapshot(workload: SnWorkload): void {
  for (const source of workload.sources) {
    const enqueued = command(workload.fixture, ['acquisition', 'enqueue', '--source', source.sourceId], { token: workload.token });
    assert.equal(enqueued.status, 0, enqueued.stderr);
    const state = command(workload.fixture, ['connection', 'pacing', '--connection', workload.connectionId], { token: workload.token });
    assert.equal(state.status, 0, state.stderr);
    const last = state.output['last_finished_at'];
    const at = typeof last === 'string'
      ? new Date(Date.parse(last) + 65_000).toISOString()
      : new Date(Date.now() + 60_000).toISOString();
    const worked = command(workload.fixture, ['acquisition', 'work', '--source', source.sourceId, '--at', at], { token: workload.token });
    assert.equal(worked.status, 0, worked.stderr);
    assert.equal(worked.output['status'], 'complete', `${source.name}: ${worked.stderr}`);
  }
}

export interface SnPublication {
  data_product_id: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
}

/**
 * Publishes the investigation Contract the way any Workspace Administrator
 * publishes a multi-Dataset Data Product: one base Source and one binding per
 * declared relationship, all in the same Workspace.
 */
export function publishSnProduct(
  workload: SnWorkload,
  options: { contract?: unknown; related?: Record<string, string>; name?: string; slug?: string } = {},
): SnPublication {
  const { fixture, token, workspaceId } = workload;
  const base = workload.sources[0]!;
  const slug = options.slug ?? 'sn-investigation';
  const result = command(
    fixture,
    [
      'product', 'publish',
      '--source', base.sourceId,
      '--name', options.name ?? SN_PRODUCT_NAME,
      '--contract', jsonFile(fixture, `${slug}-contract`, options.contract ?? SN_CONTRACT),
      '--related', jsonFile(fixture, `${slug}-related`, options.related ?? workload.related),
    ],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output['workspace_id'], workspaceId);
  return result.output as unknown as SnPublication;
}
