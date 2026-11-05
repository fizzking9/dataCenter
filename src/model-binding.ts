import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  findModelBinding,
  findModelProfile,
  findModelProfileVersion,
  type ModelBindingPreflight,
  type ModelDataCategory,
  type ModelProfileArtifact,
  type ModelProfileCheck,
  type ModelProfileVersion,
  type ModelPurpose,
  type WorkspaceModelBindingRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import { OperatorError } from './errors.js';
import { modelAdapter } from './model-adapter.js';
import {
  EVALUATION_INPUTS,
  generateForPurpose,
  isSimplifiedChinese,
  narrationFailure,
  promptPinsSimplifiedChinese,
  queryPlanFailure,
} from './model-generation.js';
import { pinnedFor, readDataCategories, readPurposes } from './model-profile.js';
import { openPlatform, type PlatformSession } from './session.js';

function digest(value: unknown): string {
  return canonicalDigest(value);
}

/** The data categories a purpose's pinned input actually carries. */
const PURPOSE_CATEGORIES: Record<ModelPurpose, ModelDataCategory[]> = {
  integration_proposal: ['dataset_schema', 'cleaning_rules', 'source_mapping'],
  data_product_proposal: ['dataset_schema'],
  grounded_narration: ['sample_records'],
  clarification: [],
  query_plan: ['product_contract'],
};

function readVersion(
  session: PlatformSession,
  context: ActionContext,
  actorName: string,
  raw: unknown,
): number {
  if (!Number.isInteger(raw) || (raw as number) < 1) {
    reject(session, actorName, context, 'MODEL_BINDING_CONFIGURATION_INVALID', 'A Binding must name one whole Model Profile Version.');
  }
  return raw as number;
}

/**
 * Runs the preflight every Binding has to clear before it exists: the pinned
 * Version must answer, under its own identity, in grounded Simplified Chinese,
 * for every purpose the Binding permits. The evidence is recorded, never hidden.
 */
async function preflight(
  session: PlatformSession,
  profile: ModelProfileArtifact,
  version: ModelProfileVersion,
  purposes: ModelPurpose[],
): Promise<ModelBindingPreflight> {
  const pinned = pinnedFor(session, profile, version);
  const failure = (code: string, message: string): never => {
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
    const probe = await modelAdapter(pinned.adapter).probe(pinned, failure);
    return `${probe.model}:${probe.contracts.join(',')}`;
  });
  await record('pinned_identity', async () => {
    const first = purposes[0];
    if (first === undefined) {
      throw new OperatorError('MODEL_BINDING_PURPOSE_UNSUPPORTED', 'A Binding must permit at least one purpose.');
    }
    const answer = await generateForPurpose(pinned, first, EVALUATION_INPUTS[first], failure);
    return `${answer.identity.model}@${answer.identity.profile_hash.slice(0, 12)}`;
  });
  for (const purpose of purposes) {
    if (purpose === 'integration_proposal') {
      await record('structured_output', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        if (!Array.isArray(answer.output['schema']) || answer.output['schema'].length === 0) {
          throw new OperatorError('MODEL_STRUCTURED_OUTPUT_INVALID', 'The answer did not honour the declared structured output.');
        }
        return 'integration_configuration_candidate';
      });
    }
    if (purpose === 'data_product_proposal') {
      await record('structured_output', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        if (!Array.isArray(answer.output['fields']) || answer.output['fields'].length === 0) {
          throw new OperatorError('MODEL_STRUCTURED_OUTPUT_INVALID', 'The answer did not honour the declared structured output.');
        }
        return 'data_product_contract_candidate';
      });
    }
    if (purpose === 'grounded_narration') {
      await record('grounded_narration', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        const mismatch = narrationFailure(answer.output, EVALUATION_INPUTS[purpose]);
        if (mismatch !== null) {
          throw new OperatorError(mismatch, 'The narrative is not grounded in the supplied evidence.');
        }
        return 'grounded';
      });
      await record('simplified_chinese_narrative', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        if (!isSimplifiedChinese(String(answer.output['narrative'] ?? ''))) {
          throw new OperatorError('NARRATION_NOT_SIMPLIFIED_CHINESE', 'The narrative is not grounded Simplified Chinese.');
        }
        return 'zh-CN';
      });
    }
    if (purpose === 'query_plan') {
      await record('query_plan', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        const mismatch = queryPlanFailure(answer.output);
        if (mismatch !== null) {
          throw new OperatorError(mismatch, 'The plan is not a request in the published query vocabulary.');
        }
        return answer.output['action'] === 'clarify' ? 'clarify' : 'query';
      });
      await record('simplified_chinese_plan', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        if (!isSimplifiedChinese(String(answer.output['interpretation'] ?? ''))) {
          throw new OperatorError('QUERY_PLAN_NOT_SIMPLIFIED_CHINESE', 'The plan is not explained in Simplified Chinese.');
        }
        return 'zh-CN';
      });
    }
    if (purpose === 'clarification') {
      await record('simplified_chinese_clarification', async () => {
        const answer = await generateForPurpose(pinned, purpose, EVALUATION_INPUTS[purpose], failure);
        if (!isSimplifiedChinese(String(answer.output['question'] ?? ''))) {
          throw new OperatorError('CLARIFICATION_NOT_SIMPLIFIED_CHINESE', 'The clarification is not Simplified Chinese.');
        }
        return 'zh-CN';
      });
    }
  }

  const passed = checks.every((check) => check.passed);
  return {
    checked_at: new Date().toISOString(),
    passed,
    checks,
    evidence_hash: digest({
      model_profile_id: profile.model_profile_id,
      model_profile_version: version.version,
      model_profile_content_hash: version.content_hash,
      purposes,
      checks,
    }),
  };
}

