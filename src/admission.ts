import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireAdministrator, type ActionContext } from './authz.js';
import {
  readOperationsConfiguration,
  type OperationsConfiguration,
} from './operations.js';
import {
  readOperationsState,
  withOperationsLock,
  writeOperationsState,
  type OperationClass,
  type OperationLease,
  type OperationsState,
  type WaitingOperation,
  type WorkerKind,
} from './operations-state.js';
import { openPlatform } from './session.js';

const LEASE_TTL_MS: Record<OperationClass, number> = {
  direct: 60_000,
  llm: 300_000,
  async: 600_000,
};

const RATE_WINDOW_MS = 60_000;

function millis(instant: string): number {
  return Date.parse(instant);
}

function isConsumerClass(cls: OperationClass): boolean {
  return cls === 'direct' || cls === 'llm';
}

/** Expired leases and aged-out rate samples stop counting the instant they lapse. */
export function pruneOperations(state: OperationsState, now: string): void {
  const at = millis(now);
  state.leases = state.leases.filter((lease) => millis(lease.expires_at) > at);
  state.requests = state.requests.filter((request) => at - millis(request.at) < RATE_WINDOW_MS);
}

/** The capacity one class may still take, given what runs now. */
function hasCapacity(
  state: OperationsState,
  configuration: OperationsConfiguration,
  request: WaitingOperation,
): boolean {
  if (request.class === 'async') {
    const worker = request.worker;
    if (worker === null) return false;
    const ceiling = configuration.limits.workers[worker];
    const running = state.leases.filter((lease) => lease.class === 'async' && lease.worker === worker).length;
    return running < ceiling;
  }
  const consumer = state.leases.filter((lease) => isConsumerClass(lease.class)).length;
  if (consumer >= configuration.limits.consumer_concurrency) return false;
  if (request.class !== 'llm') return true;
  const llm = state.leases.filter((lease) => lease.class === 'llm').length;
  return llm < configuration.limits.llm_concurrency;
}

function queueCeiling(configuration: OperationsConfiguration, cls: OperationClass): number {
  return cls === 'async'
    ? configuration.limits.workspace_async_queue
    : configuration.limits.workspace_consumer_queue;
}

function waitingInWorkspace(state: OperationsState, workspaceId: string, cls: OperationClass): WaitingOperation[] {
  return state.waiting.filter(
    (entry) => entry.workspace_id === workspaceId && isConsumerClass(entry.class) === isConsumerClass(cls),
  );
}

function agentRunning(state: OperationsState, agentId: string, cls: OperationClass): number {
  // Direct and LLM-backed operations carry their own Agent ceilings, so one
  // never stands in for the other.
  return state.leases.filter(
    (lease) => lease.agent_identity_id === agentId && lease.class === cls,
  ).length;
}

function agentRequestsInWindow(state: OperationsState, agentId: string, cls: OperationClass): number {
  return state.requests.filter(
    (entry) => entry.agent_identity_id === agentId && entry.class === cls,
  ).length;
}

function leaseFor(request: WaitingOperation, at: string): OperationLease {
  return {
    lease_id: randomUUID(),
    request_id: request.request_id,
    operation: request.operation,
    class: request.class,
    worker: request.worker,
    workspace_id: request.workspace_id,
    agent_identity_id: request.agent_identity_id,
    user_id: request.user_id,
    admitted_at: at,
    expires_at: new Date(millis(at) + LEASE_TTL_MS[request.class]).toISOString(),
  };
}

export interface AdmissionRequest {
  operation: string;
  class: OperationClass;
  workspace_id: string;
  agent_identity_id?: string | null;
  user_id?: string | null;
  worker?: WorkerKind | null;
}

export interface AdmissionOutcome {
  request_id: string;
  operation: string;
  workspace_id: string;
  outcome: 'admitted' | 'queued' | 'refused';
  code?: string;
  message?: string;
  lease_id: string | null;
  queue_position: number;
}

function asWaiting(request: AdmissionRequest, at: string): WaitingOperation {
  return {
    request_id: randomUUID(),
    operation: request.operation,
    class: request.class,
    worker: request.worker ?? (request.class === 'async' ? 'acquisition' : null),
    workspace_id: request.workspace_id,
    agent_identity_id: request.agent_identity_id ?? null,
    user_id: request.user_id ?? null,
    enqueued_at: at,
  };
}

/**
 * One admission decision, stated rather than thrown, so a batch states every
 * request's outcome and a refused request still counts against its rate window.
 */
