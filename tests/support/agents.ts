import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { USER_SESSION_COOKIE } from '../../src/auth.js';
import type { OperatorResult } from './operator.js';
import { requestToken } from './mcp.js';
import { command, jsonFile, type PlatformFixture } from './platform.js';

/**
 * One Client ID Metadata Document a pre-registered OAuth client is created
 * from: the document's own URL is the Client Identifier, and the redirect URI
 * is the only one the client may name.
 */
export const CLIENT_METADATA = {
  client_id: 'https://agent.example.invalid/oauth/client.json',
  client_name: 'Certification Agent',
  redirect_uris: ['https://agent.example.invalid/callback'],
};

/** Creates one Agent Identity bound to the Workspace that owns the Data Products. */
export function createAgent(
  fixture: PlatformFixture,
  administratorToken: string,
  workspaceId: string,
  scopes = 'mcp:read',
  name = 'certification-agent',
): string {
  const created = command(
    fixture,
    ['agent', 'create', '--name', name, '--workspaces', workspaceId, '--scopes', scopes],
    { token: administratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  return String(created.output.agent_identity_id);
}

/** Registers one pre-registered OAuth client from a Client ID Metadata Document. */
export function registerAgentClient(
  fixture: PlatformFixture,
  administratorToken: string,
  agentIdentityId: string,
  metadata: unknown = CLIENT_METADATA,
  name = 'agent-client',
): { client_id: string; client_secret: string } {
  const registered = command(
    fixture,
    ['agent', 'client-register', '--agent', agentIdentityId, '--metadata', jsonFile(fixture, name, metadata)],
    { token: administratorToken },
  );
  assert.equal(registered.status, 0, registered.stderr);
  return registered.output as unknown as { client_id: string; client_secret: string };
}

/** Narrows what one Agent Identity may read of one Data Product. */
export function grantAgent(
  fixture: PlatformFixture,
  workspaceAdministratorToken: string,
  dataProductId: string,
  agentIdentityId: string,
  request: Record<string, unknown>,
  name = 'agent-grant',
): OperatorResult {
  return command(
    fixture,
    ['grant', 'publish', '--product', dataProductId, '--agent', agentIdentityId, '--request', jsonFile(fixture, name, request)],
    { token: workspaceAdministratorToken },
  );
}

/** Records one User's consent for one Agent Identity inside one Workspace. */
export function delegateAgent(
  fixture: PlatformFixture,
  userToken: string,
  agentIdentityId: string,
  workspaceId: string,
): { delegation_id: string } {
  const delegated = command(
    fixture,
    ['agent', 'delegate', '--agent', agentIdentityId, '--workspace', workspaceId],
    { token: userToken },
  );
  assert.equal(delegated.status, 0, delegated.stderr);
  return delegated.output as unknown as { delegation_id: string };
}

/** Mints one autonomous access token for a registered client, bound to this server's own resource. */
export async function issueAgentToken(
  url: string,
  client: { client_id: string; client_secret: string },
  scope = 'mcp:read',
): Promise<string> {
  const issued = await requestToken(url, {
    grant_type: 'client_credentials',
    client_id: client.client_id,
    client_secret: client.client_secret,
    resource: url + '/mcp',
    scope,
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return String(issued.body['access_token']);
}

/** The platform User session cookie a delegated authorization request carries. */
export function userCookie(sessionToken: string): string {
  return `${USER_SESSION_COOKIE}=${sessionToken}`;
}

/** One RFC 7636 verifier and the S256 challenge a client presents. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface AuthorizationRequestOptions {
  workspaceId: string;
  /** The PKCE S256 challenge; callers that need the verifier use `pkcePair`. */
  challenge: string;
  scope?: string;
  redirectUri?: string;
  state?: string;
  responseType?: string;
  codeChallengeMethod?: string;
}

/** The exact query one delegated authorization request states. */
export function authorizationParams(
  client: { client_id: string },
  options: AuthorizationRequestOptions,
): URLSearchParams {
  const params = new URLSearchParams({
    response_type: options.responseType ?? 'code',
    client_id: client.client_id,
    redirect_uri: options.redirectUri ?? CLIENT_METADATA.redirect_uris[0]!,
    code_challenge: options.challenge,
    code_challenge_method: options.codeChallengeMethod ?? 'S256',
    workspace_id: options.workspaceId,
  });
  if (options.scope !== undefined) params.set('scope', options.scope);
  if (options.state !== undefined) params.set('state', options.state);
  return params;
}

export interface AuthorizationResponse {
  status: number;
  body: string;
  location: string | null;
}

/** Navigates to the authorization endpoint, as a browser would, carrying the User session. */
export async function requestAuthorizationConsent(
  url: string,
  params: URLSearchParams,
  cookie: string,
): Promise<AuthorizationResponse> {
  const response = await fetch(`${url}/oauth/authorize?${params.toString()}`, {
    headers: { cookie },
    redirect: 'manual',
  });
  return { status: response.status, body: await response.text(), location: response.headers.get('location') };
}

/** Posts one explicit consent decision; the 303 redirect carries the code or the error. */
export async function decideAuthorization(
  url: string,
  params: URLSearchParams,
  cookie: string,
  decision: 'approve' | 'deny',
): Promise<AuthorizationResponse> {
  const form = new URLSearchParams(params);
  form.set('decision', decision);
  const response = await fetch(`${url}/oauth/authorize`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  return { status: response.status, body: await response.text(), location: response.headers.get('location') };
}

/** Reads the code, error, and state one authorization redirect carries. */
export function redirectParams(location: string | null): URLSearchParams {
  assert.ok(location !== null, 'the authorization endpoint did not redirect');
  return new URL(location).searchParams;
}

/**
 * Runs the whole delegated flow over HTTP: an authenticated User states the
 * consent, explicitly approves it, and the client exchanges the single-use code
 * with its PKCE verifier.
 */
export async function issueDelegatedToken(
  url: string,
  client: { client_id: string; client_secret: string },
  options: { cookie: string; workspaceId: string; scope?: string; redirectUri?: string; state?: string },
): Promise<string> {
  const pair = pkcePair();
  const params = authorizationParams(client, {
    workspaceId: options.workspaceId,
    challenge: pair.challenge,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri }),
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  const consent = await requestAuthorizationConsent(url, params, options.cookie);
  assert.equal(consent.status, 200, consent.body);
  const approved = await decideAuthorization(url, params, options.cookie, 'approve');
  assert.equal(approved.status, 303, approved.body);
  const code = redirectParams(approved.location).get('code');
  assert.ok(code, String(approved.location));
  const issued = await requestToken(url, {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: pair.verifier,
    redirect_uri: options.redirectUri ?? CLIENT_METADATA.redirect_uris[0]!,
    resource: `${url}/mcp`,
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return String(issued.body['access_token']);
}
