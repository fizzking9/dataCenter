import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import {
  type AcquisitionConnectionArtifact,
  type AcquisitionConnectionVersion,
  type ConnectionPagination,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import { encryptSecret } from './keys.js';
import { workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;

function readName(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actor, context, 'CONNECTION_NAME_INVALID', 'A Connection name must contain 2 to 128 characters.');
  }
  return name;
}

function readBaseUrl(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string {
  if (typeof raw !== 'string') {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'A Connection must state the endpoint base URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The Connection base URL must be an absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The Connection base URL must use http or https.');
  }
  // The declared endpoint is the one address this Version may read, so a later
  // redirect or a different host never receives the stored credential.
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}`;
}

function readPagination(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): ConnectionPagination {
  if (!isRecord(raw)) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'A Connection must declare how it paginates.');
  }
  const parameter = raw['parameter'];
  const sizeParameter = raw['size_parameter'] ?? null;
  const start = raw['start'] ?? 1;
  const size = raw['size'];
  const maxPages = raw['max_pages'];
  if (typeof parameter !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/u.test(parameter)) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The pagination parameter must be a lowercase identifier.');
  }
  if (sizeParameter !== null && (typeof sizeParameter !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/u.test(sizeParameter))) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The pagination size parameter must be a lowercase identifier.');
  }
  if (!Number.isInteger(start) || (start as number) < 0) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The first page must be a whole number of at least 0.');
  }
  if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > 1000) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The page size must be a whole number from 1 to 1000.');
  }
  if (!Number.isInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > 1000) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'The page ceiling must be a whole number from 1 to 1000.');
  }
  return {
    parameter,
    size_parameter: sizeParameter as string | null,
    start: start as number,
    size: size as number,
    max_pages: maxPages as number,
  };
}

function readSchedule(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): { every_minutes: number } | null {
  if (raw === undefined || raw === null) return null;
  const every = isRecord(raw) ? raw['every_minutes'] : undefined;
  if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 10_080) {
    reject(session, actor, context, 'CONNECTION_CONFIGURATION_INVALID', 'A schedule interval must be a whole number of minutes from 1 to 10080.');
  }
  return { every_minutes: every as number };
}

/**
 * Publishes one Acquisition Connection Version, sealing the credential that
 * Version authenticates with.
 *
 * The sealed secret and the reference that names it belong to the Version, so
 * republishing to rotate a credential never rewrites what a Source already
 * pinned; the reference is a fingerprint of the credential, so a rotated token
 * is a different Version with a different content hash.
 */
export function publishConnection(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  configPath: string;
  credential?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'acquisition_connection_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const actorName = actorLabel(actor.user);
  const name = readName(session, actorName, context, options.name);

  const config = readJsonDocument(
    options.configPath,
    (code, message) => reject(session, actorName, context, code, message),
    'CONNECTION_CONFIGURATION_UNREADABLE',
    'The Connection configuration file must contain valid JSON.',
  );
  if (!isRecord(config)) {
    reject(session, actorName, context, 'CONNECTION_CONFIGURATION_INVALID', 'A Connection configuration must be a JSON object.');
  }
  const baseUrl = readBaseUrl(session, actorName, context, config['base_url']);
  const pagination = readPagination(session, actorName, context, config['pagination']);
  const schedule = readSchedule(session, actorName, context, config['schedule']);

  const auth = config['auth'] ?? { scheme: 'bearer' };
  if (!isRecord(auth) || auth['scheme'] !== 'bearer') {
    reject(session, actorName, context, 'CONNECTION_AUTH_UNSUPPORTED', 'The only authentication scheme this release supports is bearer.');
  }
  if (options.credential === undefined || options.credential.length === 0) {
    reject(
      session,
      actorName,
      context,
      'CONNECTION_CREDENTIAL_REQUIRED',
      'Bearer authentication requires a credential supplied on standard input.',
      'Publish the Connection with --credential-stdin.',
    );
  }

  let connection = session.state.acquisition_connections.find(
    (candidate) => candidate.workspace_id === options.workspaceId && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!connection) {
    const connectionId = randomUUID();
    connection = {
      connection_id: connectionId,
      workspace_id: options.workspaceId,
      name,
      owner_user_id: actor.user.user_id,
      created_at: new Date().toISOString(),
      adopted_version: null,
      versions: [],
    } satisfies AcquisitionConnectionArtifact;
    session.state.acquisition_connections.push(connection);
  }

  const sealed = encryptSecret(session.dataKey, options.credential);
  const credentialRef = `bearer:${canonicalDigest(options.credential).slice(0, 16)}`;
  const content = {
    version: (connection.versions[connection.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    base_url: baseUrl,
    credential_ref: credentialRef,
    pagination,
    schedule,
  };
  const version: AcquisitionConnectionVersion = {
    ...content,
    credential: sealed,
    content_hash: canonicalDigest(content),
  };
  connection.versions.push(version);

  session.audit({
    ...context,
    target: connection.connection_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: { connection_version: version.version, credential_ref: credentialRef, scheduled: schedule !== null },
  });
  session.save();
  return {
    connection_id: connection.connection_id,
    workspace_id: connection.workspace_id,
    name: connection.name,
    connection_version: version.version,
    base_url: version.base_url,
    credential_ref: version.credential_ref,
    pagination: { ...version.pagination },
    schedule: version.schedule === null ? null : { ...version.schedule },
    content_hash: version.content_hash,
    published_at: version.published_at,
  };
}

/** Adopts one exact Connection Version, which is what an acquisition Plan pins. */
export function adoptConnection(options: {
  root: string;
  masterKey: string;
  token: string;
  connectionId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'acquisition_connection_adoption', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === options.connectionId,
  );
  const role = connection === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, connection.workspace_id);
  if (!connection || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'CONNECTION_NOT_AVAILABLE', 'The Connection is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: connection.workspace_id, target: connection.connection_id };
  const version = connection.versions.find((candidate) => candidate.version === options.version);
  if (!version) {
    reject(session, actorLabel(actor.user), scoped, 'CONNECTION_VERSION_NOT_FOUND', `This Connection has no Version ${options.version}.`);
  }
  connection.adopted_version = version.version;
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { connection_version: version.version } });
  session.save();
  return {
    connection_id: connection.connection_id,
    adopted_version: version.version,
    content_hash: version.content_hash,
  };
}

/** Lists the Connections of one Workspace, naming each Version's credential but never opening it. */
export function listConnections(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'acquisition_connection_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  if (workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId) === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const connections = session.state.acquisition_connections
    .filter((connection) => connection.workspace_id === options.workspaceId)
    .map((connection) => ({
      connection_id: connection.connection_id,
      name: connection.name,
      adopted_version: connection.adopted_version,
      versions: connection.versions.map((version) => ({
        version: version.version,
        base_url: version.base_url,
        credential_ref: version.credential_ref,
        has_credential: version.credential !== null,
        schedule: version.schedule === null ? null : { ...version.schedule },
        content_hash: version.content_hash,
      })),
    }));
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { connections_returned: connections.length } });
  return { workspace_id: options.workspaceId, connections };
}
