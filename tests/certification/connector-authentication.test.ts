import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICES,
  readySource,
  type ReadySource,
} from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command, type PlatformFixture } from '../support/platform.js';

interface RunResult {
  acquisition_run_id: string;
  status: string;
  error_code?: string | null;
  plan: { pages: Array<{ page: number; outcome: string }> };
  raw_acquisition_count: number;
  raw_acquisition_ids: string[];
  batch_raw_acquisition_count: number | null;
  integration_batch_id: string | null;
  dataset_release: number | null;
  records: number | null;
}

function enqueue(ready: ReadySource, extra: string[] = []): Record<string, unknown> {
  const result = command(
    ready.fixture,
    ['acquisition', 'enqueue', '--source', ready.sourceId, ...extra],
    { token: ready.workspaceAdministratorToken },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function work(ready: ReadySource, extra: string[] = []): RunResult {
  const result = command(
    ready.fixture,
    ['acquisition', 'work', '--source', ready.sourceId, ...extra],
    { token: ready.workspaceAdministratorToken },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as RunResult;
}

function session(fixture: PlatformFixture, ready: ReadySource): Record<string, unknown> {
  const result = command(
    fixture,
    ['connection', 'session', '--connection', ready.connectionId],
    { token: ready.workspaceAdministratorToken },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

test('every declarative authentication mode works, with one serialized refresh replay and intervention after further authentication failure', async () => {
  // No authentication: nothing is attached to the request at all.
  const open = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const openReady = await readySource(open, { auth: { scheme: 'none' }, credential: null });
  enqueue(openReady);
  assert.equal(work(openReady).status, 'complete');
  assert.equal(open.requests()[0]?.authorization, null, 'no authentication scheme sends no credential');
  await open.close();

  // Basic authentication: the stored credential is the password.
  const basic = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const basicReady = await readySource(basic, {
    auth: { scheme: 'basic', username: 'device-client' },
    credential: 'basic-password',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 5 },
  });
  enqueue(basicReady);
  assert.equal(work(basicReady).status, 'complete');
  assert.equal(
    basic.requests()[0]?.authorization,
    `Basic ${Buffer.from('device-client:basic-password').toString('base64')}`,
    'basic authentication sends the published username and the stored password',
  );
  await basic.close();

  // A static API key: the credential is sent in the declared header.
  const apiKey = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const apiKeyReady = await readySource(apiKey, {
    auth: { scheme: 'api_key', header: 'x-api-key' },
    credential: 'key-1',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 5 },
  });
  enqueue(apiKeyReady);
  assert.equal(work(apiKeyReady).status, 'complete');
  assert.equal(apiKey.requests()[0]?.api_key, 'key-1', 'a static API key rides the declared header');
  await apiKey.close();

  // OAuth client credentials: a session token is obtained before the first page.
  const oauth = await startHttpSource({
    replies: [{ body: pageBody(DEVICES.slice(0, 1)) }],
    auth: { token_path: '/oauth/token', issued: ['access-1'] },
  });
  const oauthReady = await readySource(oauth, {
    auth: {
      scheme: 'oauth_client_credentials',
      token_url: `${oauth.url}/oauth/token`,
      client_id: 'device-client',
      scope: 'devices.read',
    },
    credential: 'client-secret',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 5 },
  });
  enqueue(oauthReady);
  assert.equal(work(oauthReady).status, 'complete');
  const tokenRequest = oauth.requests().find((request) => request.path === '/oauth/token');
  assert.equal(tokenRequest?.method, 'POST', 'the token endpoint is called with a POST');
  assert.match(tokenRequest?.body ?? '', /grant_type=client_credentials/u);
  assert.match(tokenRequest?.body ?? '', /client_id=device-client/u);
  assert.equal(oauth.requests().at(-1)?.authorization, 'Bearer access-1', 'the issued token authenticates the page');
  await oauth.close();

  // Username and password login, yielding a cookie session.
  const login = await startHttpSource({
    replies: [{ body: pageBody(DEVICES.slice(0, 1)) }],
    auth: { login_path: '/auth/login', issued: ['session-1'], cookie_name: 'session' },
  });
  const loginReady = await readySource(login, {
    auth: { scheme: 'login', login_path: '/auth/login', username: 'device-client', cookie_name: 'session' },
    credential: 'login-password',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 5 },
  });
  enqueue(loginReady);
  assert.equal(work(loginReady).status, 'complete');
  const loginRequest = login.requests().find((request) => request.path === '/auth/login');
  assert.match(loginRequest?.body ?? '', /"username":"device-client"/u);
  assert.equal(login.requests().at(-1)?.cookie, 'session=session-1', 'a login session is carried as the issued cookie');
  await login.close();

  // One serialized refresh replay: a token that expires mid-plan is refreshed
  // once, the rejected request is replayed, and later pages reuse the new token.
  const expiring = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 4)) },
      { body: pageBody(DEVICES.slice(4, 5)) },
    ],
    auth: { token_path: '/oauth/token', issued: ['token-a', 'token-b'], expire_after_uses: 2 },
  });
  const expiringReady = await readySource(expiring, {
    auth: {
      scheme: 'oauth_client_credentials',
      token_url: `${expiring.url}/oauth/token`,
      client_id: 'device-client',
      scope: null,
    },
    credential: 'client-secret',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 5 },
  });
  enqueue(expiringReady);
  const refreshed = work(expiringReady);
  assert.equal(refreshed.status, 'complete');
  assert.equal(refreshed.records, 5);
  const tokenCalls = expiring.requests().filter((request) => request.path === '/oauth/token');
  assert.equal(tokenCalls.length, 2, 'the expired token is refreshed exactly once');
  const pages = expiring.requests().filter((request) => request.path === '/api/devices');
  assert.deepEqual(
    pages.map((request) => request.query['page']),
    ['1', '2', '3', '3'],
    'only the rejected page is replayed',
  );
  assert.deepEqual(
    pages.map((request) => request.authorization),
    ['Bearer token-a', 'Bearer token-a', 'Bearer token-a', 'Bearer token-b'],
    'the replay carries the refreshed token and later pages reuse it',
  );
  assert.equal(refreshed.raw_acquisition_count, 4, 'the rejected response is kept as diagnostic raw bytes');
  assert.equal(refreshed.batch_raw_acquisition_count, 3, 'the batch holds only the accepted fragments of this attempt');
  assert.deepEqual(refreshed.plan.pages.map((page) => page.outcome), ['received', 'received', 'received']);

  // A second Run reuses the durable session: it never refreshes again.
  enqueue(expiringReady);
  const reused = work(expiringReady);
  assert.equal(reused.status, 'complete');
  assert.equal(
    expiring.requests().filter((request) => request.path === '/oauth/token').length,
    2,
    'a durable session is reused across Runs rather than refreshed again',
  );
  assert.equal(expiring.requests().at(-1)?.authorization, 'Bearer token-b', 'the later Run uses the persisted session');

  // A second authentication rejection after the replay stops the Run, requires
  // intervention, and never loops.
  const rejected = await startHttpSource({
    replies: [{ body: pageBody(DEVICES.slice(0, 1)) }],
    auth: { token_path: '/oauth/token', issued: ['bad-a', 'bad-b'], rejected_tokens: ['bad-a', 'bad-b'] },
  });
  const rejectedReady = await readySource(rejected, {
    auth: {
      scheme: 'oauth_client_credentials',
      token_url: `${rejected.url}/oauth/token`,
      client_id: 'device-client',
      scope: null,
    },
    credential: 'client-secret',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 5 },
  });
  enqueue(rejectedReady);
  const stopped = work(rejectedReady);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.error_code, 'ACQUISITION_AUTHENTICATION_INTERVENTION_REQUIRED');
  assert.equal(stopped.integration_batch_id, null);
  assert.equal(rejected.requests().filter((request) => request.path === '/oauth/token').length, 2);
  assert.equal(
    rejected.requests().filter((request) => request.path === '/api/devices').length,
    2,
    'the rejected request is replayed exactly once and then the Run stops',
  );
  const intervention = session(rejectedReady.fixture, rejectedReady);
  assert.equal(intervention['state'], 'intervention_required', 'the session states that intervention is required');

  enqueue(rejectedReady);
  const stillStopped = work(rejectedReady);
  assert.equal(stillStopped.error_code, 'ACQUISITION_AUTHENTICATION_INTERVENTION_REQUIRED');
  assert.equal(
    rejected.requests().filter((request) => request.path === '/api/devices').length,
    2,
    'no further request is attempted while intervention is required',
  );

  const reset = command(
    rejectedReady.fixture,
    ['connection', 'session-reset', '--connection', rejectedReady.connectionId],
    { token: rejectedReady.workspaceAdministratorToken },
  );
  assert.equal(reset.status, 0, reset.stderr);
  enqueue(rejectedReady);
  const recovered = work(rejectedReady);
  assert.equal(recovered.status, 'complete', 'an explicit session reset is the intervention that lets the Run proceed');
  assert.ok(rejected.requests().filter((request) => request.path === '/oauth/token').length >= 3);

  await expiring.close();
  await rejected.close();
});
