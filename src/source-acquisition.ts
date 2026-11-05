import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  HTTP_JSON_CONNECTOR,
  ISO_TIMESTAMP,
  type AcquisitionConnectionArtifact,
  type AcquisitionConnectionVersion,
  type AcquisitionWindowPolicy,
  type PaginationCompletion,
  type SourceAcquisitionArtifact,
  type SourceAcquisitionVersion,
  type SourceRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import { OperatorError, type Fail } from './errors.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const COMPLETIONS = ['empty_page', 'short_page', 'last_page_flag'];

/** The declarative semantics one Source acquisition Version executes under. */
export interface SourceAcquisitionInput {
  connectionId: string;
  connectionVersion: number;
  path: string;
  recordPath: string | null;
  completion: PaginationCompletion;
  window: AcquisitionWindowPolicy | null;
  contentType: string | null;
}

function readCompletion(raw: unknown, fail: Fail): PaginationCompletion {
  if (!isRecord(raw) || !COMPLETIONS.includes(String(raw['kind']))) {
    fail(
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
    fail('ACQUISITION_CONFIGURATION_INVALID', 'A last_page_flag completion must name the flag and the value that ends the read.');
  }
  return { kind: 'last_page_flag', flag, done_value: doneValue };
}

function readWindow(raw: unknown, fail: Fail): AcquisitionWindowPolicy | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'A planner window must be a JSON object.');
  }
  const mode = raw['mode'] ?? 'incremental';
  const startParameter = raw['start_parameter'] ?? 'from';
  const endParameter = raw['end_parameter'] ?? 'to';
  const initialStart = raw['initial_start'];
  const initialEnd = raw['initial_end'] ?? null;
  const maximumSpan = raw['maximum_span_minutes'] ?? 1440;
  const lookback = raw['lookback_minutes'] ?? 0;
  const timeZone = raw['time_zone'] ?? 'UTC';
  const endInclusive = raw['end_inclusive'] ?? false;
  if (mode !== 'fixed' && mode !== 'incremental') {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'A planner window is fixed or incremental.');
  }
  for (const [label, value] of [['start', startParameter], ['end', endParameter]] as const) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/u.test(value)) {
      fail('ACQUISITION_CONFIGURATION_INVALID', `The window ${label} parameter must be a lowercase identifier.`);
    }
  }
  if (typeof initialStart !== 'string' || !ISO_TIMESTAMP.test(initialStart) || !Number.isFinite(Date.parse(initialStart))) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The window must state an ISO initial start.');
  }
  if (mode === 'fixed') {
    if (typeof initialEnd !== 'string' || !ISO_TIMESTAMP.test(initialEnd) || !Number.isFinite(Date.parse(initialEnd))) {
      fail('ACQUISITION_CONFIGURATION_INVALID', 'A fixed window must state an ISO end.');
    }
    if (Date.parse(initialEnd) <= Date.parse(initialStart)) {
      fail('ACQUISITION_CONFIGURATION_INVALID', 'A fixed window must end after it starts.');
    }
  } else if (initialEnd !== null) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'An incremental window captures its own upper bound.');
  }
  if (!Number.isInteger(maximumSpan) || (maximumSpan as number) < 1 || (maximumSpan as number) > 44_640) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The maximum span must be a whole number of minutes from 1 to 44640.');
  }
  if (!Number.isInteger(lookback) || (lookback as number) < 0 || (lookback as number) > 44_640) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The lookback must be a whole number of minutes from 0 to 44640.');
  }
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The window time zone must be a non-empty string.');
  }
  if (typeof endInclusive !== 'boolean') {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The window end is either inclusive or half-open.');
  }
  return {
    mode,
    start_parameter: startParameter as string,
    end_parameter: endParameter as string,
    initial_start: initialStart,
    initial_end: initialEnd as string | null,
    maximum_span_minutes: maximumSpan as number,
    lookback_minutes: lookback as number,
    time_zone: timeZone,
    end_inclusive: endInclusive,
  };
}

function readContentType(raw: unknown, fail: Fail): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !/^[a-z]+\/[a-z0-9.+*-]+$/u.test(raw)) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The expected content type must be a media type such as application/json.');
  }
  return raw;
}

/**
 * Validates one Source acquisition declaration into the exact semantics a
 * Version executes under. The guided form, the CLI file, and the preview all
 * read through this parser, so a candidate never invents a second model.
 */
export function parseSourceAcquisitionDeclaration(
  parsed: unknown,
  fail: Fail,
): SourceAcquisitionInput {
  if (!isRecord(parsed)) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'An acquisition configuration must be a JSON object.');
  }
  const connection = parsed['connection'];
  if (typeof connection !== 'string' || connection.length === 0) {
    fail(
      'CONNECTION_NOT_AVAILABLE',
      'The acquisition configuration must name a Connection of this Workspace.',
      'Publish the Connection before configuring the Source that reads it.',
    );
  }
  const connectionVersion = parsed['connection_version'];
  if (!Number.isInteger(connectionVersion) || (connectionVersion as number) < 1) {
    fail('CONNECTION_VERSION_NOT_FOUND', 'The acquisition configuration pins a Connection Version that does not exist.');
  }
  const path = parsed['path'];
  if (typeof path !== 'string' || !path.startsWith('/')) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The acquisition path must be an absolute path on the Connection endpoint.');
  }
  const recordPath = parsed['record_path'] ?? null;
  if (recordPath !== null && (typeof recordPath !== 'string' || recordPath.length === 0)) {
    fail('ACQUISITION_CONFIGURATION_INVALID', 'The record path must name where the records array sits in the response.');
  }
  return {
    connectionId: connection,
    connectionVersion: connectionVersion as number,
    path,
    recordPath: recordPath as string | null,
    completion: readCompletion(parsed['completion'], fail),
    window: readWindow(parsed['window'], fail),
    contentType: readContentType(parsed['content_type'], fail),
  };
}

