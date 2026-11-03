#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadAcquisition } from './acquisition.js';
import { listAuditEvents } from './audit-view.js';
import { login, logout } from './auth.js';
import { issueOperatorEnrollment, revokeOperator, revokeOperatorEnrollment } from './operators.js';
import { startConsoleServer } from './console-server.js';
import { publishCommonContext, publishWorkspaceContext, showContext } from './context.js';
import { releaseDataset, showDataset } from './datasets.js';
import { OperatorError } from './errors.js';
import { initializeDeployment } from './initialize.js';
import { installDeployment } from './install.js';
import { adoptIntegrationConfiguration, publishIntegrationConfiguration } from './integration.js';
import { importLicense, readLicenseSummary } from './license.js';
import { queryDataProduct } from './product-query.js';
import { listDataProducts, publishDataProduct } from './products.js';
import { createSource } from './sources.js';
import { deploymentStatus } from './status.js';
import { readDeployment } from './state.js';
import { createUser, deactivateUser, listUsers, transferOwnership } from './users.js';
import { createWorkspace, grantMembership, listWorkspaces, revokeMembership } from './workspaces.js';

const GROUPED_COMMANDS = new Set([
  'user', 'workspace', 'membership', 'ownership', 'context', 'audit',
  'source', 'integration', 'acquisition', 'dataset', 'product', 'console',
]);
const BOOLEAN_FLAGS = new Set(['admin-password-stdin', 'password-stdin', 'deployment-administrator']);

interface Invocation {
  command: string;
  subcommand?: string;
  options: Map<string, string>;
}