function admitOne(
  state: OperationsState,
  configuration: OperationsConfiguration,
  request: AdmissionRequest,
  at: string,
): AdmissionOutcome {
  const waiting = asWaiting(request, at);
  const base = { request_id: waiting.request_id, operation: waiting.operation, workspace_id: waiting.workspace_id };
  if (request.class === 'async' && waiting.worker === null) {
    return { ...base, outcome: 'refused', code: 'OPERATION_CLASS_INVALID', lease_id: null, queue_position: 0 };
  }
  const agentId = request.agent_identity_id ?? null;
  if (agentId !== null) {
    const llmFamily = request.class === 'llm';
    const perMinute = llmFamily
      ? configuration.limits.agent_llm_requests_per_minute
      : configuration.limits.agent_direct_requests_per_minute;
    if (agentRequestsInWindow(state, agentId, request.class) >= perMinute) {
      // The refused request is still a request: it is counted before it is refused.
      state.requests.push({ agent_identity_id: agentId, class: request.class, at });
      return {
        ...base,
        outcome: 'refused',
        code: 'AGENT_RATE_LIMITED',
        message: `The Agent Identity is limited to ${String(perMinute)} ${llmFamily ? 'LLM-backed' : 'direct'} requests per minute.`,
        lease_id: null,
        queue_position: 0,
      };
    }
    state.requests.push({ agent_identity_id: agentId, class: request.class, at });
    const concurrency = llmFamily
      ? configuration.limits.agent_llm_concurrency
      : configuration.limits.agent_direct_concurrency;
    if (agentRunning(state, agentId, request.class) >= concurrency) {
      return {
        ...base,
        outcome: 'refused',
        code: 'AGENT_CONCURRENCY_LIMIT',
        message: `The Agent Identity may run ${String(concurrency)} ${llmFamily ? 'LLM-backed' : 'direct'} operations at once.`,
        lease_id: null,
        queue_position: 0,
      };
    }
  }
  const queued = waitingInWorkspace(state, request.workspace_id, request.class);
  if (queued.length >= queueCeiling(configuration, request.class)) {
    return {
      ...base,
      outcome: 'refused',
      code: 'WORKSPACE_QUEUE_FULL',
      message: 'The Workspace may not queue more operations of this class.',
      lease_id: null,
      queue_position: 0,
    };
  }
  // A request never overtakes its own Workspace backlog: it runs at once only
  // when its Workspace has nothing waiting and a slot is free.
  if (queued.length === 0 && hasCapacity(state, configuration, waiting)) {
    const lease = leaseFor(waiting, at);
    state.leases.push(lease);
    if (!state.rotation.includes(request.workspace_id)) state.rotation.push(request.workspace_id);
    return { ...base, outcome: 'admitted', lease_id: lease.lease_id, queue_position: 0 };
  }
  state.waiting.push(waiting);
  if (!state.rotation.includes(request.workspace_id)) state.rotation.push(request.workspace_id);
  return {
    ...base,
    outcome: 'queued',
    lease_id: null,
    queue_position: waitingInWorkspace(state, request.workspace_id, request.class).length,
  };
}

/**
 * Admission is a Deployment-scope operational control: an administrator states
 * it, and no Consumer admits on its own behalf.
 */
