import assert from 'node:assert/strict';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createBundleFixture, type BundleFixture, type BundleFixtureOptions } from '../support/bundle.js';
import { startConsole } from '../support/console.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  acquireAndRelease,
  publishLedgerProduct,
  publishSource,
} from '../support/data-product.js';
import { fakeDockerEnvironment } from '../support/fake-docker.js';
import {
  command,
  initializePlatform,
  jsonFile,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATOR = 'lifecycle-operator@example.invalid';
const PASSWORD = 'lifecycle-operator-password';

/** A signed bundle chained to the installed trust root, as a vendor upgrade is. */
function chainedBundle(
  fixture: PlatformFixture,
  name: string,
  release: string,
  upgradeFrom: string[],
  options: Omit<BundleFixtureOptions, 'release' | 'upgradeFrom' | 'releaseKeys' | 'licenseKeys'> = {},
): BundleFixture {
  return createBundleFixture(join(fixture.scratch, name), {
    release,
    upgradeFrom,
    releaseKeys: {
      publicKeyPem: fixture.bundle.releasePublicKeyPem,
      privateKey: fixture.bundle.releasePrivateKey,
    },
    licenseKeys: {
      publicKeyPem: fixture.bundle.licensePublicKeyPem,
      privateKey: fixture.bundle.licensePrivateKey,
    },
    ...options,
  });
}

function snapshot(fixture: PlatformFixture): { platform: string; deployment: string } {
  return {
    platform: readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8'),
    deployment: readFileSync(join(fixture.root, 'deployment.json'), 'utf8'),
  };
}

function assertUnchanged(fixture: PlatformFixture, before: { platform: string; deployment: string }): void {
  const after = snapshot(fixture);
  assert.equal(after.platform, before.platform, 'the governed database changed before mutation was authorized');
  assert.equal(after.deployment, before.deployment, 'the Deployment configuration changed before mutation was authorized');
}

interface OperatorCredentials {
  totp: string;
}

/**
 * Enrolls the Operator from a one-time CLI secret and signs in through the
 * browser, so every later request carries a real Operator Console session.
 */
async function enrolAndSignIn(page: Page, fixture: PlatformFixture, url: string): Promise<OperatorCredentials> {
  const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  assert.equal(issued.status, 0, issued.stderr);
  await page.goto(`${url}/enroll`);
  await page.getByLabel('登记密钥').fill(String(issued.output.enrollment_secret));
  await page.getByLabel('设置密码').fill(PASSWORD);
  await page.getByLabel('确认密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登记并生成验证器' }).click();
  await page.getByRole('heading', { name: '验证器已生成' }).waitFor();
  const enrolledText = await page.locator('body').innerText();
  const totp = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(enrolledText)?.[1];
  assert.ok(totp, enrolledText);
  assert.equal(enrolledText.includes(PASSWORD), false);

  await page.getByRole('button', { name: '前往登录' }).click();
  await page.getByLabel('运维账号').fill(OPERATOR);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByLabel('动态验证码').fill(totpCode(totp));
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: '运行状态' }).waitFor();
  return { totp };
}

async function openBrowser(): Promise<Browser> {
  return chromium.launch({ channel: 'msedge', headless: true });
}

async function fillPreflight(page: Page, bundle: BundleFixture, fingerprint: string): Promise<void> {
  await page.getByLabel('发布包目录').fill(bundle.directory);
  await page.getByLabel('发布密钥指纹').fill(fingerprint);
}

async function openLifecycle(page: Page, fixture: PlatformFixture, url: string): Promise<OperatorCredentials> {
  const credentials = await enrolAndSignIn(page, fixture, url);
  await page.getByRole('link', { name: '升级与应用回滚' }).click();
  await page.getByRole('heading', { name: '升级与应用回滚' }).waitFor();
  return credentials;
}

/** Preflight, confirm, and wait for the durable upgraded record. */
async function performUpgrade(page: Page, bundle: BundleFixture, fingerprint: string): Promise<void> {
  await fillPreflight(page, bundle, fingerprint);
  await page.getByRole('button', { name: '运行维护窗口预检' }).click();
  await page.getByRole('heading', { name: '预检结论' }).waitFor();
  await page.getByRole('button', { name: '开始维护窗口升级' }).click();
  const confirmation = page.getByRole('region', { name: '确认维护窗口升级' });
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '开始维护窗口升级' }).click();
  await page.getByText('已升级，等待验证', { exact: true }).waitFor();
}

function ok(result: { status: number; output: Record<string, unknown>; stderr: string }): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

