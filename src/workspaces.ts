import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireDeploymentAdministrator,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import { enrolMfa } from './enrollment.js';
import {
  isDeploymentAdministrator,
  isWorkspaceRole,
  otherActiveWorkspaceAdministrators,
  workspaceRoleOf,
  type WorkspaceRole,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireActiveUser } from './users.js';

const WORKSPACE_ROLES: WorkspaceRole[] = ['Workspace Administrator', 'Consumer'];

/** Lists only the Workspace metadata the actor is entitled to see. */
export function listWorkspaces(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'workspace_listing', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  const visible = session.state.workspaces.map((workspace) => ({
    workspace,
    role: isDeploymentAdministrator(actor.user)
      ? 'Deployment Administrator'
      : workspaceRoleOf(session.state, actor.user.user_id, workspace.workspace_id),
  })).filter((entry) => entry.role !== null);

  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return {
    workspaces: visible.map(({ workspace, role }) => ({
      workspace_id: workspace.workspace_id,
      name: workspace.name,
      created_at: workspace.created_at,
      role,
    })),
  };
}

/** Creates a Workspace together with its first accountable Workspace Administrator. */
export function createWorkspace(options: {
  root: string;
  masterKey: string;
  token: string;
  name: string;
  administrator: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'workspace_creation', scope: 'workspace', target: options.name };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const name = options.name.trim();
  if (name.length < 2 || name.length > 128) {
    reject(session, actorLabel(actor.user), context, 'WORKSPACE_NAME_INVALID', 'A Workspace name must contain 2 to 128 characters.');
  }
  if (session.state.workspaces.some((workspace) => workspace.name.toLowerCase() === name.toLowerCase())) {
    reject(session, actorLabel(actor.user), context, 'WORKSPACE_NAME_TAKEN', 'A Workspace with this name already exists.');
  }
  const administrator = requireActiveUser(session, actorLabel(actor.user), context, options.administrator);
  const workspace = {
    workspace_id: randomUUID(),
    name,
    created_at: new Date().toISOString(),
  };
  session.state.workspaces.push(workspace);
  session.state.memberships.push({
    workspace_id: workspace.workspace_id,
    user_id: administrator.user_id,
    role: 'Workspace Administrator',
    granted_at: workspace.created_at,
  });
  const enrollment = administrator.mfa === null ? enrolMfa(administrator.username, session.dataKey) : undefined;
  if (enrollment) administrator.mfa = enrollment.mfa;
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    workspace_id: workspace.workspace_id,
  });
  session.save();
  return {
    workspace_id: workspace.workspace_id,
    name: workspace.name,
    created_at: workspace.created_at,
    administrator: administrator.username,
    administrator_role: 'Workspace Administrator',
    ...(enrollment?.secrets ?? {}),
  };
}

export function grantMembership(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  username: string;
  role: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'membership_grant',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.username,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  if (!isWorkspaceRole(options.role)) {
    reject(session, actorLabel(actor.user), context, 'ROLE_INVALID', `The Workspace role must be one of: ${WORKSPACE_ROLES.join(', ')}.`);
  }
  const member = requireActiveUser(session, actorLabel(actor.user), context, options.username);
  const previous = workspaceRoleOf(session.state, member.user_id, options.workspaceId);
  if (previous === 'Workspace Administrator' && options.role === 'Consumer' && isSoleAdministrator(session, options.workspaceId, member.user_id)) {
    deny(
      session,
      actorLabel(actor.user),
      context,
      'LAST_ADMINISTRATOR_PROTECTED',
      'The only active Workspace Administrator of a Workspace cannot change role.',
    );
  }
  const existing = session.state.memberships.find(
    (membership) => membership.workspace_id === options.workspaceId && membership.user_id === member.user_id,
  );
  if (existing) {
    existing.role = options.role;
  } else {
    session.state.memberships.push({
      workspace_id: options.workspaceId,
      user_id: member.user_id,
      role: options.role,
      granted_at: new Date().toISOString(),
    });
  }
  const enrollment = options.role === 'Workspace Administrator' && member.mfa === null
    ? enrolMfa(member.username, session.dataKey)
    : undefined;
  if (enrollment) member.mfa = enrollment.mfa;
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { role: options.role } });
  session.save();
  return {
    workspace_id: options.workspaceId,
    username: member.username,
    role: options.role,
    previous_role: previous,
    ...(enrollment?.secrets ?? {}),
  };
}

export function revokeMembership(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  username: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'membership_revocation',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.username,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const member = requireActiveUser(session, actorLabel(actor.user), context, options.username);
  const membership = session.state.memberships.find(
    (candidate) => candidate.workspace_id === options.workspaceId && candidate.user_id === member.user_id,
  );
  if (!membership) {
    reject(session, actorLabel(actor.user), context, 'MEMBERSHIP_NOT_FOUND', 'The named User is not a member of this Workspace.');
  }
  if (membership.role === 'Workspace Administrator' && isSoleAdministrator(session, options.workspaceId, member.user_id)) {
    deny(
      session,
      actorLabel(actor.user),
      context,
      'LAST_ADMINISTRATOR_PROTECTED',
      'The only active Workspace Administrator of a Workspace cannot be removed.',
    );
  }
  session.state.memberships = session.state.memberships.filter((candidate) => candidate !== membership);
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  session.save();
  return { workspace_id: options.workspaceId, username: member.username, removed: true };
}

function isSoleAdministrator(session: PlatformSession, workspaceId: string, userId: string): boolean {
  return otherActiveWorkspaceAdministrators(session.state, workspaceId, userId).length === 0;
}
