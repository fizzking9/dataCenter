import { readAuditCheckpoint, readAuditEvents, verifyAuditChain, verifyAuditCheckpoint, type AuditEvent } from './audit.js';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import { isDeploymentAdministrator } from './platform.js';
import { auditRetainedAfter } from './retention.js';
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
  /** Reads the log as of one instant, so the audit retention window is inspectable. */
  at?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'audit_read',
    scope: 'deployment',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
  };
  const actor = resolveActor(session, options.token, context);
  const events = readAuditEvents(session.root);
  const now = options.at === undefined ? new Date() : new Date(options.at);
  if (!Number.isFinite(now.getTime())) {
    deny(session, actorLabel(actor.user), context, 'AUDIT_READ_INVALID', 'The audit read instant must be an ISO 8601 instant.');
  }
  // Audit Events age out of the readable window under the audit retention
  // clock while the append-only chain itself stays intact and verifiable.
  const retainedAfter = auditRetainedAfter(session.state, now);

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
  if (retainedAfter !== null) {
    visible = visible.filter((event) => Date.parse(event.occurred_at) >= retainedAfter);
  }

  const integrity = verifyAuditChain(events)
    && verifyAuditCheckpoint(events, readAuditCheckpoint(session.root), session.dataKey);
  if (!integrity) {
    return { chain_valid: false, events: visible };
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { events_returned: visible.length } });
  return { chain_valid: true, events: visible };
}

/**
 * Deployment acts that name a Workspace without being the Workspace's own
 * events. Creating a Workspace is the Deployment's decision, so it belongs to
 * the deployment-scope audit view rather than this one.
 */
const DEPLOYMENT_ACTS: ReadonlySet<string> = new Set(['workspace_creation']);

/** One page of the Workspace's newest events; the log itself stays unbounded. */
const WORKSPACE_AUDIT_LIMIT = 200;

/**
 * Reads one administered Workspace's Audit Events, newest first, projected to
 * attribution only: who acted, on what, in which scope, with which outcome.
 * Another Workspace's events, deployment-scope acts, and the stored detail
 * payloads are absent rather than redacted, so no unauthorized configuration
 * and no secret can reach this view.
 */
export function showWorkspaceAudit(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'audit_read',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const events = readAuditEvents(session.root);
  const retainedAfter = auditRetainedAfter(session.state, new Date());
  const visible = events
    .filter(
      (event) => event.scope === 'workspace'
        && event.workspace_id === options.workspaceId
        && !DEPLOYMENT_ACTS.has(event.action)
        && (retainedAfter === null || Date.parse(event.occurred_at) >= retainedAfter),
    )
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, WORKSPACE_AUDIT_LIMIT)
    .map((event) => ({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      actor: event.actor,
      action: event.action,
      scope: event.scope,
      target: event.target ?? null,
      outcome: event.outcome,
    }));

  const integrity = verifyAuditChain(events)
    && verifyAuditCheckpoint(events, readAuditCheckpoint(session.root), session.dataKey);
  if (!integrity) {
    return { workspace_id: options.workspaceId, chain_valid: false, events: visible };
  }
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { events_returned: visible.length } });
  return { workspace_id: options.workspaceId, chain_valid: true, events: visible };
}
