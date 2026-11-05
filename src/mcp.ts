import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  approveAuthorization,
  denyAuthorization,
  describeAuthorization,
  issueAccessToken,
  OAuthAuthorizationError,
  OAuthError,
  resolveAccessToken,
  type AuthorizationConsentView,
} from './agents.js';
import { USER_SESSION_COOKIE } from './auth.js';
import { OperatorError } from './errors.js';
import { callTool, findTool, listTools, TOOL_CONTRACT_VERSION } from './mcp-tools.js';
import { openPlatform } from './session.js';

/** The one protocol revision this Deployment serves; older peers cannot fall forward into it. */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION];
const SERVER_INFO = { name: 'datacenter-governed-data', version: '0.1.0' };
const MAX_MCP_BODY_BYTES = 64 * 1024;

/** JSON-RPC 2.0 codes this surface publishes, alongside its own machine-readable codes. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const SERVER_ERROR = -32000;

export interface McpServerIdentity {
  /** The canonical origin this Deployment serves, resolved from its own listening address. */
  origin: string;
}

export interface McpSurfaceOptions {
  root: string;
  masterKey: string;
  identity: McpServerIdentity;
}

/** One structured failure of the transport, before or beside a JSON-RPC message. */
class McpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly rpcCode: number = SERVER_ERROR,
    readonly data: Record<string, unknown> = {},
    readonly nextStep?: string,
  ) {
    super(message);
    this.name = 'McpFailure';
  }
}

/**
 * Serves the current MCP Streamable HTTP surface: one self-contained POST per
 * JSON-RPC message, no protocol session, and no legacy transport. Everything the
 * current revision does not define fails closed with a structured error.
 */
export async function handleMcpSurface(
  options: McpSurfaceOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === '/mcp') {
    await handleMcp(options, request, response);
    return true;
  }
  if (url.pathname === '/oauth/token') {
    await handleToken(options, request, response);
    return true;
  }
  if (url.pathname === '/oauth/authorize') {
    await handleAuthorization(options, request, response, url);
    return true;
  }
  if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    sendJson(response, 200, protectedResourceMetadata(options.identity));
    return true;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    sendJson(response, 200, authorizationServerMetadata(options.identity));
    return true;
  }
  return false;
}

