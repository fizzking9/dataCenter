import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgent, grantAgent, issueAgentToken, registerAgentClient } from '../support/agents.js';
import { callApi, startConsole } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { callTool, mcpResult, toolFailure, toolPayload } from '../support/mcp.js';
import { command, jsonFile } from '../support/platform.js';

const CONSUMER = 'analyst@example.invalid';

/** Strips the server-local cache marker, which is not part of the governed answer. */
function governed(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  delete copy['cache'];
  return copy;
}

test('MCP answers direct Data Product Queries exactly as the Data Product API answers them', async () => {
  const product = publishLedgerProduct();
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken, consumerToken } = product;

  // Both readers are narrowed by the same Grant, so nothing but the surface differs.
  const narrowing = {
    columns: ['sn', 'city'],
    row_filters: [{ field: 'city', op: 'is_not_null' }],
  };
  const consumerGrant = command(
    fixture,
    ['grant', 'publish', '--product', product.dataProductId, '--username', CONSUMER, '--request', jsonFile(fixture, 'consumer-grant', narrowing)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(consumerGrant.status, 0, consumerGrant.stderr);
  const agentId = createAgent(fixture, deploymentAdministratorToken, workspaceId);
  const client = registerAgentClient(fixture, deploymentAdministratorToken, agentId);
  const agentGrant = grantAgent(fixture, workspaceAdministratorToken, product.dataProductId, agentId, narrowing);
  assert.equal(agentGrant.status, 0, agentGrant.stderr);

  const console = await startConsole(fixture);
  try {
    const agentToken = await issueAgentToken(console.url, client);
    const path = `/api/workspaces/${workspaceId}/data-products/${product.dataProductId}/query`;
    const api = (query: Record<string, unknown>) => callApi(console.url, path, { body: query, token: consumerToken });
    const mcp = async (query: Record<string, unknown>) => toolPayload(
      await callTool(console.url, agentToken, 'query_data_product', {
        workspace_id: workspaceId,
        data_product_id: product.dataProductId,
        query,
      }),
    );

    // Records, Provenance, and freshness are one answer, not two.
    const apiRecords = await api({ kind: 'records' });
    assert.equal(apiRecords.status, 200, apiRecords.text);
    const mcpRecords = await mcp({ kind: 'records' });
    assert.deepEqual(governed(mcpRecords), governed(apiRecords.body));
    assert.deepEqual(mcpRecords['provenance'], apiRecords.body['provenance']);
    assert.equal(mcpRecords['scanned_records'], 2, 'both readers are narrowed to the same population');
    assert.equal((mcpRecords['provenance'] as Record<string, unknown>)['record_count'], null);
    assert.equal((mcpRecords['provenance'] as Record<string, unknown>)['permitted_record_count'], 2);

    // The cursor is the same bytes, and it walks the same next page.
    const apiFirst = await api({ kind: 'records', limit: 1 });
    const mcpFirst = await mcp({ kind: 'records', limit: 1 });
    assert.deepEqual(governed(mcpFirst), governed(apiFirst.body));
    const cursor = apiFirst.body['next_cursor'];
    assert.equal(typeof cursor, 'string');
    assert.equal(mcpFirst['next_cursor'], cursor, 'a cursor minted by one surface is the other surface\'s cursor');
    const apiSecond = await api({ kind: 'records', limit: 1, cursor });
    const mcpSecond = await mcp({ kind: 'records', limit: 1, cursor });
    assert.deepEqual(governed(mcpSecond), governed(apiSecond.body));
    assert.deepEqual(mcpSecond['records'], [{ sn: 'sn-002', city: '上海' }]);

    // Aggregates agree on the metric set the narrowed Contract still permits.
    const aggregateQuery = { kind: 'aggregate', group_by: ['city'], include_totals: true };
    const apiAggregate = await api(aggregateQuery);
    assert.equal(apiAggregate.status, 200, apiAggregate.text);
    const mcpAggregate = await mcp(aggregateQuery);
    assert.deepEqual(governed(mcpAggregate), governed(apiAggregate.body));
    assert.equal(mcpAggregate['groups_total'], 2);
    assert.deepEqual(
      (mcpAggregate['groups'] as Array<Record<string, unknown>>)
        .map((entry) => (entry['group'] as Record<string, unknown>)['city'])
        .sort(),
      ['上海', '杭州'],
    );
    assert.deepEqual(governed(mcpAggregate['totals'] as Record<string, unknown>), governed(apiAggregate.body['totals'] as Record<string, unknown>));

    // A column the Grant hides is refused with the same code and the same words.
    const refusedQuery = { kind: 'records', filters: [{ field: 'handled_count', op: 'equals', value: 3 }] };
    const apiRefused = await api(refusedQuery);
    assert.equal(apiRefused.status, 403, apiRefused.text);
    assert.equal(apiRefused.body['code'], 'DATA_PRODUCT_QUERY_REFUSED');
    const mcpRefused = await callTool(console.url, agentToken, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
      query: refusedQuery,
    });
    assert.equal(mcpResult(mcpRefused)['isError'], true);
    assert.equal(toolFailure(mcpRefused).code, apiRefused.body['code']);
    assert.equal(toolFailure(mcpRefused).message, apiRefused.body['message']);

    // A malformed Query document fails the same way on both surfaces.
    const malformed = { kind: 'records', filters: [{ field: 'city', op: 'sounds_right' }] };
    const apiMalformed = await api(malformed);
    assert.equal(apiMalformed.status, 400, apiMalformed.text);
    assert.equal(apiMalformed.body['code'], 'DATA_PRODUCT_QUERY_INVALID');
    const mcpMalformed = await callTool(console.url, agentToken, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: product.dataProductId,
      query: malformed,
    });
    assert.equal(toolFailure(mcpMalformed).code, apiMalformed.body['code']);

    // A page is reused only under the exact context that produced it.
    const apiAgain = await api({ kind: 'records' });
    const mcpAgain = await mcp({ kind: 'records' });
    assert.equal((apiAgain.body['cache'] as Record<string, unknown>)['reused'], true);
    assert.equal((mcpAgain['cache'] as Record<string, unknown>)['reused'], true);
    assert.deepEqual(governed(mcpAgain), governed(apiAgain.body));
  } finally {
    await console.stop();
  }
});
