import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  findIntegrationConfiguration,
  latestIntegrationVersion,
  type CleaningRule,
  type CleaningRuleName,
  type DatasetFieldType,
  type DatasetSchemaField,
  type IntegrationConfigurationArtifact,
  type IntegrationConfigurationVersion,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import { DEPLOYMENT_CONTEXT_ARTIFACT, latestVersion, findContextArtifact, workspaceContextArtifact } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const FIELD_TYPES: DatasetFieldType[] = ['string', 'integer', 'number', 'date', 'timestamp'];
const CLEANING_RULES: CleaningRuleName[] = ['trim', 'uppercase', 'lowercase', 'default', 'require_non_empty'];
const FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function digest(value: unknown): string {
  return canonicalDigest(value);
}

/**
 * Reads the exact integration semantics a Source will be executed under:
 * stable identity, canonical schema, cleaning, and source-to-dataset mapping.
 */
function readConfiguration(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  path: string,
): { identity: string[]; schema: DatasetSchemaField[]; cleaning: CleaningRule[]; mapping: Record<string, string> } {
  const parsed: unknown = readJsonDocument(
    path,
    (code, message) => reject(session, actor, context, code, message),
    'INTEGRATION_CONFIGURATION_UNREADABLE',
    'The Integration Configuration file must contain valid JSON.',
  );
  if (!isRecord(parsed)) {
    reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'An Integration Configuration must be a JSON object.');
  }
  const schema = readSchema(session, actor, context, parsed['schema']);
  const fieldNames = schema.map((field) => field.name);
  const identity = readIdentity(session, actor, context, parsed['identity'], fieldNames);
  const cleaning = readCleaning(session, actor, context, parsed['cleaning'] ?? [], fieldNames);
  const mapping = readMapping(session, actor, context, parsed['mapping'], fieldNames);
  return { identity, schema, cleaning, mapping };
}

function readSchema(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
): DatasetSchemaField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'A Dataset Schema must declare at least one field.');
  }
  const schema: DatasetSchemaField[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) {
      reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'Each Dataset Schema field must be an object.');
    }
    const name = candidate['name'];
    const type = candidate['type'];
    if (typeof name !== 'string' || !FIELD_PATTERN.test(name)) {
      reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'Each Dataset Schema field name must be a lowercase identifier of up to 64 characters.');
    }
    if (!FIELD_TYPES.includes(type as DatasetFieldType)) {
      reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', `Each Dataset Schema field type must be one of: ${FIELD_TYPES.join(', ')}.`);
    }
    if (schema.some((field) => field.name === name)) {
      reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'Each Dataset Schema field name must appear once.');
    }
    schema.push({ name, type: type as DatasetFieldType });
  }
  return schema;
}

function readIdentity(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  fieldNames: string[],
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'Stable record identity must name at least one Dataset Schema field.');
  }
  const identity: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string' || !fieldNames.includes(candidate)) {
      reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'Stable record identity must name Dataset Schema fields.');
    }
    if (identity.includes(candidate)) {
      reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'Stable record identity must name each field once.');
    }
    identity.push(candidate);
  }
  return identity;
}

function readCleaning(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  fieldNames: string[],
): CleaningRule[] {
  if (!Array.isArray(raw)) {
    reject(session, actor, context, 'INTEGRATION_CLEANING_INVALID', 'Cleaning rules must be an array.');
  }
  const cleaning: CleaningRule[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) {
      reject(session, actor, context, 'INTEGRATION_CLEANING_INVALID', 'Each cleaning rule must be an object.');
    }
    const ruleName = candidate['rule'] as CleaningRuleName;
    const field = candidate['field'];
    if (!CLEANING_RULES.includes(ruleName)) {
      reject(session, actor, context, 'INTEGRATION_CLEANING_INVALID', `Each cleaning rule must be one of: ${CLEANING_RULES.join(', ')}.`);
    }
    if (typeof field !== 'string' || !fieldNames.includes(field)) {
      reject(session, actor, context, 'INTEGRATION_CLEANING_INVALID', 'Each cleaning rule must name a Dataset Schema field.');
    }
    if (ruleName === 'default') {
      const value = candidate['value'];
      if (typeof value !== 'string') {
        reject(session, actor, context, 'INTEGRATION_CLEANING_INVALID', 'A default cleaning rule must state the string value it applies.');
      }
      cleaning.push({ rule: ruleName, field, value });
      continue;
    }
    cleaning.push({ rule: ruleName, field });
  }
  return cleaning;
}

