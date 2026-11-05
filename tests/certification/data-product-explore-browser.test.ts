import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
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

const PRODUCT_NAME = '设备维修台账';
const DOCUMENT_PRODUCT_NAME = '设备文档库';

const LEDGER = [
  '设备SN,城市,处理量,结算金额,上报日期,负责人',
  'sn-001,杭州,3,120.5,2026-01-05,张三',
  'sn-002,上海,5,300,2026-01-12,李四',
  'sn-003,,2,,2026-01-20,王五',
  'sn-004,上海,7,210,2026-02-03,张三',
  'sn-005,杭州,4,160,2026-02-10,李四',
  '',
].join('\n');

/** The next snapshot: the first device's handled count rises without moving its date. */
const LEDGER_NEXT = LEDGER.replace('sn-001,杭州,3,120.5', 'sn-001,杭州,9,120.5');

const INTEGRATION = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
    { name: 'settled_amount', type: 'number' },
    { name: 'reported_on', type: 'date' },
    { name: 'owner', type: 'string' },
  ],
  cleaning: [{ rule: 'trim', field: 'sn' }],
  mapping: {
    设备SN: 'sn',
    城市: 'city',
    处理量: 'handled_count',
    结算金额: 'settled_amount',
    上报日期: 'reported_on',
    负责人: 'owner',
  },
};

const CONTRACT = {
  title: '设备维修处理量',
  description: '按设备序列号组织的维修处理量与结算金额',
  fields: [
    { name: 'sn' },
    { name: 'city' },
    { name: 'handled_count' },
    { name: 'settled_amount' },
    { name: 'reported_on' },
    { name: 'owner' },
  ],
  dimensions: ['city'],
  metrics: [
    { name: 'device_count', aggregation: 'count', value_type: 'integer' },
    { name: 'handled_total', aggregation: 'sum', field: 'handled_count', value_type: 'integer' },
    { name: 'settled_total', aggregation: 'sum', field: 'settled_amount', value_type: 'money', currency: 'CNY' },
  ],
  grain: ['sn'],
  time: { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' },
  filters: ['city', 'handled_count', 'reported_on'],
  limit: { default: 100, max: 500 },
};

const DOCUMENT_SCHEMA = [
  { name: 'doc_id', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'text', type: 'string' },
  { name: 'city', type: 'string' },
];

const DOCUMENT_CONTRACT = {
  title: '设备文档库',
  fields: [{ name: 'doc_id' }, { name: 'title' }, { name: 'text' }, { name: 'city' }],
  grain: ['doc_id'],
  filters: ['city'],
  limit: { default: 10, max: 100 },
  search: {
    text_field: 'text',
    title_field: 'title',
    suggest_fields: ['title', 'city'],
    ranking: { kind: 'weighted_term_frequency', title_weight: 3, text_weight: 1 },
    max_terms: 8,
    min_term_length: 1,
  },
};

const DOCUMENTS = JSON.stringify({
  format: 'text',
  documents: [
    { doc_id: 'doc-001', title: '压缩机维修', text: '冷库压缩机 维修 步骤', city: '杭州' },
    { doc_id: 'doc-002', title: '冷链巡检', text: '巡检记录 维修 建议', city: '上海' },
    { doc_id: 'doc-003', title: '冷库巡检', text: '巡检记录 温度 曲线', city: '杭州' },
    { doc_id: 'doc-004', title: '冷链巡检', text: '维修 记录 归档', city: '上海' },
  ],
});

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  deploymentToken: string;
  workspaceToken: string;
  consumerToken: string;
  sourceId: string;
  productId: string;
  documentProductId: string | null;
}

function acquireAndRelease(fixture: PlatformFixture, token: string, sourceId: string, content: string, name: string): void {
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
  name: string,
  contract: Record<string, unknown>,
): string {
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', name, '--contract', jsonFile(fixture, `contract-${name}`, contract)],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  return String(published.output.data_product_id);
}

