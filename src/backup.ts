import { createHash, randomUUID, verify } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { appendAuditEvent, readAuditCheckpoint } from './audit.js';
import type { PurgeLedgerEntry, PurgeRecordKind } from './catalog.js';
import { canonicalDigest, canonicalJson, keyFingerprint, publicKeyFromFile } from './crypto.js';
import { assertCondition, OperatorError, type Fail } from './errors.js';
import { memberReader } from './grants.js';
import { decrypt, encryptValue, readMountedMasterKey, unwrapDataKey, type WrappedDataKey, type WrappedValue } from './keys.js';
import { findUserById, readPlatform, writePlatform, workspaceRoleOf, type PlatformState } from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { removePurgedRecord } from './retention.js';
import type { PlatformSession } from './session.js';
import {
  readDeployment,
  readJsonFile,
  recordEvidence,
  writeDeployment,
  writeJsonFile,
  type DeploymentState,
} from './state.js';

/**
 * The settled recovery objectives of spec section 13. Every checkpoint, backup
 * set, and restoration states these numbers, so the objectives are measurable
 * from durable non-secret evidence rather than implied by a schedule.
 */
export const CHECKPOINT_INTERVAL_SECONDS = 900;
export const BASE_BACKUP_INTERVAL_HOURS = 24;
export const RECOVERY_RETENTION_DAYS = 35;
export const RTO_LIMIT_SECONDS = 4 * 60 * 60;

/** Exported for tests and evidence; the value a coordinated checkpoint records. */
export const OBJECT_REPLICATION_INTERVAL_SECONDS = 900;

export interface CheckpointRecord {
  schema_version: 1;
  checkpoint_id: string;
  sequence: number;
  created_at: string;
  coordinated: true;
  database: {
    position: string;
    audit_sequence: number;
    audit_head: string | null;
    recorded_at: string;
  };
  objects: {
    position: string;
    count: number;
    bytes: number;
    replicated_at: string;
  };
  rpo: {
    previous_checkpoint_id: string | null;
    interval_seconds: number | null;
    limit_seconds: number;
    met: boolean | null;
  };
  wal: {
    mode: 'continuous';
    checkpoint_sequence: number;
    previous_position: string | null;
    continuous: boolean;
  };
  evidence_id: string;
  secrets_included: false;
}

export interface ObjectPosition {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BackupHealth {
  health: 'healthy' | 'degraded' | 'not_established';
  rpo_limit_seconds: number;
  last_checkpoint_id: string | null;
  last_checkpoint_at: string | null;
  checkpoint_age_seconds: number | null;
  last_rpo_seconds: number | null;
  rpo_met: boolean | null;
  reasons: string[];
}

/** Recovery sets live off-host: never inside the Deployment they protect. */
function assertOffHost(root: string, backupRoot: string): void {
  const relation = relative(resolve(root), resolve(backupRoot));
  assertCondition(
    relation.startsWith('..') || isAbsolute(relation),
    'BACKUP_TARGET_INSIDE_DEPLOYMENT',
    'The backup target must be off-host, outside the Deployment directory.',
    'Choose an off-host recovery target; a backup stored beside its own data does not survive that host.',
  );
}

function checkpointDirectory(root: string): string {
  return join(root, 'checkpoints');
}

function failureDirectory(root: string): string {
  return join(checkpointDirectory(root), 'failures');
}

interface CoordinationFailure {
  schema_version: 1;
  failed_at: string;
  error_code: string;
}

/** Refused coordination is durable: health degrades until a later checkpoint succeeds. */
function recordCoordinationFailure(root: string, at: Date, errorCode: string): void {
  mkdirSync(failureDirectory(root), { recursive: true, mode: 0o700 });
  const failure: CoordinationFailure = { schema_version: 1, failed_at: at.toISOString(), error_code: errorCode };
  writeJsonFile(join(failureDirectory(root), `${randomUUID()}.json`), failure);
}

/** The newest refused coordination attempt, which outranks an older good checkpoint. */
function latestCoordinationFailure(root: string): CoordinationFailure | undefined {
  const directory = failureDirectory(root);
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile<CoordinationFailure>(join(directory, name)))
    .sort((left, right) => Date.parse(left.failed_at) - Date.parse(right.failed_at))
    .at(-1);
}

function checkpointPath(root: string, checkpointId: string): string {
  return join(checkpointDirectory(root), `${checkpointId}.json`);
}

/** Every recorded checkpoint, oldest sequence first; the files are write-once. */
export function readCheckpoints(root: string): CheckpointRecord[] {
  const directory = checkpointDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile<CheckpointRecord>(join(directory, name)))
    .sort((left, right) => left.sequence - right.sequence);
}

export function latestCheckpoint(root: string): CheckpointRecord | undefined {
  return readCheckpoints(root).at(-1);
}

/**
 * The database position one checkpoint records: the whole governed state and
 * the tail of the hash-chained Audit Event log, so a checkpoint names exactly
 * the write position it observed.
 */
export function databasePosition(root: string, state: PlatformState = readPlatform(root)): CheckpointRecord['database'] {
  const audit = readAuditCheckpoint(root);
  return {
    position: canonicalDigest(state),
    audit_sequence: audit?.sequence ?? 0,
    audit_head: audit?.head_hash ?? null,
    recorded_at: new Date().toISOString(),
  };
}

/** One sha256 per file, so a checkpoint and a backup set agree on exact bytes. */
function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The authoritative objects one database position references. Export payloads
 * are sealed under the Deployment data key, so their integrity is proven by the
 * restoration drill that holds that key; a checkpoint still proves each sealed
 * object is present and parseable. An object the database does not reference is
 * not yet authoritative, so a write in flight never makes a checkpoint fail.
 */
export function objectPosition(root: string, state: PlatformState = readPlatform(root)): ObjectPosition[] {
  const objects: ObjectPosition[] = [];
  for (const raw of state.raw_acquisitions) {
    const absolute = join(root, raw.object_path);
    assertCondition(
      existsSync(absolute),
      'CHECKPOINT_OBJECTS_UNCOORDINATED',
      'A Raw Acquisition the database references has no object, so database and objects do not agree.',
      'Restore the object from replication before taking a new checkpoint.',
    );
    const bytes = readFileSync(absolute);
    assertCondition(
      digestBytes(bytes) === raw.content_hash,
      'CHECKPOINT_OBJECTS_UNCOORDINATED',
      'A Raw Acquisition object does not match the content hash the database recorded.',
      'Inspect the object store; a checkpoint never adopts a divergent object.',
    );
    objects.push({ path: raw.object_path, sha256: raw.content_hash, bytes: bytes.length });
  }
  for (const exported of state.exports) {
    const absolute = join(root, exported.object_path);
    assertCondition(
      existsSync(absolute),
      'CHECKPOINT_OBJECTS_UNCOORDINATED',
      'An Export the database references has no object, so database and objects do not agree.',
    );
    const sealed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
    assertCondition(
      typeof sealed['ciphertext'] === 'string' && typeof sealed['iv'] === 'string' && typeof sealed['tag'] === 'string',
      'CHECKPOINT_OBJECTS_UNCOORDINATED',
      'An Export object is not a sealed payload, so database and objects do not agree.',
    );
    const bytes = readFileSync(absolute);
    objects.push({ path: exported.object_path, sha256: digestBytes(bytes), bytes: bytes.length });
  }
  return objects.sort((left, right) => left.path.localeCompare(right.path));
}

