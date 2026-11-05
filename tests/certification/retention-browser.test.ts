import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  acquireAndRelease,
  publishLedgerProduct,
} from '../support/data-product.js';
import {
  command,
  jsonFile,
  totpSecretFor,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

type Config = Record<string, unknown>;

const DAY_MS = 86_400_000;
const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';

/** A second ledger, so the republished Data Product has a genuine current Release. */
const LEDGER_NEXT = [
  '设备SN,城市,处理量,结算金额,上报日期',
  'sn-001,杭州,4,120.50,2026-01-05',
  'sn-002,上海,5,300.00,2026-01-12',
  'sn-003,,2,,2026-01-20',
].join('\n');

interface Credentials {
  username: string;
  password: string;
  totp: string;
}

interface ReleaseRow {
  release: number;
  created_at: string;
}

interface StateFile {
  datasets: Array<{ dataset_id: string; releases: ReleaseRow[] }>;
  data_products: Array<{ data_product_id: string; releases: ReleaseRow[] }>;
  raw_acquisitions: Array<{ raw_id: string; object_path: string; received_at: string }>;
  purge_jobs: unknown[];
  purge_ledger: unknown[];
  retention_policies: Array<{ versions: Array<{ version: number; defaults: Record<string, { kind: string; days?: number }> }> }>;
  retention_overrides: Array<{ versions: Array<{ version: number; terms: Record<string, { days: number }> }> }>;
  retention_holds: Array<{ hold_id: string }>;
}

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  workspaceToken: string;
  deploymentToken: string;
  deploymentAdministrator: Credentials;
  operations: Credentials;
  analyst: Credentials;
  consumerToken: string;
  sourceId: string;
  dataProductId: string;
  datasetId: string;
}

