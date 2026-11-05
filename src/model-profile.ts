import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireDeploymentAdministrator, type ActionContext } from './authz.js';
import {
  findModelProfile,
  findModelProfileVersion,
  type ModelAdapterKind,
  type ModelDataCategory,
  type ModelProfileArtifact,
  type ModelProfileCheck,
  type ModelProfileEvaluation,
  type ModelProfileVersion,
  type ModelPrompt,
  type ModelPurpose,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import { OperatorError, type Fail } from './errors.js';
import { decrypt, encryptSecret } from './keys.js';
import { MODEL_CONTRACT, modelAdapter, type PinnedModelProfile } from './model-adapter.js';
import {
  EVALUATION_INPUTS,
  MODEL_DATA_CATEGORIES,
  MODEL_PURPOSES,
  STRUCTURED_OUTPUT,
  generateForPurpose,
  isSimplifiedChinese,
  narrationFailure,
  promptHash,
  promptOf,
  promptPinsSimplifiedChinese,
  toolsFor,
} from './model-generation.js';
import { openPlatform, type PlatformSession } from './session.js';

const ADAPTERS: ModelAdapterKind[] = ['hosted', 'generic_local'];
const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_TOOLS = 32;
const MAX_OUTPUT_MINIMUM = 256;
const MAX_OUTPUT_MAXIMUM = 1_048_576;

function digest(value: unknown): string {
  return canonicalDigest(value);
}

function readName(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actor, context, 'MODEL_PROFILE_NAME_INVALID', 'A Model Profile name must contain 2 to 128 characters.');
  }
  return name;
}

function readAdapterKind(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): ModelAdapterKind {
  if (!ADAPTERS.includes(raw as ModelAdapterKind)) {
    reject(session, actor, context, 'MODEL_ADAPTER_UNSUPPORTED', `The Model Profile adapter must be one of: ${ADAPTERS.join(', ')}.`);
  }
  return raw as ModelAdapterKind;
}

function readEndpoint(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string {
  if (typeof raw !== 'string') {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'A Model Profile must state the endpoint URL it calls.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'The Model Profile endpoint must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'The Model Profile endpoint must use http or https.');
  }
  // The declared endpoint is the only address this Version may call, so a later
  // redirect or a different host never receives the stored credential.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}`;
}

function readModelId(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string {
  const modelId = typeof raw === 'string' ? raw.trim() : '';
  if (modelId.length === 0 || modelId.length > 200) {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'A Model Profile must state the model identifier its endpoint serves.');
  }
  return modelId;
}

export function readPurposes(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): ModelPurpose[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'A Model Profile must declare at least one supported generation purpose.');
  }
  const purposes: ModelPurpose[] = [];
  for (const candidate of raw) {
    if (!MODEL_PURPOSES.includes(candidate as ModelPurpose)) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', `Each generation purpose must be one of: ${MODEL_PURPOSES.join(', ')}.`);
    }
    if (purposes.includes(candidate as ModelPurpose)) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'Each generation purpose must appear once.');
    }
    purposes.push(candidate as ModelPurpose);
  }
  return purposes;
}

export function readDataCategories(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
): ModelDataCategory[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'A Model Profile must declare the data categories its endpoint may receive.');
  }
  const categories: ModelDataCategory[] = [];
  for (const candidate of raw) {
    if (!MODEL_DATA_CATEGORIES.includes(candidate as ModelDataCategory)) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', `Each data category must be one of: ${MODEL_DATA_CATEGORIES.join(', ')}.`);
    }
    if (categories.includes(candidate as ModelDataCategory)) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'Each data category must appear once.');
    }
    categories.push(candidate as ModelDataCategory);
  }
  return categories;
}

function readTools(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_TOOLS) {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', `A Model Profile must declare at most ${MAX_TOOLS} tools.`);
  }
  const tools: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string' || !TOOL_PATTERN.test(candidate)) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'Each declared tool must be a lowercase identifier.');
    }
    if (tools.includes(candidate)) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'Each declared tool must appear once.');
    }
    tools.push(candidate);
  }
  return tools;
}

