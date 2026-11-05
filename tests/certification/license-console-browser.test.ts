import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import { installLicenseFile, installedLicenseRequest, signedLicenseFor } from '../support/license.js';
import { command, workspaceFixture, type PlatformFixture } from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATOR = 'licensing-browser-operator@example.invalid';
const PASSWORD = 'licensing-browser-password';
const DAY = 24 * 60 * 60 * 1000;

/** Both browsers ship with the certified host, so no browser download is needed. */
const CERTIFIED_BROWSERS = [
  { channel: 'msedge', label: 'Microsoft Edge' },
  { channel: 'chrome', label: 'Google Chrome' },
] as const;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function signed(fixture: PlatformFixture, name: string, options: Parameters<typeof signedLicenseFor>[4]): string {
  return signedLicenseFor(fixture.scratch, name, fixture.bundle, installedLicenseRequest(fixture.root), options);
}

function ok(result: { status: number; output: Record<string, unknown>; stderr: string }): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

/**
 * Enrolls from the one-time CLI secret and signs in through the browser, so
 * every later console request carries a real browser session.
 */
async function enrolAndSignIn(page: Page, fixture: PlatformFixture, url: string): Promise<string> {
  const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  assert.equal(issued.status, 0, issued.stderr);
  await page.goto(`${url}${String(issued.output.enrollment_path)}`);
  await page.getByLabel('设置密码').fill(PASSWORD);
  await page.getByLabel('确认密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登记并生成验证器' }).click();
  await page.getByRole('heading', { name: '验证器已生成' }).waitFor();
  const totp = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(await page.locator('body').innerText())?.[1];
  assert.ok(totp, 'the enrollment showed the dynamic code secret');
  await page.getByRole('button', { name: '前往登录' }).click();
  await page.getByLabel('运维账号').fill(OPERATOR);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByLabel('动态验证码').fill(totpCode(totp));
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: '运行状态' }).waitFor();
  return totp;
}

async function openLicensing(page: Page): Promise<void> {
  await page.getByRole('link', { name: '许可证与续期' }).click();
  await page.getByRole('heading', { name: '许可证与续期' }).waitFor();
}

async function importLicenseThroughBrowser(page: Page, path: string): Promise<void> {
  await page.getByLabel('许可证文件路径').fill(path);
  await page.getByRole('button', { name: '导入续期许可证' }).click();
  const confirmation = page.getByRole('region', { name: '确认导入或替换许可证' });
  await confirmation.waitFor();
  await confirmation.getByRole('button', { name: '导入续期许可证' }).click();
}

/** The Operator Console cookie the browser currently holds. */
async function operatorCookie(page: Page): Promise<string> {
  const found = (await page.context().cookies()).find((cookie) => cookie.name === 'dc_operator_console');
  assert.ok(found, 'the browser holds an Operator Console cookie');
  return `dc_operator_console=${found.value}`;
}

