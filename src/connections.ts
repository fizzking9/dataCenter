import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import {
  type AcquisitionConnectionArtifact,
  type AcquisitionConnectionVersion,
  type ConnectionAuth,
  type ConnectionPacingPolicy,
  type ConnectionPagination,
  type ConnectionPublicationTargets,
  type ConnectionRetryPolicy,
  type ConnectionSchedule,
} from './catalog.js';
import { describePacing, describeSession, resetSessions } from './connection-session.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import { OperatorError, type Fail } from './errors.js';
import { encryptSecret } from './keys.js';
import { workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;
const AUTH_SCHEMES = ['none', 'basic', 'bearer', 'api_key', 'oauth_client_credentials', 'login'];
const IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/u;

const DEFAULT_RETRY: ConnectionRetryPolicy = {
  max_attempts: 1,
  base_delay_ms: 250,
  max_delay_ms: 30_000,
  retry_on: [429, 500, 502, 503, 504],
};

const DEFAULT_PACING: ConnectionPacingPolicy = {
  serialization: false,
  minimum_interval_seconds: 0,
  maximum_requests_per_minute: null,
  maximum_concurrent_runs: 1,
};

/** The exact declarative content one Connection Version executes under. */
export interface ConnectionDeclarationInput {
  baseUrl: string;
  auth: ConnectionAuth;
  retry: ConnectionRetryPolicy;
  pacing: ConnectionPacingPolicy;
  pagination: ConnectionPagination;
  schedule: ConnectionSchedule | null;
  publicationTargets: ConnectionPublicationTargets | null;
}

function readName(raw: unknown, fail: Fail): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    fail('CONNECTION_NAME_INVALID', 'A Connection name must contain 2 to 128 characters.');
  }
  return name;
}

function readBaseUrl(raw: unknown, fail: Fail): string {
  if (typeof raw !== 'string') {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A Connection must state the endpoint base URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The Connection base URL must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The Connection base URL must use http or https.');
  }
  // The declared endpoint is the one address this Version may read, so a later
  // redirect or a different host never receives the stored credential.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}`;
}

function readPagination(raw: unknown, fail: Fail): ConnectionPagination {
  if (!isRecord(raw)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A Connection must declare how it paginates.');
  }
  const parameter = raw['parameter'];
  const sizeParameter = raw['size_parameter'] ?? null;
  const start = raw['start'] ?? 1;
  const size = raw['size'];
  const maxPages = raw['max_pages'];
  const mode = raw['mode'] ?? 'page_number';
  const cursorPath = raw['cursor_path'] ?? null;
  const initialCursor = raw['initial_cursor'] ?? null;
  if (typeof parameter !== 'string' || !IDENTIFIER.test(parameter)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The pagination parameter must be a lowercase identifier.');
  }
  if (sizeParameter !== null && (typeof sizeParameter !== 'string' || !IDENTIFIER.test(sizeParameter))) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The pagination size parameter must be a lowercase identifier.');
  }
  if (mode !== 'page_number' && mode !== 'cursor') {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A Connection paginates by page number or by cursor.');
  }
  if (mode === 'cursor' && (typeof cursorPath !== 'string' || cursorPath.length === 0)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'Cursor pagination must name where the next cursor sits.');
  }
  if (mode === 'page_number' && (cursorPath !== null || initialCursor !== null)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'Page-number pagination does not read a cursor.');
  }
  if (initialCursor !== null && typeof initialCursor !== 'string') {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The initial cursor must be a string.');
  }
  if (!Number.isInteger(start) || (start as number) < 0) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The first page must be a whole number of at least 0.');
  }
  if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > 1000) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The page size must be a whole number from 1 to 1000.');
  }
  if (!Number.isInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > 1000) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The page ceiling must be a whole number from 1 to 1000.');
  }
  return {
    parameter,
    size_parameter: sizeParameter as string | null,
    start: start as number,
    size: size as number,
    max_pages: maxPages as number,
    mode,
    cursor_path: cursorPath as string | null,
    initial_cursor: initialCursor as string | null,
  };
}