/** One Deployment, one Workspace with a Consumer, and one governed tabular product. */
function world(options: { releases?: number; documents?: boolean } = {}): World {
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
  let productId = publishProduct(fixture, workspaceToken, sourceId, PRODUCT_NAME, CONTRACT);
  for (let index = 1; index < (options.releases ?? 1); index += 1) {
    acquireAndRelease(fixture, workspaceToken, sourceId, LEDGER_NEXT, `ledger-${index}.csv`);
    productId = publishProduct(fixture, workspaceToken, sourceId, PRODUCT_NAME, CONTRACT);
  }

  let documentProductId: string | null = null;
  if (options.documents === true) {
    const documentSource = command(
      fixture,
      ['source', 'create', '--workspace', workspaceId, '--name', '设备文档', '--type', 'document'],
      { token: workspaceToken },
    );
    assert.equal(documentSource.status, 0, documentSource.stderr);
    const documentSourceId = String(documentSource.output.source_id);
    const documentConfiguration = command(
      fixture,
      ['integration', 'publish', '--source', documentSourceId, '--config', jsonFile(fixture, 'document-integration', {
        identity: ['doc_id'],
        schema: DOCUMENT_SCHEMA,
        cleaning: [{ rule: 'trim', field: 'doc_id' }],
        mapping: { doc_id: 'doc_id', title: 'title', text: 'text', city: 'city' },
      })],
      { token: workspaceToken },
    );
    assert.equal(documentConfiguration.status, 0, documentConfiguration.stderr);
    command(
      fixture,
      ['integration', 'adopt', '--source', documentSourceId, '--version', String(documentConfiguration.output.integration_configuration_version)],
      { token: workspaceToken },
    );
    acquireAndRelease(fixture, workspaceToken, documentSourceId, DOCUMENTS, 'documents.json');
    documentProductId = publishProduct(fixture, workspaceToken, documentSourceId, DOCUMENT_PRODUCT_NAME, DOCUMENT_CONTRACT);
  }

  return {
    fixture,
    workspaceId,
    deploymentToken,
    workspaceToken,
    consumerToken,
    sourceId,
    productId,
    documentProductId,
  };
}

async function signIn(page: Page, username: string, password: string, totp: string | null): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  if (totp !== null) await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(totp));
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

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

async function openProducts(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  await page.getByRole('link', { name: '数据产品', exact: true }).click();
  await page.getByRole('heading', { name: '数据产品', level: 1, exact: true }).waitFor();
}

async function browse(page: Page, name: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: name });
  await row.waitFor();
  await row.getByRole('button', { name: '浏览此产品' }).click();
  await page.getByRole('region', { name: '数据产品详情' }).waitFor();
}

/** The visible cells of the result table, in row order. */
async function tableRows(region: Locator): Promise<string[][]> {
  return region.locator('tbody tr').evaluateAll((rows) => rows.map(
    (row) => Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent ?? '').trim()),
  ));
}

function productPath(current: World): string {
  return `/api/workspaces/${current.workspaceId}/data-products/${current.productId}/query`;
}

async function workspaceAudit(url: string, workspaceToken: string, workspaceId: string): Promise<string[]> {
  const audit = await callApi(url, `/api/workspace/audit?workspace_id=${workspaceId}`, {
    cookie: `dc_user_session=${workspaceToken}`,
  });
  assert.equal(audit.status, 200, audit.text);
  return (audit.body['events'] as Array<Record<string, unknown>>).map((event) => String(event['action']));
}

