import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { argon2id } from 'hash-wasm';
import { assertCondition } from './errors.js';
import { encryptSecret } from './keys.js';
import { writeJsonFile } from './state.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(value: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let output = '';
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(accumulator << (5 - bits)) & 31];
  return output;
}

export interface BootstrapSecrets {
  totp_secret: string;
  recovery_codes: string[];
  enrollment_uri: string;
}

export async function bootstrapAdministrator(
  root: string,
  username: string,
  password: string,
  dataKey: Buffer,
): Promise<BootstrapSecrets> {
  assertCondition(username.length >= 3 && username.length <= 254 && !/[\s\\/\0]/.test(username), 'ADMIN_USERNAME_INVALID', 'The initial administrator username is invalid.');
  assertCondition(password.length >= 12 && password.length <= 1024, 'ADMIN_PASSWORD_INVALID', 'The initial administrator password must contain 12 to 1024 characters.');
  const passwordHash = await argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 3,
    memorySize: 65_536,
    hashLength: 32,
    outputType: 'encoded',
  });
  const totpSecret = base32(randomBytes(20));
  const recoveryCodes = Array.from({ length: 8 }, () => `${base32(randomBytes(5))}-${base32(randomBytes(5))}`);
  mkdirSync(join(root, 'config'), { recursive: true, mode: 0o700 });
  writeJsonFile(join(root, 'config', 'admin.json'), {
    schema_version: 1,
    username,
    role: 'Deployment Administrator',
    password_hash: passwordHash,
    mfa: {
      type: 'TOTP',
      secret: encryptSecret(dataKey, totpSecret),
      recovery_codes: recoveryCodes.map((code) => createHmac('sha256', dataKey).update(code).digest('hex')),
    },
    default_credentials: false,
  });
  return {
    totp_secret: totpSecret,
    recovery_codes: recoveryCodes,
    enrollment_uri: `otpauth://totp/DataCenter:${encodeURIComponent(username)}?secret=${totpSecret}&issuer=DataCenter`,
  };
}