function readSchedule(raw: unknown, fail: Fail): ConnectionSchedule | null {
  if (raw === undefined || raw === null) return null;
  const every = isRecord(raw) ? raw['every_minutes'] : undefined;
  const tolerance = isRecord(raw) ? raw['start_tolerance_seconds'] ?? 0 : undefined;
  if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 10_080) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A schedule interval must be a whole number of minutes from 1 to 10080.');
  }
  if (!Number.isInteger(tolerance) || (tolerance as number) < 0 || (tolerance as number) > 3600) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A schedule start tolerance must be a whole number of seconds from 0 to 3600.');
  }
  return { every_minutes: every as number, start_tolerance_seconds: tolerance as number };
}

/**
 * Reads how quickly a Source's result must become current. The two measurement
 * points are ordered, so a declaration that cannot be met by construction is
 * refused instead of honoured as a target it never expressed.
 */
function readPublicationTargets(raw: unknown, fail: Fail): ConnectionPublicationTargets | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'Publication targets must be a JSON object.');
  }
  const p95 = raw['p95_seconds'];
  const p99 = raw['p99_seconds'];
  for (const [label, value] of [['p95', p95], ['p99', p99]] as const) {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 86_400) {
      fail('CONNECTION_CONFIGURATION_INVALID', `A publication ${label} target must be a whole number of seconds from 1 to 86400.`);
    }
  }
  if ((p99 as number) < (p95 as number)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A publication p99 target is never shorter than its p95 target.');
  }
  return { p95_seconds: p95 as number, p99_seconds: p99 as number };
}

function readAuth(raw: unknown, fail: Fail): ConnectionAuth {
  if (raw === undefined || raw === null) return { scheme: 'bearer' };
  if (!isRecord(raw) || typeof raw['scheme'] !== 'string' || !AUTH_SCHEMES.includes(raw['scheme'])) {
    fail(
      'CONNECTION_AUTH_UNSUPPORTED',
      `The authentication scheme must be one of: ${AUTH_SCHEMES.join(', ')}.`,
    );
  }
  const scheme = raw['scheme'];
  if (scheme === 'none') return { scheme: 'none' };
  if (scheme === 'bearer') return { scheme: 'bearer' };
  if (scheme === 'basic') {
    const username = raw['username'];
    if (typeof username !== 'string' || username.length === 0) {
      fail('CONNECTION_CONFIGURATION_INVALID', 'Basic authentication must state the username.');
    }
    return { scheme: 'basic', username };
  }
  if (scheme === 'api_key') {
    const header = raw['header'];
    const prefix = raw['prefix'] ?? null;
    if (typeof header !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(header)) {
      fail('CONNECTION_CONFIGURATION_INVALID', 'An API key must name the lowercase request header it rides.');
    }
    if (prefix !== null && typeof prefix !== 'string') {
      fail('CONNECTION_CONFIGURATION_INVALID', 'An API key prefix must be a string.');
    }
    return { scheme: 'api_key', header, prefix: prefix as string | null };
  }
  if (scheme === 'oauth_client_credentials') {
    const tokenUrl = raw['token_url'];
    const clientId = raw['client_id'];
    const scope = raw['scope'] ?? null;
    if (typeof tokenUrl !== 'string') {
      fail('CONNECTION_CONFIGURATION_INVALID', 'Client credentials must name the token URL.');
    }
    try {
      const parsed = new URL(tokenUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    } catch {
      fail('CONNECTION_CONFIGURATION_INVALID', 'The token URL must be an absolute http or https URL.');
    }
    if (typeof clientId !== 'string' || clientId.length === 0) {
      fail('CONNECTION_CONFIGURATION_INVALID', 'Client credentials must state the client identifier.');
    }
    if (scope !== null && typeof scope !== 'string') {
      fail('CONNECTION_CONFIGURATION_INVALID', 'The client scope must be a string.');
    }
    return { scheme: 'oauth_client_credentials', token_url: tokenUrl, client_id: clientId, scope: scope as string | null };
  }
  const loginPath = raw['login_path'];
  const username = raw['username'];
  const tokenPath = raw['token_path'] ?? null;
  const cookieName = raw['cookie_name'] ?? null;
  if (typeof loginPath !== 'string' || !loginPath.startsWith('/')) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A login scheme must state an absolute login path.');
  }
  if (typeof username !== 'string' || username.length === 0) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A login scheme must state the username.');
  }
  if (tokenPath !== null && (typeof tokenPath !== 'string' || tokenPath.length === 0)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The login token path must name where a token sits in the response.');
  }
  if (cookieName !== null && (typeof cookieName !== 'string' || cookieName.length === 0)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The login cookie name must be a non-empty string.');
  }
  if (tokenPath === null && cookieName === null) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A login scheme must yield a bearer token, a cookie, or both.');
  }
  return {
    scheme: 'login',
    login_path: loginPath,
    username,
    token_path: tokenPath as string | null,
    cookie_name: cookieName as string | null,
  };
}

