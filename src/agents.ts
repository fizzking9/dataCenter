import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, requireDeploymentAdministrator, type ActionContext, type Actor } from './authz.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import {
  findAgentIdentity,
  findOAuthClient,
  findUserById,
  findWorkspace,
  workspaceRoleOf,
  type AccessTokenRecord,
  type AgentDelegationRecord,
  type AgentIdentityRecord,
  type OAuthAuthorizationCodeRecord,
  type OAuthClientRecord,
  type PlatformState,
  type UserRecord,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { constantTimeEquals, hashToken } from './tokens.js';

/** The scopes an Agent Identity may hold; each one opens a tool surface and nothing else. */
// mcp:nlq is reserved for ticket #47 (Natural-Language Query and Reports over MCP).
export const MCP_SCOPES = ['mcp:read', 'mcp:nlq'];

const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const AUTHORIZATION_CODE_LIFETIME_MS = 60 * 1000;
const MAX_REDIRECT_URIS = 8;
const MAX_SCOPES = MCP_SCOPES.length;
/** PKCE S256 output and input shapes, exactly as RFC 7636 defines them. */
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;

/** Metadata the Deployment controls, so a client can never claim it for itself. */
const PROTECTED_CLIENT_FIELDS = [
  'scope',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'issuer',
  'audience',
  'resource',
  'agent_identity_id',
  'client_secret',
  'client_secret_expires_at',
  'registration_access_token',
];

/**
 * One OAuth token-endpoint failure. The token endpoint answers RFC 6749 error
 * documents, so it carries the two fields that format requires rather than an
 * Operator error code.
 */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * One failure of the authorization endpoint. A refusal that already validated
 * the client and redirect URI is redirected back to that exact URI; anything
 * else is stated locally, so an unvalidated URI is never redirected to.
 */
export class OAuthAuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
    readonly redirectUri: string | null = null,
    readonly state: string | null = null,
  ) {
    super(message);
    this.name = 'OAuthAuthorizationError';
  }
}

/** Creates one Agent Identity bound to explicit Workspaces and scopes. */
export function createAgentIdentity(options: {
  root: string;
  masterKey: string;
  token: string;
  name: string;
  workspaceIds: string[];
  scopes: string[];
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'agent_identity_creation', scope: 'deployment', target: options.name };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);

  const name = options.name.trim();
  if (name.length < 2 || name.length > 128) {
    fail('AGENT_NAME_INVALID', 'An Agent Identity name must contain 2 to 128 characters.');
  }
  if (session.state.agent_identities.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
    fail('AGENT_ALREADY_EXISTS', 'An Agent Identity with this name already exists.', 'Name the Agent Identity after the Consumer system it serves.');
  }
  if (options.workspaceIds.length === 0) {
    fail('AGENT_WORKSPACE_INVALID', 'An Agent Identity belongs to at least one Workspace.');
  }
  for (const workspaceId of options.workspaceIds) {
    if (!findWorkspace(session.state, workspaceId)) {
      fail('AGENT_WORKSPACE_INVALID', `${workspaceId} is not a Workspace of this Deployment.`);
    }
  }
  const scopes = requireScopes(fail, options.scopes);
  if (scopes.length === 0) {
    fail('AGENT_SCOPE_INVALID', `An Agent Identity declares at least one of: ${MCP_SCOPES.join(', ')}.`);
  }

  const agent: AgentIdentityRecord = {
    agent_identity_id: randomUUID(),
    name,
    workspace_ids: [...new Set(options.workspaceIds)],
    scopes,
    status: 'active',
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    revoked_at: null,
  };
  session.state.agent_identities.push(agent);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { agent_identity_id: agent.agent_identity_id, workspace_count: agent.workspace_ids.length, scope_count: scopes.length },
  });
  session.save();
  return {
    agent_identity_id: agent.agent_identity_id,
    name: agent.name,
    workspace_ids: [...agent.workspace_ids],
    scopes: [...agent.scopes],
    status: agent.status,
    created_at: agent.created_at,
  };
}

