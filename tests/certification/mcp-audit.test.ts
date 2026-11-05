import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, grantAgent, issueAgentToken, registerAgentClient } from '../support/agents.js';
import { startConsole } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { callTool, mcpResult } from '../support/mcp.js';
import { command, createUser, createWorkspace } from '../support/platform.js';

test('every MCP tool invocation leaves a durable Audit Event naming the Agent, client, target, outcome, and correlation', async () => {
  const product = publishLedgerProduct();
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken } = product;
  const agentId = createAgent(fixture, deploymentAdministratorToken, workspaceId);
  const client = registerAgentClient(fixture, deploymentAdministratorToken, agentId);
  const granted = grantAgent(fixture, workspaceAdministratorToken, product.dataProductId, agentId, {
    columns: ['sn', 'city'],
  });
  assert.equal(granted.status, 0, granted.stderr);

  const console = await startConsole(fixture);
  try {
    const token = await issueAgentToken(console.url, client);
    const answered = await callTool(console.url, token, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
      query: { kind: 'records' },
    });
    assert.equal(mcpResult(answered)['isError'], undefined, answered.text);
    const correlation = (mcpResult(answered)['_meta'] as Record<string, unknown>)['correlation_id'];
    assert.equal(typeof correlation, 'string');

    // A Workspace the Agent Identity is not bound to is refused, and the refusal
    // is recorded rather than dropped.
    createUser(fixture, deploymentAdministratorToken, 'elsewhere@example.invalid', 'elsewhere-administrator');
    const otherWorkspace = createWorkspace(fixture, deploymentAdministratorToken, 'Elsewhere', 'elsewhere@example.invalid');
    const denied = await callTool(console.url, token, 'discover_data_products', { workspace_id: otherWorkspace });
    assert.equal(mcpResult(denied)['isError'], true, denied.text);

    const listing = command(fixture, ['audit', 'list'], { token: deploymentAdministratorToken });
    assert.equal(listing.status, 0, listing.stderr);
    assert.equal(listing.output['chain_valid'], true, 'the events join the verifiable Audit Event chain');
    const events = listing.output['events'] as Array<Record<string, unknown>>;
    const invocations = events.filter((event) => event['action'] === 'mcp_tool_call');
    assert.equal(invocations.length, 2, 'one Audit Event per MCP tool invocation');

    const succeeded = invocations.find((event) => event['outcome'] === 'succeeded');
    assert.ok(succeeded, 'a successful tool invocation is audited');
    assert.equal(succeeded['actor'], 'agent:certification-agent');
    assert.equal(succeeded['workspace_id'], workspaceId);
    assert.equal(succeeded['target'], product.dataProductId);
    assert.equal(succeeded['correlation_id'], correlation, 'the Audit Event carries the correlation the caller saw');
    const detail = succeeded['detail'] as Record<string, unknown>;
    assert.equal(detail['tool'], 'query_data_product');
    assert.equal(detail['agent_identity_id'], agentId);
    assert.equal(detail['oauth_client_id'], client.client_id);

    // The governed read itself is recorded under its own action and the Agent's label.
    const read = events.find((event) => event['action'] === 'data_product_query' && event['outcome'] === 'succeeded');
    assert.ok(read, 'the Data Product Query the Agent ran is audited');
    assert.equal(read['actor'], 'agent:certification-agent');
    assert.equal(read['workspace_id'], workspaceId);
    assert.equal(read['target'], product.dataProductId);

    const refused = invocations.find((event) => event['outcome'] === 'denied');
    assert.ok(refused, 'a refused tool invocation is audited');
    assert.equal(refused['actor'], 'agent:certification-agent');
    assert.equal(refused['workspace_id'], otherWorkspace);
    assert.equal(refused['target'], otherWorkspace);
    const refusedDetail = refused['detail'] as Record<string, unknown>;
    assert.equal(refusedDetail['tool'], 'discover_data_products');
    assert.equal(refusedDetail['error_code'], 'WORKSPACE_ACCESS_DENIED');
    assert.equal(refusedDetail['agent_identity_id'], agentId);
    assert.equal(refusedDetail['oauth_client_id'], client.client_id);
  } finally {
    await console.stop();
  }
});