function readRetry(raw: unknown, fail: Fail): ConnectionRetryPolicy {
  if (raw === undefined || raw === null) return { ...DEFAULT_RETRY, retry_on: [...DEFAULT_RETRY.retry_on] };
  if (!isRecord(raw)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The retry policy must be a JSON object.');
  }
  const maxAttempts = raw['max_attempts'] ?? DEFAULT_RETRY.max_attempts;
  const baseDelay = raw['base_delay_ms'] ?? DEFAULT_RETRY.base_delay_ms;
  const maxDelay = raw['max_delay_ms'] ?? DEFAULT_RETRY.max_delay_ms;
  const retryOn = raw['retry_on'] ?? DEFAULT_RETRY.retry_on;
  if (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1 || (maxAttempts as number) > 10) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The retry attempt count must be a whole number from 1 to 10.');
  }
  if (!Number.isInteger(baseDelay) || (baseDelay as number) < 0 || (baseDelay as number) > 60_000) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The retry base delay must be a whole number of milliseconds from 0 to 60000.');
  }
  if (!Number.isInteger(maxDelay) || (maxDelay as number) < (baseDelay as number) || (maxDelay as number) > 300_000) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The retry delay ceiling must be at least the base delay and at most 300000 milliseconds.');
  }
  if (!Array.isArray(retryOn) || retryOn.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The retry statuses must be HTTP status codes.');
  }
  return {
    max_attempts: maxAttempts as number,
    base_delay_ms: baseDelay as number,
    max_delay_ms: maxDelay as number,
    retry_on: [...new Set(retryOn as number[])],
  };
}

function readPacing(raw: unknown, fail: Fail): ConnectionPacingPolicy {
  if (raw === undefined || raw === null) return { ...DEFAULT_PACING };
  if (!isRecord(raw)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The pacing policy must be a JSON object.');
  }
  const serialization = raw['serialization'] ?? DEFAULT_PACING.serialization;
  const minimumInterval = raw['minimum_interval_seconds'] ?? DEFAULT_PACING.minimum_interval_seconds;
  const maximumRate = raw['maximum_requests_per_minute'] ?? DEFAULT_PACING.maximum_requests_per_minute;
  const maximumConcurrent = raw['maximum_concurrent_runs'] ?? DEFAULT_PACING.maximum_concurrent_runs;
  if (typeof serialization !== 'boolean') {
    fail('CONNECTION_CONFIGURATION_INVALID', 'Connection serialization must be true or false.');
  }
  if (!Number.isInteger(minimumInterval) || (minimumInterval as number) < 0 || (minimumInterval as number) > 3600) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The minimum interval must be a whole number of seconds from 0 to 3600.');
  }
  if (maximumRate !== null && (!Number.isInteger(maximumRate) || (maximumRate as number) < 1 || (maximumRate as number) > 6000)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The request rate must be a whole number from 1 to 6000 per minute, or null.');
  }
  if (!Number.isInteger(maximumConcurrent) || (maximumConcurrent as number) < 1 || (maximumConcurrent as number) > 64) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'The concurrent Run ceiling must be a whole number from 1 to 64.');
  }
  return {
    serialization,
    minimum_interval_seconds: minimumInterval as number,
    maximum_requests_per_minute: maximumRate as number | null,
    maximum_concurrent_runs: maximumConcurrent as number,
  };
}

/**
 * Validates one Connection declaration into the exact semantics a Version
 * executes under. The guided form, the CLI, and the preview all read through
 * this parser, so no surface invents a rule the others do not enforce.
 */
