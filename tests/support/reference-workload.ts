/**
 * The Reference Workload: frozen, representative assets for the real business
 * sources the first release is certified against.
 *
 * Everything business-specific lives here — source names, export endpoints, the
 * data-dictionary mapping from source columns to canonical Dataset fields, the
 * frozen export fragments, the physical pacing, and the expected governed
 * results. A certification test configures the Deployment from this module the
 * way an operator configures any Workspace, so the engine, the application, and
 * the console never learn a business case.
 */
import assert from 'node:assert/strict';
import {
  BMS_DICTIONARIES,
  type BusinessDataset,
} from '../fixtures/reference-workload/bms/data-dictionary.js';
import {
  COMPLAINT_EXPORTS,
  REFUND_EXPORTS,
  SERVICE_ORDER_EXPORTS,
  type BusinessRow,
} from '../fixtures/reference-workload/bms/exports.js';
import type { SourceReply } from './http-source.js';
import { pageBody } from './http-source.js';
import {
  command,
  jsonFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from './platform.js';

/** The Dataset field types an Integration Configuration can declare. */
export type ReferenceFieldType = 'string' | 'integer' | 'number' | 'date' | 'timestamp';

/** One data-dictionary mapping from a source column to a canonical Dataset field. */
export interface ReferenceColumn {
  /** The column the export endpoint sends. */
  source: string;
  /** The canonical Dataset field it maps to. */
  field: string;
  type: ReferenceFieldType;
}

/** One row of a frozen export fragment, keyed by source column. */
export type ExportRow = Record<string, string | number>;

export interface ReferenceSource {
  name: string;
  /** The export endpoint on the shared Connection. */
  path: string;
  columns: ReferenceColumn[];
  /** The canonical Dataset field carrying the source's business identifier. */
  identity: string;
  /** The frozen exports, in the order the hourly sweeps read them. */
  exports: ExportRow[][];
}

export interface ReferenceConnection {
  name: string;
  auth: Record<string, unknown>;
  pagination: Record<string, unknown>;
  retry: Record<string, unknown>;
  pacing: Record<string, unknown>;
  schedule: Record<string, unknown>;
  publication_targets: Record<string, unknown>;
}

/**
 * The three exports of one Source: the first sweep's fragment, the sweep that
 * overlaps it with one updated and one added record, and a repeat of that same
 * export, so repetition is certified against a frozen duplicate.
 */
function hourlyExports(first: ExportRow[], overlap: ExportRow[]): ExportRow[][] {
  return [first, overlap, overlap];
}

function columns(entries: Array<[string, string, ReferenceFieldType]>): ReferenceColumn[] {
  return entries.map(([source, field, type]) => ({ source, field, type }));
}

/** The canonical mapping the frozen data dictionary declares for one business dataset. */
function dictionaryColumns(dataset: BusinessDataset): ReferenceColumn[] {
  return BMS_DICTIONARIES[dataset].map((entry) => ({
    source: entry.column,
    field: entry.field,
    type: entry.type,
  }));
}

/**
 * The business export system: one physical endpoint per logical dataset, shared
 * pacing, and an hourly sweep. None of this is known to the platform.
 */
export const BMS_CONNECTION: ReferenceConnection = {
  name: '业务导出接口',
  auth: { scheme: 'api_key', header: 'x-api-key', prefix: null },
  pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 100, max_pages: 5 },
  retry: { max_attempts: 2, base_delay_ms: 50, max_delay_ms: 200, retry_on: [429, 502, 503, 504] },
  pacing: {
    serialization: true,
    minimum_interval_seconds: 65,
    maximum_requests_per_minute: null,
    maximum_concurrent_runs: 1,
  },
  schedule: { every_minutes: 60, start_tolerance_seconds: 60 },
  publication_targets: { p95_seconds: 1_800, p99_seconds: 2_700 },
};

/**
 * The planner window every Source of the export system reads: one hourly sweep
 * over the last two hours, deliberately overlapping the previous sweep by an
 * hour so late edits are re-read and reconciled.
 */
