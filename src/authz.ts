import type { AuditInput } from './audit.js';
import { OperatorError } from './errors.js';
import {
  findWorkspace,
  isDeploymentAdministrator,
  workspaceRoleOf,
  type SessionRecord,
  type UserRecord,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './platform.js';
import type { PlatformSession } from './session.js';

export interface Actor {
  user: UserRecord;
  session: SessionRecord;
}

/** The audit fields every governed operation states up front. */
export type ActionContext = Omit<AuditInput, 'actor' | 'outcome' | 'correlation_id'>;

export function actorLabel(user: UserRecord): string {
  return user.username;
}

/** Records the denied attempt and fails closed with the same code either way. */
export function deny(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  code: string,
  message: string,
  nextStep?: string,
): never {
  session.audit({ ...context, actor, outcome: 'denied', detail: { error_code: code } });
  throw new OperatorError(code, message, nextStep);
}

/** Records a validation failure that is not an authorization decision. */
export function reject(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  code: string,
  message: string,
  nextStep?: string,
): never {
  session.audit({ ...context, actor, outcome: 'failed', detail: { error_code: code } });
  throw new OperatorError(code, message, nextStep);
}

export function requireDeploymentAdministrator(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
): void {
  if (!isDeploymentAdministrator(actor.user)) {
    deny(session, actorLabel(actor.user), context, 'AUTHORIZATION_DENIED', 'The actor is not authorized for this deployment-scope operation.');
  }
}

/** Deployment Administrator, or Workspace Administrator of at least one Workspace. */
export function requireAdministrator(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
): void {
  const administersWorkspace = session.state.memberships.some(
    (membership) => membership.user_id === actor.user.user_id && membership.role === 'Workspace Administrator',
  );
  if (!isDeploymentAdministrator(actor.user) && !administersWorkspace) {
    deny(session, actorLabel(actor.user), context, 'AUTHORIZATION_DENIED', 'The actor does not hold an administrator Role.');
  }
}

/**
 * Resolves a Workspace the actor belongs to. A missing Workspace and one the
 * actor cannot see answer identically, so existence never leaks.
 */
export function requireWorkspaceAdministrator(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  workspaceId: string,
): WorkspaceRecord {
  const workspace = findWorkspace(session.state, workspaceId);
  const role: WorkspaceRole | null = workspaceRoleOf(session.state, actor.user.user_id, workspaceId);
  if (!workspace || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  return workspace;
}
