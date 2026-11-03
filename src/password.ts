import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

const PARAMETERS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65_536,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), ...PARAMETERS, outputType: 'encoded' });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2Verify({ password, hash });
}

let decoyHash: string | undefined;

/**
 * Spends the same work as a real verification so an unknown username does not
 * answer faster than a known one.
 */
export async function verifyUnusablePassword(password: string): Promise<void> {
  decoyHash ??= await argon2id({ password, salt: randomBytes(16), ...PARAMETERS, outputType: 'encoded' });
  await argon2Verify({ password, hash: decoyHash });
}
