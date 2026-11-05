import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import {
  command,
  createUser,
  initializePlatform,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const ISOLATION = 'isolation@example.invalid';
const ISOLATION_PASSWORD = 'isolation-administrator';
const RANDOM_SOURCE = '00000000-0000-4000-8000-000000000000';

/** The two governed manual representations one Source may be declared as. */
const DEVICE_LEDGER = '设备SN,城市,处理量\n  sn-001 ,杭州,3\nsn-002,上海,5\n';
const DEVICE_LEDGER_NEXT = '设备SN,城市,处理量\nsn-001,杭州,4\nsn-002,上海,5\n';
const DEVICE_LEDGER_DEFECTIVE = '设备SN,城市,处理量\nsn-001,杭州,4\nsn-001,杭州,4\nsn-002,上海,abc\n,宁波,5\n';
const DEVICE_LEDGER_DRIFTED = '设备SN,城市\nsn-001,杭州\n';

const DOCUMENTS = JSON.stringify({
  format: 'text',
  documents: [
    { doc_id: 'doc-001', title: '压缩机维修', text: '冷库压缩机 维修 步骤', city: '杭州' },
    { doc_id: 'doc-002', title: '冷链巡检', text: '巡检记录 维修 建议', city: '上海' },
  ],
});

const CREATED = (name: string) => `数据来源已创建：${name}`;
const PUBLISHED = '集成配置版本已发布：第 1 版';
const ADOPTED = '已采纳集成配置第 1 版，之后的采集按该版本执行。';
const PREVIEW_VALID = '配置校验通过，可以发布为不可变版本。';
const PREVIEW_INVALID = '配置未通过校验，请按下列原因修改后重新预览。';
const TOO_LARGE = '文档集超过配置声明的字节上限。';
const NOT_UTF8 = '文件不是 UTF-8 编码的文本。';
const BAD_SIGNATURE = '文件内容不是来源声明的文本格式（例如压缩包或二进制容器）。';
const EMPTY_FILE = '文件内容为空。';
const DRIFT = '采集的文件缺少配置映射的源列。';
const NOT_ADOPTED = '该来源尚未采纳任何集成配置版本。';
const UPLOADED = (release: number, records: number) =>
  `数据来源已采集并集成：数据集发布第 ${release} 版，共 ${records} 条有效记录。`;
const PRESERVED = (release: number) => `原始采集已保存，但集成未发布；当前数据集发布保持为第 ${release} 版。`;

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
  workspaceAdministrator: Credentials;
  consumer: Credentials;
  ledgerPath: string;
  ledgerNextPath: string;
  defectivePath: string;
  driftedPath: string;
  documentsPath: string;
  zipPath: string;
  emptyPath: string;
  utf16Path: string;
  oversizedPath: string;
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

function fileOf(fixture: PlatformFixture, name: string, content: string | Buffer): string {
  const path = join(fixture.scratch, name);
  writeFileSync(path, content);
  return path;
}

/**
 * One Deployment with two Workspaces that share no membership: a Workspace
 * Administrator and a Consumer in Operations, and an unrelated administrator
 * whose Workspace holds the Source this actor may never reach. Every upload
 * fixture is frozen here, so a browser test never invents its own bytes.
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

  const isolation = command(
    fixture,
    ['workspace', 'create', '--name', 'Isolation', '--administrator', ISOLATION],
    { token: administratorToken },
  );
  assert.equal(isolation.status, 0, isolation.stderr);

  const operationsToken = signInToken(fixture, workspaceAdministrator);
  const granted = command(
    fixture,
    ['membership', 'grant', '--workspace', operationsId, '--username', ANALYST, '--role', 'Consumer'],
    { token: operationsToken },
  );
  assert.equal(granted.status, 0, granted.stderr);

  return {
    fixture,
    administratorToken,
    deploymentAdministrator: {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    },
    operations: operationsId,
    isolation: String(isolation.output.workspace_id),
    workspaceAdministrator,
    consumer: { username: ANALYST, password: ANALYST_PASSWORD },
    ledgerPath: fileOf(fixture, 'ledger.csv', DEVICE_LEDGER),
    ledgerNextPath: fileOf(fixture, 'ledger-next.csv', DEVICE_LEDGER_NEXT),
    defectivePath: fileOf(fixture, 'ledger-defective.csv', DEVICE_LEDGER_DEFECTIVE),
    driftedPath: fileOf(fixture, 'ledger-drifted.csv', DEVICE_LEDGER_DRIFTED),
    documentsPath: fileOf(fixture, 'documents.json', DOCUMENTS),
    // A ZIP container, an empty file, a UTF-16 export, and a bundle beyond its envelope.
    zipPath: fileOf(fixture, 'ledger.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])),
    emptyPath: fileOf(fixture, 'empty.csv', ''),
    utf16Path: fileOf(fixture, 'ledger-utf16.csv', Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(DEVICE_LEDGER, 'utf16le'),
    ])),
    oversizedPath: fileOf(fixture, 'documents-large.json', JSON.stringify({
      format: 'text',
      documents: [{ doc_id: 'doc-001', title: '标题', text: '正文'.repeat(400) }],
    })),
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

/** Signs in as the Workspace Administrator and opens the Sources surface. */
async function adminSources(browser: Browser, url: string, world: Deployment): Promise<Page> {
  const page = await open(browser, url, '/app');
  await signIn(page, world.workspaceAdministrator);
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  await page.getByRole('link', { name: '数据来源' }).click();
  await page.getByRole('heading', { name: '数据来源', exact: true }).waitFor();
  return page;
}

/** Creates one manual Source through the guided form the browser offers. */
async function createSourceThroughGuide(
  page: Page,
  name: string,
  type: '手动文件（CSV）' | '手动文档集',
): Promise<void> {
  const create = page.getByRole('region', { name: '新建数据来源' });
  await create.getByLabel('来源名称', { exact: true }).fill(name);
  await create.getByLabel('来源类型', { exact: true }).selectOption({ label: type });
  await create.getByRole('button', { name: '创建数据来源' }).click();
  await page.getByText(CREATED(name)).waitFor();
}

interface WizardDeclaration {
  schema: Array<{ name: string; type: string }>;
  identity: string[];
  cleaning: Array<{ field: string; rule: string; value?: string }>;
  mapping: Array<{ column: string; target: string }>;
  limits?: { maxBytes?: string; maxDocuments?: string; maxTextChars?: string };
}

/**
 * Fills the guided Integration Configuration form field by field. Rows are added
 * through the form's own buttons, so nothing here writes JSON.
 */
async function configureThroughWizard(page: Page, declaration: WizardDeclaration): Promise<void> {
  const wizard = page.getByRole('region', { name: '集成配置向导' });
  for (const [index, field] of declaration.schema.entries()) {
    if (index > 0) await wizard.getByRole('button', { name: '添加字段' }).click();
    await wizard.getByLabel(`字段名 ${index + 1}`, { exact: true }).fill(field.name);
    await wizard
      .getByLabel(`字段类型 ${index + 1}`, { exact: true })
      .selectOption({ label: fieldTypeLabel(field.type) });
  }
  for (const field of declaration.identity) {
    await wizard.getByRole('checkbox', { name: field, exact: true }).check();
  }
  for (const [index, rule] of declaration.cleaning.entries()) {
    await wizard.getByRole('button', { name: '添加清洗规则' }).click();
    await wizard.getByLabel(`规则字段 ${index + 1}`, { exact: true }).selectOption({ label: rule.field });
    await wizard
      .getByLabel(`清洗规则 ${index + 1}`, { exact: true })
      .selectOption({ label: cleaningLabel(rule.rule) });
    if (rule.value !== undefined) {
      await wizard.getByLabel(`默认值 ${index + 1}`, { exact: true }).fill(rule.value);
    }
  }
  for (const [index, mapping] of declaration.mapping.entries()) {
    if (index > 0) await wizard.getByRole('button', { name: '添加映射' }).click();
    await wizard.getByLabel(`源列名 ${index + 1}`, { exact: true }).fill(mapping.column);
    await wizard.getByLabel(`目标字段 ${index + 1}`, { exact: true }).selectOption({ label: mapping.target });
  }
  if (declaration.limits?.maxBytes !== undefined) {
    await wizard.getByLabel('最大字节数', { exact: true }).fill(declaration.limits.maxBytes);
  }
  if (declaration.limits?.maxDocuments !== undefined) {
    await wizard.getByLabel('最多文档数', { exact: true }).fill(declaration.limits.maxDocuments);
  }
  if (declaration.limits?.maxTextChars !== undefined) {
    await wizard.getByLabel('单篇正文上限', { exact: true }).fill(declaration.limits.maxTextChars);
  }
}

function fieldTypeLabel(type: string): string {
  switch (type) {
    case 'integer':
      return '整数';
    case 'number':
      return '数值';
    case 'date':
      return '日期';
    case 'timestamp':
      return '时间戳';
    default:
      return '文本';
  }
}

function cleaningLabel(rule: string): string {
  switch (rule) {
    case 'uppercase':
      return '转为大写';
    case 'lowercase':
      return '转为小写';
    case 'default':
      return '空值替换';
    case 'require_non_empty':
      return '必填校验';
    default:
      return '去除首尾空白';
  }
}

/** Previews, publishes and adopts one guided Integration Configuration. */
async function publishThroughWizard(page: Page): Promise<void> {
  const wizard = page.getByRole('region', { name: '集成配置向导' });
  await wizard.getByRole('button', { name: '预览配置' }).focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('region', { name: '声明式配置预览' });
  await preview.getByText(PREVIEW_VALID).waitFor();
  await preview.getByRole('button', { name: '发布配置版本' }).click();
  await page.getByText(PUBLISHED).waitFor();
  await page.getByRole('button', { name: '采纳第 1 版' }).click();
  await page.getByText(ADOPTED).waitFor();
}

/** Uploads one file through the labelled upload control. */
async function uploadThroughBrowser(page: Page, path: string): Promise<void> {
  const upload = page.getByRole('region', { name: '上传受治理内容' });
  await upload.getByLabel('选择文件', { exact: true }).setInputFiles(path);
  await upload.getByRole('button', { name: '上传并集成' }).click();
}

/** The device-ledger Configuration every CSV workflow shares. */
async function configureLedger(page: Page): Promise<void> {
  await configureThroughWizard(page, {
    schema: [
      { name: 'sn', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'handled_count', type: 'integer' },
    ],
    identity: ['sn'],
    cleaning: [
      { field: 'sn', rule: 'trim' },
      { field: 'sn', rule: 'uppercase' },
    ],
    mapping: [
      { column: '设备SN', target: 'sn' },
      { column: '城市', target: 'city' },
      { column: '处理量', target: 'handled_count' },
    ],
  });
}

/** A file Source configured through the browser and ready to acquire. */
async function readyFileSource(page: Page): Promise<void> {
  await createSourceThroughGuide(page, '设备台账', '手动文件（CSV）');
  await page.getByRole('button', { name: '管理 设备台账' }).click();
  await configureLedger(page);
  await publishThroughWizard(page);
}

/** AC1 and AC3: a guided Configuration, one CSV upload, and repeat uploads. */
test('a guided CSV Source publishes an exact declarative Configuration and repeat uploads never duplicate a Release', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);

    // Nothing is authored as JSON: the Source and its Configuration come from
    // the guided forms, and the Configuration is reviewed before publication.
    await createSourceThroughGuide(page, '设备台账', '手动文件（CSV）');
    await page.getByRole('button', { name: '管理 设备台账' }).click();
    await configureLedger(page);

    const wizard = page.getByRole('region', { name: '集成配置向导' });
    await wizard.getByRole('button', { name: '预览配置' }).click();
    const preview = page.getByRole('region', { name: '声明式配置预览' });
    await preview.getByText(PREVIEW_VALID).waitFor();
    const parsed = JSON.parse(await preview.locator('pre').innerText()) as Record<string, unknown>;
    assert.deepEqual(parsed['identity'], ['sn']);
    assert.deepEqual(parsed['schema'], [
      { name: 'sn', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'handled_count', type: 'integer' },
    ]);
    assert.deepEqual(parsed['cleaning'], [
      { rule: 'trim', field: 'sn' },
      { rule: 'uppercase', field: 'sn' },
    ]);
    assert.deepEqual(parsed['mapping'], { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' });
    const previewHash = /配置内容摘要\s*([0-9a-f]{64})/u.exec(await preview.innerText())?.[1];
    assert.ok(previewHash, 'the preview states the exact content hash');
    // Reviewing publishes nothing.
    await page.getByRole('region', { name: '配置版本' }).getByText('尚未发布集成配置版本。').waitFor();

    // Publishing appends one immutable Version whose hash is the reviewed one.
    await preview.getByRole('button', { name: '发布配置版本' }).click();
    await page.getByText(PUBLISHED).waitFor();
    const versions = await page.getByRole('region', { name: '配置版本' }).innerText();
    assert.equal(versions.includes(previewHash), true, versions);
    await page.getByRole('button', { name: '采纳第 1 版' }).click();
    await page.getByText(ADOPTED).waitFor();

    // The governed upload stores one Raw Acquisition and integrates one Release.
    await uploadThroughBrowser(page, world.ledgerPath);
    await page.getByText(UPLOADED(1, 2)).waitFor();
    const release = page.getByRole('region', { name: '数据集发布' });
    await release.getByText('第 1 版', { exact: true }).waitFor();
    const published = await release.innerText();
    assert.match(published, /有效记录\s*2/u);
    assert.match(published, /拒绝记录\s*0/u);
    assert.match(published, /集成配置版本\s*1/u);
    assert.match(published, /采集时间/u);
    assert.match(published, /集成时间/u);
    assert.match(published, /发布时间/u);
    // Source-to-release Provenance names the Batch, the Run and the Raw Acquisition.
    const provenance = await page.getByRole('region', { name: '来源追溯' }).innerText();
    assert.match(provenance, /集成批次/u);
    assert.match(provenance, /采集运行/u);
    assert.match(provenance, /原始采集/u);
    assert.match(provenance, /[0-9a-f]{8}-[0-9a-f]{4}/u);

    // A repeat upload is another Run and another Raw Acquisition, never a new Release.
    const firstProvenance = provenance;
    await uploadThroughBrowser(page, world.ledgerPath);
    await page.getByText(UPLOADED(1, 2)).waitFor();
    assert.match(await page.getByRole('region', { name: '数据集发布' }).innerText(), /第 1 版/u);
    assert.notEqual(await page.getByRole('region', { name: '来源追溯' }).innerText(), firstProvenance);
    assert.match(await page.getByRole('region', { name: '采集运行' }).innerText(), /已完成/u);

    // A changed snapshot publishes the next immutable Release and keeps the first.
    await uploadThroughBrowser(page, world.ledgerNextPath);
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 2 版', { exact: true }).waitFor();
    const history = await page.getByRole('region', { name: '发布历史' }).innerText();
    assert.match(history, /1/u);
    assert.match(history, /2/u);

    // No raw bytes and no raw object locator ever reach the browser.
    const body = await page.locator('body').innerText();
    assert.equal(body.includes('raw-acquisitions'), false, body);
    assert.equal(body.includes(DEVICE_LEDGER), false, body);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC2: the document workflow, its declared envelope, and its Chinese states. */
test('a guided document Source declares its parse envelope and curates documents in the isolated worker', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(page, '设备文档库', '手动文档集');
    await page.getByRole('button', { name: '管理 设备文档库' }).click();
    await configureThroughWizard(page, {
      schema: [
        { name: 'doc_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'text', type: 'string' },
        { name: 'city', type: 'string' },
      ],
      identity: ['doc_id'],
      cleaning: [{ field: 'doc_id', rule: 'trim' }],
      mapping: [
        { column: 'doc_id', target: 'doc_id' },
        { column: 'title', target: 'title' },
        { column: 'text', target: 'text' },
        { column: 'city', target: 'city' },
      ],
      limits: { maxBytes: '4096', maxDocuments: '100', maxTextChars: '2000' },
    });
    await publishThroughWizard(page);

    // The reviewed declaration carries the explicit document envelope.
    await page.getByRole('button', { name: '预览配置' }).click();
    const preview = page.getByRole('region', { name: '声明式配置预览' });
    await preview.getByText(PREVIEW_VALID).waitFor();
    const parsed = JSON.parse(await preview.locator('pre').innerText()) as Record<string, unknown>;
    assert.deepEqual(parsed['document_limits'], {
      max_bytes: 4096,
      max_documents: 100,
      max_text_chars: 2000,
      max_metadata_fields: 64,
      max_worker_ms: 5000,
      max_heap_mb: 128,
    });

    // Documents are curated, and the Release pins the parser and its envelope.
    await uploadThroughBrowser(page, world.documentsPath);
    await page.getByText(UPLOADED(1, 2)).waitFor();
    const release = page.getByRole('region', { name: '数据集发布' });
    await release.getByText('第 1 版', { exact: true }).waitFor();
    const published = await release.innerText();
    assert.match(published, /有效记录\s*2/u);
    assert.match(published, /文档解析/u);
    assert.match(published, /document-bundle/u);
    assert.match(published, /4096/u);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC2: every upload rule fails closed with its own explicit Chinese state. */
test('uploads validate signature, size, encoding and source rules with explicit Chinese failure states', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);

    // A Source with no adopted Configuration refuses content before reading it.
    await createSourceThroughGuide(page, '未配置台账', '手动文件（CSV）');
    await page.getByRole('button', { name: '管理 未配置台账' }).click();
    await uploadThroughBrowser(page, world.ledgerPath);
    const upload = page.getByRole('region', { name: '上传受治理内容' });
    await upload.getByRole('alert').getByText(NOT_ADOPTED).waitFor();
    assert.equal(await upload.getByRole('alert').getAttribute('role'), 'alert');
    assert.match(await upload.getByRole('alert').innerText(), /SOURCE_INTEGRATION_NOT_ADOPTED/u);

    // A file Source refuses a binary container, an empty file, and non-UTF-8 text.
    await configureLedger(page);
    await publishThroughWizard(page);

    await uploadThroughBrowser(page, world.zipPath);
    await upload.getByText(BAD_SIGNATURE).waitFor();
    assert.match(await upload.innerText(), /ACQUISITION_FILE_SIGNATURE_INVALID/u);

    await uploadThroughBrowser(page, world.emptyPath);
    await upload.getByText(EMPTY_FILE).waitFor();

    await uploadThroughBrowser(page, world.utf16Path);
    await upload.getByText(NOT_UTF8).waitFor();
    assert.match(await upload.innerText(), /ACQUISITION_FILE_ENCODING_INVALID/u);

    // Nothing above published a Release: every rule failed before anything governed.
    await page.getByRole('region', { name: '数据集发布' }).getByText('尚未发布数据集。').waitFor();

    // The declared document envelope is enforced at upload, not by truncation.
    await createSourceThroughGuide(page, '设备文档库', '手动文档集');
    await page.getByRole('button', { name: '管理 设备文档库' }).click();
    await configureThroughWizard(page, {
      schema: [
        { name: 'doc_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'text', type: 'string' },
      ],
      identity: ['doc_id'],
      cleaning: [],
      mapping: [
        { column: 'doc_id', target: 'doc_id' },
        { column: 'title', target: 'title' },
        { column: 'text', target: 'text' },
      ],
      limits: { maxBytes: '512' },
    });
    await publishThroughWizard(page);
    await uploadThroughBrowser(page, world.oversizedPath);
    await upload.getByText(TOO_LARGE).waitFor();
    await page.getByRole('region', { name: '数据集发布' }).getByText('尚未发布数据集。').waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC4: Record Rejections govern what they can, and a breaking batch preserves the Release. */
test('Record Rejections and a breaking batch explain valid versus rejected outcomes without replacing the Release', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await readyFileSource(page);

    await uploadThroughBrowser(page, world.ledgerPath);
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 1 版', { exact: true }).waitFor();

    // Ordinary record-level rejections still publish the rest of the snapshot.
    await uploadThroughBrowser(page, world.defectivePath);
    await page.getByRole('region', { name: '数据集发布' }).getByText('第 2 版', { exact: true }).waitFor();
    const rejected = page.getByRole('region', { name: '记录拒绝' });
    await rejected.getByText('有效 1 条，拒绝 3 条。').waitFor();
    const rows = await rejected.locator('tbody tr').allInnerTexts();
    assert.equal(rows.length, 3, rows.join('\n'));
    assert.match(rows.join('\n'), /同一批次内标识重复/u);
    assert.match(rows.join('\n'), /不是整数/u);
    assert.match(rows.join('\n'), /标识为空/u);
    assert.match(rows[0] ?? '', /^3\b/u);
    assert.match(rows[1] ?? '', /^4\b/u);
    assert.match(rows[2] ?? '', /^5\b/u);
    // The ASCII rule and reason stay visible beside the Chinese sentence.
    assert.match(rows.join('\n'), /DUPLICATE_IDENTITY/u);
    assert.match(rows.join('\n'), /NOT_INTEGER/u);
    assert.match(rows.join('\n'), /IDENTITY_MISSING/u);

    // A batch whose source columns drifted is refused as a whole.
    await uploadThroughBrowser(page, world.driftedPath);
    await page.getByRole('region', { name: '上传受治理内容' }).getByText(DRIFT).waitFor();
    const preserved = await page.getByRole('region', { name: '数据集发布' }).innerText();
    assert.match(preserved, /第 2 版/u);
    assert.equal(preserved.includes('第 3 版'), false, preserved);
    // The failure states what the current Release still is, so nobody reads a gap.
    await page.getByText(PRESERVED(2)).waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC5: Workspace authorization, substitution, and the API behind the form. */
test('Source configuration and acquisition stay Workspace-scoped, default-deny, and free of raw bytes', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const admin = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(admin, '设备台账', '手动文件（CSV）');
    const adminCookie = await cookieHeader(admin.context());

    // The list is scoped to the active Workspace and carries nothing raw.
    const listed = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie: adminCookie },
    );
    assert.equal(listed.status, 200, listed.text);
    const sources = listed.body['sources'] as Array<Record<string, unknown>>;
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!['name'], '设备台账');
    const sourceId = String(sources[0]!['source_id']);
    assert.equal(JSON.stringify(listed.body).includes('raw-acquisitions'), false, listed.text);
    assert.equal(JSON.stringify(listed.body).includes(DEVICE_LEDGER), false, listed.text);

    // Substituting another Workspace's identifier answers like one that names nothing.
    const foreign = await callApi(consoleServer.url, `/api/workspace/sources/${world.isolation}/acquisitions`, {
      cookie: adminCookie,
      body: Buffer.from(DEVICE_LEDGER),
      contentType: 'application/octet-stream',
    });
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(foreign.body.code, 'SOURCE_NOT_AVAILABLE');
    // A substitute identifier answers exactly like one that names nothing.
    const missing = await callApi(consoleServer.url, `/api/workspace/sources/${RANDOM_SOURCE}/acquisitions`, {
      cookie: adminCookie,
      body: Buffer.from(DEVICE_LEDGER),
      contentType: 'application/octet-stream',
    });
    assert.deepEqual(missing.body, foreign.body);
    assert.equal(missing.status, foreign.status);

    // A Consumer reaches none of it, in the browser or over the API.
    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, world.consumer);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '数据来源' }).count(), 0);
    const consumerCookie = await cookieHeader(consumerPage.context());
    const consumerList = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie: consumerCookie },
    );
    assert.equal(consumerList.status, 403, consumerList.text);
    assert.equal(consumerList.body.code, 'WORKSPACE_ACCESS_DENIED');
    const consumerUpload = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${sourceId}/acquisitions`,
      { cookie: consumerCookie, body: Buffer.from(DEVICE_LEDGER), contentType: 'application/octet-stream' },
    );
    assert.equal(consumerUpload.status, 403, consumerUpload.text);
    assert.equal(consumerUpload.body.code, 'SOURCE_NOT_AVAILABLE');

    // A Deployment Administrator holds no implicit Workspace content.
    const deploymentPage = await open(browser, consoleServer.url, '/app');
    await signIn(deploymentPage, world.deploymentAdministrator);
    await deploymentPage.getByRole('heading', { name: '工作区' }).waitFor();
    await deploymentPage.goto(`${consoleServer.url}/app/w/${world.operations}/sources`);
    await deploymentPage.getByRole('heading', { name: '工作区不可用' }).waitFor();
    const deploymentCookie = await cookieHeader(deploymentPage.context());
    const deploymentDenied = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie: deploymentCookie },
    );
    assert.equal(deploymentDenied.status, 403, deploymentDenied.text);

    // A refused Configuration is audited as a failure with its own code.
    const refused = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${sourceId}/configuration/preview`,
      { cookie: adminCookie, body: { declaration: { identity: [], schema: [], cleaning: [], mapping: {} } } },
    );
    assert.equal(refused.status, 200, refused.text);
    assert.equal(refused.body['valid'], false);
    await admin.getByRole('link', { name: '审计' }).click();
    const audit = await admin.getByRole('region', { name: '审计事件' });
    await audit.getByText('source_creation').first().waitFor();
    assert.match(await audit.innerText(), /失败/u);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** AC1: an invalid guided Configuration previews its exact reasons and publishes nothing. */