function readMaxOutputBytes(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): number {
  if (
    !Number.isInteger(raw)
    || (raw as number) < MAX_OUTPUT_MINIMUM
    || (raw as number) > MAX_OUTPUT_MAXIMUM
  ) {
    reject(
      session,
      actor,
      context,
      'MODEL_PROFILE_CONFIGURATION_INVALID',
      `The output limit must be a whole number of bytes from ${MAX_OUTPUT_MINIMUM} to ${MAX_OUTPUT_MAXIMUM}.`,
    );
  }
  return raw as number;
}

function readPrompts(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  purposes: ModelPurpose[],
): ModelPrompt[] {
  if (!isRecord(raw)) {
    reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'A Model Profile must state one prompt for every declared purpose.');
  }
  const prompts: ModelPrompt[] = [];
  for (const purpose of purposes) {
    const body = raw[purpose];
    if (typeof body !== 'string' || body.trim().length === 0) {
      reject(session, actor, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', `The ${purpose} purpose needs its own pinned prompt.`);
    }
    // The prompt pins Simplified Chinese output; a Model Profile cannot opt out
    // of that and silently answer in another language instead.
    if (!promptPinsSimplifiedChinese(body)) {
      reject(
        session,
        actor,
        context,
        'MODEL_PROMPT_NOT_SIMPLIFIED_CHINESE',
        `The ${purpose} prompt must instruct the model to answer in Simplified Chinese.`,
      );
    }
    prompts.push({ id: purpose, body, hash: promptHash(purpose, body) });
  }
  return prompts;
}

function credentialOf(session: PlatformSession, version: ModelProfileVersion): string | null {
  if (version.credential === null) return null;
  return decrypt(session.dataKey, version.credential).toString('utf8');
}

/** The exact identity every generation call under this Version is pinned to. */
export function pinModelProfile(
  profile: ModelProfileArtifact,
  version: ModelProfileVersion,
  credential: string | null,
): PinnedModelProfile {
  return {
    model_profile_id: profile.model_profile_id,
    model_profile_version: version.version,
    content_hash: version.content_hash,
    adapter: version.adapter,
    endpoint_url: version.endpoint_url,
    model_id: version.model_id,
    credential,
    max_output_bytes: version.max_output_bytes,
    tools: [...version.tools],
    prompts: version.prompts.map((prompt) => ({ ...prompt })),
  };
}

/**
 * Resolves one Version into the exact pin its generation runs under. The
 * credential stays inside the pin and never reaches an audit or a view.
 */
export function pinnedFor(
  session: PlatformSession,
  profile: ModelProfileArtifact,
  version: ModelProfileVersion,
): PinnedModelProfile {
  return pinModelProfile(profile, version, credentialOf(session, version));
}

/**
 * Publishes one immutable Model Profile Version. Publishing states the endpoint,
 * contract, credential reference, and prompts; Activation is a later fact.
 */
