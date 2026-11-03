import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export interface OperatorResult {
  status: number;
  output: Record<string, unknown>;
  error: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

export function runOperator(
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): OperatorResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return {
    status: result.status ?? 1,
    output: stdout ? JSON.parse(stdout) as Record<string, unknown> : {},
    error: stderr ? JSON.parse(stderr) as Record<string, unknown> : {},
    stdout,
    stderr,
  };
}
