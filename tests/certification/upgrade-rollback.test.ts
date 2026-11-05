import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createBundleFixture,
  type BundleFixture,
  type BundleFixtureOptions,
} from '../support/bundle.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  acquireAndRelease,
  publishLedgerProduct,
  publishSource,
} from '../support/data-product.js';
import { fakeDockerEnvironment } from '../support/fake-docker.js';
import type { OperatorResult } from '../support/operator.js';
import {
  command,
  initializePlatform,
  type PlatformFixture,
} from '../support/platform.js';

const OPERATOR = 'lifecycle@example.invalid';

function ok(result: OperatorResult): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.output;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

/** A signed bundle chained to the installed trust root, as a vendor upgrade is. */
function chainedBundle(
  fixture: PlatformFixture,
  name: string,
  release: string,
  upgradeFrom: string[],
  options: Omit<BundleFixtureOptions, 'release' | 'upgradeFrom' | 'releaseKeys' | 'licenseKeys'> = {},
): BundleFixture {
  return createBundleFixture(join(fixture.scratch, name), {
    release,
    upgradeFrom,
    releaseKeys: {
      publicKeyPem: fixture.bundle.releasePublicKeyPem,
      privateKey: fixture.bundle.releasePrivateKey,
    },
    licenseKeys: {
      publicKeyPem: fixture.bundle.licensePublicKeyPem,
      privateKey: fixture.bundle.licensePrivateKey,
    },
    ...options,
  });
}

function signedArguments(fixture: PlatformFixture, bundle: BundleFixture): string[] {
  return [
    '--bundle', bundle.directory,
    '--release-key', join(fixture.root, 'trust', 'release-key.pem'),
    '--confirm-release-key-fingerprint', fixture.bundle.releaseFingerprint,
    '--operator', OPERATOR,
  ];
}

function preflight(fixture: PlatformFixture, bundle: BundleFixture): OperatorResult {
  return command(fixture, ['preflight', ...signedArguments(fixture, bundle)]);
}

function upgrade(fixture: PlatformFixture, bundle: BundleFixture): OperatorResult {
  return command(fixture, ['upgrade', ...signedArguments(fixture, bundle)]);
}

function snapshot(fixture: PlatformFixture): { platform: string; deployment: string } {
  return {
    platform: readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8'),
    deployment: readFileSync(join(fixture.root, 'deployment.json'), 'utf8'),
  };
}

function assertUnchanged(fixture: PlatformFixture, before: { platform: string; deployment: string }): void {
  const after = snapshot(fixture);
  assert.equal(after.platform, before.platform, 'the governed database changed before mutation was authorized');
  assert.equal(after.deployment, before.deployment, 'the Deployment configuration changed before mutation was authorized');
}

test('unsupported paths, ineligible bundles, missing previous images, and unhealthy stores stop before mutation', async (context) => {
  const fixture = initializePlatform({ highestEligibleRelease: '0.2.0' });
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const skipped = chainedBundle(fixture, 'bundle-0.3.0', '0.3.0', ['0.1.0']);
  const undeclared = chainedBundle(fixture, 'bundle-undeclared', '0.2.0', []);
  const uninstallable = chainedBundle(fixture, 'bundle-uninstallable', '0.2.0', ['0.1.0'], { installable: false });
  const wrongArchitecture = chainedBundle(fixture, 'bundle-arm64', '0.2.0', ['0.1.0'], { architecture: 'arm64' });

  const rejected: Array<{ name: string; bundle: BundleFixture; code: string; docker?: NodeJS.ProcessEnv }> = [
    { name: 'a skipped release', bundle: skipped, code: 'UPGRADE_PATH_UNSUPPORTED' },
    { name: 'an undeclared compatibility path', bundle: undeclared, code: 'UPGRADE_PATH_UNSUPPORTED' },
    { name: 'an uninstallable bundle', bundle: uninstallable, code: 'BUNDLE_UNSUPPORTED' },
    { name: 'a bundle for another architecture', bundle: wrongArchitecture, code: 'BUNDLE_ARCHITECTURE_UNSUPPORTED' },
    {
      name: 'unhealthy stores',
      bundle: next,
      code: 'RUNTIME_UNHEALTHY',
      docker: fakeDockerEnvironment(join(fixture.scratch, 'unhealthy'), { health: 'unhealthy' }),
    },
  ];
  for (const entry of rejected) {
    await context.test(entry.name, () => {
      const before = snapshot(fixture);
      const result = entry.docker === undefined
        ? preflight(fixture, entry.bundle)
        : command({ ...fixture, docker: entry.docker }, ['preflight', ...signedArguments(fixture, entry.bundle)]);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.error.code, entry.code);
      assertUnchanged(fixture, before);
    });
  }

  await context.test('missing previous images', () => {
    rmSync(join(fixture.root, 'releases', '0.1.0', 'images', 'minio.tar'));
    const before = snapshot(fixture);
    const result = preflight(fixture, next);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.error.code, 'PREVIOUS_RELEASE_IMAGES_MISSING');
    assertUnchanged(fixture, before);
  });

  // A license that names only the installed release refuses the target before
  // any image, store, or checkpoint work is attempted.
  await context.test('a target beyond the license entitlement', () => {
    const licensedOnly = initializePlatform({ highestEligibleRelease: '0.1.0' });
    const target = chainedBundle(licensedOnly, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
    const before = snapshot(licensedOnly);
    const result = preflight(licensedOnly, target);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.error.code, 'LICENSE_RELEASE_INELIGIBLE');
    assertUnchanged(licensedOnly, before);
  });
});

