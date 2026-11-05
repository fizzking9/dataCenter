import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { showWorkspaceAudit } from './audit-view.js';
import { login, logout } from './auth.js';
import { publishWorkspaceContext, showContext, showContextHistory } from './context.js';
import { browserIdentity, browserNavigation } from './navigation.js';
import { listDataProducts } from './products.js';
import { publishModelBinding, revokeModelBinding, showModelBindingWorkspace } from './model-binding.js';
import { activateModelProfile, evaluateModelProfile, listModelProfiles, publishModelProfile } from './model-profile.js';
import { grantMembership, listMemberships, listWorkspaces, revokeMembership } from './workspaces.js';
import {
  exchangeOperatorEnrollment,
  resolveOperatorSession,
  signInOperator,
  signOutOperator,
  OPERATOR_SESSION_LIFETIME_MS,
} from './operators.js';
import { queryDataProductApi } from './data-product-api.js';
import { OperatorError } from './errors.js';
import { readLicenseSummary } from './license.js';
import { handleMcpSurface, type McpServerIdentity } from './mcp.js';
import { openPlatform } from './session.js';
import { deploymentStatus } from './status.js';
import { readDeployment } from './state.js';

export const SESSION_COOKIE = 'dc_operator_console';
/** Platform User sessions are a separate channel from the Operator Console. */
export const USER_SESSION_COOKIE = 'dc_user_session';

const MAX_BODY_BYTES = 16 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

/** Every structured API failure, mapped to one HTTP status. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nextStep?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ConsoleServerOptions {
  root: string;
  masterKey: string;
  port: number;
  assets?: string;
}

export interface ConsoleServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function defaultAssetsDirectory(): string {
  // Compiled next to the application: dist/src/console-server.js serves dist/web.
  return fileURLToPath(new URL('../web/', import.meta.url));
}

/**
 * Serves the browser application and the authenticated HTTP application APIs
 * that back it, over the same governed modules the lifecycle CLI uses.
 */
export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  readDeployment(options.root);
  const assets = options.assets ?? defaultAssetsDirectory();
  if (!existsSync(join(assets, 'index.html'))) {
    throw new OperatorError(
      'WEB_ASSETS_MISSING',
      'The browser application is not built.',
      'Build the application before serving the Operator Console.',
    );
  }
  // The MCP resource and issuer are the Deployment's own bound origin, not a
  // client-supplied Host header, so no token can name another resource server.
  const identity: McpServerIdentity = { origin: '' };
  const handler = createHandler(options, assets, identity);
  const server: Server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendFailure(response, error);
      else response.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    // The Console is a host-local surface: it never binds off the loopback address.
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      identity.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function createHandler(options: ConsoleServerOptions, assets: string, identity: McpServerIdentity) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(options, request, response, url.pathname);
      return;
    }
    if (await handleMcpSurface({ root: options.root, masterKey: options.masterKey, identity }, request, response, url)) {
      return;
    }
    await serveAsset(request, response, assets, url.pathname);
  };
}

