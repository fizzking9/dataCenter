import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import {
  command,
  createUser,
  initializePlatform,
  jsonFile,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const DEPUTY = 'deputy@example.invalid';
const DEPUTY_PASSWORD = 'deputy-administrator';
const NEWCOMER = 'newcomer@example.invalid';
const NEWCOMER_PASSWORD = 'newcomer-password';
const ISOLATION = 'isolation@example.invalid';
const ISOLATION_PASSWORD = 'isolation-administrator';
const RANDOM_WORKSPACE = '00000000-0000-4000-8000-000000000000';
const SECRET = 'super-secret-credential-value';

const NO_WORKSPACE = '当前账号尚未加入任何工作区，请联系部署管理员。';
const GRANTED = (username: string) => `角色已授予：${username}，下一次请求即生效。`;
const REMOVED = (username: string) => `成员已移除：${username}，下一次请求即失效。`;
const PUBLISHED = '工作区上下文版本已发布。';
const SHADOWS_COMMON = '工作区扩展不能覆盖部署通用定义。';
const CROSS_WORKSPACE = '业务上下文不能引用其他工作区。';

interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

interface Deployment {
  fixture: PlatformFixture;
  administratorToken: string;
  deploymentAdministrator: Credentials;
  operations: string;
  isolation: string;
  operationsCredentials: Credentials;
  consumerCredentials: Credentials;
  deputyCredentials: Credentials;
  isolationCredentials: Credentials;
  newcomerCredentials: Credentials;
  sourceId: string;
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

function publishWorkspaceContext(
  fixture: PlatformFixture,
  token: string,
  workspaceId: string,
  name: string,
  entries: unknown[],
): void {
  const published = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', jsonFile(fixture, name, entries)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
}

/**
 * One Deployment with two Workspaces that share no membership: Operations holds
 * a Workspace Administrator, a second administrator and a Consumer; Isolation
 * answers only to its own administrator. The Operations Workspace has published
 * Business Context, a Source whose Integration Configuration pins version 1, and
 * a Connection carrying a credential the browser must never disclose.
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
    [DEPUTY, DEPUTY_PASSWORD],
    [NEWCOMER, NEWCOMER_PASSWORD],
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
  const operationsCredentials: Credentials = {
    username: OPERATIONS,
    password: OPERATIONS_PASSWORD,
    totp: String(operations.output.totp_secret),
  };

  const isolation = command(
    fixture,
    ['workspace', 'create', '--name', 'Isolation', '--administrator', ISOLATION],
    { token: administratorToken },
  );
  assert.equal(isolation.status, 0, isolation.stderr);
  const isolationId = String(isolation.output.workspace_id);
  const isolationCredentials: Credentials = {
    username: ISOLATION,
    password: ISOLATION_PASSWORD,
    totp: String(isolation.output.totp_secret),
  };

  const operationsToken = signInToken(fixture, operationsCredentials);

  const grantedConsumer = command(
    fixture,
    ['membership', 'grant', '--workspace', operationsId, '--username', ANALYST, '--role', 'Consumer'],
    { token: operationsToken },
  );
  assert.equal(grantedConsumer.status, 0, grantedConsumer.stderr);

  const grantedDeputy = command(
    fixture,
    ['membership', 'grant', '--workspace', operationsId, '--username', DEPUTY, '--role', 'Workspace Administrator'],
    { token: operationsToken },
  );
  assert.equal(grantedDeputy.status, 0, grantedDeputy.stderr);
  const deputyCredentials: Credentials = {
    username: DEPUTY,
    password: DEPUTY_PASSWORD,
    totp: String(grantedDeputy.output.totp_secret),
  };

  const common = command(
    fixture,
    ['context', 'publish-common', '--entries', jsonFile(fixture, 'common-v1', [
      { key: 'refund_window_days', kind: 'metric', value: '30', unit: 'days' },
    ])],
    { token: administratorToken },
  );
  assert.equal(common.status, 0, common.stderr);

  publishWorkspaceContext(fixture, operationsToken, operationsId, 'operations-v1', [
    { key: 'bms_export_pause_seconds', kind: 'metric', value: '65' },
  ]);
  publishWorkspaceContext(
    fixture,
    signInToken(fixture, isolationCredentials),
    isolationId,
    'isolation-v1',
    [{ key: 'region_scope', kind: 'definition', value: 'eu-west' }],
  );

  const source = command(
    fixture,
    ['source', 'create', '--workspace', operationsId, '--name', '设备台账', '--type', 'file'],
    { token: operationsToken },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const integration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', {
      identity: ['sn'],
      schema: [
        { name: 'sn', type: 'string' },
        { name: 'city', type: 'string' },
      ],
      cleaning: [{ rule: 'trim', field: 'sn' }],
      mapping: { device_sn: 'sn', device_city: 'city' },
    })],
    { token: operationsToken },
  );
  assert.equal(integration.status, 0, integration.stderr);

  const connection = command(
    fixture,
    ['connection', 'publish', '--workspace', operationsId, '--name', '设备系统', '--config', jsonFile(fixture, 'connection', {
      base_url: 'http://127.0.0.1:9',
      auth: { scheme: 'bearer' },
      pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 2, max_pages: 1 },
    }), '--credential-stdin'],
    { token: operationsToken, input: `${SECRET}\n` },
  );
  assert.equal(connection.status, 0, connection.stderr);
  assert.equal(JSON.stringify(connection.output).includes(SECRET), false, 'a credential is never returned');

  return {
    fixture,
    administratorToken,
    deploymentAdministrator: {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    },
    operations: operationsId,
    isolation: isolationId,
    operationsCredentials,
    consumerCredentials: { username: ANALYST, password: ANALYST_PASSWORD },
    deputyCredentials,
    isolationCredentials,
    newcomerCredentials: { username: NEWCOMER, password: NEWCOMER_PASSWORD },
    sourceId,
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

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function grantThroughBrowser(
  members: ReturnType<Page['getByRole']>,
  username: string,
  role: '工作区管理员' | '消费方',
): Promise<void> {
  await members.getByLabel('账号', { exact: true }).fill(username);
  await members.getByLabel('角色', { exact: true }).selectOption({ label: role });
  await members.getByRole('button', { name: '授予角色' }).click();
  await members.getByText(GRANTED(username)).waitFor();
}

async function publishThroughBrowser(
  context: ReturnType<Page['getByRole']>,
  entries: unknown[],
): Promise<void> {
  await context.getByLabel('业务上下文条目（JSON）', { exact: true }).fill(JSON.stringify(entries, null, 2));
  await context.getByRole('button', { name: '发布上下文版本' }).click();
}

/** AC1: membership and Role changes are Workspace-scoped and bind the next request. */
test('membership and Role changes stay in the active Workspace and take effect on the next request', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const admin = await open(browser, consoleServer.url, '/app');
    await signIn(admin, world.operationsCredentials);
    await admin.getByRole('heading', { name: '工作区概览' }).waitFor();

    await admin.getByRole('link', { name: '成员' }).click();
    const members = admin.getByRole('region', { name: '工作区成员' });
    await members.getByRole('cell', { name: ANALYST, exact: true }).waitFor();
    const listed = await members.innerText();
    assert.equal(listed.includes(OPERATIONS), true, listed);
    assert.equal(listed.includes(DEPUTY), true, listed);
    assert.equal(listed.includes(NEWCOMER), false, listed);
    // Another Workspace's members never appear in this one's membership.
    assert.equal(listed.includes(ISOLATION), false, listed);

    // A newcomer signs in before the grant, so the change must reach an open session.
    const newcomerPage = await open(browser, consoleServer.url, '/app');
    await signIn(newcomerPage, world.newcomerCredentials);
    await newcomerPage.getByText(NO_WORKSPACE).waitFor();

    await grantThroughBrowser(members, NEWCOMER, '消费方');
    await members.getByRole('cell', { name: NEWCOMER, exact: true }).waitFor();

    // Access is granted on the very next request, not at the next sign-in.
    await newcomerPage.getByRole('button', { name: '刷新活动' }).click();
    await newcomerPage.getByRole('heading', { name: '工作区概览' }).waitFor();

    // Revoking mid-session fails the very next request.
    await members.getByRole('button', { name: `移除 ${NEWCOMER}` }).click();
    await members.getByText(REMOVED(NEWCOMER)).waitFor();
    await newcomerPage.getByRole('button', { name: '刷新活动' }).click();
    await newcomerPage.getByRole('heading', { name: '工作区不可用' }).waitFor();

    const newcomerCookie = await cookieHeader(newcomerPage.context());
    const denied = await callApi(
      consoleServer.url,
      `/api/workspace/data-products?workspace_id=${world.operations}`,
      { cookie: newcomerCookie },
    );
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.body.code, 'WORKSPACE_ACCESS_DENIED');

    // A Role change on the same screen also binds the very next request.
    const deputyPage = await open(browser, consoleServer.url, '/app');
    await signIn(deputyPage, world.deputyCredentials);
    await deputyPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await deputyPage.getByRole('link', { name: '成员' }).count(), 1);

    await grantThroughBrowser(members, DEPUTY, '消费方');
    await deputyPage.getByRole('button', { name: '刷新活动' }).click();
    // The refresh is asynchronous: wait for the navigation tree itself to change,
    // not for a heading that was already on screen.
    const deputyNav = deputyPage.getByRole('navigation', { name: '工作区导航' });
    await deputyNav.getByRole('link', { name: '成员' }).waitFor({ state: 'detached' });
    await deputyPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await deputyNav.getByRole('link', { name: '成员' }).count(), 0);
    assert.equal(await deputyNav.getByRole('link', { name: '业务上下文' }).count(), 0);

    const deputyCookie = await cookieHeader(deputyPage.context());
    const configuration = await callApi(
      consoleServer.url,
      `/api/workspace/context?workspace_id=${world.operations}`,
      { cookie: deputyCookie },
    );
    assert.equal(configuration.status, 403, configuration.text);
    assert.equal(configuration.body.code, 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC2: Workspace extensions are additive and stay inside their own Workspace. */
test('Workspace extensions cannot shadow common definitions or reference another Workspace', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.operationsCredentials);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await page.getByRole('link', { name: '业务上下文' }).click();
    const context = page.getByRole('region', { name: '业务上下文' });
    await context.getByText('bms_export_pause_seconds').waitFor();

    await publishThroughBrowser(context, [
      { key: 'refund_window_days', kind: 'metric', value: '45' },
    ]);
    await context.getByText(SHADOWS_COMMON).waitFor();
    const shadowed = await context.innerText();
    assert.equal(shadowed.includes('cannot redefine'), false, shadowed);
    assert.match(shadowed, /业务上下文条目/u);

    await publishThroughBrowser(context, [
      {
        key: 'derived_rate',
        kind: 'metric',
        value: '0.1',
        references: [`workspace:${world.isolation}:region_scope`],
      },
    ]);
    await context.getByText(CROSS_WORKSPACE).waitFor();

    // A valid additive extension still publishes, and only version 2 exists.
    await publishThroughBrowser(context, [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '70' },
    ]);
    await context.getByText(PUBLISHED).waitFor();
    assert.match(await context.innerText(), /上下文版本\s*2/u);
    assert.equal(await context.getByRole('heading', { name: '版本 3' }).count(), 0);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC3: exact context versions, their validation, and the Artifact pins stay visible and scoped. */
