import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { commandAsync } from '../support/async-command.js';
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
const STALE_AT = (generatedAt: string): string =>
  new Date(Date.parse(generatedAt) + 16 * 60_000).toISOString();

interface Surface extends WorkspaceFixture {
  dataProductId: string;
  endpoint: MockModelEndpoint;
  bindingId: string;
  templateId: string;
  reportId: string;
  report: Record<string, unknown>;
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

/** A governed product and one activated mock Model Profile bound for Reports. */
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
  return {
    ...base,
    dataProductId: base.dataProductId,
    endpoint,
    bindingId: String(bound.output['binding_id']),
    templateId: '',
    reportId: '',
    report: {},
  };
}

/** Publishes one Template and generates its first stock Report through the CLI. */
async function stockSurface(): Promise<Surface> {
  const surface = await readySurface();
  const published = command(
    surface.fixture,
    [
      'report', 'template-publish',
      '--workspace', surface.workspaceId,
      '--product', surface.dataProductId,
      '--name', '日处理量报告',
      '--config', jsonFile(surface.fixture, 'report-template', templateConfig()),
    ],
    { token: surface.workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const generated = await commandAsync(
    surface.fixture,
    ['report', 'generate', '--template', String(published.output['report_template_id'])],
    { token: surface.workspaceAdministratorToken },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const report = asRecord(generated.output['report']);
  return {
    ...surface,
    templateId: String(published.output['report_template_id']),
    reportId: String(report['report_id']),
    report,
  };
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

async function openReports(page: Page): Promise<void> {
  await page.getByRole('link', { name: '报告', exact: true }).click();
  await page.getByRole('heading', { name: '报告库', level: 1, exact: true }).waitFor();
}

async function openNlq(page: Page): Promise<void> {
  await page.getByRole('link', { name: '自然语言问答', exact: true }).click();
  await page.getByRole('heading', { name: '自然语言问答', level: 1, exact: true }).waitFor();
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

async function apiReportList(
  url: string,
  cookie: string,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  const listed = await callApi(url, `/api/workspace/reports?workspace_id=${encodeURIComponent(workspaceId)}`, { cookie });
  assert.equal(listed.status, 200, listed.text);
  return listed.body['reports'] as Array<Record<string, unknown>>;
}

test('a Workspace Administrator publishes a single-question Template in the browser and Consumers read its immutable Report', async (t) => {
  let browser: Browser | undefined;
  const surface = await readySurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ADMIN, ADMIN_PASSWORD, totpSecretFor(surface.fixture, ADMIN));
    await openReports(page);

    // The Template form states the question, typed parameters, normalized query,
    // grounded Chinese prompt, and freshness policy.
    const templates = page.getByRole('region', { name: '报告模板' });
    await templates.getByLabel('数据产品', { exact: true }).selectOption({ label: '设备维修台账' });
    await templates.getByLabel('模板名称', { exact: true }).fill('日处理量报告');
    await templates.getByLabel('业务问题', { exact: true }).fill(QUESTION);
    await templates.getByLabel('类型化参数（JSON）', { exact: true }).fill(JSON.stringify([
      { name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-20' } },
    ]));
    await templates.getByLabel('规范化查询（JSON）', { exact: true }).fill(JSON.stringify({
      kind: 'aggregate',
      metrics: ['handled_total'],
      window: { start: '2026-01-05', end: '2026-01-20' },
      include_totals: true,
      limit: 100,
    }));
    await templates.getByLabel('中文叙述提示', { exact: true }).fill(GROUNDED_ANSWER_PROMPT);
    await templates.getByLabel('新鲜度上限（分钟）', { exact: true }).fill('15');
    await templates.getByRole('button', { name: '发布模板', exact: true }).click();
    await templates.getByText(/已发布模板第 1 版/u).waitFor();

    // The published Template pins normalized semantics, typed parameters, the
    // grounded prompt, freshness, and the accountable Owner.
    await templates.getByText('展开模板详情').click();
    const templateText = await templates.innerText();
    assert.ok(templateText.includes('日处理量报告'), templateText);
    assert.ok(templateText.includes('2026-01-05 至 2026-01-20 的处理量合计是多少?'), 'the normalized question is pinned');
    assert.ok(templateText.includes('date_window'), 'the typed parameter is pinned');
    assert.ok(templateText.includes(GROUNDED_ANSWER_PROMPT), 'the grounded Chinese prompt is pinned');
    assert.ok(templateText.includes('15'), 'the freshness policy is pinned');
    assert.ok(templateText.includes(ADMIN), 'the Owner is the publishing administrator');
    assert.ok(templateText.includes('契约主版本'), 'the Template pins a Contract line');

    // Explicit generation stores the first stock Report.
    await templates.getByRole('button', { name: '生成入库报告', exact: true }).click();
    await templates.getByText(/已生成并入库报告/u).waitFor();
    const library = page.getByRole('region', { name: '已入库报告' });
    await library.getByRole('button', { name: '查看报告', exact: true }).click();
    const detail = page.getByRole('region', { name: '报告详情' });
    await detail.getByText('库存来源', { exact: false }).first().waitFor();

    // The Report preserves structured results, optional Chinese narrative, exact
    // Template and Release references, Provenance, freshness, and completion.
    const detailText = await detail.innerText();
    for (const copy of [
      '业务问题', '规范化问题', '解析说明', '类型化参数', '结构化结果',
      'handled_total', '中文叙述', '根据证据', '报告模板引用', '模板版本',
      '发布引用与新鲜度', '数据产品发布版本', '数据集版本', '契约版本',
      '数据截止', '完成状态', '完整', '已回答', '来源与证据', '当前授权',
      '工作区管理员', '新鲜',
    ]) {
      assert.ok(detailText.includes(copy), `the Report details omit ${copy}: ${detailText}`);
    }
    assert.ok(detailText.includes('10'), 'the deterministic governed total is preserved');

    // Reading generated no new Report and the page exposes no dashboard or
    // layout editor: Reports stay a governed read-only library.
    assert.equal(await page.getByText('布局编辑器', { exact: false }).count(), 0);
    assert.equal(await page.getByText('仪表板', { exact: false }).count(), 0);
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('an exact normalized Chinese question reuses stock with zero queries and zero model calls, and retrieval follows current authorization', async (t) => {
  let browser: Browser | undefined;
  const surface = await stockSurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  let consumerCookie = '';
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ANALYST, ANALYST_PASSWORD);
    await openNlq(page);
    consumerCookie = await cookieHeader(page.context());

    const queryAudits = audits(surface.fixture, 'data_product_query');
    const generationAudits = audits(surface.fixture, 'report_generation');
    const modelCalls = surface.endpoint.calls.length;
    const stocked = await apiReportList(consoleServer.url, consumerCookie, surface.workspaceId);
    assert.equal(stocked.length, 1);

    // Different whitespace and full-width digits still normalize to the exact
    // pinned business question, so the stored Report answers without any work.
    const workbench = page.getByRole('region', { name: '自然语言问答' });
    await workbench.getByLabel('问题', { exact: true }).fill('　２０２６-01-05 至 2026-01-20　的处理量合计是多少? ');
    await workbench.getByRole('button', { name: '提问', exact: true }).click();
    const answer = page.getByRole('region', { name: '受治理回答' });
    await answer.getByText('已回答', { exact: true }).first().waitFor();
    const answerText = await answer.innerText();
    assert.ok(answerText.includes('复用已入库报告'), answerText);
    assert.ok(answerText.includes(surface.reportId), 'the reused Report is named');
    assert.ok(answerText.includes('未重新执行查询'), 'the answer states the query did not run');

    assert.equal(audits(surface.fixture, 'data_product_query'), queryAudits, 'stock reuse executed no query');
    assert.equal(audits(surface.fixture, 'report_generation'), generationAudits, 'stock reuse generated no Report');
    assert.equal(surface.endpoint.calls.length, modelCalls, 'stock reuse invoked no model');
    assert.equal((await apiReportList(consoleServer.url, consumerCookie, surface.workspaceId)).length, 1);

    // The library reads the same immutable content without regenerating it.
    await openReports(page);
    const library = page.getByRole('region', { name: '已入库报告' });
    await library.getByRole('button', { name: '查看报告', exact: true }).click();
    const detail = page.getByRole('region', { name: '报告详情' });
    await detail.getByText('库存来源', { exact: false }).first().waitFor();
    const detailText = await detail.innerText();
    assert.ok(detailText.includes('10'), 'the stored deterministic result is shown');
    assert.ok(detailText.includes('消费方'), 'the current Consumer authorization is explicit');
    assert.equal(audits(surface.fixture, 'data_product_query'), queryAudits, 'library reads execute no query');
    assert.equal(surface.endpoint.calls.length, modelCalls, 'library reads invoke no model');

    // A Grant narrows the Consumer's authorization, so the unrestricted stock is
    // no longer discoverable and the library states that explicitly in Chinese.
    const grant = command(
      surface.fixture,
      [
        'grant', 'publish',
        '--product', surface.dataProductId,
        '--username', ANALYST,
        '--request', jsonFile(surface.fixture, 'report-grant', {
          columns: ['sn', 'handled_count', 'reported_on'],
          row_filters: [],
        }),
      ],
      { token: surface.workspaceAdministratorToken },
    );
    assert.equal(grant.status, 0, grant.stderr);
    await library.getByRole('button', { name: '刷新报告库', exact: true }).click();
    await library.getByText('当前工作区还没有已入库的报告。').waitFor();

    // The exact question now generates a Report under exactly the current Grants.
    await openNlq(page);
    await workbench.getByLabel('问题', { exact: true }).fill(QUESTION);
    await workbench.getByRole('button', { name: '提问', exact: true }).click();
    await answer.getByText('已回答', { exact: true }).first().waitFor();
    await openReports(page);
    await library.getByRole('button', { name: '查看报告', exact: true }).click();
    await detail.getByText('库存来源', { exact: false }).first().waitFor();
    const narrowedText = await detail.innerText();
    assert.ok(narrowedText.includes('受限授权'), narrowedText);
    assert.ok(narrowedText.includes('sn、handled_count、reported_on'), narrowedText);
    assert.ok(narrowedText.includes('消费方'), narrowedText);
    assert.equal(narrowedText.includes('settled_amount'), false, 'the Grant hides the settled column');

    // The unrestricted Report is not retrievable under the narrower Grant.
    const denied = await callApi(
      consoleServer.url,
      `/api/workspace/reports/${encodeURIComponent(surface.reportId)}?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie: consumerCookie },
    );
    assert.equal(denied.status, 404, denied.text);
    assert.equal(denied.body['code'], 'REPORT_NOT_AVAILABLE');

    // Withdrawing the Report leaves ordinary retrieval with an explicit Chinese
    // error state; the read still regenerates nothing.
    const narrowedReports = await apiReportList(consoleServer.url, consumerCookie, surface.workspaceId);
    assert.equal(narrowedReports.length, 1);
    const narrowedId = String(narrowedReports[0]!['report_id']);
    const withdrawn = command(
      surface.fixture,
      ['report', 'withdraw', '--report', narrowedId],
      { token: surface.workspaceAdministratorToken },
    );
    assert.equal(withdrawn.status, 0, withdrawn.stderr);
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByText('REPORT_WITHDRAWN', { exact: true }).waitFor();
    await page.getByText('该报告已撤回，不再参与普通检索；治理历史仍由管理员保留。').waitFor();

    // Another Workspace sees neither the navigation destination nor the content.
    createUser(surface.fixture, surface.deploymentAdministratorToken, OUTSIDER, OUTSIDER_PASSWORD);
    createWorkspace(surface.fixture, surface.deploymentAdministratorToken, '隔离区', OUTSIDER);
    const outsiderPage = await open(browser, consoleServer.url, '/app');
    await signIn(outsiderPage, OUTSIDER, OUTSIDER_PASSWORD, totpSecretFor(surface.fixture, OUTSIDER));
    await outsiderPage.goto(`${consoleServer.url}/app/w/${encodeURIComponent(surface.workspaceId)}/reports`);
    await outsiderPage.getByRole('heading', { name: '工作区不可用', exact: true }).waitFor();
    const outsider = await callApi(
      consoleServer.url,
      `/api/workspace/reports?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie: await cookieHeader(outsiderPage.context()) },
    );
    assert.equal(outsider.status, 403, outsider.text);
    assert.equal(outsider.body['code'], 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('stale stock refreshes, unmatched questions fall back to the Natural-Language Query path, and reading never regenerates content', async (t) => {
  let browser: Browser | undefined;
  const surface = await stockSurface();
  t.after(() => surface.endpoint.close());
  const consoleServer = await startConsole(surface.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, ANALYST, ANALYST_PASSWORD);
    await openReports(page);
    const cookie = await cookieHeader(page.context());

    const library = page.getByRole('region', { name: '已入库报告' });
    await library.getByRole('button', { name: '查看报告', exact: true }).click();
    const detail = page.getByRole('region', { name: '报告详情' });
    await detail.getByText('库存来源', { exact: false }).first().waitFor();
    const originalText = await detail.innerText();

    // Sixteen minutes after generation the 15-minute policy is exceeded, so the
    // exact question generates and stores a new Report and names the superseded one.
    const queryAudits = audits(surface.fixture, 'data_product_query');
    const answer = await callApi(consoleServer.url, `/api/workspace/nlq?workspace_id=${encodeURIComponent(surface.workspaceId)}`, {
      cookie,
      body: { question: QUESTION, at: STALE_AT(String(surface.report['generated_at'])) },
    });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body['origin'], 'generated', answer.text);
    assert.equal(answer.body['executed'], true);
    assert.equal(asRecord(answer.body['refresh'])['reason'], 'stale');
    assert.equal(asRecord(answer.body['refresh'])['superseded_report_id'], surface.reportId);
    assert.notEqual(asRecord(answer.body['report'])['report_id'], surface.reportId);
    assert.equal(audits(surface.fixture, 'data_product_query'), queryAudits + 1, 'the stale refresh ran one query');

    // The library lists both Reports, marks the expired one, and reading the old
    // Report returns exactly the preserved content without regenerating anything.
    await library.getByRole('button', { name: '刷新报告库', exact: true }).click();
    await page.getByRole('button', { name: '查看报告', exact: true }).first().waitFor();
    const entries = await apiReportList(consoleServer.url, cookie, surface.workspaceId);
    assert.equal(entries.length, 2);
    const oldEntry = entries.find((entry) => entry['report_id'] === surface.reportId);
    assert.ok(oldEntry, 'the superseded Report remains in the library');
    assert.equal(oldEntry['question'], QUESTION, 'the preserved question stays unchanged');
    const reads = audits(surface.fixture, 'report_retrieval');
    const generations = audits(surface.fixture, 'report_generation');
    const oldRead = await callApi(
      consoleServer.url,
      `/api/workspace/reports/${encodeURIComponent(surface.reportId)}?workspace_id=${encodeURIComponent(surface.workspaceId)}`,
      { cookie },
    );
    assert.equal(oldRead.status, 200, oldRead.text);
    assert.deepEqual(oldRead.body['report'], surface.report, 'retrieval preserves every governed fact');
    assert.equal(oldRead.body['origin'], 'stock');
    assert.equal(audits(surface.fixture, 'report_retrieval'), reads + 1);
    assert.equal(audits(surface.fixture, 'report_generation'), generations, 'retrieval never regenerates content');
    assert.ok(originalText.includes('10'));

    await page.getByRole('button', { name: '查看报告', exact: true }).first().click();
    await detail.getByText('库存来源', { exact: false }).first().waitFor();
    assert.equal(audits(surface.fixture, 'report_generation'), generations);

    // A near-match with another period is not stock; it takes the ordinary
    // Natural-Language Query path and stores no new stock Report.
    await openNlq(page);
    const workbench = page.getByRole('region', { name: '自然语言问答' });
    await workbench.getByLabel('问题', { exact: true }).fill('2026-01-10 至 2026-01-20 的处理量合计是多少？');
    await workbench.getByRole('button', { name: '提问', exact: true }).click();
    const nlqAnswer = page.getByRole('region', { name: '受治理回答' });
    await nlqAnswer.getByText('已回答', { exact: true }).first().waitFor();
    assert.equal(await nlqAnswer.getByText('复用已入库报告', { exact: false }).count(), 0, 'a near-match reuses no stock');
    const fallback = await callApi(consoleServer.url, `/api/workspace/nlq?workspace_id=${encodeURIComponent(surface.workspaceId)}`, {
      cookie,
      body: { question: '2026-01-10 至 2026-01-20 的处理量合计是多少？' },
    });
    assert.equal(fallback.status, 200, fallback.text);
    assert.equal(fallback.body['origin'], 'generated');
    assert.equal(fallback.body['report'], null, 'the fallback answer is not a stocked Report');
    assert.equal(fallback.body['template'], null);
    assert.equal(fallback.body['executed'], true);
    assert.ok(asRecord(fallback.body['result']), 'the ordinary Natural-Language Query answered');
    assert.equal((await apiReportList(consoleServer.url, cookie, surface.workspaceId)).length, 2, 'the fallback stored no stock');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});
