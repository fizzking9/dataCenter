import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { backupHealth } from './backup.js';
import { readMountedMasterKey, unwrapDataKey, type WrappedDataKey } from './keys.js';
import { readLicenseView } from './license.js';
import { readPlatform } from './platform.js';
import { retentionHealth } from './retention.js';
import { healthyServices } from './runtime.js';
import { readDeployment, readJsonFile, recordEvidence } from './state.js';
import { rollbackWindow } from './upgrade.js';

/**
 * The listener the Operator Console last bound: its host, exposure, and whether
 * TLS protects it. Absent means no Console has served this Deployment yet.
 */
function consoleListener(root: string): Record<string, unknown> | null {
  const path = join(root, 'state', 'console-listener.json');
  return existsSync(path) ? readJsonFile<Record<string, unknown>>(path) : null;
}

export function deploymentStatus(options: {
  root: string;
  masterKey?: string;
  operator: string;
  /** The instant the license is evaluated at, so lifecycle time is testable. */
  at?: Date;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  // Recovery health is stated even while service is closed: a Deployment that
  // stopped checkpointing has lost its promised RPO whatever else it reports.
  const backup = backupHealth(options.root);
  const listener = consoleListener(options.root);
  const recovery = {
    workers_enabled: deployment.workers_enabled !== false,
    connectivity_enabled: deployment.connectivity_enabled !== false,
    restored: deployment.restored ?? null,
    backup,
  };
  const license = readLicenseView(
    options.root,
    join(options.root, 'license.json'),
    options.at === undefined ? {} : { at: options.at },
  );
  const licenseDetail = {
    license_status: license.status,
    license_warning: license.warning?.level ?? null,
    license_error: license.error_code ?? null,
  };
  if (!deployment.service_open || license.status === 'invalid') {
    const evidenceId = recordEvidence(options.root, 'status', 'closed', options.operator, {
      state: deployment.state,
      backup_health: backup.health,
      ...licenseDetail,
    });
    return {
      state: deployment.state,
      health: 'closed',
      service_open: false,
      access: 'closed',
      release: deployment.release,
      deployment_id: deployment.deployment_id,
      rollback_window: rollbackWindow(options.root),
      license,
      ...recovery,
      console_listener: listener,
      evidence_id: evidenceId,
    };
  }
  if (license.status === 'expired') {
    const evidenceId = recordEvidence(options.root, 'status', 'expired_read_only', options.operator, {
      state: deployment.state,
      backup_health: backup.health,
      ...licenseDetail,
    });
    return {
      state: deployment.state,
      health: 'degraded',
      service_open: true,
      access: 'read_only',
      release: deployment.release,
      deployment_id: deployment.deployment_id,
      rollback_window: rollbackWindow(options.root),
      license,
      ...recovery,
      console_listener: listener,
      evidence_id: evidenceId,
    };
  }
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
    ...licenseDetail,
  });
  return {
    state: deployment.state,
    health,
    service_open: true,
    access: 'full',
    release: deployment.release,
    deployment_id: deployment.deployment_id,
    rollback_window: rollbackWindow(options.root),
    runtime_services: services,
    mfa_enrolled: deployment.mfa_enrolled === true,
    default_credentials: deployment.default_credentials !== false,
    master_key_external: deployment.master_key_external === true,
    license,
    retention,
    ...recovery,
    console_listener: listener,
    evidence_id: evidenceId,
  };
}