/**
 * Creates a Workspace Model Binding: a reference enabling one exact activated
 * Model Profile Version for a permitted purpose and data-category set. It stores
 * no endpoint and no credential, so resolving it discloses provider settings to
 * nobody.
 */
export async function publishModelBinding(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  profileId: string;
  /** The browser posts its configuration; the CLI reads the same shape from a file. */
  configPath?: string;
  configuration?: unknown;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_binding_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.profileId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const actorName = actorLabel(actor.user);

  if (options.configuration === undefined && options.configPath === undefined) {
    reject(session, actorName, context, 'MODEL_BINDING_CONFIGURATION_UNREADABLE', 'A Binding needs its configuration.');
  }
  const parsed: unknown = options.configuration !== undefined
    ? options.configuration
    : readJsonDocument(
      options.configPath ?? '',
      (code, message) => reject(session, actorName, context, code, message),
      'MODEL_BINDING_CONFIGURATION_UNREADABLE',
      'The Workspace Model Binding configuration file must contain valid JSON.',
    );
  if (!isRecord(parsed)) {
    reject(session, actorName, context, 'MODEL_BINDING_CONFIGURATION_INVALID', 'A Binding configuration must be a JSON object.');
  }
  const requestedVersion = readVersion(session, context, actorName, parsed['model_profile_version']);
  const purposes = readPurposes(session, actorName, context, parsed['purposes']);
  const dataCategories = readDataCategories(session, actorName, context, parsed['data_categories']);

  const profile = findModelProfile(session.state.model_profiles, options.profileId);
  if (!profile) {
    reject(session, actorName, context, 'MODEL_PROFILE_NOT_FOUND', 'The requested Model Profile does not exist.');
  }
  const version = findModelProfileVersion(profile, requestedVersion);
  if (!version) {
    reject(session, actorName, context, 'MODEL_PROFILE_VERSION_NOT_FOUND', 'The requested Model Profile Version does not exist.');
  }
  if (profile.activated_version !== version.version) {
    reject(
      session,
      actorName,
      context,
      'MODEL_PROFILE_NOT_ACTIVATED',
      'A Binding can only reference the activated Model Profile Version.',
      'Activate the exact Version before binding it to a Workspace.',
    );
  }
  // A Binding narrows what the Profile permits; it can never widen it.
  const purposeOutside = purposes.filter((purpose) => !version.purposes.includes(purpose));
  if (purposeOutside.length > 0) {
    reject(
      session,
      actorName,
      context,
      'MODEL_BINDING_PURPOSE_NOT_PERMITTED',
      `The Model Profile Version does not permit: ${purposeOutside.join(', ')}.`,
    );
  }
  const categoryOutside = dataCategories.filter((category) => !version.data_categories.includes(category));
  if (categoryOutside.length > 0) {
    reject(
      session,
      actorName,
      context,
      'MODEL_BINDING_DATA_CATEGORY_NOT_PERMITTED',
      `The Model Profile Version does not permit the data categories: ${categoryOutside.join(', ')}.`,
    );
  }
  const uncarried = purposes.flatMap((purpose) => PURPOSE_CATEGORIES[purpose])
    .filter((category, index, all) => all.indexOf(category) === index)
    .filter((category) => !dataCategories.includes(category));
  if (uncarried.length > 0) {
    reject(
      session,
      actorName,
      context,
      'MODEL_BINDING_DATA_CATEGORY_INCOMPLETE',
      `The Binding must permit the data categories its purposes send: ${uncarried.join(', ')}.`,
    );
  }
  const unpinned = version.prompts.filter(
    (prompt) => purposes.includes(prompt.id) && !promptPinsSimplifiedChinese(prompt.body),
  );
  if (unpinned.length > 0) {
    reject(session, actorName, context, 'MODEL_PROMPT_NOT_SIMPLIFIED_CHINESE', 'A bound prompt does not require Simplified Chinese.');
  }

  const evidence = await preflight(session, profile, version, purposes);
  if (!evidence.passed) {
    reject(
      session,
      actorName,
      context,
      'MODEL_BINDING_PREFLIGHT_FAILED',
      `The Binding preflight failed: ${evidence.checks.filter((check) => !check.passed).map((check) => `${check.name}(${check.detail ?? 'unknown'})`).join(', ')}.`,
      'Point the Model Profile at an endpoint that answers grounded Simplified Chinese, then bind it again.',
    );
  }

  const binding: WorkspaceModelBindingRecord = {
    binding_id: randomUUID(),
    workspace_id: options.workspaceId,
    model_profile_id: profile.model_profile_id,
    model_profile_version: version.version,
    model_profile_content_hash: version.content_hash,
    purposes,
    data_categories: dataCategories,
    preflight: evidence,
    created_at: new Date().toISOString(),
    created_by: actorName,
    created_by_user_id: actor.user.user_id,
    revoked_at: null,
  };
  session.state.model_bindings.push(binding);

  session.audit({
    ...context,
    target: binding.binding_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      model_profile_id: binding.model_profile_id,
      model_profile_version: binding.model_profile_version,
      purposes: binding.purposes.join(','),
      preflight_hash: binding.preflight.evidence_hash,
    },
  });
  session.save();
  return viewBinding(binding);
}

