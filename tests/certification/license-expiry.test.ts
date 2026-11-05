import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishLedgerProduct } from '../support/data-product.js';
import {
  installedLicenseRequest,
  installLicenseFile,
  signedLicenseFor,
} from '../support/license.js';
import type { OperatorResult } from '../support/operator.js';
import {
  command,
  jsonFile,
  workspaceFixture,
  type PlatformFixture,
} from '../support/platform.js';

const OPERATOR = 'license@example.invalid';
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function ok(result: OperatorResult): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.output;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function refused(result: OperatorResult, code: string): void {
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.error['code'], code, JSON.stringify(result.error));
}

/** Copies one already-expired signed license into place, as elapsed time would. */
function expireInstalledLicense(fixture: PlatformFixture): string {
  const expired = signedLicenseFor(
    fixture.scratch,
    'installed-expired-license',
    fixture.bundle,
    installedLicenseRequest(fixture.root),
    { expiresAt: iso(-60_000), notBefore: iso(-2 * DAY) },
  );
  installLicenseFile(fixture.root, expired);
  return JSON.parse(readFileSync(expired, 'utf8')).payload.license_id as string;
}

test('an offline renewal replaces the license while the service is open and preserves business data', () => {
  const base = workspaceFixture();
  const { fixture } = base;
  const source = ok(command(
    fixture,
    ['source', 'create', '--workspace', base.workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: base.workspaceAdministratorToken },
  ));
  const sourceId = String(source['source_id']);
  const before = ok(command(fixture, ['status', '--operator', OPERATOR]));
  const beforeLicense = asRecord(before['license']);
  const beforeId = String(beforeLicense['license_id']);
  const deploymentId = String(before['deployment_id']);

  const renewal = signedLicenseFor(
    fixture.scratch,
    'renewal-license',
    fixture.bundle,
    installedLicenseRequest(fixture.root),
    { expiresAt: iso(45 * DAY) },
  );
  const imported = ok(command(fixture, ['import-license', '--license', renewal, '--operator', OPERATOR]));

  assert.equal(imported['renewed'], true);
  assert.equal(imported['service_open'], true);
  assert.equal(imported['state'], 'verified_open');
  assert.notEqual(imported['license_id'], beforeId);
  assert.equal(imported['previous_license_id'], beforeId);
  assert.deepEqual(imported['license_history'], [beforeId, String(imported['license_id'])]);

  const sources = ok(command(
    fixture,
    ['source', 'list', '--workspace', base.workspaceId],
    { token: base.workspaceAdministratorToken },
  ));
  const listed = sources['sources'] as Array<Record<string, unknown>>;
  assert.deepEqual(listed.map((entry) => entry['source_id']), [sourceId], 'business data survived the renewal');

  const after = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(asRecord(after['license'])['license_id'], imported['license_id']);
  assert.equal(after['deployment_id'], deploymentId, 'renewal never changes the logical Deployment identity');
  assert.equal(after['service_open'], true);
});

