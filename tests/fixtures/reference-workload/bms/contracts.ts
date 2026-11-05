/**
 * The three Data Product Contracts the business questions are certified
 * through: 经营总览, 四路退款, and 三源投诉.
 *
 * Each Contract selects from the dictionary-derived Dataset Schema rather than
 * restating it, and binds every metric to the approved Metric Definition of the
 * same name, so the definition governs the formula, unit, value type, and
 * favourable direction the engine evaluates. The business time zone is bound to
 * the approved definition too, rather than chosen by the Contract.
 */
import { BMS_TIME_ZONE } from './business-context.js';
import { dictionarySchema } from './data-dictionary.js';

function fieldsOf(dataset: Parameters<typeof dictionarySchema>[0]): Array<{ name: string }> {
  return dictionarySchema(dataset).map((field) => ({ name: field.name }));
}

/** 经营总览: reception volume and handled volume over the service orders export. */
export const BMS_OPERATING_CONTRACT = {
  title: 'BMS 经营总览',
  description: '按服务状态与受理日期分组的接待量、处理量、趋势与期间对比',
  fields: fieldsOf('service_orders'),
  dimensions: ['service_status', 'registered_on'],
  metrics: [
    {
      name: 'reception_count',
      description: '接待量（笔）',
      aggregation: 'count',
      value_type: 'integer',
      unit: '笔',
      definition: 'reception_count',
      dimensions: ['service_status', 'registered_on'],
    },
    {
      name: 'handled_total',
      description: '处理量合计（次）',
      aggregation: 'sum',
      field: 'handled_count',
      value_type: 'integer',
      unit: '次',
      definition: 'handled_total',
      dimensions: ['service_status', 'registered_on'],
    },
  ],
  grain: ['order_no'],
  time: { field: 'registered_at', precision: 'timestamp', time_zone: BMS_TIME_ZONE, definition: 'business_time_zone' },
  filters: ['service_status', 'registered_on', 'registered_at'],
  limit: { default: 100, max: 500 },
};

/** 四路退款: the four refund routes with counts and amounts over the refunds export. */
export const BMS_REFUND_CONTRACT = {
  title: 'BMS 四路退款',
  description: '按退款路径分组的退款笔数与退款金额，支持日期趋势与期间对比',
  fields: fieldsOf('refunds'),
  dimensions: ['refund_route', 'refund_status', 'refunded_on'],
  metrics: [
    {
      name: 'refund_count',
      description: '退款笔数（笔）',
      aggregation: 'count',
      value_type: 'integer',
      unit: '笔',
      definition: 'refund_count',
      dimensions: ['refund_route', 'refund_status', 'refunded_on'],
    },
    {
      name: 'refund_amount_total',
      description: '退款金额合计（元）',
      aggregation: 'sum',
      field: 'refund_amount',
      value_type: 'money',
      currency: 'CNY',
      unit: '元',
      definition: 'refund_amount_total',
      dimensions: ['refund_route', 'refund_status', 'refunded_on'],
    },
  ],
  grain: ['refund_no'],
  time: { field: 'refunded_at', precision: 'timestamp', time_zone: BMS_TIME_ZONE, definition: 'business_time_zone' },
  filters: ['refund_route', 'refund_status', 'refunded_on', 'refunded_at'],
  limit: { default: 100, max: 500 },
};

/** 三源投诉: registrations, handling, and backlog from the three complaint sources. */
export const BMS_COMPLAINT_CONTRACT = {
  title: 'BMS 三源投诉',
  description: '按投诉来源分组的登记、处理、积压，支持日期趋势与期间对比',
  fields: fieldsOf('complaints'),
  dimensions: ['complaint_source', 'snapshot_on'],
  metrics: [
    {
      name: 'complaint_registered',
      description: '投诉登记件数（件）',
      aggregation: 'sum',
      field: 'registered_count',
      value_type: 'integer',
      unit: '件',
      definition: 'complaint_registered',
      dimensions: ['complaint_source', 'snapshot_on'],
    },
    {
      name: 'complaint_handled',
      description: '投诉处理件数（件）',
      aggregation: 'sum',
      field: 'handled_count',
      value_type: 'integer',
      unit: '件',
      definition: 'complaint_handled',
      dimensions: ['complaint_source', 'snapshot_on'],
    },
    {
      name: 'complaint_backlog',
      description: '投诉结存积压（件）',
      aggregation: 'sum',
      field: 'pending_count',
      value_type: 'integer',
      unit: '件',
      definition: 'complaint_backlog',
      dimensions: ['complaint_source', 'snapshot_on'],
    },
  ],
  grain: ['report_no'],
  time: { field: 'snapshot_at', precision: 'timestamp', time_zone: BMS_TIME_ZONE, definition: 'business_time_zone' },
  filters: ['complaint_source', 'snapshot_on', 'snapshot_at'],
  limit: { default: 100, max: 500 },
};
