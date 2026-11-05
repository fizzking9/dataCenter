import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { callApi, signInOperatorConsole, signInOperatorPage, startConsole, type HttpResult } from '../support/console.js';
import { installLicenseFile, installedLicenseRequest, signedLicenseFor } from '../support/license.js';
import { command, initializePlatform, workspaceFixture, type PlatformFixture } from '../support/platform.js';

const OPERATOR = 'licensing-operator@example.invalid';
const PASSWORD = 'licensing-operator-password';
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `expected a list: ${JSON.stringify(value)}`);
  return value as Array<Record<string, unknown>>;
}

function ok(result: { status: number; output: Record<string, unknown>; stderr: string }): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/** The refusal is a governed answer: an explicit code and a message, never a fault. */
function refused(result: HttpResult, status: number, code: string): Record<string, unknown> {
  assert.equal(result.status, status, result.text);
  assert.equal(result.body.code, code, result.text);
  assert.equal(typeof result.body.message, 'string');
  return result.body;
}

/** One signed license for this Deployment, as the vendor would deliver on media. */
function signed(fixture: PlatformFixture, name: string, options: Parameters<typeof signedLicenseFor>[4]): string {
  return signedLicenseFor(fixture.scratch, name, fixture.bundle, installedLicenseRequest(fixture.root), options);
}

test('an Operator renews through the console and the CLI states the same license, history, and evidence', async () => {
  const base = workspaceFixture({ licenseExpiresAt: iso(45 * DAY) });
  const { fixture } = base;
  const created = ok(command(
    fixture,
    ['source', 'create', '--workspace', base.workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: base.workspaceAdministratorToken },
  ));
  const server = await startConsole(fixture);
  try {
    const operator = await signInOperatorConsole(fixture, server.url, { operator: OPERATOR, password: PASSWORD });
    const before = await callApi(server.url, '/api/operator/license', { cookie: operator.cookie });
    assert.equal(before.status, 200, before.text);
    assert.equal(before.body.status, 'valid');
    assert.equal(before.body.warning, null);
    const beforeId = String(before.body.license_id);
    const beforeHistory = rows(before.body.history);
    assert.deepEqual(beforeHistory.map((entry) => entry['license_id']), [beforeId]);
    assert.equal(asRecord(before.body.access)['access'], 'full');
    assert.equal(before.text.includes('signature'), false, 'no license private material is exposed');

    // A renewal arrives as an offline-signed document on the Operator's media.
    const renewal = signed(fixture, 'console-renewal', { expiresAt: iso(29.5 * DAY) });
    const imported = await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: renewal },
    });
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.body.renewed, true);
    assert.equal(imported.body.service_open, true);
    assert.notEqual(imported.body.license_id, beforeId);
    assert.equal(imported.body.previous_license_id, beforeId);
    assert.equal(typeof imported.body.evidence_id, 'string');
    assert.equal(imported.text.includes('signature'), false, 'the renewal response carries no license material');
    const warning = asRecord(imported.body.warning);
    assert.equal(warning['level'], '30_day');
    assert.equal(warning['days_remaining'], 30);
    assert.match(String(warning['message']), /到期/u);

    // The console states the renewed license beside its full history and evidence.
    const after = await callApi(server.url, '/api/operator/license', { cookie: operator.cookie });
    assert.equal(after.status, 200, after.text);
    assert.equal(after.body.license_id, imported.body.license_id);
    assert.equal(after.body.deployment_id, before.body.deployment_id, 'renewal keeps the logical Deployment identity');
    assert.equal(after.body.days_remaining, 30);
    const history = rows(after.body.history);
    assert.deepEqual(history.map((entry) => entry['license_id']), [beforeId, String(imported.body.license_id)]);
    assert.deepEqual(history.map((entry) => entry['previous_license_id']), [null, beforeId]);
    assert.equal(typeof history[1]?.['imported_at'], 'string');
    assert.equal('signature' in history[1]!, false);
    const evidence = rows(after.body.evidence);
    assert.equal(evidence[0]?.['evidence_id'], imported.body.evidence_id, 'the newest durable evidence is the renewal');
    assert.equal(evidence[0]?.['operation'], 'import-license');
    assert.equal(evidence[0]?.['outcome'], 'renewed');

    // The CLI path states exactly what the browser surface states.
    const cli = ok(command(fixture, ['console', 'license']));
    for (const field of ['license_id', 'not_before', 'expires_at', 'highest_eligible_release', 'release', 'deployment_id', 'state', 'status', 'days_remaining']) {
      assert.deepEqual(after.body[field], cli[field], field);
    }
    assert.deepEqual(after.body.history, cli['license_history']);
    assert.deepEqual(after.body.access, cli['access']);
    assert.deepEqual(after.body.evidence, cli['evidence']);

    // Business data and the Workspace are untouched by the renewal.
    const sources = ok(command(
      fixture,
      ['source', 'list', '--workspace', base.workspaceId],
      { token: base.workspaceAdministratorToken },
    ));
    assert.deepEqual(rows(sources['sources']).map((entry) => entry['source_id']), [created['source_id']]);
  } finally {
    await server.stop();
  }
});

