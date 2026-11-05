import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startConsoleServer, USER_SESSION_COOKIE, type ConsoleServer } from '../../src/console-server.js';
import { createAgent, grantAgent, issueAgentToken, registerAgentClient } from '../support/agents.js';
import { callApi } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { callTool, mcpResult, toolFailure, toolPayload, type McpResult } from '../support/mcp.js';
import {
  configureOperations,
  OPERATIONS_ASK_QUESTION,
  readyOperationsSurface,
  type OperationsSurface,
} from '../support/operations.js';
import { command, jsonFile, type PlatformFixture } from '../support/platform.js';

/** One instant every admission decision of a test shares, so no wall clock leaks in. */
const AT = '2026-06-01T00:00:00.000Z';

interface AdmissionResult {
  outcome: string;
  code?: string;
  lease_id: string | null;
}

/** Admits one operation through the Operator control, as an in-flight holder. */
function admitLease(
  fixture: PlatformFixture,
  token: string,
  request: Record<string, unknown>,
  at: string,
): string {
  const stated = jsonFile(fixture, `admission-${String(Math.random()).slice(2)}`, { requests: [request] });
  const result = command(fixture, ['operations', 'admit', '--requests', stated, '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
  const outcomes = result.output['results'] as AdmissionResult[];
  assert.equal(outcomes[0]?.outcome, 'admitted', JSON.stringify(outcomes));
  return String(outcomes[0]?.lease_id);
}

function finishLease(fixture: PlatformFixture, token: string, leaseId: string, at: string): void {
  const stated = jsonFile(fixture, `admission-finish-${String(Math.random()).slice(2)}`, { leases: [leaseId] });
  const result = command(fixture, ['operations', 'finish', '--leases', stated, '--at', at], { token });
  assert.equal(result.status, 0, result.stderr);
}

function inFlight(fixture: PlatformFixture, token: string): Record<string, number> {
  const shown = command(fixture, ['operations', 'show'], { token });
  assert.equal(shown.status, 0, shown.stderr);
  return shown.output['in_flight'] as Record<string, number>;
}

async function startAdmissionServer(fixture: PlatformFixture, clock?: () => string): Promise<ConsoleServer> {
  return startConsoleServer({
    root: fixture.root,
    masterKey: fixture.masterKey,
    port: 0,
    ...(clock === undefined ? {} : { clock }),
  });
}

/**
 * Section 15: the platform admits 20 Consumer operations and no more. The
 * published Data Product API is one of those operations, so a request past the
 * ceiling is refused explicitly and admitted again once the slot is released.
 */
test('the Data Product API refuses at the platform Consumer ceiling and recovers after release', async () => {
  const product = publishLedgerProduct();
  const { fixture } = product;
  configureOperations(fixture, product.deploymentAdministratorToken, {
    limits: {
      consumer_concurrency: 1,
      llm_concurrency: 1,
      agent_direct_concurrency: 1,
      agent_llm_concurrency: 1,
    },
  }, 'admission-api-limits');
  const server = await startAdmissionServer(fixture, () => AT);
  try {
    const leaseId = admitLease(fixture, product.deploymentAdministratorToken, {
      workspace: product.workspaceId,
      operation: 'api_query',
      class: 'direct',
    }, AT);
    const path = `/api/workspaces/${product.workspaceId}/data-products/${product.dataProductId}/query`;

    // The only Consumer slot is occupied, so the API states the ceiling rather
    // than returning a partial or truncated answer.
    const refused = await callApi(server.url, path, { token: product.consumerToken, body: { kind: 'records' } });
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.body['code'], 'PLATFORM_CONCURRENCY_LIMIT');
    assert.equal(refused.body['message'], 'The Deployment is running its 1 Consumer operations.');
    assert.equal(refused.body['records'], undefined);
    const shown = command(fixture, ['operations', 'show'], { token: product.deploymentAdministratorToken });
    assert.equal(shown.output['waiting'], 0, 'a refused execution path queues nothing');

    finishLease(fixture, product.deploymentAdministratorToken, leaseId, AT);
    const admitted = await callApi(server.url, path, { token: product.consumerToken, body: { kind: 'records' } });
    assert.equal(admitted.status, 200, admitted.text);
    assert.equal((admitted.body['records'] as unknown[]).length, 3);
    assert.deepEqual(
      inFlight(fixture, product.deploymentAdministratorToken),
      { direct: 0, llm: 0, async: 0 },
      'the execution path releases its own lease',
    );
  } finally {
    await server.close();
  }
});

/**
 * The Agent Identity limits are per minute and per concurrency. The MCP surface
 * states each refusal as a structured tool error, and a later clock tick makes
 * the rate window pass without a real sleep.
 */
test('MCP refuses at the Agent rate ceiling and admits again when the window passes', async () => {
  const product = publishLedgerProduct();
  const { fixture } = product;
  configureOperations(fixture, product.deploymentAdministratorToken, {
    limits: { agent_direct_requests_per_minute: 2 },
  }, 'admission-agent-rate-limits');
  let at = AT;
  const server = await startAdmissionServer(fixture, () => at);
  try {
    const agentId = createAgent(fixture, product.deploymentAdministratorToken, product.workspaceId);
    const client = registerAgentClient(fixture, product.deploymentAdministratorToken, agentId);
    const token = await issueAgentToken(server.url, client, 'mcp:read');
    const discover = async (): Promise<McpResult> =>
      callTool(server.url, token, 'discover_data_products', { workspace_id: product.workspaceId });

    for (const call of [1, 2]) {
      const permitted = await discover();
      assert.equal(permitted.status, 200, permitted.text);
      assert.notEqual(mcpResult(permitted)['isError'], true, `request ${String(call)} is inside the ceiling`);
    }

    const refused = await discover();
    assert.equal(refused.status, 200, refused.text);
    assert.equal(mcpResult(refused)['isError'], true);
    const failure = toolFailure(refused);
    assert.equal(failure.code, 'AGENT_RATE_LIMITED');
    assert.match(failure.message, /2 direct requests per minute/u);
    assert.ok(failure.next_step !== undefined, 'the refusal states what to do next');

    // The window is time, not a release: advancing the injected clock past one
    // minute admits the next request deterministically.
    at = new Date(Date.parse(AT) + 61_000).toISOString();
    const recovered = await discover();
    assert.equal(recovered.status, 200, recovered.text);
    assert.notEqual(mcpResult(recovered)['isError'], true, recovered.text);
  } finally {
    await server.close();
  }
});

/**
 * One LLM-backed operation per Agent Identity. While a turn holds that slot a
 * second MCP question is refused before it reaches the model, and finishing the
 * first turn admits the next one.
 */
test('MCP refuses a second LLM-backed operation per Agent and recovers after release', async () => {
  const surface: OperationsSurface = await readyOperationsSurface();
  const { fixture, workspaceId } = surface;
  try {
    const agentId = createAgent(
      fixture,
      surface.deploymentAdministratorToken,
      workspaceId,
      'mcp:read mcp:nlq',
      'admission-nlq-agent',
    );
    const client = registerAgentClient(fixture, surface.deploymentAdministratorToken, agentId);
    const granted = grantAgent(fixture, surface.workspaceAdministratorToken, surface.dataProductId, agentId, {
      columns: ['sn', 'city', 'handled_count', 'reported_on'],
      row_filters: [],
    });
    assert.equal(granted.status, 0, granted.stderr);
    const server = await startAdmissionServer(fixture, () => AT);
    try {
      const token = await issueAgentToken(server.url, client, 'mcp:nlq');
      const leaseId = admitLease(fixture, surface.deploymentAdministratorToken, {
        workspace: workspaceId,
        operation: 'nlq',
        class: 'llm',
        agent: agentId,
      }, AT);
      const modelCalls = surface.endpoint.calls.length;
      const ask = async (): Promise<McpResult> =>
        callTool(server.url, token, 'ask_natural_language_query', {
          workspace_id: workspaceId,
          data_product_id: surface.dataProductId,
          question: OPERATIONS_ASK_QUESTION,
        });

      const refused = await ask();
      assert.equal(refused.status, 200, refused.text);
      assert.equal(mcpResult(refused)['isError'], true);
      const failure = toolFailure(refused);
      assert.equal(failure.code, 'AGENT_CONCURRENCY_LIMIT');
      assert.match(failure.message, /1 LLM-backed operations at once/u);
      assert.equal(surface.endpoint.calls.length, modelCalls, 'the refused turn never reached the model');

      finishLease(fixture, surface.deploymentAdministratorToken, leaseId, AT);
      const answered = await ask();
      assert.notEqual(mcpResult(answered)['isError'], true, answered.text);
      const payload = toolPayload(answered);
      assert.equal(payload['outcome'], 'answered', JSON.stringify(payload));
      assert.ok(surface.endpoint.calls.length > modelCalls, 'the admitted turn really planned and narrated');
    } finally {
      await server.close();
    }
  } finally {
    await surface.endpoint.close();
  }
});

/**
 * Natural-Language Query and Report generation both draw from the platform
 * LLM-backed ceiling. The member NLQ path and the Report HTTP route each refuse
 * explicitly while the only slot is held, then run once it is released.
 */
test('Natural-Language Query and Report generation share the LLM ceiling and recover after release', async () => {
  const surface: OperationsSurface = await readyOperationsSurface();
  const { fixture, workspaceId } = surface;
  try {
    configureOperations(fixture, surface.deploymentAdministratorToken, {
      limits: { llm_concurrency: 1, agent_llm_concurrency: 1 },
    }, 'admission-llm-limits');
    const server = await startAdmissionServer(fixture, () => AT);
    try {
      const leaseId = admitLease(fixture, surface.deploymentAdministratorToken, {
        workspace: workspaceId,
        operation: 'report_generation',
        class: 'llm',
      }, AT);
      const ask = async (): Promise<Awaited<ReturnType<typeof callApi>>> =>
        callApi(server.url, `/api/workspace/nlq?workspace_id=${workspaceId}`, {
          cookie: `${USER_SESSION_COOKIE}=${surface.consumerToken}`,
          body: { question: OPERATIONS_ASK_QUESTION },
        });
      const generate = async (): Promise<Awaited<ReturnType<typeof callApi>>> =>
        callApi(server.url, `/api/workspace/report-templates/${surface.templateId}/generate`, {
          cookie: `${USER_SESSION_COOKIE}=${surface.workspaceAdministratorToken}`,
          body: { workspace_id: workspaceId },
        });

      const refusedAsk = await ask();
      assert.equal(refusedAsk.status, 429, refusedAsk.text);
      assert.equal(refusedAsk.body['code'], 'PLATFORM_CONCURRENCY_LIMIT');
      const refusedReport = await generate();
      assert.equal(refusedReport.status, 429, refusedReport.text);
      assert.equal(refusedReport.body['code'], 'PLATFORM_CONCURRENCY_LIMIT');

      finishLease(fixture, surface.deploymentAdministratorToken, leaseId, AT);
      const answered = await ask();
      assert.equal(answered.status, 200, answered.text);
      assert.equal(answered.body['outcome'], 'answered', JSON.stringify(answered.body));
      const generated = await generate();
      assert.equal(generated.status, 201, generated.text);
      assert.equal(generated.body['origin'], 'generated');
      assert.deepEqual(
        inFlight(fixture, surface.deploymentAdministratorToken),
        { direct: 0, llm: 0, async: 0 },
        'both execution paths released what they held',
      );
    } finally {
      await server.close();
    }
  } finally {
    await surface.endpoint.close();
  }
});
