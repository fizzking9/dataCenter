import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIENT_METADATA, createAgent, grantAgent, issueAgentToken, registerAgentClient } from '../support/agents.js';
import { startConsole } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { callTool, listTools, mcpResult, toolFailure, toolPayload } from '../support/mcp.js';
import { createUser, createWorkspace } from '../support/platform.js';

const NLQ_CLIENT = { ...CLIENT_METADATA, client_id: 'https://agent.example.invalid/oauth/nlq-client.json' };

test('MCP exposes generic discovery, Contract, and direct-query tools narrowed to what the Agent may read', async () => {
  const product = publishLedgerProduct();
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken } = product;

  const agentId = createAgent(fixture, deploymentAdministratorToken, workspaceId);
  const client = registerAgentClient(fixture, deploymentAdministratorToken, agentId);
  // The Agent may see who and where a device is, never how much it handled.
  const narrowed = grantAgent(fixture, workspaceAdministratorToken, product.dataProductId, agentId, {
    columns: ['sn', 'city'],
  });
  assert.equal(narrowed.status, 0, narrowed.stderr);

  const console = await startConsole(fixture);
  try {
    const token = await issueAgentToken(console.url, client);

    const listed = await listTools(console.url, token);
    assert.equal(listed.status, 200, listed.text);
    const tools = mcpResult(listed)['tools'] as Array<Record<string, unknown>>;
    assert.deepEqual(tools.map((tool) => tool['name']), [
      'discover_data_products',
      'read_data_product_contract',
      'query_data_product',
      'discover_reports',
      'read_report',
    ]);
    for (const tool of tools) {
      assert.equal((tool['inputSchema'] as Record<string, unknown>)['type'], 'object');
    }
    assert.equal(listed.text.includes(product.dataProductId), false, 'no Data Product gets a bespoke tool');
    assert.equal(listed.text.includes('设备维修台账'), false, 'no Data Product gets a bespoke tool');

    const discovered = toolPayload(await callTool(console.url, token, 'discover_data_products', { workspace_id: workspaceId }));
    const views = discovered['data_products'] as Array<Record<string, unknown>>;
    assert.deepEqual(views.map((view) => view['name']), ['设备维修台账']);
    const view = views[0]!;
    assert.deepEqual((view['fields'] as Array<Record<string, unknown>>).map((field) => field['name']), ['sn', 'city']);
    assert.deepEqual((view['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']), ['device_count']);
    assert.deepEqual(view['filters'], ['city']);
    assert.deepEqual(view['dimensions'], ['city']);

    const contract = toolPayload(await callTool(console.url, token, 'read_data_product_contract', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
    }));
    assert.equal(contract['title'], '设备维修台账');
    assert.deepEqual((contract['fields'] as Array<Record<string, unknown>>).map((field) => field['name']), ['sn', 'city']);
    assert.deepEqual((contract['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']), ['device_count']);
    assert.deepEqual(contract['grain'], ['sn']);
    assert.deepEqual(contract['limits'], { max_scanned_records: 100_000, max_groups: 10_000, max_execution_ms: 5_000 });

    const answered = toolPayload(await callTool(console.url, token, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
      query: { kind: 'records' },
    }));
    assert.deepEqual(answered['columns'], ['sn', 'city']);
    assert.deepEqual(answered['records'], [
      { sn: 'sn-001', city: '杭州' },
      { sn: 'sn-002', city: '上海' },
      { sn: 'sn-003', city: null },
    ]);

    // A column the Grant hides cannot even be filtered on: that would disclose it.
    const refused = await callTool(console.url, token, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
      query: { kind: 'records', filters: [{ field: 'handled_count', op: 'equals', value: 3 }] },
    });
    assert.equal(refused.status, 200, refused.text);
    assert.equal(mcpResult(refused)['isError'], true);
    const refusal = toolFailure(refused);
    assert.equal(refusal.code, 'DATA_PRODUCT_QUERY_REFUSED');
    assert.equal(refusal.retryable, false);

    // An argument the tool cannot act on is refused by name, not guessed at.
    const missingArgument = await callTool(console.url, token, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
    });
    assert.equal(mcpResult(missingArgument)['isError'], true);
    assert.equal(toolFailure(missingArgument).code, 'MCP_ARGUMENT_INVALID');
    assert.equal(toolFailure(missingArgument).field, 'query');

    const unknownTool = await callTool(console.url, token, 'query_devices', {});
    assert.equal(unknownTool.status, 400);
    assert.equal((unknownTool.body['error'] as Record<string, unknown>)['data'] instanceof Object, true);
    assert.equal(
      ((unknownTool.body['error'] as Record<string, unknown>)['data'] as Record<string, unknown>)['code'],
      'MCP_TOOL_NOT_FOUND',
    );

    // A Workspace the Agent Identity is not bound to is not discoverable at all.
    createUser(fixture, deploymentAdministratorToken, 'elsewhere@example.invalid', 'elsewhere-administrator');
    const otherWorkspace = createWorkspace(fixture, deploymentAdministratorToken, 'Elsewhere', 'elsewhere@example.invalid');
    const elsewhere = await callTool(console.url, token, 'discover_data_products', { workspace_id: otherWorkspace });
    assert.equal(mcpResult(elsewhere)['isError'], true);
    assert.equal(toolFailure(elsewhere).code, 'WORKSPACE_ACCESS_DENIED');

    // An Agent holding only the Natural-Language Query scope sees exactly the
    // Natural-Language Query tools, and no Data Product read: the two scopes are
    // distinct capability ceilings, never one replacing the other.
    const nlqAgent = createAgent(fixture, deploymentAdministratorToken, workspaceId, 'mcp:nlq', 'nlq-agent');
    const nlqClient = registerAgentClient(fixture, deploymentAdministratorToken, nlqAgent, NLQ_CLIENT, 'nlq-client');
    const nlqToken = await issueAgentToken(console.url, nlqClient, 'mcp:nlq');
    const nlqListed = await listTools(console.url, nlqToken);
    assert.equal(nlqListed.status, 200, nlqListed.text);
    assert.deepEqual(
      (mcpResult(nlqListed)['tools'] as Array<Record<string, unknown>>).map((tool) => tool['name']),
      ['ask_natural_language_query', 'continue_natural_language_query'],
    );

    const nlqDenied = await callTool(console.url, nlqToken, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
      query: { kind: 'records' },
    });
    assert.equal(nlqDenied.status, 403);
    assert.equal(nlqDenied.body['code'], 'MCP_SCOPE_REQUIRED');

    // Reading Reports is a read ceiling: an mcp:nlq token may not read one, and
    // an mcp:read token may not ask a question.
    const reportReadDenied = await callTool(console.url, nlqToken, 'discover_reports', { workspace_id: workspaceId });
    assert.equal(reportReadDenied.status, 403);
    assert.equal(reportReadDenied.body['code'], 'MCP_SCOPE_REQUIRED');
    const askDenied = await callTool(console.url, token, 'ask_natural_language_query', {
      workspace_id: workspaceId,
      question: '2026 年 1 月的处理量合计是多少？',
    });
    assert.equal(askDenied.status, 403);
    assert.equal(askDenied.body['code'], 'MCP_SCOPE_REQUIRED');
  } finally {
    await console.stop();
  }
});