function parseArguments(args: string[]): Invocation {
  const [command, ...rest] = args;
  if (!command) {
    throw new Error('A lifecycle command is required.');
  }
  const grouped = GROUPED_COMMANDS.has(command);
  const subcommand = grouped ? rest[0] : undefined;
  if (grouped && (!subcommand || subcommand.startsWith('--'))) {
    throw new Error(`${command} requires a subcommand.`);
  }
  const options = new Map<string, string>();
  for (let index = grouped ? 1 : 0; index < rest.length;) {
    const name = rest[index];
    if (!name?.startsWith('--')) {
      throw new Error(`Invalid arguments for ${[command, subcommand].filter(Boolean).join(' ')}.`);
    }
    const option = name.slice(2);
    if (BOOLEAN_FLAGS.has(option)) {
      options.set(option, 'true');
      index += 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`--${option} requires a value.`);
    }
    options.set(option, value);
    index += 2;
  }
  return subcommand === undefined ? { command, options } : { command, subcommand, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function assertStdinFlag(options: Map<string, string>, flag: string): void {
  if (options.get(flag) !== 'true') {
    throw new Error(`--${flag} is required; passwords are not accepted as command arguments.`);
  }
}

function readStdin(): string {
  return readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
}

function emit(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Every governed command states the same Deployment, key, and session. */
function governed(options: Map<string, string>) {
  return {
    root: required(options, 'root'),
    masterKey: required(options, 'master-key'),
    token: required(options, 'session-token'),
  };
}

async function main(): Promise<void> {
  const { command, subcommand, options } = parseArguments(process.argv.slice(2));
  if (command === 'install') {
    emit(installDeployment({
      bundle: required(options, 'bundle'),
      root: required(options, 'root'),
      releaseKey: required(options, 'release-key'),
      confirmedFingerprint: required(options, 'confirm-release-key-fingerprint'),
      operator: required(options, 'operator'),
    }));
    return;
  }
  if (command === 'initialize') {
    assertStdinFlag(options, 'admin-password-stdin');
    emit(await initializeDeployment({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      adminUsername: required(options, 'admin-username'),
      adminPassword: readStdin(),
      operator: required(options, 'operator'),
    }));
    return;
  }
  if (command === 'status') {
    emit(deploymentStatus({
      root: required(options, 'root'),
      ...(options.has('master-key') ? { masterKey: required(options, 'master-key') } : {}),
      operator: required(options, 'operator'),
    }));
    return;
  }
  if (command === 'import-license') {
    emit(importLicense({
      root: required(options, 'root'),
      license: required(options, 'license'),
      operator: required(options, 'operator'),
    }));
    return;
  }
  if (command === 'login') {
    assertStdinFlag(options, 'password-stdin');
    emit(await login({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      username: required(options, 'username'),
      password: readStdin(),
      ...(options.has('totp') ? { totp: required(options, 'totp') } : {}),
      ...(options.has('recovery-code') ? { recoveryCode: required(options, 'recovery-code') } : {}),
    }));
    return;
  }
  if (command === 'logout') {
    emit(logout({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      token: required(options, 'session-token'),
    }));
    return;
  }
  if (command === 'user' && subcommand === 'create') {
    assertStdinFlag(options, 'password-stdin');
    emit(await createUser({
      ...governed(options),
      username: required(options, 'username'),
      password: readStdin(),
      deploymentAdministrator: options.get('deployment-administrator') === 'true',
    }));
    return;
  }
  if (command === 'user' && subcommand === 'list') {
    emit(listUsers(governed(options)));
    return;
  }
  if (command === 'user' && subcommand === 'deactivate') {
    emit(deactivateUser({ ...governed(options), username: required(options, 'username') }));
    return;
  }
  if (command === 'ownership' && subcommand === 'transfer') {
    emit(transferOwnership({
      ...governed(options),
      from: required(options, 'from'),
      to: required(options, 'to'),
    }));
    return;
  }
  if (command === 'workspace' && subcommand === 'list') {
    emit(listWorkspaces(governed(options)));
    return;
  }
  if (command === 'workspace' && subcommand === 'create') {
    emit(createWorkspace({
      ...governed(options),
      name: required(options, 'name'),
      administrator: required(options, 'administrator'),
    }));
    return;
  }
  if (command === 'membership' && subcommand === 'grant') {
    emit(grantMembership({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      username: required(options, 'username'),
      role: required(options, 'role'),
    }));
    return;
  }
  if (command === 'membership' && subcommand === 'revoke') {
    emit(revokeMembership({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      username: required(options, 'username'),
    }));
    return;
  }
  if (command === 'context' && subcommand === 'publish-common') {
    emit(publishCommonContext({ ...governed(options), entriesPath: required(options, 'entries') }));
    return;
  }
  if (command === 'context' && subcommand === 'publish-workspace') {
    emit(publishWorkspaceContext({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      entriesPath: required(options, 'entries'),
    }));
    return;
  }
  if (command === 'context' && subcommand === 'show') {
    emit(showContext({
      ...governed(options),
      ...(options.has('workspace') ? { workspaceId: required(options, 'workspace') } : {}),
      ...(options.has('version') ? { version: Number(required(options, 'version')) } : {}),
    }));
    return;
  }
  if (command === 'audit' && subcommand === 'list') {
    emit(listAuditEvents({
      ...governed(options),
      ...(options.has('workspace') ? { workspaceId: required(options, 'workspace') } : {}),
    }));
    return;
  }
  if (command === 'source' && subcommand === 'create') {
    emit(createSource({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      name: required(options, 'name'),
      type: required(options, 'type'),
    }));
    return;
  }
  if (command === 'integration' && subcommand === 'publish') {
    emit(publishIntegrationConfiguration({
      ...governed(options),
      sourceId: required(options, 'source'),
      configPath: required(options, 'config'),
    }));
    return;
  }
  if (command === 'integration' && subcommand === 'adopt') {
    emit(adoptIntegrationConfiguration({
      ...governed(options),
      sourceId: required(options, 'source'),
      version: Number(required(options, 'version')),
    }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'upload') {
    emit(uploadAcquisition({
      ...governed(options),
      sourceId: required(options, 'source'),
      file: required(options, 'file'),
    }));
    return;
  }
  if (command === 'dataset' && subcommand === 'release') {
    emit(releaseDataset({ ...governed(options), sourceId: required(options, 'source') }));
    return;
  }
  if (command === 'dataset' && subcommand === 'show') {
    emit(showDataset({
      ...governed(options),
      sourceId: required(options, 'source'),
      ...(options.has('release') ? { release: Number(required(options, 'release')) } : {}),
    }));
    return;
  }
  if (command === 'product' && subcommand === 'publish') {
    emit(publishDataProduct({
      ...governed(options),
      sourceId: required(options, 'source'),
      name: required(options, 'name'),
      contractPath: required(options, 'contract'),
    }));
    return;
  }
  if (command === 'product' && subcommand === 'list') {
    emit(listDataProducts({ ...governed(options), workspaceId: required(options, 'workspace') }));
    return;
  }
  if (command === 'product' && subcommand === 'query') {
    emit(queryDataProduct({
      ...governed(options),
      dataProductId: required(options, 'product'),
      requestPath: required(options, 'request'),
    }));
    return;
  }
  if (command === 'console' && subcommand === 'serve') {
    const port = Number(required(options, 'port'));
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error('--port must be a whole number from 0 to 65535.');
    }
    const started = await startConsoleServer({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      port,
    });
    emit({ listening: true, url: started.url, port: started.port });
    return;
  }
  if (command === 'console' && subcommand === 'license') {
    const root = required(options, 'root');
    const deployment = readDeployment(root);
    emit({
      ...readLicenseSummary(root, join(root, 'license.json')),
      release: deployment.release,
      deployment_id: deployment.deployment_id,
      state: deployment.state,
    });
    return;
  }
  if (command === 'console' && subcommand === 'enroll') {
    emit(issueOperatorEnrollment({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      operator: required(options, 'operator'),
      ...(options.has('ttl-minutes') ? { ttlMinutes: Number(required(options, 'ttl-minutes')) } : {}),
    }));
    return;
  }
  if (command === 'console' && subcommand === 'revoke-enrollment') {
    emit(revokeOperatorEnrollment({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      enrollmentId: required(options, 'enrollment'),
    }));
    return;
  }
  if (command === 'console' && subcommand === 'revoke') {
    emit(revokeOperator({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      operator: required(options, 'operator'),
    }));
    return;
  }
  throw new Error(`Unsupported lifecycle command: ${[command, subcommand].filter(Boolean).join(' ')}.`);
}

main().then(() => {
  process.exitCode = 0;
}).catch((error: unknown) => {
  if (error instanceof OperatorError) {
    process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message, next_step: error.nextStep })}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${JSON.stringify({ code: 'INVALID_COMMAND', message: error instanceof Error ? error.message : 'The command failed.' })}\n`);
  process.exitCode = 2;
});
