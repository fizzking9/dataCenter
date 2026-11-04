import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SealedSecret } from './catalog.js';
import { assertCondition } from './errors.js';

/** An encrypted value is the domain's sealed secret, produced and opened here only. */
export type WrappedValue = SealedSecret;

export interface WrappedDataKey extends WrappedValue {
  master_key_fingerprint: string;
}

export function readMountedMasterKey(root: string, path: string): Buffer {
  const resolvedRoot = resolve(root);
  const resolvedKey = resolve(path);
  const relation = relative(resolvedRoot, resolvedKey);
  assertCondition(relation.startsWith('..') || isAbsolute(relation), 'MASTER_KEY_INSIDE_DEPLOYMENT', 'The master key must remain outside the Deployment and its primary stores.');
  assertCondition(existsSync(resolvedKey), 'MASTER_KEY_NOT_FOUND', 'The mounted master key does not exist.');
  const content = readFileSync(resolvedKey);
  if (content.length === 32) return content;
  const text = content.toString('utf8').trim();
  const decoded = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  assertCondition(decoded.length === 32, 'MASTER_KEY_INVALID', 'The master key must contain exactly 32 bytes.');
  return decoded;
}

/** Encrypts governed bytes under the Deployment data key, so no plaintext is ever stored. */
export function encryptValue(key: Buffer, plaintext: Buffer): WrappedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decrypt(key: Buffer, value: WrappedValue): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
}

/** Seals one textual secret under the Deployment data key, as a credential is stored. */
export function encryptSecret(dataKey: Buffer, value: string): WrappedValue {
  return encryptValue(dataKey, Buffer.from(value, 'utf8'));
}

export function wrapNewDataKey(masterKey: Buffer): { dataKey: Buffer; wrapped: WrappedDataKey } {
  const dataKey = randomBytes(32);
  return {
    dataKey,
    wrapped: {
      ...encryptValue(masterKey, dataKey),
      master_key_fingerprint: createHash('sha256').update(masterKey).digest('hex'),
    },
  };
}

export function unwrapDataKey(masterKey: Buffer, wrapped: WrappedDataKey): Buffer {
  assertCondition(createHash('sha256').update(masterKey).digest('hex') === wrapped.master_key_fingerprint, 'MASTER_KEY_MISMATCH', 'The mounted master key does not match this Deployment.');
  return decrypt(masterKey, wrapped);
}