/** RFC 9728 metadata: the canonical MCP resource and the Deployment that authorizes it. */
export function protectedResourceMetadata(identity: McpServerIdentity): Record<string, unknown> {
  return {
    resource: mcpResource(identity),
    authorization_servers: [identity.origin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:read', 'mcp:nlq'],
    resource_documentation: `${identity.origin}/mcp`,
  };
}

/** RFC 8414 metadata for the Deployment's own authorization server. */
export function authorizationServerMetadata(identity: McpServerIdentity): Record<string, unknown> {
  return {
    issuer: identity.origin,
    authorization_endpoint: `${identity.origin}/oauth/authorize`,
    token_endpoint: `${identity.origin}/oauth/token`,
    grant_types_supported: ['client_credentials', 'authorization_code'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ['mcp:read', 'mcp:nlq'],
    resource_indicators_supported: true,
  };
}

export function mcpResource(identity: McpServerIdentity): string {
  return `${identity.origin}/mcp`;
}

async function handleMcp(
  options: McpSurfaceOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    if (method !== 'POST') {
      // The standalone GET stream and the DELETE session end are legacy transports.
      throw new McpFailure(
        405,
        'MCP_TRANSPORT_UNSUPPORTED',
        'The MCP endpoint serves one self-contained POST per JSON-RPC message; GET and DELETE streams are not part of the current transport.',
        -1,
        { allow: 'POST' },
        'Send each JSON-RPC message as its own POST.',
      );
    }
    // Origin is a property of the HTTP request, not a claim inside the token:
    // a browser context that is not this Deployment's origin has no MCP surface.
    const origin = headerOne(request.headers.origin);
    if (origin !== undefined && origin !== '' && origin !== options.identity.origin) {
      throw new McpFailure(
        403,
        'MCP_ORIGIN_NOT_ALLOWED',
        'The request came from an Origin this Deployment does not serve.',
        -1,
        { origin: options.identity.origin },
        'Send the request from this Deployment\'s own origin.',
      );
    }
    if (headerOne(request.headers['mcp-session-id']) !== undefined) {
      throw new McpFailure(
        400,
        'MCP_SESSION_UNSUPPORTED',
        'This Deployment serves the stateless current protocol and mints no protocol session.',
        INVALID_REQUEST,
        {},
        'Send every request self-contained instead of continuing a legacy session.',
      );
    }
    if (!mediaTypeIs(headerOne(request.headers['content-type']), 'application/json')) {
      throw new McpFailure(415, 'MCP_CONTENT_TYPE_UNSUPPORTED', 'An MCP message must be posted as application/json.', -1);
    }
    const accept = headerOne(request.headers.accept) ?? '';
    if (!mediaTypeIs(accept, 'application/json') || !mediaTypeIs(accept, 'text/event-stream')) {
      throw new McpFailure(
        406,
        'MCP_TRANSPORT_UNSUPPORTED',
        'A Streamable HTTP client accepts both application/json and text/event-stream.',
        -1,
        {},
        'State both media types in Accept.',
      );
    }

    const version = headerOne(request.headers['mcp-protocol-version']);
    if (version === undefined || version === '') {
      throw new McpFailure(
        400,
        'MCP_PROTOCOL_VERSION_REQUIRED',
        'Every MCP request states the protocol revision it speaks.',
        INVALID_REQUEST,
        { supported: SUPPORTED_VERSIONS },
        `State MCP-Protocol-Version: ${MCP_PROTOCOL_VERSION}.`,
      );
    }
    if (!SUPPORTED_VERSIONS.includes(version)) {
      throw new McpFailure(
        400,
        'MCP_PROTOCOL_VERSION_UNSUPPORTED',
        `This Deployment does not serve MCP ${version}.`,
        UNSUPPORTED_PROTOCOL_VERSION,
        { supported: SUPPORTED_VERSIONS, requested: version },
        `Use MCP ${MCP_PROTOCOL_VERSION}.`,
      );
    }

    const message = await readMessage(request);
    const id = message['id'] ?? null;
    const rpcMethod = message['method'];
    if (message['jsonrpc'] !== '2.0' || typeof rpcMethod !== 'string') {
      throw new McpFailure(400, 'MCP_MESSAGE_INVALID', 'An MCP message must be a JSON-RPC 2.0 request.', INVALID_REQUEST);
    }
    const declaredMethod = headerOne(request.headers['mcp-method']);
    if (declaredMethod === undefined || declaredMethod === '') {
      throw new McpFailure(400, 'MCP_METHOD_HEADER_REQUIRED', 'Every MCP request states its method in Mcp-Method.', INVALID_REQUEST);
    }
    if (declaredMethod !== rpcMethod) {
      throw new McpFailure(
        400,
        'MCP_METHOD_HEADER_MISMATCH',
        'The Mcp-Method header does not name the method the message states.',
        INVALID_REQUEST,
      );
    }
    if (rpcMethod === 'initialize' || rpcMethod === 'notifications/initialized') {
      throw new McpFailure(
        400,
        'MCP_LEGACY_LIFECYCLE_UNSUPPORTED',
        'The legacy initialization lifecycle is not served; use server/discover and self-contained requests.',
        METHOD_NOT_FOUND,
        { supported: SUPPORTED_VERSIONS },
        `Call server/discover instead.`,
      );
    }

    const params = readParams(message['params']);
    let result: Record<string, unknown>;
    if (rpcMethod === 'server/discover') {
      result = discoverResult();
    } else if (rpcMethod === 'tools/list' || rpcMethod === 'tools/call') {
      const name = params['name'];
      if (rpcMethod === 'tools/call') {
        const declaredName = headerOne(request.headers['mcp-name']);
        if (declaredName === undefined || declaredName === '') {
          throw new McpFailure(400, 'MCP_NAME_HEADER_REQUIRED', 'A tool invocation states its Tool Name in Mcp-Name.', INVALID_PARAMS);
        }
        if (typeof name !== 'string' || declaredName !== name) {
          throw new McpFailure(400, 'MCP_NAME_HEADER_MISMATCH', 'The Mcp-Name header does not name the tool the message invokes.', INVALID_PARAMS);
        }
      }
      result = await resolveAuthenticated(request, options, { jsonrpcMethod: rpcMethod, params });
    } else {
      throw new McpFailure(400, 'MCP_METHOD_NOT_FOUND', `MCP method ${rpcMethod} is not served.`, METHOD_NOT_FOUND);
    }
    sendJsonRpc(response, 200, { jsonrpc: '2.0', id, result });
  } catch (error) {
    if (error instanceof McpFailure) {
      sendFailure(response, error, null);
      return;
    }
    sendFailure(
      response,
      new McpFailure(500, 'MCP_REQUEST_FAILED', 'The MCP Server could not complete the request.'),
      null,
    );
  }
}

function discoverResult(): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    supportedVersions: [...SUPPORTED_VERSIONS],
    serverInfo: { ...SERVER_INFO },
    // Tool contracts are versioned independently of the protocol and of Data
    // Product Artifact versions. The advertised scopes stay the public ceilings
    // the protected-resource metadata already states.
    capabilities: {
      tools: { listChanged: false, contractVersion: TOOL_CONTRACT_VERSION },
      scopes: ['mcp:read', 'mcp:nlq'],
    },
  };
}

