import { randomUUID, verify } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { appendAuditEvent } from './audit.js';
import { backupHealth, createCheckpoint, objectPosition } from './backup.js';
import { verifyReleaseBundle, type ReleaseManifest } from './bundle.js';
import { canonicalDigest, canonicalJson, keyFingerprint, publicKeyFromFile, sha256File } from './crypto.js';
import { assertCondition, OperatorError } from './errors.js';
import { memberReader } from './grants.js';
import { decrypt, readMountedMasterKey, unwrapDataKey, type WrappedDataKey, type WrappedValue } from './keys.js';
import { readLicenseSummary } from './license.js';
import {
  CURRENT_SCHEMA_VERSION,
  findUserById,
  readPlatform,
  workspaceRoleOf,
  writePlatform,
  type PlatformState,
} from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { healthyServices, startPinnedServices } from './runtime.js';
import type { PlatformSession } from './session.js';
import {
  readDeployment,
  readJsonFile,
  recordEvidence,
  writeDeployment,
  writeJsonFile,
  type DeploymentState,
} from './state.js';

/* ------------------------------------------------------------------------- *
 * Durable upgrade records: a locked migration ledger and one current attempt
 * ------------------------------------------------------------------------- */

interface MigrationStepRecord {
  name: string;
  applied_at: string;
  detail: Record<string, unknown>;
}

interface AppliedMigration {
  id: string;
  from_release: string;
  to_release: string;
  state_schema_version: number;
  expand_only: true;
  applied_at: string;
  steps: MigrationStepRecord[];
}

interface MigrationLedger {
  schema_version: 1;
  store_schema_version: number;
  migrations: AppliedMigration[];
  updated_at: string;
}

export interface RollbackWindow {
  open: boolean;
  eligible: boolean;
  from_release: string;
  to_release: string;
  upgrade_id: string;
  opened_at: string;
  closed_at: string | null;
  closed_by: 'finalize' | 'rollback' | null;
}

export type UpgradeStatus = 'migrating' | 'failed' | 'upgraded' | 'verified' | 'finalized' | 'rolled_back';

export interface UpgradeRecord {
  schema_version: 1;
  upgrade_id: string;
  attempt: number;
  status: UpgradeStatus;
  from_release: string;
  to_release: string;
  checkpoint_id: string | null;
  bundle_fingerprint: string;
  started_at: string;
  updated_at: string;
  migrations: string[];
  store_schema_version: number;
  previous_images: { release: string; images: number };
  rollback_window: RollbackWindow | null;
  verification: { passed: true; verified_at: string; evidence_id: string; checks: string[] } | null;
  finalization: { finalized_at: string; previous_release_removed: boolean; evidence_id: string } | null;
  rollback: {
    rolled_back_at: string;
    to_release: string;
    down_migrations: 0;
    data_unchanged: boolean;
    records_after_upgrade: number;
    evidence_id: string;
  } | null;
  last_error: { code: string; message: string; at: string } | null;
  secrets_included: false;
}

interface LockRecord {
  pid: number;
  acquired_at: string;
  upgrade_id: string;
}

function upgradesDirectory(root: string): string {
  return join(root, 'upgrades');
}

function recordPath(root: string): string {
  return join(upgradesDirectory(root), 'current.json');
}

function ledgerPath(root: string): string {
  return join(upgradesDirectory(root), 'ledger.json');
}

function lockPath(root: string): string {
  return join(upgradesDirectory(root), 'lock');
}

/** The current upgrade attempt, or nothing before a Deployment has ever upgraded. */
export function readUpgradeRecord(root: string): UpgradeRecord | undefined {
  const path = recordPath(root);
  if (!existsSync(path)) return undefined;
  return readJsonFile<UpgradeRecord>(path);
}

export interface MigrationLedgerView {
  schema_version: 1;
  store_schema_version: number;
  updated_at: string;
  migrations: Array<{
    id: string;
    from_release: string;
    to_release: string;
    state_schema_version: number;
    expand_only: true;
    applied_at: string;
    steps: Array<{ name: string; applied_at: string }>;
  }>;
  secrets_included: false;
}

/**
 * The durable, locked migration ledger as the Operator Console may read it:
 * every applied migration and each completed step, with no free-form details.
 */
export function readMigrationLedger(root: string): MigrationLedgerView {
  const ledger = readLedger(root);
  return {
    schema_version: 1,
    store_schema_version: ledger.store_schema_version,
    updated_at: ledger.updated_at,
    migrations: ledger.migrations.map((entry) => ({
      id: entry.id,
      from_release: entry.from_release,
      to_release: entry.to_release,
      state_schema_version: entry.state_schema_version,
      expand_only: entry.expand_only,
      applied_at: entry.applied_at,
      steps: entry.steps.map((step) => ({ name: step.name, applied_at: step.applied_at })),
    })),
    secrets_included: false,
  };
}

function writeUpgradeRecord(root: string, record: UpgradeRecord): UpgradeRecord {
  mkdirSync(upgradesDirectory(root), { recursive: true, mode: 0o700 });
  writeJsonFile(recordPath(root), record);
  return record;
}

function readLedger(root: string): MigrationLedger {
  const path = ledgerPath(root);
  if (!existsSync(path)) {
    return {
      schema_version: 1,
      store_schema_version: CURRENT_SCHEMA_VERSION,
      migrations: [],
      updated_at: new Date(0).toISOString(),
    };
  }
  return readJsonFile<MigrationLedger>(path);
}

function writeLedger(root: string, ledger: MigrationLedger): void {
  mkdirSync(upgradesDirectory(root), { recursive: true, mode: 0o700 });
  writeJsonFile(ledgerPath(root), ledger);
}

/** The rollback window a status answer states, or null when none ever opened. */
export function rollbackWindow(root: string): RollbackWindow | null {
  return readUpgradeRecord(root)?.rollback_window ?? null;
}

/* ------------------------------------------------------------------------- *
 * Signed N -> N+1 compatibility
 * ------------------------------------------------------------------------- */

function releaseParts(release: string): [number, number, number] {
  const parts = release.split('.');
  const numbers = parts.map((part) => Number(part));
  assertCondition(
    parts.length === 3 && numbers.every((part) => Number.isInteger(part) && part >= 0),
    'UPGRADE_PATH_UNSUPPORTED',
    `The release version ${release} is not a three-part version.`,
  );
  return [numbers[0]!, numbers[1]!, numbers[2]!];
}

