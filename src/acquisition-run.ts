import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  adoptedIntegrationVersion,
  findIntegrationConfiguration,
  HTTP_JSON_CONNECTOR,
  ISO_TIMESTAMP,
  type AcquisitionCheckpointState,
  type AcquisitionConnectionArtifact,
  type AcquisitionConnectionVersion,
  type AcquisitionPlanRecord,
  type AcquisitionPlanWindow,
  type AcquisitionRunRecord,
  type IntegrationBatchRecord,
  type SourceAcquisitionArtifact,
  type SourceAcquisitionVersion,
  type SourceRecord,
} from './catalog.js';
import { assertConnectivityEnabled, assertWorkersEnabled } from './backup.js';
import {
  admitRun,
  enrolRun,
  releaseRun,
  requeueRun,
} from './connection-session.js';
import { runConnector } from './connector.js';
import { releaseDatasetFor } from './datasets.js';
import { OperatorError, type Fail } from './errors.js';
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

function adoptedAcquisition(session: PlatformSession, sourceId: string): SourceAcquisitionVersion | undefined {
  const artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === sourceId);
  if (!artifact || artifact.adopted_version === null) return undefined;
  return artifact.versions.find((candidate) => candidate.version === artifact.adopted_version);
}

function connectionVersionOf(
  session: PlatformSession,
  acquisition: SourceAcquisitionVersion,
): AcquisitionConnectionVersion | undefined {
  return session.state.acquisition_connections
    .find((candidate) => candidate.connection_id === acquisition.connection_id)
    ?.versions.find((candidate) => candidate.version === acquisition.connection_version);
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
  scheduledFor: string | null,
  backfill: { start: string; end: string } | null,
  rerunOf: string | null = null,
): AcquisitionRunRecord {
  const run: AcquisitionRunRecord = {
    acquisition_run_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    mode: 'connector',
    trigger,
    backfill,
    rerun_of: rerunOf,
    integration_configuration_version: adoptedIntegrationVersion(
      findIntegrationConfiguration(session.state.integration_configurations, source.source_id),
    )?.version ?? null,
    attempts: 0,
    status: 'queued',
    queued_at: queuedAt,
    scheduled_for: scheduledFor,
    started_at: null,
    completed_at: null,
    raw_acquisition_ids: [],
    error_code: null,
  };
  session.state.acquisition_runs.push(run);
  // The Connection's durable queue is the one order every Source and worker
  // shares, so the Run takes its place at the instant it was requested.
  const acquisition = adoptedAcquisition(session, source.source_id);
  const connection = acquisition === undefined
    ? undefined
    : session.state.acquisition_connections.find(
      (candidate) => candidate.connection_id === acquisition.connection_id,
    );
  if (connection !== undefined) enrolRun(session, connection, run);
  session.audit({
    ...context,
    actor,
    outcome: 'succeeded',
    detail: { acquisition_run_id: run.acquisition_run_id, trigger },
  });
  return run;
}

function readBackfill(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  from: string | undefined,
  to: string | undefined,
): { start: string; end: string } | null {
  if (from === undefined && to === undefined) return null;
  if (from === undefined || to === undefined) {
    reject(session, actor, context, 'ACQUISITION_BACKFILL_INVALID', 'A manual backfill states both the start and the end of its window.');
  }
  if (!ISO_TIMESTAMP.test(from) || !Number.isFinite(Date.parse(from)) || !ISO_TIMESTAMP.test(to) || !Number.isFinite(Date.parse(to))) {
    reject(session, actor, context, 'ACQUISITION_BACKFILL_INVALID', 'A manual backfill states two ISO instants.');
  }
  if (Date.parse(to) <= Date.parse(from)) {
    reject(session, actor, context, 'ACQUISITION_BACKFILL_INVALID', 'A manual backfill must end after it starts.');
  }
  return { start: from, end: to };
}

