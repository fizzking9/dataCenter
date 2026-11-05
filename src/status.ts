import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMountedMasterKey, unwrapDataKey, type WrappedDataKey } from './keys.js';
import { validateLicense } from './license.js';
import { readPlatform } from './platform.js';
import { retentionHealth } from './retention.js';
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
  // A failed physical deletion degrades health until a retry succeeds; it never
  // changes published data, so the Deployment keeps serving while it is degraded.
  const retention = retentionHealth(readPlatform(options.root));
  const health = retention.health;
  const evidenceId = recordEvidence(options.root, 'status', health, options.operator, {
    state: deployment.state,
    runtime_services: services,
    license_valid: true,
    master_key_valid: true,
    failed_purges: retention.failed_purges,
    pending_purges: retention.pending_purges,
  });
  return {
    state: deployment.state,
    health,
    service_open: true,
    runtime_services: services,
    mfa_enrolled: deployment.mfa_enrolled === true,
    default_credentials: deployment.default_credentials !== false,
    master_key_external: deployment.master_key_external === true,
    retention,
    evidence_id: evidenceId,
  };
}
