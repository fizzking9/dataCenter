import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  BASE_BACKUP_INTERVAL_HOURS,
  CHECKPOINT_INTERVAL_SECONDS,
  OBJECT_REPLICATION_INTERVAL_SECONDS,
  RECOVERY_RETENTION_DAYS,
  RTO_LIMIT_SECONDS,
  backupHealth,
  enableConnectivity,
  enableWorkers,
  listBackups,
  readCheckpoints,
  readRecoveryManifest,
  showBackup,
  verifyBackupSet,
  type CheckpointRecord,
  type RecoveryManifest,
} from './backup.js';
import { assertCondition, OperatorError } from './errors.js';
import { openPlatform } from './session.js';
import { readDeployment, readJsonFile, recordEvidence, writeJsonFile } from './state.js';

/**
 * The Operator Console's recovery surface. Every action here calls the same
 * governed backup module the lifecycle CLI calls; this module adds only what a
 * browser needs and a CLI does not: a configured off-host target, durable
 * restoration progress an Operator can poll, and explicit post-restoration
 * enablement bound to the restored copy.
 */

/** The purposes a step-up grant may unlock. Each names exactly one target. */
export const RECOVERY_PURPOSES = {
  restoration: 'deployment_restoration',
  workers: 'restoration_workers',
  connectivity: 'restoration_connectivity',
} as const;

export type RestorationState = 'running' | 'verified_open' | 'failed';

export interface RestorationStep {
  step: 'accepted' | 'integrity_verified' | 'restoration_verified' | 'restoration_failed' | 'workers_enabled' | 'connectivity_enabled';
  outcome: 'started' | 'succeeded' | 'failed';
  at: string;
}

export interface RestorationRecord {
  schema_version: 1;
  restoration_id: string;
  backup_id: string;
  deployment_id: string | null;
  release: string | null;
  state: RestorationState;
  requested_at: string;
  requested_by: string;
  step_up_verified_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: RestorationStep[];
  verification: Record<string, unknown> | null;
  purge_ledger: Record<string, unknown> | null;
  rto: Record<string, unknown> | null;
  workers_enabled: boolean;
  connectivity_enabled: boolean;
  service_open: boolean;
  error: { code: string; message: string; next_step?: string } | null;
  evidence_id: string | null;
  secrets_included: false;
}

export interface RecoveryTargets {
  /** The Deployment this console serves, which stays untouched by a restoration. */
  root: string;
  /** The off-host directory holding recovery sets and the replicated ledger. */
  backupRoot: string;
  /** Where each isolated restoration is materialized, always a new directory. */
  restoreRoot: string;
}

/** The one backup target this console was started with, or a stated refusal. */
export function assertRecoveryTargets(options: {
  root: string;
  backupRoot?: string;
  restoreRoot?: string;
}): Required<RecoveryTargets> {
  assertCondition(
    options.backupRoot !== undefined && options.backupRoot.trim() !== '',
    'RECOVERY_TARGET_NOT_CONFIGURED',
    'No off-host recovery target is configured for this Operator Console.',
    'Start the Operator Console with the off-host recovery target before inspecting or restoring recovery sets.',
  );
  assertCondition(
    options.restoreRoot !== undefined && options.restoreRoot.trim() !== '',
    'RECOVERY_RESTORE_TARGET_NOT_CONFIGURED',
    'No restoration target directory is configured for this Operator Console.',
    'Start the Operator Console with a restoration target directory before restoring a recovery set.',
  );
  return { root: options.root, backupRoot: options.backupRoot, restoreRoot: options.restoreRoot };
}

function restorationDirectory(root: string): string {
  return join(root, 'recovery', 'restorations');
}

/** One restoration is materialized here, named by its own durable identifier. */
export function restorationTarget(restoreRoot: string, restorationId: string): string {
  return join(restoreRoot, `restoration-${restorationId}`);
}

export function readRestoration(root: string, restorationId: string): RestorationRecord {
  const path = join(restorationDirectory(root), `${restorationId}.json`);
  assertCondition(existsSync(path), 'RESTORATION_NOT_FOUND', 'The restoration does not exist.', 'List the restorations this Operator Console recorded.');
  return readJsonFile<RestorationRecord>(path);
}

