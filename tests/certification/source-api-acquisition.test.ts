import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import { pageBody, startHttpSource, type HttpSource } from '../support/http-source.js';
import { command, createUser, initializePlatform, type PlatformFixture } from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const ISOLATION = 'isolation@example.invalid';
const ISOLATION_PASSWORD = 'isolation-administrator';

/** A credential the browser types once and no response may ever repeat. */
const CREDENTIAL = 'browser-only-source-token';

const DEVICES = [
  { device_sn: 'sn-001', city: '杭州', handled_count: 3 },
  { device_sn: 'sn-002', city: '上海', handled_count: 5 },
  { device_sn: 'sn-003', city: '杭州', handled_count: 2 },
  { device_sn: 'sn-004', city: '上海', handled_count: 7 },
  { device_sn: 'sn-005', city: '杭州', handled_count: 4 },
];

interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

interface Deployment {
  fixture: PlatformFixture;
  administratorToken: string;
  operations: string;
  isolation: string;
  workspaceAdministrator: Credentials;
  consumer: Credentials;
}

function signInToken(fixture: PlatformFixture, credentials: Credentials): string {
  const result = command(
    fixture,
    [
      'login', '--username', credentials.username, '--password-stdin',
      ...(credentials.totp === undefined ? [] : ['--totp', totpCode(credentials.totp)]),
    ],
    { input: `${credentials.password}\n` },
  );
  assert.equal(result.status, 0, result.stderr);
  return String(result.output.session_token);
}

/**
 * One Deployment with two Workspaces that share no membership: the Operations
 * administrator who drives the browser, a Consumer, and an unrelated
 * administrator whose Workspace holds content the actor may never reach.
 */
