#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadAcquisition } from './acquisition.js';
import {
  acquisitionCheckpoint,
  acquisitionQueue,
  cancelAcquisition,
  enqueueAcquisition,
  listSourceAcquisition,
  readAcquisitionPlan,
  resetAcquisitionCheckpoint,
  tickSchedules,
  workAcquisition,
} from './acquisition-run.js';
import { acquisitionTargets } from './acquisition-targets.js';
import { listAuditEvents } from './audit-view.js';
import { createAgentIdentity, registerOAuthClient, revokeAgentIdentity, revokeOAuthClient } from './agents.js';
import { login, logout } from './auth.js';
import { issueOperatorEnrollment, revokeOperator, revokeOperatorEnrollment } from './operators.js';
import { startConsoleServer } from './console-server.js';
import {
  adoptConnection,
  connectionPacing,
  connectionSession,
  listConnections,
  publishConnection,
  resetConnectionSession,
} from './connections.js';
import { publishCommonContext, publishWorkspaceContext, showContext } from './context.js';
import { releaseDataset, showDataset } from './datasets.js';
import { OperatorError } from './errors.js';
import { createExport, downloadExport } from './export.js';
import { listGrants, publishGrant, revokeGrant } from './grants.js';
import { initializeDeployment } from './initialize.js';
import { installDeployment } from './install.js';
import { adoptIntegrationConfiguration, publishIntegrationConfiguration } from './integration.js';
import { publishModelBinding, revokeModelBinding, showModelBinding } from './model-binding.js';
import { activateModelProfile, evaluateModelProfile, publishModelProfile, showModelProfile } from './model-profile.js';
import { importLicense, readLicenseSummary } from './license.js';
import { askDataProduct, askWorkspaceQuery } from './natural-language-query.js';
import { queryDataProduct } from './product-query.js';
import { listDataProductReleases, listDataProducts, publishDataProduct, withdrawDataProductVersion } from './products.js';
import {
  adoptProposal,
  approveProposal,
  generateProposal,
  previewProposal,
  publishProposal,
  rejectProposal,
  showProposal,
  validateProposal,
} from './proposal.js';
import {
  approveProductProposal,
  generateProductProposal,
  previewProductProposal,
  publishProductProposal,
  rejectProductProposal,
  showProductProposal,
  validateProductProposal,
} from './product-proposal.js';
import { createSource } from './sources.js';
import { adoptSourceAcquisition, publishSourceAcquisition } from './source-acquisition.js';
import {
  adoptScraperProposal,
  approveScraperProposal,
  compileScraperService,
  publishScraperProposal,
  rejectScraperProposal,
  showScraperProposal,
  validateScraperProposal,
  verifyScraperProposal,
} from './scraper-service.js';
import { publishScraperCredential, publishScraperTask, showScraperTask } from './scraper-task.js';
import { runScraperService } from './scraper-run.js';
import { deploymentStatus } from './status.js';
import { readDeployment } from './state.js';
import { createUser, deactivateUser, listUsers, transferOwnership } from './users.js';
import { createWorkspace, grantMembership, listWorkspaces, revokeMembership } from './workspaces.js';

const GROUPED_COMMANDS = new Set([
  'user', 'workspace', 'membership', 'ownership', 'context', 'audit',
  'source', 'connection', 'acquisition', 'acquisition-config', 'integration', 'dataset',
  'product', 'product-proposal', 'grant', 'export', 'console', 'agent', 'model', 'binding', 'proposal',
  'scraper',
]);
const BOOLEAN_FLAGS = new Set([
  'admin-password-stdin', 'password-stdin', 'deployment-administrator', 'credential-stdin',
]);

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

