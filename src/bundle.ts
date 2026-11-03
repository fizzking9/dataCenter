import { verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';
import { canonicalJson, keyFingerprint, publicKeyFromFile, sha256File } from './crypto.js';
import { assertCondition } from './errors.js';

interface ManifestFile {
  path: string;
  sha256: string;
}

export interface ReleaseManifest {
  schema_version: number;
  release: string;
  architecture: string;
  support: {
    installable: boolean;
    host_platforms: string[];
  };
  license_verification: {
    key_id: string;
    public_key_pem: string;
  };
  files: ManifestFile[];
  images: Array<{
    name: string;
    archive: string;
    digest: string;
  }>;
}

export interface VerifiedBundle {
  directory: string;
  manifest: ReleaseManifest;
  releaseFingerprint: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function safePayloadPath(bundle: string, candidate: string): string {
  assertCondition(candidate && !isAbsolute(candidate) && !candidate.includes('\\'), 'BUNDLE_PATH_INVALID', 'The Release Bundle contains an unsafe payload path.');
  const normalized = posix.normalize(candidate);
  assertCondition(normalized === candidate && candidate !== '..' && !candidate.startsWith('../'), 'BUNDLE_PATH_INVALID', 'The Release Bundle contains an unsafe payload path.');
  const path = resolve(bundle, ...candidate.split('/'));
  const bundlePrefix = `${resolve(bundle)}${sep}`;
  assertCondition(path.startsWith(bundlePrefix), 'BUNDLE_PATH_INVALID', 'The Release Bundle payload escapes its directory.');
  assertCondition(existsSync(path), 'BUNDLE_INCOMPLETE', `The Release Bundle payload is missing: ${candidate}.`);
  const stat = lstatSync(path);
  assertCondition(stat.isFile() && !stat.isSymbolicLink(), 'BUNDLE_INCOMPLETE', `The Release Bundle payload is not a regular file: ${candidate}.`);
  assertCondition(realpathSync(path).startsWith(bundlePrefix), 'BUNDLE_PATH_INVALID', 'The Release Bundle payload resolves outside its directory.');
  return path;
}

export function verifyReleaseBundle(
  directory: string,
  releaseKeyPath: string,
  confirmedFingerprint: string,
): VerifiedBundle {
  assertCondition(existsSync(directory) && lstatSync(directory).isDirectory(), 'BUNDLE_NOT_FOUND', 'The Release Bundle does not exist.', 'Supply the complete connected-download or removable-media bundle.');
  const manifestPath = join(directory, 'manifest.json');
  const signaturePath = join(directory, 'manifest.sig');
  assertCondition(existsSync(manifestPath) && existsSync(signaturePath), 'BUNDLE_INCOMPLETE', 'The Release Bundle is missing its manifest or signature.');
  assertCondition(existsSync(releaseKeyPath), 'RELEASE_KEY_NOT_FOUND', 'The trusted release-verification key does not exist.');

  const releaseKey = publicKeyFromFile(releaseKeyPath);
  const releaseFingerprint = keyFingerprint(releaseKey);
  assertCondition(releaseFingerprint === confirmedFingerprint.toLowerCase(), 'RELEASE_KEY_NOT_CONFIRMED', 'The confirmed release-key fingerprint does not match the trusted key.', 'Confirm the fingerprint through an independent vendor channel.');

  const signature = readJson(signaturePath) as { algorithm?: string; key_id?: string; value?: string };
  const manifest = readJson(manifestPath) as ReleaseManifest;
  assertCondition(signature.algorithm === 'Ed25519' && signature.key_id === releaseFingerprint && signature.value, 'BUNDLE_SIGNATURE_INVALID', 'The Release Bundle signature metadata is invalid.');
  assertCondition(verify(null, Buffer.from(canonicalJson(manifest)), releaseKey, Buffer.from(signature.value, 'base64')), 'BUNDLE_SIGNATURE_INVALID', 'The Release Bundle signature verification failed.', 'Obtain an authentic bundle from the vendor.');
  assertCondition(manifest.schema_version === 1 && typeof manifest.release === 'string' && manifest.release.length > 0, 'BUNDLE_UNSUPPORTED', 'The Release Bundle schema or release is unsupported.');
  assertCondition(manifest.architecture === process.arch, 'BUNDLE_ARCHITECTURE_UNSUPPORTED', `The Release Bundle targets ${manifest.architecture}, but this host is ${process.arch}.`);
  assertCondition(manifest.support?.installable === true && manifest.support.host_platforms.includes(process.platform), 'BUNDLE_UNSUPPORTED', 'The Release Bundle does not support installation on this host.');
  assertCondition(manifest.license_verification?.key_id && manifest.license_verification.public_key_pem, 'BUNDLE_INCOMPLETE', 'The Release Bundle has no trusted license-verification key.');
  assertCondition(Array.isArray(manifest.files) && manifest.files.length > 0 && Array.isArray(manifest.images), 'BUNDLE_INCOMPLETE', 'The Release Bundle has no complete payload inventory.');

  const inventory = new Map<string, string>();
  for (const file of manifest.files) {
    assertCondition(!inventory.has(file.path), 'BUNDLE_INCOMPLETE', 'The Release Bundle payload inventory contains duplicates.');
    const payloadPath = safePayloadPath(directory, file.path);
    const digest = sha256File(payloadPath);
    assertCondition(digest === file.sha256, 'BUNDLE_CHECKSUM_INVALID', `The Release Bundle checksum failed for ${file.path}.`, 'Replace the corrupt or incomplete bundle.');
    inventory.set(file.path, digest);
  }
  for (const required of ['compose.yaml', 'sbom.spdx.json', 'third-party-notices.txt']) {
    assertCondition(inventory.has(required), 'BUNDLE_INCOMPLETE', `The Release Bundle is missing ${required}.`);
  }
  assertCondition([...inventory.keys()].some((path) => path.startsWith('embeddings/')), 'BUNDLE_INCOMPLETE', 'The Release Bundle is missing platform-managed embedding assets.');
  for (const image of manifest.images) {
    const digest = inventory.get(image.archive);
    assertCondition(digest && image.digest === `sha256:${digest}`, 'BUNDLE_IMAGE_DIGEST_INVALID', `The image digest does not match its archived payload: ${image.name}.`);
  }
  return { directory, manifest, releaseFingerprint };
}