function deployment(): Deployment {
  const fixture = initializePlatform();
  const administratorToken = signInToken(fixture, {
    username: fixture.administrator.username,
    password: fixture.administrator.password,
    totp: fixture.administrator.totp_secret,
  });
  for (const [username, password] of [
    [OPERATIONS, OPERATIONS_PASSWORD],
    [ANALYST, ANALYST_PASSWORD],
    [ISOLATION, ISOLATION_PASSWORD],
  ] as const) {
    createUser(fixture, administratorToken, username, password);
  }
  const operations = command(
    fixture,
    ['workspace', 'create', '--name', 'Operations', '--administrator', OPERATIONS],
    { token: administratorToken },
  );
  assert.equal(operations.status, 0, operations.stderr);
  const operationsId = String(operations.output.workspace_id);
  const workspaceAdministrator: Credentials = {
    username: OPERATIONS,
    password: OPERATIONS_PASSWORD,
    totp: String(operations.output.totp_secret),
  };
  const granted = command(
    fixture,
    ['membership', 'grant', '--workspace', operationsId, '--username', ANALYST, '--role', 'Consumer'],
    { token: signInToken(fixture, workspaceAdministrator) },
  );
  assert.equal(granted.status, 0, granted.stderr);

  const isolation = command(
    fixture,
    ['workspace', 'create', '--name', 'Isolation', '--administrator', ISOLATION],
    { token: administratorToken },
  );
  assert.equal(isolation.status, 0, isolation.stderr);

  return {
    fixture,
    administratorToken,
    operations: operationsId,
    isolation: String(isolation.output.workspace_id),
    workspaceAdministrator,
    consumer: { username: ANALYST, password: ANALYST_PASSWORD },
  };
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
  if (credentials.totp !== undefined) {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(credentials.totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** Signs in as the Workspace Administrator and opens the Sources surface. */
async function adminSources(browser: Browser, url: string, world: Deployment): Promise<Page> {
  const page = await open(browser, url, '/app');
  await signIn(page, world.workspaceAdministrator);
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  await page.getByRole('link', { name: '数据来源' }).click();
  await page.getByRole('heading', { name: '数据来源', exact: true }).waitFor();
  return page;
}

async function createSourceThroughGuide(page: Page, name: string, type: string): Promise<void> {
  const create = page.getByRole('region', { name: '新建数据来源' });
  await create.getByLabel('来源名称', { exact: true }).fill(name);
  await create.getByLabel('来源类型', { exact: true }).selectOption({ label: type });
  await create.getByRole('button', { name: '创建数据来源' }).click();
  await page.getByText(`数据来源已创建：${name}`).waitFor();
}

/** Fills the guided Connection form; every value comes from the form's own labels. */
async function fillConnectionForm(
  page: Page,
  url: string,
  options: { name?: string; minimumInterval?: string; pagination?: 'page_number' | 'cursor' } = {},
): Promise<void> {
  const connection = page.getByRole('region', { name: '接入连接' });
  await connection.getByLabel('连接名称', { exact: true }).fill(options.name ?? '设备系统');
  await connection.getByLabel('接口地址（基础 URL）', { exact: true }).fill(url);
  await connection.getByLabel('认证方式', { exact: true }).selectOption({ label: '静态 Bearer 令牌' });
  await connection.getByLabel('凭据', { exact: true }).fill(CREDENTIAL);
  if (options.pagination === 'cursor') {
    await connection.getByLabel('分页方式', { exact: true }).selectOption({ label: '游标分页' });
    await connection.getByLabel('页码参数', { exact: true }).fill('cursor');
    await connection.getByLabel('游标字段', { exact: true }).fill('next');
  } else {
    await connection.getByLabel('分页方式', { exact: true }).selectOption({ label: '页码分页' });
    await connection.getByLabel('页码参数', { exact: true }).fill('page');
    await connection.getByLabel('页大小参数', { exact: true }).fill('page_size');
    await connection.getByLabel('起始页', { exact: true }).fill('1');
    await connection.getByLabel('每页记录数', { exact: true }).fill('2');
  }
  await connection.getByLabel('最多页数', { exact: true }).fill('5');
  await connection.getByLabel('最大尝试次数', { exact: true }).fill('3');
  await connection.getByLabel('重试基础延迟（毫秒）', { exact: true }).fill('20');
  await connection.getByLabel('重试最大延迟（毫秒）', { exact: true }).fill('100');
  await connection.getByLabel('重试状态码', { exact: true }).fill('429,503');
  await connection.getByLabel('最小间隔（秒）', { exact: true }).fill(options.minimumInterval ?? '0');
  await connection.getByLabel('连接内串行执行', { exact: true }).check();
  await connection.getByLabel('启用计划', { exact: true }).check();
  await connection.getByLabel('计划间隔（分钟）', { exact: true }).fill('15');
  await connection.getByLabel('启动容忍（秒）', { exact: true }).fill('60');
}

/** Fills the guided acquisition form for one incremental window. */
async function fillAcquisitionForm(
  page: Page,
  options: { connectionName?: string; initialStart: string; lookback: string; maximumSpan: string },
): Promise<void> {
  const acquisition = page.getByRole('region', { name: '采集配置', exact: true });
  await acquisition.getByLabel('连接版本', { exact: true }).selectOption({
    label: `${options.connectionName ?? '设备系统'} 第 1 版`,
  });
  await acquisition.getByLabel('接口路径', { exact: true }).fill('/api/devices');
  await acquisition.getByLabel('记录路径', { exact: true }).fill('data.records');
  await acquisition.getByLabel('分页完成方式', { exact: true }).selectOption({ label: '短页结束' });
  await acquisition.getByLabel('启用时间窗口', { exact: true }).check();
  await acquisition.getByLabel('窗口模式', { exact: true }).selectOption({ label: '增量窗口' });
  await acquisition.getByLabel('开始参数', { exact: true }).fill('from');
  await acquisition.getByLabel('结束参数', { exact: true }).fill('to');
  await acquisition.getByLabel('初始开始（ISO）', { exact: true }).fill(options.initialStart);
  await acquisition.getByLabel('最大跨度（分钟）', { exact: true }).fill(options.maximumSpan);
  await acquisition.getByLabel('回看（分钟）', { exact: true }).fill(options.lookback);
  await acquisition.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
}

/** The Integration Configuration a device endpoint's records are curated under. */
async function configureDeviceIntegration(page: Page): Promise<void> {
  const wizard = page.getByRole('region', { name: '集成配置向导' });
  const fields = [
    { name: 'sn', type: '文本' },
    { name: 'city', type: '文本' },
    { name: 'handled_count', type: '整数' },
  ];
  for (const [index, field] of fields.entries()) {
    if (index > 0) await wizard.getByRole('button', { name: '添加字段' }).click();
    await wizard.getByLabel(`字段名 ${String(index + 1)}`, { exact: true }).fill(field.name);
    await wizard.getByLabel(`字段类型 ${String(index + 1)}`, { exact: true }).selectOption({ label: field.type });
  }
  await wizard.getByRole('checkbox', { name: 'sn', exact: true }).check();
  await wizard.getByRole('button', { name: '添加清洗规则' }).click();
  await wizard.getByLabel('规则字段 1', { exact: true }).selectOption({ label: 'sn' });
  await wizard.getByLabel('清洗规则 1', { exact: true }).selectOption({ label: '去除首尾空白' });
  const columns = [
    { column: 'device_sn', target: 'sn' },
    { column: 'city', target: 'city' },
    { column: 'handled_count', target: 'handled_count' },
  ];
  for (const [index, mapping] of columns.entries()) {
    if (index > 0) await wizard.getByRole('button', { name: '添加映射' }).click();
    await wizard.getByLabel(`源列名 ${String(index + 1)}`, { exact: true }).fill(mapping.column);
    await wizard.getByLabel(`目标字段 ${String(index + 1)}`, { exact: true }).selectOption({ label: mapping.target });
  }
  await wizard.getByRole('button', { name: '预览配置' }).click();
  const preview = page.getByRole('region', { name: '声明式配置预览' });
  await preview.getByText('配置校验通过，可以发布为不可变版本。').waitFor();
  await preview.getByRole('button', { name: '发布配置版本' }).click();
  await page.getByText('集成配置版本已发布：第 1 版').waitFor();
  await page.getByRole('region', { name: '配置版本', exact: true }).getByRole('button', { name: '采纳第 1 版' }).click();
  await page.getByText('已采纳集成配置第 1 版，之后的采集按该版本执行。').waitFor();
}

/** AC1: both guided forms preview an exact declarative document; the credential never returns. */
test('guided Connection and acquisition forms preview exact declarative documents and keep the credential write-only', async () => {
  const world = deployment();
  const http = await startHttpSource({ replies: [{ body: pageBody(DEVICES) }] });
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(page, '设备接口', '声明式 HTTP 接口');
    await page.getByRole('button', { name: '管理 设备接口' }).click();

    await fillConnectionForm(page, http.url);
    const connectionPanel = page.getByRole('region', { name: '接入连接' });
    await connectionPanel.getByRole('button', { name: '预览连接配置' }).click();
    const connectionPreview = page.getByRole('region', { name: '连接声明预览' });
    await connectionPreview.getByText('连接声明已通过校验，可以发布为不可变版本。').waitFor();
    const connectionDeclaration = JSON.parse(
      await connectionPreview.locator('pre').innerText(),
    ) as Record<string, unknown>;
    assert.match(String(connectionDeclaration['credential_ref']), /^bearer:[0-9a-f]{16}$/u);
    assert.deepEqual(connectionDeclaration, {
      base_url: http.url,
      credential_ref: connectionDeclaration['credential_ref'],
      auth: { scheme: 'bearer' },
      retry: { max_attempts: 3, base_delay_ms: 20, max_delay_ms: 100, retry_on: [429, 503] },
      pacing: {
        serialization: true,
        minimum_interval_seconds: 0,
        maximum_requests_per_minute: null,
        maximum_concurrent_runs: 1,
      },
      pagination: {
        parameter: 'page',
        size_parameter: 'page_size',
        start: 1,
        size: 2,
        max_pages: 5,
        mode: 'page_number',
        cursor_path: null,
        initial_cursor: null,
      },
      schedule: { every_minutes: 15, start_tolerance_seconds: 60 },
      publication_targets: null,
    });
    assert.equal(JSON.stringify(connectionDeclaration).includes(CREDENTIAL), false);
    assert.equal((await connectionPreview.innerText()).includes(CREDENTIAL), false);
    const connectionHash = /内容摘要\s*([0-9a-f]{64})/u.exec(await connectionPreview.innerText())?.[1];
    assert.ok(connectionHash, 'the preview states the exact content hash');

    await connectionPreview.getByRole('button', { name: '发布连接版本' }).click();
    await page.getByText('连接版本已发布：第 1 版').waitFor();
    const connectionVersions = page.getByRole('region', { name: '连接版本' });
    assert.equal((await connectionVersions.innerText()).includes(connectionHash), true);
    await connectionVersions.getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳连接第 1 版，之后的采集按该版本执行。').waitFor();

    // The acquisition form pins the exact Connection Version above.
    const cookie = await cookieHeader(page);
    const listed = await callApi(
      consoleServer.url,
      `/api/workspace/connections?workspace_id=${world.operations}`,
      { cookie },
    );
    assert.equal(listed.status, 200, listed.text);
    const connectionId = String((listed.body['connections'] as Array<Record<string, unknown>>)[0]?.['connection_id']);
    assert.equal(listed.text.includes(CREDENTIAL), false, 'a Connection listing never returns a credential');

    const acquisitionPanel = page.getByRole('region', { name: '采集配置', exact: true });
    await acquisitionPanel.getByLabel('连接版本', { exact: true }).selectOption({ label: '设备系统 第 1 版' });
    await acquisitionPanel.getByLabel('接口路径', { exact: true }).fill('/api/devices');
    await acquisitionPanel.getByLabel('记录路径', { exact: true }).fill('data.records');
    await acquisitionPanel.getByLabel('分页完成方式', { exact: true }).selectOption({ label: '短页结束' });
    await acquisitionPanel.getByLabel('启用时间窗口', { exact: true }).check();
    await acquisitionPanel.getByLabel('窗口模式', { exact: true }).selectOption({ label: '增量窗口' });
    await acquisitionPanel.getByLabel('开始参数', { exact: true }).fill('from');
    await acquisitionPanel.getByLabel('结束参数', { exact: true }).fill('to');
    await acquisitionPanel.getByLabel('初始开始（ISO）', { exact: true }).fill('2026-01-01T00:00:00.000Z');
    await acquisitionPanel.getByLabel('最大跨度（分钟）', { exact: true }).fill('60');
    await acquisitionPanel.getByLabel('回看（分钟）', { exact: true }).fill('5');
    await acquisitionPanel.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
    await acquisitionPanel.getByRole('button', { name: '预览采集配置' }).click();
    const acquisitionPreview = page.getByRole('region', { name: '采集声明预览' });
    await acquisitionPreview.getByText('采集配置校验通过，可以发布为不可变版本。').waitFor();
    const acquisitionDeclaration = JSON.parse(
      await acquisitionPreview.locator('pre').innerText(),
    ) as Record<string, unknown>;
    assert.deepEqual(acquisitionDeclaration, {
      connection: connectionId,
      connection_version: 1,
      path: '/api/devices',
      record_path: 'data.records',
      completion: { kind: 'short_page' },
      window: {
        mode: 'incremental',
        start_parameter: 'from',
        end_parameter: 'to',
        initial_start: '2026-01-01T00:00:00.000Z',
        initial_end: null,
        maximum_span_minutes: 60,
        lookback_minutes: 5,
        time_zone: 'Asia/Shanghai',
        end_inclusive: false,
      },
      content_type: null,
    });
    const acquisitionHash = /内容摘要\s*([0-9a-f]{64})/u.exec(await acquisitionPreview.innerText())?.[1];
    assert.ok(acquisitionHash, 'the preview states the exact content hash');

    await acquisitionPreview.getByRole('button', { name: '发布采集版本' }).click();
    await page.getByText('采集配置版本已发布：第 1 版').waitFor();
    const acquisitionVersions = page.getByRole('region', { name: '采集配置版本' });
    assert.equal((await acquisitionVersions.innerText()).includes(acquisitionHash), true);
    await acquisitionVersions.getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳采集配置第 1 版，之后的采集按该版本执行。').waitFor();

    // Neither the page nor any governed read answer ever repeats the secret.
    const sources = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie },
    );
    const sourceId = String((sources.body['sources'] as Array<Record<string, unknown>>)[0]?.['source_id']);
    const detail = await callApi(consoleServer.url, `/api/workspace/sources/${sourceId}`, { cookie });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.text.includes(CREDENTIAL), false, 'the Source read never returns a credential');
    assert.equal((await page.locator('body').innerText()).includes(CREDENTIAL), false, 'the page never shows the secret');
  } finally {
    await browser?.close();
    await consoleServer.stop();
    await http.close();
  }
});