test('an invalid guided Configuration previews its exact Chinese reasons and publishes nothing', async () => {
  const world = deployment();
  const consoleServer = await startConsole(world.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await adminSources(browser, consoleServer.url, world);
    await createSourceThroughGuide(page, '设备台账', '手动文件（CSV）');
    await page.getByRole('button', { name: '管理 设备台账' }).click();

    const wizard = page.getByRole('region', { name: '集成配置向导' });
    await configureThroughWizard(page, {
      schema: [
        { name: 'sn', type: 'string' },
        { name: 'city', type: 'string' },
      ],
      identity: ['sn'],
      cleaning: [],
      // The city field is left unmapped, so review must refuse to publish.
      mapping: [
        { column: '设备SN', target: 'sn' },
      ],
    });
    await wizard.getByRole('button', { name: '预览配置' }).click();
    const preview = page.getByRole('region', { name: '声明式配置预览' });
    await preview.getByText(PREVIEW_INVALID).waitFor();
    assert.equal(await preview.getByRole('button', { name: '发布配置版本' }).count(), 0);
    assert.match(await preview.innerText(), /INTEGRATION_MAPPING_INCOMPLETE/u);

    // The same refusal is what the API answers, so the form invents no rule.
    const cookie = await cookieHeader(page.context());
    const listed = await callApi(
      consoleServer.url,
      `/api/workspace/sources?workspace_id=${world.operations}`,
      { cookie },
    );
    const sourceId = String((listed.body['sources'] as Array<{ source_id: string }>)[0]?.source_id);
    const refused = await callApi(
      consoleServer.url,
      `/api/workspace/sources/${sourceId}/configuration/publish`,
      {
        cookie,
        body: {
          declaration: {
            identity: ['sn'],
            schema: [
              { name: 'sn', type: 'string' },
              { name: 'city', type: 'string' },
            ],
            cleaning: [],
            mapping: { 设备SN: 'sn' },
          },
        },
      },
    );
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body.code, 'INTEGRATION_MAPPING_INCOMPLETE');

    // Nothing was published by either attempt.
    await page.getByRole('region', { name: '配置版本' }).getByText('尚未发布集成配置版本。').waitFor();
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