test('a Consumer discovers authorized published Data Products, reads governed records, and exports reauthorized results', async () => {
  let browser: Browser | undefined;
  const current = world();
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ANALYST, ANALYST_PASSWORD);
    await openProducts(page);

    // Discovery names the authorized published product and its promised API path.
    assert.equal(await page.getByRole('row').filter({ hasText: PRODUCT_NAME }).count(), 1);
    const discovery = await page.getByRole('region', { name: '可用的数据产品' }).innerText();
    assert.ok(discovery.includes(`/api/workspaces/${current.workspaceId}/data-products/`));
    assert.ok(discovery.includes('1.0'));

    // Keyboard operation reaches the same exploration surface a pointer does.
    const browseButton = page.getByRole('row').filter({ hasText: PRODUCT_NAME }).getByRole('button', { name: '浏览此产品' });
    await browseButton.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('region', { name: '数据产品详情' });
    await details.waitFor();
    const metadata = await details.innerText();
    for (const copy of ['契约版本', '字段', '维度', '指标', '记录粒度', '时间字段', '筛选字段', '文档检索']) {
      assert.ok(metadata.includes(copy), `the metadata does not show ${copy}`);
    }
    assert.ok(metadata.includes('reported_on'), 'the Contract time field is named');
    assert.ok(metadata.includes('Asia/Shanghai'), 'the Contract business zone is named');
    assert.ok(metadata.includes('不支持'), 'a tabular Contract publishes no document search');
    for (const metric of ['device_count', 'handled_total', 'settled_total']) {
      assert.ok(metadata.includes(metric), `the metric ${metric} is published`);
    }

    const releases = page.getByRole('region', { name: '发布版本' });
    assert.ok((await releases.innerText()).includes('当前'));

    // Records: the page cursor walks the Release in its Contract grain.
    const workbench = page.getByRole('region', { name: '数据探索' });
    await workbench.getByLabel('每页条数', { exact: true }).fill('2');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    const recordResult = page.getByRole('region', { name: '记录结果' });
    await recordResult.getByText('匹配记录数').waitFor();
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-001', '杭州', '3', '120.5', '2026-01-05', '张三'],
      ['sn-002', '上海', '5', '300', '2026-01-12', '李四'],
    ]);
    const footer = await recordResult.innerText();
    assert.match(footer, /匹配记录数[\s\S]*5/u);
    assert.match(footer, /本页返回[\s\S]*2/u);
    await recordResult.getByRole('button', { name: '下一页' }).click();
    await recordResult.getByText('sn-003').waitFor();
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-003', '（空）', '2', '（空）', '2026-01-20', '王五'],
      ['sn-004', '上海', '7', '210', '2026-02-03', '张三'],
    ]);
    await recordResult.getByRole('button', { name: '下一页' }).click();
    await recordResult.getByText('sn-005').waitFor();
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-005', '杭州', '4', '160', '2026-02-10', '李四'],
    ]);
    await recordResult.getByRole('button', { name: '上一页' }).click();
    await recordResult.getByText('sn-004').waitFor();

    // A typed dimension filter applies before paging and changes the exact result.
    await workbench.getByLabel('筛选字段 1', { exact: true }).selectOption('city');
    await workbench.getByLabel('筛选运算符 1', { exact: true }).selectOption({ label: '等于' });
    await workbench.getByLabel('筛选值 1', { exact: true }).fill('杭州');
    await workbench.getByLabel('每页条数', { exact: true }).fill('100');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await recordResult.getByText('sn-005').waitFor();
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-001', '杭州', '3', '120.5', '2026-01-05', '张三'],
      ['sn-005', '杭州', '4', '160', '2026-02-10', '李四'],
    ]);

    // A null test is a typed filter too: a missing dimension is listed, not invented.
    await workbench.getByLabel('筛选运算符 1', { exact: true }).selectOption({ label: '为空' });
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await recordResult.getByText('sn-003').waitFor();
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-003', '（空）', '2', '（空）', '2026-01-20', '王五'],
    ]);

    // An inclusive date window keeps both boundary days.
    await workbench.getByRole('button', { name: '清除筛选条件' }).click();
    await workbench.getByLabel('记录时间起点', { exact: true }).fill('2026-01-05');
    await workbench.getByLabel('记录时间终点', { exact: true }).fill('2026-01-12');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await recordResult.getByText('sn-002').waitFor();
    assert.deepEqual(
      (await tableRows(recordResult)).map((row) => row[0]),
      ['sn-001', 'sn-002'],
      'the start and end of an inclusive date window are both read',
    );

    // Every read names the exact Contract, Release, freshness, and permitted Provenance.
    const provenance = page.getByRole('region', { name: '来源与新鲜度' });
    const provenanceText = await provenance.innerText();
    for (const copy of ['数据产品版本', '发布版本', '契约版本', '数据集版本', '记录数', '采集时间', '集成时间', '发布时间']) {
      assert.ok(provenanceText.includes(copy), `the Provenance does not show ${copy}`);
    }
    assert.match(provenanceText, /记录数[\s\S]*5/u);
    assert.match(provenanceText, /采集时间[\s\S]*\d{4}/u);

    // A governed export carries the very rows and columns the query answered.
    const exports = page.getByRole('region', { name: '我的导出' });
    await exports.getByText('尚无导出').waitFor();
    await exports.getByRole('button', { name: '创建导出' }).click();
    await exports.getByText('有效').waitFor();
    const listed = await callApi(consoleServer.url, `/api/workspace/my-exports?workspace_id=${current.workspaceId}`, {
      cookie: await cookieHeader(page.context()),
    });
    assert.equal(listed.status, 200, listed.text);
    const exportRecord = (listed.body['exports'] as Array<Record<string, unknown>>)[0]!;
    assert.equal(exportRecord['row_count'], 2);
    assert.deepEqual(exportRecord['columns'], ['sn', 'city', 'handled_count', 'settled_amount', 'reported_on', 'owner']);
    const lifetime = Date.parse(String(exportRecord['expires_at'])) - Date.parse(String(exportRecord['created_at']));
    assert.ok(lifetime > 0 && lifetime <= 5 * 60 * 1000, 'the download is short-lived');

    const downloadPromise = page.waitForEvent('download');
    await exports.getByRole('button', { name: '下载导出' }).click();
    const download = await downloadPromise;
    assert.equal(
      readFileSync(String(await download.path()), 'utf8'),
      'sn,city,handled_count,settled_amount,reported_on,owner\n'
        + 'sn-001,杭州,3,120.5,2026-01-05,张三\n'
        + 'sn-002,上海,5,300,2026-01-12,李四\n',
      'the encrypted export is decrypted only for an authorized owner download',
    );

    // A narrower Grant invalidates the download it no longer covers, on the next request.
    const grant = command(
      current.fixture,
      ['grant', 'publish', '--product', current.productId, '--username', ANALYST, '--request', jsonFile(
        current.fixture,
        'narrow-grant',
        { columns: ['sn', 'city'] },
      )],
      { token: current.workspaceToken },
    );
    assert.equal(grant.status, 0, grant.stderr);
    await exports.getByRole('button', { name: '下载导出' }).click();
    await page.getByText('EXPORT_NO_LONGER_AUTHORIZED').waitFor();

    // The next governed read is narrowed to the granted columns, and a hidden
    // column cannot filter, group, or total anything.
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await recordResult.getByRole('columnheader', { name: 'handled_count' }).waitFor({ state: 'detached' });
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-001', '杭州'],
      ['sn-002', '上海'],
    ]);
    const hiddenFilter = await callApi(
      consoleServer.url,
      `/api/workspace/products/${current.productId}/query?workspace_id=${current.workspaceId}`,
      {
        cookie: await cookieHeader(page.context()),
        body: { request: { kind: 'records', filters: [{ field: 'handled_count', op: 'greater_or_equal', value: 5 }] } },
      },
    );
    assert.equal(hiddenFilter.status, 403, hiddenFilter.text);
    assert.equal(hiddenFilter.body['code'], 'DATA_PRODUCT_QUERY_REFUSED');

    // A fresh export is produced under the current Grant and downloads only its columns.
    await exports.getByRole('button', { name: '创建导出' }).click();
    await exports.getByRole('button', { name: '下载导出' }).nth(1).waitFor();
    const narrowedDownloadPromise = page.waitForEvent('download');
    await exports.getByRole('button', { name: '下载导出' }).first().click();
    const narrowedDownload = await narrowedDownloadPromise;
    assert.equal(
      readFileSync(String(await narrowedDownload.path()), 'utf8'),
      'sn,city\nsn-001,杭州\nsn-002,上海\n',
      'the export carries only the columns the current Grant permits',
    );

    // A row Grant narrows the very next browser read as well, never only the API.
    const rowGrant = command(
      current.fixture,
      ['grant', 'publish', '--product', current.productId, '--username', ANALYST, '--request', jsonFile(
        current.fixture,
        'row-grant',
        { columns: ['sn', 'city'], row_filters: [{ field: 'city', op: 'equals', value: '杭州' }] },
      )],
      { token: current.workspaceToken },
    );
    assert.equal(rowGrant.status, 0, rowGrant.stderr);
    await workbench.getByLabel('记录时间起点', { exact: true }).fill('');
    await workbench.getByLabel('记录时间终点', { exact: true }).fill('');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await recordResult.getByText('sn-005').waitFor();
    assert.deepEqual(await tableRows(recordResult), [
      ['sn-001', '杭州'],
      ['sn-005', '杭州'],
    ], 'the row Grant applies before the browser renders the result');

    // The refused window is a governed Chinese error state, never English prose.
    await workbench.getByLabel('记录时间起点', { exact: true }).fill('2026-02-10');
    await workbench.getByLabel('记录时间终点', { exact: true }).fill('2026-01-05');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await page.getByText('DATA_PRODUCT_QUERY_REFUSED').waitFor();
    const alertText = await page.getByRole('alert').innerText();
    assert.ok(alertText.includes('查询被拒绝'), 'the refusal is stated in Simplified Chinese');
    assert.equal(alertText.includes('must start no later than it ends'), false, 'no English server prose leaks');

    // Both export steps are attributable Audit Events.
    const actions = await workspaceAudit(consoleServer.url, current.workspaceToken, current.workspaceId);
    assert.ok(actions.includes('data_product_export'), 'creating an export is audited');
    assert.ok(actions.includes('data_product_export_download'), 'downloading an export is audited');

    // Every surface this ticket adds reads in Simplified Chinese only.
    const body = await page.locator('body').innerText();
    for (const word of [
      'Contract', 'Release', 'Grant', 'Export', 'Records', 'Aggregate', 'Document', 'Dataset',
      'Provenance', 'Freshness', 'Window', 'Cursor',
    ]) {
      assert.equal(body.includes(word), false, `${word} leaks into the page`);
    }
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('a Consumer explores aggregates, comparisons, null groups, partial periods, and historical Releases', async () => {
  let browser: Browser | undefined;
  const current = world({ releases: 2 });
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ANALYST, ANALYST_PASSWORD);
    await openProducts(page);
    await browse(page, PRODUCT_NAME);

    // Both Releases are published and selectable by exact number.
    const workbench = page.getByRole('region', { name: '数据探索' });
    const releaseSelect = page.getByLabel('查询发布版本', { exact: true });
    const options = await releaseSelect.locator('option').allInnerTexts();
    assert.equal(options.length, 3, 'the current Release and two explicit Releases are offered');
    assert.ok(options[0]?.includes('当前（发布版本 2）'));

    await workbench.getByRole('button', { name: '汇总比较' }).click();
    await workbench.getByRole('checkbox', { name: 'city' }).check();
    await workbench.getByLabel('排序字段', { exact: true }).selectOption('handled_total');
    await workbench.getByLabel('排序方向', { exact: true }).selectOption('desc');
    await workbench.getByLabel('统计时间起点', { exact: true }).fill('2026-02-01');
    await workbench.getByLabel('统计时间终点', { exact: true }).fill('2026-02-28');
    await workbench.getByLabel('对比时间起点', { exact: true }).fill('2026-01-01');
    await workbench.getByLabel('对比时间终点', { exact: true }).fill('2026-01-31');
    await workbench.getByRole('button', { name: '查询汇总' }).click();

    const aggregate = page.getByRole('region', { name: '汇总结果' });
    await aggregate.getByRole('columnheader', { name: 'handled_total 变化', exact: true }).waitFor();
    const groups = aggregate.getByRole('table').first();
    assert.deepEqual(await tableRows(groups), [
      ['上海', '1', '7', '210.00', '0', '0.00', '2', '40.00', '-90.00', '-30.00'],
      ['杭州', '1', '4', '160.00', '0', '0.00', '-5', '-55.56', '39.50', '32.78'],
      ['（空）', '0', '0', '0.00', '-1', '-100.00', '-2', '-100.00', '0.00', '基数为零，不计算百分比'],
    ]);
    const aggregateText = await aggregate.innerText();
    assert.ok(aggregateText.includes('包含空值维度：city'), 'a null dimension forms a labelled group');
    assert.ok(aggregateText.includes('期间不完整'), 'a window the Release does not cover is labelled partial');
    assert.match(aggregateText, /分组数[\s\S]*3/u);

    const totals = aggregate.getByRole('table').nth(1);
    assert.deepEqual(await tableRows(totals), [
      ['device_count', '2', '-1', '-33.33'],
      ['handled_total', '11', '-5', '-31.25'],
      ['settled_total', '370.00', '-50.50', '-12.01'],
    ]);

    // A filter that matches nothing is an explicit empty state, never fabricated groups.
    await workbench.getByLabel('筛选字段 1', { exact: true }).selectOption('city');
    await workbench.getByLabel('筛选运算符 1', { exact: true }).selectOption({ label: '等于' });
    await workbench.getByLabel('筛选值 1', { exact: true }).fill('北京');
    await workbench.getByRole('button', { name: '查询汇总' }).click();
    await aggregate.getByText('没有符合条件的汇总分组。').waitFor();

    // A historical Release is read by exact number, never silently replaced by current data.
    await workbench.getByRole('button', { name: '清除筛选条件' }).click();
    await workbench.getByRole('button', { name: '记录' }).click();
    await releaseSelect.selectOption('1');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    const records = page.getByRole('region', { name: '记录结果' });
    await records.getByText('sn-001').waitFor();
    assert.deepEqual((await tableRows(records))[0], ['sn-001', '杭州', '3', '120.5', '2026-01-05', '张三']);
    const historicalProvenance = await page.getByRole('region', { name: '来源与新鲜度' }).innerText();
    assert.match(historicalProvenance, /发布版本[\s\S]*1(?!\d)/u);

    // The current pointer serves the newest Release again.
    await releaseSelect.selectOption('');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await records.locator('tbody tr').first().getByText('9', { exact: true }).waitFor();
    assert.deepEqual((await tableRows(records))[0], ['sn-001', '杭州', '9', '120.5', '2026-01-05', '张三']);
    const currentProvenance = await page.getByRole('region', { name: '来源与新鲜度' }).innerText();
    assert.match(currentProvenance, /发布版本[\s\S]*2(?!\d)/u);

    const body = await page.locator('body').innerText();
    for (const word of ['Aggregate', 'Comparison', 'Window', 'Release', 'Provenance']) {
      assert.equal(body.includes(word), false, `${word} leaks into the page`);
    }
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('a release-pinned page cursor fails explicitly when a later Release supersedes it', async () => {
  let browser: Browser | undefined;
  const current = world();
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ANALYST, ANALYST_PASSWORD);
    await openProducts(page);
    await browse(page, PRODUCT_NAME);

    const workbench = page.getByRole('region', { name: '数据探索' });
    await workbench.getByLabel('每页条数', { exact: true }).fill('2');
    await workbench.getByRole('button', { name: '查询记录' }).click();
    const records = page.getByRole('region', { name: '记录结果' });
    await records.getByText('匹配记录数').waitFor();
    assert.deepEqual(
      (await tableRows(records)).map((row) => row[0]),
      ['sn-001', 'sn-002'],
    );

    // A newer Release arrives while the first page is open.
    acquireAndRelease(current.fixture, current.workspaceToken, current.sourceId, LEDGER_NEXT, 'ledger-next.csv');
    publishProduct(current.fixture, current.workspaceToken, current.sourceId, PRODUCT_NAME, CONTRACT);

    // The stale cursor is refused rather than silently answering another Release.
    await records.getByRole('button', { name: '下一页' }).click();
    await page.getByText('DATA_PRODUCT_QUERY_CURSOR_INVALID').waitFor();
    const alertText = await page.getByRole('alert').innerText();
    assert.ok(alertText.includes('翻页游标已过期'), 'the stale cursor is stated in Simplified Chinese');
    assert.deepEqual(
      (await tableRows(records)).map((row) => row[0]),
      ['sn-001', 'sn-002'],
      'the refused page leaves the last authorized result unchanged',
    );

    // Reading again from the first page serves the new current Release.
    await workbench.getByRole('button', { name: '查询记录' }).click();
    await records.locator('tbody tr').first().getByText('9', { exact: true }).waitFor();
    assert.deepEqual((await tableRows(records))[0], ['sn-001', '杭州', '9', '120.5', '2026-01-05', '张三']);
    const provenance = await page.getByRole('region', { name: '来源与新鲜度' }).innerText();
    assert.match(provenance, /发布版本[\s\S]*2(?!\d)/u);
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});

