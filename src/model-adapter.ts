import type { ModelAdapterKind, ModelDataCategory, ModelPurpose } from './catalog.js';

/**
 * The one declarative generation contract this release speaks over HTTP.
 *
 * A Model Profile is an administrator-supplied endpoint, so the platform ships
 * no vendor SDK: an adapter is only the transport and the enforcement around it.
 * Both shipped adapters answer the same contract and are refused the same way
 * when they do not.
 */
export const MODEL_CONTRACT = 'datacenter.model.v1';

export type AdapterFailure = (code: string, message: string) => never;

/** The exact Model Profile Version one generation call runs under. */
export interface PinnedModelProfile {
  model_profile_id: string;
  model_profile_version: number;
  content_hash: string;
  adapter: ModelAdapterKind;
  endpoint_url: string;
  model_id: string;
  credential: string | null;
  max_output_bytes: number;
  /** The Profile's declared tools; a request may expose fewer, never more. */
  tools: string[];
  /** The exact prompts this Version pinned, one per declared purpose. */
  prompts: ModelPromptPin[];
  /**
   * The data categories this generation may send: the Version's declared set,
   * narrowed to a Binding's permitted set whenever a Binding resolved the pin.
   */
  data_categories: ModelDataCategory[];
}

/** One prompt an exact Model Profile Version pins for one purpose. */
export interface ModelPromptPin {
  id: ModelPurpose;
  body: string;
  hash: string;
}

export interface GenerationRequest {
  purpose: ModelPurpose;
  prompt: ModelPromptPin;
  /** The declared structured-output shape the answer must take. */
  structured_output: string;
  tools: string[];
  input: unknown;
}

export interface GenerationResult {
  output: Record<string, unknown>;
  tool_calls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  /** The identity the endpoint echoed, so a caller can record the exact pin. */
  identity: { model: string; profile_hash: string };
  request_hash: string;
  /**
   * What the endpoint states it consumed. An endpoint may state nothing, in
   * which case the platform accounts its own documented token count instead.
   */
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface ModelAdapter {
  readonly kind: ModelAdapterKind;
  /** Checks the endpoint speaks this contract under the pinned model identity. */
  probe(
    profile: PinnedModelProfile,
    fail: AdapterFailure,
  ): Promise<{ model: string; contracts: string[] }>;
  generate(
    profile: PinnedModelProfile,
    request: GenerationRequest,
    fail: AdapterFailure,
  ): Promise<GenerationResult>;
}

/** Each shipped adapter differs only in its declarative HTTP contract. */
const ROUTES: Record<ModelAdapterKind, { probe: string; generate: string; authenticated: boolean }> = {
  hosted: { probe: '/v1/models', generate: '/v1/generate', authenticated: true },
  generic_local: { probe: '/health', generate: '/generate', authenticated: false },
};

const ENDPOINT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headersFor(
  kind: ModelAdapterKind,
  profile: PinnedModelProfile,
): Record<string, string> {
  const route = ROUTES[kind];
  if (!route.authenticated || profile.credential === null) return {};
  return { authorization: `Bearer ${profile.credential}` };
}

async function readAnswer(
  response: Response,
  maxBytes: number,
  fail: AdapterFailure,
): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    fail('MODEL_ENDPOINT_UNREACHABLE', `The Model Profile endpoint answered ${response.status}.`);
  }
  if (Buffer.byteLength(text) > maxBytes) {
    fail('MODEL_RESPONSE_TOO_LARGE', 'The Model Profile answer exceeds the Version output limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('MODEL_RESPONSE_MALFORMED', 'The Model Profile endpoint did not answer with JSON.');
  }
  if (!isRecord(parsed)) {
    fail('MODEL_RESPONSE_MALFORMED', 'The Model Profile answer must be a JSON object.');
  }
  return parsed;
}

function requestBody(profile: PinnedModelProfile, request: GenerationRequest): Record<string, unknown> {
  return {
    contract: MODEL_CONTRACT,
    purpose: request.purpose,
    model: profile.model_id,
    model_profile: {
      id: profile.model_profile_id,
      version: profile.model_profile_version,
      hash: profile.content_hash,
    },
    prompt: { id: request.prompt.id, body: request.prompt.body, hash: request.prompt.hash },
    structured_output: request.structured_output,
    // Only the tools this request declares are exposed; the adapter refuses any
    // answer that names another one.
    tools: [...request.tools],
    input: request.input,
  };
}

