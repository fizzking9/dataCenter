import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHttpSource, publishConnection, readySource } from '../support/acquisition.js';
import { callApi, startConsole } from '../support/console.js';
import { EXTENDED_LEDGER_CONTRACT, LEDGER, acquireAndRelease, publishSource } from '../support/data-product.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { totpCode } from '../support/totp.js';
import type { OperatorResult } from '../support/operator.js';
import {
  command,
  createUser,
  createWorkspace,
  grantRole,
  jsonFile,
  sessionFor,
  textFile,
  totpSecretFor,
  workspaceFixture,
  type PlatformFixture,
} from '../support/platform.js';

const ABSENT = '00000000-0000-4000-8000-000000000000';

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

/** The exact structured refusal a governed command answered with. */
function refusal(result: OperatorResult): Record<string, unknown> {
  assert.equal(result.status, 2, `expected a structured refusal, got status ${result.status}: ${result.stdout} ${result.stderr}`);
  assert.equal(result.stdout, '', 'a refusal never writes a success payload');
  return result.error;
}

/**
 * Asserts that naming a foreign object answers exactly like naming one that does
 * not exist: same code, same message, same next step, no payload, no existence.
 */
function sameness(foreign: OperatorResult, absent: OperatorResult, what: string): void {
  const left = refusal(foreign);
  const right = refusal(absent);
  assert.deepEqual(left, right, `${what}: a foreign identifier must answer exactly like an absent one`);
}

function publishLedgerProduct(fixture: PlatformFixture, token: string, workspaceId: string): string {
  const sourceId = publishSource(fixture, token, workspaceId);
  acquireAndRelease(fixture, token, sourceId, LEDGER, 'adversarial-ledger.csv');
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账', '--contract', jsonFile(fixture, 'adversarial-contract', EXTENDED_LEDGER_CONTRACT)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  return String(published.output['data_product_id']);
}

function query(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'adversarial-query', { include_totals: true, ...request })],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function queryRefusal(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
): Record<string, unknown> {
  return refusal(command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'adversarial-query-refused', request)],
    { token },
  ));
}

function runIdOf(fixture: PlatformFixture, token: string, sourceId: string): string {
  const queue = command(fixture, ['acquisition', 'queue', '--source', sourceId], { token });
  assert.equal(queue.status, 0, queue.stderr);
  const runs = queue.output['runs'] as Array<Record<string, unknown>>;
  return String(runs[0]?.['acquisition_run_id']);
}

/** Signs one User in over the browser API and returns the session cookie. */
async function browserCookie(url: string, fixture: PlatformFixture, username: string, password: string): Promise<string> {
  const admin = username !== 'analyst@example.invalid';
  const signedIn = await callApi(url, '/api/session', {
    body: { username, password, ...(admin ? { totp: totpCode(totpSecretFor(fixture, username)) } : {}) },
  });
  assert.equal(signedIn.status, 200, signedIn.text);
  const cookie = signedIn.cookies[0];
  assert.ok(cookie);
  return cookie.split(';')[0]!;
}