function writeRestoration(root: string, record: RestorationRecord): void {
  mkdirSync(restorationDirectory(root), { recursive: true, mode: 0o700 });
  writeJsonFile(join(restorationDirectory(root), `${record.restoration_id}.json`), record);
}

function readRestorations(root: string): RestorationRecord[] {
  const directory = restorationDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile<RestorationRecord>(join(directory, name)))
    .sort((left, right) => Date.parse(left.requested_at) - Date.parse(right.requested_at));
}

/**
 * The restored copy's own state, read from the restored Deployment itself, so
 * whether workers and connectivity may resume is a fact rather than a claim.
 */
function targetView(restoreRoot: string, record: RestorationRecord) {
  const target = restorationTarget(restoreRoot, record.restoration_id);
  if (!existsSync(join(target, 'deployment.json'))) {
    return {
      root: target,
      present: false,
      state: null,
      service_open: false,
      workers_enabled: false,
      connectivity_enabled: false,
    };
  }
  const deployment = readDeployment(target);
  return {
    root: target,
    present: true,
    state: deployment.state,
    service_open: deployment.service_open,
    workers_enabled: deployment.workers_enabled !== false,
    connectivity_enabled: deployment.connectivity_enabled !== false,
  };
}

function recordView(restoreRoot: string, record: RestorationRecord): Record<string, unknown> {
  return { ...record, target: targetView(restoreRoot, record) };
}

/** A step that changed durable progress: appended, never rewritten. */
function appendStep(record: RestorationRecord, step: RestorationStep): void {
  record.progress.push(step);
}

function step(step: RestorationStep['step'], outcome: RestorationStep['outcome']): RestorationStep {
  return { step, outcome, at: new Date().toISOString() };
}

/** Every Operator action is audited on the served Deployment and given evidence. */
function recordOperatorAction(
  root: string,
  masterKey: string,
  operator: string,
  action: string,
  target: string,
  outcome: 'succeeded' | 'failed',
  detail: Record<string, string | number | boolean>,
): string {
  try {
    const session = openPlatform(root, masterKey, 'allow');
    session.audit({
      actor: `operator:${operator}`,
      action,
      scope: 'deployment',
      target,
      outcome,
      detail,
    });
  } catch {
    // A closed Deployment cannot append an Audit Event, but the non-secret
    // evidence below still records what the Operator asked for.
  }
  return recordEvidence(root, action, outcome, operator, detail);
}

function checkpointView(checkpoint: CheckpointRecord): Record<string, unknown> {
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    sequence: checkpoint.sequence,
    created_at: checkpoint.created_at,
    coordinated: checkpoint.coordinated,
    database_position: checkpoint.database.position,
    objects_position: checkpoint.objects.position,
    objects_count: checkpoint.objects.count,
    rpo_interval_seconds: checkpoint.rpo.interval_seconds,
    rpo_limit_seconds: checkpoint.rpo.limit_seconds,
    rpo_met: checkpoint.rpo.met,
    wal_continuous: checkpoint.wal.continuous,
  };
}

/** One listed recovery set with the age and retained window it is judged by. */
function recoverySetView(entry: Record<string, unknown>): Record<string, unknown> {
  const createdAt = stringOf(entry['created_at']);
  return {
    ...entry,
    age_seconds: createdAt === '' ? null : Math.max(0, Math.round((Date.now() - Date.parse(createdAt)) / 1000)),
  };
}

/**
 * The one recovery answer the console renders: how protected the Deployment is
 * right now, which coordinated checkpoints and recovery sets exist, and what
 * the Operator already restored. No key, credential, or secret appears in it.
 */
