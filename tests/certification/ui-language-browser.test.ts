import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startConsole } from '../support/console.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  acquireAndRelease,
  publishSource,
} from '../support/data-product.js';
import {
  command,
  createUser,
  createWorkspace,
  grantRole,
  initializePlatform,
  jsonFile,
  sessionFor,
  totpSecretFor,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const OPERATOR = 'ui-language-operator@example.invalid';
const OPERATOR_PASSWORD = 'ui-language-operator-password';
const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';

/** Both browsers ship with the certified host, so no browser download is needed. */
const CERTIFIED_BROWSERS = [
  { channel: 'msedge', label: 'Microsoft Edge' },
  { channel: 'chrome', label: 'Google Chrome' },
] as const;

interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  deploymentAdministrator: Credentials;
  workspaceAdministrator: Credentials;
  consumer: Credentials;
}

/**
 * One Deployment with a Deployment Administrator, a Workspace Administrator,
 * and a Consumer. Every name a surface can render is Chinese, so an English
 * identifier on screen is copy leakage rather than a governed data value.
 */
function world(): World {
  const fixture = initializePlatform();
  const administratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, administratorToken, OPERATIONS, OPERATIONS_PASSWORD);
  const workspaceId = createWorkspace(fixture, administratorToken, '华东运营', OPERATIONS);
  const workspaceAdministratorToken = sessionFor(fixture, OPERATIONS, OPERATIONS_PASSWORD);
  createUser(fixture, administratorToken, ANALYST, ANALYST_PASSWORD);
  grantRole(fixture, workspaceAdministratorToken, workspaceId, ANALYST, 'Consumer');

  // One published Data Product gives the Consumer surface governed values to
  // render exactly, including a decimal, a date, and the Contract's business zone.
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId);
  const published = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', '设备维修台账',
      '--contract', jsonFile(fixture, 'ui-language-contract', EXTENDED_LEDGER_CONTRACT)],
    { token: workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);

  return {
    fixture,
    workspaceId,
    deploymentAdministrator: {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    },
    workspaceAdministrator: {
      username: OPERATIONS,
      password: OPERATIONS_PASSWORD,
      totp: totpSecretFor(fixture, OPERATIONS),
    },
    consumer: { username: ANALYST, password: ANALYST_PASSWORD },
  };
}

