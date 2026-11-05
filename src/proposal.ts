import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  DEFAULT_DOCUMENT_PARSE_LIMITS,
  findArtifactProposal,
  findIntegrationConfiguration,
  findModelBinding,
  findModelProfile,
  findModelProfileVersion,
  latestIntegrationVersion,
  type IntegrationProposalRecord,
  type ArtifactProposalRecord,
  type CleaningRule,
  type CleaningRuleName,
  type DatasetFieldType,
  type DatasetSchemaField,
  type IntegrationConfigurationVersion,
  type ModelProfileVersion,
  type ProposalCandidates,
  type ProposalDrift,
  type ProposalEvidence,
  type ProposalModelPin,
  type ProposalProvenance,
  type ProposalValidationRecord,
  type SourceRecord,
  type WorkspaceModelBindingRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import {
  adoptIntegrationVersion,
  appendIntegrationConfigurationVersion,
  type IntegrationConfigurationInput,
} from './integration.js';
import {
  applyIntegrationTable,
  rawTableOf,
  type FragmentTable,
  type IntegrationRules,
} from './datasets.js';
import { generateIntegrationCandidate } from './model-generation.js';
import { pinnedForBinding } from './model-profile.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const FIELD_TYPES: DatasetFieldType[] = ['string', 'integer', 'number', 'date', 'timestamp'];
const CLEANING_RULES: CleaningRuleName[] = ['trim', 'uppercase', 'lowercase', 'default', 'require_non_empty'];
const FIELD_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const REASON_MAXIMUM = 1000;

function digest(value: unknown): string {
  return canonicalDigest(value);
}

/**
 * Resolves the integration Proposal kind. A Data Product Proposal is a
 * different review unit, so this lifecycle never governs it by mistake.
 */
function findIntegrationProposal(
  proposals: ArtifactProposalRecord[],
  proposalId: string,
): IntegrationProposalRecord | undefined {
  const proposal = findArtifactProposal(proposals, proposalId);
  return proposal !== undefined && proposal.kind !== 'data_product' ? proposal : undefined;
}

/** The content address of every Proposal fact; a mismatch means tampering. */
function hashOf(proposal: {
  workspace_id: string;
  source_id: string;
  binding_id: string;
  base: IntegrationProposalRecord['base'];
  model: ProposalModelPin;
  evidence: ProposalEvidence;
  candidates: ProposalCandidates;
}): string {
  return digest({
    workspace_id: proposal.workspace_id,
    source_id: proposal.source_id,
    binding_id: proposal.binding_id,
    base: proposal.base,
    model: proposal.model,
    evidence: proposal.evidence,
    candidates: proposal.candidates,
  });
}

/** One field of the administrator-supplied data dictionary the model reads. */
interface DictionaryField {
  source_column: string;
  name: string;
  type: DatasetFieldType;
  description: string | null;
  identity: boolean;
  clean: CleaningRuleName[];
}

interface DataDictionary {
  dataset_name: string;
  fields: DictionaryField[];
}

