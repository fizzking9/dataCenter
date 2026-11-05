import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandAsync } from '../support/async-command.js';
import {
  createAgent,
  delegateAgent,
  grantAgent,
  issueAgentToken,
  issueDelegatedToken,
  registerAgentClient,
  userCookie,
} from '../support/agents.js';
import { startConsole, type ConsoleHandle } from '../support/console.js';
import { EXTENDED_LEDGER_CONTRACT, publishLedgerProduct } from '../support/data-product.js';
import { callTool, listTools, mcpResult, toolFailure, type McpResult } from '../support/mcp.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from '../support/model-endpoint.js';
import {
  command,
  createUser,
  createWorkspace,
  jsonFile,
  type PlatformFixture,
} from '../support/platform.js';

const PURPOSES = ['query_plan', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['product_contract', 'sample_records'];
const PROMPTS = {
  query_plan: '你是数据产品查询规划器，只输出简体中文解释，并且只使用受治理契约发布的字段、维度、指标和算子。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据或因果。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};
const GROUNDED_ANSWER_PROMPT = '只依据给定证据用简体中文撰写报告叙述，不得推测证据之外的数据或因果。';
const QUESTION = '2026-01-05 至 2026-01-20 的处理量合计是多少？';
const AGENT_NAME = 'certification-agent';
const AGENT_ACTOR = `agent:${AGENT_NAME}`;
const ANALYST = 'analyst@example.invalid';

interface Surface {
  fixture: PlatformFixture;
  workspaceId: string;
  elsewhereId: string;
  dataProductId: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  agentId: string;
  delegationId: string;
  analystUserId: string;
  adminReportId: string;
  endpoint: MockModelEndpoint;
  console: ConsoleHandle;
  readToken: string;
  nlqToken: string;
  delegatedReadToken: string;
  delegatedNlqToken: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function profileConfig(endpoint: MockModelEndpoint): Record<string, unknown> {
  return {
    adapter: 'generic_local',
    endpoint_url: endpoint.url,
    model_id: MOCK_MODEL_ID,
    purposes: [...PURPOSES],
    data_categories: [...DATA_CATEGORIES],
    tools: [],
    max_output_bytes: 65_536,
    prompts: { ...PROMPTS },
  };
}

function templateConfig(): Record<string, unknown> {
  return {
    question: QUESTION,
    parameters: [
      { name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-20' } },
    ],
    query: {
      kind: 'aggregate',
      metrics: ['handled_total'],
      window: { start: '2026-01-05', end: '2026-01-20' },
      include_totals: true,
      limit: 100,
    },
    grounded_prompt: GROUNDED_ANSWER_PROMPT,
    freshness: { max_age_minutes: 15 },
  };
}

/** Every User the Deployment stores, so an identity is read from state, not guessed. */
function usersOf(fixture: PlatformFixture): Array<Record<string, unknown>> {
  const state = JSON.parse(readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8')) as Record<string, unknown>;
  return (state['users'] ?? []) as Array<Record<string, unknown>>;
}

function reportsOf(fixture: PlatformFixture): Array<Record<string, unknown>> {
  const state = JSON.parse(readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8')) as Record<string, unknown>;
  return (state['reports'] ?? []) as Array<Record<string, unknown>>;
}

function auditEvents(fixture: PlatformFixture): Array<Record<string, unknown>> {
  return readFileSync(join(fixture.root, 'audit', 'events.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function auditsOf(fixture: PlatformFixture, action: string): Array<Record<string, unknown>> {
  return auditEvents(fixture).filter((event) => event['action'] === action);
}

function payload(result: McpResult, label: string): Record<string, unknown> {
  const body = mcpResult(result);
  assert.notEqual(body['isError'], true, `${label}: ${result.text}`);
  return asRecord(body['structuredContent']);
}

/** The governed half of a query result, with cache bookkeeping left out. */
function governedNumbers(result: Record<string, unknown>): Record<string, unknown> {
  const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => isRecordOrNull(entry) !== null) : [];
  const groups = records(result['groups']);
  const metrics = records(result['metrics']);
  return {
    kind: result['kind'] ?? null,
    metrics: metrics.map((metric) => metric['name'] ?? null),
    grouped_by: result['grouped_by'] ?? null,
    groups_total: result['groups_total'] ?? null,
    returned: result['returned'] ?? null,
    groups: groups.map((group) => ({
      group: group['group'] ?? null,
      metrics: group['metrics'] ?? null,
      comparison: group['comparison'] ?? null,
    })),
    totals: result['totals'] ?? null,
    window: result['window'] ?? null,
    comparison_window: result['comparison_window'] ?? null,
  };
}

function isRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function totalOf(result: Record<string, unknown> | null, metric: string): unknown {
  assert.ok(result !== null, 'the answer carries a structured result');
  return asRecord(asRecord(result['totals'])['metrics'])[metric];
}

/** Answers one pinned query through the deterministic engine, as the Consumer reads it. */
function directRead(s: Surface, query: Record<string, unknown>, release: unknown): Record<string, unknown> {
  const request = release === undefined ? { ...query } : { ...query, release };
  const direct = command(
    s.fixture,
    ['product', 'query', '--product', s.dataProductId, '--request', jsonFile(s.fixture, 'mcp-direct-request', request)],
    { token: s.consumerToken },
  );
  assert.equal(direct.status, 0, direct.stderr);
  return direct.output as Record<string, unknown>;
}

/** Counts the Han characters in a string, so copy checks need no locale data. */
function hanCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) count += 1;
  }
  return count;
}

const LATIN_TOKENS = [
  'handled_total', 'handled_count', 'settled_total', 'device_count',
  'include_totals', 'limit', 'metrics', 'window', 'SQL', 'SN', 'sn-002', 'sn', 'CNY',
];

function assertChineseCopy(text: string, label: string): void {
  assert.equal(typeof text, 'string', `${label} is a string`);
  let rest = text;
  for (const token of LATIN_TOKENS) rest = rest.split(token).join(' ');
  assert.ok(hanCount(rest) >= 4, `${label} is written in Chinese: ${text}`);
  assert.equal(/[A-Za-z]/u.test(rest), false, `${label} carries no English prose: ${text}`);
}

/**
 * One Workspace holding a published ledger, one activated Model Profile bound for
 * planning, narration, and clarification, one published Report Template with its
 * first Report stocked by the Workspace Administrator, a second empty Workspace,
 * one Agent Identity bound to both, and one Consumer's delegated consent.
 */
async function readySurface(): Promise<Surface> {
  const base = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  const { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken, consumerToken } = base;
  const endpoint = await startMockModelEndpoint();
  try {
    const published = command(
      fixture,
      ['model', 'publish', '--name', '对话报告模型', '--config', jsonFile(fixture, 'mcp-nlq-profile', profileConfig(endpoint))],
      { token: deploymentAdministratorToken },
    );
    assert.equal(published.status, 0, published.stderr);
    const profileId = String(published.output['model_profile_id']);
    const version = Number(published.output['model_profile_version']);
    const evaluated = await commandAsync(
      fixture,
      ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
      { token: deploymentAdministratorToken },
    );
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
    const activated = await commandAsync(
      fixture,
      ['model', 'activate', '--profile', profileId, '--version', String(version)],
      { token: deploymentAdministratorToken },
    );
    assert.equal(activated.status, 0, activated.stderr);
    const bound = await commandAsync(
      fixture,
      [
        'binding', 'publish',
        '--workspace', workspaceId,
        '--profile', profileId,
        '--config', jsonFile(fixture, 'mcp-nlq-binding', {
          model_profile_version: version,
          purposes: [...PURPOSES],
          data_categories: [...DATA_CATEGORIES],
        }),
      ],
      { token: workspaceAdministratorToken },
    );
    assert.equal(bound.status, 0, bound.stderr);

    // A second Workspace the Agent Identity is bound to, so a conversation handle
    // of one Workspace can be presented in another.
    createUser(fixture, deploymentAdministratorToken, 'elsewhere@example.invalid', 'elsewhere-administrator');
    const elsewhereId = createWorkspace(fixture, deploymentAdministratorToken, 'Elsewhere', 'elsewhere@example.invalid');

    const agentId = createAgent(fixture, deploymentAdministratorToken, `${workspaceId},${elsewhereId}`, 'mcp:read mcp:nlq');
    const client = registerAgentClient(fixture, deploymentAdministratorToken, agentId);

    // The Agent Identity's own Grant and the delegated User's Grant are both
    // narrower than the Contract; only their intersection may be read.
    const agentGrant = grantAgent(fixture, workspaceAdministratorToken, base.dataProductId, agentId, {
      columns: ['sn', 'city', 'handled_count', 'reported_on'],
      row_filters: [],
    });
    assert.equal(agentGrant.status, 0, agentGrant.stderr);
    const userGrant = command(
      fixture,
      [
        'grant', 'publish',
        '--product', base.dataProductId,
        '--username', ANALYST,
        '--request', jsonFile(fixture, 'mcp-user-grant', {
          columns: ['city', 'handled_count', 'reported_on'],
          row_filters: [],
        }),
      ],
      { token: workspaceAdministratorToken },
    );
    assert.equal(userGrant.status, 0, userGrant.stderr);

    const delegation = delegateAgent(fixture, consumerToken, agentId, workspaceId);
    const analystUserId = String(usersOf(fixture).find((user) => user['username'] === ANALYST)?.['user_id']);
    assert.ok(analystUserId.length > 0, 'the delegated User exists');

    const template = command(
      fixture,
      [
        'report', 'template-publish',
        '--workspace', workspaceId,
        '--product', base.dataProductId,
        '--name', '日处理量报告',
        '--config', jsonFile(fixture, 'mcp-report-template', templateConfig()),
      ],
      { token: workspaceAdministratorToken },
    );
    assert.equal(template.status, 0, template.stderr);
    const generated = await commandAsync(
      fixture,
      ['report', 'generate', '--template', String(template.output['report_template_id'])],
      { token: workspaceAdministratorToken },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const adminReportId = String(asRecord(generated.output['report'])['report_id']);

    const console = await startConsole(fixture);
    try {
      return {
        ...base,
        elsewhereId,
        agentId,
        delegationId: delegation.delegation_id,
        analystUserId,
        adminReportId,
        endpoint,
        console,
        readToken: await issueAgentToken(console.url, client, 'mcp:read'),
        nlqToken: await issueAgentToken(console.url, client, 'mcp:nlq'),
        delegatedReadToken: await issueDelegatedToken(console.url, client, {
          cookie: userCookie(consumerToken),
          workspaceId,
          scope: 'mcp:read',
        }),
        delegatedNlqToken: await issueDelegatedToken(console.url, client, {
          cookie: userCookie(consumerToken),
          workspaceId,
          scope: 'mcp:nlq',
        }),
      };
    } catch (error) {
      await console.stop();
      throw error;
    }
  } catch (error) {
    await endpoint.close();
    throw error;
  }
}

test('MCP publishes Natural-Language Query and Reports under distinct scope ceilings and delegated, revocable consent', async (t) => {
  const s = await readySurface();
  t.after(async () => {
    await s.console.stop();
    await s.endpoint.close();
  });
  const url = s.console.url;
  let generatedReportId = '';
  let delegatedConversation = '';

  await t.test('mcp:read and mcp:nlq are distinct ceilings that never replace object Grants', async () => {
    const readTools = mcpResult(await listTools(url, s.readToken))['tools'] as Array<Record<string, unknown>>;
    assert.deepEqual(readTools.map((tool) => tool['name']), [
      'discover_data_products',
      'read_data_product_contract',
      'query_data_product',
      'discover_reports',
      'read_report',
    ]);
    const nlqTools = mcpResult(await listTools(url, s.nlqToken))['tools'] as Array<Record<string, unknown>>;
    assert.deepEqual(nlqTools.map((tool) => tool['name']), [
      'ask_natural_language_query',
      'continue_natural_language_query',
    ]);

    // Neither ceiling lets a token reach the other's tools, even by name.
    const askWithRead = await callTool(url, s.readToken, 'ask_natural_language_query', {
      workspace_id: s.workspaceId,
      question: '2026 年 1 月的处理量合计是多少？',
    });
    assert.equal(askWithRead.status, 403, askWithRead.text);
    assert.equal(askWithRead.body['code'], 'MCP_SCOPE_REQUIRED');
    const readWithNlq = await callTool(url, s.nlqToken, 'discover_reports', { workspace_id: s.workspaceId });
    assert.equal(readWithNlq.status, 403, readWithNlq.text);
    assert.equal(readWithNlq.body['code'], 'MCP_SCOPE_REQUIRED');

    // The scope is a ceiling, not a Grant: the Agent's own Grant still narrows it.
    const autonomous = payload(await callTool(url, s.readToken, 'query_data_product', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      query: { kind: 'records' },
    }), 'the autonomous read');
    assert.deepEqual(autonomous['columns'], ['sn', 'city', 'handled_count', 'reported_on']);
    assert.deepEqual((autonomous['records'] as Array<Record<string, unknown>>).map((record) => record['sn']), [
      'sn-001', 'sn-002', 'sn-003',
    ]);

    // Delegated authority is the exact intersection: the Agent may see sn, the
    // User may not, so the pair never sees it, and neither Grant replaces the other.
    const delegated = payload(await callTool(url, s.delegatedReadToken, 'query_data_product', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      query: { kind: 'records' },
    }), 'the delegated read');
    assert.deepEqual(delegated['columns'], ['city', 'handled_count', 'reported_on']);
    for (const record of delegated['records'] as Array<Record<string, unknown>>) {
      assert.equal('sn' in record, false, 'a column only one party may read is never disclosed');
      assert.equal('settled_amount' in record, false, 'a column neither party may read is never disclosed');
    }

    // The Natural-Language Query scope alone opens no data: a Workspace with no
    // Data Product the Agent may read answers that nothing is available.
    const empty = payload(await callTool(url, s.nlqToken, 'ask_natural_language_query', {
      workspace_id: s.elsewhereId,
      question: '本月处理量合计是多少？',
    }), 'the empty-Workspace question');
    assert.equal(empty['outcome'], 'unavailable', JSON.stringify(empty));
    assert.equal(empty['reason_code'], 'NLQ_NO_VISIBLE_PRODUCT');
    assert.equal(empty['executed'], false);
  });

  await t.test('Report discovery and reading return stored facts only, narrowed by the current Grants', async () => {
    const modelCalls = s.endpoint.calls.length;
    const reportsBefore = reportsOf(s.fixture).length;

    // The Administrator's stocked Report was generated under another scope, so
    // neither the delegated pair nor the Agent may discover or read it.
    const delegatedList = payload(await callTool(url, s.delegatedReadToken, 'discover_reports', {
      workspace_id: s.workspaceId,
    }), 'the delegated Report listing');
    assert.deepEqual(delegatedList['reports'], []);
    const autonomousList = payload(await callTool(url, s.readToken, 'discover_reports', {
      workspace_id: s.workspaceId,
    }), 'the autonomous Report listing');
    assert.deepEqual(autonomousList['reports'], []);

    const refused = await callTool(url, s.delegatedReadToken, 'read_report', {
      workspace_id: s.workspaceId,
      report_id: s.adminReportId,
    });
    assert.equal(mcpResult(refused)['isError'], true, refused.text);
    assert.equal(toolFailure(refused).code, 'REPORT_NOT_AVAILABLE');

    assert.equal(reportsOf(s.fixture).length, reportsBefore, 'discovery and reading store no Report');
    assert.equal(s.endpoint.calls.length, modelCalls, 'discovery and reading incur no model cost');
  });

  await t.test('delegated Natural-Language Query generates the Report fallback in Chinese with deterministic governed values', async () => {
    const modelCalls = s.endpoint.calls.length;
    const reportsBefore = reportsOf(s.fixture).length;

    const turn = payload(await callTool(url, s.delegatedNlqToken, 'ask_natural_language_query', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      question: QUESTION,
    }), 'the delegated question');
    assert.equal(turn['outcome'], 'answered', JSON.stringify(turn));
    assert.equal(turn['origin'], 'generated', 'no Report existed under this exact scope, so one is generated');
    assert.ok(s.endpoint.calls.length > modelCalls, 'the generation fallback calls the model');
    assert.equal(reportsOf(s.fixture).length, reportsBefore + 1, 'the fallback stores exactly one Report');

    const report = asRecord(turn['report']);
    generatedReportId = String(report['report_id']);
    assert.equal(report['generated_by'], s.analystUserId, 'the Report attributes the delegated User');
    assert.deepEqual(asRecord(report['security'])['columns'], ['city', 'handled_count', 'reported_on']);
    assert.deepEqual(asRecord(report['query'])['metrics'], ['handled_total']);
    assert.equal(totalOf(asRecord(turn['result']), 'handled_total'), 10);

    // Every number, Release, and Provenance reference equals what the
    // deterministic engine computes for the Report's own pinned query.
    const direct = directRead(s, asRecord(report['query']), asRecord(report['data_product'])['data_product_release']);
    assert.deepEqual(governedNumbers(asRecord(turn['result'])), governedNumbers(direct));
    assert.deepEqual(turn['provenance'], direct['provenance']);
    assert.equal(asRecord(turn['data_product'])['data_product_release'], direct['data_product_release']);

    // The whole interaction is Simplified Chinese.
    assertChineseCopy(String(turn['summary']), 'the generated summary');
    assertChineseCopy(String(asRecord(turn['answer'])['narrative']), 'the generated narrative');
    for (const line of turn['limitations'] as string[]) assertChineseCopy(line, 'a generated limitation');
    assert.equal(typeof turn['conversation'], 'string', 'the turn returns a follow-up handle');
    delegatedConversation = String(turn['conversation']);

    // The generation Audit Event attributes the Agent and the delegated User.
    const generation = auditsOf(s.fixture, 'report_generation')
      .filter((event) => asRecord(event['detail'])['trigger'] === 'stock_refresh');
    assert.ok(generation.length >= 1, 'the fallback is audited');
    const generationDetail = asRecord(generation.at(-1)!['detail']);
    assert.equal(generation.at(-1)!['actor'], AGENT_ACTOR);
    assert.equal(generationDetail['delegated_user_id'], s.analystUserId);
    assert.equal(generationDetail['delegated_username'], ANALYST);
  });

  await t.test('the generated Report is discoverable and readable as stored, without generating or calling the model', async () => {
    const modelCalls = s.endpoint.calls.length;
    const reportsBefore = reportsOf(s.fixture).length;

    const listed = payload(await callTool(url, s.delegatedReadToken, 'discover_reports', {
      workspace_id: s.workspaceId,
    }), 'the delegated Report listing');
    const reports = listed['reports'] as Array<Record<string, unknown>>;
    assert.equal(reports.length, 1, 'only the Report of this exact intersection is visible');
    assert.equal(reports[0]!['report_id'], generatedReportId);
    assert.equal(reports[0]!['fresh'], true);

    const read = payload(await callTool(url, s.delegatedReadToken, 'read_report', {
      workspace_id: s.workspaceId,
      report_id: generatedReportId,
    }), 'the delegated Report read');
    assert.equal(read['origin'], 'stock');
    assert.equal(read['withdrawn'], false);
    const stored = asRecord(read['report']);
    assert.equal(stored['report_id'], generatedReportId);
    assert.equal(stored['generated_by'], s.analystUserId);
    assert.equal(totalOf(asRecord(stored['result']), 'handled_total'), 10);
    assertChineseCopy(String(read['summary']), 'the Report read summary');

    // The Agent Identity alone holds a wider Grant, so this Report of the
    // intersection is not its own: the object Grants still decide the read.
    const autonomousRead = await callTool(url, s.readToken, 'read_report', {
      workspace_id: s.workspaceId,
      report_id: generatedReportId,
    });
    assert.equal(mcpResult(autonomousRead)['isError'], true, autonomousRead.text);
    assert.equal(toolFailure(autonomousRead).code, 'REPORT_NOT_AVAILABLE');
    const autonomousList = payload(await callTool(url, s.readToken, 'discover_reports', {
      workspace_id: s.workspaceId,
    }), 'the autonomous Report listing');
    assert.deepEqual(autonomousList['reports'], []);

    assert.equal(reportsOf(s.fixture).length, reportsBefore, 'reading stores no Report');
    assert.equal(s.endpoint.calls.length, modelCalls, 'reading incurs no model cost');
  });

  await t.test('clarification is a structured Chinese response that executes nothing', async () => {
    const queriesBefore = auditsOf(s.fixture, 'data_product_query').length;
    const clarified = payload(await callTool(url, s.delegatedNlqToken, 'ask_natural_language_query', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      question: '杭州的处理量合计是多少？',
    }), 'the clarification question');
    assert.equal(clarified['outcome'], 'clarification', JSON.stringify(clarified));
    assert.equal(clarified['executed'], false);
    assert.equal(clarified['result'], null);
    assert.equal(clarified['answer'], null);
    const clarification = asRecord(clarified['clarification']);
    assert.deepEqual(clarification['missing'], ['period']);
    assertChineseCopy(String(clarification['question']), 'the clarification question');
    assert.equal(auditsOf(s.fixture, 'data_product_query').length, queriesBefore, 'a clarification executes no governed read');

    // Answering the structured clarification executes the turn.
    const answered = payload(await callTool(url, s.delegatedNlqToken, 'ask_natural_language_query', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      question: '杭州的处理量合计是多少？',
      clarification: '2026-01-05 至 2026-01-20',
    }), 'the clarified question');
    assert.equal(answered['outcome'], 'answered', JSON.stringify(answered));
    assert.equal(answered['executed'], true);
    assert.equal(totalOf(asRecord(answered['result']), 'handled_total'), 3);
  });

  await t.test('a follow-up handle binds the complete security context and Workspace, and Chinese mixed identifiers stay deterministic', async () => {
    const followUp = payload(await callTool(url, s.delegatedNlqToken, 'continue_natural_language_query', {
      workspace_id: s.workspaceId,
      conversation: delegatedConversation,
      question: '2026-01-05 至 2026-01-20 各城市的处理量合计是多少？',
    }), 'the delegated follow-up');
    assert.equal(followUp['outcome'], 'answered', JSON.stringify(followUp));
    assert.equal(followUp['follow_up'], true);
    assert.equal(totalOf(asRecord(followUp['result']), 'handled_total'), 10);
    const groups = asRecord(followUp['result'])['groups'] as Array<Record<string, unknown>>;
    assert.ok(groups.length >= 2, 'the follow-up groups by city');
    assertChineseCopy(String(followUp['summary']), 'the follow-up summary');

    const direct = directRead(s, asRecord(followUp['query']), undefined);
    assert.deepEqual(governedNumbers(asRecord(followUp['result'])), governedNumbers(direct));

    // The same handle presented by another subject, or in another Workspace,
    // is refused without executing anything.
    const otherSubject = payload(await callTool(url, s.nlqToken, 'continue_natural_language_query', {
      workspace_id: s.workspaceId,
      conversation: delegatedConversation,
      question: '2026-01-05 至 2026-01-20 各城市的处理量合计是多少？',
    }), 'the foreign-subject handle');
    assert.equal(otherSubject['outcome'], 'refused');
    assert.equal(otherSubject['reason_code'], 'NLQ_CONVERSATION_INVALID');
    assert.equal(otherSubject['executed'], false);
    const otherWorkspace = payload(await callTool(url, s.nlqToken, 'continue_natural_language_query', {
      workspace_id: s.elsewhereId,
      conversation: delegatedConversation,
      question: '2026-01-05 至 2026-01-20 各城市的处理量合计是多少？',
    }), 'the foreign-Workspace handle');
    assert.equal(otherWorkspace['outcome'], 'refused');
    assert.equal(otherWorkspace['reason_code'], 'NLQ_CONVERSATION_INVALID');

    // A Chinese question carrying a mixed SN identifier answers deterministically
    // under the Agent Identity's own authority, without any delegated User.
    const snQuestion = '2026-01-05 至 2026-01-20 SN 为 sn-002 的处理量合计是多少？';
    const snTurn = payload(await callTool(url, s.nlqToken, 'ask_natural_language_query', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      question: snQuestion,
    }), 'the SN question');
    assert.equal(snTurn['outcome'], 'answered', JSON.stringify(snTurn));
    assert.deepEqual(asRecord(snTurn['query'])['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }]);
    assert.equal(totalOf(asRecord(snTurn['result']), 'handled_total'), 5);
    assertChineseCopy(String(snTurn['summary']), 'the SN summary');
    assertChineseCopy(String(asRecord(snTurn['answer'])['narrative']), 'the SN narrative');
    // Asking again answers with exactly the same governed numbers, filters,
    // Release, and Provenance: the model phrases, it never computes.
    const repeated = payload(await callTool(url, s.nlqToken, 'ask_natural_language_query', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      question: snQuestion,
    }), 'the repeated SN question');
    assert.deepEqual(asRecord(repeated['query'])['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }]);
    assert.deepEqual(governedNumbers(asRecord(repeated['result'])), governedNumbers(asRecord(snTurn['result'])));
    assert.deepEqual(repeated['provenance'], snTurn['provenance']);
    assert.equal(
      asRecord(repeated['data_product'])['data_product_release'],
      asRecord(snTurn['data_product'])['data_product_release'],
    );
  });

  await t.test('every delegated Audit Event attributes the Agent Identity and the User together', async () => {
    const events = auditEvents(s.fixture);
    const toolCalls = events.filter((event) => event['action'] === 'mcp_tool_call');
    const delegatedCalls = toolCalls.filter((event) => asRecord(event['detail'])['delegated_user_id'] === s.analystUserId);
    for (const tool of ['ask_natural_language_query', 'continue_natural_language_query', 'query_data_product', 'discover_reports', 'read_report']) {
      const matching = delegatedCalls.filter((event) => asRecord(event['detail'])['tool'] === tool);
      assert.ok(matching.length > 0, `a delegated ${tool} invocation is audited`);
      for (const event of matching) {
        assert.equal(event['actor'], AGENT_ACTOR, 'the Agent is the recorded actor');
        const detail = asRecord(event['detail']);
        assert.equal(detail['agent_identity_id'], s.agentId);
        assert.equal(detail['delegated_username'], ANALYST);
        assert.equal(String(detail['oauth_client_id']).startsWith('https://agent.example.invalid/'), true);
      }
    }

    // The governed events the delegated turns produced attribute the User too.
    for (const action of ['natural_language_query', 'data_product_query', 'report_generation', 'report_retrieval', 'report_listing']) {
      const matching = events.filter(
        (event) => event['action'] === action
          && asRecord(event['detail'])['delegated_user_id'] === s.analystUserId,
      );
      assert.ok(matching.length > 0, `${action} attributes the delegated User`);
      for (const event of matching) assert.equal(event['actor'], AGENT_ACTOR);
    }

    // An autonomous call is attributed to the Agent alone: no invented User.
    const autonomous = toolCalls.filter(
      (event) => asRecord(event['detail'])['tool'] === 'query_data_product'
        && asRecord(event['detail'])['delegated_user_id'] === undefined,
    );
    assert.ok(autonomous.length > 0, 'the autonomous call is audited without a delegated User');
    for (const event of autonomous) assert.equal(event['actor'], AGENT_ACTOR);
  });

  await t.test('revocation fails closed on the next page, Report read, and follow-up without existence leakage', async () => {
    // One page is read under the consent before it is withdrawn.
    const first = payload(await callTool(url, s.delegatedReadToken, 'query_data_product', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      query: { kind: 'records', limit: 1 },
    }), 'the first page');
    assert.equal(first['returned'], 1);
    assert.equal(typeof first['next_cursor'], 'string');
    const cursor = String(first['next_cursor']);

    const revoked = command(s.fixture, ['agent', 'delegate-revoke', '--delegation', s.delegationId], {
      token: s.consumerToken,
    });
    assert.equal(revoked.status, 0, revoked.stderr);

    // The next page fails closed before the cursor is even consulted.
    const second = await callTool(url, s.delegatedReadToken, 'query_data_product', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      query: { kind: 'records', limit: 1, cursor },
    });
    assert.equal(second.status, 401, second.text);
    assert.equal(second.body['code'], 'MCP_DELEGATION_REVOKED');

    // An existing Report and one that never existed answer identically, so a
    // revoked caller learns nothing about what exists.
    const existing = await callTool(url, s.delegatedReadToken, 'read_report', {
      workspace_id: s.workspaceId,
      report_id: generatedReportId,
    });
    const missing = await callTool(url, s.delegatedReadToken, 'read_report', {
      workspace_id: s.workspaceId,
      report_id: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(existing.status, 401, existing.text);
    assert.equal(missing.status, 401, missing.text);
    assert.deepEqual(existing.body, missing.body, 'existence is never leaked');

    // A conversation opened before revocation cannot continue either.
    const continued = await callTool(url, s.delegatedNlqToken, 'continue_natural_language_query', {
      workspace_id: s.workspaceId,
      conversation: delegatedConversation,
      question: '2026-01-05 至 2026-01-20 各城市的处理量合计是多少？',
    });
    assert.equal(continued.status, 401, continued.text);
    assert.equal(continued.body['code'], 'MCP_DELEGATION_REVOKED');

    // Only the delegated authority ended: the Agent Identity's own token still works.
    const autonomous = payload(await callTool(url, s.readToken, 'query_data_product', {
      workspace_id: s.workspaceId,
      data_product_id: s.dataProductId,
      query: { kind: 'records', limit: 1 },
    }), 'the autonomous read after revocation');
    assert.deepEqual(autonomous['columns'], ['sn', 'city', 'handled_count', 'reported_on']);
  });
});
