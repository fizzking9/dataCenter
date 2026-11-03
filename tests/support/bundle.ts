import {
  createHash,
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
  releaseFingerprint: string;
  releasePrivateKey: KeyObject;
  licensePrivateKey: KeyObject;
  licensePublicKeyPem: string;
}

export function createBundleFixture(
  workspace: string,
  options: { architecture?: string; installable?: boolean; release?: string } = {},
): BundleFixture {
  mkdirSync(workspace, { recursive: true });
  const releaseKeys = generateKeyPairSync('ed25519');
  const licenseKeys = generateKeyPairSync('ed25519');
  const directory = join(workspace, 'bundle');
  const releasePublicKeyPath = join(workspace, 'release-key.pem');
  const releasePublicKeyPem = releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const licensePublicKeyPem = licenseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
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
  const manifest = {
    schema_version: 1,
    release: options.release ?? '0.1.0',
    architecture: options.architecture ?? process.arch,
    support: {
      installable: options.installable ?? true,
      host_platforms: ['linux', 'win32'],
    },
    license_verification: {
      key_id: 'license-certification-key',
      public_key_pem: licensePublicKeyPem,
    },
    files,
    images: [
      { name: 'localhost/datacenter-postgres:0.1.0', archive: 'images/postgres.tar', digest: `sha256:${files.find((file) => file.path === 'images/postgres.tar')?.sha256}` },
      { name: 'localhost/datacenter-minio:0.1.0', archive: 'images/minio.tar', digest: `sha256:${files.find((file) => file.path === 'images/minio.tar')?.sha256}` },
    ],
  };
  const manifestBytes = Buffer.from(canonical(manifest));
  const signature = sign(null, manifestBytes, releaseKeys.privateKey).toString('base64');
  const der = releaseKeys.publicKey.export({ type: 'spki', format: 'der' });
  const releaseFingerprint = createHash('sha256').update(der).digest('hex');
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'manifest.sig'), `${JSON.stringify({ algorithm: 'Ed25519', key_id: releaseFingerprint, value: signature })}\n`);
  return {
    directory,
    releasePublicKeyPath,
    releaseFingerprint,
    releasePrivateKey: releaseKeys.privateKey,
    licensePrivateKey: licenseKeys.privateKey,
    licensePublicKeyPem,
  };
}
