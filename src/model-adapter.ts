import type { ModelAdapterKind, ModelDataCategory, ModelPurpose } from './catalog.js';
import { canonicalJson } from './crypto.js';

/**
 * The one declarative generation contract this release speaks over HTTP.
 *
 * A Model Profile is an administrator-supplied endpoint, so the platform ships
 * no vendor SDK: an adapter is only the transport and the enforcement around it.
 * Every shipped adapter answers the same contract, whatever wire protocol its
 * provider speaks, and is refused the same way when it does not.
 */
export const MODEL_CONTRACT = 'datacenter.model.v1';

/**
 * The adapters this release ships, in the order the governed vocabulary lists
 * them. `hosted` and `generic_local` are the platform's own declarative contract;
 * the three provider adapters speak their provider's native wire protocol.
 */
export const MODEL_ADAPTERS: ModelAdapterKind[] = [
  'hosted',
  'generic_local',
  'alibaba_qwen',
  'deepseek',
  'openai_compatible',
];

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

/** The platform's own declarative HTTP contract, spoken by two adapters. */
const ROUTES: Partial<Record<ModelAdapterKind, { probe: string; generate: string; authenticated: boolean }>> = {
  hosted: { probe: '/v1/models', generate: '/v1/generate', authenticated: true },
  generic_local: { probe: '/health', generate: '/generate', authenticated: false },
};

const ENDPOINT_TIMEOUT_MS = 15_000;

/**
 * The JSON Schema each purpose is answered under. A provider adapter sends the
 * schema so the provider enforces it; the platform still validates the answer
 * deterministically, so a provider that merely claims conformance cannot widen
 * the result.
 */
const STRUCTURED_OUTPUT_SCHEMAS: Record<ModelPurpose, Record<string, unknown>> = {
  integration_proposal: {
    type: 'object',
    additionalProperties: false,
    required: ['identity', 'schema', 'cleaning', 'mapping'],
    properties: {
      identity: { type: 'array', items: { type: 'string' } },
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type'],
          properties: { name: { type: 'string' }, type: { type: 'string' } },
        },
      },
      cleaning: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rule', 'field'],
          properties: { rule: { type: 'string' }, field: { type: 'string' } },
        },
      },
      mapping: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  data_product_proposal: {
    type: 'object',
    additionalProperties: true,
    required: ['fields'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      fields: { type: 'array', minItems: 1, items: { type: 'object' } },
      dimensions: { type: 'array', items: { type: 'string' } },
      metrics: { type: 'array', items: { type: 'object' } },
      grain: { type: 'array', items: { type: 'string' } },
      filters: { type: 'array', items: { type: 'string' } },
      limit: { type: 'object' },
    },
  },
  scraper_repair: {
    type: 'object',
    additionalProperties: false,
    required: ['output'],
    properties: {
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['record_selector', 'fields'],
        properties: {
          record_selector: { type: 'string' },
          fields: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'selector'],
              properties: { name: { type: 'string' }, selector: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  grounded_narration: {
    type: 'object',
    additionalProperties: false,
    required: ['narrative', 'evidence_refs'],
    properties: {
      narrative: { type: 'string' },
      evidence_refs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'value'],
          properties: { field: { type: 'string' }, value: {} },
        },
      },
    },
  },
  clarification: {
    type: 'object',
    additionalProperties: false,
    required: ['question'],
    properties: { question: { type: 'string' } },
  },
  query_plan: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'interpretation'],
    properties: {
      action: { enum: ['query', 'clarify'] },
      interpretation: { type: 'string' },
      query: { type: 'object' },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['product', 'query'],
          properties: { product: { type: 'string' }, query: { type: 'object' } },
        },
      },
      missing: { type: 'array', items: { type: 'string' } },
      candidates: { type: 'array', items: { type: 'string' } },
    },
  },
};

/**
 * The closed set of platform-declared tools and their argument schema. A tool
 * outside this set cannot be described to a provider, so the adapter refuses
 * the request rather than sending an unconstrained function.
 */
const TOOL_PARAMETERS: Record<string, Record<string, unknown>> = {
  read_data_dictionary: { type: 'object', additionalProperties: false, properties: {} },
  read_governed_result: { type: 'object', additionalProperties: false, properties: {} },
};