/** One consistent read of the governed state and the objects it references. */
interface Snapshot {
  state: PlatformState;
  /** The exact governed-state bytes a base backup stores under its database position. */
  databaseState: string;
  database: CheckpointRecord['database'];
  objects: ObjectPosition[];
}

function takeSnapshot(root: string, at: Date): Snapshot {
  const state = readPlatform(root);
  const databaseState = canonicalJson(state);
  const database = { ...databasePosition(root, state), recorded_at: at.toISOString() };
  return { state, databaseState, database, objects: objectPosition(root, state) };
}

/** Takes one snapshot, leaving refused coordination durable so health can degrade. */
function coordinatedSnapshot(root: string, at: Date): Snapshot {
  try {
    return takeSnapshot(root, at);
  } catch (error) {
    if (error instanceof OperatorError) recordCoordinationFailure(root, at, error.code);
    throw error;
  }
}

function writeCheckpoint(
  root: string,
  operator: string,
  at: Date,
  snapshot: Snapshot,
): CheckpointRecord {
  const previous = latestCheckpoint(root);
  const interval = previous === undefined
    ? null
    : Math.max(0, Math.round((at.getTime() - Date.parse(previous.created_at)) / 1000));
  const checkpointId = randomUUID();
  const met = interval === null ? null : interval <= CHECKPOINT_INTERVAL_SECONDS;
  const evidenceId = recordEvidence(root, 'checkpoint', 'coordinated', operator, {
    checkpoint_id: checkpointId,
    database_position: snapshot.database.position,
    objects_position: canonicalDigest(snapshot.objects),
    objects_count: snapshot.objects.length,
    rpo_interval_seconds: interval,
    rpo_limit_seconds: CHECKPOINT_INTERVAL_SECONDS,
    rpo_met: met,
  });
  const checkpoint: CheckpointRecord = {
    schema_version: 1,
    checkpoint_id: checkpointId,
    sequence: (previous?.sequence ?? 0) + 1,
    created_at: at.toISOString(),
    coordinated: true,
    database: snapshot.database,
    objects: {
      position: canonicalDigest(snapshot.objects),
      count: snapshot.objects.length,
      bytes: snapshot.objects.reduce((total, object) => total + object.bytes, 0),
      replicated_at: at.toISOString(),
    },
    rpo: {
      previous_checkpoint_id: previous?.checkpoint_id ?? null,
      interval_seconds: interval,
      limit_seconds: CHECKPOINT_INTERVAL_SECONDS,
      met,
    },
    wal: {
      mode: 'continuous',
      checkpoint_sequence: (previous?.sequence ?? 0) + 1,
      previous_position: previous?.database.position ?? null,
      continuous: true,
    },
    evidence_id: evidenceId,
    secrets_included: false,
  };
  mkdirSync(checkpointDirectory(root), { recursive: true, mode: 0o700 });
  writeJsonFile(checkpointPath(root, checkpointId), checkpoint);
  return checkpoint;
}

/**
 * Records one coordinated checkpoint of the database and object positions.
 * A checkpoint is durable evidence, so it is written once and never rewritten;
 * a database position whose objects have moved on is refused rather than
 * recorded, and the last good checkpoint keeps ageing into degraded health.
 */
export function createCheckpoint(options: {
  root: string;
  operator: string;
  at?: string;
  backupRoot?: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  assertCondition(deployment.service_open, 'CHECKPOINT_DEPLOYMENT_CLOSED', 'A coordinated checkpoint requires an open Deployment.', 'Initialize the Deployment before taking checkpoints.');
  const at = options.at === undefined ? new Date() : new Date(options.at);
  assertCondition(!Number.isNaN(at.getTime()), 'CHECKPOINT_AT_INVALID', 'The checkpoint instant must be an ISO 8601 instant.');
  let snapshot: Snapshot;
  try {
    snapshot = coordinatedSnapshot(options.root, at);
  } catch (error) {
    if (error instanceof OperatorError) {
      recordEvidence(options.root, 'checkpoint', 'failed', options.operator, {
        error_code: error.code,
        rpo_limit_seconds: CHECKPOINT_INTERVAL_SECONDS,
      });
    }
    throw error;
  }
  const checkpoint = writeCheckpoint(options.root, options.operator, at, snapshot);
  if (options.backupRoot !== undefined) {
    replicateCheckpoint(options.backupRoot, checkpoint);
    replicateLedger(options.backupRoot, deployment.deployment_id, snapshot.state, at);
  }
  return { ...checkpoint };
}

/* ------------------------------------------------------------------------- *
 * Recovery sets
 * ------------------------------------------------------------------------- */

export interface RecoveryComponent {
  role: 'database' | 'objects' | 'configuration' | 'manifests' | 'audit' | 'purge_ledger';
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  encrypted: true;
  restores_to?: string;
  plaintext_sha256: string;
}

export interface RecoveryManifest {
  schema_version: 1;
  backup_id: string;
  kind: 'base';
  created_at: string;
  deployment_id: string;
  release: string;
  payloads_encrypted: true;
  secrets_included: false;
  cadence: {
    base_backup_hours: number;
    checkpoint_seconds: number;
    object_replication_seconds: number;
    wal: 'continuous';
  };
  retention: { days: number; retain_until: string };
  checkpoint_id: string;
  positions: { database: CheckpointRecord['database']; objects: CheckpointRecord['objects'] };
  purge_ledger: { through_sequence: number; entries: number; digest: string };
  components: RecoveryComponent[];
  excluded: Array<{ name: string; reason: string; rebuildable: true }>;
  escrowed_separately: { master_key: true };
}

export interface PurgeLedgerReplica {
  schema_version: 1;
  deployment_id: string;
  updated_at: string;
  head_sequence: number;
  digest: string;
  entries: PurgeLedgerEntry[];
}

/** Recovery sets keep monitoring and rebuildable derived data out on purpose. */
const EXCLUDED: RecoveryManifest['excluded'] = [
  {
    name: 'monitoring',
    reason: 'Prometheus metrics, JSON logs, and OpenTelemetry traces are observability state a later release rebuilds.',
    rebuildable: true,
  },
  {
    name: 'derived_cache_indexes',
    reason: 'Query caches, cursors, and the local embedding index are derived data a later query rebuilds.',
    rebuildable: true,
  },
];

function backupsDirectory(backupRoot: string): string {
  return join(backupRoot, 'backups');
}

function backupDirectory(backupRoot: string, backupId: string): string {
  return join(backupsDirectory(backupRoot), backupId);
}

export function ledgerReplicaPath(backupRoot: string): string {
  return join(backupRoot, 'ledger', 'purge-ledger.json');
}

/** Reads the off-host sequenced Purge Ledger a restoration must replay. */
export function readLedgerReplica(backupRoot: string, deploymentId?: string): PurgeLedgerReplica {
  const path = ledgerReplicaPath(backupRoot);
  assertCondition(
    existsSync(path),
    'RESTORE_LEDGER_MISSING',
    'The off-host Purge Ledger replica is missing, so a restoration cannot promise that purged content stays deleted.',
    'Replicate the Purge Ledger from the running Deployment before restoring.',
  );
  const replica = readJsonFile<PurgeLedgerReplica>(path);
  assertCondition(replica.schema_version === 1 && Array.isArray(replica.entries), 'RESTORE_LEDGER_INVALID', 'The off-host Purge Ledger replica is not readable.');
  assertCondition(
    replica.digest === canonicalDigest(replica.entries),
    'RESTORE_LEDGER_TAMPERED',
    'The off-host Purge Ledger replica does not match its own digest.',
    'Re-replicate the ledger from a trusted Deployment before restoring.',
  );
  if (deploymentId !== undefined) {
    assertCondition(replica.deployment_id === deploymentId, 'RESTORE_LEDGER_MISMATCH', 'The off-host Purge Ledger belongs to a different Deployment.');
  }
  return replica;
}

/** Appends one checkpoint to the off-host write journal, so the WAL is continuous. */
export function replicateCheckpoint(backupRoot: string, checkpoint: CheckpointRecord): void {
  const directory = join(backupRoot, 'replication');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, 'checkpoints.jsonl'),
    `${JSON.stringify(checkpoint)}\n`,
    { flag: 'a', mode: 0o600 },
  );
}

