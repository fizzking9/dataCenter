import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command, jsonFile, workspaceFixture } from '../support/platform.js';

test('a Workspace Administrator registers a file Source and a Consumer cannot', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = workspaceFixture();

  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.output.workspace_id, workspaceId);
  assert.equal(created.output.name, '设备台账');
  assert.equal(created.output.type, 'file');
  assert.equal(created.output.owner, 'operations@example.invalid');
  assert.match(String(created.output.source_id), /^[0-9a-f-]{36}$/);

  const duplicate = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(duplicate.status, 2);
  assert.equal(duplicate.error.code, 'SOURCE_NAME_TAKEN');

  const unsupported = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '投诉接口', '--type', 'http_api'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(unsupported.status, 2);
  assert.equal(unsupported.error.code, 'SOURCE_TYPE_UNSUPPORTED');

  const unauthorized = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '退货明细', '--type', 'file'],
    { token: consumerToken },
  );
  assert.equal(unauthorized.status, 2);
  assert.equal(unauthorized.error.code, 'WORKSPACE_ACCESS_DENIED');
});

test('an Integration Configuration records exact schema, cleaning, mapping, and Business Context versions', () => {
  const { fixture, workspaceId, workspaceAdministratorToken, deploymentAdministratorToken } = workspaceFixture();

  command(
    fixture,
    ['context', 'publish-common', '--entries', jsonFile(fixture, 'common-v1', [
      { key: 'refund_window_days', kind: 'metric', value: '30', unit: 'days' },
    ])],
    { token: deploymentAdministratorToken },
  );
  command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', jsonFile(fixture, 'workspace-v1', [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '65' },
    ])],
    { token: workspaceAdministratorToken },
  );
  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  const sourceId = String(source.output.source_id);

  const configuration = () => jsonFile(fixture, 'integration-v1', {
    identity: ['sn'],
    schema: [
      { name: 'sn', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'handled_count', type: 'integer' },
    ],
    cleaning: [
      { rule: 'trim', field: 'sn' },
      { rule: 'uppercase', field: 'sn' },
      { rule: 'default', field: 'city', value: '未知' },
    ],
    mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' },
  });

  const published = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', configuration()],
    { token: workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.output.integration_configuration_version, 1);
  assert.deepEqual(published.output.pins, {
    common_business_context_version: 1,
    workspace_business_context_version: 1,
  });
  for (const hash of ['content_hash', 'schema_hash', 'cleaning_hash', 'mapping_hash']) {
    assert.match(String(published.output[hash]), /^[0-9a-f]{64}$/, hash);
  }
  assert.equal(published.output.adopted_version, null);

  const republished = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', configuration()],
    { token: workspaceAdministratorToken },
  );
  assert.equal(republished.output.integration_configuration_version, 2);
  assert.equal(republished.output.content_hash, published.output.content_hash);

  const incomplete = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration-incomplete', {
      identity: ['sn'],
      schema: [{ name: 'sn', type: 'string' }, { name: 'city', type: 'string' }],
      mapping: { 设备SN: 'sn' },
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(incomplete.status, 2);
  assert.equal(incomplete.error.code, 'INTEGRATION_MAPPING_INCOMPLETE');

  const unknownIdentity = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration-identity', {
      identity: ['absent'],
      schema: [{ name: 'sn', type: 'string' }],
      mapping: { 设备SN: 'sn' },
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(unknownIdentity.status, 2);
  assert.equal(unknownIdentity.error.code, 'INTEGRATION_CONFIGURATION_INVALID');

  const adopted = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', '1'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(adopted.output.adopted_version, 1);

  const missingVersion = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', '9'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(missingVersion.status, 2);
  assert.equal(missingVersion.error.code, 'INTEGRATION_VERSION_NOT_FOUND');
});