test('an unusable renewal leaves the current license and the open service unchanged', () => {
  const base = workspaceFixture();
  const { fixture } = base;
  const request = installedLicenseRequest(fixture.root);
  const before = ok(command(fixture, ['status', '--operator', OPERATOR]));
  const beforeId = String(asRecord(before['license'])['license_id']);

  const wrongDeployment = signedLicenseFor(fixture.scratch, 'wrong-deployment', fixture.bundle, request, {
    deploymentId: '00000000-0000-4000-8000-000000000000',
    expiresAt: iso(60 * DAY),
  });
  refused(command(fixture, ['import-license', '--license', wrongDeployment, '--operator', OPERATOR]), 'LICENSE_DEPLOYMENT_MISMATCH');

  const forgedPath = signedLicenseFor(fixture.scratch, 'forged-renewal', fixture.bundle, request, { expiresAt: iso(60 * DAY) });
  const forged = JSON.parse(readFileSync(forgedPath, 'utf8')) as { payload: { expires_at: string } };
  forged.payload.expires_at = iso(365 * DAY);
  writeFileSync(forgedPath, JSON.stringify(forged));
  refused(command(fixture, ['import-license', '--license', forgedPath, '--operator', OPERATOR]), 'LICENSE_SIGNATURE_INVALID');

  const early = signedLicenseFor(fixture.scratch, 'early-renewal', fixture.bundle, request, {
    notBefore: iso(60 * 60 * 1000),
    expiresAt: iso(60 * DAY),
  });
  refused(command(fixture, ['import-license', '--license', early, '--operator', OPERATOR]), 'LICENSE_NOT_YET_VALID');

  const expired = signedLicenseFor(fixture.scratch, 'expired-renewal', fixture.bundle, request, {
    notBefore: iso(-2 * DAY),
    expiresAt: iso(-DAY),
  });
  refused(command(fixture, ['import-license', '--license', expired, '--operator', OPERATOR]), 'LICENSE_EXPIRED');

  const malformed = join(fixture.scratch, 'malformed-license.json');
  writeFileSync(malformed, '{ not a license');
  refused(command(fixture, ['import-license', '--license', malformed, '--operator', OPERATOR]), 'LICENSE_MALFORMED');

  refused(
    command(fixture, ['import-license', '--license', join(fixture.scratch, 'absent.json'), '--operator', OPERATOR]),
    'LICENSE_NOT_FOUND',
  );

  const after = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(asRecord(after['license'])['license_id'], beforeId, 'the failed renewals changed nothing');
  assert.equal(after['service_open'], true);
  const created = command(
    fixture,
    ['source', 'create', '--workspace', base.workspaceId, '--name', '续期后来源', '--type', 'file'],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
});

test('warnings appear at thirty, seven, and one day before expiration', () => {
  const fixture = workspaceFixture({ licenseExpiresAt: iso(60 * DAY) }).fixture;
  const request = installedLicenseRequest(fixture.root);

  const noWarning = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(asRecord(noWarning['license'])['warning'], null);

  const cases: Array<{ offset: number; level: string; days: number }> = [
    { offset: 29.5 * DAY, level: '30_day', days: 30 },
    { offset: 6.5 * DAY, level: '7_day', days: 7 },
    { offset: 0.5 * DAY, level: '1_day', days: 1 },
  ];
  for (const entry of cases) {
    const license = signedLicenseFor(fixture.scratch, `warn-${entry.level}`, fixture.bundle, request, {
      expiresAt: iso(entry.offset),
    });
    const imported = ok(command(fixture, ['import-license', '--license', license, '--operator', OPERATOR]));
    assert.equal(imported['service_open'], true);
    const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
    const licenseView = asRecord(status['license']);
    assert.equal(licenseView['status'], 'valid');
    const warning = asRecord(licenseView['warning']);
    assert.equal(warning['level'], entry.level);
    assert.equal(warning['days_remaining'], entry.days);
    assert.equal(typeof warning['message'], 'string');
    assert.match(String(warning['message']), /到期/u);
  }
});

test('significant backward clock movement keeps the service closed and refuses reads', () => {
  const base = workspaceFixture({ licenseExpiresAt: iso(400 * DAY) });
  const { fixture } = base;

  const ahead = ok(command(fixture, ['status', '--operator', OPERATOR, '--at', iso(2 * DAY)]));
  assert.equal(asRecord(ahead['license'])['status'], 'valid');
  assert.equal(ahead['service_open'], true);

  const rolledBack = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(rolledBack['health'], 'closed');
  assert.equal(rolledBack['service_open'], false);
  assert.equal(asRecord(rolledBack['license'])['error_code'], 'LICENSE_CLOCK_ROLLBACK');

  refused(
    command(fixture, ['workspace', 'list'], { token: base.deploymentAdministratorToken }),
    'LICENSE_CLOCK_ROLLBACK',
  );
});

test('expiration stops governed writes while reads, stored data, exports, backup, and lifecycle commands remain', () => {
  const product = publishLedgerProduct();
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken } = product;
  const request = jsonFile(fixture, 'records-query', { kind: 'records' });
  const readableBefore = ok(command(
    fixture,
    ['product', 'query', '--product', product.dataProductId, '--request', request],
    { token: workspaceAdministratorToken },
  ));
  assert.equal((readableBefore['records'] as unknown[]).length, 3);
  const exportedBefore = ok(command(
    fixture,
    ['export', 'create', '--product', product.dataProductId, '--request', jsonFile(fixture, 'export-request', { kind: 'records' })],
    { token: workspaceAdministratorToken },
  ));
  const exportId = String(exportedBefore['export_id']);

  expireInstalledLicense(fixture);

  const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(status['service_open'], true);
  assert.equal(status['access'], 'read_only');
  assert.equal(asRecord(status['license'])['status'], 'expired');

  // Existing data, stored exports, audit, and metadata stay readable.
  const readableAfter = ok(command(
    fixture,
    ['product', 'query', '--product', product.dataProductId, '--request', request],
    { token: workspaceAdministratorToken },
  ));
  assert.deepEqual(readableAfter['records'], readableBefore['records']);
  const downloaded = ok(command(fixture, ['export', 'download', '--export', exportId], { token: workspaceAdministratorToken }));
  assert.equal(typeof downloaded['content'], 'string');
  assert.equal(ok(command(fixture, ['export', 'list', '--workspace', workspaceId], { token: workspaceAdministratorToken }))['exports'] instanceof Array, true);
  assert.equal(ok(command(fixture, ['source', 'list', '--workspace', workspaceId], { token: workspaceAdministratorToken }))['sources'] instanceof Array, true);
  assert.equal(ok(command(fixture, ['report', 'list', '--workspace', workspaceId], { token: workspaceAdministratorToken }))['reports'] instanceof Array, true);
  assert.equal(ok(command(fixture, ['audit', 'list', '--workspace', workspaceId], { token: workspaceAdministratorToken }))['events'] instanceof Array, true);

  // Exports, backups, checkpoints, and lifecycle status remain available.
  const exportedAfter = ok(command(
    fixture,
    ['export', 'create', '--product', product.dataProductId, '--request', jsonFile(fixture, 'export-request-2', { kind: 'records' })],
    { token: workspaceAdministratorToken },
  ));
  assert.equal(typeof exportedAfter['export_id'], 'string');
  assert.equal(ok(command(fixture, ['checkpoint', '--operator', OPERATOR]))['coordinated'], true);
  assert.equal(ok(command(fixture, ['backup', 'create', '--operator', OPERATOR, '--backup-root', join(fixture.scratch, 'off-host')]))['backup_id'] !== undefined, true);

  // Acquisition, integration, configuration, Artifacts, generation, candidates, refreshes, and schedules stop.
  const integrationConfig = jsonFile(fixture, 'renewal-integration', {
    identity: ['sn'],
    schema: [{ name: 'sn', type: 'string' }],
    cleaning: [],
    mapping: { 设备SN: 'sn' },
  });
  const blocked: Array<[string[], string]> = [
    [['acquisition', 'enqueue', '--source', product.sourceId], 'LICENSE_EXPIRED'],
    [['acquisition', 'work', '--source', product.sourceId], 'LICENSE_EXPIRED'],
    [['acquisition', 'tick'], 'LICENSE_EXPIRED'],
    [['acquisition', 'upload', '--source', product.sourceId, '--file', jsonFile(fixture, 'upload-file', {})], 'LICENSE_EXPIRED'],
    [['integration', 'publish', '--source', product.sourceId, '--config', integrationConfig], 'LICENSE_EXPIRED'],
    [['integration', 'adopt', '--source', product.sourceId, '--version', '1'], 'LICENSE_EXPIRED'],
    [['dataset', 'release', '--source', product.sourceId], 'LICENSE_EXPIRED'],
    [['source', 'create', '--workspace', workspaceId, '--name', '新来源', '--type', 'file'], 'LICENSE_EXPIRED'],
    [['context', 'publish-common', '--entries', jsonFile(fixture, 'common-context', [])], 'LICENSE_EXPIRED'],
    [['product', 'publish', '--source', product.sourceId, '--name', '新台账', '--contract', jsonFile(fixture, 'new-contract', {})], 'LICENSE_EXPIRED'],
    [['product', 'withdraw', '--product', product.dataProductId, '--version', '1'], 'LICENSE_EXPIRED'],
    [['report', 'generate', '--template', '00000000-0000-4000-8000-000000000000'], 'LICENSE_EXPIRED'],
    [['report', 'schedule-create', '--template', '00000000-0000-4000-8000-000000000000', '--consumer', 'analyst@example.invalid', '--interval-minutes', '60'], 'LICENSE_EXPIRED'],
    [['report', 'schedule-tick', '--workspace', workspaceId], 'LICENSE_EXPIRED'],
    [['report', 'candidate-approve', '--candidate', '00000000-0000-4000-8000-000000000000'], 'LICENSE_EXPIRED'],
    [['user', 'create', '--username', 'new@example.invalid', '--password-stdin'], 'LICENSE_EXPIRED'],
  ];
  for (const [args, code] of blocked) {
    refused(command(fixture, args, {
      token: workspaceAdministratorToken,
      ...(args[0] === 'user' ? { input: 'new-user-password\n' } : {}),
    }), code);
  }

  // The Consumer surface reads the same unchanged data.
  assert.equal(ok(command(
    fixture,
    ['product', 'query', '--product', product.dataProductId, '--request', request],
    { token: consumerToken },
  ))['records'] instanceof Array, true);

  // A valid offline renewal restores writes without reinstalling anything.
  const renewal = signedLicenseFor(
    fixture.scratch,
    'expiry-renewal',
    fixture.bundle,
    installedLicenseRequest(fixture.root),
    { expiresAt: iso(30 * DAY) },
  );
  const imported = ok(command(fixture, ['import-license', '--license', renewal, '--operator', OPERATOR]));
  assert.equal(imported['renewed'], true);
  assert.equal(imported['service_open'], true);
  const created = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '续期后新来源', '--type', 'file'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
});

