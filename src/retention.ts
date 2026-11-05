import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireAdministrator,
  requireDeploymentAdministrator,
  requireWorkspaceAdministrator,
  type ActionContext,
  type Actor,
} from './authz.js';
import {
  findDataProduct,
  findDataset,
  findReport,
  type ArtifactProposalRecord,
  type DataProductArtifact,
  type DatasetArtifact,
  type DatasetReleaseRecord,
  type ExportRecord,
  type OverridableRetentionClass,
  type PurgeEligibilityReason,
  type PurgeJobRecord,
  type PurgeLedgerEntry,
  type PurgePlanEntry,
  type PurgeRecordKind,
  type ReportRecord,
  type RetentionBounds,
  type RetentionDataClass,
  type RetentionHoldRecord,
  type RetentionPolicyArtifact,
  type RetentionPolicyVersion,
  type RetentionScope,
  type RetentionScopeKind,
  type RetentionTerm,
  type WorkspaceRetentionOverrideArtifact,
  type WorkspaceRetentionOverrideVersion,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { isDeploymentAdministrator, workspaceRoleOf, type PlatformState } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const DAY_MS = 86_400_000;
/** One failed deletion is retried after this many seconds, once per attempt. */
const PURGE_RETRY_SECONDS = 60;

export const RETENTION_DATA_CLASSES: RetentionDataClass[] = [
  'raw_acquisition',
  'dataset_release_history',
  'report',
  'artifact_version',
  'provenance',
  'audit_event',
  'proposal_evidence',
  'export',
  'derived_data',
];

const OVERRIDABLE_CLASSES: OverridableRetentionClass[] = ['raw_acquisition', 'dataset_release_history', 'report'];

/** The settled defaults of spec section 13, applied until a policy is published. */
export const SETTLED_RETENTION_DEFAULTS: Record<RetentionDataClass, RetentionTerm> = {
  raw_acquisition: { kind: 'days', days: 30 },
  dataset_release_history: { kind: 'days', days: 400 },
  report: { kind: 'days', days: 400 },
  artifact_version: { kind: 'indefinite' },
  provenance: { kind: 'indefinite' },
  audit_event: { kind: 'days', days: 400 },
  proposal_evidence: { kind: 'days', days: 90 },
  export: { kind: 'days', days: 7 },
  derived_data: { kind: 'no_guarantee' },
};

/** The envelope every Workspace override must stay inside. */
export const SETTLED_RETENTION_BOUNDS: Record<OverridableRetentionClass, RetentionBounds> = {
  raw_acquisition: { min_days: 1, max_days: 3650 },
  dataset_release_history: { min_days: 1, max_days: 3650 },
  report: { min_days: 1, max_days: 3650 },
};

export interface EffectiveRetention {
  policy_version: number;
  override_version: number | null;
  terms: Record<RetentionDataClass, RetentionTerm>;
  overrides: Partial<Record<OverridableRetentionClass, RetentionTerm>>;
  clamped: OverridableRetentionClass[];
}

function latestPolicy(state: PlatformState): RetentionPolicyVersion | undefined {
  const artifact = state.retention_policies.find((candidate) => candidate.artifact_id === 'retention-policy');
  return artifact?.versions[artifact.versions.length - 1];
}

function latestOverride(
  state: PlatformState,
  workspaceId: string,
): WorkspaceRetentionOverrideVersion | undefined {
  const artifact = state.retention_overrides.find((candidate) => candidate.workspace_id === workspaceId);
  return artifact?.versions[artifact.versions.length - 1];
}

export function termDays(term: RetentionTerm): number | null {
  return term.kind === 'days' ? term.days : null;
}

/** The term one class is actually judged by for one Workspace. */
export function effectiveTerm(
  state: PlatformState,
  workspaceId: string | null,
  dataClass: RetentionDataClass,
): RetentionTerm {
  const policy = latestPolicy(state);
  const defaults = policy?.defaults ?? SETTLED_RETENTION_DEFAULTS;
  const bounds = policy?.bounds ?? SETTLED_RETENTION_BOUNDS;
  let term = defaults[dataClass];
  if (workspaceId === null) return term;
  const override = latestOverride(state, workspaceId);
  if (override === undefined) return term;
  if (!(OVERRIDABLE_CLASSES as string[]).includes(dataClass)) return term;
  const overridden = override.terms[dataClass as OverridableRetentionClass];
  if (overridden === undefined) return term;
  if (overridden.kind !== 'days') return overridden;
  const envelope = bounds[dataClass as OverridableRetentionClass];
  return { kind: 'days', days: Math.min(Math.max(overridden.days, envelope.min_days), envelope.max_days) };
}

/** True when a record created at this instant is older than its class clock. */
export function isPastRetention(
  state: PlatformState,
  workspaceId: string | null,
  dataClass: RetentionDataClass,
  createdAt: string,
  now: Date,
): boolean {
  const term = effectiveTerm(state, workspaceId, dataClass);
  const days = termDays(term);
  if (days === null) return false;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && now.getTime() - created > days * DAY_MS;
}

export function effectiveRetention(state: PlatformState, workspaceId: string): EffectiveRetention {
  const policy = latestPolicy(state);
  const defaults = policy?.defaults ?? SETTLED_RETENTION_DEFAULTS;
  const bounds = policy?.bounds ?? SETTLED_RETENTION_BOUNDS;
  const override = latestOverride(state, workspaceId);
  const terms = { ...defaults };
  const overrides: Partial<Record<OverridableRetentionClass, RetentionTerm>> = {};
  const clamped: OverridableRetentionClass[] = [];
  if (override !== undefined) {
    for (const dataClass of OVERRIDABLE_CLASSES) {
      const overridden = override.terms[dataClass];
      if (overridden === undefined) continue;
      overrides[dataClass] = overridden;
      const envelope = bounds[dataClass];
      if (overridden.kind !== 'days') {
        terms[dataClass] = overridden;
        continue;
      }
      const days = Math.min(Math.max(overridden.days, envelope.min_days), envelope.max_days);
      if (days !== overridden.days) clamped.push(dataClass);
      terms[dataClass] = { kind: 'days', days };
    }
  }
  return {
    policy_version: policy?.version ?? 0,
    override_version: override?.version ?? null,
    terms,
    overrides,
    clamped,
  };
}

/** True when a record is named by the Purge Ledger or by a committed, running Purge. */
export function purgeRevoked(state: PlatformState, recordKind: PurgeRecordKind, recordId: string): boolean {
  for (const entry of state.purge_ledger) {
    if (entry.purged.some((record) => record.record_kind === recordKind && record.record_id === recordId)) {
      return true;
    }
  }
  for (const job of state.purge_jobs) {
    if (job.status === 'completed') continue;
    const planned = job.plan.some(
      (entry) => entry.record_kind === recordKind && entry.record_id === recordId && entry.eligible && entry.deferred !== true,
    );
    if (planned) return true;
  }
  return false;
}

export function retentionHealth(state: PlatformState): {
  health: 'healthy' | 'degraded';
  failed_purges: number;
  pending_purges: number;
} {
  const failed = state.purge_jobs.filter((job) => job.status === 'failed').length;
  const pending = state.purge_jobs.filter((job) => job.status === 'pending').length;
  return { health: failed > 0 ? 'degraded' : 'healthy', failed_purges: failed, pending_purges: pending };
}

/** The audit retention window, evaluated at one instant. Workspace overrides never govern audit. */
export function auditRetainedAfter(state: PlatformState, now: Date): number | null {
  const term = effectiveTerm(state, null, 'audit_event');
  const days = termDays(term);
  return days === null ? null : now.getTime() - days * DAY_MS;
}

// ---------------------------------------------------------------------------
// Policy publication and Workspace overrides.
// ---------------------------------------------------------------------------

function policyView(policy: RetentionPolicyVersion): Record<string, unknown> {
  return {
    policy_version: policy.version,
    published_at: policy.published_at,
    published_by: policy.published_by,
    defaults: deepCopy(policy.defaults),
    bounds: deepCopy(policy.bounds),
    content_hash: policy.content_hash,
  };
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseTerm(raw: unknown): RetentionTerm | null {
  if (raw === 'indefinite') return { kind: 'indefinite' };
  if (raw === 'no_guarantee') return { kind: 'no_guarantee' };
  if (!isRecord(raw)) return null;
  if (raw['indefinite'] === true || raw['kind'] === 'indefinite') return { kind: 'indefinite' };
  if (raw['no_guarantee'] === true || raw['kind'] === 'no_guarantee') return { kind: 'no_guarantee' };
  const days = raw['days'] ?? (raw['kind'] === 'days' ? raw['value'] : undefined);
  if (typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 36_500) {
    return { kind: 'days', days };
  }
  return null;
}

function validBounds(raw: unknown): RetentionBounds | null {
  if (!isRecord(raw)) return null;
  const min = raw['min_days'];
  const max = raw['max_days'];
  if (typeof min !== 'number' || typeof max !== 'number') return null;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max < min || max > 36_500) return null;
  return { min_days: min, max_days: max };
}

/**
 * The policy document a caller stated in memory, which is the same document the
 * CLI reads from a file. The governed module validates it identically.
 */
function statedConfig(
  options: { configPath?: string; config?: unknown },
  fail: Fail,
  label: string,
): unknown {
  if (options.config !== undefined) return options.config;
  if (options.configPath === undefined) {
    fail('RETENTION_CONFIG_UNREADABLE', `The ${label} must be stated as a JSON object.`);
  }
  return readJsonDocument(options.configPath, fail, 'RETENTION_CONFIG_UNREADABLE', `The ${label} file must contain valid JSON.`);
}

/** Publishes one immutable Deployment retention policy Version. */
export function publishRetentionPolicy(options: {
  root: string;
  masterKey: string;
  token: string;
  configPath?: string;
  config?: unknown;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'retention_policy_publish', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  const config = statedConfig(options, fail, 'retention policy');
  if (!isRecord(config)) fail('RETENTION_POLICY_INVALID', 'A retention policy must be a JSON object.');
  const current = latestPolicy(session.state);
  const defaults: Record<RetentionDataClass, RetentionTerm> = deepCopy(current?.defaults ?? SETTLED_RETENTION_DEFAULTS);
  const bounds: Record<OverridableRetentionClass, RetentionBounds> = deepCopy(current?.bounds ?? SETTLED_RETENTION_BOUNDS);

  const rawDefaults = config['defaults'] ?? {};
  if (!isRecord(rawDefaults)) fail('RETENTION_POLICY_INVALID', 'Policy defaults must be an object keyed by data class.');
  for (const [dataClass, value] of Object.entries(rawDefaults)) {
    if (!(RETENTION_DATA_CLASSES as string[]).includes(dataClass)) {
      fail('RETENTION_POLICY_INVALID', `Unknown retention data class: ${dataClass}.`);
    }
    const term = parseTerm(value);
    if (term === null) {
      fail('RETENTION_POLICY_INVALID', `The ${dataClass} term must be a whole number of days, indefinite, or no_guarantee.`);
    }
    defaults[dataClass as RetentionDataClass] = term;
  }
  const rawBounds = config['bounds'] ?? {};
  if (!isRecord(rawBounds)) fail('RETENTION_POLICY_INVALID', 'Policy bounds must be an object keyed by data class.');
  for (const [dataClass, value] of Object.entries(rawBounds)) {
    if (!(OVERRIDABLE_CLASSES as string[]).includes(dataClass)) {
      fail('RETENTION_POLICY_INVALID', `Bounds may be stated only for: ${OVERRIDABLE_CLASSES.join(', ')}.`);
    }
    const envelope = validBounds(value);
    if (envelope === null) {
      fail('RETENTION_POLICY_INVALID', `The ${dataClass} bounds must state min_days and max_days with 1 <= min_days <= max_days <= 36500.`);
    }
    bounds[dataClass as OverridableRetentionClass] = envelope;
  }

  // Settled semantics stay settled: Artifact versions and Provenance are
  // indefinite, derived data carries no guarantee, and the finite clocks must
  // fit the bounds a Workspace override is measured against.
  if (defaults.artifact_version.kind !== 'indefinite' || defaults.provenance.kind !== 'indefinite') {
    fail('RETENTION_POLICY_INVALID', 'Artifact versions and their Provenance are retained indefinitely.');
  }
  if (defaults.derived_data.kind !== 'no_guarantee') {
    fail('RETENTION_POLICY_INVALID', 'Caches and indexes carry no retention guarantee.');
  }
  for (const dataClass of OVERRIDABLE_CLASSES) {
    const term = defaults[dataClass];
    const envelope = bounds[dataClass];
    if (term.kind !== 'days' || term.days < envelope.min_days || term.days > envelope.max_days) {
      fail(
        'RETENTION_POLICY_INVALID',
        `The ${dataClass} default must be a number of days within its Deployment bounds.`,
      );
    }
  }
  const version = (current?.version ?? 0) + 1;
  const published: RetentionPolicyVersion = {
    version,
    published_at: new Date().toISOString(),
    published_by: actorLabel(actor.user),
    defaults,
    bounds,
    content_hash: canonicalDigest({ defaults, bounds }),
  };
  let artifact = session.state.retention_policies.find((candidate) => candidate.artifact_id === 'retention-policy');
  if (artifact === undefined) {
    artifact = { artifact_id: 'retention-policy', versions: [] };
    session.state.retention_policies.push(artifact);
  }
  artifact.versions.push(published);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { policy_version: version, content_hash: published.content_hash },
  });
  session.save();
  return {
    ...policyView(published),
    summary: `保留策略第 ${version} 版已发布，立即适用于既有数据和未来数据。`,
  };
}

