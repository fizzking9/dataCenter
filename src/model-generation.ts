import type { CleaningRule, DatasetSchemaField, ModelDataCategory, ModelPurpose } from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord } from './documents.js';
import { parseIntegrationConfiguration } from './integration.js';
import {
  modelAdapter,
  type AdapterFailure,
  type GenerationRequest,
  type GenerationResult,
  type ModelPromptPin,
  type PinnedModelProfile,
} from './model-adapter.js';
import { REFUSED_KEYS } from './product-query-document.js';

/** The purposes a Model Profile Version may declare, in evaluation order. */
export const MODEL_PURPOSES: ModelPurpose[] = [
  'integration_proposal',
  'data_product_proposal',
  'grounded_narration',
  'clarification',
  'query_plan',
];

/** The data categories a Model Profile Version may be permitted to receive. */
export const MODEL_DATA_CATEGORIES: ModelDataCategory[] = [
  'dataset_schema',
  'cleaning_rules',
  'source_mapping',
  'sample_records',
  'product_contract',
];

/** The data categories a purpose's pinned input actually carries. */
export const PURPOSE_CATEGORIES: Record<ModelPurpose, ModelDataCategory[]> = {
  integration_proposal: ['dataset_schema', 'cleaning_rules', 'source_mapping'],
  data_product_proposal: ['dataset_schema'],
  grounded_narration: ['sample_records'],
  clarification: [],
  query_plan: ['product_contract'],
};

/** The declared structured-output shape each purpose has to answer with. */
export const STRUCTURED_OUTPUT: Record<ModelPurpose, string> = {
  integration_proposal: 'integration_configuration_candidate',
  data_product_proposal: 'data_product_contract_candidate',
  grounded_narration: 'grounded_narrative',
  clarification: 'clarification_question',
  query_plan: 'data_product_query_plan',
};

/** The tools each purpose may expose; nothing outside this closed set exists. */
const PURPOSE_TOOLS: Record<ModelPurpose, string[]> = {
  integration_proposal: ['read_data_dictionary'],
  data_product_proposal: [],
  grounded_narration: ['read_governed_result'],
  clarification: [],
  query_plan: [],
};

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;
const LATIN = /[A-Za-z]/gu;

export function promptHash(purpose: ModelPurpose, body: string): string {
  return canonicalDigest({ id: purpose, body });
}

/** A prompt pins Simplified Chinese output; a Profile cannot omit that. */
export function promptPinsSimplifiedChinese(body: string): boolean {
  return body.includes('简体中文');
}

/**
 * Whether an answer is grounded Simplified Chinese narration. Latin text alone
 * is an English answer, and the platform refuses to degrade into it silently.
 */
export function isSimplifiedChinese(text: string): boolean {
  const cjk = text.match(CJK)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  return cjk >= 6 && cjk >= latin;
}

/** Only the declared tools a purpose is allowed to see are ever exposed. */
export function toolsFor(profile: PinnedModelProfile, purpose: ModelPurpose): string[] {
  return PURPOSE_TOOLS[purpose].filter((tool) => profile.tools.includes(tool));
}

/** The exact pinned prompt one purpose runs under, never a supplied override. */
export function promptOf(
  profile: PinnedModelProfile,
  purpose: ModelPurpose,
  fail: AdapterFailure,
): ModelPromptPin {
  const prompt = profile.prompts.find((candidate) => candidate.id === purpose);
  if (prompt === undefined) {
    fail('MODEL_PURPOSE_UNSUPPORTED', `The Model Profile Version declares no ${purpose} prompt.`);
  }
  return prompt;
}

/**
 * The one generation seam. Every purpose, and every adapter, runs through this
 * call: the exact pinned Version, its pinned prompt, its declared tools, and the
 * declared structured-output shape. Nothing here chooses a provider or falls
 * back to another one.
 */
