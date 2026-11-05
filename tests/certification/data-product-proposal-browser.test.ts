import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { commandAsync } from '../support/async-command.js';
import { callApi, startConsole } from '../support/console.js';
import { LEDGER, acquireAndRelease, publishSource } from '../support/data-product.js';
import { MOCK_MODEL_ID, startMockModelEndpoint } from '../support/model-endpoint.js';
import {
  command,
  contextEntries,
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

const PURPOSES = ['data_product_proposal', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['dataset_schema', 'sample_records'];
const PROMPTS = {
  data_product_proposal: '你是数据产品助手，只输出简体中文说明，并按结构化输出返回候选 Data Product Contract。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

/** The Metric Definitions the Workspace Business Context publishes before any Release. */
const METRIC_DEFINITIONS = [
  { key: 'handled_count_total', kind: 'metric', value: '处理量合计', unit: '次' },
  { key: 'settled_amount_total', kind: 'metric', value: '结算金额合计', unit: '元' },
  { key: 'device_count', kind: 'metric', value: '记录条数' },
];

/** The broad Chinese requirement the model has to ask about before generating. */
const BROAD_REQUIREMENT = '请帮我整理一下这份设备数据。';
const CLARIFIED_REQUIREMENT = '按城市统计 SN 的设备数与处理量合计，时间范围为 2026 年 1 月。';
/** A requirement that already names a governed identifier needs no clarification. */
const NAMED_REQUIREMENT = '按城市统计 SN 的设备数与处理量合计。';
const CHANGED_REQUIREMENT = '按城市统计 SN 的结算金额合计。';

const PRODUCT_NAME = '设备处理量台账';

/** A later ledger, so the second Dataset Release genuinely moves the input. */
const EXPANDED_LEDGER = [
  '设备SN,城市,处理量,结算金额,上报日期',
  'sn-001,杭州,3,120.50,2026-01-05',
  'sn-002,上海,5,300.00,2026-01-12',
  'sn-003,,2,,2026-01-20',
  'sn-004,杭州,1,50.00,2026-01-25',
].join('\n');

interface Credentials {
  username: string;
  password: string;
  totp: string;
}

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  workspaceToken: string;
  deploymentToken: string;
  operations: Credentials;
  analyst: Credentials;
  sourceId: string;
  consumerToken: string;
  bindingLabel: string;
}

function asRecord(value: unknown): Config {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Config;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

/** One Deployment, one Workspace holding a governed Dataset Release. */
function world(): World {
  const fixture = initializePlatform();
  const deploymentToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, deploymentToken, OPERATIONS, OPERATIONS_PASSWORD);
  const created = command(
    fixture,
    ['workspace', 'create', '--name', '运营中心', '--administrator', OPERATIONS],
    { token: deploymentToken },
  );
  assert.equal(created.status, 0, created.stderr);
  const workspaceId = String(created.output['workspace_id']);
  const operationsTotp = String(created.output['totp_secret']);
  registerTotp(fixture, OPERATIONS, operationsTotp);
  const workspaceToken = sessionFor(fixture, OPERATIONS, OPERATIONS_PASSWORD);
  createUser(fixture, deploymentToken, ANALYST, ANALYST_PASSWORD);
  grantRole(fixture, workspaceToken, workspaceId, ANALYST, 'Consumer');

  const definitions = command(
    fixture,
    ['context', 'publish-workspace', '--workspace', workspaceId, '--entries', contextEntries(fixture, 'definitions', METRIC_DEFINITIONS)],
    { token: workspaceToken },
  );
  assert.equal(definitions.status, 0, definitions.stderr);

  const sourceId = publishSource(fixture, workspaceToken, workspaceId);
  acquireAndRelease(fixture, workspaceToken, sourceId);

  return {
    fixture,
    workspaceId,
    workspaceToken,
    deploymentToken,
    operations: { username: OPERATIONS, password: OPERATIONS_PASSWORD, totp: operationsTotp },
    analyst: { username: ANALYST, password: ANALYST_PASSWORD, totp: '' },
    sourceId,
    consumerToken: sessionFor(fixture, ANALYST, ANALYST_PASSWORD),
    bindingLabel: '产品提案档案 · v1',
  };
}

/** Publishes, evaluates, activates, and binds one Model Profile Version for the Workspace. */
async function activatedBinding(current: World, endpointUrl: string): Promise<void> {
  const { fixture, deploymentToken, workspaceToken, workspaceId } = current;
  const published = command(
    fixture,
    ['model', 'publish', '--name', '产品提案档案', '--config', jsonFile(fixture, 'model-profile', {
      adapter: 'hosted',
      endpoint_url: endpointUrl,
      model_id: MOCK_MODEL_ID,
      purposes: [...PURPOSES],
      data_categories: [...DATA_CATEGORIES],
      tools: [],
      max_output_bytes: 65_536,
      prompts: { ...PROMPTS },
    })],
    { token: deploymentToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const profileId = String(published.output['model_profile_id']);
  const version = Number(published.output['model_profile_version']);
  const evaluated = await commandAsync(
    fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: deploymentToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(
    fixture,
    ['model', 'activate', '--profile', profileId, '--version', String(version)],
    { token: deploymentToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    fixture,
    [
      'binding', 'publish', '--workspace', workspaceId, '--profile', profileId,
      '--config', jsonFile(fixture, 'binding', {
        model_profile_version: version,
        purposes: [...PURPOSES],
        data_categories: [...DATA_CATEGORIES],
      }),
    ],
    { token: workspaceToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
}

async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  if (credentials.totp !== '') {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(credentials.totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
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

/** The production facts the browser must leave unchanged until Publication lands. */
function productionState(current: World): { products: string; datasets: string } {
  const state = JSON.parse(readFileSync(join(current.fixture.root, 'state', 'platform.json'), 'utf8')) as Config;
  return {
    products: JSON.stringify(state['data_products'] ?? []),
    datasets: JSON.stringify(state['datasets'] ?? []),
  };
}

/** The proposals the browser reads, from the same authorized HTTP contract. */
async function listed(url: string, cookie: string, sourceId: string): Promise<Config[]> {
  const list = await callApi(url, `/api/workspace/sources/${sourceId}/product-proposals`, { cookie });
  assert.equal(list.status, 200, list.text);
  return (list.body['proposals'] as Config[]).map(asRecord);
}

/** Opens the Data Product Proposal workflow and selects the governed Source. */
async function openWorkflow(page: Page, current: World): Promise<void> {
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  await page.getByRole('link', { name: '数据产品提案' }).click();
  await page.getByRole('heading', { name: '数据产品提案', exact: true }).waitFor();
  const sourcePanel = page.getByRole('region', { name: '选择数据来源' });
  await sourcePanel.getByLabel('数据来源', { exact: true }).selectOption({ label: '设备台账' });
}

/** Re-selects the Source on a page that already shows the workflow. */
async function reselectSource(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '数据产品提案', exact: true }).waitFor();
  const sourcePanel = page.getByRole('region', { name: '选择数据来源' });
  await sourcePanel.getByLabel('数据来源', { exact: true }).selectOption({ label: '设备台账' });
}

async function generate(page: Page, current: World, name: string, requirement: string): Promise<void> {
  const form = page.getByRole('region', { name: '生成数据产品提案' });
  await form.getByLabel('工作区模型绑定', { exact: true }).selectOption({ label: current.bindingLabel });
  await form.getByLabel('数据产品名称', { exact: true }).fill(name);
  await form.getByLabel('中文需求', { exact: true }).fill(requirement);
  await form.getByRole('button', { name: '生成数据产品提案' }).click();
}

async function validateAndPreview(page: Page): Promise<void> {
  const detail = page.getByRole('region', { name: '提案详情' });
  const validation = detail.getByRole('region', { name: '确定性校验' });
  await validation.getByRole('button', { name: '运行确定性校验' }).click();
  await validation.getByText('记录粒度唯一').waitFor();
  const preview = detail.getByRole('region', { name: '代表性预览' });
  await preview.getByRole('button', { name: '运行代表性预览' }).click();
  await preview.getByText('API 形态').waitFor();
}

async function approve(page: Page, proposalId: string): Promise<void> {
  const detail = page.getByRole('region', { name: '提案详情' });
  await detail.getByRole('region', { name: '审批与发布' }).getByRole('button', { name: '批准提案' }).click();
  const confirmation = page.getByRole('region', { name: '确认批准数据产品提案' });
  const text = await confirmation.innerText();
  assert.match(text, /对象/u);
  assert.match(text, /范围/u);
  assert.match(text, /影响/u);
  assert.ok(text.includes(proposalId));
  await confirmation.getByRole('button', { name: '确认批准' }).click();
}

async function publish(page: Page): Promise<void> {
  const detail = page.getByRole('region', { name: '提案详情' });
  await detail.getByRole('region', { name: '审批与发布' }).getByRole('button', { name: '发布数据产品' }).click();
  const confirmation = page.getByRole('region', { name: '确认发布数据产品' });
  assert.match(await confirmation.innerText(), /影响/u);
  await confirmation.getByRole('button', { name: '确认发布' }).click();
}

/** The one aggregate answer a Consumer reads from the governed API. */
const AGGREGATE_QUERY = {
  kind: 'aggregate',
  group_by: ['city'],
  metrics: ['handled_count_total', 'settled_amount_total', 'device_count'],
  include_totals: true,
};

test('a Chinese requirement, its clarification, and the Contract preview become the exact Data Product a Workspace Administrator approves and publishes, and its governed API answers automatically', async () => {
  const endpoint = await startMockModelEndpoint();
  let browser: Browser | undefined;
  try {
    const current = world();
    await activatedBinding(current, endpoint.url);
    const before = productionState(current);

    const consoleServer = await startConsole(current.fixture);
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await open(browser, consoleServer.url, '/app');
      await signIn(page, current.operations);
      await openWorkflow(page, current);
      await page.getByText('尚未生成任何数据产品提案。').waitFor();

      // A broad Chinese requirement is refused with one deterministic Chinese
      // clarification, and the refusal creates no Proposal at all.
      await generate(page, current, PRODUCT_NAME, BROAD_REQUIREMENT);
      const clarification = page.getByRole('region', { name: '澄清问题' });
      await clarification.waitFor();
      const question = await clarification.innerText();
      assert.match(question, /时间范围/u);
      assert.equal(question.includes('PRODUCT_PROPOSAL_'), false);
      assert.equal((await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId)).length, 0);

      // The recorded Chinese answer completes the requirement, and generation lands
      // exactly one pending Proposal whose requirement content is immutable.
      await clarification.getByLabel('澄清答复', { exact: true }).fill(CLARIFIED_REQUIREMENT);
      await clarification.getByRole('button', { name: '带上澄清重新生成' }).click();
      await page.getByRole('region', { name: '提案详情' }).waitFor();
      const first = await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      assert.equal(first.length, 1);
      const proposal = first[0]!;
      assert.equal(proposal['status'], 'pending');
      assert.equal(asRecord(proposal['freshness'])['fresh'], true);
      const requirement = asRecord(proposal['requirement']);
      assert.equal(requirement['text'], BROAD_REQUIREMENT);
      const clarifications = asArray(requirement['clarifications']);
      assert.equal(clarifications.length, 1);
      assert.equal(asRecord(clarifications[0])['answer'], CLARIFIED_REQUIREMENT);
      assert.match(String(requirement['hash']), /^[0-9a-f]{64}$/u);
      const candidates = asRecord(proposal['candidates']);
      assert.equal(candidates['name'], PRODUCT_NAME);
      const contract = asRecord(candidates['contract']);
      assert.deepEqual(asArray(contract['grain']), ['sn']);
      assert.deepEqual(asArray(contract['dimensions']), ['city']);
      assert.match(String(candidates['contract_hash']), /^[0-9a-f]{64}$/u);
      assert.equal(asRecord(proposal['base'])['dataset_release'], 1);
      assert.equal(asRecord(proposal['base'])['data_product_id'], null);

      // The browser shows the exact candidate, its requirement and clarification,
      // the Contract shape, and the Provenance addresses — never a raw error code.
      const detail = page.getByRole('region', { name: '提案详情' });
      await detail.locator('span.pill').filter({ hasText: '待审批' }).waitFor();
      await detail.getByRole('region', { name: '已记录的澄清问答' }).waitFor();
      const contractPanel = detail.getByRole('region', { name: '候选契约' });
      const contractText = await contractPanel.innerText();
      for (const copy of [
        PRODUCT_NAME,
        'sn',
        'city',
        'handled_count',
        'settled_amount',
        'reported_on',
        'handled_count_total',
        'settled_amount_total',
        'device_count',
        '求和',
        '计数',
        '处理量合计',
        'Asia/Shanghai',
      ]) {
        assert.ok(contractText.includes(copy), `the Contract panel does not show ${copy}`);
      }
      const evidenceText = await detail.innerText();
      for (const hash of [
        String(requirement['hash']),
        String(candidates['contract_hash']),
        String(candidates['content_hash']),
        String(proposal['proposal_hash']),
        String(asRecord(proposal['evidence'])['dataset_release_hash']),
      ]) {
        assert.ok(evidenceText.includes(hash), `the browser did not show ${hash}`);
      }
      assert.ok(evidenceText.includes(BROAD_REQUIREMENT));
      assert.ok(evidenceText.includes(CLARIFIED_REQUIREMENT));
      assert.equal(evidenceText.includes('PRODUCT_PROPOSAL_'), false);
      assert.deepEqual(productionState(current), before);

      // Deterministic validation proves every Contract name against the real
      // Release, and the isolated preview exposes the API shape, example queries,
      // representative results, freshness, Provenance, and Chinese narration.
      await validateAndPreview(page);
      assert.deepEqual(productionState(current), before);
      const validated = (await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId))[0]!;
      assert.equal(asArray(validated['validations']).length, 1);
      assert.equal(asArray(validated['previews']).length, 1);
      const validation = asRecord(asArray(validated['validations'])[0]);
      assert.deepEqual(validation['checks'], [
        'contract:valid',
        'fields:resolved',
        'dimensions:resolved',
        'metrics:defined',
        'grain:unique',
        'dataset_release:current',
      ]);
      assert.equal(validation['dataset_release'], 1);
      const preview = asRecord(asArray(validated['previews'])[0]);
      const apiShape = asRecord(preview['api_shape']);
      assert.equal(apiShape['method'], 'POST');
      assert.equal(apiShape['route'], '/api/workspaces/{workspace_id}/data-products/{data_product_id}/query');
      assert.equal(apiShape['api_path'], null);
      assert.equal(asArray(preview['example_queries']).length, 2);
      const totals = asRecord(asRecord(asRecord(asArray(preview['representative_results'])[0])['totals'])['metrics']);
      assert.deepEqual(totals, { handled_count_total: 10, settled_amount_total: '420.50', device_count: 3 });
      assert.equal(asRecord(preview['freshness'])['dataset_release'], 1);
      assert.equal(asRecord(preview['freshness'])['dataset_record_count'], 3);
      assert.equal(asRecord(preview['provenance'])['record_count'], 3);
      assert.match(String(preview['evidence_hash']), /^[0-9a-f]{64}$/u);

      const previewText = await detail.getByRole('region', { name: '代表性预览' }).innerText();
      for (const copy of [
        'POST',
        '/api/workspaces/{workspace_id}/data-products/{data_product_id}/query',
        '示例查询',
        '代表性结果',
        '数据新鲜度',
        '来源追溯',
        'sn-001',
        '10',
        '420.50',
        '设备处理量台账',
      ]) {
        assert.ok(previewText.includes(copy), `the preview does not show ${copy}`);
      }

      // Approval is exact and states its target, scope, and consequence before it lands.
      await approve(page, String(proposal['proposal_id']));
      await detail.locator('span.pill').filter({ hasText: '已批准' }).waitFor();
      const approved = await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      const decision = asRecord(asArray(approved[0]!['decisions'])[0]);
      assert.equal(decision['outcome'], 'approved');
      const approvalProv = asRecord(decision['provenance']);
      assert.equal(approvalProv['requirement_hash'], requirement['hash']);
      assert.equal(approvalProv['candidate_content_hash'], candidates['content_hash']);
      assert.equal(approvalProv['preview_hash'], preview['evidence_hash']);
      assert.equal(approvalProv['validation_hash'], validation['evidence_hash']);

      // Publication is a separate, separately confirmed action, and the browser
      // reads back the exact API path it exposes.
      await publish(page);
      await detail.locator('span.pill').filter({ hasText: '已发布' }).waitFor();
      const published = (await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId))[0]!;
      const publication = asRecord(asArray(published['publications'])[0]);
      assert.equal(publication['data_product_version'], 1);
      assert.equal(publication['data_product_release'], 1);
      assert.equal(publication['dataset_release'], 1);
      assert.equal(publication['contract_hash'], candidates['contract_hash']);
      const apiPath = String(publication['api_path']);
      assert.equal(apiPath, `/api/workspaces/${current.workspaceId}/data-products/${String(publication['data_product_id'])}/query`);
      const publishedPanel = await detail.getByRole('region', { name: '已发布的数据产品 API' }).innerText();
      assert.ok(publishedPanel.includes(apiPath));
      assert.match(publishedPanel, /数据产品版本[\s\S]*1/u);
      assert.match(publishedPanel, /发布版本[\s\S]*1/u);

      // The existing Data Product API serves the new Version; nothing was generated.
      const serverAnswer = await callApi(consoleServer.url, apiPath, {
        body: AGGREGATE_QUERY,
        token: current.consumerToken,
      });
      assert.equal(serverAnswer.status, 200, serverAnswer.text);
      assert.equal(serverAnswer.body['contract_hash'], candidates['contract_hash']);
      assert.equal(serverAnswer.body['data_product_version'], 1);
      assert.equal(serverAnswer.body['data_product_release'], 1);
      assert.deepEqual(asRecord(asRecord(serverAnswer.body['totals'])['metrics']), {
        handled_count_total: 10,
        settled_amount_total: '420.50',
        device_count: 3,
      });
      assert.equal(serverAnswer.body['groups_total'], 3);

      const after = productionState(current);
      const products = JSON.parse(after.products) as Config[];
      assert.equal(products.length, 1);
      assert.equal(products[0]!['api_path'], apiPath);
      assert.deepEqual(
        Object.keys(products[0]!).filter((key) => ['code', 'endpoint', 'handler', 'module', 'route', 'routes'].includes(key)),
        [],
      );
      assert.equal(asArray(products[0]!['versions']).length, 1);
      assert.equal(asArray(products[0]!['releases']).length, 1);
      assert.equal(after.datasets, before.datasets);

      // A Consumer discovers the same Data Product in the browser and holds no
      // Proposal surface at all.
      const consumerPage = await open(browser, consoleServer.url, '/app');
      await signIn(consumerPage, current.analyst);
      await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
      assert.equal(await consumerPage.getByRole('link', { name: '数据产品提案' }).count(), 0);
      await consumerPage.getByRole('link', { name: '数据产品', exact: true }).click();
      const listedRow = consumerPage.getByRole('row').filter({ hasText: PRODUCT_NAME });
      await listedRow.waitFor();
      assert.ok((await listedRow.innerText()).includes(apiPath));

      // Every surface this ticket adds reads in Simplified Chinese only.
      const body = await page.locator('body').innerText();
      for (const word of [
        'Generate', 'Approve', 'Publish', 'Contract', 'Preview', 'Proposal', 'Requirement',
        'Validation', 'Dataset', 'Source',
      ]) {
        assert.equal(body.includes(word), false, `${word} leaks into the page`);
      }
    } finally {
      await consoleServer.stop();
    }
  } finally {
    await browser?.close();
    await endpoint.close();
  }
});

test('failed validation, stale inputs, changed requirements, and a rejected candidate leave the published Data Product serving unchanged', async () => {
  const endpoint = await startMockModelEndpoint();
  let browser: Browser | undefined;
  try {
    const current = world();
    await activatedBinding(current, endpoint.url);

    const consoleServer = await startConsole(current.fixture);
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await open(browser, consoleServer.url, '/app');
      await signIn(page, current.operations);
      await openWorkflow(page, current);

      // Publish one exact Data Product through the browser first.
      await generate(page, current, PRODUCT_NAME, NAMED_REQUIREMENT);
      await page.getByRole('region', { name: '提案详情' }).waitFor();
      await validateAndPreview(page);
      const [publishedProposal] = await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      assert.ok(publishedProposal !== undefined);
      await approve(page, String(publishedProposal['proposal_id']));
      await publish(page);
      const detail = page.getByRole('region', { name: '提案详情' });
      await detail.locator('span.pill').filter({ hasText: '已发布' }).waitFor();
      const publishedFact = asRecord(asArray((await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId))[0]!['publications'])[0]);
      const apiPath = String(publishedFact['api_path']);
      const serving = await callApi(consoleServer.url, apiPath, { body: AGGREGATE_QUERY, token: current.consumerToken });
      assert.equal(serving.status, 200, serving.text);
      const afterPublish = productionState(current);

      // A changed Chinese requirement is new Proposal content; it can never ride
      // on the published Approval.
      await generate(page, current, PRODUCT_NAME, CHANGED_REQUIREMENT);
      await detail.waitFor();
      const proposals = await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      assert.equal(proposals.length, 2);
      const changed = proposals.find((entry) => entry['proposal_id'] !== publishedProposal['proposal_id']);
      assert.ok(changed !== undefined);
      assert.equal(asRecord(changed['requirement'])['text'], CHANGED_REQUIREMENT);
      assert.notEqual(changed['proposal_hash'], publishedProposal['proposal_hash']);
      const changedId = String(changed['proposal_id']);

      // Approval without validation is refused, and nothing is published.
      const actions = detail.getByRole('region', { name: '审批与发布' });
      await actions.getByRole('button', { name: '批准提案' }).click();
      await page.getByRole('region', { name: '确认批准数据产品提案' }).getByRole('button', { name: '确认批准' }).click();
      await detail.getByText('PRODUCT_PROPOSAL_VALIDATION_REQUIRED').waitFor();
      assert.ok((await detail.innerText()).includes('提案必须先通过确定性校验，才能批准。'));

      // Approval without a preview is refused too.
      const validation = detail.getByRole('region', { name: '确定性校验' });
      await validation.getByRole('button', { name: '运行确定性校验' }).click();
      await validation.getByText('记录粒度唯一').waitFor();
      await actions.getByRole('button', { name: '批准提案' }).click();
      await page.getByRole('region', { name: '确认批准数据产品提案' }).getByRole('button', { name: '确认批准' }).click();
      await detail.getByText('PRODUCT_PROPOSAL_PREVIEW_REQUIRED').waitFor();
      assert.ok((await detail.innerText()).includes('提案必须先完成代表性预览，才能批准。'));

      // The real preview still succeeds and writes nothing production-visible.
      const preview = detail.getByRole('region', { name: '代表性预览' });
      await preview.getByRole('button', { name: '运行代表性预览' }).click();
      await preview.getByText('API 形态').waitFor();
      assert.deepEqual(productionState(current), afterPublish);

      // Moving the Dataset Release makes the Proposal stale: reload shows it, and
      // Approval and Publication fail closed.
      acquireAndRelease(current.fixture, current.workspaceToken, current.sourceId, EXPANDED_LEDGER, 'expanded.csv');
      const beforeFailure = productionState(current);
      await page.reload();
      await reselectSource(page);
      const staleRow = page.getByRole('row').filter({ hasText: '已变化' });
      await staleRow.first().waitFor();
      const reloadedDetail = page.getByRole('region', { name: '提案详情' });
      await reloadedDetail.getByText('基线数据集版本、业务上下文或数据产品版本已变化，请重新生成提案。').waitFor();
      await reloadedDetail.getByText(CHANGED_REQUIREMENT).first().waitFor();
      await approve(page, changedId);
      await reloadedDetail.getByText('PRODUCT_PROPOSAL_BASE_STALE').waitFor();
      assert.ok((await reloadedDetail.innerText()).includes('基线数据集版本、业务上下文或数据产品版本已变化，请重新生成提案。'));
      const reloadedActions = reloadedDetail.getByRole('region', { name: '审批与发布' });
      await reloadedActions.getByRole('button', { name: '发布数据产品' }).click();
      await page.getByRole('region', { name: '确认发布数据产品' }).getByRole('button', { name: '确认发布' }).click();
      await reloadedDetail.getByText('PRODUCT_PROPOSAL_NOT_APPROVED').waitFor();
      assert.ok((await reloadedDetail.innerText()).includes('只有已批准的数据产品提案才能发布。'));

      // Rejecting the stale candidate terminates only that candidate.
      await reloadedActions.getByLabel('驳回原因', { exact: true }).fill('基线版本已变化，终止该候选。');
      await reloadedActions.getByRole('button', { name: '驳回提案' }).click();
      await page.getByRole('region', { name: '确认驳回数据产品提案' }).getByRole('button', { name: '确认驳回' }).click();
      await reloadedDetail.locator('span.pill').filter({ hasText: '已驳回' }).waitFor();
      const afterRejection = await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      const rejected = afterRejection.find((entry) => entry['proposal_id'] === changedId);
      assert.ok(rejected !== undefined);
      assert.equal(rejected['status'], 'rejected');
      assert.equal(asRecord(asArray(rejected['decisions'])[0])['outcome'], 'rejected');

      // A candidate the deterministic Contract reader refuses is never recorded.
      endpoint.behaviour = 'unauthorized_field';
      await generate(page, current, '越权台账', NAMED_REQUIREMENT);
      const form = page.getByRole('region', { name: '生成数据产品提案' });
      await form.getByText('候选契约与数据集不兼容，请重新生成数据产品提案。').waitFor();
      assert.ok((await form.innerText()).includes('PRODUCT_PROPOSAL_CANDIDATE_INVALID'));
      assert.equal((await listed(consoleServer.url, await cookieHeader(page.context()), current.sourceId)).length, 2);

      // The published Contract and its governed API keep answering exactly what
      // they answered before every failure.
      const afterFailure = productionState(current);
      assert.equal(afterFailure.products, beforeFailure.products);
      assert.equal(afterFailure.datasets, beforeFailure.datasets);
      const served = await callApi(consoleServer.url, apiPath, { body: AGGREGATE_QUERY, token: current.consumerToken });
      assert.equal(served.status, 200, served.text);
      assert.deepEqual(asRecord(asRecord(served.body['totals'])['metrics']), {
        handled_count_total: 10,
        settled_amount_total: '420.50',
        device_count: 3,
      });
      assert.equal(served.body['contract_hash'], publishedFact['contract_hash']);

      // A Consumer holds no Proposal surface, and the server refuses it outright.
      const consumerPage = await open(browser, consoleServer.url, '/app');
      await signIn(consumerPage, current.analyst);
      await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
      assert.equal(await consumerPage.getByRole('link', { name: '数据产品提案' }).count(), 0);
      const deniedList = await callApi(
        consoleServer.url,
        `/api/workspace/sources/${current.sourceId}/product-proposals`,
        { cookie: await cookieHeader(consumerPage.context()) },
      );
      assert.equal(deniedList.status, 404, deniedList.text);
      assert.equal(deniedList.body['code'], 'SOURCE_NOT_AVAILABLE');
      const deniedApprove = await callApi(
        consoleServer.url,
        `/api/workspace/product-proposals/${encodeURIComponent(changedId)}/approve`,
        { method: 'POST', cookie: await cookieHeader(consumerPage.context()) },
      );
      assert.equal(deniedApprove.status, 403, deniedApprove.text);
      assert.equal(deniedApprove.body['code'], 'WORKSPACE_ACCESS_DENIED');
    } finally {
      await consoleServer.stop();
    }
  } finally {
    await browser?.close();
    await endpoint.close();
  }
});
