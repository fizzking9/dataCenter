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

/** The purposes a Model Profile Version may declare, in evaluation order. */
export const MODEL_PURPOSES: ModelPurpose[] = ['integration_proposal', 'grounded_narration', 'clarification'];

/** The data categories a Model Profile Version may be permitted to receive. */
export const MODEL_DATA_CATEGORIES: ModelDataCategory[] = [
  'dataset_schema',
  'cleaning_rules',
  'source_mapping',
  'sample_records',
];

/** The declared structured-output shape each purpose has to answer with. */
export const STRUCTURED_OUTPUT: Record<ModelPurpose, string> = {
  integration_proposal: 'integration_configuration_candidate',
  grounded_narration: 'grounded_narrative',
  clarification: 'clarification_question',
};

/** The tools each purpose may expose; nothing outside this closed set exists. */
const PURPOSE_TOOLS: Record<ModelPurpose, string[]> = {
  integration_proposal: ['read_data_dictionary'],
  grounded_narration: ['read_governed_result'],
  clarification: [],
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
  clarification: {
    question: '处理量',
    missing: ['time_range'],
  },
} as const;
