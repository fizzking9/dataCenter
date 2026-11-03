import { readAuditCheckpoint, readAuditEvents, verifyAuditChain, verifyAuditCheckpoint, type AuditEvent } from './audit.js';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  type ActionContext,
} from './authz.js';
import { isDeploymentAdministrator } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

function administeredWorkspaces(session: PlatformSession, userId: string): Set<string> {
  return new Set(
    session.state.memberships
      .filter((membership) => membership.user_id === userId && membership.role === 'Workspace Administrator')
      .map((membership) => membership.workspace_id),
  );
}

/**
 * Reads deployment-wide audit metadata for Deployment Administrators and only
 * the administered Workspaces' events for Workspace Administrators. A denied
 * read is itself recorded, like every other protected operation.
 */
export function listAuditEvents(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'audit_read',
    scope: 'deployment',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  const events = readAuditEvents(session.root);

  let visible: AuditEvent[];
  if (isDeploymentAdministrator(actor.user)) {
    visible = events.filter((event) => options.workspaceId === undefined || event.workspace_id === options.workspaceId);
  } else {
    const administered = administeredWorkspaces(session, actor.user.user_id);
    if (administered.size === 0 || (options.workspaceId !== undefined && !administered.has(options.workspaceId))) {
      deny(session, actorLabel(actor.user), context, 'AUTHORIZATION_DENIED', 'Reading Audit Events requires authority over the requested scope.');
    }
    visible = events.filter(
      (event) => event.workspace_id !== undefined
        && administered.has(event.workspace_id)
        && (options.workspaceId === undefined || event.workspace_id === options.workspaceId),
    );
  }

  const integrity = verifyAuditChain(events)
    && verifyAuditCheckpoint(events, readAuditCheckpoint(session.root), session.dataKey);
  if (!integrity) {
    return { chain_valid: false, events: visible };
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { events_returned: visible.length } });
  return { chain_valid: true, events: visible };
}
