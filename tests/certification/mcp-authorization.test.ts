import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIENT_METADATA, createAgent, registerAgentClient } from '../support/agents.js';
import { startConsole } from '../support/console.js';
import { mcpCall, requestToken } from '../support/mcp.js';
import { command, jsonFile, workspaceFixture } from '../support/platform.js';

test("MCP authorization validates the Deployment's own issuer, resource, audience, client, redirect, and Origin", async () => {
  const workspace = workspaceFixture();
  const { fixture, workspaceId, deploymentAdministratorToken } = workspace;

  const agentId = createAgent(fixture, deploymentAdministratorToken, workspaceId);
  const client = registerAgentClient(fixture, deploymentAdministratorToken, agentId);

  const console = await startConsole(fixture);
  let restarted: Awaited<ReturnType<typeof startConsole>> | undefined;
  try {
    const metadata = await fetch(`${console.url}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.status, 200);
    const document = await metadata.json() as Record<string, unknown>;
    assert.equal(document['resource'], `${console.url}/mcp`);
    assert.deepEqual(document['authorization_servers'], [console.url]);
    assert.deepEqual(document['bearer_methods_supported'], ['header']);

    const authorizationServer = await fetch(`${console.url}/.well-known/oauth-authorization-server`);
    const serverDocument = await authorizationServer.json() as Record<string, unknown>;
    assert.equal(serverDocument['issuer'], console.url);
    assert.equal(serverDocument['token_endpoint'], `${console.url}/oauth/token`);

    const resource = `${console.url}/mcp`;
    const token = await requestToken(console.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      resource,
      scope: 'mcp:read',
      redirect_uri: CLIENT_METADATA.redirect_uris[0]!,
    });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.equal(token.body['token_type'], 'Bearer');
    assert.equal(token.body['resource'], resource);
    assert.equal(token.body['scope'], 'mcp:read');
    assert.equal(typeof token.body['access_token'], 'string');
    const accessToken = String(token.body['access_token']);

    // The audience is the Deployment's own MCP resource, never a client-supplied one.
    const audience = await mcpCall(
      console.url,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: accessToken },
    );
    assert.equal(audience.status, 200, audience.text);

    const anonymous = await mcpCall(console.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body['code'], 'MCP_AUTHENTICATION_REQUIRED');
    assert.match(String(anonymous.headers.get('www-authenticate')), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);

    const foreignOrigin = await mcpCall(
      console.url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: accessToken, origin: 'https://agent.example.invalid' },
    );
    assert.equal(foreignOrigin.status, 403);
    assert.equal(foreignOrigin.body['code'], 'MCP_ORIGIN_NOT_ALLOWED');

    const ownOrigin = await mcpCall(
      console.url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { token: accessToken, origin: console.url },
    );
    assert.equal(ownOrigin.status, 200, ownOrigin.text);

    const forged = await mcpCall(
      console.url,
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      { token: 'not-a-deployment-issued-token' },
    );
    assert.equal(forged.status, 401);
    assert.equal(forged.body['code'], 'MCP_TOKEN_INVALID');

    const wrongResource = await requestToken(console.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      resource: `${console.url}/api`,
      scope: 'mcp:read',
    });
    assert.equal(wrongResource.status, 400);
    assert.equal(wrongResource.body['error'], 'invalid_target');

    const missingResource = await requestToken(console.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope: 'mcp:read',
    });
    assert.equal(missingResource.status, 400);
    assert.equal(missingResource.body['error'], 'invalid_target');

    const wrongSecret = await requestToken(console.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: 'not-the-issued-secret',
      resource,
      scope: 'mcp:read',
    });
    assert.equal(wrongSecret.status, 401);
    assert.equal(wrongSecret.body['error'], 'invalid_client');

    const escalated = await requestToken(console.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      resource,
      scope: 'mcp:read mcp:nlq',
    });
    assert.equal(escalated.status, 400);
    assert.equal(escalated.body['error'], 'invalid_scope');

    const unregisteredRedirect = await requestToken(console.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      resource,
      scope: 'mcp:read',
      redirect_uri: 'https://agent.example.invalid/callback/',
    });
    assert.equal(unregisteredRedirect.status, 400);
    assert.equal(unregisteredRedirect.body['error'], 'OAUTH_REDIRECT_URI_INVALID');

    // A client may not claim an authorization-server-controlled metadata field.
    const protectedMetadata = command(
      fixture,
      ['agent', 'client-register', '--agent', agentId, '--metadata', jsonFile(fixture, 'protected-metadata', {
        ...CLIENT_METADATA,
        client_id: 'https://agent.example.invalid/oauth/protected.json',
        scope: 'mcp:read mcp:nlq',
      })],
      { token: deploymentAdministratorToken },
    );
    assert.equal(protectedMetadata.status, 2);
    assert.equal(protectedMetadata.error.code, 'OAUTH_CLIENT_METADATA_PROTECTED');

    // A foreign Deployment's token is a passthrough attempt, not a credential.
    const other = workspaceFixture();
    const otherAgent = createAgent(other.fixture, other.deploymentAdministratorToken, other.workspaceId, 'mcp:read', 'foreign-agent');
    const otherClient = registerAgentClient(other.fixture, other.deploymentAdministratorToken, otherAgent, CLIENT_METADATA, 'foreign-client');
    const otherConsole = await startConsole(other.fixture);
    try {
      const foreignToken = await requestToken(otherConsole.url, {
        grant_type: 'client_credentials',
        client_id: otherClient.client_id,
        client_secret: otherClient.client_secret,
        resource: `${otherConsole.url}/mcp`,
        scope: 'mcp:read',
      });
      assert.equal(foreignToken.status, 200, JSON.stringify(foreignToken.body));
      const passthrough = await mcpCall(
        console.url,
        { jsonrpc: '2.0', id: 5, method: 'tools/list' },
        { token: String(foreignToken.body['access_token']) },
      );
      assert.equal(passthrough.status, 401);
      assert.equal(passthrough.body['code'], 'MCP_TOKEN_INVALID');
    } finally {
      await otherConsole.stop();
    }

    // The token is bound to the issuer that minted it: a restart on another origin
    // cannot silently keep honouring it.
    await console.stop();
    restarted = await startConsole(fixture);
    const rebound = await mcpCall(
      restarted.url,
      { jsonrpc: '2.0', id: 6, method: 'tools/list' },
      { token: accessToken },
    );
    assert.equal(rebound.status, 401);
    assert.equal(rebound.body['code'], 'MCP_TOKEN_ISSUER_MISMATCH');

    const revokedClient = command(fixture, ['agent', 'client-revoke', '--client', client.client_id], { token: deploymentAdministratorToken });
    assert.equal(revokedClient.status, 0, revokedClient.stderr);
    const afterRevocation = await requestToken(restarted.url, {
      grant_type: 'client_credentials',
      client_id: client.client_id,
      client_secret: client.client_secret,
      resource: `${restarted.url}/mcp`,
      scope: 'mcp:read',
    });
    assert.equal(afterRevocation.status, 401);
    assert.equal(afterRevocation.body['error'], 'invalid_client');
  } finally {
    await restarted?.stop();
    await console.stop();
  }
});
