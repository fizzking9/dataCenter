import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueAccessToken, OAuthError, resolveAccessToken } from './agents.js';
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
    token_endpoint: `${identity.origin}/oauth/token`,
    grant_types_supported: ['client_credentials'],
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
    capabilities: { tools: { listChanged: false } },
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
  const session = openPlatform(options.root, options.masterKey);
  const grant = resolveAccessToken(session.state, token, options.identity.origin, mcpResource(options.identity));
  if (grant.kind === 'rejected') {
    throw new McpFailure(401, grant.code, grant.message, -1, { resource_metadata: resourceMetadata });
  }
  const scopes = new Set(grant.scopes);
  if (context.jsonrpcMethod === 'tools/list') {
    return { tools: TOOLS.filter((tool) => tool.scopes.every((scope) => scopes.has(scope))).map(toolView) };
  }
  return callTool(session, grant, context.params);
}

/** Reads the Bearer credential a request presents, or nothing at all. */
function bearerToken(request: IncomingMessage): string | undefined {
  const header = headerOne(request.headers.authorization);
  if (header === undefined) return undefined;
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match?.[1];
}

interface McpTool {
  name: string;
  title: string;
  description: string;
  scopes: string[];
  inputSchema: Record<string, unknown>;
}

/**
 * The generic read-only tools this Deployment publishes. They are driven by the
 * Contract, so no Data Product ever gets a bespoke tool.
 */
const TOOLS: McpTool[] = [
  {
    name: 'discover_data_products',
    title: 'Discover Data Products',
    description: 'Lists the published Data Products in one Workspace that this Agent Identity may read, with the fields, metrics, and filters its Grants permit.',
    scopes: ['mcp:read'],
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', description: 'The Workspace whose Data Products to discover.' } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_data_product_contract',
    title: 'Read Data Product Contract',
    description: 'Reads the Contract of one published Data Product: its fields, dimensions, metrics, grain, time, filters, and limits, narrowed to what this Agent Identity may read.',
    scopes: ['mcp:read'],
    inputSchema: {
      type: 'object',
      properties: { data_product_id: { type: 'string', description: 'The Data Product whose Contract to read.' } },
      required: ['data_product_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_data_product',
    title: 'Query Data Product',
    description: 'Answers one Data Product Query against the pinned Release, with the same records, cursors, Provenance, and errors the Data Product API answers.',
    scopes: ['mcp:read'],
    inputSchema: {
      type: 'object',
      properties: {
        data_product_id: { type: 'string', description: 'The Data Product to query.' },
        query: { type: 'object', description: 'The Data Product Query document, exactly as the Data Product API accepts it.' },
      },
      required: ['data_product_id', 'query'],
      additionalProperties: false,
    },
  },
];

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

async function readForm(request: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_MCP_BODY_BYTES) {
      throw new McpFailure(413, 'OAUTH_REQUEST_TOO_LARGE', 'The token request is too large.', -1);
    }
    chunks.push(buffer);
  }
  const form: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
    form[name] = value;
  }
  return form;
}

/** Dispatches one tool invocation; every tool answers or fails as a tool result. */
function callTool(
  _session: ReturnType<typeof openPlatform>,
  _grant: { agent: { name: string }; client: { client_id: string }; scopes: string[] },
  params: Record<string, unknown>,
): Record<string, unknown> {
  throw new McpFailure(400, 'MCP_TOOL_NOT_FOUND', `${String(params['name'])} is not a tool this Deployment publishes.`, INVALID_PARAMS);
}

function toolView(tool: McpTool): Record<string, unknown> {
  return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema };
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