/** Publishes one Workspace retention override within the Deployment bounds. */
export function publishRetentionOverride(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  configPath?: string;
  config?: unknown;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'retention_override_publish',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  const config = statedConfig(options, fail, 'retention override');
  if (!isRecord(config)) fail('RETENTION_POLICY_INVALID', 'A retention override must be a JSON object.');
  const policy = latestPolicy(session.state);
  const bounds = policy?.bounds ?? SETTLED_RETENTION_BOUNDS;
  const terms: Partial<Record<OverridableRetentionClass, RetentionTerm>> = {};
  for (const [dataClass, value] of Object.entries(config)) {
    if (!(OVERRIDABLE_CLASSES as string[]).includes(dataClass)) {
      fail(
        'RETENTION_POLICY_INVALID',
        `A Workspace may override only: ${OVERRIDABLE_CLASSES.join(', ')}.`,
      );
    }
    const term = parseTerm(value);
    if (term === null || term.kind !== 'days') {
      fail('RETENTION_POLICY_INVALID', `The ${dataClass} override must be a whole number of days.`);
    }
    const envelope = bounds[dataClass as OverridableRetentionClass];
    if (term.days < envelope.min_days || term.days > envelope.max_days) {
      fail(
        'RETENTION_POLICY_INVALID',
        `The ${dataClass} override must be between ${envelope.min_days} and ${envelope.max_days} days.`,
      );
    }
    terms[dataClass as OverridableRetentionClass] = term;
  }
  if (Object.keys(terms).length === 0) {
    fail('RETENTION_POLICY_INVALID', 'A retention override must state at least one data class.');
  }
  let artifact = session.state.retention_overrides.find((candidate) => candidate.workspace_id === options.workspaceId);
  if (artifact === undefined) {
    artifact = { workspace_id: options.workspaceId, versions: [] };
    session.state.retention_overrides.push(artifact);
  }
  const previous = artifact.versions[artifact.versions.length - 1];
  const version = (previous?.version ?? 0) + 1;
  const override: WorkspaceRetentionOverrideVersion = {
    version,
    policy_version: policy?.version ?? 0,
    terms,
    updated_at: new Date().toISOString(),
    updated_by: actorLabel(actor.user),
  };
  artifact.versions.push(override);
  const effective = effectiveRetention(session.state, options.workspaceId);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      override_version: version,
      policy_version: override.policy_version,
      raw_acquisition_days: terms.raw_acquisition?.kind === 'days' ? terms.raw_acquisition.days : 0,
      dataset_release_history_days: terms.dataset_release_history?.kind === 'days' ? terms.dataset_release_history.days : 0,
      report_days: terms.report?.kind === 'days' ? terms.report.days : 0,
    },
  });
  session.save();
  return {
    workspace_id: options.workspaceId,
    override_version: version,
    policy_version: override.policy_version,
    terms: deepCopy(terms),
    effective: deepCopy(effective.terms),
    clamped: [...effective.clamped],
    summary: `工作区保留覆盖第 ${version} 版已发布，未超出部署边界，立即生效。`,
  };
}