/** Withdraws one Agent Identity, so every token it holds stops authenticating. */
export function revokeAgentIdentity(options: {
  root: string;
  masterKey: string;
  token: string;
  agentIdentityId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'agent_identity_revocation',
    scope: 'deployment',
    target: options.agentIdentityId,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const agent = findAgentIdentity(session.state, options.agentIdentityId);
  if (!agent) {
    reject(session, actorLabel(actor.user), context, 'AGENT_NOT_FOUND', 'The named Agent Identity does not exist in this Deployment.');
  }
  if (agent.status === 'revoked') {
    return { agent_identity_id: agent.agent_identity_id, status: agent.status, revoked_at: agent.revoked_at, already_revoked: true };
  }
  agent.status = 'revoked';
  agent.revoked_at = new Date().toISOString();
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { name: agent.name } });
  session.save();
  return { agent_identity_id: agent.agent_identity_id, status: agent.status, revoked_at: agent.revoked_at };
}

/**
 * Records one User's consent for one Agent Identity to act on their behalf
 * inside one Workspace. Consent never expands either party: the effective
 * authority is always the intersection of the Agent Identity's Grants and the
 * User's own permissions, revalidated on every request.
 */
export function createAgentDelegation(options: {
  root: string;
  masterKey: string;
  token: string;
  agentIdentityId: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'agent_delegation',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.agentIdentityId,
  };
  const actor = resolveActor(session, options.token, context);
  const agent = findAgentIdentity(session.state, options.agentIdentityId);
  if (!agent || agent.status !== 'active' || !agent.workspace_ids.includes(options.workspaceId)) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'AGENT_NOT_FOUND',
      'An active Agent Identity bound to this Workspace must be named.',
    );
  }
  if (!findWorkspace(session.state, options.workspaceId)
    || workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId) === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const existing = session.state.agent_delegations.find(
    (delegation) => delegation.agent_identity_id === agent.agent_identity_id
      && delegation.user_id === actor.user.user_id
      && delegation.workspace_id === options.workspaceId
      && delegation.revoked_at === null,
  );
  if (existing !== undefined) {
    return delegationView(session, existing, true);
  }
  const delegation: AgentDelegationRecord = {
    delegation_id: randomUUID(),
    workspace_id: options.workspaceId,
    agent_identity_id: agent.agent_identity_id,
    user_id: actor.user.user_id,
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    revoked_at: null,
  };
  session.state.agent_delegations.push(delegation);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      delegation_id: delegation.delegation_id,
      agent_identity_id: agent.agent_identity_id,
      delegated_user_id: actor.user.user_id,
    },
  });
  session.save();
  return delegationView(session, delegation, false);
}

/** Withdraws one delegated consent; every token acting under it stops at once. */
export function revokeAgentDelegation(options: {
  root: string;
  masterKey: string;
  token: string;
  delegationId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'agent_delegation_revocation', scope: 'workspace', target: options.delegationId };
  const actor = resolveActor(session, options.token, context);
  const delegation = session.state.agent_delegations.find(
    (candidate) => candidate.delegation_id === options.delegationId,
  );
  const role = delegation === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, delegation.workspace_id);
  if (!delegation || (delegation.user_id !== actor.user.user_id && role !== 'Workspace Administrator')) {
    deny(session, actorLabel(actor.user), context, 'DELEGATION_NOT_AVAILABLE', 'The delegated consent is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: delegation.workspace_id };
  if (delegation.revoked_at !== null) {
    return { delegation_id: delegation.delegation_id, revoked_at: delegation.revoked_at, already_revoked: true };
  }
  delegation.revoked_at = new Date().toISOString();
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { agent_identity_id: delegation.agent_identity_id, delegated_user_id: delegation.user_id },
  });
  session.save();
  return { delegation_id: delegation.delegation_id, revoked_at: delegation.revoked_at };
}

function delegationView(
  session: { state: PlatformState },
  delegation: AgentDelegationRecord,
  alreadyExisting: boolean,
): Record<string, unknown> {
  return {
    delegation_id: delegation.delegation_id,
    workspace_id: delegation.workspace_id,
    agent_identity_id: delegation.agent_identity_id,
    user: {
      user_id: delegation.user_id,
      username: findUserById(session.state, delegation.user_id)?.username ?? null,
    },
    created_at: delegation.created_at,
    revoked_at: delegation.revoked_at,
    ...(alreadyExisting ? { already_existing: true } : {}),
  };
}

/**
 * Registers one OAuth client for an Agent Identity from its Client ID Metadata
 * Document. The client names only itself and where it is redirected; every
 * claim the Deployment controls is refused rather than trusted.
 */
