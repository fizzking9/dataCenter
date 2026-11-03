import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyReleaseBundle } from './bundle.js';
import { assertCondition } from './errors.js';

export interface InstallResult {
  state: string;
  release: string;
  deployment_id: string;
  license_request: string;
  service_open: boolean;
  evidence_id: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function installDeployment(options: {
  bundle: string;
  root: string;
  releaseKey: string;
  confirmedFingerprint: string;
  operator: string;
}): InstallResult {
  assertCondition(!existsSync(options.root), 'DEPLOYMENT_EXISTS', 'The Deployment root already exists.', 'Use the supported lifecycle command for the existing Deployment.');
  const verified = verifyReleaseBundle(options.bundle, options.releaseKey, options.confirmedFingerprint);
  const parent = dirname(options.root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.dc-install-${randomUUID()}`);
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const releaseRoot = join(staging, 'releases', verified.manifest.release);
    cpSync(verified.directory, releaseRoot, { recursive: true, errorOnExist: true });
    mkdirSync(join(staging, 'trust'), { recursive: true, mode: 0o700 });
    mkdirSync(join(staging, 'evidence'), { recursive: true, mode: 0o700 });
    cpSync(options.releaseKey, join(staging, 'trust', 'release-key.pem'));
    writeFileSync(join(staging, 'trust', 'release-key.fingerprint'), `${verified.releaseFingerprint}\n`, { mode: 0o600 });
    writeJson(join(staging, 'trust', 'license-key.json'), verified.manifest.license_verification);

    const now = new Date().toISOString();
    const deploymentId = randomUUID();
    writeJson(join(staging, 'deployment.json'), {
      schema_version: 1,
      deployment_id: deploymentId,
      release: verified.manifest.release,
      state: 'license_required',
      service_open: false,
      created_at: now,
    });
    const requestPath = join(staging, 'license-request.json');
    writeJson(requestPath, {
      schema_version: 1,
      request_id: randomUUID(),
      deployment_id: deploymentId,
      release: verified.manifest.release,
      created_at: now,
    });
    const evidenceId = randomUUID();
    writeJson(join(staging, 'evidence', `${evidenceId}.json`), {
      evidence_id: evidenceId,
      operation: 'install',
      outcome: 'license_required',
      operator: options.operator,
      release: verified.manifest.release,
      deployment_id: deploymentId,
      release_key_fingerprint: verified.releaseFingerprint,
      occurred_at: now,
      secrets_included: false,
    });
    renameSync(staging, options.root);
    return {
      state: 'license_required',
      release: verified.manifest.release,
      deployment_id: deploymentId,
      license_request: requestPath.replace(staging, options.root),
      service_open: false,
      evidence_id: evidenceId,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
