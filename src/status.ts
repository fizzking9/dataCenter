import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMountedMasterKey, unwrapDataKey, type WrappedDataKey } from './keys.js';
import { validateLicense } from './license.js';
import { healthyServices } from './runtime.js';
import { readDeployment, readJsonFile, recordEvidence } from './state.js';

export function deploymentStatus(options: {
  root: string;
  masterKey?: string;
  operator: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const licensePath = join(options.root, 'license.json');
  if (!existsSync(licensePath) || !deployment.service_open) {
    const evidenceId = recordEvidence(options.root, 'status', 'closed', options.operator, {
      state: deployment.state,
    });
    return {
      state: deployment.state,
      health: 'closed',
      service_open: false,
      evidence_id: evidenceId,
    };
  }
  validateLicense(options.root, licensePath);
  if (!options.masterKey) {
    throw new Error('--master-key is required for an initialized Deployment.');
  }
  const masterKey = readMountedMasterKey(options.root, options.masterKey);
  const wrapped = readJsonFile<WrappedDataKey>(join(options.root, 'config', 'wrapped-data-key.json'));
  unwrapDataKey(masterKey, wrapped);
  const services = healthyServices(options.root, deployment);
  const evidenceId = recordEvidence(options.root, 'status', 'healthy', options.operator, {
    state: deployment.state,
    runtime_services: services,
    license_valid: true,
    master_key_valid: true,
  });
  return {
    state: deployment.state,
    health: 'healthy',
    service_open: true,
    runtime_services: services,
    mfa_enrolled: deployment.mfa_enrolled === true,
    default_credentials: deployment.default_credentials !== false,
    master_key_external: deployment.master_key_external === true,
    evidence_id: evidenceId,
  };
}