export function registerOAuthClient(options: {
  root: string;
  masterKey: string;
  token: string;
  agentIdentityId: string;
  /** The Client ID Metadata Document as a file, as the lifecycle CLI states it. */
  metadataPath?: string;
  /** The same document as a browser form already read it. */
  metadata?: unknown;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'oauth_client_registration', scope: 'deployment', target: options.agentIdentityId };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const agent = findAgentIdentity(session.state, options.agentIdentityId);
  if (!agent || agent.status !== 'active') {
    reject(session, actorLabel(actor.user), context, 'AGENT_NOT_FOUND', 'A client is registered for an active Agent Identity.');
  }
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  const metadata = options.metadata !== undefined
    ? options.metadata
    : readJsonDocument(
      options.metadataPath ?? '',
      fail,
      'OAUTH_CLIENT_METADATA_INVALID',
      'The Client ID Metadata Document must contain valid JSON.',
    );
  if (!isRecord(metadata)) {
    fail('OAUTH_CLIENT_METADATA_INVALID', 'A Client ID Metadata Document must be a JSON object.');
  }

  const claimed = PROTECTED_CLIENT_FIELDS.filter((field) => metadata[field] !== undefined);
  if (claimed.length > 0) {
    fail(
      'OAUTH_CLIENT_METADATA_PROTECTED',
      `A client cannot claim ${claimed.join(', ')}, which the Deployment's authorization server controls.`,
      'State only client_id, client_name, and redirect_uris; scopes are granted to the Agent Identity.',
    );
  }
  const clientId = typeof metadata['client_id'] === 'string' ? metadata['client_id'] : '';
  requireClientIdentifier(fail, clientId);
  const clientName = typeof metadata['client_name'] === 'string' && metadata['client_name'].trim() !== ''
    ? metadata['client_name'].trim()
    : clientId;
  const redirectUris = readRedirectUris(fail, metadata['redirect_uris']);
  if (findOAuthClient(session.state, clientId)) {
    fail('OAUTH_CLIENT_ALREADY_REGISTERED', 'This Client Identifier is already registered in this Deployment.');
  }

  // The secret is returned once; only its hash is stored, exactly like a session token.
  const secret = randomBytes(32).toString('base64url');
  const client: OAuthClientRecord = {
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    agent_identity_id: agent.agent_identity_id,
    client_secret_hash: hashToken(secret),
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    revoked_at: null,
  };
  session.state.oauth_clients.push(client);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { client_id: client.client_id, agent_identity_id: agent.agent_identity_id },
  });
  session.save();
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    client_secret: secret,
    redirect_uris: [...client.redirect_uris],
    agent_identity_id: agent.agent_identity_id,
    created_at: client.created_at,
  };
}

/** Withdraws one OAuth client, so it can neither authenticate nor refresh. */
export function revokeOAuthClient(options: {
  root: string;
  masterKey: string;
  token: string;
  clientId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'oauth_client_revocation', scope: 'deployment', target: options.clientId };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const client = findOAuthClient(session.state, options.clientId);
  if (!client) {
    reject(session, actorLabel(actor.user), context, 'OAUTH_CLIENT_NOT_FOUND', 'The named OAuth client is not registered in this Deployment.');
  }
  if (client.revoked_at !== null) {
    return { client_id: client.client_id, revoked_at: client.revoked_at, already_revoked: true };
  }
  client.revoked_at = new Date().toISOString();
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { agent_identity_id: client.agent_identity_id } });
  session.save();
  return { client_id: client.client_id, revoked_at: client.revoked_at };
}

/** A client identifier is the HTTPS URL of its own metadata document. */
function requireClientIdentifier(fail: Fail, clientId: string): void {
  const parsed = parseUrl(clientId);
  if (!parsed || parsed.protocol !== 'https:' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
    fail(
      'OAUTH_CLIENT_METADATA_INVALID',
      'A Client Identifier must be the HTTPS URL of a Client ID Metadata Document.',
      'Serve the metadata document over HTTPS and use its absolute URL as client_id.',
    );
  }
}