export function parseConnectionDeclaration(
  parsed: unknown,
  fail: Fail,
): ConnectionDeclarationInput {
  if (!isRecord(parsed)) {
    fail('CONNECTION_CONFIGURATION_INVALID', 'A Connection configuration must be a JSON object.');
  }
  return {
    baseUrl: readBaseUrl(parsed['base_url'], fail),
    pagination: readPagination(parsed['pagination'], fail),
    schedule: readSchedule(parsed['schedule'], fail),
    publicationTargets: readPublicationTargets(parsed['publication_targets'], fail),
    auth: readAuth(parsed['auth'], fail),
    retry: readRetry(parsed['retry'], fail),
    pacing: readPacing(parsed['pacing'], fail),
  };
}

/** The credential a scheme pins, named by a fingerprint rather than by value. */
function credentialReference(scheme: string, credential: string | undefined): string {
  return `${scheme}:${canonicalDigest(credential ?? `${scheme}:none`).slice(0, 16)}`;
}

function requireCredential(
  auth: ConnectionAuth,
  credential: string | undefined,
  fail: Fail,
): void {
  if (auth.scheme !== 'none' && (credential === undefined || credential.length === 0)) {
    fail(
      'CONNECTION_CREDENTIAL_REQUIRED',
      `${auth.scheme} authentication requires a credential supplied on standard input.`,
      'Publish the Connection with --credential-stdin.',
    );
  }
}

/**
 * The exact declarative document a guided form reviews. It is the content a
 * Version hashes, so a preview and a publication never disagree, and it never
 * carries the credential itself — only the reference that names it.
 */
function declarativeDocument(
  input: ConnectionDeclarationInput,
  credentialRef: string,
): Record<string, unknown> {
  return {
    base_url: input.baseUrl,
    credential_ref: credentialRef,
    auth: { ...input.auth },
    retry: { ...input.retry, retry_on: [...input.retry.retry_on] },
    pacing: { ...input.pacing },
    pagination: { ...input.pagination },
    schedule: input.schedule === null ? null : { ...input.schedule },
    publication_targets: input.publicationTargets === null ? null : { ...input.publicationTargets },
  };
}

/**
 * Publishes one Acquisition Connection Version, sealing the credential that
 * Version authenticates with.
 *
 * The sealed secret and the reference that names it belong to the Version, so
 * republishing to rotate a credential never rewrites what a Source already
 * pinned; the reference is a fingerprint of the credential, so a rotated token
 * is a different Version with a different content hash.
 */
