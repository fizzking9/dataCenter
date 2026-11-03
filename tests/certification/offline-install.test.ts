import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBundleFixture } from '../support/bundle.js';
import { fakeDockerEnvironment } from '../support/fake-docker.js';
import { issueLicense } from '../support/license.js';
import { runOperator } from '../support/operator.js';

test('install rejects a missing Release Bundle before mutating the Deployment', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-install-'));
  const root = join(workspace, 'deployment');
  const result = runOperator([
    'install',
    '--bundle', join(workspace, 'missing-bundle'),
    '--root', root,
    '--release-key', join(workspace, 'release-key.pem'),
    '--confirm-release-key-fingerprint', 'not-a-fingerprint',
    '--operator', 'certification@example.invalid',
  ]);

  assert.equal(result.status, 2);
  assert.equal(result.error.code, 'BUNDLE_NOT_FOUND');
  assert.equal(existsSync(root), false);
});

test('install verifies a signed Release Bundle and creates a closed Deployment with a License Request', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-install-'));
  const bundle = createBundleFixture(workspace);
  const root = join(workspace, 'deployment');
  const result = runOperator([
    'install',
    '--bundle', bundle.directory,
    '--root', root,
    '--release-key', bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
    '--operator', 'certification@example.invalid',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.state, 'license_required');
  assert.equal(result.output.release, '0.1.0');
  assert.match(String(result.output.deployment_id), /^[0-9a-f-]{36}$/);
  assert.equal(typeof result.output.license_request, 'string');
  assert.equal(existsSync(String(result.output.license_request)), true);
  assert.equal(result.output.service_open, false);
  assert.equal(typeof result.output.evidence_id, 'string');
  const evidence = readFileSync(join(root, 'evidence', `${String(result.output.evidence_id)}.json`), 'utf8');
  assert.equal(evidence.includes(bundle.releaseFingerprint), true);
  assert.equal(evidence.includes('master_key'), false);
});

test('import accepts a signed Deployment License matching the License Request', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-license-'));
  const bundle = createBundleFixture(workspace);
  const root = join(workspace, 'deployment');
  const installed = runOperator([
    'install', '--bundle', bundle.directory, '--root', root,
    '--release-key', bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
    '--operator', 'certification@example.invalid',
  ]);
  assert.equal(installed.status, 0, installed.stderr);
  const requestPath = String(installed.output.license_request);
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
    request_id: string;
    deployment_id: string;
    release: string;
  };
  assert.deepEqual(Object.keys(request).sort(), ['created_at', 'deployment_id', 'release', 'request_id', 'schema_version']);
  const licensePath = join(workspace, 'deployment-license.json');
  const licenseId = issueLicense(licensePath, bundle, request);
  const imported = runOperator([
    'import-license', '--root', root, '--license', licensePath,
    '--operator', 'certification@example.invalid',
  ]);

  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.output.state, 'ready_to_initialize');
  assert.equal(imported.output.license_id, licenseId);
  assert.equal(imported.output.service_open, false);
});

test('import rejects wrong-Deployment, not-yet-valid, and forged licenses without poisoning later import', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-license-reject-'));
  const bundle = createBundleFixture(workspace);
  const root = join(workspace, 'deployment');
  const installed = runOperator([
    'install', '--bundle', bundle.directory, '--root', root,
    '--release-key', bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
    '--operator', 'certification@example.invalid',
  ]);
  const request = JSON.parse(readFileSync(String(installed.output.license_request), 'utf8')) as {
    request_id: string;
    deployment_id: string;
    release: string;
  };
  const wrongDeployment = join(workspace, 'wrong-deployment.json');
  issueLicense(wrongDeployment, bundle, request, { deploymentId: '00000000-0000-4000-8000-000000000000' });
  const mismatch = runOperator(['import-license', '--root', root, '--license', wrongDeployment, '--operator', 'certification@example.invalid']);
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.error.code, 'LICENSE_DEPLOYMENT_MISMATCH');

  const notYetValid = join(workspace, 'not-yet-valid.json');
  issueLicense(notYetValid, bundle, request, { notBefore: new Date(Date.now() + 60_000).toISOString() });
  const early = runOperator(['import-license', '--root', root, '--license', notYetValid, '--operator', 'certification@example.invalid']);
  assert.equal(early.status, 2);
  assert.equal(early.error.code, 'LICENSE_NOT_YET_VALID');

  const forgedPath = join(workspace, 'forged.json');
  issueLicense(forgedPath, bundle, request);
  const forged = JSON.parse(readFileSync(forgedPath, 'utf8')) as { payload: { expires_at: string } };
  forged.payload.expires_at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(forgedPath, JSON.stringify(forged));
  const forgedResult = runOperator(['import-license', '--root', root, '--license', forgedPath, '--operator', 'certification@example.invalid']);
  assert.equal(forgedResult.status, 2);
  assert.equal(forgedResult.error.code, 'LICENSE_SIGNATURE_INVALID');

  const validPath = join(workspace, 'valid.json');
  issueLicense(validPath, bundle, request);
  const valid = runOperator(['import-license', '--root', root, '--license', validPath, '--operator', 'certification@example.invalid']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.output.state, 'ready_to_initialize');
});

