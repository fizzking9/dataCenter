import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundleFixture, type BundleFixture } from './bundle.js';
import { fakeDockerEnvironment } from './fake-docker.js';
import { issueLicense } from './license.js';
import { runOperator, type OperatorResult } from './operator.js';
import { totpCode } from './totp.js';

export interface AdministratorCredentials {
  username: string;
  password: string;
  totp_secret: string;
  recovery_codes: string[];
}

export interface PlatformFixture {
  root: string;
  masterKey: string;
  docker: NodeJS.ProcessEnv;
  scratch: string;
  /** The installed Release Bundle, so a test can sign a chained upgrade bundle. */
  bundle: BundleFixture;
  administrator: AdministratorCredentials;
}

export interface CommandOptions {
  input?: string;
  token?: string;
}

const enrolmentSecrets = new Map<string, string>();

/** Records the enrollment secret returned once when an administrator is enrolled. */
export function registerTotp(fixture: PlatformFixture, username: string, secret: unknown): void {
  if (typeof secret === 'string') enrolmentSecrets.set(`${fixture.root}|${username}`, secret);
}

/** The enrollment secret an administrator received, which a browser sign-in needs. */
export function totpSecretFor(fixture: PlatformFixture, username: string): string {
  const secret = enrolmentSecrets.get(`${fixture.root}|${username}`);
  if (secret === undefined) throw new Error(`no enrollment secret recorded for ${username}`);
  return secret;
}

/**
 * Installs, licenses, and initializes a Deployment through the Operator
 * lifecycle commands, leaving one bootstrapped Deployment Administrator.
 */
export function initializePlatform(
  options: { administratorPassword?: string; highestEligibleRelease?: string } = {},
): PlatformFixture {
  const scratch = mkdtempSync(join(tmpdir(), 'dc-platform-'));
  const bundle = createBundleFixture(scratch);
  const root = join(scratch, 'deployment');
  const docker = fakeDockerEnvironment(scratch);
  const masterKey = join(scratch, 'mounted-master-key');
  writeFileSync(masterKey, randomBytes(32), { mode: 0o600 });

  const installed = runOperator([
    'install', '--bundle', bundle.directory, '--root', root,
    '--release-key', bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', bundle.releaseFingerprint,
    '--operator', 'certification@example.invalid',
  ]);
  if (installed.status !== 0) {
    throw new Error(`install failed: ${installed.stderr}`);
  }
  const request = JSON.parse(readFileSync(String(installed.output.license_request), 'utf8')) as {
    request_id: string;
    deployment_id: string;
    release: string;
  };
  const licensePath = join(scratch, 'deployment-license.json');
  issueLicense(licensePath, bundle, request, {
    ...(options.highestEligibleRelease === undefined ? {} : { highestEligibleRelease: options.highestEligibleRelease }),
  });
  const imported = runOperator(['import-license', '--root', root, '--license', licensePath, '--operator', 'certification@example.invalid']);
  if (imported.status !== 0) {
    throw new Error(`import-license failed: ${imported.stderr}`);
  }

  const password = options.administratorPassword ?? 'bootstrap-administrator-password';
  const initialized = runOperator([
    'initialize', '--root', root, '--master-key', masterKey,
    '--admin-username', 'bootstrap@example.invalid', '--admin-password-stdin',
    '--operator', 'certification@example.invalid',
  ], { input: `${password}\n`, env: docker });
  if (initialized.status !== 0) {
    throw new Error(`initialize failed: ${initialized.stderr}`);
  }
  const fixture: PlatformFixture = {
    root,
    masterKey,
    docker,
    scratch,
    bundle,
    administrator: {
      username: String(initialized.output.admin_username ?? 'bootstrap@example.invalid'),
      password,
      totp_secret: String(initialized.output.totp_secret),
      recovery_codes: initialized.output.recovery_codes as string[],
    },
  };
  registerTotp(fixture, fixture.administrator.username, fixture.administrator.totp_secret);
  return fixture;
}

/** Runs one governed command against the installed Deployment. */
export function command(
  fixture: PlatformFixture,
  args: string[],
  options: CommandOptions = {},
): OperatorResult {
  const full = [...args, '--root', fixture.root, '--master-key', fixture.masterKey];
  if (options.token) full.push('--session-token', options.token);
  return runOperator(full, {
    ...(options.input === undefined ? {} : { input: options.input }),
    env: fixture.docker,
  });
}

/**
 * Authenticates a User. Administrators were enrolled at provisioning time, so
 * their enrollment secret is already recorded; ordinary Users authenticate with
 * a password alone.
 */