export async function generateForPurpose(
  profile: PinnedModelProfile,
  purpose: ModelPurpose,
  input: unknown,
  fail: AdapterFailure,
): Promise<GenerationResult> {
  // A pinned permission set is the ceiling for every purpose, on every path: a
  // generation whose evidence is outside it is refused before the endpoint sees it.
  const unpermitted = PURPOSE_CATEGORIES[purpose].filter(
    (category) => !profile.data_categories.includes(category),
  );
  if (unpermitted.length > 0) {
    fail(
      'MODEL_DATA_CATEGORY_NOT_PERMITTED',
      `The pinned Model Profile permissions do not cover the data this ${purpose} generation carries: ${unpermitted.join(', ')}.`,
    );
  }
  const request: GenerationRequest = {
    purpose,
    prompt: promptOf(profile, purpose, fail),
    structured_output: STRUCTURED_OUTPUT[purpose],
    tools: toolsFor(profile, purpose),
    input,
  };
  return modelAdapter(profile.adapter).generate(profile, request, fail);
}

export interface GeneratedCandidate {
  identity: string[];
  schema: DatasetSchemaField[];
  cleaning: CleaningRule[];
  mapping: Record<string, string>;
}

/** Why a narrative answer is not grounded in the governed evidence it received. */
export function narrationFailure(output: Record<string, unknown>, input: unknown): string | null {
  const refs = output['evidence_refs'];
  if (!Array.isArray(refs) || refs.length === 0) return 'EVIDENCE_REFS_MISSING';
  const records = isRecord(input) && Array.isArray(input['records'])
    ? input['records'].filter((record): record is Record<string, unknown> => isRecord(record))
    : [];
  for (const reference of refs) {
    if (!isRecord(reference) || typeof reference['field'] !== 'string') return 'EVIDENCE_REF_INVALID';
    const field = reference['field'];
    const value = reference['value'];
    if (!records.some((record) => record[field] === value)) return 'EVIDENCE_REF_NOT_GOVERNED';
  }
  const narrative = typeof output['narrative'] === 'string' ? output['narrative'] : '';
  if (!refs.some((reference) => isRecord(reference) && narrative.includes(String(reference['value'])))) {
    return 'NARRATIVE_NOT_GROUNDED';
  }
  return null;
}

/** The members a query-plan answer may state, and nothing wider. */
const PLAN_KEYS = ['action', 'query', 'parts', 'missing', 'candidates', 'interpretation'];
const PLAN_QUERY_KEYS = [
  'kind', 'filters', 'metric_filters', 'group_by', 'metrics', 'sort',
  'window', 'comparison', 'include_totals', 'limit', 'q',
  'release', 'major', 'cursor',
];
const PART_KEYS = ['product', 'query'];
/** How many independent Data Product Queries one compound question may plan. */
export const MAX_PLAN_PARTS = 8;
const MISSING_KINDS = ['period', 'dimension', 'metric', 'filter_value'];
const QUERY_KINDS = ['records', 'aggregate', 'search', 'suggest'];

/** Whether a turn expects one query, one or more parts, or either. */
export type QueryPlanShape = 'query' | 'parts' | 'either';

/** Finds any key the published query language never accepts, at any depth. */
function refusedKeyIn(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = refusedKeyIn(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (REFUSED_KEYS.includes(key)) return key;
    const found = refusedKeyIn(child);
    if (found !== null) return found;
  }
  return null;
}

/** The published request vocabulary one part's query may use, and nothing wider. */
function queryBodyFailure(query: Record<string, unknown>): string | null {
  if (typeof query['kind'] !== 'string' || !QUERY_KINDS.includes(query['kind'])) {
    return 'QUERY_PLAN_KIND_INVALID';
  }
  for (const key of Object.keys(query)) {
    if (PLAN_QUERY_KEYS.includes(key)) continue;
    if (REFUSED_KEYS.includes(key)) return 'QUERY_PLAN_CODE_REFUSED';
    return 'QUERY_PLAN_KEY_UNSUPPORTED';
  }
  if (refusedKeyIn(query) !== null) return 'QUERY_PLAN_CODE_REFUSED';
  return null;
}

/**
 * One independent part of a compound question: the Data Product handle the turn
 * authorized and the request that part compiles to. A part carries no join, no
 * formula, and no reference to any other part.
 */