export function showRecovery(options: RecoveryTargets & { masterKey: string }): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const recoverySets = listBackups({ backupRoot: options.backupRoot });
  const restorations = readRestorations(options.root).map((record) => recordView(options.restoreRoot, record));
  const health = backupHealth(options.root);
  const failed = restorations.filter((record) => asState(record['state']) === 'failed');
  const verified = restorations.filter((record) => asState(record['state']) === 'verified_open');
  // A newer failed verification is degraded recovery health, even while the
  // backup cadence itself is intact: the Operator must see both facts.
  const latestFailure = failed.at(-1);
  const latestSuccess = verified.at(-1);
  const verificationDegraded = latestFailure !== undefined && (
    latestSuccess === undefined
      || Date.parse(stringOf(latestFailure['requested_at'])) > Date.parse(stringOf(latestSuccess['requested_at']))
  );
  const verificationReasons = verificationDegraded ? ['restore_verification_failed'] : [];
  return {
    deployment_id: deployment.deployment_id,
    release: deployment.release,
    state: deployment.state,
    service_open: deployment.service_open,
    restored: deployment.restored ?? null,
    workers_enabled: deployment.workers_enabled !== false,
    connectivity_enabled: deployment.connectivity_enabled !== false,
    backup_root: options.backupRoot,
    restore_root: options.restoreRoot,
    objectives: {
      rpo_limit_seconds: CHECKPOINT_INTERVAL_SECONDS,
      rto_limit_seconds: RTO_LIMIT_SECONDS,
      checkpoint_seconds: CHECKPOINT_INTERVAL_SECONDS,
      object_replication_seconds: OBJECT_REPLICATION_INTERVAL_SECONDS,
      base_backup_hours: BASE_BACKUP_INTERVAL_HOURS,
      retention_days: RECOVERY_RETENTION_DAYS,
    },
    backup: {
      ...health,
      verification_health: verificationDegraded ? 'degraded' : 'healthy',
      verification_reasons: verificationReasons,
    },
    checkpoints: readCheckpoints(options.root).slice(-20).reverse().map(checkpointView),
    recovery_sets: (recoverySets['backups'] as Array<Record<string, unknown>> | undefined ?? []).map(recoverySetView),
    ledger: recoverySets['ledger'] ?? { head_sequence: 0, updated_at: null, entries: 0 },
    restorations,
    checked_at: new Date().toISOString(),
  };
}