/**
 * The enforcement every adapter shares: a reply is accepted only under the
 * pinned model identity, only with the declared tools, and only as an object
 * shaped by the declared structured-output contract.
 */
function enforce(
  profile: PinnedModelProfile,
  request: GenerationRequest,
  envelope: Record<string, unknown>,
  fail: AdapterFailure,
): GenerationResult {
  if (envelope['contract'] !== MODEL_CONTRACT) {
    fail('MODEL_RESPONSE_MALFORMED', 'The Model Profile answer does not state the pinned generation contract.');
  }
  const model = envelope['model'];
  const profileHash = envelope['model_profile_hash'];
  if (model !== profile.model_id || profileHash !== profile.content_hash) {
    fail('MODEL_IDENTITY_MISMATCH', 'The Model Profile answer does not come from the pinned Model Profile Version.');
  }
  const rawCalls = envelope['tool_calls'] ?? [];
  if (!Array.isArray(rawCalls)) {
    fail('MODEL_RESPONSE_MALFORMED', 'The Model Profile answer must state its tool calls as an array.');
  }
  const toolCalls: GenerationResult['tool_calls'] = [];
  for (const call of rawCalls) {
    if (!isRecord(call) || typeof call['tool'] !== 'string') {
      fail('MODEL_RESPONSE_MALFORMED', 'Every tool call must name one tool.');
    }
    if (!request.tools.includes(call['tool'])) {
      fail('MODEL_TOOL_NOT_PERMITTED', `The Model Profile answer named the undeclared tool ${call['tool']}.`);
    }
    toolCalls.push({
      tool: call['tool'],
      arguments: isRecord(call['arguments']) ? call['arguments'] : {},
    });
  }
  const output = envelope['output'];
  if (!isRecord(output)) {
    fail('MODEL_STRUCTURED_OUTPUT_INVALID', 'The Model Profile answer did not honour the declared structured output.');
  }
  const statedUsage = envelope['usage'];
  const usage = isRecord(statedUsage)
    && typeof statedUsage['input_tokens'] === 'number'
    && typeof statedUsage['output_tokens'] === 'number'
    ? {
        input_tokens: statedUsage['input_tokens'],
        output_tokens: statedUsage['output_tokens'],
      }
    : null;
  return {
    output,
    tool_calls: toolCalls,
    identity: { model: profile.model_id, profile_hash: profile.content_hash },
    request_hash: '',
    usage,
  };
}

function adapterFor(kind: ModelAdapterKind): ModelAdapter {
  const route = ROUTES[kind];
  return {
    kind,
    async probe(profile, fail) {
      let response: Response;
      try {
        response = await fetch(`${profile.endpoint_url}${route.probe}`, {
          method: 'GET',
          headers: { accept: 'application/json', ...headersFor(kind, profile) },
          redirect: 'error',
          signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
        });
      } catch {
        return fail('MODEL_ENDPOINT_UNREACHABLE', 'The Model Profile endpoint did not answer its preflight probe.');
      }
      const answer = await readAnswer(response, profile.max_output_bytes, fail);
      if (answer['model'] !== profile.model_id) {
        fail('MODEL_PREFLIGHT_FAILED', 'The Model Profile endpoint serves a different model than the one configured.');
      }
      const contracts = Array.isArray(answer['contracts'])
        ? answer['contracts'].filter((item): item is string => typeof item === 'string')
        : [];
      if (!contracts.includes(MODEL_CONTRACT)) {
        fail('MODEL_PREFLIGHT_FAILED', `The Model Profile endpoint does not declare the ${MODEL_CONTRACT} contract.`);
      }
      return { model: profile.model_id, contracts };
    },
    async generate(profile, request, fail) {
      const body = requestBody(profile, request);
      let response: Response;
      try {
        response = await fetch(`${profile.endpoint_url}${route.generate}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headersFor(kind, profile) },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
        });
      } catch {
        return fail('MODEL_ENDPOINT_UNREACHABLE', 'The Model Profile endpoint did not answer the generation request.');
      }
      const envelope = await readAnswer(response, profile.max_output_bytes, fail);
      return enforce(profile, request, envelope, fail);
    },
  };
}

const ADAPTERS: Record<ModelAdapterKind, ModelAdapter> = {
  hosted: adapterFor('hosted'),
  generic_local: adapterFor('generic_local'),
};

export function modelAdapter(kind: ModelAdapterKind): ModelAdapter {
  return ADAPTERS[kind];
}