export function publishModelProfile(options: {
  root: string;
  masterKey: string;
  token: string;
  name: string;
  configPath: string;
  credential?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_profile_publication',
    scope: 'deployment',
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const actorName = actorLabel(actor.user);
  const name = readName(session, actorName, context, options.name);

  const parsed: unknown = readJsonDocument(
    options.configPath,
    (code, message) => reject(session, actorName, context, code, message),
    'MODEL_PROFILE_CONFIGURATION_UNREADABLE',
    'The Model Profile configuration file must contain valid JSON.',
  );
  if (!isRecord(parsed)) {
    reject(session, actorName, context, 'MODEL_PROFILE_CONFIGURATION_INVALID', 'A Model Profile configuration must be a JSON object.');
  }
  const adapter = readAdapterKind(session, actorName, context, parsed['adapter']);
  const endpointUrl = readEndpoint(session, actorName, context, parsed['endpoint_url']);
  const modelId = readModelId(session, actorName, context, parsed['model_id']);
  const purposes = readPurposes(session, actorName, context, parsed['purposes']);
  const dataCategories = readDataCategories(session, actorName, context, parsed['data_categories']);
  const tools = readTools(session, actorName, context, parsed['tools'] ?? []);
  const maxOutputBytes = readMaxOutputBytes(session, actorName, context, parsed['max_output_bytes'] ?? 65_536);
  const prompts = readPrompts(session, actorName, context, parsed['prompts'], purposes);

  let profile = session.state.model_profiles.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!profile) {
    profile = {
      model_profile_id: randomUUID(),
      name,
      owner_user_id: actor.user.user_id,
      created_at: new Date().toISOString(),
      activated_version: null,
      activated_at: null,
      versions: [],
      evaluations: [],
    } satisfies ModelProfileArtifact;
    session.state.model_profiles.push(profile);
  }

  const content = {
    adapter,
    endpoint_url: endpointUrl,
    model_id: modelId,
    purposes,
    data_categories: dataCategories,
    tools,
    max_output_bytes: maxOutputBytes,
    prompts,
  };
  const version: ModelProfileVersion = {
    version: (profile.versions[profile.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    adapter,
    endpoint_url: endpointUrl,
    model_id: modelId,
    credential_ref: options.credential === undefined
      ? 'none'
      : `bearer:${digest(options.credential).slice(0, 16)}`,
    credential: options.credential === undefined ? null : encryptSecret(session.dataKey, options.credential),
    purposes,
    data_categories: dataCategories,
    tools,
    max_output_bytes: maxOutputBytes,
    prompts,
    content_hash: digest(content),
  };
  profile.versions.push(version);

  session.audit({
    ...context,
    target: profile.model_profile_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      model_profile_version: version.version,
      adapter,
      purposes: purposes.join(','),
      content_hash: version.content_hash,
    },
  });
  session.save();
  return {
    model_profile_id: profile.model_profile_id,
    name: profile.name,
    model_profile_version: version.version,
    adapter: version.adapter,
    model_id: version.model_id,
    purposes: [...version.purposes],
    data_categories: [...version.data_categories],
    tools: [...version.tools],
    max_output_bytes: version.max_output_bytes,
    prompts: version.prompts.map((prompt) => ({ ...prompt })),
    credential_ref: version.credential_ref,
    has_credential: version.credential !== null,
    content_hash: version.content_hash,
    activated_version: profile.activated_version,
    published_at: version.published_at,
  };
}

/**
 * Runs the activation evaluation: preflight, pinned identity, structured output,
 * constrained tools, the Chinese prompt, grounded Chinese narration, and Chinese
 * clarification. The evidence is recorded whether it passes or fails, so an
 * incompatible endpoint can never be activated by omission.
 */
export async function evaluateModelProfile(options: {
  root: string;
  masterKey: string;
  token: string;
  profileId: string;
  version: number;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_profile_evaluation',
    scope: 'deployment',
    target: options.profileId,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const profile = findModelProfile(session.state.model_profiles, options.profileId);
  if (!profile) {
    reject(session, actorLabel(actor.user), context, 'MODEL_PROFILE_NOT_FOUND', 'The requested Model Profile does not exist.');
  }
  const version = findModelProfileVersion(profile, options.version);
  if (!version) {
    reject(session, actorLabel(actor.user), context, 'MODEL_PROFILE_VERSION_NOT_FOUND', 'The requested Model Profile Version does not exist.');
  }
  const pinned = pinnedFor(session, profile, version);
  // Evaluation evidence is captured, not thrown away: a failed check is a
  // recorded fact and the command still reports it.
  const failure: Fail = (code, message) => {
    throw new OperatorError(code, message);
  };
  const checks: ModelProfileCheck[] = [];
  const record = async (name: string, run: () => Promise<string>): Promise<void> => {
    try {
      checks.push({ name, passed: true, detail: await run() });
    } catch (error) {
      if (!(error instanceof OperatorError)) throw error;
      checks.push({ name, passed: false, detail: error.code });
    }
  };

  await record('preflight', async () => {
    const probe = await modelAdapter(version.adapter).probe(pinned, failure);
    return `${probe.model}:${MODEL_CONTRACT}`;
  });
  // A Version may declare one purpose or all of them, so every gate is judged
  // against the purposes it actually declares.
  const first = version.purposes[0]!;
  await record('pinned_identity', async () => {
    const answer = await generateForPurpose(pinned, first, EVALUATION_INPUTS[first], failure);
    return `${answer.identity.model}@${answer.identity.profile_hash.slice(0, 12)}`;
  });
  if (version.purposes.includes('integration_proposal')) {
    await record('structured_output', async () => {
      const answer = await generateForPurpose(pinned, 'integration_proposal', EVALUATION_INPUTS.integration_proposal, failure);
      const schema = answer.output['schema'];
      if (!Array.isArray(schema) || schema.length === 0) {
        throw new OperatorError('MODEL_STRUCTURED_OUTPUT_INVALID', 'The answer did not honour the declared structured output.');
      }
      return STRUCTURED_OUTPUT.integration_proposal;
    });
  }
  if (version.purposes.includes('data_product_proposal')) {
    await record('structured_output:data_product_proposal', async () => {
      const answer = await generateForPurpose(pinned, 'data_product_proposal', EVALUATION_INPUTS.data_product_proposal, failure);
      const fields = answer.output['fields'];
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new OperatorError('MODEL_STRUCTURED_OUTPUT_INVALID', 'The answer did not honour the declared structured output.');
      }
      return STRUCTURED_OUTPUT.data_product_proposal;
    });
  }
  await record('constrained_tools', async () => {
    // The request exposes only the tools its purpose declares, so any tool call
    // in the answer is the endpoint reaching outside what it was given.
    const answer = await modelAdapter(version.adapter).generate(pinned, {
      purpose: first,
      prompt: promptOf(pinned, first, failure),
      structured_output: STRUCTURED_OUTPUT[first],
      tools: toolsFor(pinned, first),
      input: EVALUATION_INPUTS[first],
    }, failure);
    if (answer.tool_calls.length > 0) {
      throw new OperatorError('MODEL_TOOL_NOT_PERMITTED', 'The answer named a tool the request did not expose.');
    }
    return toolsFor(pinned, first).length === 0 ? 'closed' : 'declared';
  });
  await record('simplified_chinese_prompt', async () => {
    const missing = version.prompts.filter((prompt) => !promptPinsSimplifiedChinese(prompt.body));
    if (missing.length > 0) {
      throw new OperatorError('MODEL_PROMPT_NOT_SIMPLIFIED_CHINESE', 'A pinned prompt does not require Simplified Chinese.');
    }
    return `${version.prompts.length} prompts`;
  });
  if (version.purposes.includes('grounded_narration')) {
    await record('grounded_narration', async () => {
      const answer = await generateForPurpose(pinned, 'grounded_narration', EVALUATION_INPUTS.grounded_narration, failure);
      const mismatch = narrationFailure(answer.output, EVALUATION_INPUTS.grounded_narration);
      if (mismatch !== null) {
        throw new OperatorError(mismatch, 'The narrative is not grounded in the supplied evidence.');
      }
      return 'grounded';
    });
    await record('simplified_chinese_narrative', async () => {
      const answer = await generateForPurpose(pinned, 'grounded_narration', EVALUATION_INPUTS.grounded_narration, failure);
      const narrative = String(answer.output['narrative'] ?? '');
      if (!isSimplifiedChinese(narrative)) {
        throw new OperatorError('NARRATION_NOT_SIMPLIFIED_CHINESE', 'The narrative is not grounded Simplified Chinese.');
      }
      return 'zh-CN';
    });
  }
  if (version.purposes.includes('clarification')) {
    await record('simplified_chinese_clarification', async () => {
      const answer = await generateForPurpose(pinned, 'clarification', EVALUATION_INPUTS.clarification, failure);
      const question = String(answer.output['question'] ?? '');
      if (!isSimplifiedChinese(question)) {
        throw new OperatorError('CLARIFICATION_NOT_SIMPLIFIED_CHINESE', 'The clarification is not Simplified Chinese.');
      }
      return 'zh-CN';
    });
  }

  const passed = checks.every((check) => check.passed);
  const evaluation: ModelProfileEvaluation = {
    model_profile_version: version.version,
    model_profile_content_hash: version.content_hash,
    evaluated_at: new Date().toISOString(),
    evaluated_by: actor.user.user_id,
    adapter: version.adapter,
    model_id: version.model_id,
    passed,
    checks,
    evidence_hash: digest({
      model_profile_version: version.version,
      model_profile_content_hash: version.content_hash,
      checks,
    }),
  };
  profile.evaluations.push(evaluation);

  session.audit({
    ...context,
    target: `${profile.model_profile_id}:${version.version}`,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      model_profile_version: version.version,
      evaluation_passed: passed,
      failed_checks: checks.filter((check) => !check.passed).map((check) => check.name).join(',') || 'none',
    },
  });
  session.save();
  return {
    model_profile_id: profile.model_profile_id,
    model_profile_version: version.version,
    content_hash: version.content_hash,
    passed,
    checks: checks.map((check) => ({ ...check })),
    evidence_hash: evaluation.evidence_hash,
    evaluated_at: evaluation.evaluated_at,
  };
}