/** The version lineage an administrator reads beside the effective clocks. */
function policyHistory(policy: RetentionPolicyArtifact | undefined): Array<Record<string, unknown>> {
  return (policy?.versions ?? []).map((version) => ({
    version: version.version,
    published_at: version.published_at,
    published_by: version.published_by,
    content_hash: version.content_hash,
  }));
}

function overrideHistory(artifact: WorkspaceRetentionOverrideArtifact | undefined): Array<Record<string, unknown>> {
  return (artifact?.versions ?? []).map((version) => ({
    version: version.version,
    policy_version: version.policy_version,
    terms: deepCopy(version.terms),
    updated_at: version.updated_at,
    updated_by: version.updated_by,
  }));
}

function retentionPolicyArtifact(state: PlatformState): RetentionPolicyArtifact | undefined {
  return state.retention_policies.find((candidate) => candidate.artifact_id === 'retention-policy');
}

function retentionOverrideArtifact(
  state: PlatformState,
  workspaceId: string,
): WorkspaceRetentionOverrideArtifact | undefined {
  return state.retention_overrides.find((candidate) => candidate.workspace_id === workspaceId);
}

/** Shows the Deployment policy, or one Workspace's effective terms. */
export function showRetentionPolicy(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId?: string;
  version?: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'retention_policy_read',
    scope: options.workspaceId === undefined ? 'deployment' : 'workspace',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  if (options.workspaceId === undefined) {
    requireAdministrator(session, actor, context);
  } else {
    requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  }
  const policy = latestPolicy(session.state);
  const version = options.version ?? policy?.version ?? 0;
  if (version === 0) {
    if (options.workspaceId !== undefined) {
      const effective = effectiveRetention(session.state, options.workspaceId);
      session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
      return {
        workspace_id: options.workspaceId,
        policy_version: 0,
        override_version: effective.override_version,
        effective: deepCopy(effective.terms),
        overrides: deepCopy(effective.overrides),
        clamped: [...effective.clamped],
        policy_history: [],
        override_history: overrideHistory(retentionOverrideArtifact(session.state, options.workspaceId)),
        summary: '当前生效的是内置保留默认值，适用于既有数据和未来数据。',
      };
    }
    session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
    return {
      policy_version: 0,
      source: 'settled',
      defaults: deepCopy(SETTLED_RETENTION_DEFAULTS),
      bounds: deepCopy(SETTLED_RETENTION_BOUNDS),
      content_hash: null,
      history: [],
      summary: '当前生效的是内置保留默认值，适用于既有数据和未来数据。',
    };
  }
  const stored = session.state.retention_policies
    .find((candidate) => candidate.artifact_id === 'retention-policy')
    ?.versions.find((candidate) => candidate.version === version);
  if (stored === undefined) {
    reject(session, actorLabel(actor.user), context, 'RETENTION_POLICY_VERSION_NOT_FOUND', `Retention policy Version ${version} does not exist.`);
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  if (options.workspaceId !== undefined) {
    const effective = effectiveRetention(session.state, options.workspaceId);
    return {
      workspace_id: options.workspaceId,
      policy_version: stored.version,
      policy: policyView(stored),
      override_version: effective.override_version,
      effective: deepCopy(effective.terms),
      overrides: deepCopy(effective.overrides),
      clamped: [...effective.clamped],
      policy_history: policyHistory(retentionPolicyArtifact(session.state)),
      override_history: overrideHistory(retentionOverrideArtifact(session.state, options.workspaceId)),
      summary: `当前生效的保留策略为第 ${stored.version} 版，并叠加工作区覆盖。`,
    };
  }
  return {
    ...policyView(stored),
    source: 'published',
    history: policyHistory(retentionPolicyArtifact(session.state)),
    summary: `当前生效的保留策略为第 ${stored.version} 版，适用于既有数据和未来数据。`,
  };
}

// ---------------------------------------------------------------------------
// Holds: accountable, scoped exceptions that block every Purge.
// ---------------------------------------------------------------------------

export type RetentionOptions = {
  root: string;
  masterKey: string;
  token: string;
  workspaceId?: string;
  sourceId?: string;
  datasetId?: string;
  datasetRelease?: number;
  targetId?: string;
  at?: string;
};

function optionScopeKind(raw: string): RetentionScopeKind {
  const kinds: RetentionScopeKind[] = ['deployment', 'workspace', 'source', 'dataset', 'release', 'proposal_evidence', 'export'];
  if (!kinds.includes(raw as RetentionScopeKind)) {
    throw new Error(`--scope must be one of: ${kinds.join(', ')}.`);
  }
  return raw as RetentionScopeKind;
}

/** Resolves one scope from explicit identifiers, refusing identifiers that name nothing. */
function resolveScope(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  options: RetentionOptions,
  scopeKind: RetentionScopeKind,
): RetentionScope {
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  if (scopeKind === 'deployment') {
    requireDeploymentAdministrator(session, actor, context);
    return { kind: scopeKind, workspace_id: null, source_id: null, dataset_id: null, dataset_release: null, target_id: null };
  }
  if (scopeKind === 'workspace') {
    if (options.workspaceId === undefined) fail('RETENTION_SCOPE_INVALID', 'A workspace scope must name --workspace.');
    requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
    return { kind: scopeKind, workspace_id: options.workspaceId, source_id: null, dataset_id: null, dataset_release: null, target_id: null };
  }
  if (scopeKind === 'source') {
    if (options.sourceId === undefined) fail('RETENTION_SCOPE_INVALID', 'A source scope must name --source.');
    const source = session.state.sources.find((candidate) => candidate.source_id === options.sourceId);
    if (source === undefined) deny(session, actorLabel(actor.user), context, 'RETENTION_SCOPE_INVALID', 'The requested Source is not available to this actor.');
    requireWorkspaceAdministrator(session, actor, context, source.workspace_id);
    return {
      kind: scopeKind,
      workspace_id: source.workspace_id,
      source_id: source.source_id,
      dataset_id: null,
      dataset_release: null,
      target_id: null,
    };
  }
  if (scopeKind === 'dataset' || scopeKind === 'release') {
    if (options.datasetId === undefined) fail('RETENTION_SCOPE_INVALID', `A ${scopeKind} scope must name --dataset.`);
    const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === options.datasetId);
    if (dataset === undefined) deny(session, actorLabel(actor.user), context, 'RETENTION_SCOPE_INVALID', 'The requested Dataset is not available to this actor.');
    requireWorkspaceAdministrator(session, actor, context, dataset.workspace_id);
    if (scopeKind === 'dataset') {
      return {
        kind: scopeKind,
        workspace_id: dataset.workspace_id,
        source_id: dataset.source_id,
        dataset_id: dataset.dataset_id,
        dataset_release: null,
        target_id: null,
      };
    }
    if (options.datasetRelease === undefined || !Number.isInteger(options.datasetRelease)) {
      fail('RETENTION_SCOPE_INVALID', 'A release scope must name --release.');
    }
    if (!dataset.releases.some((candidate) => candidate.release === options.datasetRelease)
      && !purgeRevoked(session.state, 'dataset_release', `${dataset.dataset_id}#${options.datasetRelease}`)) {
      fail('RETENTION_SCOPE_INVALID', `The Dataset has no Release ${options.datasetRelease}.`);
    }
    return {
      kind: scopeKind,
      workspace_id: dataset.workspace_id,
      source_id: dataset.source_id,
      dataset_id: dataset.dataset_id,
      dataset_release: options.datasetRelease,
      target_id: null,
    };
  }
  if (scopeKind === 'proposal_evidence') {
    if (options.workspaceId === undefined) fail('RETENTION_SCOPE_INVALID', 'A proposal-evidence scope must name --workspace.');
    requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
    return {
      kind: scopeKind,
      workspace_id: options.workspaceId,
      source_id: null,
      dataset_id: null,
      dataset_release: null,
      target_id: options.targetId ?? null,
    };
  }
  if (scopeKind === 'export') {
    if (options.workspaceId === undefined && options.targetId === undefined) {
      fail('RETENTION_SCOPE_INVALID', 'An export scope must name --workspace or --export.');
    }
    const record = options.targetId === undefined
      ? undefined
      : session.state.exports.find((candidate) => candidate.export_id === options.targetId);
    const workspaceId = record?.workspace_id ?? options.workspaceId;
    if (workspaceId === undefined) fail('RETENTION_SCOPE_INVALID', 'An export scope must name --workspace or --export.');
    requireWorkspaceAdministrator(session, actor, context, workspaceId);
    return {
      kind: scopeKind,
      workspace_id: workspaceId,
      source_id: null,
      dataset_id: null,
      dataset_release: null,
      target_id: options.targetId ?? null,
    };
  }
  fail('RETENTION_SCOPE_INVALID', `Unsupported retention scope: ${scopeKind}.`);
}

