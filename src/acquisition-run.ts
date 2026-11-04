import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  adoptedIntegrationVersion,
  findIntegrationConfiguration,
  HTTP_JSON_CONNECTOR,
  type AcquisitionConnectionVersion,
  type AcquisitionPlanRecord,
  type AcquisitionRunRecord,
  type IntegrationBatchRecord,
  type SourceAcquisitionVersion,
  type SourceRecord,
} from './catalog.js';
import { runConnector } from './connector.js';
import { releaseDataset } from './datasets.js';
import type { Fail } from './errors.js';
import { isDeploymentAdministrator, workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

/** A Source acquired by a connector is refused a hand upload, and the reverse. */
function requireConnectorSource(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  source: SourceRecord,
): void {
  if (source.type !== 'http_json') {
    reject(
      session,
      actor,
      context,
      'ACQUISITION_CONNECTOR_NOT_APPLICABLE',
      'This Source is not acquired by a connector, so it cannot be queued or run.',
      'Upload its bytes, or configure it as a JSON endpoint Source.',
    );
  }
}

function queuedRunFor(
  session: PlatformSession,
  sourceId: string,
): AcquisitionRunRecord | undefined {
  return session.state.acquisition_runs.find(
    (run) => run.source_id === sourceId && (run.status === 'queued' || run.status === 'running'),
  );
}

/**
 * Queues one Acquisition Run. A trigger never acquires inline and never
 * replaces pending work: a Run is a durable request the worker picks up in order.
 */
function queueRun(
  session: PlatformSession,
  source: SourceRecord,
  actor: string,
  context: ActionContext,
  trigger: 'manual' | 'scheduled',
  queuedAt: string,
): AcquisitionRunRecord {
  const run: AcquisitionRunRecord = {
    acquisition_run_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    mode: 'connector',
    trigger,
    integration_configuration_version: adoptedIntegrationVersion(
      findIntegrationConfiguration(session.state.integration_configurations, source.source_id),
    )?.version ?? null,
    attempts: 0,
    status: 'queued',
    queued_at: queuedAt,
    started_at: null,
    completed_at: null,
    raw_acquisition_ids: [],
    error_code: null,
  };
  session.state.acquisition_runs.push(run);
  session.audit({
    ...context,
    actor,
    outcome: 'succeeded',
    detail: { acquisition_run_id: run.acquisition_run_id, trigger },
  });
  return run;
}

export function enqueueAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_enqueue', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  requireConnectorSource(session, actorLabel(actor.user), scoped, source);
  const run = queueRun(session, source, actorLabel(actor.user), scoped, 'manual', new Date().toISOString());
  session.save();
  return {
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    trigger: run.trigger,
    queued_at: run.queued_at,
  };
}

/** Reports how much queued work one Source is holding, so nothing is dropped silently. */
export function acquisitionQueue(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_queue_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const runs = session.state.acquisition_runs.filter((run) => run.source_id === source.source_id);
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { queued: runs.filter((run) => run.status === 'queued').length } });
  return {
    source_id: source.source_id,
    queued: runs.filter((run) => run.status === 'queued').length,
    running: runs.filter((run) => run.status === 'running').length,
    completed: runs.filter((run) => run.status === 'complete').length,
    failed: runs.filter((run) => run.status === 'failed').length,
    runs: runs.map((run) => ({
      acquisition_run_id: run.acquisition_run_id,
      status: run.status,
      trigger: run.trigger,
      queued_at: run.queued_at,
      completed_at: run.completed_at,
    })),
  };
}

function adoptedAcquisition(session: PlatformSession, sourceId: string): SourceAcquisitionVersion | undefined {
  const artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === sourceId);
  if (!artifact || artifact.adopted_version === null) return undefined;
  return artifact.versions.find((candidate) => candidate.version === artifact.adopted_version);
}

