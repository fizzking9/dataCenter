import { existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OperatorError } from './errors.js';
import { readJsonFile, writeJsonFile } from './state.js';

/** What one admitted operation is: a Consumer slot, an LLM-backed slot, or a worker job. */
export type OperationClass = 'direct' | 'llm' | 'async';

/** The worker a class-`async` job occupies while it runs. */
export type WorkerKind = 'acquisition' | 'browser_scraper' | 'llm';

export interface OperationLease {
  lease_id: string;
  request_id: string;
  operation: string;
  class: OperationClass;
  worker: WorkerKind | null;
  workspace_id: string;
  agent_identity_id: string | null;
  user_id: string | null;
  admitted_at: string;
  expires_at: string;
}

export interface WaitingOperation {
  request_id: string;
  operation: string;
  class: OperationClass;
  worker: WorkerKind | null;
  workspace_id: string;
  agent_identity_id: string | null;
  user_id: string | null;
  enqueued_at: string;
}

/** One Agent Identity request inside the rolling minute, refused or not. */
export interface AgentRequestAt {
  agent_identity_id: string;
  class: OperationClass;
  at: string;
}

/** One metered generation, priced at the operator's CNY tariff. */
export interface UsageEntry {
  usage_id: string;
  class: 'nlq' | 'report' | 'artifact' | 'activation';
  operation: string;
  /** Groups the generations of one logical operation, so averages stay per operation. */
  operation_id: string;
  workspace_id: string | null;
  agent_identity_id: string | null;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  /** True when the endpoint stated no usage and the platform counted tokens itself. */
  estimated: boolean;
  cost_cny: number;
  outcome: 'succeeded' | 'refused';
  at: string;
}

/** One operation the harness really ran and really timed. */
export interface MeasurementSample {
  sample_id: string;
  run_id: string;
  window: string;
  operation: string;
  operation_class: string;
  cache: 'cold' | 'warm';
  elapsed_ms: number;
  outcome: string;
  freshness_seconds: number | null;
  at: string;
}

/** The exact parameters one measurement run was executed with. */
export interface MeasurementRun {
  run_id: string;
  parameters: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
}

/** The host volumes and pressure last read, so health states them rather than guesses. */
export interface EnvelopeObservation {
  observed_at: string;
  values: Record<string, number>;
}

/** Durable admission state, measured samples, usage, and run records. */
export interface OperationsState {
  schema_version: number;
  leases: OperationLease[];
  waiting: WaitingOperation[];
  /** The round-robin turn order of Workspaces with waiting operations. */
  rotation: string[];
  requests: AgentRequestAt[];
  usage: UsageEntry[];
  samples: MeasurementSample[];
  runs: MeasurementRun[];
  envelope: EnvelopeObservation | null;
}

const OPERATIONS_SCHEMA_VERSION = 1;

export function operationsStatePath(root: string): string {
  return join(root, 'state', 'operations.json');
}

function emptyOperationsState(): OperationsState {
  return {
    schema_version: OPERATIONS_SCHEMA_VERSION,
    leases: [],
    waiting: [],
    rotation: [],
    requests: [],
    usage: [],
    samples: [],
    runs: [],
    envelope: null,
  };
}

export function readOperationsState(root: string): OperationsState {
  const path = operationsStatePath(root);
  if (!existsSync(path)) return emptyOperationsState();
  const stored = readJsonFile<Partial<OperationsState>>(path);
  const state = emptyOperationsState();
  state.leases = Array.isArray(stored.leases) ? stored.leases : [];
  state.waiting = Array.isArray(stored.waiting) ? stored.waiting : [];
  state.rotation = Array.isArray(stored.rotation) ? stored.rotation : [];
  state.requests = Array.isArray(stored.requests) ? stored.requests : [];
  state.usage = Array.isArray(stored.usage) ? stored.usage : [];
  state.samples = Array.isArray(stored.samples) ? stored.samples : [];
  state.runs = Array.isArray(stored.runs) ? stored.runs : [];
  state.envelope = stored.envelope ?? null;
  return state;
}

export function writeOperationsState(root: string, state: OperationsState): void {
  writeJsonFile(operationsStatePath(root), state);
}

/** A synchronous pause, because admission is a synchronous read-modify-write. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Every admission and every metered generation is one read-modify-write of
 * durable state, and concurrent commands are separate processes. A stale lock
 * from a crashed command expires, so contention delays work but never loses a
 * lease, a queue entry, or a usage record.
 */
export function withOperationsLock<T>(root: string, work: () => T): T {
  const lock = join(root, 'state', 'operations.lock');
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
      } catch {
        // Another process released the lock while this one looked at it.
      }
      if (Date.now() > deadline) {
        throw new OperatorError(
          'OPERATIONS_CONTENTION',
          'The admission state stayed locked for ten seconds.',
          'Inspect for a crashed command holding state/operations.lock, then retry.',
        );
      }
      sleepSync(2 + Math.floor(Math.random() * 8));
    }
  }
  try {
    return work();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // The lock already expired and was removed by another process.
    }
  }
}
