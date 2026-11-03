import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { command, contextEntries, createUser, createWorkspace, initializePlatform, sessionFor } from '../support/platform.js';

interface AuditRecord {
  sequence: number;
  actor: string;
  previous_hash: string;
  hash: string;
  [key: string]: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Simulates a host-level attacker editing the append-only log on disk. */
function tamperWithAuditLog(
  root: string,
  mutate: (records: AuditRecord[]) => AuditRecord[],
  recomputeChain: boolean,
): void {
  const path = join(root, 'audit', 'events.jsonl');
  const records = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
  const rewritten = mutate(records);
  if (recomputeChain) {
    let previous = '0'.repeat(64);
    for (const [index, record] of rewritten.entries()) {
      record.sequence = index + 1;
      record.previous_hash = previous;
      const { hash, ...rest } = record;
      record.hash = createHash('sha256').update(canonical(rest)).digest('hex');
      previous = record.hash;
    }
  }
  writeFileSync(path, `${rewritten.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function preparedDeployment() {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  const workspaceId = createWorkspace(fixture, administratorToken, 'Operations', 'operations@example.invalid');
  command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'operations', [
      { key: 'refund_window_days', kind: 'metric', value: '30' },
    ])],
    { token: sessionFor(fixture, 'operations@example.invalid', 'operations-administrator') },
  );
  return { fixture, administratorToken };
}

test('editing a recorded Audit Event is detected', () => {
  const { fixture, administratorToken } = preparedDeployment();

  tamperWithAuditLog(fixture.root, (records) => {
    records[1]!.actor = 'forged-actor@example.invalid';
    return records;
  }, false);

  const listing = command(fixture, ['audit', 'list'], { token: administratorToken });
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.output['chain_valid'], false);
});

test('a wholesale rewrite cannot forge the Audit Event chain and stops governed writes', () => {
  const { fixture, administratorToken } = preparedDeployment();

  tamperWithAuditLog(fixture.root, (records) => {
    records[1]!.actor = 'forged-actor@example.invalid';
    return records;
  }, true);

  const listing = command(fixture, ['audit', 'list'], { token: administratorToken });
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.output['chain_valid'], false);

  const write = command(fixture, ['workspace', 'list'], { token: administratorToken });
  assert.equal(write.status, 2);
  assert.equal(write.error.code, 'AUDIT_INTEGRITY_FAILED');
  assert.equal(write.stdout, '');
});