test('initialization requires a valid license, an external master key, MFA bootstrap, and healthy pinned services', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-initialize-'));
  const bundle = createBundleFixture(workspace);
  const root = join(workspace, 'deployment');
  const docker = fakeDockerEnvironment(workspace);
  const masterKey = join(workspace, 'mounted-master-key');
  writeFileSync(masterKey, randomBytes(32), { mode: 0o600 });
  const installed = runOperator([
    'install', '--bundle', bundle.directory, '--root', root,
    '--release-key', bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
    '--operator', 'certification@example.invalid',
  ]);
  const initializeArguments = [
    'initialize', '--root', root, '--master-key', masterKey,
    '--admin-username', 'admin@example.invalid', '--admin-password-stdin',
    '--operator', 'certification@example.invalid',
  ];
  const withoutLicense = runOperator(initializeArguments, { input: 'a sufficiently long password\n', env: docker });
  assert.equal(withoutLicense.status, 2);
  assert.equal(withoutLicense.error.code, 'LICENSE_REQUIRED');

  const request = JSON.parse(readFileSync(String(installed.output.license_request), 'utf8')) as {
    request_id: string;
    deployment_id: string;
    release: string;
  };
  const licensePath = join(workspace, 'deployment-license.json');
  issueLicense(licensePath, bundle, request);
  const imported = runOperator(['import-license', '--root', root, '--license', licensePath, '--operator', 'certification@example.invalid']);
  assert.equal(imported.status, 0, imported.stderr);

  const internalKey = join(root, 'master-key');
  writeFileSync(internalKey, randomBytes(32));
  const insideRoot = runOperator(initializeArguments.map((argument) => argument === masterKey ? internalKey : argument), {
    input: 'a sufficiently long password\n',
    env: docker,
  });
  assert.equal(insideRoot.status, 2);
  assert.equal(insideRoot.error.code, 'MASTER_KEY_INSIDE_DEPLOYMENT');

  const initialized = runOperator(initializeArguments, { input: 'a sufficiently long password\n', env: docker });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(initialized.output.state, 'verified_open');
  assert.equal(initialized.output.service_open, true);
  assert.equal(initialized.output.mfa_enrolled, true);
  assert.equal(initialized.output.default_credentials, false);
  assert.equal(initialized.output.master_key_external, true);
  assert.deepEqual(initialized.output.runtime_services, ['minio', 'postgres']);
  assert.equal(typeof initialized.output.totp_secret, 'string');
  assert.equal((initialized.output.recovery_codes as unknown[]).length, 8);
  assert.equal(initialized.stdout.includes('a sufficiently long password'), false);
  assert.equal(initialized.stdout.includes(masterKey), false);

  const status = runOperator(['status', '--root', root, '--master-key', masterKey, '--operator', 'certification@example.invalid'], { env: docker });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.output.health, 'healthy');
  assert.equal(status.output.state, 'verified_open');
  assert.deepEqual(status.output.runtime_services, ['minio', 'postgres']);
  const evidencePath = join(root, 'evidence', `${String(status.output.evidence_id)}.json`);
  const evidence = readFileSync(evidencePath, 'utf8');
  assert.equal(evidence.includes('a sufficiently long password'), false);
  assert.equal(evidence.includes(String(initialized.output.totp_secret)), false);
  assert.equal(evidence.includes(masterKey), false);
  assert.equal(evidence.includes((initialized.output.recovery_codes as string[])[0] ?? 'missing'), false);
});

test('initialization stays closed when runtime health evidence is absent', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-unhealthy-'));
  const bundle = createBundleFixture(workspace);
  const root = join(workspace, 'deployment');
  const docker = fakeDockerEnvironment(workspace, { health: 'missing' });
  const masterKey = join(workspace, 'master-key');
  writeFileSync(masterKey, randomBytes(32));
  const installed = runOperator([
    'install', '--bundle', bundle.directory, '--root', root,
    '--release-key', bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
    '--operator', 'certification@example.invalid',
  ]);
  const request = JSON.parse(readFileSync(String(installed.output.license_request), 'utf8')) as {
    request_id: string;
    deployment_id: string;
    release: string;
  };
  const license = join(workspace, 'license.json');
  issueLicense(license, bundle, request);
  runOperator(['import-license', '--root', root, '--license', license, '--operator', 'certification@example.invalid']);
  const initialized = runOperator([
    'initialize', '--root', root, '--master-key', masterKey,
    '--admin-username', 'admin@example.invalid', '--admin-password-stdin',
    '--operator', 'certification@example.invalid',
  ], { input: 'a sufficiently long password\n', env: docker });
  assert.equal(initialized.status, 2);
  assert.equal(initialized.error.code, 'RUNTIME_UNHEALTHY');
  const status = runOperator(['status', '--root', root, '--operator', 'certification@example.invalid'], { env: docker });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.output.health, 'closed');
  assert.equal(status.output.service_open, false);
});

