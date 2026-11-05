import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
  type Actor,
} from './authz.js';
import {
  DEFAULT_DOCUMENT_PARSE_LIMITS,
  findDataset,
  findIntegrationConfiguration,
  findSource,
  latestDatasetRelease,
  type DatasetReleaseRecord,
  type SourceRecord,
  type SourceType,
} from './catalog.js';
import { OperatorError } from './errors.js';
import { workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const SOURCE_TYPES: SourceType[] = ['file', 'http_json', 'document', 'scraper'];
const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;

export function isSourceType(value: string): value is SourceType {
  return SOURCE_TYPES.includes(value as SourceType);
}

/**
 * Resolves a Source the actor administers. A Source in a Workspace the actor
 * cannot administer answers exactly like one that does not exist, so the
 * identifier never discloses another Workspace's content.
 */
export function requireAdministeredSource(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  sourceId: string,
): SourceRecord {
  const source = findSource(session.state.sources, sourceId);
  const scoped: ActionContext = source === undefined
    ? context
    : { ...context, workspace_id: source.workspace_id, target: source.source_id };
  if (!source || workspaceRoleOf(session.state, actor.user.user_id, source.workspace_id) !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), scoped, 'SOURCE_NOT_AVAILABLE', 'The Source is not available to this actor.');
  }
  return source;
}

/**
 * The refusal a browser upload sees. A Workspace member who lacks administration
 * is explicitly forbidden, while a non-member reads the very same answer as an
 * identifier that names nothing, so no foreign identifier confirms existence.
 */
export function requireAdministrableSource(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  sourceId: string,
): SourceRecord {
  const source = findSource(session.state.sources, sourceId);
  if (source !== undefined) {
    const role = workspaceRoleOf(session.state, actor.user.user_id, source.workspace_id);
    if (role === 'Workspace Administrator') return source;
    if (role !== null) {
      session.audit({
        ...context,
        workspace_id: source.workspace_id,
        target: source.source_id,
        actor: actorLabel(actor.user),
        outcome: 'denied',
        detail: { error_code: 'SOURCE_NOT_AVAILABLE' },
      });
      throw new OperatorError(
        'SOURCE_NOT_AVAILABLE',
        'The Source is not available to this actor.',
        undefined,
        403,
      );
    }
  }
  deny(session, actorLabel(actor.user), context, 'SOURCE_NOT_AVAILABLE', 'The Source is not available to this actor.');
}

/** The Sources of one administered Workspace, named without any raw content. */
export function listWorkspaceSources(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'source_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  return {
    workspace_id: options.workspaceId,
    sources: session.state.sources
      .filter((source) => source.workspace_id === options.workspaceId)
      .map((source) => ({
        source_id: source.source_id,
        name: source.name,
        type: source.type,
        created_at: source.created_at,
      })),
  };
}

function releaseSummary(release: DatasetReleaseRecord): Record<string, unknown> {
  return {
    release: release.release,
    created_at: release.created_at,
    record_count: release.record_count,
    record_rejection_count: release.record_rejections.length,
    records_hash: release.records_hash,
    integration_configuration_version: release.integration_configuration_version,
    provenance: {
      batch_ids: [...release.provenance.batch_ids],
      acquisition_run_ids: [...release.provenance.acquisition_run_ids],
      raw_acquisition_ids: [...release.provenance.raw_acquisition_ids],
      acquired_at: release.provenance.acquired_at,
      integrated_at: release.provenance.integrated_at,
    },
    ...(release.document_processing === undefined
      ? {}
      : {
        document_processing: {
          parser: { ...release.document_processing.parser },
          limits: { ...release.document_processing.limits },
        },
      }),
  };
}

/**
 * The one administered Source as the browser configures it: the immutable
 * Configuration Versions, the exact Releases they produced, the Runs that
 * acquired the bits, and the most recent acquisition Provenance. Raw object
 * locators and bytes never enter this view.
 */
