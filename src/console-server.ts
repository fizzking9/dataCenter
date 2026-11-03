import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exchangeOperatorEnrollment,
  resolveOperatorSession,
  signInOperator,
  signOutOperator,
  OPERATOR_SESSION_LIFETIME_MS,
} from './operators.js';
import { OperatorError } from './errors.js';
import { readLicenseSummary } from './license.js';
import { openPlatform } from './session.js';
import { deploymentStatus } from './status.js';
import { readDeployment } from './state.js';

export const SESSION_COOKIE = 'dc_operator_console';

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
  const handler = createHandler(options, assets);
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

function createHandler(options: ConsoleServerOptions, assets: string) {
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(options, request, response, url.pathname);
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

function cookieValue(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
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