function assertAdmissionAuthority(
  root: string,
  masterKey: string,
  token: string,
  action: string,
  requests: AdmissionRequest[],
): void {
  const session = openPlatform(root, masterKey);
  const context: ActionContext = { action, scope: 'deployment' };
  const actor = resolveActor(session, token, context);
  requireAdministrator(session, actor, context);
  for (const request of requests) {
    if (!session.state.workspaces.some((workspace) => workspace.workspace_id === request.workspace_id)) {
      reject(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
    }
    const agentId = request.agent_identity_id ?? null;
    if (agentId !== null) {
      const agent = session.state.agent_identities.find((candidate) => candidate.agent_identity_id === agentId);
      if (!agent || agent.status !== 'active' || !agent.workspace_ids.includes(request.workspace_id)) {
        reject(session, actorLabel(actor.user), context, 'AGENT_NOT_AVAILABLE', 'The Agent Identity is not an active actor of this Workspace.');
      }
    }
  }
}

export function admitOperations(options: {
  root: string;
  masterKey: string;
  token: string;
  requests: AdmissionRequest[];
  at?: string;
}): Record<string, unknown> {
  const at = options.at ?? new Date().toISOString();
  assertAdmissionAuthority(options.root, options.masterKey, options.token, 'operations_admit', options.requests);
  return withOperationsLock(options.root, () => {
    const configuration = readOperationsConfiguration(options.root);
    const state = readOperationsState(options.root);
    pruneOperations(state, at);
    const results = options.requests.map((request) => admitOne(state, configuration, request, at));
    writeOperationsState(options.root, state);
    return {
      results,
      admitted: results.filter((result) => result.outcome === 'admitted').length,
      queued: results.filter((result) => result.outcome === 'queued').length,
      refused: results.filter((result) => result.outcome === 'refused').length,
    };
  });
}

/**
 * A freed slot is offered to the Workspace whose turn it is, taking one waiting
 * operation at a time, so two backlogs share the capacity instead of one
 * consuming it.
 */
export function dispatchOperations(options: {
  root: string;
  masterKey: string;
  token: string;
  cls?: OperationClass;
  at?: string;
}): Record<string, unknown> {
  const at = options.at ?? new Date().toISOString();
  assertAdmissionAuthority(options.root, options.masterKey, options.token, 'operations_dispatch', []);
  return withOperationsLock(options.root, () => {
    const configuration = readOperationsConfiguration(options.root);
    const state = readOperationsState(options.root);
    pruneOperations(state, at);
    const admitted: Array<Record<string, unknown>> = [];
    for (;;) {
      const next = nextWaiting(state, configuration, options.cls);
      if (next === undefined) break;
      state.waiting = state.waiting.filter((entry) => entry.request_id !== next.request_id);
      const lease = leaseFor(next, at);
      state.leases.push(lease);
      state.rotation = [...state.rotation.filter((workspace) => workspace !== next.workspace_id), next.workspace_id];
      admitted.push({ ...lease });
    }
    writeOperationsState(options.root, state);
    return { admitted, waiting: state.waiting.length };
  });
}

function classMatches(entry: WaitingOperation, cls: OperationClass | undefined): boolean {
  if (cls === undefined) return true;
  return isConsumerClass(cls) ? isConsumerClass(entry.class) : entry.class === 'async';
}

function nextWaiting(
  state: OperationsState,
  configuration: OperationsConfiguration,
  cls: OperationClass | undefined,
): WaitingOperation | undefined {
  for (const workspaceId of state.rotation) {
    const head = state.waiting.find((entry) => entry.workspace_id === workspaceId && classMatches(entry, cls));
    if (head === undefined) continue;
    if (!hasCapacity(state, configuration, head)) continue;
    return head;
  }
  return undefined;
}

export function finishOperations(options: {
  root: string;
  masterKey: string;
  token: string;
  leaseIds: string[];
  at?: string;
}): Record<string, unknown> {
  const at = options.at ?? new Date().toISOString();
  assertAdmissionAuthority(options.root, options.masterKey, options.token, 'operations_finish', []);
  return withOperationsLock(options.root, () => {
    const state = readOperationsState(options.root);
    pruneOperations(state, at);
    const released = new Set(options.leaseIds);
    const finished = state.leases.filter((lease) => released.has(lease.lease_id)).map((lease) => lease.lease_id);
    state.leases = state.leases.filter((lease) => !released.has(lease.lease_id));
    writeOperationsState(options.root, state);
    return { finished, in_flight: state.leases.length, waiting: state.waiting.length };
  });
}

/** The live admission picture, stated beside the configuration it is measured against. */
export function operationsQueue(root: string, at?: string): {
  queue: Record<string, { waiting: number; consumer_waiting: number; async_waiting: number }>;
  in_flight: Record<OperationClass, number>;
  waiting: number;
} {
  const state = readOperationsState(root);
  if (at !== undefined) pruneOperations(state, at);
  const queue: Record<string, { waiting: number; consumer_waiting: number; async_waiting: number }> = {};
  for (const workspaceId of new Set([...state.waiting.map((entry) => entry.workspace_id), ...state.rotation])) {
    const entries = state.waiting.filter((entry) => entry.workspace_id === workspaceId);
    queue[workspaceId] = {
      waiting: entries.length,
      consumer_waiting: entries.filter((entry) => isConsumerClass(entry.class)).length,
      async_waiting: entries.filter((entry) => entry.class === 'async').length,
    };
  }
  return {
    queue,
    in_flight: {
      direct: state.leases.filter((lease) => lease.class === 'direct').length,
      llm: state.leases.filter((lease) => lease.class === 'llm').length,
      async: state.leases.filter((lease) => lease.class === 'async').length,
    },
    waiting: state.waiting.length,
  };
}
