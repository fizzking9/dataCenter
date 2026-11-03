import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function fakeDockerEnvironment(
  workspace: string,
  options: { health?: 'healthy' | 'unhealthy' | 'missing' } = {},
): NodeJS.ProcessEnv {
  mkdirSync(workspace, { recursive: true });
  const script = join(workspace, 'fake-docker.mjs');
  const log = join(workspace, 'docker-calls.jsonl');
  writeFileSync(script, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DC_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args.includes('ps')) {
  const health = ${JSON.stringify(options.health ?? 'healthy')};
  for (const Service of ['postgres', 'minio']) {
    const service = { Service, State: 'running' };
    if (health !== 'missing') service.Health = health;
    console.log(JSON.stringify(service));
  }
}
`);
  return {
    DC_DOCKER_BIN: process.execPath,
    DC_DOCKER_SCRIPT: script,
    DC_DOCKER_LOG: log,
  };
}
