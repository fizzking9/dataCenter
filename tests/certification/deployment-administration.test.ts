import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import { command, createUser, initializePlatform, sessionFor, type PlatformFixture } from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const SUCCESSOR = 'successor@example.invalid';
const SUCCESSOR_PASSWORD = 'successor-password';
const SECOND_ADMIN = 'second-admin@example.invalid';
const SECOND_ADMIN_PASSWORD = 'second-administrator';
const RANDOM_WORKSPACE = '00000000-0000-4000-8000-000000000000';

const LAST_ADMINISTRATOR = '最后一名生效中的管理员不能被停用、移除或降级。';
const USERNAME_INVALID = '账号必须是形如 name@domain 的账号标识。';
const OWNER_TRANSFER_REQUIRED = '该账号名下仍有对象，请先转移归属。';

interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

interface World {
  fixture: PlatformFixture;
  administratorToken: string;
  deploymentAdministrator: Credentials;
  operations: string;
}

/** One open Deployment with a Workspace whose only administrator is a human User. */
function deployment(): World {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, OPERATIONS, OPERATIONS_PASSWORD);
  createUser(fixture, administratorToken, ANALYST, ANALYST_PASSWORD);
  const workspace = command(
    fixture,
    ['workspace', 'create', '--name', 'Operations', '--administrator', OPERATIONS],
    { token: administratorToken },
  );
  assert.equal(workspace.status, 0, workspace.stderr);
  return {
    fixture,
    administratorToken,
    deploymentAdministrator: {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    },
    operations: String(workspace.output.workspace_id),
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

/** Confirms the one pending consequential action, after checking what it names. */
async function confirmAction(page: Page, panel: string, label: string): Promise<void> {
  const confirmation = page.getByRole('region', { name: panel });
  await confirmation.getByRole('button', { name: label }).click();
}

/** AC1, AC4, AC5: account lifecycle, last-administrator safeguard, and next-request revocation. */
test('Deployment Administrator accounts create, refuse the last administrator, and revoke at once', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区' }).waitFor();

    // Deployment-only navigation reaches identity management; no Workspace tree appears.
    assert.equal(await page.getByRole('navigation', { name: '部署导航' }).count(), 1);
    assert.equal(await page.getByRole('navigation', { name: '工作区导航' }).count(), 0);
    await page.getByRole('link', { name: '用户与身份' }).click();
    await page.getByRole('heading', { name: '用户' }).waitFor();
    const users = page.getByRole('region', { name: '用户' });
    await users.getByRole('cell', { name: OPERATIONS, exact: true }).waitFor();
    const listing = await users.innerText();
    assert.match(listing, /部署管理员/u);
    assert.match(listing, /工作区管理员/u);
    assert.match(listing, /启用/u);
    // Governance metadata never becomes Workspace business content.
    assert.equal(await users.getByRole('cell', { name: 'Operations', exact: true }).count(), 1);

    // The only active Deployment Administrator cannot be deactivated, and the
    // refusal names the exact target before it is attempted.
    const administratorDeactivate = `停用 ${world.deploymentAdministrator.username}`;
    await users.getByRole('button', { name: administratorDeactivate }).click();
    const deactivation = page.getByRole('region', { name: '停用平台账号' });
    const consequence = await deactivation.innerText();
    assert.match(consequence, /对象/u);
    assert.match(consequence, new RegExp(world.deploymentAdministrator.username.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(consequence, /范围/u);
    assert.match(consequence, /影响/u);
    await deactivation.getByRole('button', { name: '取消' }).click();
    assert.equal(await page.getByRole('region', { name: '停用平台账号' }).count(), 0);

    await users.getByRole('button', { name: administratorDeactivate }).click();
    await confirmAction(page, '停用平台账号', '确认停用');
    await users.getByText(LAST_ADMINISTRATOR).waitFor();
    assert.equal((await users.innerText()).includes('LAST_ADMINISTRATOR_PROTECTED'), true);

    // Chinese validation for a malformed account identifier.
    await users.getByLabel('账号', { exact: true }).fill('not-an-account');
    await users.getByLabel('初始密码', { exact: true }).fill(SUCCESSOR_PASSWORD);
    await users.getByRole('button', { name: '创建账号' }).click();
    const creation = page.getByRole('region', { name: '确认创建平台账号' });
    assert.match(await creation.innerText(), /影响/u);
    await confirmAction(page, '确认创建平台账号', '确认创建');
    await users.getByText(USERNAME_INVALID).waitFor();

    // A valid account is created, and the roster reloads with it.
    await users.getByLabel('账号', { exact: true }).fill(SUCCESSOR);
    await users.getByLabel('初始密码', { exact: true }).fill(SUCCESSOR_PASSWORD);
    await users.getByRole('button', { name: '创建账号' }).click();
    await confirmAction(page, '确认创建平台账号', '确认创建');
    await users.getByText(`账号已创建：${SUCCESSOR}。`).waitFor();
    await users.getByRole('cell', { name: SUCCESSOR, exact: true }).waitFor();

    // A second Deployment Administrator is enrolled once, in Simplified Chinese.
    await users.getByLabel('账号', { exact: true }).fill(SECOND_ADMIN);
    await users.getByLabel('初始密码', { exact: true }).fill(SECOND_ADMIN_PASSWORD);
    await users.getByLabel('授予部署管理员', { exact: true }).check();
    await users.getByRole('button', { name: '创建账号' }).click();
    const administratorCreation = await page.getByRole('region', { name: '确认创建平台账号' }).innerText();
    assert.match(administratorCreation, /部署级管理权限/u);
    await confirmAction(page, '确认创建平台账号', '确认创建');
    const enrollment = page.getByRole('region', { name: '一次性注册信息' });
    await enrollment.waitFor();
    const totpSecret = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(await enrollment.innerText())?.[1];
    assert.ok(totpSecret);
    assert.match(await enrollment.innerText(), /恢复码/u);

    // A consumer signs in and is revoked by the administrator, effective at once.
    const successorPage = await open(browser, consoleServer.url, '/app');
    await signIn(successorPage, { username: SUCCESSOR, password: SUCCESSOR_PASSWORD });
    await successorPage.getByText('当前账号尚未加入任何工作区，请联系部署管理员。').waitFor();

    const secondPage = await open(browser, consoleServer.url, '/app');
    await signIn(secondPage, { username: SECOND_ADMIN, password: SECOND_ADMIN_PASSWORD, totp: totpSecret });
    await secondPage.getByRole('heading', { name: '工作区' }).waitFor();
    await secondPage.getByRole('link', { name: '用户与身份' }).click();
    const secondUsers = secondPage.getByRole('region', { name: '用户' });
    await secondUsers.getByRole('cell', { name: SUCCESSOR, exact: true }).waitFor();

    await secondUsers.getByRole('button', { name: `停用 ${SUCCESSOR}` }).click();
    await confirmAction(secondPage, '停用平台账号', '确认停用');
    await secondUsers.getByText(`账号已停用：${SUCCESSOR}，其会话已立即失效。`).waitFor();

    await successorPage.getByRole('button', { name: '刷新活动' }).click();
    await successorPage.getByText('会话已失效，请重新登录。').waitFor();

    // With a second active administrator the first can be deactivated, and the
    // deactivated administrator's own browser session ends on its next request.
    await secondUsers.getByRole('button', { name: administratorDeactivate }).click();
    await confirmAction(secondPage, '停用平台账号', '确认停用');
    await secondUsers.getByText(`账号已停用：${world.deploymentAdministrator.username}，其会话已立即失效。`).waitFor();

    await page.getByRole('button', { name: '刷新活动' }).click();
    await page.getByText('会话已失效，请重新登录。').waitFor();

    // Every surface this ticket adds reads in Simplified Chinese only.
    const secondBody = await secondPage.locator('body').innerText();
    for (const word of ['Users', 'Account', 'Password', 'Deactivate', 'Create', 'Service Identity']) {
      assert.equal(secondBody.includes(word), false, `${word} leaks into ${secondBody}`);
    }
    assert.equal((await secondUsers.innerText()).includes(SUCCESSOR_PASSWORD), false);

    // The roster the browser read is the same authorized contract the API serves.
    const permitted = await callApi(consoleServer.url, '/api/deployment/users', {
      cookie: await cookieHeader(secondPage.context()),
    });
    assert.equal(permitted.status, 200, permitted.text);
    assert.equal((permitted.text.includes(SECOND_ADMIN_PASSWORD)), false);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
