import { randomUUID, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleFixture } from './bundle.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface LicenseRequest {
  request_id: string;
  deployment_id: string;
  release: string;
}

export function issueLicense(
  path: string,
  bundle: BundleFixture,
  request: LicenseRequest,
  options: {
    deploymentId?: string;
    notBefore?: string;
    expiresAt?: string;
    /** The highest release the entitlement allows; upgrades to it stay eligible. */
    highestEligibleRelease?: string;
  } = {},
): string {
  const now = Date.now();
  const payload = {
    schema_version: 1,
    license_id: randomUUID(),
    request_id: request.request_id,
    deployment_id: options.deploymentId ?? request.deployment_id,
    not_before: options.notBefore ?? new Date(now - 60_000).toISOString(),
    expires_at: options.expiresAt ?? new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    highest_eligible_release: options.highestEligibleRelease ?? request.release,
    issued_at: new Date(now).toISOString(),
  };
  const signature = sign(null, Buffer.from(canonical(payload)), bundle.licensePrivateKey).toString('base64');
  writeFileSync(path, `${JSON.stringify({
    payload,
    signature: {
      algorithm: 'Ed25519',
      key_id: 'license-certification-key',
      value: signature,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return payload.license_id;
}

/** The License Request the installed Deployment was issued for. */
export function installedLicenseRequest(root: string): LicenseRequest {
  return JSON.parse(readFileSync(join(root, 'license-request.json'), 'utf8')) as LicenseRequest;
}

/**
 * Signs one Deployment License for the installed License Request. Tests use it
 * for renewal, replacement, and for copying an already-expired entitlement into
 * place, which is the same file an ordinary expiration leaves behind.
 */
export function signedLicenseFor(
  directory: string,
  name: string,
  bundle: BundleFixture,
  request: LicenseRequest,
  options: Parameters<typeof issueLicense>[3] = {},
): string {
  const path = join(directory, `${name}.json`);
  issueLicense(path, bundle, request, options);
  return path;
}

/** Installs one signed license exactly as the removable-media import would. */
export function installLicenseFile(root: string, licensePath: string): void {
  writeFileSync(join(root, 'license.json'), readFileSync(licensePath));
}
