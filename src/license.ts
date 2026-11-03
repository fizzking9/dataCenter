import { createPublicKey, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './crypto.js';
import { assertCondition } from './errors.js';
import {
  readDeployment,
  readJsonFile,
  recordEvidence,
  writeDeployment,
  writeJsonFile,
} from './state.js';

interface LicenseRequest {
  schema_version: number;
  request_id: string;
  deployment_id: string;
  release: string;
}

interface LicensePayload {
  schema_version: number;
  license_id: string;
  request_id: string;
  deployment_id: string;
  not_before: string;
  expires_at: string;
  highest_eligible_release: string;
  issued_at: string;
}

interface SignedLicense {
  payload: LicensePayload;
  signature: {
    algorithm: string;
    key_id: string;
    value: string;
  };
}

function compareRelease(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  assertCondition(leftParts.length === 3 && rightParts.length === 3 && [...leftParts, ...rightParts].every(Number.isInteger), 'LICENSE_RELEASE_INVALID', 'The license or Deployment release version is invalid.');
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function validateLicense(root: string, licensePath: string): SignedLicense {
  const deployment = readDeployment(root);
  const request = readJsonFile<LicenseRequest>(join(root, 'license-request.json'));
  assertCondition(existsSync(licensePath), 'LICENSE_NOT_FOUND', 'The Deployment License does not exist.');
  const license = readJsonFile<SignedLicense>(licensePath);
  const trust = readJsonFile<{ key_id: string; public_key_pem: string }>(join(root, 'trust', 'license-key.json'));
  assertCondition(license.signature?.algorithm === 'Ed25519' && license.signature.key_id === trust.key_id && license.signature.value, 'LICENSE_SIGNATURE_INVALID', 'The Deployment License signature metadata is invalid.');
  const key = createPublicKey(trust.public_key_pem);
  assertCondition(verify(null, Buffer.from(canonicalJson(license.payload)), key, Buffer.from(license.signature.value, 'base64')), 'LICENSE_SIGNATURE_INVALID', 'The Deployment License signature verification failed.');
  const payload = license.payload;
  assertCondition(payload.schema_version === 1 && payload.license_id && payload.request_id === request.request_id, 'LICENSE_REQUEST_MISMATCH', 'The Deployment License does not match the current License Request.');
  assertCondition(payload.deployment_id === deployment.deployment_id, 'LICENSE_DEPLOYMENT_MISMATCH', 'The Deployment License is bound to a different Deployment.');
  assertCondition(compareRelease(deployment.release, payload.highest_eligible_release) <= 0, 'LICENSE_RELEASE_INELIGIBLE', 'The installed release exceeds the license entitlement.');
  const now = Date.now();
  const notBefore = Date.parse(payload.not_before);
  const expiresAt = Date.parse(payload.expires_at);
  assertCondition(Number.isFinite(notBefore) && Number.isFinite(expiresAt) && notBefore < expiresAt, 'LICENSE_WINDOW_INVALID', 'The Deployment License validity window is invalid.');
  assertCondition(now >= notBefore, 'LICENSE_NOT_YET_VALID', 'The Deployment License is not yet valid.', 'Correct the host clock or import a currently valid license.');
  assertCondition(now < expiresAt, 'LICENSE_EXPIRED', 'The Deployment License has expired.', 'Import a renewed Deployment License before initialization.');
  return license;
}

export function importLicense(options: {
  root: string;
  license: string;
  operator: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  assertCondition(!deployment.service_open, 'DEPLOYMENT_ALREADY_OPEN', 'License replacement requires the supported renewal lifecycle while service is closed.');
  const license = validateLicense(options.root, options.license);
  writeJsonFile(join(options.root, 'license.json'), license);
  const next = {
    ...deployment,
    state: 'ready_to_initialize',
  };
  writeDeployment(options.root, next);
  recordEvidence(options.root, 'import-license', 'ready_to_initialize', options.operator, {
    license_id: license.payload.license_id,
    not_before: license.payload.not_before,
    expires_at: license.payload.expires_at,
    highest_eligible_release: license.payload.highest_eligible_release,
  });
  return {
    state: next.state,
    license_id: license.payload.license_id,
    service_open: false,
  };
}
