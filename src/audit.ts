import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './crypto.js';
import { OperatorError } from './errors.js';

export type AuditOutcome = 'succeeded' | 'denied' | 'failed';

export interface AuditEvent {
  sequence: number;
  event_id: string;
  occurred_at: string;
  actor: string;
  action: string;
  scope: 'deployment' | 'workspace';
  workspace_id?: string;
  target?: string;
  outcome: AuditOutcome;
  correlation_id: string;
  detail?: Record<string, string | number | boolean>;
  previous_hash: string;
  hash: string;
}

export type AuditInput = Omit<
  AuditEvent,
  'sequence' | 'event_id' | 'occurred_at' | 'previous_hash' | 'hash'
>;

export interface AuditCheckpoint {
  sequence: number;
  head_hash: string;
  mac: string;
}

const GENESIS = '0'.repeat(64);

function auditDirectory(root: string): string {
  return join(root, 'audit');
}

function eventsPath(root: string): string {
  return join(auditDirectory(root), 'events.jsonl');
}

function checkpointPath(root: string): string {
  return join(auditDirectory(root), 'checkpoint.json');
}

function checkpointMac(key: Buffer, sequence: number, headHash: string): string {
  return createHmac('sha256', key).update(`${sequence}:${headHash}`).digest('hex');
}

function eventHash(event: Omit<AuditEvent, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

export function readAuditEvents(root: string): AuditEvent[] {
  const path = eventsPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEvent);
}

export function readAuditCheckpoint(root: string): AuditCheckpoint | undefined {
  const path = checkpointPath(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as AuditCheckpoint : undefined;
}

function unavailable(): OperatorError {
  return new OperatorError(
    'AUDIT_LOG_UNAVAILABLE',
    'The Audit Event log cannot be written, so the protected operation stops.',
    'Restore write access to the Deployment audit log before retrying.',
  );
}

function integrityFailure(): OperatorError {
  return new OperatorError(
    'AUDIT_INTEGRITY_FAILED',
    'The Audit Event chain does not match its signed checkpoint.',
    'Stop governed writes and investigate the tampered Audit Event log.',
  );
}

/**
 * Proves the Audit Event log is writable and still matches its signed checkpoint
 * before a protected operation changes anything. An unavailable log or a forged
 * tail therefore stops the operation rather than letting it act unaudited.
 */
export function assertAuditLogAvailable(root: string, checkpointKey: Buffer): void {
  let previous: AuditEvent | undefined;
  let checkpoint: AuditCheckpoint | undefined;
  try {
    mkdirSync(auditDirectory(root), { recursive: true, mode: 0o700 });
    // Opening for append proves writability; reading the tail proves the log is
    // still the log its checkpoint signed.
    const probe = openSync(eventsPath(root), 'a', 0o600);
    closeSync(probe);
    previous = lastEvent(root);
    checkpoint = readAuditCheckpoint(root);
  } catch {
    throw unavailable();
  }
  if (!checkpointMatchesHead(previous, checkpoint, checkpointKey)) throw integrityFailure();
}

export function appendAuditEvent(root: string, input: AuditInput, checkpointKey: Buffer): AuditEvent {
  let previous: AuditEvent | undefined;
  try {
    previous = lastEvent(root);
  } catch {
    throw unavailable();
  }
  if (!checkpointMatchesHead(previous, readAuditCheckpoint(root), checkpointKey)) {
    throw integrityFailure();
  }
  const draft = {
    ...input,
    sequence: (previous?.sequence ?? 0) + 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    previous_hash: previous?.hash ?? GENESIS,
  };
  const event: AuditEvent = { ...draft, hash: eventHash(draft) };
  const checkpoint: AuditCheckpoint = {
    sequence: event.sequence,
    head_hash: event.hash,
    mac: checkpointMac(checkpointKey, event.sequence, event.hash),
  };
  try {
    mkdirSync(auditDirectory(root), { recursive: true, mode: 0o700 });
    appendFileSync(eventsPath(root), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    // The checkpoint is written in the same protected step, so a log that cannot
    // be extended never leaves a recorded event the Deployment cannot prove.
    writeAtomic(checkpointPath(root), `${JSON.stringify(checkpoint)}\n`);
  } catch {
    throw unavailable();
  }
  return event;
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Reads only the tail line, so extending the chain does not parse the whole log. */
function lastEvent(root: string): AuditEvent | undefined {
  const path = eventsPath(root);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, 'utf8');
  const end = content.endsWith('\n') ? content.length - 1 : content.length;
  if (end <= 0) return undefined;
  const start = content.lastIndexOf('\n', end - 1) + 1;
  const line = content.slice(start, end);
  return line.length > 0 ? (JSON.parse(line) as AuditEvent) : undefined;
}

/** Recomputes every link, so editing, reordering, or dropping a record is detectable. */
export function verifyAuditChain(events: AuditEvent[]): boolean {
  let previous = GENESIS;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.previous_hash !== previous) return false;
    const { hash, ...rest } = event;
    if (eventHash(rest) !== hash) return false;
    previous = hash;
  }
  return true;
}

/**
 * The chain alone cannot detect a wholesale rewrite, because a forger can
 * recompute every hash. The checkpoint is keyed with the Deployment data key,
 * so recomputing the chain without that key fails verification.
 */
export function verifyAuditCheckpoint(
  events: AuditEvent[],
  checkpoint: AuditCheckpoint | undefined,
  checkpointKey: Buffer,
): boolean {
  return checkpointMatchesHead(events[events.length - 1], checkpoint, checkpointKey);
}

function checkpointMatchesHead(
  head: AuditEvent | undefined,
  checkpoint: AuditCheckpoint | undefined,
  checkpointKey: Buffer,
): boolean {
  if (!head) return checkpoint === undefined || checkpoint.sequence === 0;
  if (!checkpoint) return false;
  if (checkpoint.sequence !== head.sequence || checkpoint.head_hash !== head.hash) return false;
  const expected = Buffer.from(checkpointMac(checkpointKey, checkpoint.sequence, checkpoint.head_hash), 'utf8');
  const recorded = Buffer.from(checkpoint.mac, 'utf8');
  return expected.length === recorded.length && timingSafeEqual(expected, recorded);
}