function readDictionary(session: PlatformSession, actorName: string, context: ActionContext, path: string): DataDictionary {
  const fail: Fail = (code, message) => reject(session, actorName, context, code, message);
  const parsed: unknown = readJsonDocument(
    path,
    fail,
    'PROPOSAL_EVIDENCE_UNREADABLE',
    'The data dictionary must be a readable JSON document.',
  );
  if (!isRecord(parsed) || !Array.isArray(parsed['fields']) || parsed['fields'].length === 0) {
    fail('PROPOSAL_EVIDENCE_INVALID', 'A data dictionary must declare at least one field.');
  }
  const fields: DictionaryField[] = [];
  for (const candidate of parsed['fields']) {
    if (!isRecord(candidate)) {
      fail('PROPOSAL_EVIDENCE_INVALID', 'Each data dictionary field must be an object.');
    }
    const sourceColumn = candidate['source_column'];
    const name = candidate['name'];
    const type = candidate['type'];
    if (typeof sourceColumn !== 'string' || sourceColumn.trim().length === 0) {
      fail('PROPOSAL_EVIDENCE_INVALID', 'Each data dictionary field must name the source column it reads.');
    }
    if (typeof name !== 'string' || !FIELD_PATTERN.test(name)) {
      fail('PROPOSAL_EVIDENCE_INVALID', 'Each data dictionary field name must be a lowercase identifier of up to 64 characters.');
    }
    if (!FIELD_TYPES.includes(type as DatasetFieldType)) {
      fail('PROPOSAL_EVIDENCE_INVALID', `Each data dictionary field type must be one of: ${FIELD_TYPES.join(', ')}.`);
    }
    if (fields.some((field) => field.name === name)) {
      fail('PROPOSAL_EVIDENCE_INVALID', 'Each data dictionary field name must appear once.');
    }
    const clean = candidate['clean'] ?? [];
    if (!Array.isArray(clean) || clean.some((rule) => !CLEANING_RULES.includes(rule as CleaningRuleName))) {
      fail('PROPOSAL_EVIDENCE_INVALID', `Each cleaning hint must be one of: ${CLEANING_RULES.join(', ')}.`);
    }
    const description = candidate['description'];
    fields.push({
      source_column: sourceColumn,
      name,
      type: type as DatasetFieldType,
      description: typeof description === 'string' ? description : null,
      identity: candidate['identity'] === true,
      clean: clean as CleaningRuleName[],
    });
  }
  if (!fields.some((field) => field.identity)) {
    fail('PROPOSAL_EVIDENCE_INVALID', 'A data dictionary must name at least one identity field.');
  }
  return {
    dataset_name: typeof parsed['dataset_name'] === 'string' ? parsed['dataset_name'] : '',
    fields,
  };
}

/** The binding, its exact Model Profile Version, and that Version's activation. */
interface BoundModel {
  binding: WorkspaceModelBindingRecord;
  version: ModelProfileVersion;
  pin: ProposalModelPin;
}

function requireBinding(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  bindingId: string,
  workspaceId: string,
): BoundModel {
  const binding = findModelBinding(session.state.model_bindings, bindingId);
  if (!binding || binding.workspace_id !== workspaceId) {
    reject(session, actorName, context, 'PROPOSAL_BINDING_NOT_FOUND', 'The Workspace Model Binding is not available for this Source.');
  }
  if (binding.revoked_at !== null) {
    reject(session, actorName, context, 'PROPOSAL_BINDING_REVOKED', 'The Workspace Model Binding has been revoked.');
  }
  if (!binding.purposes.includes('integration_proposal')) {
    reject(session, actorName, context, 'PROPOSAL_PURPOSE_NOT_BOUND', 'The Workspace Model Binding does not permit integration Proposal generation.');
  }
  const profile = findModelProfile(session.state.model_profiles, binding.model_profile_id);
  const version = findModelProfileVersion(profile, binding.model_profile_version);
  if (!profile || !version || version.content_hash !== binding.model_profile_content_hash) {
    reject(session, actorName, context, 'PROPOSAL_MODEL_STALE', 'The Bound Model Profile Version is no longer the one the Binding pinned.');
  }
  if (profile.activated_version !== version.version) {
    reject(session, actorName, context, 'PROPOSAL_MODEL_NOT_ACTIVATED', 'The Bound Model Profile Version is no longer activated.');
  }
  const prompt = version.prompts.find((candidate) => candidate.id === 'integration_proposal');
  if (!prompt) {
    reject(session, actorName, context, 'PROPOSAL_PURPOSE_NOT_BOUND', 'The Model Profile Version pins no integration Proposal prompt.');
  }
  return {
    binding,
    version,
    pin: {
      model_profile_id: profile.model_profile_id,
      model_profile_version: version.version,
      model_profile_content_hash: version.content_hash,
      adapter: version.adapter,
      model_id: version.model_id,
      prompt_id: 'integration_proposal',
      prompt_hash: prompt.hash,
    },
  };
}

