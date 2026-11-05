import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import { callApi, startConsole } from '../support/console.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  publishLedgerProduct,
} from '../support/data-product.js';
import {
  MOCK_MODEL_ID,
  startMockModelEndpoint,
  type MockModelEndpoint,
} from '../support/model-endpoint.js';
import {
  command,
  createUser,
  createWorkspace,
  grantRole,
  jsonFile,
  totpSecretFor,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const ADMIN = 'operations@example.invalid';
const ADMIN_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const OUTSIDER = 'outsider@example.invalid';
const OUTSIDER_PASSWORD = 'outsider-consumer';

const PURPOSES = ['query_plan', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['product_contract', 'sample_records'];
const PROMPTS = {
  query_plan: '你是数据产品查询规划器，只输出简体中文解释，并且只使用受治理契约发布的字段、维度、指标和算子。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据或因果。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};
const GROUNDED_ANSWER_PROMPT = '只依据给定证据用简体中文撰写报告叙述，不得推测证据之外的数据或因果。';
const QUESTION = '2026-01-05 至 2026-01-20 的处理量合计是多少？';
/** A question the published stock does not answer, so it enters review. */
const CANDIDATE_QUESTION = '2026-01-06 至 2026-01-20 的处理量合计是多少？';
/** The same business question as CANDIDATE_QUESTION, worded differently. */
const PARAPHRASE_QUESTION = '请查询 2026-01-06 到 2026-01-20 的处理量总计';

interface Surface extends WorkspaceFixture {
  dataProductId: string;
  endpoint: MockModelEndpoint;
  templateId: string;
  templateVersion: number;
  reportId: string;
  report: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), 'expected an array');
  return value.filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry));
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

function templateConfig(question: string, window: { start: string; end: string }): Record<string, unknown> {
  return {
    question,
    parameters: [{ name: 'period', type: 'date_window', value: window }],
    query: {
      kind: 'aggregate',
      metrics: ['handled_total'],
      window: { ...window },
      include_totals: true,
      limit: 100,
    },
    grounded_prompt: GROUNDED_ANSWER_PROMPT,
    freshness: { max_age_minutes: 15 },
  };
}

/**
 * One Workspace holding a published ledger, one activated mock Model Profile
 * bound for planning, narration, and clarification, and one published Template
 * whose first Report is already stocked.
 */