/** The exact declarative document one acquisition Version hashes and executes. */
function declarativeDocument(input: SourceAcquisitionInput): Record<string, unknown> {
  return {
    connection: input.connectionId,
    connection_version: input.connectionVersion,
    path: input.path,
    record_path: input.recordPath,
    completion: { ...input.completion },
    window: input.window === null ? null : { ...input.window },
    content_type: input.contentType,
  };
}

/**
 * Resolves the exact Connection Version a declaration pins. A Connection of
 * another Workspace answers exactly like one that does not exist.
 */
function pinnedConnection(
  session: PlatformSession,
  fail: Fail,
  workspaceId: string,
  input: SourceAcquisitionInput,
): { connection: AcquisitionConnectionArtifact; version: AcquisitionConnectionVersion } {
  const connection = session.state.acquisition_connections.find(
    (candidate) => candidate.connection_id === input.connectionId && candidate.workspace_id === workspaceId,
  );
  if (!connection) {
    fail(
      'CONNECTION_NOT_AVAILABLE',
      'The acquisition configuration must name a Connection of this Workspace.',
      'Publish the Connection before configuring the Source that reads it.',
    );
  }
  const version = connection.versions.find((candidate) => candidate.version === input.connectionVersion);
  if (!version) {
    fail('CONNECTION_VERSION_NOT_FOUND', 'The acquisition configuration pins a Connection Version that does not exist.');
  }
  return { connection, version };
}

function appendAcquisitionVersion(options: {
  session: PlatformSession;
  actorName: string;
  actorUserId: string;
  context: ActionContext;
  source: SourceRecord;
  input: SourceAcquisitionInput;
}): Record<string, unknown> {
  const { session, context, source, input } = options;
  const { connection, version: connectionVersion } = pinnedConnection(
    session,
    (code, message, nextStep) => reject(session, options.actorName, context, code, message, nextStep),
    source.workspace_id,
    input,
  );

  let artifact = session.state.source_acquisitions.find((candidate) => candidate.source_id === source.source_id);
  if (!artifact) {
    artifact = {
      source_id: source.source_id,
      workspace_id: source.workspace_id,
      owner_user_id: options.actorUserId,
      adopted_version: null,
      versions: [],
      checkpoint: null,
    } satisfies SourceAcquisitionArtifact;
    session.state.source_acquisitions.push(artifact);
  }
  const content = declarativeDocument(input);
  const version: SourceAcquisitionVersion = {
    version: (artifact.versions[artifact.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: options.actorUserId,
    connection_id: input.connectionId,
    connection_version: input.connectionVersion,
    connector: { ...HTTP_JSON_CONNECTOR },
    path: input.path,
    record_path: input.recordPath,
    completion: { ...input.completion },
    window: input.window === null ? null : { ...input.window },
    content_type: input.contentType,
    content_hash: canonicalDigest(content),
  };
  artifact.versions.push(version);
  session.audit({
    ...context,
    target: source.source_id,
    actor: options.actorName,
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
    path: version.path,
    record_path: version.record_path,
    completion: { ...version.completion },
    window: version.window === null ? null : { ...version.window },
    content_type: version.content_type,
    content_hash: version.content_hash,
  };
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

  const config = readJsonDocument(
    options.configPath,
    (code, message) => reject(session, actorLabel(actor.user), scoped, code, message),
    'ACQUISITION_CONFIGURATION_UNREADABLE',
    'The acquisition configuration file must contain valid JSON.',
  );
  const input = parseSourceAcquisitionDeclaration(config, (code, message, nextStep) =>
    reject(session, actorLabel(actor.user), scoped, code, message, nextStep));

  return appendAcquisitionVersion({
    session,
    actorName: actorLabel(actor.user),
    actorUserId: actor.user.user_id,
    context: scoped,
    source,
    input,
  });
}

/**
 * Validates one guided acquisition declaration without writing anything. An
 * invalid candidate reports the exact refusal the publication would answer,
 * and nothing is published by a review.
 */
export function previewSourceAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  declaration: unknown;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'source_acquisition_preview', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  try {
    const input = parseSourceAcquisitionDeclaration(options.declaration, (code, message, nextStep) =>
      reject(session, actorLabel(actor.user), scoped, code, message, nextStep));
    pinnedConnection(
      session,
      (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep),
      source.workspace_id,
      input,
    );
    const document = declarativeDocument(input);
    session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded' });
    return {
      valid: true,
      declaration: document,
      content_hash: canonicalDigest(document),
      errors: [],
    };
  } catch (error) {
    if (!(error instanceof OperatorError)) throw error;
    // The refusal is already audited by reject(); the caller reads the reason.
    return {
      valid: false,
      errors: [{ code: error.code, message: error.message }],
    };
  }
}

/**
 * Publishes one guided acquisition declaration as the next immutable Version.
 * The declaration is structured configuration, never a file the browser wrote.
 */
export function publishSourceAcquisitionDeclaration(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  declaration: unknown;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'source_acquisition_publication', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const input = parseSourceAcquisitionDeclaration(options.declaration, (code, message, nextStep) =>
    reject(session, actorLabel(actor.user), scoped, code, message, nextStep));

  return appendAcquisitionVersion({
    session,
    actorName: actorLabel(actor.user),
    actorUserId: actor.user.user_id,
    context: scoped,
    source,
    input,
  });
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