test('a failed coordinated checkpoint stops an upgrade before mutation', () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.0' });
  const { fixture } = published;
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);

  const preflightResult = ok(preflight(fixture, next));
  assert.equal(preflightResult['passed'], true);
  assert.equal(preflightResult['from_release'], '0.1.0');
  assert.equal(preflightResult['to_release'], '0.2.0');
  assert.equal(asRecord(preflightResult['previous_images'])['images'], 2);
  assert.deepEqual(asRecord(preflightResult['stores'])['services'], ['minio', 'postgres']);
  assert.equal(asRecord(preflightResult['queues'])['pending'], 0);

  // The database still references the object, so coordinate it no longer.
  const state = JSON.parse(readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8')) as {
    raw_acquisitions: Array<{ object_path: string }>;
  };
  assert.equal(state.raw_acquisitions.length >= 1, true);
  rmSync(join(fixture.root, state.raw_acquisitions[0]!.object_path));
  const before = snapshot(fixture);

  const refused = upgrade(fixture, next);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(refused.error.code, 'CHECKPOINT_OBJECTS_UNCOORDINATED');
  assertUnchanged(fixture, before);
  const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(status['service_open'], true);
  assert.equal(status['release'], '0.1.0');
});

test('a signed N to N+1 upgrade applies locked expand-only migrations and verifies every governed surface', () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.0' });
  const { fixture } = published;
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);

  const upgraded = ok(upgrade(fixture, next));
  assert.equal(upgraded['status'], 'upgraded');
  assert.equal(upgraded['from_release'], '0.1.0');
  assert.equal(upgraded['to_release'], '0.2.0');
  assert.equal(upgraded['service_open'], true);
  assert.equal(upgraded['state'], 'verify_pending');
  assert.equal(upgraded['checkpoint_required'], true);
  const migrations = asRecord(upgraded['migrations']);
  assert.equal(migrations['expand_only'], true);
  assert.equal(migrations['destructive'], 0);
  assert.equal(migrations['applied_steps'], 3);
  assert.equal(migrations['skipped_steps'], 0);
  const window = asRecord(upgraded['rollback_window']);
  assert.equal(window['open'], true);
  assert.equal(window['eligible'], true);
  assert.equal(window['from_release'], '0.1.0');
  assert.equal(window['to_release'], '0.2.0');

  // The coordinated checkpoint and the release switch are both durable facts.
  const checkpoints = JSON.parse(readFileSync(join(fixture.root, 'state', 'schema.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(checkpoints['schema_version'], 9);
  assert.equal(checkpoints['expand_only'], true);
  const ledger = JSON.parse(readFileSync(join(fixture.root, 'upgrades', 'ledger.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(ledger['store_schema_version'], 9);
  const applied = (ledger['migrations'] as Array<Record<string, unknown>>)[0]!;
  assert.equal(applied['id'], '0.2.0-expand-catalog-indexes');
  assert.equal(applied['expand_only'], true);
  assert.deepEqual((applied['steps'] as Array<Record<string, unknown>>).map((step) => step['name']), [
    'backfill-contract-lines',
    'rebuild-derived-catalog-index',
    'record-expanded-store-schema',
  ]);

  const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(status['release'], '0.2.0');
  assert.equal(status['service_open'], true);
  assert.equal(asRecord(status['rollback_window'])['open'], true);

  const verified = ok(command(fixture, ['verify', '--operator', OPERATOR]));
  assert.equal(verified['passed'], true);
  assert.equal(verified['store_schema_version'], 9);
  assert.equal(asRecord(verified['migrations'])['expand_only'], true);
  const checks = asRecord(verified['checks']);
  const names = ['stores', 'objects', 'keys', 'queues', 'identities', 'workspace_isolation', 'releases', 'provenance', 'consumer_reads'];
  for (const name of names) {
    assert.equal(asRecord(checks[name])['passed'], true, `${name} did not pass: ${JSON.stringify(checks[name])}`);
  }
  assert.deepEqual(asRecord(checks['stores'])['services'], ['minio', 'postgres']);
  assert.equal(Number(asRecord(checks['objects'])['verified']) >= 1, true);
  assert.equal(asRecord(checks['keys'])['data_key_unwrapped'], true);
  assert.equal(asRecord(checks['queues'])['pending'], 0);
  assert.equal(asRecord(checks['identities'])['violations'], 0);
  assert.equal(Number(asRecord(checks['identities'])['users']) >= 3, true);
  assert.equal(asRecord(checks['workspace_isolation'])['violations'], 0);
  assert.equal(asRecord(checks['workspace_isolation'])['workspaces'], 1);
  assert.equal(Number(asRecord(checks['releases'])['dataset_releases']) >= 1, true);
  assert.equal(Number(asRecord(checks['releases'])['product_releases']) >= 1, true);
  assert.equal(asRecord(checks['provenance'])['dangling'], 0);
  const reads = asRecord(checks['consumer_reads']);
  assert.equal(Number(reads['products']) >= 1, true);
  const firstRead = asRecord((reads['reads'] as unknown[])[0]);
  assert.equal(firstRead['data_product_id'], published.dataProductId);
  assert.equal(Number(firstRead['returned']) >= 1, true);
  assert.equal(firstRead['provenance'], true);

  const afterVerify = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(afterVerify['state'], 'verified_open');

  // Verification evidence is durable and carries no master key or business bytes.
  const evidence = readFileSync(join(fixture.root, 'evidence', `${String(verified['evidence_id'])}.json`), 'utf8');
  assert.equal(evidence.includes(fixture.masterKey), false);
  assert.equal(evidence.includes('sn-001'), false);
  assert.equal(evidence.includes('secrets_included": false'), true);

  const queried = ok(command(fixture, [
    'product', 'query', '--product', published.dataProductId,
    '--request', jsonFor(fixture, 'post-upgrade-read', { kind: 'records', limit: 10 }),
  ], { token: published.workspaceAdministratorToken }));
  assert.equal((queried['records'] as unknown[]).length, 3);
});

test('post-upgrade writes stay readable and governable after an offline Application Rollback', () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.0' });
  const { fixture } = published;
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);

  ok(upgrade(fixture, next));
  ok(command(fixture, ['verify', '--operator', OPERATOR]));

  // A governed write made under the new release, after the checkpoint.
  const postSource = publishSource(fixture, published.workspaceAdministratorToken, published.workspaceId, {
    name: '升级后台账',
  });
  acquireAndRelease(fixture, published.workspaceAdministratorToken, postSource, undefined, 'post-upgrade.csv');
  const postProduct = ok(command(fixture, [
    'product', 'publish',
    '--source', postSource,
    '--name', '升级后台账',
    '--contract', jsonFor(fixture, 'post-upgrade-contract', EXTENDED_LEDGER_CONTRACT),
  ], { token: published.workspaceAdministratorToken }));
  const postProductId = String(postProduct['data_product_id']);

  // Rollback has to work from local images alone: the original media is gone.
  renameSync(next.directory, join(fixture.scratch, 'offline-media'));
  writeFileSync(String(fixture.docker.DC_DOCKER_LOG), '');

  const rolledBack = ok(command(fixture, ['rollback', '--operator', OPERATOR]));
  assert.equal(rolledBack['from_release'], '0.2.0');
  assert.equal(rolledBack['to_release'], '0.1.0');
  assert.equal(rolledBack['release'], '0.1.0');
  assert.equal(rolledBack['service_open'], true);
  assert.equal(rolledBack['down_migrations'], 0);
  assert.equal(rolledBack['state_schema_version'], 9);
  assert.equal(rolledBack['data_unchanged'], true);
  assert.equal(rolledBack['offline'], true);
  assert.equal(Number(rolledBack['records_after_upgrade']) >= 2, true);
  const closed = asRecord(rolledBack['rollback_window']);
  assert.equal(closed['open'], false);
  assert.equal(closed['eligible'], false);
  assert.equal(closed['closed_by'], 'rollback');

  const calls = readFileSync(String(fixture.docker.DC_DOCKER_LOG), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.some((args) => args[0] === 'pull'), false, 'Application Rollback must not pull from a registry');
  const up = calls.find((args) => args.includes('up'));
  assert.ok(up?.includes('--pull'));
  assert.ok(up?.includes('never'));

  // The previous application serves the pre-upgrade and the post-upgrade writes.
  const original = ok(command(fixture, [
    'product', 'query', '--product', published.dataProductId,
    '--request', jsonFor(fixture, 'rollback-read-original', { kind: 'records', limit: 10 }),
  ], { token: published.workspaceAdministratorToken }));
  assert.equal((original['records'] as unknown[]).length, 3);
  const written = ok(command(fixture, [
    'product', 'query', '--product', postProductId,
    '--request', jsonFor(fixture, 'rollback-read-written', { kind: 'records', limit: 10 }),
  ], { token: published.workspaceAdministratorToken }));
  assert.equal((written['records'] as unknown[]).length, 3);

  // The previous application can still govern new data written after rollback.
  const governedSource = publishSource(fixture, published.workspaceAdministratorToken, published.workspaceId, {
    name: '回滚后台账',
  });
  acquireAndRelease(fixture, published.workspaceAdministratorToken, governedSource, undefined, 'after-rollback.csv');
  const governedProduct = ok(command(fixture, [
    'product', 'publish',
    '--source', governedSource,
    '--name', '回滚后台账产品',
    '--contract', jsonFor(fixture, 'after-rollback-contract', EXTENDED_LEDGER_CONTRACT),
  ], { token: published.workspaceAdministratorToken }));
  const governedRead = ok(command(fixture, [
    'product', 'query', '--product', String(governedProduct['data_product_id']),
    '--request', jsonFor(fixture, 'after-rollback-read', { kind: 'records', limit: 10 }),
  ], { token: published.workspaceAdministratorToken }));
  assert.equal((governedRead['records'] as unknown[]).length, 3);

  const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(status['release'], '0.1.0');
  assert.equal(status['service_open'], true);
  assert.equal(asRecord(status['rollback_window'])['eligible'], false);

  const repeated = command(fixture, ['rollback', '--operator', OPERATOR]);
  assert.equal(repeated.status, 2);
  assert.equal(repeated.error.code, 'ROLLBACK_NOT_ELIGIBLE');

  const evidence = readFileSync(join(fixture.root, 'evidence', `${String(rolledBack['evidence_id'])}.json`), 'utf8');
  assert.equal(evidence.includes(`"down_migrations": 0`), true);
  assert.equal(evidence.includes(`"offline": true`), true);
  assert.equal(evidence.includes(fixture.masterKey), false);
});

test('a failed migration stays closed, locked against concurrency, and restartable without repeating steps', () => {
  const fixture = initializePlatform({ highestEligibleRelease: '0.2.0' });
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const upgrades = join(fixture.root, 'upgrades');

  // A live migration lock refuses a second upgrade before the checkpoint.
  mkdirSync(upgrades, { recursive: true });
  writeFileSync(join(upgrades, 'lock'), `${JSON.stringify({
    pid: process.pid,
    acquired_at: new Date().toISOString(),
    upgrade_id: 'another-operator',
  })}\n`);
  const before = snapshot(fixture);
  const locked = upgrade(fixture, next);
  assert.equal(locked.status, 2, locked.stderr);
  assert.equal(locked.error.code, 'UPGRADE_LOCKED');
  assertUnchanged(fixture, before);
  rmSync(join(upgrades, 'lock'));

  // The derived index cannot be rebuilt while its directory path is a file.
  writeFileSync(join(fixture.root, 'state', 'indexes'), 'not a directory\n');
  // A lock left by a dead process is a crash artifact, not a reason to refuse.
  writeFileSync(join(upgrades, 'lock'), `${JSON.stringify({
    pid: 999_999,
    acquired_at: new Date().toISOString(),
    upgrade_id: 'crashed-operator',
  })}\n`);
  const failed = upgrade(fixture, next);
  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(failed.error.code, 'MIGRATION_FAILED');

  const closed = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(closed['service_open'], false);
  assert.equal(closed['health'], 'closed');
  assert.equal(closed['release'], '0.1.0');
  assert.equal(closed['state'], 'upgrade_failed');
  assert.equal(existsSync(join(upgrades, 'lock')), false);

  const partial = JSON.parse(readFileSync(join(upgrades, 'ledger.json'), 'utf8')) as {
    store_schema_version: number;
    migrations: Array<{ id: string; steps: Array<{ name: string; applied_at: string }> }>;
  };
  assert.equal(partial.store_schema_version, 8);
  assert.equal(partial.migrations.length, 1);
  assert.deepEqual(partial.migrations[0]!.steps.map((step) => step.name), ['backfill-contract-lines']);
  const firstStepAt = partial.migrations[0]!.steps[0]!.applied_at;

  // Correcting the cause resumes the same migration; the completed step is not repeated.
  rmSync(join(fixture.root, 'state', 'indexes'));
  const resumed = ok(upgrade(fixture, next));
  assert.equal(resumed['status'], 'upgraded');
  assert.equal(resumed['attempt'], 2);
  assert.equal(resumed['checkpoint_required'], false);
  const migrations = asRecord(resumed['migrations']);
  assert.equal(migrations['applied_steps'], 2);
  assert.equal(migrations['skipped_steps'], 1);

  const completed = JSON.parse(readFileSync(join(upgrades, 'ledger.json'), 'utf8')) as {
    store_schema_version: number;
    migrations: Array<{ steps: Array<{ name: string; applied_at: string }> }>;
  };
  assert.equal(completed.store_schema_version, 9);
  assert.deepEqual(completed.migrations[0]!.steps.map((step) => step.name), [
    'backfill-contract-lines',
    'rebuild-derived-catalog-index',
    'record-expanded-store-schema',
  ]);
  assert.equal(completed.migrations[0]!.steps[0]!.applied_at, firstStepAt);

  const verified = ok(command(fixture, ['verify', '--operator', OPERATOR]));
  assert.equal(verified['passed'], true);
});

test('finalization ends rollback eligibility before cleanup and before another upgrade', () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.1' });
  const { fixture } = published;
  const first = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const second = chainedBundle(fixture, 'bundle-0.2.1', '0.2.1', ['0.2.0']);

  ok(upgrade(fixture, first));

  // Another upgrade is refused while the rollback window is open.
  const blocked = preflight(fixture, second);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(blocked.error.code, 'ROLLBACK_WINDOW_OPEN');

  // Finalization without verification is refused, so eligibility never ends blind.
  const unverified = command(fixture, ['finalize', '--operator', OPERATOR]);
  assert.equal(unverified.status, 2, unverified.stderr);
  assert.equal(unverified.error.code, 'VERIFICATION_REQUIRED');

  ok(command(fixture, ['verify', '--operator', OPERATOR]));
  const finalized = ok(command(fixture, ['finalize', '--operator', OPERATOR]));
  assert.equal(finalized['changed'], true);
  assert.equal(finalized['rollback_eligible'], false);
  assert.equal(asRecord(finalized['rollback_window'])['open'], false);
  assert.equal(asRecord(finalized['rollback_window'])['closed_by'], 'finalize');
  assert.deepEqual(finalized['cleanup'], { previous_release: '0.1.0', removed: true });
  assert.equal(existsSync(join(fixture.root, 'releases', '0.1.0')), false);

  const refused = command(fixture, ['rollback', '--operator', OPERATOR]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(refused.error.code, 'ROLLBACK_NOT_ELIGIBLE');

  // Only after eligibility ended may the next N -> N+1 upgrade begin, and it
  // builds its own rollback window over the release that is now previous.
  const eligible = ok(preflight(fixture, second));
  assert.equal(eligible['from_release'], '0.2.0');
  const upgraded = ok(upgrade(fixture, second));
  assert.equal(upgraded['to_release'], '0.2.1');
  assert.equal(upgraded['from_release'], '0.2.0');
  assert.equal(asRecord(upgraded['migrations'])['applied_steps'], 2);
  assert.equal(asRecord(upgraded['rollback_window'])['from_release'], '0.2.0');
  assert.equal(asRecord(upgraded['rollback_window'])['to_release'], '0.2.1');

  const verified = ok(command(fixture, ['verify', '--operator', OPERATOR]));
  assert.equal(verified['passed'], true);
  assert.equal(verified['store_schema_version'], 10);
});

function jsonFor(fixture: PlatformFixture, name: string, value: unknown): string {
  const path = join(fixture.scratch, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}
