import { createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './crypto.js';
import { OperatorError, assertCondition } from './errors.js';
import {
  readDeployment,
  readJsonFile,
  recordEvidence,
  writeDeployment,
  writeJsonFile,
} from './state.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A host clock correction of a few minutes is ordinary, but a Deployment that
 * observes the wall clock jump a day or more backwards is not: the entitlement
 * could otherwise be extended simply by turning the clock back.
 */
const CLOCK_ROLLBACK_TOLERANCE_MS = DAY_MS;

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

export interface SignedLicense {
  payload: LicensePayload;
  signature: {
    algorithm: string;
    key_id: string;
    value: string;
  };
}

/** The three announced warning thresholds, each stated in Simplified Chinese. */
export type LicenseWarningLevel = '30_day' | '7_day' | '1_day';

export interface LicenseWarning {
  level: LicenseWarningLevel;
  days_remaining: number;
  expires_at: string;
  message: string;
}

export type LicenseAssessment =
  | {
    kind: 'valid';
    license: SignedLicense;
    days_remaining: number;
    warning: LicenseWarning | null;
  }
  | {
    kind: 'expired';
    license: SignedLicense;
    days_remaining: number;
  }
  | {
    kind: 'invalid';
    code: string;
    message: string;
    nextStep?: string;
  };

export interface LicenseSummary {
  license_id: string;
  not_before: string;
  expires_at: string;
  highest_eligible_release: string;
}

/** What a status surface may show about the current entitlement. */
export interface LicenseView extends Partial<LicenseSummary> {
  status: 'valid' | 'expired' | 'invalid';
  days_remaining: number | null;
  warning: LicenseWarning | null;
  error_code?: string;
  message?: string;
}

interface LicenseHistoryEntry extends LicenseSummary {
  request_id: string;
  imported_at: string;
  previous_license_id: string | null;
}

interface LicenseHistory {
  schema_version: 1;
  entries: LicenseHistoryEntry[];
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

export function licenseWarningAt(expiresAt: number, at: Date, expiresText: string): LicenseWarning | null {
  const remaining = expiresAt - at.getTime();
  if (remaining <= 0) return null;
  const level: LicenseWarningLevel | null = remaining <= DAY_MS
    ? '1_day'
    : remaining <= 7 * DAY_MS
      ? '7_day'
      : remaining <= 30 * DAY_MS
        ? '30_day'
        : null;
  if (level === null) return null;
  const days = Math.max(1, Math.ceil(remaining / DAY_MS));
  return {
    level,
    days_remaining: days,
    expires_at: expiresText,
    message: `许可将在 ${days} 天内到期，请离线导入续期许可。`,
  };
}

function clockPath(root: string): string {
  return join(root, 'state', 'clock.json');
}

/**
 * Records the highest wall-clock instant this Deployment has observed. A later
 * operation proves whether the host clock moved backwards significantly, which
 * fails closed instead of silently extending the entitlement.
 */
function observeClock(root: string, at: Date): { rolledBack: boolean } {
  const path = clockPath(root);
  let observed: number | null = null;
  if (existsSync(path)) {
    try {
      const record = readJsonFile<{ highest_observed_at: string }>(path);
      const parsed = Date.parse(record.highest_observed_at);
      if (Number.isFinite(parsed)) observed = parsed;
    } catch {
      // An unreadable observation record establishes no earlier instant.
    }
  }
  if (observed !== null && at.getTime() < observed - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return { rolledBack: true };
  }
  if (observed === null || at.getTime() > observed) {
    mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 });
    writeJsonFile(path, {
      schema_version: 1,
      highest_observed_at: at.toISOString(),
    });
  }
  return { rolledBack: false };
}

function invalid(
  code: string,
  message: string,
  nextStep?: string,
): { kind: 'invalid'; code: string; message: string; nextStep?: string } {
  return { kind: 'invalid', code, message, ...(nextStep === undefined ? {} : { nextStep }) };
}

/**
 * Evaluates the installed Deployment License without acting on it. A license is
 * valid when it is signed by the trusted vendor key, bound to this exact
 * Deployment and License Request, within its window, eligible for the installed
 * release, and observed by a clock that has not moved significantly backwards.
 */