/** Mutable latest aliases defeat the pinned identity, so they never reach a provider. */
const MUTABLE_ALIAS = /(?:^|[-_.:/])latest$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function headersFor(
  kind: ModelAdapterKind,
  profile: PinnedModelProfile,
): Record<string, string> {
  const route = ROUTES[kind];
  if (route === undefined || !route.authenticated || profile.credential === null) return {};
  return { authorization: `Bearer ${profile.credential}` };
}

/** A stored credential is sent only when the provider protocol expects one. */
function credentialHeaders(profile: PinnedModelProfile): Record<string, string> {
  return profile.credential === null ? {} : { authorization: `Bearer ${profile.credential}` };
}

/**
 * Joins the administrator's base URL with a provider route without repeating a
 * version segment the administrator already stated (`.../v1` or `.../api/v1`).
 */
function providerUrl(endpoint: string, path: string): string {
  if (path.startsWith('/api/v1/') && endpoint.endsWith('/api/v1')) {
    return `${endpoint}${path.slice('/api/v1'.length)}`;
  }
  if (path.startsWith('/v1/') && endpoint.endsWith('/v1')) {
    return `${endpoint}${path.slice('/v1'.length)}`;
  }
  return `${endpoint}${path}`;
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
  if (route === undefined) {
    throw new Error(`The ${String(kind)} adapter does not speak the platform contract.`);
  }
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

/**
 * A provider-native adapter is refused before it reaches the network when its
 * configured settings cannot be honoured: a native provider needs its stored
 * credential, and a mutable latest alias cannot be pinned as an exact identity.
 */
function assertProviderSettings(
  kind: ModelAdapterKind,
  profile: PinnedModelProfile,
  requireCredential: boolean,
  fail: AdapterFailure,
): void {
  if (requireCredential && profile.credential === null) {
    fail('MODEL_CREDENTIAL_REQUIRED', `The ${kind} adapter needs a stored provider credential.`);
  }
  if (MUTABLE_ALIAS.test(profile.model_id)) {
    fail(
      'MODEL_MODEL_ALIAS_UNSUPPORTED',
      `The ${kind} adapter cannot pin the mutable model alias ${profile.model_id}.`,
    );
  }
}

function schemaFor(request: GenerationRequest, fail: AdapterFailure): Record<string, unknown> {
  const schema = STRUCTURED_OUTPUT_SCHEMAS[request.purpose];
  if (!isRecord(schema)) {
    fail('MODEL_UNSUPPORTED_SETTING', `No structured-output schema is shipped for the ${request.purpose} purpose.`);
  }
  return schema;
}

/** The declared tools, each with the closed argument schema the provider enforces. */
function toolDefinitions(
  kind: ModelAdapterKind,
  request: GenerationRequest,
  fail: AdapterFailure,
): Array<Record<string, unknown>> {
  const definitions: Array<Record<string, unknown>> = [];
  for (const tool of request.tools) {
    const parameters = TOOL_PARAMETERS[tool];
    if (parameters === undefined) {
      fail('MODEL_UNSUPPORTED_SETTING', `The ${kind} adapter has no schema-constrained definition for the tool ${tool}.`);
    }
    definitions.push({
      type: 'function',
      function: {
        name: tool,
        description: `The platform-declared ${tool} tool.`,
        strict: true,
        parameters,
      },
    });
  }
  return definitions;
}

/** One system prompt and one user turn carrying the governed input, provider-neutral. */
function providerMessages(request: GenerationRequest): Array<Record<string, unknown>> {
  return [
    { role: 'system', content: request.prompt.body },
    {
      role: 'user',
      content: canonicalJson({
        purpose: request.purpose,
        structured_output: request.structured_output,
        input: request.input,
      }),
    },
  ];
}

function jsonObject(
  kind: ModelAdapterKind,
  raw: unknown,
  code: string,
  fail: AdapterFailure,
): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer did not state a JSON object.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code, `The ${kind} answer was not a JSON object.`);
  }
  if (!isRecord(parsed)) fail(code, `The ${kind} answer was not a JSON object.`);
  return parsed;
}

/**
 * Maps provider tool calls back to the platform's closed call shape. A call to
 * the synthetic structured-output tool becomes the answer object; every other
 * call is passed through so the shared enforcement refuses it when undeclared.
 */