/** Replicates the sequenced Purge Ledger, which is kept until no backup can hold purged content. */
export function replicateLedger(
  backupRoot: string,
  deploymentId: string,
  state: PlatformState,
  at: Date,
): PurgeLedgerReplica {
  const entries = JSON.parse(JSON.stringify(state.purge_ledger)) as PurgeLedgerEntry[];
  const replica: PurgeLedgerReplica = {
    schema_version: 1,
    deployment_id: deploymentId,
    updated_at: at.toISOString(),
    head_sequence: entries.at(-1)?.sequence ?? 0,
    digest: canonicalDigest(entries),
    entries,
  };
  mkdirSync(dirname(ledgerReplicaPath(backupRoot)), { recursive: true, mode: 0o700 });
  writeJsonFile(ledgerReplicaPath(backupRoot), replica);
  return replica;
}

function encryptComponent(
  directory: string,
  dataKey: Buffer,
  component: {
    role: RecoveryComponent['role'];
    name: string;
    target: string;
    payload: Buffer;
    restoresTo?: string;
    /** Configuration is sealed under the master key, so the wrapped data key opens first. */
    key?: Buffer;
  },
): RecoveryComponent {
  const filePath = join(directory, component.target);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const sealed = encryptValue(component.key ?? dataKey, component.payload);
  const text = `${JSON.stringify(sealed)}\n`;
  writeFileSync(filePath, text, { mode: 0o600 });
  return {
    role: component.role,
    name: component.name,
    path: component.target,
    sha256: digestBytes(Buffer.from(text, 'utf8')),
    bytes: Buffer.byteLength(text, 'utf8'),
    encrypted: true,
    ...(component.restoresTo === undefined ? {} : { restores_to: component.restoresTo }),
    plaintext_sha256: digestBytes(component.payload),
  };
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Configuration a restored Deployment needs, excluding the separately escrowed master key. */
function configurationBundle(root: string, deployment: Record<string, unknown>): Record<string, unknown> {
  return {
    files: {
      'deployment.json': deployment,
      'license-request.json': readOptional(join(root, 'license-request.json')),
      'license.json': readOptional(join(root, 'license.json')),
      'trust/release-key.pem': readOptional(join(root, 'trust', 'release-key.pem')),
      'trust/release-key.fingerprint': readOptional(join(root, 'trust', 'release-key.fingerprint')),
      'trust/license-key.json': readOptional(join(root, 'trust', 'license-key.json')),
      'config/wrapped-data-key.json': readOptional(join(root, 'config', 'wrapped-data-key.json')),
      'state/operator-console.json': readOptional(join(root, 'state', 'operator-console.json')),
    },
    escrowed_separately: { master_key: true },
  };
}

function manifestBundle(root: string, release: string): Record<string, unknown> {
  const releaseDirectory = join(root, 'releases', release);
  return {
    release,
    files: {
      'manifest.json': readOptional(join(releaseDirectory, 'manifest.json')),
      'manifest.sig': readOptional(join(releaseDirectory, 'manifest.sig')),
      'compose.yaml': readOptional(join(releaseDirectory, 'compose.yaml')),
    },
  };
}

function auditBundle(root: string): Record<string, unknown> {
  return {
    'events.jsonl': readOptional(join(root, 'audit', 'events.jsonl')),
    'checkpoint.json': readOptional(join(root, 'audit', 'checkpoint.json')),
  };
}

function jsonPayload(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

/**
 * Produces one coordinated off-host base backup set: the governed database, the
 * authoritative objects, configuration, release manifests, the Audit Event
 * chain, and the sequenced Purge Ledger, each sealed under the Deployment data
 * key. The master key never enters the set; it is escrowed separately.
 */
export function createBackup(options: {
  root: string;
  masterKey: string;
  operator: string;
  backupRoot: string;
  at?: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  assertCondition(deployment.service_open, 'BACKUP_DEPLOYMENT_CLOSED', 'A base backup requires an open Deployment.', 'Initialize the Deployment before taking base backups.');
  const at = options.at === undefined ? new Date() : new Date(options.at);
  assertCondition(!Number.isNaN(at.getTime()), 'BACKUP_AT_INVALID', 'The backup instant must be an ISO 8601 instant.');
  const masterKey = readMountedMasterKey(options.root, options.masterKey);
  const wrapped = readJsonFile<WrappedDataKey>(join(options.root, 'config', 'wrapped-data-key.json'));
  const dataKey = unwrapDataKey(masterKey, wrapped);

  let snapshot: Snapshot;
  try {
    snapshot = coordinatedSnapshot(options.root, at);
  } catch (error) {
    if (error instanceof OperatorError) {
      recordEvidence(options.root, 'backup-create', 'failed', options.operator, { error_code: error.code });
    }
    throw error;
  }
  const checkpoint = writeCheckpoint(options.root, options.operator, at, snapshot);
  replicateCheckpoint(options.backupRoot, checkpoint);
  const ledger = replicateLedger(options.backupRoot, deployment.deployment_id, snapshot.state, at);

  const backupId = randomUUID();
  const directory = backupDirectory(options.backupRoot, backupId);
  assertCondition(!existsSync(directory), 'BACKUP_EXISTS', 'A recovery set with this identifier already exists.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const deploymentSnapshot = JSON.parse(JSON.stringify(readDeployment(options.root))) as Record<string, unknown>;
  const components: RecoveryComponent[] = [
    encryptComponent(directory, dataKey, {
      role: 'database',
      name: 'governed-database',
      target: 'database.enc.json',
      payload: Buffer.from(snapshot.databaseState, 'utf8'),
      restoresTo: 'state/platform.json',
    }),
    encryptComponent(directory, dataKey, {
      role: 'configuration',
      name: 'deployment-configuration',
      target: 'configuration.enc.json',
      payload: jsonPayload(configurationBundle(options.root, deploymentSnapshot)),
      restoresTo: 'configuration',
      key: masterKey,
    }),
    encryptComponent(directory, dataKey, {
      role: 'manifests',
      name: 'release-manifests',
      target: 'manifests.enc.json',
      payload: jsonPayload(manifestBundle(options.root, deployment.release)),
      restoresTo: `releases/${deployment.release}`,
    }),
    ...Object.entries(auditBundle(options.root))
      .filter(([, content]) => content !== null)
      .map(([name, content]) => encryptComponent(directory, dataKey, {
        role: 'audit',
        name: `audit-${name}`,
        target: `audit/${name}.enc.json`,
        payload: Buffer.from(content as string, 'utf8'),
        restoresTo: `audit/${name}`,
      })),
    encryptComponent(directory, dataKey, {
      role: 'purge_ledger',
      name: 'purge-ledger-replica',
      target: 'purge-ledger.enc.json',
      payload: jsonPayload(ledger),
    }),
    ...snapshot.objects.map((object) => encryptComponent(directory, dataKey, {
      role: 'objects',
      name: object.path,
      target: `objects/${object.path}.enc.json`,
      payload: readFileSync(join(options.root, object.path)),
      restoresTo: object.path,
    })),
  ];
  const manifest: RecoveryManifest = {
    schema_version: 1,
    backup_id: backupId,
    kind: 'base',
    created_at: at.toISOString(),
    deployment_id: deployment.deployment_id,
    release: deployment.release,
    payloads_encrypted: true,
    secrets_included: false,
    cadence: {
      base_backup_hours: BASE_BACKUP_INTERVAL_HOURS,
      checkpoint_seconds: CHECKPOINT_INTERVAL_SECONDS,
      object_replication_seconds: OBJECT_REPLICATION_INTERVAL_SECONDS,
      wal: 'continuous',
    },
    retention: {
      days: RECOVERY_RETENTION_DAYS,
      retain_until: new Date(at.getTime() + RECOVERY_RETENTION_DAYS * 86_400_000).toISOString(),
    },
    checkpoint_id: checkpoint.checkpoint_id,
    positions: { database: checkpoint.database, objects: checkpoint.objects },
    purge_ledger: { through_sequence: ledger.head_sequence, entries: ledger.entries.length, digest: ledger.digest },
    components,
    excluded: EXCLUDED,
    escrowed_separately: { master_key: true },
  };
  writeJsonFile(join(directory, 'manifest.json'), manifest);
  const evidenceId = recordEvidence(options.root, 'backup-create', 'coordinated', options.operator, {
    backup_id: backupId,
    checkpoint_id: checkpoint.checkpoint_id,
    retention_days: RECOVERY_RETENTION_DAYS,
    retain_until: manifest.retention.retain_until,
    components: components.length,
    excluded: manifest.excluded.map((entry) => entry.name),
    purge_ledger_through_sequence: ledger.head_sequence,
    payloads_encrypted: true,
  });
  return { ...manifest, evidence_id: evidenceId };
}

export function readRecoveryManifest(backupRoot: string, backupId: string): RecoveryManifest {
  const path = join(backupDirectory(backupRoot, backupId), 'manifest.json');
  assertCondition(existsSync(path), 'BACKUP_NOT_FOUND', 'The named recovery set does not exist.', 'List the available recovery sets on the backup target.');
  return readJsonFile<RecoveryManifest>(path);
}

/** Recomputes every stored component digest, so a damaged set is named, never used. */
export function verifyRecoverySet(backupRoot: string, manifest: RecoveryManifest): void {
  const directory = backupDirectory(backupRoot, manifest.backup_id);
  for (const component of manifest.components) {
    const path = join(directory, component.path);
    assertCondition(existsSync(path), 'BACKUP_INTEGRITY_FAILED', `The recovery set is missing ${component.path}.`, 'Discard the damaged set and take a new base backup.');
    assertCondition(
      digestBytes(readFileSync(path)) === component.sha256,
      'BACKUP_INTEGRITY_FAILED',
      `The recovery set checksum failed for ${component.path}.`,
      'Discard the damaged set and take a new base backup.',
    );
  }
}

/** Lists recovery sets in creation order, with the settled retention applied. */
export function listBackups(options: { backupRoot: string }): Record<string, unknown> {
  const directory = backupsDirectory(options.backupRoot);
  const manifests = existsSync(directory)
    ? readdirSync(directory)
      .filter((name) => existsSync(join(directory, name, 'manifest.json')))
      .map((name) => readJsonFile<RecoveryManifest>(join(directory, name, 'manifest.json')))
      .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
    : [];
  const now = Date.now();
  const ledgerPath = ledgerReplicaPath(options.backupRoot);
  const ledger = existsSync(ledgerPath) ? readJsonFile<PurgeLedgerReplica>(ledgerPath) : null;
  return {
    retention_days: RECOVERY_RETENTION_DAYS,
    backups: manifests.map((manifest) => ({
      backup_id: manifest.backup_id,
      kind: manifest.kind,
      created_at: manifest.created_at,
      deployment_id: manifest.deployment_id,
      checkpoint_id: manifest.checkpoint_id,
      components: manifest.components.length,
      retain_until: manifest.retention.retain_until,
      within_retention: now <= Date.parse(manifest.retention.retain_until),
      purge_ledger_through_sequence: manifest.purge_ledger.through_sequence,
    })),
    ledger: {
      head_sequence: ledger?.head_sequence ?? 0,
      updated_at: ledger?.updated_at ?? null,
      entries: ledger?.entries.length ?? 0,
    },
  };
}

/** Shows one recovery set and its recomputed integrity. */
export function showBackup(options: { backupRoot: string; backupId: string }): Record<string, unknown> {
  const manifest = readRecoveryManifest(options.backupRoot, options.backupId);
  verifyRecoverySet(options.backupRoot, manifest);
  return { manifest, integrity: { verified: true, checked: manifest.components.length } };
}

/** The current protection state, stated by every `status` answer. */
export function backupHealth(root: string, now: Date = new Date()): BackupHealth {
  const latest = latestCheckpoint(root);
  const failure = latestCoordinationFailure(root);
  if (latest === undefined) {
    const refused = failure !== undefined;
    return {
      health: refused ? 'degraded' : 'not_established',
      rpo_limit_seconds: CHECKPOINT_INTERVAL_SECONDS,
      last_checkpoint_id: null,
      last_checkpoint_at: null,
      checkpoint_age_seconds: null,
      last_rpo_seconds: null,
      rpo_met: null,
      reasons: refused ? ['objects_uncoordinated'] : [],
    };
  }
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(latest.created_at)) / 1000));
  const reasons: string[] = [];
  if (age > CHECKPOINT_INTERVAL_SECONDS) reasons.push('checkpoint_stale');
  if (latest.rpo.met === false) reasons.push('checkpoint_gap');
  // A refused coordination is newer evidence than the last good checkpoint: the
  // stores disagree right now, so health degrades until a later checkpoint lands.
  if (failure !== undefined && Date.parse(failure.failed_at) > Date.parse(latest.created_at)) {
    reasons.push('objects_uncoordinated');
  }
  return {
    health: reasons.length === 0 ? 'healthy' : 'degraded',
    rpo_limit_seconds: CHECKPOINT_INTERVAL_SECONDS,
    last_checkpoint_id: latest.checkpoint_id,
    last_checkpoint_at: latest.created_at,
    checkpoint_age_seconds: age,
    last_rpo_seconds: latest.rpo.interval_seconds,
    rpo_met: latest.rpo.met,
    reasons,
  };
}

/** A restored Deployment keeps background workers closed until explicitly enabled. */
export function assertWorkersEnabled(root: string): void {
  if (readDeployment(root).workers_enabled !== false) return;
  assertCondition(
    false,
    'WORKERS_DISABLED',
    'Background workers stay disabled on a restored Deployment until an Operator enables them.',
    'Run enable-workers after the restoration verification passes.',
  );
}

/** A restored Deployment holds no external connectivity until explicitly enabled. */
export function assertConnectivityEnabled(root: string): void {
  if (readDeployment(root).connectivity_enabled !== false) return;
  assertCondition(
    false,
    'CONNECTIVITY_DISABLED',
    'External connectivity stays disabled on a restored Deployment until an Operator enables it.',
    'Run enable-connectivity after the restoration verification passes.',
  );
}

/* ------------------------------------------------------------------------- *
 * Isolated restoration and restoration drills
 * ------------------------------------------------------------------------- */

interface ConfigurationBundle {
  files: Record<string, unknown>;
  escrowed_separately: { master_key: true };
}

interface RestoredMaterial {
  root: string;
  manifest: RecoveryManifest;
  ledger: PurgeLedgerReplica;
  state: PlatformState;
  dataKey: Buffer;
  /** Records the Purge Ledger replay removed, and those an older set never held. */
  replay: { removed: number; already_absent: number };
}

function componentOf(manifest: RecoveryManifest, role: RecoveryComponent['role']): RecoveryComponent {
  const component = manifest.components.find((candidate) => candidate.role === role);
  assertCondition(component !== undefined, 'BACKUP_INTEGRITY_FAILED', `The recovery set has no ${role} component.`);
  return component;
}

function componentsOf(manifest: RecoveryManifest, role: RecoveryComponent['role']): RecoveryComponent[] {
  return manifest.components.filter((candidate) => candidate.role === role);
}

function decryptComponent(
  backupRoot: string,
  manifest: RecoveryManifest,
  component: RecoveryComponent,
  key: Buffer,
): Buffer {
  const sealed = readJsonFile<WrappedValue>(join(backupDirectory(backupRoot, manifest.backup_id), component.path));
  let plaintext: Buffer;
  try {
    plaintext = decrypt(key, sealed);
  } catch {
    throw new OperatorError(
      'RESTORE_KEY_MISMATCH',
      'The escrowed master key does not open this recovery set.',
      'Supply the master key escrowed for this Deployment.',
    );
  }
  assertCondition(
    digestBytes(plaintext) === component.plaintext_sha256,
    'RESTORE_INTEGRITY_FAILED',
    `The recovery set payload ${component.path} does not match its recorded digest.`,
  );
  return plaintext;
}

/** Writes one restored file, refusing any path a recovery set should not name. */
function writeRestored(root: string, relativePath: string, content: Buffer | string): void {
  const normalized = relativePath.replace(/\\/g, '/');
  assertCondition(
    !normalized.startsWith('/') && !normalized.split('/').includes('..'),
    'RESTORE_PATH_INVALID',
    'The recovery set names a file outside the restored Deployment.',
  );
  const absolute = join(root, ...normalized.split('/'));
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, content, { mode: 0o600 });
}

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

