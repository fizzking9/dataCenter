import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  authorizationParams,
  CLIENT_METADATA,
  createAgent,
  decideAuthorization,
  delegateAgent,
  grantAgent,
  issueAgentToken,
  issueDelegatedToken,
  pkcePair,
  redirectParams,
  registerAgentClient,
  requestAuthorizationConsent,
  userCookie,
} from '../support/agents.js';
import { callApi, startConsole, type ConsoleHandle } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { callTool, mcpResult, requestToken, toolPayload } from '../support/mcp.js';
import { command, jsonFile, type PlatformFixture } from '../support/platform.js';

const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const REDIRECT_URI = CLIENT_METADATA.redirect_uris[0]!;
const OTHER_CLIENT = {
  client_id: 'https://agent.example.invalid/oauth/other-client.json',
  client_name: 'Other Certification Agent',
  redirect_uris: ['https://agent.example.invalid/other-callback'],
};

interface DelegatedSurface {
  fixture: PlatformFixture;
  workspaceId: string;
  dataProductId: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  agentId: string;
  client: { client_id: string; client_secret: string };
  otherClient: { client_id: string; client_secret: string };
  delegationId: string;
  console: ConsoleHandle;
  cookie: string;
}

async function delegatedSurface(): Promise<DelegatedSurface> {
  const product = publishLedgerProduct();
  const { fixture, workspaceId, workspaceAdministratorToken, consumerToken, dataProductId } = product;
  const agentId = createAgent(fixture, product.deploymentAdministratorToken, workspaceId);
  const client = registerAgentClient(fixture, product.deploymentAdministratorToken, agentId);
  const otherClient = registerAgentClient(fixture, product.deploymentAdministratorToken, agentId, OTHER_CLIENT, 'other-client');
  const delegation = delegateAgent(fixture, consumerToken, agentId, workspaceId);

  // The Agent may read two fields in one row; the User may read one field in all
  // rows. Only their intersection may ever reach a delegated token.
  const agentGrant = grantAgent(fixture, workspaceAdministratorToken, dataProductId, agentId, {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'city', op: 'equals', value: '上海' }],
  });
  assert.equal(agentGrant.status, 0, agentGrant.stderr);
  const userGrant = command(fixture, [
    'grant', 'publish', '--product', dataProductId, '--username', ANALYST,
    '--request', jsonFile(fixture, 'analyst-delegated-oauth-grant', { columns: ['sn'] }),
  ], { token: workspaceAdministratorToken });
  assert.equal(userGrant.status, 0, userGrant.stderr);

  const console = await startConsole(fixture);
  try {
    // The User signs in through the same HTTP session endpoint the browser uses.
    const signedIn = await callApi(console.url, '/api/session', {
      body: { username: ANALYST, password: ANALYST_PASSWORD },
    });
    assert.equal(signedIn.status, 200, signedIn.text);
    const cookie = signedIn.cookies[0]?.split(';')[0];
    assert.ok(cookie, 'the User session cookie is issued');
    return { fixture, workspaceId, dataProductId, workspaceAdministratorToken, consumerToken, agentId, client, otherClient, delegationId: delegation.delegation_id, console, cookie };
  } catch (error) {
    await console.stop();
    throw error;
  }
}

interface IssuedCode {
  code: string;
  verifier: string;
  params: URLSearchParams;
}

