import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext, type Actor } from './authz.js';
import {
  DEFAULT_DOCUMENT_PARSE_LIMITS,
  findIntegrationConfiguration,
  latestIntegrationVersion,
  type CleaningRule,
  type CleaningRuleName,
  type DatasetFieldType,
  type DatasetSchemaField,
  type DocumentParseLimits,
  type IntegrationConfigurationArtifact,
  type IntegrationConfigurationVersion,
  type SourceRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import type { Fail } from './errors.js';
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
export interface IntegrationConfigurationInput {
  identity: string[];
  schema: DatasetSchemaField[];
  cleaning: CleaningRule[];
  mapping: Record<string, string>;
  documentLimits: DocumentParseLimits;
}

/**
 * Validates one Integration Configuration document. Publication and a generated
 * Proposal share this parser, so a candidate never invents a second model.
 */
export function parseIntegrationConfiguration(
  parsed: unknown,
  fail: Fail,
): IntegrationConfigurationInput {
  if (!isRecord(parsed)) {
    fail('INTEGRATION_CONFIGURATION_INVALID', 'An Integration Configuration must be a JSON object.');
  }
  const schema = readSchema(parsed['schema'], fail);
  const fieldNames = schema.map((field) => field.name);
  const identity = readIdentity(parsed['identity'], fieldNames, fail);
  const cleaning = readCleaning(parsed['cleaning'] ?? [], fieldNames, fail);
  const mapping = readMapping(parsed['mapping'], fieldNames, fail);
  const documentLimits = readDocumentLimits(parsed['document_limits'], fail);
  return { identity, schema, cleaning, mapping, documentLimits };
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
): IntegrationConfigurationInput {
  const parsed: unknown = readJsonDocument(
    path,
    (code, message) => reject(session, actor, context, code, message),
    'INTEGRATION_CONFIGURATION_UNREADABLE',
    'The Integration Configuration file must contain valid JSON.',
  );
  return parseIntegrationConfiguration(parsed, (code, message) => reject(session, actor, context, code, message));
}

function readSchema(
  raw: unknown,
  fail: Fail,
): DatasetSchemaField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('INTEGRATION_CONFIGURATION_INVALID', 'A Dataset Schema must declare at least one field.');
  }
  const schema: DatasetSchemaField[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) {
      fail('INTEGRATION_CONFIGURATION_INVALID', 'Each Dataset Schema field must be an object.');
    }
    const name = candidate['name'];
    const type = candidate['type'];
    if (typeof name !== 'string' || !FIELD_PATTERN.test(name)) {
      fail('INTEGRATION_CONFIGURATION_INVALID', 'Each Dataset Schema field name must be a lowercase identifier of up to 64 characters.');
    }
    if (!FIELD_TYPES.includes(type as DatasetFieldType)) {
      fail('INTEGRATION_CONFIGURATION_INVALID', `Each Dataset Schema field type must be one of: ${FIELD_TYPES.join(', ')}.`);
    }
    if (schema.some((field) => field.name === name)) {
      fail('INTEGRATION_CONFIGURATION_INVALID', 'Each Dataset Schema field name must appear once.');
    }
    schema.push({ name, type: type as DatasetFieldType });
  }
  return schema;
}

function readIdentity(
  raw: unknown,
  fieldNames: string[],
  fail: Fail,
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('INTEGRATION_CONFIGURATION_INVALID', 'Stable record identity must name at least one Dataset Schema field.');
  }
  const identity: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string' || !fieldNames.includes(candidate)) {
      fail('INTEGRATION_CONFIGURATION_INVALID', 'Stable record identity must name Dataset Schema fields.');
    }
    if (identity.includes(candidate)) {
      fail('INTEGRATION_CONFIGURATION_INVALID', 'Stable record identity must name each field once.');
    }
    identity.push(candidate);
  }
  return identity;
}

function readCleaning(
  raw: unknown,
  fieldNames: string[],
  fail: Fail,
): CleaningRule[] {
  if (!Array.isArray(raw)) {
    fail('INTEGRATION_CLEANING_INVALID', 'Cleaning rules must be an array.');
  }
  const cleaning: CleaningRule[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) {
      fail('INTEGRATION_CLEANING_INVALID', 'Each cleaning rule must be an object.');
    }
    const ruleName = candidate['rule'] as CleaningRuleName;
    const field = candidate['field'];
    if (!CLEANING_RULES.includes(ruleName)) {
      fail('INTEGRATION_CLEANING_INVALID', `Each cleaning rule must be one of: ${CLEANING_RULES.join(', ')}.`);
    }
    if (typeof field !== 'string' || !fieldNames.includes(field)) {
      fail('INTEGRATION_CLEANING_INVALID', 'Each cleaning rule must name a Dataset Schema field.');
    }
    if (ruleName === 'default') {
      const value = candidate['value'];
      if (typeof value !== 'string') {
        fail('INTEGRATION_CLEANING_INVALID', 'A default cleaning rule must state the string value it applies.');
      }
      cleaning.push({ rule: ruleName, field, value });
      continue;
    }
    cleaning.push({ rule: ruleName, field });
  }
  return cleaning;
}