export function signIn(fixture: PlatformFixture, username: string, password: string): OperatorResult {
  const secret = enrolmentSecrets.get(`${fixture.root}|${username}`);
  return command(
    fixture,
    ['login', '--username', username, '--password-stdin', ...(secret === undefined ? [] : ['--totp', totpCode(secret)])],
    { input: `${password}\n` },
  );
}

/** Logs in and returns the issued session token. */
export function sessionFor(fixture: PlatformFixture, username: string, password: string): string {
  const result = signIn(fixture, username, password);
  if (result.status !== 0) {
    throw new Error(`login failed for ${username}: ${result.stderr}`);
  }
  return String(result.output.session_token);
}

/** Creates a User, optionally with the Deployment Administrator Role. */
export function createUser(
  fixture: PlatformFixture,
  administratorToken: string,
  username: string,
  password: string,
  deploymentAdministrator = false,
): OperatorResult {
  const result = command(
    fixture,
    [
      'user', 'create', '--username', username, '--password-stdin',
      ...(deploymentAdministrator ? ['--deployment-administrator'] : []),
    ],
    { token: administratorToken, input: `${password}\n` },
  );
  if (result.status !== 0) {
    throw new Error(`user create failed for ${username}: ${result.stderr}`);
  }
  registerTotp(fixture, username, result.output['totp_secret']);
  return result;
}

/** Creates a Workspace whose only Workspace Administrator is the named User. */
export function createWorkspace(
  fixture: PlatformFixture,
  administratorToken: string,
  name: string,
  administrator: string,
): string {
  const result = command(
    fixture,
    ['workspace', 'create', '--name', name, '--administrator', administrator],
    { token: administratorToken },
  );
  if (result.status !== 0) {
    throw new Error(`workspace create failed for ${name}: ${result.stderr}`);
  }
  registerTotp(fixture, administrator, result.output['totp_secret']);
  return String(result.output.workspace_id);
}

/** Writes a Business Context entry snapshot and returns its path. */
export function contextEntries(fixture: PlatformFixture, name: string, entries: unknown[]): string {
  return jsonFile(fixture, name, entries);
}

/** Writes a JSON document the commands read, and returns its path. */
export function jsonFile(fixture: PlatformFixture, name: string, value: unknown): string {
  const path = join(fixture.scratch, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** Writes a byte-exact fixture file, and returns its path. */
export function textFile(fixture: PlatformFixture, name: string, content: string): string {
  const path = join(fixture.scratch, name);
  writeFileSync(path, content);
  return path;
}

/** Grants an existing User one Workspace-scoped Role. */
export function grantRole(
  fixture: PlatformFixture,
  token: string,
  workspaceId: string,
  username: string,
  role: 'Workspace Administrator' | 'Consumer',
): void {
  const result = command(
    fixture,
    ['membership', 'grant', '--workspace', workspaceId, '--username', username, '--role', role],
    { token },
  );
  if (result.status !== 0) {
    throw new Error(`membership grant failed for ${username}: ${result.stderr}`);
  }
  registerTotp(fixture, username, result.output['totp_secret']);
}

export interface WorkspaceFixture {
  fixture: PlatformFixture;
  workspaceId: string;
  deploymentAdministratorToken: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
}

/**
 * One Workspace holding a Workspace Administrator and a Consumer, which is the
 * shape every governed Workspace Artifact lifecycle needs.
 */
export function workspaceFixture(
  options: { highestEligibleRelease?: string } = {},
): WorkspaceFixture {
  const fixture = initializePlatform(options);
  const deploymentAdministratorToken = sessionFor(
    fixture,
    fixture.administrator.username,
    fixture.administrator.password,
  );
  createUser(fixture, deploymentAdministratorToken, 'operations@example.invalid', 'operations-administrator');
  const workspaceId = createWorkspace(fixture, deploymentAdministratorToken, 'Operations', 'operations@example.invalid');
  const workspaceAdministratorToken = sessionFor(fixture, 'operations@example.invalid', 'operations-administrator');
  createUser(fixture, deploymentAdministratorToken, 'analyst@example.invalid', 'analyst-consumer');
  grantRole(fixture, workspaceAdministratorToken, workspaceId, 'analyst@example.invalid', 'Consumer');
  const consumerToken = sessionFor(fixture, 'analyst@example.invalid', 'analyst-consumer');
  return { fixture, workspaceId, deploymentAdministratorToken, workspaceAdministratorToken, consumerToken };
}
