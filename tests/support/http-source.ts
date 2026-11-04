import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SourceRequest {
  path: string;
  query: Record<string, string>;
  authorization: string | null;
}

export interface SourceReply {
  status?: number;
  body: string;
}

export interface HttpSourceScenario {
  /** One reply per request; the last one repeats unless `repeat_last` is false. */
  replies: SourceReply[];
  repeat_last?: boolean;
}

/**
 * A real HTTP endpoint a connector acquires from, running in its own process so
 * the connector's synchronous caller can still be answered on the wire.
 */
export interface HttpSource {
  url: string;
  requests(): SourceRequest[];
  close(): Promise<void>;
}

const serverScript = fileURLToPath(new URL('./http-source-server.js', import.meta.url));
const running = new Set<ChildProcess>();

process.on('exit', () => {
  for (const child of running) child.kill();
});

export async function startHttpSource(scenario: HttpSourceScenario): Promise<HttpSource> {
  const directory = mkdtempSync(join(tmpdir(), 'dc-http-source-'));
  const log = join(directory, 'requests.jsonl');
  const child = spawn(process.execPath, [serverScript, JSON.stringify({ ...scenario, log })], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  running.add(child);
  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const line = buffered.split('\n')[0];
      if (line === undefined || !line.endsWith('}')) return;
      resolve((JSON.parse(line) as { port: number }).port);
    });
    child.once('exit', (code) => reject(new Error(`the HTTP source exited with ${code}`)));
  });
  // The fixture never keeps the test process alive: a failed assertion that skips
  // close() must fail its test rather than hang the run.
  child.stdout?.removeAllListeners('data');
  child.stdout?.destroy();
  child.unref();
  return {
    url: `http://127.0.0.1:${port}`,
    requests() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SourceRequest);
    },
    async close() {
      running.delete(child);
      // The child is detached, so its exit event is not something to wait on; the
      // signal is enough and the process ends with the test run.
      if (child.exitCode === null) child.kill();
    },
  };
}

/** One page of a paged JSON endpoint, sized the way the connection paginates. */
export function pageBody(records: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ data: { records }, ...extra });
}
