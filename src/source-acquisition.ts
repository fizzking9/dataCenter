import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  HTTP_JSON_CONNECTOR,
  type PaginationCompletion,
  type SourceAcquisitionArtifact,
  type SourceAcquisitionVersion,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const COMPLETIONS = ['empty_page', 'short_page', 'last_page_flag'];

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

/**
 * Publishes one Source's acquisition configuration, pinning an exact Connection
 * Version and the connector identity every Plan will record.
 */
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
  const content = {
    version: (artifact.versions[artifact.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    connection_id: connection.connection_id,
    connection_version: connectionVersion.version,
    connector: { ...HTTP_JSON_CONNECTOR },
    path,
    record_path: recordPath as string | null,
    completion,
  };
  const version: SourceAcquisitionVersion = {
    ...content,
    content_hash: canonicalDigest(content),
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