test('cross-Workspace substitution, raw, draft, credential, and configuration attempts reveal no existence', async () => {
  const base = workspaceFixture();
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken, consumerToken } = base;
  const productId = publishLedgerProduct(fixture, workspaceAdministratorToken, workspaceId);
  const sourceId = String(
    (command(fixture, ['source', 'list', '--workspace', workspaceId], { token: workspaceAdministratorToken })
      .output['sources'] as Array<Record<string, unknown>>)[0]?.['source_id'],
  );
  const runId = runIdOf(fixture, workspaceAdministratorToken, sourceId);
  const connection = publishConnection(fixture, workspaceId, workspaceAdministratorToken, {
    name: '外部设备接口',
    baseUrl: 'http://127.0.0.1:9',
  });
  const grant = command(
    fixture,
    ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid', '--request', jsonFile(fixture, 'adversarial-grant', { columns: ['sn', 'city'], row_filters: [] })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(grant.status, 0, grant.stderr);
  const grantId = String(grant.output['grant_id']);
  const exported = command(
    fixture,
    ['export', 'create', '--product', productId, '--request', jsonFile(fixture, 'adversarial-export', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(exported.status, 0, exported.stderr);
  const exportId = String(exported.output['export_id']);

  // A second Workspace whose administrator substitutes every identifier it can
  // learn from a shared link, a log line, or a guessed UUID.
  createUser(fixture, deploymentAdministratorToken, 'isolation-admin@example.invalid', 'isolation-password');
  const otherWorkspaceId = createWorkspace(fixture, deploymentAdministratorToken, '隔离工作区', 'isolation-admin@example.invalid');
  assert.notEqual(otherWorkspaceId, workspaceId);
  const outsiderToken = sessionFor(fixture, 'isolation-admin@example.invalid', 'isolation-password');

  const substitutions: Array<{ what: string; foreign: OperatorResult; absent: OperatorResult }> = [
    {
      what: 'Data Product query',
      foreign: command(fixture, ['product', 'query', '--product', productId, '--request', jsonFile(fixture, 'iso-product', { kind: 'records' })], { token: outsiderToken }),
      absent: command(fixture, ['product', 'query', '--product', ABSENT, '--request', jsonFile(fixture, 'iso-product-absent', { kind: 'records' })], { token: outsiderToken }),
    },
    {
      what: 'Data Product Releases',
      foreign: command(fixture, ['product', 'releases', '--product', productId], { token: outsiderToken }),
      absent: command(fixture, ['product', 'releases', '--product', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'Dataset read',
      foreign: command(fixture, ['dataset', 'show', '--source', sourceId], { token: outsiderToken }),
      absent: command(fixture, ['dataset', 'show', '--source', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'Acquisition Plan',
      foreign: command(fixture, ['acquisition', 'plan', '--run', runId], { token: outsiderToken }),
      absent: command(fixture, ['acquisition', 'plan', '--run', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'Acquisition Run cancellation',
      foreign: command(fixture, ['acquisition', 'cancel', '--run', runId], { token: outsiderToken }),
      absent: command(fixture, ['acquisition', 'cancel', '--run', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'Acquisition Connection session',
      foreign: command(fixture, ['connection', 'session', '--connection', connection.connectionId], { token: outsiderToken }),
      absent: command(fixture, ['connection', 'session', '--connection', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'Acquisition Connection pacing',
      foreign: command(fixture, ['connection', 'pacing', '--connection', connection.connectionId], { token: outsiderToken }),
      absent: command(fixture, ['connection', 'pacing', '--connection', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'Data Product Grant revocation',
      foreign: command(fixture, ['grant', 'revoke', '--grant', grantId], { token: outsiderToken }),
      absent: command(fixture, ['grant', 'revoke', '--grant', ABSENT], { token: outsiderToken }),
    },
    {
      what: 'governed export download',
      foreign: command(fixture, ['export', 'download', '--export', exportId], { token: outsiderToken }),
      absent: command(fixture, ['export', 'download', '--export', ABSENT], { token: outsiderToken }),
    },
  ];
  for (const substitution of substitutions) sameness(substitution.foreign, substitution.absent, substitution.what);

  // A Consumer inside the Workspace still holds no raw, draft, or configuration
  // surface: the same identifier answers as if it did not exist.
  sameness(
    command(fixture, ['dataset', 'show', '--source', sourceId], { token: consumerToken }),
    command(fixture, ['dataset', 'show', '--source', ABSENT], { token: consumerToken }),
    'Consumer raw dataset read',
  );
  sameness(
    command(fixture, ['acquisition', 'plan', '--run', runId], { token: consumerToken }),
    command(fixture, ['acquisition', 'plan', '--run', ABSENT], { token: consumerToken }),
    'Consumer Acquisition Plan read',
  );
  sameness(
    command(fixture, ['connection', 'session', '--connection', connection.connectionId], { token: consumerToken }),
    command(fixture, ['connection', 'session', '--connection', ABSENT], { token: consumerToken }),
    'Consumer credential surface',
  );
  sameness(
    command(fixture, ['product', 'query', '--product', ABSENT, '--request', jsonFile(fixture, 'draft-read', { kind: 'records' })], { token: consumerToken }),
    command(fixture, ['product', 'query', '--product', '00000000-0000-4000-8000-000000000001', '--request', jsonFile(fixture, 'draft-read-2', { kind: 'records' })], { token: consumerToken }),
    'draft Data Product read',
  );
  assert.equal(refusal(command(fixture, ['connection', 'list', '--workspace', workspaceId], { token: consumerToken }))['code'], 'WORKSPACE_ACCESS_DENIED');

  // Neither a raw-acquisition nor a configuration shape is an exportable query.
  assert.equal(queryRefusal(fixture, consumerToken, productId, { kind: 'records', raw_acquisitions: true })['code'], 'DATA_PRODUCT_QUERY_INVALID');
  assert.equal(queryRefusal(fixture, consumerToken, productId, { kind: 'records', select: 'configuration' })['code'], 'DATA_PRODUCT_QUERY_INVALID');
  assert.equal(queryRefusal(fixture, consumerToken, productId, { kind: 'raw', path: 'raw-acquisitions' })['code'], 'DATA_PRODUCT_QUERY_INVALID');

  // The same substitution over the HTTP Data Product API answers identically.
  const consoleServer = await startConsole(fixture);
  try {
    const cookie = await browserCookie(consoleServer.url, fixture, 'analyst@example.invalid', 'analyst-consumer');
    const ownPath = `/api/workspaces/${workspaceId}/data-products/${productId}/query`;
    const served = await callApi(consoleServer.url, ownPath, { token: consumerToken, body: { kind: 'records' } });
    assert.equal(served.status, 200, served.text);
    const foreignPath = await callApi(consoleServer.url, `/api/workspaces/${otherWorkspaceId}/data-products/${productId}/query`, {
      token: consumerToken,
      body: { kind: 'records' },
    });
    const absentPath = await callApi(consoleServer.url, `/api/workspaces/${otherWorkspaceId}/data-products/${ABSENT}/query`, {
      token: consumerToken,
      body: { kind: 'records' },
    });
    assert.equal(foreignPath.status, absentPath.status);
    assert.deepEqual(foreignPath.body, absentPath.body, 'the API path never confirms a foreign object');
    // The published API path names its Workspace, so the substituting caller's
    // own Bearer credential reaches it exactly as the advertised link does.
    const rawExport = await callApi(consoleServer.url, `/api/workspace/products/${productId}/exports?workspace_id=${workspaceId}`, {
      cookie,
      body: { request: { kind: 'records', raw_acquisitions: true } },
    });
    assert.equal(rawExport.status, 400, rawExport.text);
    assert.equal(rawExport.body['code'], 'DATA_PRODUCT_QUERY_INVALID');
    const ownExports = await callApi(consoleServer.url, `/api/workspace/exports?workspace_id=${workspaceId}`, { cookie });
    assert.equal(ownExports.status, 403, 'a Consumer holds no Workspace export listing');
    const rawText = `${foreignPath.text}${absentPath.text}${rawExport.text}`;
    assert.equal(rawText.includes('SN-001'), false, 'no refusal carries governed values');
  } finally {
    await consoleServer.stop();
  }
});

test('row and column inference through records, counts, groupings, exports, and discovery reveals no withheld value', () => {
  const base = workspaceFixture();
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken, deploymentAdministratorToken } = base;
  const productId = publishLedgerProduct(fixture, workspaceAdministratorToken, workspaceId);

  // One Grant permits two columns and one city: everything else is withheld.
  const grant = command(
    fixture,
    ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid', '--request', jsonFile(fixture, 'inference-grant', {
      columns: ['sn', 'city'],
      row_filters: [{ field: 'city', op: 'equals', value: '杭州' }],
    })],
    { token: workspaceAdministratorToken },
  );
  assert.equal(grant.status, 0, grant.stderr);

  const records = query(fixture, consumerToken, productId, { kind: 'records' });
  assert.deepEqual(records['records'], [{ sn: 'sn-001', city: '杭州' }]);
  assert.equal(records['matched_count'], 1);
  assert.equal(records['scanned_records'], 1, 'the scan never counts rows the Grant withholds');
  assert.equal(asRecord(records['provenance'])['record_count'], null, 'the Release total stays withheld');

  const totals = query(fixture, consumerToken, productId, { kind: 'aggregate', metrics: ['device_count'], include_totals: true });
  assert.deepEqual(totals['totals'], { metrics: { device_count: 1 } });

  // Every inference channel over a withheld column is refused rather than answered.
  const channels: Array<Record<string, unknown>> = [
    { kind: 'records', filters: [{ field: 'handled_count', op: 'greater_or_equal', value: 1 }] },
    { kind: 'records', filters: [{ field: 'settled_amount', op: 'is_not_null' }] },
    { kind: 'aggregate', group_by: ['handled_count'] },
    { kind: 'aggregate', metrics: ['settled_total'] },
    { kind: 'aggregate', metrics: ['handled_total'] },
    { kind: 'aggregate', metrics: ['device_count'], metric_filters: [{ metric: 'settled_total', op: 'greater_than', value: 0 }] },
  ];
  for (const channel of channels) {
    const refused = queryRefusal(fixture, consumerToken, productId, channel);
    assert.ok(
      refused['code'] === 'DATA_PRODUCT_QUERY_REFUSED' || refused['code'] === 'DATA_PRODUCT_QUERY_INVALID',
      `every channel over a withheld column is refused: ${JSON.stringify(channel)} answered ${JSON.stringify(refused)}`,
    );
  }

  // Discovery is narrowed the same way, and no refused answer echoes a value.
  const listed = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumerToken });
  assert.equal(listed.status, 0, listed.stderr);
  const entry = (listed.output['data_products'] as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(entry['fields'], ['sn', 'city']);
  assert.deepEqual((entry['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']), ['device_count']);
  assert.equal(JSON.stringify(records).includes('120.5'), false);
  assert.equal(JSON.stringify(records).includes('300'), false);

  // The export carries the same narrowing, and the encrypted object betrays nothing.
  const exported = command(
    fixture,
    ['export', 'create', '--product', productId, '--request', jsonFile(fixture, 'inference-export', { kind: 'records' })],
    { token: consumerToken },
  );
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(exported.output['row_count'], 1);
  assert.deepEqual(exported.output['columns'], ['sn', 'city']);
  const stored = readFileSync(join(fixture.root, String(exported.output['object_path'])), 'utf8');
  assert.equal(stored.includes('120.5'), false);

  // A second Consumer in the same Workspace cannot download the first one's
  // export; the identifier answers exactly like one that never existed.
  createUser(fixture, deploymentAdministratorToken, 'analyst-two@example.invalid', 'analyst-two-password');
  grantRole(fixture, workspaceAdministratorToken, workspaceId, 'analyst-two@example.invalid', 'Consumer');
  const secondToken = sessionFor(fixture, 'analyst-two@example.invalid', 'analyst-two-password');
  const exportId = String(exported.output['export_id']);
  sameness(
    command(fixture, ['export', 'download', '--export', exportId], { token: secondToken }),
    command(fixture, ['export', 'download', '--export', ABSENT], { token: secondToken }),
    'another Consumer downloading a governed export',
  );
  const ownDownload = command(fixture, ['export', 'download', '--export', exportId], { token: consumerToken });
  assert.equal(ownDownload.status, 0, `the producer still downloads its own export: ${ownDownload.stderr}`);
});

test('a poisoned cache entry is a miss, and queued work honors the authorization in force when it runs', async () => {
  const base = workspaceFixture();
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken } = base;
  const productId = publishLedgerProduct(fixture, workspaceAdministratorToken, workspaceId);

  // Two governed reads with different shapes both land in the page cache.
  const requestFile = jsonFile(fixture, 'cache-query', { kind: 'records' });
  const otherFile = jsonFile(fixture, 'cache-query-two', { kind: 'aggregate', metrics: ['device_count'] });
  const first = command(fixture, ['product', 'query', '--product', productId, '--request', requestFile], { token: workspaceAdministratorToken });
  assert.equal(first.status, 0, first.stderr);
  const second = command(fixture, ['product', 'query', '--product', productId, '--request', otherFile], { token: workspaceAdministratorToken });
  assert.equal(second.status, 0, second.stderr);

  const cacheDirectory = join(fixture.root, 'cache', 'query-results');
  const pages = readdirSync(cacheDirectory).filter((name) => name.endsWith('.json'));
  assert.equal(pages.length, 2, 'two distinct reads hold two cache pages');
  const [left, right] = pages;

  // A host-level attacker swaps one page's bytes for another's. The recorded key
  // no longer matches the file it is stored under, so neither page is reused.
  const leftBytes = readFileSync(join(cacheDirectory, left!));
  writeFileSync(join(cacheDirectory, left!), readFileSync(join(cacheDirectory, right!)));
  writeFileSync(join(cacheDirectory, right!), leftBytes);
  const afterSwap = command(fixture, ['product', 'query', '--product', productId, '--request', requestFile], { token: workspaceAdministratorToken });
  assert.equal(afterSwap.status, 0, afterSwap.stderr);
  assert.equal(asRecord(afterSwap.output['cache'])['reused'], false, 'a swapped page is never reused');
  assert.deepEqual(afterSwap.output['records'], first.output['records'], 'the answer is recomputed from governed data');

  // A page replaced with something that is not a sealed entry is a miss too.
  for (const name of readdirSync(cacheDirectory)) rmSync(join(cacheDirectory, name), { force: true });
  const again = command(fixture, ['product', 'query', '--product', productId, '--request', requestFile], { token: workspaceAdministratorToken });
  assert.equal(again.status, 0, again.stderr);
  const recomputed = readdirSync(cacheDirectory).filter((name) => name.endsWith('.json'));
  assert.equal(recomputed.length, 1, 'the recomputed read wrote exactly one page');
  const poisoned = join(cacheDirectory, recomputed[0]!);
  writeFileSync(poisoned, `${JSON.stringify({ key: 'forged', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), response: { forged: 'attacker payload' } })}\n`);
  const afterPoison = command(fixture, ['product', 'query', '--product', productId, '--request', requestFile], { token: workspaceAdministratorToken });
  assert.equal(afterPoison.status, 0, afterPoison.stderr);
  assert.equal(asRecord(afterPoison.output['cache'])['reused'], false, 'an unsealed page is never reused');
  assert.deepEqual(afterPoison.output['records'], first.output['records']);
  assert.equal(afterPoison.stdout.includes('attacker payload'), false);

  // Leave only the two genuine pages behind for the rest of the test.
  for (const path of readdirSync(cacheDirectory).map((name) => join(cacheDirectory, name))) rmSync(path, { force: true });

  // Queued work runs only under the authorization in force when it starts.
  const server = await startHttpSource({ replies: [{ body: pageBody([{ device_sn: 'sn-001', city: '杭州', handled_count: 3 }]) }] });
  try {
    const source = await readySource(server, { workspace: base, pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 2 } });
    const enqueued = command(fixture, ['acquisition', 'enqueue', '--source', source.sourceId], { token: source.workspaceAdministratorToken });
    assert.equal(enqueued.status, 0, enqueued.stderr);

    createUser(fixture, deploymentAdministratorToken, 'operations-two@example.invalid', 'operations-two-password');
    grantRole(fixture, workspaceAdministratorToken, workspaceId, 'operations-two@example.invalid', 'Workspace Administrator');
    const secondAdministrator = sessionFor(fixture, 'operations-two@example.invalid', 'operations-two-password');
    const revoked = command(
      fixture,
      ['membership', 'revoke', '--workspace', workspaceId, '--username', 'operations@example.invalid'],
      { token: secondAdministrator },
    );
    assert.equal(revoked.status, 0, revoked.stderr);

    assert.equal(
      refusal(command(fixture, ['acquisition', 'work', '--source', source.sourceId], { token: workspaceAdministratorToken }))['code'],
      'SOURCE_NOT_AVAILABLE',
      'a queued Run is not worked by an actor who lost the Workspace',
    );
    const queue = command(fixture, ['acquisition', 'queue', '--source', source.sourceId], { token: secondAdministrator });
    assert.equal(queue.status, 0, queue.stderr);
    assert.equal(queue.output['queued'], 1, 'refused work leaves the Run queued');
    assert.equal(server.requests().length, 0, 'a refused worker reads nothing from the target');

    grantRole(fixture, secondAdministrator, workspaceId, 'operations@example.invalid', 'Workspace Administrator');
    const worked = command(fixture, ['acquisition', 'work', '--source', source.sourceId], { token: workspaceAdministratorToken });
    assert.equal(worked.status, 0, worked.stderr);
    assert.equal(worked.output['status'], 'complete');

    // Revocation is next-request: the same session token stops working.
    const loggedOut = command(fixture, ['logout'], { token: workspaceAdministratorToken });
    assert.equal(loggedOut.status, 0, loggedOut.stderr);
    assert.equal(
      refusal(command(fixture, ['workspace', 'list'], { token: workspaceAdministratorToken }))['code'],
      'SESSION_INVALID',
      'a revoked session is stale on the very next request',
    );
  } finally {
    await server.close();
  }
});

test('audit unavailability stops protected operations without persisting, and tampering stays detectable', () => {
  const base = workspaceFixture();
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken } = base;
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId, LEDGER, 'audit-baseline.csv');

  const statePath = join(fixture.root, 'state', 'platform.json');
  const rawDirectory = join(fixture.root, 'raw-acquisitions');
  const before = readFileSync(statePath, 'utf8');
  const rawBefore = existsSync(rawDirectory) ? readdirSync(rawDirectory).length : 0;

  // An audit log that cannot be appended is unavailable, not merely empty.
  const eventsPath = join(fixture.root, 'audit', 'events.jsonl');
  const savedEvents = readFileSync(eventsPath, 'utf8');
  renameSync(eventsPath, `${eventsPath}.saved`);
  mkdirSync(eventsPath);

  try {
    const upload = command(
      fixture,
      ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'audit-blocked.csv', LEDGER)],
      { token: workspaceAdministratorToken },
    );
    assert.equal(refusal(upload)['code'], 'AUDIT_LOG_UNAVAILABLE');
    assert.equal(readFileSync(statePath, 'utf8'), before, 'an unauditable acquisition persists nothing');
    assert.equal(existsSync(rawDirectory) ? readdirSync(rawDirectory).length : 0, rawBefore, 'no Raw Acquisition object is written');

    const grant = command(
      fixture,
      ['membership', 'grant', '--workspace', workspaceId, '--username', 'analyst@example.invalid', '--role', 'Consumer'],
      { token: workspaceAdministratorToken },
    );
    assert.equal(refusal(grant)['code'], 'AUDIT_LOG_UNAVAILABLE', 'a governed write stops when its Audit Event cannot be appended');
    assert.equal(readFileSync(statePath, 'utf8'), before);

    assert.equal(
      refusal(command(fixture, ['product', 'list', '--workspace', workspaceId], { token: workspaceAdministratorToken }))['code'],
      'AUDIT_LOG_UNAVAILABLE',
      'a protected read is stopped too, because every governed operation is audited',
    );
  } finally {
    rmSync(eventsPath, { recursive: true, force: true });
    renameSync(`${eventsPath}.saved`, eventsPath);
  }

  // With the log restored the same operation completes exactly once.
  const upload = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'audit-restored.csv', LEDGER)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(upload.status, 0, upload.stderr);

  // A forged tail cannot rewrite history: the signed checkpoint no longer
  // matches, so the tamper is visible and the next governed write stops.
  const restoredState = readFileSync(statePath, 'utf8');
  writeFileSync(eventsPath, `${readFileSync(eventsPath, 'utf8')}${JSON.stringify({ sequence: 999_999, event_id: 'forged', actor: 'forged@example.invalid' })}\n`);
  const listing = command(fixture, ['audit', 'list'], { token: deploymentAdministratorToken });
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.output['chain_valid'], false);
  assert.equal(
    refusal(command(fixture, ['workspace', 'list'], { token: deploymentAdministratorToken }))['code'],
    'AUDIT_INTEGRITY_FAILED',
  );
  assert.equal(readFileSync(statePath, 'utf8'), restoredState, 'a refused operation persists nothing');
});
