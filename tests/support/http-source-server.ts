/**
 * A standalone HTTP source process.
 *
 * It must be its own process: a governed command is run synchronously from the
 * test process, so an in-process server could never answer the connector.
 *
 * argv[2] is a JSON scenario: `{ replies, repeat_last, log, auth }`. Every
 * request is appended to `log` as JSON, including when it arrived, which auth
 * material it carried, and the body it sent. `auth` turns the fixture into a
 * real credential endpoint: `token_path` (or `login_path`) issues the next
 * token, and every other path rejects a token the scenario says is expired or
 * rejected.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Reply {
  status?: number;
  body: string;
  /** Extra response headers, such as Retry-After. */
  headers?: Record<string, string>;
  /** `null` sends no content type at all; otherwise this replaces the default. */
  content_type?: string | null;
  delay_ms?: number;
}

interface AuthScenario {
  token_path?: string;
  login_path?: string;
  /** The token each call to the credential endpoint issues, in order. */
  issued?: string[];
  /** When set, the credential response also sets this cookie to the issued token. */
  cookie_name?: string | null;
  /** Tokens the protected endpoint never accepts. */
  rejected_tokens?: string[];
  /** How many protected requests one issued token serves before it expires. */
  expire_after_uses?: number;
}

interface Scenario {
  replies: Reply[];
  repeat_last?: boolean;
  log: string;
  auth?: AuthScenario;
}

const scenario = JSON.parse(process.argv[2] ?? '{}') as Scenario;
let served = 0;
let issuedIndex = 0;
const uses = new Map<string, number>();
const issued = new Set<string>();

function issuedToken(): string {
  const token = scenario.auth?.issued?.[issuedIndex] ?? 'fixture-issued-token';
  issuedIndex += 1;
  issued.add(token);
  return token;
}

/** The token a protected request presents, whichever shape its auth mode uses. */
function presentedToken(authorization: string | undefined, cookie: string | undefined): string | null {
  const cookieName = scenario.auth?.cookie_name;
  if (cookieName && cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === cookieName) return value.join('=');
    }
  }
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  return null;
}

function isAccepted(token: string | null): boolean {
  const auth = scenario.auth;
  if (!auth) return true;
  if (token === null) return false;
  if (auth.rejected_tokens?.includes(token)) return false;
  if (!issued.has(token)) return false;
  if (auth.expire_after_uses === undefined) return true;
  return (uses.get(token) ?? 0) < auth.expire_after_uses;
}

function respond(response: import('node:http').ServerResponse, reply: Reply): void {
  const send = (): void => {
    response.statusCode = reply.status ?? 200;
    const contentType = reply.content_type === undefined ? 'application/json; charset=utf-8' : reply.content_type;
    if (contentType !== null) response.setHeader('content-type', contentType);
    for (const [name, value] of Object.entries(reply.headers ?? {})) response.setHeader(name, value);
    response.end(reply.body);
  };
  if (reply.delay_ms === undefined) {
    send();
    return;
  }
  setTimeout(send, reply.delay_ms);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    appendFileSync(scenario.log, `${JSON.stringify({
      at: Date.now(),
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      authorization: request.headers.authorization ?? null,
      cookie: request.headers.cookie ?? null,
      api_key: request.headers['x-api-key'] ?? null,
      content_type: request.headers['content-type'] ?? null,
      body,
    })}\n`);

    const auth = scenario.auth;
    if (auth !== undefined && (url.pathname === auth.token_path || url.pathname === auth.login_path)) {
      const token = issuedToken();
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      if (auth.cookie_name) {
        response.setHeader('set-cookie', `${auth.cookie_name}=${token}; Path=/; HttpOnly`);
      }
      response.end(JSON.stringify({ access_token: token, token_type: 'Bearer' }));
      return;
    }

    if (auth !== undefined) {
      const token = presentedToken(request.headers.authorization, request.headers.cookie);
      if (!isAccepted(token)) {
        response.statusCode = 401;
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end('{"error":"invalid_token"}');
        return;
      }
      uses.set(token as string, (uses.get(token as string) ?? 0) + 1);
    }

    const index = scenario.repeat_last === false ? served : Math.min(served, scenario.replies.length - 1);
    served += 1;
    const reply = scenario.replies[index];
    if (reply === undefined) {
      response.statusCode = 500;
      response.end('{"error":"no reply configured"}');
      return;
    }
    respond(response, reply);
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