function appendConnectionVersion(options: {
  session: PlatformSession;
  actorName: string;
  actorUserId: string;
  context: ActionContext;
  workspaceId: string;
  name: string;
  input: ConnectionDeclarationInput;
  credential?: string;
}): Record<string, unknown> {
  const { session, context, workspaceId, name, input } = options;
  requireCredential(input.auth, options.credential, (code, message, nextStep) =>
    reject(session, options.actorName, context, code, message, nextStep));

  let connection = session.state.acquisition_connections.find(
    (candidate) => candidate.workspace_id === workspaceId && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!connection) {
    const connectionId = randomUUID();
    connection = {
      connection_id: connectionId,
      workspace_id: workspaceId,
      name,
      owner_user_id: options.actorUserId,
      created_at: new Date().toISOString(),
      adopted_version: null,
      versions: [],
    } satisfies AcquisitionConnectionArtifact;
    session.state.acquisition_connections.push(connection);
  }

  const credentialRef = credentialReference(input.auth.scheme, options.credential);
  const content = declarativeDocument(input, credentialRef);
  const version: AcquisitionConnectionVersion = {
    version: (connection.versions[connection.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: options.actorUserId,
    base_url: input.baseUrl,
    credential_ref: credentialRef,
    credential: options.credential === undefined ? null : encryptSecret(session.dataKey, options.credential),
    auth: { ...input.auth },
    retry: { ...input.retry, retry_on: [...input.retry.retry_on] },
    pacing: { ...input.pacing },
    pagination: { ...input.pagination },
    schedule: input.schedule === null ? null : { ...input.schedule },
    publication_targets: input.publicationTargets === null ? null : { ...input.publicationTargets },
    content_hash: canonicalDigest(content),
  };
  connection.versions.push(version);

  session.audit({
    ...context,
    target: connection.connection_id,
    actor: options.actorName,
    outcome: 'succeeded',
    detail: {
      connection_version: version.version,
      credential_ref: credentialRef,
      auth_scheme: input.auth.scheme,
      scheduled: input.schedule !== null,
    },
  });
  session.save();
  return {
    connection_id: connection.connection_id,
    workspace_id: connection.workspace_id,
    name: connection.name,
    connection_version: version.version,
    base_url: version.base_url,
    credential_ref: version.credential_ref,
    has_credential: version.credential !== null,
    auth: { ...version.auth },
    retry: { ...version.retry },
    pacing: { ...version.pacing },
    pagination: { ...version.pagination },
    schedule: version.schedule === null ? null : { ...version.schedule },
    publication_targets: version.publication_targets === null ? null : { ...version.publication_targets },
    content_hash: version.content_hash,
    published_at: version.published_at,
  };
}

export function publishConnection(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  configPath: string;
  credential?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'acquisition_connection_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const actorName = actorLabel(actor.user);
  const name = readName(options.name, (code, message, nextStep) =>
    reject(session, actorName, context, code, message, nextStep));

  const config = readJsonDocument(
    options.configPath,
    (code, message) => reject(session, actorName, context, code, message),
    'CONNECTION_CONFIGURATION_UNREADABLE',
    'The Connection configuration file must contain valid JSON.',
  );
  const input = parseConnectionDeclaration(config, (code, message, nextStep) =>
    reject(session, actorName, context, code, message, nextStep));

  return appendConnectionVersion({
    session,
    actorName,
    actorUserId: actor.user.user_id,
    context,
    workspaceId: options.workspaceId,
    name,
    input,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
  });
}

/**
 * Validates one guided Connection declaration without writing anything. The
 * credential is required exactly as publication requires it, and it is never
 * echoed: the answer names the reference it would pin, not the secret.
 */
export function previewConnectionDeclaration(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  declaration: unknown;
  credential?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'acquisition_connection_preview',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const actorName = actorLabel(actor.user);

  try {
    const name = readName(options.name, (code, message, nextStep) =>
      reject(session, actorName, context, code, message, nextStep));
    const input = parseConnectionDeclaration(options.declaration, (code, message, nextStep) =>
      reject(session, actorName, context, code, message, nextStep));
    requireCredential(input.auth, options.credential, (code, message, nextStep) =>
      reject(session, actorName, context, code, message, nextStep));
    const credentialRef = credentialReference(input.auth.scheme, options.credential);
    const document = declarativeDocument(input, credentialRef);
    session.audit({ ...context, actor: actorName, outcome: 'succeeded', detail: { auth_scheme: input.auth.scheme } });
    return {
      valid: true,
      name,
      declaration: document,
      credential_ref: credentialRef,
      has_credential: input.auth.scheme !== 'none',
      content_hash: canonicalDigest(document),
      errors: [],
    };
  } catch (error) {
    if (!(error instanceof OperatorError)) throw error;
    // The refusal is already audited by reject(); the caller reads the reason.
    return {
      valid: false,
      errors: [{ code: error.code, message: error.message }],
    };
  }
}

/**
 * Publishes one guided declarative Connection as the next immutable Version.
 * The declaration arrives as structured configuration, never executable code,
 * and the credential is sealed without entering any response.
 */
export function publishConnectionDeclaration(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  declaration: unknown;
  credential?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'acquisition_connection_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const actorName = actorLabel(actor.user);
  const name = readName(options.name, (code, message, nextStep) =>
    reject(session, actorName, context, code, message, nextStep));
  const input = parseConnectionDeclaration(options.declaration, (code, message, nextStep) =>
    reject(session, actorName, context, code, message, nextStep));

  return appendConnectionVersion({
    session,
    actorName,
    actorUserId: actor.user.user_id,
    context,
    workspaceId: options.workspaceId,
    name,
    input,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
  });
}

/** Adopts one exact Connection Version, which is what an acquisition Plan pins. */
export function adoptConnection(options: {
  root: string;
  masterKey: string;
  token: string;
  connectionId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_connection_adoption', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === options.connectionId,
  );
  const role = connection === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, connection.workspace_id);
  if (!connection || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'CONNECTION_NOT_AVAILABLE', 'The Connection is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: connection.workspace_id, target: connection.connection_id };
  const version = connection.versions.find((candidate) => candidate.version === options.version);
  if (!version) {
    reject(session, actorLabel(actor.user), scoped, 'CONNECTION_VERSION_NOT_FOUND', `This Connection has no Version ${options.version}.`);
  }
  connection.adopted_version = version.version;
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { connection_version: version.version } });
  session.save();
  return {
    connection_id: connection.connection_id,
    adopted_version: version.version,
    content_hash: version.content_hash,
  };
}

