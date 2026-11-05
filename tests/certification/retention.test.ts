import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  acquireAndRelease,
  publishLedgerProduct,
} from '../support/data-product.js';
import {
  MOCK_MODEL_ID,
  startMockModelEndpoint,
  type MockModelEndpoint,
} from '../support/model-endpoint.js';
import {
  command,
  jsonFile,
  textFile,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

const DAY_MS = 86_400_000;
const LEDGER_NEXT = [
  '设备SN,城市,处理量,结算金额,上报日期',
  'sn-001,杭州,4,120.50,2026-01-05',
  'sn-002,上海,5,300.00,2026-01-12',
  'sn-003,,2,,2026-01-20',
].join('\n');

/** The settled defaults of spec section 13, asserted as governed values. */
const SETTLED_DEFAULTS = {
  raw_acquisition: { kind: 'days', days: 30 },
  dataset_release_history: { kind: 'days', days: 400 },
  report: { kind: 'days', days: 400 },
  artifact_version: { kind: 'indefinite' },
  provenance: { kind: 'indefinite' },
  audit_event: { kind: 'days', days: 400 },
  proposal_evidence: { kind: 'days', days: 90 },
  export: { kind: 'days', days: 7 },
  derived_data: { kind: 'no_guarantee' },
} as const;

interface StateFile {
  raw_acquisitions: Array<{ raw_id: string; received_at: string; object_path: string; source_id: string }>;
  datasets: Array<{
    dataset_id: string;
    source_id: string;
    releases: Array<{ release: number; created_at: string }>;
  }>;
  data_products: Array<{
    data_product_id: string;
    releases: Array<{ release: number; created_at: string; dataset_release: number }>;
  }>;
  reports: Array<{ report_id: string; generated_at: string }>;
  exports: Array<{ export_id: string; created_at: string; expires_at: string; object_path: string }>;
}

interface Surface extends WorkspaceFixture {
  sourceId: string;
  dataProductId: string;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function statePathOf(fixture: PlatformFixture): string {
  return join(fixture.root, 'state', 'platform.json');
}

function stateOf(fixture: PlatformFixture): StateFile {
  return JSON.parse(readFileSync(statePathOf(fixture), 'utf8')) as StateFile;
}

function editState(fixture: PlatformFixture, mutate: (state: StateFile) => void): void {
  const state = stateOf(fixture);
  mutate(state);
  writeFileSync(statePathOf(fixture), `${JSON.stringify(state, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

function ok(result: CommandResult): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.output;
}

/** Asserts user-facing copy is written in Simplified Chinese with no English prose. */
function assertChineseCopy(text: unknown): void {
  assert.equal(typeof text, 'string');
  const value = text as string;
  assert.equal(/[A-Za-z]/u.test(value), false, `copy carries English prose: ${value}`);
  assert.ok(/[\u4e00-\u9fff]{2}/u.test(value), `copy is written in Chinese: ${value}`);
}

/**
 * One Workspace with two Dataset Releases and two Data Product Releases: the
 * second of each is current, which is the shape every retention decision needs.
 */
function surface(): Surface {
  const base = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  acquireAndRelease(base.fixture, base.workspaceAdministratorToken, base.sourceId, LEDGER_NEXT, 'ledger-next.csv');
  const republished = command(
    base.fixture,
    [
      'product', 'publish',
      '--source', base.sourceId,
      '--name', '设备维修台账',
      '--contract', jsonFile(base.fixture, 'contract-again', EXTENDED_LEDGER_CONTRACT),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(republished.status, 0, republished.stderr);
  assert.equal(republished.output['data_product_release'], 2);
  return { ...base, sourceId: base.sourceId, dataProductId: String(republished.output['data_product_id']) };
}

function policyShow(surface: Surface, args: string[] = [], token?: string): Record<string, unknown> {
  return ok(command(surface.fixture, ['retention', 'policy-show', ...args], {
    token: token ?? surface.deploymentAdministratorToken,
  }));
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function overridePolicy(
  surface: Surface,
  terms: Record<string, unknown>,
): CommandResult {
  return command(
    surface.fixture,
    ['retention', 'override', '--workspace', surface.workspaceId, '--config', jsonFile(surface.fixture, uniqueName('override'), terms)],
    { token: surface.workspaceAdministratorToken },
  );
}

function publishPolicy(
  surface: Surface,
  config: Record<string, unknown>,
): CommandResult {
  return command(
    surface.fixture,
    ['retention', 'policy-publish', '--config', jsonFile(surface.fixture, uniqueName('policy'), config)],
    { token: surface.deploymentAdministratorToken },
  );
}

function evaluate(surface: Surface, args: string[] = []): Record<string, unknown> {
  return ok(command(
    surface.fixture,
    ['retention', 'evaluate', '--workspace', surface.workspaceId, ...args],
    { token: surface.workspaceAdministratorToken },
  ));
}

function tick(surface: Surface, at: Date, token?: string): Record<string, unknown> {
  return ok(command(
    surface.fixture,
    ['retention', 'tick', '--at', at.toISOString()],
    { token: token ?? surface.deploymentAdministratorToken },
  ));
}

function planOf(output: Record<string, unknown>): Array<Record<string, unknown>> {
  return asArray(output['plan']).map((entry) => asRecord(entry));
}

function planEntry(
  output: Record<string, unknown>,
  predicate: (entry: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const entry = planOf(output).find(predicate);
  assert.ok(entry !== undefined, `no plan entry matched in ${JSON.stringify(output['plan'])}`);
  return entry;
}

function queryFailure(
  fixture: PlatformFixture,
  token: string,
  dataProductId: string,
  request: Record<string, unknown>,
): string {
  const result = command(
    fixture,
    ['product', 'query', '--product', dataProductId, '--request', jsonFile(fixture, uniqueName('request'), request)],
    { token },
  );
  assert.equal(result.status, 2, result.stdout);
  return String(result.error['code']);
}

function showDatasetFailure(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  release: number,
): string {
  const result = command(
    fixture,
    ['dataset', 'show', '--source', sourceId, '--release', String(release)],
    { token },
  );
  assert.equal(result.status, 2, result.stdout);
  return String(result.error['code']);
}

function auditEvents(fixture: PlatformFixture, token: string, args: string[] = []): Record<string, unknown> {
  return ok(command(fixture, ['audit', 'list', ...args], { token }));
}

test('settled retention defaults apply to existing data, current Releases never expire, and automatic Purge is dependency-aware', () => {
  const s = surface();
  const policy = policyShow(s);
  assert.equal(policy['policy_version'], 0);
  assert.equal(policy['source'], 'settled');
  assert.deepEqual(policy['defaults'], SETTLED_DEFAULTS);
  assert.deepEqual(policy['bounds'], {
    raw_acquisition: { min_days: 1, max_days: 3650 },
    dataset_release_history: { min_days: 1, max_days: 3650 },
    report: { min_days: 1, max_days: 3650 },
  });
  assertChineseCopy(policy['summary']);

  // Existing data ages: every Release is older than the clock, and so is every
  // Raw Acquisition. The current Release is still old — current never expires.
  editState(s.fixture, (state) => {
    for (const dataset of state.datasets) {
      for (const release of dataset.releases) release.created_at = daysAgo(500);
    }
    for (const product of state.data_products) {
      for (const release of product.releases) release.created_at = daysAgo(500);
    }
    for (const raw of state.raw_acquisitions) raw.received_at = daysAgo(40);
  });

  // The current Dataset Release and Data Product Release still serve exactly.
  const current = ok(command(s.fixture, ['dataset', 'show', '--source', s.sourceId], { token: s.workspaceAdministratorToken }));
  assert.equal(current['dataset_release'], 2);
  assert.equal(asArray(current['records']).length, 3);
  const currentQuery = ok(command(
    s.fixture,
    ['product', 'query', '--product', s.dataProductId, '--request', jsonFile(s.fixture, 'current-request', {
      kind: 'records', limit: 10,
    })],
    { token: s.consumerToken },
  ));
  assert.equal(currentQuery['data_product_release'], 2);

  // A historical query says retention expired; it never substitutes the
  // current Release for the one the caller named.
  assert.equal(showDatasetFailure(s.fixture, s.workspaceAdministratorToken, s.sourceId, 1), 'RETENTION_EXPIRED');
  assert.equal(queryFailure(s.fixture, s.consumerToken, s.dataProductId, { kind: 'records', release: 1, limit: 10 }), 'RETENTION_EXPIRED');

  const releases = ok(command(s.fixture, ['product', 'releases', '--product', s.dataProductId], {
    token: s.consumerToken,
  }));
  const listed = asArray(releases['releases']).map((entry) => asRecord(entry));
  assert.deepEqual(listed.map((entry) => [entry['release'], entry['retention_expired']]), [[1, true], [2, false]]);

  // Eligibility explains every class: historical Releases are eligible, the
  // current Releases are not, and expired Raw Acquisitions are eligible.
  const eligibility = evaluate(s);
  const datasetOne = planEntry(eligibility, (entry) => entry['record_kind'] === 'dataset_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(datasetOne['eligible'], true);
  const datasetTwo = planEntry(eligibility, (entry) => entry['record_kind'] === 'dataset_release' && String(entry['record_id']).endsWith('#2'));
  assert.equal(datasetTwo['eligible'], false);
  assert.equal(datasetTwo['reason'], 'current');
  const productOne = planEntry(eligibility, (entry) => entry['record_kind'] === 'data_product_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(productOne['eligible'], true);
  const raws = planOf(eligibility).filter((entry) => entry['record_kind'] === 'raw_acquisition');
  assert.equal(raws.length, 2);
  assert.equal(raws.every((entry) => entry['eligible'] === true), true);
  assert.equal(eligibility['eligible_count'], 4);
  assertChineseCopy(eligibility['summary']);

  // One automatic tick revokes, deletes asynchronously, and records the Purge
  // Ledger entries that keep purged content from reappearing.
  const rawState = stateOf(s.fixture).raw_acquisitions;
  const rawObjects = rawState.map((raw) => join(s.fixture.root, raw.object_path));
  assert.equal(rawObjects.every((path) => existsSync(path)), true);
  const ticked = tick(s, new Date());
  assert.equal(ticked['health'], 'healthy');
  assert.equal(asArray(ticked['ledger']).length > 0, true);
  assertChineseCopy(ticked['summary']);

  const after = stateOf(s.fixture);
  assert.deepEqual(after.datasets[0]?.releases.map((release) => release.release), [2]);
  assert.deepEqual(after.data_products[0]?.releases.map((release) => release.release), [2]);
  assert.equal(after.raw_acquisitions.length, 0);
  assert.equal(rawObjects.every((path) => existsSync(path)), false, 'purged raw objects are deleted');

  // The current Release survives raw expiry, and a rerun reconciles from the
  // retained curated snapshot rather than silently losing old records.
  const rerun = ok(command(s.fixture, ['dataset', 'release', '--source', s.sourceId], {
    token: s.workspaceAdministratorToken,
  }));
  assert.equal(rerun['dataset_release'], 2);
  assert.equal(rerun['reused'], true);
  assert.equal(rerun['record_count'], 3);

  // Purged history stays explicitly expired even after the physical delete.
  assert.equal(showDatasetFailure(s.fixture, s.workspaceAdministratorToken, s.sourceId, 1), 'RETENTION_EXPIRED');
  assert.equal(queryFailure(s.fixture, s.consumerToken, s.dataProductId, { kind: 'records', release: 1, limit: 10 }), 'RETENTION_EXPIRED');
});

test('Retention Holds block automatic and manual Purge until released, with accountable scope, reason, review date, and Audit Events', () => {
  const s = surface();
  editState(s.fixture, (state) => {
    for (const raw of state.raw_acquisitions) raw.received_at = daysAgo(40);
  });
  const reviewAt = new Date(Date.now() + 30 * DAY_MS).toISOString();

  // A Workspace Administrator places an accountable Hold on the Workspace.
  const hold = ok(command(
    s.fixture,
    [
      'retention', 'hold-create',
      '--scope', 'workspace',
      '--workspace', s.workspaceId,
      '--reason', '监管调查期间禁止删除任何历史证据',
      '--review-at', reviewAt,
    ],
    { token: s.workspaceAdministratorToken },
  ));
  const holdId = String(hold['hold_id']);
  assert.equal(asRecord(hold['scope'])['kind'], 'workspace');
  assert.equal(asRecord(hold['scope'])['workspace_id'], s.workspaceId);
  assert.equal(hold['reason'], '监管调查期间禁止删除任何历史证据');
  assert.equal(hold['review_at'], reviewAt);
  assert.equal(hold['created_by'], 'operations@example.invalid');
  assert.equal(hold['pins_restorable_backups'], true);
  assertChineseCopy(hold['summary']);

  // Automatic eligibility and manual Purge both report the Hold and do nothing.
  const eligibility = evaluate(s);
  const held = planOf(eligibility).filter((entry) => entry['record_kind'] === 'raw_acquisition');
  assert.equal(held.length, 2);
  assert.equal(held.every((entry) => entry['eligible'] === false && entry['reason'] === 'held'), true);
  assert.equal(held.every((entry) => asArray(entry['held_by']).includes(holdId)), true);

  const manual = ok(command(
    s.fixture,
    ['retention', 'purge', '--scope', 'source', '--source', s.sourceId],
    { token: s.workspaceAdministratorToken },
  ));
  assert.equal(manual['purge_id'], null);
  assert.equal(manual['status'], 'nothing_eligible');
  assert.equal(manual['eligible_count'], 0);
  assert.equal(planOf(manual).some((entry) => entry['reason'] === 'held'), true);
  assertChineseCopy(manual['summary']);

  const rawState = stateOf(s.fixture).raw_acquisitions;
  const rawObjects = rawState.map((raw) => join(s.fixture.root, raw.object_path));
  const automatic = tick(s, new Date());
  assert.equal(asArray(automatic['ledger']).length, 0);
  assert.equal(stateOf(s.fixture).raw_acquisitions.length, 2);
  assert.equal(rawObjects.every((path) => existsSync(path)), true);

  // The Hold and its release are Audit Events naming the accountable actor.
  const events = auditEvents(s.fixture, s.workspaceAdministratorToken).events as Array<Record<string, unknown>>;
  const created = events.find((event) => event['action'] === 'retention_hold_create');
  assert.ok(created);
  assert.equal(created['actor'], 'operations@example.invalid');
  assert.equal(created['workspace_id'], s.workspaceId);
  assert.equal(asRecord(created['detail'])['review_at'], reviewAt);

  // Releasing the Hold makes the same content eligible, and the purge deletes.
  const released = ok(command(s.fixture, ['retention', 'hold-release', '--hold', holdId], {
    token: s.workspaceAdministratorToken,
  }));
  assert.equal(released['hold_id'], holdId);
  assert.equal(typeof released['released_at'], 'string');
  assertChineseCopy(released['summary']);
  const afterRelease = tick(s, new Date());
  assert.equal(asArray(afterRelease['ledger']).length > 0, true);
  assert.equal(stateOf(s.fixture).raw_acquisitions.length, 0);
  const eventsAfter = auditEvents(s.fixture, s.workspaceAdministratorToken).events as Array<Record<string, unknown>>;
  assert.equal(eventsAfter.some((event) => event['action'] === 'retention_hold_release'), true);
});

test('Purge revokes access immediately, deletes asynchronously, respects dependencies, and never resurrects purged content when a policy lengthens', () => {
  const s = surface();
  // The historical Dataset Release is old, but a still-retained Data Product
  // Release pins it, so the dependency keeps it ineligible.
  editState(s.fixture, (state) => {
    for (const dataset of state.datasets) {
      for (const release of dataset.releases) {
        if (release.release === 1) release.created_at = daysAgo(500);
      }
    }
  });
  const dependency = evaluate(s);
  const pinned = planEntry(dependency, (entry) => entry['record_kind'] === 'dataset_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(pinned['eligible'], false);
  assert.equal(pinned['reason'], 'dependent');
  assert.equal(asArray(pinned['dependencies']).length, 1);
  const retainedProduct = planEntry(dependency, (entry) => entry['record_kind'] === 'data_product_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(retainedProduct['eligible'], false);
  assert.equal(retainedProduct['reason'], 'within_retention');

  const blockedPurge = ok(command(
    s.fixture,
    ['retention', 'purge', '--scope', 'release', '--dataset', stateOf(s.fixture).datasets[0]!.dataset_id, '--release', '1'],
    { token: s.workspaceAdministratorToken },
  ));
  assert.equal(blockedPurge['purge_id'], null);
  assert.equal(blockedPurge['eligible_count'], 0);
  assertChineseCopy(blockedPurge['summary']);

  // Age the retained dependent too, then request a Release Purge. Access is
  // revoked at once while the records and their objects still exist.
  editState(s.fixture, (state) => {
    for (const product of state.data_products) {
      for (const release of product.releases) release.created_at = daysAgo(500);
    }
  });
  const purged = ok(command(
    s.fixture,
    ['retention', 'purge', '--scope', 'release', '--dataset', stateOf(s.fixture).datasets[0]!.dataset_id, '--release', '1'],
    { token: s.workspaceAdministratorToken },
  ));
  const purgeId = String(purged['purge_id']);
  assert.equal(purged['status'], 'pending');
  assert.equal(typeof purged['access_revoked_at'], 'string');
  assert.equal(purged['eligible_count'], 2);
  assertChineseCopy(purged['summary']);
  assert.equal(showDatasetFailure(s.fixture, s.workspaceAdministratorToken, s.sourceId, 1), 'RETENTION_EXPIRED');
  assert.equal(queryFailure(s.fixture, s.consumerToken, s.dataProductId, { kind: 'records', release: 1, limit: 10 }), 'RETENTION_EXPIRED');
  // The evidence is still physically present: deletion is asynchronous.
  assert.deepEqual(stateOf(s.fixture).datasets[0]?.releases.map((release) => release.release), [1, 2]);

  // Lengthening the policy before the worker runs makes the content retained by
  // age again, but a committed Purge is never resurrected by a policy change.
  const lengthened = publishPolicy(s, {
    defaults: { dataset_release_history: { days: 800 } },
  });
  assert.equal(lengthened.status, 0, lengthened.stderr);
  assert.equal(showDatasetFailure(s.fixture, s.workspaceAdministratorToken, s.sourceId, 1), 'RETENTION_EXPIRED');
  const shown = ok(command(s.fixture, ['retention', 'purge-show', '--purge', purgeId], {
    token: s.workspaceAdministratorToken,
  }));
  assert.equal(shown['status'], 'pending');
  assertChineseCopy(shown['summary']);

  const ticked = tick(s, new Date(Date.now() + 60_000));
  assert.equal(asArray(ticked['ledger']).length > 0, true);
  assert.deepEqual(stateOf(s.fixture).datasets[0]?.releases.map((release) => release.release), [2]);
  assert.deepEqual(stateOf(s.fixture).data_products[0]?.releases.map((release) => release.release), [2]);
  // The purged content stays expired after the physical delete and the longer
  // policy; the untouched current Release still serves.
  assert.equal(showDatasetFailure(s.fixture, s.workspaceAdministratorToken, s.sourceId, 1), 'RETENTION_EXPIRED');
  assert.equal(queryFailure(s.fixture, s.consumerToken, s.dataProductId, { kind: 'records', release: 1, limit: 10 }), 'RETENTION_EXPIRED');
  const current = ok(command(s.fixture, ['dataset', 'show', '--source', s.sourceId], { token: s.workspaceAdministratorToken }));
  assert.equal(current['dataset_release'], 2);
  assert.equal(current['record_count'], 3);
});

test('a failed Purge retries safely, exposes degraded health, and changes no published data', () => {
  const s = surface();
  editState(s.fixture, (state) => {
    for (const raw of state.raw_acquisitions) raw.received_at = daysAgo(40);
  });
  const raw = stateOf(s.fixture).raw_acquisitions[0]!;
  const objectPath = join(s.fixture.root, raw.object_path);
  const originalBytes = readFileSync(objectPath);

  const requested = ok(command(
    s.fixture,
    ['retention', 'purge', '--scope', 'source', '--source', s.sourceId],
    { token: s.workspaceAdministratorToken },
  ));
  const purgeId = String(requested['purge_id']);
  assert.equal(requested['status'], 'pending');

  // A storage fault: the object path is unexpectedly a directory, so physical
  // deletion fails after the access revocation already took effect.
  rmSync(objectPath);
  mkdirSync(objectPath);
  const firstTry = tick(s, new Date(Date.now() + 60_000));
  assert.equal(firstTry['health'], 'degraded');
  const failedJob = asArray(firstTry['jobs']).map((job) => asRecord(job)).find((job) => job['purge_id'] === purgeId);
  assert.ok(failedJob);
  assert.equal(failedJob['status'], 'failed');
  assert.equal(failedJob['attempts'], 1);
  assert.equal(typeof failedJob['last_error'], 'string');
  assert.equal(typeof failedJob['retry_at'], 'string');
  assert.equal(asArray(firstTry['ledger']).length, 0);

  const status = ok(command(s.fixture, ['status', '--operator', 'certification@example.invalid']));
  assert.equal(status['health'], 'degraded');
  assert.equal(asRecord(status['retention'])['failed_purges'], 1);
  assert.equal(asRecord(status['retention'])['pending_purges'], 0);

  // Published data is unchanged by the failed Purge.
  const current = ok(command(s.fixture, ['dataset', 'show', '--source', s.sourceId], { token: s.workspaceAdministratorToken }));
  assert.equal(current['dataset_release'], 2);
  assert.equal(current['record_count'], 3);
  const query = ok(command(
    s.fixture,
    ['product', 'query', '--product', s.dataProductId, '--request', jsonFile(s.fixture, 'failed-purge-request', { kind: 'aggregate', metrics: ['handled_total'], include_totals: true, limit: 10 })],
    { token: s.consumerToken },
  ));
  assert.equal(asRecord(asRecord(query['totals'])['metrics'])['handled_total'], 11);

  // Correcting storage lets the same durable job retry safely and complete.
  rmSync(objectPath, { recursive: true, force: true });
  writeFileSync(objectPath, originalBytes);
  const secondTry = tick(s, new Date(Date.now() + 5 * 60_000));
  assert.equal(secondTry['health'], 'healthy');
  const completed = asArray(secondTry['jobs']).map((job) => asRecord(job)).find((job) => job['purge_id'] === purgeId);
  assert.ok(completed);
  assert.equal(completed['status'], 'completed');
  assert.equal(asArray(secondTry['ledger']).length, 1);
  assert.equal(stateOf(s.fixture).raw_acquisitions.length, 0);
  const healthy = ok(command(s.fixture, ['status', '--operator', 'certification@example.invalid']));
  assert.equal(healthy['health'], 'healthy');
  assert.equal(asRecord(healthy['retention'])['failed_purges'], 0);
});

test('retention policies are versioned, Workspace overrides stay within Deployment bounds, and audit visibility follows audit retention', () => {
  const s = surface();
  // Only a Deployment Administrator controls defaults and audit retention.
  const denied = command(
    s.fixture,
    ['retention', 'policy-publish', '--config', jsonFile(s.fixture, 'denied-policy', {
      defaults: { raw_acquisition: { days: 10 } },
    })],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(denied.status, 2);
  assert.equal(denied.error['code'], 'AUTHORIZATION_DENIED');

  const published = publishPolicy(s, {
    defaults: {
      raw_acquisition: { days: 10 },
      dataset_release_history: { days: 30 },
      report: { days: 200 },
      audit_event: { days: 400 },
      proposal_evidence: { days: 90 },
      export: { days: 7 },
    },
    bounds: {
      raw_acquisition: { min_days: 1, max_days: 60 },
      dataset_release_history: { min_days: 1, max_days: 90 },
      report: { min_days: 1, max_days: 400 },
    },
  });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.output['policy_version'], 1);
  assert.match(String(published.output['content_hash']), /^[0-9a-f]{64}$/u);
  assertChineseCopy(published.output['summary']);
  const shown = policyShow(s);
  assert.equal(shown['policy_version'], 1);
  assert.equal(asRecord(shown['defaults'])['raw_acquisition'] && asRecord(asRecord(shown['defaults'])['raw_acquisition'])['days'], 10);

  // A Workspace Administrator narrows raw and curated retention within bounds.
  const overridden = overridePolicy(s, {
    raw_acquisition: { days: 5 },
    dataset_release_history: { days: 20 },
  });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.output['override_version'], 1);
  assertChineseCopy(overridden.output['summary']);
  const effective = policyShow(s, ['--workspace', s.workspaceId], s.workspaceAdministratorToken);
  assert.equal(asRecord(effective['effective'])['raw_acquisition'] && asRecord(asRecord(effective['effective'])['raw_acquisition'])['days'], 5);
  assert.equal(asRecord(effective['effective'])['dataset_release_history'] && asRecord(asRecord(effective['effective'])['dataset_release_history'])['days'], 20);

  // An override outside the Deployment bounds, or of a class a Workspace may
  // not override, fails closed.
  const beyond = overridePolicy(s, { dataset_release_history: { days: 100 } });
  assert.equal(beyond.status, 2);
  assert.equal(beyond.error['code'], 'RETENTION_POLICY_INVALID');
  const notOverridable = overridePolicy(s, { audit_event: { days: 10 } });
  assert.equal(notOverridable.status, 2);
  assert.equal(notOverridable.error['code'], 'RETENTION_POLICY_INVALID');

  // A fifteen-day-old history is inside the thirty-day Deployment default and
  // inside the twenty-day Workspace override. Shortening the override to five
  // days makes it eligible immediately; lengthening it to sixty retains it again
  // while nothing has been purged.
  editState(s.fixture, (state) => {
    for (const dataset of state.datasets) {
      for (const release of dataset.releases) {
        if (release.release === 1) release.created_at = daysAgo(15);
      }
    }
    for (const product of state.data_products) {
      for (const release of product.releases) {
        if (release.release === 1) release.created_at = daysAgo(15);
      }
    }
  });
  const atDefault = evaluate(s);
  const insideDefault = planEntry(atDefault, (entry) => entry['record_kind'] === 'dataset_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(insideDefault['eligible'], false);
  assert.equal(['within_retention', 'dependent'].includes(String(insideDefault['reason'])), true);

  const shortenedOverride = overridePolicy(s, { dataset_release_history: { days: 5 } });
  assert.equal(shortenedOverride.status, 0, shortenedOverride.stderr);
  assert.equal(shortenedOverride.output['override_version'], 2);
  const shortened = evaluate(s);
  const history = planEntry(shortened, (entry) => entry['record_kind'] === 'dataset_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(history['eligible'], true, 'shortening the Workspace clock makes the fifteen-day Release eligible');

  const lengthenedOverride = overridePolicy(s, { dataset_release_history: { days: 60 } });
  assert.equal(lengthenedOverride.status, 0, lengthenedOverride.stderr);
  const retainedAgain = evaluate(s);
  const retainedHistory = planEntry(retainedAgain, (entry) => entry['record_kind'] === 'dataset_release' && String(entry['record_id']).endsWith('#1'));
  assert.equal(retainedHistory['eligible'], false, 'lengthening the clock retains content that was not purged');

  // Purge under the shortened clock, then lengthen the clock again: the purged
  // Release stays expired while the current Release is untouched.
  const shortenedAgain = overridePolicy(s, { dataset_release_history: { days: 5 } });
  assert.equal(shortenedAgain.status, 0, shortenedAgain.stderr);
  const requested = ok(command(
    s.fixture,
    ['retention', 'purge', '--scope', 'release', '--dataset', stateOf(s.fixture).datasets[0]!.dataset_id, '--release', '1'],
    { token: s.workspaceAdministratorToken },
  ));
  assert.equal(requested['eligible_count'], 2);
  tick(s, new Date(Date.now() + 60_000));
  const lengthenedFinal = overridePolicy(s, { dataset_release_history: { days: 60 } });
  assert.equal(lengthenedFinal.status, 0, lengthenedFinal.stderr);
  assert.equal(showDatasetFailure(s.fixture, s.workspaceAdministratorToken, s.sourceId, 1), 'RETENTION_EXPIRED');
  const current = ok(command(s.fixture, ['dataset', 'show', '--source', s.sourceId], { token: s.workspaceAdministratorToken }));
  assert.equal(current['dataset_release'], 2);
  assert.equal(current['record_count'], 3);

  // A Deployment default change applies to existing data under the same bounds.
  const redeclared = publishPolicy(s, {
    defaults: { dataset_release_history: { days: 10 } },
    bounds: {
      raw_acquisition: { min_days: 1, max_days: 60 },
      dataset_release_history: { min_days: 1, max_days: 90 },
      report: { min_days: 1, max_days: 400 },
    },
  });
  assert.equal(redeclared.status, 0, redeclared.stderr);
  assert.equal(redeclared.output['policy_version'], 2);

  // Audit Events age out of the readable window while the chain stays intact.
  const nowAudit = ok(command(s.fixture, ['audit', 'list'], { token: s.deploymentAdministratorToken }));
  assert.equal(asArray(nowAudit['events']).length > 0, true);
  assert.equal(nowAudit['chain_valid'], true);
  const future = new Date(Date.now() + 401 * DAY_MS).toISOString();
  const laterAudit = ok(command(s.fixture, ['audit', 'list', '--at', future], { token: s.deploymentAdministratorToken }));
  assert.deepEqual(laterAudit['events'], []);
  assert.equal(laterAudit['chain_valid'], true);
});

interface ReportSurface extends Surface {
  endpoint: MockModelEndpoint;
  templateId: string;
  reportId: string;
}

const PURPOSES = ['query_plan', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['product_contract', 'sample_records'];
const PROMPTS = {
  query_plan: '你是数据产品查询规划器，只输出简体中文解释，并且只使用受治理契约发布的字段、维度、指标和算子。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据或因果。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

/** A surface carrying one stocked Report generated through the governed path. */
async function reportSurface(): Promise<ReportSurface> {
  const base = surface();
  const endpoint = await startMockModelEndpoint();
  const profile = command(
    base.fixture,
    ['model', 'publish', '--name', '保留测试模型', '--config', jsonFile(base.fixture, 'retention-profile', {
      adapter: 'generic_local',
      endpoint_url: endpoint.url,
      model_id: MOCK_MODEL_ID,
      purposes: [...PURPOSES],
      data_categories: [...DATA_CATEGORIES],
      tools: [],
      max_output_bytes: 65_536,
      prompts: { ...PROMPTS },
    })],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(profile.status, 0, profile.stderr);
  const profileId = String(profile.output['model_profile_id']);
  const version = Number(profile.output['model_profile_version']);
  const evaluated = await commandAsync(
    base.fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const activated = await commandAsync(
    base.fixture,
    ['model', 'activate', '--profile', profileId, '--version', String(version)],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    base.fixture,
    ['binding', 'publish', '--workspace', base.workspaceId, '--profile', profileId, '--config', jsonFile(base.fixture, 'retention-binding', {
      model_profile_version: version,
      purposes: [...PURPOSES],
      data_categories: [...DATA_CATEGORIES],
    })],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const template = command(
    base.fixture,
    ['report', 'template-publish', '--workspace', base.workspaceId, '--product', base.dataProductId, '--name', '保留报告', '--config', jsonFile(base.fixture, 'retention-template', {
      question: '2026-01-05 至 2026-01-20 的处理量合计是多少？',
      parameters: [{ name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-20' } }],
      query: {
        kind: 'aggregate',
        metrics: ['handled_total'],
        window: { start: '2026-01-05', end: '2026-01-20' },
        include_totals: true,
        limit: 100,
      },
      grounded_prompt: '只依据给定证据用简体中文撰写报告叙述，不得推测证据之外的数据或因果。',
      freshness: { max_age_minutes: 15 },
    })],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(template.status, 0, template.stderr);
  const generated = await commandAsync(
    base.fixture,
    ['report', 'generate', '--template', String(template.output['report_template_id'])],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const report = asRecord(generated.output['report']);
  return {
    ...base,
    endpoint,
    templateId: String(template.output['report_template_id']),
    reportId: String(report['report_id']),
  };
}

test('Reports and exports follow their settled retention clocks while current results stay readable', async (t) => {
  const s = await reportSurface();
  t.after(() => s.endpoint.close());

  const exported = ok(command(
    s.fixture,
    ['export', 'create', '--product', s.dataProductId, '--request', jsonFile(s.fixture, 'retention-export-request', {
      kind: 'aggregate',
      metrics: ['handled_total'],
      include_totals: true,
      limit: 100,
    })],
    { token: s.consumerToken },
  ));
  const exportId = String(exported['export_id']);
  editState(s.fixture, (state) => {
    for (const report of state.reports) report.generated_at = daysAgo(500);
    for (const record of state.exports) {
      if (record.export_id === exportId) {
        record.created_at = daysAgo(8);
        record.expires_at = daysAgo(7);
      }
    }
  });

  // The Report and export say retention expired on every surface; the current
  // Data Product and its current Release still answer exactly.
  const expiredReport = command(s.fixture, ['report', 'show', '--report', s.reportId], { token: s.consumerToken });
  assert.equal(expiredReport.status, 2, expiredReport.stdout);
  assert.equal(expiredReport.error['code'], 'RETENTION_EXPIRED');
  const listed = ok(command(s.fixture, ['report', 'list', '--workspace', s.workspaceId], { token: s.workspaceAdministratorToken }));
  assert.deepEqual(listed['reports'], []);
  const expiredExport = command(s.fixture, ['export', 'download', '--export', exportId], { token: s.consumerToken });
  assert.equal(expiredExport.status, 2, expiredExport.stdout);
  assert.equal(expiredExport.error['code'], 'EXPORT_ACCESS_EXPIRED');
  const current = ok(command(s.fixture, ['dataset', 'show', '--source', s.sourceId], { token: s.workspaceAdministratorToken }));
  assert.equal(current['dataset_release'], 2);

  const eligibility = evaluate(s);
  const reportEntry = planEntry(eligibility, (entry) => entry['record_kind'] === 'report');
  assert.equal(reportEntry['eligible'], true);
  const exportEntry = planEntry(eligibility, (entry) => entry['record_kind'] === 'export');
  assert.equal(exportEntry['eligible'], true);

  // One automatic tick deletes both under their settled clocks.
  const ticked = tick(s, new Date());
  assert.equal(asArray(ticked['ledger']).length > 0, true);
  assert.equal(stateOf(s.fixture).reports.length, 0);
  assert.equal(stateOf(s.fixture).exports.length, 0);
  assert.equal(existsSync(join(s.fixture.root, exported['object_path'] as string)), false);

  // The Purge Ledger keeps both explicitly expired after deletion.
  const goneReport = command(s.fixture, ['report', 'show', '--report', s.reportId], { token: s.consumerToken });
  assert.equal(goneReport.status, 2, goneReport.stdout);
  assert.equal(goneReport.error['code'], 'RETENTION_EXPIRED');
  const goneExport = command(s.fixture, ['export', 'download', '--export', exportId], { token: s.consumerToken });
  assert.equal(goneExport.status, 2, goneExport.stdout);
  assert.equal(goneExport.error['code'], 'RETENTION_EXPIRED');

  // Every retention response introduced by this ticket carries Chinese copy.
  const policy = policyShow(s);
  assertChineseCopy(policy['summary']);
  const hold = ok(command(
    s.fixture,
    ['retention', 'hold-create', '--scope', 'workspace', '--workspace', s.workspaceId, '--reason', '季度合规复核', '--review-at', new Date(Date.now() + DAY_MS).toISOString()],
    { token: s.workspaceAdministratorToken },
  ));
  assertChineseCopy(hold['summary']);
});