function scopeView(scope: RetentionScope): Record<string, unknown> {
  return { ...scope };
}

function holdView(hold: RetentionHoldRecord): Record<string, unknown> {
  return {
    hold_id: hold.hold_id,
    scope: scopeView(hold.scope),
    reason: hold.reason,
    review_at: hold.review_at,
    created_at: hold.created_at,
    created_by: hold.created_by,
    released_at: hold.released_at,
    released_by: hold.released_by,
    active: hold.released_at === null,
    pins_restorable_backups: true,
  };
}

/** Places one accountable Retention Hold on an explicit scope. */
export function createRetentionHold(options: RetentionOptions & {
  scopeKind: string;
  reason: string;
  reviewAt: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'retention_hold_create', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const kind = optionScopeKind(options.scopeKind);
  const scope = resolveScope(session, actor, context, options, kind);
  const scoped: ActionContext = scope.workspace_id === null
    ? context
    : { ...context, scope: 'workspace', workspace_id: scope.workspace_id };
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  const reason = options.reason.trim();
  if (reason.length === 0 || reason.length > 1024) {
    fail('RETENTION_HOLD_INVALID', 'A Retention Hold must state a reason of 1 to 1024 characters.');
  }
  const reviewMs = Date.parse(options.reviewAt);
  if (!Number.isFinite(reviewMs)) {
    fail('RETENTION_HOLD_INVALID', 'A Retention Hold must state an ISO 8601 review date.');
  }
  const hold: RetentionHoldRecord = {
    hold_id: `hold-${canonicalDigest({ scope, reason, at: new Date().toISOString(), actor: actorLabel(actor.user) }).slice(0, 32)}`,
    scope,
    reason,
    review_at: new Date(reviewMs).toISOString(),
    created_at: new Date().toISOString(),
    created_by: actorLabel(actor.user),
    created_by_user_id: actor.user.user_id,
    released_at: null,
    released_by: null,
    released_by_user_id: null,
  };
  session.state.retention_holds.push(hold);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      hold_id: hold.hold_id,
      scope_kind: hold.scope.kind,
      reason: hold.reason,
      review_at: hold.review_at,
    },
  });
  session.save();
  return {
    ...holdView(hold),
    summary: '已创建保留暂停：该范围内的自动与手动清除在解除前一律阻止。',
  };
}

function canAdministerHold(session: PlatformSession, actor: Actor, hold: RetentionHoldRecord): boolean {
  if (isDeploymentAdministrator(actor.user)) return true;
  return hold.scope.workspace_id !== null
    && workspaceRoleOf(session.state, actor.user.user_id, hold.scope.workspace_id) === 'Workspace Administrator';
}

/** Lists the Holds the actor may administer, optionally scoped to one Workspace. */
export function listRetentionHolds(options: RetentionOptions): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'retention_hold_list',
    scope: options.workspaceId === undefined ? 'deployment' : 'workspace',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  if (options.workspaceId !== undefined) {
    requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  } else if (!isDeploymentAdministrator(actor.user)) {
    const administers = session.state.memberships.some(
      (membership) => membership.user_id === actor.user.user_id && membership.role === 'Workspace Administrator',
    );
    if (!administers) deny(session, actorLabel(actor.user), context, 'AUTHORIZATION_DENIED', 'Reading Retention Holds requires administrator authority.');
  }
  const holds = session.state.retention_holds
    .filter((hold) => options.workspaceId === undefined ? canAdministerHold(session, actor, hold) : hold.scope.workspace_id === options.workspaceId)
    .filter((hold) => canAdministerHold(session, actor, hold))
    .map((hold) => holdView(hold));
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { holds_returned: holds.length } });
  return {
    holds,
    summary: '已列出当前管理员范围内的保留暂停。',
  };
}

/** Releases one Retention Hold, recording the accountable release. */
export function releaseRetentionHold(options: RetentionOptions & { holdId: string }): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'retention_hold_release', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const hold = session.state.retention_holds.find((candidate) => candidate.hold_id === options.holdId);
  if (hold === undefined || !canAdministerHold(session, actor, hold)) {
    deny(session, actorLabel(actor.user), context, 'RETENTION_HOLD_NOT_FOUND', 'The Retention Hold is not available to this actor.');
  }
  if (hold.released_at !== null) {
    return {
      ...holdView(hold),
      already_released: true,
      summary: '该保留暂停此前已解除，治理历史保持不变。',
    };
  }
  hold.released_at = new Date().toISOString();
  hold.released_by = actorLabel(actor.user);
  hold.released_by_user_id = actor.user.user_id;
  const scoped: ActionContext = hold.scope.workspace_id === null
    ? context
    : { ...context, scope: 'workspace', workspace_id: hold.scope.workspace_id };
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { hold_id: hold.hold_id, released_at: hold.released_at },
  });
  session.save();
  return {
    ...holdView(hold),
    already_released: false,
    summary: '已解除保留暂停：该范围重新按保留策略参与自动与手动清除。',
  };
}

// ---------------------------------------------------------------------------
// Eligibility: every data class evaluated against policy, Holds, and dependencies.
// ---------------------------------------------------------------------------

interface PurgeCandidate {
  record_kind: PurgeRecordKind;
  record_id: string;
  data_class: RetentionDataClass;
  workspace_id: string;
  created_at: string;
  source_id: string | null;
  dataset_id: string | null;
  dataset_release: number | null;
  product_id: string | null;
  product_release: number | null;
  target_id: string | null;
  /** The Dataset Release is its Dataset's latest, or a current Product Release binds it. */
  current: boolean;
  terminal: boolean;
}

function reportCandidates(state: PlatformState, reports: ReportRecord[]): PurgeCandidate[] {
  return reports.map((report) => {
    const product = findDataProduct(state.data_products, report.data_product.data_product_id);
    const productRelease = product?.releases.find((candidate) => candidate.release === report.data_product.data_product_release);
    const dataset = productRelease === undefined ? undefined : findDataset(state.datasets, productRelease.dataset_id);
    return {
      record_kind: 'report',
      record_id: report.report_id,
      data_class: 'report',
      workspace_id: report.workspace_id,
      created_at: report.generated_at,
      source_id: dataset?.source_id ?? null,
      dataset_id: productRelease?.dataset_id ?? null,
      dataset_release: productRelease?.dataset_release ?? null,
      product_id: report.data_product.data_product_id,
      product_release: report.data_product.data_product_release,
      target_id: report.report_id,
      current: false,
      terminal: true,
    };
  });
}

