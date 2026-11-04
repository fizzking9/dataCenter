import { closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AcquisitionConnectionArtifact,
  AcquisitionConnectionVersion,
  AcquisitionRunRecord,
  ConnectionAuth,
  ConnectionPacingPolicy,
  ConnectionPacingRecord,
  ConnectionSessionRecord,
  SealedSecret,
} from './catalog.js';
import { isRecord, valueAtPath } from './documents.js';
import { OperatorError } from './errors.js';
import { decrypt, encryptSecret } from './keys.js';
import { readPlatform } from './platform.js';
import type { PlatformSession } from './session.js';

/** The one governed code an authentication failure ends a Run with. */
export const AUTHENTICATION_INTERVENTION_REQUIRED = 'ACQUISITION_AUTHENTICATION_INTERVENTION_REQUIRED';

/** How long one Connection may wait for another worker's refresh before giving up. */
const REFRESH_LOCK_TIMEOUT_MS = 10_000;

/** How many recent requests one Connection's pacing keeps for its rate window. */
const REQUEST_HISTORY_LIMIT = 600;

const RATE_WINDOW_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function decryptedText(session: PlatformSession, value: SealedSecret | null): string | null {
  if (value === null) return null;
  return decrypt(session.dataKey, value).toString('utf8');
}

/** The headers a static scheme attaches to every request; token schemes add their own. */
function staticHeaders(auth: ConnectionAuth, credential: string | null): Record<string, string> {
  if (auth.scheme === 'none') return {};
  if (credential === null) return {};
  if (auth.scheme === 'basic') {
    return { authorization: `Basic ${Buffer.from(`${auth.username}:${credential}`, 'utf8').toString('base64')}` };
  }
  if (auth.scheme === 'bearer') return { authorization: `Bearer ${credential}` };
  if (auth.scheme === 'api_key') {
    return { [auth.header.toLowerCase()]: auth.prefix === null ? credential : `${auth.prefix} ${credential}` };
  }
  return {};
}

function authSessionMode(auth: ConnectionAuth): boolean {
  return auth.scheme === 'oauth_client_credentials' || auth.scheme === 'login';
}

function findRecord(
  session: PlatformSession,
  connectionId: string,
  version: number,
  credentialRef: string,
): ConnectionSessionRecord | undefined {
  return session.state.connection_sessions.find(
    (candidate) => candidate.connection_id === connectionId
      && candidate.connection_version === version
      && candidate.credential_ref === credentialRef,
  );
}

function upsertRecord(
  session: PlatformSession,
  connectionId: string,
  workspaceId: string,
  version: number,
  credentialRef: string,
): ConnectionSessionRecord {
  const existing = findRecord(session, connectionId, version, credentialRef);
  if (existing !== undefined) return existing;
  const created: ConnectionSessionRecord = {
    connection_id: connectionId,
    workspace_id: workspaceId,
    connection_version: version,
    credential_ref: credentialRef,
    access_token: null,
    cookie: null,
    issued_at: null,
    expires_at: null,
    generation: 0,
    state: 'active',
    updated_at: new Date().toISOString(),
  };
  session.state.connection_sessions.push(created);
  return created;
}

/**
 * Serializes the refresh of one Connection across every worker of the
 * Deployment. The winner holds the lock while it calls the credential endpoint;
 * a loser waits, then observes the winner's generation rather than refreshing
 * a second time.
 */
async function withRefreshLock<T>(
  root: string,
  connectionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const directory = join(root, 'locks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `connection-${connectionId}.refresh`);
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = openSync(path, 'wx', 0o600);
      try {
        return await action();
      } finally {
        closeSync(handle);
        rmSync(path, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new OperatorError(
          'ACQUISITION_AUTHENTICATION_REFRESH_BUSY',
          'Another worker held this Connection refresh for too long.',
          'Retry the Run; a refresh that cannot be serialized never proceeds unsynchronized.',
        );
      }
      await sleep(25);
    }
  }
}

export interface ConnectionAuthRuntime {
  /** The headers the next request carries. */
  headers(): Record<string, string>;
  /** Ensures a session exists before the first request of an attempt. */
  prepare(): Promise<string | null>;
  /** Replaces the session the endpoint just rejected, at most once per attempt. */
  refresh(): Promise<string | null>;
  /** Marks the Connection as needing an operator before it may read again. */
  requireIntervention(): void;
  /** The durable state this exact Connection Version established. */
  sessionRecord(): ConnectionSessionRecord | null;
}

