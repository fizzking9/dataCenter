import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import {
  command,
  createUser,
  initializePlatform,
  jsonFile,
  sessionFor,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const RANDOM_WORKSPACE = '00000000-0000-4000-8000-000000000000';

const GENERIC_FAILURE = '登录失败：账号、密码或验证码不正确。';
const SESSION_LOST = '会话已失效，请重新登录。';
const WORKSPACE_UNAVAILABLE = '该工作区不存在或当前账号无权访问。';

interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

interface Deployment {
  fixture: PlatformFixture;
  administratorToken: string;
  deploymentAdministrator: Credentials;
  workspaceAdministrator: Credentials;
  consumer: Credentials;
  operations: string;
  isolation: string;
}

/**
 * One Deployment with a Deployment Administrator, a Workspace Administrator and
 * a Consumer in Operations, plus a second Workspace neither ordinary Role sees.
 */
function deployment(): Deployment {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);

  createUser(fixture, administratorToken, OPERATIONS, OPERATIONS_PASSWORD);
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

  const isolation = command(
    fixture,
    ['workspace', 'create', '--name', 'Isolation', '--administrator', OPERATIONS],
    { token: administratorToken },
  );
  assert.equal(isolation.status, 0, isolation.stderr);
  const isolationId = String(isolation.output.workspace_id);

  createUser(fixture, administratorToken, ANALYST, ANALYST_PASSWORD);
  const workspaceAdministratorToken = signInToken(fixture, workspaceAdministrator);
  const granted = command(
    fixture,
    ['membership', 'grant', '--workspace', operationsId, '--username', ANALYST, '--role', 'Consumer'],
    { token: workspaceAdministratorToken },
  );
  assert.equal(granted.status, 0, granted.stderr);

  publishContext(fixture, workspaceAdministratorToken, operationsId, 'refund_window', '30');
  publishContext(fixture, workspaceAdministratorToken, isolationId, 'region_scope', 'eu-west');

  return {
    fixture,
    administratorToken,
    deploymentAdministrator: {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    },
    workspaceAdministrator,
    consumer: { username: ANALYST, password: ANALYST_PASSWORD },
    operations: operationsId,
    isolation: isolationId,
  };
}