/** Activates one exact Version only after its own evaluation passed. */
export function activateModelProfile(options: {
  root: string;
  masterKey: string;
  token: string;
  profileId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_profile_activation',
    scope: 'deployment',
    target: options.profileId,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const profile = findModelProfile(session.state.model_profiles, options.profileId);
  if (!profile) {
    reject(session, actorLabel(actor.user), context, 'MODEL_PROFILE_NOT_FOUND', 'The requested Model Profile does not exist.');
  }
  const version = findModelProfileVersion(profile, options.version);
  if (!version) {
    reject(session, actorLabel(actor.user), context, 'MODEL_PROFILE_VERSION_NOT_FOUND', 'The requested Model Profile Version does not exist.');
  }
  const evaluation = [...profile.evaluations].reverse().find(
    (candidate) => candidate.model_profile_version === version.version
      && candidate.model_profile_content_hash === version.content_hash,
  );
  if (!evaluation) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'MODEL_PROFILE_EVALUATION_REQUIRED',
      'The Model Profile Version has no activation evaluation evidence.',
      'Evaluate the exact Version before activating it.',
    );
  }
  if (!evaluation.passed) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'MODEL_PROFILE_EVALUATION_FAILED',
      'The Model Profile Version did not pass its activation evaluation.',
      'Point the Profile at an endpoint that answers grounded Simplified Chinese, then evaluate it again.',
    );
  }
  profile.activated_version = version.version;
  profile.activated_at = new Date().toISOString();
  session.audit({
    ...context,
    target: `${profile.model_profile_id}:${version.version}`,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      model_profile_version: version.version,
      evaluation_hash: evaluation.evidence_hash,
      content_hash: version.content_hash,
    },
  });
  session.save();
  return {
    model_profile_id: profile.model_profile_id,
    activated_version: profile.activated_version,
    activated_at: profile.activated_at,
    content_hash: version.content_hash,
    evaluation_hash: evaluation.evidence_hash,
  };
}

