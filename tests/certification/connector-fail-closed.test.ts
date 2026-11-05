import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEVICES, readyFileSource, readySource } from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command, workspaceFixture, type PlatformFixture } from '../support/platform.js';

interface WorkResult {
  status: string;
  plan: unknown;
  raw_acquisition_count: number;
  integration_batch_id: string | null;
  dataset_release: number | null;
  error_code?: string | null;
}

function enqueue(fixture: PlatformFixture, token: string, sourceId: string): void {
  const result = command(fixture, ['acquisition', 'enqueue', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
}

function work(fixture: PlatformFixture, token: string, sourceId: string): WorkResult {
  const result = command(fixture, ['acquisition', 'work', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkResult;
}

function watermark(fixture: PlatformFixture, token: string, sourceId: string): string | null {
  const result = command(fixture, ['acquisition', 'checkpoint', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  const checkpoint = result.output['checkpoint'] as Record<string, unknown> | null;
  return (checkpoint?.['watermark'] as string | null | undefined) ?? null;
}

test('authentication, protocol, container, content-type, file-signature, and schema drift all fail closed', async () => {
  // ---------------------------------------------------------------------------
  // Authentication: the endpoint stops accepting the Connection's session. The
  // second rejection after the one replay stops the Run, and the resume point a
  // previous complete Plan won stays exactly where it was.
  // ---------------------------------------------------------------------------
  const authServer = await startHttpSource({
    replies: [{ body: pageBody([DEVICES[0]!]) }],
    auth: { token_path: '/oauth/token', issued: ['token-a', 'token-b'], rejected_tokens: ['token-b'], expire_after_uses: 1 },
  });
  const authenticated = await readySource(authServer, {
    auth: {
      scheme: 'oauth_client_credentials',
      token_url: `${authServer.url}/oauth/token`,
      client_id: 'device-client',
      scope: null,
    },
    credential: 'client-secret',
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-01-01T00:00:00.000Z',
      maximum_span_minutes: 44640,
      lookback_minutes: 0,
    },
  });
  enqueue(authenticated.fixture, authenticated.workspaceAdministratorToken, authenticated.sourceId);
  const firstRun = work(authenticated.fixture, authenticated.workspaceAdministratorToken, authenticated.sourceId);
  assert.equal(firstRun.status, 'complete');
  const authWatermark = watermark(authenticated.fixture, authenticated.workspaceAdministratorToken, authenticated.sourceId);
  assert.notEqual(authWatermark, null);

  enqueue(authenticated.fixture, authenticated.workspaceAdministratorToken, authenticated.sourceId);
  const stopped = work(authenticated.fixture, authenticated.workspaceAdministratorToken, authenticated.sourceId);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error_code, 'ACQUISITION_AUTHENTICATION_INTERVENTION_REQUIRED');
  assert.equal(stopped.integration_batch_id, null);
  assert.equal(stopped.dataset_release, null);
  assert.equal(
    authServer.requests().filter((request) => request.path === '/api/devices').length,
    3,
    'the refused attempt replays exactly once and then stops instead of looping',
  );
  assert.equal(
    watermark(authenticated.fixture, authenticated.workspaceAdministratorToken, authenticated.sourceId),
    authWatermark,
    'a refused authentication never advances the checkpoint',
  );
  await authServer.close();

  // ---------------------------------------------------------------------------
  // Protocol, content-type, and schema drift on one Source: each attempt states
  // the drift, keeps its diagnostic Raw Acquisition, and leaves the checkpoint.
  // ---------------------------------------------------------------------------
  const driftServer = await startHttpSource({
    replies: [
      { body: pageBody([DEVICES[0]!]) },
      { body: 'not-json-at-all' },
      { body: '{"data":{"records":[]}}', content_type: 'text/plain' },
      { body: pageBody([{ device_serial: 'sn-001', city: '杭州', handled_count: 3 }]) },
    ],
  });
  const drifting = await readySource(driftServer, {
    content_type: 'application/json',
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-01-01T00:00:00.000Z',
      maximum_span_minutes: 44640,
      lookback_minutes: 0,
    },
  });
  const { fixture, workspaceAdministratorToken: token, sourceId } = drifting;
  enqueue(fixture, token, sourceId);
  assert.equal(work(fixture, token, sourceId).status, 'complete');
  const driftWatermark = watermark(fixture, token, sourceId);
  assert.notEqual(driftWatermark, null);

  // Protocol drift: the endpoint answers 200 with something that is not JSON.
  enqueue(fixture, token, sourceId);
  const protocol = work(fixture, token, sourceId);
  assert.equal(protocol.status, 'failed');
  assert.equal(protocol.error_code, 'ACQUISITION_RESPONSE_MALFORMED');
  assert.equal(protocol.raw_acquisition_count, 1, 'the unparseable response stays as evidence');
  assert.equal(protocol.integration_batch_id, null);
  assert.equal(watermark(fixture, token, sourceId), driftWatermark);

  // Content-type drift: the bytes arrive under a type the Source never declared.
  enqueue(fixture, token, sourceId);
  const contentTyped = work(fixture, token, sourceId);
  assert.equal(contentTyped.status, 'failed');
  assert.equal(contentTyped.error_code, 'ACQUISITION_CONTENT_TYPE_UNEXPECTED');
  assert.equal(contentTyped.integration_batch_id, null);
  assert.equal(watermark(fixture, token, sourceId), driftWatermark);

  // Schema drift: the JSON parses but no longer matches the adopted Integration.
  enqueue(fixture, token, sourceId);
  const schema = command(fixture, ['acquisition', 'work', '--source', sourceId], { token });
  assert.equal(schema.status, 2);
  assert.equal(schema.error['code'], 'INTEGRATION_MAPPING_UNKNOWN_COLUMN', 'the drift is named, not silently dropped');
  assert.equal(watermark(fixture, token, sourceId), driftWatermark, 'a quarantined Batch never moves the checkpoint');
  await driftServer.close();

  // ---------------------------------------------------------------------------
  // Container and file-signature drift: an archive or a binary blob uploaded as
  // delimited text is refused before it can become a governed Dataset Release.
  // ---------------------------------------------------------------------------
  const workspace = workspaceFixture();
  const fileSourceId = readyFileSource(workspace.fixture, workspace, '台账文件');
  const archive = join(workspace.fixture.root, 'ledger.zip');
  writeFileSync(archive, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
  const container = command(workspace.fixture, ['acquisition', 'upload', '--source', fileSourceId, '--file', archive], {
    token: workspace.workspaceAdministratorToken,
  });
  assert.equal(container.status, 2);
  assert.equal(container.error['code'], 'ACQUISITION_FILE_SIGNATURE_INVALID', 'an archive is a container, not delimited text');

  const binary = join(workspace.fixture.root, 'ledger.bin');
  writeFileSync(binary, Buffer.concat([
    Buffer.from('device_sn,city,handled_count\nsn-001,', 'utf8'),
    Buffer.from([0x00, 0x01, 0x02]),
    Buffer.from('\n', 'utf8'),
  ]));
  const signature = command(workspace.fixture, ['acquisition', 'upload', '--source', fileSourceId, '--file', binary], {
    token: workspace.workspaceAdministratorToken,
  });
  assert.equal(signature.status, 2);
  assert.equal(signature.error['code'], 'ACQUISITION_FILE_SIGNATURE_INVALID', 'the bytes are sniffed, not the file name');

  const text = join(workspace.fixture.root, 'ledger.csv');
  writeFileSync(text, 'device_sn,city,handled_count\nsn-001,杭州,3\n');
  const accepted = command(workspace.fixture, ['acquisition', 'upload', '--source', fileSourceId, '--file', text], {
    token: workspace.workspaceAdministratorToken,
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.output['status'], 'complete');
  assert.equal(
    ((accepted.output['integration_batch'] as Record<string, unknown>)['raw_acquisition_ids'] as unknown[]).length,
    1,
    'the accepted text is the only fragment the Batch holds',
  );
  const ledger = command(workspace.fixture, ['acquisition', 'queue', '--source', fileSourceId], {
    token: workspace.workspaceAdministratorToken,
  });
  assert.equal(
    (ledger.output['runs'] as unknown[]).length,
    1,
    'neither refused upload left a Run, a Raw Acquisition, or a Batch behind',
  );
});
