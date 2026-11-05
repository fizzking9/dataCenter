/**
 * The frozen data-dictionary mapping for the ai-acc handling export.
 *
 * This is a versioned certification asset, not application code: it states, in
 * the terms the source system's own data dictionary uses, which exported column
 * becomes which canonical Dataset field and what business meaning that field
 * carries. The Workspace-owned Integration Configuration and Data Product
 * Contract used by certification are derived from this one statement, so a
 * mapping is never restated in two places and never reaches the engine.
 */

/** One exported column and the canonical field it becomes. */
export interface DictionaryEntry {
  /** The column name the export really carries, as the source system prints it. */
  column: string;
  /** The canonical Dataset field the column curates into. */
  field: string;
  /** The canonical field's declared type. */
  type: 'string' | 'integer' | 'number' | 'date' | 'timestamp';
  /** The business meaning of the field, in Simplified Chinese. */
  meaning: string;
}

/**
 * The export's columns, in the order the source system prints them. The order
 * is part of the asset: it is what a reviewer compares against the dictionary.
 */
export const AI_ACC_DICTIONARY: DictionaryEntry[] = [
  { column: '工单号', field: 'record_id', type: 'string', meaning: '受理工单唯一编号' },
  { column: '设备编号', field: 'device_sn', type: 'string', meaning: '受理设备序列号' },
  { column: '日期', field: 'handled_on', type: 'date', meaning: '受理发生日期' },
  { column: '时段', field: 'time_band', type: 'string', meaning: '受理所属时段' },
  { column: '接管状态', field: 'takeover_state', type: 'string', meaning: '该笔受理是否已被接管' },
  { column: '处理量', field: 'handled_count', type: 'integer', meaning: '该工单的处理量（次）' },
];

/** The source-column-to-field mapping the Integration Configuration pins. */
export function dictionaryMapping(): Record<string, string> {
  return Object.fromEntries(AI_ACC_DICTIONARY.map((entry) => [entry.column, entry.field]));
}

/** The canonical Dataset Schema the dictionary declares, in dictionary order. */
export function dictionarySchema(): Array<{ name: string; type: DictionaryEntry['type'] }> {
  return AI_ACC_DICTIONARY.map((entry) => ({ name: entry.field, type: entry.type }));
}

/**
 * The business vocabulary the Workspace owns. These are governed definitions a
 * reviewer can read beside a result, and the values themselves stay the
 * source-native labels the export carries.
 */
export const AI_ACC_BUSINESS_CONTEXT = [
  {
    key: 'ai_acc_handled_total',
    kind: 'metric',
    value: '受理处理量合计，等于该范围内每条工单处理量之和',
    unit: '次',
  },
  {
    key: 'ai_acc_record_count',
    kind: 'metric',
    value: '受理工单条数，按工单号去重后计数',
    unit: '条',
  },
  {
    key: 'ai_acc_time_band',
    kind: 'dimension',
    value: '受理时段，取值 00-08、08-16、16-24，按来源原值保留',
  },
  {
    key: 'ai_acc_takeover_state',
    kind: 'dimension',
    value: '接管状态，取值 已接管、未接管，按来源原值保留',
  },
];
