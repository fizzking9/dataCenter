import { randomUUID, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
  options: { deploymentId?: string; notBefore?: string; expiresAt?: string } = {},
): string {
  const now = Date.now();
  const payload = {
    schema_version: 1,
    license_id: randomUUID(),
    request_id: request.request_id,
    deployment_id: options.deploymentId ?? request.deployment_id,
    not_before: options.notBefore ?? new Date(now - 60_000).toISOString(),
    expires_at: options.expiresAt ?? new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    highest_eligible_release: request.release,
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
