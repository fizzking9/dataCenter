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

interface AuditEvent {
  sequence: number;
  action: string;
  scope: string;
  workspace_id?: string;
  outcome: string;
  actor: string;
  target?: string;
  detail?: Record<string, unknown>;
  previous_hash: string;
  hash: string;
}

interface AuditListing {
  chain_valid: boolean;
  events: AuditEvent[];
}

function auditListing(
  fixture: ReturnType<typeof initializePlatform>,
  token: string,
  workspaceId?: string,
): AuditListing {
  const result = command(
    fixture,
    ['audit', 'list', ...(workspaceId === undefined ? [] : ['--workspace', workspaceId])],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as AuditListing;
}

test('Audit Events are hash-chained, attributable, and free of Workspace payloads', () => {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  const workspaceId = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');

  const published = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'secret-entries', [
      { key: 'refund_window_days', kind: 'metric', value: 'confidential-business-value' },
    ])],
    { token: operationsToken },
  );
  assert.equal(published.status, 0, published.stderr);

  const listing = auditListing(fixture, administratorToken);
  assert.equal(listing.chain_valid, true);
  assert.equal(listing.events.length > 0, true);
  assert.deepEqual(listing.events.map((event) => event.sequence), listing.events.map((_, index) => index + 1));

  const publication = listing.events.find(
    (event) => event.action === 'business_context_publish' && event.workspace_id === workspaceId,
  );
  assert.ok(publication);
  assert.equal(publication.actor, 'operations@example.invalid');
  assert.equal(publication.outcome, 'succeeded');
  assert.equal(publication.scope, 'workspace');

  const serialized = JSON.stringify(listing.events);
  assert.equal(serialized.includes('confidential-business-value'), false);

  const authentication = listing.events.filter((event) => event.action === 'authentication');
  assert.equal(authentication.length > 0, true);
  assert.equal(authentication.some((event) => event.outcome === 'succeeded'), true);
});

test('denied cross-Workspace access is audited and Workspace audit views stay in scope', () => {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  createUser(fixture, administratorToken, 'isolation@example.invalid', 'isolation-administrator');
  const operationsWorkspace = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  const isolationWorkspace = createWorkspace(fixture, administratorToken, 'Isolation', 'isolation@example.invalid');
  const operationsToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');
  const isolationToken = sessionFor(fixture, 'isolation@example.invalid', 'isolation-administrator');

  command(
    fixture,
    ['context', 'publish-workspace', '--workspace', operationsWorkspace, '--entries', contextEntries(fixture, 'operations', [
      { key: 'refund_window_days', kind: 'metric', value: '30' },
    ])],
    { token: operationsToken },
  );
  command(
    fixture,
    ['context', 'publish-workspace', '--workspace', isolationWorkspace, '--entries', contextEntries(fixture, 'isolation', [
      { key: 'leakage_probe', kind: 'metric', value: '7' },
    ])],
    { token: isolationToken },
  );

  const denied = command(
    fixture,
    ['context', 'show', '--workspace', isolationWorkspace],
    { token: operationsToken },
  );
  assert.equal(denied.status, 2);
  assert.equal(denied.error.code, 'WORKSPACE_ACCESS_DENIED');

  const scoped = auditListing(fixture, operationsToken);
  assert.equal(scoped.chain_valid, true);
  assert.equal(scoped.events.length > 0, true);
  assert.deepEqual(
    [...new Set(scoped.events.map((event) => event.workspace_id))],
    [operationsWorkspace],
  );

  const foreignListing = command(
    fixture,
    ['audit', 'list', '--workspace', isolationWorkspace],
    { token: operationsToken },
  );
  assert.equal(foreignListing.status, 2);
  assert.equal(foreignListing.error.code, 'AUTHORIZATION_DENIED');

  const deployment = auditListing(fixture, administratorToken);
  const denial = deployment.events.find((event) => event.outcome === 'denied');
  assert.ok(denial);
  assert.equal(denial.action, 'business_context_read');
  assert.equal(denial.workspace_id, isolationWorkspace);
  assert.equal(denial.detail?.['error_code'], 'WORKSPACE_ACCESS_DENIED');
  assert.equal(denial.actor, 'operations@example.invalid');
  assert.equal(
    deployment.events.some((event) => event.action === 'business_context_publish' && event.workspace_id === operationsWorkspace),
    true,
  );
});