/** AC3: scheduled and manual Runs expose plans, attempts, pacing, cancellation, and reruns. */
test('manual and scheduled Runs expose immutable plans, attempts, durable pacing, cancellation, and linked reruns', async () => {
  const world = deployment();
  const http = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 4)) },
      { body: pageBody(DEVICES.slice(4, 5)) },
    ],
    repeat_last: true,
  });
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(page, '设备接口', '声明式 HTTP 接口');
    await page.getByRole('button', { name: '管理 设备接口' }).click();

    // One Connection with a five-second minimum interval and a 15-minute schedule.
    await fillConnectionForm(page, http.url, { minimumInterval: '5' });
    const connectionPanel = page.getByRole('region', { name: '接入连接' });
    await connectionPanel.getByRole('button', { name: '预览连接配置' }).click();
    const connectionPreview = page.getByRole('region', { name: '连接声明预览' });
    await connectionPreview.getByText('连接声明已通过校验，可以发布为不可变版本。').waitFor();
    await connectionPreview.getByRole('button', { name: '发布连接版本' }).click();
    await page.getByText('连接版本已发布：第 1 版').waitFor();
    await page.getByRole('region', { name: '连接版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳连接第 1 版，之后的采集按该版本执行。').waitFor();

    await fillAcquisitionForm(page, {
      initialStart: '2026-01-01T00:00:00.000Z',
      lookback: '5',
      maximumSpan: '60',
    });
    const acquisitionPanel = page.getByRole('region', { name: '采集配置', exact: true });
    await acquisitionPanel.getByRole('button', { name: '预览采集配置' }).click();
    const acquisitionPreview = page.getByRole('region', { name: '采集声明预览' });
    await acquisitionPreview.getByText('采集配置校验通过，可以发布为不可变版本。').waitFor();
    await acquisitionPreview.getByRole('button', { name: '发布采集版本' }).click();
    await page.getByText('采集配置版本已发布：第 1 版').waitFor();
    await page.getByRole('region', { name: '采集配置版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳采集配置第 1 版，之后的采集按该版本执行。').waitFor();

    // The Integration Configuration the connector's fields are mapped through.
    await configureDeviceIntegration(page);

    // A manual trigger queues a Run; the attempt is only made on request.
    const runs = page.getByRole('region', { name: '采集运行' });
    await runs.getByRole('button', { name: '排队手动采集' }).click();
    await page.getByText('已排队采集运行。').waitFor();
    let history = await runs.innerText();
    assert.match(history, /手动/u);
    assert.match(history, /排队中/u);

    // Working it writes the immutable Plan first and publishes the Release.
    await runs.getByRole('button', { name: '执行下一条排队采集' }).click();
    await page.getByText('已执行一条排队采集。').waitFor();
    const outcome = await runs.innerText();
    assert.match(outcome, /已完成/u);
    assert.match(outcome, /数据集发布\s*1/u);
    assert.match(outcome, /有效记录\s*5/u);
    const plan = page.getByRole('region', { name: '采集计划' });
    await plan.getByText('计划编号').waitFor();
    const planText = await plan.innerText();
    assert.match(planText, /已完成/u);
    assert.match(planText, /http-json 1/u);
    assert.match(planText, /增量窗口/u);
    const pageRows = await plan.locator('tbody tr').allInnerTexts();
    assert.equal(pageRows.length, 3, pageRows.join('\n'));
    assert.match(pageRows[0] ?? '', /已接收\s*2\s*1/u);
    assert.match(pageRows[2] ?? '', /已接收\s*1\s*1/u);

    // The durable queue is visible: three requests in the last minute.
    await page.getByRole('region', { name: '连接排队' }).getByText('最近一分钟请求').waitFor();
    assert.match(await page.getByRole('region', { name: '连接排队' }).innerText(), /最近一分钟请求\s*3/u);

    // A second request inside the minimum interval stays queued with its reason.
    await runs.getByRole('button', { name: '排队手动采集' }).click();
    await page.getByText('已排队采集运行。').waitFor();
    await runs.getByRole('button', { name: '执行下一条排队采集' }).click();
    await page.getByText('本次运行未获准执行：最小间隔未到。').waitFor();
    assert.match(await runs.innerText(), /最早可执行时间/u);

    // Cancellation removes the queued Run without reading anything.
    await runs.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.alert--info').filter({ hasText: '采集运行已取消。' }).waitFor();
    history = await runs.innerText();
    assert.match(history, /已取消/u);
    const requestsBeforeCancel = http.requests().length;
    assert.equal(requestsBeforeCancel, 3, 'a cancelled Run never reads the endpoint');

    // A rerun is a linked new Run, never a resumed Plan.
    const cancelledRow = runs.locator('tbody tr').filter({ hasText: '已取消' });
    await cancelledRow.getByRole('button', { name: '重新采集' }).click();
    await page.getByText('已按该运行重新排队一次采集。').waitFor();
    history = await runs.innerText();
    assert.match(history, /关联运行/u);
    const rerunRow = runs.locator('tbody tr').filter({ hasText: '排队中' });
    assert.equal(await rerunRow.count(), 1, history);
    await rerunRow.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.alert--info').filter({ hasText: '采集运行已取消。' }).waitFor();

    // The schedule becomes due 15 minutes after the last completion.
    const cookie = await cookieHeader(page);
    const lastCompleted = /([0-9a-f-]{36})\s*手动\s*已完成/u.exec(await runs.innerText())?.[1];
    assert.ok(lastCompleted, 'the completed manual Run is in the ledger');
    const dueAt = new Date(Date.now() + 16 * 60_000).toISOString();
    const ticked = await callApi(consoleServer.url, '/api/workspace/acquisition/schedule', {
      cookie,
      body: { at: dueAt },
    });
    assert.equal(ticked.status, 200, ticked.text);
    assert.equal((ticked.body['enqueued'] as unknown[]).length, 1, ticked.text);

    await page.reload();
    await page.getByRole('heading', { name: '数据来源', exact: true }).waitFor();
    await page.getByRole('button', { name: '管理 设备接口' }).click();
    const scheduledRun = page.getByRole('region', { name: '采集运行' });
    await scheduledRun.getByText('计划', { exact: true }).waitFor();
    assert.match(await scheduledRun.innerText(), /计划时刻/u);

    // A scheduled Run completes through the same Plan, pacing and Release path.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await scheduledRun.getByRole('button', { name: '执行下一条排队采集' }).click();
    await page.getByText('已执行一条排队采集。').waitFor();
    const scheduledPlan = page.getByRole('region', { name: '采集计划' });
    await scheduledPlan.getByText('计划编号').waitFor();
    assert.match(await scheduledPlan.innerText(), /已完成/u);
    const rows = await scheduledRun.locator('tbody tr').allInnerTexts();
    const scheduledRow = rows.find((row) => row.includes('计划'));
    assert.ok(scheduledRow, rows.join('\n'));
    assert.match(scheduledRow, /已完成/u);
    assert.equal(http.requests().length, 4, 'the scheduled attempt reads its own page');
  } finally {
    await browser?.close();
    await consoleServer.stop();
    await http.close();
  }
});