export function assessLicense(
  root: string,
  licensePath: string,
  options: { at?: Date; recordClock?: boolean } = {},
): LicenseAssessment {
  const deployment = readDeployment(root);
  const at = options.at ?? new Date();
  assertCondition(!Number.isNaN(at.getTime()), 'LICENSE_AT_INVALID', 'The license evaluation instant must be a valid time.');

  if (!existsSync(licensePath)) {
    return invalid('LICENSE_NOT_FOUND', 'The Deployment License does not exist.');
  }
  let license: SignedLicense;
  try {
    license = readJsonFile<SignedLicense>(licensePath);
  } catch {
    return invalid('LICENSE_MALFORMED', 'The Deployment License is not a readable signed document.');
  }
  if (license === null || typeof license !== 'object' || license.payload === null || typeof license.payload !== 'object') {
    return invalid('LICENSE_MALFORMED', 'The Deployment License is not a readable signed document.');
  }

  let trust: { key_id: string; public_key_pem: string };
  try {
    trust = readJsonFile<{ key_id: string; public_key_pem: string }>(join(root, 'trust', 'license-key.json'));
  } catch {
    return invalid('LICENSE_SIGNATURE_INVALID', 'The Deployment trust root for Deployment Licenses is missing or unreadable.');
  }
  if (license.signature?.algorithm !== 'Ed25519'
    || license.signature.key_id !== trust.key_id
    || !license.signature.value) {
    return invalid('LICENSE_SIGNATURE_INVALID', 'The Deployment License signature metadata is invalid.');
  }
  try {
    const key = createPublicKey(trust.public_key_pem);
    if (!verify(null, Buffer.from(canonicalJson(license.payload)), key, Buffer.from(license.signature.value, 'base64'))) {
      return invalid('LICENSE_SIGNATURE_INVALID', 'The Deployment License signature verification failed.');
    }
  } catch {
    return invalid('LICENSE_SIGNATURE_INVALID', 'The Deployment License signature verification failed.');
  }

  let request: LicenseRequest;
  try {
    request = readJsonFile<LicenseRequest>(join(root, 'license-request.json'));
  } catch {
    return invalid('LICENSE_REQUEST_MISMATCH', 'The Deployment License Request is missing or unreadable.');
  }
  const payload = license.payload;
  if (payload.schema_version !== 1 || !payload.license_id || payload.request_id !== request.request_id) {
    return invalid('LICENSE_REQUEST_MISMATCH', 'The Deployment License does not match the current License Request.');
  }
  if (payload.deployment_id !== deployment.deployment_id) {
    return invalid('LICENSE_DEPLOYMENT_MISMATCH', 'The Deployment License is bound to a different Deployment.');
  }
  try {
    if (compareRelease(deployment.release, payload.highest_eligible_release) > 0) {
      return invalid('LICENSE_RELEASE_INELIGIBLE', 'The installed release exceeds the license entitlement.');
    }
  } catch (error) {
    return invalid(
      error instanceof OperatorError ? error.code : 'LICENSE_RELEASE_INVALID',
      error instanceof OperatorError ? error.message : 'The license or Deployment release version is invalid.',
    );
  }
  const notBefore = Date.parse(payload.not_before);
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore >= expiresAt) {
    return invalid('LICENSE_WINDOW_INVALID', 'The Deployment License validity window is invalid.');
  }

  if (options.recordClock !== false) {
    const clock = observeClock(root, at);
    if (clock.rolledBack) {
      return invalid(
        'LICENSE_CLOCK_ROLLBACK',
        'The host clock moved significantly backwards since this Deployment last observed the time.',
        'Restore the host clock to the current time; the service stays closed until the clock is trustworthy.',
      );
    }
  }
  if (at.getTime() < notBefore) {
    return invalid(
      'LICENSE_NOT_YET_VALID',
      'The Deployment License is not yet valid.',
      'Correct the host clock or import a currently valid license.',
    );
  }
  if (at.getTime() >= expiresAt) {
    return {
      kind: 'expired',
      license,
      days_remaining: 0,
    };
  }
  return {
    kind: 'valid',
    license,
    days_remaining: Math.max(1, Math.ceil((expiresAt - at.getTime()) / DAY_MS)),
    warning: licenseWarningAt(expiresAt, at, payload.expires_at),
  };
}

/**
 * The entitlement a governed request runs under: no license means the service
 * is closed, while an expired license leaves existing data readable.
 */
export function validateLicense(root: string, licensePath: string): SignedLicense {
  const assessment = assessLicense(root, licensePath);
  if (assessment.kind === 'invalid') {
    throw new OperatorError(assessment.code, assessment.message, assessment.nextStep);
  }
  if (assessment.kind === 'expired') {
    throw new OperatorError(
      'LICENSE_EXPIRED',
      'The Deployment License has expired.',
      'Import a renewed Deployment License before initialization.',
    );
  }
  return assessment.license;
}