function exportCandidates(state: PlatformState, exports: ExportRecord[]): PurgeCandidate[] {
  return exports.map((record) => {
    const product = findDataProduct(state.data_products, record.data_product_id);
    const productRelease = product?.releases.find((candidate) => candidate.release === record.data_product_release);
    const dataset = productRelease === undefined ? undefined : findDataset(state.datasets, productRelease.dataset_id);
    return {
      record_kind: 'export',
      record_id: record.export_id,
      data_class: 'export',
      workspace_id: record.workspace_id,
      created_at: record.created_at,
      source_id: dataset?.source_id ?? null,
      dataset_id: productRelease?.dataset_id ?? null,
      dataset_release: productRelease?.dataset_release ?? null,
      product_id: record.data_product_id,
      product_release: record.data_product_release,
      target_id: record.export_id,
      current: false,
      terminal: true,
    };
  });
}

function datasetReleaseCandidates(
  state: PlatformState,
  dataset: DatasetArtifact,
  release: DatasetReleaseRecord,
): PurgeCandidate {
  const latest = dataset.releases[dataset.releases.length - 1];
  return {
    record_kind: 'dataset_release',
    record_id: `${dataset.dataset_id}#${release.release}`,
    data_class: 'dataset_release_history',
    workspace_id: dataset.workspace_id,
    created_at: release.created_at,
    source_id: dataset.source_id,
    dataset_id: dataset.dataset_id,
    dataset_release: release.release,
    product_id: null,
    product_release: null,
    target_id: null,
    current: latest !== undefined && latest.release === release.release,
    terminal: true,
  };
}

function proposalCandidates(proposals: ArtifactProposalRecord[]): PurgeCandidate[] {
  return proposals
    .filter((proposal) => proposal.decisions.length > 0 || proposal.publications.length > 0)
    .map((proposal) => ({
      record_kind: 'proposal_evidence',
      record_id: proposal.proposal_id,
      data_class: 'proposal_evidence',
      workspace_id: proposal.workspace_id,
      created_at: proposal.created_at,
      source_id: 'source_id' in proposal ? proposal.source_id : null,
      dataset_id: 'dataset_id' in proposal ? proposal.dataset_id : null,
      dataset_release: 'base' in proposal && isRecord(proposal.base) && typeof proposal.base.dataset_release === 'number'
        ? proposal.base.dataset_release
        : null,
      product_id: null,
      product_release: null,
      target_id: proposal.proposal_id,
      current: false,
      terminal: true,
    }));
}

/** Every record one explicit scope covers, before eligibility is judged. */
function candidatesInScope(state: PlatformState, scope: RetentionScope): PurgeCandidate[] {
  const candidates: PurgeCandidate[] = [];
  const workspaceIds = new Set<string>();
  if (scope.workspace_id !== null) workspaceIds.add(scope.workspace_id);

  const datasets = state.datasets.filter((dataset) => {
    if (scope.kind === 'dataset' || scope.kind === 'release') return dataset.dataset_id === scope.dataset_id;
    if (scope.kind === 'source') return dataset.source_id === scope.source_id;
    return scope.workspace_id !== null && dataset.workspace_id === scope.workspace_id;
  });
  const datasetIds = new Set(datasets.map((dataset) => dataset.dataset_id));
  const productIds = new Set(
    state.data_products
      .filter((product) => {
        if (scope.kind === 'dataset' || scope.kind === 'release') {
          return product.workspace_id === scope.workspace_id
            && product.releases.some((release) => release.dataset_id === scope.dataset_id);
        }
        if (scope.kind === 'source') {
          return product.releases.some((release) => datasetIds.has(release.dataset_id));
        }
        return scope.workspace_id !== null && product.workspace_id === scope.workspace_id;
      })
      .map((product) => product.data_product_id),
  );

  if (scope.kind === 'export') {
    const exports = state.exports.filter((record) => scope.target_id === null
      ? record.workspace_id === scope.workspace_id
      : record.export_id === scope.target_id);
    return exportCandidates(state, exports);
  }
  if (scope.kind === 'proposal_evidence') {
    const proposals = state.artifact_proposals.filter((proposal) => proposal.workspace_id === scope.workspace_id
      && (scope.target_id === null || proposal.proposal_id === scope.target_id));
    return proposalCandidates(proposals);
  }

  const raws = state.raw_acquisitions.filter((raw) => {
    if (scope.kind === 'source') return raw.source_id === scope.source_id;
    return scope.workspace_id !== null && raw.workspace_id === scope.workspace_id;
  });
  for (const raw of raws) {
    candidates.push({
      record_kind: 'raw_acquisition',
      record_id: raw.raw_id,
      data_class: 'raw_acquisition',
      workspace_id: raw.workspace_id,
      created_at: raw.received_at,
      source_id: raw.source_id,
      dataset_id: null,
      dataset_release: null,
      product_id: null,
      product_release: null,
      target_id: null,
      current: false,
      terminal: true,
    });
  }

  for (const dataset of datasets) {
    for (const release of dataset.releases) {
      if (scope.kind === 'release' && release.release !== scope.dataset_release) continue;
      candidates.push(datasetReleaseCandidates(state, dataset, release));
    }
  }

  for (const product of state.data_products) {
    if (!productIds.has(product.data_product_id)) continue;
    for (const release of product.releases) {
      if (scope.kind === 'release'
        && (release.dataset_id !== scope.dataset_id || release.dataset_release !== scope.dataset_release)) {
        continue;
      }
      const dataset = state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
      candidates.push({
        record_kind: 'data_product_release',
        record_id: `${product.data_product_id}#${release.release}`,
        data_class: 'dataset_release_history',
        workspace_id: product.workspace_id,
        created_at: release.created_at,
        source_id: dataset?.source_id ?? null,
        dataset_id: release.dataset_id,
        dataset_release: release.dataset_release,
        product_id: product.data_product_id,
        product_release: release.release,
        target_id: null,
        current: product.lines.some((line) => line.current_release === release.release),
        terminal: true,
      });
    }
  }

  const reports = state.reports.filter((report) => {
    if (scope.kind === 'release') {
      return report.data_product.data_product_id !== undefined
        && productIds.has(report.data_product.data_product_id)
        && productReleaseMatchesReport(state, report, scope);
    }
    if (scope.kind === 'source') {
      return productIds.has(report.data_product.data_product_id);
    }
    return scope.workspace_id !== null && report.workspace_id === scope.workspace_id;
  });
  candidates.push(...reportCandidates(state, reports));

  const exports = state.exports.filter((record) => {
    if (scope.kind === 'release') {
      return productIds.has(record.data_product_id)
        && productReleaseBindings(state, record.data_product_id, record.data_product_release, scope);
    }
    if (scope.kind === 'source') return productIds.has(record.data_product_id);
    return scope.workspace_id !== null && record.workspace_id === scope.workspace_id;
  });
  candidates.push(...exportCandidates(state, exports));

  if (scope.kind === 'workspace' || scope.kind === 'source' || scope.kind === 'dataset') {
    const proposals = state.artifact_proposals.filter((proposal) => {
      if (scope.kind === 'dataset') {
        return proposal.workspace_id === scope.workspace_id
          && ('dataset_id' in proposal ? proposal.dataset_id === scope.dataset_id : false);
      }
      if (scope.kind === 'source') {
        return proposal.workspace_id === scope.workspace_id
          && 'source_id' in proposal
          && proposal.source_id === scope.source_id;
      }
      return proposal.workspace_id === scope.workspace_id;
    });
    candidates.push(...proposalCandidates(proposals));
  }

  // Deduplicate: one record is judged once however many paths reached it.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.record_kind}:${candidate.record_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function productReleaseMatchesReport(state: PlatformState, report: ReportRecord, scope: RetentionScope): boolean {
  const product = findDataProduct(state.data_products, report.data_product.data_product_id);
  const release = product?.releases.find((candidate) => candidate.release === report.data_product.data_product_release);
  return release !== undefined && release.dataset_id === scope.dataset_id && release.dataset_release === scope.dataset_release;
}

function productReleaseBindings(
  state: PlatformState,
  productId: string,
  releaseNumber: number,
  scope: RetentionScope,
): boolean {
  const product = findDataProduct(state.data_products, productId);
  const release = product?.releases.find((candidate) => candidate.release === releaseNumber);
  return release !== undefined && release.dataset_id === scope.dataset_id && release.dataset_release === scope.dataset_release;
}