for (const browserCase of CERTIFIED_BROWSERS) {
  test(`an Operator renews and inspects a license in ${browserCase.label}`, async () => {
    const base = workspaceFixture({ licenseExpiresAt: iso(45 * DAY) });
    const { fixture } = base;
    const consoleServer = await startConsole(fixture);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ channel: browserCase.channel, headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(20_000);
      let totpSecret = await enrolAndSignIn(page, fixture, consoleServer.url);
      assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
      await openLicensing(page);

      // The current entitlement and its single import are stated before anything changes.
      const licensePanel = page.getByRole('region', { name: '许可证', exact: true });
      await licensePanel.waitFor();
      const initialText = await licensePanel.innerText();
      assert.match(initialText, /有效/u);
      assert.match(initialText, /许可证编号/u);
      assert.match(initialText, /剩余天数/u);
      const initialId = /许可证编号\s*\n+\s*([0-9a-f-]{36})/u.exec(initialText)?.[1];
      assert.ok(initialId, initialText);
      const historyPanel = page.getByRole('region', { name: '许可证历史' });
      assert.equal((await historyPanel.innerText()).split(initialId).length - 1, 1);

      // A renewal from offline media, stated as target and consequence first.
      const renewal = signed(fixture, 'browser-renewal', { expiresAt: iso(29.5 * DAY) });
      await page.getByLabel('许可证文件路径').fill(renewal);
      await page.getByRole('button', { name: '导入续期许可证' }).click();
      const confirmation = page.getByRole('region', { name: '确认导入或替换许可证' });
      await confirmation.waitFor();
      await confirmation.getByText(renewal, { exact: true }).waitFor();
      await confirmation.getByText(/业务数据、会话和部署标识保持不变/u).waitFor();
      await confirmation.getByRole('button', { name: '导入续期许可证' }).click();

      // The renewed entitlement, the expiration warning, the history, and the evidence.
      await page.getByText('续期已完成，许可证历史与证据已更新。').waitFor();
      await page.getByText('许可将在 30 天内到期，请离线导入续期许可证。').waitFor();
      const renewedText = await licensePanel.innerText();
      assert.match(renewedText, /剩余天数\s*\n+\s*30\s+天/u);
      const renewedId = /许可证编号\s*\n+\s*([0-9a-f-]{36})/u.exec(renewedText)?.[1];
      assert.ok(renewedId, renewedText);
      assert.notEqual(renewedId, initialId);
      const historyRows = await historyPanel.innerText();
      assert.equal(historyRows.includes(initialId), true);
      assert.equal(historyRows.includes(renewedId), true);
      assert.match(historyRows, /前序许可证/u);

      // Browser and CLI state the same license, history, and durable evidence.
      const cli = ok(command(fixture, ['console', 'license']));
      assert.equal(cli['license_id'], renewedId);
      assert.equal(cli['status'], 'valid');
      assert.equal(asRecord(cli['access'])['access'], 'full');
      const cliHistory = cli['license_history'] as Array<Record<string, unknown>>;
      assert.deepEqual(cliHistory.map((entry) => entry['license_id']), [initialId, renewedId]);
      const cliEvidence = cli['evidence'] as Array<Record<string, unknown>>;
      const evidencePanel = page.getByRole('region', { name: '许可证证据' });
      await evidencePanel.getByText(String(cliEvidence[0]?.['evidence_id']), { exact: true }).waitFor();
      await evidencePanel.getByText('已续期', { exact: true }).waitFor();

      // A license bound to another Deployment is refused in Simplified Chinese.
      const wrongDeployment = signed(fixture, 'browser-wrong-deployment', {
        deploymentId: '00000000-0000-4000-8000-000000000000',
        expiresAt: iso(60 * DAY),
      });
      await importLicenseThroughBrowser(page, wrongDeployment);
      await page.getByRole('alert').getByText('许可证绑定到另一个部署。').waitFor();
      await page.getByRole('alert').getByText('LICENSE_DEPLOYMENT_MISMATCH', { exact: true }).waitFor();
      assert.match(await licensePanel.innerText(), new RegExp(renewedId, 'u'), 'the refused renewal changed nothing');

      // A second session is withdrawn from the browser and dies on its next request.
      const secondSession = await callApi(consoleServer.url, '/api/operator/session', {
        body: { username: OPERATOR, password: PASSWORD, totp: totpCode(totpSecret) },
      });
      assert.equal(secondSession.status, 200, secondSession.text);
      const secondCookie = (secondSession.cookies[0] ?? '').split(';')[0] ?? '';
      await page.getByRole('link', { name: '运行状态' }).click();
      await page.getByRole('button', { name: '结束其他会话' }).click();
      await page.getByText('其他会话已结束。').waitFor();
      assert.equal((await callApi(consoleServer.url, '/api/operator/health', { cookie: secondCookie })).status, 401);
      assert.equal((await callApi(consoleServer.url, '/api/operator/health', { cookie: await operatorCookie(page) })).status, 200);

      // The Operator console cookie never opens the platform User channel.
      assert.equal(await page.evaluate(async () => (await fetch('/api/session')).status), 401);

      // CLI revocation ends the browser session on its very next request.
      assert.equal(ok(command(fixture, ['console', 'revoke', '--operator', OPERATOR]))['sessions_revoked'], 1);
      await page.getByRole('button', { name: '刷新' }).click();
      await page.getByText('会话已失效，请重新登录。').waitFor();

      // CLI-assisted re-enrollment restores browser access, still without a User session.
      totpSecret = await enrolAndSignIn(page, fixture, consoleServer.url);
      assert.equal(await page.evaluate(async () => (await fetch('/api/session')).status), 401);
      assert.equal(typeof totpSecret, 'string');

      // Ordinary expiration: permitted reads and lifecycle work beside disabled writes.
      installLicenseFile(fixture.root, signed(fixture, 'browser-expired', {
        notBefore: iso(-2 * DAY),
        expiresAt: iso(-60_000),
      }));
      await openLicensing(page);
      const expiredState = page.getByRole('status').filter({ hasText: '许可证已过期' });
      await expiredState.waitFor();
      assert.match(await expiredState.innerText(), /现有数据仍可读取/u);
      const accessPanel = page.getByRole('region', { name: '过期后的可用范围' });
      await accessPanel.waitFor();
      const permitted = await accessPanel.getByRole('list', { name: '仍然可用' }).innerText();
      const disabled = await accessPanel.getByRole('list', { name: '已停用' }).innerText();
      assert.match(permitted, /读取已发布的数据产品/u);
      assert.match(permitted, /离线导入或续期许可证/u);
      assert.equal(/数据获取与原始文件上传/u.test(permitted), false);
      assert.match(disabled, /数据获取与原始文件上传/u);
      assert.match(disabled, /报表生成/u);
      assert.match(await licensePanel.innerText(), /已过期/u);

      // The CLI agrees that the entitlement expired and that writes are closed.
      const expiredCli = ok(command(fixture, ['console', 'license']));
      assert.equal(expiredCli['status'], 'expired');
      assert.equal(asRecord(expiredCli['access'])['access'], 'read_only');
      const denied = command(
        fixture,
        ['source', 'create', '--workspace', base.workspaceId, '--name', '过期后新来源', '--type', 'file'],
        { token: base.workspaceAdministratorToken },
      );
      assert.equal(denied.status, 2);
      assert.equal(denied.error['code'], 'LICENSE_EXPIRED');
    } finally {
      await browser?.close();
      await consoleServer.stop();
    }
  });
}