function publishContext(fixture: PlatformFixture, token: string, workspaceId: string, key: string, value: string): void {
  const published = command(
    fixture,
    [
      'context', 'publish-workspace', '--workspace', workspaceId,
      '--entries', jsonFile(fixture, `context-${key}`, [{ key, kind: 'definition', value }]),
    ],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
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

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('heading', { name: '登录数据中心' }).waitFor();
}

/** The single-use recovery code path shares the same form as the dynamic code. */
async function signInWithRecoveryCode(page: Page, credentials: Credentials, recoveryCode: string): Promise<void> {
  await page.getByRole('button', { name: '改用恢复码' }).click();
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  await page.getByLabel('恢复码', { exact: true }).fill(recoveryCode);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/** The persistent session bar every signed-in surface shares. */
function sessionBar(page: Page) {
  return page.getByLabel('当前会话');
}

async function cookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** The local login contract: one generic answer whatever went wrong. */
test('local sign-in demands administrator MFA or a recovery code and answers every failure generically', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await page.getByRole('heading', { name: '登录数据中心' }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');

    // An unknown account, a wrong password and a missing code answer identically.
    await page.getByLabel('账号', { exact: true }).fill('nobody@example.invalid');
    await page.getByLabel('密码', { exact: true }).fill('irrelevant-password-value');
    await page.getByLabel('动态验证码', { exact: true }).fill('000000');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText(GENERIC_FAILURE).waitFor();
    const unknown = await page.getByRole('alert').innerText();
    assert.equal(unknown.includes('nobody@example.invalid'), false, unknown);

    await page.getByLabel('账号', { exact: true }).fill(world.deploymentAdministrator.username);
    await page.getByLabel('密码', { exact: true }).fill('wrong-password-value');
    await page.getByLabel('动态验证码', { exact: true }).fill('000000');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText(GENERIC_FAILURE).waitFor();
    const wrongPassword = await page.getByRole('alert').innerText();
    assert.equal(wrongPassword, unknown);

    await page.getByLabel('密码', { exact: true }).fill(world.deploymentAdministrator.password);
    await page.getByLabel('动态验证码', { exact: true }).fill('');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText(GENERIC_FAILURE).waitFor();
    const missingMfa = await page.getByRole('alert').innerText();
    assert.equal(missingMfa, unknown);

    // A correct code signs the administrator in.
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(world.deploymentAdministrator.totp!));
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('heading', { name: '工作区' }).waitFor();
    assert.equal((await sessionBar(page).innerText()).includes(world.deploymentAdministrator.username), true);

    // Signing out ends the session without pretending it expired.
    await signOut(page);
    assert.equal(await page.getByText(SESSION_LOST).count(), 0);

    // A recovery code signs the same administrator in exactly once.
    await signInWithRecoveryCode(page, world.deploymentAdministrator, world.fixture.administrator.recovery_codes[0]!);
    await page.getByRole('heading', { name: '工作区' }).waitFor();
    await signOut(page);

    await signInWithRecoveryCode(page, world.deploymentAdministrator, world.fixture.administrator.recovery_codes[0]!);
    await page.getByText(GENERIC_FAILURE).waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** Next-request session revocation, observed in the browser. */
test('a revoked platform session returns the browser to sign-in on the very next request', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.consumer);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();

    const deactivated = command(world.fixture, ['user', 'deactivate', '--username', ANALYST], {
      token: world.administratorToken,
    });
    assert.equal(deactivated.status, 0, deactivated.stderr);

    await page.getByRole('button', { name: '刷新活动' }).click();
    await page.getByText(SESSION_LOST).waitFor();
    await page.getByRole('heading', { name: '登录数据中心' }).waitFor();

    // The deactivated credential keeps answering with the same generic failure.
    await signIn(page, world.consumer);
    await page.getByText(GENERIC_FAILURE).waitFor();
    assert.equal((await page.getByRole('alert').innerText()).includes('deactivated'), false);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** Two distinct navigation trees: deployment authority never opens Workspace content. */
test('Deployment and Workspace navigation are separate trees', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');

    await signIn(page, world.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区' }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '部署导航' }).count(), 1);
    assert.equal(await page.getByRole('navigation', { name: '工作区导航' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '数据产品' }).count(), 0);
    // Deployment-level governance lists the Workspace, and still shows no content.
    await page.getByRole('region', { name: '工作区' }).getByText('Operations').waitFor();
    const administration = await page.locator('body').innerText();
    assert.equal(administration.includes('refund_window'), false, administration);
    assert.equal(administration.includes('region_scope'), false, administration);
    await signOut(page);

    await signIn(page, world.workspaceAdministrator);
    // Two memberships: the shell requires an explicit choice before any content.
    await page.getByRole('heading', { name: '选择工作区' }).waitFor();
    await page.getByRole('button', { name: 'Operations', exact: true }).click();
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '部署导航' }).count(), 0);
    assert.equal(await page.getByRole('navigation', { name: '工作区导航' }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '概览' }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '数据产品' }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '业务上下文' }).count(), 1);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** A Deployment Administrator who also belongs to a Workspace keeps both trees. */
