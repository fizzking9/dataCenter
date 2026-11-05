import { randomBytes, randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, requireDeploymentAdministrator, type ActionContext } from './authz.js';
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
  type OAuthClientRecord,
  type PlatformState,
  type UserRecord,
} from './platform.js';
import { openPlatform } from './session.js';
import { constantTimeEquals, hashToken } from './tokens.js';

/** The scopes an Agent Identity may hold; each one opens a tool surface and nothing else. */
// mcp:nlq is reserved for ticket #47 (Natural-Language Query and Reports over MCP).
export const MCP_SCOPES = ['mcp:read', 'mcp:nlq'];

const ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const MAX_REDIRECT_URIS = 8;
const MAX_SCOPES = MCP_SCOPES.length;

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
  metadataPath: string;
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
  const metadata = readJsonDocument(
    options.metadataPath,
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
 * Mints one access token for a pre-registered client. The token names this
 * Deployment as its issuer and its MCP endpoint as its resource and audience,
 * and carries exactly the scopes the Agent Identity already holds.
 */
export function issueAccessToken(options: {
  root: string;
  masterKey: string;
  origin: string;
  form: Record<string, string>;
}): Record<string, unknown> {
  const resource = `${options.origin}/mcp`;
  const grantType = options.form['grant_type'];
  if (grantType !== 'client_credentials') {
    throw new OAuthError(400, 'unsupported_grant_type', 'This Deployment issues tokens for the client_credentials grant only.');
  }
  const clientId = options.form['client_id'] ?? '';
  const presentedSecret = options.form['client_secret'] ?? '';
  const session = openPlatform(options.root, options.masterKey);
  const client = findOAuthClient(session.state, clientId);
  if (!client || client.revoked_at !== null || !constantTimeEquals(hashToken(presentedSecret), client.client_secret_hash)) {
    throw new OAuthError(401, 'invalid_client', 'The client is not registered with this Deployment, or its secret is not valid.');
  }
  const agent = findAgentIdentity(session.state, client.agent_identity_id);
  if (!agent || agent.status !== 'active') {
    throw new OAuthError(401, 'invalid_client', 'The Agent Identity this client acts for is not active.');
  }
  if (options.form['resource'] !== resource) {
    throw new OAuthError(400, 'invalid_target', `The only resource this Deployment issues tokens for is ${resource}.`);
  }
  const requested = (options.form['scope'] ?? agent.scopes.join(' ')).split(' ').filter((scope) => scope !== '');
  if (requested.length === 0 || requested.some((scope) => !agent.scopes.includes(scope))) {
    throw new OAuthError(400, 'invalid_scope', `This client may request only: ${agent.scopes.join(' ')}.`);
  }
  const redirectUri = options.form['redirect_uri'];
  if (redirectUri !== undefined && !client.redirect_uris.includes(redirectUri)) {
    throw new OAuthError(400, 'OAUTH_REDIRECT_URI_INVALID', 'The redirect_uri is not one this client registered.');
  }
  const delegation = readDelegation(session.state, options.form['delegation_id'], agent.agent_identity_id);
  const now = Date.now();
  const record: AccessTokenRecord = {
    token_hash: '',
    issuer: options.origin,
    audience: resource,
    resource,
    client_id: client.client_id,
    agent_identity_id: agent.agent_identity_id,
    scopes: [...new Set(requested)],
    redirect_uri: redirectUri ?? null,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ACCESS_TOKEN_LIFETIME_MS).toISOString(),
    revoked_at: null,
    delegation_id: delegation?.delegation_id ?? null,
    delegated_user_id: delegation?.user_id ?? null,
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
      agent_identity_id: agent.agent_identity_id,
      client_id: client.client_id,
      scope_count: record.scopes.length,
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
  const delegation = state.agent_delegations.find(
    (candidate) => candidate.delegation_id === record.delegation_id,
  );
  const user = delegation === undefined ? undefined : findUserById(state, delegation.user_id);
  if (!delegation
    || delegation.revoked_at !== null
    || delegation.agent_identity_id !== agent.agent_identity_id
    || delegation.user_id !== record.delegated_user_id
    || !user
    || user.status !== 'active'
    || workspaceRoleOf(state, user.user_id, delegation.workspace_id) === null) {
    return null;
  }
  return { delegation, user };
}

/** Reads the consent a token request names, refusing one that is not in force. */
function readDelegation(
  state: PlatformState,
  raw: string | undefined,
  agentIdentityId: string,
): AgentDelegationRecord | null {
  if (raw === undefined || raw === '') return null;
  const delegation = state.agent_delegations.find((candidate) => candidate.delegation_id === raw);
  const user = delegation === undefined ? undefined : findUserById(state, delegation.user_id);
  if (!delegation
    || delegation.revoked_at !== null
    || delegation.agent_identity_id !== agentIdentityId
    || !user
    || user.status !== 'active'
    || workspaceRoleOf(state, user.user_id, delegation.workspace_id) === null) {
    throw new OAuthError(
      400,
      'invalid_delegation',
      'The delegation_id is not an active consent this Agent Identity acts under.',
    );
  }
  return delegation;
}