function readRedirectUris(fail: Fail, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('OAUTH_CLIENT_METADATA_INVALID', 'A Client ID Metadata Document states at least one redirect_uri.');
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    fail('OAUTH_CLIENT_METADATA_INVALID', `A client registers at most ${MAX_REDIRECT_URIS} redirect URIs.`);
  }
  const uris: string[] = [];
  for (const candidate of raw) {
    const parsed = typeof candidate === 'string' ? parseUrl(candidate) : undefined;
    const loopback = parsed?.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1');
    if (!parsed || (parsed.protocol !== 'https:' && !loopback) || parsed.hash !== '') {
      fail('OAUTH_CLIENT_METADATA_INVALID', 'Every redirect_uri must be an absolute HTTPS URL, or a loopback HTTP URL.');
    }
    if (!uris.includes(candidate as string)) uris.push(candidate as string);
  }
  return uris;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function requireScopes(fail: Fail, raw: string[]): string[] {
  const scopes: string[] = [];
  for (const scope of raw) {
    if (!MCP_SCOPES.includes(scope)) {
      fail('AGENT_SCOPE_INVALID', `${scope} is not a scope this Deployment defines.`, `Use one or more of: ${MCP_SCOPES.join(', ')}.`);
    }
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  if (scopes.length > MAX_SCOPES) {
    fail('AGENT_SCOPE_INVALID', `An Agent Identity holds at most ${MAX_SCOPES} scopes.`);
  }
  return scopes;
}

/**
 * What one authorization request would delegate, once every claim has been
 * proven against the Deployment's own identity and the User's session.
 */
export interface AuthorizationConsentView {
  user: { user_id: string; username: string };
  client: { client_id: string; client_name: string };
  agent: { agent_identity_id: string; name: string };
  workspace: { workspace_id: string; name: string };
  scopes: string[];
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
}

interface AuthorizationGrant {
  session: PlatformSession;
  user: UserRecord;
  client: OAuthClientRecord;
  agent: AgentIdentityRecord;
  workspace: { workspace_id: string; name: string };
  delegation: AgentDelegationRecord;
  scopes: string[];
  redirectUri: string;
  state: string | null;
}

/**
 * Describes the consent one authenticated User is being asked for. Nothing is
 * recorded until the User explicitly approves; every claim is revalidated here.
 */
export function describeAuthorization(options: {
  root: string;
  masterKey: string;
  token: string;
  params: Record<string, string>;
}): AuthorizationConsentView {
  const grant = validateAuthorization(options);
  return {
    user: { user_id: grant.user.user_id, username: grant.user.username },
    client: { client_id: grant.client.client_id, client_name: grant.client.client_name },
    agent: { agent_identity_id: grant.agent.agent_identity_id, name: grant.agent.name },
    workspace: { workspace_id: grant.workspace.workspace_id, name: grant.workspace.name },
    scopes: [...grant.scopes],
    redirect_uri: grant.redirectUri,
    code_challenge: options.params['code_challenge'] ?? '',
    state: grant.state,
  };
}

/**
 * Records one explicit consent and issues a short-lived, single-use
 * authorization code bound to the User, Agent Identity, Workspace, scopes,
 * client, exact redirect URI, and PKCE challenge.
 */
export function approveAuthorization(options: {
  root: string;
  masterKey: string;
  token: string;
  params: Record<string, string>;
}): { location: string } {
  const grant = validateAuthorization(options);
  const code = randomBytes(32).toString('base64url');
  const now = Date.now();
  const record: OAuthAuthorizationCodeRecord = {
    code_hash: hashToken(code),
    client_id: grant.client.client_id,
    agent_identity_id: grant.agent.agent_identity_id,
    user_id: grant.user.user_id,
    workspace_id: grant.delegation.workspace_id,
    delegation_id: grant.delegation.delegation_id,
    scopes: [...grant.scopes],
    redirect_uri: grant.redirectUri,
    code_challenge: options.params['code_challenge'] ?? '',
    code_challenge_method: 'S256',
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + AUTHORIZATION_CODE_LIFETIME_MS).toISOString(),
    consumed_at: null,
  };
  grant.session.state.oauth_authorization_codes.push(record);
  grant.session.audit({
    action: 'oauth_authorization_consent',
    scope: 'workspace',
    workspace_id: grant.delegation.workspace_id,
    target: grant.client.client_id,
    actor: actorLabel(grant.user),
    outcome: 'succeeded',
    detail: {
      agent_identity_id: grant.agent.agent_identity_id,
      delegation_id: grant.delegation.delegation_id,
      scopes: grant.scopes.join(' '),
      scope_count: grant.scopes.length,
      redirect_uri: grant.redirectUri,
    },
  });
  grant.session.save();
  return { location: redirectLocation(grant.redirectUri, { code, state: grant.state }) };
}