/** Reads one comma- or space-separated list of names, dropping empty entries. */
function list(value: string): string[] {
  return value.split(/[\s,]+/).filter((entry) => entry !== '');
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
  if (command === 'source' && subcommand === 'list') {
    emit(listSourceAcquisition({ ...governed(options), workspaceId: required(options, 'workspace') }));
    return;
  }
  if (command === 'connection' && subcommand === 'publish') {
    emit(publishConnection({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      name: required(options, 'name'),
      configPath: required(options, 'config'),
      ...(options.get('credential-stdin') === 'true' ? { credential: readStdin() } : {}),
    }));
    return;
  }
  if (command === 'connection' && subcommand === 'adopt') {
    emit(adoptConnection({
      ...governed(options),
      connectionId: required(options, 'connection'),
      version: Number(required(options, 'version')),
    }));
    return;
  }
  if (command === 'connection' && subcommand === 'list') {
    emit(listConnections({ ...governed(options), workspaceId: required(options, 'workspace') }));
    return;
  }
  if (command === 'connection' && subcommand === 'session') {
    emit(connectionSession({ ...governed(options), connectionId: required(options, 'connection') }));
    return;
  }
  if (command === 'connection' && subcommand === 'session-reset') {
    emit(resetConnectionSession({ ...governed(options), connectionId: required(options, 'connection') }));
    return;
  }
  if (command === 'connection' && subcommand === 'pacing') {
    emit(connectionPacing({ ...governed(options), connectionId: required(options, 'connection') }));
    return;
  }
  if (command === 'acquisition-config' && subcommand === 'publish') {
    emit(publishSourceAcquisition({
      ...governed(options),
      sourceId: required(options, 'source'),
      configPath: required(options, 'config'),
    }));
    return;
  }
  if (command === 'acquisition-config' && subcommand === 'adopt') {
    emit(adoptSourceAcquisition({
      ...governed(options),
      sourceId: required(options, 'source'),
      version: Number(required(options, 'version')),
    }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'enqueue') {
    emit(enqueueAcquisition({
      ...governed(options),
      sourceId: required(options, 'source'),
      ...(options.has('from') ? { from: required(options, 'from') } : {}),
      ...(options.has('to') ? { to: required(options, 'to') } : {}),
    }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'work') {
    emit(await workAcquisition({
      ...governed(options),
      sourceId: required(options, 'source'),
      ...(options.has('at') ? { at: required(options, 'at') } : {}),
    }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'cancel') {
    emit(cancelAcquisition({ ...governed(options), runId: required(options, 'run') }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'queue') {
    emit(acquisitionQueue({ ...governed(options), sourceId: required(options, 'source') }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'checkpoint') {
    emit(acquisitionCheckpoint({ ...governed(options), sourceId: required(options, 'source') }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'plan') {
    emit(readAcquisitionPlan({ ...governed(options), runId: required(options, 'run') }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'targets') {
    emit(acquisitionTargets({ ...governed(options), sourceId: required(options, 'source') }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'checkpoint-reset') {
    emit(resetAcquisitionCheckpoint({ ...governed(options), sourceId: required(options, 'source') }));
    return;
  }
  if (command === 'acquisition' && subcommand === 'tick') {
    emit(tickSchedules({
      ...governed(options),
      ...(options.has('at') ? { at: required(options, 'at') } : {}),
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
  if (command === 'product' && subcommand === 'releases') {
    emit(listDataProductReleases({ ...governed(options), dataProductId: required(options, 'product') }));
    return;
  }
  if (command === 'product' && subcommand === 'withdraw') {
    emit(withdrawDataProductVersion({
      ...governed(options),
      dataProductId: required(options, 'product'),
      version: Number(required(options, 'version')),
    }));
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
  if (command === 'product' && subcommand === 'ask') {
    // A Natural-Language Query names either one Data Product or one Workspace,
    // never both, so the turn's authority is always explicit.
    const dataProductId = options.get('product');
    const workspaceId = options.get('workspace');
    if ((dataProductId === undefined) === (workspaceId === undefined)) {
      throw new Error('product ask requires exactly one of --product or --workspace.');
    }
    const shared = {
      ...governed(options),
      question: required(options, 'question'),
      ...(options.has('clarification') ? { clarification: required(options, 'clarification') } : {}),
      ...(options.has('binding') ? { bindingId: required(options, 'binding') } : {}),
      ...(options.has('conversation') ? { conversation: required(options, 'conversation') } : {}),
    };
    emit(dataProductId !== undefined
      ? await askDataProduct({ ...shared, dataProductId })
      : await askWorkspaceQuery({ ...shared, workspaceId: required(options, 'workspace') }));
    return;
  }
  if (command === 'grant' && subcommand === 'publish') {
    emit(publishGrant({
      ...governed(options),
      dataProductId: required(options, 'product'),
      // A Grant narrows exactly one principal: a Workspace member or an Agent Identity.
      ...(options.has('agent')
        ? { agentIdentityId: required(options, 'agent') }
        : { username: required(options, 'username') }),
      requestPath: required(options, 'request'),
    }));
    return;
  }
  if (command === 'grant' && subcommand === 'list') {
    emit(listGrants({ ...governed(options), dataProductId: required(options, 'product') }));
    return;
  }
  if (command === 'grant' && subcommand === 'revoke') {
    emit(revokeGrant({ ...governed(options), grantId: required(options, 'grant') }));
    return;
  }
  if (command === 'agent' && subcommand === 'create') {
    emit(createAgentIdentity({
      ...governed(options),
      name: required(options, 'name'),
      workspaceIds: list(required(options, 'workspaces')),
      scopes: list(required(options, 'scopes')),
    }));
    return;
  }
  if (command === 'agent' && subcommand === 'revoke') {
    emit(revokeAgentIdentity({ ...governed(options), agentIdentityId: required(options, 'agent') }));
    return;
  }
  if (command === 'agent' && subcommand === 'client-register') {
    emit(registerOAuthClient({
      root: required(options, 'root'),
      masterKey: required(options, 'master-key'),
      token: required(options, 'session-token'),
      agentIdentityId: required(options, 'agent'),
      metadataPath: required(options, 'metadata'),
    }));
    return;
  }
  if (command === 'agent' && subcommand === 'client-revoke') {
    emit(revokeOAuthClient({ ...governed(options), clientId: required(options, 'client') }));
    return;
  }
  if (command === 'export' && subcommand === 'create') {
    emit(createExport({
      ...governed(options),
      dataProductId: required(options, 'product'),
      requestPath: required(options, 'request'),
    }));
    return;
  }
  if (command === 'export' && subcommand === 'download') {
    emit(downloadExport({ ...governed(options), exportId: required(options, 'export') }));
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
  if (command === 'model' && subcommand === 'publish') {
    emit(publishModelProfile({
      ...governed(options),
      name: required(options, 'name'),
      configPath: required(options, 'config'),
      ...(options.get('credential-stdin') === 'true' ? { credential: readStdin() } : {}),
    }));
    return;
  }
  if (command === 'model' && subcommand === 'evaluate') {
    emit(await evaluateModelProfile({
      ...governed(options),
      profileId: required(options, 'profile'),
      version: Number(required(options, 'version')),
    }));
    return;
  }
  if (command === 'model' && subcommand === 'activate') {
    emit(activateModelProfile({
      ...governed(options),
      profileId: required(options, 'profile'),
      version: Number(required(options, 'version')),
    }));
    return;
  }
  if (command === 'model' && subcommand === 'show') {
    emit(showModelProfile({ ...governed(options), profileId: required(options, 'profile') }));
    return;
  }
  if (command === 'binding' && subcommand === 'publish') {
    emit(await publishModelBinding({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      profileId: required(options, 'profile'),
      configPath: required(options, 'config'),
    }));
    return;
  }
  if (command === 'binding' && subcommand === 'show') {
    emit(showModelBinding({ ...governed(options), bindingId: required(options, 'binding') }));
    return;
  }
  if (command === 'binding' && subcommand === 'revoke') {
    emit(revokeModelBinding({ ...governed(options), bindingId: required(options, 'binding') }));
    return;
  }
  if (command === 'proposal' && subcommand === 'generate') {
    emit(await generateProposal({
      ...governed(options),
      sourceId: required(options, 'source'),
      bindingId: required(options, 'binding'),
      evidencePath: required(options, 'evidence'),
    }));
    return;
  }
  if (command === 'proposal' && subcommand === 'validate') {
    emit(validateProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      fixturesPath: required(options, 'fixtures'),
    }));
    return;
  }
  if (command === 'proposal' && subcommand === 'preview') {
    emit(previewProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      rawId: required(options, 'raw'),
    }));
    return;
  }
  if (command === 'proposal' && subcommand === 'reject') {
    emit(rejectProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      reason: required(options, 'reason'),
    }));
    return;
  }
  if (command === 'proposal' && subcommand === 'approve') {
    emit(approveProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'proposal' && subcommand === 'publish') {
    emit(publishProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'proposal' && subcommand === 'adopt') {
    emit(adoptProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'proposal' && subcommand === 'show') {
    emit(showProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'generate') {
    emit(await generateProductProposal({
      ...governed(options),
      sourceId: required(options, 'source'),
      bindingId: required(options, 'binding'),
      requirementPath: required(options, 'requirement'),
    }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'validate') {
    emit(validateProductProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'preview') {
    emit(await previewProductProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'reject') {
    emit(rejectProductProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      reason: required(options, 'reason'),
    }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'approve') {
    emit(approveProductProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'publish') {
    emit(publishProductProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'product-proposal' && subcommand === 'show') {
    emit(showProductProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'scraper' && subcommand === 'task') {
    emit(publishScraperTask({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      name: required(options, 'name'),
      configPath: required(options, 'config'),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'task-show') {
    emit(showScraperTask({
      ...governed(options),
      taskId: required(options, 'task'),
      ...(options.has('version') ? { version: Number(required(options, 'version')) } : {}),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'credential') {
    emit(publishScraperCredential({
      ...governed(options),
      workspaceId: required(options, 'workspace'),
      ref: required(options, 'name'),
      location: required(options, 'location'),
      ...(options.has('cookie-name') ? { cookieName: required(options, 'cookie-name') } : {}),
      ...(options.get('credential-stdin') === 'true' ? { credential: readStdin() } : {}),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'compile') {
    emit(compileScraperService({
      ...governed(options),
      taskId: required(options, 'task'),
      ...(options.has('version') ? { taskVersion: Number(required(options, 'version')) } : {}),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'validate') {
    emit(validateScraperProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'scraper' && subcommand === 'reject') {
    emit(rejectScraperProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      reason: required(options, 'reason'),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'approve') {
    emit(approveScraperProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'scraper' && subcommand === 'publish') {
    emit(publishScraperProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'scraper' && subcommand === 'verify') {
    emit(await verifyScraperProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      ...(options.has('parameters') ? { parametersPath: required(options, 'parameters') } : {}),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'adopt') {
    emit(adoptScraperProposal({
      ...governed(options),
      proposalId: required(options, 'proposal'),
      sourceId: required(options, 'source'),
    }));
    return;
  }
  if (command === 'scraper' && subcommand === 'show') {
    emit(showScraperProposal({ ...governed(options), proposalId: required(options, 'proposal') }));
    return;
  }
  if (command === 'scraper' && subcommand === 'run') {
    emit(await runScraperService({
      ...governed(options),
      sourceId: required(options, 'source'),
      ...(options.has('parameters') ? { parametersPath: required(options, 'parameters') } : {}),
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
