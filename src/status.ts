import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backupHealth } from './backup.js';
import { readMountedMasterKey, unwrapDataKey, type WrappedDataKey } from './keys.js';
import { validateLicense } from './license.js';
import { readPlatform } from './platform.js';
import { retentionHealth } from './retention.js';
import { healthyServices } from './runtime.js';
import { readDeployment, readJsonFile, recordEvidence } from './state.js';
import { rollbackWindow } from './upgrade.js';

export function deploymentStatus(options: {
  root: string;
  masterKey?: string;
  operator: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  // Recovery health is stated even while service is closed: a Deployment that
  // stopped checkpointing has lost its promised RPO whatever else it reports.
  const backup = backupHealth(options.root);
  const recovery = {
    workers_enabled: deployment.workers_enabled !== false,
    connectivity_enabled: deployment.connectivity_enabled !== false,
    restored: deployment.restored ?? null,
    backup,
  };
  const licensePath = join(options.root, 'license.json');
  if (!existsSync(licensePath) || !deployment.service_open) {
    const evidenceId = recordEvidence(options.root, 'status', 'closed', options.operator, {
      state: deployment.state,
      backup_health: backup.health,
    });
    return {
      state: deployment.state,
      health: 'closed',
      service_open: false,
      release: deployment.release,
      rollback_window: rollbackWindow(options.root),
      ...recovery,
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
  const health = retention.health === 'degraded' || backup.health === 'degraded' ? 'degraded' : 'healthy';
  const evidenceId = recordEvidence(options.root, 'status', health, options.operator, {
    state: deployment.state,
    runtime_services: services,
    license_valid: true,
    master_key_valid: true,
    failed_purges: retention.failed_purges,
    pending_purges: retention.pending_purges,
    backup_health: backup.health,
    backup_reasons: backup.reasons,
  });
  return {
    state: deployment.state,
    health,
    service_open: true,
    release: deployment.release,
    rollback_window: rollbackWindow(options.root),
    runtime_services: services,
    mfa_enrolled: deployment.mfa_enrolled === true,
    default_credentials: deployment.default_credentials !== false,
    master_key_external: deployment.master_key_external === true,
    retention,
    ...recovery,
    evidence_id: evidenceId,
  };
}