/** Records one consent refusal; no code is issued and no authority is delegated. */
export function denyAuthorization(options: {
  root: string;
  masterKey: string;
  token: string;
  params: Record<string, string>;
}): { location: string } {
  const grant = validateAuthorization(options);
  grant.session.audit({
    action: 'oauth_authorization_consent',
    scope: 'workspace',
    workspace_id: grant.delegation.workspace_id,
    target: grant.client.client_id,
    actor: actorLabel(grant.user),
    outcome: 'denied',
    detail: {
      reason: 'consent_refused',
      agent_identity_id: grant.agent.agent_identity_id,
      delegation_id: grant.delegation.delegation_id,
      scopes: grant.scopes.join(' '),
    },
  });
  return { location: redirectLocation(grant.redirectUri, { error: 'access_denied', state: grant.state }) };
}

/**
 * Proves one authorization request against the authenticated User, the
 * pre-registered client, the Agent Identity, the Workspace, and the consenting
 * User's active delegated consent. The client and redirect URI are validated
 * before any error may be redirected back, so an unvalidated URI never receives
 * a response.
 */
function validateAuthorization(options: {
  root: string;
  masterKey: string;
  token: string;
  params: Record<string, string>;
}): AuthorizationGrant {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'oauth_authorization_request', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const params = options.params;
  const client = findOAuthClient(session.state, params['client_id'] ?? '');
  if (!client || client.revoked_at !== null) {
    authorizationFailure(session, actor, context, 'invalid_request', 'The client_id is not a registered, active client of this Deployment.', null, null);
  }
  const redirectUri = params['redirect_uri'] ?? '';
  if (!client.redirect_uris.includes(redirectUri)) {
    authorizationFailure(session, actor, context, 'invalid_request', 'The redirect_uri is not one this client registered.', null, null);
  }
  const state = params['state'] ?? null;
  if ((params['response_type'] ?? '') !== 'code') {
    authorizationFailure(session, actor, context, 'unsupported_response_type', 'The authorization endpoint issues authorization codes only.', redirectUri, state);
  }
  const challenge = params['code_challenge'] ?? '';
  if (!PKCE_CHALLENGE.test(challenge) || (params['code_challenge_method'] ?? '') !== 'S256') {
    authorizationFailure(session, actor, context, 'invalid_request', 'A PKCE S256 code_challenge is required.', redirectUri, state);
  }
  const agent = findAgentIdentity(session.state, client.agent_identity_id);
  if (!agent || agent.status !== 'active') {
    authorizationFailure(session, actor, context, 'access_denied', 'The Agent Identity this client acts for is not active.', redirectUri, state);
  }
  const rawScope = (params['scope'] ?? '').trim();
  const scopes = rawScope === ''
    ? [...agent.scopes]
    : [...new Set(rawScope.split(/\s+/u).filter((scope) => scope !== ''))];
  if (scopes.length === 0 || scopes.some((scope) => !agent.scopes.includes(scope))) {
    authorizationFailure(session, actor, context, 'invalid_scope', `This client may request only: ${agent.scopes.join(' ')}.`, redirectUri, state);
  }
  const workspaceId = params['workspace_id'] ?? '';
  const workspace = findWorkspace(session.state, workspaceId);
  const delegation = session.state.agent_delegations.find(
    (candidate) => candidate.workspace_id === workspaceId
      && candidate.agent_identity_id === agent.agent_identity_id
      && candidate.user_id === actor.user.user_id
      && candidate.revoked_at === null,
  );
  if (!workspace
    || !agent.workspace_ids.includes(workspaceId)
    || workspaceRoleOf(session.state, actor.user.user_id, workspaceId) === null
    || delegation === undefined) {
    authorizationFailure(
      session,
      actor,
      context,
      'access_denied',
      'The User has no active delegated consent for this Agent Identity in this Workspace.',
      redirectUri,
      state,
    );
  }
  return {
    session,
    user: actor.user,
    client,
    agent,
    workspace: { workspace_id: workspace.workspace_id, name: workspace.name },
    delegation,
    scopes,
    redirectUri,
    state,
  };
}

