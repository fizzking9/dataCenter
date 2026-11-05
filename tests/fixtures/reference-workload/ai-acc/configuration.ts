/**
 * The Workspace-owned configuration that realizes the ai-acc reference workload.
 *
 * Nothing here is application behavior: these are the declarative values a
 * Workspace Administrator publishes — endpoint auth, pacing, schedule, window
 * bounds, integration mapping, Business Context, and the Data Product Contract.
 * Certification feeds them through the same generic commands a customer uses,
 * which is the whole point: the engine learns nothing about 受理 data.
 */
import { AI_ACC_BUSINESS_CONTEXT, dictionaryMapping, dictionarySchema } from './data-dictionary.js';
import { AI_ACC_WINDOWS } from './windows.js';

/** How the source system authenticates: a login that yields a bearer token and a cookie. */
export const AI_ACC_AUTH = {
  scheme: 'login',
  login_path: '/auth/login',
  username: 'acc-export-reader',
  token_path: 'access_token',
  cookie_name: 'session',
};

/** The stored credential the Workspace Administrator supplies out of band. */
export const AI_ACC_CREDENTIAL = 'export-reader-password';

/** The export paginates by page number; one window fits in a handful of pages. */
export const AI_ACC_PAGINATION = {
  parameter: 'page',
  size_parameter: 'page_size',
  start: 1,
  size: 10,
  max_pages: 3,
};

/** ai-acc pacing is independent of any other system: no serialization, a modest rate. */
export const AI_ACC_PACING = {
  serialization: true,
  minimum_interval_seconds: 0,
  maximum_requests_per_minute: 60,
  maximum_concurrent_runs: 1,
};

/** The settled cadence: every fifteen minutes, a Run may start up to 60 s late. */
export const AI_ACC_SCHEDULE = { every_minutes: 15, start_tolerance_seconds: 60 };

/** The settled publication targets for an ai-acc Run. */
export const AI_ACC_PUBLICATION_TARGETS = { p95_seconds: 300, p99_seconds: 600 };

/** Where the export answers, and where its records sit in the response. */
export const AI_ACC_PATH = '/api/acc/handling-export';
export const AI_ACC_RECORD_PATH = 'data.records';

/**
 * The planner window: half-open, no lookback, and a hard seven-day ceiling so a
 * catch-up after downtime is walked in consecutive bounded windows.
 */
export const AI_ACC_WINDOW = {
  mode: 'incremental',
  start_parameter: 'from',
  end_parameter: 'to',
  initial_start: AI_ACC_WINDOWS[0]!.window.start,
  maximum_span_minutes: 7 * 24 * 60,
  lookback_minutes: 0,
  time_zone: 'Asia/Shanghai',
  end_inclusive: false,
};

/** The Integration Configuration: stable identity, dictionary schema, and mapping. */
export const AI_ACC_INTEGRATION = {
  identity: ['record_id'],
  schema: dictionarySchema(),
  cleaning: [
    { rule: 'trim', field: 'record_id' },
    { rule: 'trim', field: 'device_sn' },
    { rule: 'trim', field: 'time_band' },
    { rule: 'trim', field: 'takeover_state' },
  ],
  mapping: dictionaryMapping(),
};

/** The Business Context snapshot the Workspace publishes beside the configuration. */
export const AI_ACC_CONTEXT = AI_ACC_BUSINESS_CONTEXT;

/**
 * The Data Product Contract: 处理量 and 条数 grouped by 时段 and 接管状态, at the
 * 工单 grain, over the source's own business dates in Asia/Shanghai.
 */
export const AI_ACC_CONTRACT = {
  title: 'ai-acc 受理处理量与接管分析',
  description: '按受理时段与接管状态分组的处理量与工单条数',
  fields: dictionarySchema().map((field) => ({ name: field.name })),
  dimensions: ['time_band', 'takeover_state'],
  metrics: [
    { name: 'record_count', description: '工单条数', aggregation: 'count', value_type: 'integer', unit: '条' },
    {
      name: 'handled_total',
      description: '处理量合计',
      aggregation: 'sum',
      field: 'handled_count',
      value_type: 'integer',
      unit: '次',
    },
  ],
  grain: ['record_id'],
  time: { field: 'handled_on', precision: 'date', time_zone: 'Asia/Shanghai' },
  filters: ['time_band', 'takeover_state', 'handled_on'],
  limit: { default: 100, max: 500 },
};