async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  if (credentials.totp !== undefined) {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(credentials.totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('heading', { name: '登录数据中心' }).waitFor();
}

/** Enrolls the Operator through the CLI-issued one-time secret and signs in. */
async function enrolOperator(page: Page, fixture: PlatformFixture, url: string): Promise<void> {
  const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  assert.equal(issued.status, 0, issued.stderr);
  await page.goto(`${url}${String(issued.output.enrollment_path)}`);
  await page.getByLabel('设置密码').fill(OPERATOR_PASSWORD);
  await page.getByLabel('确认密码').fill(OPERATOR_PASSWORD);
  await page.getByRole('button', { name: '登记并生成验证器' }).click();
  await page.getByRole('heading', { name: '验证器已生成' }).waitFor();
  const secret = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(await page.locator('body').innerText())?.[1];
  assert.ok(secret, 'the enrollment showed the dynamic code secret');
  await page.getByRole('button', { name: '前往登录' }).click();
  await page.getByLabel('运维账号').fill(OPERATOR);
  await page.getByLabel('密码').fill(OPERATOR_PASSWORD);
  await page.getByLabel('动态验证码').fill(totpCode(secret));
  await page.getByRole('button', { name: '登录' }).click();
}

interface CopyLeak {
  tag: string;
  text: string;
  attribute?: string;
}

/**
 * Scans the rendered page for English user-facing copy. Machine values stay
 * exempt only when they are single identifiers, not English sentences; a
 * Chinese sentence may name one brand or acronym, but not carry English prose.
 */
async function copyLeaks(page: Page): Promise<CopyLeak[]> {
  return page.evaluate(() => {
    const CJK = /[\u4e00-\u9fff]/u;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TEXTAREA']);
    // Table headers may name governed fields, so a single identifier is allowed
    // there; every other copy role rejects even a one-word English label.
    const STRICT = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BUTTON', 'A', 'LABEL', 'DT', 'SUMMARY', 'CAPTION']);
    const ATTRIBUTES = ['aria-label', 'aria-description', 'title', 'placeholder', 'alt'];

    const looksLikeToken = (text: string): boolean =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)
      || /[/_:@\\]/u.test(text)
      || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(text)
      || /^[a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\.?$/u.test(text)
      || /^[A-Z0-9][A-Z0-9 .%+\-–—/]*$/u.test(text);

    // Product brand names are governed identifiers written in Latin letters in
    // Chinese prose; naming any number of them never turns a sentence English.
    const BRANDS = new Set(['MinIO', 'PostgreSQL']);
    const englishWords = (text: string): string[] =>
      (text.match(/[A-Za-z][A-Za-z'-]*/gu) ?? [])
        .filter((word) => !BRANDS.has(word) && word.length >= 3 && /[a-z]/u.test(word));

    const leaks = (text: string, strict: boolean): boolean => {
      const value = text.replace(/\s+/gu, ' ').trim();
      if (value === '' || /^\d[\d\s.,:%+-]*$/u.test(value)) return false;
      const words = englishWords(value);
      if (words.length === 0) return false;
      if (looksLikeToken(value)) return false;
      if (CJK.test(value)) return words.length >= 2;
      return strict ? words.length >= 1 : words.length >= 2;
    };

    const visible = (element: Element): boolean => {
      if (element.closest('[aria-hidden="true"]') !== null) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const found: CopyLeak[] = [];
    for (const element of document.querySelectorAll('body *')) {
      if (SKIP.has(element.tagName) || !visible(element)) continue;
      let text = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
      }
      text = text.replace(/\s+/gu, ' ').trim();
      if (text !== '' && leaks(text, STRICT.has(element.tagName))) {
        found.push({ tag: element.tagName, text: text.slice(0, 120) });
      }
      for (const attribute of ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (value !== null && leaks(value, true)) {
          found.push({ tag: element.tagName, attribute, text: value.slice(0, 120) });
        }
      }
    }
    return found;
  });
}

interface ContrastFailure {
  tag: string;
  text: string;
  ratio: number;
  color: string;
  background: string;
}

/** WCAG 2.2 AA: 4.5:1 for normal text and 3:1 for large text. */
async function contrastFailures(page: Page): Promise<ContrastFailure[]> {
  return page.evaluate(() => {
    interface Rgba { r: number; g: number; b: number; a: number }
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TEXTAREA']);

    const parse = (value: string): Rgba | null => {
      const match = /^rgba?\(([^)]+)\)$/u.exec(value);
      if (match === null) return null;
      const parts = (match[1] ?? '').split(',').map((part) => Number(part.trim()));
      if (parts.length < 3) return null;
      return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const channel = (value: number): number => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgba): number =>
      0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    const ratio = (left: Rgba, right: Rgba): number => {
      const first = luminance(left);
      const second = luminance(right);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const backgroundOf = (element: Element): Rgba => {
      const chain: Element[] = [];
      for (let node: Element | null = element; node !== null; node = node.parentElement) chain.push(node);
      let background: Rgba = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain.reverse()) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color !== null && color.a > 0) background = over(color, background);
      }
      return background;
    };
    const visible = (element: Element): boolean => {
      if (element.closest('[aria-hidden="true"]') !== null) return false;
      if (element.closest('button:disabled, input:disabled, select:disabled') !== null) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const failures: ContrastFailure[] = [];
    for (const element of document.querySelectorAll('body *')) {
      if (SKIP.has(element.tagName) || !visible(element)) continue;
      let text = '';
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
      }
      text = text.replace(/\s+/gu, ' ').trim();
      if (text === '') continue;
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      if (foreground === null) continue;
      const background = backgroundOf(element);
      const effective = over(foreground, background);
      const value = ratio(effective, background);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      if (value < required - 0.01) {
        failures.push({
          tag: element.tagName,
          text: text.slice(0, 80),
          ratio: Math.round(value * 100) / 100,
          color: style.color,
          background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
        });
      }
    }
    return failures;
  });
}

/** Every form control must have a programmatic name before it can be used by keyboard or SR. */
async function unlabeledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const missing: string[] = [];
    for (const control of document.querySelectorAll('input, select, textarea')) {
      const element = control as HTMLInputElement;
      if (element.type === 'hidden') continue;
      const label = element.labels?.[0]?.textContent?.trim()
        ?? element.getAttribute('aria-label')
        ?? element.getAttribute('aria-labelledby')?.split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      if (label === undefined || label === '') missing.push(element.id || element.name || element.tagName);
    }
    return missing;
  });
}

