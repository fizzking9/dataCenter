import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireAdministrator,
  requireDeploymentAdministrator,
  type ActionContext,
} from './authz.js';
import { enrolAdministrator } from './enrollment.js';
import { hashPassword } from './password.js';
import {
  findUser,
  isUsernameValid,
  otherActiveWorkspaceAdministrators,
  workspaceRoleOf,
  type UserRecord,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const MINIMUM_PASSWORD_LENGTH = 12;

function requireUsername(session: PlatformSession, actor: string, context: ActionContext, username: string): string {
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 254 || !isUsernameValid(trimmed)) {
    reject(session, actor, context, 'USERNAME_INVALID', 'A User name must be an account identifier of the form name@domain.');
  }
  return trimmed;
}

export function requireActiveUser(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  username: string,
): UserRecord {
  const user = findUser(session.state, username);
  if (!user) {
    reject(session, actor, context, 'USER_NOT_FOUND', 'The named User does not exist in this Deployment.');
  }
  if (user.status !== 'active') {
    reject(session, actor, context, 'USER_DEACTIVATED', 'The named User is deactivated.');
  }
  return user;
}

/** Deployment Administrators provision every local identity explicitly. */
export async function createUser(options: {
  root: string;
  masterKey: string;
  token: string;
  username: string;
  password: string;
  deploymentAdministrator: boolean;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'user_creation', scope: 'deployment', target: options.username };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);

  const username = requireUsername(session, actorLabel(actor.user), context, options.username);
  if (findUser(session.state, username)) {
    reject(session, actorLabel(actor.user), context, 'USER_ALREADY_EXISTS', 'A User with this name already exists.');
  }
  if (options.password.length < MINIMUM_PASSWORD_LENGTH) {
    reject(session, actorLabel(actor.user), context, 'PASSWORD_INVALID', `A password must contain at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }

  const enrollment = options.deploymentAdministrator ? enrolAdministrator(username, session.dataKey) : undefined;
  const user: UserRecord = {
    user_id: randomUUID(),
    username,
    password_hash: await hashPassword(options.password),
    status: 'active',
    deployment_role: options.deploymentAdministrator ? 'Deployment Administrator' : null,
    mfa: enrollment?.mfa ?? null,
    failure_count: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  };
  session.state.users.push(user);
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', target: username });
  session.save();
  return {
    user_id: user.user_id,
    username: user.username,
    deployment_role: user.deployment_role,
    status: user.status,
    mfa_enrolled: user.mfa !== null,
    ...(enrollment?.secrets ?? {}),
  };
}

export function listUsers(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'user_listing', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return {
    users: session.state.users.map((user) => ({
      user_id: user.user_id,
      username: user.username,
      status: user.status,
      deployment_role: user.deployment_role,
      mfa_enrolled: user.mfa !== null,
      workspace_roles: session.state.memberships
        .filter((membership) => membership.user_id === user.user_id)
        .map((membership) => ({ workspace_id: membership.workspace_id, role: membership.role })),
    })),
  };
}

/**
 * Deactivation is refused while the User is the last active administrator of
 * the Deployment or of any Workspace, and while the User still owns Artifacts.
 */
export function deactivateUser(options: {
  root: string;
  masterKey: string;
  token: string;
  username: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'user_deactivation', scope: 'deployment', target: options.username };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const target = requireActiveUser(session, actorLabel(actor.user), context, options.username);

  const activeDeploymentAdministrators = session.state.users.filter(
    (user) => user.status === 'active' && user.deployment_role === 'Deployment Administrator',
  );
  if (target.deployment_role === 'Deployment Administrator' && activeDeploymentAdministrators.length === 1) {
    deny(session, actorLabel(actor.user), context, 'LAST_ADMINISTRATOR_PROTECTED', 'The only active Deployment Administrator cannot be deactivated.');
  }

  for (const workspace of session.state.workspaces) {
    const isAdministrator = workspaceRoleOf(session.state, target.user_id, workspace.workspace_id) === 'Workspace Administrator';
    if (isAdministrator && otherActiveWorkspaceAdministrators(session.state, workspace.workspace_id, target.user_id).length === 0) {
      deny(
        session,
        actorLabel(actor.user),
        { ...context, workspace_id: workspace.workspace_id },
        'LAST_ADMINISTRATOR_PROTECTED',
        'The only active Workspace Administrator of a Workspace cannot be deactivated.',
      );
    }
  }

  if (session.state.context_artifacts.some((artifact) => artifact.owner_user_id === target.user_id)) {
    deny(
      session,
      actorLabel(actor.user),
      context,
      'OWNER_TRANSFER_REQUIRED',
      'The User still owns Artifacts; transfer ownership before deactivation.',
    );
  }

  target.status = 'deactivated';
  for (const record of session.state.sessions) {
    if (record.user_id === target.user_id && record.revoked_at === null) {
      record.revoked_at = new Date().toISOString();
    }
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', target: target.username });
  session.save();
  return { user_id: target.user_id, username: target.username, status: target.status };
}

function canAdministerScope(session: PlatformSession, user: UserRecord, scope: string, workspaceId: string | null): boolean {
  if (scope === 'deployment') return user.deployment_role === 'Deployment Administrator';
  return workspaceId !== null && workspaceRoleOf(session.state, user.user_id, workspaceId) === 'Workspace Administrator';
}

/**
 * Moves accountability for every Artifact a User owns to another User who is
 * eligible in that same scope, so no Artifact is ever left unowned.
 */
export function transferOwnership(options: {
  root: string;
  masterKey: string;
  token: string;
  from: string;
  to: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'ownership_transfer', scope: 'deployment', target: options.from };
  const actor = resolveActor(session, options.token, context);
  requireAdministrator(session, actor, context);
  const owner = requireActiveUser(session, actorLabel(actor.user), context, options.from);
  const recipient = requireActiveUser(session, actorLabel(actor.user), context, options.to);
  if (owner.user_id === recipient.user_id) {
    reject(session, actorLabel(actor.user), context, 'OWNERSHIP_TARGET_INVALID', 'Ownership must move to a different User.');
  }

  const owned = session.state.context_artifacts.filter((artifact) => artifact.owner_user_id === owner.user_id);
  for (const artifact of owned) {
    if (!canAdministerScope(session, actor.user, artifact.scope, artifact.workspace_id)) {
      deny(
        session,
        actorLabel(actor.user),
        {
          action: 'ownership_transfer',
          scope: artifact.scope,
          ...(artifact.workspace_id === null ? {} : { workspace_id: artifact.workspace_id }),
          target: artifact.artifact_id,
        },
        'AUTHORIZATION_DENIED',
        'Ownership transfer requires authority over every Artifact being transferred.',
      );
    }
    if (!canAdministerScope(session, recipient, artifact.scope, artifact.workspace_id)) {
      deny(
        session,
        actorLabel(actor.user),
        {
          action: 'ownership_transfer',
          scope: artifact.scope,
          ...(artifact.workspace_id === null ? {} : { workspace_id: artifact.workspace_id }),
          target: artifact.artifact_id,
        },
        'OWNER_NOT_ELIGIBLE',
        'The recipient cannot own this Artifact scope.',
      );
    }
  }
  for (const artifact of owned) {
    artifact.owner_user_id = recipient.user_id;
    session.audit({
      action: 'ownership_transfer',
      scope: artifact.scope,
      ...(artifact.workspace_id === null ? {} : { workspace_id: artifact.workspace_id }),
      target: artifact.artifact_id,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: { previous_owner: owner.username, owner: recipient.username },
    });
  }
  session.save();
  return {
    from: owner.username,
    owner: recipient.username,
    transferred: owned.length,
    artifact_ids: owned.map((artifact) => artifact.artifact_id),
  };
}