/** True when a Hold's scope covers one candidate. */
function holdCovers(hold: RetentionHoldRecord, candidate: PurgeCandidate): boolean {
  if (hold.released_at !== null) return false;
  const scope = hold.scope;
  if (scope.kind === 'deployment') return true;
  if (scope.workspace_id !== null && scope.workspace_id !== candidate.workspace_id) return false;
  if (scope.kind === 'workspace') return true;
  if (scope.kind === 'source') return candidate.source_id === scope.source_id;
  if (scope.kind === 'dataset') return candidate.dataset_id === scope.dataset_id;
  if (scope.kind === 'release') {
    return candidate.dataset_id === scope.dataset_id && candidate.dataset_release === scope.dataset_release;
  }
  if (scope.kind === 'proposal_evidence') {
    return candidate.record_kind === 'proposal_evidence'
      && (scope.target_id === null || scope.target_id === candidate.target_id);
  }
  if (scope.kind === 'export') {
    return candidate.record_kind === 'export' && (scope.target_id === null || scope.target_id === candidate.target_id);
  }
  return false;
}

function retainedReport(state: PlatformState, report: ReportRecord, now: Date): boolean {
  return !isPastRetention(state, report.workspace_id, 'report', report.generated_at, now)
    && !purgeRevoked(state, 'report', report.report_id);
}

function productReleaseRetained(
  state: PlatformState,
  product: DataProductArtifact,
  release: DataProductArtifact['releases'][number],
  now: Date,
): boolean {
  if (product.lines.some((line) => line.current_release === release.release)) return true;
  return !isPastRetention(state, product.workspace_id, 'dataset_release_history', release.created_at, now)
    && !purgeRevoked(state, 'data_product_release', `${product.data_product_id}#${release.release}`);
}

function productReleasesBinding(state: PlatformState, datasetId: string, datasetRelease: number): Array<{
  product: DataProductArtifact;
  release: DataProductArtifact['releases'][number];
}> {
  return state.data_products.flatMap((product) => product.releases
    .filter((release) => (release.dataset_id === datasetId && release.dataset_release === datasetRelease)
      || (release.relationships ?? []).some(
        (binding) => binding.dataset_id === datasetId && binding.dataset_release === datasetRelease,
      ))
    .map((release) => ({ product, release })));
}

function reportsPinning(state: PlatformState, productId: string, productRelease: number): ReportRecord[] {
  return state.reports.filter((report) => report.data_product.data_product_id === productId
    && report.data_product.data_product_release === productRelease
    && !purgeRevoked(state, 'report', report.report_id));
}

/** Judges one candidate against policy, active Holds, and retained dependents. */
function judgeCandidate(
  state: PlatformState,
  candidate: PurgeCandidate,
  now: Date,
  holds: RetentionHoldRecord[],
): PurgePlanEntry {
  const entry: PurgePlanEntry = {
    data_class: candidate.data_class,
    record_kind: candidate.record_kind,
    record_id: candidate.record_id,
    workspace_id: candidate.workspace_id,
    eligible: false,
    reason: 'within_retention',
    held_by: [],
    dependencies: [],
  };
  entry.held_by = holds.filter((hold) => holdCovers(hold, candidate)).map((hold) => hold.hold_id);
  if (entry.held_by.length > 0) {
    entry.reason = 'held';
    return entry;
  }
  const term = effectiveTerm(state, candidate.workspace_id, candidate.data_class);
  if (term.kind === 'indefinite') {
    entry.reason = 'indefinite';
    return entry;
  }
  if (term.kind === 'no_guarantee') {
    entry.reason = 'no_guarantee';
    return entry;
  }

  if (candidate.record_kind === 'dataset_release') {
    if (candidate.current) {
      entry.reason = 'current';
      return entry;
    }
    const bindings = productReleasesBinding(state, candidate.dataset_id!, candidate.dataset_release!);
    const retainedBindings = bindings.filter(({ product, release }) => productReleaseRetained(state, product, release, now));
    const retained = retainedBindings
      .filter(({ product, release }) => !purgeRevoked(state, 'data_product_release', `${product.data_product_id}#${release.release}`))
      .map(({ product, release }) => `${product.data_product_id}#${release.release}`);
    for (const { product, release } of retainedBindings) {
      for (const report of reportsPinning(state, product.data_product_id, release.release)) {
        if (retainedReport(state, report, now)) retained.push(report.report_id);
      }
    }
    if (retained.length > 0) {
      entry.reason = 'dependent';
      entry.dependencies = [...new Set(retained)];
      return entry;
    }
  }

  if (candidate.record_kind === 'data_product_release') {
    if (candidate.current) {
      entry.reason = 'current';
      return entry;
    }
    const dependent = reportsPinning(state, candidate.product_id!, candidate.product_release!)
      .filter((report) => retainedReport(state, report, now))
      .map((report) => report.report_id);
    if (dependent.length > 0) {
      entry.reason = 'dependent';
      entry.dependencies = [...new Set(dependent)];
      return entry;
    }
  }

  if (!isPastRetention(state, candidate.workspace_id, candidate.data_class, candidate.created_at, now)) {
    entry.reason = 'within_retention';
    return entry;
  }
  entry.eligible = true;
  entry.reason = 'eligible';
  return entry;
}

export function evaluateScope(state: PlatformState, scope: RetentionScope, now: Date): PurgePlanEntry[] {
  const holds = state.retention_holds;
  return candidatesInScope(state, scope).map((candidate) => judgeCandidate(state, candidate, now, holds));
}

// ---------------------------------------------------------------------------
// Purge: immediate revocation, asynchronous durable deletion, retry, ledger.
// ---------------------------------------------------------------------------

function nowOf(options: { at?: string }): Date {
  if (options.at === undefined) return new Date();
  const parsed = new Date(options.at);
  if (!Number.isFinite(parsed.getTime())) throw new Error('--at must be an ISO 8601 instant.');
  return parsed;
}

function jobView(job: PurgeJobRecord): Record<string, unknown> {
  const purged = job.plan.filter((entry) => entry.purged === true);
  const deferred = job.plan.filter((entry) => entry.deferred === true);
  return {
    purge_id: job.purge_id,
    mode: job.mode,
    status: job.status,
    scope: scopeView(job.scope),
    requested_at: job.requested_at,
    requested_by: job.requested_by,
    access_revoked_at: job.access_revoked_at,
    attempts: job.attempts,
    retry_at: job.retry_at,
    last_error: job.last_error,
    completed_at: job.completed_at,
    ledger_sequence: job.ledger_sequence,
    purged_count: purged.length,
    deferred_count: deferred.length,
    plan: job.plan.map((entry) => ({ ...entry, held_by: [...entry.held_by], dependencies: [...entry.dependencies] })),
  };
}

function planSummary(plan: PurgePlanEntry[]): { eligible: number; held: number; blocked: number } {
  const eligible = plan.filter((entry) => entry.eligible).length;
  const held = plan.filter((entry) => entry.reason === 'held').length;
  return { eligible, held, blocked: plan.length - eligible };
}

/**
 * Evaluates one explicit Purge scope without acting, so the exact target, the
 * records it reaches, their dependencies, and their consequences are visible
 * before an administrator confirms anything.
 */
export function previewPurge(options: RetentionOptions & { scopeKind: string }): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'retention_purge_preview', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const kind = optionScopeKind(options.scopeKind);
  if (kind === 'deployment') {
    reject(session, actorLabel(actor.user), context, 'RETENTION_SCOPE_INVALID', 'A manual Purge supports workspace, source, dataset, release, proposal-evidence, and export scopes.');
  }
  const scope = resolveScope(session, actor, context, options, kind);
  const scoped: ActionContext = scope.workspace_id === null
    ? context
    : { ...context, scope: 'workspace', workspace_id: scope.workspace_id };
  const now = nowOf(options);
  const plan = evaluateScope(session.state, scope, now);
  const counts = planSummary(plan);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { scope_kind: scope.kind, eligible_count: counts.eligible, held_count: counts.held, blocked_count: counts.blocked },
  });
  return {
    mode: 'preview',
    at: now.toISOString(),
    scope: scopeView(scope),
    plan: plan.map((entry) => ({ ...entry, held_by: [...entry.held_by], dependencies: [...entry.dependencies] })),
    eligible_count: counts.eligible,
    blocked_count: counts.blocked,
    held_count: counts.held,
    summary: counts.eligible === 0
      ? '本次清除预演没有符合条件的内容：当前、保留中、受暂停或仍被依赖的记录一律保留。'
      : `本次清除预演将立即撤销访问并异步删除 ${counts.eligible} 条记录，其余 ${counts.blocked} 条因当前、保留中、受暂停或依赖而保留。`,
  };
}

