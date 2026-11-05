import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { commandAsync } from '../support/async-command.js';
import { callApi, startConsole } from '../support/console.js';
import { startHttpSource, type HttpSource } from '../support/http-source.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from '../support/model-endpoint.js';
import {
  command,
  createUser,
  grantRole,
  initializePlatform,
  jsonFile,
  registerTotp,
  sessionFor,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

type Config = Record<string, unknown>;

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const CREDENTIAL = 'report-token-7f3c';
const CREDENTIAL_REF = '报表账号';

/** One record-bearing page: the exact markup the first Task Version pins. */
const BASE_PAGE = [
  '<html><body><table>',
  '<tr class="record"><td class="sn">dev-1</td><td class="city">杭州</td><td class="count">12</td></tr>',
  '<tr class="record"><td class="sn">dev-2</td><td class="city">上海</td><td class="count">3</td></tr>',
  '</table></body></html>',
].join('');

/** The next page proves exhaustion; a scraper never guesses that the end was reached. */
const EMPTY_PAGE = '<html><body><table></table></body></html>';

const TABLE_RECORDS = [
  { sn: 'dev-1', city: '杭州', handled_count: '12' },
  { sn: 'dev-2', city: '上海', handled_count: '3' },
];

const INTEGRATION: Config = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
  ],
  cleaning: [],
  mapping: { sn: 'sn', city: 'city', handled_count: 'handled_count' },
};

interface Credentials {
  username: string;
  password: string;
  totp: string;
}

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  workspaceToken: string;
  operations: Credentials;
  analyst: Credentials;
  sourceId: string;
}

interface FixturePage {
  name: string;
  path: string;
  body: string;
  expectedCount: number;
  expectedRecords?: Array<Record<string, string>>;
}

interface StateFile {
  artifact_proposals: Config[];
  scraper_tasks: Config[];
  scraper_services: Config[];
  source_scraper_services: Config[];
  scraper_credentials: Config[];
  scraper_runs: Config[];
  scraper_diagnostics: Config[];
  raw_acquisitions: unknown[];
  acquisition_runs: unknown[];
  integration_batches: unknown[];
  datasets: Config[];
}

function asRecord(value: unknown): Config {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Config;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

function stateOf(current: World): StateFile {
  return JSON.parse(readFileSync(join(current.fixture.root, 'state', 'platform.json'), 'utf8')) as StateFile;
}

/** One Deployment, one Workspace, one scraper Source with a pin-ready credential. */
function world(): World {
  const fixture = initializePlatform();
  const deploymentToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  const created = createUser(fixture, deploymentToken, OPERATIONS, OPERATIONS_PASSWORD);
  assert.equal(created.status, 0, created.stderr);
  const workspace = command(
    fixture,
    ['workspace', 'create', '--name', '运营中心', '--administrator', OPERATIONS],
    { token: deploymentToken },
  );
  assert.equal(workspace.status, 0, workspace.stderr);
  const workspaceId = String(workspace.output['workspace_id']);
  const totp = String(workspace.output['totp_secret']);
  registerTotp(fixture, OPERATIONS, totp);
  const analyst = createUser(fixture, deploymentToken, ANALYST, ANALYST_PASSWORD);
  assert.equal(analyst.status, 0, analyst.stderr);
  const workspaceToken = sessionFor(fixture, OPERATIONS, OPERATIONS_PASSWORD);
  grantRole(fixture, workspaceToken, workspaceId, ANALYST, 'Consumer');

  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备处理量报表', '--type', 'scraper'],
    { token: workspaceToken },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output['source_id']);

  const credential = command(
    fixture,
    [
      'scraper', 'credential', '--workspace', workspaceId, '--name', CREDENTIAL_REF,
      '--location', 'bearer', '--credential-stdin',
    ],
    { token: workspaceToken, input: `${CREDENTIAL}\n` },
  );
  assert.equal(credential.status, 0, credential.stderr);

  return {
    fixture,
    workspaceId,
    workspaceToken,
    operations: { username: OPERATIONS, password: OPERATIONS_PASSWORD, totp },
    analyst: { username: ANALYST, password: ANALYST_PASSWORD, totp: '' },
    sourceId,
  };
}

