#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { OperatorError } from './errors.js';
import { initializeDeployment } from './initialize.js';
import { installDeployment } from './install.js';
import { importLicense } from './license.js';
import { deploymentStatus } from './status.js';

function parseArguments(args: string[]): { command: string; options: Map<string, string> } {
  const [command, ...rest] = args;
  if (!command) {
    throw new Error('A lifecycle command is required.');
  }
  const options = new Map<string, string>();
  const flags = new Set(['admin-password-stdin']);
  for (let index = 0; index < rest.length;) {
    const name = rest[index];
    if (!name?.startsWith('--')) {
      throw new Error(`Invalid arguments for ${command}.`);
    }
    const option = name.slice(2);
    if (flags.has(option)) {
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
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function assertPasswordInput(options: Map<string, string>): void {
  if (options.get('admin-password-stdin') !== 'true') {
    throw new Error('--admin-password-stdin is required; passwords are not accepted as command arguments.');
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === 'install') {
    const result = installDeployment({
      bundle: required(options, 'bundle'),
      root: required(options, 'root'),
      releaseKey: required(options, 'release-key'),
      confirmedFingerprint: required(options, 'confirm-release-key-fingerprint'),
      operator: required(options, 'operator'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'initialize') {
    assertPasswordInput(options);
    const result = await initializeDeployment({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      adminUsername: required(options, 'admin-username'),
      adminPassword: readFileSync(0, 'utf8').replace(/[\r\n]+$/, ''),
      operator: required(options, 'operator'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'status') {
    const result = deploymentStatus({
      root: required(options, 'root'),
      ...(options.has('master-key') ? { masterKey: required(options, 'master-key') } : {}),
      operator: required(options, 'operator'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'import-license') {
    const result = importLicense({
      root: required(options, 'root'),
      license: required(options, 'license'),
      operator: required(options, 'operator'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(`Unsupported lifecycle command: ${command}.`);
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