export function showWorkspaceSource(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'source_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  const artifact = findIntegrationConfiguration(session.state.integration_configurations, source.source_id);
  const dataset = findDataset(session.state.datasets, source.source_id);
  const latest = latestDatasetRelease(dataset);
  const batches = session.state.integration_batches.filter((batch) => batch.source_id === source.source_id);
  const lastBatch = batches[batches.length - 1];
  const acquisition = session.state.source_acquisitions.find(
    (candidate) => candidate.source_id === source.source_id,
  );
  const adoptedAcquisition = acquisition?.versions.find(
    (candidate) => candidate.version === acquisition.adopted_version,
  );
  const pinnedConnection = adoptedAcquisition === undefined
    ? undefined
    : session.state.acquisition_connections.find(
      (candidate) => candidate.connection_id === adoptedAcquisition.connection_id,
    );

  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return {
    source: {
      source_id: source.source_id,
      workspace_id: source.workspace_id,
      name: source.name,
      type: source.type,
      created_at: source.created_at,
    },
    configuration: {
      adopted_version: artifact?.adopted_version ?? null,
      versions: (artifact?.versions ?? []).map((version) => ({
        version: version.version,
        published_at: version.published_at,
        content_hash: version.content_hash,
        schema: version.schema.map((field) => ({ ...field })),
        identity_fields: [...version.identity_fields],
        cleaning: version.cleaning.map((rule) => ({ ...rule })),
        mapping: { ...version.mapping },
        document_limits: { ...(version.document_limits ?? DEFAULT_DOCUMENT_PARSE_LIMITS) },
      })),
    },
    // The declarative acquisition configuration and the resume point it holds.
    // No credential, token, or object locator belongs in this view.
    acquisition: {
      adopted_version: acquisition?.adopted_version ?? null,
      checkpoint: acquisition === undefined || acquisition.checkpoint === null
        ? null
        : { ...acquisition.checkpoint },
      versions: (acquisition?.versions ?? []).map((version) => ({
        version: version.version,
        published_at: version.published_at,
        content_hash: version.content_hash,
        connection_id: version.connection_id,
        connection_version: version.connection_version,
        connector: { ...version.connector },
        path: version.path,
        record_path: version.record_path,
        completion: { ...version.completion },
        window: version.window === null ? null : { ...version.window },
        content_type: version.content_type,
      })),
      connection: pinnedConnection === undefined
        ? null
        : {
          connection_id: pinnedConnection.connection_id,
          name: pinnedConnection.name,
          adopted_version: pinnedConnection.adopted_version,
          versions: pinnedConnection.versions.map((version) => ({
            version: version.version,
            base_url: version.base_url,
            credential_ref: version.credential_ref,
            has_credential: version.credential !== null,
            auth_scheme: version.auth.scheme,
            retry: { ...version.retry },
            pacing: { ...version.pacing },
            schedule: version.schedule === null ? null : { ...version.schedule },
            publication_targets: version.publication_targets === null ? null : { ...version.publication_targets },
            content_hash: version.content_hash,
          })),
        },
    },
    dataset: {
      releases: (dataset?.releases ?? []).map((release) => releaseSummary(release)),
      ...(latest === undefined
        ? {}
        : {
          latest: {
            ...releaseSummary(latest),
            record_rejections: latest.record_rejections.map((rejection) => ({ ...rejection })),
          },
        }),
    },
    runs: session.state.acquisition_runs
      .filter((run) => run.source_id === source.source_id)
      .map((run) => ({
        acquisition_run_id: run.acquisition_run_id,
        mode: run.mode,
        trigger: run.trigger,
        status: run.status,
        attempts: run.attempts,
        backfill: run.backfill === null ? null : { ...run.backfill },
        rerun_of: run.rerun_of ?? null,
        queued_at: run.queued_at,
        scheduled_for: run.scheduled_for,
        started_at: run.started_at,
        completed_at: run.completed_at,
        integration_configuration_version: run.integration_configuration_version,
        error_code: run.error_code ?? null,
      })),
    latest_acquisition: lastBatch === undefined
      ? null
      : {
        batch_id: lastBatch.batch_id,
        acquisition_run_id: lastBatch.acquisition_run_id,
        raw_acquisition_ids: [...lastBatch.raw_acquisition_ids],
        created_at: lastBatch.created_at,
        quarantined: lastBatch.quarantined_at !== null,
      },
  };
}

/** Registers a Workspace-owned Source that later acquisitions read from. */
export function createSource(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  type: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'source_creation',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  if (!isSourceType(options.type)) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'SOURCE_TYPE_UNSUPPORTED',
      `The Source type must be one of: ${SOURCE_TYPES.join(', ')}.`,
    );
  }
  const name = options.name.trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actorLabel(actor.user), context, 'SOURCE_NAME_INVALID', 'A Source name must contain 2 to 128 characters.');
  }
  if (session.state.sources.some(
    (source) => source.workspace_id === options.workspaceId && source.name.toLowerCase() === name.toLowerCase(),
  )) {
    reject(session, actorLabel(actor.user), context, 'SOURCE_NAME_TAKEN', 'A Source with this name already exists in this Workspace.');
  }
  const source: SourceRecord = {
    source_id: randomUUID(),
    workspace_id: options.workspaceId,
    name,
    type: options.type,
    owner_user_id: actor.user.user_id,
    created_at: new Date().toISOString(),
  };
  session.state.sources.push(source);
  session.audit({
    ...context,
    target: source.source_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { source_type: source.type },
  });
  session.save();
  return {
    source_id: source.source_id,
    workspace_id: source.workspace_id,
    name: source.name,
    type: source.type,
    owner: actorLabel(actor.user),
    created_at: source.created_at,
  };
}