function partsFailure(raw: unknown, shape: QueryPlanShape): string | null {
  if (shape === 'query') return 'QUERY_PLAN_PARTS_UNSUPPORTED';
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PLAN_PARTS) {
    return 'QUERY_PLAN_PARTS_INVALID';
  }
  for (const part of raw) {
    if (!isRecord(part)) return 'QUERY_PLAN_PARTS_INVALID';
    for (const key of Object.keys(part)) {
      if (PART_KEYS.includes(key)) continue;
      if (REFUSED_KEYS.includes(key)) return 'QUERY_PLAN_CODE_REFUSED';
      return 'QUERY_PLAN_KEY_UNSUPPORTED';
    }
    const product = part['product'];
    if (typeof product !== 'string' || product.length === 0 || product.length > 2048) {
      return 'QUERY_PLAN_PART_PRODUCT_INVALID';
    }
    const query = part['query'];
    if (!isRecord(query)) return 'QUERY_PLAN_QUERY_MISSING';
    const failure = queryBodyFailure(query);
    if (failure !== null) return failure;
  }
  return null;
}

/**
 * The declared query-plan shape every model answer is judged against before it
 * can become a Data Product Query. It never widens the published vocabulary:
 * SQL, formulas, joins, and unpublished request keys are refused by name.
 *
 * A compound question plans independent parts instead of one query, so a part
 * can name only a Data Product handle this turn already authorized; composing
 * parts into one request is not expressible at all.
 */
export function queryPlanFailure(
  output: Record<string, unknown>,
  shape: QueryPlanShape = 'either',
): string | null {
  const refused = Object.keys(output).find((key) => key !== 'query' && REFUSED_KEYS.includes(key));
  if (refused !== undefined) return 'QUERY_PLAN_CODE_REFUSED';
  if (Object.keys(output).some((key) => !PLAN_KEYS.includes(key))) return 'QUERY_PLAN_KEY_UNSUPPORTED';
  const action = output['action'];
  if (action !== 'query' && action !== 'clarify') return 'QUERY_PLAN_ACTION_INVALID';
  const interpretation = output['interpretation'];
  if (typeof interpretation !== 'string' || interpretation.trim().length === 0) {
    return 'QUERY_PLAN_INTERPRETATION_MISSING';
  }
  if (output['candidates'] !== undefined) {
    const candidates = output['candidates'];
    if (!Array.isArray(candidates) || candidates.some((candidate) => typeof candidate !== 'string')) {
      return 'QUERY_PLAN_CANDIDATES_INVALID';
    }
  }
  if (action === 'clarify') {
    const missing = output['missing'];
    if (!Array.isArray(missing) || missing.length === 0) return 'QUERY_PLAN_MISSING_UNDECLARED';
    if (missing.some((kind) => typeof kind !== 'string' || !MISSING_KINDS.includes(kind))) {
      return 'QUERY_PLAN_MISSING_UNSUPPORTED';
    }
    if (output['query'] !== undefined || output['parts'] !== undefined) {
      return 'QUERY_PLAN_QUERY_UNEXPECTED';
    }
    return null;
  }
  const hasParts = output['parts'] !== undefined;
  if (hasParts) {
    if (output['query'] !== undefined) return 'QUERY_PLAN_QUERY_UNEXPECTED';
    return partsFailure(output['parts'], shape);
  }
  const query = output['query'];
  if (!isRecord(query)) return 'QUERY_PLAN_QUERY_MISSING';
  if (shape === 'parts') return 'QUERY_PLAN_PARTS_REQUIRED';
  return queryBodyFailure(query);
}

/**
 * Runs one integration generation under the exact pinned Version, then validates
 * the answer with the same Integration Configuration parser publication uses, so
 * a candidate is never a second configuration model.
 */
export async function generateIntegrationCandidate(
  profile: PinnedModelProfile,
  input: unknown,
  fail: AdapterFailure,
): Promise<GeneratedCandidate> {
  const result = await generateForPurpose(profile, 'integration_proposal', input, fail);
  if (result.tool_calls.length > 0) {
    // The data dictionary is already supplied, so a tool call would mean the
    // endpoint looked somewhere the platform did not expose.
    fail('MODEL_STRUCTURED_OUTPUT_INVALID', 'The Model Profile answer used a tool the Proposal generation did not need.');
  }
  return parseIntegrationConfiguration(result.output, (code, message) => {
    fail('MODEL_STRUCTURED_OUTPUT_INVALID', `${code}: ${message}`);
  });
}

/**
 * Runs one Data Product generation under the exact pinned Version and returns
 * the candidate Contract document. The caller validates it with the same
 * Contract parser publication uses, so a candidate is never a second model.
 */