export const BMS_WINDOW = {
  mode: 'incremental',
  start_parameter: 'from',
  end_parameter: 'to',
  initial_start: '2026-11-01T00:00:00.000Z',
  maximum_span_minutes: 120,
  lookback_minutes: 60,
  time_zone: 'Asia/Shanghai',
  end_inclusive: false,
};

const serviceOrders = SERVICE_ORDER_EXPORTS as ExportRow[][];

const refunds = REFUND_EXPORTS as ExportRow[][];

const sparePartIssues = hourlyExports(
  [
    { issue_no: 'PI-2026-2201', updated_at: '2026-10-31T23:20:00.000Z', part_code: 'P-COMP-01', issued_quantity: 2 },
    { issue_no: 'PI-2026-2202', updated_at: '2026-11-01T00:25:00.000Z', part_code: 'P-FAN-07', issued_quantity: 1 },
  ],
  [
    { issue_no: 'PI-2026-2201', updated_at: '2026-10-31T23:20:00.000Z', part_code: 'P-COMP-01', issued_quantity: 2 },
    { issue_no: 'PI-2026-2202', updated_at: '2026-11-01T01:10:00.000Z', part_code: 'P-FAN-07', issued_quantity: 3 },
    { issue_no: 'PI-2026-2203', updated_at: '2026-11-01T01:40:00.000Z', part_code: 'P-PUMP-02', issued_quantity: 1 },
  ],
);

const devices = hourlyExports(
  [
    { device_sn: 'SN-0001', updated_at: '2026-10-31T23:00:00.000Z', site_name: '杭州一店', service_years: 3.5 },
    { device_sn: 'SN-0002', updated_at: '2026-11-01T00:10:00.000Z', site_name: '上海二店', service_years: 1.25 },
  ],
  [
    { device_sn: 'SN-0001', updated_at: '2026-10-31T23:00:00.000Z', site_name: '杭州一店', service_years: 3.5 },
    { device_sn: 'SN-0002', updated_at: '2026-11-01T00:10:00.000Z', site_name: '上海二店', service_years: 1.5 },
    { device_sn: 'SN-0003', updated_at: '2026-11-01T01:00:00.000Z', site_name: '南京三店', service_years: 0.75 },
  ],
);

const visits = hourlyExports(
  [
    { visit_no: 'VS-2026-3301', updated_at: '2026-10-31T23:30:00.000Z', visit_result: '现场修复', duration_minutes: 45 },
    { visit_no: 'VS-2026-3302', updated_at: '2026-11-01T00:35:00.000Z', visit_result: '待备件', duration_minutes: 20 },
  ],
  [
    { visit_no: 'VS-2026-3301', updated_at: '2026-10-31T23:30:00.000Z', visit_result: '现场修复', duration_minutes: 45 },
    { visit_no: 'VS-2026-3302', updated_at: '2026-11-01T01:20:00.000Z', visit_result: '现场修复', duration_minutes: 35 },
    { visit_no: 'VS-2026-3303', updated_at: '2026-11-01T01:50:00.000Z', visit_result: '待备件', duration_minutes: 15 },
  ],
);

const complaints = COMPLAINT_EXPORTS as ExportRow[][];

const branchStock = hourlyExports(
  [
    { stock_key: 'ST-HZ-01-P-COMP-01', updated_at: '2026-10-31T23:45:00.000Z', part_code: 'P-COMP-01', available_quantity: 12 },
    { stock_key: 'ST-SH-02-P-FAN-07', updated_at: '2026-11-01T00:45:00.000Z', part_code: 'P-FAN-07', available_quantity: 4 },
  ],
  [
    { stock_key: 'ST-HZ-01-P-COMP-01', updated_at: '2026-11-01T01:05:00.000Z', part_code: 'P-COMP-01', available_quantity: 10 },
    { stock_key: 'ST-SH-02-P-FAN-07', updated_at: '2026-11-01T00:45:00.000Z', part_code: 'P-FAN-07', available_quantity: 4 },
    { stock_key: 'ST-NJ-03-P-PUMP-02', updated_at: '2026-11-01T01:35:00.000Z', part_code: 'P-PUMP-02', available_quantity: 6 },
  ],
);

