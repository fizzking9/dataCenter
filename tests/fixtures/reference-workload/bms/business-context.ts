/**
 * The Workspace-owned Business Context that governs the BMS business Data
 * Products.
 *
 * These are approved Metric Definitions, dimension definitions, and the
 * business time zone: a reviewer reads them beside a result, and the engine
 * enforces the formula, unit, value type, favourable direction, and time zone
 * they state. Nothing here is application behavior — it is the declarative
 * meaning an operator publishes through the ordinary governed path.
 */

/** One Business Context entry, in the shape the publication command reads. */
export interface BusinessContextEntry {
  key: string;
  kind: 'metric' | 'dimension' | 'definition';
  value: string;
  unit?: string;
  description?: string;
  aggregation?: 'count' | 'sum' | 'min' | 'max' | 'avg';
  value_type?: 'integer' | 'decimal' | 'money' | 'date' | 'timestamp';
  favorable_direction?: 'up' | 'down' | 'neutral';
}

/** The approved business time zone every Contract window resolves against. */
export const BMS_TIME_ZONE = 'Asia/Shanghai';

export const BMS_BUSINESS_CONTEXT: BusinessContextEntry[] = [
  {
    key: 'business_time_zone',
    kind: 'definition',
    value: BMS_TIME_ZONE,
    description: '全部业务日期与比较窗口统一采用的业务时区',
  },

  // 经营总览
  {
    key: 'reception_count',
    kind: 'metric',
    value: '接待量，等于窗口内受理登记的服务工单笔数',
    unit: '笔',
    aggregation: 'count',
    value_type: 'integer',
    favorable_direction: 'up',
    description: '接待量上升视为经营向好',
  },
  {
    key: 'handled_total',
    kind: 'metric',
    value: '处理量合计，等于窗口内每笔服务工单处理量之和',
    unit: '次',
    aggregation: 'sum',
    value_type: 'integer',
    favorable_direction: 'up',
    description: '处理量上升视为经营向好',
  },
  {
    key: 'service_status',
    kind: 'dimension',
    value: '服务状态，取值 已受理、维修中、已完工，按来源原值保留',
  },
  {
    key: 'registered_on',
    kind: 'dimension',
    value: '受理登记日期，按业务时区的自然日',
  },

  // 四路退款
  {
    key: 'refund_count',
    kind: 'metric',
    value: '退款笔数，等于窗口内的退款单笔数',
    unit: '笔',
    aggregation: 'count',
    value_type: 'integer',
    favorable_direction: 'down',
    description: '退款笔数下降视为经营向好',
  },
  {
    key: 'refund_amount_total',
    kind: 'metric',
    value: '退款金额合计，等于窗口内退款单金额之和',
    unit: '元',
    aggregation: 'sum',
    value_type: 'money',
    favorable_direction: 'down',
    description: '退款金额下降视为经营向好',
  },
  {
    key: 'refund_route',
    kind: 'dimension',
    value: '退款路径，取值 A 线上直退、B 线下、C 闪猫退款、D 手动退款，按来源原值保留',
  },
  {
    key: 'refund_status',
    kind: 'dimension',
    value: '退款状态，取值 待审批、已退款，按来源原值保留',
  },
  {
    key: 'refunded_on',
    kind: 'dimension',
    value: '退款完成日期，按业务时区的自然日',
  },

  // 三源投诉
  {
    key: 'complaint_registered',
    kind: 'metric',
    value: '投诉登记件数，等于窗口内各投诉快照登记件数之和',
    unit: '件',
    aggregation: 'sum',
    value_type: 'integer',
    favorable_direction: 'down',
    description: '投诉量下降视为经营向好',
  },
  {
    key: 'complaint_handled',
    kind: 'metric',
    value: '投诉处理件数，等于窗口内各投诉快照处理件数之和',
    unit: '件',
    aggregation: 'sum',
    value_type: 'integer',
    favorable_direction: 'up',
    description: '投诉处理量上升视为经营向好',
  },
  {
    key: 'complaint_backlog',
    kind: 'metric',
    value: '投诉结存积压，等于窗口内投诉快照的结存积压件数之和；单日窗口即当日结存积压',
    unit: '件',
    aggregation: 'sum',
    value_type: 'integer',
    favorable_direction: 'down',
    description: '积压下降视为经营向好',
  },
  {
    key: 'complaint_source',
    kind: 'dimension',
    value: '投诉来源，取值 内部、商户号、外部，按来源原值保留',
  },
  {
    key: 'snapshot_on',
    kind: 'dimension',
    value: '投诉快照日期，按业务时区的自然日',
  },
];