export function enqueueAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  from?: string;
  to?: string;
  /** The Run this manual request reruns, so the ledger links one request to the next. */
  rerunOf?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_enqueue', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  requireConnectorSource(session, actorLabel(actor.user), scoped, source);
  const backfill = readBackfill(session, actorLabel(actor.user), scoped, options.from, options.to);
  if (options.rerunOf !== undefined && options.rerunOf !== '') {
    const previous = session.state.acquisition_runs.find(
      (candidate) => candidate.acquisition_run_id === options.rerunOf && candidate.source_id === source.source_id,
    );
    if (!previous) {
      reject(session, actorLabel(actor.user), scoped, 'ACQUISITION_RUN_NOT_FOUND', 'No Acquisition Run of this Source has this identifier.');
    }
  }
  const run = queueRun(
    session,
    source,
    actorLabel(actor.user),
    scoped,
    'manual',
    new Date().toISOString(),
    null,
    backfill,
    options.rerunOf === undefined || options.rerunOf === '' ? null : options.rerunOf,
  );
  session.save();
  return {
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    trigger: run.trigger,
    backfill: run.backfill,
    rerun_of: run.rerun_of ?? null,
    queued_at: run.queued_at,
  };
}

/**
 * Cancels one Run that has not started reading.
 *
 * A cancelled Run leaves its Connection's durable queue immediately, emits no
 * Plan, no Integration Batch, and no Dataset Release, and reads nothing from the
 * endpoint. It stays in the Run ledger as the reason the work never happened.
 */
export function cancelAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  runId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_cancel', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const run = session.state.acquisition_runs.find(
    (candidate) => candidate.acquisition_run_id === options.runId,
  );
  if (!run) {
    reject(session, actorLabel(actor.user), context, 'ACQUISITION_RUN_NOT_FOUND', 'No Acquisition Run has this identifier.');
  }
  const source = requireAdministeredSource(session, actor, context, run.source_id);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  if (run.status !== 'queued') {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_RUN_NOT_CANCELLABLE',
      'Only a Run that has not started reading may be cancelled.',
      'Inspect the Run; a started attempt either completes its Plan or fails on its own.',
    );
  }
  const acquisition = adoptedAcquisition(session, source.source_id);
  const connection = acquisition === undefined
    ? undefined
    : session.state.acquisition_connections.find((candidate) => candidate.connection_id === acquisition.connection_id);
  if (connection !== undefined) {
    releaseRun({ session, connection, run, at: new Date().toISOString() });
  }
  run.status = 'cancelled';
  run.error_code = 'ACQUISITION_RUN_CANCELLED';
  run.completed_at = new Date().toISOString();
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { acquisition_run_id: run.acquisition_run_id, status: run.status },
  });
  session.save();
  return {
    acquisition_run_id: run.acquisition_run_id,
    source_id: source.source_id,
    status: run.status,
    error_code: run.error_code,
  };
}

