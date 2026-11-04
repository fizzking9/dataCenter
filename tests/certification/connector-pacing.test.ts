import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { DEVICES, readySource } from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { runOperatorAsync } from '../support/operator.js';
import { command, type PlatformFixture } from '../support/platform.js';

interface WorkResult {
  acquisition_run_id: string;
  status: string;
  paced?: boolean;
  pacing_reason?: string | null;
  queue_position?: number;
  not_before?: string | null;
  plan: unknown;
  error_code?: string | null;
}

function enqueue(fixture: PlatformFixture, token: string, sourceId: string): void {
  const result = command(fixture, ['acquisition', 'enqueue', '--source', sourceId], { token });
  assert.equal(result.status, 0, result.stderr);
}

function workAt(fixture: PlatformFixture, token: string, sourceId: string, at: string): WorkResult {
  const result = command(fixture, ['acquisition', 'work', '--source', sourceId, '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkResult;
}

/** Works one Source in a second process, so two workers overlap on one Connection. */
async function workInAnotherWorker(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
): Promise<WorkResult> {
  const result = await runOperatorAsync(
    ['acquisition', 'work', '--source', sourceId, '--root', fixture.root, '--master-key', fixture.masterKey, '--session-token', token],
    { env: fixture.docker },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as WorkResult;
}

function pacing(fixture: PlatformFixture, token: string, connectionId: string): Record<string, unknown> {
  const result = command(fixture, ['connection', 'pacing', '--connection', connectionId], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

test('one durable Connection queue paces every Source through its FIFO order, interval, rate, and concurrency slot', async () => {
  // ---------------------------------------------------------------------------
  // Two Sources share one Connection. The queue is the Deployment's single order
  // for that Connection, so the second Source waits behind the first even though
  // its own Run is the only work its Source holds; the minimum interval then
  // holds it again once the first Run has closed its turn.
  // ---------------------------------------------------------------------------
  const sharedServer = await startHttpSource({ replies: [{ body: pageBody([DEVICES[0]!]) }] });
  const first = await readySource(sharedServer, {
    name: '设备甲',
    pacing: { minimum_interval_seconds: 60, maximum_requests_per_minute: null, maximum_concurrent_runs: 2 },
  });
  const second = await readySource(sharedServer, {
    name: '设备乙',
    workspace: first.workspace,
    connection: { connectionId: first.connectionId, connectionVersion: first.connectionVersion },
  });
  const token = first.workspaceAdministratorToken;

  enqueue(first.fixture, token, first.sourceId);
  enqueue(first.fixture, token, second.sourceId);

  const behind = workAt(first.fixture, token, second.sourceId, '2027-01-01T00:00:00.000Z');
  assert.equal(behind.status, 'queued');
  assert.equal(behind.paced, true);
  assert.equal(behind.pacing_reason, 'fifo', 'a Source waits behind the Connection queue, not behind its own Runs');
  assert.equal(behind.queue_position, 1);
  assert.equal(behind.plan, null, 'a paced Run plans nothing until it is admitted');

  const queued = pacing(first.fixture, token, first.connectionId);
  assert.deepEqual(
    (queued['queue'] as Array<Record<string, unknown>>).map((entry) => entry['source_id']),
    [first.sourceId, second.sourceId],
    'the queue is durable and keeps request order across Sources',
  );

  const head = workAt(first.fixture, token, first.sourceId, '2027-01-01T00:00:00.000Z');
  assert.equal(head.status, 'complete');
  const afterHead = pacing(first.fixture, token, first.connectionId);
  assert.deepEqual(
    (afterHead['queue'] as Array<Record<string, unknown>>).map((entry) => entry['source_id']),
    [second.sourceId],
    'finishing the head Run leaves the rest of the queue in place, so a restart continues it',
  );
  assert.notEqual(afterHead['last_finished_at'], null, 'the instant a turn closed is durable pacing state');

  const held = workAt(first.fixture, token, second.sourceId, new Date().toISOString());
  assert.equal(held.status, 'queued');
  assert.equal(held.pacing_reason, 'interval');
  assert.ok(typeof held.not_before === 'string', 'the refusal states when the connection is free again');

  const resumed = workAt(first.fixture, token, second.sourceId, new Date(Date.now() + 61_000).toISOString());
  assert.equal(resumed.status, 'complete');
  assert.equal(sharedServer.requests().length, 2, 'each admitted Run read exactly once');
  await sharedServer.close();

  // ---------------------------------------------------------------------------
  // The rate is the Connection's, counted over every request of every Source.
  // ---------------------------------------------------------------------------
  const rateServer = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 3)) },
    ],
  });
  const rated = await readySource(rateServer, {
    pacing: { minimum_interval_seconds: 0, maximum_requests_per_minute: 2, maximum_concurrent_runs: 1 },
  });
  enqueue(rated.fixture, rated.workspaceAdministratorToken, rated.sourceId);
  const spent = workAt(rated.fixture, rated.workspaceAdministratorToken, rated.sourceId, new Date().toISOString());
  assert.equal(spent.status, 'complete');
  assert.equal(rateServer.requests().length, 2, 'the Run used the whole minute allowance');

  enqueue(rated.fixture, rated.workspaceAdministratorToken, rated.sourceId);
  const throttled = workAt(rated.fixture, rated.workspaceAdministratorToken, rated.sourceId, new Date().toISOString());
  assert.equal(throttled.status, 'queued');
  assert.equal(throttled.pacing_reason, 'rate');
  assert.ok(typeof throttled.not_before === 'string');
  assert.equal(rateServer.requests().length, 2, 'a rate refusal reads nothing');
  await rateServer.close();

  // ---------------------------------------------------------------------------
  // One concurrency slot: a second worker is refused while the first holds it,
  // and the Work it gets back is a durable queue position rather than a failure.
  // ---------------------------------------------------------------------------
  const slowServer = await startHttpSource({
    replies: [{ body: pageBody([DEVICES[3]!]), delay_ms: 6_000 }],
  });
  const holder = await readySource(slowServer, {
    name: '设备甲',
    pacing: { serialization: false, minimum_interval_seconds: 0, maximum_requests_per_minute: null, maximum_concurrent_runs: 1 },
  });
  const rival = await readySource(slowServer, {
    name: '设备乙',
    workspace: holder.workspace,
    connection: { connectionId: holder.connectionId, connectionVersion: holder.connectionVersion },
  });
  const holderToken = holder.workspaceAdministratorToken;
  enqueue(holder.fixture, holderToken, holder.sourceId);
  enqueue(holder.fixture, holderToken, rival.sourceId);

  const holding = workInAnotherWorker(holder.fixture, holderToken, holder.sourceId);
  await wait(1_500);
  const refused = workAt(holder.fixture, holderToken, rival.sourceId, new Date().toISOString());
  assert.equal(refused.status, 'queued');
  assert.equal(refused.pacing_reason, 'concurrency', 'the Connection admits one Run at a time');
  assert.equal(refused.error_code, null, 'a paced Run is not a failed Run');

  const heldRun = await holding;
  assert.equal(heldRun.status, 'complete');
  const afterHold = pacing(holder.fixture, holderToken, holder.connectionId);
  assert.deepEqual(afterHold['active'], [], 'a finished Run releases its concurrency slot');
  const finallyAdmitted = workAt(holder.fixture, holderToken, rival.sourceId, new Date().toISOString());
  assert.equal(finallyAdmitted.status, 'complete');
  await slowServer.close();
});
