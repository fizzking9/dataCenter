import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { commandAsync } from '../support/async-command.js';
import { callApi, startConsole } from '../support/console.js';
import { MOCK_MODEL_ID, startMockModelEndpoint } from '../support/model-endpoint.js';
import {
  command,
  createUser,
  grantRole,
  initializePlatform,
  jsonFile,
  registerTotp,
  sessionFor,
  textFile,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

type Config = Record<string, unknown>;

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';

const PURPOSES = ['integration_proposal', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['dataset_schema', 'cleaning_rules', 'source_mapping', 'sample_records'];
const PROMPTS = {
  integration_proposal: '你是数据集成助手，只输出简体中文说明，并按结构化输出返回候选 Integration Configuration。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

/** The Integration Configuration the Source runs before any Proposal. */
const BASE_CONFIGURATION: Config = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
  ],
  cleaning: [],
  mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' },
};

/** One representative upload: a value to transform, a value to reject, a column to ignore. */
const RAW_CSV = [
  '设备SN,城市,处理量,备注',
  ' dev-1 ,杭州,12,临时',
  'dev-2,上海,十二,临时',
  '',
].join('\n');

const DICTIONARY: Config = {
  dataset_name: '设备台账',
  fields: [
    { source_column: '设备SN', name: 'sn', type: 'string', description: '设备序列号', identity: true, clean: ['trim', 'uppercase'] },
    { source_column: '城市', name: 'city', type: 'string', description: '所在城市' },
    { source_column: '处理量', name: 'handled_count', type: 'integer', description: '当日处理量' },
  ],
};

const FIXTURES: Config = {
  fixtures: [
    {
      name: '标准样本',
      header: ['设备SN', '城市', '处理量', '备注'],
      rows: [
        [' dev-1 ', '杭州', '12', '临时'],
        ['dev-2', '上海', '十二', '临时'],
      ],
    },
  ],
};

/** The broad Chinese requirement the model has to ask about before generating. */
const BROAD_REQUIREMENT = '请帮我整理一下这份数据。';
const CLARIFIED_REQUIREMENT = '设备SN、城市与处理量三列都要，按 SN 汇总每日处理量。';
/** A requirement that already names governed columns needs no clarification. */
const NAMED_REQUIREMENT = '按设备SN汇总城市与处理量，保留每日台账。';

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
  baseVersion: number;
  rawId: string;
  dictionaryPath: string;
  fixturesPath: string;
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

/** One Deployment, one Workspace, one file Source already running a stable base Version. */
function world(): World {
  const fixture = initializePlatform();
  const deploymentToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  const created = createUser(fixture, deploymentToken, OPERATIONS, OPERATIONS_PASSWORD);
  assert.equal(created.status, 0, created.stderr);
  const workspace = command(
    fixture,
    ['workspace', 'create', '--name', '运营中心', '--administrator', OPERATIONS],
    { token: deploymentToken },
  );
  assert.equal(workspace.status, 0, workspace.stderr);
  const workspaceId = String(workspace.output['workspace_id']);
  // Creating the Workspace enrolls its first administrator, so that enrollment
  // is the verifier secret both the CLI session and the browser sign-in present.
  registerTotp(fixture, OPERATIONS, workspace.output['totp_secret']);
  const operationsTotp = String(workspace.output['totp_secret']);
  const analyst = createUser(fixture, deploymentToken, ANALYST, ANALYST_PASSWORD);
  assert.equal(analyst.status, 0, analyst.stderr);
  const workspaceToken = sessionFor(fixture, OPERATIONS, OPERATIONS_PASSWORD);
  grantRole(fixture, workspaceToken, workspaceId, ANALYST, 'Consumer');

  const source = command(
    fixture,
    ['source', 'create', '--workspace', workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: workspaceToken },
  );
  assert.equal(source.status, 0, source.stderr);
  const sourceId = String(source.output['source_id']);

  const published = command(
    fixture,
    ['integration', 'publish', '--source', sourceId, '--config', jsonFile(fixture, 'integration-base', BASE_CONFIGURATION)],
    { token: workspaceToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const baseVersion = Number(published.output['integration_configuration_version']);
  const adopted = command(
    fixture,
    ['integration', 'adopt', '--source', sourceId, '--version', String(baseVersion)],
    { token: workspaceToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);

  const uploaded = command(
    fixture,
    ['acquisition', 'upload', '--source', sourceId, '--file', textFile(fixture, 'acquisition.csv', RAW_CSV)],
    { token: workspaceToken },
  );
  assert.equal(uploaded.status, 0, uploaded.stderr);
  const rawId = String(asRecord(uploaded.output['raw_acquisition'])['raw_id']);

  return {
    fixture,
    workspaceId,
    workspaceToken,
    deploymentToken,
    operations: {
      username: OPERATIONS,
      password: OPERATIONS_PASSWORD,
      totp: operationsTotp,
    },
    analyst: { username: ANALYST, password: ANALYST_PASSWORD, totp: '' },
    sourceId,
    baseVersion,
    rawId,
    dictionaryPath: jsonFile(fixture, 'data-dictionary', DICTIONARY),
    fixturesPath: jsonFile(fixture, 'validation-fixtures', FIXTURES),
    bindingLabel: '集成档案 · v1',
  };
}

/** Publishes, evaluates, activates, and binds one Model Profile Version for the Workspace. */
async function activatedBinding(current: World, endpointUrl: string): Promise<void> {
  const { fixture, deploymentToken, workspaceToken, workspaceId } = current;
  const published = command(
    fixture,
    ['model', 'publish', '--name', '集成档案', '--config', jsonFile(fixture, 'model-profile', {
      adapter: 'hosted',
      endpoint_url: endpointUrl,
      model_id: MOCK_MODEL_ID,
      purposes: [...PURPOSES],
      data_categories: [...DATA_CATEGORIES],
      tools: ['read_data_dictionary'],
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

/** The governed state the browser must leave unchanged until Adoption. */
function productionState(current: World): { versions: number; adopted: number; releases: number; records: number } {
  const state = JSON.parse(readFileSync(join(current.fixture.root, 'state', 'platform.json'), 'utf8')) as {
    integration_configurations: Array<{ adopted_version: number | null; versions: Config[] }>;
    datasets: Array<{ releases: Array<{ record_count: number }> }>;
  };
  const configuration = state.integration_configurations[0];
  assert.ok(configuration !== undefined);
  const releases = state.datasets[0]?.releases ?? [];
  return {
    versions: configuration.versions.length,
    adopted: configuration.adopted_version ?? 0,
    releases: releases.length,
    records: releases.at(-1)?.record_count ?? 0,
  };
}

async function confirm(page: Page, region: string, label: string): Promise<void> {
  await page.getByRole('region', { name: region }).getByRole('button', { name: label }).click();
}

/** Fills the generate form, reads the dictionary from a real file, and submits. */
async function generate(page: Page, current: World, requirement: string): Promise<void> {
  const panel = page.getByRole('region', { name: '生成集成提案' });
  await panel.getByLabel('工作区模型绑定', { exact: true }).selectOption({ label: current.bindingLabel });
  await panel.getByLabel('中文需求', { exact: true }).fill(requirement);
  await panel.getByLabel('数据字典（JSON 文件）', { exact: true }).setInputFiles(current.dictionaryPath);
  await panel.getByRole('button', { name: '生成集成提案' }).click();
}

/** Runs the deterministic fixtures and the isolated preview of the real acquisition. */
async function validateAndPreview(page: Page, current: World): Promise<void> {
  const detail = page.getByRole('region', { name: '提案详情' });
  const validation = detail.getByRole('region', { name: '确定性校验' });
  await validation.getByLabel('校验夹具（JSON 文件）', { exact: true }).setInputFiles(current.fixturesPath);
  await validation.getByRole('button', { name: '运行校验夹具' }).click();
  try {
    await validation.getByText('不是整数').waitFor();
  } catch (error) {
    console.error('body after validation:', await page.locator('body').innerText());
    throw error;
  }
  const preview = detail.getByRole('region', { name: '真实采集预览' });
  await preview.getByLabel('原始采集', { exact: true }).selectOption(current.rawId);
  await preview.getByRole('button', { name: '预览真实采集' }).click();
  await preview.getByText('预览证据摘要').waitFor();
}

/** The proposal list the browser reads, from the same authorized HTTP contract. */
async function listedProposals(url: string, cookie: string, sourceId: string): Promise<Config[]> {
  const listed = await callApi(url, `/api/workspace/sources/${sourceId}/proposals`, { cookie });
  assert.equal(listed.status, 200, listed.text);
  return (listed.body['proposals'] as Config[]).map(asRecord);
}

test('a Chinese requirement, its clarification, and the data dictionary become Proposal content, and the browser approves, publishes, and adopts exact versions', async () => {
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
      await page.getByRole('heading', { name: '工作区概览' }).waitFor();

      // The navigation names the Artifact Proposal workflow in Simplified Chinese.
      await page.getByRole('link', { name: '集成提案' }).click();
      await page.getByRole('heading', { name: '集成提案', exact: true }).waitFor();

      // The Source names the data this Workspace administers; nothing is generated yet.
      const sourcePanel = page.getByRole('region', { name: '选择数据来源' });
      await sourcePanel.getByLabel('数据来源', { exact: true }).selectOption({ label: '设备台账' });
      await page.getByText('尚未生成任何集成提案。').waitFor();

      // A broad Chinese requirement is refused with one deterministic Chinese
      // clarification, and the refusal creates no Proposal at all.
      await generate(page, current, BROAD_REQUIREMENT);
      const clarification = page.getByRole('region', { name: '澄清问题' });
      await clarification.waitFor();
      const question = await clarification.innerText();
      assert.match(question, /源列/u);
      assert.match(question, /数据集/u);
      assert.equal((await listedProposals(consoleServer.url, await cookieHeader(page.context()), current.sourceId)).length, 0);

      // The recorded Chinese answer completes the requirement, and generation lands
      // exactly one pending Proposal whose requirement content is immutable.
      const clarified = { question: '请确认要映射哪些源列，以及数据集覆盖的业务范围？', answer: CLARIFIED_REQUIREMENT };
      await clarification.getByLabel('澄清答复', { exact: true }).fill(clarified.answer);
      await clarification.getByRole('button', { name: '带上澄清重新生成' }).click();
      await page.getByRole('region', { name: '提案详情' }).waitFor();
      const first = await listedProposals(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      assert.equal(first.length, 1);
      const proposal = first[0]!;
      assert.equal(proposal['status'], 'pending');
      assert.equal(asRecord(proposal['freshness'])['fresh'], true);
      const requirement = asRecord(proposal['requirement']);
      assert.equal(requirement['text'], BROAD_REQUIREMENT);
      assert.deepEqual(requirement['clarifications'], [clarified]);
      assert.match(String(requirement['hash']), /^[0-9a-f]{64}$/u);
      const candidates = asRecord(proposal['candidates']);
      const integration = asRecord(candidates['integration_configuration']);
      assert.equal(integration['version'], current.baseVersion + 1);

      // Evidence inspection: the exact candidate versions, the requirement, the
      // model pin, and the dictionary evidence all read in the browser.
      const detail = page.getByRole('region', { name: '提案详情' });
      await detail.locator('span.pill').filter({ hasText: '待审批' }).waitFor();
      const evidenceText = await detail.innerText();
      for (const hash of [
        String(requirement['hash']),
        String(asRecord(proposal['evidence'])['data_dictionary_hash']),
        String(proposal['proposal_hash']),
        String(integration['content_hash']),
      ]) {
        assert.ok(evidenceText.includes(hash), `the browser did not show ${hash}`);
      }
      for (const copy of ['sn、city、handled_count', 'trim:sn', '设备SN → sn', BROAD_REQUIREMENT]) {
        assert.ok(evidenceText.includes(copy), `the browser did not show ${copy}`);
      }
      assert.equal(evidenceText.includes('PROPOSAL_'), false);

      // Deterministic validation and the isolated preview expose transformations,
      // Record Rejections, and drift while no production release moves.
      await validateAndPreview(page, current);
      const validation = detail.getByRole('region', { name: '确定性校验' });
      assert.match(await validation.innerText(), /有效记录 1 条，转换 3 处，拒绝 1 条/u);
      assert.match(await validation.innerText(), /不是整数/u);
      assert.match(await validation.innerText(), /未映射的源列[\s\S]*备注/u);
      const preview = detail.getByRole('region', { name: '真实采集预览' });
      const previewText = await preview.innerText();
      assert.match(previewText, /记录数[\s\S]*1/u);
      assert.match(previewText, /转换数[\s\S]*3/u);
      assert.match(previewText, /拒绝数[\s\S]*1/u);
      assert.ok(previewText.includes(current.rawId));
      assert.deepEqual(productionState(current), before);

      const afterPreview = (await listedProposals(consoleServer.url, await cookieHeader(page.context()), current.sourceId))[0]!;
      assert.equal(asArray(afterPreview['validations']).length, 1);
      assert.equal(asArray(afterPreview['previews']).length, 1);
      const validatedPreview = asRecord(asArray(afterPreview['previews'])[0]);
      assert.match(String(validatedPreview['evidence_hash']), /^[0-9a-f]{64}$/u);

      // Approval is all-or-nothing and states its exact target before it lands.
      const actions = detail.getByRole('region', { name: '审批与发布' });
      await actions.getByRole('button', { name: '批准提案' }).click();
      const approval = page.getByRole('region', { name: '确认批准集成提案' });
      const approvalText = await approval.innerText();
      assert.match(approvalText, /对象/u);
      assert.match(approvalText, /范围/u);
      assert.match(approvalText, /影响/u);
      assert.ok(approvalText.includes(String(proposal['proposal_id'])));
      await approval.getByRole('button', { name: '确认批准' }).click();
      await detail.locator('span.pill').filter({ hasText: '已批准' }).waitFor();

      // Publication and Adoption are separate, separately confirmed actions.
      await actions.getByRole('button', { name: '发布集成配置' }).click();
      const publication = page.getByRole('region', { name: '确认发布集成配置' });
      assert.match(await publication.innerText(), /影响/u);
      await publication.getByRole('button', { name: '确认发布' }).click();
      await detail.locator('span.pill').filter({ hasText: '已发布' }).waitFor();
      const publishedState = productionState(current);
      assert.equal(publishedState.versions, before.versions + 1);
      assert.equal(publishedState.adopted, before.adopted);

      await actions.getByRole('button', { name: '采纳集成配置' }).click();
      const adoption = page.getByRole('region', { name: '确认采纳集成配置' });
      assert.match(await adoption.innerText(), /影响/u);
      await adoption.getByRole('button', { name: '确认采纳' }).click();
      await detail.locator('span.pill').filter({ hasText: '已采纳' }).waitFor();
      const adoptedState = productionState(current);
      assert.equal(adoptedState.adopted, current.baseVersion + 1);
      assert.equal(adoptedState.versions, before.versions + 1);
      assert.equal(adoptedState.releases, before.releases);
      assert.equal(adoptedState.records, before.records);

      // Every lifecycle fact restates the same requirement and evidence lineage.
      const [adopted] = await listedProposals(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      assert.ok(adopted !== undefined);
      const decision = asRecord(asArray(adopted['decisions'])[0]);
      assert.equal(asRecord(decision['provenance'])['requirement_hash'], requirement['hash']);
      assert.equal(asRecord(decision['provenance'])['data_dictionary_hash'], asRecord(proposal['evidence'])['data_dictionary_hash']);
      assert.equal(asRecord(asArray(adopted['adoptions'])[0])['integration_configuration_version'], current.baseVersion + 1);

      // A second Proposal with a named requirement needs no clarification.
      await generate(page, current, NAMED_REQUIREMENT);
      await detail.getByText(NAMED_REQUIREMENT).waitFor();
      const second = await listedProposals(consoleServer.url, await cookieHeader(page.context()), current.sourceId);
      assert.equal(second.length, 2);
      const stale = second.find((entry) => entry['proposal_id'] !== proposal['proposal_id']);
      assert.ok(stale !== undefined);
      assert.equal(asRecord(stale['requirement'])['text'], NAMED_REQUIREMENT);
      await validateAndPreview(page, current);

      // Moving the Source's base Version makes the Proposal stale: approval fails,
      // and the adopted Version and its Release keep serving unchanged.
      const moved = command(
        current.fixture,
        ['integration', 'publish', '--source', current.sourceId, '--config', jsonFile(current.fixture, 'integration-moved', BASE_CONFIGURATION)],
        { token: current.workspaceToken },
      );
      assert.equal(moved.status, 0, moved.stderr);
      const movedState = productionState(current);
      await actions.getByRole('button', { name: '批准提案' }).click();
      await page.getByRole('region', { name: '确认批准集成提案' }).getByRole('button', { name: '确认批准' }).click();
      await detail.getByText('基线版本已变化，请重新生成提案。').waitFor();
      assert.ok((await detail.innerText()).includes('PROPOSAL_BASE_STALE'));
      const afterStale = productionState(current);
      assert.deepEqual(afterStale, movedState);
      assert.equal(afterStale.adopted, current.baseVersion + 1);

      // A Consumer holds no Artifact Proposal surface, and the server refuses the API.
      const consumerPage = await open(browser, consoleServer.url, '/app');
      await signIn(consumerPage, current.analyst);
      await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
      assert.equal(await consumerPage.getByRole('link', { name: '集成提案' }).count(), 0);
      const denied = await callApi(
        consoleServer.url,
        `/api/workspace/sources/${current.sourceId}/proposals`,
        { cookie: await cookieHeader(consumerPage.context()) },
      );
      // The refusal names nothing: a Consumer reads it exactly like a missing Source.
      assert.equal(denied.status, 404, denied.text);
      assert.equal(denied.body['code'], 'SOURCE_NOT_AVAILABLE');

      // Every surface this ticket adds reads in Simplified Chinese only.
      const body = await page.locator('body').innerText();
      for (const word of [
        'Generate', 'Approve', 'Reject', 'Publish', 'Adopt', 'Requirement', 'Binding',
        'Dictionary', 'Validation', 'Preview', 'Proposal',
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