/** Reports how much queued work one Source is holding, so nothing is dropped silently. */
export function acquisitionQueue(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
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

/**
 * Captures the one half-open interval this attempt reads.
 *
 * The upper bound is read once, here, and stored on the Plan. A later clock
 * reading therefore cannot extend a Plan that is already durable, and a Run
 * that catches up over a long gap is split into consecutive bounded windows
 * rather than one unbounded read.
 */
function captureWindow(
  acquisition: SourceAcquisitionVersion,
  checkpoint: AcquisitionCheckpointState | null,
  backfill: { start: string; end: string } | null,
  at: string,
): AcquisitionPlanWindow | null {
  if (backfill !== null) {
    return {
      mode: 'backfill',
      start: backfill.start,
      end: backfill.end,
      lookback_minutes: 0,
      end_inclusive: false,
      captured_at: at,
    };
  }
  const policy = acquisition.window;
  if (policy === null) return null;
  if (policy.mode === 'fixed') {
    return {
      mode: 'fixed',
      start: policy.initial_start,
      end: policy.initial_end ?? policy.initial_start,
      lookback_minutes: policy.lookback_minutes,
      end_inclusive: policy.end_inclusive,
      captured_at: at,
    };
  }
  const watermark = checkpoint?.watermark ?? policy.initial_start;
  const start = new Date(Date.parse(watermark) - policy.lookback_minutes * 60_000).toISOString();
  const ceiling = Date.parse(start) + policy.maximum_span_minutes * 60_000;
  const captured = Math.min(Date.parse(at), ceiling);
  return {
    mode: 'incremental',
    start,
    end: new Date(Math.max(Date.parse(start), captured)).toISOString(),
    lookback_minutes: policy.lookback_minutes,
    end_inclusive: policy.end_inclusive,
    captured_at: at,
  };
}

function checkpointView(checkpoint: AcquisitionCheckpointState | null): { watermark: string | null; cursor: string | null } {
  return { watermark: checkpoint?.watermark ?? null, cursor: checkpoint?.cursor ?? null };
}

/**
 * Works the oldest queued Run for one Source.
 *
 * The Plan is durable before the first request. Only a Plan whose every page
 * completed hands over an Integration Batch and releases a Dataset; a failed or
 * partial attempt keeps its diagnostic Raw Acquisitions, leaves the current
 * governed data exactly where it was, and never advances the checkpoint.
 */
export async function workAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  at?: string;
}): Promise<Record<string, unknown>> {
  // A restored Deployment keeps its workers closed until an Operator reopens
  // them, so a disaster recovery never resumes background writes by itself.
  assertWorkersEnabled(options.root);
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_work', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  requireConnectorSource(session, actorLabel(actor.user), scoped, source);
  // Connectivity is judged before the Run is claimed, so a refused attempt
  // leaves the queued Run exactly where it was rather than stranding it running.
  assertConnectivityEnabled(options.root);

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
  const connection: AcquisitionConnectionArtifact | undefined = session.state.acquisition_connections
    .find((candidate) => candidate.connection_id === acquisition.connection_id);
  const connectionVersion = connectionVersionOf(session, acquisition);
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

  const at = options.at ?? new Date().toISOString();
  if (!ISO_TIMESTAMP.test(at) || !Number.isFinite(Date.parse(at))) {
    fail('ACQUISITION_WORK_AT_INVALID', 'The worker clock must be an ISO instant.');
  }

  // Admission is decided before anything is read, so a paced Run stays queued
  // rather than failing, and its place in the Connection's queue is durable.
  const admission = admitRun({
    session,
    connection,
    policy: connectionVersion.pacing,
    run,
    at,
  });
  if (!admission.admitted) {
    if (admission.dirty) session.save();
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: {
        acquisition_run_id: run.acquisition_run_id,
        paced: admission.reason ?? 'none',
        queue_position: admission.position,
      },
    });
    return {
      acquisition_run_id: run.acquisition_run_id,
      status: 'queued',
      trigger: run.trigger,
      paced: true,
      pacing_reason: admission.reason,
      queue_position: admission.position,
      not_before: admission.not_before,
      plan: null,
      raw_acquisition_count: 0,
      raw_acquisition_ids: [],
      batch_raw_acquisition_count: null,
      integration_batch_id: null,
      dataset_release: null,
      records: null,
      error_code: null,
    };
  }

  const artifact: SourceAcquisitionArtifact | undefined = session.state.source_acquisitions
    .find((candidate) => candidate.source_id === source.source_id);
  const checkpointBefore = artifact?.checkpoint ?? null;
  const window = captureWindow(acquisition, checkpointBefore, run.backfill, at);
  const useCursor = connectionVersion.pagination.mode === 'cursor';
  const startCursor = useCursor && checkpointBefore?.cursor_state !== 'invalid'
    ? checkpointBefore?.cursor ?? null
    : null;

  const plan: AcquisitionPlanRecord = {
    plan_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    trigger: run.trigger,
    connector: { ...acquisition.connector },
    connection_id: acquisition.connection_id,
    connection_version: connectionVersion.version,
    acquisition_configuration_version: acquisition.version,
    integration_configuration_version: integration.version,
    pages: [],
    window,
    start_cursor: startCursor,
    checkpoint_before: checkpointView(checkpointBefore),
    checkpoint_after: checkpointView(checkpointBefore),
    end_cursor: null,
    status: 'planned',
    created_at: at,
    completed_at: null,
  };
  session.state.acquisition_plans.push(plan);
  run.status = 'running';
  run.attempts += 1;
  run.started_at = at;
  session.save();

  const outcome = await runConnector({
    session,
    plan,
    connection,
    connectionVersion,
    acquisition,
  });
  run.raw_acquisition_ids = outcome.rawIds;
  // The attempt completes on the clock that planned it, so a worker given an
  // explicit instant reports one reproducible timeline: a scheduled Run's start
  // and publication latencies are facts of the ledger, not of the test harness.
  run.completed_at = at;
  plan.completed_at = run.completed_at;

  if (!outcome.complete) {
    plan.status = 'partial';
    if (outcome.errorCode === 'ACQUISITION_PACING_RATE_EXCEEDED') {
      // A rate refusal is not a failure of the attempt: the Run returns to the
      // front of the queue and its next attempt plans again rather than
      // continuing a Plan whose fragments are already known to be incomplete.
      run.status = 'queued';
      run.completed_at = null;
      plan.status = 'partial';
      requeueRun({
        session,
        connection,
        run,
        at: new Date().toISOString(),
        notBefore: null,
      });
    } else {
      run.status = 'failed';
      run.error_code = outcome.errorCode;
      releaseRun({ session, connection, run, at: new Date().toISOString() });
      if (outcome.errorCode === 'ACQUISITION_CHECKPOINT_CURSOR_INVALID' && artifact !== undefined) {
        artifact.checkpoint = {
          watermark: artifact.checkpoint?.watermark ?? null,
          cursor: artifact.checkpoint?.cursor ?? null,
          cursor_state: 'invalid',
          updated_at: new Date().toISOString(),
          generation: (artifact.checkpoint?.generation ?? 0) + 1,
        };
        plan.checkpoint_after = checkpointView(artifact.checkpoint);
      }
    }
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
      plan: { ...plan, pages: plan.pages.map((page) => ({ ...page, failed_attempts: page.failed_attempts.map((entry) => ({ ...entry })) })) },
      raw_acquisition_count: outcome.rawIds.length,
      raw_acquisition_ids: outcome.rawIds,
      batch_raw_acquisition_count: null,
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
    raw_acquisition_ids: outcome.batchIds,
    created_at: new Date().toISOString(),
    quarantined_at: null,
    quarantine_error_code: null,
  };
  session.state.integration_batches.push(batch);
  run.status = 'complete';
  run.error_code = null;
  run.integration_configuration_version = integration.version;
  plan.status = 'complete';
  session.save();

  // A complete Plan is the only thing that advances governed data, and it does so
  // through the same Dataset Release path a manual acquisition uses.
  let released: Record<string, unknown>;
  try {
    released = releaseDatasetFor(session, actor, source);
  } catch (error) {
    // Integration refused the Batch: it is quarantined so it never governs a
    // Release, the checkpoint stays exactly where it was, and the operator sees
    // the drift as a failed Run rather than a silently missing column.
    const code = error instanceof OperatorError ? error.code : 'ACQUISITION_SCHEMA_DRIFT';
    batch.quarantined_at = new Date().toISOString();
    batch.quarantine_error_code = code;
    run.status = 'failed';
    run.error_code = 'ACQUISITION_SCHEMA_DRIFT';
    plan.status = 'failed';
    plan.checkpoint_after = checkpointView(artifact?.checkpoint ?? null);
    releaseRun({ session, connection, run, at: new Date().toISOString() });
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: {
        acquisition_run_id: run.acquisition_run_id,
        plan_id: plan.plan_id,
        integration_batch_id: batch.batch_id,
        error_code: 'ACQUISITION_SCHEMA_DRIFT',
        integration_error_code: code,
      },
    });
    session.save();
    throw error;
  }

  // The checkpoint advances only after the Release the attempt produced exists,
  // so an interrupted Run either governs a whole Plan or nothing at all.
  if (artifact !== undefined) {
    const previous = artifact.checkpoint;
    let next: AcquisitionCheckpointState | null = previous;
    if (window !== null && window.mode === 'incremental') {
      next = {
        watermark: window.end,
        cursor: useCursor ? plan.end_cursor : previous?.cursor ?? null,
        cursor_state: 'valid',
        updated_at: new Date().toISOString(),
        generation: (previous?.generation ?? 0) + 1,
      };
    } else if (useCursor) {
      next = {
        watermark: previous?.watermark ?? null,
        cursor: plan.end_cursor,
        cursor_state: 'valid',
        updated_at: new Date().toISOString(),
        generation: (previous?.generation ?? 0) + 1,
      };
    }
    artifact.checkpoint = next;
    plan.checkpoint_after = checkpointView(next);
  }

  releaseRun({ session, connection, run, at: new Date().toISOString() });
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      acquisition_run_id: run.acquisition_run_id,
      plan_id: plan.plan_id,
      integration_batch_id: batch.batch_id,
      raw_acquisition_count: outcome.rawIds.length,
      batch_raw_acquisition_count: outcome.batchIds.length,
      connector_version: plan.connector.version,
    },
  });
  session.save();
  return {
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    trigger: run.trigger,
    plan: { ...plan, pages: plan.pages.map((page) => ({ ...page, failed_attempts: page.failed_attempts.map((entry) => ({ ...entry })) })) },
    raw_acquisition_count: outcome.rawIds.length,
    raw_acquisition_ids: outcome.rawIds,
    batch_raw_acquisition_count: batch.raw_acquisition_ids.length,
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
  assertWorkersEnabled(options.root);
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
    const connectionVersion = connectionVersionOf(session, acquisition);
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
    const run = queueRun(session, source, actorLabel(actor.user), scoped, 'scheduled', at, new Date(dueAt).toISOString(), null);
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

/** Reads the durable resume point of one Source. */
export function acquisitionCheckpoint(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_checkpoint_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === source.source_id);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      watermark: artifact?.checkpoint?.watermark ?? '',
      cursor_state: artifact?.checkpoint?.cursor_state ?? '',
    },
  });
  return {
    source_id: source.source_id,
    checkpoint: artifact?.checkpoint === undefined || artifact.checkpoint === null
      ? null
      : { ...artifact.checkpoint },
  };
}

