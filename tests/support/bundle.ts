import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

export interface BundleFixture {
  directory: string;
  releasePublicKeyPath: string;
  releasePublicKeyPem: string;
  releaseFingerprint: string;
  releasePrivateKey: KeyObject;
  licensePrivateKey: KeyObject;
  licensePublicKeyPem: string;
}

export interface BundleFixtureOptions {
  architecture?: string;
  installable?: boolean;
  release?: string;
  /** Releases this bundle declares it upgrades from, so N -> N+1 has a signed path. */
  upgradeFrom?: string[];
  /** Reuses the installed trust root, so an upgrade bundle chains to the same key. */
  releaseKeys?: { publicKeyPem: string; privateKey: KeyObject };
  /** Reuses the license-verification key the Deployment already trusts. */
  licenseKeys?: { publicKeyPem: string; privateKey: KeyObject };
}

export function createBundleFixture(
  workspace: string,
  options: BundleFixtureOptions = {},
): BundleFixture {
  mkdirSync(workspace, { recursive: true });
  const generatedRelease = options.releaseKeys === undefined ? generateKeyPairSync('ed25519') : undefined;
  const generatedLicense = options.licenseKeys === undefined ? generateKeyPairSync('ed25519') : undefined;
  const releasePrivateKey = options.releaseKeys?.privateKey ?? generatedRelease!.privateKey;
  const licensePrivateKey = options.licenseKeys?.privateKey ?? generatedLicense!.privateKey;
  const directory = join(workspace, 'bundle');
  const releasePublicKeyPath = join(workspace, 'release-key.pem');
  const releasePublicKeyPem = options.releaseKeys?.publicKeyPem
    ?? generatedRelease!.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const licensePublicKeyPem = options.licenseKeys?.publicKeyPem
    ?? generatedLicense!.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(releasePublicKeyPath, releasePublicKeyPem, { mode: 0o600 });

  const payload: Record<string, string> = {
    'compose.yaml': [
      'services:',
      '  postgres:',
      '    image: localhost/datacenter-postgres:0.1.0',
      '  minio:',
      '    image: localhost/datacenter-minio:0.1.0',
      '',
    ].join('\n'),
    'images/postgres.tar': 'postgres image archive fixture',
    'images/minio.tar': 'minio image archive fixture',
    'sbom.spdx.json': '{"spdxVersion":"SPDX-2.3","name":"datacenter-certification"}\n',
    'third-party-notices.txt': 'Certification fixture notices.\n',
    'embeddings/model.json': '{"model":"bundled-local-embeddings","version":"1"}\n',
  };
  for (const [path, content] of Object.entries(payload)) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: 0o600 });
  }
  const files = Object.keys(payload).sort().map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(join(directory, path))).digest('hex'),
  }));
  const release = options.release ?? '0.1.0';
  const manifest = {
    schema_version: 1,
    release,
    architecture: options.architecture ?? process.arch,
    support: {
      installable: options.installable ?? true,
      host_platforms: ['linux', 'win32'],
    },
    compatibility: {
      upgrade_from: options.upgradeFrom ?? [],
    },
    license_verification: {
      key_id: 'license-certification-key',
      public_key_pem: licensePublicKeyPem,
    },
    files,
    images: [
      { name: `localhost/datacenter-postgres:${release}`, archive: 'images/postgres.tar', digest: `sha256:${files.find((file) => file.path === 'images/postgres.tar')?.sha256}` },
      { name: `localhost/datacenter-minio:${release}`, archive: 'images/minio.tar', digest: `sha256:${files.find((file) => file.path === 'images/minio.tar')?.sha256}` },
    ],
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  const signature = sign(null, manifestBytes, releasePrivateKey).toString('base64');
  const der = createPublicKey(releasePublicKeyPem).export({ type: 'spki', format: 'der' });
  const releaseFingerprint = createHash('sha256').update(der).digest('hex');
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'manifest.sig'), `${JSON.stringify({ algorithm: 'Ed25519', key_id: releaseFingerprint, value: signature })}\n`);
  return {
    directory,
    releasePublicKeyPath,
    releasePublicKeyPem,
    releaseFingerprint,
    releasePrivateKey,
    licensePrivateKey,
    licensePublicKeyPem,
  };
}