const settlements = hourlyExports(
  [
    { settlement_no: 'SE-2026-5501', updated_at: '2026-10-31T23:50:00.000Z', settlement_status: '待结算', settled_amount: 1500 },
    { settlement_no: 'SE-2026-5502', updated_at: '2026-11-01T00:50:00.000Z', settlement_status: '已结算', settled_amount: 980.75 },
  ],
  [
    { settlement_no: 'SE-2026-5501', updated_at: '2026-11-01T01:15:00.000Z', settlement_status: '已结算', settled_amount: 1500 },
    { settlement_no: 'SE-2026-5502', updated_at: '2026-11-01T00:50:00.000Z', settlement_status: '已结算', settled_amount: 980.75 },
    { settlement_no: 'SE-2026-5503', updated_at: '2026-11-01T01:45:00.000Z', settlement_status: '待结算', settled_amount: 430 },
  ],
);

const warrantyContracts = hourlyExports(
  [
    { contract_no: 'WC-2026-6601', updated_at: '2026-10-31T23:35:00.000Z', contract_status: '生效中', covered_months: 36 },
    { contract_no: 'WC-2026-6602', updated_at: '2026-11-01T00:30:00.000Z', contract_status: '已到期', covered_months: 12 },
  ],
  [
    { contract_no: 'WC-2026-6601', updated_at: '2026-10-31T23:35:00.000Z', contract_status: '生效中', covered_months: 36 },
    { contract_no: 'WC-2026-6602', updated_at: '2026-11-01T00:30:00.000Z', contract_status: '已到期', covered_months: 12 },
    { contract_no: 'WC-2026-6603', updated_at: '2026-11-01T01:55:00.000Z', contract_status: '生效中', covered_months: 48 },
  ],
);

/**
 * The nine independently configured Sources of the business export system. Each
 * reads its own export endpoint over the one shared Connection, so the physical
 * system is serialized while every dataset stays independent.
 */
export const BMS_SOURCES: ReferenceSource[] = [
  {
    name: '服务工单',
    path: '/exports/service-orders',
    identity: 'order_no',
    columns: dictionaryColumns('service_orders'),
    exports: serviceOrders,
  },
  {
    name: '退款单',
    path: '/exports/refunds',
    identity: 'refund_no',
    columns: dictionaryColumns('refunds'),
    exports: refunds,
  },
  {
    name: '备件出库',
    path: '/exports/spare-part-issues',
    identity: 'issue_no',
    columns: columns([
      ['issue_no', 'issue_no', 'string'],
      ['updated_at', 'updated_at', 'timestamp'],
      ['part_code', 'part_code', 'string'],
      ['issued_quantity', 'issued_quantity', 'integer'],
    ]),
    exports: sparePartIssues,
  },
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
    exports: devices,
  },
  {
    name: '上门记录',
    path: '/exports/visits',
    identity: 'visit_no',
    columns: columns([
      ['visit_no', 'visit_no', 'string'],
      ['updated_at', 'updated_at', 'timestamp'],
      ['visit_result', 'visit_result', 'string'],
      ['duration_minutes', 'duration_minutes', 'integer'],
    ]),
    exports: visits,
  },
  {
    name: '投诉工单',
    path: '/exports/complaints',
    identity: 'report_no',
    columns: dictionaryColumns('complaints'),
    exports: complaints,
  },
  {
    name: '网点库存',
    path: '/exports/branch-stock',
    identity: 'stock_key',
    columns: columns([
      ['stock_key', 'stock_key', 'string'],
      ['updated_at', 'updated_at', 'timestamp'],
      ['part_code', 'part_code', 'string'],
      ['available_quantity', 'available_quantity', 'integer'],
    ]),
    exports: branchStock,
  },
  {
    name: '结算单',
    path: '/exports/settlements',
    identity: 'settlement_no',
    columns: columns([
      ['settlement_no', 'settlement_no', 'string'],
      ['updated_at', 'updated_at', 'timestamp'],
      ['settlement_status', 'settlement_status', 'string'],
      ['settled_amount', 'settled_amount', 'number'],
    ]),
    exports: settlements,
  },
  {
    name: '保修合同',
    path: '/exports/warranty-contracts',
    identity: 'contract_no',
    columns: columns([
      ['contract_no', 'contract_no', 'string'],
      ['updated_at', 'updated_at', 'timestamp'],
      ['contract_status', 'contract_status', 'string'],
      ['covered_months', 'covered_months', 'integer'],
    ]),
    exports: warrantyContracts,
  },
];