/** Requests one manual Purge: access is revoked now, deletion is asynchronous. */
export function requestPurge(options: RetentionOptions & {
  scopeKind: string;
  /** The instant a separate step-up authentication verified this actor. */
  stepUpVerifiedAt?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'retention_purge_request', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const kind = optionScopeKind(options.scopeKind);
  if (kind === 'deployment') {
    reject(session, actorLabel(actor.user), context, 'RETENTION_SCOPE_INVALID', 'A manual Purge supports workspace, source, dataset, release, proposal-evidence, and export scopes.');
  }
  const scope = resolveScope(session, actor, context, options, kind);
  const scoped: ActionContext = scope.workspace_id === null
    ? context
    : { ...context, scope: 'workspace', workspace_id: scope.workspace_id };
  const now = nowOf(options);
  const plan = evaluateScope(session.state, scope, now);
  const counts = planSummary(plan);
  if (counts.eligible === 0) {
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: {
        scope_kind: scope.kind,
        eligible_count: 0,
        held_count: counts.held,
        blocked_count: counts.blocked,
      },
    });
    session.save();
    return {
      purge_id: null,
      mode: 'manual',
      status: 'nothing_eligible',
      access_revoked_at: null,
      scope: scopeView(scope),
      plan: plan.map((entry) => ({ ...entry, held_by: [...entry.held_by], dependencies: [...entry.dependencies] })),
      eligible_count: 0,
      blocked_count: counts.blocked,
      held_count: counts.held,
      summary: '本次清除没有符合条件的内容：当前、保留中、受暂停或仍被依赖的记录一律保留。',
    };
  }
  const job: PurgeJobRecord = {
    purge_id: `purge-${canonicalDigest({ scope, at: now.toISOString(), actor: actorLabel(actor.user) }).slice(0, 32)}`,
    mode: 'manual',
    scope,
    requested_at: now.toISOString(),
    requested_by: actorLabel(actor.user),
    requested_by_user_id: actor.user.user_id,
    status: 'pending',
    access_revoked_at: now.toISOString(),
    plan,
    attempts: 0,
    retry_at: now.toISOString(),
    last_error: null,
    completed_at: null,
    ledger_sequence: null,
  };
  session.state.purge_jobs.push(job);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      purge_id: job.purge_id,
      scope_kind: scope.kind,
      eligible_count: counts.eligible,
      blocked_count: counts.blocked,
      held_count: counts.held,
      access_revoked_at: job.access_revoked_at,
      ...(options.stepUpVerifiedAt === undefined ? {} : { step_up_verified_at: options.stepUpVerifiedAt }),
    },
  });
  session.save();
  return {
    ...jobView(job),
    eligible_count: counts.eligible,
    blocked_count: counts.blocked,
    held_count: counts.held,
    summary: '已立即撤销访问并建立异步清除任务，满足依赖与恢复条件后执行物理删除。',
  };
}

/** Evaluates one Workspace without acting, so eligibility is inspectable. */
export function evaluateRetention(options: RetentionOptions): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'retention_evaluate',
    scope: 'workspace',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  if (options.workspaceId === undefined) {
    reject(session, actorLabel(actor.user), context, 'RETENTION_SCOPE_INVALID', 'An eligibility evaluation must name --workspace.');
  }
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const now = nowOf(options);
  const effective = effectiveRetention(session.state, options.workspaceId);
  const plan = evaluateScope(session.state, {
    kind: 'workspace',
    workspace_id: options.workspaceId,
    source_id: null,
    dataset_id: null,
    dataset_release: null,
    target_id: null,
  }, now);
  const counts = planSummary(plan);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { eligible_count: counts.eligible, held_count: counts.held, blocked_count: counts.blocked },
  });
  return {
    workspace_id: options.workspaceId,
    at: now.toISOString(),
    policy_version: effective.policy_version,
    override_version: effective.override_version,
    terms: deepCopy(effective.terms),
    plan: plan.map((entry) => ({ ...entry, held_by: [...entry.held_by], dependencies: [...entry.dependencies] })),
    eligible_count: counts.eligible,
    blocked_count: counts.blocked,
    held_count: counts.held,
    summary: '已完成保留资格评估：只有超出保留期且未被暂停或依赖的记录才可清除。',
  };
}

/**
 * Applies one Purge decision to the stores. The same function serves an executed
 * Purge job and a Purge Ledger replay during disaster recovery, so restored
 * content is removed exactly the way the original Purge removed it.
 */
export function removePurgedRecord(
  session: PlatformSession,
  entry: Pick<PurgePlanEntry, 'record_kind' | 'record_id'>,
): void {
  switch (entry.record_kind) {
    case 'raw_acquisition': {
      const raw = session.state.raw_acquisitions.find((candidate) => candidate.raw_id === entry.record_id);
      if (raw === undefined) return;
      rmSync(join(session.root, raw.object_path), { force: true });
      session.state.raw_acquisitions = session.state.raw_acquisitions.filter((candidate) => candidate.raw_id !== entry.record_id);
      return;
    }
    case 'dataset_release': {
      const [datasetId, release] = entry.record_id.split('#');
      const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === datasetId);
      if (dataset === undefined) return;
      dataset.releases = dataset.releases.filter((candidate) => candidate.release !== Number(release));
      return;
    }
    case 'data_product_release': {
      const [productId, release] = entry.record_id.split('#');
      const product = session.state.data_products.find((candidate) => candidate.data_product_id === productId);
      if (product === undefined) return;
      product.releases = product.releases.filter((candidate) => candidate.release !== Number(release));
      return;
    }
    case 'report': {
      session.state.reports = session.state.reports.filter((candidate) => candidate.report_id !== entry.record_id);
      return;
    }
    case 'proposal_evidence': {
      const proposal = session.state.artifact_proposals.find((candidate) => candidate.proposal_id === entry.record_id);
      if (proposal === undefined) return;
      proposal.validations = [];
      if ('previews' in proposal) proposal.previews = [];
      return;
    }
    case 'export': {
      const record = session.state.exports.find((candidate) => candidate.export_id === entry.record_id);
      if (record !== undefined) rmSync(join(session.root, record.object_path), { force: true });
      session.state.exports = session.state.exports.filter((candidate) => candidate.export_id !== entry.record_id);
      return;
    }
  }
}

/**
 * Executes one durable Purge job. Every planned record is re-judged against
 * Holds and dependencies first, so a Hold or a newly retained dependent stops
 * physical deletion while the committed revocation stands. A storage fault
 * leaves the job durable with a later retry, never changing published data.
 */
function executeJob(session: PlatformSession, job: PurgeJobRecord, at: Date): void {
  const fresh = evaluateScope(session.state, job.scope, at);
  const freshByKey = new Map(fresh.map((entry) => [`${entry.record_kind}:${entry.record_id}`, entry]));
  for (const entry of job.plan) {
    if (entry.purged === true) continue;
    if (entry.deferred === true) continue;
    const current = freshByKey.get(`${entry.record_kind}:${entry.record_id}`);
    if (current === undefined) {
      // The record no longer exists: an earlier attempt already deleted it.
      entry.purged = true;
      continue;
    }
    if (current.reason === 'held' || current.reason === 'dependent') {
      entry.deferred = true;
      entry.held_by = [...current.held_by];
      entry.dependencies = [...current.dependencies];
      continue;
    }
    removePurgedRecord(session, entry);
    entry.purged = true;
  }
  const retained = job.plan.filter((entry) => entry.purged !== true && entry.deferred !== true);
  if (retained.length > 0) {
    throw new Error('A planned record could not be purged.');
  }
  const purged = job.plan.filter((entry) => entry.purged === true);
  if (purged.length > 0) {
    const sequence = session.state.purge_ledger.length + 1;
    const ledger: PurgeLedgerEntry = {
      sequence,
      purge_id: job.purge_id,
      mode: job.mode,
      recorded_at: at.toISOString(),
      scope: job.scope,
      purged: purged.map((entry) => ({
        record_kind: entry.record_kind,
        record_id: entry.record_id,
        data_class: entry.data_class,
      })),
    };
    session.state.purge_ledger.push(ledger);
    job.ledger_sequence = sequence;
  }
  job.status = 'completed';
  job.completed_at = at.toISOString();
  job.retry_at = null;
  job.last_error = null;
}

