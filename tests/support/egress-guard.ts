import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A preload guard that fails every non-loopback connection a certified process
 * makes. Disconnected certification installs it into the fixture environment,
 * so a lifecycle step that secretly needed a vendor service would fail instead
 * of quietly reaching the network, and each blocked destination is recorded.
 */
export interface EgressGuard {
  env: NodeJS.ProcessEnv;
  logPath: string;
}

export function blockedEgressEnvironment(directory: string): EgressGuard {
  mkdirSync(directory, { recursive: true });
  const script = join(directory, 'egress-guard.cjs');
  const logPath = join(directory, 'egress-attempts.log');
  writeFileSync(script, `
const fs = require('node:fs');
const net = require('node:net');

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']);

function allowed(host) {
  if (host === undefined || host === null || host === '') return true;
  const name = String(host).replace(/^\\[/u, '').replace(/\\]$/u, '').toLowerCase();
  return LOOPBACK_NAMES.has(name) || name.startsWith('127.');
}

function refuse(host) {
  try {
    fs.appendFileSync(process.env.DC_EGRESS_LOG, String(host) + '\\n');
  } catch {}
  const error = new Error('CERTIFICATION_EGRESS_BLOCKED ' + String(host));
  error.code = 'CERTIFICATION_EGRESS_BLOCKED';
  throw error;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  let host;
  if (first !== null && typeof first === 'object') {
    host = first.host;
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (!allowed(host)) refuse(host);
  return originalConnect.apply(this, args);
};

const dns = require('node:dns');
const originalLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (!allowed(hostname)) refuse(hostname);
  return originalLookup.call(this, hostname, ...rest);
};
if (dns.promises && typeof dns.promises.lookup === 'function') {
  const originalPromised = dns.promises.lookup;
  dns.promises.lookup = function (hostname, ...rest) {
    if (!allowed(hostname)) refuse(hostname);
    return originalPromised.call(this, hostname, ...rest);
  };
}
`);
  const existing = process.env['NODE_OPTIONS'] ?? '';
  // NODE_OPTIONS parses its own argument string, so the Windows separator would
  // be consumed as an escape; a forward-slash path is stable on every host.
  const preloadPath = script.replace(/\\/gu, '/');
  return {
    env: {
      NODE_OPTIONS: `${existing} --require "${preloadPath}"`.trim(),
      DC_EGRESS_LOG: logPath,
    },
    logPath,
  };
}

/** The exact non-loopback destinations a guarded process tried to reach. */
export function recordedEgressAttempts(logPath: string): string[] {
  try {
    return readFileSync(logPath, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