/**
 * The frozen expected results of three hourly sweeps of the nine Sources. The
 * counts are written down rather than recomputed, so a fixture that quietly
 * changed would fail the oracle instead of agreeing with itself.
 *
 * Three of the Sources carry the two representative complete weeks the business
 * Data Products are certified over, so their exports are larger than the six
 * operational Sources beside them; `record_counts` states each Source's own
 * count in BMS_SOURCES order.
 */
export const BMS_EXPECTED = {
  sources: 9,
  interval_seconds: 65,
  start_tolerance_seconds: 60,
  publication_p95_seconds: 1_800,
  publication_p99_seconds: 2_700,
  sweeps: [
    {
      window: { from: '2026-10-31T23:00:00.000Z', to: '2026-11-01T01:00:00.000Z' },
      raw_acquisitions: 9,
      record_counts: [31, 57, 2, 2, 2, 45, 2, 2, 2],
      records: 145,
    },
    {
      window: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-01T02:00:00.000Z' },
      raw_acquisitions: 9,
      record_counts: [33, 61, 3, 3, 3, 48, 3, 3, 3],
      records: 160,
    },
    {
      window: { from: '2026-11-01T01:00:00.000Z', to: '2026-11-01T03:00:00.000Z' },
      raw_acquisitions: 9,
      record_counts: [33, 61, 3, 3, 3, 48, 3, 3, 3],
      records: 160,
      new_releases: 0,
    },
  ],
} as const;

/** The canonical business identifier of one frozen row. */
export function identityOf(source: ReferenceSource, row: ExportRow): string {
  const column = source.columns.find((candidate) => candidate.field === source.identity);
  assert.ok(column !== undefined, `${source.name} maps its business identifier to a canonical field`);
  return String(row[column.source]);
}

/** How many records one Source's export carried on one sweep. */
export function recordsOnSweep(sweep: number, sourceIndex: number): number {
  const counts = BMS_EXPECTED.sweeps[sweep]?.record_counts;
  assert.ok(counts !== undefined && sourceIndex < counts.length, 'the sweep froze this Source\'s count');
  return counts[sourceIndex]!;
}

/** The identities a Release must govern after one sweep, taken from the frozen export. */
export function expectedIdentities(source: ReferenceSource, sweep: number): string[] {
  const rows = source.exports[sweep];
  assert.ok(rows !== undefined, `${source.name} froze export ${sweep}`);
  return rows.map((row) => `${source.identity}=${identityOf(source, row)}`).sort();
}

/** The Integration Configuration the data dictionary implies for one Source. */
export function integrationConfiguration(source: ReferenceSource): Record<string, unknown> {
  return {
    identity: [source.identity],
    schema: source.columns.map((column) => ({ name: column.field, type: column.type })),
    cleaning: [{ rule: 'trim', field: source.identity }],
    mapping: Object.fromEntries(source.columns.map((column) => [column.source, column.field])),
  };
}

/** The frozen export fragments, one reply per request the sweeps make. */
export function bmsReplies(repeat_sweeps = 3): SourceReply[] {
  const replies: SourceReply[] = [];
  for (let sweep = 0; sweep < repeat_sweeps; sweep += 1) {
    for (const source of BMS_SOURCES) {
      replies.push({ body: pageBody(source.exports[sweep] ?? []) });
    }
  }
  return replies;
}