/** The Artifact Version a Proposal was generated against, and whether it moved. */
function baseOf(session: PlatformSession, sourceId: string): {
  base: IntegrationProposalRecord['base'];
  version: IntegrationConfigurationVersion | undefined;
} {
  const version = latestIntegrationVersion(
    findIntegrationConfiguration(session.state.integration_configurations, sourceId),
  );
  return {
    base: version === undefined
      ? { integration_configuration_version: null, integration_configuration_content_hash: null }
      : {
        integration_configuration_version: version.version,
        integration_configuration_content_hash: version.content_hash,
      },
    version,
  };
}

function assertFresh(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  proposal: IntegrationProposalRecord,
): void {
  const current = baseOf(session, proposal.source_id).base;
  if (
    current.integration_configuration_version !== proposal.base.integration_configuration_version
    || current.integration_configuration_content_hash !== proposal.base.integration_configuration_content_hash
  ) {
    reject(
      session,
      actorName,
      context,
      'PROPOSAL_BASE_STALE',
      'The Source Integration Configuration Version moved after this Proposal was generated.',
      'Generate a new Proposal against the current Artifact Version; a stale Proposal cannot be approved, published, or adopted.',
    );
  }
}

function assertIntact(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  proposal: IntegrationProposalRecord,
): void {
  if (proposal.proposal_hash !== hashOf(proposal)) {
    reject(session, actorName, context, 'PROPOSAL_TAMPERED', 'The Proposal record does not match its content address.');
  }
}

function statusOf(proposal: IntegrationProposalRecord): string {
  if (proposal.adoptions.length > 0) return 'adopted';
  if (proposal.publications.length > 0) return 'published';
  const decision = proposal.decisions[proposal.decisions.length - 1];
  if (decision?.outcome === 'rejected') return 'rejected';
  if (decision?.outcome === 'approved') return 'approved';
  return 'pending';
}

/** Why the candidate and a real table do not line up, stated as drift. */
function driftOf(
  base: IntegrationConfigurationVersion | undefined,
  candidate: IntegrationConfigurationInput,
  table: FragmentTable,
): ProposalDrift {
  const baseSchema = base?.schema ?? [];
  const baseCleaning = base?.cleaning ?? [];
  const baseMapping = base?.mapping ?? {};
  const signature = (rule: CleaningRule): string => `${rule.rule}:${rule.field}:${rule.value ?? ''}`;
  const candidateCleaning = new Set(candidate.cleaning.map(signature));
  const baseCleaningSignatures = new Set(baseCleaning.map(signature));
  const candidateColumns = Object.keys(candidate.mapping);
  const baseColumns = Object.keys(baseMapping);
  return {
    base_present: base !== undefined,
    schema: {
      added: candidate.schema.filter((field) => !baseSchema.some((other) => other.name === field.name)).map((field) => field.name),
      removed: baseSchema.filter((field) => !candidate.schema.some((other) => other.name === field.name)).map((field) => field.name),
      retyped: candidate.schema
        .map((field) => {
          const before = baseSchema.find((other) => other.name === field.name);
          return before !== undefined && before.type !== field.type
            ? { field: field.name, from: before.type, to: field.type }
            : null;
        })
        .filter((entry): entry is { field: string; from: DatasetFieldType; to: DatasetFieldType } => entry !== null),
    },
    cleaning: {
      added: [...candidateCleaning].filter((rule) => !baseCleaningSignatures.has(rule)),
      removed: [...baseCleaningSignatures].filter((rule) => !candidateCleaning.has(rule)),
    },
    mapping: {
      added: candidateColumns.filter((column) => baseMapping[column] === undefined),
      removed: baseColumns.filter((column) => candidate.mapping[column] === undefined),
      retargeted: candidateColumns
        .filter((column) => baseMapping[column] !== undefined && baseMapping[column] !== candidate.mapping[column])
        .map((column) => ({ column, from: String(baseMapping[column]), to: String(candidate.mapping[column]) })),
    },
    raw_columns: {
      unmapped: table.header.filter((column) => candidate.mapping[column] === undefined),
      missing: candidateColumns.filter((column) => !table.header.includes(column)),
    },
  };
}

