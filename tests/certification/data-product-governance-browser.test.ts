import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import {
  command,
  createUser,
  createWorkspace,
  grantRole,
  initializePlatform,
  jsonFile,
  sessionFor,
  textFile,
  totpSecretFor,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const ADMIN = 'operations@example.invalid';
const ADMIN_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const OUTSIDER = 'outsider@example.invalid';
const OUTSIDER_PASSWORD = 'outsider-administrator';

const PRODUCT_NAME = '设备处理量台账';

const LEDGER = [
  '设备SN,城市,处理量,负责人',
  'sn-001,杭州,3,张三',
  'sn-002,上海,5,李四',
  'sn-003,杭州,2,王五',
  'sn-004,上海,7,张三',
  'sn-005,杭州,4,李四',
  '',
].join('\n');

const LEDGER_NEXT = LEDGER.replace('sn-001,杭州,3', 'sn-001,杭州,9');

const INTEGRATION = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
    { name: 'owner', type: 'string' },
  ],
  cleaning: [{ rule: 'trim', field: 'sn' }, { rule: 'uppercase', field: 'sn' }],
  mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count', 负责人: 'owner' },
};

const CONTRACT = {
  title: '设备处理量',
  fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }],
  dimensions: ['city'],
  metrics: [
    { name: 'device_count', aggregation: 'count', value_type: 'integer' },
    { name: 'handled_total', aggregation: 'sum', field: 'handled_count', value_type: 'integer' },
  ],
  grain: ['sn'],
  filters: ['city'],
  limit: { default: 100, max: 500 },
};

/** The additive change: one exposed field, one dimension, and one filter are added. */
const ADDITIVE_CONTRACT = {
  ...CONTRACT,
  fields: [{ name: 'sn' }, { name: 'city' }, { name: 'handled_count' }, { name: 'owner' }],
  dimensions: ['city', 'owner'],
  filters: ['city', 'owner'],
};

/** The breaking change: a published field and the metric reading it are withdrawn. */
const BREAKING_CONTRACT = {
  ...CONTRACT,
  fields: [{ name: 'sn' }, { name: 'city' }],
  metrics: [{ name: 'device_count', aggregation: 'count', value_type: 'integer' }],
};

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  deploymentToken: string;
  workspaceToken: string;
  consumerToken: string;
  sourceId: string;
  productId: string;
}

function acquireAndRelease(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  content: string,
  name: string,
): void {
  const uploaded = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, name, content)],
    { token },
  );
  assert.equal(uploaded.status, 0, uploaded.stderr);
  const released = command(fixture, ['dataset', 'release', '--source', sourceId], { token });
  assert.equal(released.status, 0, released.stderr);
}

function publishProduct(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  contract: Record<string, unknown>,
): Record<string, unknown> {
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', PRODUCT_NAME, '--contract', jsonFile(fixture, 'contract', contract)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  return published.output;
}

/** One Deployment, one Workspace with a Consumer, and one published Data Product. */
function world(options: { releases?: number } = {}): World {
  const fixture = initializePlatform();
  const deploymentToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, deploymentToken, ADMIN, ADMIN_PASSWORD);
  const workspaceId = createWorkspace(fixture, deploymentToken, '运营中心', ADMIN);
  const workspaceToken = sessionFor(fixture, ADMIN, ADMIN_PASSWORD);
  createUser(fixture, deploymentToken, ANALYST, ANALYST_PASSWORD);
  grantRole(fixture, workspaceToken, workspaceId, ANALYST, 'Consumer');
  const consumerToken = sessionFor(fixture, ANALYST, ANALYST_PASSWORD);

  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceToken },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output.source_id);
  const configuration = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration', INTEGRATION)],
    { token: workspaceToken },
  );
  assert.equal(configuration.status, 0, configuration.stderr);
  command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(configuration.output.integration_configuration_version)],
    { token: workspaceToken },
  );

  acquireAndRelease(fixture, workspaceToken, sourceId, LEDGER, 'ledger.csv');
  let publication = publishProduct(fixture, workspaceToken, sourceId, CONTRACT);
  for (let index = 1; index < (options.releases ?? 1); index += 1) {
    acquireAndRelease(fixture, workspaceToken, sourceId, LEDGER_NEXT, `ledger-${index}.csv`);
    publication = publishProduct(fixture, workspaceToken, sourceId, CONTRACT);
  }

  return {
    fixture,
    workspaceId,
    deploymentToken,
    workspaceToken,
    consumerToken,
    sourceId,
    productId: String(publication['data_product_id']),
  };
}

