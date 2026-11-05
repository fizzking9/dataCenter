import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { command, type PlatformFixture } from './platform.js';
import { totpCode } from './totp.js';

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export interface ConsoleHandle {
  url: string;
  port: number;
  /** Whatever the server last wrote to stderr, so a failed call can explain itself. */
  errors(): string;
  stop(): Promise<void>;
}

/**
 * The ports a Chromium browser refuses to connect to at all, whatever the
 * service behind them answers: a page on one fails with ERR_UNSAFE_PORT before
 * any test step runs. The operating system may still assign one to a server
 * bound on port zero, so every listening address is checked against this set.
 */
const BROWSER_REFUSED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Starts the browser application on an address a Chromium browser will accept. */
export async function startConsole(
  fixture: PlatformFixture,
  options: { backupRoot?: string; restoreRoot?: string } = {},
): Promise<ConsoleHandle> {
  // A refused port is rare but not impossible, so the server is restarted on a
  // fresh assignment instead of handing the browser a URL it can never open.
  for (let attempt = 1; attempt < 8; attempt += 1) {
    const handle = await startConsoleOnce(fixture, options);
    if (!BROWSER_REFUSED_PORTS.has(handle.port)) return handle;
    await handle.stop();
  }
  throw new Error('the console never obtained a port a Chromium browser accepts');
}

async function startConsoleOnce(
  fixture: PlatformFixture,
  options: { backupRoot?: string; restoreRoot?: string },
): Promise<ConsoleHandle> {
  const recovery = [
    ...(options.backupRoot === undefined ? [] : ['--backup-root', options.backupRoot]),
    ...(options.restoreRoot === undefined ? [] : ['--restore-root', options.restoreRoot]),
  ];
  const child = spawn(
    process.execPath,
    [cliPath, 'console', 'serve', '--root', fixture.root, '--master-key', fixture.masterKey, '--port', '0', ...recovery],
    { env: { ...process.env, ...fixture.docker }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const listening = await waitForListening(child);
  const url = String(listening.url);
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  return {
    url,
    port: Number(listening.port),
    errors: () => errors,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await exited;
    },
  };
}

function waitForListening(child: ChildProcessByStdio<null, Readable, Readable>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let errors = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`console did not start listening: ${errors || buffer}`));
    }, 20_000);
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`console reported an unreadable address: ${String(error)}`));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`console exited with code ${String(code)}: ${errors}`));
    });
  });
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  cookies: string[];
}

export interface OperatorConsoleSession {
  /** The raw `name=value` cookie a later console request carries. */
  cookie: string;
  totp_secret: string;
}

/**
 * Enrolls one Operator from the CLI-issued one-time secret and opens a console
 * session over the authenticated HTTP API, exactly as the browser does.
 */
export async function signInOperatorConsole(
  fixture: PlatformFixture,
  url: string,
  options: { operator: string; password: string },
): Promise<OperatorConsoleSession> {
  const issued = command(fixture, ['console', 'enroll', '--operator', options.operator]);
  if (issued.status !== 0) throw new Error(`console enroll failed: ${issued.stderr}`);
  const enrolled = await callApi(url, '/api/operator/enrollment', {
    body: { enrollment_secret: String(issued.output.enrollment_secret), password: options.password },
  });
  if (enrolled.status !== 201) throw new Error(`operator enrollment failed: ${enrolled.text}`);
  const totpSecret = String(enrolled.body.totp_secret);
  return { cookie: await signInOperatorPage(url, options, totpSecret), totp_secret: totpSecret };
}

/** Opens one further console session for an Operator that already has credentials. */
export async function signInOperatorPage(
  url: string,
  options: { operator: string; password: string },
  totpSecret: string,
): Promise<string> {
  const signedIn = await callApi(url, '/api/operator/session', {
    body: { username: options.operator, password: options.password, totp: totpCode(totpSecret) },
  });
  if (signedIn.status !== 200) throw new Error(`operator sign-in failed: ${signedIn.text}`);
  return (signedIn.cookies[0] ?? '').split(';')[0] ?? '';
}

/** A raw byte body, which is what one governed upload carries. */
function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Calls one authenticated HTTP application API with an explicit operator cookie. */
export async function callApi(
  url: string,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; token?: string; contentType?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = options.contentType ?? 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined
      ? {}
      : {
        body: (isBytes(options.body)
          ? options.body
          : JSON.stringify(options.body)) as unknown as BodyInit,
      }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : {},
    text,
    cookies: response.headers.getSetCookie(),
  };
}