export interface ConfiguredSource {
  name: string;
  path: string;
  sourceId: string;
  /** The instant the Source was registered, which starts its first schedule interval. */
  createdAt: string;
  identity: string;
  columns: ReferenceColumn[];
  exports: ExportRow[][];
  acquisitionVersion: number;
  integrationVersion: number;
}

export interface ReferenceWorkload {
  fixture: PlatformFixture;
  workspace: WorkspaceFixture;
  workspaceId: string;
  token: string;
  connectionId: string;
  connectionVersion: number;
  sources: ConfiguredSource[];
}

interface ConnectionOptions {
  /** A Connection this Workload shares with an already configured Source. */
  connection?: { connectionId: string; connectionVersion: number };
  /** Overrides the Connection Version's schedule, for scheduler certification. */
  schedule?: Record<string, unknown>;
}

interface WorkloadOptions extends ConnectionOptions {
  window?: Record<string, unknown>;
  /**
   * Workspace Business Context published before any Integration Configuration
   * is pinned, so the Releases the Source produces carry the exact approved
   * Metric Definitions the business questions read.
   */
  context?: unknown[];
}

function publishConnection(
  fixture: PlatformFixture,
  workspaceId: string,
  token: string,
  baseUrl: string,
  definition: ReferenceConnection,
  options: ConnectionOptions,
): { connectionId: string; connectionVersion: number } {
  if (options.connection !== undefined) return options.connection;
  const published = command(
    fixture,
    [
      'connection', 'publish', '--workspace', workspaceId, '--name', definition.name,
      '--config', jsonFile(fixture, `connection-${definition.name}`, {
        base_url: baseUrl,
        auth: definition.auth,
        pagination: definition.pagination,
        retry: definition.retry,
        pacing: definition.pacing,
        schedule: options.schedule ?? definition.schedule,
        publication_targets: definition.publication_targets,
      }),
      ...(definition.auth['scheme'] === 'none' ? [] : ['--credential-stdin']),
    ],
    { token, ...(definition.auth['scheme'] === 'none' ? {} : { input: 'reference-workload-credential\n' }) },
  );
  assert.equal(published.status, 0, published.stderr);
  const reference = {
    connectionId: String(published.output.connection_id),
    connectionVersion: Number(published.output.connection_version),
  };
  const adopted = command(
    fixture,
    ['connection', 'adopt', '--connection', reference.connectionId, '--version', String(reference.connectionVersion)],
    { token },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  return reference;
}

function configureSource(
  fixture: PlatformFixture,
  workspaceId: string,
  token: string,
  source: ReferenceSource,
  connection: { connectionId: string; connectionVersion: number },
  window: Record<string, unknown>,
): ConfiguredSource {
  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', source.name, '--type', 'http_json'],
    { token },
  );
  assert.equal(created.status, 0, created.stderr);
  const sourceId = String(created.output.source_id);

  const acquisition = command(
    fixture,
    ['acquisition-config', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `acquisition-${source.name}`, {
      connection: connection.connectionId,
      connection_version: connection.connectionVersion,
      path: source.path,
      record_path: 'data.records',
      completion: { kind: 'short_page' },
      window,
      content_type: 'application/json',
    })],
    { token },
  );
  assert.equal(acquisition.status, 0, acquisition.stderr);
  const acquisitionVersion = Number(acquisition.output.acquisition_configuration_version);
  const adoptedAcquisition = command(
    fixture,
    ['acquisition-config', 'adopt', '--source', sourceId, '--version', String(acquisitionVersion)],
    { token },
  );
  assert.equal(adoptedAcquisition.status, 0, adoptedAcquisition.stderr);

  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `integration-${source.name}`, integrationConfiguration(source))],
    { token },
  );
  assert.equal(integration.status, 0, integration.stderr);
  const integrationVersion = Number(integration.output.integration_configuration_version);
  const adoptedIntegration = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(integrationVersion)],
    { token },
  );
  assert.equal(adoptedIntegration.status, 0, adoptedIntegration.stderr);

  return {
    name: source.name,
    path: source.path,
    sourceId,
    createdAt: String(created.output.created_at),
    identity: source.identity,
    columns: source.columns,
    exports: source.exports,
    acquisitionVersion,
    integrationVersion,
  };
}