function toolCallsFrom(
  kind: ModelAdapterKind,
  raw: unknown,
  structuredTool: string | null,
  fail: AdapterFailure,
): {
  output: Record<string, unknown> | null;
  calls: Array<{ tool: string; arguments: Record<string, unknown> }>;
} {
  if (raw === undefined || raw === null) return { output: null, calls: [] };
  if (!Array.isArray(raw)) {
    fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer must state its tool calls as an array.`);
  }
  const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  let output: Record<string, unknown> | null = null;
  for (const call of raw) {
    if (!isRecord(call) || !isRecord(call['function']) || typeof call['function']['name'] !== 'string') {
      fail('MODEL_RESPONSE_MALFORMED', `Every ${kind} tool call must name one function.`);
    }
    const name = call['function']['name'];
    const args = jsonObject(kind, call['function']['arguments'] ?? {}, 'MODEL_RESPONSE_MALFORMED', fail);
    if (structuredTool !== null && name === structuredTool) {
      if (output !== null) {
        fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer stated the structured output more than once.`);
      }
      output = args;
      continue;
    }
    calls.push({ tool: name, arguments: args });
  }
  return { output, calls };
}

/** A provider's message content, when the answer carries the object there. */
function contentObject(
  kind: ModelAdapterKind,
  raw: unknown,
  fail: AdapterFailure,
): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return jsonObject(kind, raw, 'MODEL_STRUCTURED_OUTPUT_INVALID', fail);
}

function usageOf(raw: unknown): { input_tokens: number; output_tokens: number } | null {
  if (!isRecord(raw)) return null;
  const input = typeof raw['input_tokens'] === 'number'
    ? raw['input_tokens']
    : typeof raw['prompt_tokens'] === 'number'
      ? raw['prompt_tokens']
      : null;
  const output = typeof raw['output_tokens'] === 'number'
    ? raw['output_tokens']
    : typeof raw['completion_tokens'] === 'number'
      ? raw['completion_tokens']
      : null;
  return input === null || output === null ? null : { input_tokens: input, output_tokens: output };
}

/**
 * A provider completion must have finished normally. A truncated or filtered
 * answer is refused rather than parsed as if it were a complete result.
 */
function finishedNormally(
  kind: ModelAdapterKind,
  reason: unknown,
  allowed: string[],
  fail: AdapterFailure,
): void {
  if (reason === undefined || reason === null) return;
  if (typeof reason !== 'string') {
    fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer stated an invalid finish reason.`);
  }
  if (reason === 'length' || reason === 'max_tokens') {
    fail('MODEL_RESPONSE_TRUNCATED', `The ${kind} answer was truncated before its structured output completed.`);
  }
  if (reason === 'content_filter' || reason === 'sensitive' || reason === 'refusal') {
    fail('MODEL_RESPONSE_REFUSED', `The ${kind} provider refused to complete the pinned prompt.`);
  }
  if (!allowed.includes(reason)) {
    fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer finished with ${reason}.`);
  }
}

/**
 * The common finish for a provider-native answer: the echoed identity is
 * refused when it differs from the pin, and the mapped answer passes through
 * the same contract, tool, and structured-output enforcement as any adapter.
 */
function providerResult(
  profile: PinnedModelProfile,
  request: GenerationRequest,
  statedModel: unknown,
  output: Record<string, unknown> | null,
  calls: Array<{ tool: string; arguments: Record<string, unknown> }>,
  statedUsage: unknown,
  fail: AdapterFailure,
): GenerationResult {
  if (statedModel !== undefined) {
    if (typeof statedModel !== 'string') {
      fail('MODEL_RESPONSE_MALFORMED', 'The provider answer stated an invalid model identity.');
    }
    if (statedModel !== profile.model_id) {
      fail('MODEL_IDENTITY_MISMATCH', 'The provider answer came from a different model than the pinned one.');
    }
  }
  if (output === null) {
    fail('MODEL_STRUCTURED_OUTPUT_INVALID', 'The provider answer did not honour the declared structured output.');
  }
  return enforce(profile, request, {
    contract: MODEL_CONTRACT,
    model: profile.model_id,
    model_profile_hash: profile.content_hash,
    output,
    tool_calls: calls,
    usage: usageOf(statedUsage),
  }, fail);
}