test('deployment navigation stays reachable from inside a Workspace', async () => {
  const world = deployment();
  const workspaceAdministratorToken = signInToken(world.fixture, world.workspaceAdministrator);
  const granted = command(
    world.fixture,
    [
      'membership', 'grant', '--workspace', world.operations,
      '--username', world.deploymentAdministrator.username, '--role', 'Consumer',
    ],
    { token: workspaceAdministratorToken },
  );
  assert.equal(granted.status, 0, granted.stderr);

  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');

    // One membership is selected by default, and the deployment tree stays.
    await signIn(page, world.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '部署导航' }).count(), 1);
    assert.equal(await page.getByRole('navigation', { name: '工作区导航' }).count(), 1);

    // Deployment navigation is its own destination, not a detour through the picker.
    await page.getByRole('link', { name: '工作区' }).click();
    await page.getByRole('heading', { name: '工作区' }).waitFor();
    assert.equal(page.url(), `${consoleServer.url}/app/deployment`);
    const administration = await page.getByRole('region', { name: '工作区' }).innerText();
    assert.equal(administration.includes('Operations'), true, administration);
    assert.equal(administration.includes('Isolation'), true, administration);
    assert.equal(administration.includes('refund_window'), false, administration);

    // The shell still offers the way back into an authorized Workspace.
    await page.getByLabel('选择工作区', { exact: true }).selectOption({ label: 'Operations' });
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.match(await sessionBar(page).innerText(), /Operations/u);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** Unauthorized navigation and object substitution fail closed without an existence leak. */
test('unauthorized Workspace navigation and object substitution fail closed without an existence leak', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.consumer);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();

    // Deep-linking a Workspace the Consumer is not a member of.
    await page.goto(`${consoleServer.url}/app/w/${world.isolation}/overview`);
    await page.getByRole('heading', { name: '工作区不可用' }).waitFor();
    const foreign = await page.getByRole('main').innerText();
    assert.equal(foreign.includes(WORKSPACE_UNAVAILABLE), true, foreign);
    assert.equal(foreign.includes('Isolation'), false, foreign);
    assert.equal(foreign.includes('region_scope'), false, foreign);

    // Substituting an identifier that names nothing answers identically.
    await page.goto(`${consoleServer.url}/app/w/${RANDOM_WORKSPACE}/overview`);
    await page.getByRole('heading', { name: '工作区不可用' }).waitFor();
    assert.equal(await page.getByRole('main').innerText(), foreign);

    const browserContext = page.context();
    const cookie = await cookieHeader(browserContext);
    const foreignCall = await callApi(
      consoleServer.url,
      `/api/workspace/data-products?workspace_id=${world.isolation}`,
      { cookie },
    );
    const missingCall = await callApi(
      consoleServer.url,
      `/api/workspace/data-products?workspace_id=${RANDOM_WORKSPACE}`,
      { cookie },
    );
    assert.equal(foreignCall.status, 403, foreignCall.text);
    assert.equal(foreignCall.body.code, 'WORKSPACE_ACCESS_DENIED');
    assert.deepEqual(foreignCall.body, missingCall.body);
    assert.equal(missingCall.status, foreignCall.status);

    // The same object stays served inside her own Workspace.
    const own = await callApi(
      consoleServer.url,
      `/api/workspace/data-products?workspace_id=${world.operations}`,
      { cookie },
    );
    assert.equal(own.status, 200, own.text);
    assert.equal(own.body.workspace_id, world.operations);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** Default selection, explicit selection, and no aggregation across Workspaces. */