function rulesOf(proposal: IntegrationProposalRecord): IntegrationRules {
  return {
    identity: proposal.candidates.integration_configuration.identity_fields,
    schema: proposal.candidates.schema.fields,
    cleaning: proposal.candidates.cleaning.rules,
    mapping: proposal.candidates.mapping.mapping,
    version: proposal.candidates.integration_configuration.version,
  };
}

function candidateOf(proposal: IntegrationProposalRecord): IntegrationConfigurationInput {
  return {
    identity: proposal.candidates.integration_configuration.identity_fields,
    schema: proposal.candidates.schema.fields,
    cleaning: proposal.candidates.cleaning.rules,
    mapping: proposal.candidates.mapping.mapping,
    // A generated candidate proposes no document envelope, so a document bundle
    // it is exercised against is read under the same defaults an Integration
    // Configuration that states none is read under.
    documentLimits: { ...DEFAULT_DOCUMENT_PARSE_LIMITS },
  };
}

/**
 * Generates one Artifact Proposal from a real data dictionary under one Bound
 * Model Profile Version. The candidate is validated by the same Integration
 * Configuration parser publication uses, and nothing is published or adopted.
 */
export async function generateProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  bindingId: string;
  evidencePath: string;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_generation', scope: 'workspace', target: options.sourceId };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const actorName = actorLabel(actor.user);

  const bound = requireBinding(session, actorName, scoped, options.bindingId, source.workspace_id);
  const dictionary = readDictionary(session, actorName, scoped, options.evidencePath);
  const pinned = pinnedForBinding(
    session,
    findModelProfile(session.state.model_profiles, bound.pin.model_profile_id)!,
    bound.version,
    bound.binding,
  );
  const candidate = await generateIntegrationCandidate(
    pinned,
    dictionary,
    (code, message) => reject(session, actorName, scoped, code, message),
  );

  const { base } = baseOf(session, source.source_id);
  const next = (base.integration_configuration_version ?? 0) + 1;
  const candidates: ProposalCandidates = {
    schema: { candidate_version: next, fields: candidate.schema, hash: digest(candidate.schema) },
    cleaning: { candidate_version: next, rules: candidate.cleaning, hash: digest(candidate.cleaning) },
    mapping: { candidate_version: next, mapping: candidate.mapping, hash: digest(candidate.mapping) },
    integration_configuration: {
      version: next,
      identity_fields: candidate.identity,
      schema_hash: digest(candidate.schema),
      cleaning_hash: digest(candidate.cleaning),
      mapping_hash: digest(candidate.mapping),
      content_hash: digest({
        identity: candidate.identity,
        schema: candidate.schema,
        cleaning: candidate.cleaning,
        mapping: candidate.mapping,
        // A generated candidate proposes no document envelope, so Approval
        // covers the defaults an Integration Configuration that states none is
        // read under, which is what Publication then writes.
        document_limits: { ...DEFAULT_DOCUMENT_PARSE_LIMITS },
      }),
    },
  };
  const evidence: ProposalEvidence = {
    data_dictionary_hash: digest(dictionary),
    data_dictionary_fields: dictionary.fields.map((field) => field.name),
    field_count: dictionary.fields.length,
  };
  const header = {
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    binding_id: bound.binding.binding_id,
    base,
    model: bound.pin,
    evidence,
    candidates,
  };
  const proposal: IntegrationProposalRecord = {
    proposal_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    created_at: new Date().toISOString(),
    created_by: actorName,
    created_by_user_id: actor.user.user_id,
    binding_id: bound.binding.binding_id,
    base,
    model: bound.pin,
    evidence,
    candidates,
    proposal_hash: hashOf(header),
    validations: [],
    previews: [],
    decisions: [],
    publications: [],
    adoptions: [],
  };
  session.state.artifact_proposals.push(proposal);

  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      proposal_hash: proposal.proposal_hash,
      model_profile_id: bound.pin.model_profile_id,
      model_profile_version: bound.pin.model_profile_version,
      prompt_hash: bound.pin.prompt_hash,
      data_dictionary_hash: evidence.data_dictionary_hash,
      candidate_content_hash: candidates.integration_configuration.content_hash,
      base_version: base.integration_configuration_version ?? 0,
    },
  });
  session.save();
  return viewProposal(proposal);
}