function executeDueJobs(
  session: PlatformSession,
  actorName: string,
  at: Date,
): { executed: PurgeJobRecord[]; ledger: PurgeLedgerEntry[]; failed: number } {
  const ledgerBefore = session.state.purge_ledger.length;
  const executed: PurgeJobRecord[] = [];
  for (const job of session.state.purge_jobs) {
    if (job.status === 'completed') continue;
    const due = job.status === 'pending'
      || (job.status === 'failed' && job.retry_at !== null && Date.parse(job.retry_at) <= at.getTime());
    if (!due) continue;
    try {
      executeJob(session, job, at);
      executed.push(job);
      session.audit({
        action: 'retention_purge_complete',
        scope: 'deployment',
        ...(job.scope.workspace_id === null ? {} : { workspace_id: job.scope.workspace_id }),
        actor: actorName,
        outcome: 'succeeded',
        detail: { purge_id: job.purge_id, mode: job.mode, ledger_sequence: job.ledger_sequence ?? 0 },
      });
    } catch (error) {
      job.status = 'failed';
      job.attempts += 1;
      job.last_error = error instanceof Error ? error.message : 'The physical deletion failed.';
      job.retry_at = new Date(at.getTime() + job.attempts * PURGE_RETRY_SECONDS * 1000).toISOString();
      executed.push(job);
      session.audit({
        action: 'retention_purge_failed',
        scope: 'deployment',
        ...(job.scope.workspace_id === null ? {} : { workspace_id: job.scope.workspace_id }),
        actor: actorName,
        outcome: 'failed',
        detail: { purge_id: job.purge_id, attempts: job.attempts, error_code: 'PURGE_DELETION_FAILED' },
      });
    }
  }
  return { executed, ledger: session.state.purge_ledger.slice(ledgerBefore), failed: session.state.purge_jobs.filter((job) => job.status === 'failed').length };}

function coveredByOpenJob(state: PlatformState, entry: PurgePlanEntry): boolean {
  return state.purge_jobs.some((job) => job.status !== 'completed'
    && job.plan.some((planned) => planned.record_kind === entry.record_kind && planned.record_id === entry.record_id));
}

/**
 * Evaluates every Workspace at one instant: eligible content becomes durable
 * automatic Purge work, and every due job (manual or automatic, including a
 * retry) is executed against current Holds and dependencies.
 */
export function tickRetention(options: { root: string; masterKey: string; token: string; at?: string }): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'retention_purge_tick', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const at = nowOf(options);
  const created: PurgeJobRecord[] = [];
  for (const workspace of session.state.workspaces) {
    const plan = evaluateScope(session.state, {
      kind: 'workspace',
      workspace_id: workspace.workspace_id,
      source_id: null,
      dataset_id: null,
      dataset_release: null,
      target_id: null,
    }, at).filter((entry) => entry.eligible && !coveredByOpenJob(session.state, entry));
    if (plan.length === 0) continue;
    const job: PurgeJobRecord = {
      purge_id: `purge-${canonicalDigest({ workspace: workspace.workspace_id, at: at.toISOString(), plan: plan.map((entry) => entry.record_id) }).slice(0, 32)}`,
      mode: 'automatic',
      scope: {
        kind: 'workspace',
        workspace_id: workspace.workspace_id,
        source_id: null,
        dataset_id: null,
        dataset_release: null,
        target_id: null,
      },
      requested_at: at.toISOString(),
      requested_by: 'retention-tick',
      requested_by_user_id: actor.user.user_id,
      status: 'pending',
      access_revoked_at: at.toISOString(),
      plan,
      attempts: 0,
      retry_at: at.toISOString(),
      last_error: null,
      completed_at: null,
      ledger_sequence: null,
    };
    session.state.purge_jobs.push(job);
    created.push(job);
    session.audit({
      action: 'retention_purge_schedule',
      scope: 'workspace',
      workspace_id: workspace.workspace_id,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: { purge_id: job.purge_id, eligible_count: plan.length },
    });
  }
  const executed = executeDueJobs(session, actorLabel(actor.user), at);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      at: at.toISOString(),
      automatic_jobs_created: created.length,
      jobs_executed: executed.executed.length,
      ledger_entries: executed.ledger.length,
      failed_purges: executed.failed,
    },
  });
  session.save();
  const health = retentionHealth(session.state);
  return {
    at: at.toISOString(),
    created_jobs: created.map((job) => job.purge_id),
    jobs: executed.executed.map((job) => jobView(job)),
    ledger: executed.ledger.map((entry) => deepCopy(entry)),
    health: health.health,
    failed_purges: health.failed_purges,
    pending_purges: health.pending_purges,
    summary: '自动清除评估已完成：符合条件的内容已撤销访问并排队执行物理删除。',
  };
}

/** Shows one durable Purge job and its plan. */
export function showPurgeJob(options: RetentionOptions & { purgeId: string }): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'retention_purge_read', scope: 'deployment', target: options.purgeId };
  const actor = resolveActor(session, options.token, context);
  const job = session.state.purge_jobs.find((candidate) => candidate.purge_id === options.purgeId);
  if (job === undefined) {
    reject(session, actorLabel(actor.user), context, 'RETENTION_PURGE_NOT_FOUND', 'The requested Purge job does not exist.');
  }
  const administers = job.scope.workspace_id === null
    ? isDeploymentAdministrator(actor.user)
    : workspaceRoleOf(session.state, actor.user.user_id, job.scope.workspace_id) === 'Workspace Administrator'
      || isDeploymentAdministrator(actor.user);
  if (!administers) {
    deny(session, actorLabel(actor.user), context, 'RETENTION_PURGE_NOT_FOUND', 'The requested Purge job is not available to this actor.');
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return {
    ...jobView(job),
    summary: job.status === 'completed'
      ? '该清除任务已完成，清除台账已记录被删除的内容。'
      : job.status === 'failed'
        ? '该清除任务的上一次物理删除失败，将按退避时间安全重试。'
        : '该清除任务已撤销访问，等待异步物理删除。',
  };
}

/** Lists the Purge jobs the actor may administer. */
export function listPurgeJobs(options: RetentionOptions): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'retention_purge_list',
    scope: options.workspaceId === undefined ? 'deployment' : 'workspace',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  const jobs = session.state.purge_jobs
    .filter((job) => {
      if (options.workspaceId !== undefined) return job.scope.workspace_id === options.workspaceId;
      return isDeploymentAdministrator(actor.user)
        || (job.scope.workspace_id !== null
          && workspaceRoleOf(session.state, actor.user.user_id, job.scope.workspace_id) === 'Workspace Administrator');
    })
    .map((job) => jobView(job));
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { jobs_returned: jobs.length } });
  return {
    jobs,
    ledger: deepCopy(session.state.purge_ledger),
    health: retentionHealth(session.state),
    summary: '已列出当前管理员范围内的清除任务与清除台账。',
  };
}

/**
 * The rejection an expired historical read receives. It never substitutes the
 * current Release for the one the caller named, and a purged record is named as
 * retention-expired whether or not its bytes are already gone.
 */
export function retentionExpiredMessage(
  state: PlatformState,
  workspaceId: string,
  dataClass: RetentionDataClass,
  createdAt: string,
  now: Date,
  label: string,
): string {
  const term = effectiveTerm(state, workspaceId, dataClass);
  const days = termDays(term);
  return days === null
    ? `${label} is no longer available under the retention policy.`
    : `${label} is older than the ${days}-day retention policy and has expired.`;
}