async function handleApi(
  options: ConsoleServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && !isSameOrigin(request)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'The request did not originate from this Operator Console.');
  }

  if (pathname === '/api/operator/enrollment' && method === 'POST') {
    const body = await readJson(request);
    const enrolled = await exchangeOperatorEnrollment({
      root: options.root,
      masterKey: options.masterKey,
      secret: text(body, 'enrollment_secret'),
      password: text(body, 'password'),
    });
    sendJson(response, 201, { ...enrolled });
    return;
  }

  if (pathname === '/api/operator/session' && method === 'POST') {
    const body = await readJson(request);
    const signedIn = await signInOperator({
      root: options.root,
      masterKey: options.masterKey,
      username: text(body, 'username'),
      password: text(body, 'password'),
      ...(text(body, 'totp') ? { totp: text(body, 'totp') } : {}),
      ...(text(body, 'recovery_code') ? { recoveryCode: text(body, 'recovery_code') } : {}),
    });
    response.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${signedIn.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(OPERATOR_SESSION_LIFETIME_MS / 1000)}`,
    );
    sendJson(response, 200, {
      operator_id: signedIn.operator_id,
      username: signedIn.username,
      session_expires_at: signedIn.session_expires_at,
    });
    return;
  }

  if (pathname === '/api/operator/session' && method === 'DELETE') {
    const token = cookieValue(request);
    if (!token) {
      sendJson(response, 200, { revoked: false });
      return;
    }
    const result = signOutOperator({ root: options.root, masterKey: options.masterKey, token });
    response.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    sendJson(response, 200, result);
    return;
  }

  if (pathname === '/api/operator/session' && method === 'GET') {
    const resolved = authorize(options, request, 'operator_console_session');
    sendJson(response, 200, {
      operator_id: resolved.operator.operator_id,
      username: resolved.operator.username,
      session_expires_at: resolved.session.expires_at,
    });
    return;
  }

  if (pathname === '/api/operator/health' && method === 'GET') {
    const resolved = authorize(options, request, 'operator_console_health');
    const status = deploymentStatus({
      root: options.root,
      masterKey: options.masterKey,
      operator: resolved.operator.username,
    });
    sendJson(response, 200, { ...status, checked_at: new Date().toISOString() });
    return;
  }

  if (pathname === '/api/operator/license' && method === 'GET') {
    const resolved = authorize(options, request, 'operator_console_license');
    const deployment = readDeployment(options.root);
    const summary = readLicenseSummary(options.root, join(options.root, 'license.json'));
    sendJson(response, 200, {
      ...summary,
      release: deployment.release,
      deployment_id: deployment.deployment_id,
      state: deployment.state,
      checked_at: new Date().toISOString(),
    });
    return;
  }

  // The platform User channel: a separate cookie, a separate sign-in, and the
  // authorized trees the browser application navigates. Every route resolves the
  // session again, so revocation and expiry apply on the very next request.

  if (pathname === '/api/session' && method === 'POST') {
    const body = await readJson(request);
    const signedIn = await login({
      root: options.root,
      masterKey: options.masterKey,
      username: text(body, 'username'),
      password: text(body, 'password'),
      ...(text(body, 'totp') ? { totp: text(body, 'totp') } : {}),
      ...(text(body, 'recovery_code') ? { recoveryCode: text(body, 'recovery_code') } : {}),
    });
    response.setHeader('set-cookie', sessionCookie(String(signedIn.session_token), signedIn.session_expires_at));
    sendJson(response, 200, {
      username: signedIn.username,
      deployment_role: signedIn.deployment_role,
      mfa_enrolled: signedIn.mfa_enrolled,
      session_expires_at: signedIn.session_expires_at,
    });
    return;
  }

  if (pathname === '/api/session' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, browserIdentity({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/session' && method === 'DELETE') {
    const token = cookieValueFor(request, USER_SESSION_COOKIE);
    response.setHeader('set-cookie', sessionCookie('', null));
    if (!token) {
      sendJson(response, 200, { revoked: false });
      return;
    }
    try {
      sendJson(response, 200, logout({ root: options.root, masterKey: options.masterKey, token }));
    } catch (error) {
      // Signing out never traps a User whose session has already ended.
      if (!(error instanceof OperatorError) || error.code !== 'SESSION_INVALID') throw error;
      sendJson(response, 200, { revoked: false });
    }
    return;
  }

  if (pathname === '/api/navigation' && method === 'GET') {
    const token = userSession(request);
    const workspaceId = searchParam(request, 'workspace_id');
    sendJson(response, 200, browserNavigation({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...(workspaceId === null ? {} : { workspaceId }),
    }));
    return;
  }

  if (pathname === '/api/deployment/workspaces' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listWorkspaces({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/workspace/data-products' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listDataProducts({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/context' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showContext({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  // A Publication advertises this path. It answers the very same governed read
  // Model Profiles are Deployment-scoped: only a Deployment Administrator may
  // read them, publish a Version, evaluate it, or activate it.
  if (pathname === '/api/deployment/model-profiles' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listModelProfiles({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/model-profiles' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const credential = text(body, 'credential');
    sendJson(response, 201, publishModelProfile({
      root: options.root,
      masterKey: options.masterKey,
      token,
      name: text(body, 'name'),
      configuration: body,
      ...(credential === '' ? {} : { credential }),
    }));
    return;
  }

  const modelProfileRoute = /^\/api\/deployment\/model-profiles\/([^/]+)\/(evaluate|activate)$/u.exec(pathname);
  if (modelProfileRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const profileId = decodeURIComponent(modelProfileRoute[1]!);
    const version = number(body, 'model_profile_version');
    if (modelProfileRoute[2] === 'evaluate') {
      sendJson(response, 200, await evaluateModelProfile({
        root: options.root,
        masterKey: options.masterKey,
        token,
        profileId,
        version,
      }));
      return;
    }
    sendJson(response, 200, activateModelProfile({
      root: options.root,
      masterKey: options.masterKey,
      token,
      profileId,
      version,
    }));
    return;
  }

  // A Binding is Workspace-scoped: a Workspace Administrator reads, creates,
  // and revokes only the Bindings of the active Workspace.
  if (pathname === '/api/workspace/model-bindings' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showModelBindingWorkspace({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/model-bindings' && method === 'POST') {
    const token = userSession(request);
    const workspaceId = activeWorkspace(request);
    const body = await readJson(request);
    sendJson(response, 201, await publishModelBinding({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId,
      profileId: text(body, 'model_profile_id'),
      configuration: body,
    }));
    return;
  }

  const bindingRevokeRoute = /^\/api\/workspace\/model-bindings\/([^/]+)\/revoke$/u.exec(pathname);
  if (bindingRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeModelBinding({
      root: options.root,
      masterKey: options.masterKey,
      token,
      bindingId: decodeURIComponent(bindingRevokeRoute[1]!),
    }));
    return;
  }

  // A Publication advertises this path. It answers the very same governed read
  // the MCP direct-query tool answers, with a Consumer's own Bearer credential.
  const queryRoute = /^\/api\/workspaces\/([^/]+)\/data-products\/([^/]+)\/query$/.exec(pathname);
  if (queryRoute !== null && method === 'POST') {
    const credential = bearerCredential(request);
    if (credential === undefined) {
      throw new HttpError(401, 'SESSION_INVALID', 'A Data Product Query requires a Bearer session token.');
    }
    sendJson(response, 200, queryDataProductApi({
      root: options.root,
      masterKey: options.masterKey,
      token: credential,
      workspaceId: decodeURIComponent(queryRoute[1]!),
      dataProductId: decodeURIComponent(queryRoute[2]!),
      request: await readJson(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/memberships' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listMemberships({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/memberships' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, grantMembership({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      username: text(body, 'username'),
      role: text(body, 'role'),
    }));
    return;
  }

  if (pathname === '/api/workspace/memberships/revoke' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, revokeMembership({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      username: text(body, 'username'),
    }));
    return;
  }

  if (pathname === '/api/workspace/context/history' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showContextHistory({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/context/publish' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, publishWorkspaceContext({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      entries: body['entries'],
    }));
    return;
  }

  if (pathname === '/api/workspace/audit' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showWorkspaceAudit({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  throw new HttpError(404, 'API_NOT_FOUND', 'No such application API.');
}

/** Every console request re-resolves the Operator, so revocation takes effect at once. */
function authorize(options: ConsoleServerOptions, request: IncomingMessage, target: string) {
  const token = cookieValue(request);
  const resolved = token ? resolveOperatorSession(options.root, token) : undefined;
  if (!resolved) {
    recordDeniedAccess(options, target);
    throw new HttpError(401, 'OPERATOR_SESSION_INVALID', 'The Operator Console session is not valid.');
  }
  return resolved;
}

function recordDeniedAccess(options: ConsoleServerOptions, target: string): void {
  try {
    const session = openPlatform(options.root, options.masterKey);
    session.audit({
      actor: 'unauthenticated',
      action: 'operator_console_access',
      scope: 'deployment',
      target,
      outcome: 'denied',
      detail: { error_code: 'OPERATOR_SESSION_INVALID' },
    });
  } catch {
    // The Deployment is not open, so there is no governed Audit Event to append.
  }
}

function userSession(request: IncomingMessage): string {
  const token = cookieValueFor(request, USER_SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'SESSION_INVALID', 'The session is not valid.');
  return token;
}

/** Every Workspace-scoped request names the one active Workspace it acts on. */
function activeWorkspace(request: IncomingMessage): string {
  const workspaceId = searchParam(request, 'workspace_id');
  if (workspaceId === null) {
    throw new HttpError(400, 'WORKSPACE_REQUIRED', 'The request must name one Workspace.');
  }
  return workspaceId;
}

/** A write names its Workspace in the body, and an unauthorized one fails closed. */
function workspaceFromBody(body: Record<string, unknown>): string {
  const workspaceId = text(body, 'workspace_id');
  if (workspaceId === '') {
    throw new HttpError(400, 'WORKSPACE_REQUIRED', 'The request must name one Workspace.');
  }
  return workspaceId;
}

function searchParam(request: IncomingMessage, name: string): string | null {
  const value = new URL(request.url ?? '/', 'http://localhost').searchParams.get(name);
  return value === null || value === '' ? null : value;
}

/** The browser never reads this cookie, and it never outlives the session. */
function sessionCookie(token: string, expiresAt: unknown): string {
  const remaining = Date.parse(String(expiresAt)) - Date.now();
  const maxAge = token === '' || !Number.isFinite(remaining) ? 0 : Math.max(0, Math.floor(remaining / 1000));
  return `${USER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Reads the Bearer credential a published Data Product API path presents. */
function bearerCredential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(value.trim());
  return match?.[1];
}

function cookieValue(request: IncomingMessage): string | undefined {
  return cookieValueFor(request, SESSION_COOKIE);
}

function cookieValueFor(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** A cross-origin form cannot forge this: only the Console's own origin is accepted. */
function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  return host !== undefined && origin === `http://${host}`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'The request body is too large.');
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** A whole number the governed module validates, never a browser-side guess. */
function number(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  return typeof value === 'number' ? value : Number.NaN;
}

async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assets: string,
  pathname: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'The browser application is served read-only.');
  }
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = resolve(assets, relativePath);
  const root = resolve(assets);
  const insideRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
  const served = insideRoot && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, 'index.html');
  const extension = extname(served).toLowerCase();
  response.setHeader('content-type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
  response.setHeader(
    'cache-control',
    served.startsWith(join(root, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-store',
  );
  response.statusCode = 200;
  if (method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(served);
    stream.once('error', rejectStream);
    stream.once('end', () => resolveStream());
    stream.pipe(response);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(payload);
}

const STATUS_BY_CODE: Record<string, number> = {
  OPERATOR_ENROLLMENT_INVALID: 401,
  OPERATOR_ENROLLMENT_EXPIRED: 401,
  OPERATOR_ENROLLMENT_REVOKED: 401,
  OPERATOR_ENROLLMENT_CONSUMED: 401,
  OPERATOR_AUTHENTICATION_FAILED: 401,
  OPERATOR_SESSION_INVALID: 401,
  OPERATOR_PASSWORD_INVALID: 400,
  OPERATOR_NAME_INVALID: 400,
  OPERATOR_ALREADY_ENROLLED: 409,
  AUTHENTICATION_FAILED: 401,
  SESSION_INVALID: 401,
  AUTHORIZATION_DENIED: 403,
  WORKSPACE_ACCESS_DENIED: 403,
  ROLE_INVALID: 400,
  MEMBERSHIP_NOT_FOUND: 404,
  LAST_ADMINISTRATOR_PROTECTED: 409,
  CONTEXT_NOT_PUBLISHED: 404,
  CONTEXT_SHADOWS_COMMON: 409,
  CROSS_WORKSPACE_REFERENCE: 409,
  CONTEXT_REFERENCE_NOT_QUALIFIED: 400,
  CONTEXT_REFERENCE_UNRESOLVED: 409,
  CONTEXT_ENTRY_INVALID: 400,
  CONTEXT_ENTRY_DUPLICATE: 400,
  CONTEXT_ENTRIES_UNREADABLE: 400,
  // A Data Product Query failure is a governed answer, not a server fault.
  DATA_PRODUCT_QUERY_INVALID: 400,
  DATA_PRODUCT_QUERY_CURSOR_INVALID: 400,
  DATA_PRODUCT_QUERY_REFUSED: 403,
  DATA_PRODUCT_NOT_AVAILABLE: 404,
  DATA_PRODUCT_NOT_PUBLISHED: 409,
  DATA_PRODUCT_RELEASE_NOT_FOUND: 404,
  DATASET_RELEASE_NOT_FOUND: 409,
  DATA_PRODUCT_QUERY_TOO_COMPLEX: 422,
  DATA_PRODUCT_QUERY_RESULT_TOO_LARGE: 422,
  DATA_PRODUCT_QUERY_TIMEOUT: 504,
  MODEL_PROFILE_NAME_INVALID: 400,
  MODEL_ADAPTER_UNSUPPORTED: 400,
  MODEL_PROFILE_CONFIGURATION_INVALID: 400,
  MODEL_PROFILE_CONFIGURATION_UNREADABLE: 400,
  MODEL_PROFILE_NOT_FOUND: 404,
  MODEL_PROFILE_VERSION_NOT_FOUND: 404,
  MODEL_PROFILE_NOT_ACTIVATED: 409,
  MODEL_PROFILE_EVALUATION_REQUIRED: 409,
  MODEL_PROFILE_EVALUATION_FAILED: 409,
  MODEL_PROMPT_NOT_SIMPLIFIED_CHINESE: 422,
  MODEL_BINDING_CONFIGURATION_INVALID: 400,
  MODEL_BINDING_CONFIGURATION_UNREADABLE: 400,
  MODEL_BINDING_NOT_FOUND: 404,
  MODEL_BINDING_PURPOSE_UNSUPPORTED: 422,
  MODEL_BINDING_PURPOSE_NOT_PERMITTED: 422,
  MODEL_BINDING_DATA_CATEGORY_NOT_PERMITTED: 422,
  MODEL_BINDING_DATA_CATEGORY_INCOMPLETE: 422,
  MODEL_BINDING_PREFLIGHT_FAILED: 422,
};

function sendFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof OperatorError) {
    sendJson(response, STATUS_BY_CODE[error.code] ?? 503, {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
    });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
    });
    return;
  }
  sendJson(response, 500, {
    code: 'CONSOLE_REQUEST_FAILED',
    message: 'The Operator Console could not complete the request.',
  });
}