/** AC4: drift, malformed responses, authentication changes, and invalid cursors fail closed. */
test('malformed responses, schema drift, authentication changes, and invalid cursors fail closed without changing curation', async () => {
  const world = deployment();
  const http = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 3)) },
      { body: '{"data":{"records":"not-a-list"}}' },
      { body: pageBody([{ device_sn: 'sn-009', city: '宁波' }]) },
      { status: 401, body: '{"error":"unauthorized"}' },
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(3, 4)) },
      // The cursor Source's pages follow the page-number Source's attempts.
      { body: JSON.stringify({ data: { records: [DEVICES[0]] }, next: 'c1' }) },
      { status: 400, body: '{"error":"cursor expired"}' },
      { body: JSON.stringify({ data: { records: [DEVICES[3]] } }) },
    ],
    repeat_last: true,
  });
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(page, '设备接口', '声明式 HTTP 接口');
    await page.getByRole('button', { name: '管理 设备接口' }).click();
    await fillConnectionForm(page, http.url);
    await page.getByRole('region', { name: '接入连接' }).getByRole('button', { name: '预览连接配置' }).click();
    await page.getByRole('region', { name: '连接声明预览' }).getByText('连接声明已通过校验，可以发布为不可变版本。').waitFor();
    await page.getByRole('region', { name: '连接声明预览' }).getByRole('button', { name: '发布连接版本' }).click();
    await page.getByText('连接版本已发布：第 1 版').waitFor();
    await page.getByRole('region', { name: '连接版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳连接第 1 版，之后的采集按该版本执行。').waitFor();
    await fillAcquisitionForm(page, { initialStart: '2026-01-01T00:00:00.000Z', lookback: '0', maximumSpan: '60' });
    await page.getByRole('region', { name: '采集配置', exact: true }).getByRole('button', { name: '预览采集配置' }).click();
    await page.getByRole('region', { name: '采集声明预览' }).getByText('采集配置校验通过，可以发布为不可变版本。').waitFor();
    await page.getByRole('region', { name: '采集声明预览' }).getByRole('button', { name: '发布采集版本' }).click();
    await page.getByText('采集配置版本已发布：第 1 版').waitFor();
    await page.getByRole('region', { name: '采集配置版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳采集配置第 1 版，之后的采集按该版本执行。').waitFor();
    await configureDeviceIntegration(page);

    const runs = page.getByRole('region', { name: '采集运行' });
    const cookie = await cookieHeader(page);
    const sourceIds = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie },
    );
    const sourceId = String((sourceIds.body['sources'] as Array<Record<string, unknown>>)[0]?.['source_id']);
    const checkpoint = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${sourceId}/acquisition/checkpoint`,
      { cookie },
    );
    assert.equal(checkpoint.body['checkpoint'], null, 'a fresh Source has no checkpoint yet');

    const runOnce = async (): Promise<void> => {
      await runs.getByRole('button', { name: '排队手动采集' }).click();
      await page.getByText('已排队采集运行。').waitFor();
      await runs.getByRole('button', { name: '执行下一条排队采集' }).click();
    };

    // A complete attempt governs the first Release and advances the checkpoint.
    await runOnce();
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();
    const firstCheckpoint = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${sourceId}/acquisition/checkpoint`,
      { cookie },
    );
    const watermark = (firstCheckpoint.body['checkpoint'] as Record<string, unknown>)['watermark'];
    assert.ok(typeof watermark === 'string' && watermark.length > 0);

    // A malformed response keeps its diagnostic fragment and fails the Plan.
    await runOnce();
    await page.getByText('已执行一条排队采集。').waitFor();
    await runs.getByText('接口响应不是声明的 JSON 结构。 ACQUISITION_RESPONSE_MALFORMED').waitFor();
    assert.match(await page.getByRole('region', { name: '采集计划' }).innerText(), /不完整/u);
    assert.match(await page.getByRole('region', { name: '采集计划' }).innerText(), /失败/u);
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();
    assert.deepEqual(
      (await callApi(consoleServer.url, `/api/workspace/sources/${sourceId}/acquisition/checkpoint`, { cookie })).body['checkpoint'],
      firstCheckpoint.body['checkpoint'],
      'a failed attempt never advances the checkpoint',
    );

    // Schema drift quarantines the Batch and leaves the Release untouched.
    await runOnce();
    await runs.getByText('采集的数据结构与集成配置不一致，当前数据集发布保持不变。').waitFor();
    assert.equal((await runs.innerText()).includes('ACQUISITION_SCHEMA_DRIFT'), true);
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();
    assert.deepEqual(
      (await callApi(consoleServer.url, `/api/workspace/sources/${sourceId}/acquisition/checkpoint`, { cookie })).body['checkpoint'],
      firstCheckpoint.body['checkpoint'],
    );

    // An authentication change stops the Run and demands an explicit intervention.
    await runOnce();
    await page.getByText('已执行一条排队采集。').waitFor();
    await runs.getByText('接口拒绝了连接凭据，需要人工处理后才能继续采集。 ACQUISITION_AUTHENTICATION_INTERVENTION_REQUIRED').waitFor();
    const session = page.getByRole('region', { name: '连接会话' });
    await session.getByText('需要人工干预').waitFor();
    await session.getByRole('button', { name: '重置连接会话' }).click();
    await page.getByText('连接会话已重置，下一次采集会重新认证。').waitFor();
    await session.getByText('生效中').waitFor();

    // After the explicit reset the same Connection acquires the next Release.
    await runOnce();
    await page.getByText('已执行一条排队采集。').waitFor();
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 2 版', { exact: true }).waitFor();

    // -------------------------------------------------------------------------
    // A cursor the endpoint no longer honours is refused; resetting the cursor
    // is the explicit recovery and the watermark survives it.
    // -------------------------------------------------------------------------
    await page.getByRole('heading', { name: '数据来源', exact: true }).waitFor();
    await createSourceThroughGuide(page, '设备游标', '声明式 HTTP 接口');
    await page.getByRole('button', { name: '管理 设备游标' }).click();
    await fillConnectionForm(page, http.url, { name: '设备游标系统', pagination: 'cursor' });
    const cursorConnection = page.getByRole('region', { name: '接入连接' });
    await cursorConnection.getByRole('button', { name: '预览连接配置' }).click();
    await page.getByRole('region', { name: '连接声明预览' }).getByText('连接声明已通过校验，可以发布为不可变版本。').waitFor();
    await page.getByRole('region', { name: '连接声明预览' }).getByRole('button', { name: '发布连接版本' }).click();
    await page.getByText('连接版本已发布：第 1 版').waitFor();
    const cursorVersions = page.getByRole('region', { name: '连接版本' });
    await cursorVersions.getByText('设备游标系统').waitFor();
    await cursorVersions.locator('li', { hasText: '设备游标系统' }).getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳连接第 1 版，之后的采集按该版本执行。').waitFor();
    const cursorAcquisition = page.getByRole('region', { name: '采集配置', exact: true });
    await cursorAcquisition.getByLabel('连接版本', { exact: true }).selectOption({ label: '设备游标系统 第 1 版' });
    await cursorAcquisition.getByLabel('接口路径', { exact: true }).fill('/api/devices');
    await cursorAcquisition.getByLabel('记录路径', { exact: true }).fill('data.records');
    await cursorAcquisition.getByRole('button', { name: '预览采集配置' }).click();
    await page.getByRole('region', { name: '采集声明预览' }).getByText('采集配置校验通过，可以发布为不可变版本。').waitFor();
    await page.getByRole('region', { name: '采集声明预览' }).getByRole('button', { name: '发布采集版本' }).click();
    await page.getByText('采集配置版本已发布：第 1 版').waitFor();
    await page.getByRole('region', { name: '采集配置版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText('已采纳采集配置第 1 版，之后的采集按该版本执行。').waitFor();
    await configureDeviceIntegration(page);

    const cursorRuns = page.getByRole('region', { name: '采集运行' });
    const runCursorSource = async (): Promise<void> => {
      await cursorRuns.getByRole('button', { name: '排队手动采集' }).click();
      await page.getByText('已排队采集运行。').waitFor();
      await cursorRuns.getByRole('button', { name: '执行下一条排队采集' }).click();
    };
    await runCursorSource();
    await page.getByText('已执行一条排队采集。').waitFor();
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();
    await cursorRuns.getByText('c1', { exact: true }).waitFor();

    await runCursorSource();
    await cursorRuns.getByText('接口拒绝了已保存的游标，请重置检查点后重新采集。 ACQUISITION_CHECKPOINT_CURSOR_INVALID').waitFor();
    await cursorRuns.getByText('已失效').waitFor();
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();
    const workspaceSources = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie },
    );
    const cursorSourceId = String(
      (workspaceSources.body['sources'] as Array<Record<string, unknown>>)
        .find((source) => source['name'] === '设备游标')?.['source_id'],
    );
    const cursorCheckpoint = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${cursorSourceId}/acquisition/checkpoint`,
      { cookie },
    );
    assert.equal((cursorCheckpoint.body['checkpoint'] as Record<string, unknown>)['cursor_state'], 'invalid');

    await cursorRuns.getByRole('button', { name: '重置检查点游标' }).click();
    await page.getByText('检查点游标已重置，水位保持不变。').waitFor();
    await cursorRuns.getByText('有效', { exact: true }).waitFor();
    await runCursorSource();
    await page.getByText('已执行一条排队采集。').waitFor();
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 2 版', { exact: true }).waitFor();
    const cursorRequests = http.requests().filter((request) => request.path === '/api/devices');
    assert.equal(cursorRequests.some((request) => request.query['cursor'] === 'c1'), true);
    assert.equal(
      cursorRequests[cursorRequests.length - 1]?.query['cursor'],
      undefined,
      'the recovered traversal starts without the refused cursor',
    );
  } finally {
    await browser?.close();
    await consoleServer.stop();
    await http.close();
  }
});

/** Previews, publishes, and adopts the Connection, acquisition, and integration configuration. */
async function adoptGuidedApiSource(page: Page, url: string): Promise<void> {
  await fillConnectionForm(page, url);
  await page.getByRole('region', { name: '接入连接' }).getByRole('button', { name: '预览连接配置' }).click();
  await page.getByRole('region', { name: '连接声明预览' }).getByText('连接声明已通过校验，可以发布为不可变版本。').waitFor();
  await page.getByRole('region', { name: '连接声明预览' }).getByRole('button', { name: '发布连接版本' }).click();
  await page.getByText('连接版本已发布：第 1 版').waitFor();
  await page.getByRole('region', { name: '连接版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
  await page.getByText('已采纳连接第 1 版，之后的采集按该版本执行。').waitFor();
  await fillAcquisitionForm(page, { initialStart: '2026-01-01T00:00:00.000Z', lookback: '5', maximumSpan: '60' });
  await page.getByRole('region', { name: '采集配置', exact: true }).getByRole('button', { name: '预览采集配置' }).click();
  await page.getByRole('region', { name: '采集声明预览' }).getByText('采集配置校验通过，可以发布为不可变版本。').waitFor();
  await page.getByRole('region', { name: '采集声明预览' }).getByRole('button', { name: '发布采集版本' }).click();
  await page.getByText('采集配置版本已发布：第 1 版').waitFor();
  await page.getByRole('region', { name: '采集配置版本' }).getByRole('button', { name: '采纳第 1 版' }).click();
  await page.getByText('已采纳采集配置第 1 版，之后的采集按该版本执行。').waitFor();
  await configureDeviceIntegration(page);
}
/** AC5: restart-safe progress, Workspace isolation, and write-only credentials. */
test('run progress survives a console restart and every route stays Workspace-scoped with write-only credentials', async () => {
  const world = deployment();
  const http = await startHttpSource({
    replies: [
      { body: pageBody(DEVICES.slice(0, 2)) },
      { body: pageBody(DEVICES.slice(2, 4)) },
      { body: pageBody(DEVICES.slice(4, 5)) },
    ],
    repeat_last: true,
  });
  let consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(page, '设备接口', '声明式 HTTP 接口');
    await page.getByRole('button', { name: '管理 设备接口' }).click();
    await adoptGuidedApiSource(page, http.url);

    const runs = page.getByRole('region', { name: '采集运行' });
    await runs.getByRole('button', { name: '排队手动采集' }).click();
    await page.getByText('已排队采集运行。').waitFor();
    await runs.getByRole('button', { name: '执行下一条排队采集' }).click();
    await page.getByText('已执行一条排队采集。').waitFor();
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();
    const runId = /([0-9a-f-]{36})/u.exec(await runs.innerText())?.[1];
    assert.ok(runId, 'the ledger names the Run');
    const watermark = (await runs.locator('dd').first().innerText()).trim();
    assert.notEqual(watermark, '—', 'a complete attempt advances the checkpoint');
    assert.equal((await page.getByRole('region', { name: '采集计划' }).locator('tbody tr').count()), 3);

    // The console process is replaced; the durable ledger is the only memory.
    await consoleServer.stop();
    consoleServer = await startConsole(world.fixture);
    await page.goto(`${consoleServer.url}/app/w/${world.operations}/sources`);
    await page.getByRole('button', { name: '管理 设备接口' }).click();
    const restored = page.getByRole('region', { name: '采集运行' });
    await restored.getByText(runId).waitFor();
    assert.equal((await restored.locator('dd').first().innerText()).trim(), watermark, 'the checkpoint survived the restart');
    assert.match(await restored.innerText(), /已完成/u);
    await restored.getByRole('button', { name: '查看计划' }).click();
    const restoredPlan = page.getByRole('region', { name: '采集计划' });
    await restoredPlan.getByText('计划编号').waitFor();
    assert.equal(await restoredPlan.locator('tbody tr').count(), 3, 'the immutable Plan survived the restart');

    // The credential is write-only: no read answer and no page repeats it.
    const cookie = await cookieHeader(page);
    assert.equal((await page.locator('body').innerText()).includes(CREDENTIAL), false);
    const sources = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie },
    );
    const sourceId = String((sources.body['sources'] as Array<Record<string, unknown>>)[0]?.['source_id']);
    const detail = await callApi(consoleServer.url, `/api/workspace/sources/${sourceId}`, { cookie });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.text.includes(CREDENTIAL), false, 'the Source read never returns a credential');
    const connections = await callApi(
      consoleServer.url,
      `/api/workspace/connections?workspace_id=${world.operations}`,
      { cookie },
    );
    assert.equal(connections.text.includes(CREDENTIAL), false, 'the Connection listing never returns a credential');

    // A Consumer reaches none of it, in the browser or over the API.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, world.consumer);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '数据来源' }).count(), 0);
    const consumerCookie = await cookieHeader(consumerPage);
    const refused = await callApi(
      consoleServer.url,
      `/api/workspace/connections?workspace_id=${world.operations}`,
      { cookie: consumerCookie },
    );
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.body.code, 'WORKSPACE_ACCESS_DENIED');
    const consumerWork = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${sourceId}/acquisition/work`,
      { cookie: consumerCookie, method: 'POST' },
    );
    assert.equal(consumerWork.status, 404, consumerWork.text);
    assert.equal(consumerWork.body.code, 'SOURCE_NOT_AVAILABLE');

    // A substituted identifier answers exactly like one that names nothing.
    const foreignSource = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${world.isolation}/acquisition/preview`,
      { cookie, body: { declaration: {} } },
    );
    assert.equal(foreignSource.status, 404, foreignSource.text);
    assert.equal(foreignSource.body.code, 'SOURCE_NOT_AVAILABLE');
    const foreignConnection = await callApi(
      consoleServer.url,
      `/api/workspace/connections/${world.isolation}/session`,
      { cookie },
    );
    assert.equal(foreignConnection.status, 404, foreignConnection.text);
    assert.equal(foreignConnection.body.code, 'CONNECTION_NOT_AVAILABLE');
    const foreignPage = await open(browser, consoleServer.url, `/app/w/${world.isolation}/sources`);
    await signIn(foreignPage, world.workspaceAdministrator);
    await foreignPage.getByRole('heading', { name: '工作区不可用' }).waitFor();

    // The audit trail names the acquisition actions without any credential.
    await page.getByRole('link', { name: '审计' }).click();
    const audit = page.getByRole('region', { name: '审计事件' });
    await audit.getByText('acquisition_work').first().waitFor();
    const auditText = await audit.innerText();
    assert.match(auditText, /acquisition_enqueue/u);
    assert.match(auditText, /acquisition_connection_publication/u);
    assert.equal(auditText.includes(CREDENTIAL), false, 'Audit Events never carry a credential');
  } finally {
    await browser?.close();
    await consoleServer.stop();
    await http.close();
  }
});