/**
 * Works the oldest queued Run for one Source.
 *
 * The Plan is durable before the first request. Only a Plan whose every page
 * completed hands over an Integration Batch and releases a Dataset; a failed or
 * partial attempt keeps its diagnostic Raw Acquisitions and leaves the current
 * governed data exactly where it was.
 */
export async function workAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_work', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  requireConnectorSource(session, actorLabel(actor.user), scoped, source);

  const run = session.state.acquisition_runs.find(
    (candidate) => candidate.source_id === source.source_id && candidate.status === 'queued',
  );
  if (!run) {
    fail('ACQUISITION_QUEUE_EMPTY', 'This Source has no queued Acquisition Run to work.', 'Queue a Run before asking for work.');
  }
  const acquisition = adoptedAcquisition(session, source.source_id);
  if (!acquisition) {
    fail(
      'ACQUISITION_CONFIGURATION_NOT_ADOPTED',
      'The Source has no adopted acquisition configuration Version to execute.',
      'Publish an acquisition configuration for the Source and adopt the exact version.',
    );
  }
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === acquisition.connection_id,
  );
  const connectionVersion: AcquisitionConnectionVersion | undefined = connection?.versions.find(
    (candidate) => candidate.version === acquisition.connection_version,
  );
  if (!connection || !connectionVersion) {
    fail(
      'CONNECTION_VERSION_NOT_FOUND',
      'The Connection Version this acquisition configuration pins is not available.',
      'Republish the Connection and adopt the exact version the Source pins.',
    );
  }
  const integration = adoptedIntegrationVersion(
    findIntegrationConfiguration(session.state.integration_configurations, source.source_id),
  );
  if (!integration) {
    fail(
      'SOURCE_INTEGRATION_NOT_ADOPTED',
      'The Source has no adopted Integration Configuration Version to integrate against.',
      'Publish an Integration Configuration for the Source and adopt the exact version.',
    );
  }

  const plan: AcquisitionPlanRecord = {
    plan_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    trigger: run.trigger,
    connector: { ...acquisition.connector },
    connection_id: connection.connection_id,
    connection_version: connectionVersion.version,
    acquisition_configuration_version: acquisition.version,
    integration_configuration_version: integration.version,
    pages: [],
    status: 'planned',
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  session.state.acquisition_plans.push(plan);
  run.status = 'running';
  run.attempts += 1;
  run.started_at = new Date().toISOString();
  session.save();

  const outcome = await runConnector({
    session,
    plan,
    connection,
    connectionVersion,
    acquisition,
  });
  run.raw_acquisition_ids = outcome.rawIds;
  run.completed_at = new Date().toISOString();
  plan.completed_at = run.completed_at;

  if (!outcome.complete) {
    run.status = 'failed';
    run.error_code = outcome.errorCode;
    plan.status = 'partial';
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: {
        acquisition_run_id: run.acquisition_run_id,
        plan_id: plan.plan_id,
        error_code: outcome.errorCode ?? 'ACQUISITION_FAILED',
        raw_acquisition_count: outcome.rawIds.length,
      },
    });
    session.save();
    return {
      acquisition_run_id: run.acquisition_run_id,
      status: run.status,
      trigger: run.trigger,
      plan: { ...plan, pages: plan.pages.map((page) => ({ ...page })) },
      raw_acquisition_count: outcome.rawIds.length,
      integration_batch_id: null,
      dataset_release: null,
      records: null,
      error_code: outcome.errorCode,
    };
  }

  const batch: IntegrationBatchRecord = {
    batch_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    integration_configuration_version: integration.version,
    integration_configuration_content_hash: integration.content_hash,
    raw_acquisition_ids: outcome.rawIds,
    created_at: new Date().toISOString(),
  };
  session.state.integration_batches.push(batch);
  run.status = 'complete';
  run.error_code = null;
  run.integration_configuration_version = integration.version;
  plan.status = 'complete';
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      acquisition_run_id: run.acquisition_run_id,
      plan_id: plan.plan_id,
      integration_batch_id: batch.batch_id,
      raw_acquisition_count: outcome.rawIds.length,
      connector_version: plan.connector.version,
    },
  });
  session.save();

  // A complete Plan is the only thing that advances governed data, and it does so
  // through the same Dataset Release path a manual acquisition uses.
  const released = releaseDataset({
    root: options.root,
    masterKey: options.masterKey,
    token: options.token,
    sourceId: source.source_id,
  });
  return {
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    trigger: run.trigger,
    plan: { ...plan, pages: plan.pages.map((page) => ({ ...page })) },
    raw_acquisition_count: outcome.rawIds.length,
    integration_batch_id: batch.batch_id,
    dataset_release: released['dataset_release'] ?? null,
    records: released['record_count'] ?? null,
    error_code: null,
  };
}

