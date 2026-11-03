import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  command,
  jsonFile,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

const DEVICE_LEDGER = '设备SN,城市,处理量\n  sn-001 ,杭州,3\nsn-002,上海,5\n';
const DEVICE_LEDGER_NEXT = '设备SN,城市,处理量\nsn-001,杭州,4\nsn-002,上海,5\n';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function integrationConfiguration(fixture: PlatformFixture): string {
  return jsonFile(fixture, 'integration', {
    identity: ['sn'],
    schema: [
      { name: 'sn', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'handled_count', type: 'integer' },
    ],
    cleaning: [
      { rule: 'trim', field: 'sn' },
      { rule: 'uppercase', field: 'sn' },
    ],
    mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' },
  });
}

/** A file Source with one adopted Integration Configuration Version. */
function integratedSource(fixture: PlatformFixture, token: string, workspaceId: string): string {
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const published = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', integrationConfiguration(fixture)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  const adopted = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(published.output.integration_configuration_version)],
    { token },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  return sourceId;
}

function upload(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  csvPath: string,
): Record<string, unknown> {
  const result = command(fixture, ['acquisition', 'upload', '--source', sourceId, '--file', csvPath], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

interface RawAcquisitionView {
  raw_id: string;
  content_hash: string;
  byte_length: number;
  object_path: string;
}

function rawOf(output: Record<string, unknown>): RawAcquisitionView {
  return output['raw_acquisition'] as RawAcquisitionView;
}

test('an uploaded file becomes an immutable Raw Acquisition inside one complete Acquisition Run and Integration Batch', () => {
  const { fixture, workspaceId, workspaceAdministratorToken }: WorkspaceFixture = workspaceFixture();
  const sourceId = integratedSource(fixture, workspaceAdministratorToken, workspaceId);

  const first = upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger.csv', DEVICE_LEDGER));
  assert.equal(first['source_id'], sourceId);
  assert.equal(first['status'], 'complete');
  assert.match(String(first['acquisition_run_id']), /^[0-9a-f-]{36}$/);

  const raw = rawOf(first);
  assert.equal(raw.content_hash, sha256(DEVICE_LEDGER));
  assert.equal(raw.byte_length, Buffer.byteLength(DEVICE_LEDGER));
  assert.equal(readFileSync(join(fixture.root, raw.object_path), 'utf8'), DEVICE_LEDGER);

  const batch = first['integration_batch'] as Record<string, unknown>;
  assert.equal(batch['acquisition_run_id'], first['acquisition_run_id']);
  assert.equal(batch['integration_configuration_version'], 1);
  assert.deepEqual(batch['raw_acquisition_ids'], [raw.raw_id]);

  const second = upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger-next.csv', DEVICE_LEDGER_NEXT));
  assert.notEqual(second['acquisition_run_id'], first['acquisition_run_id']);
  assert.notEqual(rawOf(second).raw_id, raw.raw_id);
  assert.equal(readFileSync(join(fixture.root, raw.object_path), 'utf8'), DEVICE_LEDGER);
});

test('a Source without an adopted Integration Configuration acquires nothing', () => {
  const { fixture, workspaceId, workspaceAdministratorToken } = workspaceFixture();
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  const sourceId = String(source.output.source_id);
  const csvPath = textFile(fixture, 'ledger.csv', DEVICE_LEDGER);

  const blocked = command(fixture, ['acquisition', 'upload', '--source', sourceId, '--file', csvPath], {
    token: workspaceAdministratorToken,
  });
  assert.equal(blocked.status, 2);
  assert.equal(blocked.error.code, 'SOURCE_INTEGRATION_NOT_ADOPTED');

  const missing = command(fixture, ['acquisition', 'upload', '--source', sourceId, '--file', join(fixture.scratch, 'absent.csv')], {
    token: workspaceAdministratorToken,
  });
  assert.equal(missing.status, 2);
  assert.equal(missing.error.code, 'SOURCE_INTEGRATION_NOT_ADOPTED');
});

interface DatasetShow {
  dataset_id: string;
  dataset_release: number;
  record_count: number;
  pins: { common_business_context_version: number; workspace_business_context_version: number };
  provenance: { batch_ids: string[] };
  records: Array<{ identity: string; values: Record<string, string | number | null> }>;
  record_rejections: Array<{ row: number; field: string | null; rule: string; reason: string }>;
}

function release(fixture: PlatformFixture, token: string, sourceId: string): Record<string, unknown> {
  const result = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function showDataset(fixture: PlatformFixture, token: string, sourceId: string, version?: number): DatasetShow {
  const result = command(
    fixture,
    ['dataset', 'show', '--source', sourceId, ...(version === undefined ? [] : ['--release', String(version)])],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as DatasetShow;
}

test('a Dataset Release reconciles by stable identity and redelivery never duplicates records or Releases', () => {
  const { fixture, workspaceId, workspaceAdministratorToken } = workspaceFixture();
  const sourceId = integratedSource(fixture, workspaceAdministratorToken, workspaceId);
  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger.csv', DEVICE_LEDGER));

  const first = release(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(first['dataset_release'], 1);
  assert.equal(first['reused'], false);
  assert.equal(first['record_count'], 2);
  assert.equal(first['integration_configuration_version'], 1);
  assert.match(String(first['records_hash']), /^[0-9a-f]{64}$/);
  assert.deepEqual(first['pins'], { common_business_context_version: 0, workspace_business_context_version: 0 });

  const shown = showDataset(fixture, workspaceAdministratorToken, sourceId);
  assert.deepEqual(shown.records, [
    { identity: 'sn=SN-001', values: { sn: 'SN-001', city: '杭州', handled_count: 3 } },
    { identity: 'sn=SN-002', values: { sn: 'SN-002', city: '上海', handled_count: 5 } },
  ]);

  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger-again.csv', DEVICE_LEDGER));
  const redelivered = release(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(redelivered['reused'], true);
  assert.equal(redelivered['dataset_release'], 1);
  assert.equal(redelivered['record_count'], 2);
  assert.equal(showDataset(fixture, workspaceAdministratorToken, sourceId).records.length, 2);

  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger-next.csv', DEVICE_LEDGER_NEXT));
  const next = release(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(next['dataset_release'], 2);
  assert.equal(next['reused'], false);
  assert.equal(next['dataset_id'], first['dataset_id']);
  assert.equal(showDataset(fixture, workspaceAdministratorToken, sourceId).records[0]?.values['handled_count'], 4);
  assert.equal(showDataset(fixture, workspaceAdministratorToken, sourceId, 1).records[0]?.values['handled_count'], 3);
});

test('repeated acquisitions reconcile into one logically complete Dataset Release', () => {
  const { fixture, workspaceId, workspaceAdministratorToken } = workspaceFixture();
  const sourceId = integratedSource(fixture, workspaceAdministratorToken, workspaceId);
  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger.csv', DEVICE_LEDGER));
  assert.equal(release(fixture, workspaceAdministratorToken, sourceId)['record_count'], 2);

  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger-fragment.csv', '设备SN,城市,处理量\nsn-003,宁波,7\n'));
  const reconciled = release(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(reconciled['record_count'], 3);
  assert.equal((reconciled['provenance'] as { batch_ids: string[] }).batch_ids.length, 2);
  assert.deepEqual(
    showDataset(fixture, workspaceAdministratorToken, sourceId).records.map((record) => record.identity),
    ['sn=SN-001', 'sn=SN-002', 'sn=SN-003'],
  );
});

test('Record Rejections state the raw locator, failed rule, and reason while the rest of the snapshot governs', () => {
  const { fixture, workspaceId, workspaceAdministratorToken } = workspaceFixture();
  const sourceId = integratedSource(fixture, workspaceAdministratorToken, workspaceId);
  upload(fixture, workspaceAdministratorToken, sourceId, textFile(
    fixture,
    'ledger-defective.csv',
    '设备SN,城市,处理量\nsn-001,杭州,3\nsn-001,杭州,4\nsn-002,上海,abc\n,宁波,5\n',
  ));

  release(fixture, workspaceAdministratorToken, sourceId);
  const shown = showDataset(fixture, workspaceAdministratorToken, sourceId);
  assert.equal(shown.record_count, 1);
  assert.deepEqual(shown.records, [{ identity: 'sn=SN-001', values: { sn: 'SN-001', city: '杭州', handled_count: 3 } }]);
  assert.deepEqual(
    shown.record_rejections.map((rejection) => [rejection.row, rejection.field, rejection.rule, rejection.reason]),
    [
      [3, 'sn', 'identity', 'DUPLICATE_IDENTITY'],
      [4, 'handled_count', 'type', 'NOT_INTEGER'],
      [5, 'sn', 'identity', 'IDENTITY_MISSING'],
    ],
  );
});

test('a Record Rejection locator stays the physical record number when the file has a blank line', () => {
  const { fixture, workspaceId, workspaceAdministratorToken } = workspaceFixture();
  const sourceId = integratedSource(fixture, workspaceAdministratorToken, workspaceId);
  upload(fixture, workspaceAdministratorToken, sourceId, textFile(
    fixture,
    'ledger-blank.csv',
    '设备SN,城市,处理量\n\nsn-001,杭州,3\nsn-002,上海,abc\n',
  ));

  release(fixture, workspaceAdministratorToken, sourceId);
  assert.deepEqual(
    showDataset(fixture, workspaceAdministratorToken, sourceId).record_rejections.map(
      (rejection) => [rejection.row, rejection.reason],
    ),
    [[4, 'NOT_INTEGER']],
  );
});

test('a Dataset Release pins the exact Business Context versions its Integration Configuration named', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, deploymentAdministratorToken } = workspaceFixture();
  const publishContext = (common: number, workspace: number): void => {
    command(fixture, ['context', 'publish-common', '--entries', jsonFile(fixture, `common-v${common}`, [
      { key: 'refund_window_days', kind: 'metric', value: String(common) },
    ])], { token: deploymentAdministratorToken });
    command(fixture, ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', jsonFile(fixture, `workspace-v${workspace}`, [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '65' },
    ])], { token: workspaceAdministratorToken });
  };
  publishContext(1, 1);
  const sourceId = integratedSource(fixture, workspaceAdministratorToken, workspaceId);
  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger.csv', DEVICE_LEDGER));
  assert.deepEqual(release(fixture, workspaceAdministratorToken, sourceId)['pins'], {
    common_business_context_version: 1,
    workspace_business_context_version: 1,
  });

  publishContext(2, 2);
  const republished = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', integrationConfiguration(fixture)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(republished.status, 0, republished.stderr);
  assert.deepEqual(republished.output.pins, {
    common_business_context_version: 2,
    workspace_business_context_version: 2,
  });
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(republished.output.integration_configuration_version)],
    { token: workspaceAdministratorToken },
  );
  upload(fixture, workspaceAdministratorToken, sourceId, textFile(fixture, 'ledger-next.csv', DEVICE_LEDGER_NEXT));
  assert.deepEqual(release(fixture, workspaceAdministratorToken, sourceId)['pins'], {
    common_business_context_version: 2,
    workspace_business_context_version: 2,
  });
  assert.deepEqual(showDataset(fixture, workspaceAdministratorToken, sourceId, 1).pins, {
    common_business_context_version: 1,
    workspace_business_context_version: 1,
  });
});
