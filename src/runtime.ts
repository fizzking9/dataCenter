import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { ReleaseManifest } from './bundle.js';
import { assertCondition, OperatorError } from './errors.js';
import { readJsonFile, type DeploymentState } from './state.js';

interface RuntimeService {
  Service?: string;
  Name?: string;
  State?: string;
  Health?: string;
}

function docker(args: string[]): string {
  const executable = process.env.DC_DOCKER_BIN ?? 'docker';
  const prefix = process.env.DC_DOCKER_SCRIPT ? [process.env.DC_DOCKER_SCRIPT] : [];
  const result = spawnSync(executable, [...prefix, ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new OperatorError('RUNTIME_COMMAND_FAILED', 'The local container runtime command failed.', 'Inspect local Docker health; no vendor network access is required.');
  }
  return result.stdout;
}

function composeArguments(root: string, deployment: DeploymentState): string[] {
  return [
    'compose',
    '--project-name', `dc-${deployment.deployment_id}`,
    '--file', join(root, 'releases', deployment.release, 'compose.yaml'),
  ];
}

export function healthyServices(root: string, deployment: DeploymentState): string[] {
  const output = docker([...composeArguments(root, deployment), 'ps', '--format', 'json']);
  const trimmed = output.trim();
  let services: RuntimeService[];
  if (!trimmed) {
    services = [];
  } else if (trimmed.startsWith('[')) {
    services = JSON.parse(trimmed) as RuntimeService[];
  } else {
    services = trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RuntimeService);
  }
  const healthy = services.filter((service) => service.State === 'running' && service.Health === 'healthy');
  const names = healthy.map((service) => service.Service ?? service.Name).filter((name): name is string => Boolean(name)).sort();
  assertCondition(['minio', 'postgres'].every((required) => names.includes(required)), 'RUNTIME_UNHEALTHY', 'PostgreSQL and MinIO are not both running and healthy.', 'Keep service closed and inspect the durable lifecycle evidence.');
  return names;
}

export function startPinnedServices(root: string, deployment: DeploymentState): string[] {
  const manifest = readJsonFile<ReleaseManifest>(join(root, 'releases', deployment.release, 'manifest.json'));
  for (const image of manifest.images) {
    docker(['load', '--input', join(root, 'releases', deployment.release, image.archive)]);
  }
  docker([...composeArguments(root, deployment), 'up', '--detach', '--pull', 'never', '--no-build']);
  return healthyServices(root, deployment);
}
