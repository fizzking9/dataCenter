import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
  type Actor,
} from './authz.js';
import { findSource, type SourceRecord, type SourceType } from './catalog.js';
import { workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const SOURCE_TYPES: SourceType[] = ['file'];
const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;

export function isSourceType(value: string): value is SourceType {
  return SOURCE_TYPES.includes(value as SourceType);
}

/**
 * Resolves a Source the actor administers. A Source in a Workspace the actor
 * cannot administer answers exactly like one that does not exist, so the
 * identifier never discloses another Workspace's content.
 */
export function requireAdministeredSource(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  sourceId: string,
): SourceRecord {
  const source = findSource(session.state.sources, sourceId);
  const scoped: ActionContext = source === undefined
    ? context
    : { ...context, workspace_id: source.workspace_id, target: source.source_id };
  if (!source || workspaceRoleOf(session.state, actor.user.user_id, source.workspace_id) !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), scoped, 'SOURCE_NOT_AVAILABLE', 'The Source is not available to this actor.');
  }
  return source;
}

/** Registers a Workspace-owned Source that later acquisitions read from. */
export function createSource(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  type: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'source_creation',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  if (!isSourceType(options.type)) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'SOURCE_TYPE_UNSUPPORTED',
      `The Source type must be one of: ${SOURCE_TYPES.join(', ')}.`,
    );
  }
  const name = options.name.trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actorLabel(actor.user), context, 'SOURCE_NAME_INVALID', 'A Source name must contain 2 to 128 characters.');
  }
  if (session.state.sources.some(
    (source) => source.workspace_id === options.workspaceId && source.name.toLowerCase() === name.toLowerCase(),
  )) {
    reject(session, actorLabel(actor.user), context, 'SOURCE_NAME_TAKEN', 'A Source with this name already exists in this Workspace.');
  }
  const source: SourceRecord = {
    source_id: randomUUID(),
    workspace_id: options.workspaceId,
    name,
    type: options.type,
    owner_user_id: actor.user.user_id,
    created_at: new Date().toISOString(),
  };
  session.state.sources.push(source);
  session.audit({
    ...context,
    target: source.source_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { source_type: source.type },
  });
  session.save();
  return {
    source_id: source.source_id,
    workspace_id: source.workspace_id,
    name: source.name,
    type: source.type,
    owner: actorLabel(actor.user),
    created_at: source.created_at,
  };
}