/**
 * Authorization is required for every tool operation; discovery is deliberately
 * the only unauthenticated operation. The bearer token is resolved against this
 * Deployment\'s own issuer and resource, never forwarded anywhere.
 */
async function resolveAuthenticated(
  request: IncomingMessage,
  options: McpSurfaceOptions,
  context: { jsonrpcMethod: string; params: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const resourceMetadata = `${options.identity.origin}/.well-known/oauth-protected-resource`;
  const token = bearerToken(request);
  if (token === undefined) {
    throw new McpFailure(
      401,
      'MCP_AUTHENTICATION_REQUIRED',
      'Every tool operation requires an access token.',
      -1,
      { resource_metadata: resourceMetadata },
      'Obtain a token from this Deployment and send it as a Bearer credential.',
    );
  }
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const grant = resolveAccessToken(session.state, token, options.identity.origin, mcpResource(options.identity));
  if (grant.kind === 'rejected') {
    throw new McpFailure(401, grant.code, grant.message, -1, { resource_metadata: resourceMetadata });
  }
  const scopes = new Set(grant.scopes);
  if (context.jsonrpcMethod === 'tools/list') {
    return { tools: listTools(scopes) };
  }
  const name = typeof context.params['name'] === 'string' ? context.params['name'] : '';
  const tool = findTool(name);
  if (tool === undefined) {
    throw new McpFailure(400, 'MCP_TOOL_NOT_FOUND', `${name} is not a tool this Deployment publishes.`, INVALID_PARAMS);
  }
  // A tool the Agent Identity's scopes do not cover is not invocable at all,
  // even if a client guesses its name.
  if (!tool.scopes.every((scope) => scopes.has(scope))) {
    throw new McpFailure(
      403,
      'MCP_SCOPE_REQUIRED',
      `This Agent Identity does not hold the ${tool.scopes.join(', ')} scope ${tool.name} requires.`,
      -1,
      { required: [...tool.scopes] },
    );
  }
  return callTool(session, grant, tool, context.params['arguments']);
}

/** Reads the Bearer credential a request presents, or nothing at all. */
function bearerToken(request: IncomingMessage): string | undefined {
  const header = headerOne(request.headers.authorization);
  if (header === undefined) return undefined;
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The token endpoint. It mints one short-lived access token for a pre-registered
 * client and answers with RFC 6749 error documents, so a client learns exactly
 * which claim was refused.
 */
async function handleToken(
  options: McpSurfaceOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if ((request.method ?? 'GET') !== 'POST') {
      throw new McpFailure(405, 'OAUTH_TOKEN_METHOD_UNSUPPORTED', 'The token endpoint accepts POST only.', -1, { allow: 'POST' });
    }
    if (!mediaTypeIs(headerOne(request.headers['content-type']), 'application/x-www-form-urlencoded')) {
      throw new McpFailure(415, 'OAUTH_TOKEN_CONTENT_TYPE_UNSUPPORTED', 'A token request must be posted as application/x-www-form-urlencoded.', -1);
    }
    const form = await readForm(request);
    sendJson(response, 200, issueAccessToken({
      root: options.root,
      masterKey: options.masterKey,
      origin: options.identity.origin,
      form,
    }));
  } catch (error) {
    if (error instanceof OAuthError) {
      sendJson(response, error.status, { error: error.error, error_description: error.message });
      return;
    }
    if (error instanceof McpFailure) {
      sendFailure(response, error, null);
      return;
    }
    throw error;
  }
}

/**
 * The authorization endpoint. A platform User must already hold a session; the
 * request names one pre-registered client, one exact redirect URI, one
 * Workspace, and a PKCE S256 challenge. GET states the consent, and only an
 * explicit POST approval issues the short-lived single-use code.
 */
async function handleAuthorization(
  options: McpSurfaceOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') {
      throw new McpFailure(
        405,
        'OAUTH_AUTHORIZE_METHOD_UNSUPPORTED',
        'The authorization endpoint accepts GET and POST only.',
        -1,
        { allow: 'GET, POST' },
      );
    }
    let params: Record<string, string>;
    if (method === 'GET') {
      params = {};
      for (const [name, value] of url.searchParams) params[name] = value;
    } else {
      // A consent decision is a state change: it must come from this origin,
      // and the SameSite=Lax session cookie is never sent by a cross-site POST.
      const origin = headerOne(request.headers.origin);
      if (origin !== undefined && origin !== '' && origin !== options.identity.origin) {
        throw new McpFailure(
          403,
          'OAUTH_ORIGIN_NOT_ALLOWED',
          'The authorization request came from an Origin this Deployment does not serve.',
          -1,
        );
      }
      if (!mediaTypeIs(headerOne(request.headers['content-type']), 'application/x-www-form-urlencoded')) {
        throw new McpFailure(
          415,
          'OAUTH_AUTHORIZE_CONTENT_TYPE_UNSUPPORTED',
          'A consent decision must be posted as application/x-www-form-urlencoded.',
          -1,
        );
      }
      params = await readForm(request);
    }
    const token = cookieValueFor(request, USER_SESSION_COOKIE);
    if (token === undefined || token === '') {
      sendHtml(response, 401, authorizationErrorPage('需要登录', 'session_required'));
      return;
    }
    if (method === 'GET') {
      const view = describeAuthorization({
        root: options.root,
        masterKey: options.masterKey,
        token,
        params,
      });
      sendHtml(response, 200, consentPage(view));
      return;
    }
    const decision = params['decision'];
    if (decision === 'approve') {
      sendRedirect(response, approveAuthorization({
        root: options.root,
        masterKey: options.masterKey,
        token,
        params,
      }).location);
      return;
    }
    if (decision === 'deny') {
      sendRedirect(response, denyAuthorization({
        root: options.root,
        masterKey: options.masterKey,
        token,
        params,
      }).location);
      return;
    }
    // An unrecognized decision is stated locally, never redirected to a URI
    // this request has not proven against the registered client.
    throw new OAuthAuthorizationError(400, 'invalid_request', 'The consent decision must be approve or deny.');
  } catch (error) {
    if (error instanceof OAuthAuthorizationError) {
      if (error.redirectUri !== null) {
        sendOAuthErrorRedirect(response, error.redirectUri, error.error, error.state);
      } else {
        sendHtml(response, error.status, authorizationErrorPage('授权请求无效', error.error));
      }
      return;
    }
    if (error instanceof OperatorError) {
      if (error.code === 'SESSION_INVALID') {
        sendHtml(response, 401, authorizationErrorPage('需要登录', 'session_required'));
        return;
      }
      sendHtml(response, 503, authorizationErrorPage('授权服务暂不可用', 'oauth_unavailable'));
      return;
    }
    if (error instanceof McpFailure) {
      sendFailure(response, error, null);
      return;
    }
    throw error;
  }
}

