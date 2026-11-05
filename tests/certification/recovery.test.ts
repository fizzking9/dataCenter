import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEVICES, readySource } from '../support/acquisition.js';
import { EXTENDED_LEDGER_CONTRACT, acquireAndRelease, publishLedgerProduct } from '../support/data-product.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { runOperator, type OperatorResult } from '../support/operator.js';
import {
  command,
  initializePlatform,
  jsonFile,
  registerTotp,
  sessionFor,
  totpSecretFor,
  type PlatformFixture,
} from '../support/platform.js';

const OPERATOR = 'recovery@example.invalid';
const MINUTE = 60_000;

function ok(result: OperatorResult): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.output;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Every regular file under one directory, so an assertion can read a whole set. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function backupRootOf(fixture: PlatformFixture): string {
  return join(fixture.scratch, 'off-host');
}

test('coordinated checkpoints measure a fifteen-minute RPO and missed checkpoints degrade health', () => {
  const fixture = initializePlatform();

  // A Deployment that has never checkpointed states that no RPO has been
  // established yet; it never claims a healthy protection it does not have.
  const initial = ok(command(fixture, ['status', '--operator', OPERATOR]));
  const initialBackup = asRecord(initial['backup']);
  assert.equal(initialBackup['health'], 'not_established');
  assert.equal(initialBackup['rpo_limit_seconds'], 900);
  assert.equal(initial['health'], 'healthy');

  // A checkpoint states the database position and the object position it was
  // coordinated with, and both keep moving as governed writes continue.
  const first = ok(command(fixture, ['checkpoint', '--operator', OPERATOR, '--at', iso(-20 * MINUTE)]));
  assert.equal(first['coordinated'], true);
  const firstDatabase = asRecord(first['database']);
  const firstObjects = asRecord(first['objects']);
  assert.match(String(firstDatabase['position']), /^[0-9a-f]{64}$/);
  assert.match(String(firstObjects['position']), /^[0-9a-f]{64}$/);
  assert.equal(firstObjects['count'], 0);
  assert.equal(asRecord(first['rpo'])['interval_seconds'], null);
  assert.equal(asRecord(first['wal'])['continuous'], true);
  assert.equal(asRecord(first['wal'])['checkpoint_sequence'], 1);
  assert.equal(typeof first['evidence_id'], 'string');

  // Twenty minutes later the recorded checkpoint is older than the settled
  // fifteen-minute RPO, and health is explicitly degraded rather than silent.
  const stale = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(stale['health'], 'degraded');
  const staleBackup = asRecord(stale['backup']);
  assert.equal(staleBackup['health'], 'degraded');
  assert.equal(staleBackup['last_checkpoint_id'], first['checkpoint_id']);
  assert.equal(Number(staleBackup['checkpoint_age_seconds']) >= 1200, true);
  assert.deepEqual(staleBackup['reasons'], ['checkpoint_stale']);

  // The checkpoint that closes the missed window reports the measured interval
  // and still holds health degraded until a later checkpoint proves the RPO.
  const second = ok(command(fixture, ['checkpoint', '--operator', OPERATOR]));
  const secondRpo = asRecord(second['rpo']);
  assert.equal(secondRpo['previous_checkpoint_id'], first['checkpoint_id']);
  assert.equal(Number(secondRpo['interval_seconds']) >= 1200, true);
  assert.equal(secondRpo['limit_seconds'], 900);
  assert.equal(secondRpo['met'], false);
  const gapped = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(gapped['health'], 'degraded');
  assert.deepEqual(asRecord(gapped['backup'])['reasons'], ['checkpoint_gap']);
  const secondDatabase = asRecord(second['database']);
  assert.equal(asRecord(second['wal'])['continuous'], true);
  assert.equal(asRecord(second['wal'])['previous_position'], firstDatabase['position']);
  assert.equal(asRecord(second['wal'])['checkpoint_sequence'], 2);

  const third = ok(command(fixture, ['checkpoint', '--operator', OPERATOR]));
  assert.equal(asRecord(third['rpo'])['met'], true);
  assert.equal(asRecord(third['wal'])['checkpoint_sequence'], 3);
  const healthy = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(healthy['health'], 'healthy');
  assert.deepEqual(asRecord(healthy['backup'])['reasons'], []);
});

