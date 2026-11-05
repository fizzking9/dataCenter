import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CommandOptions, PlatformFixture } from './platform.js';

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export interface CommandResult {
  status: number;
  output: Record<string, unknown>;
  error: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

/**
 * Runs one governed command without blocking the test process, so a deterministic
 * model endpoint hosted by the test can answer the child process that calls it.
 */
export function commandAsync(
  fixture: PlatformFixture,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const full = [...args, '--root', fixture.root, '--master-key', fixture.masterKey];
  if (options.token) full.push('--session-token', options.token);
  return runAsync(full, fixture.docker, options.input);
}

function runAsync(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const out = stdout.trim();
      const err = stderr.trim();
      resolve({
        status: code ?? 1,
        output: out ? JSON.parse(out) as Record<string, unknown> : {},
        error: err ? JSON.parse(err) as Record<string, unknown> : {},
        stdout: out,
        stderr: err,
      });
    });
    child.stdin.end(input ?? '');
  });
}