/** One authorization error redirected to the exact URI the client registered. */
function sendOAuthErrorRedirect(
  response: ServerResponse,
  redirectUri: string,
  error: string,
  state: string | null,
): void {
  const location = new URL(redirectUri);
  location.searchParams.set('error', error);
  if (state !== null) location.searchParams.set('state', state);
  sendRedirect(response, location.toString());
}

function sendRedirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader('location', location);
  response.setHeader('cache-control', 'no-store');
  response.end();
}

/** Reads one cookie value; the platform session cookie is the only one read here. */
function cookieValueFor(request: IncomingMessage, name: string): string | undefined {
  const header = headerOne(request.headers.cookie);
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** The consent page names exactly what the User is being asked to delegate. */
function consentPage(view: AuthorizationConsentView): string {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  const state = view.state === null ? '' : hidden('state', view.state);
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>授权委托访问</title></head>
<body>
<main>
<h1>授权委托访问</h1>
<p>代理身份 <strong>${escapeHtml(view.agent.name)}</strong> 请求代表你（${escapeHtml(view.user.username)}）在工作区 <strong>${escapeHtml(view.workspace.name)}</strong> 中读取受治理数据。</p>
<dl>
<dt>客户端</dt><dd>${escapeHtml(view.client.client_name)}（${escapeHtml(view.client.client_id)}）</dd>
<dt>权限范围</dt><dd>${escapeHtml(view.scopes.join(' '))}</dd>
<dt>重定向地址</dt><dd>${escapeHtml(view.redirect_uri)}</dd>
</dl>
<p>同意后，代理身份只能读取你的当前权限与其自身授权的交集，且仅限本工作区；你可以随时在工作区中撤销委托。</p>
<form method="post" action="/oauth/authorize">
${hidden('response_type', 'code')}
${hidden('client_id', view.client.client_id)}
${hidden('redirect_uri', view.redirect_uri)}
${hidden('scope', view.scopes.join(' '))}
${state}
${hidden('code_challenge', view.code_challenge)}
${hidden('code_challenge_method', 'S256')}
${hidden('workspace_id', view.workspace.workspace_id)}
<button type="submit" name="decision" value="approve">同意授权</button>
<button type="submit" name="decision" value="deny">拒绝</button>
</form>
</main>
</body>
</html>`;
}

/** User-facing authorization errors stay in Simplified Chinese; the code stays machine-readable. */
const AUTHORIZATION_ERROR_COPY: Record<string, string> = {
  session_required: '授权委托访问需要一个已登录的平台用户会话。',
  invalid_request: '授权请求无效，或缺少必需的 PKCE S256 参数。',
  unsupported_response_type: '本部署只签发授权码。',
  invalid_scope: '请求的权限范围超出该代理身份的上限。',
  access_denied: '该委托同意未生效或已被撤销。',
  oauth_unavailable: '授权服务暂不可用，请稍后重试。',
};

function authorizationErrorPage(title: string, code: string): string {
  const message = AUTHORIZATION_ERROR_COPY[code] ?? '授权请求无法完成。';
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><code>${escapeHtml(code)}</code></p>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_MCP_BODY_BYTES) {
      throw new McpFailure(413, 'OAUTH_REQUEST_TOO_LARGE', 'The OAuth request body is too large.', -1);
    }
    chunks.push(buffer);
  }
  const form: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
    form[name] = value;
  }
  return form;
}

function readParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpFailure(400, 'MCP_MESSAGE_INVALID', 'MCP params must be a JSON object.', INVALID_PARAMS);
  }
  return value as Record<string, unknown>;
}

async function readMessage(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_MCP_BODY_BYTES) {
      throw new McpFailure(413, 'MCP_MESSAGE_TOO_LARGE', 'The MCP message is too large.');
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new McpFailure(400, 'MCP_MESSAGE_INVALID', 'An MCP request must carry one JSON-RPC message.', PARSE_ERROR);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new McpFailure(400, 'MCP_MESSAGE_INVALID', 'The MCP message must be valid JSON.', PARSE_ERROR);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpFailure(400, 'MCP_MESSAGE_INVALID', 'An MCP request carries exactly one JSON-RPC object.', INVALID_REQUEST);
  }
  return parsed as Record<string, unknown>;
}

/** Reads one header value; a repeated header is never silently merged. */
function headerOne(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Compares a media type without being fooled by parameters or case. */
function mediaTypeIs(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase())
    .includes(expected);
}

function sendFailure(response: ServerResponse, failure: McpFailure, id: unknown): void {
  const headers: Record<string, string> = {};
  if (failure.status === 401) {
    headers['www-authenticate'] = `Bearer resource_metadata="${failure.data['resource_metadata'] ?? '/.well-known/oauth-protected-resource'}"`;
  }
  if (failure.code === 'MCP_TRANSPORT_UNSUPPORTED' && failure.status === 405) {
    headers.allow = 'POST';
  }
  const payload = failure.rpcCode === -1
    ? { code: failure.code, message: failure.message, ...(failure.nextStep === undefined ? {} : { next_step: failure.nextStep }) }
    : {
      jsonrpc: '2.0',
      id,
      error: {
        code: failure.rpcCode,
        message: failure.message,
        data: { code: failure.code, ...failure.data, ...(failure.nextStep === undefined ? {} : { next_step: failure.nextStep }) },
      },
    };
  sendJson(response, failure.status, payload, headers);
}

function sendJsonRpc(response: ServerResponse, status: number, payload: unknown): void {
  sendJson(response, status, payload);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  // The consent form posts back to this same origin; nothing else is loadable.
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  );
  response.end(html);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(`${JSON.stringify(payload)}\n`);
}