function compareReleases(left: string, right: string): number {
  const from = releaseParts(left);
  const to = releaseParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (from[index] ?? 0) - (to[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Only the immediately following release is a supported upgrade path. */
function isImmediatelyNext(from: string, to: string): boolean {
  const [fromMajor, fromMinor, fromPatch] = releaseParts(from);
  const [toMajor, toMinor, toPatch] = releaseParts(to);
  if (toMajor !== fromMajor) return false;
  return (toMinor === fromMinor + 1 && toPatch === 0) || (toMinor === fromMinor && toPatch === fromPatch + 1);
}

/** Every image archive the installed release would need to be started again. */
export function verifyReleaseImages(root: string, release: string): { release: string; images: number; archives: string[] } {
  const directory = join(root, 'releases', release);
  const manifestFile = join(directory, 'manifest.json');
  assertCondition(
    existsSync(manifestFile),
    'PREVIOUS_RELEASE_IMAGES_MISSING',
    `The installed release ${release} has no release manifest.`,
    'Reinstall the complete Release Bundle; rollback needs the previous images locally.',
  );
  const manifest = readJsonFile<ReleaseManifest>(manifestFile);
  assertCondition(manifest.release === release, 'PREVIOUS_RELEASE_IMAGES_MISSING', 'The installed release manifest names a different release.');
  const archives: string[] = [];
  for (const image of manifest.images) {
    const archive = join(directory, ...image.archive.split('/'));
    assertCondition(
      existsSync(archive),
      'PREVIOUS_RELEASE_IMAGES_MISSING',
      `The previous image archive is missing: ${image.archive}.`,
      'Restore the installed release images before upgrading; rollback has no registry to pull from.',
    );
    assertCondition(
      `sha256:${sha256File(archive)}` === image.digest,
      'PREVIOUS_RELEASE_IMAGES_MISSING',
      `The previous image archive does not match its digest: ${image.archive}.`,
    );
    archives.push(image.archive);
  }
  const trustedKey = publicKeyFromFile(join(root, 'trust', 'release-key.pem'));
  const signature = readJsonFile<{ algorithm?: string; key_id?: string; value?: string }>(join(directory, 'manifest.sig'));
  const authenticated = signature.algorithm === 'Ed25519'
    && signature.key_id === keyFingerprint(trustedKey)
    && typeof signature.value === 'string'
    && verify(null, Buffer.from(canonicalJson(manifest)), trustedKey, Buffer.from(signature.value, 'base64'));
  assertCondition(
    authenticated,
    'PREVIOUS_RELEASE_UNTRUSTED',
    `The installed release manifest for ${release} is not authentic under the trusted release key.`,
  );
  return { release, images: archives.length, archives };
}

/** Queued work the maintenance window has to drain before persistent formats move. */
function queueState(state: PlatformState): {
  queued: number;
  running: number;
  pending_purges: number;
  pending: number;
} {
  const queued = state.acquisition_runs.filter((run) => run.status === 'queued').length;
  const running = state.acquisition_runs.filter((run) => run.status === 'running').length;
  const pendingPurges = state.purge_jobs.filter((job) => job.status === 'pending').length;
  return { queued, running, pending_purges: pendingPurges, pending: queued + running + pendingPurges };
}

interface PreflightOptions {
  root: string;
  bundle: string;
  releaseKey: string;
  confirmedFingerprint: string;
  masterKey: string;
  operator: string;
  license?: string;
}

/** Where the target release can be installed without exhausting the certified host. */
function capacityReport(root: string, requiredBytes: number): Record<string, unknown> {
  try {
    const stats = statfsSync(root);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return {
      measured: true,
      free_bytes: free,
      required_bytes: requiredBytes,
      sufficient: free >= requiredBytes,
    };
  } catch {
    return { measured: false, free_bytes: null, required_bytes: requiredBytes, sufficient: true };
  }
}

/**
 * Every gate that must clear before a coordinated checkpoint: the signed path,
 * the previous images rollback depends on, the entitlement, the master key,
 * store health, drained queues, and recovery health. It mutates nothing.
 */
function evaluatePreflight(options: PreflightOptions): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const existing = readUpgradeRecord(options.root);
  assertCondition(
    !(existing?.rollback_window?.open === true),
    'ROLLBACK_WINDOW_OPEN',
    'The previous upgrade is still inside its rollback window.',
    'Run verify and then finalize before starting another upgrade.',
  );

  const verified = verifyReleaseBundle(options.bundle, options.releaseKey, options.confirmedFingerprint);
  const from = deployment.release;
  const to = verified.manifest.release;
  assertCondition(
    compareReleases(from, to) !== 0,
    'UPGRADE_PATH_UNSUPPORTED',
    `The Release Bundle is the installed release ${from}.`,
  );
  assertCondition(
    isImmediatelyNext(from, to),
    'UPGRADE_PATH_UNSUPPORTED',
    `${from} -> ${to} is not an immediately following N -> N+1 upgrade.`,
    'Install the next published release in order; releases are never skipped.',
  );
  assertCondition(
    (verified.manifest.compatibility?.upgrade_from ?? []).includes(from),
    'UPGRADE_PATH_UNSUPPORTED',
    `The Release Bundle does not declare ${from} as a compatible predecessor.`,
  );
  const migration = migrationFor(from, to);
  assertCondition(
    migration !== undefined,
    'UPGRADE_PATH_UNSUPPORTED',
    `No locked forward-only migration exists for ${from} -> ${to}.`,
  );

  // A refused migration left service closed and durable progress behind; rerunning
  // the same signed bundle resumes it instead of demanding a new checkpoint.
  const resumable = existing !== undefined
    && existing.status === 'failed'
    && existing.from_release === from
    && existing.to_release === to
    && existing.checkpoint_id !== null;
  assertCondition(
    deployment.service_open || resumable,
    'UPGRADE_DEPLOYMENT_NOT_OPEN',
    'An upgrade requires an open Deployment or a failed attempt it can resume.',
    'Restore service health and rerun upgrade.',
  );

  const previousImages = verifyReleaseImages(options.root, from);
  const license = readLicenseSummary(options.root, options.license ?? join(options.root, 'license.json'));
  assertCondition(
    compareReleases(to, license.highest_eligible_release) <= 0,
    'LICENSE_RELEASE_INELIGIBLE',
    `The Deployment License allows releases up to ${license.highest_eligible_release}, not ${to}.`,
    'Import a renewed Deployment License whose entitlement covers this release.',
  );

  const masterKey = readMountedMasterKey(options.root, options.masterKey);
  const wrapped = readJsonFile<WrappedDataKey>(join(options.root, 'config', 'wrapped-data-key.json'));
  unwrapDataKey(masterKey, wrapped);
  const services = healthyServices(options.root, deployment);
  const state = readPlatform(options.root);
  const queues = queueState(state);
  assertCondition(
    queues.pending === 0,
    'UPGRADE_QUEUES_NOT_DRAINED',
    `The maintenance window still holds ${queues.pending} queued, running, or pending job(s).`,
    'Drain or cancel queued work before upgrading persistent formats.',
  );
  const backup = backupHealth(options.root);
  assertCondition(
    backup.health !== 'degraded',
    'BACKUP_UNHEALTHY',
    `Recovery protection is degraded: ${backup.reasons.join(', ')}.`,
    'Take a coordinated checkpoint and restore protection before upgrading.',
  );

  const bundleBytes = verified.manifest.files.reduce(
    (total, file) => {
      const path = join(verified.directory, ...file.path.split('/'));
      return total + (existsSync(path) ? statSync(path).size : 0);
    },
    0,
  );
  return {
    passed: true,
    from_release: from,
    to_release: to,
    resumable,
    service_open: deployment.service_open,
    upgrade_path: {
      adjacent: true,
      declared: true,
      from,
      to,
      migration_id: migration!.id,
    },
    bundle: {
      release: to,
      release_key_fingerprint: verified.releaseFingerprint,
      signature_verified: true,
      files: verified.manifest.files.length,
      images: verified.manifest.images.length,
    },
    previous_images: previousImages,
    license: {
      eligible: true,
      highest_eligible_release: license.highest_eligible_release,
    },
    master_key: { valid: true },
    stores: { healthy: true, services },
    queues,
    backups: {
      health: backup.health,
      last_checkpoint_id: backup.last_checkpoint_id,
      last_checkpoint_at: backup.last_checkpoint_at,
    },
    capacity: capacityReport(options.root, bundleBytes * 2),
    checkpoint_required: !resumable,
  };
}

/** Runs preflight and records its durable, non-secret evidence. */
export function preflightUpgrade(options: PreflightOptions): Record<string, unknown> {
  try {
    const report = evaluatePreflight(options);
    const evidenceId = recordEvidence(options.root, 'preflight', 'eligible', options.operator, {
      from_release: report['from_release'],
      to_release: report['to_release'],
      previous_images: report['previous_images'],
      stores: report['stores'],
      queues: report['queues'],
      backup_health: (report['backups'] as Record<string, unknown>)['health'],
      resumable: report['resumable'],
    });
    return { ...report, evidence_id: evidenceId };
  } catch (error) {
    if (error instanceof OperatorError && existsSync(join(options.root, 'deployment.json'))) {
      recordEvidence(options.root, 'preflight', 'rejected', options.operator, {
        error_code: error.code,
      });
    }
    throw error;
  }
}

/* ------------------------------------------------------------------------- *
 * Locked, forward-only, expand-only migrations
 * ------------------------------------------------------------------------- */

interface MigrationStepContext {
  root: string;
  state: PlatformState;
  deployment: DeploymentState;
  migration: MigrationDefinition;
}

interface MigrationStepDefinition {
  name: string;
  expand_only: true;
  run(context: MigrationStepContext): Record<string, unknown>;
}

interface MigrationDefinition {
  id: string;
  from_release: string;
  to_release: string;
  state_schema_version: number;
  expand_only: true;
  steps: MigrationStepDefinition[];
}

function catalogIndex(root: string, state: PlatformState, format: number): Record<string, unknown> {
  const collections = {
    users: state.users.length,
    workspaces: state.workspaces.length,
    sources: state.sources.length,
    datasets: state.datasets.length,
    dataset_releases: state.datasets.reduce((total, dataset) => total + dataset.releases.length, 0),
    data_products: state.data_products.length,
    data_product_releases: state.data_products.reduce((total, product) => total + product.releases.length, 0),
    raw_acquisitions: state.raw_acquisitions.length,
    acquisition_runs: state.acquisition_runs.length,
    reports: state.reports.length,
  };
  mkdirSync(join(root, 'state', 'indexes'), { recursive: true, mode: 0o700 });
  writeJsonFile(join(root, 'state', 'indexes', 'catalog.json'), {
    schema_version: format,
    digest: canonicalDigest(state),
    collections,
    built_at: new Date().toISOString(),
    rebuildable: true,
    secrets_included: false,
  });
  return { ...collections, digest: canonicalDigest(state) };
}

function recordExpandedSchema(root: string, migration: MigrationDefinition, ledger: MigrationLedger): Record<string, unknown> {
  writeJsonFile(join(root, 'state', 'schema.json'), {
    schema_version: migration.state_schema_version,
    expand_only: true,
    compatible_with_application_releases: [migration.from_release, migration.to_release],
    migrations: ledger.migrations.map((entry) => ({
      id: entry.id,
      state_schema_version: entry.state_schema_version,
      expand_only: entry.expand_only,
      applied_at: entry.applied_at,
    })),
    updated_at: new Date().toISOString(),
    secrets_included: false,
  });
  return { state_schema_version: migration.state_schema_version, expand_only: true };
}

/**
 * The locked migrations this release ships. Each is forward-only and additive:
 * older code keeps reading the expanded store for the whole rollback window.
 */
const MIGRATIONS: MigrationDefinition[] = [
  {
    id: '0.2.0-expand-catalog-indexes',
    from_release: '0.1.0',
    to_release: '0.2.0',
    state_schema_version: 9,
    expand_only: true,
    steps: [
      {
        name: 'backfill-contract-lines',
        expand_only: true,
        run: ({ root, state }) => {
          state.schema_version = CURRENT_SCHEMA_VERSION;
          writePlatform(root, state);
          return {
            data_products: state.data_products.length,
            lines: state.data_products.reduce((total, product) => total + product.lines.length, 0),
          };
        },
      },
      {
        name: 'rebuild-derived-catalog-index',
        expand_only: true,
        run: ({ root, state }) => catalogIndex(root, state, 1),
      },
      {
        name: 'record-expanded-store-schema',
        expand_only: true,
        run: ({ root, migration }) => recordExpandedSchema(root, migration, readLedger(root)),
      },
    ],
  },
  {
    id: '0.2.1-expand-index-format',
    from_release: '0.2.0',
    to_release: '0.2.1',
    state_schema_version: 10,
    expand_only: true,
    steps: [
      {
        name: 'refresh-derived-catalog-index',
        expand_only: true,
        run: ({ root, state }) => catalogIndex(root, state, 2),
      },
      {
        name: 'record-expanded-store-schema',
        expand_only: true,
        run: ({ root, migration }) => recordExpandedSchema(root, migration, readLedger(root)),
      },
    ],
  },
];

function migrationFor(from: string, to: string): MigrationDefinition | undefined {
  return MIGRATIONS.find((migration) => migration.from_release === from && migration.to_release === to);
}

interface AppliedMigrationsReport {
  migrations: string[];
  state_schema_version: number;
  expand_only: true;
  destructive: 0;
  applied_steps: number;
  skipped_steps: number;
  total_steps: number;
}

/**
 * Applies one locked migration step by step, persisting the ledger after each
 * step so a failure is restartable and a completed step is never repeated.
 */
function applyMigration(
  root: string,
  migration: MigrationDefinition,
  deployment: DeploymentState,
): AppliedMigrationsReport {
  const ledger = readLedger(root);
  assertCondition(
    ledger.store_schema_version <= migration.state_schema_version,
    'MIGRATION_DOWNGRADE_UNSUPPORTED',
    'The stored schema is newer than this release can migrate.',
  );
  assertCondition(
    ledger.migrations.every((entry) => entry.expand_only === true),
    'MIGRATION_NOT_EXPAND_ONLY',
    'A recorded migration is not expand-only, so Application Rollback is no longer safe.',
  );
  let entry = ledger.migrations.find((candidate) => candidate.id === migration.id);
  const now = new Date().toISOString();
  if (entry === undefined) {
    entry = {
      id: migration.id,
      from_release: migration.from_release,
      to_release: migration.to_release,
      state_schema_version: migration.state_schema_version,
      expand_only: true,
      applied_at: now,
      steps: [],
    };
    ledger.migrations.push(entry);
  }
  const completed = new Set(entry.steps.map((step) => step.name));
  let applied = 0;
  let skipped = 0;
  for (const step of migration.steps) {
    if (completed.has(step.name)) {
      skipped += 1;
      continue;
    }
    const context: MigrationStepContext = {
      root,
      state: readPlatform(root),
      deployment,
      migration,
    };
    try {
      const detail = step.run(context);
      entry.steps.push({ name: step.name, applied_at: new Date().toISOString(), detail });
      applied += 1;
    } catch (error) {
      ledger.updated_at = new Date().toISOString();
      writeLedger(root, ledger);
      throw new OperatorError(
        'MIGRATION_FAILED',
        `Migration ${migration.id} failed at ${step.name}: ${error instanceof Error ? error.message : 'unknown error'}.`,
        'Leave service closed, correct the cause, and rerun upgrade; completed steps are not repeated.',
      );
    }
    ledger.updated_at = new Date().toISOString();
    writeLedger(root, ledger);
  }
  ledger.store_schema_version = Math.max(ledger.store_schema_version, migration.state_schema_version);
  ledger.updated_at = new Date().toISOString();
  writeLedger(root, ledger);
  return {
    migrations: [migration.id],
    state_schema_version: ledger.store_schema_version,
    expand_only: true,
    destructive: 0,
    applied_steps: applied,
    skipped_steps: skipped,
    total_steps: migration.steps.length,
  };
}

/* ------------------------------------------------------------------------- *
 * The upgrade lock
 * ------------------------------------------------------------------------- */

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireUpgradeLock(root: string, upgradeId: string): LockRecord {
  mkdirSync(upgradesDirectory(root), { recursive: true, mode: 0o700 });
  const lock: LockRecord = { pid: process.pid, acquired_at: new Date().toISOString(), upgrade_id: upgradeId };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(lockPath(root), 'wx');
      writeSync(handle, `${JSON.stringify(lock, null, 2)}\n`);
      closeSync(handle);
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = tryReadLock(root);
      if (existing !== null && processAlive(existing.pid)) {
        throw new OperatorError(
          'UPGRADE_LOCKED',
          `Another upgrade (pid ${existing.pid}) holds the migration lock.`,
          'Wait for that upgrade to finish, or remove a lock left by a dead process.',
        );
      }
      // A lock whose process no longer exists is a crash artifact: take it over.
      rmSync(lockPath(root), { force: true });
    }
  }
  throw new OperatorError('UPGRADE_LOCKED', 'The migration lock could not be acquired.');
}