function readMapping(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  fieldNames: string[],
): Record<string, string> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    reject(session, actor, context, 'INTEGRATION_CONFIGURATION_INVALID', 'An Integration Configuration must map source columns to Dataset Schema fields.');
  }
  const mapping: Record<string, string> = {};
  const targets = new Set<string>();
  for (const [column, target] of Object.entries(raw)) {
    if (typeof target !== 'string' || !fieldNames.includes(target)) {
      reject(session, actor, context, 'INTEGRATION_MAPPING_INVALID', 'Every mapped target must be a declared Dataset Schema field.');
    }
    if (targets.has(target)) {
      reject(session, actor, context, 'INTEGRATION_MAPPING_INVALID', 'Two source columns cannot map to the same Dataset Schema field.');
    }
    targets.add(target);
    mapping[column] = target;
  }
  const missing = fieldNames.filter((name) => !targets.has(name));
  if (missing.length > 0) {
    reject(
      session,
      actor,
      context,
      'INTEGRATION_MAPPING_INCOMPLETE',
      `Every Dataset Schema field must be mapped; unmapped: ${missing.join(', ')}.`,
    );
  }
  return mapping;
}

/** The Business Context versions an Integration Configuration is pinned to. */
function currentPins(
  session: PlatformSession,
  workspaceId: string,
): { common_business_context_version: number; workspace_business_context_version: number } {
  const common = latestVersion(findContextArtifact(session.state, DEPLOYMENT_CONTEXT_ARTIFACT));
  const workspace = latestVersion(findContextArtifact(session.state, workspaceContextArtifact(workspaceId)));
  return {
    common_business_context_version: common?.version ?? 0,
    workspace_business_context_version: workspace?.version ?? 0,
  };
}

/**
 * Publishes one immutable Integration Configuration Version. Publishing states
 * the exact semantics without binding the Source to them; Adoption does that.
 */
export function publishIntegrationConfiguration(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  configPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'integration_configuration_publication', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  const configuration = readConfiguration(session, actorLabel(actor.user), scoped, options.configPath);

  let artifact = findIntegrationConfiguration(session.state.integration_configurations, source.source_id);
  if (!artifact) {
    artifact = {
      source_id: source.source_id,
      workspace_id: source.workspace_id,
      owner_user_id: source.owner_user_id,
      adopted_version: null,
      versions: [],
    };
    session.state.integration_configurations.push(artifact);
  }
  const version: IntegrationConfigurationVersion = {
    version: (latestIntegrationVersion(artifact)?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    identity_fields: configuration.identity,
    schema: configuration.schema,
    cleaning: configuration.cleaning,
    mapping: configuration.mapping,
    schema_hash: digest(configuration.schema),
    cleaning_hash: digest(configuration.cleaning),
    mapping_hash: digest(configuration.mapping),
    content_hash: digest({
      identity: configuration.identity,
      schema: configuration.schema,
      cleaning: configuration.cleaning,
      mapping: configuration.mapping,
    }),
    pins: currentPins(session, source.workspace_id),
  };
  artifact.versions.push(version);

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      integration_configuration_version: version.version,
      common_business_context_version: version.pins.common_business_context_version,
      workspace_business_context_version: version.pins.workspace_business_context_version,
    },
  });
  session.save();
  return view(artifact, version);
}

/** Binds the Source to one exact published version; later execution uses only that version. */
export function adoptIntegrationConfiguration(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'integration_configuration_adoption', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  const artifact = findIntegrationConfiguration(session.state.integration_configurations, source.source_id);
  const version = artifact?.versions.find((candidate) => candidate.version === options.version);
  if (!artifact || !version) {
    reject(session, actorLabel(actor.user), scoped, 'INTEGRATION_VERSION_NOT_FOUND', 'The requested Integration Configuration Version does not exist for this Source.');
  }
  const previous = artifact.adopted_version;
  artifact.adopted_version = version.version;
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    ...(previous === null ? {} : { detail: { previous_adopted_version: previous } }),
  });
  session.save();
  return {
    ...view(artifact, version),
    previous_adopted_version: previous,
  };
}

function view(
  artifact: IntegrationConfigurationArtifact,
  version: IntegrationConfigurationVersion,
): Record<string, unknown> {
  return {
    source_id: artifact.source_id,
    workspace_id: artifact.workspace_id,
    integration_configuration_version: version.version,
    content_hash: version.content_hash,
    schema_hash: version.schema_hash,
    cleaning_hash: version.cleaning_hash,
    mapping_hash: version.mapping_hash,
    pins: { ...version.pins },
    adopted_version: artifact.adopted_version,
  };
}
