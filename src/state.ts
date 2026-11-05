import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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

export interface EvidenceSummary {
  evidence_id: string;
  operation: string;
  outcome: string;
  occurred_at: string;
  error_code?: string;
}

/**
 * The newest durable evidence for the named operations. It never reads content
 * bytes or secrets: only the facts an Operator Console states as outcomes.
 */
export function recentEvidence(
  root: string,
  operations: readonly string[],
  limit = 12,
): EvidenceSummary[] {
  const directory = join(root, 'evidence');
  if (!existsSync(directory)) return [];
  const allowed = new Set(operations);
  const summaries: Array<EvidenceSummary & { mtime: number }> = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const record = readJsonFile<Record<string, unknown>>(path);
      const operation = typeof record['operation'] === 'string' ? record['operation'] : '';
      if (!allowed.has(operation)) continue;
      summaries.push({
        evidence_id: typeof record['evidence_id'] === 'string' ? record['evidence_id'] : name.slice(0, -5),
        operation,
        outcome: typeof record['outcome'] === 'string' ? record['outcome'] : '',
        occurred_at: typeof record['occurred_at'] === 'string' ? record['occurred_at'] : '',
        ...(typeof record['error_code'] === 'string' ? { error_code: record['error_code'] } : {}),
        mtime: statSync(path).mtimeMs,
      });
    } catch {
      // Evidence that cannot be read is not lifecycle evidence.
    }
  }
  summaries.sort((left, right) => right.mtime - left.mtime);
  return summaries.slice(0, limit).map((summary) => ({
    evidence_id: summary.evidence_id,
    operation: summary.operation,
    outcome: summary.outcome,
    occurred_at: summary.occurred_at,
    ...(summary.error_code === undefined ? {} : { error_code: summary.error_code }),
  }));
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