/**
 * Opens the authentication runtime of one pinned Connection Version.
 *
 * Static schemes attach the Version's sealed credential. A token or login
 * scheme keeps a durable session instead, so a later Run reuses the token it
 * already holds rather than authenticating again, and an operator who resets
 * the session is the only one who can clear an intervention.
 */
export function openConnectionAuth(options: {
  session: PlatformSession;
  connection: AcquisitionConnectionArtifact;
  version: AcquisitionConnectionVersion;
}): ConnectionAuthRuntime {
  const { session, connection, version } = options;
  const auth = version.auth;
  const credential = version.credential === null ? null : decryptedText(session, version.credential);
  let blocked = false;

  if (!authSessionMode(auth)) {
    const headers = staticHeaders(auth, credential);
    const current = (): ConnectionSessionRecord | undefined =>
      findRecord(session, connection.connection_id, version.version, version.credential_ref);
    const mark = (): ConnectionSessionRecord => {
      const record = upsertRecord(session, connection.connection_id, connection.workspace_id, version.version, version.credential_ref);
      record.state = 'intervention_required';
      record.updated_at = new Date().toISOString();
      return record;
    };
    return {
      headers: () => ({ ...headers }),
      prepare: async () => {
        if (current()?.state === 'intervention_required') {
          blocked = true;
          return AUTHENTICATION_INTERVENTION_REQUIRED;
        }
        return null;
      },
      refresh: async () => {
        blocked = true;
        mark();
        return AUTHENTICATION_INTERVENTION_REQUIRED;
      },
      requireIntervention: () => {
        blocked = true;
        mark();
      },
      sessionRecord: () => current() ?? null,
    };
  }

  const record = (): ConnectionSessionRecord | undefined =>
    findRecord(session, connection.connection_id, version.version, version.credential_ref);

  const material = (): { token: string | null; cookie: { name: string; value: string } | null } => {
    const current = record();
    return {
      token: current === undefined ? null : decryptedText(session, current.access_token),
      cookie: current?.cookie === undefined || current.cookie === null
        ? null
        : { name: current.cookie.name, value: decryptedText(session, current.cookie.value) ?? '' },
    };
  };

  const persist = (issuedToken: string | null, issuedCookie: { name: string; value: string } | null): void => {
    const target = upsertRecord(session, connection.connection_id, connection.workspace_id, version.version, version.credential_ref);
    target.access_token = issuedToken === null ? null : encryptSecret(session.dataKey, issuedToken);
    target.cookie = issuedCookie === null
      ? null
      : { name: issuedCookie.name, value: encryptSecret(session.dataKey, issuedCookie.value) };
    target.issued_at = new Date().toISOString();
    target.expires_at = null;
    target.generation += 1;
    target.state = 'active';
    target.updated_at = target.issued_at;
  };

  const markIntervention = (): void => {
    const target = upsertRecord(session, connection.connection_id, connection.workspace_id, version.version, version.credential_ref);
    target.state = 'intervention_required';
    target.updated_at = new Date().toISOString();
    blocked = true;
  };

  const loginCookie = (response: Response): { name: string; value: string } | null => {
    if (auth.scheme !== 'login' || auth.cookie_name === null) return null;
    const lines = response.headers.getSetCookie();
    for (const line of lines) {
      const [pair] = line.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair === undefined || separator < 0) continue;
      if (pair.slice(0, separator).trim() !== auth.cookie_name) continue;
      return { name: auth.cookie_name, value: pair.slice(separator + 1) };
    }
    return null;
  };

  const requestToken = async (): Promise<{ token: string | null; cookie: { name: string; value: string } | null }> => {
    if (auth.scheme === 'oauth_client_credentials') {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: auth.client_id,
        client_secret: credential ?? '',
      });
      if (auth.scope !== null) body.set('scope', auth.scope);
      const response = await fetch(auth.token_url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new OperatorError(AUTHENTICATION_INTERVENTION_REQUIRED, 'The token endpoint refused the client credential.');
      }
      const issued = JSON.parse(await response.text()) as unknown;
      const token = isRecord(issued) ? issued['access_token'] : undefined;
      if (typeof token !== 'string' || token.length === 0) {
        throw new OperatorError(AUTHENTICATION_INTERVENTION_REQUIRED, 'The token endpoint issued no access token.');
      }
      return { token, cookie: null };
    }
    if (auth.scheme === 'login') {
      const url = new URL(`${version.base_url}${auth.login_path}`).toString();
      const response = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ username: auth.username, password: credential ?? '' }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new OperatorError(AUTHENTICATION_INTERVENTION_REQUIRED, 'The login endpoint refused the stored credential.');
      }
      const cookie = loginCookie(response);
      const issued = JSON.parse(await response.text()) as unknown;
      const token = auth.token_path === null ? undefined : valueAtPath(issued, auth.token_path);
      return {
        token: typeof token === 'string' && token.length > 0 ? token : null,
        cookie,
      };
    }
    return { token: null, cookie: null };
  };

  const refreshOnce = async (): Promise<string | null> => {
    if (blocked) return AUTHENTICATION_INTERVENTION_REQUIRED;
    const before = record();
    try {
      return await withRefreshLock(session.root, connection.connection_id, async () => {
        // Another worker may have refreshed while this one waited; its generation
        // is the proof, and the loser replays with what the winner established.
        const fresh = readPlatform(session.root);
        const winner = fresh.connection_sessions.find(
          (candidate) => candidate.connection_id === connection.connection_id
            && candidate.connection_version === version.version
            && candidate.credential_ref === version.credential_ref,
        );
        if (winner !== undefined && winner.state === 'intervention_required') {
          markIntervention();
          return AUTHENTICATION_INTERVENTION_REQUIRED;
        }
        if (
          winner !== undefined
          && winner.generation > (before?.generation ?? 0)
          && (winner.access_token !== null || winner.cookie !== null)
        ) {
          const index = session.state.connection_sessions.findIndex(
            (candidate) => candidate.connection_id === connection.connection_id
              && candidate.connection_version === version.version
              && candidate.credential_ref === version.credential_ref,
          );
          if (index >= 0) session.state.connection_sessions[index] = { ...winner };
          else session.state.connection_sessions.push({ ...winner });
          return null;
        }
        const issued = await requestToken();
        if (issued.token === null && issued.cookie === null) {
          markIntervention();
          return AUTHENTICATION_INTERVENTION_REQUIRED;
        }
        persist(issued.token, issued.cookie);
        return null;
      });
    } catch (error) {
      if (error instanceof OperatorError) {
        markIntervention();
        return error.code;
      }
      markIntervention();
      return AUTHENTICATION_INTERVENTION_REQUIRED;
    }
  };

  return {
    headers: () => {
      const current = material();
      const headers: Record<string, string> = {};
      if (current.token !== null) headers['authorization'] = `Bearer ${current.token}`;
      if (current.cookie !== null) headers['cookie'] = `${current.cookie.name}=${current.cookie.value}`;
      return headers;
    },
    prepare: async () => {
      const current = record();
      if (current?.state === 'intervention_required') {
        blocked = true;
        return AUTHENTICATION_INTERVENTION_REQUIRED;
      }
      if (current !== undefined && (current.access_token !== null || current.cookie !== null)) return null;
      return refreshOnce();
    },
    refresh: async () => refreshOnce(),
    requireIntervention: markIntervention,
    sessionRecord: () => record() ?? null,
  };
}