async function readySurface(): Promise<Surface> {
  const base = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  const endpoint = await startMockModelEndpoint();
  const published = command(
    base.fixture,
    ['model', 'publish', '--name', '报告模型', '--config', jsonFile(base.fixture, 'report-profile', profileConfig(endpoint))],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const profileId = String(published.output['model_profile_id']);
  const version = Number(published.output['model_profile_version']);
  const evaluated = await commandAsync(
    base.fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(
    base.fixture,
    ['model', 'activate', '--profile', profileId, '--version', String(version)],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    base.fixture,
    [
      'binding', 'publish',
      '--workspace', base.workspaceId,
      '--profile', profileId,
      '--config', jsonFile(base.fixture, 'report-binding', {
        model_profile_version: version,
        purposes: [...PURPOSES],
        data_categories: [...DATA_CATEGORIES],
      }),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const template = command(
    base.fixture,
    [
      'report', 'template-publish',
      '--workspace', base.workspaceId,
      '--product', base.dataProductId,
      '--name', '日处理量报告',
      '--config', jsonFile(base.fixture, 'report-template', templateConfig(QUESTION, { start: '2026-01-05', end: '2026-01-20' })),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(template.status, 0, template.stderr);
  const templateId = String(template.output['report_template_id']);
  const generated = await commandAsync(
    base.fixture,
    ['report', 'generate', '--template', templateId],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const report = asRecord(generated.output['report']);
  return {
    ...base,
    dataProductId: base.dataProductId,
    endpoint,
    templateId,
    templateVersion: Number(template.output['template_version']),
    reportId: String(report['report_id']),
    report,
  };
}

/**
 * Asks one unmatched Chinese question through the governed Consumer CLI. The
 * deterministic model endpoint lives in this process, so the ask runs async.
 */
function ask(surface: Surface, question: string): Promise<CommandResult> {
  return commandAsync(
    surface.fixture,
    ['product', 'ask', '--product', surface.dataProductId, '--question', question],
    { token: surface.consumerToken },
  ).then((result) => {
    assert.equal(result.status, 0, result.stderr);
    return result;
  });
}

function audits(fixture: PlatformFixture, action: string): number {
  const lines = readFileSync(join(fixture.root, 'audit', 'events.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['action'] === action)
    .length;
}

async function signIn(page: Page, username: string, password: string, totp: string | null = null): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  if (totp !== null) await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(totp));
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function open(browser: Browser, url: string, path: string): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${url}${path}`);
  return page;
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function openGovernance(page: Page): Promise<void> {
  await page.getByRole('link', { name: '报告治理', exact: true }).click();
  await page.getByRole('heading', { name: '报告治理', level: 1, exact: true }).waitFor();
}

/** The exact candidate list one administrator answer returned. */
async function candidateList(url: string, cookie: string, workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const listed = await callApi(url, `/api/workspace/report-candidates?workspace_id=${encodeURIComponent(workspaceId)}`, { cookie });
  assert.equal(listed.status, 200, listed.text);
  return records(listed.body['candidates']);
}

test('a Workspace Administrator reviews one deduplicated candidate, sees similarity nominations, and approves the exact reviewed content without regeneration', async (t) => {
  let browser: Browser | undefined;
  const surface = await readySurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  try {
    // Two arrivals of the same Chinese semantics, the second with different
    // whitespace, share one open review item.
    const first = await ask(surface, CANDIDATE_QUESTION);
    const second = await ask(surface, '　2026-01-06 至 2026-01-20　的处理量合计是多少? ');
    assert.equal(first.output['origin'], 'generated');
    assert.equal(asRecord(first.output['candidate'])['status'], 'open');
    assert.equal(
      asRecord(second.output['candidate'])['candidate_id'],
      asRecord(first.output['candidate'])['candidate_id'],
      'the repeated semantics join the same item',
    );
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 1);

    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ADMIN, ADMIN_PASSWORD, totpSecretFor(surface.fixture, ADMIN));
    await openGovernance(page);
    const cookie = await cookieHeader(page.context());

    const panel = page.getByRole('region', { name: '报告候选' });
    await panel.getByText(CANDIDATE_QUESTION).first().waitFor();
    const listed = await candidateList(consoleServer.url, cookie, surface.workspaceId);
    assert.equal(listed.length, 1, 'one deduplicated review item');
    const candidate = listed[0]!;
    assert.equal(candidate['occurrences'], 2, 'both arrivals share the one item');

    // The item states its dedup count, its notification, and that a similarity
    // nomination is never an equivalence or an authorization.
    const listText = await panel.innerText();
    for (const copy of [
      '待审核', '出现次数 2', ANALYST, '审核通知', '相同语义未重复通知。',
      '相似度建议', 'Qwen3-Embedding-0.6B', '0.4',
      '相似度建议只提示可能相关的已发布问题或候选，不代表业务等价',
      '批准会原样发布审阅时的模板版本与报告，不会重新执行查询，也不会重新生成内容。',
    ]) {
      assert.ok(listText.includes(copy), `the candidate panel omits ${copy}: ${listText}`);
    }
    assert.ok(listText.includes(QUESTION), 'the stocked Template question is nominated as similar');

    // The reviewer opens the exact reviewed Template Version and Report.
    await panel.getByRole('button', { name: '查看候选证据', exact: true }).click();
    const evidence = page.getByRole('region', { name: '候选证据' });
    await evidence.getByText(String(candidate['report_id']), { exact: true }).waitFor();
    const evidenceText = await evidence.innerText();
    for (const copy of [
      '模板版本', '模板内容哈希', '业务问题', '规范化问题',
      '结构化结果合计', 'handled_total：7', '中文叙述', '模板状态', '报告状态', '有效',
    ]) {
      assert.ok(evidenceText.includes(copy), `the candidate evidence omits ${copy}: ${evidenceText}`);
    }

    // Approval publishes that exact content: no query, no Report, no model call.
    const queries = audits(surface.fixture, 'data_product_query');
    const generations = audits(surface.fixture, 'report_generation');
    const modelCalls = surface.endpoint.calls.length;
    await panel.getByRole('button', { name: '批准候选', exact: true }).click();
    await panel.getByText('已批准候选：审阅时的模板版本与报告原样发布，未重新执行查询，也未重新生成内容。').waitFor();
    assert.equal(audits(surface.fixture, 'data_product_query'), queries, 'Approval reran no query');
    assert.equal(audits(surface.fixture, 'report_generation'), generations, 'Approval generated no Report');
    assert.equal(surface.endpoint.calls.length, modelCalls, 'Approval invoked no model');
    await panel.getByText('已批准', { exact: true }).first().waitFor();
    const approved = (await candidateList(consoleServer.url, cookie, surface.workspaceId))[0]!;
    assert.equal(approved['status'], 'approved');
    assert.equal(approved['report_id'], candidate['report_id'], 'the exact reviewed Report is published');
    const evidenceAfter = await evidence.innerText();
    assert.ok(evidenceAfter.includes(String(candidate['report_id'])), 'the reviewed Report identity is unchanged');
    assert.ok(evidenceAfter.includes('handled_total：7'), 'the reviewed governed number is unchanged');

    // The published Template now answers the exact question from stock without
    // executing anything, and no similarity score ever granted reuse on its own.
    const asked = await ask(surface, CANDIDATE_QUESTION);
    assert.equal(asked.output['origin'], 'stock', JSON.stringify(asked.output));
    assert.equal(asRecord(asked.output['stock'])['report_id'], candidate['report_id']);
    assert.equal(audits(surface.fixture, 'data_product_query'), queries, 'stock reuse ran no query');
    assert.equal(surface.endpoint.calls.length, modelCalls, 'stock reuse invoked no model');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('rejection suppresses identical notifications until the reviewer reopens the item', async (t) => {
  let browser: Browser | undefined;
  const surface = await readySurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  try {
    await ask(surface, CANDIDATE_QUESTION);
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 1);

    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ADMIN, ADMIN_PASSWORD, totpSecretFor(surface.fixture, ADMIN));
    await openGovernance(page);
    const cookie = await cookieHeader(page.context());
    const panel = page.getByRole('region', { name: '报告候选' });
    await panel.getByText(CANDIDATE_QUESTION).first().waitFor();

    // Rejection records the reviewer's Chinese reason and sends no second notice.
    await panel.getByLabel('拒绝原因', { exact: true }).fill('该问题与已发布模板语义不一致');
    await panel.getByRole('button', { name: '拒绝候选', exact: true }).click();
    await panel.getByText('已拒绝候选：相同语义不再重复通知，重新开启或语义变化后才会再次进入审核。').waitFor();
    await panel.getByText('已拒绝', { exact: true }).first().waitFor();
    assert.ok((await panel.innerText()).includes('该问题与已发布模板语义不一致'));
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 1);

    // Identical semantics join the rejected item without any new notification.
    await ask(surface, CANDIDATE_QUESTION);
    await panel.getByRole('button', { name: '刷新治理视图', exact: true }).click();
    await panel.getByText('出现次数 2', { exact: true }).first().waitFor();
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 1, 'rejection suppresses identical notifications');
    const suppressedText = await panel.innerText();
    assert.ok(suppressedText.includes('相同语义未重复通知。'));

    // A semantic change is a separate item and notifies once more; the rejected
    // item itself stays rejected rather than being silently approved.
    await ask(surface, PARAPHRASE_QUESTION);
    await panel.getByRole('button', { name: '刷新治理视图', exact: true }).click();
    await panel.getByText(PARAPHRASE_QUESTION).first().waitFor();
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 2);
    assert.equal((await candidateList(consoleServer.url, cookie, surface.workspaceId)).length, 2);

    // Reopening notifies exactly once and returns the item to review.
    await panel.getByRole('button', { name: '重新开启候选', exact: true }).first().click();
    await panel.getByText('已重新开启候选审核，相同语义将重新进入审核通知。').waitFor();
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 3);
    await panel.getByText('待审核', { exact: true }).first().waitFor();
    await ask(surface, CANDIDATE_QUESTION);
    assert.equal(audits(surface.fixture, 'report_candidate_notification'), 3, 'the reopened item never notifies twice for one semantic');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('a secure schedule revalidates its designated Consumer, pauses and resumes, and shows durable background activity', async (t) => {
  let browser: Browser | undefined;
  const surface = await readySurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ADMIN, ADMIN_PASSWORD, totpSecretFor(surface.fixture, ADMIN));
    await openGovernance(page);
    const cookie = await cookieHeader(page.context());
    const panel = page.getByRole('region', { name: '报告计划' });
    const emptyText = await panel.innerText();
    for (const copy of ['当前工作区还没有报告计划。', '计划只在显式的到期检查时评估']) {
      assert.ok(emptyText.includes(copy), `the schedule panel omits ${copy}: ${emptyText}`);
    }

    // A schedule due ninety minutes ago with a sixty-minute interval covers two
    // instants, so one evaluation is a catch-up rather than a run per instant.
    const start = new Date(Date.now() - 90 * 60_000).toISOString();
    await panel.getByLabel('报告模板', { exact: true }).selectOption({ label: '日处理量报告' });
    await panel.getByLabel('指定消费者账号', { exact: true }).fill(ANALYST);
    await panel.getByLabel('间隔（分钟）', { exact: true }).fill('60');
    await panel.getByLabel('开始时刻（ISO 8601，留空立即开始）', { exact: true }).fill(start);
    await panel.getByRole('button', { name: '创建报告计划', exact: true }).click();
    await panel.getByText('已按指定消费者创建报告计划：每次到期都会重新校验该消费者与授权后再生成。').waitFor();
    await panel.getByText('60 分钟', { exact: false }).first().waitFor();
    const createdText = await panel.innerText();
    for (const copy of ['日处理量报告', ANALYST, '60 分钟', '运行中', '下次到期']) {
      assert.ok(createdText.includes(copy), `the created schedule omits ${copy}: ${createdText}`);
    }

    // Pausing is a lifecycle fact: the due instant is not consumed and the tick
    // skips the schedule without executing any query.
    const reportsBefore = records((await callApi(
      consoleServer.url,
      `/api/workspace/reports?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie },
    )).body['reports']).length;
    const queries = audits(surface.fixture, 'data_product_query');
    await panel.getByRole('button', { name: '暂停计划', exact: true }).click();
    await panel.getByText('已暂停该报告计划：到期检查将跳过它，已生成的报告与运行历史完整保留。').waitFor();
    await panel.getByText('已暂停', { exact: true }).first().waitFor();
    await panel.getByRole('button', { name: '执行到期检查', exact: true }).click();
    await panel.getByText('本次调度检查跳过了 1 个已暂停的报告计划。').first().waitFor();
    assert.equal(audits(surface.fixture, 'data_product_query'), queries, 'a paused schedule executes no query');
    const afterPause = records((await callApi(
      consoleServer.url,
      `/api/workspace/reports?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie },
    )).body['reports']).length;
    assert.equal(afterPause, reportsBefore, 'a paused schedule stores no Report');

    // The paused schedule is durable background attention, not browser state.
    const activity = page.getByRole('complementary', { name: '活动中心' });
    await activity.getByRole('button', { name: '刷新活动', exact: true }).click();
    await activity.getByRole('region', { name: '需要处理' }).getByText('已暂停', { exact: true }).first().waitFor();

    // Resuming produces exactly one catch-up run that reuses unchanged fresh stock.
    await panel.getByRole('button', { name: '恢复计划', exact: true }).click();
    await panel.getByText('已恢复该报告计划：下一次到期检查会重新校验指定消费者，错过的到期最多补跑一次。').waitFor();
    await panel.getByRole('button', { name: '执行到期检查', exact: true }).click();
    await panel.getByText(/本次调度检查执行了 1 个到期计划/u).first().waitFor();
    const scheduleItem = panel.getByRole('listitem').first();
    await scheduleItem.getByText('已复用库存', { exact: true }).waitFor();
    const runText = await scheduleItem.innerText();
    assert.ok(runText.includes('是'), `the run states it caught up: ${runText}`);
    assert.ok(runText.includes('2'), `the run coalesced both due instants: ${runText}`);
    assert.equal(audits(surface.fixture, 'data_product_query'), queries, 'unchanged inputs reuse stock without a query');

    // Activity now names the durable scheduled run beside its report.
    await activity.getByRole('button', { name: '刷新活动', exact: true }).click();
    await activity.getByRole('region', { name: '后台活动' }).getByText('已复用库存', { exact: true }).first().waitFor();

    // Revoking the designated Consumer's membership fails the next due run closed.
    // A second schedule is created while she is still a member, then the next tick
    // revalidates her current state rather than the authorization it began with.
    const secondStart = new Date(Date.now() - 2 * 60_000).toISOString();
    await panel.getByLabel('报告模板', { exact: true }).selectOption({ label: '日处理量报告' });
    await panel.getByLabel('指定消费者账号', { exact: true }).fill(ANALYST);
    await panel.getByLabel('间隔（分钟）', { exact: true }).fill('1');
    await panel.getByLabel('开始时刻（ISO 8601，留空立即开始）', { exact: true }).fill(secondStart);
    await panel.getByRole('button', { name: '创建报告计划', exact: true }).click();
    const second = panel.getByRole('listitem').nth(1);
    await second.getByText(ANALYST, { exact: false }).first().waitFor();
    const revoked = command(
      surface.fixture,
      ['membership', 'revoke', '--workspace', surface.workspaceId, '--username', ANALYST],
      { token: surface.workspaceAdministratorToken },
    );
    assert.equal(revoked.status, 0, revoked.stderr);
    await panel.getByRole('button', { name: '执行到期检查', exact: true }).click();
    await panel.getByText(/本次调度检查执行了 1 个到期计划/u).first().waitFor();
    await second.getByText('未生成', { exact: true }).waitFor();
    const failedText = await second.innerText();
    assert.ok(failedText.includes('指定消费者已不是该工作空间成员，本次调度未执行查询。'), failedText);
    assert.equal(audits(surface.fixture, 'data_product_query'), queries, 'a revoked Consumer executes no query');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('Report and Template Withdrawal stop ordinary reuse while preserving governed history', async (t) => {
  let browser: Browser | undefined;
  const surface = await readySurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  let consumerPage: Page | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ADMIN, ADMIN_PASSWORD, totpSecretFor(surface.fixture, ADMIN));
    await openGovernance(page);
    const cookie = await cookieHeader(page.context());
    const panel = page.getByRole('region', { name: '撤回报告与模板' });
    await panel.getByText(QUESTION).first().waitFor();

    // Withdrawing the Report leaves stock and ordinary retrieval.
    await panel.getByRole('button', { name: '撤回该报告', exact: true }).click();
    await panel.getByText('已撤回该报告：它不再参与库存复用和普通检索，治理历史与来源信息完整保留。').waitFor();
    assert.equal(audits(surface.fixture, 'report_withdrawal'), 1);
    const historyText = await panel.innerText();
    assert.ok(historyText.includes('已撤回'), 'the administrator still sees the governed history');
    assert.ok(historyText.includes(surface.reportId), 'the withdrawn Report identity is preserved');

    consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, ANALYST, ANALYST_PASSWORD);
    await consumerPage.getByRole('link', { name: '报告', exact: true }).click();
    await consumerPage.getByText('当前工作区还没有已入库的报告。').waitFor();

    // The exact question no longer reuses the withdrawn Report; the still
    // published Template generates a fresh, separately stored one.
    const refreshed = await ask(surface, QUESTION);
    assert.equal(refreshed.output['origin'], 'generated', JSON.stringify(refreshed.output));
    assert.equal(refreshed.output['stock'], null, 'a withdrawn Report is never offered as stock');

    // Withdrawing the published Template Version stops matching and generation.
    await page.getByRole('button', { name: '撤回已发布模板版本', exact: true }).click();
    await panel.getByText('已撤回该模板版本：它不再匹配库存或生成新报告，已生成的报告仍按治理历史保留。').waitFor();
    assert.equal(audits(surface.fixture, 'report_template_withdrawal'), 1);
    const generate = await commandAsync(
      surface.fixture,
      ['report', 'generate', '--template', surface.templateId],
      { token: surface.workspaceAdministratorToken },
    );
    assert.equal(generate.status, 2);
    assert.equal(generate.error['code'], 'REPORT_TEMPLATE_WITHDRAWN');
    const unmatched = await ask(surface, QUESTION);
    assert.equal(unmatched.output['origin'], 'generated');
    assert.equal(unmatched.output['template'], null, 'a withdrawn Template never matches');

    // The original Report is still exactly readable as governed history.
    const history = command(
      surface.fixture,
      ['report', 'show', '--report', surface.reportId],
      { token: surface.workspaceAdministratorToken },
    );
    assert.equal(history.status, 0, history.stderr);
    assert.equal(history.output['withdrawn'], true);
    assert.deepEqual(asRecord(history.output['report'])['result'], surface.report['result'], 'Withdrawal erases no governed result');
    const listed = await callApi(
      consoleServer.url,
      `/api/workspace/reports?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie },
    );
    const stored = records(listed.body['reports']).find((entry) => entry['report_id'] === surface.reportId);
    assert.ok(stored, 'the withdrawn Report remains in the governed history');
    assert.notEqual(stored['withdrawn_at'], null);
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('report governance is server-side authorized and its empty states are written in Chinese', async (t) => {
  let browser: Browser | undefined;
  const surface = await readySurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  try {
    await ask(surface, CANDIDATE_QUESTION);
    const operations = await callApi(
      consoleServer.url,
      '/api/workspace/report-candidates',
      { },
    );
    assert.equal(operations.status, 401, 'no session never reads candidates');

    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ADMIN, ADMIN_PASSWORD, totpSecretFor(surface.fixture, ADMIN));
    await openGovernance(page);
    const adminCookie = await cookieHeader(page.context());
    const candidates = await candidateList(consoleServer.url, adminCookie, surface.workspaceId);
    assert.equal(candidates.length, 1);
    const candidateId = String(candidates[0]!['candidate_id']);

    // An outsider administers an independent Workspace, so every Operations
    // object reads exactly like one that does not exist.
    createUser(surface.fixture, surface.deploymentAdministratorToken, OUTSIDER, OUTSIDER_PASSWORD);
    const outsiderWorkspace = createWorkspace(
      surface.fixture,
      surface.deploymentAdministratorToken,
      '隔离区',
      OUTSIDER,
    );
    const outsiderPage = await open(browser, consoleServer.url, '/app');
    await signIn(outsiderPage, OUTSIDER, OUTSIDER_PASSWORD, totpSecretFor(surface.fixture, OUTSIDER));

    // Its own governance page is empty, in Chinese, and issues no existence leak.
    await outsiderPage.goto(`${consoleServer.url}/app/w/${encodeURIComponent(outsiderWorkspace)}/report-governance`);
    await outsiderPage.getByRole('heading', { name: '报告治理', level: 1, exact: true }).waitFor();
    await outsiderPage.getByText('当前工作区还没有报告候选。').waitFor();
    await outsiderPage.getByText('当前工作区还没有报告计划。').waitFor();
    await outsiderPage.getByText('当前工作区还没有报告。').waitFor();
    await outsiderPage.getByText('当前工作区还没有报告模板。').waitFor();
    // Read the cookie only after the signed-in surface proves the session landed.
    const outsiderCookie = await cookieHeader(outsiderPage.context());

    // Substituting the foreign candidate id fails closed without any leak.
    const substituted = await callApi(
      consoleServer.url,
      `/api/workspace/report-candidates/${encodeURIComponent(candidateId)}/approve`,
      { cookie: outsiderCookie, method: 'POST' },
    );
    assert.equal(substituted.status, 403, substituted.text);
    assert.equal(substituted.body['code'], 'WORKSPACE_ACCESS_DENIED');
    const foreign = await callApi(
      consoleServer.url,
      `/api/workspace/report-candidates?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie: outsiderCookie },
    );
    assert.equal(foreign.status, 403, foreign.text);
    const foreignSchedule = await callApi(
      consoleServer.url,
      '/api/workspace/report-schedules/00000000-0000-4000-8000-000000000000/pause',
      { cookie: outsiderCookie, method: 'POST' },
    );
    assert.equal(foreignSchedule.status, 404, foreignSchedule.text);
    assert.equal(foreignSchedule.body['code'], 'REPORT_SCHEDULE_NOT_AVAILABLE');

    // A Consumer has no governance navigation and no deep link either.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, ANALYST, ANALYST_PASSWORD);
    await consumerPage.getByRole('link', { name: '报告', exact: true }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '报告治理', exact: true }).count(), 0);
    const consumerCookie = await cookieHeader(consumerPage.context());
    const denied = await callApi(
      consoleServer.url,
      `/api/workspace/report-candidates?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie: consumerCookie },
    );
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.body['code'], 'WORKSPACE_ACCESS_DENIED');
    await consumerPage.goto(`${consoleServer.url}/app/w/${encodeURIComponent(surface.workspaceId)}/report-governance`);
    await consumerPage.getByRole('heading', { name: '工作区不可用', exact: true }).waitFor();
    assert.equal(await consumerPage.getByText(CANDIDATE_QUESTION).count(), 0, 'the deep link leaks no candidate content');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});