/** Proves one surface: one Chinese document heading, Chinese copy, AA contrast, labelled controls. */
async function assertChineseSurface(page: Page, heading: string): Promise<void> {
  await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.match(await page.title(), /[\u4e00-\u9fff]/u, 'the document title is Chinese');
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, `${page.url()} has one page heading`);

  const leaks = await copyLeaks(page);
  assert.deepEqual(leaks, [], `${page.url()}: English user-facing copy remains`);
  const contrast = await contrastFailures(page);
  assert.deepEqual(contrast, [], `${page.url()}: text fails WCAG 2.2 AA contrast`);
  const unlabeled = await unlabeledControls(page);
  assert.deepEqual(unlabeled, [], `${page.url()}: form controls have no programmatic label`);
}

/** Tabs through the page and proves each focused control shows a visible focus indicator. */
async function assertKeyboardFocus(page: Page, steps: number): Promise<void> {
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Tab');
  for (let step = 0; step < steps; step += 1) {
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        text: (element.textContent ?? '').trim().slice(0, 40),
        outline: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        shadow: style.boxShadow,
      };
    });
    assert.ok(focused !== null, 'Tab moves focus into the page');
    assert.ok(
      (focused.outline !== 'none' && focused.outlineWidth !== '0px') || focused.shadow !== 'none',
      `${focused.tag} ${JSON.stringify(focused.text)} has no visible focus indicator`,
    );
    await page.keyboard.press('Tab');
  }
}

