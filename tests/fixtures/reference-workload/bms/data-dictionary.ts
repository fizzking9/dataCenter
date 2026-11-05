/**
 * The frozen data-dictionary mapping for the three BMS operational exports the
 * business Data Products are certified against.
 *
 * This is a versioned certification asset, not application code. It states, in
 * the terms the source system's own data dictionary uses, which exported column
 * becomes which canonical Dataset field and what business meaning it carries.
 * The Workspace-owned Integration Configurations and Data Product Contracts are
 * derived from this one statement, so a mapping is never restated in two places
 * and never reaches the engine.
 */

/** One exported column and the canonical field it becomes. */
export interface DictionaryEntry {
  /** The column name the export really carries, in Simplified Chinese. */
  column: string;
  /** The canonical Dataset field the column curates into. */
  field: string;
  /** The canonical field's declared type. */
  type: 'string' | 'integer' | 'number' | 'date' | 'timestamp';
  /** The business meaning of the field, in Simplified Chinese. */
  meaning: string;
}

/** The three operational exports the business questions read. */
export type BusinessDataset = 'service_orders' | 'refunds' | 'complaints';

/**
 * The BMS source update column is carried by every export but is not a business
 * event: it states when the export system last rewrote the row.
 */
const UPDATED_AT: DictionaryEntry = {
  column: 'updated_at',
  field: 'updated_at',
  type: 'timestamp',
  meaning: '导出系统记录的更新时间',
};

const SERVICE_ORDERS: DictionaryEntry[] = [
  { column: 'order_no', field: 'order_no', type: 'string', meaning: '服务工单编号，工单唯一标识' },
  UPDATED_AT,
  { column: 'registered_at', field: 'registered_at', type: 'timestamp', meaning: '受理登记时间' },
  { column: 'registered_on', field: 'registered_on', type: 'date', meaning: '受理登记日期' },
  { column: 'status_text', field: 'service_status', type: 'string', meaning: '工单服务状态：已受理、维修中、已完工' },
  { column: 'handled_count', field: 'handled_count', type: 'integer', meaning: '该工单累计处理量（次）' },
];

const REFUNDS: DictionaryEntry[] = [
  { column: 'refund_no', field: 'refund_no', type: 'string', meaning: '退款单号，退款单唯一标识' },
  UPDATED_AT,
  { column: 'refunded_at', field: 'refunded_at', type: 'timestamp', meaning: '退款完成时间' },
  { column: 'refunded_on', field: 'refunded_on', type: 'date', meaning: '退款完成日期' },
  { column: 'refund_status', field: 'refund_status', type: 'string', meaning: '退款状态：待审批、已退款' },
  {
    column: 'refund_route',
    field: 'refund_route',
    type: 'string',
    meaning: '退款路径：A 线上直退、B 线下、C 闪猫退款、D 手动退款',
  },
  { column: 'refund_amount', field: 'refund_amount', type: 'number', meaning: '退款金额（元）' },
];

const COMPLAINTS: DictionaryEntry[] = [
  { column: 'report_no', field: 'report_no', type: 'string', meaning: '投诉日报编号，快照唯一标识' },
  UPDATED_AT,
  { column: 'snapshot_at', field: 'snapshot_at', type: 'timestamp', meaning: '投诉快照时间' },
  { column: 'snapshot_on', field: 'snapshot_on', type: 'date', meaning: '投诉快照日期' },
  {
    column: 'source_name',
    field: 'complaint_source',
    type: 'string',
    meaning: '投诉来源：内部、商户号、外部',
  },
  { column: 'registered_count', field: 'registered_count', type: 'integer', meaning: '当日登记投诉件数' },
  { column: 'handled_count', field: 'handled_count', type: 'integer', meaning: '当日处理投诉件数' },
  { column: 'pending_count', field: 'pending_count', type: 'integer', meaning: '当日结存积压投诉件数' },
];

/** The dictionary of one business dataset, in the order the export prints it. */
export const BMS_DICTIONARIES: Record<BusinessDataset, DictionaryEntry[]> = {
  service_orders: SERVICE_ORDERS,
  refunds: REFUNDS,
  complaints: COMPLAINTS,
};

/** The source-column-to-field mapping an Integration Configuration pins. */
export function dictionaryMapping(dataset: BusinessDataset): Record<string, string> {
  return Object.fromEntries(BMS_DICTIONARIES[dataset].map((entry) => [entry.column, entry.field]));
}

/** The canonical Dataset Schema the dictionary declares, in dictionary order. */
export function dictionarySchema(
  dataset: BusinessDataset,
): Array<{ name: string; type: DictionaryEntry['type'] }> {
  return BMS_DICTIONARIES[dataset].map((entry) => ({ name: entry.field, type: entry.type }));
}

/** The canonical field a source column curates into, so certification can name it. */
export function fieldOf(dataset: BusinessDataset, column: string): string {
  const entry = BMS_DICTIONARIES[dataset].find((candidate) => candidate.column === column);
  if (entry === undefined) throw new Error(`${dataset} carries no ${column} column`);
  return entry.field;
}