test('a Consumer searches documents, and unauthorized discovery is indistinguishable from nonexistence', async () => {
  let browser: Browser | undefined;
  const current = world({ documents: true });
  assert.ok(current.documentProductId !== null);
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signInAs(page, current, ANALYST, ANALYST_PASSWORD);
    await openProducts(page);

    // Discovery lists both authorized published products and nothing else.
    const discovery = await page.getByRole('region', { name: '可用的数据产品' }).innerText();
    assert.ok(discovery.includes(PRODUCT_NAME));
    assert.ok(discovery.includes(DOCUMENT_PRODUCT_NAME));

    await browse(page, DOCUMENT_PRODUCT_NAME);
    const details = await page.getByRole('region', { name: '数据产品详情' }).innerText();
    assert.ok(details.includes('支持'), 'the document Contract publishes search');
    assert.ok(details.includes('text'), 'the searchable text field is published metadata');

    const workbench = page.getByRole('region', { name: '数据探索' });
    await workbench.getByRole('button', { name: '文档检索' }).click();
    await workbench.getByLabel('每页条数', { exact: true }).fill('2');
    await workbench.getByLabel('检索词', { exact: true }).fill('维修');
    await workbench.getByRole('button', { name: '检索文档' }).click();
    const documents = page.getByRole('region', { name: '文档检索结果' });
    await documents.getByText('doc-001').waitFor();
    const firstPage = await tableRows(documents);
    assert.deepEqual(firstPage, [
      ['doc-001', '压缩机维修', '冷库压缩机 维修 步骤', '杭州', '4', '维修'],
      ['doc-002', '冷链巡检', '巡检记录 维修 建议', '上海', '1', '维修'],
    ]);
    assert.match(await documents.innerText(), /匹配文档数[\s\S]*3/u);
    assert.match(await documents.innerText(), /本页返回[\s\S]*2/u);

    // The next document page is pinned to the same Release and ranked total order.
    await documents.getByRole('button', { name: '下一页' }).click();
    await documents.getByText('doc-004').waitFor();
    assert.deepEqual(await tableRows(documents), [
      ['doc-004', '冷链巡检', '维修 记录 归档', '上海', '1', '维修'],
    ]);

    // A search that matches no document is an explicit Chinese empty state.
    await workbench.getByLabel('检索词', { exact: true }).fill('不存在的词');
    await workbench.getByRole('button', { name: '检索文档' }).click();
    await documents.getByText('没有匹配的文档。').waitFor();

    // Another Workspace sees no product, and every foreign or missing identifier
    // answers with the same governed refusal.
    createUser(current.fixture, current.deploymentToken, OUTSIDER, OUTSIDER_PASSWORD);
    const outsiderWorkspaceId = createWorkspace(current.fixture, current.deploymentToken, '隔离区', OUTSIDER);
    const outsiderPage = await open(browser, consoleServer.url, '/app');
    await signInAs(outsiderPage, current, OUTSIDER, OUTSIDER_PASSWORD);
    await openProducts(outsiderPage);
    await outsiderPage.getByText('当前工作区尚未发布数据产品。').waitFor();
    assert.equal(await outsiderPage.getByRole('row').filter({ hasText: PRODUCT_NAME }).count(), 0);

    const cookie = await cookieHeader(outsiderPage.context());
    const foreign = await callApi(
      consoleServer.url,
      `/api/workspace/products/${current.productId}/query?workspace_id=${outsiderWorkspaceId}`,
      { cookie, body: { request: { kind: 'records' } } },
    );
    const missing = await callApi(
      consoleServer.url,
      `/api/workspace/products/00000000-0000-4000-8000-000000000000/query?workspace_id=${outsiderWorkspaceId}`,
      { cookie, body: { request: { kind: 'records' } } },
    );
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(missing.status, 404, missing.text);
    assert.equal(foreign.body['code'], 'DATA_PRODUCT_NOT_AVAILABLE');
    assert.equal(missing.body['code'], foreign.body['code'], 'foreign and missing products are indistinguishable');

    const foreignReleases = await callApi(
      consoleServer.url,
      `/api/workspace/products/${current.productId}/releases?workspace_id=${outsiderWorkspaceId}`,
      { cookie },
    );
    assert.equal(foreignReleases.status, 404, foreignReleases.text);
    assert.equal(foreignReleases.body['code'], 'DATA_PRODUCT_NOT_AVAILABLE');

    const ownExports = await callApi(
      consoleServer.url,
      `/api/workspace/my-exports?workspace_id=${outsiderWorkspaceId}`,
      { cookie },
    );
    assert.equal(ownExports.status, 200, ownExports.text);
    assert.deepEqual(ownExports.body['exports'], [], 'another Workspace never reveals its exports');
  } finally {
    await consoleServer.stop();
    await browser?.close();
  }
});