/**
 * Exercises the candidate against administrator-supplied validation fixtures.
 * Fixtures name their own header and rows, so a rejected record and a transformed
 * value are both visible before any real acquisition is read.
 */
export function validateProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  fixturesPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_validation', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  const fail: Fail = (code, message) => reject(session, actorName, scoped, code, message);

  const parsed: unknown = readJsonDocument(
    options.fixturesPath,
    fail,
    'PROPOSAL_FIXTURES_UNREADABLE',
    'The validation fixtures must be a readable JSON document.',
  );
  if (!isRecord(parsed) || !Array.isArray(parsed['fixtures']) || parsed['fixtures'].length === 0) {
    fail('PROPOSAL_FIXTURES_INVALID', 'Validation fixtures must declare at least one fixture.');
  }
  const baseVersion = baseOf(session, proposal.source_id).version;
  const fixtures = parsed['fixtures'].map((fixture: unknown) => {
    if (
      !isRecord(fixture)
      || typeof fixture['name'] !== 'string'
      || !Array.isArray(fixture['header'])
      || !Array.isArray(fixture['rows'])
    ) {
      fail('PROPOSAL_FIXTURES_INVALID', 'Each fixture must name a header and its rows.');
    }
    const header = fixture['header'].map(String);
    const rows = fixture['rows'].map((cells: unknown) => {
      if (!Array.isArray(cells)) {
        fail('PROPOSAL_FIXTURES_INVALID', 'Each fixture row must be an array of cells.');
      }
      return { row: 0, cells: cells.map(String) };
    }).map((row, index) => ({ ...row, row: index + 1 }));
    const table: FragmentTable = { header, rows };
    const outcome = applyIntegrationTable(rulesOf(proposal), table, `fixture:${fixture['name']}`);
    return {
      name: fixture['name'],
      header,
      record_count: outcome.records.length,
      transformed: outcome.transformations.length,
      rejected: outcome.rejections.length,
      transformations: outcome.transformations,
      rejections: outcome.rejections,
      drift: driftOf(baseVersion, candidateOf(proposal), table),
    };
  });
  const record: ProposalValidationRecord = {
    validated_at: new Date().toISOString(),
    validated_by: actorName,
    fixtures,
    evidence_hash: digest({ proposal_hash: proposal.proposal_hash, fixtures }),
  };
  proposal.validations.push(record);
  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      fixtures: fixtures.length,
      transformed: fixtures.reduce((total, fixture) => total + fixture.transformed, 0),
      rejected: fixtures.reduce((total, fixture) => total + fixture.rejected, 0),
      evidence_hash: record.evidence_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    validated_at: record.validated_at,
    fixtures,
    evidence_hash: record.evidence_hash,
  };
}

/**
 * Runs the candidate over one real Raw Acquisition and reports exactly what a
 * Release would change. No Dataset, Dataset Release, or canonical record is
 * written; only the counts, hashes, and drift are kept as evidence.
 */