/** Audits one refused authorization request and fails closed with its OAuth error. */
function authorizationFailure(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  error: string,
  message: string,
  redirectUri: string | null,
  state: string | null,
): never {
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: error === 'access_denied' ? 'denied' : 'failed',
    detail: { error_code: error },
  });
  throw new OAuthAuthorizationError(400, error, message, redirectUri, state);
}

/** Builds a redirect to the one already-validated redirect URI. */
function redirectLocation(
  redirectUri: string,
  params: { code?: string; error?: string; state: string | null },
): string {
  const url = new URL(redirectUri);
  if (params.code !== undefined) url.searchParams.set('code', params.code);
  if (params.error !== undefined) url.searchParams.set('error', params.error);
  if (params.state !== null) url.searchParams.set('state', params.state);
  return url.toString();
}

/**
 * The token endpoint. Autonomous agents authenticate their pre-registered
 * client and exchange it for a short-lived token; delegated access exchanges a
 * single-use authorization code with its PKCE verifier, and the resulting token
 * never carries more than the intersection of the Agent Identity and the
 * consenting User.
 */
export function issueAccessToken(options: {
  root: string;
  masterKey: string;
  origin: string;
  form: Record<string, string>;
}): Record<string, unknown> {
  const grantType = options.form['grant_type'];
  if (grantType !== 'client_credentials' && grantType !== 'authorization_code') {
    throw new OAuthError(
      400,
      'unsupported_grant_type',
      'This Deployment issues tokens for the client_credentials and authorization_code grants only.',
    );
  }
  const resource = `${options.origin}/mcp`;
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const { client, agent } = authenticateTokenClient(session, options.form);
  if (options.form['resource'] !== resource) {
    throw new OAuthError(400, 'invalid_target', `The only resource this Deployment issues tokens for is ${resource}.`);
  }
  if (grantType === 'authorization_code') {
    return exchangeAuthorizationCode(session, options, resource, client, agent);
  }
  if (options.form['delegation_id'] !== undefined) {
    throw new OAuthError(
      400,
      'invalid_request',
      'Delegated access uses the authorization_code grant with PKCE; client_credentials never names a delegation.',
    );
  }
  const requested = (options.form['scope'] ?? agent.scopes.join(' ')).split(' ').filter((scope) => scope !== '');
  if (requested.length === 0 || requested.some((scope) => !agent.scopes.includes(scope))) {
    throw new OAuthError(400, 'invalid_scope', `This client may request only: ${agent.scopes.join(' ')}.`);
  }
  const redirectUri = options.form['redirect_uri'];
  if (redirectUri !== undefined && !client.redirect_uris.includes(redirectUri)) {
    throw new OAuthError(400, 'OAUTH_REDIRECT_URI_INVALID', 'The redirect_uri is not one this client registered.');
  }
  return mintAccessToken(
    session,
    options.origin,
    resource,
    client,
    agent,
    [...new Set(requested)],
    redirectUri ?? null,
    null,
    'client_credentials',
  );
}

/** Proves a pre-registered client and the active Agent Identity it acts for. */
function authenticateTokenClient(
  session: PlatformSession,
  form: Record<string, string>,
): { client: OAuthClientRecord; agent: AgentIdentityRecord } {
  const clientId = form['client_id'] ?? '';
  const presentedSecret = form['client_secret'] ?? '';
  const client = findOAuthClient(session.state, clientId);
  if (!client || client.revoked_at !== null || !constantTimeEquals(hashToken(presentedSecret), client.client_secret_hash)) {
    throw new OAuthError(401, 'invalid_client', 'The client is not registered with this Deployment, or its secret is not valid.');
  }
  const agent = findAgentIdentity(session.state, client.agent_identity_id);
  if (!agent || agent.status !== 'active') {
    throw new OAuthError(401, 'invalid_client', 'The Agent Identity this client acts for is not active.');
  }
  return { client, agent };
}

/**
 * Exchanges one single-use authorization code. A replayed, expired, foreign,
 * redirect-mismatched, or verifier-mismatched code is refused, and the
 * delegated consent is revalidated at this instant rather than trusted.
 */