/** The Integration Configuration repeated Runs integrate their acquired rows under. */
function adoptIntegration(current: World): void {
  const published = command(
    current.fixture,
    ['integration', 'publish', '--source', current.sourceId, '--config', jsonFile(current.fixture, 'scraper-integration', INTEGRATION)],
    { token: current.workspaceToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const adopted = command(
    current.fixture,
    [
      'integration', 'adopt', '--source', current.sourceId,
      '--version', String(published.output['integration_configuration_version']),
    ],
    { token: current.workspaceToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
}

async function open(browser: Browser, url: string, path: string): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${url}${path}`);
  return page;
}

async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  if (credentials.totp !== '') {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(credentials.totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * Fills the guided Scraper Task form and publishes one immutable Task Version.
 * Every fact the acceptance criteria name is stated here explicitly.
 */
async function publishTask(
  page: Page,
  current: World,
  name: string,
  target: HttpSource,
  fixtures: FixturePage[],
): Promise<void> {
  const form = page.getByRole('region', { name: '发布抓取任务版本', exact: true });
  await form.getByLabel('任务名称', { exact: true }).fill(name);
  await form.getByLabel('目标站点地址', { exact: true }).fill(target.url);
  await form.getByLabel('目标路径模板', { exact: true }).fill('/reports/{month}');
  await form.getByLabel('分页参数名', { exact: true }).fill('page');
  await form.getByLabel('起始页码', { exact: true }).fill('1');
  await form.getByLabel('最多页数', { exact: true }).fill('3');
  await form.getByLabel('批准的网络来源', { exact: true }).fill(target.url);
  await form.getByLabel('批准的网络路径前缀', { exact: true }).fill('/reports');
  await form.getByLabel('记录选择器', { exact: true }).fill('tr.record');

  // Three output columns, pinned by name and selector.
  const fields: Array<[string, string]> = [
    ['sn', 'td.sn'],
    ['city', 'td.city'],
    ['handled_count', 'td.count'],
  ];
  for (let index = 0; index < fields.length; index += 1) {
    if (index > 0) await form.getByRole('button', { name: '添加输出字段' }).click();
    const [fieldName, selector] = fields[index]!;
    await form.getByLabel(`输出字段名 ${String(index + 1)}`, { exact: true }).fill(fieldName);
    await form.getByLabel(`输出选择器 ${String(index + 1)}`, { exact: true }).fill(selector);
  }

  // Two declared run parameters: one optional default, one required.
  await form.getByRole('button', { name: '添加运行参数' }).click();
  await form.getByRole('button', { name: '添加运行参数' }).click();
  await form.getByLabel('参数名 1', { exact: true }).fill('month');
  await form.getByLabel('默认值 1', { exact: true }).fill('2026-01');
  await form.getByLabel('参数名 2', { exact: true }).fill('region');
  await form.getByLabel('必填 2', { exact: true }).check();

  // The versioned fixtures validation and preview run against.
  for (let index = 0; index < fixtures.length; index += 1) {
    if (index > 0) await form.getByRole('button', { name: '添加夹具页面' }).click();
    const fixture = fixtures[index]!;
    await form.getByLabel(`夹具名称 ${String(index + 1)}`, { exact: true }).fill(fixture.name);
    await form.getByLabel(`夹具路径 ${String(index + 1)}`, { exact: true }).fill(fixture.path);
    await form.getByLabel(`夹具页面内容 ${String(index + 1)}`, { exact: true }).fill(fixture.body);
    await form.getByLabel(`预期记录数 ${String(index + 1)}`, { exact: true }).fill(String(fixture.expectedCount));
    if (fixture.expectedRecords !== undefined) {
      await form
        .getByLabel(`预期记录 JSON ${String(index + 1)}`, { exact: true })
        .fill(JSON.stringify(fixture.expectedRecords));
    }
  }

  await form.getByLabel('超时毫秒', { exact: true }).fill('5000');
  await form.getByLabel('最大字节数', { exact: true }).fill('1048576');
  await form.getByLabel('最大记录数', { exact: true }).fill('1000');
  await form.getByLabel(CREDENTIAL_REF, { exact: true }).check();
  await form.getByRole('button', { name: '发布抓取任务版本' }).click();

  // The Version is announced only once the form result is on the page.
  await page.getByText(/抓取任务第 1 版已发布。|抓取任务第 2 版已发布。|抓取任务第 3 版已发布。/u).waitFor();
}

/** The browser's own view of the governed scraper state, read over the same HTTP contract. */
async function scraperWorkspace(url: string, cookie: string, workspaceId: string): Promise<Config> {
  const listed = await callApi(url, `/api/workspace/scrapers?workspace_id=${encodeURIComponent(workspaceId)}`, { cookie });
  assert.equal(listed.status, 200, listed.text);
  return listed.body;
}

async function scraperProposals(url: string, cookie: string, workspaceId: string): Promise<Config[]> {
  const listed = await callApi(
    url,
    `/api/workspace/scraper-proposals?workspace_id=${encodeURIComponent(workspaceId)}`,
    { cookie },
  );
  assert.equal(listed.status, 200, listed.text);
  return (listed.body['proposals'] as Config[]).map(asRecord);
}

test('an administrator compiles, reviews, and adopts a Scraper Service in the browser and repeated Runs reuse the exact adopted version', async () => {
  // Verify reads page 1 and the empty page 2; each of two Runs reads the same pair.
  const target = await startHttpSource({
    replies: Array.from({ length: 6 }, (_, index) => ({
      body: index % 2 === 0 ? BASE_PAGE : EMPTY_PAGE,
      content_type: 'text/html; charset=utf-8',
    })),
  });
  let browser: Browser | undefined;
  try {
    const current = world();
    adoptIntegration(current);
    const consoleServer = await startConsole(current.fixture);
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await open(browser, consoleServer.url, '/app');
      await signIn(page, current.operations);
      await page.getByRole('heading', { name: '工作区概览' }).waitFor();

      // Workspace navigation names the scraper surface in Simplified Chinese.
      await page.getByRole('link', { name: '抓取服务' }).click();
      await page.getByRole('heading', { name: '抓取服务', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '发布抓取任务版本' }).count(), 1);

      // The form pins every fact: target, scope, output contract, parameters,
      // fixtures, constraints, and credential references.
      await publishTask(page, current, '处理量报表', target, [
        { name: '处理量第一页', path: '/reports/2026-01?page=1', body: BASE_PAGE, expectedCount: 2, expectedRecords: TABLE_RECORDS },
        { name: '处理量第二页', path: '/reports/2026-01?page=2', body: EMPTY_PAGE, expectedCount: 0 },
      ]);
      const taskState = asRecord(asArray(stateOf(current).scraper_tasks)[0]);
      const taskVersion = asRecord(asArray(taskState['versions'])[0]);
      assert.deepEqual(taskVersion['target'], {
        base_url: target.url,
        path: '/reports/{month}',
        page_parameter: 'page',
        first_page: 1,
        page_size: null,
        page_size_parameter: null,
        max_pages: 3,
      });
      assert.deepEqual(taskVersion['network_scope'], { origins: [target.url], paths: ['/reports'] });
      assert.deepEqual(asRecord(taskVersion['output']), {
        record_selector: 'tr.record',
        fields: [
          { name: 'sn', selector: 'td.sn' },
          { name: 'city', selector: 'td.city' },
          { name: 'handled_count', selector: 'td.count' },
        ],
      });
      assert.deepEqual(taskVersion['parameters'], [
        { name: 'month', type: 'string', required: false, default: '2026-01' },
        { name: 'region', type: 'string', required: true, default: null },
      ]);
      assert.equal(asArray(asRecord(taskVersion['fixtures'])['pages']).length, 2);
      assert.deepEqual(taskVersion['constraints'], { timeout_ms: 5000, max_bytes: 1048576, max_records: 1000 });
      assert.deepEqual(taskVersion['credential_refs'], [CREDENTIAL_REF]);
      // The credential value never reaches the Task, the browser, or the candidate.
      assert.ok(!JSON.stringify(taskState).includes(CREDENTIAL));
      assert.equal((await page.getByRole('region', { name: '抓取任务', exact: true }).innerText()).includes(CREDENTIAL), false);

      // Compilation produces one pending candidate; nothing is published or run.
      await page.getByRole('region', { name: '抓取任务', exact: true }).getByRole('button', { name: '编译第 1 版' }).click();
      await page.getByText('已编译候选提案。').waitFor();
      const compiled = await scraperProposals(consoleServer.url, await cookieHeader(page.context()), current.workspaceId);
      assert.equal(compiled.length, 1);
      const proposal = compiled[0]!;
      assert.equal(proposal['status'], 'pending');
      assert.equal(proposal['scraper_task_version'], 1);
      assert.equal(asRecord(proposal['base'])['scraper_service_version'], null);
      const candidate = asRecord(asRecord(proposal['candidates'])['service']);
      assert.deepEqual(asRecord(candidate['source_task']), {
        version: 1,
        content_hash: taskVersion['content_hash'],
      });
      assert.deepEqual(candidate['credential_refs'], [CREDENTIAL_REF]);

      // Validation and preview read versioned fixtures only: no target request,
      // no credential value, and no governed data before Approval.
      const before = stateOf(current);
      assert.deepEqual(target.requests(), []);
      const detail = page.getByRole('region', { name: '提案详情' });
      await detail.locator('span.pill').filter({ hasText: '待审批' }).waitFor();
      await detail.getByRole('region', { name: '静态校验与夹具验证' }).getByRole('button', { name: '运行校验' }).click();
      await detail.getByRole('region', { name: '静态校验与夹具验证' }).getByText('候选通过静态校验与版本化夹具。').waitFor();
      const validationText = await detail.getByRole('region', { name: '静态校验与夹具验证' }).innerText();
      assert.match(validationText, /产出 2 条，预期 2 条/u);
      assert.match(validationText, /产出 0 条，预期 0 条/u);

      const previewPanel = detail.getByRole('region', { name: '版本化夹具预览' });
      await previewPanel.getByRole('button', { name: '预览夹具输出' }).click();
      await previewPanel.getByRole('status').waitFor();
      assert.match(await previewPanel.getByRole('status').innerText(), /候选在全部版本化夹具上产出预期记录。/u);
      const previewText = await previewPanel.innerText();
      assert.match(previewText, /dev-1/u);
      assert.match(previewText, /杭州/u);
      assert.match(previewText, /与预期一致/u);
      assert.match(previewText, /不访问真实目标/u);
      assert.deepEqual(target.requests(), []);
      const afterReview = stateOf(current);
      assert.deepEqual(afterReview.scraper_services, before.scraper_services);
      assert.deepEqual(afterReview.source_scraper_services, before.source_scraper_services);
      assert.deepEqual(afterReview.raw_acquisitions, before.raw_acquisitions);
      assert.deepEqual(afterReview.acquisition_runs, before.acquisition_runs);
      assert.deepEqual(afterReview.integration_batches, before.integration_batches);
      assert.deepEqual(afterReview.datasets, before.datasets);
      assert.deepEqual(afterReview.scraper_runs, before.scraper_runs);
      const reviewed = (await scraperProposals(consoleServer.url, await cookieHeader(page.context()), current.workspaceId))[0]!;
      assert.equal(asArray(reviewed['validations']).length, 1);
      assert.equal(asArray(reviewed['previews']).length, 1);
      const previewRecord = asRecord(asArray(reviewed['previews'])[0]);
      assert.match(String(previewRecord['evidence_hash']), /^[0-9a-f]{64}$/u);

      // Approval, Publication, isolated verification, and Adoption are separate
      // exact-version actions; Adoption before verification is refused.
      const actions = detail.getByRole('region', { name: '审批、发布、验证与采纳' });
      await actions.getByRole('button', { name: '批准抓取服务提案' }).click();
      const approval = page.getByRole('region', { name: '确认批准抓取服务提案' });
      const approvalText = await approval.innerText();
      assert.match(approvalText, /对象/u);
      assert.ok(approvalText.includes(String(proposal['proposal_id'])));
      await approval.getByRole('button', { name: '确认批准' }).click();
      await detail.locator('span.pill').filter({ hasText: '已批准' }).waitFor();

      await actions.getByRole('button', { name: '发布抓取服务版本' }).click();
      await page.getByRole('region', { name: '确认发布抓取服务版本' }).getByRole('button', { name: '确认发布' }).click();
      await detail.locator('span.pill').filter({ hasText: '已发布' }).waitFor();
      const publishedState = stateOf(current);
      assert.equal(publishedState.scraper_services.length, 1);
      assert.equal(asArray(asRecord(asArray(publishedState.scraper_services)[0])['versions']).length, 1);
      assert.deepEqual(publishedState.source_scraper_services, []);

      await actions.getByLabel('采纳到数据源', { exact: true }).selectOption({ label: '设备处理量报表' });
      await actions.getByRole('button', { name: '为数据源采纳抓取服务版本' }).click();
      await page.getByRole('region', { name: '确认采纳抓取服务版本' }).getByRole('button', { name: '确认采纳' }).click();
      await detail.getByText('采纳前必须先对已发布版本执行隔离验证。').waitFor();
      assert.ok((await detail.innerText()).includes('SCRAPER_VERIFICATION_REQUIRED'));
      assert.deepEqual(stateOf(current).source_scraper_services, []);

      await actions.getByLabel('验证参数（JSON）', { exact: true }).fill('{"region":"east"}');
      await actions.getByRole('button', { name: '对已发布版本执行隔离验证' }).click();
      await page.getByRole('region', { name: '确认执行隔离验证' }).getByRole('button', { name: '确认验证' }).click();
      await detail.getByText('隔离验证通过。').waitFor();
      assert.equal(target.requests().length, 2);
      assert.equal(target.requests()[0]?.authorization, `Bearer ${CREDENTIAL}`);
      const verifiedState = stateOf(current);
      assert.deepEqual(verifiedState.raw_acquisitions, []);
      assert.deepEqual(verifiedState.acquisition_runs, []);
      assert.deepEqual(verifiedState.datasets, []);
      assert.deepEqual(verifiedState.scraper_runs, []);
      assert.deepEqual(verifiedState.source_scraper_services, []);

      await actions.getByRole('button', { name: '为数据源采纳抓取服务版本' }).click();
      await page.getByRole('region', { name: '确认采纳抓取服务版本' }).getByRole('button', { name: '确认采纳' }).click();
      await detail.locator('span.pill').filter({ hasText: '已采纳' }).waitFor();
      const adoptedState = stateOf(current);
      const pin = asRecord(asArray(adoptedState.source_scraper_services)[0]);
      assert.equal(pin['adopted_version'], 1);
      assert.equal(pin['proposal_id'], proposal['proposal_id']);
      const pinsPanel = page.getByRole('region', { name: '数据源固定版本' });
      // The pin list reloads after Adoption, so wait for the pinned Source first.
      await pinsPanel.getByText('设备处理量报表').waitFor();
      assert.match(await pinsPanel.innerText(), /设备处理量报表[\s\S]*第 1 版/u);

      // Repeated Runs reuse exactly the adopted Version; each acquires again
      // without duplicating records, and every Run keeps its Provenance.
      const runPanel = page.getByRole('region', { name: '抓取运行' });
      await runPanel.getByLabel('数据源', { exact: true }).selectOption({ label: '设备处理量报表' });
      await runPanel.getByLabel('本次运行参数', { exact: true }).fill('{"region":"east"}');
      await runPanel.getByRole('button', { name: '按已采纳版本运行' }).click();
      await runPanel.getByText('运行完成：第 1 版数据集发布，共 2 条记录。').waitFor();
      await runPanel.getByRole('button', { name: '按已采纳版本运行' }).click();
      await runPanel.getByText('运行完成：第 1 版数据集发布，共 2 条记录。').waitFor();

      const runState = stateOf(current);
      assert.equal(runState.acquisition_runs.length, 2);
      assert.equal(runState.scraper_runs.length, 2);
      assert.equal(runState.raw_acquisitions.length, 4);
      assert.equal(asArray(asRecord(asArray(runState.datasets)[0])['releases']).length, 1);
      const runsPanel = page.getByRole('region', { name: '采集运行' });
      const runsText = await runsPanel.innerText();
      assert.match(runsText, /已完成/u);
      assert.equal((runsText.match(/第 1 版/gu) ?? []).length >= 2, true, runsText);
      assert.match(runsText, /第 1 版，2 条记录/u);

      await runsPanel.getByRole('button', { name: '查看运行' }).first().click();
      const manifestPanel = page.getByRole('region', { name: '运行清单' });
      const manifestText = await manifestPanel.innerText();
      assert.match(manifestText, /抓取任务版本[\s\S]*第 1 版/u);
      assert.match(manifestText, /抓取服务版本[\s\S]*第 1 版/u);
      assert.match(manifestText, /原始采集[\s\S]*[0-9a-f]{64}/u);
      assert.match(manifestText, /接口|页面/u);
      assert.equal(manifestText.includes(CREDENTIAL), false);

      // A Consumer holds no scraper surface, and the server refuses the API.
      const consumerPage = await open(browser, consoleServer.url, '/app');
      await signIn(consumerPage, current.analyst);
      await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
      assert.equal(await consumerPage.getByRole('link', { name: '抓取服务' }).count(), 0);
      const denied = await callApi(
        consoleServer.url,
        `/api/workspace/scrapers?workspace_id=${encodeURIComponent(current.workspaceId)}`,
        { cookie: await cookieHeader(consumerPage.context()) },
      );
      assert.equal(denied.status, 403, denied.text);
      assert.equal(denied.body['code'], 'WORKSPACE_ACCESS_DENIED');
      await consumerPage.goto(`${consoleServer.url}/app/w/${encodeURIComponent(current.workspaceId)}/scrapers`);
      await consumerPage.getByRole('heading', { name: '工作区不可用' }).waitFor();

      // Every surface this ticket adds reads in Simplified Chinese only.
      const body = await page.locator('body').innerText();
      for (const word of [
        'Scraper', 'Compile', 'Approve', 'Publish', 'Adopt', 'Verify', 'Validation',
        'Preview', 'Fixture', 'Task', 'Run', 'Diagnostics', 'Repair', 'Proposal',
      ]) {
        assert.equal(body.includes(word), false, `${word} leaks into the page`);
      }
    } finally {
      await consoleServer.stop();
    }
  } finally {
    await browser?.close();
    await target.close();
  }
});

/** The same records after a controlled layout change renames one cell class. */
const CHANGED_PAGE = [
  '<html><body><table>',
  '<tr class="record"><td class="serial">dev-1</td><td class="city">杭州</td><td class="count">12</td></tr>',
  '<tr class="record"><td class="serial">dev-2</td><td class="city">上海</td><td class="count">3</td></tr>',
  '</table></body></html>',
].join('');

/** A controlled pagination change: the second page now carries records. */
const PAGE2_RECORDS = [
  '<html><body><table>',
  '<tr class="record"><td class="serial">dev-3</td><td class="city">南京</td><td class="count">7</td></tr>',
  '<tr class="record"><td class="serial">dev-4</td><td class="city">苏州</td><td class="count">5</td></tr>',
  '</table></body></html>',
].join('');

const REPAIR_PROMPT = '你是抓取服务修复助手，只输出简体中文说明，并且只返回修好的输出契约。';

/** Publishes, evaluates, activates, and binds one deterministic repair endpoint. */
async function repairBinding(current: World, endpoint: MockModelEndpoint): Promise<string> {
  const deploymentToken = sessionFor(
    current.fixture,
    current.fixture.administrator.username,
    current.fixture.administrator.password,
  );
  const published = command(
    current.fixture,
    ['model', 'publish', '--name', '修复档案', '--config', jsonFile(current.fixture, `repair-profile-${Math.random()}`, {
      adapter: 'generic_local',
      endpoint_url: endpoint.url,
      model_id: MOCK_MODEL_ID,
      purposes: ['scraper_repair'],
      data_categories: ['scraper_diagnostics'],
      tools: [],
      max_output_bytes: 65_536,
      prompts: { scraper_repair: REPAIR_PROMPT },
    })],
    { token: deploymentToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const profileId = String(published.output['model_profile_id']);
  const version = Number(published.output['model_profile_version']);
  const evaluated = await commandAsync(
    current.fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: deploymentToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(
    current.fixture,
    ['model', 'activate', '--profile', profileId, '--version', String(version)],
    { token: deploymentToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    current.fixture,
    [
      'binding', 'publish', '--workspace', current.workspaceId, '--profile', profileId,
      '--config', jsonFile(current.fixture, `repair-binding-${Math.random()}`, {
        model_profile_version: version,
        purposes: ['scraper_repair'],
        data_categories: ['scraper_diagnostics'],
      }),
    ],
    { token: current.workspaceToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  return String(bound.output['binding_id']);
}

/** Reloads the surface so the guided form starts from empty fields again. */
async function resetTaskForm(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('heading', { name: '抓取服务', exact: true }).waitFor();
}

/** Runs validation and preview, then approves, publishes, verifies, and adopts. */
async function reviewAndAdopt(page: Page, sourceName: string): Promise<void> {
  const detail = page.getByRole('region', { name: '提案详情' });
  const validation = detail.getByRole('region', { name: '静态校验与夹具验证' });
  await validation.getByRole('button', { name: '运行校验' }).click();
  await validation.getByText('候选通过静态校验与版本化夹具。').waitFor();
  const preview = detail.getByRole('region', { name: '版本化夹具预览' });
  await preview.getByRole('button', { name: '预览夹具输出' }).click();
  await preview.getByRole('status').waitFor();

  const actions = detail.getByRole('region', { name: '审批、发布、验证与采纳' });
  await actions.getByRole('button', { name: '批准抓取服务提案' }).click();
  await page.getByRole('region', { name: '确认批准抓取服务提案' }).getByRole('button', { name: '确认批准' }).click();
  await detail.locator('span.pill').filter({ hasText: '已批准' }).waitFor();
  await actions.getByRole('button', { name: '发布抓取服务版本' }).click();
  await page.getByRole('region', { name: '确认发布抓取服务版本' }).getByRole('button', { name: '确认发布' }).click();
  await detail.locator('span.pill').filter({ hasText: '已发布' }).waitFor();
  await actions.getByLabel('验证参数（JSON）', { exact: true }).fill('{"region":"east"}');
  await actions.getByRole('button', { name: '对已发布版本执行隔离验证' }).click();
  await page.getByRole('region', { name: '确认执行隔离验证' }).getByRole('button', { name: '确认验证' }).click();
  await detail.getByText('隔离验证通过。').waitFor();
  await actions.getByLabel('采纳到数据源', { exact: true }).selectOption({ label: sourceName });
  await actions.getByRole('button', { name: '为数据源采纳抓取服务版本' }).click();
  await page.getByRole('region', { name: '确认采纳抓取服务版本' }).getByRole('button', { name: '确认采纳' }).click();
  await detail.locator('span.pill').filter({ hasText: '已采纳' }).waitFor();
}

test('a layout and pagination change is repaired from recorded diagnostics, a failed repair is refused, and re-adoption preserves Provenance', async () => {
  const endpoint = await startMockModelEndpoint();
  // 1-2 adopt the base Service, 3-4 fail its re-verification, 5-7 verify the
  // repair, 8-10 run the repaired Version across three pages.
  const target = await startHttpSource({
    replies: [
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: PAGE2_RECORDS, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: PAGE2_RECORDS, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
    ],
  });
  let browser: Browser | undefined;
  try {
    const current = world();
    adoptIntegration(current);
    await repairBinding(current, endpoint);
    const consoleServer = await startConsole(current.fixture);
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await open(browser, consoleServer.url, '/app');
      await signIn(page, current.operations);
      await page.getByRole('heading', { name: '工作区概览' }).waitFor();
      await page.getByRole('link', { name: '抓取服务' }).click();
      await page.getByRole('heading', { name: '抓取服务', exact: true }).waitFor();

      // The base Service Version is compiled, verified, and explicitly adopted.
      await publishTask(page, current, '处理量报表', target, [
        { name: '处理量第一页', path: '/reports/2026-01?page=1', body: BASE_PAGE, expectedCount: 2, expectedRecords: TABLE_RECORDS },
        { name: '处理量第二页', path: '/reports/2026-01?page=2', body: EMPTY_PAGE, expectedCount: 0 },
      ]);
      await page.getByRole('region', { name: '抓取任务', exact: true }).getByRole('button', { name: '编译第 1 版' }).click();
      await page.getByText('已编译候选提案。').waitFor();
      await reviewAndAdopt(page, '设备处理量报表');
      assert.equal(asRecord(asArray(stateOf(current).source_scraper_services)[0])['adopted_version'], 1);

      // The controlled layout change makes the published Version fail an
      // isolated re-verification; the failure becomes durable diagnostics.
      const detail = page.getByRole('region', { name: '提案详情' });
      const actions = detail.getByRole('region', { name: '审批、发布、验证与采纳' });
      await actions.getByRole('button', { name: '对已发布版本执行隔离验证' }).click();
      await page.getByRole('region', { name: '确认执行隔离验证' }).getByRole('button', { name: '确认验证' }).click();
      await detail.getByText('实时验证失败，采纳被拒绝；现有数据源固定版本保持不变。').waitFor();
      const failedState = stateOf(current);
      assert.equal(asRecord(asArray(failedState.source_scraper_services)[0])['adopted_version'], 1);
      assert.equal(asArray(asRecord(asArray(failedState.scraper_services)[0])['versions']).length, 1);
      assert.equal(failedState.scraper_diagnostics.length, 1);
      const diagnosis = asRecord(failedState.scraper_diagnostics[0]);
      assert.equal(diagnosis['mode'], 'verification');
      assert.equal(diagnosis['failure_code'], 'SCRAPER_FIELD_EMPTY');
      assert.equal(diagnosis['stage'], 'extraction');
      assert.equal(diagnosis['category'], 'field_missing');

      const diagnosticsPanel = page.getByRole('region', { name: '失败诊断', exact: true });
      const diagnosticsText = await diagnosticsPanel.innerText();
      assert.match(diagnosticsText, /SCRAPER_FIELD_EMPTY/u);
      assert.match(diagnosticsText, /抽取/u);
      assert.match(diagnosticsText, /字段缺失/u);
      await diagnosticsPanel.getByRole('button', { name: '查看诊断' }).click();
      const diagnosticDetail = page.getByRole('region', { name: '诊断详情' });
      await diagnosticDetail.getByText('字段缺失').first().waitFor();
      const evidenceText = await diagnosticDetail.innerText();
      assert.match(evidenceText, /class="serial"/u);
      assert.match(evidenceText, /authorization/u);
      assert.equal(evidenceText.includes(CREDENTIAL), false);

      // A Task Version that drops a retained fixture can still seed a repair
      // candidate, but validation refuses it and Approval stays impossible.
      await resetTaskForm(page);
      await publishTask(page, current, '处理量报表', target, [
        { name: '改版后第一页', path: '/reports/2026-01?page=1', body: CHANGED_PAGE, expectedCount: 2, expectedRecords: TABLE_RECORDS },
        { name: '处理量第二页', path: '/reports/2026-01?page=2', body: EMPTY_PAGE, expectedCount: 0 },
      ]);
      const repairPanel = page.getByRole('region', { name: '抓取服务修复' });
      await repairPanel.getByLabel('修复所用的任务版本', { exact: true }).selectOption({ label: '第 2 版' });
      await repairPanel.getByRole('button', { name: '生成修复候选' }).click();
      await page.getByText('修复候选已生成为新提案。').waitFor({ timeout: 8_000 });
      const refusedDetail = page.getByRole('region', { name: '提案详情' });
      const refusedValidation = refusedDetail.getByRole('region', { name: '静态校验与夹具验证' });
      await refusedValidation.getByRole('button', { name: '运行校验' }).click();
      await refusedValidation.getByText('未通过').first().waitFor();
      const refusedActions = refusedDetail.getByRole('region', { name: '审批、发布、验证与采纳' });
      await refusedActions.getByRole('button', { name: '批准抓取服务提案' }).click();
      await page.getByRole('region', { name: '确认批准抓取服务提案' }).getByRole('button', { name: '确认批准' }).click();
      await refusedDetail.getByText('候选未通过静态校验或版本化夹具，不能批准。').waitFor();
      assert.match(await refusedValidation.innerText(), /fixtures:regression/u);
      const afterFailedRepair = stateOf(current);
      assert.equal(asArray(asRecord(asArray(afterFailedRepair.scraper_services)[0])['versions']).length, 1);
      assert.equal(asRecord(asArray(afterFailedRepair.source_scraper_services)[0])['adopted_version'], 1);

      // The retained Page 1 and Page 2 fixtures plus a new Page 3 fixture let the
      // repair prove the failure and the changed pagination without widening scope.
      await resetTaskForm(page);
      await publishTask(page, current, '处理量报表', target, [
        { name: '处理量第一页', path: '/reports/2026-01?page=1', body: CHANGED_PAGE, expectedCount: 2, expectedRecords: TABLE_RECORDS },
        { name: '处理量第二页', path: '/reports/2026-01?page=2', body: EMPTY_PAGE, expectedCount: 0 },
        { name: '处理量第三页', path: '/reports/2026-01?page=3', body: EMPTY_PAGE, expectedCount: 0 },
      ]);
      await repairPanel.getByLabel('修复所用的任务版本', { exact: true }).selectOption({ label: '第 3 版' });
      await repairPanel.getByRole('button', { name: '生成修复候选' }).click();
      await page.getByText('修复候选已生成为新提案。').waitFor();
      const repairedDetail = page.getByRole('region', { name: '提案详情' });
      const repairedEvidence = await repairedDetail.innerText();
      assert.match(repairedEvidence, /修复候选/u);
      assert.match(repairedEvidence, /SCRAPER_FIELD_EMPTY/u);
      assert.match(repairedEvidence, new RegExp(MOCK_MODEL_ID, 'u'));
      assert.match(repairedEvidence, /处理量第三页/u);
      const repairedValidation = repairedDetail.getByRole('region', { name: '静态校验与夹具验证' });
      await repairedValidation.getByRole('button', { name: '运行校验' }).click();
      await repairedValidation.getByText('候选通过静态校验与版本化夹具。').waitFor();
      const repairedValidationText = await repairedValidation.innerText();
      assert.match(repairedValidationText, /repair:addresses_failure/u);
      assert.match(repairedValidationText, /repair:changes/u);
      const repairedPreview = repairedDetail.getByRole('region', { name: '版本化夹具预览' });
      await repairedPreview.getByRole('button', { name: '预览夹具输出' }).click();
      await repairedPreview.getByRole('status').waitFor();
      const previewText = await repairedPreview.innerText();
      assert.match(previewText, /dev-1/u);
      assert.match(previewText, /与预期一致/u);

      // Approval, Publication, isolated verification, and re-adoption stay separate.
      await reviewAndAdopt(page, '设备处理量报表');
      const readopted = stateOf(current);
      const pin = asRecord(asArray(readopted.source_scraper_services)[0]);
      assert.equal(pin['adopted_version'], 2);
      assert.equal(asArray(asRecord(asArray(readopted.scraper_services)[0])['versions']).length, 2);
      const listed = await scraperProposals(consoleServer.url, await cookieHeader(page.context()), current.workspaceId);
      const repairedProposal = listed.find(
        (proposal) => asRecord(proposal)['repair'] !== null && proposal['status'] === 'adopted',
      );
      assert.ok(repairedProposal !== undefined);
      const adoption = asRecord(asArray(repairedProposal['adoptions'])[0]);
      assert.equal(adoption['previous_adopted_version'], 1);
      const repairRecord = asRecord(repairedProposal['repair']);
      assert.equal(repairRecord['base_service_version'], 1);
      assert.equal(repairRecord['base_task_version'], 1);
      assert.equal(repairRecord['failure_code'], 'SCRAPER_FIELD_EMPTY');
      const decisionProvenance = asRecord(asRecord(asArray(repairedProposal['decisions'])[0])['provenance']);
      // The Approval predates verification, so it restates the preview it saw.
      assert.equal(decisionProvenance['preview_hash'] === '', false);
      assert.equal(decisionProvenance['verification_hash'], '');
      assert.match(String(decisionProvenance['candidate_content_hash']), /^[0-9a-f]{64}$/u);
      // Adoption restates the complete Provenance, verification included.
      const adoptionProvenance = asRecord(adoption['provenance']);
      assert.equal(adoptionProvenance['preview_hash'] === '', false);
      assert.equal(adoptionProvenance['verification_hash'] === '', false);
      assert.equal(adoptionProvenance['proposal_hash'], repairedProposal['proposal_hash']);

      // The repaired Version reads the controlled pagination change completely.
      const runPanel = page.getByRole('region', { name: '抓取运行' });
      await runPanel.getByLabel('数据源', { exact: true }).selectOption({ label: '设备处理量报表' });
      await runPanel.getByLabel('本次运行参数', { exact: true }).fill('{"region":"east"}');
      await runPanel.getByRole('button', { name: '按已采纳版本运行' }).click();
      await runPanel.getByText('运行完成：第 1 版数据集发布，共 4 条记录。').waitFor();
      const runState = stateOf(current);
      const release = asRecord(asArray(asRecord(asArray(runState.datasets)[0])['releases'])[0]);
      assert.equal(release['record_count'], 4);
      assert.equal(asRecord(asArray(runState.scraper_runs)[0])['scraper_service_version'], 2);
      assert.equal(asArray(asRecord(asArray(runState.scraper_runs)[0])['pages']).length, 3);
      assert.equal(asRecord(asArray(runState.scraper_runs)[0])['record_count'], 4);

      // The first Version, its pin history, and its Proposal remain readable.
      const baseProposal = listed.find(
        (proposal) => proposal['proposal_id'] !== repairedProposal['proposal_id']
          && proposal['repair'] === null
          && proposal['status'] === 'adopted',
      );
      assert.ok(baseProposal !== undefined);
      assert.equal(asArray(baseProposal['adoptions']).length, 1);
      const runsPanel = page.getByRole('region', { name: '采集运行' });
      const runText = await runsPanel.innerText();
      assert.match(runText, /第 2 版/u);
      assert.match(runText, /第 1 版，4 条记录/u);

      const body = await page.locator('body').innerText();
      for (const word of ['Scraper', 'Repair', 'Diagnostics', 'Validation', 'Preview', 'Proposal', 'Fixture']) {
        assert.equal(body.includes(word), false, `${word} leaks into the page`);
      }
    } finally {
      await consoleServer.stop();
    }
  } finally {
    await browser?.close();
    await endpoint.close();
    await target.close();
  }
});
