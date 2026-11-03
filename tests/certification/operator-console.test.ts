import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callApi, startConsole } from '../support/console.js';
import { command, initializePlatform, sessionFor } from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATOR = 'console-operator@example.invalid';
const PASSWORD = 'console-operator-password';

test('operator enrollment issues one distinct expiring secret per request', () => {
  const fixture = initializePlatform();
  const first = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.output.operator, OPERATOR);
  assert.equal(typeof first.output.enrollment_id, 'string');
  assert.match(String(first.output.enrollment_secret), /^[A-Za-z0-9_-]{43}$/);
  assert.match(String(first.output.enrollment_path), /^\/enroll#/);
  assert.equal(Date.parse(String(first.output.enrollment_expires_at)) > Date.now(), true);

  const second = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(second.output.enrollment_secret, first.output.enrollment_secret);
  assert.equal(first.stdout.includes(OPERATOR), true);
});

test('operator console enrollment trades a one-time secret for new credentials and mandatory MFA', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
    assert.equal(issued.status, 0, issued.stderr);
    const secret = String(issued.output.enrollment_secret);

    const enrolled = await callApi(console.url, '/api/operator/enrollment', {
      body: { enrollment_secret: secret, password: PASSWORD },
    });
    assert.equal(enrolled.status, 201, enrolled.text);
    assert.equal(enrolled.body.username, OPERATOR);
    assert.equal(enrolled.body.mfa_enrolled, true);
    assert.match(String(enrolled.body.totp_secret), /^[A-Z2-7]{16,}$/);
    assert.equal((enrolled.body.recovery_codes as unknown[]).length, 8);
    assert.match(String(enrolled.body.enrollment_uri), /^otpauth:\/\/totp\//);
    assert.equal(enrolled.cookies.length, 0);
    assert.equal(enrolled.text.includes(PASSWORD), false);

    const replay = await callApi(console.url, '/api/operator/enrollment', {
      body: { enrollment_secret: secret, password: PASSWORD },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'OPERATOR_ENROLLMENT_CONSUMED');
  } finally {
    await console.stop();
  }
});

test('operator console sign-in demands MFA and never shares the platform User session namespace', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const credentials = await enrolOperator(console.url, fixture);

    const passwordOnly = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD },
    });
    assert.equal(passwordOnly.status, 401);
    assert.equal(passwordOnly.body.code, 'OPERATOR_AUTHENTICATION_FAILED');

    const wrongCode = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: '000000' },
    });
    assert.equal(wrongCode.status, 401);
    assert.equal(wrongCode.body.code, 'OPERATOR_AUTHENTICATION_FAILED');

    const signedIn = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: totpCode(credentials.totp_secret) },
    });
    assert.equal(signedIn.status, 200, signedIn.text);
    assert.equal(signedIn.body.username, OPERATOR);
    const setCookie = signedIn.cookies[0] ?? '';
    assert.match(setCookie, /^dc_operator_console=/);
    assert.equal(setCookie.includes('HttpOnly'), true);
    assert.equal(setCookie.includes('SameSite=Strict'), true);
    const cookie = setCookie.split(';')[0] ?? '';
    const token = cookie.slice('dc_operator_console='.length);

    const anonymous = await callApi(console.url, '/api/operator/health');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.code, 'OPERATOR_SESSION_INVALID');

    const health = await callApi(console.url, '/api/operator/health', { cookie });
    assert.equal(health.status, 200, health.text);
    assert.equal(health.body.health, 'healthy');
    assert.equal(health.body.state, 'verified_open');
    assert.deepEqual(health.body.runtime_services, ['minio', 'postgres']);
    assert.equal(health.body.service_open, true);
    assert.equal(health.text.includes(fixture.masterKey), false);
    assert.equal(health.text.includes(PASSWORD), false);
    assert.equal(health.text.includes(credentials.totp_secret), false);

    const license = await callApi(console.url, '/api/operator/license', { cookie });
    assert.equal(license.status, 200, license.text);
    assert.equal(typeof license.body.license_id, 'string');
    assert.equal(license.body.highest_eligible_release, '0.1.0');
    assert.equal(license.body.release, '0.1.0');
    assert.equal(Date.parse(String(license.body.expires_at)) > Date.now(), true);
    assert.equal('signature' in license.body, false);
    assert.equal(license.text.includes('Ed25519'), false);

    const platformToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
    const crossedIn = await callApi(console.url, '/api/operator/health', {
      cookie: `dc_operator_console=${platformToken}`,
    });
    assert.equal(crossedIn.status, 401);
    assert.equal(crossedIn.body.code, 'OPERATOR_SESSION_INVALID');

    const crossedOut = command(fixture, ['workspace', 'list'], { token });
    assert.equal(crossedOut.status, 2);
    assert.equal(crossedOut.error.code, 'SESSION_INVALID');
  } finally {
    await console.stop();
  }
});