test('unhealthy stores reject the maintenance window before mutation', async () => {
  const fixture = initializePlatform({ highestEligibleRelease: '0.2.0' });
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const consoleServer = await startConsole({
    ...fixture,
    docker: fakeDockerEnvironment(join(fixture.scratch, 'unhealthy'), { health: 'unhealthy' }),
  });
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await openLifecycle(page, fixture, consoleServer.url);
    const before = snapshot(fixture);
    await fillPreflight(page, next, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    await page.getByText('数据库或对象存储未同时健康运行，部署保持关闭。').waitFor();
    await page.getByRole('alert').getByText('RUNTIME_UNHEALTHY', { exact: true }).waitFor();
    assertUnchanged(fixture, before);
  } finally {
    await browser.close();
    await consoleServer.stop();
  }
});

test('an Operator upgrades, verifies, and finalizes a signed maintenance window through the browser', async () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.0' });
  const fixture = published.fixture;
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const consoleServer = await startConsole(fixture);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    const credentials = await openLifecycle(page, fixture, consoleServer.url);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');

    // The exact source, target, compatibility, and maintenance state are stated
    // before the confirmation, together with the durable preflight evidence.
    await fillPreflight(page, next, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    const result = page.getByRole('region', { name: '预检结论' });
    await result.waitFor();
    await result.getByText('相邻 N → N+1，且发布包已声明兼容').waitFor();
    await result.getByText('0.2.0-expand-catalog-indexes').waitFor();
    await result.getByText('0.1.0 的 2 个本地镜像可用').waitFor();
    await result.getByText('服务开放，需要协调检查点后进入锁定迁移').waitFor();
    await result.getByText('最高可用版本 0.2.0').waitFor();
    await result.getByText(/升级将从 0\.1\.0 到 0\.2\.0/u).waitFor();

    await page.getByRole('button', { name: '开始维护窗口升级' }).click();
    const confirmation = page.getByRole('region', { name: '确认维护窗口升级' });
    await confirmation.waitFor();
    await confirmation.getByText('0.1.0 → 0.2.0').waitFor();
    await confirmation.getByText('失败时服务保持关闭，且不自动恢复或向下迁移。').waitFor();
    await confirmation.getByRole('button', { name: '开始维护窗口升级' }).click();

    // The upgrade is durable: record, locked ledger, and each applied step.
    await page.getByText('已升级，等待验证', { exact: true }).waitFor();
    await page.getByText('backfill-contract-lines').waitFor();
    await page.getByText('rebuild-derived-catalog-index').first().waitFor();
    await page.getByText('record-expanded-store-schema').first().waitFor();

    await page.getByRole('button', { name: '运行升级验证' }).click();
    await page.getByText(/升级验证已通过/u).waitFor();
    const verifyPanel = page.getByRole('region', { name: '升级验证' });
    for (const label of ['存储', '对象', '密钥', '队列', '身份', '工作区隔离', '发布版本', '数据来源', '代表性读取']) {
      await verifyPanel.getByText(label, { exact: true }).waitFor();
    }
    assert.equal(await verifyPanel.getByText('失败', { exact: true }).count(), 0);

    // Finalization is a separate consequential action with its own step-up.
    const finalizePanel = page.getByRole('region', { name: '定稿发布' });
    await finalizePanel.getByLabel('运维密码').fill(PASSWORD);
    await finalizePanel.getByLabel('动态验证码').fill(totpCode(credentials.totp));
    await finalizePanel.getByRole('button', { name: '定稿当前版本' }).click();
    await page.getByText('定稿完成；回滚资格已结束，上一版本镜像已清理。').waitFor();
    await page.getByText('已由定稿关闭', { exact: true }).waitFor();
    await page.getByText('当前没有开放的回滚窗口；定稿或回滚之后不能再执行应用回滚。').waitFor();

    // CLI parity: the same status and the same refusal after finalization.
    const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
    assert.equal(status['release'], '0.2.0');
    assert.equal(status['state'], 'verified_open');
    assert.equal(asRecord(status['application_rollback_window'])['eligible'], false);
    assert.equal(asRecord(status['application_rollback_window'])['closed_by'], 'finalize');
    const refused = command(fixture, ['rollback', '--operator', OPERATOR]);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.error['code'], 'ROLLBACK_NOT_ELIGIBLE');

    const bodyText = await page.locator('body').innerText();
    assert.equal(/Upgrade|Rollback|Finalize|Preflight|Restore/u.test(bodyText), false, bodyText);
  } finally {
    await browser.close();
    await consoleServer.stop();
  }
});