test('wrong, forged, malformed, missing, and not-yet-valid licenses keep the service closed and recovery preserves identity', () => {
  const base = workspaceFixture();
  const { fixture } = base;
  const request = installedLicenseRequest(fixture.root);
  const before = ok(command(fixture, ['status', '--operator', OPERATOR]));
  const deploymentId = String(before['deployment_id']);
  const validPath = join(fixture.root, 'license.json');
  const validBytes = readFileSync(validPath);

  const cases: Array<{ name: string; prepare: () => void; code: string }> = [
    {
      name: 'wrong deployment',
      code: 'LICENSE_DEPLOYMENT_MISMATCH',
      prepare: () => installLicenseFile(
        fixture.root,
        signedLicenseFor(fixture.scratch, 'case-wrong', fixture.bundle, request, {
          deploymentId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    },
    {
      name: 'forged',
      code: 'LICENSE_SIGNATURE_INVALID',
      prepare: () => {
        const path = signedLicenseFor(fixture.scratch, 'case-forged', fixture.bundle, request);
        const forged = JSON.parse(readFileSync(path, 'utf8')) as { payload: { expires_at: string } };
        forged.payload.expires_at = iso(365 * DAY);
        writeFileSync(path, JSON.stringify(forged));
        installLicenseFile(fixture.root, path);
      },
    },
    {
      name: 'malformed',
      code: 'LICENSE_MALFORMED',
      prepare: () => installLicenseFile(fixture.root, join(fixture.scratch, 'case-malformed')),
    },
    {
      name: 'not yet valid',
      code: 'LICENSE_NOT_YET_VALID',
      prepare: () => installLicenseFile(
        fixture.root,
        signedLicenseFor(fixture.scratch, 'case-early', fixture.bundle, request, { notBefore: iso(DAY) }),
      ),
    },
    {
      name: 'missing',
      code: 'LICENSE_NOT_FOUND',
      prepare: () => rmSync(validPath),
    },
  ];
  writeFileSync(join(fixture.scratch, 'case-malformed'), '{ not json');

  for (const entry of cases) {
    entry.prepare();
    refused(command(fixture, ['source', 'list', '--workspace', base.workspaceId], { token: base.workspaceAdministratorToken }), entry.code);
    const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
    assert.equal(status['service_open'], false, `${entry.name} must stay closed`);
    assert.equal(status['health'], 'closed');
    assert.equal(asRecord(status['license'])['error_code'], entry.code);
    assert.equal(status['deployment_id'], deploymentId);
  }

  writeFileSync(validPath, validBytes);
  const recovered = ok(command(fixture, ['source', 'list', '--workspace', base.workspaceId], { token: base.workspaceAdministratorToken }));
  assert.equal(recovered['sources'] instanceof Array, true);
  const after = ok(command(fixture, ['status', '--operator', OPERATOR]));
  assert.equal(after['deployment_id'], deploymentId, 'recovery preserves the logical Deployment identity');
  assert.equal(after['service_open'], true);
});
