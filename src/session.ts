import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertAuditLogAvailable, appendAuditEvent, type AuditInput } from './audit.js';
import { OperatorError, assertCondition } from './errors.js';
import { readMountedMasterKey, unwrapDataKey, type WrappedDataKey } from './keys.js';
import { assessLicense, type LicenseWarning } from './license.js';
import { readPlatform, writePlatform, type PlatformState } from './platform.js';
import { readDeployment, readJsonFile } from './state.js';

/** The entitlement one governed request ran under. */
export interface SessionLicense {
  status: 'valid' | 'expired';
  expires_at: string;
  days_remaining: number;
  warning: LicenseWarning | null;
}

/**
 * Whether one operation may continue after ordinary license expiration. Reads,
 * exports, authentication, and ephemeral Natural-Language Query keep working;
 * governed writes pass the default `deny` and fail closed.
 */
export type ExpiryAccess = 'allow' | 'deny';

/**
 * One governed request against an open Deployment. State is loaded once,
 * audited appends are immediate, and only `save` persists changes. The license
 * is evaluated here, at the single server-side seam every governed operation
 * opens, so no module can accidentally write past an expired entitlement.
 */
export interface PlatformSession {
  root: string;
  state: PlatformState;
  dataKey: Buffer;
  correlationId: string;
  /** Absent on internal verification sessions that never consult entitlement. */
  license?: SessionLicense;
  audit(input: Omit<AuditInput, 'correlation_id'>): void;
  save(): void;
}

export function openPlatform(
  root: string,
  masterKeyPath: string,
  expiry: ExpiryAccess = 'deny',
): PlatformSession {
  const deployment = readDeployment(root);
  assertCondition(deployment.service_open, 'DEPLOYMENT_NOT_OPEN', 'The Deployment is not open for governed operations.', 'Run initialize with a valid license and a healthy runtime.');
  const assessment = assessLicense(root, join(root, 'license.json'));
  if (assessment.kind === 'invalid') {
    throw new OperatorError(assessment.code, assessment.message, assessment.nextStep);
  }
  if (assessment.kind === 'expired' && expiry === 'deny') {
    throw new OperatorError(
      'LICENSE_EXPIRED',
      'The Deployment License has expired; governed writes are closed and existing data stays readable.',
      'Import a renewed Deployment License to restore governed writes; reads, stored Reports, exports, backup, and lifecycle commands remain available.',
    );
  }
  const masterKey = readMountedMasterKey(root, masterKeyPath);
  const wrapped = readJsonFile<WrappedDataKey>(join(root, 'config', 'wrapped-data-key.json'));
  const state = readPlatform(root);
  const dataKey = unwrapDataKey(masterKey, wrapped);
  const correlationId = randomUUID();
  return {
    root,
    state,
    dataKey,
    correlationId,
    license: {
      status: assessment.kind,
      expires_at: assessment.license.payload.expires_at,
      days_remaining: assessment.days_remaining,
      warning: assessment.kind === 'valid' ? assessment.warning : null,
    },
    audit(input) {
      appendAuditEvent(root, { ...input, correlation_id: correlationId }, dataKey);
    },
    save() {
      // A state change is never persisted onto a Deployment whose audit log is
      // unavailable or no longer matches its checkpoint: the operation stops
      // instead of leaving a governed fact with no account of itself.
      assertAuditLogAvailable(root, dataKey);
      writePlatform(root, state);
    },
  };
}