test('offline Application Rollback preserves current data and post-upgrade writes through the browser', async () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.0' });
  const fixture = published.fixture;
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const consoleServer = await startConsole(fixture);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    const credentials = await openLifecycle(page, fixture, consoleServer.url);
    await performUpgrade(page, next, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行升级验证' }).click();
    await page.getByText(/升级验证已通过/u).waitFor();

    // The consequence is stated before the action: preservation, not restoration.
    await page.getByText('应用回滚只把应用镜像恢复到上一个兼容版本，并保留当前数据与升级后写入；它不是备份恢复，也不是向下迁移。').waitFor();

    // Post-upgrade writes through the same governed commands Consumers use.
    const postSource = publishSource(fixture, published.workspaceAdministratorToken, published.workspaceId, {
      name: '升级后台账',
    });
    acquireAndRelease(fixture, published.workspaceAdministratorToken, postSource, undefined, 'post-upgrade.csv');
    const postProduct = ok(command(fixture, [
      'product', 'publish',
      '--source', postSource,
      '--name', '升级后台账',
      '--contract', jsonFile(fixture, 'post-upgrade-contract', EXTENDED_LEDGER_CONTRACT),
    ], { token: published.workspaceAdministratorToken }));
    const postProductId = String(postProduct['data_product_id']);

    // Rollback must work from local images alone: the original media is gone.
    renameSync(next.directory, join(fixture.scratch, 'offline-media'));
    writeFileSync(String(fixture.docker.DC_DOCKER_LOG), '');

    const rollbackPanel = page.getByRole('region', { name: '应用回滚' });
    await rollbackPanel.getByLabel('运维密码').fill('wrong-operator-password');
    await rollbackPanel.getByLabel('动态验证码').fill(totpCode(credentials.totp));
    await rollbackPanel.getByRole('button', { name: '执行应用回滚' }).click();
    await page.getByText('再次验证失败：密码或动态验证码不正确。').waitFor();
    await page.getByRole('alert').getByText('OPERATOR_STEP_UP_FAILED', { exact: true }).waitFor();

    await rollbackPanel.getByLabel('运维密码').fill(PASSWORD);
    await rollbackPanel.getByLabel('动态验证码').fill(totpCode(credentials.totp));
    await rollbackPanel.getByRole('button', { name: '执行应用回滚' }).click();
    await page.getByText('应用回滚完成：0.2.0 → 0.1.0，当前数据与升级后写入保持不变。').waitFor();
    await page.getByText('已由应用回滚关闭', { exact: true }).waitFor();

    const resultText = await rollbackPanel.innerText();
    assert.match(resultText, /回滚前版本\s*\n*\s*0\.2\.0/u);
    assert.match(resultText, /回滚后版本\s*\n*\s*0\.1\.0/u);
    assert.match(resultText, /向下迁移次数\s*\n*\s*0/u);
    assert.match(resultText, /当前数据保持不变\s*\n*\s*是/u);
    assert.match(resultText, /离线执行（不使用介质或镜像仓库）\s*\n*\s*是/u);
    const retained = /升级后写入保留\s*\n*\s*(\d+)/u.exec(resultText);
    assert.ok(retained && Number(retained[1]) >= 2, resultText);

    // CLI parity: the previous release serves both pre- and post-upgrade writes.
    const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
    assert.equal(status['release'], '0.1.0');
    assert.equal(status['service_open'], true);
    assert.equal(asRecord(status['application_rollback_window'])['closed_by'], 'rollback');
    for (const productId of [published.dataProductId, postProductId]) {
      const queried = ok(command(fixture, [
        'product', 'query',
        '--product', productId,
        '--request', jsonFile(fixture, `read-${productId.slice(0, 8)}`, { kind: 'records', limit: 10 }),
      ], { token: published.workspaceAdministratorToken }));
      assert.equal((queried['records'] as unknown[]).length, 3);
    }
    const calls = readFileSync(String(fixture.docker.DC_DOCKER_LOG), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.some((args) => args[0] === 'pull'), false, 'Application Rollback must not pull from a registry');
  } finally {
    await browser.close();
    await consoleServer.stop();
  }
});