function exchangeAuthorizationCode(
  session: PlatformSession,
  options: { origin: string; form: Record<string, string> },
  resource: string,
  client: OAuthClientRecord,
  agent: AgentIdentityRecord,
): Record<string, unknown> {
  const rawCode = options.form['code'] ?? '';
  const codeHash = hashToken(rawCode);
  const record = rawCode === ''
    ? undefined
    : session.state.oauth_authorization_codes.find((candidate) => constantTimeEquals(candidate.code_hash, codeHash));
  if (record === undefined) {
    throw new OAuthError(400, 'invalid_grant', 'The authorization code was not issued by this Deployment.');
  }
  if (record.consumed_at !== null) {
    throw new OAuthError(400, 'invalid_grant', 'The authorization code has already been used.');
  }
  if (Date.parse(record.expires_at) <= Date.now()) {
    throw new OAuthError(400, 'invalid_grant', 'The authorization code has expired.');
  }
  if (record.client_id !== client.client_id || record.agent_identity_id !== agent.agent_identity_id) {
    throw new OAuthError(400, 'invalid_grant', 'The authorization code was issued to a different client.');
  }
  if (record.redirect_uri !== (options.form['redirect_uri'] ?? '')) {
    throw new OAuthError(400, 'invalid_grant', 'The redirect_uri does not match the authorization request.');
  }
  const verifier = options.form['code_verifier'] ?? '';
  if (!PKCE_VERIFIER.test(verifier)) {
    throw new OAuthError(400, 'invalid_grant', 'A valid PKCE code_verifier is required.');
  }
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  if (!constantTimeEquals(challenge, record.code_challenge)) {
    throw new OAuthError(400, 'invalid_grant', 'The code_verifier does not match the authorization request.');
  }
  const delegated = activeDelegatedAuthority(session.state, record.delegation_id, agent, record.user_id);
  if (delegated === null || delegated.delegation.workspace_id !== record.workspace_id) {
    throw new OAuthError(400, 'invalid_grant', 'The delegated consent this code was issued under is no longer in force.');
  }
  if (record.scopes.length === 0 || record.scopes.some((scope) => !agent.scopes.includes(scope))) {
    throw new OAuthError(400, 'invalid_grant', "The authorization code no longer matches the Agent Identity's scopes.");
  }
  // The code is consumed before the token is minted, so a replay can never
  // produce a second token even if the first response is lost.
  record.consumed_at = new Date().toISOString();
  return mintAccessToken(
    session,
    options.origin,
    resource,
    client,
    agent,
    [...record.scopes],
    record.redirect_uri,
    delegated,
    'authorization_code',
  );
}

/** Stores and returns one access token under the exact authority it proves. */
function mintAccessToken(
  session: PlatformSession,
  origin: string,
  resource: string,
  client: OAuthClientRecord,
  agent: AgentIdentityRecord,
  scopes: string[],
  redirectUri: string | null,
  delegated: DelegatedAuthority | null,
  grantType: 'client_credentials' | 'authorization_code',
): Record<string, unknown> {
  const now = Date.now();
  const record: AccessTokenRecord = {
    token_hash: '',
    issuer: origin,
    audience: resource,
    resource,
    client_id: client.client_id,
    agent_identity_id: agent.agent_identity_id,
    scopes: [...new Set(scopes)],
    redirect_uri: redirectUri,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ACCESS_TOKEN_LIFETIME_MS).toISOString(),
    revoked_at: null,
    delegation_id: delegated?.delegation.delegation_id ?? null,
    delegated_user_id: delegated?.user.user_id ?? null,
  };
  const token = randomBytes(32).toString('base64url');
  record.token_hash = hashToken(token);
  session.state.access_tokens.push(record);
  session.audit({
    actor: `agent:${agent.name}`,
    action: 'oauth_access_token_issuance',
    scope: 'deployment',
    target: client.client_id,
    outcome: 'succeeded',
    detail: {
      grant_type: grantType,
      agent_identity_id: agent.agent_identity_id,
      client_id: client.client_id,
      scope_count: record.scopes.length,
      ...(delegated === null
        ? {}
        : { delegated_user_id: delegated.user.user_id, delegated_username: delegated.user.username }),
    },
  });
  session.save();
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_LIFETIME_MS / 1000),
    scope: record.scopes.join(' '),
    resource,
  };
}

/** The exact delegated consent one token acts under, revalidated on every request. */
export interface DelegatedAuthority {
  delegation: AgentDelegationRecord;
  user: UserRecord;
}

