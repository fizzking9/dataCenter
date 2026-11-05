import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import { command, createUser, initializePlatform, jsonFile, sessionFor, type PlatformFixture } from '../support/platform.js';
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
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();

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
    await secondPage.getByRole('heading', { name: '工作区', exact: true }).waitFor();
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

/** AC1, AC4: accountable ownership moves between eligible Users before deactivation. */
test('ownership transfer keeps every Artifact accountable and unblocks deactivation', async () => {
  const world = deployment();
  const second = createUser(world.fixture, world.administratorToken, SECOND_ADMIN, SECOND_ADMIN_PASSWORD, true);
  const secondTotp = String(second.output.totp_secret);
  const published = command(world.fixture, ['context', 'publish-common', '--entries', jsonFile(world.fixture, 'common', [
    { key: 'refund_window_days', kind: 'metric', value: '30' },
  ])], { token: world.administratorToken });
  assert.equal(published.status, 0, published.stderr);

  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    await page.getByRole('link', { name: '用户与身份' }).click();
    const users = page.getByRole('region', { name: '用户' });
    await users.getByRole('cell', { name: world.deploymentAdministrator.username, exact: true }).waitFor();

    // The Deployment's common Business Context is owned by the administrator,
    // so deactivation is refused until that accountability moves.
    await users.getByRole('button', { name: `停用 ${world.deploymentAdministrator.username}` }).click();
    await confirmAction(page, '停用平台账号', '确认停用');
    await users.getByText(OWNER_TRANSFER_REQUIRED).waitFor();
    assert.match(await users.innerText(), /OWNER_TRANSFER_REQUIRED/u);

    // An ineligible recipient would leave the Artifact without an administrator.
    const ownership = page.getByRole('region', { name: '对象归属转移' });
    await ownership.getByLabel('原负责人', { exact: true }).fill(world.deploymentAdministrator.username);
    await ownership.getByLabel('新负责人', { exact: true }).fill(ANALYST);
    await ownership.getByRole('button', { name: '转移归属' }).click();
    const confirmation = page.getByRole('region', { name: '确认转移对象归属' });
    const stated = await confirmation.innerText();
    assert.match(stated, /影响/u);
    assert.match(stated, new RegExp(ANALYST.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    await confirmation.getByRole('button', { name: '确认转移' }).click();
    await ownership.getByText('新负责人不具备该对象的授权范围。').waitFor();

    // An eligible recipient takes accountability, and the roster reports it.
    await ownership.getByLabel('新负责人', { exact: true }).fill(SECOND_ADMIN);
    await ownership.getByRole('button', { name: '转移归属' }).click();
    await page.getByRole('region', { name: '确认转移对象归属' }).getByRole('button', { name: '确认转移' }).click();
    await ownership.getByText(`已转移 1 个对象的归属：${SECOND_ADMIN}。`).waitFor();

    // Deactivation now succeeds, while the recipient keeps the Artifact governed.
    // The second administrator performs it, so the acting session stays open.
    const secondPage = await open(browser, consoleServer.url, '/app');
    await signIn(secondPage, { username: SECOND_ADMIN, password: SECOND_ADMIN_PASSWORD, totp: secondTotp });
    await secondPage.getByRole('link', { name: '用户与身份' }).click();
    const secondUsers = secondPage.getByRole('region', { name: '用户' });
    await secondUsers.getByRole('cell', { name: world.deploymentAdministrator.username, exact: true }).waitFor();
    await secondUsers.getByRole('button', { name: `停用 ${world.deploymentAdministrator.username}` }).click();
    await confirmAction(secondPage, '停用平台账号', '确认停用');
    await secondUsers.getByText(`账号已停用：${world.deploymentAdministrator.username}，其会话已立即失效。`).waitFor();

    await page.getByRole('button', { name: '刷新活动' }).click();
    await page.getByText('会话已失效，请重新登录。').waitFor();

    // A deactivated account can never receive accountability again.
    const secondOwnership = secondPage.getByRole('region', { name: '对象归属转移' });
    await secondOwnership.getByLabel('原负责人', { exact: true }).fill(SECOND_ADMIN);
    await secondOwnership.getByLabel('新负责人', { exact: true }).fill(world.deploymentAdministrator.username);
    await secondOwnership.getByRole('button', { name: '转移归属' }).click();
    await secondPage.getByRole('region', { name: '确认转移对象归属' }).getByRole('button', { name: '确认转移' }).click();
    await secondOwnership.getByText('该账号已停用。').waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC1, AC3, AC4: Service Identities are internal executors, never consumers. */
test('Service Identities execute internal jobs but never consume, and revoke at once', async () => {
  const world = deployment();
  const agent = command(world.fixture, [
    'agent', 'create', '--name', 'agent-consumer', '--workspaces', world.operations, '--scopes', 'mcp:read',
  ], { token: world.administratorToken });
  assert.equal(agent.status, 0, agent.stderr);

  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, world.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    await page.getByRole('link', { name: '用户与身份' }).click();
    await page.getByRole('heading', { name: '服务身份', exact: true }).waitFor();
    const identities = page.getByRole('region', { name: '服务身份', exact: true });

    // Nothing is conflated: an Agent Identity is not a Service Identity.
    await identities.getByText('本部署尚未创建服务身份。').waitFor();
    assert.equal((await identities.innerText()).includes('agent-consumer'), false);

    // The form names the one Workspace the identity executes in.
    await identities.getByLabel('名称', { exact: true }).fill('ingest-job');
    await identities.getByLabel('Operations', { exact: true }).check();
    await identities.getByRole('button', { name: '创建服务身份' }).click();
    const confirmation = page.getByRole('region', { name: '确认创建服务身份', exact: true });
    const stated = await confirmation.innerText();
    assert.match(stated, /对象/u);
    assert.match(stated, /ingest-job/u);
    assert.match(stated, /不能消费数据产品/u);
    await confirmation.getByRole('button', { name: '确认创建' }).click();
    await identities.getByText('服务身份已创建：ingest-job。').waitFor();
    const row = identities.getByRole('row', { name: /ingest-job/u });
    await row.waitFor();
    assert.match(await row.innerText(), /生效中/u);
    assert.match(await row.innerText(), /执行作业，不读取数据产品/u);
    assert.match(await row.innerText(), /Operations/u);

    // The same name is refused, and an Agent Identity's name is refused too.
    await identities.getByLabel('名称', { exact: true }).fill('ingest-job');
    await identities.getByRole('button', { name: '创建服务身份' }).click();
    await page.getByRole('region', { name: '确认创建服务身份' }).getByRole('button', { name: '确认创建' }).click();
    await identities.getByText('该服务身份名称已存在。').waitFor();

    await identities.getByLabel('名称', { exact: true }).fill('agent-consumer');
    await identities.getByRole('button', { name: '创建服务身份' }).click();
    await page.getByRole('region', { name: '确认创建服务身份' }).getByRole('button', { name: '确认创建' }).click();
    await identities.getByText('服务身份不能与外部代理身份重名。').waitFor();

    // Revocation is immediate, idempotent, and keeps the record's history.
    await identities.getByRole('button', { name: '撤销 ingest-job' }).click();
    const revocation = page.getByRole('region', { name: '确认撤销服务身份' });
    assert.match(await revocation.innerText(), /立即不能执行任何作业/u);
    await revocation.getByRole('button', { name: '确认撤销' }).click();
    await identities.getByText('服务身份已撤销：ingest-job。').waitFor();
    assert.match(await row.innerText(), /已撤销/u);
    assert.equal(await identities.getByRole('button', { name: '撤销 ingest-job' }).count(), 0);

    const cookie = await cookieHeader(page.context());
    const granted = await callApi(consoleServer.url, '/api/deployment/service-identities', { cookie });
    assert.equal(granted.status, 200, granted.text);
    const listed = (granted.body.service_identities as Array<Record<string, unknown>>)[0];
    assert.deepEqual(listed?.['capabilities'], {
      executes_jobs: true,
      consumes_data_products: false,
      owns_artifacts: false,
    });
    const identityId = String(listed?.['service_identity_id']);
    const repeated = await callApi(consoleServer.url, `/api/deployment/service-identities/${identityId}/revoke`, {
      cookie,
      body: {},
    });
    assert.equal(repeated.status, 200, repeated.text);
    assert.equal(repeated.body.already_revoked, true);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC1, AC4, AC5: Workspace creation, emergency administration, and orphan safeguards. */
test('Workspace creation names a first administrator, and an emergency administrator prevents an orphan', async () => {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, OPERATIONS, OPERATIONS_PASSWORD);
  createUser(fixture, administratorToken, SUCCESSOR, SUCCESSOR_PASSWORD);
  const isolation = createUser(fixture, administratorToken, 'isolation@example.invalid', 'isolation-administrator');
  const isolationTotp = String(isolation.output.totp_secret);
  const deploymentAdministrator: Credentials = {
    username: fixture.administrator.username,
    password: fixture.administrator.password,
    totp: fixture.administrator.totp_secret,
  };

  const consoleServer = await startConsole(fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    const workspaces = page.getByRole('region', { name: '工作区', exact: true });
    await workspaces.getByText('尚未创建工作区。').waitFor();

    // A Workspace is created together with its first accountable administrator.
    await workspaces.getByLabel('工作区名称', { exact: true }).fill('Operations');
    await workspaces.getByLabel('第一位工作区管理员', { exact: true }).fill(OPERATIONS);
    await workspaces.getByRole('button', { name: '创建工作区' }).click();
    const creation = page.getByRole('region', { name: '确认创建工作区' });
    assert.match(await creation.innerText(), /第一位工作区管理员/u);
    await creation.getByRole('button', { name: '确认创建工作区' }).click();
    await workspaces.getByText('工作区已创建：Operations。').waitFor();
    const operationsRow = workspaces.getByRole('row', { name: /Operations/u });
    await operationsRow.waitFor();
    assert.match(await operationsRow.innerText(), /部署管理员/u);
    assert.equal(await operationsRow.getByRole('cell', { name: '1', exact: true }).count(), 1);

    // A duplicate name and an unknown administrator answer in Simplified Chinese.
    await workspaces.getByLabel('工作区名称', { exact: true }).fill('Operations');
    await workspaces.getByLabel('第一位工作区管理员', { exact: true }).fill(OPERATIONS);
    await workspaces.getByRole('button', { name: '创建工作区' }).click();
    await page.getByRole('region', { name: '确认创建工作区' }).getByRole('button', { name: '确认创建工作区' }).click();
    await workspaces.getByText('该工作区名称已存在。').waitFor();

    await workspaces.getByLabel('工作区名称', { exact: true }).fill('Isolation');
    await workspaces.getByLabel('第一位工作区管理员', { exact: true }).fill('nobody@example.invalid');
    await workspaces.getByRole('button', { name: '创建工作区' }).click();
    await page.getByRole('region', { name: '确认创建工作区' }).getByRole('button', { name: '确认创建工作区' }).click();
    await workspaces.getByText('该账号不存在。').waitFor();

    await workspaces.getByLabel('工作区名称', { exact: true }).fill('Isolation');
    await workspaces.getByLabel('第一位工作区管理员', { exact: true }).fill('isolation@example.invalid');
    await workspaces.getByRole('button', { name: '创建工作区' }).click();
    await page.getByRole('region', { name: '确认创建工作区' }).getByRole('button', { name: '确认创建工作区' }).click();
    await workspaces.getByText('工作区已创建：Isolation。').waitFor();

    // Deployment authority still opens no Workspace content, in either direction.
    const cookie = await cookieHeader(page.context());
    const listed = await callApi(consoleServer.url, '/api/deployment/workspaces', { cookie });
    assert.equal(listed.status, 200, listed.text);
    const rows = listed.body.workspaces as Array<{ workspace_id: string; name: string }>;
    const operationsId = rows.find((entry) => entry.name === 'Operations')?.workspace_id ?? '';
    const isolationId = rows.find((entry) => entry.name === 'Isolation')?.workspace_id ?? '';
    assert.notEqual(operationsId, '');
    assert.notEqual(isolationId, '');

    await page.goto(`${consoleServer.url}/app/w/${operationsId}/overview`);
    await page.getByRole('heading', { name: '工作区不可用' }).waitFor();
    const content = await callApi(consoleServer.url, `/api/workspace/context?workspace_id=${operationsId}`, { cookie });
    assert.equal(content.status, 403, content.text);
    assert.equal(content.body.code, 'WORKSPACE_ACCESS_DENIED');

    // A Workspace's only administrator cannot be deactivated: it would orphan it.
    await page.goto(`${consoleServer.url}/app/deployment/users`);
    const users = page.getByRole('region', { name: '用户' });
    await users.getByRole('cell', { name: 'isolation@example.invalid', exact: true }).waitFor();
    await users.getByRole('button', { name: '停用 isolation@example.invalid' }).click();
    await confirmAction(page, '停用平台账号', '确认停用');
    await users.getByText(LAST_ADMINISTRATOR).waitFor();

    // Emergency administration names exactly one Workspace and one account, and
    // never converts the acting Deployment Administrator's authority into access.
    await page.goto(`${consoleServer.url}/app/deployment`);
    const emergency = page.getByRole('region', { name: '任命紧急管理员' });
    await emergency.getByLabel('工作区', { exact: true }).selectOption({ label: 'Isolation' });
    await emergency.getByLabel('紧急管理员', { exact: true }).fill(deploymentAdministrator.username);
    await emergency.getByRole('button', { name: '任命紧急管理员' }).click();
    await page.getByRole('region', { name: '确认任命紧急管理员' }).getByRole('button', { name: '确认任命' }).click();
    await workspaces.getByText('部署管理员不能任命自己为工作区的紧急管理员。').waitFor();

    await emergency.getByLabel('紧急管理员', { exact: true }).fill('isolation@example.invalid');
    await emergency.getByRole('button', { name: '任命紧急管理员' }).click();
    await page.getByRole('region', { name: '确认任命紧急管理员' }).getByRole('button', { name: '确认任命' }).click();
    await workspaces.getByText('该账号已经是这个工作区的工作区管理员。').waitFor();

    await emergency.getByLabel('紧急管理员', { exact: true }).fill(SUCCESSOR);
    await emergency.getByRole('button', { name: '任命紧急管理员' }).click();
    const appointment = page.getByRole('region', { name: '确认任命紧急管理员' });
    const stated = await appointment.innerText();
    assert.match(stated, /Isolation/u);
    assert.match(stated, new RegExp(SUCCESSOR.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(stated, /影响/u);
    await appointment.getByRole('button', { name: '确认任命' }).click();
    await workspaces.getByText(`已任命 ${SUCCESSOR} 为 Isolation 的紧急管理员。`).waitFor();
    const enrollment = page.getByRole('region', { name: '一次性注册信息' });
    await enrollment.waitFor();
    const successorTotp = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(await enrollment.innerText())?.[1];
    assert.ok(successorTotp);
    const isolationRow = workspaces.getByRole('row', { name: /Isolation/u });
    assert.equal(await isolationRow.getByRole('cell', { name: '2', exact: true }).count(), 1);

    // With a second administrator the Workspace is no longer at risk, so the
    // departing administrator can be deactivated and one stays accountable.
    await page.goto(`${consoleServer.url}/app/deployment/users`);
    await users.getByRole('cell', { name: 'isolation@example.invalid', exact: true }).waitFor();
    await users.getByRole('button', { name: '停用 isolation@example.invalid' }).click();
    await confirmAction(page, '停用平台账号', '确认停用');
    await users.getByText('账号已停用：isolation@example.invalid，其会话已立即失效。').waitFor();

    const successorPage = await open(browser, consoleServer.url, '/app');
    await signIn(successorPage, { username: SUCCESSOR, password: SUCCESSOR_PASSWORD, totp: successorTotp });
    await successorPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.match(await successorPage.getByLabel('当前会话').innerText(), /Isolation/u);

    // The deactivated administrator keeps answering with the generic failure.
    const revokedPage = await open(browser, consoleServer.url, '/app');
    await signIn(revokedPage, { username: 'isolation@example.invalid', password: 'isolation-administrator', totp: isolationTotp });
    await revokedPage.getByText('登录失败：账号、密码或验证码不正确。').waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