/**
 * Configures the nine business Sources the way an operator would: one shared
 * Connection for the physical export system, and one independently adopted
 * acquisition and Integration Configuration per Source.
 */
export function configureBmsWorkload(
  source: { url: string },
  options: WorkloadOptions = {},
): ReferenceWorkload {
  const workspace = workspaceFixture();
  const { fixture, workspaceId, workspaceAdministratorToken: token } = workspace;
  if (options.context !== undefined) {
    const published = command(
      fixture,
      ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', jsonFile(fixture, 'workspace-context', options.context)],
      { token },
    );
    assert.equal(published.status, 0, published.stderr);
  }
  const connection = publishConnection(fixture, workspaceId, token, source.url, BMS_CONNECTION, options);
  const sources = BMS_SOURCES.map((entry) => configureSource(
    fixture,
    workspaceId,
    token,
    entry,
    connection,
    options.window ?? BMS_WINDOW,
  ));
  return {
    fixture,
    workspace,
    workspaceId,
    token,
    connectionId: connection.connectionId,
    connectionVersion: connection.connectionVersion,
    sources,
  };
}

/** One Source of a configured Workload, found by the name its Workspace publishes. */
export function bmsSource(workload: ReferenceWorkload, name: string): ConfiguredSource {
  const source = workload.sources.find((candidate) => candidate.name === name);
  assert.ok(source !== undefined, `${name} is one of the configured Sources`);
  return source;
}

/**
 * Works one Source at the earliest instant its Connection admits it: never
 * before the previous export on that Connection has been closed for the whole
 * minimum interval. Nothing sleeps; the worker clock is stated, and every call
 * is a fresh process, so durable pacing is what admits it.
 */
export function workWhenConnectionIsFree(
  workload: ReferenceWorkload,
  source: ConfiguredSource,
  notEarlier: number,
): Record<string, unknown> {
  const state = command(workload.fixture, ['connection', 'pacing', '--connection', workload.connectionId], { token: workload.token });
  assert.equal(state.status, 0, state.stderr);
  const lastFinished = state.output['last_finished_at'];
  const free = typeof lastFinished === 'string'
    ? Date.parse(lastFinished) + BMS_EXPECTED.interval_seconds * 1_000
    : notEarlier;
  const result = command(
    workload.fixture,
    ['acquisition', 'work', '--source', source.sourceId, '--at', new Date(Math.max(notEarlier, free)).toISOString()],
    { token: workload.token },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = result.output as Record<string, unknown>;
  assert.equal(output['status'], 'complete', `${source.name}: ${JSON.stringify(output)}`);
  return output;
}

/**
 * One manual sweep over every Source of the physical export system, drained
 * through the Connection's own durable pacing. The clock starts at the stated
 * instant, so the sweeps of one Certification never depend on wall time.
 */
export function sweepBmsWorkload(
  workload: ReferenceWorkload,
  fromAt = Date.now(),
): Array<Record<string, unknown>> {
  let notEarlier = fromAt;
  return workload.sources.map((source) => {
    const enqueued = command(workload.fixture, ['acquisition', 'enqueue', '--source', source.sourceId], { token: workload.token });
    assert.equal(enqueued.status, 0, enqueued.stderr);
    const result = workWhenConnectionIsFree(workload, source, notEarlier);
    const plan = result['plan'] as Record<string, unknown> | null;
    notEarlier = Date.parse(String(plan?.['completed_at'])) + BMS_EXPECTED.interval_seconds * 1_000;
    return result;
  });
}