/**
 * Queues one Run for every Source whose adopted schedule is due at the stated
 * instant. A Source holding queued or running work is left alone, so a schedule
 * tick never duplicates a Run and never drops one.
 */
export function tickSchedules(options: {
  root: string;
  masterKey: string;
  token: string;
  at?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_schedule_tick', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const at = options.at ?? new Date().toISOString();
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) {
    reject(session, actorLabel(actor.user), context, 'ACQUISITION_SCHEDULE_AT_INVALID', 'The schedule tick must state an ISO instant.');
  }

  const enqueued: Array<Record<string, unknown>> = [];
  for (const source of session.state.sources) {
    if (source.type !== 'http_json') continue;
    const administers = workspaceRoleOf(session.state, actor.user.user_id, source.workspace_id) === 'Workspace Administrator';
    if (!administers && !isDeploymentAdministrator(actor.user)) continue;
    if (queuedRunFor(session, source.source_id) !== undefined) continue;

    const acquisition = adoptedAcquisition(session, source.source_id);
    if (!acquisition) continue;
    const connection = session.state.acquisition_connections.find(
      (candidate) => candidate.connection_id === acquisition.connection_id,
    );
    const connectionVersion = connection?.versions.find((candidate) => candidate.version === acquisition.connection_version);
    const schedule = connectionVersion?.schedule ?? null;
    if (schedule === null) continue;

    const lastComplete = [...session.state.acquisition_runs]
      .reverse()
      .find((run) => run.source_id === source.source_id && run.status === 'complete' && run.completed_at !== null);
    const dueAt = lastComplete === undefined
      ? Date.parse(source.created_at)
      : Date.parse(lastComplete.completed_at!) + schedule.every_minutes * 60_000;
    if (atMs < dueAt) continue;

    const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
    const run = queueRun(session, source, actorLabel(actor.user), scoped, 'scheduled', at);
    enqueued.push({
      source_id: source.source_id,
      acquisition_run_id: run.acquisition_run_id,
      due_at: new Date(dueAt).toISOString(),
    });
  }
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { at, enqueued: enqueued.length },
  });
  session.save();
  return { at, enqueued };
}

/** The Sources of a Workspace and the acquisition state each one holds. */
export function listSourceAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'source_acquisition_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  if (workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId) === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const sources = session.state.sources
    .filter((source) => source.workspace_id === options.workspaceId)
    .map((source) => {
      const acquisition = session.state.source_acquisitions.find((candidate) => candidate.source_id === source.source_id);
      const runs = session.state.acquisition_runs.filter((run) => run.source_id === source.source_id);
      return {
        source_id: source.source_id,
        name: source.name,
        type: source.type,
        connector: source.type === 'http_json' ? { ...HTTP_JSON_CONNECTOR } : null,
        adopted_acquisition_configuration_version: acquisition?.adopted_version ?? null,
        queued: runs.filter((run) => run.status === 'queued').length,
        last_run: runs.length === 0
          ? null
          : {
            acquisition_run_id: runs[runs.length - 1]!.acquisition_run_id,
            status: runs[runs.length - 1]!.status,
            completed_at: runs[runs.length - 1]!.completed_at,
          },
      };
    });
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { sources_returned: sources.length } });
  return { workspace_id: options.workspaceId, sources };
}
