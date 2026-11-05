import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireDeploymentAdministrator, type ActionContext } from './authz.js';
import type { Fail } from './errors.js';
import {
  findServiceIdentity,
  findUserById,
  findWorkspace,
  type PlatformState,
  type ServiceIdentityRecord,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

/** What a Service Identity may do, stated once so no surface has to infer it. */
const EXECUTION_CAPABILITIES = {
  executes_jobs: true,
  // A Service Identity is not an Agent Identity: it holds no Data Product Grant,
  // no MCP scope, and no OAuth client, so it can never consume governed data.
  consumes_data_products: false,
  owns_artifacts: false,
} as const;

function workspaceBindings(state: PlatformState, workspaceIds: string[]): Array<{ workspace_id: string; name: string }> {
  return workspaceIds.flatMap((workspaceId) => {
    const workspace = findWorkspace(state, workspaceId);
    return workspace === undefined ? [] : [{ workspace_id: workspace.workspace_id, name: workspace.name }];
  });
}

function project(session: PlatformSession, identity: ServiceIdentityRecord): Record<string, unknown> {
  return {
    service_identity_id: identity.service_identity_id,
    name: identity.name,
    workspace_ids: [...identity.workspace_ids],
    workspaces: workspaceBindings(session.state, identity.workspace_ids),
    status: identity.status,
    created_at: identity.created_at,
    created_by: findUserById(session.state, identity.created_by)?.username ?? null,
    revoked_at: identity.revoked_at,
    capabilities: { ...EXECUTION_CAPABILITIES },
  };
}

/**
 * Creates one Service Identity bound to at least one existing Workspace. It is
 * an internal executor only: the record carries no credential, no scope, and no
 * Owner, so a bounded identity can never widen into consumption.
 */
export function createServiceIdentity(options: {
  root: string;
  masterKey: string;
  token: string;
  name: string;
  workspaceIds: string[];
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'service_identity_creation', scope: 'deployment', target: options.name };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);

  const name = options.name.trim();
  if (name.length < 2 || name.length > 128) {
    fail('SERVICE_IDENTITY_NAME_INVALID', 'A Service Identity name must contain 2 to 128 characters.');
  }
  if (session.state.service_identities.some((identity) => identity.name.toLowerCase() === name.toLowerCase())) {
    fail('SERVICE_IDENTITY_EXISTS', 'A Service Identity with this name already exists.');
  }
  // An Agent Identity is a different principal with different authority, so the
  // two can never share a name that audit attribution would have to disambiguate.
  if (session.state.agent_identities.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
    fail(
      'SERVICE_IDENTITY_NAME_CONFLICT',
      'A Service Identity cannot take the name of an Agent Identity.',
      'Name the Service Identity after the internal job it executes.',
    );
  }
  const workspaceIds = [...new Set(options.workspaceIds)];
  if (workspaceIds.length === 0) {
    fail('SERVICE_IDENTITY_WORKSPACE_INVALID', 'A Service Identity executes in at least one Workspace.');
  }
  for (const workspaceId of workspaceIds) {
    if (!findWorkspace(session.state, workspaceId)) {
      fail('SERVICE_IDENTITY_WORKSPACE_INVALID', `${workspaceId} is not a Workspace of this Deployment.`);
    }
  }

  const identity: ServiceIdentityRecord = {
    service_identity_id: randomUUID(),
    name,
    workspace_ids: workspaceIds,
    status: 'active',
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    revoked_at: null,
  };
  session.state.service_identities.push(identity);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { service_identity_id: identity.service_identity_id, workspace_count: workspaceIds.length },
  });
  session.save();
  return project(session, identity);
}

/** Lists every Service Identity with the Workspaces it is bound to. */
export function listServiceIdentities(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'service_identity_listing', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const identities = [...session.state.service_identities]
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.name.localeCompare(right.name))
    .map((identity) => project(session, identity));
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { identities_returned: identities.length },
  });
  return { service_identities: identities };
}

/** Withdraws one Service Identity, so it executes nothing from now on. */
export function revokeServiceIdentity(options: {
  root: string;
  masterKey: string;
  token: string;
  serviceIdentityId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'service_identity_revocation',
    scope: 'deployment',
    target: options.serviceIdentityId,
  };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const identity = findServiceIdentity(session.state, options.serviceIdentityId);
  if (!identity) {
    reject(session, actorLabel(actor.user), context, 'SERVICE_IDENTITY_NOT_FOUND', 'The named Service Identity does not exist in this Deployment.');
  }
  if (identity.status === 'revoked') {
    return { ...project(session, identity), already_revoked: true };
  }
  identity.status = 'revoked';
  identity.revoked_at = new Date().toISOString();
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { name: identity.name, workspace_count: identity.workspace_ids.length },
  });
  session.save();
  return project(session, identity);
}
