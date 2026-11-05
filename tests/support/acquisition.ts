/**
 * Fixtures for declarative HTTP Sources. They publish and adopt the exact
 * Artifact Versions a Run pins, so a certification test only states what the
 * scenario is about: the endpoint, its auth, and the acquisition policy.
 */
import assert from 'node:assert/strict';
import type { HttpSource } from './http-source.js';
import {
  command,
  jsonFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from './platform.js';

export const DEVICES = [
  { device_sn: 'sn-001', city: '杭州', handled_count: 3 },
  { device_sn: 'sn-002', city: '上海', handled_count: 5 },
  { device_sn: 'sn-003', city: '杭州', handled_count: 2 },
  { device_sn: 'sn-004', city: '上海', handled_count: 7 },
  { device_sn: 'sn-005', city: '杭州', handled_count: 4 },
];

export const DEVICE_INTEGRATION = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
  ],
  cleaning: [{ rule: 'trim', field: 'sn' }],
  mapping: { device_sn: 'sn', city: 'city', handled_count: 'handled_count' },
};

export interface ConnectionReference {
  connectionId: string;
  connectionVersion: number;
}

export interface ReadyOptions {
  workspace?: WorkspaceFixture;
  name?: string;
  connectionName?: string;
  /** Publish a second Source onto a Connection another Source already owns. */
  connection?: ConnectionReference;
  auth?: Record<string, unknown>;
  credential?: string | null;
  pagination?: Record<string, unknown>;
  retry?: Record<string, unknown>;
  pacing?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  publicationTargets?: Record<string, unknown>;
  completion?: Record<string, unknown>;
  window?: Record<string, unknown>;
  content_type?: string | null;
  /** The endpoint path the Source reads and where its records sit in the response. */
  path?: string;
  recordPath?: string;
  integration?: Record<string, unknown>;
  adopt?: boolean;
}

export interface ReadySource {
  fixture: PlatformFixture;
  workspace: WorkspaceFixture;
  workspaceId: string;
  workspaceAdministratorToken: string;
  sourceId: string;
  connectionId: string;
  connectionVersion: number;
  acquisitionVersion: number;
  integrationVersion: number;
  close(): Promise<void>;
}

/** Creates a Source of one Workspace, naming it uniquely enough to read in output. */
export function createHttpSource(
  fixture: PlatformFixture,
  workspaceId: string,
  token: string,
  name: string,
): string {
  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', name, '--type', 'http_json'],
    { token },
  );
  assert.equal(created.status, 0, created.stderr);
  return String(created.output.source_id);
}

/** Publishes and adopts one Connection Version. */
export function publishConnection(
  fixture: PlatformFixture,
  workspaceId: string,
  token: string,
  options: {
    name: string;
    baseUrl: string;
    auth?: Record<string, unknown>;
    credential?: string | null;
    pagination?: Record<string, unknown>;
    retry?: Record<string, unknown>;
    pacing?: Record<string, unknown>;
    schedule?: Record<string, unknown>;
    publicationTargets?: Record<string, unknown>;
  },
): ConnectionReference {
  const credential = options.credential === undefined ? 'source-access-token' : options.credential;
  const published = command(
    fixture,
    [
      'connection', 'publish',
      '--workspace', workspaceId,
      '--name', options.name,
      '--config', jsonFile(fixture, `connection-${options.name}`, {
        base_url: options.baseUrl,
        auth: options.auth ?? { scheme: 'bearer' },
        pagination: options.pagination ?? {
          parameter: 'page',
          size_parameter: 'page_size',
          start: 1,
          size: 2,
          max_pages: 5,
        },
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(options.pacing === undefined ? {} : { pacing: options.pacing }),
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
        ...(options.publicationTargets === undefined ? {} : { publication_targets: options.publicationTargets }),
      }),
      ...(credential === null ? [] : ['--credential-stdin']),
    ],
    { token, ...(credential === null ? {} : { input: `${credential}\n` }) },
  );
  assert.equal(published.status, 0, published.stderr);
  const reference = {
    connectionId: String(published.output.connection_id),
    connectionVersion: Number(published.output.connection_version),
  };
  const adopted = command(
    fixture,
    ['connection', 'adopt', '--connection', reference.connectionId, '--version', String(reference.connectionVersion)],
    { token },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  return reference;
}

/** One HTTP Source whose Connection, Acquisition Configuration, and Integration are adopted. */
export async function readySource(
  source: HttpSource,
  options: ReadyOptions = {},
): Promise<ReadySource> {
  const workspace = options.workspace ?? workspaceFixture();
  const { fixture, workspaceId, workspaceAdministratorToken: token } = workspace;
  const sourceId = createHttpSource(fixture, workspaceId, token, options.name ?? '设备接口');

  const connection = options.connection ?? publishConnection(fixture, workspaceId, token, {
    name: options.connectionName ?? '设备系统',
    baseUrl: source.url,
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(options.pagination === undefined ? {} : { pagination: options.pagination }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.pacing === undefined ? {} : { pacing: options.pacing }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.publicationTargets === undefined ? {} : { publicationTargets: options.publicationTargets }),
  });

  const acquisition = command(
    fixture,
    ['acquisition-config', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `acquisition-${sourceId}`, {
      connection: connection.connectionId,
      connection_version: connection.connectionVersion,
      path: options.path ?? '/api/devices',
      record_path: options.recordPath ?? 'data.records',
      completion: options.completion ?? { kind: 'short_page' },
      ...(options.window === undefined ? {} : { window: options.window }),
      ...(options.content_type === undefined ? {} : { content_type: options.content_type }),
    })],
    { token },
  );
  assert.equal(acquisition.status, 0, acquisition.stderr);
  const acquisitionVersion = Number(acquisition.output.acquisition_configuration_version);
  const adoptedAcquisition = command(
    fixture,
    ['acquisition-config', 'adopt', '--source', sourceId, '--version', String(acquisitionVersion)],
    { token },
  );
  assert.equal(adoptedAcquisition.status, 0, adoptedAcquisition.stderr);

  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `integration-${sourceId}`, options.integration ?? DEVICE_INTEGRATION)],
    { token },
  );
  assert.equal(integration.status, 0, integration.stderr);
  const integrationVersion = Number(integration.output.integration_configuration_version);
  const adoptedIntegration = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(integrationVersion)],
    { token },
  );
  assert.equal(adoptedIntegration.status, 0, adoptedIntegration.stderr);

  return {
    fixture,
    workspace,
    workspaceId,
    workspaceAdministratorToken: token,
    sourceId,
    connectionId: connection.connectionId,
    connectionVersion: connection.connectionVersion,
    acquisitionVersion,
    integrationVersion,
    close: () => source.close(),
  };
}

/** A file Source whose Integration Configuration is adopted, ready for an upload. */
export function readyFileSource(
  fixture: PlatformFixture,
  workspace: WorkspaceFixture,
  name: string,
): string {
  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspace.workspaceId, '--name', name, '--type', 'file'],
    { token: workspace.workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  const sourceId = String(created.output.source_id);
  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, `integration-${sourceId}`, DEVICE_INTEGRATION)],
    { token: workspace.workspaceAdministratorToken },
  );
  assert.equal(integration.status, 0, integration.stderr);
  const adopted = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(integration.output.integration_configuration_version)],
    { token: workspace.workspaceAdministratorToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  return sourceId;
}