/** The license view a status or console surface may show without failing on expiry. */
export function readLicenseView(
  root: string,
  licensePath: string,
  options: { at?: Date } = {},
): LicenseView {
  const assessment = assessLicense(root, licensePath, options);
  if (assessment.kind === 'invalid') {
    return {
      status: 'invalid',
      days_remaining: null,
      warning: null,
      error_code: assessment.code,
      message: assessment.message,
    };
  }
  const payload = assessment.license.payload;
  return {
    status: assessment.kind,
    license_id: payload.license_id,
    not_before: payload.not_before,
    expires_at: payload.expires_at,
    highest_eligible_release: payload.highest_eligible_release,
    days_remaining: assessment.days_remaining,
    warning: assessment.kind === 'valid' ? assessment.warning : null,
  };
}

/** The strict license summary used where a current entitlement is required. */
export function readLicenseSummary(root: string, licensePath: string): LicenseSummary {
  const license = validateLicense(root, licensePath);
  return {
    license_id: license.payload.license_id,
    not_before: license.payload.not_before,
    expires_at: license.payload.expires_at,
    highest_eligible_release: license.payload.highest_eligible_release,
  };
}

function currentLicenseIdentity(root: string): LicenseSummary | null {
  try {
    const license = readJsonFile<SignedLicense>(join(root, 'license.json'));
    const payload = license?.payload;
    if (payload === null || typeof payload !== 'object' || typeof payload.license_id !== 'string') return null;
    return {
      license_id: payload.license_id,
      not_before: payload.not_before,
      expires_at: payload.expires_at,
      highest_eligible_release: payload.highest_eligible_release,
    };
  } catch {
    return null;
  }
}

function readLicenseHistory(root: string): LicenseHistory {
  const path = join(root, 'license-history.json');
  if (!existsSync(path)) return { schema_version: 1, entries: [] };
  try {
    const stored = readJsonFile<LicenseHistory>(path);
    return Array.isArray(stored.entries)
      ? { schema_version: 1, entries: stored.entries }
      : { schema_version: 1, entries: [] };
  } catch {
    return { schema_version: 1, entries: [] };
  }
}

/**
 * Imports one offline-signed Deployment License. A Deployment that is already
 * open renews in place: the new entitlement is validated before anything is
 * written, the replaced license joins the license history, and business data,
 * sessions, and the logical Deployment identity are untouched. A renewal that
 * cannot be validated leaves the current license exactly as it was.
 */
export function importLicense(options: {
  root: string;
  license: string;
  operator: string;
}): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const assessment = assessLicense(options.root, options.license);
  if (assessment.kind === 'invalid') {
    throw new OperatorError(assessment.code, assessment.message, assessment.nextStep);
  }
  if (assessment.kind === 'expired') {
    throw new OperatorError(
      'LICENSE_EXPIRED',
      'The imported Deployment License has already expired.',
      'Import a currently valid renewal issued for this Deployment.',
    );
  }

  const previous = currentLicenseIdentity(options.root);
  const history = readLicenseHistory(options.root);
  history.entries.push({
    license_id: assessment.license.payload.license_id,
    request_id: assessment.license.payload.request_id,
    not_before: assessment.license.payload.not_before,
    expires_at: assessment.license.payload.expires_at,
    highest_eligible_release: assessment.license.payload.highest_eligible_release,
    imported_at: new Date().toISOString(),
    previous_license_id: previous?.license_id ?? null,
  });
  writeJsonFile(join(options.root, 'license-history.json'), history);
  writeJsonFile(join(options.root, 'license.json'), assessment.license);

  const renewed = deployment.service_open;
  const next = renewed ? deployment : { ...deployment, state: 'ready_to_initialize' };
  if (!renewed) writeDeployment(options.root, next);
  recordEvidence(options.root, 'import-license', renewed ? 'renewed' : 'ready_to_initialize', options.operator, {
    license_id: assessment.license.payload.license_id,
    previous_license_id: previous?.license_id ?? null,
    not_before: assessment.license.payload.not_before,
    expires_at: assessment.license.payload.expires_at,
    highest_eligible_release: assessment.license.payload.highest_eligible_release,
    warning: assessment.warning?.level ?? null,
  });
  return {
    state: next.state,
    license_id: assessment.license.payload.license_id,
    previous_license_id: previous?.license_id ?? null,
    renewed,
    service_open: renewed,
    warning: assessment.warning,
    license_history: history.entries.map((entry) => entry.license_id),
  };
}
