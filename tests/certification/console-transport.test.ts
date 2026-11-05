import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startConsole } from '../support/console.js';
import { runOperator } from '../support/operator.js';
import { command, workspaceFixture } from '../support/platform.js';

const CERTIFICATE = fileURLToPath(new URL('../../../tests/fixtures/tls/loopback-cert.pem', import.meta.url));
const KEY = fileURLToPath(new URL('../../../tests/fixtures/tls/loopback-key.pem', import.meta.url));

function listenerOf(fixture: ReturnType<typeof workspaceFixture>['fixture']): Record<string, unknown> {
  const status = command(fixture, ['status', '--operator', 'console-transport-certification']);
  assert.equal(status.status, 0, status.stderr);
  const listener = status.output['console_listener'];
  assert.ok(listener !== null && typeof listener === 'object', 'status must disclose the bound listener');
  return listener as Record<string, unknown>;
}

/**
 * Section 12: TLS is required for non-loopback traffic. The refusal happens
 * before any socket opens, while loopback development keeps working, and the
 * status surface states exactly where the active Console is bound and whether
 * TLS protects it.
 */
test('a non-loopback Console refuses to bind without TLS and loopback still starts', async () => {
  const { fixture } = workspaceFixture();

  // A wildcard bind would expose sessions and governed answers to the network
  // in clear text, so it is refused before the listener is created.
  const refused = runOperator(
    [
      'console', 'serve',
      '--root', fixture.root,
      '--master-key', fixture.masterKey,
      '--port', '0',
      '--host', '0.0.0.0',
    ],
    { env: fixture.docker },
  );
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(refused.error['code'], 'TLS_REQUIRED_FOR_NON_LOOPBACK');
  assert.equal(existsSync(join(fixture.root, 'state', 'console-listener.json')), false, 'no listener may exist after a refusal');

  // Loopback development is unchanged: plain HTTP on the host-local address.
  const loopback = await startConsole(fixture, { host: '127.0.0.1' });
  try {
    assert.match(loopback.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const listener = listenerOf(fixture);
    assert.equal(listener['host'], '127.0.0.1');
    assert.equal(listener['exposure'], 'loopback');
    assert.deepEqual(listener['tls'], { enabled: false, certificate: null });
  } finally {
    await loopback.stop();
  }

  // Configured TLS serves the same loopback listener over HTTPS and says so.
  const secure = await startConsole(fixture, {
    host: '127.0.0.1',
    tls: { certificateFile: CERTIFICATE, keyFile: KEY },
  });
  try {
    assert.match(secure.url, /^https:\/\/127\.0\.0\.1:\d+$/u);
    const listener = listenerOf(fixture);
    assert.equal(listener['exposure'], 'loopback');
    assert.deepEqual(listener['tls'], { enabled: true, certificate: CERTIFICATE });
  } finally {
    await secure.stop();
  }
});
