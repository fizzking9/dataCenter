import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  command,
  contextEntries,
  createUser,
  createWorkspace,
  initializePlatform,
  registerTotp,
  sessionFor,
  signIn,
} from '../support/platform.js';

test('Deployment Administrators hold no implicit Workspace content access', () => {
  const fixture = initializePlatform();
  const administrator = fixture.administrator;
  const administratorToken = sessionFor(fixture, administrator.username, administrator.password);

  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  const operationsWorkspace = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');

  const published = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', operationsWorkspace, '--entries', contextEntries(fixture, 'operations', [
      { key: 'refund_window_days', kind: 'metric', value: '30' },
    ])],
    { token: operationsToken },
  );
  assert.equal(published.status, 0, published.stderr);

  const administratorRead = command(
    fixture,
    ['context', 'show', '--workspace', operationsWorkspace],
    { token: administratorToken },
  );
  assert.equal(administratorRead.status, 2);
  assert.equal(administratorRead.error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(administratorRead.stdout, '');

  const unknownWorkspace = command(
    fixture,
    ['context', 'show', '--workspace', '00000000-0000-4000-8000-000000000000'],
    { token: administratorToken },
  );
  assert.equal(unknownWorkspace.status, 2);
  assert.equal(unknownWorkspace.error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(unknownWorkspace.error.message, administratorRead.error.message);

  const listing = command(fixture, ['workspace', 'list'], { token: administratorToken });
  assert.equal(listing.status, 0, listing.stderr);
  const workspaceIds = (listing.output.workspaces as Array<{ workspace_id: string }>).map((entry) => entry.workspace_id);
  assert.deepEqual(workspaceIds, [operationsWorkspace]);
});

test('Workspace Administrators stay inside their assigned Workspace', () => {
  const fixture = initializePlatform();
  const administrator = fixture.administrator;
  const administratorToken = sessionFor(fixture, administrator.username, administrator.password);

  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  createUser(fixture, administratorToken, 'isolation@example.invalid', 'isolation-administrator');
  createUser(fixture, administratorToken, 'analyst@example.invalid', 'operations-analyst-password');
  const operationsWorkspace = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const isolationWorkspace = createWorkspace(fixture, administratorToken, 'Isolation', 'isolation@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');

  const foreignGrant = command(
    fixture,
    ['membership', 'grant', '--workspace', isolationWorkspace, '--username', 'operations@example.invalid', '--role', 'Consumer'],
    { token: operationsToken },
  );
  assert.equal(foreignGrant.status, 2);
  assert.equal(foreignGrant.error.code, 'WORKSPACE_ACCESS_DENIED');

  const foreignRead = command(
    fixture,
    ['context', 'show', '--workspace', isolationWorkspace],
    { token: operationsToken },
  );
  assert.equal(foreignRead.status, 2);
  assert.equal(foreignRead.error.code, 'WORKSPACE_ACCESS_DENIED');

  const ownGrant = command(
    fixture,
    ['membership', 'grant', '--workspace', operationsWorkspace, '--username', 'analyst@example.invalid', '--role', 'Consumer'],
    { token: operationsToken },
  );
  assert.equal(ownGrant.status, 0, ownGrant.stderr);
  assert.equal(ownGrant.output.role, 'Consumer');
  assert.equal(ownGrant.output.username, 'analyst@example.invalid');

  const listing = command(fixture, ['workspace', 'list'], { token: operationsToken });
  assert.equal(listing.status, 0, listing.stderr);
  const visible = listing.output.workspaces as Array<{ workspace_id: string; role: string }>;
  assert.deepEqual(visible.map((entry) => entry.workspace_id), [operationsWorkspace]);
  assert.equal(visible[0]?.role, 'Workspace Administrator');
});

test('Consumers reach no Workspace configuration or Audit Events', () => {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  createUser(fixture, administratorToken, 'analyst@example.invalid', 'operations-analyst-password');
  const workspaceId = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');
  const analystToken = sessionFor(fixture, 'analyst@example.invalid', 'operations-analyst-password');

  const granted = command(
    fixture,
    ['membership', 'grant', '--workspace', workspaceId, '--username', 'analyst@example.invalid', '--role', 'Consumer'],
    { token: operationsToken },
  );
  assert.equal(granted.status, 0, granted.stderr);

  const configuration = command(fixture, ['context', 'show', '--workspace', workspaceId], { token: analystToken });
  assert.equal(configuration.status, 2);
  assert.equal(configuration.error.code, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(configuration.stdout, '');

  const audit = command(fixture, ['audit', 'list'], { token: analystToken });
  assert.equal(audit.status, 2);
  assert.equal(audit.error.code, 'AUTHORIZATION_DENIED');
});

test('a Workspace Administrator is enrolled for MFA when the Role is granted', () => {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  createUser(fixture, administratorToken, 'successor@example.invalid', 'successor-administrator');
  const workspaceId = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');

  const passwordOnly = command(fixture, ['login', '--username', 'successor@example.invalid', '--password-stdin'], {
    input: 'successor-administrator\n',
  });
  assert.equal(passwordOnly.status, 0, passwordOnly.stderr);
  assert.equal(passwordOnly.output.mfa_enrolled, false);

  const granted = command(
    fixture,
    ['membership', 'grant', '--workspace', workspaceId, '--username', 'successor@example.invalid', '--role', 'Workspace Administrator'],
    { token: operationsToken },
  );
  assert.equal(granted.status, 0, granted.stderr);
  assert.equal(typeof granted.output.totp_secret, 'string');
  assert.equal((granted.output.recovery_codes as unknown[]).length, 8);
  registerTotp(fixture, 'successor@example.invalid', granted.output.totp_secret);

  const withoutCode = command(fixture, ['login', '--username', 'successor@example.invalid', '--password-stdin'], {
    input: 'successor-administrator\n',
  });
  assert.equal(withoutCode.status, 2);
  assert.equal(withoutCode.error.code, 'AUTHENTICATION_FAILED');

  const enrolled = signIn(fixture, 'successor@example.invalid', 'successor-administrator');
  assert.equal(enrolled.status, 0, enrolled.stderr);
  assert.equal(enrolled.output.mfa_enrolled, true);
  assert.deepEqual(enrolled.output.workspace_roles, [{ workspace_id: workspaceId, role: 'Workspace Administrator' }]);
});