/** Reads one Model Profile without ever disclosing its endpoint or credential. */
export function showModelProfile(options: {
  root: string;
  masterKey: string;
  token: string;
  profileId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_profile_read',
    scope: 'deployment',
    target: options.profileId,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const profile = findModelProfile(session.state.model_profiles, options.profileId);
  if (!profile) {
    reject(session, actorLabel(actor.user), context, 'MODEL_PROFILE_NOT_FOUND', 'The requested Model Profile does not exist.');
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return {
    model_profile_id: profile.model_profile_id,
    name: profile.name,
    created_at: profile.created_at,
    activated_version: profile.activated_version,
    activated_at: profile.activated_at,
    versions: profile.versions.map((version) => ({
      model_profile_version: version.version,
      adapter: version.adapter,
      model_id: version.model_id,
      purposes: [...version.purposes],
      data_categories: [...version.data_categories],
      tools: [...version.tools],
      max_output_bytes: version.max_output_bytes,
      prompts: version.prompts.map((prompt) => ({ ...prompt })),
      credential_ref: version.credential_ref,
      has_credential: version.credential !== null,
      content_hash: version.content_hash,
      published_at: version.published_at,
      published_by: version.published_by,
    })),
    evaluations: profile.evaluations.map((evaluation) => ({
      ...evaluation,
      checks: evaluation.checks.map((check) => ({ ...check })),
    })),
  };
}