function readMapping(
  raw: unknown,
  fieldNames: string[],
  fail: Fail,
): Record<string, string> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    fail('INTEGRATION_CONFIGURATION_INVALID', 'An Integration Configuration must map source columns to Dataset Schema fields.');
  }
  const mapping: Record<string, string> = {};
  const targets = new Set<string>();
  for (const [column, target] of Object.entries(raw)) {
    if (typeof target !== 'string' || !fieldNames.includes(target)) {
      fail('INTEGRATION_MAPPING_INVALID', 'Every mapped target must be a declared Dataset Schema field.');
    }
    if (targets.has(target)) {
      fail('INTEGRATION_MAPPING_INVALID', 'Two source columns cannot map to the same Dataset Schema field.');
    }
    targets.add(target);
    mapping[column] = target;
  }
  const missing = fieldNames.filter((name) => !targets.has(name));
  if (missing.length > 0) {
    fail(
      'INTEGRATION_MAPPING_INCOMPLETE',
      `Every Dataset Schema field must be mapped; unmapped: ${missing.join(', ')}.`,
    );
  }
  return mapping;
}

/** The ceilings a Configuration may raise one document limit to. */
const DOCUMENT_LIMIT_CEILINGS: DocumentParseLimits = {
  max_bytes: 67_108_864,
  max_documents: 100_000,
  max_text_chars: 5_000_000,
  max_metadata_fields: 256,
  max_worker_ms: 60_000,
  max_heap_mb: 1_024,
};

/**
 * Reads the explicit resource envelope documents are parsed under. A limit is
 * never inferred from the file at hand: it is declared here, the Release pins
 * it, and a bundle that needs more fails closed rather than being read wider.
 */
function readDocumentLimits(raw: unknown, fail: Fail): DocumentParseLimits {
  if (raw === undefined) return { ...DEFAULT_DOCUMENT_PARSE_LIMITS };
  if (!isRecord(raw)) {
    fail('INTEGRATION_CONFIGURATION_INVALID', 'Document limits must be a JSON object.');
  }
  const unknown = Object.keys(raw).filter((key) => !(key in DEFAULT_DOCUMENT_PARSE_LIMITS));
  if (unknown.length > 0) {
    fail(
      'INTEGRATION_CONFIGURATION_INVALID',
      `Document limits must name only: ${Object.keys(DEFAULT_DOCUMENT_PARSE_LIMITS).join(', ')}. Unknown: ${unknown.join(', ')}.`,
    );
  }
  const limits = { ...DEFAULT_DOCUMENT_PARSE_LIMITS };
  for (const key of Object.keys(DEFAULT_DOCUMENT_PARSE_LIMITS) as Array<keyof DocumentParseLimits>) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > DOCUMENT_LIMIT_CEILINGS[key]) {
      fail(
        'INTEGRATION_CONFIGURATION_INVALID',
        `Document limit ${key} must be a whole number between 1 and ${DOCUMENT_LIMIT_CEILINGS[key]}.`,
      );
    }
    limits[key] = value as number;
  }
  return limits;
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
 * Appends one immutable Integration Configuration Version. Integration
 * Configuration publication and an approved Proposal's publication both write
 * here, so a Proposal never invents a second configuration model.
 */
export function appendIntegrationConfigurationVersion(
  session: PlatformSession,
  actor: Actor,
  source: SourceRecord,
  configuration: IntegrationConfigurationInput,
): { artifact: IntegrationConfigurationArtifact; version: IntegrationConfigurationVersion } {
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
    document_limits: configuration.documentLimits,
    schema_hash: digest(configuration.schema),
    cleaning_hash: digest(configuration.cleaning),
    mapping_hash: digest(configuration.mapping),
    content_hash: digest({
      identity: configuration.identity,
      schema: configuration.schema,
      cleaning: configuration.cleaning,
      mapping: configuration.mapping,
      document_limits: configuration.documentLimits,
    }),
    pins: currentPins(session, source.workspace_id),
  };
  artifact.versions.push(version);
  return { artifact, version };
}

/**
 * Binds the Source to one exact published Version. Integration Configuration
 * adoption and a Proposal's adoption both write here.
 */
export function adoptIntegrationVersion(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  source: SourceRecord,
  target: number,
): { artifact: IntegrationConfigurationArtifact; version: IntegrationConfigurationVersion; previous: number | null } {
  const artifact = findIntegrationConfiguration(session.state.integration_configurations, source.source_id);
  const version = artifact?.versions.find((candidate) => candidate.version === target);
  if (!artifact || !version) {
    reject(session, actorLabel(actor.user), context, 'INTEGRATION_VERSION_NOT_FOUND', 'The requested Integration Configuration Version does not exist for this Source.');
  }
  const previous = artifact.adopted_version;
  artifact.adopted_version = version.version;
  return { artifact, version, previous };
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

  const { artifact, version } = appendIntegrationConfigurationVersion(session, actor, source, configuration);

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

  const { artifact, version, previous } = adoptIntegrationVersion(session, actor, scoped, source, options.version);
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