test('a backward clock movement is an explicit closed state in Microsoft Edge', async () => {
  const base = workspaceFixture({ licenseExpiresAt: iso(400 * DAY) });
  const { fixture } = base;
  const consoleServer = await startConsole(fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await enrolAndSignIn(page, fixture, consoleServer.url);
    // The host already observed a later instant, so this clock is a rollback.
    ok(command(fixture, ['status', '--operator', OPERATOR, '--at', iso(2 * DAY)]));

    await openLicensing(page);
    const alert = page.getByRole('alert');
    await alert.getByText('主机时钟明显回退，服务保持关闭。').waitFor();
    await alert.getByText('LICENSE_CLOCK_ROLLBACK', { exact: true }).waitFor();
    const accessPanel = page.getByRole('region', { name: '过期后的可用范围' });
    const permitted = await accessPanel.getByRole('list', { name: '仍然可用' }).innerText();
    assert.match(permitted, /离线导入或续期许可证/u);
    const disabled = await accessPanel.getByRole('list', { name: '已停用' }).innerText();
    assert.match(disabled, /读取已发布的数据产品/u);

    // The same closed state is refused for a renewal import, in Simplified Chinese.
    const alertCount = await page.getByRole('alert').count();
    await importLicenseThroughBrowser(page, signed(fixture, 'browser-rollback-renewal', { expiresAt: iso(45 * DAY) }));
    const alerts = page.getByRole('alert');
    const refusal = alerts.filter({ hasText: '导入被拒绝' });
    await refusal.getByText('主机时钟明显回退，服务保持关闭。').waitFor();
    await refusal.getByText('LICENSE_CLOCK_ROLLBACK', { exact: true }).waitFor();
    assert.equal(await alerts.count(), alertCount + 1, 'the refusal is stated beside the closed state');
    assert.equal(ok(command(fixture, ['console', 'license']))['error_code'], 'LICENSE_CLOCK_ROLLBACK');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
