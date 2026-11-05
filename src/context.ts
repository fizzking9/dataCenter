import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  reject,
  requireDeploymentAdministrator,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import { canonicalJson } from './crypto.js';
import {
  DEPLOYMENT_CONTEXT_ARTIFACT,
  findContextArtifact,
  findUserById,
  latestVersion,
  workspaceContextArtifact,
  type ContextEntry,
  type ContextVersion,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const ENTRY_KINDS = ['metric', 'definition', 'dimension'] as const;
const KEY_RULE = /^[a-z][a-z0-9_]{1,63}$/;
const FAVORABLE_DIRECTIONS = ['up', 'down', 'neutral'] as const;
const METRIC_AGGREGATIONS = ['count', 'sum', 'min', 'max', 'avg'] as const;
const METRIC_VALUE_TYPES = ['integer', 'decimal', 'money', 'date', 'timestamp'] as const;

interface Resolution {
  commonKeys: Set<string>;
  workspaceKeys: Set<string>;
  workspaceId: string | null;
}

function requireEntry(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): ContextEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    reject(session, actor, context, 'CONTEXT_ENTRY_INVALID', 'Each Business Context entry must be an object.');
  }
  const candidate = raw as Record<string, unknown>;
  const key = candidate['key'];
  if (typeof key !== 'string' || !KEY_RULE.test(key)) {
    reject(session, actor, context, 'CONTEXT_ENTRY_INVALID', 'Each entry key must be a lowercase identifier of 2 to 64 characters.');
  }
  const kind = candidate['kind'];
  if (!ENTRY_KINDS.includes(kind as (typeof ENTRY_KINDS)[number])) {
    reject(session, actor, context, 'CONTEXT_ENTRY_INVALID', `Each entry kind must be one of: ${ENTRY_KINDS.join(', ')}.`);
  }
  const value = candidate['value'];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    reject(session, actor, context, 'CONTEXT_ENTRY_INVALID', 'Each entry value must be a non-empty string of at most 1024 characters.');
  }
  const references = candidate['references'] ?? [];
  if (!Array.isArray(references) || references.some((reference) => typeof reference !== 'string')) {
    reject(session, actor, context, 'CONTEXT_ENTRY_INVALID', 'Entry references must be an array of qualified keys.');
  }
  const unit = candidate['unit'];
  const description = candidate['description'];
  const favorable = candidate['favorable_direction'];
  const aggregation = candidate['aggregation'];
  const valueType = candidate['value_type'];
  // Only a Metric Definition carries a direction and a formula: a dimension or
  // a general definition that claimed one would govern something it does not.
  if (favorable !== undefined
    && (kind !== 'metric' || !FAVORABLE_DIRECTIONS.includes(favorable as (typeof FAVORABLE_DIRECTIONS)[number]))) {
    reject(
      session,
      actor,
      context,
      'CONTEXT_ENTRY_INVALID',
      `Only a metric entry may state a favorable direction, and it must be one of: ${FAVORABLE_DIRECTIONS.join(', ')}.`,
    );
  }
  if (aggregation !== undefined
    && (kind !== 'metric' || !METRIC_AGGREGATIONS.includes(aggregation as (typeof METRIC_AGGREGATIONS)[number]))) {
    reject(
      session,
      actor,
      context,
      'CONTEXT_ENTRY_INVALID',
      `Only a metric entry may state an aggregation, and it must be one of: ${METRIC_AGGREGATIONS.join(', ')}.`,
    );
  }
  if (valueType !== undefined
    && (kind !== 'metric' || !METRIC_VALUE_TYPES.includes(valueType as (typeof METRIC_VALUE_TYPES)[number]))) {
    reject(
      session,
      actor,
      context,
      'CONTEXT_ENTRY_INVALID',
      `Only a metric entry may state a value type, and it must be one of: ${METRIC_VALUE_TYPES.join(', ')}.`,
    );
  }
  return {
    key,
    kind: kind as ContextEntry['kind'],
    value,
    ...(typeof unit === 'string' ? { unit } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(references.length === 0 ? {} : { references: references as string[] }),
    ...(favorable === undefined ? {} : { favorable_direction: favorable as NonNullable<ContextEntry['favorable_direction']> }),
    ...(aggregation === undefined ? {} : { aggregation: aggregation as NonNullable<ContextEntry['aggregation']> }),
    ...(valueType === undefined ? {} : { value_type: valueType as NonNullable<ContextEntry['value_type']> }),
  };
}

