import { sign, verify, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest, canonicalJson, keyFingerprint, publicKeyFromFile } from '../../src/crypto.js';

/**
 * A release certification manifest is a signed, canonical fact set. It is
 * written beside a detached signature so a handoff reviewer can verify the
 * exact bytes with the same release key that signed the Release Bundle.
 */
export interface EvidenceSignature {
  algorithm: 'Ed25519';
  key_id: string;
  value: string;
}

export interface WrittenEvidence {
  manifestPath: string;
  signaturePath: string;
  digest: string;
  signature: EvidenceSignature;
}

export interface EvidenceVerification {
  valid: boolean;
  digest: string | null;
  reason: string | null;
}

/** Sorts every object key, so the same evidence always serializes to the same bytes. */
function canonicalObject(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

/** Writes the canonical manifest and its Ed25519 signature under one directory. */
export function writeEvidenceManifest(options: {
  directory: string;
  body: Record<string, unknown>;
  privateKey: KeyObject;
  keyId: string;
}): WrittenEvidence {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const canonical = canonicalJson(options.body);
  const signature: EvidenceSignature = {
    algorithm: 'Ed25519',
    key_id: options.keyId,
    value: sign(null, Buffer.from(canonical), options.privateKey).toString('base64'),
  };
  const manifestPath = join(options.directory, 'evidence.json');
  const signaturePath = join(options.directory, 'evidence.sig');
  writeFileSync(manifestPath, `${JSON.stringify(canonicalObject(options.body), null, 2)}\n`, { mode: 0o600 });
  writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`, { mode: 0o600 });
  return { manifestPath, signaturePath, digest: canonicalDigest(options.body), signature };
}

/**
 * Verifies a manifest against a trusted release public key. A missing, altered,
 * or foreign-key signature is reported as invalid, never treated as unsigned.
 */
export function verifyEvidenceManifest(options: {
  manifestPath: string;
  signaturePath: string;
  publicKeyPath: string;
}): EvidenceVerification {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(options.manifestPath, 'utf8')) as unknown;
  } catch {
    return { valid: false, digest: null, reason: 'EVIDENCE_MALFORMED' };
  }
  let signature: Partial<EvidenceSignature>;
  try {
    signature = JSON.parse(readFileSync(options.signaturePath, 'utf8')) as Partial<EvidenceSignature>;
  } catch {
    return { valid: false, digest: null, reason: 'EVIDENCE_MALFORMED' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, digest: null, reason: 'EVIDENCE_MALFORMED' };
  }
  if (signature.algorithm !== 'Ed25519' || typeof signature.value !== 'string' || typeof signature.key_id !== 'string') {
    return { valid: false, digest: null, reason: 'EVIDENCE_MALFORMED' };
  }
  const releaseKey = publicKeyFromFile(options.publicKeyPath);
  if (keyFingerprint(releaseKey) !== signature.key_id.toLowerCase()) {
    return { valid: false, digest: null, reason: 'EVIDENCE_SIGNATURE_INVALID' };
  }
  const canonical = canonicalJson(body);
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonical), releaseKey, Buffer.from(signature.value, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { valid: false, digest: null, reason: 'EVIDENCE_SIGNATURE_INVALID' };
  return { valid: true, digest: canonicalDigest(body), reason: null };
}

/** Every manifest key that carries a wall-clock instant, so only generated_at may vary. */
export function timestampKeys(value: unknown, path = ''): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => found.push(...timestampKeys(entry, `${path}[${String(index)}]`)));
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (/(^|_)(at|time|timestamp)$/u.test(key) || /_(at|time)$/u.test(key)) found.push(here);
    found.push(...timestampKeys(entry, here));
  }
  return found;
}