test('a failed coordinated checkpoint stops an upgrade before mutation and stays actionable', async () => {
  const published = publishLedgerProduct(undefined, { highestEligibleRelease: '0.2.0' });
  const fixture = published.fixture;
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const state = JSON.parse(readFileSync(join(fixture.root, 'state', 'platform.json'), 'utf8')) as {
    raw_acquisitions: Array<{ object_path: string }>;
  };
  assert.equal(state.raw_acquisitions.length >= 1, true);
  rmSync(join(fixture.root, state.raw_acquisitions[0]!.object_path));

  const consoleServer = await startConsole(fixture);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await openLifecycle(page, fixture, consoleServer.url);
    const before = snapshot(fixture);
    await fillPreflight(page, next, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    await page.getByRole('heading', { name: '预检结论' }).waitFor();
    await page.getByRole('button', { name: '开始维护窗口升级' }).click();
    await page.getByRole('region', { name: '确认维护窗口升级' })
      .getByRole('button', { name: '开始维护窗口升级' }).click();

    await page.getByText('协调检查点失败：数据库引用的对象与存储不一致，升级在变更前停止。').first().waitFor();
    await page.getByRole('alert').getByText('CHECKPOINT_OBJECTS_UNCOORDINATED', { exact: true }).waitFor();
    assertUnchanged(fixture, before);

    const status = ok(command(fixture, ['status', '--operator', OPERATOR]));
    assert.equal(status['release'], '0.1.0');
    assert.equal(status['service_open'], true);

    const evidencePanel = page.getByRole('region', { name: '生命周期证据' });
    await evidencePanel.getByText('协调检查点').first().waitFor();
    await evidencePanel.getByText('检查点失败').first().waitFor();
    await evidencePanel.getByText('维护窗口升级').first().waitFor();
  } finally {
    await browser.close();
    await consoleServer.stop();
  }
});

test('unsupported, foreign-architecture, and incomplete bundles are rejected from the Operator Console before mutation', async () => {
  const fixture = initializePlatform({ highestEligibleRelease: '0.2.0' });
  const next = chainedBundle(fixture, 'bundle-0.2.0', '0.2.0', ['0.1.0']);
  const skipped = chainedBundle(fixture, 'bundle-0.3.0', '0.3.0', ['0.1.0']);
  const foreign = chainedBundle(fixture, 'bundle-arm64', '0.2.0', ['0.1.0'], { architecture: 'arm64' });

  const consoleServer = await startConsole(fixture);
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await enrolAndSignIn(page, fixture, consoleServer.url);
    await page.getByRole('link', { name: '升级与应用回滚' }).click();
    await page.getByRole('heading', { name: '升级与应用回滚' }).waitFor();

    const before = snapshot(fixture);

    // A skipped release is an unsupported upgrade path, not a warning.
    await fillPreflight(page, skipped, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    await page.getByText('升级路径不受支持：只能安装紧接着的下一个发布版本，且发布包必须声明与当前版本兼容。').waitFor();
    await page.getByRole('alert').getByText('UPGRADE_PATH_UNSUPPORTED', { exact: true }).waitFor();

    // A bundle built for another architecture is ineligible before any work starts.
    await fillPreflight(page, foreign, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    await page.getByText('发布包架构与当前主机不匹配。').waitFor();
    await page.getByRole('alert').getByText('BUNDLE_ARCHITECTURE_UNSUPPORTED', { exact: true }).waitFor();

    // Missing previous images would make Application Rollback impossible.
    rmSync(join(fixture.root, 'releases', '0.1.0', 'images', 'minio.tar'));
    await fillPreflight(page, next, fixture.bundle.releaseFingerprint);
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    await page.getByText('上一个发布版本的本地镜像缺失，自动回滚将不可用。').waitFor();
    await page.getByRole('alert').getByText('PREVIOUS_RELEASE_IMAGES_MISSING', { exact: true }).waitFor();

    assertUnchanged(fixture, before);

    // A wrong fingerprint is a trust refusal, never an accepted bundle.
    await fillPreflight(page, next, 'f'.repeat(64));
    await page.getByRole('button', { name: '运行维护窗口预检' }).click();
    await page.getByText('确认的发布密钥指纹与信任根不一致。').waitFor();
    await page.getByRole('alert').getByText('RELEASE_KEY_NOT_CONFIRMED', { exact: true }).waitFor();
    assertUnchanged(fixture, before);

    // Every refusal left durable lifecycle evidence the Operator can inspect.
    const evidencePanel = page.getByRole('region', { name: '生命周期证据' });
    await evidencePanel.getByText('维护窗口预检').first().waitFor();
    await evidencePanel.getByText('拒绝').first().waitFor();
  } finally {
    await browser.close();
    await consoleServer.stop();
  }
});