test('unusable renewals are explicit and leave the current license unchanged', async () => {
  const base = workspaceFixture({ licenseExpiresAt: iso(45 * DAY) });
  const { fixture } = base;
  const server = await startConsole(fixture);
  try {
    const operator = await signInOperatorConsole(fixture, server.url, { operator: OPERATOR, password: PASSWORD });
    const before = await callApi(server.url, '/api/operator/license', { cookie: operator.cookie });
    const beforeId = String(before.body.license_id);

    const wrongDeployment = signed(fixture, 'console-wrong-deployment', {
      deploymentId: '00000000-0000-4000-8000-000000000000',
      expiresAt: iso(60 * DAY),
    });
    const wrong = refused(await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: wrongDeployment },
    }), 409, 'LICENSE_DEPLOYMENT_MISMATCH');
    assert.equal(typeof wrong['next_step'], 'undefined');

    const forgedPath = signed(fixture, 'console-forged', { expiresAt: iso(60 * DAY) });
    const forged = JSON.parse(readFileSync(forgedPath, 'utf8')) as { payload: { expires_at: string } };
    forged.payload.expires_at = iso(365 * DAY);
    writeFileSync(forgedPath, JSON.stringify(forged));
    refused(await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: forgedPath },
    }), 409, 'LICENSE_SIGNATURE_INVALID');

    refused(await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: signed(fixture, 'console-expired', { notBefore: iso(-2 * DAY), expiresAt: iso(-DAY) }) },
    }), 409, 'LICENSE_EXPIRED');

    refused(await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: signed(fixture, 'console-early', { notBefore: iso(60 * 60 * 1000), expiresAt: iso(60 * DAY) }) },
    }), 409, 'LICENSE_NOT_YET_VALID');

    const malformed = join(fixture.scratch, 'console-malformed-license.json');
    writeFileSync(malformed, '{ not a license');
    refused(await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: malformed },
    }), 409, 'LICENSE_MALFORMED');

    refused(await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: join(fixture.scratch, 'console-absent.json') },
    }), 404, 'LICENSE_NOT_FOUND');

    const after = await callApi(server.url, '/api/operator/license', { cookie: operator.cookie });
    assert.equal(after.body.license_id, beforeId, 'refused renewals changed nothing');
    assert.equal(after.body.status, 'valid');
    assert.deepEqual(rows(after.body.history).map((entry) => entry['license_id']), [beforeId]);
    const created = command(
      fixture,
      ['source', 'create', '--workspace', base.workspaceId, '--name', '续期后来源', '--type', 'file'],
      { token: base.workspaceAdministratorToken },
    );
    assert.equal(created.status, 0, `the service still accepts governed writes: ${created.stderr}`);
  } finally {
    await server.stop();
  }
});

test('an expired license keeps reads and lifecycle work open while writes are explicitly closed', async () => {
  const base = workspaceFixture({ licenseExpiresAt: iso(45 * DAY) });
  const { fixture } = base;
  const server = await startConsole(fixture);
  try {
    const operator = await signInOperatorConsole(fixture, server.url, { operator: OPERATOR, password: PASSWORD });
    // The file an ordinary expiration leaves behind: an entitlement whose window ended.
    installLicenseFile(fixture.root, signed(fixture, 'console-expired-installed', {
      notBefore: iso(-2 * DAY),
      expiresAt: iso(-60_000),
    }));

    const view = await callApi(server.url, '/api/operator/license', { cookie: operator.cookie });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.status, 'expired');
    assert.equal(view.body.days_remaining, 0);
    assert.equal(view.body.warning, null);
    const access = asRecord(view.body.access);
    assert.equal(access['access'], 'read_only');
    const permitted = rows(access['permitted']).map(String).sort();
    const disabled = rows(access['disabled']).map(String).sort();
    assert.deepEqual(permitted, [
      'authentication',
      'backup',
      'ephemeral_query',
      'existing_reads',
      'exports',
      'license_import',
      'lifecycle',
    ]);
    assert.deepEqual(disabled, [
      'acquisition',
      'artifacts',
      'configuration',
      'data_products',
      'integration',
      'reports',
      'schedules',
    ]);
    assert.deepEqual(permitted.filter((entry) => disabled.includes(entry)), []);
    assert.deepEqual(asRecord(ok(command(fixture, ['console', 'license']))['access']), access);

    // Reads stay open and governed writes close, exactly as the view states.
    assert.equal(ok(command(
      fixture,
      ['source', 'list', '--workspace', base.workspaceId],
      { token: base.workspaceAdministratorToken },
    ))['sources'] instanceof Array, true);
    const denied = command(
      fixture,
      ['source', 'create', '--workspace', base.workspaceId, '--name', '过期后新来源', '--type', 'file'],
      { token: base.workspaceAdministratorToken },
    );
    assert.equal(denied.status, 2);
    assert.equal(denied.error['code'], 'LICENSE_EXPIRED');

    // A renewal imported through the console restores the full entitlement.
    const renewed = await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: signed(fixture, 'console-expiry-renewal', { expiresAt: iso(45 * DAY) }) },
    });
    assert.equal(renewed.status, 200, renewed.text);
    assert.equal(renewed.body.status, 'valid');
    assert.equal(asRecord(renewed.body.access)['access'], 'full');
    assert.deepEqual(rows(asRecord(renewed.body.access)['permitted']), []);
    assert.equal(rows(renewed.body.history).length, 2);
    const created = command(
      fixture,
      ['source', 'create', '--workspace', base.workspaceId, '--name', '续期后新来源', '--type', 'file'],
      { token: base.workspaceAdministratorToken },
    );
    assert.equal(created.status, 0, created.stderr);
  } finally {
    await server.stop();
  }
});

