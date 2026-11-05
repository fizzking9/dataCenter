import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCondition } from './errors.js';

export interface DeploymentState {
  schema_version: number;
  deployment_id: string;
  release: string;
  state: string;
  service_open: boolean;
  created_at: string;
  mfa_enrolled?: boolean;
  default_credentials?: boolean;
  master_key_external?: boolean;
  runtime_services?: string[];
  /** Absent means enabled: a Deployment that was never restored keeps working. */
  workers_enabled?: boolean;
  connectivity_enabled?: boolean;
  /** Present only on a Deployment produced by an isolated restoration. */
  restored?: { backup_id: string; restored_at: string; verification_id: string } | null;
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readDeployment(root: string): DeploymentState {
  const path = join(root, 'deployment.json');
  assertCondition(existsSync(path), 'DEPLOYMENT_NOT_FOUND', 'The Deployment has not been installed.', 'Run install with a verified Release Bundle.');
  return readJsonFile<DeploymentState>(path);
}

export function writeDeployment(root: string, state: DeploymentState): void {
  writeJsonFile(join(root, 'deployment.json'), state);
}

export function recordEvidence(
  root: string,
  operation: string,
  outcome: string,
  operator: string,
  details: Record<string, unknown> = {},
): string {
  const evidenceDirectory = join(root, 'evidence');
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const evidenceId = randomUUID();
  writeJsonFile(join(evidenceDirectory, `${evidenceId}.json`), {
    evidence_id: evidenceId,
    operation,
    outcome,
    operator,
    deployment_id: readDeployment(root).deployment_id,
    occurred_at: new Date().toISOString(),
    secrets_included: false,
    ...details,
  });
  return evidenceId;
}