export async function generateProductCandidate(
  profile: PinnedModelProfile,
  input: unknown,
  fail: AdapterFailure,
): Promise<Record<string, unknown>> {
  const result = await generateForPurpose(profile, 'data_product_proposal', input, fail);
  if (result.tool_calls.length > 0) {
    // The authorized schema and Business Context are already supplied, so a
    // tool call would mean the endpoint looked somewhere it was not given.
    fail('MODEL_STRUCTURED_OUTPUT_INVALID', 'The Model Profile answer used a tool the Data Product Proposal generation did not need.');
  }
  const output = result.output['contract'] ?? result.output;
  if (!isRecord(output)) {
    fail('MODEL_STRUCTURED_OUTPUT_INVALID', 'The Model Profile answer did not contain a Data Product Contract candidate.');
  }
  return output;
}

/** Runs one grounded-narration generation and refuses ungrounded or English prose. */
export async function generateGroundedNarration(
  profile: PinnedModelProfile,
  input: unknown,
  fail: AdapterFailure,
): Promise<Record<string, unknown>> {
  const result = await generateForPurpose(profile, 'grounded_narration', input, fail);
  const failure = narrationFailure(result.output, input);
  if (failure !== null) {
    fail('NARRATION_NOT_GROUNDED', `The Model Profile answer is not grounded in the supplied evidence (${failure}).`);
  }
  const narrative = String(result.output['narrative'] ?? '');
  if (!isSimplifiedChinese(narrative)) {
    fail('NARRATION_NOT_SIMPLIFIED_CHINESE', 'The Model Profile answer is not grounded Simplified Chinese narration.');
  }
  return result.output;
}

/** Runs one clarification generation and refuses an English-only question. */
export async function generateClarification(
  profile: PinnedModelProfile,
  input: unknown,
  fail: AdapterFailure,
): Promise<Record<string, unknown>> {
  const result = await generateForPurpose(profile, 'clarification', input, fail);
  const question = result.output['question'];
  if (typeof question !== 'string' || !isSimplifiedChinese(question)) {
    fail('CLARIFICATION_NOT_SIMPLIFIED_CHINESE', 'The Model Profile answer is not a Simplified Chinese clarification.');
  }
  return result.output;
}

/** The frozen evidence every activation evaluation and Binding preflight uses. */
export const EVALUATION_INPUTS = {
  integration_proposal: {
    dataset_name: '激活评价样本',
    fields: [
      { source_column: '设备SN', name: 'sn', type: 'string', description: '设备序列号', identity: true, clean: ['trim'] },
      { source_column: '处理量', name: 'handled_count', type: 'integer', description: '当日处理量' },
    ],
  },
  grounded_narration: {
    question: '受治理结果里杭州的处理量是多少？',
    records: [
      { city: '杭州', handled_count: 5 },
      { city: '上海', handled_count: 3 },
    ],
  },
  data_product_proposal: {
    name: '设备处理量表',
    requirement: '按城市汇总设备处理量与结算金额。',
    clarifications: [],
    dataset: {
      dataset_id: 'evaluation-dataset',
      release: 1,
      identity_fields: ['sn'],
      fields: [
        { name: 'sn', type: 'string', description: '设备序列号' },
        { name: 'city', type: 'string', description: '所在城市' },
        { name: 'handled_count', type: 'integer', description: '当日处理量' },
      ],
    },
    metric_definitions: [
      { key: 'handled_count_total', value: '处理量合计', unit: '次' },
    ],
    business_context: { common_version: 1, workspace_version: 1 },
  },
  clarification: {
    question: '处理量',
    missing: ['time_range'],
  },
  query_plan: {
    question: '杭州的处理量合计是多少？',
    clarification: null,
    today: '2026-01-31',
    contract: {
      title: '设备维修台账',
      fields: [
        { name: 'sn', description: '设备序列号' },
        { name: 'city', description: '所属城市' },
        { name: 'handled_count', description: '处理量' },
        { name: 'reported_on', description: '上报日期' },
      ],
      dimensions: ['city'],
      metrics: [
        { name: 'handled_total', aggregation: 'sum', value_type: 'integer', unit: '次', dimensions: ['city'] },
        { name: 'device_count', aggregation: 'count', value_type: 'integer', dimensions: ['city'] },
      ],
      filters: ['city'],
      time: { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' },
      limits: { max_scanned_records: 10_000, max_groups: 100, max_execution_ms: 1_000 },
    },
    defaults: { limit: 100 },
  },
} as const;