/** True while one record is still stored, judged the way a Purge judges it. */
function recordPresent(state: PlatformState, kind: PurgeRecordKind, recordId: string): boolean {
  switch (kind) {
    case 'raw_acquisition':
      return state.raw_acquisitions.some((record) => record.raw_id === recordId);
    case 'dataset_release': {
      const [datasetId, release] = recordId.split('#');
      return state.datasets.some((dataset) => dataset.dataset_id === datasetId
        && dataset.releases.some((candidate) => candidate.release === Number(release)));
    }
    case 'data_product_release': {
      const [productId, release] = recordId.split('#');
      return state.data_products.some((product) => product.data_product_id === productId
        && product.releases.some((candidate) => candidate.release === Number(release)));
    }
    case 'report':
      return state.reports.some((record) => record.report_id === recordId);
    case 'proposal_evidence':
      return state.artifact_proposals.some((record) => record.proposal_id === recordId);
    case 'export':
      return state.exports.some((record) => record.export_id === recordId);
  }
}

/**
 * Replays the newest sequenced Purge Ledger over a restored database, so an
 * older recovery set can never make deleted content reappear.
 */
function replayLedger(session: PlatformSession, ledger: PurgeLedgerReplica): RestoredMaterial['replay'] {
  let removed = 0;
  let alreadyAbsent = 0;
  session.state.purge_ledger = JSON.parse(JSON.stringify(ledger.entries)) as PurgeLedgerEntry[];
  for (const entry of [...ledger.entries].sort((left, right) => left.sequence - right.sequence)) {
    for (const purged of entry.purged) {
      const present = recordPresent(session.state, purged.record_kind, purged.record_id);
      removePurgedRecord(session, { record_kind: purged.record_kind, record_id: purged.record_id });
      if (present) removed += 1;
      else alreadyAbsent += 1;
    }
  }
  return { removed, already_absent: alreadyAbsent };
}