/**
 * Clears the cursor of one Source so a refused cursor stops blocking it.
 *
 * The watermark is kept: recovering from a cursor the endpoint no longer
 * honours must not re-read everything the Source already governed.
 */
export function resetAcquisitionCheckpoint(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_checkpoint_reset', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === source.source_id);
  if (!artifact) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_CONFIGURATION_NOT_ADOPTED',
      'The Source has no acquisition configuration Artifact to hold a checkpoint.',
      'Publish an acquisition configuration for the Source.',
    );
  }
  const previous = artifact.checkpoint;
  artifact.checkpoint = {
    watermark: previous?.watermark ?? null,
    cursor: null,
    cursor_state: 'valid',
    updated_at: new Date().toISOString(),
    generation: (previous?.generation ?? 0) + 1,
  };
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { checkpoint_reset: true } });
  session.save();
  return { source_id: source.source_id, checkpoint: { ...artifact.checkpoint } };
}

/**
 * Reads the immutable Acquisition Plan — the manifest — one Run attempt left,
 * together with the Raw Acquisition inventory that attempt kept.
 *
 * The Plan is durable before the first request and after every page, so a later
 * process reads exactly the fragments and window the attempt really used rather
 * than reconstructing them from the current checkpoint.
 */
export function readAcquisitionPlan(options: {
  root: string;
  masterKey: string;
  token: string;
  runId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'acquisition_plan_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const run = session.state.acquisition_runs.find(
    (candidate) => candidate.acquisition_run_id === options.runId,
  );
  if (!run) {
    reject(session, actorLabel(actor.user), context, 'ACQUISITION_RUN_NOT_FOUND', 'No Acquisition Run has this identifier.');
  }
  const source = requireAdministeredSource(session, actor, context, run.source_id);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const plan = [...session.state.acquisition_plans]
    .reverse()
    .find((candidate) => candidate.acquisition_run_id === run.acquisition_run_id);
  if (!plan) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_PLAN_NOT_FOUND',
      'This Run has not durably planned an attempt.',
      'Work the Run so its Plan is durable before reading its manifest.',
    );
  }
  const rawAcquisitions = session.state.raw_acquisitions
    .filter((raw) => raw.acquisition_run_id === run.acquisition_run_id)
    .map((raw) => ({
      raw_id: raw.raw_id,
      content_hash: raw.content_hash,
      byte_length: raw.byte_length,
      received_at: raw.received_at,
    }));
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      acquisition_run_id: run.acquisition_run_id,
      plan_id: plan.plan_id,
      raw_acquisition_count: rawAcquisitions.length,
    },
  });
  return {
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    plan: {
      ...plan,
      window: plan.window === null ? null : { ...plan.window },
      checkpoint_before: plan.checkpoint_before === null ? null : { ...plan.checkpoint_before },
      checkpoint_after: plan.checkpoint_after === null ? null : { ...plan.checkpoint_after },
      pages: plan.pages.map((page) => ({
        ...page,
        failed_attempts: page.failed_attempts.map((attempt) => ({ ...attempt })),
      })),
    },
    raw_acquisitions: rawAcquisitions,
  };
}

/** The Sources of a Workspace and the acquisition state each one holds. */
export function listSourceAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
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
        checkpoint: acquisition?.checkpoint === undefined || acquisition.checkpoint === null
          ? null
          : { ...acquisition.checkpoint },
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