/** The Connection's pacing state, created empty the first time it is consulted. */
function ensurePacing(
  session: PlatformSession,
  connection: AcquisitionConnectionArtifact,
): ConnectionPacingRecord {
  const existing = session.state.connection_pacing.find(
    (candidate) => candidate.connection_id === connection.connection_id,
  );
  if (existing !== undefined) return existing;
  const created: ConnectionPacingRecord = {
    connection_id: connection.connection_id,
    workspace_id: connection.workspace_id,
    queue: [],
    active: [],
    last_finished_at: null,
    requests: [],
    updated_at: new Date().toISOString(),
  };
  session.state.connection_pacing.push(created);
  return created;
}

/** Enrols one Run in its Connection's durable FIFO queue at the instant it was queued. */
export function enrolRun(
  session: PlatformSession,
  connection: AcquisitionConnectionArtifact,
  run: AcquisitionRunRecord,
): void {
  const pacing = ensurePacing(session, connection);
  if (pacing.active.some((entry) => entry.acquisition_run_id === run.acquisition_run_id)) return;
  const queued = pacing.queue.find((entry) => entry.acquisition_run_id === run.acquisition_run_id);
  if (queued !== undefined) return;
  // Runs are appended in the order they were requested, which is the order the
  // Run ledger already keeps; a stated clock never reorders the queue.
  pacing.queue.push({
    acquisition_run_id: run.acquisition_run_id,
    source_id: run.source_id,
    enqueued_at: run.queued_at,
    not_before: null,
  });
  pacing.updated_at = new Date().toISOString();
}