test('one authorized Workspace is selected by default and multiple Workspaces require explicit selection', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');

    // A Consumer belongs to one Workspace, which the shell selects by itself.
    await signIn(page, world.consumer);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(page.url(), `${consoleServer.url}/app/w/${world.operations}/overview`);
    assert.match(await sessionBar(page).innerText(), /Operations/u);
    // Nothing about a Workspace she may not see leaks into the shell.
    const consumerText = await page.getByRole('main').innerText();
    assert.equal(consumerText.includes('Isolation'), false, consumerText);
    await signOut(page);

    // Two memberships require an explicit choice, and nothing is fetched first.
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await signIn(page, world.workspaceAdministrator);
    await page.getByRole('heading', { name: '选择工作区' }).waitFor();
    assert.equal(requests.some((url) => url.includes('/api/workspace/')), false);
    const picker = await page.getByRole('main').innerText();
    assert.equal(picker.includes('refund_window'), false, picker);
    assert.equal(picker.includes('region_scope'), false, picker);
    assert.equal(picker.includes('Operations'), true, picker);
    assert.equal(picker.includes('Isolation'), true, picker);

    // Selection is explicit, and each Workspace answers with its own content only.
    await page.getByRole('button', { name: 'Isolation', exact: true }).click();
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.match(await sessionBar(page).innerText(), /Isolation/u);
    await page.getByRole('link', { name: '业务上下文' }).click();
    const contextPanel = page.getByRole('region', { name: '业务上下文' });
    await contextPanel.getByText('region_scope').waitFor();
    assert.equal((await contextPanel.innerText()).includes('refund_window'), false);

    const workspaceRequests = requests.filter((url) => url.includes('/api/workspace/'));
    assert.equal(workspaceRequests.length > 0, true);
    for (const url of workspaceRequests) {
      assert.equal((url.match(/workspace_id=/gu) ?? []).length, 1, url);
      assert.match(url, new RegExp(world.isolation, 'u'));
    }

    await page.getByLabel('切换工作区', { exact: true }).selectOption({ label: 'Operations' });
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await page.getByRole('link', { name: '业务上下文' }).click();
    await contextPanel.getByText('refund_window').waitFor();
    assert.equal((await contextPanel.innerText()).includes('region_scope'), false);
    assert.match(await sessionBar(page).innerText(), /Operations/u);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** The persistent shell: active Workspace, session state, activity, attention. */
test('the active Workspace, session state, background activity and required attention stay visible', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.workspaceAdministrator);
    await page.getByRole('heading', { name: '选择工作区' }).waitFor();
    await page.getByRole('button', { name: 'Operations', exact: true }).click();
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();

    const activity = page.getByRole('complementary', { name: '活动中心' });
    const assertShell = async () => {
      const bar = await sessionBar(page).innerText();
      assert.match(bar, /当前工作区/u);
      assert.match(bar, /Operations/u);
      assert.match(bar, /当前角色/u);
      assert.match(bar, /工作区管理员/u);
      assert.match(bar, /会话到期/u);
      assert.equal(await activity.isVisible(), true);
      await activity.getByRole('region', { name: '后台活动' }).waitFor();
      await activity.getByRole('region', { name: '需要处理' }).waitFor();
      assert.equal(await activity.getByText('没有正在进行的后台活动。').isVisible(), true);
      assert.equal(await activity.getByText('没有需要处理的事项。').isVisible(), true);
    };
    await assertShell();

    await page.getByRole('link', { name: '数据产品' }).click();
    await page.getByRole('heading', { name: '数据产品' }).waitFor();
    await assertShell();

    await page.getByRole('link', { name: '业务上下文' }).click();
    await page.getByRole('heading', { name: '业务上下文' }).waitFor();
    await assertShell();

    await page.getByRole('link', { name: '概览' }).click();
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await assertShell();

    // No surface ships English copy.
    const body = await page.locator('body').innerText();
    for (const word of ['Sign in', 'Password', 'Workspace', 'Activity', 'Overview', 'Deployment', 'Refresh']) {
      assert.equal(body.includes(word), false, `${word} leaks into ${body}`);
    }
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** Every built-in Role, and accessible navigation. */
test('every built-in Role signs in and reaches only its authorized navigation', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');

    // Deployment Administrator: deployment navigation only.
    await signIn(page, world.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区' }).waitFor();
    assert.match(await sessionBar(page).innerText(), /部署管理员/u);
    await page.goto(`${consoleServer.url}/app/w/${world.operations}/overview`);
    await page.getByRole('heading', { name: '工作区不可用' }).waitFor();
    await page.goto(`${consoleServer.url}/app`);
    await signOut(page);

    // Workspace Administrator: an explicit choice, then Workspace navigation
    // including configuration.
    await signIn(page, world.workspaceAdministrator);
    await page.getByRole('heading', { name: '选择工作区' }).waitFor();
    await page.getByRole('button', { name: 'Operations', exact: true }).click();
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.match(await sessionBar(page).innerText(), /工作区管理员/u);
    assert.equal(await page.getByRole('link', { name: '业务上下文' }).count(), 1);
    await signOut(page);

    // Consumer: keyboard-only sign-in, Workspace navigation without configuration.
    await page.getByLabel('账号', { exact: true }).focus();
    await page.keyboard.type(ANALYST);
    await page.keyboard.press('Tab');
    await page.keyboard.type(ANALYST_PASSWORD);
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.match(await sessionBar(page).innerText(), /消费方/u);
    assert.equal(await page.getByRole('link', { name: '数据产品' }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '业务上下文' }).count(), 0);
    assert.equal(await page.getByRole('navigation', { name: '部署导航' }).count(), 0);

    // The active destination is announced, and the skip link reaches the content.
    assert.equal(await page.getByRole('link', { name: '概览' }).getAttribute('aria-current'), 'page');
    await page.getByRole('link', { name: '跳到主要内容' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('main').evaluate((element) => element === document.activeElement), true);

    // Workspace configuration stays closed to a Consumer over the HTTP surface too.
    const cookie = await cookieHeader(page.context());
    const configuration = await callApi(
      consoleServer.url,
      `/api/workspace/context?workspace_id=${world.operations}`,
      { cookie },
    );
    assert.equal(configuration.status, 403, configuration.text);
    assert.equal(configuration.body.code, 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** The platform User channel is not the Operator channel. */
test('a platform User session never opens the Operator Console', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.consumer);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();

    const operator = await callApi(consoleServer.url, '/api/operator/session', {
      cookie: await cookieHeader(page.context()),
    });
    assert.equal(operator.status, 401, operator.text);
    assert.equal(operator.body.code, 'OPERATOR_SESSION_INVALID');

    // The Operator surface still starts at its own sign-in, untouched.
    await page.goto(`${consoleServer.url}/`);
    await page.getByRole('heading', { name: '登录运维控制台' }).waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