export function previewProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  rawId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_preview', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = {
    ...context,
    workspace_id: proposal.workspace_id,
    target: `${proposal.proposal_id}:${options.rawId}`,
  };

  const raw = session.state.raw_acquisitions.find(
    (candidate) => candidate.raw_id === options.rawId && candidate.source_id === proposal.source_id,
  );
  if (!raw) {
    reject(session, actorName, scoped, 'PROPOSAL_PREVIEW_RAW_NOT_FOUND', 'The Raw Acquisition is not available for this Source.');
  }
  const rules = rulesOf(proposal);
  const table = rawTableOf(session, actor, scoped, { mapping: rules.mapping }, raw);
  const outcome = applyIntegrationTable(rules, table, raw.raw_id);
  const baseVersion = baseOf(session, proposal.source_id).version;
  const record = {
    previewed_at: new Date().toISOString(),
    previewed_by: actorName,
    raw_id: raw.raw_id,
    acquisition_run_id: raw.acquisition_run_id,
    record_count: outcome.records.length,
    transformed: outcome.transformations.length,
    rejected: outcome.rejections.length,
    records_hash: digest(outcome.records),
    transformations: outcome.transformations,
    rejections: outcome.rejections,
    drift: driftOf(baseVersion, candidateOf(proposal), table),
  };
  proposal.previews.push({ ...record, evidence_hash: digest({ proposal_hash: proposal.proposal_hash, ...record }) });
  const preview = proposal.previews[proposal.previews.length - 1]!;

  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      record_count: preview.record_count,
      transformed: preview.transformed,
      rejected: preview.rejected,
      records_hash: preview.records_hash,
      evidence_hash: preview.evidence_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    preview: {
      raw_id: preview.raw_id,
      record_count: preview.record_count,
      transformed: preview.transformed,
      rejected: preview.rejected,
      transformations: preview.transformations,
      rejections: preview.rejections,
      drift: preview.drift,
      evidence_hash: preview.evidence_hash,
    },
  };
}

/** Records one Workspace Administrator rejection of one exact Proposal. */
export function rejectProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  reason: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_rejection', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  const reason = options.reason.trim();
  if (reason.length === 0 || reason.length > REASON_MAXIMUM) {
    reject(session, actorName, scoped, 'PROPOSAL_REASON_INVALID', `A rejection reason must contain 1 to ${REASON_MAXIMUM} characters.`);
  }
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorName, scoped, 'PROPOSAL_ALREADY_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  proposal.decisions.push({
    decided_at: new Date().toISOString(),
    decided_by: actor.user.user_id,
    actor: actorName,
    outcome: 'rejected',
    reason,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: { decision: 'rejected', proposal_hash: proposal.proposal_hash },
  });
  session.save();
  return { proposal_id: proposal.proposal_id, status: statusOf(proposal), reason };
}

/**
 * Records the mandatory human Approval. A Proposal reaches Approval only with
 * validation and preview evidence, on a base that has not moved, under a Binding
 * that still pins the exact activated Model Profile Version.
 */