async function open(browser: Browser, url: string, path: string): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${url}${path}`);
  return page;
}

for (const browserCase of CERTIFIED_BROWSERS) {
  test(`every Operator, administrator, and Consumer surface reads in Simplified Chinese in ${browserCase.label}`, async () => {
    const deployment = world();
    const consoleServer = await startConsole(deployment.fixture);
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ channel: browserCase.channel, headless: true });

      // The Operator Console is a separately authenticated surface, and its
      // navigation, health, licensing, and lifecycle views are all Chinese.
      const operator = await open(browser, consoleServer.url, '/');
      await operator.getByRole('heading', { name: '登录运维控制台' }).waitFor();
      await enrolOperator(operator, deployment.fixture, consoleServer.url);
      // Health and license load after the page heading; certify the loaded
      // panels rather than whichever asynchronous frame the scan happens to see.
      await operator.getByRole('heading', { name: '部署健康', exact: true }).waitFor();
      await assertChineseSurface(operator, '运行状态');
      assert.deepEqual(await copyLeaks(operator), []);
      await operator.getByRole('link', { name: '许可证与续期' }).click();
      await operator.getByRole('heading', { name: '许可证', exact: true }).waitFor();
      await assertChineseSurface(operator, '许可证与续期');
      await operator.getByRole('link', { name: '升级与应用回滚' }).click();
      await operator.getByRole('heading', { name: '当前部署', exact: true }).waitFor();
      await assertChineseSurface(operator, '升级与应用回滚');
      await assertKeyboardFocus(operator, 6);
      await operator.close();

      // The Deployment Administrator governs identities and deployment settings
      // without entering Workspace content.
      const administrator = await open(browser, consoleServer.url, '/app');
      await signIn(administrator, deployment.deploymentAdministrator);
      await assertChineseSurface(administrator, '工作区');
      assert.equal(await administrator.getByRole('navigation', { name: '部署导航' }).count(), 1);
      assert.equal(await administrator.getByRole('navigation', { name: '工作区导航' }).count(), 0);
      for (const [link, heading] of [
        ['用户与身份', '用户'],
        ['模型档案', '模型档案'],
        ['保留策略', '保留策略'],
        ['工作区', '工作区'],
      ] as const) {
        await administrator.getByRole('link', { name: link, exact: true }).click();
        await assertChineseSurface(administrator, heading);
        if (heading === '模型档案') {
          // An empty deployment states its empty state in Chinese.
          await administrator.getByText('尚未发布任何模型档案版本。').waitFor();
        }
      }
      await assertKeyboardFocus(administrator, 6);
      await signOut(administrator);
      await administrator.close();

      // The Workspace Administrator sees every workspace governance surface.
      const workspaceAdministrator = await open(browser, consoleServer.url, '/app');
      await signIn(workspaceAdministrator, deployment.workspaceAdministrator);
      await assertChineseSurface(workspaceAdministrator, '工作区概览');
      assert.equal(await workspaceAdministrator.getByRole('navigation', { name: '工作区导航' }).count(), 1);
      const workspaceViews = [
        ['数据来源', '数据来源'],
        ['抓取服务', '抓取服务'],
        ['数据产品', '数据产品'],
        ['自然语言问答', '自然语言问答'],
        ['报告', '报告库'],
        ['报告治理', '报告治理'],
        ['数据产品治理', '数据产品治理'],
        ['业务上下文', '业务上下文'],
        ['成员', '工作区成员'],
        ['代理授权', '代理授权'],
        ['审计', '审计事件'],
        ['模型绑定', '工作区模型绑定'],
        ['集成提案', '集成提案'],
        ['数据产品提案', '数据产品提案'],
        ['保留与清除', '保留与清除'],
        ['概览', '工作区概览'],
      ] as const;
      for (const [link, heading] of workspaceViews) {
        await workspaceAdministrator.getByRole('link', { name: link, exact: true }).click();
        await assertChineseSurface(workspaceAdministrator, heading);
      }
      await assertKeyboardFocus(workspaceAdministrator, 6);
      await signOut(workspaceAdministrator);
      await workspaceAdministrator.close();

      // The Consumer reads the published product, asks a governed question, and
      // reads the immutable Report library. Exact governed values keep their
      // Contract representation and business zone.
      const consumer = await open(browser, consoleServer.url, '/app');
      await signIn(consumer, deployment.consumer);
      await assertChineseSurface(consumer, '工作区概览');
      assert.equal(await consumer.getByRole('navigation', { name: '工作区导航' }).count(), 1);

      await consumer.getByRole('link', { name: '数据产品', exact: true }).click();
      await assertChineseSurface(consumer, '数据产品');
      const productRow = consumer.getByRole('row').filter({ hasText: '设备维修台账' });
      await productRow.waitFor();
      const browse = productRow.getByRole('button', { name: '浏览此产品' });
      await browse.focus();
      await consumer.keyboard.press('Enter');
      const details = consumer.getByRole('region', { name: '数据产品详情' });
      await details.waitFor();
      assert.match(await details.innerText(), /Asia\/Shanghai/u, 'the Contract business zone is named');
      const workbench = consumer.getByRole('region', { name: '数据探索' });
      await workbench.getByRole('button', { name: '查询记录' }).click();
      const results = consumer.getByRole('region', { name: '记录结果' });
      await results.getByText('sn-001').waitFor();
      const rows = await results.locator('tbody tr').allInnerTexts();
      const first = rows[0] ?? '';
      assert.ok(first.includes('120.5'), `the governed decimal is not rounded: ${first}`);
      assert.ok(first.includes('2026-01-05'), `the governed date keeps its source representation: ${first}`);

      // A refused query is a Chinese validation state carrying the unchanged code.
      await workbench.getByLabel('记录时间起点', { exact: true }).fill('2026-02-10');
      await workbench.getByLabel('记录时间终点', { exact: true }).fill('2026-01-05');
      await workbench.getByRole('button', { name: '查询记录' }).click();
      await consumer.getByText('DATA_PRODUCT_QUERY_REFUSED').waitFor();
      const refusal = await consumer.getByRole('alert').innerText();
      assert.ok(refusal.includes('查询被拒绝'), `the refusal is Chinese: ${refusal}`);
      assert.equal(/must start|no later/u.test(refusal), false, `no English server prose leaks: ${refusal}`);
      await assertChineseSurface(consumer, '数据产品');

      await consumer.getByRole('link', { name: '自然语言问答', exact: true }).click();
      await assertChineseSurface(consumer, '自然语言问答');
      await consumer.getByRole('link', { name: '报告', exact: true }).click();
      await assertChineseSurface(consumer, '报告库');
      await consumer.getByText('当前工作区还没有已入库的报告。').waitFor();
      await assertKeyboardFocus(consumer, 6);
      await consumer.close();
    } finally {
      await browser?.close();
      await consoleServer.stop();
    }
  });
}
