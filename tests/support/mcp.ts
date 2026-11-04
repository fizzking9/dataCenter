/** One MCP Streamable HTTP exchange, as a client would state it. */
export interface McpCallOptions {
  token?: string;
  /** The Origin header a browser client would send; omitted by non-browser clients. */
  origin?: string;
  /** Overrides the protocol-version header; `null` omits it. */
  protocolVersion?: string | null;
  /** Overrides the Mcp-Method header; `null` omits it. */
  mcpMethod?: string | null;
  /** Overrides the Mcp-Name header; `null` omits it. */
  mcpName?: string | null;
  sessionId?: string;
  accept?: string;
  method?: string;
  contentType?: string;
}

export interface McpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
}

export const MCP_VERSION = '2026-07-28';

/** Posts one JSON-RPC message the way a current Streamable HTTP client does. */
export async function mcpCall(
  url: string,
  message: Record<string, unknown>,
  options: McpCallOptions = {},
): Promise<McpResult> {
  const method = String(message['method'] ?? '');
  const name = typeof message['params'] === 'object' && message['params'] !== null
    ? (message['params'] as Record<string, unknown>)['name']
    : undefined;
  const headers: Record<string, string> = {
    accept: options.accept ?? 'application/json, text/event-stream',
    'content-type': options.contentType ?? 'application/json',
    'mcp-protocol-version': options.protocolVersion === null ? '' : (options.protocolVersion ?? MCP_VERSION),
    'mcp-method': options.mcpMethod === null ? '' : (options.mcpMethod ?? method),
  };
  if (options.mcpName === null) {
    // omitted deliberately
  } else if (options.mcpName !== undefined) {
    headers['mcp-name'] = options.mcpName;
  } else if (method === 'tools/call' && typeof name === 'string') {
    headers['mcp-name'] = name;
  }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.sessionId !== undefined) headers['mcp-session-id'] = options.sessionId;
  // An intentionally blank header is not sent at all by fetch, which is exactly
  // the "header absent" case a client omitting it produces.
  for (const [key, value] of Object.entries(headers)) {
    if (value === '') delete headers[key];
  }
  const response = await fetch(`${url}/mcp`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.method === undefined || options.method === 'POST'
      ? { body: JSON.stringify(message) }
      : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: parseJson(text),
    text,
    headers: response.headers,
  };
}

/** Reads one JSON-RPC result from a successful exchange. */
export function mcpResult(result: McpResult): Record<string, unknown> {
  return (result.body['result'] ?? {}) as Record<string, unknown>;
}

/** Reads the JSON-RPC error a failed exchange carries. */
export function mcpError(result: McpResult): {
  code: number;
  message: string;
  data: Record<string, unknown>;
} {
  const error = (result.body['error'] ?? {}) as Record<string, unknown>;
  return {
    code: Number(error['code']),
    message: String(error['message'] ?? ''),
    data: (error['data'] ?? {}) as Record<string, unknown>,
  };
}

/** Reads a tool invocation's structured payload, failing loudly when it is an error. */
export function toolPayload(result: McpResult): Record<string, unknown> {
  const payload = (mcpResult(result)['structuredContent'] ?? {}) as Record<string, unknown>;
  return payload;
}

/** Reads a tool invocation's structured failure. */
export function toolFailure(result: McpResult): {
  code: string;
  message: string;
  next_step?: string;
  field?: string;
  retryable: boolean;
} {
  const payload = toolPayload(result);
  return (payload['error'] ?? {}) as ReturnType<typeof toolFailure>;
}

function parseJson(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { unparsed: text };
  }
}

/** One OAuth token request, as an autonomous Agent client states it. */
export async function requestToken(
  url: string,
  form: Record<string, string>,
  options: { basic?: { clientId: string; clientSecret: string } } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (options.basic) {
    headers.authorization = `Basic ${Buffer.from(`${options.basic.clientId}:${options.basic.clientSecret}`).toString('base64')}`;
  }
  const response = await fetch(`${url}/oauth/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}
