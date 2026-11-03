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

test('ownership transfer and last-administrator safeguards prevent orphaned Artifacts and administrators', () => {
  const fixture = initializePlatform();
  const bootstrap = fixture.administrator;
  const bootstrapToken = sessionFor(fixture, bootstrap.username, bootstrap.password);
  createUser(fixture, bootstrapToken, 'second.admin@example.invalid', 'second-administrator', true);
  createUser(fixture, bootstrapToken, 'consumer@example.invalid', 'consumer-account-password');

  const published = command(
    fixture,
    ['context', 'publish-common', '--entries', contextEntries(fixture, 'common', [
      { key: 'refund_window_days', kind: 'metric', value: '30' },
    ])],
    { token: bootstrapToken },
  );
  assert.equal(published.status, 0, published.stderr);

  const ineligible = command(
    fixture,
    ['ownership', 'transfer', '--from', bootstrap.username, '--to', 'consumer@example.invalid'],
    { token: bootstrapToken },
  );
  assert.equal(ineligible.status, 2);
  assert.equal(ineligible.error.code, 'OWNER_NOT_ELIGIBLE');

  const blocked = command(
    fixture,
    ['user', 'deactivate', '--username', bootstrap.username],
    { token: bootstrapToken },
  );
  assert.equal(blocked.status, 2);
  assert.equal(blocked.error.code, 'OWNER_TRANSFER_REQUIRED');

  const transferred = command(
    fixture,
    ['ownership', 'transfer', '--from', bootstrap.username, '--to', 'second.admin@example.invalid'],
    { token: bootstrapToken },
  );
  assert.equal(transferred.status, 0, transferred.stderr);
  assert.equal(transferred.output.transferred, 1);
  assert.equal(transferred.output.owner, 'second.admin@example.invalid');

  const deactivated = command(
    fixture,
    ['user', 'deactivate', '--username', bootstrap.username],
    { token: bootstrapToken },
  );
  assert.equal(deactivated.status, 0, deactivated.stderr);

  const revoked = command(fixture, ['workspace', 'list'], { token: bootstrapToken });
  assert.equal(revoked.status, 2);
  assert.equal(revoked.error.code, 'SESSION_INVALID');

  const secondToken = sessionFor(fixture, 'second.admin@example.invalid', 'second-administrator');
  const lastAdministrator = command(
    fixture,
    ['user', 'deactivate', '--username', 'second.admin@example.invalid'],
    { token: secondToken },
  );
  assert.equal(lastAdministrator.status, 2);
  assert.equal(lastAdministrator.error.code, 'LAST_ADMINISTRATOR_PROTECTED');
});

test('a Workspace cannot be left without an active Workspace Administrator', () => {
  const fixture = initializePlatform();
  const bootstrapToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, bootstrapToken, 'operations@example.invalid', 'operations-administrator');
  createUser(fixture, bootstrapToken, 'successor@example.invalid', 'successor-administrator');
  const workspaceId = createWorkspace(fixture, bootstrapToken, 'Operations', 'operations@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');

  const ownRevocation = command(
    fixture,
    ['membership', 'revoke', '--workspace', workspaceId, '--username', 'operations@example.invalid'],
    { token: operationsToken },
  );
  assert.equal(ownRevocation.status, 2);
  assert.equal(ownRevocation.error.code, 'LAST_ADMINISTRATOR_PROTECTED');

  const deactivation = command(
    fixture,
    ['user', 'deactivate', '--username', 'operations@example.invalid'],
    { token: bootstrapToken },
  );
  assert.equal(deactivation.status, 2);
  assert.equal(deactivation.error.code, 'LAST_ADMINISTRATOR_PROTECTED');

  const granted = command(
    fixture,
    ['membership', 'grant', '--workspace', workspaceId, '--username', 'successor@example.invalid', '--role', 'Workspace Administrator'],
    { token: operationsToken },
  );
  assert.equal(granted.status, 0, granted.stderr);
  assert.equal(granted.output.role, 'Workspace Administrator');

  const allowed = command(
    fixture,
    ['user', 'deactivate', '--username', 'operations@example.invalid'],
    { token: bootstrapToken },
  );
  assert.equal(allowed.status, 0, allowed.stderr);

  const staleSession = command(fixture, ['workspace', 'list'], { token: operationsToken });
  assert.equal(staleSession.status, 2);
  assert.equal(staleSession.error.code, 'SESSION_INVALID');
});