test('operator revocation ends console access and re-enrollment restores it', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const credentials = await enrolOperator(console.url, fixture);
    const signedIn = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: totpCode(credentials.totp_secret) },
    });
    assert.equal(signedIn.status, 200, signedIn.text);
    const cookie = (signedIn.cookies[0] ?? '').split(';')[0] ?? '';
    assert.equal((await callApi(console.url, '/api/operator/health', { cookie })).status, 200);

    const doubleEnrollment = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
    assert.equal(doubleEnrollment.status, 2);
    assert.equal(doubleEnrollment.error.code, 'OPERATOR_ALREADY_ENROLLED');

    const revoked = command(fixture, ['console', 'revoke', '--operator', OPERATOR]);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(revoked.output.sessions_revoked, 1);
    assert.equal(revoked.output.status, 'revoked');

    const ended = await callApi(console.url, '/api/operator/health', { cookie });
    assert.equal(ended.status, 401);
    const denied = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: totpCode(credentials.totp_secret) },
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, 'OPERATOR_AUTHENTICATION_FAILED');

    const restored = await enrolOperator(console.url, fixture);
    const signedBack = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: totpCode(restored.totp_secret) },
    });
    assert.equal(signedBack.status, 200, signedBack.text);
    const restoredCookie = (signedBack.cookies[0] ?? '').split(';')[0] ?? '';
    assert.equal((await callApi(console.url, '/api/operator/health', { cookie: restoredCookie })).status, 200);
  } finally {
    await console.stop();
  }
});

test('operator console sign-out ends the session and clears the cookie', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const credentials = await enrolOperator(console.url, fixture);
    const signedIn = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: totpCode(credentials.totp_secret) },
    });
    const cookie = (signedIn.cookies[0] ?? '').split(';')[0] ?? '';
    const signedOut = await callApi(console.url, '/api/operator/session', { method: 'DELETE', cookie });
    assert.equal(signedOut.status, 200, signedOut.text);
    assert.equal(signedOut.body.revoked, true);
    assert.match(signedOut.cookies[0] ?? '', /Max-Age=0/);
    assert.equal((await callApi(console.url, '/api/operator/health', { cookie })).status, 401);
  } finally {
    await console.stop();
  }
});

test('a recovery code signs an Operator in exactly once', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const credentials = await enrolOperator(console.url, fixture);
    const recoveryCode = credentials.recovery_codes[0] ?? '';
    const accepted = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, recovery_code: recoveryCode },
    });
    assert.equal(accepted.status, 200, accepted.text);
    const replayed = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, recovery_code: recoveryCode },
    });
    assert.equal(replayed.status, 401, replayed.text);
    assert.equal(replayed.body.code, 'OPERATOR_AUTHENTICATION_FAILED');
  } finally {
    await console.stop();
  }
});

test('the console license view and the lifecycle CLI report the same license', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const credentials = await enrolOperator(console.url, fixture);
    const signedIn = await callApi(console.url, '/api/operator/session', {
      body: { username: OPERATOR, password: PASSWORD, totp: totpCode(credentials.totp_secret) },
    });
    const cookie = (signedIn.cookies[0] ?? '').split(';')[0] ?? '';
    const api = await callApi(console.url, '/api/operator/license', { cookie });
    assert.equal(api.status, 200, api.text);

    const cli = command(fixture, ['console', 'license']);
    assert.equal(cli.status, 0, cli.stderr);
    for (const field of ['license_id', 'not_before', 'expires_at', 'highest_eligible_release', 'release', 'deployment_id', 'state']) {
      assert.equal(api.body[field], cli.output[field], field);
    }
  } finally {
    await console.stop();
  }
});

/** Enrolls one Operator through the supported lifecycle commands and console API. */
async function enrolOperator(url: string, fixture: Parameters<typeof command>[0]) {
  const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  if (issued.status !== 0) throw new Error(`console enroll failed: ${issued.stderr}`);
  const enrolled = await callApi(url, '/api/operator/enrollment', {
    body: { enrollment_secret: String(issued.output.enrollment_secret), password: PASSWORD },
  });
  if (enrolled.status !== 201) throw new Error(`enrollment exchange failed: ${enrolled.text}`);
  return enrolled.body as unknown as { totp_secret: string; recovery_codes: string[] };
}

test('operator enrollment secrets expire and are revocable before they are used', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const unknown = await callApi(console.url, '/api/operator/enrollment', {
      body: { enrollment_secret: 'not-a-real-secret', password: PASSWORD },
    });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.code, 'OPERATOR_ENROLLMENT_INVALID');

    const expiring = command(fixture, ['console', 'enroll', '--operator', OPERATOR, '--ttl-minutes', '0.01']);
    assert.equal(expiring.status, 0, expiring.stderr);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const expired = await callApi(console.url, '/api/operator/enrollment', {
      body: { enrollment_secret: String(expiring.output.enrollment_secret), password: PASSWORD },
    });
    assert.equal(expired.status, 401, expired.text);
    assert.equal(expired.body.code, 'OPERATOR_ENROLLMENT_EXPIRED');

    const revocable = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
    const revocation = command(fixture, ['console', 'revoke-enrollment', '--enrollment', String(revocable.output.enrollment_id)]);
    assert.equal(revocation.status, 0, revocation.stderr);
    assert.equal(revocation.output.revoked, true);
    const revoked = await callApi(console.url, '/api/operator/enrollment', {
      body: { enrollment_secret: String(revocable.output.enrollment_secret), password: PASSWORD },
    });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.code, 'OPERATOR_ENROLLMENT_REVOKED');
    const again = command(fixture, ['console', 'revoke-enrollment', '--enrollment', String(revocable.output.enrollment_id)]);
    assert.equal(again.status, 2);
    assert.equal(again.error.code, 'OPERATOR_ENROLLMENT_INACTIVE');
  } finally {
    await console.stop();
  }
});