export interface PacingAdmission {
  admitted: boolean;
  /** Why the Run was not admitted, when it was not. */
  reason: 'fifo' | 'serialization' | 'concurrency' | 'interval' | 'rate' | null;
  /** The earliest instant the Run may be attempted, when the reason states one. */
  not_before: string | null;
  /** How many Runs of this Connection are ahead of it. */
  position: number;
  /** Whether deciding this admission changed durable pacing state. */
  dirty: boolean;
}

function pruneRequests(record: ConnectionPacingRecord, nowMs: number): void {
  const horizon = nowMs - RATE_WINDOW_MS;
  record.requests = record.requests.filter((entry) => Date.parse(entry) >= horizon);
  if (record.requests.length > REQUEST_HISTORY_LIMIT) {
    record.requests = record.requests.slice(record.requests.length - REQUEST_HISTORY_LIMIT);
  }
}

/**
 * Decides whether one Run may start reading now.
 *
 * The queue is the Deployment's single order for the Connection, so a Run that
 * is not at its head waits even when the Connection would otherwise be idle.
 * Serialization, concurrency, minimum interval, and rate all come from the
 * exact Connection Version the Run pinned.
 */
export function admitRun(options: {
  session: PlatformSession;
  connection: AcquisitionConnectionArtifact;
  policy: ConnectionPacingPolicy;
  run: AcquisitionRunRecord;
  at: string;
}): PacingAdmission {
  const { session, connection, policy, run, at } = options;
  const pacing = ensurePacing(session, connection);
  const nowMs = Date.parse(at);
  const before = JSON.stringify(pacing);
  pruneRequests(pacing, nowMs);
  enrolRun(session, connection, run);

  const position = pacing.queue.findIndex((entry) => entry.acquisition_run_id === run.acquisition_run_id);
  if (position > 0) {
    return { admitted: false, reason: 'fifo', not_before: null, position, dirty: before !== JSON.stringify(pacing) };
  }
  if (policy.serialization && pacing.active.length > 0) {
    return { admitted: false, reason: 'serialization', not_before: null, position: 0, dirty: before !== JSON.stringify(pacing) };
  }
  if (pacing.active.length >= Math.max(1, policy.maximum_concurrent_runs)) {
    return { admitted: false, reason: 'concurrency', not_before: null, position: 0, dirty: before !== JSON.stringify(pacing) };
  }
  if (policy.minimum_interval_seconds > 0 && pacing.last_finished_at !== null) {
    const earliest = Date.parse(pacing.last_finished_at) + policy.minimum_interval_seconds * 1_000;
    if (nowMs < earliest) {
      return { admitted: false, reason: 'interval', not_before: new Date(earliest).toISOString(), position: 0, dirty: before !== JSON.stringify(pacing) };
    }
  }
  if (policy.maximum_requests_per_minute !== null && pacing.requests.length >= policy.maximum_requests_per_minute) {
    const earliest = pacing.requests.length === 0
      ? nowMs
      : Date.parse(pacing.requests[0]!) + RATE_WINDOW_MS;
    return { admitted: false, reason: 'rate', not_before: new Date(earliest).toISOString(), position: 0, dirty: before !== JSON.stringify(pacing) };
  }

  pacing.queue = pacing.queue.filter((entry) => entry.acquisition_run_id !== run.acquisition_run_id);
  pacing.active.push({ acquisition_run_id: run.acquisition_run_id, source_id: run.source_id, started_at: at });
  pacing.updated_at = at;
  return { admitted: true, reason: null, not_before: null, position: 0, dirty: before !== JSON.stringify(pacing) };
}

/** Records that one request was made, so the Connection's rate window is durable. */
export function recordRequest(
  session: PlatformSession,
  connection: AcquisitionConnectionArtifact,
  at: string,
): void {
  const pacing = ensurePacing(session, connection);
  pacing.requests.push(at);
  pruneRequests(pacing, Date.parse(at));
  pacing.updated_at = at;
}

/** Whether the Connection's rate still allows one more request at this instant. */
export function rateAllows(
  session: PlatformSession,
  connection: AcquisitionConnectionArtifact,
  policy: ConnectionPacingPolicy,
  at: string,
): boolean {
  if (policy.maximum_requests_per_minute === null) return true;
  const pacing = ensurePacing(session, connection);
  pruneRequests(pacing, Date.parse(at));
  return pacing.requests.length < policy.maximum_requests_per_minute;
}