test('context publication, validation, version history and affected Artifact pins stay inside the Workspace', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.operationsCredentials);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await page.getByRole('link', { name: '业务上下文' }).click();
    const context = page.getByRole('region', { name: '业务上下文' });
    await context.getByText('bms_export_pause_seconds').waitFor();

    const first = await context.innerText();
    assert.match(first, /上下文版本\s*1/u);
    assert.match(first, /版本历史/u);
    assert.match(first, /版本 1/u);
    assert.match(first, /operations@example\.invalid/u);
    // The affected Artifact is named: the Source whose Integration Configuration pins version 1.
    assert.match(first, /设备台账/u);
    assert.match(first, /集成配置/u);
    // The common version a Workspace version pins is stated.
    assert.match(first, /通用上下文版本/u);
    // Only this Workspace's configuration is shown.
    assert.equal(first.includes('region_scope'), false, first);
    assert.equal(first.includes(SECRET), false, first);

    await publishThroughBrowser(context, [
      { key: 'bms_export_pause_seconds', kind: 'metric', value: '70' },
    ]);
    await context.getByText(PUBLISHED).waitFor();
    const second = await context.innerText();
    assert.match(second, /上下文版本\s*2/u);
    assert.match(second, /版本 2/u);
    // Version 1 remains exactly as it was, with the Artifact still pinned to it.
    assert.match(second, /版本 1[\s\S]*设备台账/u);
    assert.equal(second.includes('region_scope'), false, second);
    assert.equal(second.includes(SECRET), false, second);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC4: Workspace Audit Events are attributable, scoped, and free of secrets. */