test('a significant backward clock movement is an explicit closed state in the console', async () => {
  const base = workspaceFixture({ licenseExpiresAt: iso(400 * DAY) });
  const { fixture } = base;
  const server = await startConsole(fixture);
  try {
    const operator = await signInOperatorConsole(fixture, server.url, { operator: OPERATOR, password: PASSWORD });
    // The host observed a later instant, so the current clock is a rollback.
    ok(command(fixture, ['status', '--operator', OPERATOR, '--at', iso(2 * DAY)]));

    const view = await callApi(server.url, '/api/operator/license', { cookie: operator.cookie });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.status, 'invalid');
    assert.equal(view.body.error_code, 'LICENSE_CLOCK_ROLLBACK');
    assert.equal(typeof view.body.message, 'string');
    const access = asRecord(view.body.access);
    assert.equal(access['access'], 'closed');
    assert.deepEqual(rows(access['permitted']).map(String).sort(), ['license_import', 'lifecycle']);
    assert.equal(rows(access['disabled']).map(String).includes('existing_reads'), true);
    assert.equal(ok(command(fixture, ['console', 'license']))['error_code'], 'LICENSE_CLOCK_ROLLBACK');

    // Importing while the clock is untrustworthy is refused, not silently applied.
    const importRefusal = await callApi(server.url, '/api/operator/license', {
      method: 'POST',
      cookie: operator.cookie,
      body: { license: signed(fixture, 'console-rollback-renewal', { expiresAt: iso(45 * DAY) }) },
    });
    const refusal = refused(importRefusal, 409, 'LICENSE_CLOCK_ROLLBACK');
    assert.equal(typeof refusal['next_step'], 'string');
    assert.equal(rows(ok(command(fixture, ['console', 'license']))['license_history']).length, 1);
  } finally {
    await server.stop();
  }
});

test('ending other Operator sessions takes effect on their next request without a platform session', async () => {
  const fixture = initializePlatform();
  const server = await startConsole(fixture);
  try {
    const operator = await signInOperatorConsole(fixture, server.url, { operator: OPERATOR, password: PASSWORD });
    const second = await signInOperatorPage(server.url, { operator: OPERATOR, password: PASSWORD }, operator.totp_secret);

    const listed = await callApi(server.url, '/api/operator/sessions', { cookie: operator.cookie });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.operator, OPERATOR);
    const sessions = rows(listed.body.sessions);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter((entry) => entry['current'] === true).length, 1);
    for (const entry of sessions) {
      assert.equal(typeof entry['issued_at'], 'string');
      assert.equal(typeof entry['expires_at'], 'string');
      assert.equal('token_hash' in entry, false, 'no session secret is exposed');
    }
    assert.equal(listed.text.includes(second.slice('dc_operator_console='.length)), false);

    const revoked = await callApi(server.url, '/api/operator/sessions/revoke', {
      method: 'POST',
      cookie: operator.cookie,
      body: {},
    });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.body.sessions_revoked, 1);
    assert.equal(typeof revoked.body.evidence_id, 'string');
    assert.equal((await callApi(server.url, '/api/operator/sessions', { cookie: second })).status, 401);
    assert.equal((await callApi(server.url, '/api/operator/sessions', { cookie: operator.cookie })).body.operator, OPERATOR);

    // The Operator console session never authenticates the platform User channel.
    const crossed = await callApi(server.url, '/api/session', { cookie: operator.cookie });
    assert.equal(crossed.status, 401);
    assert.equal(crossed.body.code, 'SESSION_INVALID');

    // CLI revocation ends the remaining session on its very next request.
    assert.equal(ok(command(fixture, ['console', 'revoke', '--operator', OPERATOR]))['sessions_revoked'], 1);
    assert.equal((await callApi(server.url, '/api/operator/sessions', { cookie: operator.cookie })).status, 401);

    // CLI-assisted re-enrollment restores console access and still grants no User session.
    const restored = await signInOperatorConsole(fixture, server.url, { operator: OPERATOR, password: PASSWORD });
    assert.equal((await callApi(server.url, '/api/operator/sessions', { cookie: restored.cookie })).status, 200);
    assert.equal((await callApi(server.url, '/api/session', { cookie: restored.cookie })).status, 401);
  } finally {
    await server.stop();
  }
});