function asState(value: unknown): RestorationState | undefined {
  return value === 'running' || value === 'verified_open' || value === 'failed' ? value : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The measured restoration time, or null when the record holds no measurement. */
function rtoSecondsOf(record: RestorationRecord): number | null {
  const value = record.rto?.['seconds'];
  return typeof value === 'number' ? value : null;
}

/** One recovery set with its recomputed integrity and its retained window. */
export function inspectRecoverySet(options: {
  backupRoot: string;
  backupId: string;
}): Record<string, unknown> {
  const shown = showBackup({ backupRoot: options.backupRoot, backupId: options.backupId });
  const manifest = shown['manifest'] as RecoveryManifest;
  return {
    ...shown,
    within_retention: Date.now() <= Date.parse(manifest.retention.retain_until),
    age_seconds: Math.max(0, Math.round((Date.now() - Date.parse(manifest.created_at)) / 1000)),
  };
}

/**
 * Runs the same isolated restoration and verification a disaster would, into a
 * throwaway target, so an Operator certifies a recovery set without opening a
 * second Deployment. Failures are recorded and rethrown, never softened.
 */
export function verifyRecoverySet(options: {
  root: string;
  masterKey: string;
  backupRoot: string;
  backupId: string;
  operator: string;
}): Record<string, unknown> {
  try {
    const verified = verifyBackupSet({
      backupRoot: options.backupRoot,
      backupId: options.backupId,
      masterKey: options.masterKey,
      operator: options.operator,
    });
    const evidenceId = recordOperatorAction(
      options.root,
      options.masterKey,
      options.operator,
      'recovery_set_verification',
      options.backupId,
      'succeeded',
      {
        backup_id: options.backupId,
        verification_id: stringOf(verified['verification_id']),
        workers_connectivity_disabled: true,
        secrets_included: false,
      },
    );
    return { ...verified, evidence_id: evidenceId };
  } catch (error) {
    const failure = asFailure(error);
    recordOperatorAction(
      options.root,
      options.masterKey,
      options.operator,
      'recovery_set_verification',
      options.backupId,
      'failed',
      { backup_id: options.backupId, error_code: failure.code },
    );
    throw error;
  }
}

function asFailure(error: unknown): { code: string; message: string; next_step?: string } {
  if (error instanceof OperatorError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
    };
  }
  return { code: 'RESTORATION_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Starts one isolated restoration and returns before it finishes, so the
 * browser never waits on the work. Progress is written durably at every stage
 * and the record is pollable from any later request or console restart.
 */
export function startRestoration(options: RecoveryTargets & {
  masterKey: string;
  backupId: string;
  operator: string;
  stepUpVerifiedAt: string;
}): Record<string, unknown> {
  const running = readRestorations(options.root).find((record) => record.state === 'running');
  assertCondition(
    running === undefined,
    'RESTORATION_IN_PROGRESS',
    'Another isolated restoration is still running.',
    'Wait for the running restoration to finish before starting another.',
  );
  const manifest = readRecoveryManifest(options.backupRoot, options.backupId);
  const restorationId = randomUUID();
  const target = restorationTarget(options.restoreRoot, restorationId);
  assertCondition(
    !existsSync(target),
    'DEPLOYMENT_EXISTS',
    'The restoration target already exists.',
    'Restore into a new, empty directory.',
  );
  const record: RestorationRecord = {
    schema_version: 1,
    restoration_id: restorationId,
    backup_id: manifest.backup_id,
    deployment_id: manifest.deployment_id,
    release: manifest.release,
    state: 'running',
    requested_at: new Date().toISOString(),
    requested_by: options.operator,
    step_up_verified_at: options.stepUpVerifiedAt,
    started_at: null,
    finished_at: null,
    progress: [step('accepted', 'succeeded')],
    verification: null,
    purge_ledger: null,
    rto: null,
    workers_enabled: false,
    connectivity_enabled: false,
    service_open: false,
    error: null,
    evidence_id: null,
    secrets_included: false,
  };
  writeRestoration(options.root, record);
  recordOperatorAction(options.root, options.masterKey, options.operator, 'restoration_started', restorationId, 'succeeded', {
    restoration_id: restorationId,
    backup_id: manifest.backup_id,
    deployment_id: manifest.deployment_id,
    target,
    step_up_verified_at: options.stepUpVerifiedAt,
    workers_enabled: false,
    connectivity_enabled: false,
  });

  // The restoration runs in its own worker thread, so this request returns
  // immediately and every poll sees durable progress while the console stays
  // responsive for the whole restoration.
  launchRestoration(options, restorationId);
  return recordView(options.restoreRoot, record);
}

function launchRestoration(options: RecoveryTargets & {
  masterKey: string;
  backupId: string;
  operator: string;
}, restorationId: string): void {
  const targetRoot = restorationTarget(options.restoreRoot, restorationId);
  const recordPath = join(restorationDirectory(options.root), `${restorationId}.json`);
  const started = readRestoration(options.root, restorationId);
  started.started_at = new Date().toISOString();
  writeRestoration(options.root, started);

  const worker = new Worker(new URL('./restore-worker.js', import.meta.url), {
    workerData: {
      targetRoot,
      masterKey: options.masterKey,
      backupRoot: options.backupRoot,
      backupId: options.backupId,
      operator: options.operator,
      recordPath,
    },
  });
  let settled = false;
  worker.once('message', (message: { ok: boolean; restored?: Record<string, unknown>; error?: { code: string; message: string; next_step?: string } }) => {
    if (settled) return;
    settled = true;
    void worker.terminate();
    if (message.ok && message.restored !== undefined) finishRestoration(options, restorationId, message.restored);
    else failRestoration(options, restorationId, message.error ?? { code: 'RESTORATION_FAILED', message: 'The restoration worker reported no outcome.' });
  });
  worker.once('error', (error: Error) => {
    if (settled) return;
    settled = true;
    failRestoration(options, restorationId, { code: 'RESTORATION_FAILED', message: error.message });
  });
  worker.once('exit', (code: number) => {
    if (settled) return;
    settled = true;
    if (code !== 0) failRestoration(options, restorationId, { code: 'RESTORATION_FAILED', message: `The restoration worker stopped with exit code ${code}.` });
  });
}

/** A verified restoration keeps its evidence, and opens with nothing resumed. */
function finishRestoration(
  options: RecoveryTargets & { masterKey: string; operator: string },
  restorationId: string,
  restored: Record<string, unknown>,
): void {
  const record = readRestoration(options.root, restorationId);
  record.state = 'verified_open';
  record.finished_at = new Date().toISOString();
  record.verification = (restored['verification'] as Record<string, unknown> | undefined) ?? null;
  record.purge_ledger = (restored['purge_ledger'] as Record<string, unknown> | undefined) ?? null;
  record.rto = (restored['rto'] as Record<string, unknown> | undefined) ?? null;
  record.service_open = restored['service_open'] === true;
  record.workers_enabled = restored['workers_enabled'] === true;
  record.connectivity_enabled = restored['connectivity_enabled'] === true;
  record.evidence_id = typeof restored['evidence_id'] === 'string' ? restored['evidence_id'] : null;
  appendStep(record, step('restoration_verified', 'succeeded'));
  writeRestoration(options.root, record);
  recordOperatorAction(options.root, options.masterKey, options.operator, 'restoration_verified', record.restoration_id, 'succeeded', {
    restoration_id: record.restoration_id,
    backup_id: record.backup_id,
    ...(rtoSecondsOf(record) === null ? {} : { rto_seconds: rtoSecondsOf(record) as number }),
    rto_met: record.rto !== null && record.rto['met'] === true,
    workers_enabled: false,
    connectivity_enabled: false,
  });
}

/** A refused restoration stays closed and states exactly why. */
function failRestoration(
  options: RecoveryTargets & { masterKey: string; operator: string },
  restorationId: string,
  failure: { code: string; message: string; next_step?: string },
): void {
  const record = readRestoration(options.root, restorationId);
  record.state = 'failed';
  record.finished_at = new Date().toISOString();
  record.service_open = false;
  record.error = failure;
  appendStep(record, step('restoration_failed', 'failed'));
  writeRestoration(options.root, record);
  recordOperatorAction(options.root, options.masterKey, options.operator, 'restoration_verified', record.restoration_id, 'failed', {
    restoration_id: record.restoration_id,
    backup_id: record.backup_id,
    error_code: failure.code,
    service_open: false,
  });
}

export function showRestoration(options: { root: string; restoreRoot: string; restorationId: string }): Record<string, unknown> {
  return recordView(options.restoreRoot, readRestoration(options.root, options.restorationId));
}

export function listRestorations(options: { root: string; restoreRoot: string }): Record<string, unknown> {
  return { restorations: readRestorations(options.root).map((record) => recordView(options.restoreRoot, record)) };
}

/** Enabling is only possible on a verified restoration, and only explicitly. */
function enableRestored(options: RecoveryTargets & {
  masterKey: string;
  operator: string;
  restorationId: string;
  stepUpVerifiedAt: string;
  which: 'workers' | 'connectivity';
}): Record<string, unknown> {
  const record = readRestoration(options.root, options.restorationId);
  assertCondition(
    record.state === 'verified_open',
    'RESTORATION_NOT_VERIFIED',
    'Only a verified restoration may be enabled.',
    'Wait until the restoration reports verified_open before enabling it.',
  );
  const target = restorationTarget(options.restoreRoot, options.restorationId);
  assertCondition(existsSync(join(target, 'deployment.json')), 'RESTORATION_TARGET_MISSING', 'The restored Deployment is no longer present at its target.');
  const enabled = options.which === 'workers'
    ? enableWorkers({ root: target, operator: options.operator })
    : enableConnectivity({ root: target, operator: options.operator });
  const updated = readRestoration(options.root, options.restorationId);
  if (options.which === 'workers') updated.workers_enabled = true;
  else updated.connectivity_enabled = true;
  appendStep(updated, step(options.which === 'workers' ? 'workers_enabled' : 'connectivity_enabled', 'succeeded'));
  writeRestoration(options.root, updated);
  const evidenceId = recordOperatorAction(
    options.root,
    options.masterKey,
    options.operator,
    options.which === 'workers' ? 'restoration_enable_workers' : 'restoration_enable_connectivity',
    options.restorationId,
    'succeeded',
    {
      restoration_id: options.restorationId,
      backup_id: record.backup_id,
      changed: enabled['changed'] === true,
      step_up_verified_at: options.stepUpVerifiedAt,
      workers_enabled: updated.workers_enabled,
      connectivity_enabled: updated.connectivity_enabled,
    },
  );
  return {
    ...recordView(options.restoreRoot, updated),
    changed: enabled['changed'] === true,
    evidence_id: evidenceId,
  };
}

export function enableRestoredWorkers(options: RecoveryTargets & {
  masterKey: string;
  operator: string;
  restorationId: string;
  stepUpVerifiedAt: string;
}): Record<string, unknown> {
  return enableRestored({ ...options, which: 'workers' });
}

export function enableRestoredConnectivity(options: RecoveryTargets & {
  masterKey: string;
  operator: string;
  restorationId: string;
  stepUpVerifiedAt: string;
}): Record<string, unknown> {
  return enableRestored({ ...options, which: 'connectivity' });
}