test('Workspace Audit Events are attributable and scoped, with secrets and foreign payloads excluded', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const admin = await open(browser, consoleServer.url, '/app');
    await signIn(admin, world.operationsCredentials);
    await admin.getByRole('heading', { name: '工作区概览' }).waitFor();

    // Governed activity this Workspace's audit must attribute.
    await admin.getByRole('link', { name: '成员' }).click();
    const members = admin.getByRole('region', { name: '工作区成员' });
    await members.getByRole('cell', { name: ANALYST, exact: true }).waitFor();
    await grantThroughBrowser(members, NEWCOMER, '消费方');
    await members.getByRole('button', { name: `移除 ${NEWCOMER}` }).click();
    await members.getByText(REMOVED(NEWCOMER)).waitFor();

    await admin.getByRole('link', { name: '审计' }).click();
    const audit = admin.getByRole('region', { name: '审计事件' });
    await audit.getByText('membership_grant').first().waitFor();
    const events = await audit.innerText();
    assert.match(events, /operations@example\.invalid/u);
    assert.match(events, /membership_grant/u);
    assert.match(events, /membership_revocation/u);
    assert.match(events, /business_context_publish/u);
    assert.match(events, /NEWCOMER@example\.invalid|newcomer@example\.invalid/u);
    assert.match(events, /工作区/u);
    assert.match(events, /成功/u);

    // Another Workspace's Audit Events, deployment-scope events, and secrets stay out.
    assert.equal(events.includes(`workspace-${world.isolation}-business-context`), false, events);
    assert.equal(events.includes('region_scope'), false, events);
    assert.equal(events.includes('workspace_creation'), false, events);
    assert.equal(events.includes(ISOLATION), false, events);
    assert.equal(events.includes(SECRET), false, events);

    // A Consumer holds no audit access, in the browser or over the API.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, world.consumerCredentials);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '审计' }).count(), 0);
    assert.equal(await consumerPage.getByRole('link', { name: '成员' }).count(), 0);

    const consumerCookie = await cookieHeader(consumerPage.context());
    const denied = await callApi(
      consoleServer.url,
      `/api/workspace/audit?workspace_id=${world.operations}`,
      { cookie: consumerCookie },
    );
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.body.code, 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC5: substitution, denial, inheritance, Chinese validation, and audit outcomes in one browser run. */
test('real browser substitution, denial, inheritance, Chinese validation and audit outcomes all fail closed', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const admin = await open(browser, consoleServer.url, '/app');
    await signIn(admin, world.operationsCredentials);
    await admin.getByRole('heading', { name: '工作区概览' }).waitFor();
    const adminCookie = await cookieHeader(admin.context());

    // Substituting another Workspace's identifier answers like one that names nothing.
    for (const path of [
      `/api/workspace/memberships?workspace_id=${world.isolation}`,
      `/api/workspace/context/history?workspace_id=${world.isolation}`,
      `/api/workspace/audit?workspace_id=${world.isolation}`,
    ]) {
      const foreign = await callApi(consoleServer.url, path, { cookie: adminCookie });
      const missing = await callApi(
        consoleServer.url,
        path.replace(world.isolation, RANDOM_WORKSPACE),
        { cookie: adminCookie },
      );
      assert.equal(foreign.status, 403, foreign.text);
      assert.deepEqual(foreign.body, missing.body);
      assert.equal(missing.status, foreign.status);
      assert.equal(foreign.text.includes('Isolation'), false, foreign.text);
    }

    const substitutedGrant = await callApi(consoleServer.url, '/api/workspace/memberships', {
      cookie: adminCookie,
      body: { workspace_id: world.isolation, username: ANALYST, role: 'Consumer' },
    });
    const missingGrant = await callApi(consoleServer.url, '/api/workspace/memberships', {
      cookie: adminCookie,
      body: { workspace_id: RANDOM_WORKSPACE, username: ANALYST, role: 'Consumer' },
    });
    assert.equal(substitutedGrant.status, 403, substitutedGrant.text);
    assert.deepEqual(substitutedGrant.body, missingGrant.body);

    // A Consumer is denied every administrative surface.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, world.consumerCredentials);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    const consumerCookie = await cookieHeader(consumerPage.context());
    for (const path of [
      `/api/workspace/memberships?workspace_id=${world.operations}`,
      `/api/workspace/context/history?workspace_id=${world.operations}`,
      `/api/workspace/audit?workspace_id=${world.operations}`,
    ]) {
      const denied = await callApi(consoleServer.url, path, { cookie: consumerCookie });
      assert.equal(denied.status, 403, denied.text);
      assert.equal(denied.body.code, 'WORKSPACE_ACCESS_DENIED');
    }

    // Inheritance never widens access: a Workspace Administrator keeps the
    // Consumer surfaces, while deployment authority opens no Workspace content.
    assert.equal(await admin.getByRole('link', { name: '数据产品' }).count(), 1);
    assert.equal(await admin.getByRole('navigation', { name: '部署导航' }).count(), 0);

    const deploymentPage = await open(browser, consoleServer.url, '/app');
    await signIn(deploymentPage, world.deploymentAdministrator);
    await deploymentPage.getByRole('heading', { name: '工作区' }).waitFor();
    await deploymentPage.goto(`${consoleServer.url}/app/w/${world.operations}/overview`);
    await deploymentPage.getByRole('heading', { name: '工作区不可用' }).waitFor();
    const deploymentCookie = await cookieHeader(deploymentPage.context());
    const deploymentDenied = await callApi(
      consoleServer.url,
      `/api/workspace/memberships?workspace_id=${world.operations}`,
      { cookie: deploymentCookie },
    );
    assert.equal(deploymentDenied.status, 403, deploymentDenied.text);
    assert.equal(deploymentDenied.body.code, 'WORKSPACE_ACCESS_DENIED');

    // Validation answers in Simplified Chinese, and the refusal is audited.
    await admin.getByRole('link', { name: '业务上下文' }).click();
    const context = admin.getByRole('region', { name: '业务上下文' });
    await context.getByText('bms_export_pause_seconds').waitFor();
    await publishThroughBrowser(context, [
      { key: 'refund_window_days', kind: 'metric', value: '45' },
    ]);
    await context.getByText(SHADOWS_COMMON).waitFor();
    const attempted = await callApi(consoleServer.url, '/api/workspace/context/publish', {
      cookie: adminCookie,
      body: { workspace_id: world.operations, entries: [{ key: 'refund_window_days', kind: 'metric', value: '45' }] },
    });
    assert.equal(attempted.status, 409, attempted.text);
    assert.equal(attempted.body.code, 'CONTEXT_SHADOWS_COMMON');

    // Required audit outcomes: success, denial, and validation failure are all attributable.
    await admin.getByRole('link', { name: '审计' }).click();
    const audit = admin.getByRole('region', { name: '审计事件' });
    await audit.getByText('business_context_publish').first().waitFor();
    const events = await audit.innerText();
    assert.match(events, /成功/u);
    assert.match(events, /拒绝/u);
    assert.match(events, /失败/u);
    assert.match(events, /operations@example\.invalid/u);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