async function signIn(page: Page, username: string, password: string, totp: string | null): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  if (totp !== null) {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/** The enrollment secret an administrator received, or null for a Consumer without MFA. */
function optionalTotpFor(current: World, username: string): string | null {
  try {
    return totpSecretFor(current.fixture, username);
  } catch {
    return null;
  }
}

async function signInAs(page: Page, current: World, username: string, password: string): Promise<void> {
  await signIn(page, username, password, optionalTotpFor(current, username));
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
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  await page.getByRole('link', { name: '数据产品治理' }).click();
  await page.getByRole('heading', { name: '数据产品治理', exact: true }).waitFor();
  const selector = page.getByRole('region', { name: '选择数据产品' });
  await selector.getByLabel('数据产品', { exact: true }).selectOption({ label: PRODUCT_NAME });
  await page.getByRole('region', { name: '发布历史' }).getByRole('button', { name: '查看发布版本 1' }).waitFor();
}

function productPath(current: World): string {
  return `/api/workspaces/${current.workspaceId}/data-products/${current.productId}/query`;
}

async function consumerRecords(
  url: string,
  current: World,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const answer = await callApi(url, productPath(current), { body, token: current.consumerToken });
  assert.equal(answer.status, 200, answer.text);
  return answer.body;
}

/** The audit events the active Workspace records, from the same authorized HTTP contract. */
async function auditActions(url: string, cookie: string, workspaceId: string): Promise<string[]> {
  const audit = await callApi(url, `/api/workspace/audit?workspace_id=${workspaceId}`, { cookie });
  assert.equal(audit.status, 200, audit.text);
  return (audit.body['events'] as Array<Record<string, unknown>>).map((event) => String(event['action']));
}

test('a Workspace Administrator inspects exact Releases and evolves a Contract additively and with a breaking change', async () => {
  let browser: Browser | undefined;
  const current = world({ releases: 2 });
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ADMIN, ADMIN_PASSWORD);
    await openGovernance(page);

    // The Release history names every exact Release, the Dataset Release it
    // pinned, and the freshness and Provenance that Release carries.
    const releases = page.getByRole('region', { name: '发布历史' });
    const releaseText = await releases.innerText();
    for (const copy of ['发布版本', '数据产品版本', '契约版本', '数据集版本', '当前', '历史']) {
      assert.ok(releaseText.includes(copy), `the Release history does not show ${copy}`);
    }
    await releases.getByRole('button', { name: '查看发布版本 1' }).click();
    const releaseDetail = page.getByRole('region', { name: '发布版本 1 详情' });
    await releaseDetail.getByText('记录数').waitFor();
    const detailText = await releaseDetail.innerText();
    for (const copy of ['数据集版本', '记录数', '采集时间', '集成时间', '发布时间', '批次', '原始采集']) {
      assert.ok(detailText.includes(copy), `the Release detail does not show ${copy}`);
    }
    assert.match(detailText, /记录数[\s\S]*5/u, 'the exact record count is disclosed');

    // Each active major line advances its own current-release pointer.
    const lines = page.getByRole('region', { name: '主版本线' });
    await lines.getByText('生效中').waitFor();
    const lineText = await lines.innerText();
    assert.ok(lineText.includes('1'));
    assert.ok(lineText.includes('2'), 'the current Release of the major line is stated');

    // The Contract history shows the exact Versions and their additive changes.
    const contracts = page.getByRole('region', { name: '契约历史' });
    const contractText = await contracts.innerText();
    assert.ok(contractText.includes('首次发布'));
    assert.ok(contractText.includes('兼容追加'));
    assert.ok(contractText.includes('1.0'));
    assert.ok(contractText.includes('1.1'));
    await contracts.getByRole('button', { name: '查看契约版本 1' }).click();
    const contractDetail = page.getByRole('region', { name: '契约版本 1 详情' });
    await contractDetail.getByText('设备处理量').waitFor();
    const contractDetailText = await contractDetail.innerText();
    for (const copy of ['字段', '维度', '指标', '记录粒度', '筛选字段', '计数', '求和']) {
      assert.ok(contractDetailText.includes(copy), `the Contract detail does not show ${copy}`);
    }

    // Additive evolution shows its Consumer consequences before Publication.
    const evolution = page.getByRole('region', { name: '契约演进' });
    await evolution.getByLabel('候选契约（JSON）', { exact: true }).fill(JSON.stringify(ADDITIVE_CONTRACT, null, 2));
    await evolution.getByRole('button', { name: '预览影响' }).click();
    const impact = evolution.getByRole('region', { name: '契约变更影响' });
    await impact.getByText('兼容追加').waitFor();
    const additiveText = await impact.innerText();
    assert.ok(additiveText.includes('契约 1.2'), 'the exact next Contract version is named');
    assert.ok(additiveText.includes('主版本 1'));
    assert.ok(additiveText.includes('现有消费方无需修改'));
    assert.ok(additiveText.includes('数据集版本 2'));

    await evolution.getByRole('button', { name: '发布契约新版本' }).click();
    const additiveConfirm = page.getByRole('region', { name: '确认发布契约新版本' });
    const additiveConfirmText = await additiveConfirm.innerText();
    assert.ok(additiveConfirmText.includes('1.2'));
    assert.ok(additiveConfirmText.includes('兼容追加'));
    await additiveConfirm.getByRole('button', { name: '确认发布' }).click();
    await contracts.getByText('1.2', { exact: true }).waitFor();
    const additiveAnswer = await consumerRecords(consoleServer.url, current, { kind: 'records' });
    assert.equal(additiveAnswer['data_product_version'], 3);
    assert.equal(additiveAnswer['data_product_release'], 3);
    assert.deepEqual(additiveAnswer['contract_version'], { major: 1, minor: 2 });
    const additiveRecord = (additiveAnswer['records'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(additiveRecord['owner'], '张三', 'the additive field is served at once');

    // A breaking change opens a new major line; the old line keeps serving.
    await evolution.getByLabel('候选契约（JSON）', { exact: true }).fill(JSON.stringify(BREAKING_CONTRACT, null, 2));
    await evolution.getByRole('button', { name: '预览影响' }).click();
    await impact.getByText('破坏性变更').waitFor();
    const breakingText = await impact.innerText();
    assert.ok(breakingText.includes('契约 2.0'));
    assert.ok(breakingText.includes('主版本 2'));
    assert.ok(breakingText.includes('主版本 1 继续以发布版本 3 提供服务'));
    assert.ok(breakingText.includes('已发布的字段'));
    assert.ok(breakingText.includes('指标定义'));

    await evolution.getByRole('button', { name: '发布契约新版本' }).click();
    const breakingConfirm = page.getByRole('region', { name: '确认发布契约新版本' });
    assert.ok((await breakingConfirm.innerText()).includes('破坏性变更'));
    await breakingConfirm.getByRole('button', { name: '确认发布' }).click();
    await contracts.getByText('2.0', { exact: true }).waitFor();

    const newest = await consumerRecords(consoleServer.url, current, { kind: 'records' });
    assert.equal(newest['data_product_version'], 4);
    assert.equal(newest['data_product_release'], 4);
    assert.deepEqual(newest['contract_version'], { major: 2, minor: 0 });
    assert.equal((newest['records'] as Array<Record<string, unknown>>)[0]!['handled_count'], undefined);
    const pinned = await consumerRecords(consoleServer.url, current, { kind: 'records', major: 1 });
    assert.equal(pinned['data_product_release'], 3);
    assert.deepEqual(pinned['contract_version'], { major: 1, minor: 2 });
    assert.equal((pinned['records'] as Array<Record<string, unknown>>)[0]!['handled_count'], 9);
    const historical = await consumerRecords(consoleServer.url, current, { kind: 'records', release: 1 });
    assert.equal((historical['records'] as Array<Record<string, unknown>>)[0]!['handled_count'], 3);

    const cookie = await cookieHeader(page.context());
    const actions = await auditActions(consoleServer.url, cookie, current.workspaceId);
    assert.ok(actions.includes('data_product_evolution_preview'), 'a preview is audited');
    assert.equal(
      actions.filter((action) => action === 'data_product_publication').length,
      4,
      'the two initial Publications and the two evolved Publications are each audited',
    );

    // A Consumer holds no governance surface, and the server refuses it outright.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signInAs(consumerPage, current, ANALYST, ANALYST_PASSWORD);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '数据产品治理' }).count(), 0);
    const denied = await callApi(
      consoleServer.url,
      `/api/workspace/products/${current.productId}/governance`,
      { cookie: await cookieHeader(consumerPage.context()) },
    );
    assert.equal(denied.status, 404, denied.text);
    assert.equal(denied.body['code'], 'DATA_PRODUCT_NOT_AVAILABLE');

    // Every surface this ticket adds reads in Simplified Chinese only.
    const body = await page.locator('body').innerText();
    for (const word of ['Contract', 'Release', 'Grant', 'Export', 'Withdraw', 'Rollback', 'Dataset', 'Provenance']) {
      assert.equal(body.includes(word), false, `${word} leaks into the page`);
    }
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('row and column Grants for Consumers and agents bind the next request, and exports stay governed', async () => {
  let browser: Browser | undefined;
  const current = world();

  const agent = command(
    current.fixture,
    ['agent', 'create', '--name', '巡检代理', '--workspaces', current.workspaceId, '--scopes', 'mcp:read'],
    { token: current.deploymentToken },
  );
  assert.equal(agent.status, 0, agent.stderr);
  const agentName = '巡检代理';
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ADMIN, ADMIN_PASSWORD);
    await openGovernance(page);

    // A row and column Grant to a Consumer is published from the browser.
    const grants = page.getByRole('region', { name: '数据产品授权' });
    await grants.getByLabel('成员账号', { exact: true }).selectOption({ label: ANALYST });
    await grants.getByLabel('允许字段', { exact: true }).fill('sn,city');
    await grants.getByLabel('行筛选（JSON）', { exact: true }).fill('[{"field":"city","op":"equals","value":"杭州"}]');
    await grants.getByRole('button', { name: '发布授权' }).click();
    const grantConfirm = page.getByRole('region', { name: '确认发布数据产品授权' });
    const grantConfirmText = await grantConfirm.innerText();
    assert.ok(grantConfirmText.includes(ANALYST));
    assert.ok(grantConfirmText.includes(PRODUCT_NAME));
    assert.ok(grantConfirmText.includes('下一次请求'));
    await grantConfirm.getByRole('button', { name: '确认发布' }).click();
    await grants.getByRole('row').filter({ hasText: ANALYST }).waitFor();

    const narrowed = await consumerRecords(consoleServer.url, current, { kind: 'records' });
    assert.deepEqual(
      (narrowed['records'] as Array<Record<string, unknown>>).map((record) => record['sn']),
      ['SN-001', 'SN-003', 'SN-005'],
      'the row filter binds the very next request',
    );
    assert.deepEqual(Object.keys((narrowed['records'] as Array<Record<string, unknown>>)[0]!), ['sn', 'city']);

    // Revocation restores the wider baseline on the next request.
    const grantRow = grants.getByRole('row').filter({ hasText: ANALYST });
    await grantRow.getByRole('button', { name: '撤销授权' }).click();
    const revokeConfirm = page.getByRole('region', { name: '确认撤销数据产品授权' });
    assert.ok((await revokeConfirm.innerText()).includes('下一次请求'));
    await revokeConfirm.getByRole('button', { name: '确认撤销' }).click();
    await grants.getByText('尚无数据产品授权').waitFor();

    const widened = await consumerRecords(consoleServer.url, current, { kind: 'records' });
    assert.equal((widened['records'] as Array<Record<string, unknown>>).length, 5);
    assert.deepEqual(
      Object.keys((widened['records'] as Array<Record<string, unknown>>)[0]!).sort(),
      ['city', 'handled_count', 'sn'],
    );

    // The same surface narrows an Agent Identity, never widening its scopes.
    await grants.getByLabel('授权对象类型', { exact: true }).selectOption({ label: '代理身份' });
    await grants.getByLabel('代理身份', { exact: true }).selectOption({ label: agentName });
    await grants.getByLabel('允许字段', { exact: true }).fill('sn');
    await grants.getByRole('button', { name: '发布授权' }).click();
    await page.getByRole('region', { name: '确认发布数据产品授权' }).getByRole('button', { name: '确认发布' }).click();
    await grants.getByRole('row').filter({ hasText: agentName }).waitFor();
    const agentGrants = await callApi(consoleServer.url, `/api/workspace/agents?workspace_id=${current.workspaceId}`, {
      cookie: await cookieHeader(page.context()),
    });
    assert.equal(agentGrants.status, 200, agentGrants.text);
    const agentView = (agentGrants.body['agents'] as Array<Record<string, unknown>>).find((entry) => entry['name'] === agentName);
    assert.ok(agentView !== undefined);
    assert.deepEqual((agentView['grants'] as Array<Record<string, unknown>>)[0]?.['columns'], ['sn']);

    // A governed export is created, listed, downloaded, and revoked from the browser.
    const exports = page.getByRole('region', { name: '导出治理' });
    await exports.getByLabel('导出查询（JSON）', { exact: true }).fill('{"kind":"records"}');
    await exports.getByRole('button', { name: '创建导出' }).click();
    const exportRow = exports.getByRole('row').filter({ hasText: '5' }).first();
    await exportRow.waitFor();
    const listed = await callApi(consoleServer.url, `/api/workspace/exports?workspace_id=${current.workspaceId}`, {
      cookie: await cookieHeader(page.context()),
    });
    assert.equal(listed.status, 200, listed.text);
    const exportRecord = (listed.body['exports'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(exportRecord['row_count'], 5);
    assert.equal(exportRecord['status'], 'active');
    const lifetime = Date.parse(String(exportRecord['expires_at'])) - Date.parse(String(exportRecord['created_at']));
    assert.ok(lifetime > 0 && lifetime <= 5 * 60 * 1000, 'the download is short-lived');

    const downloadPromise = page.waitForEvent('download');
    await exportRow.getByRole('button', { name: '下载导出' }).click();
    const download = await downloadPromise;
    const downloaded = readFileSync(String(await download.path()), 'utf8');
    assert.equal(
      downloaded,
      'sn,city,handled_count\nSN-001,杭州,3\nSN-002,上海,5\nSN-003,杭州,2\nSN-004,上海,7\nSN-005,杭州,4\n',
      'the encrypted export is decrypted only for an authorized download',
    );

    await exportRow.getByRole('button', { name: '撤销导出' }).click();
    const revokeExportConfirm = page.getByRole('region', { name: '确认撤销导出' });
    assert.ok((await revokeExportConfirm.innerText()).includes(String(exportRecord['export_id'])));
    await revokeExportConfirm.getByRole('button', { name: '确认撤销' }).click();
    await exports.getByText('已撤销').waitFor();
    const revokedDownload = await callApi(
      consoleServer.url,
      `/api/workspace/exports/${String(exportRecord['export_id'])}/download`,
      { method: 'POST', cookie: await cookieHeader(page.context()) },
    );
    assert.equal(revokedDownload.status, 410, revokedDownload.text);
    assert.equal(revokedDownload.body['code'], 'EXPORT_REVOKED');

    // A Consumer cannot list or revoke Workspace exports, and another Workspace
    // Administrator sees neither the Data Product nor its exports.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signInAs(consumerPage, current, ANALYST, ANALYST_PASSWORD);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    const deniedList = await callApi(
      consoleServer.url,
      `/api/workspace/exports?workspace_id=${current.workspaceId}`,
      { cookie: await cookieHeader(consumerPage.context()) },
    );
    assert.equal(deniedList.status, 403, deniedList.text);
    assert.equal(deniedList.body['code'], 'WORKSPACE_ACCESS_DENIED');

    createUser(current.fixture, current.deploymentToken, OUTSIDER, OUTSIDER_PASSWORD);
    const outsiderWorkspaceId = createWorkspace(current.fixture, current.deploymentToken, '隔离区', OUTSIDER);
    const outsiderPage = await open(browser, consoleServer.url, '/app');
    await signInAs(outsiderPage, current, OUTSIDER, OUTSIDER_PASSWORD);
    await outsiderPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    const foreign = await callApi(
      consoleServer.url,
      `/api/workspace/products/${current.productId}/governance?workspace_id=${outsiderWorkspaceId}`,
      { cookie: await cookieHeader(outsiderPage.context()) },
    );
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(foreign.body['code'], 'DATA_PRODUCT_NOT_AVAILABLE');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('Withdrawal and Rollback are separate exact actions with consequences, audit, and preserved history', async () => {
  let browser: Browser | undefined;
  const current = world({ releases: 2 });

  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ADMIN, ADMIN_PASSWORD);
    await openGovernance(page);

    // Rollback returns the major line to the exact earlier Release.
    const contracts = page.getByRole('region', { name: '契约历史' });
    const versionOne = contracts.getByRole('row').filter({ hasText: '1.0' });
    await versionOne.getByRole('button', { name: '回滚到此版本' }).click();
    const rollbackConfirm = page.getByRole('region', { name: '确认回滚数据产品版本' });
    const rollbackText = await rollbackConfirm.innerText();
    assert.ok(rollbackText.includes('数据产品版本 1'));
    assert.ok(rollbackText.includes('发布版本 1'));
    assert.ok(rollbackText.includes('主版本 1'));
    assert.ok(rollbackText.includes('历史'));
    await rollbackConfirm.getByRole('button', { name: '确认回滚' }).click();
    await contracts.getByText('当前', { exact: true }).first().waitFor();

    const rolledBack = await consumerRecords(consoleServer.url, current, { kind: 'records' });
    assert.equal(rolledBack['data_product_release'], 1, 'the major line serves the exact earlier Release again');
    assert.equal((rolledBack['records'] as Array<Record<string, unknown>>)[0]!['handled_count'], 3);
    const afterRollback = await contracts.innerText();
    assert.ok(afterRollback.includes('2'), 'the later Version stays in history');

    // Withdrawal is a visibly distinct action with its own consequences.
    const versionOneAfterRollback = contracts.getByRole('row').filter({ hasText: '1.0' });
    await versionOneAfterRollback.getByRole('button', { name: '撤下此版本' }).click();
    const withdrawConfirm = page.getByRole('region', { name: '确认撤下数据产品版本' });
    const withdrawText = await withdrawConfirm.innerText();
    assert.ok(withdrawText.includes('数据产品版本 1'));
    assert.ok(withdrawText.includes('发布版本 1'));
    assert.ok(withdrawText.includes('停止提供新查询'));
    assert.notEqual(withdrawText, rollbackText, 'Withdrawal and Rollback state different consequences');
    await withdrawConfirm.getByRole('button', { name: '确认撤下' }).click();
    await contracts.getByText('已撤下', { exact: true }).first().waitFor();

    const withdrawnHistory = await contracts.innerText();
    assert.ok(withdrawnHistory.includes('已撤下'));
    assert.ok(withdrawnHistory.includes('历史'));

    const refused = await callApi(consoleServer.url, productPath(current), {
      body: { kind: 'records' },
      token: current.consumerToken,
    });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body['code'], 'DATA_PRODUCT_NOT_PUBLISHED');
    const exact = await callApi(consoleServer.url, productPath(current), {
      body: { kind: 'records', release: 1 },
      token: current.consumerToken,
    });
    assert.equal(exact.status, 409, exact.text);
    assert.equal(exact.body['code'], 'DATA_PRODUCT_VERSION_WITHDRAWN');

    const cookie = await cookieHeader(page.context());
    const actions = await auditActions(consoleServer.url, cookie, current.workspaceId);
    assert.ok(actions.includes('data_product_rollback'), 'a Rollback is audited');
    assert.ok(actions.includes('data_product_withdrawal'), 'a Withdrawal is audited');

    const body = await page.locator('body').innerText();
    for (const word of ['Withdraw', 'Rollback', 'Version', 'Release']) {
      assert.equal(body.includes(word), false, `${word} leaks into the page`);
    }
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});