/**
 * Builds a closed restored Deployment from one recovery set: the governed
 * database, its authoritative objects, configuration, release manifests, and
 * the Audit Event chain, with the newest Purge Ledger replayed before anything
 * is served. Service stays closed; workers and connectivity stay disabled.
 */
function materializeRestored(options: {
  targetRoot: string;
  backupRoot: string;
  manifest: RecoveryManifest;
  masterKey: string;
}): RestoredMaterial {
  const { manifest, backupRoot } = options;
  assertCondition(!existsSync(options.targetRoot), 'DEPLOYMENT_EXISTS', 'The restoration target already exists.', 'Restore into a new, empty directory.');
  const masterKey = readMountedMasterKey(options.targetRoot, options.masterKey);
  const configuration = JSON.parse(
    decryptComponent(backupRoot, manifest, componentOf(manifest, 'configuration'), masterKey).toString('utf8'),
  ) as ConfigurationBundle;
  const wrappedText = configuration.files['config/wrapped-data-key.json'];
  assertCondition(typeof wrappedText === 'string', 'RESTORE_INTEGRITY_FAILED', 'The recovery set holds no wrapped data key.');
  const wrapped = JSON.parse(wrappedText) as WrappedDataKey;
  const dataKey = unwrapDataKey(masterKey, wrapped);

  const database = decryptComponent(backupRoot, manifest, componentOf(manifest, 'database'), dataKey);
  assertCondition(
    digestBytes(database) === manifest.positions.database.position,
    'RESTORE_INTEGRITY_FAILED',
    'The restored database does not match the checkpoint position the recovery set records.',
  );
  const state = JSON.parse(database.toString('utf8')) as PlatformState;
  const ledger = readLedgerReplica(backupRoot, manifest.deployment_id);

  const recordedLedger = JSON.parse(
    decryptComponent(backupRoot, manifest, componentOf(manifest, 'purge_ledger'), dataKey).toString('utf8'),
  ) as PurgeLedgerReplica;
  assertCondition(
    recordedLedger.digest === manifest.purge_ledger.digest,
    'RESTORE_INTEGRITY_FAILED',
    'The Purge Ledger inside the recovery set does not match the set manifest.',
  );

  const parent = dirname(options.targetRoot);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.dc-restore-${randomUUID()}`);
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    writeRestored(staging, 'state/platform.json', database);
    for (const [name, content] of Object.entries(configuration.files)) {
      if (name === 'deployment.json' || name === 'config/wrapped-data-key.json') continue;
      if (typeof content === 'string') writeRestored(staging, name, content);
    }
    writeRestored(staging, 'config/wrapped-data-key.json', wrappedText);
    const manifests = JSON.parse(
      decryptComponent(backupRoot, manifest, componentOf(manifest, 'manifests'), dataKey).toString('utf8'),
    ) as { release: string; files: Record<string, string | null> };
    for (const [name, content] of Object.entries(manifests.files)) {
      if (typeof content === 'string') writeRestored(staging, `releases/${manifests.release}/${name}`, content);
    }
    for (const component of componentsOf(manifest, 'audit')) {
      writeRestored(staging, String(component.restores_to), decryptComponent(backupRoot, manifest, component, dataKey));
    }
    for (const component of componentsOf(manifest, 'objects')) {
      writeRestored(staging, String(component.restores_to), decryptComponent(backupRoot, manifest, component, dataKey));
    }

    const session = verificationSession(staging, state, dataKey);
    const replay = replayLedger(session, ledger);
    writePlatform(staging, state);
    const original = configuration.files['deployment.json'] as DeploymentState | undefined;
    assertCondition(original !== undefined, 'RESTORE_INTEGRITY_FAILED', 'The recovery set holds no Deployment configuration.');
    const restoredDeployment: DeploymentState = {
      schema_version: 1,
      deployment_id: original.deployment_id,
      release: original.release,
      state: 'restoring',
      service_open: false,
      created_at: original.created_at,
      mfa_enrolled: original.mfa_enrolled === true,
      default_credentials: original.default_credentials === true,
      master_key_external: true,
      workers_enabled: false,
      connectivity_enabled: false,
      restored: { backup_id: manifest.backup_id, restored_at: new Date().toISOString(), verification_id: '' },
    };
    writeDeployment(staging, restoredDeployment);
    renameSync(staging, options.targetRoot);
    return { root: options.targetRoot, manifest, ledger, state, dataKey, replay };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

interface VerificationReport {
  integrity: { passed: boolean; components: number; database_position: string };
  objects: { passed: boolean; count: number; verified: number; bytes: number };
  keys: { passed: boolean; data_key_unwrapped: boolean; sealed_credentials: number; decrypted: number };
  manifests: { passed: boolean; release: string; signature_verified: boolean };
  provenance: { passed: boolean; dataset_releases: number; batches: number; dangling: number };
  governed_reads: {
    passed: boolean;
    products: number;
    reads: Array<Record<string, unknown>>;
    purged_refusals: { confirmed: number; failed: number };
  };
  purge_ledger: {
    passed: boolean;
    applied_through_sequence: number;
    entries: number;
    purged_records: number;
    removed: number;
    already_absent: number;
  };
}

/** Every sealed credential a restored Deployment holds, so custody is provable. */
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

/** Picks the member a restoration drill reads through: an administrator when one exists. */
function readIdentity(state: PlatformState, workspaceId: string): { userId: string; role: string } | undefined {
  const members = state.memberships.filter((membership) => membership.workspace_id === workspaceId
    && findUserById(state, membership.user_id)?.status === 'active');
  const administrator = members.find((membership) => membership.role === 'Workspace Administrator');
  const member = administrator ?? members[0];
  return member === undefined ? undefined : { userId: member.user_id, role: member.role };
}

/** One governed read through the same engine and Grants a Consumer reads through. */
function governedRead(
  session: PlatformSession,
  state: PlatformState,
  product: PlatformState['data_products'][number],
  request: Record<string, unknown>,
): Record<string, unknown> {
  const identity = readIdentity(state, product.workspace_id);
  assertCondition(identity !== undefined, 'RESTORE_VERIFICATION_FAILED', 'A restored Data Product has no active member to read through.');
  const user = findUserById(state, identity.userId);
  assertCondition(user !== undefined, 'RESTORE_VERIFICATION_FAILED', 'A restored member identity is missing.');
  const fail: Fail = (code, message, nextStep) => {
    throw new OperatorError(code, message, nextStep);
  };
  return executeDataProductQuery({
    session,
    reader: memberReader(session, user, workspaceRoleOf(state, user.user_id, product.workspace_id)),
    product,
    context: { action: 'data_product_query', scope: 'workspace', workspace_id: product.workspace_id, target: product.data_product_id },
    request,
    fail,
  });
}

/**
 * Verifies a restored Deployment through the governed engine a Consumer reads
 * through: exact hashes, authoritative objects, key custody, release manifest
 * authenticity, Provenance references, and representative reads.
 */
function verifyRestored(material: RestoredMaterial): VerificationReport {
  const { root, manifest, state, dataKey } = material;

  // Integrity: every restored file still hashes to what the set recorded. The
  // database is proven against the recorded checkpoint position while it is
  // materialized; the Purge Ledger replay then legitimately rewrites it, and
  // retires exactly the objects it names.
  const retired = material.ledger.entries.flatMap((entry) => entry.purged)
    .filter((record) => record.record_kind === 'raw_acquisition' || record.record_kind === 'export')
    .map((record) => record.record_id);
  let components = 0;
  for (const component of manifest.components) {
    if (component.role === 'database' || component.role === 'configuration' || component.role === 'manifests') continue;
    if (component.restores_to === undefined) continue;
    if (retired.some((recordId) => component.restores_to?.includes(recordId) === true)) continue;
    const absolute = join(root, ...component.restores_to.split('/'));
    assertCondition(existsSync(absolute), 'RESTORE_VERIFICATION_FAILED', `The restored Deployment is missing ${component.restores_to}.`);
    assertCondition(
      digestBytes(readFileSync(absolute)) === component.plaintext_sha256,
      'RESTORE_VERIFICATION_FAILED',
      `The restored file ${component.restores_to} does not match the recovery set digest.`,
    );
    components += 1;
  }

  // Objects: every authoritative object is present and byte-exact; an Export is
  // opened with the restored data key and reconciled with its recorded hash.
  let verifiedObjects = 0;
  let objectBytes = 0;
  for (const raw of state.raw_acquisitions) {
    const absolute = join(root, raw.object_path);
    assertCondition(existsSync(absolute), 'RESTORE_VERIFICATION_FAILED', 'A restored Raw Acquisition object is missing.');
    const bytes = readFileSync(absolute);
    assertCondition(digestBytes(bytes) === raw.content_hash, 'RESTORE_VERIFICATION_FAILED', 'A restored Raw Acquisition object does not match its recorded content hash.');
    verifiedObjects += 1;
    objectBytes += bytes.length;
  }
  for (const exported of state.exports) {
    const absolute = join(root, exported.object_path);
    assertCondition(existsSync(absolute), 'RESTORE_VERIFICATION_FAILED', 'A restored Export object is missing.');
    const plaintext = decrypt(dataKey, readJsonFile<WrappedValue>(absolute));
    assertCondition(digestBytes(plaintext) === exported.content_hash, 'RESTORE_VERIFICATION_FAILED', 'A restored Export object does not match its recorded content hash.');
    verifiedObjects += 1;
    objectBytes += plaintext.length;
  }

  // Keys: the escrowed master key unwraps the data key, and that key opens the
  // sealed credentials the restored Deployment would inject just in time.
  const sealed = sealedSecrets(state);
  let decrypted = 0;
  for (const secret of sealed) {
    assertCondition(decrypt(dataKey, secret).length > 0, 'RESTORE_VERIFICATION_FAILED', 'A restored sealed credential opened to nothing.');
    decrypted += 1;
  }

  // Manifests: the restored release manifest is authentic under the trusted
  // release key the Deployment installed and still holds.
  const releaseDirectory = join(root, 'releases', manifest.release);
  const releaseManifest = readJsonFile<Record<string, unknown>>(join(releaseDirectory, 'manifest.json'));
  const signature = readJsonFile<{ algorithm?: string; key_id?: string; value?: string }>(join(releaseDirectory, 'manifest.sig'));
  const trustedKey = publicKeyFromFile(join(root, 'trust', 'release-key.pem'));
  const fingerprint = keyFingerprint(trustedKey);
  const signatureVerified = signature.algorithm === 'Ed25519'
    && signature.key_id === fingerprint
    && typeof signature.value === 'string'
    && verify(null, Buffer.from(canonicalJson(releaseManifest)), trustedKey, Buffer.from(signature.value, 'base64'));

  // Provenance: every Release reconciles to its own records, and every lineage
  // reference resolves except raw bytes the Purge Ledger itself retired.
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
      if (release.record_count !== release.records.length) dangling += 1;
      if (canonicalDigest(release.records.map((record) => ({ identity: record.identity, values: record.values }))) !== release.records_hash) {
        dangling += 1;
      }
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
  assertCondition(dangling === 0, 'RESTORE_VERIFICATION_FAILED', 'Restored Provenance does not reconcile with its Releases.');

  // Governed reads: each published Data Product answers through the governed
  // engine, and a Release the Purge Ledger retired stays explicitly expired.
  const session = verificationSession(root, state, dataKey);
  const reads: Array<Record<string, unknown>> = [];
  for (const product of state.data_products.filter((candidate) => candidate.releases.length > 0 && candidate.versions.length > 0).slice(0, 3)) {
    let answer: Record<string, unknown>;
    try {
      answer = governedRead(session, state, product, { kind: 'records', limit: 1 });
    } catch (error) {
      throw new OperatorError('RESTORE_VERIFICATION_FAILED', `A representative governed read failed: ${(error as Error).message}`);
    }
    const records = Array.isArray(answer['records']) ? answer['records'] as unknown[] : [];
    reads.push({
      data_product_id: product.data_product_id,
      workspace_id: product.workspace_id,
      data_product_release: answer['data_product_release'] ?? null,
      returned: records.length,
      provenance: answer['provenance'] !== undefined,
    });
  }

  let confirmed = 0;
  let refusedFailures = 0;
  const refusedCodes: string[] = [];
  for (const purged of state.purge_ledger.flatMap((entry) => entry.purged)) {
    if (purged.record_kind !== 'data_product_release') continue;
    const [productId, release] = purged.record_id.split('#');
    const product = state.data_products.find((candidate) => candidate.data_product_id === productId);
    if (product === undefined) continue;
    try {
      governedRead(session, state, product, { kind: 'records', release: Number(release), limit: 1 });
      refusedFailures += 1;
      refusedCodes.push(`${purged.record_id}:answered`);
    } catch (error) {
      if (error instanceof OperatorError && error.code === 'RETENTION_EXPIRED') confirmed += 1;
      else {
        refusedFailures += 1;
        refusedCodes.push(`${purged.record_id}:${error instanceof OperatorError ? error.code : 'unknown'}`);
      }
    }
  }
  assertCondition(refusedFailures === 0, 'RESTORE_VERIFICATION_FAILED', `A Release the Purge Ledger retired answered a governed read after restoration (${refusedCodes.join(', ')}).`);

  // Purge Ledger: no purged record survived the replay.
  const purgedRecords = state.purge_ledger.flatMap((entry) => entry.purged);
  let survived = 0;
  for (const purged of purgedRecords) {
    if (recordPresent(state, purged.record_kind, purged.record_id)) survived += 1;
  }
  assertCondition(survived === 0, 'RESTORE_VERIFICATION_FAILED', 'A purged record reappeared in the restored Deployment.');

  assertCondition(signatureVerified, 'RESTORE_VERIFICATION_FAILED', 'The restored release manifest is not authentic under the trusted release key.');

  return {
    integrity: { passed: true, components, database_position: manifest.positions.database.position },
    objects: { passed: true, count: verifiedObjects, verified: verifiedObjects, bytes: objectBytes },
    keys: { passed: true, data_key_unwrapped: true, sealed_credentials: sealed.length, decrypted },
    manifests: { passed: signatureVerified, release: manifest.release, signature_verified: signatureVerified },
    provenance: { passed: dangling === 0, dataset_releases: datasetReleases, batches, dangling },
    governed_reads: { passed: true, products: reads.length, reads, purged_refusals: { confirmed, failed: refusedFailures } },
    purge_ledger: {
      passed: true,
      applied_through_sequence: material.ledger.head_sequence,
      entries: material.ledger.entries.length,
      purged_records: purgedRecords.length,
      removed: material.replay.removed,
      already_absent: material.replay.already_absent,
    },
  };
}

/**
 * Restores one recovery set into an isolated Deployment and verifies it. The
 * restoration opens only after every check passes, so corruption, a missing
 * object, a wrong key, or a tampered manifest leaves service closed.
 */
export function restoreDeployment(options: {
  root: string;
  masterKey: string;
  operator: string;
  backupRoot: string;
  backupId: string;
}): Record<string, unknown> {
  const startedAt = new Date();
  const manifest = readRecoveryManifest(options.backupRoot, options.backupId);
  verifyRecoverySet(options.backupRoot, manifest);
  const verificationId = randomUUID();
  const material = materializeRestored({
    targetRoot: options.root,
    backupRoot: options.backupRoot,
    manifest,
    masterKey: options.masterKey,
  });
  const restored = readDeployment(options.root);
  writeDeployment(options.root, {
    ...restored,
    restored: { backup_id: manifest.backup_id, restored_at: startedAt.toISOString(), verification_id: verificationId },
  });
  let report: VerificationReport;
  try {
    report = verifyRestored(material);
  } catch (error) {
    writeDeployment(options.root, { ...readDeployment(options.root), state: 'restore_failed', service_open: false });
    recordEvidence(options.root, 'restore', 'failed', options.operator, {
      backup_id: manifest.backup_id,
      verification_id: verificationId,
      error: error instanceof OperatorError ? error.code : 'RESTORE_VERIFICATION_FAILED',
      service_open: false,
    });
    throw error instanceof OperatorError
      ? error
      : new OperatorError(
        'RESTORE_VERIFICATION_FAILED',
        `The restored Deployment failed verification and stays closed: ${(error as Error).message}`,
      );
  }
  const finishedAt = new Date();
  const rtoSeconds = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
  const rtoMet = rtoSeconds <= RTO_LIMIT_SECONDS;
  if (!rtoMet) {
    writeDeployment(options.root, { ...readDeployment(options.root), state: 'restore_failed', service_open: false });
    recordEvidence(options.root, 'restore', 'rto_exceeded', options.operator, {
      backup_id: manifest.backup_id,
      verification_id: verificationId,
      rto_seconds: rtoSeconds,
      rto_limit_seconds: RTO_LIMIT_SECONDS,
      service_open: false,
    });
    assertCondition(false, 'RESTORE_RTO_EXCEEDED', 'The restored Deployment verified, but the measured restoration exceeded the four-hour RTO.', 'Investigate the recovery target before relying on it.');
  }
  writeDeployment(options.root, {
    ...readDeployment(options.root),
    state: 'verified_open',
    service_open: true,
    runtime_services: ['minio', 'postgres'],
    restored: { backup_id: manifest.backup_id, restored_at: startedAt.toISOString(), verification_id: verificationId },
  });
  const evidenceId = recordEvidence(options.root, 'restore', 'verified_open', options.operator, {
    restore_id: verificationId,
    backup_id: manifest.backup_id,
    verification_id: verificationId,
    rto_seconds: rtoSeconds,
    rto_limit_seconds: RTO_LIMIT_SECONDS,
    rto_met: rtoMet,
    workers_enabled: false,
    connectivity_enabled: false,
    purge_ledger_through_sequence: material.ledger.head_sequence,
    purge_records_removed: material.replay.removed,
    governed_reads: report.governed_reads.products,
    payloads_encrypted: true,
  });
  return {
    restore_id: verificationId,
    backup_id: manifest.backup_id,
    deployment_id: manifest.deployment_id,
    release: manifest.release,
    state: 'verified_open',
    service_open: true,
    workers_enabled: false,
    connectivity_enabled: false,
    verification: report,
    purge_ledger: {
      applied_through_sequence: material.ledger.head_sequence,
      entries: material.ledger.entries.length,
      purged_records: report.purge_ledger.purged_records,
      removed: material.replay.removed,
      already_absent: material.replay.already_absent,
    },
    rto: {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      seconds: rtoSeconds,
      limit_seconds: RTO_LIMIT_SECONDS,
      met: rtoMet,
    },
    evidence_id: evidenceId,
  };
}

/**
 * Runs the same restoration and verification a disaster would, into a throwaway
 * target, so an Operator can certify a recovery set without opening a service.
 */
export function verifyBackupSet(options: {
  backupRoot: string;
  backupId: string;
  masterKey: string;
  operator: string;
}): Record<string, unknown> {
  const startedAt = new Date();
  const manifest = readRecoveryManifest(options.backupRoot, options.backupId);
  verifyRecoverySet(options.backupRoot, manifest);
  const scratch = mkdtempSync(join(tmpdir(), 'dc-restore-drill-'));
  const restored = join(scratch, 'deployment');
  try {
    const material = materializeRestored({
      targetRoot: restored,
      backupRoot: options.backupRoot,
      manifest,
      masterKey: options.masterKey,
    });
    const report = verifyRestored(material);
    const finishedAt = new Date();
    const rtoSeconds = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
    const verificationId = randomUUID();
    const record = {
      verification_id: verificationId,
      backup_id: manifest.backup_id,
      deployment_id: manifest.deployment_id,
      verified_at: finishedAt.toISOString(),
      rto_seconds: rtoSeconds,
      rto_limit_seconds: RTO_LIMIT_SECONDS,
      rto_met: rtoSeconds <= RTO_LIMIT_SECONDS,
      verification: report,
      workers_connectivity_disabled: true,
      secrets_included: false,
      operator: options.operator,
    };
    mkdirSync(join(options.backupRoot, 'verifications'), { recursive: true, mode: 0o700 });
    writeJsonFile(join(options.backupRoot, 'verifications', `${verificationId}.json`), record);
    return {
      verification_id: verificationId,
      backup_id: manifest.backup_id,
      verified: true,
      verification: report,
      rto: {
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        seconds: rtoSeconds,
        limit_seconds: RTO_LIMIT_SECONDS,
        met: rtoSeconds <= RTO_LIMIT_SECONDS,
      },
      evidence: join(options.backupRoot, 'verifications', `${verificationId}.json`),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Enables background workers on a restored Deployment, explicitly and audibly. */
export function enableWorkers(options: { root: string; operator: string }): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const changed = deployment.workers_enabled === false;
  writeDeployment(options.root, { ...deployment, workers_enabled: true });
  const evidenceId = recordEvidence(options.root, 'enable-workers', 'enabled', options.operator, {
    changed,
    restored_backup_id: deployment.restored?.backup_id ?? null,
  });
  return { workers_enabled: true, changed, evidence_id: evidenceId };
}

/** Enables external connectivity on a restored Deployment, explicitly and audibly. */
export function enableConnectivity(options: { root: string; operator: string }): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const changed = deployment.connectivity_enabled === false;
  writeDeployment(options.root, { ...deployment, connectivity_enabled: true });
  const evidenceId = recordEvidence(options.root, 'enable-connectivity', 'enabled', options.operator, {
    changed,
    restored_backup_id: deployment.restored?.backup_id ?? null,
  });
  return { connectivity_enabled: true, changed, evidence_id: evidenceId };
}