export interface AccessTokenGrant {
  kind: 'granted';
  agent: AgentIdentityRecord;
  client: OAuthClientRecord;
  scopes: string[];
  /** The delegated User's authority this token is intersected with, or nothing. */
  delegation: DelegatedAuthority | null;
}

export interface AccessTokenRejection {
  kind: 'rejected';
  code: string;
  message: string;
}

/**
 * Re-proves every claim a stored token was minted under against this
 * Deployment's own identity. A token that is unknown, expired, revoked, or
 * minted for another issuer, resource, audience, client, or Agent Identity is
 * rejected — never forwarded.
 */
export function resolveAccessToken(
  state: PlatformState,
  token: string,
  origin: string,
  resource: string,
): AccessTokenGrant | AccessTokenRejection {
  const record = state.access_tokens.find((candidate) => candidate.token_hash === hashToken(token));
  if (!record || record.revoked_at !== null) {
    return { kind: 'rejected', code: 'MCP_TOKEN_INVALID', message: 'The bearer token was not issued by this Deployment.' };
  }
  if (Date.parse(record.expires_at) <= Date.now()) {
    return { kind: 'rejected', code: 'MCP_TOKEN_EXPIRED', message: 'The bearer token has expired.' };
  }
  if (record.issuer !== origin) {
    return {
      kind: 'rejected',
      code: 'MCP_TOKEN_ISSUER_MISMATCH',
      message: 'The bearer token was issued by a different Deployment origin.',
    };
  }
  if (record.resource !== resource || record.audience !== resource) {
    return {
      kind: 'rejected',
      code: 'MCP_TOKEN_RESOURCE_MISMATCH',
      message: 'The bearer token was issued for a different resource.',
    };
  }
  const client = findOAuthClient(state, record.client_id);
  if (!client || client.revoked_at !== null) {
    return { kind: 'rejected', code: 'MCP_CLIENT_REVOKED', message: 'The OAuth client that requested this token is revoked.' };
  }
  const agent = findAgentIdentity(state, record.agent_identity_id);
  if (!agent || agent.status !== 'active') {
    return { kind: 'rejected', code: 'MCP_AGENT_REVOKED', message: 'The Agent Identity this token acts for is revoked.' };
  }
  const delegated = record.delegation_id === undefined || record.delegation_id === null
    ? null
    : currentDelegation(state, record, agent);
  if (record.delegation_id !== undefined && record.delegation_id !== null && delegated === null) {
    // Revocation during a conversation or pagination takes effect on the very
    // next call, exactly like an expired token.
    return {
      kind: 'rejected',
      code: 'MCP_DELEGATION_REVOKED',
      message: 'The delegated authority this token acts under is no longer in force.',
    };
  }
  return { kind: 'granted', agent, client, scopes: [...record.scopes], delegation: delegated };
}

/**
 * Re-proves the delegated consent a token was minted under: the exact consent,
 * the Agent Identity, the User's status, and their current Workspace membership.
 * Any change answers null, so the token stops working immediately.
 */
function currentDelegation(
  state: PlatformState,
  record: AccessTokenRecord,
  agent: AgentIdentityRecord,
): DelegatedAuthority | null {
  if (record.delegation_id === undefined || record.delegation_id === null) return null;
  if (record.delegated_user_id === undefined || record.delegated_user_id === null) return null;
  return activeDelegatedAuthority(state, record.delegation_id, agent, record.delegated_user_id);
}

/**
 * The one exact consent in force right now for one Agent Identity and one User,
 * revalidated against the User's status and current Workspace membership.
 */
function activeDelegatedAuthority(
  state: PlatformState,
  delegationId: string,
  agent: AgentIdentityRecord,
  userId: string,
): DelegatedAuthority | null {
  const delegation = state.agent_delegations.find(
    (candidate) => candidate.delegation_id === delegationId,
  );
  const user = delegation === undefined ? undefined : findUserById(state, delegation.user_id);
  if (!delegation
    || delegation.revoked_at !== null
    || delegation.agent_identity_id !== agent.agent_identity_id
    || delegation.user_id !== userId
    || !user
    || user.status !== 'active'
    || workspaceRoleOf(state, user.user_id, delegation.workspace_id) === null) {
    return null;
  }
  return { delegation, user };
}
