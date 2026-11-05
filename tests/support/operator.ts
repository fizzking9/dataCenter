import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export interface OperatorResult {
  status: number;
  output: Record<string, unknown>;
  error: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

function parse(stdoutText: string, stderrText: string, status: number | null): OperatorResult {
  const stdout = stdoutText.trim();
  const stderr = stderrText.trim();
  return {
    status: status ?? 1,
    output: stdout ? JSON.parse(stdout) as Record<string, unknown> : {},
    error: stderr ? JSON.parse(stderr) as Record<string, unknown> : {},
    stdout,
    stderr,
  };
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
  return parse(result.stdout ?? '', result.stderr ?? '', result.status);
}

/**
 * Runs one governed command without blocking the test thread, so a test can
 * start a second worker while the first is still talking to a Source.
 */
export function runOperatorAsync(
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<OperatorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (status) => {
      try {
        resolve(parse(stdout, stderr, status));
      } catch (error) {
        reject(error);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
