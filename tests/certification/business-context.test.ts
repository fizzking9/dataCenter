import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  command,
  contextEntries,
  createUser,
  createWorkspace,
  initializePlatform,
  sessionFor,
} from '../support/platform.js';

interface ContextShow {
  scope: string;
  business_context_version: number;
  pins: { common_business_context_version: number; previous_workspace_business_context_version: number | null };
  entries: Array<{ key: string; source: string; value: string }>;
}

function showWorkspaceContext(
  fixture: ReturnType<typeof initializePlatform>,
  token: string,
  workspaceId: string,
  version?: number,
): ContextShow {
  const result = command(
    fixture,
    ['context', 'show', '--workspace', workspaceId, ...(version === undefined ? [] : ['--version', String(version)])],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as ContextShow;
}

interface ContextPins {
  common_business_context_version: number;
  previous_workspace_business_context_version: number | null;
}

function pinsOf(output: Record<string, unknown>): ContextPins {
  return output['pins'] as ContextPins;
}

function operatorWorkspace() {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  const workspaceId = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');
  return { fixture, administratorToken, workspaceId, operationsToken };
}

test('common Business Context is inherited and Workspace extensions cannot shadow it', () => {
  const { fixture, administratorToken, workspaceId, operationsToken } = operatorWorkspace();

  const common = command(
    fixture,
    ['context', 'publish-common', '--entries', contextEntries(fixture, 'common-v1', [
      { key: 'refund_window_days', kind: 'metric', value: '30', unit: 'days' },
      { key: 'complaint_channel_labels', kind: 'definition', value: 'channel,source_platform' },
    ])],
    { token: administratorToken },
  );
  assert.equal(common.status, 0, common.stderr);
  assert.equal(common.output.scope, 'deployment');
  assert.equal(common.output.business_context_version, 1);

  const extension = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'workspace-v1', [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '65', references: ['common:refund_window_days'] },
    ])],
    { token: operationsToken },
  );
  assert.equal(extension.status, 0, extension.stderr);
  assert.equal(pinsOf(extension.output).common_business_context_version, 1);

  const effective = showWorkspaceContext(fixture, operationsToken, workspaceId);
  assert.equal(effective.scope, 'workspace');
  assert.deepEqual(
    effective.entries.map((entry) => [entry.key, entry.source]),
    [['bms_export_pause_seconds', 'workspace'], ['complaint_channel_labels', 'common'], ['refund_window_days', 'common']],
  );

  const shadow = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'shadow', [
      { key: 'refund_window_days', kind: 'metric', value: '45' },
    ])],
    { token: operationsToken },
  );
  assert.equal(shadow.status, 2);
  assert.equal(shadow.error.code, 'CONTEXT_SHADOWS_COMMON');

  const untouched = showWorkspaceContext(fixture, operationsToken, workspaceId);
  assert.equal(untouched.business_context_version, 1);
  assert.equal(untouched.entries.find((entry) => entry.key === 'refund_window_days')?.value, '30');
});

test('Business Context versions pin exact common versions and reject implicit or cross-Workspace references', () => {
  const { fixture, administratorToken, workspaceId, operationsToken } = operatorWorkspace();
  createUser(fixture, administratorToken, 'isolation@example.invalid', 'isolation-administrator');
  const isolationWorkspace = createWorkspace(fixture, administratorToken, 'Isolation', 'isolation@example.invalid');

  command(
    fixture,
    ['context', 'publish-common', '--entries', contextEntries(fixture, 'common-v1', [
      { key: 'refund_window_days', kind: 'metric', value: '30' },
    ])],
    { token: administratorToken },
  );
  const first = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'workspace-v1', [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '65' },
    ])],
    { token: operationsToken },
  );
  assert.equal(first.status, 0, first.stderr);

  const second = command(
    fixture,
    ['context', 'publish-common', '--entries', contextEntries(fixture, 'common-v2', [
      { key: 'refund_window_days', kind: 'metric', value: '30' },
      { key: 'refund_rate', kind: 'metric', value: '0.12', unit: 'ratio' },
    ])],
    { token: administratorToken },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.output.business_context_version, 2);

  const pinned = showWorkspaceContext(fixture, operationsToken, workspaceId, 1);
  assert.equal(pinned.pins.common_business_context_version, 1);
  assert.equal(pinned.entries.some((entry) => entry.key === 'refund_rate'), false);

  const repinned = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'workspace-v2', [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '65' },
      { key: 'refund_rate_floor', kind: 'metric', value: '0.05', references: ['common:refund_rate'] },
    ])],
    { token: operationsToken },
  );
  assert.equal(repinned.status, 0, repinned.stderr);
  assert.equal(pinsOf(repinned.output).common_business_context_version, 2);
  assert.equal(pinsOf(repinned.output).previous_workspace_business_context_version, 1);

  const implicit = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'implicit', [
      { key: 'derived_rate', kind: 'metric', value: '0.1', references: ['refund_rate'] },
    ])],
    { token: operationsToken },
  );
  assert.equal(implicit.status, 2);
  assert.equal(implicit.error.code, 'CONTEXT_REFERENCE_NOT_QUALIFIED');

  const crossWorkspace = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'cross', [
      { key: 'derived_rate', kind: 'metric', value: '0.1', references: [`workspace:${isolationWorkspace}:leakage_probe`] },
    ])],
    { token: operationsToken },
  );
  assert.equal(crossWorkspace.status, 2);
  assert.equal(crossWorkspace.error.code, 'CROSS_WORKSPACE_REFERENCE');

  const commonCrossing = command(
    fixture,
    ['context', 'publish-common', '--entries', contextEntries(fixture, 'common-cross', [
      { key: 'derived_rate', kind: 'metric', value: '0.1', references: [`workspace:${workspaceId}:bms_export_pause_seconds`] },
    ])],
    { token: administratorToken },
  );
  assert.equal(commonCrossing.status, 2);
  assert.equal(commonCrossing.error.code, 'CROSS_WORKSPACE_REFERENCE');

  const unresolved = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'unresolved', [
      { key: 'derived_rate', kind: 'metric', value: '0.1', references: ['common:absent_metric'] },
    ])],
    { token: operationsToken },
  );
  assert.equal(unresolved.status, 2);
  assert.equal(unresolved.error.code, 'CONTEXT_REFERENCE_UNRESOLVED');

  const final = showWorkspaceContext(fixture, operationsToken, workspaceId);
  assert.equal(final.business_context_version, 2);
  assert.equal(final.entries.some((entry) => entry.key === 'derived_rate'), false);
});
