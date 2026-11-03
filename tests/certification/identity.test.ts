import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command, initializePlatform, signIn } from '../support/platform.js';

const GENERIC_FAILURE = 'Authentication failed.';

test('administrators authenticate locally with MFA and single-use recovery codes', () => {
  const fixture = initializePlatform();
  const administrator = fixture.administrator;

  const unknownUser = command(
    fixture,
    ['login', '--username', 'nobody@example.invalid', '--password-stdin', '--totp', '000000'],
    { input: 'irrelevant-password-value\n' },
  );
  assert.equal(unknownUser.status, 2);
  assert.equal(unknownUser.error.code, 'AUTHENTICATION_FAILED');

  const wrongPassword = command(
    fixture,
    ['login', '--username', administrator.username, '--password-stdin', '--totp', '000000'],
    { input: 'wrong-password-value\n' },
  );
  assert.equal(wrongPassword.status, 2);
  assert.equal(wrongPassword.error.code, 'AUTHENTICATION_FAILED');

  const missingMfa = command(
    fixture,
    ['login', '--username', administrator.username, '--password-stdin'],
    { input: `${administrator.password}\n` },
  );
  assert.equal(missingMfa.status, 2);
  assert.equal(missingMfa.error.code, 'AUTHENTICATION_FAILED');

  assert.equal(unknownUser.error.message, wrongPassword.error.message);
  assert.equal(wrongPassword.error.message, missingMfa.error.message);
  assert.equal(missingMfa.error.message, GENERIC_FAILURE);
  assert.equal(missingMfa.stdout.includes(administrator.username), false);

  const authenticated = signIn(fixture, administrator.username, administrator.password);
  assert.equal(authenticated.status, 0, authenticated.stderr);
  assert.equal(authenticated.output.deployment_role, 'Deployment Administrator');
  assert.equal(authenticated.output.mfa_enrolled, true);
  assert.equal(typeof authenticated.output.session_token, 'string');
  assert.equal(Date.parse(String(authenticated.output.session_expires_at)) > Date.now(), true);
  assert.equal(authenticated.stdout.includes(administrator.password), false);
  assert.equal(authenticated.stdout.includes(administrator.totp_secret), false);

  const firstCode = administrator.recovery_codes[0]!;
  const recovered = command(
    fixture,
    ['login', '--username', administrator.username, '--password-stdin', '--recovery-code', firstCode],
    { input: `${administrator.password}\n` },
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.output.mfa_enrolled, true);

  const replayed = command(
    fixture,
    ['login', '--username', administrator.username, '--password-stdin', '--recovery-code', firstCode],
    { input: `${administrator.password}\n` },
  );
  assert.equal(replayed.status, 2);
  assert.equal(replayed.error.code, 'AUTHENTICATION_FAILED');
  assert.equal(replayed.error.message, GENERIC_FAILURE);
});

test('repeated credential failures throttle further attempts behind the same generic answer', () => {
  const fixture = initializePlatform();
  const administrator = fixture.administrator;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = command(
      fixture,
      ['login', '--username', administrator.username, '--password-stdin', '--totp', '000000'],
      { input: 'wrong-password-value\n' },
    );
    assert.equal(failed.status, 2);
    assert.equal(failed.error.code, 'AUTHENTICATION_FAILED');
    assert.equal(failed.error.message, GENERIC_FAILURE);
  }

  const throttled = signIn(fixture, administrator.username, administrator.password);
  assert.equal(throttled.status, 2);
  assert.equal(throttled.error.code, 'AUTHENTICATION_FAILED');
  assert.equal(throttled.error.message, GENERIC_FAILURE);
  assert.equal(throttled.stdout, '');
});

test('logout revokes the session on the next request', () => {
  const fixture = initializePlatform();
  const administrator = fixture.administrator;

  const signedIn = signIn(fixture, administrator.username, administrator.password);
  assert.equal(signedIn.status, 0, signedIn.stderr);
  const token = String(signedIn.output.session_token);

  const beforeLogout = command(fixture, ['workspace', 'list'], { token });
  assert.equal(beforeLogout.status, 0, beforeLogout.stderr);

  const loggedOut = command(fixture, ['logout'], { token });
  assert.equal(loggedOut.status, 0, loggedOut.stderr);
  assert.equal(loggedOut.output.revoked, true);

  const afterLogout = command(fixture, ['workspace', 'list'], { token });
  assert.equal(afterLogout.status, 2);
  assert.equal(afterLogout.error.code, 'SESSION_INVALID');
});