/** One published snapshot: every entry is valid and every key appears once. */
function parseEntries(session: PlatformSession, actor: string, context: ActionContext, parsed: unknown): ContextEntry[] {
  if (!Array.isArray(parsed)) {
    reject(session, actor, context, 'CONTEXT_ENTRY_INVALID', 'The Business Context entries must be an array of entries.');
  }
  const entries = parsed.map((raw) => requireEntry(session, actor, context, raw));
  const keys = new Set(entries.map((entry) => entry.key));
  if (keys.size !== entries.length) {
    reject(session, actor, context, 'CONTEXT_ENTRY_DUPLICATE', 'Each Business Context entry key must appear once.');
  }
  return entries;
}

function readEntries(session: PlatformSession, actor: string, context: ActionContext, path: string): ContextEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    reject(session, actor, context, 'CONTEXT_ENTRIES_UNREADABLE', 'The Business Context entry file must contain valid JSON.');
  }
  return parseEntries(session, actor, context, parsed);
}

/**
 * Qualified references only: `common:<key>` or `workspace:<workspace id>:<key>`.
 * An unqualified reference is an implicit one, and a reference into a different
 * Workspace is prohibited, so both fail closed.
 */
function validateReferences(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  entry: ContextEntry,
  resolution: Resolution,
): void {
  for (const reference of entry.references ?? []) {
    const separator = reference.indexOf(':');
    if (separator <= 0) {
      reject(
        session,
        actor,
        context,
        'CONTEXT_REFERENCE_NOT_QUALIFIED',
        'Business Context references must be qualified as common:<key> or workspace:<workspace id>:<key>.',
      );
    }
    const scope = reference.slice(0, separator);
    const remainder = reference.slice(separator + 1);
    if (scope === 'common') {
      if (!resolution.commonKeys.has(remainder)) {
        reject(session, actor, context, 'CONTEXT_REFERENCE_UNRESOLVED', 'A common reference does not resolve in the pinned common version.');
      }
      continue;
    }
    if (scope !== 'workspace') {
      reject(session, actor, context, 'CONTEXT_REFERENCE_NOT_QUALIFIED', 'Business Context references must use the common or workspace scope.');
    }
    const nested = remainder.indexOf(':');
    if (nested <= 0) {
      reject(session, actor, context, 'CONTEXT_REFERENCE_NOT_QUALIFIED', 'Workspace references must name the Workspace explicitly.');
    }
    if (resolution.workspaceId === null || remainder.slice(0, nested) !== resolution.workspaceId) {
      reject(session, actor, context, 'CROSS_WORKSPACE_REFERENCE', 'A Workspace reference must resolve inside the same Workspace.');
    }
    if (!resolution.workspaceKeys.has(remainder.slice(nested + 1))) {
      reject(session, actor, context, 'CONTEXT_REFERENCE_UNRESOLVED', 'A Workspace reference does not resolve in this snapshot.');
    }
  }
}

function validateSnapshot(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  entries: ContextEntry[],
  resolution: Resolution,
): void {
  if (resolution.workspaceId !== null) {
    for (const entry of entries) {
      if (resolution.commonKeys.has(entry.key)) {
        reject(
          session,
          actor,
          context,
          'CONTEXT_SHADOWS_COMMON',
          'A Workspace extension cannot redefine a common Business Context key.',
        );
      }
    }
  }
  for (const entry of entries) {
    validateReferences(session, actor, context, entry, resolution);
  }
}

function keysOf(version: ContextVersion | undefined): Set<string> {
  return new Set((version?.entries ?? []).map((entry) => entry.key));
}

