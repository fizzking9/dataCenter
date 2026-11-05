import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import { publishLedgerProduct } from '../support/data-product.js';
import { command, type PlatformFixture } from '../support/platform.js';
import { runOperator } from '../support/operator.js';
import { totpCode } from '../support/totp.js';

const OPERATOR = 'recovery-console@example.invalid';
const PASSWORD = 'recovery-console-password';
const MINUTE = 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `expected an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface RecoveryWorld {
  fixture: PlatformFixture;
  backupRoot: string;
  restoreRoot: string;
}

function world(): RecoveryWorld {
  const published = publishLedgerProduct();
  const { fixture } = published;
  return {
    fixture,
    backupRoot: join(fixture.scratch, 'off-host'),
    restoreRoot: join(fixture.scratch, 'restore-targets'),
  };
}

/**
 * Enrolls one Operator Console account through the published HTTP contract and
 * signs in through the browser, so every later action carries a real session.
 */
async function enrollAndSignIn(page: Page, url: string, fixture: PlatformFixture): Promise<string> {
  const issued = command(fixture, ['console', 'enroll', '--operator', OPERATOR]);
  assert.equal(issued.status, 0, issued.stderr);
  const enrolled = await callApi(url, '/api/operator/enrollment', {
    body: { enrollment_secret: issued.output.enrollment_secret, password: PASSWORD },
  });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const totpSecret = String(enrolled.body['totp_secret']);

  await page.goto(`${url}/`);
  await page.getByLabel('运维账号').fill(OPERATOR);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByLabel('动态验证码').fill(totpCode(totpSecret));
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: '运行状态' }).waitFor();
  return totpSecret;
}

async function operatorCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** The one request shape every consequential recovery action uses. */
async function postWithCookie(url: string, path: string, cookie: string, body: unknown) {
  return callApi(url, path, { method: 'POST', cookie, body });
}

test('an Operator inspects coordinated checkpoints and recovery sets with retention and degraded health', async () => {  const current = world();
  const { fixture, backupRoot, restoreRoot } = current;
  // One coordinated base backup, then a checkpoint twenty minutes old, which is
  // past the settled fifteen-minute RPO: health degrades instead of staying silent.
  const created = command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]);
  assert.equal(created.status, 0, created.stderr);
  const backup = asRecord(created.output);
  const stale = command(fixture, ['checkpoint', '--operator', OPERATOR, '--at', iso(-20 * MINUTE)]);
  assert.equal(stale.status, 0, stale.stderr);
  const status = command(fixture, ['status', '--operator', OPERATOR]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.output['health'], 'degraded');

  const consoleServer = await startConsole(fixture, { backupRoot, restoreRoot });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await enrollAndSignIn(page, consoleServer.url, fixture);

    // Recovery health states the missed checkpoint and the settled objectives
    // without exposing any key or secret.
    const healthPanel = page.getByRole('region', { name: '备份与恢复健康' });
    await healthPanel.getByText('已降级', { exact: true }).waitFor();
    const healthText = await healthPanel.innerText();
    for (const copy of ['检查点已过期', '15 分钟', '当前部署工作进程', '当前部署外部连接']) {
      assert.ok(healthText.includes(copy), `recovery health does not state ${copy}:\n${healthText}`);
    }
    const objectivesPanel = page.getByRole('region', { name: '既定恢复目标' });
    const objectivesText = await objectivesPanel.innerText();
    for (const copy of ['4 小时', '35 天']) {
      assert.ok(objectivesText.includes(copy), `the recovery objectives do not state ${copy}:\n${objectivesText}`);
    }

    // The coordinated checkpoint names the database and object positions and the
    // measured RPO interval every checkpoint keeps moving.
    const checkpointPanel = page.getByRole('region', { name: '协调检查点' });
    const checkpointText = await checkpointPanel.innerText();
    assert.match(checkpointText, /[0-9a-f]{64}/u);
    assert.ok(checkpointText.includes(String(stale.output['checkpoint_id'])), 'the checkpoint identifier is missing');

    // The recovery set is named with its checkpoint, component count, and the
    // retained window; its integrity is recomputed before it may be used.
    const setsPanel = page.getByRole('region', { name: '恢复集合' });
    await setsPanel.getByText(String(backup['backup_id'])).waitFor();
    const setsText = await setsPanel.innerText();
    assert.ok(setsText.includes('在保留期内'), setsText);
    await setsPanel.getByRole('button', { name: '查看恢复集合' }).first().click();
    const detailPanel = page.getByRole('region', { name: '恢复集合详情' });
    await detailPanel.getByText('完整性已通过', { exact: true }).waitFor();
    const detailText = await detailPanel.innerText();
    for (const copy of ['数据库', '对象', '配置', '清单', '审计', '清除台账']) {
      assert.ok(detailText.includes(copy), `the recovery set detail does not state ${copy}:\n${detailText}`);
    }
    assert.ok(detailText.includes('未包含密钥'), `the detail must state that no secret travels in the set:\n${detailText}`);

    // No key material, and no English user-facing copy, reaches the browser.
    const bodyText = await page.locator('body').innerText();
    const masterKey = readFileSync(fixture.masterKey);
    assert.equal(bodyText.includes(masterKey.toString('hex')), false);
    assert.equal(bodyText.includes(masterKey.toString('base64')), false);
    assert.equal(/Restore|Recovery|Backup|Checkpoint|Step-up|Password/u.test(bodyText), false, bodyText);

    // Restoration is refused by the server without a fresh step-up proof: the
    // browser cannot skip the challenge by calling the API directly.
    const cookie = await operatorCookie(page);
    const unauthenticated = await postWithCookie(
      consoleServer.url,
      '/api/operator/recovery/restorations',
      cookie,
      { backup_id: backup['backup_id'] },
    );
    assert.equal(unauthenticated.status, 403, JSON.stringify(unauthenticated.body));
    assert.equal(unauthenticated.body['code'], 'OPERATOR_STEP_UP_REQUIRED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

test('a step-up authenticated restoration reports its evidence and only an explicit action resumes the restored workers and connectivity', async () => {
  const current = world();
  const { fixture, backupRoot, restoreRoot } = current;
  const created = command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]);
  assert.equal(created.status, 0, created.stderr);
  const backupId = String(created.output['backup_id']);

  const consoleServer = await startConsole(fixture, { backupRoot, restoreRoot });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    const totpSecret = await enrollAndSignIn(page, consoleServer.url, fixture);

    // The recovery set is chosen explicitly, and the confirmation states the
    // exact target, scope, isolation boundary, and both recovery objectives.
    const setsPanel = page.getByRole('region', { name: '恢复集合' });
    await setsPanel.getByText(backupId).waitFor();
    await setsPanel.getByRole('button', { name: '发起恢复' }).first().click();
    const gate = page.getByRole('region', { name: '恢复步进认证' });
    const gateText = await gate.innerText();
    assert.ok(gateText.includes(backupId), `the confirmation does not name the exact target:\n${gateText}`);
    for (const copy of ['目标', '范围', '影响', '15 分钟', '4 小时', '隔离', '默认禁用']) {
      assert.ok(gateText.includes(copy), `the confirmation does not state ${copy}:\n${gateText}`);
    }

    // A wrong password is refused by the server itself, and nothing is restored.
    await gate.getByLabel('密码').fill('not-the-operator-password');
    await gate.getByLabel('动态验证码').fill(totpCode(totpSecret));
    await gate.getByRole('button', { name: '确认发起隔离恢复' }).click();
    await page.getByText('步进认证失败：请重新输入当前密码和动态验证码。').waitFor();
    const recordsPanel = page.getByRole('region', { name: '恢复记录' });
    const refusedText = await recordsPanel.innerText();
    assert.ok(refusedText.includes('尚无隔离恢复记录'), refusedText);

    // A current password and dynamic code are accepted, and the restoration is
    // observable through its own durable record instead of a held request.
    await gate.getByLabel('密码').fill(PASSWORD);
    await gate.getByLabel('动态验证码').fill(totpCode(totpSecret));
    await gate.getByRole('button', { name: '确认发起隔离恢复' }).click();
    await page.getByText('已开始隔离恢复，进度会在本页自动刷新。').waitFor();
    await recordsPanel.getByText('已验证开放', { exact: true }).waitFor({ timeout: 60_000 });

    // The evidence names every verification the acceptance criteria require,
    // the measured objective, and the disabled isolation boundary.
    await recordsPanel.getByRole('button', { name: '查看恢复证据' }).first().click();
    const evidencePanel = page.getByRole('region', { name: '恢复证据' });
    await evidencePanel.getByText('完整性', { exact: true }).waitFor();
    const evidenceText = await evidencePanel.innerText();
    for (const copy of ['完整性', '对象', '密钥', '清单', '血缘', '代表性读取', '清除台账', '通过', '4 小时', '隔离边界', '已禁用']) {
      assert.ok(evidenceText.includes(copy), `the restoration evidence does not state ${copy}:\n${evidenceText}`);
    }

    // The durable record agrees with what the browser shows, and the restored
    // copy itself still holds workers and connectivity disabled.
    const cookie = await operatorCookie(page);
    const listed = await callApi(consoleServer.url, '/api/operator/recovery/restorations', { cookie });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const restorations = listed.body['restorations'] as Array<Record<string, unknown>>;
    assert.equal(restorations.length, 1);
    const restoration = asRecord(restorations[0]);
    assert.equal(restoration['state'], 'verified_open');
    assert.equal(restoration['service_open'], true);
    assert.equal(restoration['workers_enabled'], false);
    assert.equal(restoration['connectivity_enabled'], false);
    assert.equal(asRecord(restoration['rto'])['met'], true);
    const target = asRecord(restoration['target']);
    assert.equal(target['workers_enabled'], false);
    assert.equal(target['connectivity_enabled'], false);
    assert.equal(typeof target['root'], 'string');

    // CLI parity: the same governed command states the same restored Deployment.
    const before = command(fixture, ['status', '--operator', OPERATOR]);
    assert.equal(before.status, 0, before.stderr);
    const targetStatus = runOperator([
      'status', '--root', String(target['root']), '--master-key', fixture.masterKey, '--operator', OPERATOR,
    ], { env: fixture.docker });
    assert.equal(targetStatus.status, 0, targetStatus.stderr);
    assert.equal(targetStatus.output['health'], 'healthy');
    assert.equal(targetStatus.output['workers_enabled'], false);
    assert.equal(targetStatus.output['connectivity_enabled'], false);

    // Workers resume only through an explicit, step-up authenticated action.
    const enablePanel = page.getByRole('region', { name: '恢复后启用' });
    await enablePanel.getByRole('button', { name: '启用工作进程' }).click();
    const workerGate = page.getByRole('region', { name: '启用步进认证' });
    await workerGate.getByLabel('密码').fill(PASSWORD);
    await workerGate.getByLabel('动态验证码').fill(totpCode(totpSecret));
    await workerGate.getByRole('button', { name: '确认启用工作进程' }).click();
    await page.getByText('恢复副本的工作进程已启用。').waitFor();
    await page.getByRole('region', { name: '恢复后启用' }).getByText('已启用').first().waitFor();

    // External connectivity is a second, separately authenticated action.
    await enablePanel.getByRole('button', { name: '启用外部连接' }).click();
    const connectivityGate = page.getByRole('region', { name: '启用步进认证' });
    await connectivityGate.getByLabel('密码').fill(PASSWORD);
    await connectivityGate.getByLabel('动态验证码').fill(totpCode(totpSecret));
    await connectivityGate.getByRole('button', { name: '确认启用外部连接' }).click();
    await page.getByText('恢复副本的外部连接已启用。').waitFor();

    const afterEnable = runOperator([
      'status', '--root', String(target['root']), '--master-key', fixture.masterKey, '--operator', OPERATOR,
    ], { env: fixture.docker });
    assert.equal(afterEnable.status, 0, afterEnable.stderr);
    assert.equal(afterEnable.output['workers_enabled'], true);
    assert.equal(afterEnable.output['connectivity_enabled'], true);

    // Equivalent CLI recovery behavior: the same set verifies and restores
    // through the lifecycle commands, and a CLI restoration is disabled too.
    const verified = command(fixture, [
      'backup', 'verify', '--backup-root', backupRoot, '--backup', backupId, '--operator', OPERATOR,
    ]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.output['verified'], true);
    const cliTarget = join(fixture.scratch, 'cli-restored');
    const cliRestored = runOperator([
      'restore', '--root', cliTarget, '--backup-root', backupRoot, '--backup', backupId,
      '--master-key', fixture.masterKey, '--operator', OPERATOR,
    ], { env: fixture.docker });
    assert.equal(cliRestored.status, 0, cliRestored.stderr);
    assert.equal(cliRestored.output['state'], 'verified_open');
    assert.equal(cliRestored.output['workers_enabled'], false);
    assert.equal(cliRestored.output['connectivity_enabled'], false);

    // The browser stays Chinese-only and never renders key material.
    const bodyText = await page.locator('body').innerText();
    assert.equal(bodyText.includes(readFileSync(fixture.masterKey).toString('hex')), false);
    assert.equal(/Restore|Recovery|Backup|Checkpoint|Step-up|Password/u.test(bodyText), false, bodyText);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});

/** The stored file backing one component of a recovery set. */
function componentPath(backupRoot: string, backupId: string, role: string): string {
  const manifest = JSON.parse(
    readFileSync(join(backupRoot, 'backups', backupId, 'manifest.json'), 'utf8'),
  ) as { components: Array<{ role: string; path: string }> };
  const component = manifest.components.find((entry) => entry.role === role);
  assert.ok(component !== undefined, `the recovery set has no ${role} component`);
  return join(backupRoot, 'backups', backupId, component.path);
}

async function startRestoreFromRow(page: Page, backupId: string, totpSecret: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: backupId });
  await row.getByRole('button', { name: '发起恢复' }).click();
  const gate = page.getByRole('region', { name: '恢复步进认证' });
  await gate.getByLabel('密码').fill(PASSWORD);
  await gate.getByLabel('动态验证码').fill(totpCode(totpSecret));
  await gate.getByRole('button', { name: '确认发起隔离恢复' }).click();
}

/** Waits until the durable record list holds at least this many restorations. */
async function waitForRestorations(page: Page, count: number): Promise<void> {
  const panel = page.getByRole('region', { name: '恢复记录' });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await panel.getByRole('row').count()) >= count + 1) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const notices = await page.locator('.alert__body').allInnerTexts();
  throw new Error(`expected ${count} restoration records; notices: ${notices.join(' | ')}\n${await panel.innerText()}`);
}

test('corruption, missing objects, keys, manifests, and ledger fail closed with explicit Chinese states', async () => {
  const current = world();
  const { fixture, backupRoot, restoreRoot } = current;
  const first = command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]);
  assert.equal(first.status, 0, first.stderr);
  const second = command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]);
  assert.equal(second.status, 0, second.stderr);
  const third = command(fixture, ['backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR]);
  assert.equal(third.status, 0, third.stderr);
  const corruptId = String(first.output['backup_id']);
  const objectsId = String(second.output['backup_id']);
  const manifestsId = String(third.output['backup_id']);

  const consoleServer = await startConsole(fixture, { backupRoot, restoreRoot });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    const totpSecret = await enrollAndSignIn(page, consoleServer.url, fixture);

    const setsPanel = page.getByRole('region', { name: '恢复集合' });
    await setsPanel.getByText(corruptId).waitFor();
    const row = (backupId: string) => page.getByRole('row').filter({ hasText: backupId });
    const recordsPanel = page.getByRole('region', { name: '恢复记录' });

    // A corrupted component is named by the recomputed integrity check, and a
    // restoration of that set never creates a target.
    const databasePath = componentPath(backupRoot, corruptId, 'database');
    appendFileSync(databasePath, 'corruption');
    await row(corruptId).getByRole('button', { name: '验证恢复集合' }).click();
    await page.getByText('恢复集的存储字节与清单不一致，已拒绝使用。').first().waitFor();
    assert.equal(await page.getByText('BACKUP_INTEGRITY_FAILED').count() >= 1, true);
    const evidencePanel = page.getByRole('region', { name: '恢复证据' });
    await startRestoreFromRow(page, corruptId, totpSecret);
    await waitForRestorations(page, 1);
    await evidencePanel.getByText('失败', { exact: true }).waitFor({ timeout: 60_000 });
    assert.ok((await evidencePanel.innerText()).includes('恢复集的存储字节与清单不一致，已拒绝使用。'));

    // A referenced object missing from the set fails the same way, so the
    // Operator never mistakes a partial set for a recoverable one.
    const objectsPath = componentPath(backupRoot, objectsId, 'objects');
    const objectsBytes = readFileSync(objectsPath);
    rmSync(objectsPath);
    await row(objectsId).getByRole('button', { name: '验证恢复集合' }).click();
    await page.getByText('恢复集的存储字节与清单不一致，已拒绝使用。').first().waitFor();
    assert.equal(await page.getByText('BACKUP_INTEGRITY_FAILED').count() >= 1, true);

    // A stored manifest that no longer matches its digest is refused before any
    // restoration target exists.
    const manifestPath = componentPath(backupRoot, manifestsId, 'manifests');
    const firstManifest = readFileSync(manifestPath);
    appendFileSync(manifestPath, 'tampered');
    await startRestoreFromRow(page, manifestsId, totpSecret);
    await waitForRestorations(page, 2);
    await evidencePanel.getByText('失败', { exact: true }).waitFor({ timeout: 60_000 });
    assert.ok((await evidencePanel.innerText()).includes('恢复集的存储字节与清单不一致，已拒绝使用。'));
    writeFileSync(manifestPath, firstManifest);

    // The escrowed master key is not in the set: when it is unavailable, both
    // verification and restoration refuse instead of guessing.
    writeFileSync(objectsPath, objectsBytes);
    const keyPath = fixture.masterKey;
    const parkedKey = `${keyPath}.parked`;
    renameSync(keyPath, parkedKey);
    try {
      await row(objectsId).getByRole('button', { name: '验证恢复集合' }).click();
      await page.getByText('托管主密钥不可用，恢复与验证被拒绝。').first().waitFor();
      assert.equal(await page.getByText('MASTER_KEY_NOT_FOUND').count() >= 1, true);
    } finally {
      renameSync(parkedKey, keyPath);
    }

    // Without the replicated Purge Ledger a restoration cannot promise purged
    // content stays deleted, so it refuses and opens nothing.
    const ledgerPath = join(backupRoot, 'ledger', 'purge-ledger.json');
    const ledger = readFileSync(ledgerPath);
    rmSync(ledgerPath);
    await startRestoreFromRow(page, objectsId, totpSecret);
    await waitForRestorations(page, 3);
    await page.getByText('离机清除台账缺失，无法保证已清除内容不再出现，恢复被拒绝。').first().waitFor({ timeout: 60_000 });
    writeFileSync(ledgerPath, ledger);
    await recordsPanel.getByText('失败', { exact: true }).nth(2).waitFor({ timeout: 60_000 });

    // Every failed restoration stays closed, creates no target, and degrades the
    // stated recovery health until a later verification succeeds.
    const cookie = await operatorCookie(page);
    const listed = await callApi(consoleServer.url, '/api/operator/recovery/restorations', { cookie });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const restorations = listed.body['restorations'] as Array<Record<string, unknown>>;
    assert.equal(restorations.length, 3);
    for (const entry of restorations) {
      const record = asRecord(entry);
      assert.equal(record['state'], 'failed');
      assert.equal(record['service_open'], false);
      assert.equal(asRecord(record['target'])['present'], false);
      assert.equal(typeof asRecord(record['error'])['code'], 'string');
    }
    const healthPanel = page.getByRole('region', { name: '备份与恢复健康' });
    await healthPanel.getByText('已降级', { exact: true }).waitFor();
    const degradedText = await healthPanel.innerText();
    assert.ok(degradedText.includes('最近一次恢复验证失败'), degradedText);

    // The adverse states stay Chinese-only.
    const bodyText = await page.locator('body').innerText();
    assert.equal(/Restore|Recovery|Backup|Checkpoint|Step-up|Password/u.test(bodyText), false, bodyText);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