test('connected-download and removable-media bundles produce equivalent secure offline Deployments', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dc-channels-'));
  const connected = createBundleFixture(join(workspace, 'source'));
  const media = join(workspace, 'removable-media');
  cpSync(connected.directory, media, { recursive: true });

  for (const [channel, bundlePath] of [['connected', connected.directory], ['removable', media]] as const) {
    const channelRoot = join(workspace, channel);
    const root = join(channelRoot, 'deployment');
    const docker = fakeDockerEnvironment(channelRoot);
    const masterKey = join(channelRoot, 'master-key');
    writeFileSync(masterKey, randomBytes(32));
    const installed = runOperator([
      'install', '--bundle', bundlePath, '--root', root,
      '--release-key', connected.releasePublicKeyPath,
      '--confirm-release-key-fingerprint', connected.releaseFingerprint,
      '--operator', 'certification@example.invalid',
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    const request = JSON.parse(readFileSync(String(installed.output.license_request), 'utf8')) as {
      request_id: string;
      deployment_id: string;
      release: string;
    };
    const license = join(channelRoot, 'license.json');
    issueLicense(license, connected, request);
    assert.equal(runOperator(['import-license', '--root', root, '--license', license, '--operator', 'certification@example.invalid']).status, 0);
    const initialized = runOperator([
      'initialize', '--root', root, '--master-key', masterKey,
      '--admin-username', 'admin@example.invalid', '--admin-password-stdin',
      '--operator', 'certification@example.invalid',
    ], { input: 'a sufficiently long password\n', env: docker });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(installed.output.release, '0.1.0');
    assert.equal(initialized.output.state, 'verified_open');
    assert.equal(initialized.output.mfa_enrolled, true);
    assert.equal(initialized.output.default_credentials, false);
    assert.equal(initialized.output.master_key_external, true);
    assert.deepEqual(initialized.output.runtime_services, ['minio', 'postgres']);
    const calls = readFileSync(String(docker.DC_DOCKER_LOG), 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[0] === 'pull' || args.includes('--pull') && !args.includes('never')), false);
    const up = calls.find((args) => args.includes('up'));
    assert.ok(up?.includes('--pull'));
    assert.ok(up?.includes('never'));
  }
});

test('install rejects every unusable bundle before mutation', async (context) => {
  const cases = [
    {
      name: 'corrupt payload',
      code: 'BUNDLE_CHECKSUM_INVALID',
      prepare: (bundle: ReturnType<typeof createBundleFixture>) => appendFileSync(join(bundle.directory, 'compose.yaml'), 'corruption\n'),
    },
    {
      name: 'incomplete payload',
      code: 'BUNDLE_INCOMPLETE',
      prepare: (bundle: ReturnType<typeof createBundleFixture>) => rmSync(join(bundle.directory, 'images', 'minio.tar')),
    },
    {
      name: 'wrong signature',
      code: 'BUNDLE_SIGNATURE_INVALID',
      prepare: (bundle: ReturnType<typeof createBundleFixture>) => writeFileSync(
        join(bundle.directory, 'manifest.sig'),
        JSON.stringify({ algorithm: 'Ed25519', key_id: bundle.releaseFingerprint, value: Buffer.alloc(64).toString('base64') }),
      ),
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, () => {
      const workspace = mkdtempSync(join(tmpdir(), 'dc-reject-'));
      const bundle = createBundleFixture(workspace);
      entry.prepare(bundle);
      const root = join(workspace, 'deployment');
      const result = runOperator([
        'install', '--bundle', bundle.directory, '--root', root,
        '--release-key', bundle.releasePublicKeyPath,
        '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
        '--operator', 'certification@example.invalid',
      ]);
      assert.equal(result.status, 2);
      assert.equal(result.error.code, entry.code);
      assert.equal(existsSync(root), false);
    });
  }

  for (const [name, options, code] of [
    ['wrong architecture', { architecture: 'arm64' }, 'BUNDLE_ARCHITECTURE_UNSUPPORTED'],
    ['unsupported bundle', { installable: false }, 'BUNDLE_UNSUPPORTED'],
  ] as const) {
    await context.test(name, () => {
      const workspace = mkdtempSync(join(tmpdir(), 'dc-reject-'));
      const bundle = createBundleFixture(workspace, options);
      const root = join(workspace, 'deployment');
      const result = runOperator([
        'install', '--bundle', bundle.directory, '--root', root,
        '--release-key', bundle.releasePublicKeyPath,
        '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
        '--operator', 'certification@example.invalid',
      ]);
      assert.equal(result.status, 2);
      assert.equal(result.error.code, code);
      assert.equal(existsSync(root), false);
    });
  }
});