function contentHash(entries: ContextEntry[]): string {
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

function publish(
  session: PlatformSession,
  actor: { user_id: string; username: string },
  artifactId: string,
  scope: 'deployment' | 'workspace',
  workspaceId: string | null,
  entries: ContextEntry[],
  pinnedCommonVersion: number,
): Record<string, unknown> {
  let artifact = findContextArtifact(session.state, artifactId);
  if (!artifact) {
    artifact = {
      artifact_id: artifactId,
      scope,
      workspace_id: workspaceId,
      owner_user_id: actor.user_id,
      versions: [],
    };
    session.state.context_artifacts.push(artifact);
  }
  const previous = latestVersion(artifact);
  const version: ContextVersion = {
    version: (previous?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user_id,
    content_hash: contentHash(entries),
    pins: {
      common_version: scope === 'deployment' ? (previous?.version ?? 0) + 1 : pinnedCommonVersion,
      previous_version: previous?.version ?? null,
    },
    entries,
  };
  artifact.versions.push(version);
  session.audit({
    action: 'business_context_publish',
    scope,
    ...(workspaceId === null ? {} : { workspace_id: workspaceId }),
    target: artifactId,
    actor: actor.username,
    outcome: 'succeeded',
    detail: { business_context_version: version.version, entry_count: entries.length },
  });
  session.save();
  return {
    scope,
    artifact_id: artifactId,
    workspace_id: workspaceId,
    business_context_version: version.version,
    content_hash: version.content_hash,
    pins: scope === 'deployment'
      ? {
          common_business_context_version: version.pins.common_version,
          previous_common_business_context_version: version.pins.previous_version,
        }
      : {
          common_business_context_version: version.pins.common_version,
          previous_workspace_business_context_version: version.pins.previous_version,
        },
    entry_count: entries.length,
  };
}

/** Publishes an immutable full snapshot of Deployment-owned common Business Context. */
export function publishCommonContext(options: {
  root: string;
  masterKey: string;
  token: string;
  entriesPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'business_context_publish',
    scope: 'deployment',
    target: DEPLOYMENT_CONTEXT_ARTIFACT,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const entries = readEntries(session, actorLabel(actor.user), context, options.entriesPath);
  validateSnapshot(session, actorLabel(actor.user), context, entries, {
    commonKeys: new Set(entries.map((entry) => entry.key)),
    workspaceKeys: new Set<string>(),
    workspaceId: null,
  });
  return publish(session, actor.user, DEPLOYMENT_CONTEXT_ARTIFACT, 'deployment', null, entries, 0);
}

/** Publishes an additive Workspace extension pinned to the current common version. */
export function publishWorkspaceContext(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  /** The CLI names a file; a browser workflow posts the entries themselves. */
  entriesPath?: string;
  entries?: unknown;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'business_context_publish',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: workspaceContextArtifact(options.workspaceId),
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const common = latestVersion(findContextArtifact(session.state, DEPLOYMENT_CONTEXT_ARTIFACT));
  const entries = options.entries === undefined
    ? readEntries(session, actorLabel(actor.user), context, options.entriesPath ?? '')
    : parseEntries(session, actorLabel(actor.user), context, options.entries);
  validateSnapshot(session, actorLabel(actor.user), context, entries, {
    commonKeys: keysOf(common),
    workspaceKeys: new Set(entries.map((entry) => entry.key)),
    workspaceId: options.workspaceId,
  });
  return publish(
    session,
    actor.user,
    workspaceContextArtifact(options.workspaceId),
    'workspace',
    options.workspaceId,
    entries,
    common?.version ?? 0,
  );
}

/** Reads one exact Business Context version with the common versions it pins. */
export function showContext(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId?: string;
  version?: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'business_context_read',
    scope: options.workspaceId === undefined ? 'deployment' : 'workspace',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  if (options.workspaceId === undefined) {
    requireDeploymentAdministrator(session, actor, context);
  } else {
    requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  }
  const artifactId = options.workspaceId === undefined
    ? DEPLOYMENT_CONTEXT_ARTIFACT
    : workspaceContextArtifact(options.workspaceId);
  const artifact = findContextArtifact(session.state, artifactId);
  if (!artifact || artifact.versions.length === 0) {
    reject(session, actorLabel(actor.user), context, 'CONTEXT_NOT_PUBLISHED', 'No Business Context version has been published for this scope.');
  }
  const version = options.version === undefined
    ? latestVersion(artifact)!
    : artifact.versions.find((candidate) => candidate.version === options.version);
  if (!version) {
    reject(session, actorLabel(actor.user), context, 'CONTEXT_VERSION_NOT_FOUND', 'The requested Business Context version does not exist.');
  }

  const pinnedCommon = artifact.scope === 'workspace'
    ? findContextArtifact(session.state, DEPLOYMENT_CONTEXT_ARTIFACT)?.versions.find(
        (candidate) => candidate.version === version.pins.common_version,
      )
    : version;
  const entries: Array<ContextEntry & { source: 'common' | 'workspace' }> = artifact.scope === 'workspace'
    ? [
        ...(pinnedCommon?.entries ?? []).map((entry) => ({ ...entry, source: 'common' as const })),
        ...version.entries.map((entry) => ({ ...entry, source: 'workspace' as const })),
      ]
    : version.entries.map((entry) => ({ ...entry, source: 'common' as const }));
  entries.sort((left, right) => left.key.localeCompare(right.key));

  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', target: artifactId });
  const owner = findUserById(session.state, artifact.owner_user_id);
  return {
    scope: artifact.scope,
    workspace_id: artifact.workspace_id,
    artifact_id: artifact.artifact_id,
    owner: owner?.username ?? null,
    business_context_version: version.version,
    content_hash: version.content_hash,
    pins: artifact.scope === 'deployment'
      ? {
          common_business_context_version: version.pins.common_version,
          previous_common_business_context_version: version.pins.previous_version,
        }
      : {
          common_business_context_version: version.pins.common_version,
          previous_workspace_business_context_version: version.pins.previous_version,
        },
    entries,
  };
}

/** One Artifact pinned to an exact Workspace Business Context version. */
function affectedArtifacts(
  session: PlatformSession,
  workspaceId: string,
  version: number,
): Array<Record<string, string | number>> {
  const sourceName = (sourceId: string): string =>
    session.state.sources.find((source) => source.source_id === sourceId)?.name ?? sourceId;
  const configurations = session.state.integration_configurations
    .filter((artifact) => artifact.workspace_id === workspaceId)
    .flatMap((artifact) => artifact.versions
      .filter((candidate) => candidate.pins.workspace_business_context_version === version)
      .map((candidate) => ({
        kind: 'integration_configuration',
        version: candidate.version,
        source_id: artifact.source_id,
        source_name: sourceName(artifact.source_id),
      })));
  const releases = session.state.datasets
    .filter((dataset) => dataset.workspace_id === workspaceId)
    .flatMap((dataset) => dataset.releases
      .filter((release) => release.pins.workspace_business_context_version === version)
      .map((release) => ({
        kind: 'dataset_release',
        version: release.release,
        dataset_id: release.dataset_id,
        source_id: release.source_id,
        source_name: sourceName(release.source_id),
      })));
  return [...configurations, ...releases];
}

/**
 * Reads this Workspace's own Business Context version history, newest first,
 * with the Artifacts each exact version is pinned to. Another Workspace's
 * configuration is a different Artifact, so it is never part of the answer.
 */
export function showContextHistory(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const artifactId = workspaceContextArtifact(options.workspaceId);
  const context: ActionContext = {
    action: 'business_context_history_read',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: artifactId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const artifact = findContextArtifact(session.state, artifactId);
  if (!artifact || artifact.versions.length === 0) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'CONTEXT_NOT_PUBLISHED',
      'No Business Context version has been published for this Workspace.',
    );
  }
  const versions = [...artifact.versions]
    .sort((left, right) => right.version - left.version)
    .map((version) => ({
      version: version.version,
      published_at: version.published_at,
      published_by: findUserById(session.state, version.published_by)?.username ?? null,
      content_hash: version.content_hash,
      entry_count: version.entries.length,
      common_business_context_version: version.pins.common_version,
      previous_workspace_business_context_version: version.pins.previous_version,
      affected_artifacts: affectedArtifacts(session, options.workspaceId, version.version),
    }));
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { versions_returned: versions.length },
  });
  return { workspace_id: options.workspaceId, versions };
}