/** Returns one Run's slot and closes its turn with the instant it finished. */
export function releaseRun(options: {
  session: PlatformSession;
  connection: AcquisitionConnectionArtifact;
  run: AcquisitionRunRecord;
  at: string;
}): void {
  const pacing = ensurePacing(options.session, options.connection);
  pacing.active = pacing.active.filter((entry) => entry.acquisition_run_id !== options.run.acquisition_run_id);
  pacing.queue = pacing.queue.filter((entry) => entry.acquisition_run_id !== options.run.acquisition_run_id);
  pacing.last_finished_at = options.at;
  pacing.updated_at = options.at;
}

/** Returns one paced Run to the head of the queue without closing its turn. */
export function requeueRun(options: {
  session: PlatformSession;
  connection: AcquisitionConnectionArtifact;
  run: AcquisitionRunRecord;
  at: string;
  notBefore: string | null;
}): void {
  const pacing = ensurePacing(options.session, options.connection);
  pacing.active = pacing.active.filter((entry) => entry.acquisition_run_id !== options.run.acquisition_run_id);
  const queued = pacing.queue.find((entry) => entry.acquisition_run_id === options.run.acquisition_run_id);
  if (queued === undefined) {
    pacing.queue.unshift({
      acquisition_run_id: options.run.acquisition_run_id,
      source_id: options.run.source_id,
      enqueued_at: options.run.queued_at,
      not_before: options.notBefore,
    });
  } else {
    queued.not_before = options.notBefore;
  }
  pacing.updated_at = options.at;
}

/** The durable view of one Connection's pacing, never including request bodies. */
export function describePacing(
  session: PlatformSession,
  connection: AcquisitionConnectionArtifact,
): Record<string, unknown> {
  const pacing = session.state.connection_pacing.find(
    (candidate) => candidate.connection_id === connection.connection_id,
  );
  const nowMs = Date.now();
  const requests = (pacing?.requests ?? []).filter((entry) => Date.parse(entry) >= nowMs - RATE_WINDOW_MS);
  return {
    connection_id: connection.connection_id,
    workspace_id: connection.workspace_id,
    queue: (pacing?.queue ?? []).map((entry) => ({ ...entry })),
    active: (pacing?.active ?? []).map((entry) => ({ ...entry })),
    last_finished_at: pacing?.last_finished_at ?? null,
    requests_last_minute: requests.length,
    updated_at: pacing?.updated_at ?? null,
  };
}

/** The durable view of one Connection's session, which never returns a token or cookie value. */
export function describeSession(options: {
  session: PlatformSession;
  connection: AcquisitionConnectionArtifact;
  version: AcquisitionConnectionVersion | null;
}): Record<string, unknown> {
  const { session, connection, version } = options;
  const records = session.state.connection_sessions.filter(
    (candidate) => candidate.connection_id === connection.connection_id,
  );
  const relevant = version === null
    ? records[records.length - 1]
    : records.find(
      (candidate) => candidate.connection_version === version.version
        && candidate.credential_ref === version.credential_ref,
    ) ?? records.filter((candidate) => candidate.connection_version === version.version).at(-1);
  return {
    connection_id: connection.connection_id,
    workspace_id: connection.workspace_id,
    connection_version: relevant?.connection_version ?? version?.version ?? null,
    auth_scheme: version?.auth.scheme ?? null,
    state: relevant?.state ?? 'active',
    has_access_token: relevant?.access_token !== null && relevant?.access_token !== undefined,
    has_cookie: relevant?.cookie !== null && relevant?.cookie !== undefined,
    cookie_name: relevant?.cookie?.name ?? null,
    issued_at: relevant?.issued_at ?? null,
    expires_at: relevant?.expires_at ?? null,
    generation: relevant?.generation ?? 0,
    updated_at: relevant?.updated_at ?? null,
  };
}

/**
 * Clears every session one Connection holds, which is the operator's explicit
 * intervention after a Run stopped on an authentication failure.
 */
export function resetSessions(
  session: PlatformSession,
  connection: AcquisitionConnectionArtifact,
): number {
  const before = session.state.connection_sessions.length;
  session.state.connection_sessions = session.state.connection_sessions.filter(
    (candidate) => candidate.connection_id !== connection.connection_id,
  );
  return before - session.state.connection_sessions.length;
}
