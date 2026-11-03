import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type Locator } from 'playwright-core';
import { startConsole } from '../support/console.js';
import { command, initializePlatform } from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATOR = 'console-operator@example.invalid';
const PASSWORD = 'console-operator-password';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

/** Focus is asserted through the accessible name, never through a DOM id. */
async function hasFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element === document.activeElement);
}

/** Both browsers ship with the certified host, so no browser download is needed. */
const CERTIFIED_BROWSERS = [
  { channel: 'msedge', label: 'Microsoft Edge' },
  { channel: 'chrome', label: 'Google Chrome' },
] as const;

for (const browserCase of CERTIFIED_BROWSERS) {
  test(`an Operator enrolls and inspects a Deployment in ${browserCase.label}`, async () => {
    const fixture = initializePlatform();
    const consoleServer = await startConsole(fixture);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ channel: browserCase.channel, headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(20_000);

      // The browser shell, the Simplified Chinese catalog, and the sign-in state.
      await page.goto(`${consoleServer.url}/`);
      await page.getByRole('heading', { name: '登录运维控制台' }).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
      assert.equal(await page.getByRole('link', { name: '跳到主要内容' }).count(), 1);
      assert.equal(await page.getByLabel('运维账号').isVisible(), true);

      // Enrollment from the one-time CLI secret, with the secret carried in the fragment.
      await page.goto(`${consoleServer.url}/enroll#not-a-real-Secret`);
      await page.getByLabel('设置密码').fill(PASSWORD);
      await page.getByLabel('确认密码').fill(PASSWORD);
      await page.getByRole('button', { name: '登记并生成验证器' }).click();
      await page.getByText('登记失败，请确认密钥未被使用、未过期且未被撤销。').waitFor();

      const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
      assert.equal(issued.status, 0, issued.stderr);
      await page.goto(`${consoleServer.url}${String(issued.output.enrollment_path)}`);
      await page.getByRole('heading', { name: '登记运维账号' }).waitFor();
      assert.equal(await page.getByLabel('登记密钥').inputValue(), String(issued.output.enrollment_secret));
      await page.getByLabel('设置密码').fill(PASSWORD);
      await page.getByLabel('确认密码').fill(PASSWORD);
      await page.getByRole('button', { name: '登记并生成验证器' }).click();

      // The secrets are shown exactly once, in Simplified Chinese.
      await page.getByRole('heading', { name: '验证器已生成' }).waitFor();
      const enrolledText = await page.locator('body').innerText();
      const totpSecret = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(enrolledText)?.[1];
      assert.ok(totpSecret, enrolledText);
      assert.equal((enrolledText.match(/[A-Z2-7]{8}-[A-Z2-7]{8}/gu) ?? []).length, 8);
      assert.equal(enrolledText.includes(PASSWORD), false);

      // Sign in using only the keyboard.
      await page.getByRole('button', { name: '前往登录' }).click();
      await page.getByRole('heading', { name: '登录运维控制台' }).waitFor();
      assert.equal(await hasFocus(page.getByLabel('运维账号')), true);
      await page.keyboard.type(OPERATOR);
      await page.keyboard.press('Tab');
      assert.equal(await hasFocus(page.getByLabel('密码')), true);
      await page.keyboard.type(PASSWORD);
      await page.keyboard.press('Tab');
      assert.equal(await hasFocus(page.getByLabel('动态验证码')), true);
      await page.keyboard.type(totpCode(totpSecret));
      await page.keyboard.press('Enter');

      // Read-only health and license over the authenticated application APIs.
      await page.getByRole('heading', { name: '运行状态' }).waitFor();
      const healthPanel = page.getByRole('region', { name: '部署健康' });
      const licensePanel = page.getByRole('region', { name: '许可证' });
      await healthPanel.getByText('数据库 PostgreSQL').waitFor();
      await healthPanel.getByText('对象存储 MinIO').waitFor();
      await healthPanel.getByText('健康', { exact: true }).waitFor();
      await healthPanel.getByText('已验证开放', { exact: true }).waitFor();
      await licensePanel.getByText('最高可用版本').waitFor();
      const licenseText = await licensePanel.innerText();
      assert.match(licenseText, /许可证编号/u);
      assert.match(licenseText, UUID);
      assert.match(licenseText, /剩余天数/u);
      assert.match(licenseText, /0\.1\.0/u);
      const consoleText = await page.locator('body').innerText();
      assert.equal(consoleText.includes(OPERATOR), true);
      assert.equal(/Health|License|Sign in|Password/u.test(consoleText), false);

      const skipLink = page.getByRole('link', { name: '跳到主要内容' });
      await skipLink.focus();
      await page.keyboard.press('Enter');
      assert.equal(await hasFocus(page.getByRole('main')), true);

      await page.getByRole('button', { name: '刷新' }).click();
      await page.getByRole('heading', { name: '运行状态' }).waitFor();

      // Signing out ends the session in the browser.
      await page.getByRole('button', { name: '退出登录' }).click();
      await page.getByRole('heading', { name: '登录运维控制台' }).waitFor();
      assert.equal(await page.getByText('会话已失效，请重新登录。').count(), 0);

      await page.getByLabel('运维账号').fill(OPERATOR);
      await page.getByLabel('密码').fill(PASSWORD);
      await page.getByLabel('动态验证码').fill(totpCode(totpSecret));
      await page.getByRole('button', { name: '登录' }).click();
      await page.getByRole('heading', { name: '运行状态' }).waitFor();

      // CLI revocation ends browser access, and the revoked credentials stay refused.
      const revoked = command(fixture, ['console', 'revoke', '--operator', OPERATOR]);
      assert.equal(revoked.status, 0, revoked.stderr);
      await page.getByRole('button', { name: '刷新' }).click();
      await page.getByText('会话已失效，请重新登录。').waitFor();

      await page.getByLabel('运维账号').fill(OPERATOR);
      await page.getByLabel('密码').fill(PASSWORD);
      await page.getByLabel('动态验证码').fill(totpCode(totpSecret));
      await page.getByRole('button', { name: '登录' }).click();
      await page.getByText('登录失败：账号、密码或验证码不正确。').waitFor();
    } finally {
      await browser?.close();
      await consoleServer.stop();
    }
  });
}