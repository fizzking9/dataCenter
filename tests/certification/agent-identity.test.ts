import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { grantAgent, createAgent, delegateAgent, issueAgentToken, registerAgentClient } from '../support/agents.js';
import { callApi, startConsole } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { callTool, listTools, mcpResult, requestToken, toolFailure, toolPayload } from '../support/mcp.js';
import {
  command,
  createUser,
  createWorkspace,
  initializePlatform,
  jsonFile,
  sessionFor,
  totpSecretFor,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const CLIENT_ID = 'https://agent.example.invalid/oauth/client.json';
const REDIRECT_URI = 'https://agent.example.invalid/callback';

interface Credentials {
  username: string;
  password: string;
  totp?: string;
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

async function confirmAction(page: Page, panel: string, label: string): Promise<void> {
  const confirmation = page.getByRole('region', { name: panel, exact: true });
  await confirmation.getByRole('button', { name: label }).click();
}

/** AC1, AC2, AC5: scoped identities, one-time client credentials, and next-request revocation. */
test('Deployment Administrators create scoped Agent Identities and revocation stops MCP at once', async () => {
  const product = publishLedgerProduct();
  const { fixture, workspaceId, workspaceAdministratorToken, dataProductId } = product;
  const consoleServer = await startConsole(fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    });
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    await page.getByRole('link', { name: '用户与身份' }).click();
    await page.getByRole('heading', { name: '外部代理身份', exact: true }).waitFor();
    const agents = page.getByRole('region', { name: '外部代理身份', exact: true });
    await agents.getByText('本部署尚未创建外部代理身份。').waitFor();

    // A malformed name is refused in Simplified Chinese before any identity exists.
    await agents.getByLabel('名称', { exact: true }).fill('a');
    await agents.getByLabel('Operations', { exact: true }).check();
    await agents.getByLabel('读取治理数据', { exact: true }).check();
    await agents.getByRole('button', { name: '创建代理身份' }).click();
    const creation = page.getByRole('region', { name: '确认创建外部代理身份', exact: true });
    const creationCopy = await creation.innerText();
    assert.match(creationCopy, /管理权限/u);
    assert.match(creationCopy, /原始数据/u);
    await creation.getByRole('button', { name: '确认创建' }).click();
    await agents.getByText('代理身份名称需要 2 到 128 个字符。').waitFor();

    // The identity binds one Workspace and only the read scope; it holds no
    // administrative or raw-data authority by construction.
    await agents.getByLabel('名称', { exact: true }).fill('certification-agent');
    assert.equal(await agents.getByLabel('自然语言问答', { exact: true }).isChecked(), false);
    await agents.getByRole('button', { name: '创建代理身份' }).click();
    await page.getByRole('region', { name: '确认创建外部代理身份', exact: true })
      .getByRole('button', { name: '确认创建' }).click();
    await agents.getByText('代理身份已创建：certification-agent。').waitFor();
    const row = agents.getByRole('row', { name: /^certification-agent /u });
    await row.waitFor();
    const rowCopy = await row.innerText();
    assert.match(rowCopy, /Operations/u);
    assert.match(rowCopy, /读取治理数据/u);
    assert.equal(rowCopy.includes('自然语言问答'), false);
    assert.match(rowCopy, /只读消费；无管理权限；无原始数据权限/u);

    const cookie = await cookieHeader(page.context());
    const listed = await callApi(consoleServer.url, '/api/deployment/agent-identities', { cookie });
    assert.equal(listed.status, 200, listed.text);
    const listedText = JSON.stringify(listed.body);
    assert.equal(listedText.includes('client_secret'), false);
    const agent = (listed.body.agent_identities as Array<Record<string, unknown>>)[0];
    assert.deepEqual(agent?.['scopes'], ['mcp:read']);
    assert.deepEqual(agent?.['capabilities'], {
      consumes_data_products: true,
      administrative_authority: false,
      raw_data_access: false,
      owns_artifacts: false,
    });
    const agentId = String(agent?.['agent_identity_id']);

    // A duplicate name cannot become a second identity with different authority.
    await agents.getByLabel('名称', { exact: true }).fill('certification-agent');
    await agents.getByRole('button', { name: '创建代理身份' }).click();
    await page.getByRole('region', { name: '确认创建外部代理身份', exact: true })
      .getByRole('button', { name: '确认创建' }).click();
    await agents.getByText('该代理身份名称已存在。').waitFor();

    // A pre-registered client is the autonomous access configuration. Its secret
    // is shown exactly once and never returned by any later view.
    const clients = page.getByRole('region', { name: '自主访问 OAuth 客户端', exact: true });
    await clients.getByLabel('代理身份', { exact: true }).selectOption({ label: 'certification-agent' });
    await clients.getByLabel('客户端标识', { exact: true }).fill(CLIENT_ID);
    await clients.getByLabel('客户端名称', { exact: true }).fill('Certification Agent');
    await clients.getByLabel('重定向地址', { exact: true }).fill(REDIRECT_URI);
    await clients.getByRole('button', { name: '注册 OAuth 客户端' }).click();
    await confirmAction(page, '确认注册 OAuth 客户端', '确认注册');
    const oneTime = page.getByRole('region', { name: '一次性客户端密钥', exact: true });
    await oneTime.waitFor();
    const oneTimeCopy = await oneTime.innerText();
    const clientSecret = /客户端密钥\s*\n+\s*([A-Za-z0-9_-]{20,})/u.exec(oneTimeCopy)?.[1];
    assert.ok(clientSecret, oneTimeCopy);
    assert.match(await clients.innerText(), /https:\/\/agent\.example\.invalid\/oauth\/client\.json/u);

    await page.getByRole('link', { name: '工作区', exact: true }).click();
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes(clientSecret), false);

    const afterListing = await callApi(consoleServer.url, '/api/deployment/agent-identities', { cookie });
    assert.equal(afterListing.status, 200, afterListing.text);
    assert.equal(afterListing.text.includes(clientSecret), false);
    assert.equal(afterListing.text.includes('client_secret_hash'), false);
    const client = ((afterListing.body.agent_identities as Array<Record<string, unknown>>)[0]?.['clients'] as Array<Record<string, unknown>>)[0];
    assert.equal(client?.['client_id'], CLIENT_ID);

    // The scope is a ceiling: the client can mint mcp:read but never mcp:nlq.
    const resource = `${consoleServer.url}/mcp`;
    const granted = await requestToken(consoleServer.url, {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      resource,
      scope: 'mcp:read',
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    const accessToken = String(granted.body['access_token']);
    const escalated = await requestToken(consoleServer.url, {
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      resource,
      scope: 'mcp:nlq',
    });
    assert.equal(escalated.status, 400);
    assert.equal(escalated.body['error'], 'invalid_scope');

    const tools = await listTools(consoleServer.url, accessToken);
    assert.equal(tools.status, 200, tools.text);
    const names = ((mcpResult(tools)['tools'] ?? []) as Array<Record<string, unknown>>).map((tool) => tool['name']);
    assert.equal(names.includes('query_data_product'), true);
    assert.equal(names.includes('ask_natural_language_query'), false);

    // A Grant issued by the Workspace Administrator is the second ceiling.
    const grantedProduct = grantAgent(fixture, workspaceAdministratorToken, dataProductId, agentId, {
      columns: ['sn', 'city'],
    });
    assert.equal(grantedProduct.status, 0, grantedProduct.stderr);
    const answered = await callTool(consoleServer.url, accessToken, 'query_data_product', {
      workspace_id: workspaceId,
      data_product_id: dataProductId,
      query: { kind: 'records' },
    });
    assert.equal(mcpResult(answered)['isError'], undefined, answered.text);
    assert.deepEqual(toolPayload(answered)['columns'], ['sn', 'city']);

    // Revocation is visible and effective on the very next MCP request.
    await page.getByRole('link', { name: '用户与身份' }).click();
    await agents.getByRole('row', { name: /^certification-agent /u }).waitFor();
    await agents.getByRole('button', { name: '撤销 certification-agent' }).click();
    const revocation = page.getByRole('region', { name: '确认撤销代理身份', exact: true });
    assert.match(await revocation.innerText(), /下一次调用即被拒绝/u);
    await revocation.getByRole('button', { name: '确认撤销' }).click();
    await agents.getByText('代理身份已撤销：certification-agent。').waitFor();
    await agents.getByText('已撤销', { exact: true }).waitFor();
    assert.equal(await agents.getByRole('button', { name: '撤销 certification-agent' }).count(), 0);

    const stopped = await listTools(consoleServer.url, accessToken);
    assert.equal(stopped.status, 401);
    assert.equal(stopped.body['code'], 'MCP_AGENT_REVOKED');

    // A Consumer cannot read or manage deployment-scoped Agent Identities.
    const consumerCookies = await signInAs(browser, consoleServer.url, {
      username: 'analyst@example.invalid',
      password: 'analyst-consumer',
    });
    const forbidden = await callApi(consoleServer.url, '/api/deployment/agent-identities', { cookie: consumerCookies });
    assert.equal(forbidden.status, 403, forbidden.text);
    assert.equal(forbidden.body['code'], 'AUTHORIZATION_DENIED');

    // Every surface this ticket adds reads in Simplified Chinese only.
    const body = await page.locator('body').innerText();
    for (const word of ['Create', 'Revoke', 'Scope', 'Workspace', 'Client', 'Agent Identity']) {
      assert.equal(body.includes(word), false, `${word} leaks into ${body}`);
    }
    const clientPanelCopy = await clients.innerText();
    assert.equal(clientPanelCopy.includes(clientSecret), false);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

async function signInAs(browser: Browser, url: string, credentials: Credentials): Promise<string> {
  const page = await open(browser, url, '/app');
  await signIn(page, credentials);
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  return cookieHeader(page.context());
}

function credentialsOf(fixture: ReturnType<typeof publishLedgerProduct>['fixture']): Credentials {
  return {
    username: fixture.administrator.username,
    password: fixture.administrator.password,
    totp: fixture.administrator.totp_secret,
  };
}

/**
 * AC2, AC3, AC5: one Workspace Administrator narrows an Agent Identity and
 * records delegated consent; the effective authority is the intersection, and
 * every revocation binds the very next MCP request while both identities stay
 * attributable in the Workspace audit view.
 */
test('Workspace grants and delegated consent intersect, and revocation stops the next call', async () => {
  const product = publishLedgerProduct();
  const {
    fixture,
    workspaceId,
    deploymentAdministratorToken,
    workspaceAdministratorToken,
    consumerToken,
    dataProductId,
  } = product;
  const agentId = createAgent(fixture, deploymentAdministratorToken, workspaceId);
  const client = registerAgentClient(fixture, deploymentAdministratorToken, agentId);
  const delegation = delegateAgent(fixture, consumerToken, agentId, workspaceId);

  // The delegated User's own Grant is narrower than the Agent's: the delegated
  // read must carry only the intersection of both column sets.
  const memberGrant = command(fixture, [
    'grant', 'publish', '--product', dataProductId, '--username', 'analyst@example.invalid',
    '--request', jsonFile(fixture, 'analyst-agent-narrowing', { columns: ['sn'] }),
  ], { token: workspaceAdministratorToken });
  assert.equal(memberGrant.status, 0, memberGrant.stderr);

  createUser(fixture, deploymentAdministratorToken, 'isolation@example.invalid', 'isolation-administrator');
  const isolationId = createWorkspace(fixture, deploymentAdministratorToken, 'Isolation', 'isolation@example.invalid');

  const consoleServer = await startConsole(fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, {
      username: 'operations@example.invalid',
      password: 'operations-administrator',
      totp: totpSecretOf(fixture, 'operations@example.invalid'),
    });
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await page.getByRole('link', { name: '代理授权', exact: true }).click();
    await page.getByRole('heading', { name: '代理授权', exact: true }).waitFor();
    const access = page.getByRole('region', { name: '代理授权', exact: true });

    // The Agent Identity is visible only in the Workspace it is bound to, with
    // its scope ceiling and the delegated consent already on record.
    const agentRow = access.getByRole('row', { name: /^certification-agent/u });
    await agentRow.waitFor();
    assert.match(await agentRow.innerText(), /读取治理数据/u);
    assert.match(await agentRow.innerText(), /尚无数据产品授权/u);
    assert.match(await agentRow.innerText(), /analyst@example\.invalid（消费方）：生效中/u);
    assert.match(await access.innerText(), /交集/u);

    // A field the Contract does not publish is refused in Simplified Chinese.
    const grantPanel = page.getByRole('region', { name: '发布数据产品授权', exact: true });
    await grantPanel.getByLabel('代理身份', { exact: true }).selectOption({ label: 'certification-agent' });
    await grantPanel.getByLabel('数据产品', { exact: true }).selectOption({ label: '设备维修台账' });
    await grantPanel.getByLabel('允许字段', { exact: true }).fill('not_a_published_field');
    await grantPanel.getByRole('button', { name: '发布授权' }).click();
    await confirmAction(page, '确认发布数据产品授权', '确认发布');
    await access.getByText('允许字段必须是此数据产品契约发布的字段。').waitFor();

    // The real Grant names two fields and one typed row predicate.
    await grantPanel.getByLabel('允许字段', { exact: true }).fill('sn, city');
    await grantPanel.getByLabel('行筛选（JSON）', { exact: true })
      .fill('[{"field":"city","op":"equals","value":"上海"}]');
    await grantPanel.getByRole('button', { name: '发布授权' }).click();
    await confirmAction(page, '确认发布数据产品授权', '确认发布');
    await access.getByText('已为 certification-agent 发布 设备维修台账 的数据产品授权。').waitFor();
    const grantRow = access.getByRole('row', { name: /设备维修台账/u }).first();
    assert.match(await grantRow.innerText(), /字段：sn、city/u);
    assert.match(await grantRow.innerText(), /行筛选/u);

    // The Workspace Administrator records their own consent through the browser;
    // repeating it is idempotent and says so.
    const delegationPanel = page.getByRole('region', { name: '委托同意', exact: true });
    await delegationPanel.getByLabel('代理身份', { exact: true }).selectOption({ label: 'certification-agent' });
    await delegationPanel.getByRole('button', { name: '记录我的委托同意' }).click();
    await confirmAction(page, '确认记录委托同意', '确认记录');
    await access.getByText('已记录委托同意：certification-agent。').waitFor();
    await delegationPanel.getByRole('button', { name: '记录我的委托同意' }).click();
    await confirmAction(page, '确认记录委托同意', '确认记录');
    await access.getByText('该委托同意已存在且生效。').waitFor();

    const cookie = await cookieHeader(page.context());
    const listed = await callApi(consoleServer.url, `/api/workspace/agents?workspace_id=${workspaceId}`, { cookie });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.text.includes(client.client_secret), false);
    assert.equal(listed.text.includes('client_secret'), false);

    // Autonomous access reads the Agent's Grant; delegated access reads only
    // what both the Agent and the delegated User may see, in the same Workspace.
    const autonomousToken = await issueAgentToken(consoleServer.url, client);
    const delegatedToken = await issueAgentToken(consoleServer.url, client, 'mcp:read', delegation.delegation_id);
    const query = {
      workspace_id: workspaceId,
      data_product_id: dataProductId,
      query: { kind: 'records' },
    };
    const autonomousAnswer = await callTool(consoleServer.url, autonomousToken, 'query_data_product', query);
    assert.equal(mcpResult(autonomousAnswer)['isError'], undefined, autonomousAnswer.text);
    assert.deepEqual(toolPayload(autonomousAnswer)['columns'], ['sn', 'city']);
    assert.deepEqual(toolPayload(autonomousAnswer)['records'], [{ sn: 'sn-002', city: '上海' }]);
    const delegatedAnswer = await callTool(consoleServer.url, delegatedToken, 'query_data_product', query);
    assert.equal(mcpResult(delegatedAnswer)['isError'], undefined, delegatedAnswer.text);
    assert.deepEqual(toolPayload(delegatedAnswer)['columns'], ['sn']);
    assert.deepEqual(toolPayload(delegatedAnswer)['records'], [{ sn: 'sn-002' }]);

    // Explicit Workspace selection: the Agent is refused another Workspace and
    // the refusal is a governed result, not an existence disclosure.
    const crossWorkspace = await callTool(consoleServer.url, autonomousToken, 'discover_data_products', {
      workspace_id: isolationId,
    });
    assert.equal(mcpResult(crossWorkspace)['isError'], true, crossWorkspace.text);
    assert.equal(toolFailure(crossWorkspace).code, 'WORKSPACE_ACCESS_DENIED');

    // Both identities remain attributable; the view never carries secrets or tokens.
    await page.getByRole('link', { name: '审计', exact: true }).click();
    await page.getByRole('heading', { name: '审计事件', exact: true }).waitFor();
    const attributed = page.getByRole('row').filter({ hasText: 'agent:certification-agent' })
      .filter({ hasText: 'analyst@example.invalid' });
    await attributed.first().waitFor();
    const auditBody = await page.locator('body').innerText();
    assert.equal(auditBody.includes(client.client_secret), false);
    assert.equal(auditBody.includes(autonomousToken), false);
    assert.equal(auditBody.includes(delegatedToken), false);
    assert.match(auditBody, /委托用户/u);

    // Revoking the delegated consent stops the delegated token immediately,
    // without disturbing the Agent Identity's own authority.
    await page.getByRole('link', { name: '代理授权', exact: true }).click();
    await page.getByRole('heading', { name: '代理授权', exact: true }).waitFor();
    const analystDelegation = page.getByRole('region', { name: '委托同意', exact: true })
      .getByRole('row').filter({ hasText: 'analyst@example.invalid' }).first();
    await analystDelegation.getByRole('button', { name: '撤销委托' }).click();
    await confirmAction(page, '确认撤销委托同意', '确认撤销');
    await access.getByText('委托同意已撤销：analyst@example.invalid。').waitFor();
    const delegatedStopped = await callTool(consoleServer.url, delegatedToken, 'query_data_product', query);
    assert.equal(delegatedStopped.status, 401);
    assert.equal(delegatedStopped.body['code'], 'MCP_DELEGATION_REVOKED');
    const stillAutonomous = await callTool(consoleServer.url, autonomousToken, 'query_data_product', query);
    assert.equal(mcpResult(stillAutonomous)['isError'], undefined, stillAutonomous.text);

    // Withdrawing the Grant refuses the next autonomous read the same way.
    const grantToRevoke = access.getByRole('row')
      .filter({ hasText: '设备维修台账' })
      .filter({ has: page.getByRole('button', { name: '撤销授权' }) })
      .first();
    await grantToRevoke.getByRole('button', { name: '撤销授权' }).click();
    await confirmAction(page, '确认撤销数据产品授权', '确认撤销');
    await access.getByText('数据产品授权已撤销。').waitFor();
    const grantStopped = await callTool(consoleServer.url, autonomousToken, 'query_data_product', query);
    assert.equal(mcpResult(grantStopped)['isError'], true, grantStopped.text);
    assert.equal(toolFailure(grantStopped).code, 'DATA_PRODUCT_NOT_AVAILABLE');

    // Workspace access is server-authorized: neither the Deployment Administrator
    // nor a Consumer can read this Workspace's Agent grants and consents.
    const administratorPage = await open(browser, consoleServer.url, '/app');
    await signIn(administratorPage, credentialsOf(fixture));
    await administratorPage.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    const administratorCookies = await cookieHeader(administratorPage.context());
    const deploymentRead = await callApi(consoleServer.url, `/api/workspace/agents?workspace_id=${workspaceId}`, {
      cookie: administratorCookies,
    });
    assert.equal(deploymentRead.status, 403, deploymentRead.text);
    assert.equal(deploymentRead.body['code'], 'WORKSPACE_ACCESS_DENIED');
    await administratorPage.goto(`${consoleServer.url}/app/w/${workspaceId}/agents`);
    await administratorPage.getByRole('heading', { name: '工作区不可用' }).waitFor();

    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, { username: 'analyst@example.invalid', password: 'analyst-consumer' });
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '代理授权' }).count(), 0);
    const consumerCookies = await cookieHeader(consumerPage.context());
    const consumerRead = await callApi(consoleServer.url, `/api/workspace/agents?workspace_id=${workspaceId}`, {
      cookie: consumerCookies,
    });
    assert.equal(consumerRead.status, 403, consumerRead.text);
    assert.equal(consumerRead.body['code'], 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

function totpSecretOf(fixture: ReturnType<typeof publishLedgerProduct>['fixture'], username: string): string {
  return totpSecretFor(fixture, username);
}

/** AC5: an unbound Workspace never reveals another Workspace's Agent Identity. */
test('Workspace Agent access is empty and isolated until an identity is bound there', async () => {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, 'operations@example.invalid', 'operations-administrator');
  const operations = command(
    fixture,
    ['workspace', 'create', '--name', 'Operations', '--administrator', 'operations@example.invalid'],
    { token: administratorToken },
  );
  assert.equal(operations.status, 0, operations.stderr);
  createUser(fixture, administratorToken, 'isolation@example.invalid', 'isolation-administrator');
  const isolation = command(
    fixture,
    ['workspace', 'create', '--name', 'Isolation', '--administrator', 'isolation@example.invalid'],
    { token: administratorToken },
  );
  assert.equal(isolation.status, 0, isolation.stderr);
  const isolationId = String(isolation.output.workspace_id);
  createAgent(fixture, administratorToken, String(operations.output.workspace_id));

  const consoleServer = await startConsole(fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, {
      username: 'isolation@example.invalid',
      password: 'isolation-administrator',
      totp: String(isolation.output.totp_secret),
    });
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await page.getByRole('link', { name: '代理授权', exact: true }).click();
    await page.getByRole('heading', { name: '代理授权', exact: true }).waitFor();
    await page.getByText('本工作区尚无绑定到此处的外部代理身份。').waitFor();
    assert.equal((await page.locator('body').innerText()).includes('certification-agent'), false);

    const cookie = await cookieHeader(page.context());
    const listed = await callApi(consoleServer.url, `/api/workspace/agents?workspace_id=${isolationId}`, { cookie });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body['agents'], []);
    const foreign = await callApi(consoleServer.url, `/api/workspace/agents?workspace_id=${String(operations.output.workspace_id)}`, { cookie });
    assert.equal(foreign.status, 403, foreign.text);
    assert.equal(foreign.body['code'], 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
