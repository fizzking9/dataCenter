import { createHmac } from 'node:crypto';
import { encryptSecret, type WrappedValue } from './keys.js';
import { newRecoveryCode, newTotpSecret } from './totp.js';

const RECOVERY_CODE_COUNT = 8;

/** The MFA credentials every human identity may hold, at Deployment or Console scope. */
export interface MfaRecord {
  type: 'TOTP';
  secret: WrappedValue;
  recovery_codes: string[];
}

export interface Enrollment {
  mfa: MfaRecord;
  secrets: {
    totp_secret: string;
    recovery_codes: string[];
    enrollment_uri: string;
  };
}

/** Single-use recovery codes are only ever stored as keyed hashes. */
export function recoveryCodeHash(dataKey: Buffer, code: string): string {
  return createHmac('sha256', dataKey).update(code.trim().toUpperCase()).digest('hex');
}

/**
 * Enrols any identity for mandatory TOTP MFA. The plaintext secret and the
 * recovery codes are returned exactly once, at provisioning time.
 */
export function enrolMfa(username: string, dataKey: Buffer): Enrollment {
  const totpSecret = newTotpSecret();
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  return {
    mfa: {
      type: 'TOTP',
      secret: encryptSecret(dataKey, totpSecret),
      recovery_codes: recoveryCodes.map((code) => recoveryCodeHash(dataKey, code)),
    },
    secrets: {
      totp_secret: totpSecret,
      recovery_codes: recoveryCodes,
      enrollment_uri: `otpauth://totp/DataCenter:${encodeURIComponent(username)}?secret=${totpSecret}&issuer=DataCenter`,
    },
  };
}
