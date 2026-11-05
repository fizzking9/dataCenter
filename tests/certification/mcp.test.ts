import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startConsole } from '../support/console.js';
import { MCP_VERSION, mcpCall, mcpError, mcpResult } from '../support/mcp.js';
import { initializePlatform } from '../support/platform.js';

const DISCOVER = { jsonrpc: '2.0', id: 1, method: 'server/discover' };

test('MCP discovery answers the current protocol and rejects legacy versions, sessions, and transports', async () => {
  const fixture = initializePlatform();
  const console = await startConsole(fixture);
  try {
    const discover = await mcpCall(console.url, DISCOVER);
    assert.equal(discover.status, 200, discover.text);
    const result = mcpResult(discover);
    assert.equal(result['protocolVersion'], MCP_VERSION);
    assert.deepEqual(result['supportedVersions'], [MCP_VERSION]);
    assert.equal(typeof (result['serverInfo'] as Record<string, unknown>)['name'], 'string');
    const capabilities = result['capabilities'] as Record<string, unknown>;
    assert.equal(typeof (capabilities['tools'] as Record<string, unknown>), 'object');
    assert.equal(discover.text.includes('workspace'), false, 'discovery reveals no Workspace');
    assert.equal(discover.text.includes('data_product'), false, 'discovery reveals no Data Product');

    const legacy = await mcpCall(console.url, DISCOVER, { protocolVersion: '2025-11-25' });
    assert.equal(legacy.status, 400);
    const unsupported = mcpError(legacy);
    assert.equal(unsupported.code, -32022);
    assert.deepEqual(unsupported.data['supported'], [MCP_VERSION]);
    assert.equal(unsupported.data['requested'], '2025-11-25');

    const missingVersion = await mcpCall(console.url, DISCOVER, { protocolVersion: null });
    assert.equal(missingVersion.status, 400);
    assert.equal(mcpError(missingVersion).data['code'], 'MCP_PROTOCOL_VERSION_REQUIRED');

    const legacyLifecycle = await mcpCall(console.url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
    });
    assert.equal(legacyLifecycle.status, 400);
    assert.equal(mcpError(legacyLifecycle).data['code'], 'MCP_LEGACY_LIFECYCLE_UNSUPPORTED');

    const session = await mcpCall(console.url, DISCOVER, { sessionId: 'session-from-a-legacy-client' });
    assert.equal(session.status, 400);
    assert.equal(mcpError(session).data['code'], 'MCP_SESSION_UNSUPPORTED');
    assert.equal(session.headers.get('mcp-session-id'), null, 'the server never mints a protocol session');

    const getStream = await mcpCall(console.url, DISCOVER, { method: 'GET' });
    assert.equal(getStream.status, 405);
    assert.equal(getStream.body['code'], 'MCP_TRANSPORT_UNSUPPORTED');
    assert.equal(getStream.headers.get('allow'), 'POST');

    const deleteStream = await mcpCall(console.url, DISCOVER, { method: 'DELETE' });
    assert.equal(deleteStream.status, 405);
    assert.equal(deleteStream.body['code'], 'MCP_TRANSPORT_UNSUPPORTED');

    const nonStreamable = await mcpCall(console.url, DISCOVER, { accept: 'application/json' });
    assert.equal(nonStreamable.status, 406);
    assert.equal(nonStreamable.body['code'], 'MCP_TRANSPORT_UNSUPPORTED');

    const wrongMethod = await mcpCall(console.url, DISCOVER, { mcpMethod: 'tools/list' });
    assert.equal(wrongMethod.status, 400);
    assert.equal(mcpError(wrongMethod).data['code'], 'MCP_METHOD_HEADER_MISMATCH');

    const missingMethod = await mcpCall(console.url, DISCOVER, { mcpMethod: null });
    assert.equal(missingMethod.status, 400);
    assert.equal(mcpError(missingMethod).data['code'], 'MCP_METHOD_HEADER_REQUIRED');
  } finally {
    await console.stop();
  }
});