function tryReadLock(root: string): LockRecord | null {
  try {
    return readJsonFile<LockRecord>(lockPath(root));
  } catch {
    return null;
  }
}

function releaseUpgradeLock(root: string, lock: LockRecord): void {
  const existing = tryReadLock(root);
  if (existing === null || existing.upgrade_id !== lock.upgrade_id) return;
  rmSync(lockPath(root), { force: true });
}

/* ------------------------------------------------------------------------- *
 * Upgrade
 * ------------------------------------------------------------------------- */

/** Installs the verified release beside the previous one, from local media only. */
function installRelease(root: string, verified: ReturnType<typeof verifyReleaseBundle>): string {
  const releases = join(root, 'releases');
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  const target = join(releases, verified.manifest.release);
  const staging = join(releases, `.${verified.manifest.release}-${randomUUID()}.tmp`);
  try {
    cpSync(verified.directory, staging, { recursive: true, errorOnExist: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return target;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new OperatorError(
      'RELEASE_INSTALL_FAILED',
      `The verified release could not be installed: ${error instanceof Error ? error.message : 'unknown error'}.`,
      'Keep service closed and rerun upgrade; the previous release is untouched.',
    );
  }
}

/**
 * Performs a signed N -> N+1 maintenance-window upgrade: preflight, coordinated
 * checkpoint, locked expand-only migrations, local release installation, and
 * reopening on the new release with the rollback window explicitly open.
 */
export function upgradeDeployment(options: PreflightOptions & { backupRoot?: string }): Record<string, unknown> {
  let preflight: Record<string, unknown>;
  try {
    preflight = evaluatePreflight(options);
  } catch (error) {
    if (error instanceof OperatorError && existsSync(join(options.root, 'deployment.json'))) {
      recordEvidence(options.root, 'upgrade', 'rejected', options.operator, { error_code: error.code });
    }
    throw error;
  }

  const verified = verifyReleaseBundle(options.bundle, options.releaseKey, options.confirmedFingerprint);
  const deployment = readDeployment(options.root);
  const existing = readUpgradeRecord(options.root);
  const resumable = preflight['resumable'] === true;
  const upgradeId = resumable && existing !== undefined ? existing.upgrade_id : randomUUID();
  const attempt = (resumable && existing !== undefined ? existing.attempt : 0) + 1;
  const from = deployment.release;
  const to = verified.manifest.release;
  const previousImages = preflight['previous_images'] as { release: string; images: number };
  const lock = acquireUpgradeLock(options.root, upgradeId);
  try {
    let checkpointId: string;
    if (resumable && existing?.checkpoint_id) {
      checkpointId = existing.checkpoint_id;
    } else {
      try {
        const checkpoint = createCheckpoint({
          root: options.root,
          operator: options.operator,
          ...(options.backupRoot === undefined ? {} : { backupRoot: options.backupRoot }),
        });
        checkpointId = String(checkpoint['checkpoint_id']);
      } catch (error) {
        if (error instanceof OperatorError) {
          recordEvidence(options.root, 'upgrade', 'checkpoint_failed', options.operator, {
            error_code: error.code,
            from_release: from,
            to_release: to,
          });
        }
        throw error;
      }
    }

    const startedAt = existing !== undefined && resumable ? existing.started_at : new Date().toISOString();
    let record: UpgradeRecord = {
      schema_version: 1,
      upgrade_id: upgradeId,
      attempt,
      status: 'migrating',
      from_release: from,
      to_release: to,
      checkpoint_id: checkpointId,
      bundle_fingerprint: verified.releaseFingerprint,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      migrations: [],
      store_schema_version: readLedger(options.root).store_schema_version,
      previous_images: previousImages,
      rollback_window: existing?.rollback_window?.open === true ? existing.rollback_window : null,
      verification: null,
      finalization: null,
      rollback: null,
      last_error: null,
      secrets_included: false,
    };
    writeUpgradeRecord(options.root, record);
    writeDeployment(options.root, { ...deployment, state: 'upgrading', service_open: false });

    const migration = migrationFor(from, to)!;
    try {
      const applied = applyMigration(options.root, migration, deployment);
      installRelease(options.root, verified);
      const running: DeploymentState = {
        ...readDeployment(options.root),
        release: to,
        state: 'verify_pending',
        service_open: false,
      };
      const services = startPinnedServices(options.root, running);
      writeDeployment(options.root, { ...running, service_open: true, runtime_services: services });
      const window: RollbackWindow = {
        open: true,
        eligible: true,
        from_release: from,
        to_release: to,
        upgrade_id: upgradeId,
        opened_at: new Date().toISOString(),
        closed_at: null,
        closed_by: null,
      };
      record = {
        ...record,
        status: 'upgraded',
        updated_at: new Date().toISOString(),
        migrations: applied.migrations,
        store_schema_version: applied.state_schema_version,
        rollback_window: window,
        attempt,
      };
      writeUpgradeRecord(options.root, record);
      const evidenceId = recordEvidence(options.root, 'upgrade', 'upgraded', options.operator, {
        upgrade_id: upgradeId,
        attempt,
        from_release: from,
        to_release: to,
        checkpoint_id: checkpointId,
        migrations: applied.migrations,
        store_schema_version: applied.state_schema_version,
        expand_only: applied.expand_only,
        destructive_migrations: applied.destructive,
        applied_steps: applied.applied_steps,
        skipped_steps: applied.skipped_steps,
        total_steps: applied.total_steps,
        rollback_eligible: true,
        service_open: true,
        secrets_included: false,
      });
      return {
        upgrade_id: upgradeId,
        attempt,
        status: 'upgraded',
        from_release: from,
        to_release: to,
        checkpoint_id: checkpointId,
        state: 'verify_pending',
        service_open: true,
        runtime_services: services,
        migrations: applied,
        rollback_window: window,
        checkpoint_required: preflight['checkpoint_required'],
        evidence_id: evidenceId,
      };
    } catch (error) {
      const code = error instanceof OperatorError ? error.code : 'UPGRADE_FAILED';
      writeUpgradeRecord(options.root, {
        ...record,
        status: 'failed',
        updated_at: new Date().toISOString(),
        migrations: readLedger(options.root).migrations.map((entry) => entry.id),
        store_schema_version: readLedger(options.root).store_schema_version,
        last_error: { code, message: error instanceof Error ? error.message : 'unknown error', at: new Date().toISOString() },
      });
      writeDeployment(options.root, { ...readDeployment(options.root), state: 'upgrade_failed', service_open: false });
      recordEvidence(options.root, 'upgrade', 'failed', options.operator, {
        upgrade_id: upgradeId,
        from_release: from,
        to_release: to,
        error_code: code,
        completed_steps: readLedger(options.root).migrations.flatMap((entry) => entry.steps.map((step) => step.name)),
        service_open: false,
        next_step: 'Correct the cause and rerun upgrade; completed migration steps are not repeated.',
      });
      throw error;
    }
  } finally {
    releaseUpgradeLock(options.root, lock);
  }
}

/* ------------------------------------------------------------------------- *
 * Verification, finalization, and Application Rollback
 * ------------------------------------------------------------------------- */

/** Every sealed secret the Deployment holds, so key custody is provable. */
function sealedSecrets(state: PlatformState): WrappedValue[] {
  const sealed: WrappedValue[] = [];
  for (const connection of state.acquisition_connections) {
    for (const version of connection.versions) {
      if (version.credential !== null) sealed.push(version.credential);
    }
  }
  for (const credential of state.scraper_credentials) sealed.push(credential.sealed);
  for (const profile of state.model_profiles) {
    for (const version of profile.versions) {
      if (version.credential !== null) sealed.push(version.credential);
    }
  }
  return sealed;
}

function workspaceViolations(state: PlatformState): { workspaces: number; artifacts: number; violations: number } {
  const workspaceIds = new Set(state.workspaces.map((workspace) => workspace.workspace_id));
  let artifacts = 0;
  let violations = 0;
  const scoped: Array<{ workspace_id: string }> = [
    ...state.sources,
    ...state.acquisition_connections,
    ...state.source_acquisitions,
    ...state.integration_configurations,
    ...state.raw_acquisitions,
    ...state.acquisition_runs,
    ...state.integration_batches,
    ...state.datasets,
    ...state.data_products,
    ...state.data_product_grants,
    ...state.exports,
    ...state.reports,
  ];
  for (const artifact of scoped) {
    artifacts += 1;
    if (!workspaceIds.has(artifact.workspace_id)) violations += 1;
  }
  for (const dataset of state.datasets) {
    const source = state.sources.find((candidate) => candidate.source_id === dataset.source_id);
    if (source === undefined || source.workspace_id !== dataset.workspace_id) violations += 1;
  }
  for (const product of state.data_products) {
    for (const release of product.releases) {
      const dataset = state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
      const releaseExists = dataset?.releases.some((candidate) => candidate.release === release.dataset_release) === true;
      if (dataset === undefined || dataset.workspace_id !== product.workspace_id || !releaseExists) violations += 1;
    }
    for (const grant of state.data_product_grants.filter((candidate) => candidate.data_product_id === product.data_product_id)) {
      if (grant.workspace_id !== product.workspace_id) violations += 1;
    }
  }
  for (const raw of state.raw_acquisitions) {
    const source = state.sources.find((candidate) => candidate.source_id === raw.source_id);
    if (source === undefined || source.workspace_id !== raw.workspace_id) violations += 1;
  }
  return { workspaces: workspaceIds.size, artifacts, violations };
}

function releaseViolations(state: PlatformState): {
  dataset_releases: number;
  product_releases: number;
  dangling: number;
} {
  let datasetReleases = 0;
  let productReleases = 0;
  let dangling = 0;
  for (const dataset of state.datasets) {
    const seen = new Set<number>();
    for (const release of dataset.releases) {
      datasetReleases += 1;
      if (seen.has(release.release)) dangling += 1;
      seen.add(release.release);
      if (release.record_count !== release.records.length) dangling += 1;
      if (canonicalDigest(release.records.map((record) => ({ identity: record.identity, values: record.values }))) !== release.records_hash) {
        dangling += 1;
      }
    }
  }
  for (const product of state.data_products) {
    for (const release of product.releases) {
      productReleases += 1;
      const version = product.versions.some((candidate) => candidate.version === release.data_product_version);
      const dataset = state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
      const datasetRelease = dataset?.releases.some((candidate) => candidate.release === release.dataset_release) === true;
      if (!version || !datasetRelease) dangling += 1;
    }
    for (const line of product.lines) {
      if (!product.versions.some((candidate) => candidate.version === line.current_version)) dangling += 1;
    }
  }
  return { dataset_releases: datasetReleases, product_releases: productReleases, dangling };
}

function provenanceViolations(state: PlatformState): {
  dataset_releases: number;
  batches: number;
  dangling: number;
} {
  let datasetReleases = 0;
  let batches = 0;
  let dangling = 0;
  const purgedRaw = new Set(
    state.purge_ledger.flatMap((entry) => entry.purged
      .filter((record) => record.record_kind === 'raw_acquisition')
      .map((record) => record.record_id)),
  );
  for (const dataset of state.datasets) {
    for (const release of dataset.releases) {
      datasetReleases += 1;
      for (const batchId of release.provenance.batch_ids) {
        batches += 1;
        if (!state.integration_batches.some((batch) => batch.batch_id === batchId)) dangling += 1;
      }
      for (const runId of release.provenance.acquisition_run_ids) {
        if (!state.acquisition_runs.some((run) => run.acquisition_run_id === runId)) dangling += 1;
      }
      for (const rawId of release.provenance.raw_acquisition_ids) {
        if (purgedRaw.has(rawId)) continue;
        if (!state.raw_acquisitions.some((raw) => raw.raw_id === rawId)) dangling += 1;
      }
    }
  }
  return { dataset_releases: datasetReleases, batches, dangling };
}

function identityViolations(state: PlatformState): {
  users: number;
  workspaces: number;
  memberships: number;
  sessions: number;
  agents: number;
  service_identities: number;
  violations: number;
} {
  let violations = 0;
  const userIds = new Set(state.users.map((user) => user.user_id));
  const workspaceIds = new Set(state.workspaces.map((workspace) => workspace.workspace_id));
  const usernames = new Set<string>();
  for (const user of state.users) {
    if (usernames.has(user.username.toLowerCase())) violations += 1;
    usernames.add(user.username.toLowerCase());
  }
  for (const membership of state.memberships) {
    if (!userIds.has(membership.user_id) || !workspaceIds.has(membership.workspace_id)) violations += 1;
  }
  for (const session of state.sessions) {
    if (!userIds.has(session.user_id)) violations += 1;
  }
  for (const agent of state.agent_identities) {
    for (const workspaceId of agent.workspace_ids) {
      if (!workspaceIds.has(workspaceId)) violations += 1;
    }
  }
  for (const service of state.service_identities) {
    for (const workspaceId of service.workspace_ids) {
      if (!workspaceIds.has(workspaceId)) violations += 1;
    }
  }
  for (const workspace of state.workspaces) {
    const activeAdministrator = state.memberships.some((membership) => membership.workspace_id === workspace.workspace_id
      && membership.role === 'Workspace Administrator'
      && findUserById(state, membership.user_id)?.status === 'active');
    if (!activeAdministrator) violations += 1;
  }
  return {
    users: state.users.length,
    workspaces: state.workspaces.length,
    memberships: state.memberships.length,
    sessions: state.sessions.length,
    agents: state.agent_identities.length,
    service_identities: state.service_identities.length,
    violations,
  };
}

/**
 * Verifies an upgraded Deployment through the same governed engine a Consumer
 * reads through: stores, objects, keys, queues, identities, Workspace
 * isolation, Releases, Provenance, and representative Consumer reads.
 */
export function verifyUpgrade(options: {
  root: string;
  masterKey: string;
  operator: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const record = readUpgradeRecord(options.root);
  assertCondition(
    record !== undefined && (record.status === 'upgraded' || record.status === 'verified'),
    'UPGRADE_NOT_READY',
    'No completed upgrade is waiting for verification.',
    'Run upgrade first; verification covers exactly one open rollback window.',
  );
  assertCondition(deployment.service_open, 'DEPLOYMENT_NOT_OPEN', 'Verification requires an open Deployment.');
  assertCondition(
    deployment.release === record.to_release,
    'UPGRADE_RELEASE_MISMATCH',
    `The Deployment runs ${deployment.release}, not the upgraded release ${record.to_release}.`,
  );
  const masterKey = readMountedMasterKey(options.root, options.masterKey);
  const wrapped = readJsonFile<WrappedDataKey>(join(options.root, 'config', 'wrapped-data-key.json'));
  const dataKey = unwrapDataKey(masterKey, wrapped);
  const state = readPlatform(options.root);
  const ledger = readLedger(options.root);

  const checks: Record<string, Record<string, unknown>> = {};
  const attempt = (name: string, run: () => Record<string, unknown>): void => {
    try {
      checks[name] = { passed: true, ...run() };
    } catch (error) {
      checks[name] = {
        passed: false,
        error_code: error instanceof OperatorError ? error.code : 'CHECK_FAILED',
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  };

  attempt('stores', () => {
    const services = healthyServices(options.root, deployment);
    assertCondition(
      existsSync(join(options.root, 'state', 'indexes', 'catalog.json')),
      'UPGRADE_VERIFICATION_FAILED',
      'The expanded catalog index is missing.',
    );
    readJsonFile<Record<string, unknown>>(join(options.root, 'state', 'indexes', 'catalog.json'));
    assertCondition(
      existsSync(join(options.root, 'state', 'schema.json')),
      'UPGRADE_VERIFICATION_FAILED',
      'The expanded store schema record is missing.',
    );
    return { services, indexes: 1 };
  });
  attempt('objects', () => {
    const objects = objectPosition(options.root, state);
    return {
      verified: objects.length,
      bytes: objects.reduce((total, object) => total + object.bytes, 0),
    };
  });
  attempt('keys', () => {
    const sealed = sealedSecrets(state);
    let decrypted = 0;
    for (const secret of sealed) {
      assertCondition(decrypt(dataKey, secret).length > 0, 'UPGRADE_VERIFICATION_FAILED', 'A sealed credential opened to nothing.');
      decrypted += 1;
    }
    return { data_key_unwrapped: true, sealed_credentials: sealed.length, decrypted };
  });
  attempt('queues', () => {
    const queues = queueState(state);
    assertCondition(
      queues.pending === 0,
      'UPGRADE_VERIFICATION_FAILED',
      `The maintenance window still holds ${queues.pending} queued or pending job(s).`,
    );
    return { ...queues, drained: true };
  });
  attempt('identities', () => {
    const identities = identityViolations(state);
    assertCondition(identities.violations === 0, 'UPGRADE_VERIFICATION_FAILED', 'Identity references do not reconcile.');
    return identities;
  });
  attempt('workspace_isolation', () => {
    const isolation = workspaceViolations(state);
    assertCondition(isolation.violations === 0, 'UPGRADE_VERIFICATION_FAILED', 'A Workspace-scoped Artifact crosses its Workspace.');
    return isolation;
  });
  attempt('releases', () => {
    const releases = releaseViolations(state);
    assertCondition(releases.dangling === 0, 'UPGRADE_VERIFICATION_FAILED', 'A Dataset or Data Product Release does not reconcile.');
    return releases;
  });
  attempt('provenance', () => {
    const provenance = provenanceViolations(state);
    assertCondition(provenance.dangling === 0, 'UPGRADE_VERIFICATION_FAILED', 'Provenance does not reconcile with its Releases.');
    return provenance;
  });
  attempt('consumer_reads', () => {
    const reads: Array<Record<string, unknown>> = [];
    const session = verificationSession(options.root, state, dataKey);
    for (const product of state.data_products
      .filter((candidate) => candidate.releases.length > 0 && candidate.versions.some((version) => version.withdrawn_at === null))
      .slice(0, 3)) {
      const identity = state.memberships.filter((membership) => membership.workspace_id === product.workspace_id
        && findUserById(state, membership.user_id)?.status === 'active');
      const member = identity.find((membership) => membership.role === 'Workspace Administrator') ?? identity[0];
      assertCondition(member !== undefined, 'UPGRADE_VERIFICATION_FAILED', 'A Data Product has no active member to read through.');
      const user = findUserById(state, member.user_id);
      assertCondition(user !== undefined, 'UPGRADE_VERIFICATION_FAILED', 'A member identity is missing.');
      const answer = executeDataProductQuery({
        session,
        reader: memberReader(session, user, workspaceRoleOf(state, user.user_id, product.workspace_id)),
        product,
        context: {
          action: 'data_product_query',
          scope: 'workspace',
          workspace_id: product.workspace_id,
          target: product.data_product_id,
        },
        request: { kind: 'records', limit: 1 },
        fail: (code, message, nextStep) => {
          throw new OperatorError(code, message, nextStep);
        },
      });
      const records = Array.isArray(answer['records']) ? answer['records'] as unknown[] : [];
      reads.push({
        data_product_id: product.data_product_id,
        workspace_id: product.workspace_id,
        data_product_release: answer['data_product_release'] ?? null,
        returned: records.length,
        provenance: answer['provenance'] !== undefined,
      });
    }
    return { products: reads.length, reads };
  });

  const failed = Object.entries(checks).filter(([, check]) => check['passed'] !== true).map(([name]) => name);
  if (failed.length > 0) {
    recordEvidence(options.root, 'verify', 'failed', options.operator, {
      upgrade_id: record.upgrade_id,
      failed_checks: failed,
      checks: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check['passed'] === true])),
    });
    throw new OperatorError(
      'UPGRADE_VERIFICATION_FAILED',
      `Upgrade verification failed: ${failed.join(', ')}.`,
      'Keep the rollback window open, inspect the named checks, and roll back if the new release cannot be trusted.',
    );
  }

  const evidenceId = recordEvidence(options.root, 'verify', 'passed', options.operator, {
    upgrade_id: record.upgrade_id,
    from_release: record.from_release,
    to_release: record.to_release,
    checks: Object.fromEntries(Object.keys(checks).map((name) => [name, true])),
    migrations_expand_only: ledger.migrations.every((entry) => entry.expand_only),
    destructive_migrations: 0,
    consumer_reads: (checks['consumer_reads'] as Record<string, unknown>)['products'],
    secrets_included: false,
  });
  writeUpgradeRecord(options.root, {
    ...record,
    status: 'verified',
    updated_at: new Date().toISOString(),
    verification: {
      passed: true,
      verified_at: new Date().toISOString(),
      evidence_id: evidenceId,
      checks: Object.keys(checks),
    },
  });
  const current = readDeployment(options.root);
  if (current.state === 'verify_pending') {
    writeDeployment(options.root, { ...current, state: 'verified_open' });
  }
  return {
    upgrade_id: record.upgrade_id,
    from_release: record.from_release,
    to_release: record.to_release,
    store_schema_version: ledger.store_schema_version,
    migrations: {
      applied: ledger.migrations.map((entry) => entry.id),
      expand_only: true,
      destructive: 0,
    },
    passed: true,
    checks,
    rollback_window: record.rollback_window,
    evidence_id: evidenceId,
  };
}

/** A verification session for representative reads; it never persists state. */
function verificationSession(root: string, state: PlatformState, dataKey: Buffer): PlatformSession {
  const correlationId = randomUUID();
  return {
    root,
    state,
    dataKey,
    correlationId,
    audit(input) {
      appendAuditEvent(root, { ...input, correlation_id: correlationId }, dataKey);
    },
    save() {
      writePlatform(root, state);
    },
  };
}

/**
 * Ends rollback eligibility explicitly and only then cleans up the previous
 * release images; another upgrade is refused until this has happened.
 */
export function finalizeUpgrade(options: { root: string; operator: string }): Record<string, unknown> {
  const record = readUpgradeRecord(options.root);
  assertCondition(record !== undefined, 'UPGRADE_NOT_READY', 'No upgrade has been applied to this Deployment.');
  assertCondition(
    record.verification?.passed === true,
    'VERIFICATION_REQUIRED',
    'Finalization requires a passing upgrade verification.',
    'Run verify first; finalization ends rollback eligibility for good.',
  );
  if (record.status === 'finalized') {
    return {
      upgrade_id: record.upgrade_id,
      from_release: record.from_release,
      to_release: record.to_release,
      rollback_eligible: false,
      changed: false,
      finalization: record.finalization,
    };
  }
  assertCondition(
    record.rollback_window?.open === true,
    'ROLLBACK_NOT_ELIGIBLE',
    'The rollback window is no longer open.',
  );
  const closedAt = new Date().toISOString();
  const closed: UpgradeRecord = {
    ...record,
    status: 'finalized',
    updated_at: closedAt,
    rollback_window: {
      ...record.rollback_window,
      open: false,
      eligible: false,
      closed_at: closedAt,
      closed_by: 'finalize',
    },
  };
  // Eligibility ends durably before any cleanup is attempted.
  writeUpgradeRecord(options.root, closed);
  let removed = false;
  const previousDirectory = join(options.root, 'releases', record.from_release);
  if (record.from_release !== record.to_release && existsSync(previousDirectory)) {
    rmSync(previousDirectory, { recursive: true, force: true });
    removed = true;
  }
  const evidenceId = recordEvidence(options.root, 'finalize', 'finalized', options.operator, {
    upgrade_id: record.upgrade_id,
    from_release: record.from_release,
    to_release: record.to_release,
    rollback_eligible: false,
    rollback_closed_at: closedAt,
    previous_release_removed: removed,
    cleanup_after_eligibility_ended: true,
    secrets_included: false,
  });
  const finalization = { finalized_at: closedAt, previous_release_removed: removed, evidence_id: evidenceId };
  writeUpgradeRecord(options.root, { ...closed, finalization });
  return {
    upgrade_id: record.upgrade_id,
    from_release: record.from_release,
    to_release: record.to_release,
    rollback_eligible: false,
    changed: true,
    rollback_window: closed.rollback_window,
    cleanup: { previous_release: record.from_release, removed },
    finalization,
    evidence_id: evidenceId,
  };
}

/**
 * Returns the Deployment to the immediately previous compatible release from
 * local images, without a down-migration, bundle media, or registry access.
 * Governed data and post-upgrade writes are preserved byte for byte.
 */
export function rollbackDeployment(options: {
  root: string;
  masterKey: string;
  operator: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const record = readUpgradeRecord(options.root);
  assertCondition(
    record !== undefined && record.rollback_window?.open === true && record.rollback_window.eligible,
    'ROLLBACK_NOT_ELIGIBLE',
    'The Deployment has no open, eligible rollback window.',
    'Application Rollback is only available until explicit finalization.',
  );
  assertCondition(
    deployment.release === record.to_release,
    'ROLLBACK_NOT_APPLICABLE',
    `The Deployment runs ${deployment.release}, not the upgraded release ${record.to_release}.`,
  );
  assertCondition(
    deployment.service_open,
    'ROLLBACK_DEPLOYMENT_NOT_OPEN',
    'Application Rollback requires an open Deployment.',
  );
  const previousImages = verifyReleaseImages(options.root, record.from_release);
  const ledger = readLedger(options.root);
  assertCondition(
    ledger.migrations.every((entry) => entry.expand_only === true),
    'ROLLBACK_NOT_EXPAND_ONLY',
    'A recorded migration is not expand-only, so the previous application cannot read current data.',
    'Finalize this upgrade and recover through a supported release instead of a down-migration.',
  );
  const masterKey = readMountedMasterKey(options.root, options.masterKey);
  const wrapped = readJsonFile<WrappedDataKey>(join(options.root, 'config', 'wrapped-data-key.json'));
  unwrapDataKey(masterKey, wrapped);
  healthyServices(options.root, deployment);

  const stateBefore = readPlatform(options.root);
  const preservedDigest = canonicalDigest(stateBefore);
  const stateSchemaVersion = ledger.store_schema_version;
  const recordsAfterUpgrade = stateBefore.datasets
    .flatMap((dataset) => dataset.releases)
    .filter((release) => Date.parse(release.created_at) >= Date.parse(record.started_at)).length
    + stateBefore.data_products
      .flatMap((product) => product.releases)
      .filter((release) => Date.parse(release.created_at) >= Date.parse(record.started_at)).length;

  writeDeployment(options.root, { ...deployment, state: 'rolling_back', service_open: false });
  const previous: DeploymentState = {
    ...readDeployment(options.root),
    release: record.from_release,
    state: 'verified_open',
    service_open: false,
  };
  try {
    const services = startPinnedServices(options.root, previous);
    writeDeployment(options.root, { ...previous, service_open: true, runtime_services: services });
  } catch (error) {
    writeDeployment(options.root, { ...readDeployment(options.root), state: 'rollback_failed', service_open: false });
    recordEvidence(options.root, 'rollback', 'failed', options.operator, {
      upgrade_id: record.upgrade_id,
      from_release: record.to_release,
      to_release: record.from_release,
      error_code: error instanceof OperatorError ? error.code : 'ROLLBACK_FAILED',
      down_migrations: 0,
    });
    throw error;
  }

  const stateAfter = readPlatform(options.root);
  const dataUnchanged = canonicalDigest(stateAfter) === preservedDigest;
  const closedAt = new Date().toISOString();
  const rollback = {
    rolled_back_at: closedAt,
    to_release: record.from_release,
    down_migrations: 0 as const,
    data_unchanged: dataUnchanged,
    records_after_upgrade: recordsAfterUpgrade,
    evidence_id: '',
  };
  const evidenceId = recordEvidence(options.root, 'rollback', 'rolled_back', options.operator, {
    upgrade_id: record.upgrade_id,
    from_release: record.to_release,
    to_release: record.from_release,
    previous_images: previousImages,
    down_migrations: 0,
    state_schema_version: stateSchemaVersion,
    expand_only_migrations: ledger.migrations.length,
    data_unchanged: dataUnchanged,
    records_after_upgrade: recordsAfterUpgrade,
    offline: true,
    secrets_included: false,
  });
  rollback.evidence_id = evidenceId;
  const window: RollbackWindow = {
    ...record.rollback_window,
    open: false,
    eligible: false,
    closed_at: closedAt,
    closed_by: 'rollback',
  };
  writeUpgradeRecord(options.root, {
    ...record,
    status: 'rolled_back',
    updated_at: closedAt,
    rollback_window: window,
    rollback,
  });
  return {
    upgrade_id: record.upgrade_id,
    from_release: record.to_release,
    to_release: record.from_release,
    release: record.from_release,
    state: 'verified_open',
    service_open: true,
    runtime_services: readDeployment(options.root).runtime_services,
    down_migrations: 0,
    state_schema_version: stateSchemaVersion,
    data_unchanged: dataUnchanged,
    records_after_upgrade: recordsAfterUpgrade,
    previous_images: previousImages,
    offline: true,
    rollback_window: window,
    evidence_id: evidenceId,
  };
}