/** States and approves one consent over HTTP, returning the single-use code. */
async function issueCode(
  surface: DelegatedSurface,
  options: { client?: { client_id: string }; scope?: string; state?: string; challenge?: string } = {},
): Promise<IssuedCode> {
  const pair = pkcePair();
  const params = authorizationParams(options.client ?? surface.client, {
    workspaceId: surface.workspaceId,
    challenge: options.challenge ?? pair.challenge,
    scope: options.scope ?? 'mcp:read',
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  const consent = await requestAuthorizationConsent(surface.console.url, params, surface.cookie);
  assert.equal(consent.status, 200, consent.body);
  const approved = await decideAuthorization(surface.console.url, params, surface.cookie, 'approve');
  assert.equal(approved.status, 303, approved.body);
  const code = redirectParams(approved.location).get('code');
  assert.ok(code, String(approved.location));
  return { code, verifier: pair.verifier, params };
}

function exchangeCode(
  surface: DelegatedSurface,
  client: { client_id: string; client_secret: string },
  code: string,
  verifier: string,
  redirectUri = REDIRECT_URI,
): ReturnType<typeof requestToken> {
  return requestToken(surface.console.url, {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    resource: `${surface.console.url}/mcp`,
  });
}

/** Backdates the newest authorization code, as elapsed time would. */
function expireNewestCode(fixture: PlatformFixture): void {
  const path = join(fixture.root, 'state', 'platform.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as { oauth_authorization_codes?: Array<Record<string, unknown>> };
  const codes = state.oauth_authorization_codes ?? [];
  const newest = codes[codes.length - 1];
  assert.ok(newest, 'an authorization code exists');
  newest['expires_at'] = new Date(Date.now() - 1_000).toISOString();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

test('delegated access uses authorization code with PKCE and stays the Agent/User intersection', async (t) => {
  const s = await delegatedSurface();
  t.after(async () => s.console.stop());
  const url = s.console.url;

  await t.test('metadata advertises the authorization endpoint and S256 only', async () => {
    const response = await fetch(`${url}/.well-known/oauth-authorization-server`);
    const document = await response.json() as Record<string, unknown>;
    assert.equal(document['authorization_endpoint'], `${url}/oauth/authorize`);
    assert.equal(document['token_endpoint'], `${url}/oauth/token`);
    assert.deepEqual(document['grant_types_supported'], ['client_credentials', 'authorization_code']);
    assert.deepEqual(document['response_types_supported'], ['code']);
    assert.deepEqual(document['code_challenge_methods_supported'], ['S256']);
  });

  await t.test('an authenticated User consents explicitly and the code exchanges with its PKCE verifier', async () => {
    const pair = pkcePair();
    const params = authorizationParams(s.client, {
      workspaceId: s.workspaceId,
      challenge: pair.challenge,
      scope: 'mcp:read',
      state: 'certification-state',
    });

    // Without a platform User session there is no consent surface at all.
    const anonymous = await fetch(`${url}/oauth/authorize?${params.toString()}`, { redirect: 'manual' });
    assert.equal(anonymous.status, 401);
    assert.match(await anonymous.text(), /需要登录/u);

    const consent = await requestAuthorizationConsent(url, params, s.cookie);
    assert.equal(consent.status, 200, consent.body);
    assert.match(consent.body, /授权委托访问/u);
    assert.match(consent.body, /certification-agent/u);
    assert.match(consent.body, /mcp:read/u);
    assert.match(consent.body, /analyst@example\.invalid/u);
    assert.match(consent.body, /form method="post" action="\/oauth\/authorize"/u);

    const approved = await decideAuthorization(url, params, s.cookie, 'approve');
    assert.equal(approved.status, 303, approved.body);
    const redirect = redirectParams(approved.location);
    assert.equal(redirect.get('state'), 'certification-state');
    assert.ok(redirect.get('code'), 'the approval redirects with a code');

    const issued = await exchangeCode(s, s.client, String(redirect.get('code')), pair.verifier);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body['scope'], 'mcp:read');
    assert.equal(issued.body['resource'], `${url}/mcp`);
    const token = String(issued.body['access_token']);

    // The delegated token reads exactly the intersection of both Grants.
    const query = { workspace_id: s.workspaceId, data_product_id: s.dataProductId, query: { kind: 'records' } };
    const delegated = await callTool(url, token, 'query_data_product', query);
    assert.equal(mcpResult(delegated)['isError'], undefined, delegated.text);
    assert.deepEqual(toolPayload(delegated)['columns'], ['sn']);
    assert.deepEqual(toolPayload(delegated)['records'], [{ sn: 'sn-002' }]);

    // The Agent's own autonomous token still sees its own broader Grant.
    const autonomous = await issueAgentToken(url, s.client);
    const autonomousRead = await callTool(url, autonomous, 'query_data_product', query);
    assert.equal(mcpResult(autonomousRead)['isError'], undefined, autonomousRead.text);
    assert.deepEqual(toolPayload(autonomousRead)['columns'], ['sn', 'city']);
    assert.deepEqual(toolPayload(autonomousRead)['records'], [{ sn: 'sn-002', city: '上海' }]);

    // Both identities are attributed in Workspace Audit Events, without tokens.
    const audit = await callApi(url, `/api/workspace/audit?workspace_id=${s.workspaceId}`, {
      cookie: userCookie(s.workspaceAdministratorToken),
    });
    assert.equal(audit.status, 200, audit.text);
    const events = audit.body['events'] as Array<Record<string, unknown>>;
    const consentEvent = events.find((event) => event['action'] === 'oauth_authorization_consent');
    assert.equal(consentEvent?.['actor'], ANALYST);
    assert.equal(consentEvent?.['target'], s.client.client_id);
    const callEvent = events.find(
      (event) => event['action'] === 'mcp_tool_call' && event['delegated_user'] === ANALYST,
    );
    assert.equal(callEvent?.['actor'], 'agent:certification-agent');
    assert.equal(audit.text.includes(token), false);
    assert.equal(audit.text.includes(s.client.client_secret), false);
  });

  await t.test('missing, wrong, and replayed verifiers never mint a second token', async () => {
    const issued = await issueCode(s);

    const missing = await requestToken(url, {
      grant_type: 'authorization_code',
      client_id: s.client.client_id,
      client_secret: s.client.client_secret,
      code: issued.code,
      redirect_uri: REDIRECT_URI,
      resource: `${url}/mcp`,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body['error'], 'invalid_grant');

    const wrong = await exchangeCode(s, s.client, issued.code, pkcePair().verifier);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body['error'], 'invalid_grant');

    // A refused verifier did not consume the code; the right one still works.
    const accepted = await exchangeCode(s, s.client, issued.code, issued.verifier);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

    const replayed = await exchangeCode(s, s.client, issued.code, issued.verifier);
    assert.equal(replayed.status, 400);
    assert.equal(replayed.body['error'], 'invalid_grant');
  });

  await t.test('an expired code is refused at exchange', async () => {
    const issued = await issueCode(s);
    expireNewestCode(s.fixture);
    const expired = await exchangeCode(s, s.client, issued.code, issued.verifier);
    assert.equal(expired.status, 400);
    assert.equal(expired.body['error'], 'invalid_grant');
  });

  await t.test('a code is bound to its client, redirect URI, and the client secret', async () => {
    const issued = await issueCode(s);

    const wrongClient = await exchangeCode(s, s.otherClient, issued.code, issued.verifier, OTHER_CLIENT.redirect_uris[0]!);
    assert.equal(wrongClient.status, 400);
    assert.equal(wrongClient.body['error'], 'invalid_grant');

    const wrongRedirect = await exchangeCode(s, s.client, issued.code, issued.verifier, `${REDIRECT_URI}/elsewhere`);
    assert.equal(wrongRedirect.status, 400);
    assert.equal(wrongRedirect.body['error'], 'invalid_grant');

    const missingSecret = await requestToken(url, {
      grant_type: 'authorization_code',
      client_id: s.client.client_id,
      code: issued.code,
      code_verifier: issued.verifier,
      redirect_uri: REDIRECT_URI,
      resource: `${url}/mcp`,
    });
    assert.equal(missingSecret.status, 401);
    assert.equal(missingSecret.body['error'], 'invalid_client');

    // None of the refusals consumed the code.
    const accepted = await exchangeCode(s, s.client, issued.code, issued.verifier);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  });

  await t.test('an unregistered client or redirect URI is refused without redirecting', async () => {
    const pair = pkcePair();
    const unknownClient = authorizationParams({ client_id: 'https://agent.example.invalid/oauth/unknown.json' }, {
      workspaceId: s.workspaceId,
      challenge: pair.challenge,
    });
    const unknown = await requestAuthorizationConsent(url, unknownClient, s.cookie);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.location, null);
    assert.match(unknown.body, /invalid_request/u);

    const wrongRedirect = authorizationParams(s.client, {
      workspaceId: s.workspaceId,
      challenge: pair.challenge,
      redirectUri: 'https://agent.example.invalid/callback/extra',
    });
    const refused = await requestAuthorizationConsent(url, wrongRedirect, s.cookie);
    assert.equal(refused.status, 400);
    assert.equal(refused.location, null);
    assert.match(refused.body, /invalid_request/u);
  });

  await t.test('a missing PKCE challenge, wrong method, or escalated scope is refused', async () => {
    const pair = pkcePair();
    const missing = authorizationParams(s.client, {
      workspaceId: s.workspaceId,
      challenge: '',
      state: 'pkce-missing',
    });
    const refused = await requestAuthorizationConsent(url, missing, s.cookie);
    assert.equal(refused.status, 303);
    assert.equal(redirectParams(refused.location).get('error'), 'invalid_request');
    assert.equal(redirectParams(refused.location).get('state'), 'pkce-missing');

    const wrongMethod = authorizationParams(s.client, {
      workspaceId: s.workspaceId,
      challenge: pair.challenge,
      codeChallengeMethod: 'plain',
    });
    const plain = await requestAuthorizationConsent(url, wrongMethod, s.cookie);
    assert.equal(plain.status, 303);
    assert.equal(redirectParams(plain.location).get('error'), 'invalid_request');

    const escalated = authorizationParams(s.client, {
      workspaceId: s.workspaceId,
      challenge: pair.challenge,
      scope: 'mcp:read mcp:nlq',
    });
    const beyond = await requestAuthorizationConsent(url, escalated, s.cookie);
    assert.equal(beyond.status, 303);
    assert.equal(redirectParams(beyond.location).get('error'), 'invalid_scope');

    const wrongResponseType = authorizationParams(s.client, {
      workspaceId: s.workspaceId,
      challenge: pair.challenge,
      responseType: 'token',
    });
    const noToken = await requestAuthorizationConsent(url, wrongResponseType, s.cookie);
    assert.equal(noToken.status, 303);
    assert.equal(redirectParams(noToken.location).get('error'), 'unsupported_response_type');
  });

  await t.test('a refused consent redirects access_denied and issues no code', async () => {
    const before = authorizationCodeCount(s.fixture);
    const pair = pkcePair();
    const params = authorizationParams(s.client, { workspaceId: s.workspaceId, challenge: pair.challenge });
    const consent = await requestAuthorizationConsent(url, params, s.cookie);
    assert.equal(consent.status, 200, consent.body);
    const denied = await decideAuthorization(url, params, s.cookie, 'deny');
    assert.equal(denied.status, 303, denied.body);
    const redirect = redirectParams(denied.location);
    assert.equal(redirect.get('error'), 'access_denied');
    assert.equal(redirect.get('code'), null);
    assert.equal(authorizationCodeCount(s.fixture), before, 'no code is stored for a refused consent');
  });

  await t.test('revoking the delegation stops new codes, unexchanged codes, and live tokens', async () => {
    const liveToken = await issueDelegatedToken(url, s.client, {
      cookie: s.cookie,
      workspaceId: s.workspaceId,
      scope: 'mcp:read',
    });
    const issued = await issueCode(s);

    const revoked = command(s.fixture, ['agent', 'delegate-revoke', '--delegation', s.delegationId], {
      token: s.consumerToken,
    });
    assert.equal(revoked.status, 0, revoked.stderr);

    // The code was issued before revocation; the delegated consent is revalidated
    // at exchange, so it no longer works.
    const stale = await exchangeCode(s, s.client, issued.code, issued.verifier);
    assert.equal(stale.status, 400);
    assert.equal(stale.body['error'], 'invalid_grant');

    // A live delegated token stops on the very next call, without touching the
    // Agent Identity's own autonomous authority.
    const stopped = await callTool(url, liveToken, 'query_data_product', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      query: { kind: 'records' },
    });
    assert.equal(stopped.status, 401);
    assert.equal(stopped.body['code'], 'MCP_DELEGATION_REVOKED');

    // A new authorization request cannot silently recreate the consent.
    const pair = pkcePair();
    const params = authorizationParams(s.client, { workspaceId: s.workspaceId, challenge: pair.challenge });
    const refused = await requestAuthorizationConsent(url, params, s.cookie);
    assert.equal(refused.status, 303);
    assert.equal(redirectParams(refused.location).get('error'), 'access_denied');
  });

  await t.test('client_credentials stays autonomous and never names a delegation', async () => {
    const autonomous = await issueAgentToken(url, s.client);
    const query = { workspace_id: s.workspaceId, data_product_id: s.dataProductId, query: { kind: 'records' } };
    const read = await callTool(url, autonomous, 'query_data_product', query);
    assert.equal(mcpResult(read)['isError'], undefined, read.text);
    assert.deepEqual(toolPayload(read)['columns'], ['sn', 'city']);

    const named = await requestToken(url, {
      grant_type: 'client_credentials',
      client_id: s.client.client_id,
      client_secret: s.client.client_secret,
      resource: `${url}/mcp`,
      scope: 'mcp:read',
      delegation_id: s.delegationId,
    });
    assert.equal(named.status, 400);
    assert.equal(named.body['error'], 'invalid_request');
  });
});

function authorizationCodeCount(fixture: PlatformFixture): number {
  const state = JSON.parse(readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8')) as {
    oauth_authorization_codes?: unknown[];
  };
  return (state.oauth_authorization_codes ?? []).length;
}
