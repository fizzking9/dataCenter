import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapAdministrator } from './admin.js';
import { assertCondition } from './errors.js';
import { readMountedMasterKey, wrapNewDataKey } from './keys.js';
import { validateLicense } from './license.js';
import { startPinnedServices } from './runtime.js';
import {
  readDeployment,
  recordEvidence,
  writeDeployment,
  writeJsonFile,
} from './state.js';

export async function initializeDeployment(options: {
  root: string;
  masterKey: string;
  adminUsername: string;
  adminPassword: string;
  operator: string;
}): Promise<Record<string, unknown>> {
  const deployment = readDeployment(options.root);
  assertCondition(!deployment.service_open, 'DEPLOYMENT_ALREADY_OPEN', 'The Deployment is already initialized and open.');
  const licensePath = join(options.root, 'license.json');
  assertCondition(existsSync(licensePath), 'LICENSE_REQUIRED', 'A matching signed Deployment License is required before initialization.');
  validateLicense(options.root, licensePath);
  const masterKey = readMountedMasterKey(options.root, options.masterKey);
  const { dataKey, wrapped } = wrapNewDataKey(masterKey);
  const secrets = await bootstrapAdministrator(options.root, options.adminUsername, options.adminPassword, dataKey);
  mkdirSync(join(options.root, 'config'), { recursive: true, mode: 0o700 });
  writeJsonFile(join(options.root, 'config', 'wrapped-data-key.json'), wrapped);
  writeDeployment(options.root, {
    ...deployment,
    state: 'initializing',
    service_open: false,
    mfa_enrolled: true,
    default_credentials: false,
    master_key_external: true,
  });
  try {
    const services = startPinnedServices(options.root, readDeployment(options.root));
    writeDeployment(options.root, {
      ...readDeployment(options.root),
      state: 'verified_open',
      service_open: true,
      runtime_services: services,
    });
    const evidenceId = recordEvidence(options.root, 'initialize', 'verified_open', options.operator, {
      release: deployment.release,
      runtime_services: services,
      mfa_enrolled: true,
      default_credentials: false,
      master_key_external: true,
    });
    return {
      state: 'verified_open',
      service_open: true,
      mfa_enrolled: true,
      default_credentials: false,
      master_key_external: true,
      runtime_services: services,
      evidence_id: evidenceId,
      ...secrets,
    };
  } catch (error) {
    writeDeployment(options.root, {
      ...readDeployment(options.root),
      state: 'closed',
      service_open: false,
    });
    recordEvidence(options.root, 'initialize', 'closed', options.operator, {
      release: deployment.release,
      next_step: 'Correct local runtime health and rerun initialize; service remains closed.',
    });
    throw error;
  }
}