/** Lists the Connections of one Workspace, naming each Version's credential but never opening it. */
export function listConnections(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'acquisition_connection_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  if (workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId) !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const connections = session.state.acquisition_connections
    .filter((connection) => connection.workspace_id === options.workspaceId)
    .map((connection) => ({
      connection_id: connection.connection_id,
      name: connection.name,
      adopted_version: connection.adopted_version,
      versions: connection.versions.map((version) => ({
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
    }));
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { connections_returned: connections.length } });
  return { workspace_id: options.workspaceId, connections };
}

function administratedConnection(
  session: PlatformSession,
  token: string,
  connectionId: string,
  action: string,
): { connection: AcquisitionConnectionArtifact; context: ActionContext; actorName: string } {
  const context: ActionContext = { action, scope: 'workspace' };
  const actor = resolveActor(session, token, context);
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === connectionId,
  );
  const role = connection === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, connection.workspace_id);
  if (!connection || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'CONNECTION_NOT_AVAILABLE', 'The Connection is not available to this actor.');
  }
  return {
    connection,
    context: { ...context, workspace_id: connection.workspace_id, target: connection.connection_id },
    actorName: actorLabel(actor.user),
  };
}

function inspectedVersion(connection: AcquisitionConnectionArtifact): AcquisitionConnectionVersion | null {
  if (connection.versions.length === 0) return null;
  const adopted = connection.adopted_version === null
    ? undefined
    : connection.versions.find((candidate) => candidate.version === connection.adopted_version);
  return adopted ?? connection.versions[connection.versions.length - 1]!;
}

/** Reports the durable authentication session of one Connection without opening it. */
export function connectionSession(options: {
  root: string;
  masterKey: string;
  token: string;
  connectionId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const { connection, context, actorName } = administratedConnection(
    session,
    options.token,
    options.connectionId,
    'acquisition_connection_session_read',
  );
  const view = describeSession({ session, connection, version: inspectedVersion(connection) });
  session.audit({ ...context, actor: actorName, outcome: 'succeeded', detail: { state: String(view['state']) } });
  return view;
}

/** Clears one Connection's session, which is the operator's explicit intervention. */
export function resetConnectionSession(options: {
  root: string;
  masterKey: string;
  token: string;
  connectionId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_connection_session_reset', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === options.connectionId,
  );
  const role = connection === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, connection.workspace_id);
  if (!connection || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'CONNECTION_NOT_AVAILABLE', 'The Connection is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: connection.workspace_id, target: connection.connection_id };
  const removed = resetSessions(session, connection);
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { sessions_removed: removed } });
  session.save();
  return {
    connection_id: connection.connection_id,
    reset: true,
    sessions_removed: removed,
    state: 'active',
  };
}

/** Reports one Connection's durable FIFO queue, active slots, and rate window. */
export function connectionPacing(options: {
  root: string;
  masterKey: string;
  token: string;
  connectionId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_connection_pacing_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === options.connectionId,
  );
  const role = connection === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, connection.workspace_id);
  if (!connection || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'CONNECTION_NOT_AVAILABLE', 'The Connection is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: connection.workspace_id, target: connection.connection_id };
  const version = inspectedVersion(connection);
  const pacing = describePacing(session, connection);
  const queue = pacing['queue'];
  const view = {
    ...pacing,
    policy: version === null ? null : { ...version.pacing },
  };
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { queued: Array.isArray(queue) ? queue.length : 0 },
  });
  return view;
}
