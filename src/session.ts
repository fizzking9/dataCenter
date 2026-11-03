import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendAuditEvent, type AuditInput } from './audit.js';
import { assertCondition } from './errors.js';
import { readMountedMasterKey, unwrapDataKey, type WrappedDataKey } from './keys.js';
import { readPlatform, writePlatform, type PlatformState } from './platform.js';
import { readDeployment, readJsonFile } from './state.js';

/**
 * One governed request against an open Deployment. State is loaded once,
 * audited appends are immediate, and only `save` persists changes.
 */
export interface PlatformSession {
  root: string;
  state: PlatformState;
  dataKey: Buffer;
  correlationId: string;
  audit(input: Omit<AuditInput, 'correlation_id'>): void;
  save(): void;
}

export function openPlatform(root: string, masterKeyPath: string): PlatformSession {
  const deployment = readDeployment(root);
  assertCondition(deployment.service_open, 'DEPLOYMENT_NOT_OPEN', 'The Deployment is not open for governed operations.', 'Run initialize with a valid license and a healthy runtime.');
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
    audit(input) {
      appendAuditEvent(root, { ...input, correlation_id: correlationId }, dataKey);
    },
    save() {
      writePlatform(root, state);
    },
  };
}