function asRecord(value: unknown): Config {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Config;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function statePathOf(fixture: PlatformFixture): string {
  return join(fixture.root, 'state', 'platform.json');
}

function stateOf(fixture: PlatformFixture): StateFile {
  return JSON.parse(readFileSync(statePathOf(fixture), 'utf8')) as StateFile;
}

function editState(fixture: PlatformFixture, mutate: (state: StateFile) => void): void {
  const state = stateOf(fixture);
  mutate(state);
  writeFileSync(statePathOf(fixture), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * One Workspace with two Dataset Releases and two Data Product Releases: the
 * second of each is current, so eligibility has a historical and a current side.
 */
function world(options: { secondRelease?: boolean } = {}): World {
  const base = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  let dataProductId = base.dataProductId;
  if (options.secondRelease !== false) {
    acquireAndRelease(base.fixture, base.workspaceAdministratorToken, base.sourceId, LEDGER_NEXT, 'ledger-next.csv');
    const republished = command(
      base.fixture,
      [
        'product', 'publish',
        '--source', base.sourceId,
        '--name', '设备维修台账',
        '--contract', jsonFile(base.fixture, 'contract-again', EXTENDED_LEDGER_CONTRACT),
      ],
      { token: base.workspaceAdministratorToken },
    );
    assert.equal(republished.status, 0, republished.stderr);
    assert.equal(republished.output['data_product_release'], 2);
    dataProductId = String(republished.output['data_product_id']);
  }
  return {
    fixture: base.fixture,
    workspaceId: base.workspaceId,
    workspaceToken: base.workspaceAdministratorToken,
    deploymentToken: base.deploymentAdministratorToken,
    deploymentAdministrator: {
      username: base.fixture.administrator.username,
      password: base.fixture.administrator.password,
      totp: base.fixture.administrator.totp_secret,
    },
    operations: {
      username: OPERATIONS,
      password: OPERATIONS_PASSWORD,
      totp: totpSecretFor(base.fixture, OPERATIONS),
    },
    analyst: { username: ANALYST, password: ANALYST_PASSWORD, totp: '' },
    consumerToken: base.consumerToken,
    sourceId: base.sourceId,
    dataProductId,
    datasetId: stateOf(base.fixture).datasets[0]!.dataset_id,
  };
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

function auditEvents(fixture: PlatformFixture, token: string): Config[] {
  const result = command(fixture, ['audit', 'list'], { token });
  assert.equal(result.status, 0, result.stderr);
  return asArray(result.output['events']).map(asRecord);
}

async function openWorkspaceRetention(page: Page): Promise<void> {
  await page.getByRole('heading', { name: '工作区概览' }).waitFor();
  await page.getByRole('link', { name: '保留与清除' }).click();
  await page.getByRole('heading', { name: '保留与清除', exact: true }).waitFor();
}

async function openDeploymentRetention(page: Page): Promise<void> {
  await page.getByRole('link', { name: '保留策略' }).click();
  await page.getByRole('heading', { name: '保留策略', exact: true }).waitFor();
}

/** Fills an override's one stated clock and publishes it through the gate. */
async function publishOverride(page: Page, fieldLabel: string, days: string): Promise<void> {
  const panel = page.getByRole('region', { name: '工作区覆盖' });
  await panel.getByLabel(fieldLabel, { exact: true }).fill(days);
  await panel.getByRole('button', { name: '发布工作区覆盖' }).click();
  const confirmation = page.getByRole('region', { name: '确认发布工作区保留覆盖' });
  const text = await confirmation.innerText();
  assert.match(text, /对象/u);
  assert.match(text, /范围/u);
  assert.match(text, /影响/u);
  await confirmation.getByRole('button', { name: '发布工作区覆盖' }).click();
  await page.getByText(/工作区保留覆盖第 \d+ 版已发布/u).waitFor();
}

function retentionRow(page: Page, fragment: string) {
  return page.getByRole('row').filter({ hasText: fragment });
}

const STEP_UP_FAILURE = '步进认证失败：请重新输入当前密码和动态验证码。';

test('Deployment defaults and Workspace overrides show exact clocks, versions, and effects on existing and future data', async () => {
  let browser: Browser | undefined;
  const current = world();
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    // The Deployment Administrator sees the settled defaults, their clocks, and
    // the bounds every Workspace override is measured against.
    const deploymentPage = await open(browser, consoleServer.url, '/app');
    await signIn(deploymentPage, current.deploymentAdministrator);
    await openDeploymentRetention(deploymentPage);
    const defaultsPanel = deploymentPage.getByRole('region', { name: '部署保留默认值' });
    const defaultsText = await defaultsPanel.innerText();
    for (const copy of ['30 天', '400 天', '永久保留', '无保留保证', '采集完成起算', '创建时起算', '内置默认值']) {
      assert.ok(defaultsText.includes(copy), `the defaults panel does not show ${copy}`);
    }

    // Publishing one policy Version states target, scope, and consequence first.
    const publishPanel = deploymentPage.getByRole('region', { name: '发布新的保留策略版本' });
    await publishPanel.getByLabel('原始采集（天）', { exact: true }).fill('10');
    await publishPanel.getByLabel('版本历史（天）', { exact: true }).fill('30');
    await publishPanel.getByLabel('报告（天）', { exact: true }).fill('200');
    await publishPanel.getByLabel('审计事件（天）', { exact: true }).fill('400');
    await publishPanel.getByLabel('原始采集 最小', { exact: true }).fill('1');
    await publishPanel.getByLabel('原始采集 最大', { exact: true }).fill('60');
    await publishPanel.getByLabel('数据集与数据产品版本历史 最小', { exact: true }).fill('1');
    await publishPanel.getByLabel('数据集与数据产品版本历史 最大', { exact: true }).fill('90');
    await publishPanel.getByLabel('报告 最小', { exact: true }).fill('1');
    await publishPanel.getByLabel('报告 最大', { exact: true }).fill('400');
    await publishPanel.getByRole('button', { name: '发布保留策略' }).click();
    const policyConfirmation = deploymentPage.getByRole('region', { name: '确认发布部署保留策略' });
    const policyGate = await policyConfirmation.innerText();
    for (const copy of ['对象', '范围', '影响', '既有数据与未来数据']) {
      assert.ok(policyGate.includes(copy), `the policy confirmation does not state ${copy}`);
    }
    await policyConfirmation.getByRole('button', { name: '发布保留策略' }).click();
    await deploymentPage.getByText(/部署保留策略第 1 版已发布/u).waitFor();
    await defaultsPanel.getByText('已发布版本').waitFor();
    assert.ok((await defaultsPanel.innerText()).includes('10 天'));
    const publishedState = stateOf(current.fixture);
    assert.equal(publishedState.retention_policies[0]?.versions[0]?.version, 1);
    assert.equal(publishedState.retention_policies[0]?.versions[0]?.defaults['raw_acquisition']?.days, 10);
    assert.ok((await deploymentPage.getByRole('region', { name: '策略版本历史' }).innerText()).includes('1'));

    // The Workspace Administrator sees the Deployment default and narrows it.
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, current.operations);
    await openWorkspaceRetention(page);
    const effective = page.getByRole('region', { name: '生效保留策略' });
    await effective.getByText('10 天').first().waitFor();
    const effectiveText = await effective.innerText();
    for (const copy of ['立即适用于既有数据与未来数据', '当前发布版本永不因时间到期', '部署策略版本', '工作区覆盖版本']) {
      assert.ok(effectiveText.includes(copy), `the effective panel does not show ${copy}`);
    }
    await publishOverride(page, '版本历史（天）', '20');
    const overrideState = stateOf(current.fixture);
    assert.equal(overrideState.retention_overrides[0]?.versions[0]?.version, 1);
    assert.equal(overrideState.retention_overrides[0]?.versions[0]?.terms['dataset_release_history']?.days, 20);
    assert.ok((await effective.innerText()).includes('20 天'));

    // Fifteen-day-old history is inside both clocks. Shortening the override
    // makes the same existing data eligible; lengthening retains it again.
    editState(current.fixture, (state) => {
      for (const dataset of state.datasets) {
        for (const release of dataset.releases) {
          if (release.release === 1) release.created_at = daysAgo(15);
        }
      }
      for (const product of state.data_products) {
        for (const release of product.releases) {
          if (release.release === 1) release.created_at = daysAgo(15);
        }
      }
    });
    const evaluationPanel = page.getByRole('region', { name: '保留资格评估' });
    await evaluationPanel.getByRole('button', { name: '评估保留资格' }).click();
    await evaluationPanel.getByText('符合清除条件').waitFor();
    const inside = evaluationPanel.getByRole('row').filter({ hasText: '#1' }).first();
    await inside.waitFor();
    assert.ok((await inside.innerText()).includes('保留'));

    await publishOverride(page, '版本历史（天）', '5');
    await evaluationPanel.getByRole('button', { name: '评估保留资格' }).click();
    const shortened = evaluationPanel.getByRole('row').filter({ hasText: '#1' }).first();
    await shortened.getByText('可清除').waitFor();
    const shortenedText = await shortened.innerText();
    assert.ok(shortenedText.includes('超出保留期，符合清除条件'));

    await publishOverride(page, '版本历史（天）', '60');
    await evaluationPanel.getByRole('button', { name: '评估保留资格' }).click();
    const lengthened = evaluationPanel.getByRole('row').filter({ hasText: '#1' }).first();
    await lengthened.getByText('保留', { exact: true }).waitFor();
    const lengthenedText = await lengthened.innerText();
    assert.equal(lengthenedText.includes('可清除'), false);
    assert.ok(
      lengthenedText.includes('仍在保留期内') || lengthenedText.includes('仍被保留中的结果引用'),
      lengthenedText,
    );

    // The current Release stays explicitly protected and historical expiry is
    // stated rather than silently substituted.
    const currentRow = evaluationPanel.getByRole('row').filter({ hasText: '#2' }).first();
    assert.ok((await currentRow.innerText()).includes('当前版本，永不因时间到期'));
    assert.ok((await evaluationPanel.innerText()).includes('绝不会被当前版本静默替代'));

    // Version history is visible on both trees.
    assert.ok((await effective.innerText()).includes('工作区覆盖版本'));

    // The screen carries Simplified Chinese only.
    const body = await page.locator('body').innerText();
    for (const word of ['Retention', 'Purge', 'Hold', 'Policy', 'Eligible', 'Backup']) {
      assert.equal(body.includes(word), false, `${word} leaks into the retention page`);
    }

    // Authorization: a Workspace Administrator cannot publish Deployment policy,
    // a Consumer holds no retention surface, and deployment authority alone opens
    // no Workspace retention content.
    const workspaceCookie = await cookieHeader(page.context());
    const deniedPolicy = await callApi(consoleServer.url, '/api/deployment/retention', {
      method: 'POST',
      cookie: workspaceCookie,
      body: { defaults: { raw_acquisition: { days: 9 } } },
    });
    assert.equal(deniedPolicy.status, 403, deniedPolicy.text);
    assert.equal(deniedPolicy.body['code'], 'AUTHORIZATION_DENIED');
    const deploymentCookie = await cookieHeader(deploymentPage.context());
    const deploymentInWorkspace = await callApi(
      consoleServer.url,
      `/api/workspace/retention?workspace_id=${current.workspaceId}`,
      { cookie: deploymentCookie },
    );
    assert.equal(deploymentInWorkspace.status, 403, deploymentInWorkspace.text);
    assert.equal(deploymentInWorkspace.body['code'], 'WORKSPACE_ACCESS_DENIED');

    const consumerPage = await open(browser, consoleServer.url, '/app');
    await signIn(consumerPage, current.analyst);
    await consumerPage.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await consumerPage.getByRole('link', { name: '保留与清除' }).count(), 0);
    const consumerRetention = await callApi(
      consoleServer.url,
      `/api/workspace/retention?workspace_id=${current.workspaceId}`,
      { cookie: await cookieHeader(consumerPage.context()) },
    );
    assert.equal(consumerRetention.status, 403, consumerRetention.text);
    assert.equal(consumerRetention.body['code'], 'WORKSPACE_ACCESS_DENIED');

    // Policy and override publication are Audit Events with accountable actors.
    const events = auditEvents(current.fixture, current.deploymentToken);
    const policyEvent = events.find((event) => event['action'] === 'retention_policy_publish');
    assert.ok(policyEvent);
    assert.equal(policyEvent['actor'], current.deploymentAdministrator.username);
    assert.equal(asRecord(policyEvent['detail'])['policy_version'], 1);
    const overrideEvents = events.filter((event) => event['action'] === 'retention_override_publish');
    assert.equal(overrideEvents.length, 3);
    assert.ok(overrideEvents.every((event) => event['workspace_id'] === current.workspaceId));
    assert.equal(overrideEvents[0]?.['actor'], OPERATIONS);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

test('Retention Holds block automatic and manual Purge until released, and dependent governed results stay protected', async () => {
  let browser: Browser | undefined;
  const current = world();
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, current.operations);
    await openWorkspaceRetention(page);

    // The historical Dataset Release is old, but a fresh Data Product Release
    // still binds it, so the dependency keeps it out of the plan.
    editState(current.fixture, (state) => {
      for (const dataset of state.datasets) {
        for (const release of dataset.releases) release.created_at = daysAgo(500);
      }
    });
    const evaluationPanel = page.getByRole('region', { name: '保留资格评估' });
    await evaluationPanel.getByRole('button', { name: '评估保留资格' }).click();
    const dependent = evaluationPanel.getByRole('row').filter({ hasText: '#1' }).first();
    await dependent.waitFor();
    const dependentText = await dependent.innerText();
    assert.ok(dependentText.includes('仍被保留中的结果引用'), dependentText);
    assert.ok(dependentText.includes(`${current.dataProductId}#1`), dependentText);

    // A manual Purge of that Release previews zero eligible records and creates
    // no job, even with step-up; nothing is silently substituted.
    const purgePanel = page.getByRole('region', { name: '手动清除' });
    await purgePanel.getByLabel('清除范围', { exact: true }).selectOption('release');
    await purgePanel.getByLabel('数据集编号', { exact: true }).fill(current.datasetId);
    await purgePanel.getByLabel('数据集版本号', { exact: true }).fill('1');
    await purgePanel.getByRole('button', { name: '预演清除范围' }).click();
    await purgePanel.getByText('符合条件 0 条').waitFor();
    await purgePanel.getByRole('button', { name: '请求清除' }).click();
    const purgeGate = page.getByRole('region', { name: '确认手动清除' });
    await purgeGate.getByLabel('当前密码', { exact: true }).fill(current.operations.password);
    await purgeGate.getByLabel('动态验证码', { exact: true }).fill(totpCode(current.operations.totp));
    await purgeGate.getByRole('button', { name: '确认清除' }).click();
    await page.getByText('本次清除没有符合条件的内容，未建立任何清除任务。').waitFor();
    assert.equal(stateOf(current.fixture).purge_jobs.length, 0);

    // An accountable Workspace Hold names reason and review date and is visible
    // with its administrator; every eligible record becomes held.
    editState(current.fixture, (state) => {
      for (const raw of state.raw_acquisitions) raw.received_at = daysAgo(40);
    });
    const holdPanel = page.getByRole('region', { name: '保留暂停' });
    await holdPanel.getByLabel('暂停范围', { exact: true }).selectOption('workspace');
    await holdPanel.getByLabel('暂停原因', { exact: true }).fill('监管调查期间禁止删除任何历史证据');
    await holdPanel.getByLabel('复核日期', { exact: true }).fill(new Date(Date.now() + 30 * DAY_MS).toISOString());
    await holdPanel.getByRole('button', { name: '创建保留暂停' }).click();
    const holdGate = page.getByRole('region', { name: '确认创建保留暂停' });
    const holdGateText = await holdGate.innerText();
    for (const copy of ['对象', '范围', '影响']) assert.ok(holdGateText.includes(copy));
    await holdGate.getByRole('button', { name: '创建保留暂停' }).click();
    await page.getByText(/保留暂停已创建/u).waitFor();
    const holdId = stateOf(current.fixture).retention_holds[0]?.hold_id;
    assert.ok(holdId !== undefined);
    const holdRow = retentionRow(page, holdId);
    await holdRow.waitFor();
    assert.ok((await holdRow.innerText()).includes('生效中'));
    assert.ok((await holdRow.innerText()).includes('监管调查期间禁止删除任何历史证据'));

    await evaluationPanel.getByRole('button', { name: '评估保留资格' }).click();
    const heldRaw = evaluationPanel.getByRole('row').filter({ hasText: '原始采集' }).first();
    await heldRaw.getByText('受保留暂停阻止').first().waitFor();
    assert.ok((await heldRaw.innerText()).includes(holdId));

    await purgePanel.getByLabel('清除范围', { exact: true }).selectOption('workspace');
    await purgePanel.getByRole('button', { name: '预演清除范围' }).click();
    await purgePanel.getByText('符合条件 0 条').waitFor();
    assert.ok((await purgePanel.innerText()).includes('受暂停'));

    // Automatic Purge is blocked by the Hold too: a Deployment tick creates and
    // deletes nothing while the raw records and their objects remain.
    const deploymentPage = await open(browser, consoleServer.url, '/app');
    await signIn(deploymentPage, current.deploymentAdministrator);
    await openDeploymentRetention(deploymentPage);
    const tickPanel = deploymentPage.getByRole('region', { name: '自动保留清除' });
    await tickPanel.getByRole('button', { name: '运行自动保留清除' }).click();
    await deploymentPage.getByText(/自动清除已完成/u).waitFor();
    assert.equal(stateOf(current.fixture).raw_acquisitions.length, 2);
    assert.equal(stateOf(current.fixture).purge_ledger.length, 0);

    // Releasing the Hold is its own audited act, and the same content becomes
    // eligible again.
    await page.reload();
    await page.getByRole('heading', { name: '保留与清除', exact: true }).waitFor();
    const reloadedHoldRow = retentionRow(page, holdId);
    await reloadedHoldRow.waitFor();
    await reloadedHoldRow.getByRole('button', { name: '解除暂停' }).click();
    const releaseGate = page.getByRole('region', { name: '确认解除保留暂停' });
    assert.ok((await releaseGate.innerText()).includes('重新按保留策略参与自动与手动清除'));
    await releaseGate.getByRole('button', { name: '解除暂停' }).click();
    await page.getByText(/保留暂停已解除/u).waitFor();
    const reloadedEvaluation = page.getByRole('region', { name: '保留资格评估' });
    await reloadedEvaluation.getByRole('button', { name: '评估保留资格' }).click();
    const eligibleRaw = reloadedEvaluation.getByRole('row').filter({ hasText: '原始采集' }).first();
    await eligibleRaw.getByText('超出保留期，符合清除条件').first().waitFor();

    await deploymentPage.getByRole('region', { name: '自动保留清除' })
      .getByRole('button', { name: '运行自动保留清除' }).click();
    await deploymentPage.getByText(/自动清除已完成/u).waitFor();
    assert.equal(stateOf(current.fixture).raw_acquisitions.length, 0);
    assert.ok(stateOf(current.fixture).purge_ledger.length > 0);
    // The dependent historical Release is still intact because the fresh Data
    // Product Release still pins it.
    assert.deepEqual(stateOf(current.fixture).datasets[0]?.releases.map((release) => release.release), [1, 2]);
    assert.deepEqual(stateOf(current.fixture).data_products[0]?.releases.map((release) => release.release), [1, 2]);

    // Once the dependent result expires, the next tick purges exactly the
    // historical pair while the current Release keeps serving.
    editState(current.fixture, (state) => {
      for (const product of state.data_products) {
        for (const release of product.releases) release.created_at = daysAgo(500);
      }
    });
    await deploymentPage.getByRole('region', { name: '自动保留清除' })
      .getByRole('button', { name: '运行自动保留清除' }).click();
    await deploymentPage.getByText(/自动清除已完成/u).waitFor();
    assert.deepEqual(stateOf(current.fixture).datasets[0]?.releases.map((release) => release.release), [2]);
    assert.deepEqual(stateOf(current.fixture).data_products[0]?.releases.map((release) => release.release), [2]);
    const currentAnswer = await callApi(
      consoleServer.url,
      `/api/workspaces/${current.workspaceId}/data-products/${current.dataProductId}/query`,
      { token: current.consumerToken, body: { kind: 'records', limit: 10 } },
    );
    assert.equal(currentAnswer.status, 200, currentAnswer.text);
    assert.equal(currentAnswer.body['data_product_release'], 2);

    // The Hold lifecycle and the Purge work are required Audit Events.
    const events = auditEvents(current.fixture, current.deploymentToken);
    const created = events.find((event) => event['action'] === 'retention_hold_create');
    assert.ok(created);
    assert.equal(created['workspace_id'], current.workspaceId);
    assert.equal(created['actor'], OPERATIONS);
    assert.equal(asRecord(created['detail'])['review_at'] !== undefined, true);
    const released = events.find((event) => event['action'] === 'retention_hold_release');
    assert.ok(released);
    assert.equal(released['actor'], OPERATIONS);
    assert.ok(events.some((event) => event['action'] === 'retention_purge_schedule'));
    assert.ok(events.some((event) => event['action'] === 'retention_purge_complete'));
    assert.ok(events.some((event) => event['action'] === 'retention_purge_preview'));

    // The Workspace audit surface names the same acts without leaking payloads.
    await page.getByRole('link', { name: '审计', exact: true }).click();
    await page.getByRole('heading', { name: '审计事件' }).waitFor();
    await page.getByText('retention_hold_create', { exact: true }).waitFor();
    const auditText = await page.locator('main').innerText();
    for (const action of ['retention_hold_create', 'retention_hold_release', 'retention_purge_request', 'retention_purge_preview']) {
      assert.ok(auditText.includes(action), `the workspace audit page does not show ${action}`);
    }
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

test('Purge shows exact target and dependencies, demands step-up authentication, revokes access immediately, and deletes asynchronously', async () => {
  let browser: Browser | undefined;
  const current = world();
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, current.operations);
    await openWorkspaceRetention(page);
    editState(current.fixture, (state) => {
      for (const dataset of state.datasets) {
        for (const release of dataset.releases) release.created_at = daysAgo(500);
      }
      for (const product of state.data_products) {
        for (const release of product.releases) release.created_at = daysAgo(500);
      }
    });

    const purgePanel = page.getByRole('region', { name: '手动清除' });
    await purgePanel.getByLabel('清除范围', { exact: true }).selectOption('release');
    await purgePanel.getByLabel('数据集编号', { exact: true }).fill(current.datasetId);
    await purgePanel.getByLabel('数据集版本号', { exact: true }).fill('1');
    await purgePanel.getByRole('button', { name: '预演清除范围' }).click();
    await purgePanel.getByText('符合条件 2 条').waitFor();
    const previewTable = await purgePanel.innerText();
    assert.ok(previewTable.includes('数据集版本'));
    assert.ok(previewTable.includes('数据产品版本'));

    // The confirmation states the exact target, scope, and consequence before a
    // wrong password is refused without creating any job.
    await purgePanel.getByRole('button', { name: '请求清除' }).click();
    const gate = page.getByRole('region', { name: '确认手动清除' });
    const gateText = await gate.innerText();
    for (const copy of ['对象', '范围', '影响', '立即撤销', '不可撤销']) {
      assert.ok(gateText.includes(copy), `the purge confirmation does not state ${copy}`);
    }
    assert.ok(gateText.includes(current.datasetId));
    await gate.getByLabel('当前密码', { exact: true }).fill('wrong-password-value');
    await gate.getByRole('button', { name: '确认清除' }).click();
    await page.getByText(STEP_UP_FAILURE).waitFor();
    assert.ok((await page.getByRole('alert').innerText()).includes('STEP_UP_AUTHENTICATION_FAILED'));
    assert.equal(stateOf(current.fixture).purge_jobs.length, 0);
    assert.deepEqual(stateOf(current.fixture).datasets[0]?.releases.map((release) => release.release), [1, 2]);

    // A correct step-up proof revokes access at once while the bytes still exist.
    await purgePanel.getByRole('button', { name: '请求清除' }).click();
    const secondGate = page.getByRole('region', { name: '确认手动清除' });
    await secondGate.getByLabel('当前密码', { exact: true }).fill(current.operations.password);
    await secondGate.getByLabel('动态验证码', { exact: true }).fill(totpCode(current.operations.totp));
    await secondGate.getByRole('button', { name: '确认清除' }).click();
    await page.getByText(/已撤销访问并建立异步清除任务/u).waitFor();
    const requested = stateOf(current.fixture);
    assert.equal(requested.purge_jobs.length, 1);
    const job = asRecord(requested.purge_jobs[0]);
    assert.equal(job['status'], 'pending');
    assert.equal(typeof job['access_revoked_at'], 'string');
    // The records remain physically present: deletion is asynchronous.
    assert.deepEqual(stateOf(current.fixture).datasets[0]?.releases.map((release) => release.release), [1, 2]);

    const historical = await callApi(
      consoleServer.url,
      `/api/workspaces/${current.workspaceId}/data-products/${current.dataProductId}/query`,
      { token: current.consumerToken, body: { kind: 'records', release: 1, limit: 10 } },
    );
    assert.equal(historical.body['code'], 'RETENTION_EXPIRED', historical.text);

    // Automatic deletion completes the committed job and records the ledger.
    const deploymentPage = await open(browser, consoleServer.url, '/app');
    await signIn(deploymentPage, current.deploymentAdministrator);
    await openDeploymentRetention(deploymentPage);
    await deploymentPage.getByRole('region', { name: '自动保留清除' })
      .getByRole('button', { name: '运行自动保留清除' }).click();
    await deploymentPage.getByText(/自动清除已完成/u).waitFor();
    assert.deepEqual(stateOf(current.fixture).datasets[0]?.releases.map((release) => release.release), [2]);
    assert.deepEqual(stateOf(current.fixture).data_products[0]?.releases.map((release) => release.release), [2]);
    assert.equal(stateOf(current.fixture).purge_ledger.length, 1);

    await page.reload();
    await page.getByRole('heading', { name: '保留与清除', exact: true }).waitFor();
    await page.getByText('已完成', { exact: true }).first().waitFor();

    // The purged history answers explicitly after deletion, and the untouched
    // current Release still serves normally.
    const purgedAgain = await callApi(
      consoleServer.url,
      `/api/workspaces/${current.workspaceId}/data-products/${current.dataProductId}/query`,
      { token: current.consumerToken, body: { kind: 'records', release: 1, limit: 10 } },
    );
    assert.equal(purgedAgain.body['code'], 'RETENTION_EXPIRED', purgedAgain.text);
    const currentAnswer = await callApi(
      consoleServer.url,
      `/api/workspaces/${current.workspaceId}/data-products/${current.dataProductId}/query`,
      { token: current.consumerToken, body: { kind: 'records', limit: 10 } },
    );
    assert.equal(currentAnswer.status, 200, currentAnswer.text);
    assert.equal(currentAnswer.body['data_product_release'], 2);

    // Step-up attempts (one failed, one succeeded) and the Purge are Audit
    // Events naming the actor and the exact target.
    const events = auditEvents(current.fixture, current.deploymentToken);
    const stepUps = events.filter((event) => event['action'] === 'step_up_authentication');
    assert.equal(stepUps.length, 2);
    assert.deepEqual(stepUps.map((event) => event['outcome']), ['failed', 'succeeded']);
    assert.ok(stepUps.every((event) => event['actor'] === OPERATIONS));
    const request = events.find((event) => event['action'] === 'retention_purge_request');
    assert.ok(request);
    assert.equal(asRecord(request['detail'])['scope_kind'], 'release');
    assert.equal(asRecord(request['detail'])['eligible_count'], 2);
    assert.equal(typeof asRecord(request['detail'])['step_up_verified_at'], 'string');
    assert.ok(asRecord(request['detail'])['access_revoked_at'] !== undefined);
    assert.ok(events.some((event) => event['action'] === 'retention_purge_complete'));
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

test('a failed Purge retries safely with degraded health and changes no published data', async () => {
  let browser: Browser | undefined;
  const current = world({ secondRelease: false });
  const consoleServer = await startConsole(current.fixture);
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await open(browser, consoleServer.url, '/app');
    await signIn(page, current.operations);
    await openWorkspaceRetention(page);

    editState(current.fixture, (state) => {
      for (const raw of state.raw_acquisitions) raw.received_at = daysAgo(40);
    });
    const raw = stateOf(current.fixture).raw_acquisitions[0]!;
    const objectPath = join(current.fixture.root, raw.object_path);
    const originalBytes = readFileSync(objectPath);
    // A storage fault: the object path is unexpectedly a directory, so physical
    // deletion fails after access was already revoked.
    rmSync(objectPath);
    mkdirSync(objectPath);

    const purgePanel = page.getByRole('region', { name: '手动清除' });
    await purgePanel.getByLabel('清除范围', { exact: true }).selectOption('source');
    await purgePanel.getByLabel('数据来源编号', { exact: true }).fill(current.sourceId);
    await purgePanel.getByRole('button', { name: '预演清除范围' }).click();
    await purgePanel.getByText('符合条件 1 条').waitFor();
    await purgePanel.getByRole('button', { name: '请求清除' }).click();
    const gate = page.getByRole('region', { name: '确认手动清除' });
    await gate.getByLabel('当前密码', { exact: true }).fill(current.operations.password);
    await gate.getByLabel('动态验证码', { exact: true }).fill(totpCode(current.operations.totp));
    await gate.getByRole('button', { name: '确认清除' }).click();
    await page.getByText(/已撤销访问并建立异步清除任务/u).waitFor();

    // The first execution fails, health degrades, and the job states its retry
    // instant without changing published data.
    const deploymentPage = await open(browser, consoleServer.url, '/app');
    await signIn(deploymentPage, current.deploymentAdministrator);
    await openDeploymentRetention(deploymentPage);
    await deploymentPage.getByRole('region', { name: '自动保留清除' })
      .getByRole('button', { name: '运行自动保留清除' }).click();
    await deploymentPage.getByText(/自动清除已完成/u).waitFor();
    await deploymentPage.getByText(/清除健康已降级/u).first().waitFor();
    const failedState = stateOf(current.fixture);
    assert.equal(failedState.purge_ledger.length, 0);
    const failedJob = asRecord(failedState.purge_jobs[0]);
    assert.equal(failedJob['status'], 'failed');
    assert.equal(failedJob['attempts'], 1);
    assert.equal(typeof failedJob['retry_at'], 'string');
    assert.equal(typeof failedJob['last_error'], 'string');

    await page.reload();
    await page.getByRole('heading', { name: '保留与清除', exact: true }).waitFor();
    const jobRow = retentionRow(page, String(failedJob['purge_id']));
    await jobRow.waitFor();
    const jobText = await jobRow.innerText();
    assert.ok(jobText.includes('物理删除失败，等待重试'));
    assert.ok(jobText.includes('1'));
    // The current Release still answers exactly while the Purge is degraded.
    const currentAnswer = await callApi(
      consoleServer.url,
      `/api/workspaces/${current.workspaceId}/data-products/${current.dataProductId}/query`,
      { token: current.consumerToken, body: { kind: 'records', limit: 10 } },
    );
    assert.equal(currentAnswer.status, 200, currentAnswer.text);
    assert.equal(currentAnswer.body['data_product_release'], 1);

    // Correcting storage lets the same durable job retry after its backoff and
    // complete, restoring health and leaving no raw object behind.
    rmSync(objectPath, { recursive: true, force: true });
    writeFileSync(objectPath, originalBytes);
    const deploymentCookie = await cookieHeader(deploymentPage.context());
    const retried = await callApi(consoleServer.url, '/api/deployment/retention/tick', {
      method: 'POST',
      cookie: deploymentCookie,
      body: { at: new Date(Date.now() + 5 * 60_000).toISOString() },
    });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.body['health'], 'healthy');
    const retriedJob = asRecord(asArray(retried.body['jobs'])[0]);
    assert.equal(retriedJob['status'], 'completed');
    assert.equal(asArray(retried.body['ledger']).length, 1);
    const recovered = stateOf(current.fixture);
    assert.equal(recovered.raw_acquisitions.length, 0);
    assert.equal(asRecord(recovered.purge_jobs[0])['status'], 'completed');

    await deploymentPage.reload();
    await deploymentPage.getByRole('heading', { name: '保留策略', exact: true }).waitFor();
    assert.equal(await deploymentPage.getByText(/清除健康已降级/u).count(), 0);
    await deploymentPage.getByText('已完成', { exact: true }).first().waitFor();

    const events = auditEvents(current.fixture, current.deploymentToken);
    assert.ok(events.some((event) => event['action'] === 'retention_purge_failed'));
    assert.ok(events.some((event) => event['action'] === 'retention_purge_complete'));
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
