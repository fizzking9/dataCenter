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
  HTTP_JSON_CONNECTOR,
  type AcquisitionConnectionArtifact,
  type AcquisitionConnectionVersion,
  type ConnectionPagination,
  type PaginationCompletion,
  type SourceAcquisitionArtifact,
  type SourceAcquisitionVersion,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { encryptSecret } from './keys.js';
import { workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;
const COMPLETIONS = ['empty_page', 'short_page', 'last_page_flag'];

function requireName(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): string {
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
  // The declared endpoint is the one address this Connection may read, so a
  // later redirect or a different host never receives the stored credential.
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

/** Publishes one Acquisition Connection Version, sealing the credential it authenticates with. */
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
  const name = requireName(session, actorLabel(actor.user), context, options.name);

  const config = readJsonDocument(
    options.configPath,
    (code, message) => reject(session, actorLabel(actor.user), context, code, message),
    'CONNECTION_CONFIGURATION_UNREADABLE',
    'The Connection configuration file must contain valid JSON.',
  );
  if (!isRecord(config)) {
    reject(session, actorLabel(actor.user), context, 'CONNECTION_CONFIGURATION_INVALID', 'A Connection configuration must be a JSON object.');
  }
  const baseUrl = readBaseUrl(session, actorLabel(actor.user), context, config['base_url']);
  const pagination = readPagination(session, actorLabel(actor.user), context, config['pagination']);

  const auth = config['auth'] ?? { scheme: 'bearer' };
  if (!isRecord(auth) || auth['scheme'] !== 'bearer') {
    reject(session, actorLabel(actor.user), context, 'CONNECTION_AUTH_UNSUPPORTED', 'The only authentication scheme this release supports is bearer.');
  }
  if (options.credential === undefined || options.credential.length === 0) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'CONNECTION_CREDENTIAL_REQUIRED',
      'Bearer authentication requires a credential supplied on standard input.',
      'Publish the Connection with --credential-stdin.',
    );
  }

  let schedule: { every_minutes: number } | null = null;
  if (config['schedule'] !== undefined && config['schedule'] !== null) {
    const raw = config['schedule'];
    const every = isRecord(raw) ? raw['every_minutes'] : undefined;
    if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 10_080) {
      reject(session, actorLabel(actor.user), context, 'CONNECTION_CONFIGURATION_INVALID', 'A schedule interval must be a whole number of minutes from 1 to 10080.');
    }
    schedule = { every_minutes: every as number };
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
      credential: null,
    } satisfies AcquisitionConnectionArtifact;
    session.state.acquisition_connections.push(connection);
  }
  const connectionContent = {
    version: (connection.versions[connection.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    base_url: baseUrl,
    credential_ref: 'bearer',
    pagination,
    schedule,
  };
  const version: AcquisitionConnectionVersion = {
    ...connectionContent,
    content_hash: canonicalDigest(connectionContent),
  };
  connection.versions.push(version);
  // The credential is sealed under the Deployment data key and never returned.
  connection.credential = encryptSecret(session.dataKey, options.credential);

  session.audit({
    ...context,
    target: connection.connection_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { connection_version: version.version, scheduled: schedule !== null },
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

/** Lists the Connections of one Workspace, without their credentials. */
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
      has_credential: connection.credential !== null,
      versions: connection.versions.map((version) => ({
        version: version.version,
        base_url: version.base_url,
        schedule: version.schedule === null ? null : { ...version.schedule },
        content_hash: version.content_hash,
      })),
    }));
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { connections_returned: connections.length } });
  return { workspace_id: options.workspaceId, connections };
}