test('a base backup set states every authoritative component, the settled cadence, and 35-day retention', () => {
  const published = publishLedgerProduct();
  const { fixture } = published;
  const backupRoot = backupRootOf(fixture);
  const created = ok(command(fixture, [
    'backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR,
  ]));

  assert.equal(created['kind'], 'base');
  assert.equal(created['schema_version'], 1);
  const cadence = asRecord(created['cadence']);
  assert.deepEqual(cadence, {
    base_backup_hours: 24,
    checkpoint_seconds: 900,
    object_replication_seconds: 900,
    wal: 'continuous',
  });
  const retention = asRecord(created['retention']);
  assert.equal(retention['days'], 35);
  assert.equal(
    Date.parse(String(retention['retain_until'])) - Date.parse(String(created['created_at'])),
    35 * 86_400_000,
  );

  // Every authoritative component is named with the digest of its stored bytes:
  // the governed database, the raw objects, configuration, release manifests,
  // the Audit Event chain, and the sequenced Purge Ledger.
  const components = (created['components'] as unknown[]).map((entry) => asRecord(entry));
  const roles = new Set(components.map((entry) => entry['role']));
  for (const role of ['database', 'objects', 'configuration', 'manifests', 'audit', 'purge_ledger']) {
    assert.equal(roles.has(role), true, `component role ${role} is missing`);
  }
  assert.equal(components.every((entry) => /^[0-9a-f]{64}$/.test(String(entry['sha256']))), true);
  assert.equal(components.filter((entry) => entry['role'] === 'objects').length, 1);
  const objectComponents = components.filter((entry) => entry['role'] === 'objects');
  assert.equal(objectComponents[0]?.['restores_to'], 'raw-acquisitions/' + String(objectComponents[0]?.['restores_to']).split('/').at(-1));

  // Only monitoring and rebuildable derived data are excluded, and the master
  // key is escrowed separately instead of travelling inside a recovery set.
  const excluded = (created['excluded'] as unknown[]).map((entry) => asRecord(entry));
  assert.deepEqual(excluded.map((entry) => entry['name']).sort(), ['derived_cache_indexes', 'monitoring']);
  assert.equal(excluded.every((entry) => entry['rebuildable'] === true), true);
  assert.deepEqual(created['escrowed_separately'], { master_key: true });
  assert.equal(created['secrets_included'], false);

  // The backup set is a durable off-host directory of encrypted payloads: no
  // business bytes and no master key material appear anywhere inside it.
  const backupDirectory = join(backupRoot, 'backups', String(created['backup_id']));
  const manifest = JSON.parse(readFileSync(join(backupDirectory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(manifest, JSON.parse(JSON.stringify(created, (key, value) => key === 'evidence_id' ? undefined : value)));
  const masterKeyBytes = readFileSync(fixture.masterKey);
  const text = filesUnder(backupDirectory)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.equal(text.includes('sn-001'), false, 'raw business payloads are encrypted');
  assert.equal(text.includes(masterKeyBytes.toString('hex')), false, 'the master key never enters a backup');
  assert.equal(text.includes(masterKeyBytes.toString('base64')), false);
  assert.equal(text.includes('master-key'), false);
  assert.equal(manifest['payloads_encrypted'], true);

  // The checkpoint enters the continuous off-host WAL journal, so the set names
  // the exact position the journal kept writing from.
  const journal = readFileSync(join(backupRoot, 'replication', 'checkpoints.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(journal.at(-1)?.['checkpoint_id'], created['checkpoint_id']);
  assert.equal(asRecord(journal.at(-1)?.['wal'] ?? {})['continuous'], true);
  assert.equal(asRecord(journal.at(-1)?.['objects'] ?? {})['replicated_at'], created['created_at']);

  // The sequenced Purge Ledger is replicated off-host with every base backup.
  const ledger = JSON.parse(readFileSync(join(backupRoot, 'ledger', 'purge-ledger.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(ledger['deployment_id'], created['deployment_id']);
  assert.equal(ledger['head_sequence'], 0);
  assert.deepEqual(ledger['entries'], []);

  const listed = ok(command(fixture, ['backup', 'list', '--backup-root', backupRoot, '--operator', OPERATOR]));
  assert.equal(listed['retention_days'], 35);
  const sets = (listed['backups'] as unknown[]).map((entry) => asRecord(entry));
  assert.equal(sets.length, 1);
  assert.equal(sets[0]?.['backup_id'], created['backup_id']);
  assert.equal(sets[0]?.['within_retention'], true);

  const shown = ok(command(fixture, [
    'backup', 'show', '--backup-root', backupRoot, '--backup', String(created['backup_id']), '--operator', OPERATOR,
  ]));
  assert.deepEqual(shown['integrity'], { verified: true, checked: components.length });
  assert.equal(asRecord(shown['manifest'])['backup_id'], created['backup_id']);
});

test('an isolated restoration verifies integrity, objects, keys, manifests, Provenance, and governed reads within a four-hour RTO', () => {
  const published = publishLedgerProduct();
  const { fixture } = published;
  const backupRoot = backupRootOf(fixture);
  const created = ok(command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]));
  const isolated = join(fixture.scratch, 'restored');

  const restored = ok(runOperator([
    'restore',
    '--root', isolated,
    '--backup-root', backupRoot,
    '--backup', String(created['backup_id']),
    '--master-key', fixture.masterKey,
    '--operator', OPERATOR,
  ], { env: fixture.docker }));
  assert.equal(restored['state'], 'verified_open');
  assert.equal(restored['service_open'], true);
  assert.equal(restored['deployment_id'], created['deployment_id']);
  assert.equal(restored['release'], '0.1.0');

  // Every verification the acceptance criteria name passes, and the restoration
  // reports the measured objective rather than a promise.
  const verification = asRecord(restored['verification']);
  assert.equal(asRecord(verification['integrity'])['passed'], true);
  assert.equal(asRecord(verification['objects'])['passed'], true);
  assert.equal(Number(asRecord(verification['objects'])['verified']) >= 1, true);
  const keys = asRecord(verification['keys']);
  assert.equal(keys['passed'], true);
  assert.equal(keys['data_key_unwrapped'], true);
  assert.equal(keys['decrypted'], 0);
  const manifests = asRecord(verification['manifests']);
  assert.equal(manifests['passed'], true);
  assert.equal(manifests['signature_verified'], true);
  const provenance = asRecord(verification['provenance']);
  assert.equal(provenance['passed'], true);
  assert.equal(Number(provenance['dataset_releases']) >= 1, true);
  assert.equal(provenance['dangling'], 0);
  const reads = asRecord(verification['governed_reads']);
  assert.equal(reads['passed'], true);
  assert.equal(reads['products'], 1);
  const firstRead = asRecord((reads['reads'] as unknown[])[0]);
  assert.equal(firstRead['data_product_id'], published.dataProductId);
  assert.equal(firstRead['returned'], 1);
  assert.equal(firstRead['provenance'], true);
  const rto = asRecord(restored['rto']);
  assert.equal(rto['met'], true);
  assert.equal(rto['limit_seconds'], 14_400);
  assert.equal(Number(rto['seconds']) <= 14_400, true);

  // Workers and external connectivity stay disabled on a restored Deployment,
  // and its state says so until an Operator explicitly enables each.
  assert.equal(restored['workers_enabled'], false);
  assert.equal(restored['connectivity_enabled'], false);
  const restoredStatus = ok(runOperator([
    'status', '--root', isolated, '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker }));
  assert.equal(restoredStatus['health'], 'healthy');
  assert.equal(restoredStatus['workers_enabled'], false);
  assert.equal(restoredStatus['connectivity_enabled'], false);
  assert.equal(asRecord(restoredStatus['restored'])['backup_id'], created['backup_id']);

  // The restored Deployment serves the same governed data to the same Consumer.
  const restoredFixture = { ...fixture, root: isolated };
  const sessionSecret = totpSecretFor(fixture, 'operations@example.invalid');
  registerTotp(restoredFixture, 'operations@example.invalid', sessionSecret);
  const operatorToken = sessionFor(restoredFixture, 'operations@example.invalid', 'operations-administrator');
  const queried = ok(runOperator([
    'product', 'query', '--product', published.dataProductId,
    '--request', jsonFile(restoredFixture, 'restored-request', { kind: 'records', limit: 10 }),
    '--root', isolated, '--master-key', fixture.masterKey, '--session-token', operatorToken,
  ], { env: fixture.docker }));
  assert.equal((queried['records'] as unknown[]).length, 3);

  // Enabling is explicit, audited, and idempotent; the master key stays escrowed
  // outside the restored Deployment, and evidence never carries it.
  const enabledWorkers = ok(runOperator([
    'enable-workers', '--root', isolated, '--operator', OPERATOR,
  ]));
  assert.equal(enabledWorkers['workers_enabled'], true);
  assert.equal(enabledWorkers['changed'], true);
  const enabledAgain = ok(runOperator(['enable-workers', '--root', isolated, '--operator', OPERATOR]));
  assert.equal(enabledAgain['changed'], false);
  const enabledConnectivity = ok(runOperator([
    'enable-connectivity', '--root', isolated, '--operator', OPERATOR,
  ]));
  assert.equal(enabledConnectivity['connectivity_enabled'], true);
  assert.equal(enabledConnectivity['changed'], true);
  const afterEnable = ok(runOperator([
    'status', '--root', isolated, '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker }));
  assert.equal(afterEnable['workers_enabled'], true);
  assert.equal(afterEnable['connectivity_enabled'], true);

  const evidence = readFileSync(join(isolated, 'evidence', `${String(restored['evidence_id'])}.json`), 'utf8');
  const masterKeyBytes = readFileSync(fixture.masterKey);
  assert.equal(evidence.includes(masterKeyBytes.toString('hex')), false);
  assert.equal(evidence.includes(fixture.masterKey), false);
  assert.equal(evidence.includes('"workers_enabled": false'), true);
  assert.equal(evidence.includes('"rto_met": true'), true);
  assert.equal(filesUnder(isolated).some((path) => path.endsWith('mounted-master-key')), false);
});

const LEDGER_NEXT = [
  '设备SN,城市,处理量,结算金额,上报日期',
  'sn-001,杭州,4,120.50,2026-01-05',
  'sn-002,上海,5,300.00,2026-01-12',
  'sn-003,,2,,2026-01-20',
].join('\n');

/** One Workspace with a historical and a current Dataset and Data Product Release. */
function twoReleaseSurface() {
  const base = publishLedgerProduct();
  acquireAndRelease(base.fixture, base.workspaceAdministratorToken, base.sourceId, LEDGER_NEXT, 'ledger-next.csv');
  const republished = command(base.fixture, [
    'product', 'publish',
    '--source', base.sourceId,
    '--name', '设备维修台账',
    '--contract', jsonFile(base.fixture, 'contract-again', EXTENDED_LEDGER_CONTRACT),
  ], { token: base.workspaceAdministratorToken });
  assert.equal(republished.status, 0, republished.stderr);
  return base;
}

function stateFile(fixture: PlatformFixture): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8')) as Record<string, unknown>;
}

test('restoring an older backup replays the newest Purge Ledger so deleted content never reappears', () => {
  const s = twoReleaseSurface();
  const { fixture } = s;
  const backupRoot = backupRootOf(fixture);
  const older = ok(command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]));

  const before = stateFile(fixture);
  const datasets = before['datasets'] as Array<{ dataset_id: string; releases: Array<{ release: number; created_at: string }> }>;
  const products = before['data_products'] as Array<{ data_product_id: string; releases: Array<{ release: number; created_at: string }> }>;
  const raws = before['raw_acquisitions'] as Array<{ raw_id: string; received_at: string; object_path: string }>;
  assert.equal(datasets[0]?.releases.length, 2);
  assert.equal(products[0]?.releases.length, 2);
  const rawObjects = raws.map((raw) => join(fixture.root, raw.object_path));
  assert.equal(rawObjects.every((path) => existsSync(path)), true);

  // The historical Release and its raw payloads age past the settled retention,
  // and an Operator Purges exactly the historical Dataset Release.
  const fiveHundredDaysAgo = new Date(Date.now() - 500 * 86_400_000).toISOString();
  const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const edited = stateFile(fixture);
  for (const dataset of edited['datasets'] as typeof datasets) {
    for (const release of dataset.releases) if (release.release === 1) release.created_at = fiveHundredDaysAgo;
  }
  for (const product of edited['data_products'] as typeof products) {
    for (const release of product.releases) if (release.release === 1) release.created_at = fiveHundredDaysAgo;
  }
  for (const raw of edited['raw_acquisitions'] as typeof raws) raw.received_at = fortyDaysAgo;
  writeFileSync(join(fixture.root, 'state', 'platform.json'), `${JSON.stringify(edited, null, 2)}\n`);

  const datasetId = String(datasets[0]?.dataset_id);
  void datasetId;
  // An automatic retention tick Purges exactly the eligible historical content:
  // the aged Raw Acquisitions and the historical Dataset and Product Releases.
  const ticked = ok(command(fixture, ['retention', 'tick'], { token: s.deploymentAdministratorToken }));
  assert.equal(ticked['health'], 'healthy');
  const ledgerEntries = stateFile(fixture)['purge_ledger'] as Array<{
    sequence: number;
    purged: Array<{ record_kind: string; record_id: string }>;
  }>;
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0]?.sequence, 1);
  assert.equal(ledgerEntries[0]?.purged.some((record) => record.record_kind === 'dataset_release' && record.record_id.endsWith('#1')), true);
  assert.equal(ledgerEntries[0]?.purged.some((record) => record.record_kind === 'data_product_release' && record.record_id.endsWith('#1')), true);
  assert.equal(ledgerEntries[0]?.purged.some((record) => record.record_kind === 'data_product_release' && record.record_id.endsWith('#2')), false);
  const purgedRawIds = new Set(ledgerEntries[0]?.purged
    .filter((record) => record.record_kind === 'raw_acquisition')
    .map((record) => record.record_id));
  assert.equal(purgedRawIds.size, 2);

  // A later base backup replicates the sequenced ledger off-host; the older
  // recovery set still holds the content the Purge retired.
  const newer = ok(command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]));
  const replica = JSON.parse(readFileSync(join(backupRoot, 'ledger', 'purge-ledger.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(replica['head_sequence'], 1);
  assert.equal((replica['entries'] as unknown[]).length, 1);

  // Restoring the older set applies the newest ledger: the purged Release stays
  // explicitly expired, its objects stay deleted, and the current Release serves.
  const isolated = join(fixture.scratch, 'restored-older');
  const restored = ok(runOperator([
    'restore', '--root', isolated, '--backup-root', backupRoot, '--backup', String(older['backup_id']),
    '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker }));
  assert.equal(restored['service_open'], true);
  const ledger = asRecord(restored['purge_ledger']);
  assert.equal(ledger['applied_through_sequence'], 1);
  assert.equal(ledger['entries'], 1);
  assert.equal(Number(ledger['removed']) >= 4, true);
  assert.equal(ledger['purged_records'], ledgerEntries[0]?.purged.length);
  const refusals = asRecord(asRecord(restored['verification'])['governed_reads'])['purged_refusals'];
  assert.equal(Number(asRecord(refusals)['confirmed']) >= 1, true);
  assert.equal(asRecord(refusals)['failed'], 0);

  const restoredState = JSON.parse(readFileSync(join(isolated, 'state', 'platform.json'), 'utf8')) as Record<string, unknown>;
  const restoredDatasets = restoredState['datasets'] as typeof datasets;
  assert.deepEqual(restoredDatasets[0]?.releases.map((release) => release.release), [2]);
  const restoredProducts = restoredState['data_products'] as typeof products;
  assert.deepEqual(restoredProducts[0]?.releases.map((release) => release.release), [2]);
  assert.deepEqual(restoredState['raw_acquisitions'], []);
  assert.equal(rawObjects.some((path) => existsSync(join(isolated, path.slice(fixture.root.length)))), false);

  const restoredFixture = { ...fixture, root: isolated };
  registerTotp(restoredFixture, 'operations@example.invalid', totpSecretFor(fixture, 'operations@example.invalid'));
  const restoredToken = sessionFor(restoredFixture, 'operations@example.invalid', 'operations-administrator');
  const expired = runOperator([
    'product', 'query', '--product', s.dataProductId, '--request', jsonFile(restoredFixture, 'purged-request', { kind: 'records', release: 1, limit: 10 }),
    '--root', isolated, '--master-key', fixture.masterKey, '--session-token', restoredToken,
  ], { env: fixture.docker });
  assert.equal(expired.status, 2);
  assert.equal(expired.error['code'], 'RETENTION_EXPIRED');
  const current = ok(runOperator([
    'product', 'query', '--product', s.dataProductId, '--request', jsonFile(restoredFixture, 'current-request', { kind: 'records', limit: 10 }),
    '--root', isolated, '--master-key', fixture.masterKey, '--session-token', restoredToken,
  ], { env: fixture.docker }));
  assert.equal((current['records'] as unknown[]).length, 3);

  // Restoring the newer set is idempotent: the same ledger finds the records
  // already absent instead of deleting anything twice.
  const second = join(fixture.scratch, 'restored-newer');
  const replayed = ok(runOperator([
    'restore', '--root', second, '--backup-root', backupRoot, '--backup', String(newer['backup_id']),
    '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker }));
  assert.equal(asRecord(replayed['purge_ledger'])['removed'], 0);
  assert.equal(Number(asRecord(replayed['purge_ledger'])['already_absent']) >= 4, true);
});

test('a damaged, uncoordinated, wrongly-keyed, or ledger-less recovery fails closed and opens nothing', () => {
  const s = publishLedgerProduct();
  const { fixture } = s;
  const backupRoot = backupRootOf(fixture);
  const backup = ok(command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]));

  // A recovery set whose stored bytes no longer match the manifest is refused
  // before any target is created.
  const backed = join(backupRoot, 'backups', String(backup['backup_id']));
  const component = JSON.parse(readFileSync(join(backed, 'manifest.json'), 'utf8')) as {
    components: Array<{ role: string; path: string }>;
  };
  const databasePath = component.components.find((entry) => entry.role === 'database')?.path ?? '';
  const original = readFileSync(join(backed, databasePath));
  appendFileSync(join(backed, databasePath), 'corruption');
  const verified = command(fixture, [
    'backup', 'verify', '--backup-root', backupRoot, '--backup', String(backup['backup_id']), '--operator', OPERATOR,
  ]);
  assert.equal(verified.status, 2);
  assert.equal(verified.error['code'], 'BACKUP_INTEGRITY_FAILED');
  const refusedTarget = join(fixture.scratch, 'restored-damaged');
  const damaged = runOperator([
    'restore', '--root', refusedTarget, '--backup-root', backupRoot, '--backup', String(backup['backup_id']),
    '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker });
  assert.equal(damaged.status, 2);
  assert.equal(damaged.error['code'], 'BACKUP_INTEGRITY_FAILED');
  assert.equal(existsSync(refusedTarget), false);
  writeFileSync(join(backed, databasePath), original);

  // A master key escrowed for another Deployment opens nothing, and the target
  // is never created.
  const wrongKey = join(fixture.scratch, 'other-master-key');
  writeFileSync(wrongKey, Buffer.alloc(32, 7));
  const mismatched = runOperator([
    'restore', '--root', join(fixture.scratch, 'restored-wrong-key'), '--backup-root', backupRoot,
    '--backup', String(backup['backup_id']), '--master-key', wrongKey, '--operator', OPERATOR,
  ], { env: fixture.docker });
  assert.equal(mismatched.status, 2);
  assert.equal(mismatched.error['code'], 'RESTORE_KEY_MISMATCH');

  // Without the off-host ledger a restoration cannot promise purged content
  // stays deleted, so it refuses instead of guessing.
  const ledgerPath = join(backupRoot, 'ledger', 'purge-ledger.json');
  const ledger = readFileSync(ledgerPath, 'utf8');
  rmSync(ledgerPath, { force: true });
  const ledgerless = runOperator([
    'restore', '--root', join(fixture.scratch, 'restored-no-ledger'), '--backup-root', backupRoot,
    '--backup', String(backup['backup_id']), '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker });
  assert.equal(ledgerless.status, 2);
  assert.equal(ledgerless.error['code'], 'RESTORE_LEDGER_MISSING');
  const tampered = JSON.parse(ledger) as { entries: unknown[] };
  tampered.entries = [{
    sequence: 1,
    purge_id: 'not-a-real-purge',
    mode: 'manual',
    recorded_at: new Date().toISOString(),
    scope: { kind: 'workspace', workspace_id: null, source_id: null, dataset_id: null, dataset_release: null, target_id: null },
    purged: [],
  }];
  writeFileSync(ledgerPath, JSON.stringify(tampered));
  const tamperedRestore = runOperator([
    'restore', '--root', join(fixture.scratch, 'restored-tampered-ledger'), '--backup-root', backupRoot,
    '--backup', String(backup['backup_id']), '--master-key', fixture.masterKey, '--operator', OPERATOR,
  ], { env: fixture.docker });
  assert.equal(tamperedRestore.status, 2);
  assert.equal(tamperedRestore.error['code'], 'RESTORE_LEDGER_TAMPERED');
  writeFileSync(ledgerPath, ledger);

  // A referenced object missing from the object store makes database and objects
  // disagree: no checkpoint is recorded, no backup is taken, and health says so.
  const raw = (stateFile(fixture)['raw_acquisitions'] as Array<{ object_path: string }>)[0];
  assert.ok(raw !== undefined);
  rmSync(join(fixture.root, raw.object_path), { force: true });
  const uncoordinated = command(fixture, ['checkpoint', '--operator', OPERATOR]);
  assert.equal(uncoordinated.status, 2);
  assert.equal(uncoordinated.error['code'], 'CHECKPOINT_OBJECTS_UNCOORDINATED');
  const unbacked = command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]);
  assert.equal(unbacked.status, 2);
  assert.equal(unbacked.error['code'], 'CHECKPOINT_OBJECTS_UNCOORDINATED');
  const degraded = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(degraded['health'], 'degraded');
  assert.equal((asRecord(degraded['backup'])['reasons'] as string[]).includes('objects_uncoordinated'), true);
});

test('restored workers and external connectivity remain disabled until explicitly enabled', async () => {
  const source = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 4)) },
      { body: pageBody(DEVICES.slice(4)) },
    ],
  });
  const ready = await readySource(source, { name: '设备接口' });
  try {
    const { fixture } = ready;
    const backupRoot = backupRootOf(fixture);
    const queued = ok(command(fixture, ['acquisition', 'enqueue', '--source', ready.sourceId], {
      token: ready.workspaceAdministratorToken,
    }));
    assert.equal(typeof queued['acquisition_run_id'], 'string');
    const worked = ok(command(fixture, ['acquisition', 'work', '--source', ready.sourceId], {
      token: ready.workspaceAdministratorToken,
    }));
    assert.equal(worked['status'], 'complete');

    const backup = ok(command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]));
    const isolated = join(fixture.scratch, 'restored-connector');
    const restored = ok(runOperator([
      'restore', '--root', isolated, '--backup-root', backupRoot, '--backup', String(backup['backup_id']),
      '--master-key', fixture.masterKey, '--operator', OPERATOR,
    ], { env: fixture.docker }));
    const keys = asRecord(asRecord(restored['verification'])['keys']);
    assert.equal(keys['passed'], true);
    assert.equal(Number(keys['sealed_credentials']) >= 1, true);
    assert.equal(keys['decrypted'], keys['sealed_credentials']);
    assert.equal(Number(asRecord(asRecord(restored['verification'])['objects'])['verified']) >= 1, true);

    const restoredFixture = { ...fixture, root: isolated };
    registerTotp(restoredFixture, 'operations@example.invalid', totpSecretFor(fixture, 'operations@example.invalid'));
    const token = sessionFor(restoredFixture, 'operations@example.invalid', 'operations-administrator');
    const run = (args: string[]) => runOperator([
      ...args, '--root', isolated, '--master-key', fixture.masterKey, '--session-token', token,
    ], { env: fixture.docker });

    // A queued Run is durable, but a restored worker refuses to execute it.
    ok(run(['acquisition', 'enqueue', '--source', ready.sourceId]));
    const blockedWorker = run(['acquisition', 'work', '--source', ready.sourceId]);
    assert.equal(blockedWorker.status, 2);
    assert.equal(blockedWorker.error['code'], 'WORKERS_DISABLED');

    // Enabling workers still leaves the outside world unreachable.
    const enabledWorkers = ok(runOperator(['enable-workers', '--root', isolated, '--operator', OPERATOR]));
    assert.equal(enabledWorkers['changed'], true);
    const blockedConnectivity = run(['acquisition', 'work', '--source', ready.sourceId]);
    assert.equal(blockedConnectivity.status, 2);
    assert.equal(blockedConnectivity.error['code'], 'CONNECTIVITY_DISABLED');

    // Only an explicit connectivity command lets the restored worker acquire,
    // and the sealed credential it injects is the restored one.
    ok(runOperator(['enable-connectivity', '--root', isolated, '--operator', OPERATOR]));
    const completed = ok(run(['acquisition', 'work', '--source', ready.sourceId]));
    assert.equal(completed['status'], 'complete');
    const requests = source.requests().filter((request) => request.path === '/api/devices');
    assert.equal(requests.length >= 4, true);

    const status = ok(runOperator([
      'status', '--root', isolated, '--master-key', fixture.masterKey, '--operator', OPERATOR,
    ], { env: fixture.docker }));
    assert.equal(status['workers_enabled'], true);
    assert.equal(status['connectivity_enabled'], true);
    assert.equal(status['health'], 'healthy');
  } finally {
    await ready.close();
  }
});