/** Reads one Binding without disclosing its Model Profile's endpoint or credential. */
export function showModelBinding(options: {
  root: string;
  masterKey: string;
  token: string;
  bindingId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_binding_read',
    scope: 'workspace',
    target: options.bindingId,
  };
  const actor = resolveActor(session, options.token, context);
  const binding = findModelBinding(session.state.model_bindings, options.bindingId);
  if (!binding) {
    reject(session, actorLabel(actor.user), context, 'MODEL_BINDING_NOT_FOUND', 'The requested Workspace Model Binding does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, binding.workspace_id);
  session.audit({ ...context, workspace_id: binding.workspace_id, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return viewBinding(binding);
}

/**
 * The only shape a Binding ever leaves the platform as. It names the exact
 * Model Profile Version it pins, never where that Version runs or as whom.
 */
function viewBinding(binding: WorkspaceModelBindingRecord): Record<string, unknown> {
  return {
    binding_id: binding.binding_id,
    workspace_id: binding.workspace_id,
    model_profile_id: binding.model_profile_id,
    model_profile_version: binding.model_profile_version,
    model_profile_content_hash: binding.model_profile_content_hash,
    purposes: [...binding.purposes],
    data_categories: [...binding.data_categories],
    preflight: {
      checked_at: binding.preflight.checked_at,
      passed: binding.preflight.passed,
      // A check detail can name the model identity the probe answered as, so a
      // Binding discloses only whether each governed check passed.
      checks: binding.preflight.checks.map((check) => ({ name: check.name, passed: check.passed })),
      evidence_hash: binding.preflight.evidence_hash,
    },
    created_at: binding.created_at,
    created_by: binding.created_by,
    revoked_at: binding.revoked_at,
  };
}

/**
 * The Workspace Model Binding surface a Workspace Administrator reads: the
 * Workspace's own Bindings, plus the activated Profile Versions it may bind.
 * Neither carries an endpoint, a credential, or a provider model identity.
 */
export function showModelBindingWorkspace(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_binding_read',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);

  const bindings = session.state.model_bindings
    .filter((binding) => binding.workspace_id === options.workspaceId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((binding) => ({
      ...viewBinding(binding),
      model_profile_name: findModelProfile(session.state.model_profiles, binding.model_profile_id)?.name ?? null,
    }));

  const modelProfiles: Record<string, unknown>[] = [];
  for (const profile of session.state.model_profiles) {
    if (profile.activated_version === null) continue;
    const version = findModelProfileVersion(profile, profile.activated_version);
    if (version === undefined) continue;
    modelProfiles.push({
      model_profile_id: profile.model_profile_id,
      name: profile.name,
      model_profile_version: version.version,
      content_hash: version.content_hash,
      purposes: [...version.purposes],
      data_categories: [...version.data_categories],
    });
  }

  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return { workspace_id: options.workspaceId, bindings, model_profiles: modelProfiles };
}

/**
 * Revokes one Binding so later generation never resolves it again. Revocation
 * is idempotent: repeating it reports the Binding was already revoked.
 */
export function revokeModelBinding(options: {
  root: string;
  masterKey: string;
  token: string;
  bindingId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'model_binding_revocation',
    scope: 'workspace',
    target: options.bindingId,
  };
  const actor = resolveActor(session, options.token, context);
  const binding = findModelBinding(session.state.model_bindings, options.bindingId);
  if (!binding) {
    reject(session, actorLabel(actor.user), context, 'MODEL_BINDING_NOT_FOUND', 'The requested Workspace Model Binding does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, binding.workspace_id);
  const alreadyRevoked = binding.revoked_at !== null;
  if (!alreadyRevoked) binding.revoked_at = new Date().toISOString();
  session.audit({
    ...context,
    workspace_id: binding.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { already_revoked: alreadyRevoked },
  });
  session.save();
  return { ...viewBinding(binding), already_revoked: alreadyRevoked };
}