export function approveProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_approval', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };

  if (statusOf(proposal) !== 'pending') {
    reject(session, actorName, scoped, 'PROPOSAL_ALREADY_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  if (proposal.validations.length === 0) {
    reject(
      session,
      actorName,
      scoped,
      'PROPOSAL_VALIDATION_REQUIRED',
      'A Proposal cannot be approved without validation evidence.',
      'Run proposal validate against the validation fixtures first.',
    );
  }
  if (proposal.previews.length === 0) {
    reject(
      session,
      actorName,
      scoped,
      'PROPOSAL_PREVIEW_REQUIRED',
      'A Proposal cannot be approved without a preview of a real Raw Acquisition.',
      'Run proposal preview against a representative Raw Acquisition first.',
    );
  }
  assertFresh(session, actorName, scoped, proposal);
  const bound = requireBinding(session, actorName, scoped, proposal.binding_id, proposal.workspace_id);
  if (
    bound.pin.model_profile_version !== proposal.model.model_profile_version
    || bound.pin.model_profile_content_hash !== proposal.model.model_profile_content_hash
  ) {
    reject(session, actorName, scoped, 'PROPOSAL_MODEL_STALE', 'The Bound Model Profile Version moved after this Proposal was generated.');
  }

  proposal.decisions.push({
    decided_at: new Date().toISOString(),
    decided_by: actor.user.user_id,
    actor: actorName,
    outcome: 'approved',
    reason: null,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  const decision = proposal.decisions[proposal.decisions.length - 1]!;
  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      decision: 'approved',
      proposal_hash: proposal.proposal_hash,
      validation_hash: decision.provenance.validation_hash,
      preview_hash: decision.provenance.preview_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    decided_at: decision.decided_at,
    provenance: decision.provenance,
  };
}

/** Publishes the approved candidate as the next Integration Configuration Version. */
export function publishProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_publication', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };

  if (proposal.publications.length > 0) {
    reject(session, actorName, scoped, 'PROPOSAL_ALREADY_PUBLISHED', 'This Proposal has already been published.');
  }
  if (statusOf(proposal) !== 'approved') {
    reject(
      session,
      actorName,
      scoped,
      'PROPOSAL_NOT_APPROVED',
      'Only an approved Proposal can be published.',
      'A Workspace Administrator must approve the Proposal first.',
    );
  }
  assertFresh(session, actorName, scoped, proposal);
  const source = requireAdministeredSource(session, actor, scoped, proposal.source_id);
  const { version } = appendIntegrationConfigurationVersion(session, actor, source, candidateOf(proposal));
  if (version.content_hash !== proposal.candidates.integration_configuration.content_hash) {
    reject(session, actorName, scoped, 'PROPOSAL_TAMPERED', 'The published version does not match the approved candidate.');
  }
  proposal.publications.push({
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    actor: actorName,
    integration_configuration_version: version.version,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      integration_configuration_version: version.version,
      content_hash: version.content_hash,
      proposal_hash: proposal.proposal_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    integration_configuration_version: version.version,
    content_hash: version.content_hash,
  };
}

/** Adopts the published candidate, binding the Source to exactly that Version. */
export function adoptProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_adoption', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };

  if (proposal.adoptions.length > 0) {
    reject(session, actorName, scoped, 'PROPOSAL_ALREADY_ADOPTED', 'This Proposal has already been adopted.');
  }
  const publication = proposal.publications[proposal.publications.length - 1];
  if (!publication) {
    reject(
      session,
      actorName,
      scoped,
      'PROPOSAL_NOT_PUBLISHED',
      'Only a published Proposal can be adopted.',
      'Publish the approved Proposal first.',
    );
  }
  // Publication moved the base to the Version this Proposal published, so
  // freshness now means no later Version has appeared since.
  const latest = baseOf(session, proposal.source_id).base;
  if (latest.integration_configuration_version !== publication.integration_configuration_version) {
    reject(
      session,
      actorName,
      scoped,
      'PROPOSAL_BASE_STALE',
      'The Source Integration Configuration Version moved after this Proposal was published.',
      'Generate a new Proposal against the current Artifact Version; a stale Proposal cannot be adopted.',
    );
  }
  const source: SourceRecord = requireAdministeredSource(session, actor, scoped, proposal.source_id);
  const { version, previous } = adoptIntegrationVersion(
    session,
    actor,
    scoped,
    source,
    publication.integration_configuration_version,
  );
  if (version.content_hash !== proposal.candidates.integration_configuration.content_hash) {
    reject(session, actorName, scoped, 'PROPOSAL_TAMPERED', 'The adopted version does not match the approved candidate.');
  }
  proposal.adoptions.push({
    adopted_at: new Date().toISOString(),
    adopted_by: actor.user.user_id,
    actor: actorName,
    integration_configuration_version: version.version,
    previous_adopted_version: previous,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      integration_configuration_version: version.version,
      previous_adopted_version: previous ?? 0,
      proposal_hash: proposal.proposal_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    adopted_version: version.version,
    previous_adopted_version: previous,
  };
}

/** Reads one Proposal and its evidence without disclosing any provider setting. */
export function showProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'proposal_read', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = findIntegrationProposal(session.state.artifact_proposals, options.proposalId);
  if (!proposal) {
    reject(session, actorLabel(actor.user), context, 'PROPOSAL_NOT_FOUND', 'The requested Artifact Proposal does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, proposal.workspace_id);
  assertIntact(session, actorLabel(actor.user), { ...context, workspace_id: proposal.workspace_id }, proposal);
  session.audit({ ...context, workspace_id: proposal.workspace_id, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return viewProposal(proposal);
}

/** Resolves a pending Proposal the actor may change, refusing a tampered record. */
function requireWritableProposal(
  session: PlatformSession,
  actor: ReturnType<typeof resolveActor>,
  context: ActionContext,
  proposalId: string,
): IntegrationProposalRecord {
  const actorName = actorLabel(actor.user);
  const proposal = findIntegrationProposal(session.state.artifact_proposals, proposalId);
  if (!proposal) {
    reject(session, actorName, context, 'PROPOSAL_NOT_FOUND', 'The requested Artifact Proposal does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, proposal.workspace_id);
  assertIntact(session, actorName, { ...context, workspace_id: proposal.workspace_id }, proposal);
  return proposal;
}

/** The lineage every decision, publication, and adoption restates. */
function provenanceOf(proposal: IntegrationProposalRecord): ProposalProvenance {
  const validation = proposal.validations[proposal.validations.length - 1];
  const preview = proposal.previews[proposal.previews.length - 1];
  return {
    model_profile_id: proposal.model.model_profile_id,
    model_profile_version: proposal.model.model_profile_version,
    model_profile_content_hash: proposal.model.model_profile_content_hash,
    adapter: proposal.model.adapter,
    model_id: proposal.model.model_id,
    binding_id: proposal.binding_id,
    prompt_id: proposal.model.prompt_id,
    prompt_hash: proposal.model.prompt_hash,
    data_dictionary_hash: proposal.evidence.data_dictionary_hash,
    validation_hash: validation?.evidence_hash ?? '',
    preview_hash: preview?.evidence_hash ?? '',
    candidate_content_hash: proposal.candidates.integration_configuration.content_hash,
    proposal_hash: proposal.proposal_hash,
  };
}

function viewProposal(proposal: IntegrationProposalRecord): Record<string, unknown> {
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    workspace_id: proposal.workspace_id,
    source_id: proposal.source_id,
    binding_id: proposal.binding_id,
    created_at: proposal.created_at,
    created_by: proposal.created_by,
    base: { ...proposal.base },
    model: { ...proposal.model },
    evidence: { ...proposal.evidence },
    candidates: {
      schema: { candidate_version: proposal.candidates.schema.candidate_version, hash: proposal.candidates.schema.hash, fields: proposal.candidates.schema.fields.map((field) => ({ ...field })) },
      cleaning: { candidate_version: proposal.candidates.cleaning.candidate_version, hash: proposal.candidates.cleaning.hash, rules: proposal.candidates.cleaning.rules.map((rule) => ({ ...rule })) },
      mapping: { candidate_version: proposal.candidates.mapping.candidate_version, hash: proposal.candidates.mapping.hash, mapping: { ...proposal.candidates.mapping.mapping } },
      integration_configuration: { ...proposal.candidates.integration_configuration },
    },
    proposal_hash: proposal.proposal_hash,
    validations: proposal.validations.map((validation) => ({
      validated_at: validation.validated_at,
      validated_by: validation.validated_by,
      evidence_hash: validation.evidence_hash,
      fixtures: validation.fixtures.map((fixture) => ({
        name: fixture.name,
        record_count: fixture.record_count,
        transformed: fixture.transformed,
        rejected: fixture.rejected,
        drift: fixture.drift,
      })),
    })),
    previews: proposal.previews.map((preview) => ({
      raw_id: preview.raw_id,
      record_count: preview.record_count,
      transformed: preview.transformed,
      rejected: preview.rejected,
      evidence_hash: preview.evidence_hash,
      drift: preview.drift,
    })),
    decisions: proposal.decisions.map((decision) => ({
      decided_at: decision.decided_at,
      decided_by: decision.decided_by,
      outcome: decision.outcome,
      reason: decision.reason,
      evidence_hash: decision.evidence_hash,
      provenance: { ...decision.provenance },
    })),
    publications: proposal.publications.map((publication) => ({
      published_at: publication.published_at,
      published_by: publication.published_by,
      integration_configuration_version: publication.integration_configuration_version,
      evidence_hash: publication.evidence_hash,
      provenance: { ...publication.provenance },
    })),
    adoptions: proposal.adoptions.map((adoption) => ({
      adopted_at: adoption.adopted_at,
      adopted_by: adoption.adopted_by,
      integration_configuration_version: adoption.integration_configuration_version,
      previous_adopted_version: adoption.previous_adopted_version,
      evidence_hash: adoption.evidence_hash,
      provenance: { ...adoption.provenance },
    })),
  };
}
