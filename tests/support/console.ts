import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { PlatformFixture } from './platform.js';

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export interface ConsoleHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Starts the browser application through its supported lifecycle command and
 * waits for it to report the address it is listening on.
 */
export async function startConsole(fixture: PlatformFixture): Promise<ConsoleHandle> {
  const child = spawn(
    process.execPath,
    [cliPath, 'console', 'serve', '--root', fixture.root, '--master-key', fixture.masterKey, '--port', '0'],
    { env: { ...process.env, ...fixture.docker }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const listening = await waitForListening(child);
  const url = String(listening.url);
  return {
    url,
    port: Number(listening.port),
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

/** Calls one authenticated HTTP application API with an explicit operator cookie. */
export async function callApi(
  url: string,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : {},
    text,
    cookies: response.headers.getSetCookie(),
  };
}