function readCompletion(session: PlatformSession, actor: string, context: ActionContext, raw: unknown): PaginationCompletion {
  if (!isRecord(raw) || !COMPLETIONS.includes(String(raw['kind']))) {
    reject(
      session,
      actor,
      context,
      'ACQUISITION_CONFIGURATION_INVALID',
      `Pagination completion must be one of: ${COMPLETIONS.join(', ')}.`,
    );
  }
  const kind = raw['kind'];
  if (kind === 'empty_page') return { kind: 'empty_page' };
  if (kind === 'short_page') return { kind: 'short_page' };
  const flag = raw['flag'];
  const doneValue = raw['done_value'] ?? false;
  if (typeof flag !== 'string' || typeof doneValue !== 'boolean') {
    reject(session, actor, context, 'ACQUISITION_CONFIGURATION_INVALID', 'A last_page_flag completion must name the flag and the value that ends the read.');
  }
  return { kind: 'last_page_flag', flag, done_value: doneValue };
}

/** Publishes one Source's acquisition configuration, pinning its Connection Version. */
export function publishSourceAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  configPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'source_acquisition_publication', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);

  const config = readJsonDocument(
    options.configPath,
    fail,
    'ACQUISITION_CONFIGURATION_UNREADABLE',
    'The acquisition configuration file must contain valid JSON.',
  );
  if (!isRecord(config)) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'An acquisition configuration must be a JSON object.');
  }
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === config['connection'] && candidate.workspace_id === source.workspace_id,
  );
  if (!connection) {
    fail(
      'CONNECTION_NOT_AVAILABLE',
      'The acquisition configuration must name a Connection of this Workspace.',
      'Publish the Connection before configuring the Source that reads it.',
    );
  }
  const connectionVersion = connection.versions.find((candidate) => candidate.version === config['connection_version']);
  if (!connectionVersion) {
    fail('CONNECTION_VERSION_NOT_FOUND', 'The acquisition configuration pins a Connection Version that does not exist.');
  }
  const path = config['path'];
  if (typeof path !== 'string' || !path.startsWith('/')) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The acquisition path must be an absolute path on the Connection endpoint.');
  }
  const recordPath = config['record_path'] ?? null;
  if (recordPath !== null && (typeof recordPath !== 'string' || recordPath.length === 0)) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The record path must name where the records array sits in the response.');
  }
  const completion = readCompletion(session, actorLabel(actor.user), scoped, config['completion']);

  let artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === source.source_id);
  if (!artifact) {
    artifact = {
      source_id: source.source_id,
      workspace_id: source.workspace_id,
      owner_user_id: actor.user.user_id,
      adopted_version: null,
      versions: [],
    } satisfies SourceAcquisitionArtifact;
    session.state.source_acquisitions.push(artifact);
  }
  const acquisitionContent = {
    version: (artifact.versions[artifact.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    connection_id: connection.connection_id,
    connection_version: connectionVersion.version,
    connector: { ...HTTP_JSON_CONNECTOR },
    path,
    record_path: recordPath,
    completion,
  };
  const version: SourceAcquisitionVersion = {
    ...acquisitionContent,
    content_hash: canonicalDigest(acquisitionContent),
  };
  artifact.versions.push(version);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      acquisition_configuration_version: version.version,
      connection_id: connection.connection_id,
      connection_version: connectionVersion.version,
      connector_version: HTTP_JSON_CONNECTOR.version,
    },
  });
  session.save();
  return {
    source_id: source.source_id,
    acquisition_configuration_version: version.version,
    connection_id: connection.connection_id,
    connection_version: connectionVersion.version,
    connector: { ...HTTP_JSON_CONNECTOR },
    content_hash: version.content_hash,
  };
}

/** Adopts one exact acquisition configuration Version for a Source. */
export function adoptSourceAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'source_acquisition_adoption', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === source.source_id);
  const version = artifact?.versions.find((candidate) => candidate.version === options.version);
  if (!artifact || !version) {
    reject(session, actorLabel(actor.user), scoped, 'ACQUISITION_VERSION_NOT_FOUND', `This Source has no acquisition configuration Version ${options.version}.`);
  }
  artifact.adopted_version = version.version;
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { acquisition_configuration_version: version.version } });
  session.save();
  return {
    source_id: source.source_id,
    adopted_version: version.version,
    content_hash: version.content_hash,
  };
}