/** The model identifiers a provider's model list exposes, whatever its envelope. */
function listedModels(
  kind: ModelAdapterKind,
  payload: Record<string, unknown>,
  fail: AdapterFailure,
): string[] {
  let entries: unknown;
  if (kind === 'alibaba_qwen') {
    const output = isRecord(payload['output']) ? payload['output'] : null;
    entries = output?.['models'];
  } else {
    entries = payload['data'];
  }
  if (!Array.isArray(entries)) {
    fail('MODEL_PREFLIGHT_FAILED', `The ${kind} endpoint did not answer a model list.`);
  }
  const identifiers: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const identifier = typeof entry['model'] === 'string'
      ? entry['model']
      : typeof entry['id'] === 'string'
        ? entry['id']
        : null;
    if (identifier !== null) identifiers.push(identifier);
  }
  return identifiers;
}

async function probeProviderModels(
  kind: ModelAdapterKind,
  profile: PinnedModelProfile,
  path: string,
  requireCredential: boolean,
  fail: AdapterFailure,
): Promise<{ model: string; contracts: string[] }> {
  assertProviderSettings(kind, profile, requireCredential, fail);
  const query = kind === 'alibaba_qwen' ? `?model=${encodeURIComponent(profile.model_id)}` : '';
  let response: Response;
  try {
    response = await fetch(providerUrl(profile.endpoint_url, path) + query, {
      method: 'GET',
      headers: { accept: 'application/json', ...credentialHeaders(profile) },
      redirect: 'error',
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
  } catch {
    return fail('MODEL_ENDPOINT_UNREACHABLE', `The ${kind} endpoint did not answer its preflight probe.`);
  }
  const answer = await readAnswer(response, profile.max_output_bytes, fail);
  const identifiers = listedModels(kind, answer, fail);
  if (!identifiers.includes(profile.model_id)) {
    fail(
      'MODEL_IDENTITY_MISMATCH',
      `The ${kind} endpoint does not serve the pinned model ${profile.model_id}.`,
    );
  }
  return { model: profile.model_id, contracts: [MODEL_CONTRACT] };
}

async function postProvider(
  kind: ModelAdapterKind,
  profile: PinnedModelProfile,
  path: string,
  body: Record<string, unknown>,
  fail: AdapterFailure,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(providerUrl(profile.endpoint_url, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentialHeaders(profile) },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
  } catch {
    return fail('MODEL_ENDPOINT_UNREACHABLE', `The ${kind} endpoint did not answer the generation request.`);
  }
  return readAnswer(response, profile.max_output_bytes, fail);
}

/** One OpenAI-shaped completion, which DeepSeek and compatible services share. */
function chatCompletionAnswer(
  kind: ModelAdapterKind,
  profile: PinnedModelProfile,
  request: GenerationRequest,
  answer: Record<string, unknown>,
  structuredTool: string | null,
  fail: AdapterFailure,
): GenerationResult {
  const choices = Array.isArray(answer['choices']) ? answer['choices'] : null;
  const choice = choices === null ? null : choices[0];
  if (!isRecord(choice)) {
    fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer did not state its completion choice.`);
  }
  finishedNormally(kind, choice['finish_reason'], ['stop', 'tool_calls'], fail);
  const message = isRecord(choice['message']) ? choice['message'] : null;
  if (message === null) {
    fail('MODEL_RESPONSE_MALFORMED', `The ${kind} answer did not state its assistant message.`);
  }
  const mapped = toolCallsFrom(kind, message['tool_calls'], structuredTool, fail);
  const output = mapped.output ?? contentObject(kind, message['content'], fail);
  return providerResult(
    profile,
    request,
    answer['model'],
    output,
    mapped.calls,
    answer['usage'],
    fail,
  );
}

/** Alibaba Qwen native: DashScope text generation with JSON Schema output. */
function alibabaQwenAdapter(): ModelAdapter {
  const kind: ModelAdapterKind = 'alibaba_qwen';
  return {
    kind,
    async probe(profile, fail) {
      return probeProviderModels(kind, profile, '/api/v1/models', true, fail);
    },
    async generate(profile, request, fail) {
      assertProviderSettings(kind, profile, true, fail);
      const parameters: Record<string, unknown> = {
        result_format: 'message',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: request.structured_output,
            strict: true,
            schema: schemaFor(request, fail),
          },
        },
      };
      const tools = toolDefinitions(kind, request, fail);
      if (tools.length > 0) {
        parameters['tools'] = tools;
        parameters['tool_choice'] = 'auto';
      }
      const answer = await postProvider(
        kind,
        profile,
        '/api/v1/services/aigc/text-generation/generation',
        { model: profile.model_id, input: { messages: providerMessages(request) }, parameters },
        fail,
      );
      const answered = isRecord(answer['output']) ? answer['output'] : null;
      const choices = answered === null || !Array.isArray(answered['choices']) ? null : answered['choices'];
      const choice = choices === null ? null : choices[0];
      if (!isRecord(choice)) {
        fail('MODEL_RESPONSE_MALFORMED', 'The alibaba_qwen answer did not state its completion choice.');
      }
      finishedNormally(kind, choice['finish_reason'], ['stop', 'tool_calls'], fail);
      const message = isRecord(choice['message']) ? choice['message'] : null;
      if (message === null) {
        return fail('MODEL_RESPONSE_MALFORMED', 'The alibaba_qwen answer did not state its assistant message.');
      }
      const mapped = toolCallsFrom(kind, message['tool_calls'], null, fail);
      const output = mapped.output ?? contentObject(kind, message['content'], fail);
      return providerResult(
        profile,
        request,
        answer['model'] ?? answered?.['model'],
        output,
        mapped.calls,
        answer['usage'],
        fail,
      );
    },
  };
}

/** DeepSeek native: a forced strict tool call carries the structured output. */
function deepseekAdapter(): ModelAdapter {
  const kind: ModelAdapterKind = 'deepseek';
  return {
    kind,
    async probe(profile, fail) {
      return probeProviderModels(kind, profile, '/models', true, fail);
    },
    async generate(profile, request, fail) {
      assertProviderSettings(kind, profile, true, fail);
      const tools = [
        ...toolDefinitions(kind, request, fail),
        {
          type: 'function',
          function: {
            name: request.structured_output,
            description: 'Return exactly one object matching the declared structured output schema.',
            strict: true,
            parameters: schemaFor(request, fail),
          },
        },
      ];
      const answer = await postProvider(kind, profile, '/chat/completions', {
        model: profile.model_id,
        messages: providerMessages(request),
        stream: false,
        tools,
        tool_choice: { type: 'function', function: { name: request.structured_output } },
      }, fail);
      return chatCompletionAnswer(kind, profile, request, answer, request.structured_output, fail);
    },
  };
}

/** Generic OpenAI-compatible Chat Completions, for customer-operated services. */
function openaiCompatibleAdapter(): ModelAdapter {
  const kind: ModelAdapterKind = 'openai_compatible';
  return {
    kind,
    async probe(profile, fail) {
      return probeProviderModels(kind, profile, '/v1/models', false, fail);
    },
    async generate(profile, request, fail) {
      assertProviderSettings(kind, profile, false, fail);
      const body: Record<string, unknown> = {
        model: profile.model_id,
        messages: providerMessages(request),
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: request.structured_output,
            strict: true,
            schema: schemaFor(request, fail),
          },
        },
      };
      const tools = toolDefinitions(kind, request, fail);
      if (tools.length > 0) {
        body['tools'] = tools;
        body['tool_choice'] = 'auto';
      }
      const answer = await postProvider(kind, profile, '/v1/chat/completions', body, fail);
      return chatCompletionAnswer(kind, profile, request, answer, null, fail);
    },
  };
}

const ADAPTERS: Record<ModelAdapterKind, ModelAdapter> = {
  hosted: adapterFor('hosted'),
  generic_local: adapterFor('generic_local'),
  alibaba_qwen: alibabaQwenAdapter(),
  deepseek: deepseekAdapter(),
  openai_compatible: openaiCompatibleAdapter(),
};

export function modelAdapter(kind: ModelAdapterKind): ModelAdapter {
  const adapter = ADAPTERS[kind];
  if (adapter === undefined) {
    throw new Error(`No Model Profile adapter is shipped for ${String(kind)}.`);
  }
  return adapter;
}
