import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { acquireUpload } from './acquisition.js';
import {
  acquisitionCheckpoint,
  cancelAcquisition,
  enqueueAcquisition,
  readAcquisitionPlan,
  resetAcquisitionCheckpoint,
  tickSchedules,
  workAcquisition,
} from './acquisition-run.js';
import { listAgentIdentities, showWorkspaceAgentAccess } from './agent-admin.js';
import {
  createAgentDelegation,
  createAgentIdentity,
  registerOAuthClient,
  revokeAgentDelegation,
  revokeAgentIdentity,
  revokeOAuthClient,
} from './agents.js';
import { publishGrant, revokeGrant } from './grants.js';
import { createExport, downloadExport, listExports, listOwnExports, revokeExport } from './export.js';
import { showDataProductGovernance } from './product-governance.js';
import { showWorkspaceAudit } from './audit-view.js';
import { login, logout, verifyStepUpAuthentication } from './auth.js';
import {
  adoptConnection,
  connectionPacing,
  connectionSession,
  listConnections,
  previewConnectionDeclaration,
  publishConnectionDeclaration,
  resetConnectionSession,
} from './connections.js';
import { publishWorkspaceContext, showContext, showContextHistory } from './context.js';
import {
  adoptSourceAcquisition,
  previewSourceAcquisition,
  publishSourceAcquisitionDeclaration,
} from './source-acquisition.js';
import {
  adoptIntegrationConfiguration,
  previewIntegrationConfiguration,
  publishIntegrationDeclaration,
} from './integration.js';
import { browserIdentity, browserNavigation } from './navigation.js';
import { askWorkspaceQuery } from './natural-language-query.js';
import { listDataProductReleases, listDataProducts, previewDataProductEvolution, publishDataProductEvolution, rollbackDataProductVersion, withdrawDataProductVersion } from './products.js';
import { generateTemplateReport, listReportTemplates, listReports, publishReportTemplate, showReport, showReportTemplate, withdrawReport, withdrawReportTemplate } from './reports.js';
import {
  approveReportCandidate,
  listReportCandidates,
  rejectReportCandidate,
  reopenReportCandidate,
  showReportCandidate,
} from './report-review.js';
import {
  createReportSchedule,
  listReportSchedules,
  pauseReportSchedule,
  resumeReportSchedule,
  tickReportSchedules,
} from './report-schedule.js';
import { publishModelBinding, revokeModelBinding, showModelBindingWorkspace } from './model-binding.js';
import { activateModelProfile, evaluateModelProfile, listModelProfiles, publishModelProfile } from './model-profile.js';
import {
  adoptProposal,
  approveProposal,
  generateProposal,
  listSourceProposals,
  previewProposal,
  publishProposal,
  rejectProposal,
  validateProposal,
} from './proposal.js';
import {
  approveProductProposal,
  generateProductProposal,
  listProductProposals,
  previewProductProposal,
  publishProductProposal,
  rejectProductProposal,
  validateProductProposal,
} from './product-proposal.js';
import { createSource, listWorkspaceSources, showWorkspaceSource } from './sources.js';
import {
  adoptScraperProposal,
  approveScraperProposal,
  compileScraperService,
  listScraperProposals,
  listScraperWorkspace,
  previewScraperProposal,
  publishScraperProposal,
  rejectScraperProposal,
  repairScraperService,
  showScraperProposal,
  validateScraperProposal,
  verifyScraperProposal,
} from './scraper-service.js';
import { publishScraperTaskDeclaration } from './scraper-task.js';
import { listScraperRuns, runScraperService } from './scraper-run.js';
import { showScraperDiagnostics } from './scraper-diagnostics.js';
import {
  appointEmergencyAdministrator,
  createWorkspace,
  grantMembership,
  listMemberships,
  listWorkspaces,
  revokeMembership,
} from './workspaces.js';
import { createUser, deactivateUser, listUsers, transferOwnership } from './users.js';
import { createServiceIdentity, listServiceIdentities, revokeServiceIdentity } from './service-identities.js';
import {
  exchangeOperatorEnrollment,
  consumeOperatorStepUp,
  listOperatorSessions,
  resolveOperatorSession,
  revokeOtherOperatorSessions,
  signInOperator,
  signOutOperator,
  verifyOperatorStepUp,
  OPERATOR_SESSION_LIFETIME_MS,
} from './operators.js';
import { queryDataProductApi } from './data-product-api.js';
import {
  createRetentionHold,
  evaluateRetention,
  listPurgeJobs,
  listRetentionHolds,
  previewPurge,
  publishRetentionOverride,
  publishRetentionPolicy,
  releaseRetentionHold,
  requestPurge,
  showPurgeJob,
  showRetentionPolicy,
  tickRetention,
} from './retention.js';
import { OperatorError } from './errors.js';
import {
  importLicense,
  licenseAccess,
  readLicenseHistoryEntries,
  readLicenseView,
} from './license.js';
import { handleMcpSurface, type McpServerIdentity } from './mcp.js';
import {
  RECOVERY_PURPOSES,
  assertRecoveryTargets,
  enableRestoredConnectivity,
  enableRestoredWorkers,
  inspectRecoverySet,
  listRestorations,
  showRecovery,
  showRestoration,
  startRestoration,
  verifyRecoverySet,
} from './recovery.js';
import { openPlatform } from './session.js';
import { deploymentStatus } from './status.js';
import { readDeployment, recentEvidence } from './state.js';
import { finalizeUpgrade, preflightUpgrade, readMigrationLedger, readUpgradeRecord, rollbackDeployment, rollbackWindow, verifyUpgrade } from './upgrade.js';

export const SESSION_COOKIE = 'dc_operator_console';
/** Platform User sessions are a separate channel from the Operator Console. */
export const USER_SESSION_COOKIE = 'dc_user_session';

/** One governed JSON body is bounded before it reaches any governed module. */
const MAX_BODY_BYTES = 1024 * 1024;
/** One governed upload is bounded before it reaches any governed module. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

/** Every structured API failure, mapped to one HTTP status. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly nextStep?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ConsoleServerOptions {
  root: string;
  masterKey: string;
  port: number;
  assets?: string;
  /** The off-host recovery target the Operator Console may inspect and restore. */
  backupRoot?: string;
  /** Where an isolated restoration is materialized, always in a new directory. */
  restoreRoot?: string;
}

export interface ConsoleServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function defaultAssetsDirectory(): string {
  // Compiled next to the application: dist/src/console-server.js serves dist/web.
  return fileURLToPath(new URL('../web/', import.meta.url));
}

/**
 * Serves the browser application and the authenticated HTTP application APIs
 * that back it, over the same governed modules the lifecycle CLI uses.
 */
export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  readDeployment(options.root);
  const assets = options.assets ?? defaultAssetsDirectory();
  if (!existsSync(join(assets, 'index.html'))) {
    throw new OperatorError(
      'WEB_ASSETS_MISSING',
      'The browser application is not built.',
      'Build the application before serving the Operator Console.',
    );
  }
  // The MCP resource and issuer are the Deployment's own bound origin, not a
  // client-supplied Host header, so no token can name another resource server.
  const identity: McpServerIdentity = { origin: '' };
  const handler = createHandler(options, assets, identity);
  const server: Server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendFailure(response, error);
      else response.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    // The Console is a host-local surface: it never binds off the loopback address.
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      identity.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

interface LifecycleJobError {
  code: string;
  message: string;
  next_step?: string;
}

/** The one background lifecycle attempt this Console has started, if any. */
interface LifecycleJob {
  kind: 'upgrade';
  state: 'running' | 'succeeded' | 'failed';
  started_at: string;
  finished_at: string | null;
  operator: string;
  error: LifecycleJobError | null;
  result: Record<string, unknown> | null;
}

/** The durable operations the Operator Console states as lifecycle evidence. */
const LIFECYCLE_EVIDENCE_OPERATIONS = ['preflight', 'checkpoint', 'upgrade', 'verify', 'finalize', 'rollback'] as const;

/** The durable evidence a licensing view states beside the entitlement itself. */
const LICENSE_EVIDENCE_OPERATIONS = ['import-license'] as const;

function publicJob(job: LifecycleJob | undefined): Record<string, unknown> | null {
  if (job === undefined) return null;
  return {
    kind: job.kind,
    state: job.state,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    result: job.result,
  };
}

function createHandler(options: ConsoleServerOptions, assets: string, identity: McpServerIdentity) {
  const lifecycleJobs = new Map<string, LifecycleJob>();
  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(options, request, response, url.pathname, lifecycleJobs);
      return;
    }
    if (await handleMcpSurface({ root: options.root, masterKey: options.masterKey, identity }, request, response, url)) {
      return;
    }
    await serveAsset(request, response, assets, url.pathname);
  };
}

async function handleApi(
  options: ConsoleServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  lifecycleJobs: Map<string, LifecycleJob>,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && !isSameOrigin(request)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'The request did not originate from this Operator Console.');
  }

  if (pathname === '/api/operator/enrollment' && method === 'POST') {
    const body = await readJson(request);
    const enrolled = await exchangeOperatorEnrollment({
      root: options.root,
      masterKey: options.masterKey,
      secret: text(body, 'enrollment_secret'),
      password: text(body, 'password'),
    });
    sendJson(response, 201, { ...enrolled });
    return;
  }

  if (pathname === '/api/operator/session' && method === 'POST') {
    const body = await readJson(request);
    const signedIn = await signInOperator({
      root: options.root,
      masterKey: options.masterKey,
      username: text(body, 'username'),
      password: text(body, 'password'),
      ...(text(body, 'totp') ? { totp: text(body, 'totp') } : {}),
      ...(text(body, 'recovery_code') ? { recoveryCode: text(body, 'recovery_code') } : {}),
    });
    response.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${signedIn.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(OPERATOR_SESSION_LIFETIME_MS / 1000)}`,
    );
    sendJson(response, 200, {
      operator_id: signedIn.operator_id,
      username: signedIn.username,
      session_expires_at: signedIn.session_expires_at,
    });
    return;
  }

  if (pathname === '/api/operator/session' && method === 'DELETE') {
    const token = cookieValue(request);
    if (!token) {
      sendJson(response, 200, { revoked: false });
      return;
    }
    const result = signOutOperator({ root: options.root, masterKey: options.masterKey, token });
    response.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    sendJson(response, 200, result);
    return;
  }

  if (pathname === '/api/operator/session' && method === 'GET') {
    const resolved = authorize(options, request, 'operator_console_session');
    sendJson(response, 200, {
      operator_id: resolved.operator.operator_id,
      username: resolved.operator.username,
      session_expires_at: resolved.session.expires_at,
    });
    return;
  }

  if (pathname === '/api/operator/health' && method === 'GET') {
    const resolved = authorize(options, request, 'operator_console_health');
    const status = deploymentStatus({
      root: options.root,
      masterKey: options.masterKey,
      operator: resolved.operator.username,
    });
    sendJson(response, 200, { ...status, checked_at: new Date().toISOString() });
    return;
  }

  // Licensing is stated and driven by the same governed module the CLI calls:
  // the current entitlement, every imported entitlement before it, the durable
  // import evidence, and the operation classes an unusable license leaves open.
  if (pathname === '/api/operator/license' && method === 'GET') {
    authorize(options, request, 'operator_console_license');
    sendJson(response, 200, licenseSurface(options));
    return;
  }

  // An offline renewal or replacement validates before anything is written, so a
  // refused import leaves the current entitlement exactly as it was.
  if (pathname === '/api/operator/license' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_console_license_import');
    const body = await readJson(request);
    const imported = importLicense({
      root: options.root,
      license: requiredText(body, 'license'),
      operator: resolved.operator.username,
    });
    sendJson(response, 200, { ...imported, ...licenseSurface(options) });
    return;
  }

  // The sessions this Operator holds, and the way the one in front of them ends
  // another left open elsewhere. Both re-resolve the session on every request.
  if (pathname === '/api/operator/sessions' && method === 'GET') {
    authorize(options, request, 'operator_console_sessions');
    sendJson(response, 200, listOperatorSessions({
      root: options.root,
      token: cookieValue(request) ?? '',
    }));
    return;
  }

  if (pathname === '/api/operator/sessions/revoke' && method === 'POST') {
    authorize(options, request, 'operator_session_revocation');
    sendJson(response, 200, revokeOtherOperatorSessions({
      root: options.root,
      masterKey: options.masterKey,
      token: cookieValue(request) ?? '',
    }));
    return;
  }

  // A step-up challenge is a fresh password and MFA proof beside the standing
  // session. It mints one single-use grant bound to the exact purpose and
  // target; restoring or resuming a restored Deployment consumes it server-side.
  if (pathname === '/api/operator/step-up' && method === 'POST') {
    authorize(options, request, 'operator_step_up');
    const body = await readJson(request);
    sendJson(response, 201, await verifyOperatorStepUp({
      root: options.root,
      masterKey: options.masterKey,
      token: cookieValue(request) ?? '',
      password: text(body, 'password'),
      ...(text(body, 'totp') === '' ? {} : { totp: text(body, 'totp') }),
      ...(text(body, 'recovery_code') === '' ? {} : { recoveryCode: text(body, 'recovery_code') }),
      purpose: text(body, 'purpose'),
      target: text(body, 'target'),
    }));
    return;
  }

  // Post-installation lifecycle: one signed maintenance window at a time, with
  // its durable record, locked migration ledger, rollback window, and evidence
  // readable between every step. The browser calls the same governed modules the
  // CLI calls; no lifecycle decision is made in the browser or in this route.
  if (pathname === '/api/operator/lifecycle' && method === 'GET') {
    authorize(options, request, 'operator_console_lifecycle');
    const deployment = readDeployment(options.root);
    sendJson(response, 200, {
      deployment: {
        release: deployment.release,
        state: deployment.state,
        service_open: deployment.service_open,
      },
      upgrade: readUpgradeRecord(options.root) ?? null,
      ledger: readMigrationLedger(options.root),
      rollback_window: rollbackWindow(options.root),
      evidence: recentEvidence(options.root, LIFECYCLE_EVIDENCE_OPERATIONS, 12),
      job: publicJob(lifecycleJobs.get(options.root)),
      checked_at: new Date().toISOString(),
    });
    return;
  }

  if (pathname === '/api/operator/lifecycle/preflight' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_console_preflight');
    const body = await readJson(request);
    sendJson(response, 200, preflightUpgrade({
      root: options.root,
      masterKey: options.masterKey,
      operator: resolved.operator.username,
      bundle: requiredText(body, 'bundle'),
      releaseKey: releaseKeyPath(options.root, body),
      confirmedFingerprint: requiredText(body, 'confirm_release_key_fingerprint'),
      ...(text(body, 'license') === '' ? {} : { license: text(body, 'license') }),
    }));
    return;
  }

  // Recovery: the coordinated checkpoints, recovery sets, and isolated
  // restorations, read and driven through the same governed module the CLI
  // calls. The console serves exactly one configured off-host target.
  if (pathname === '/api/operator/recovery' && method === 'GET') {
    const resolved = authorize(options, request, 'operator_recovery');
    void resolved;
    sendJson(response, 200, showRecovery({
      ...recoveryTargets(options),
      masterKey: options.masterKey,
    }));
    return;
  }

  const recoverySetRoute = /^\/api\/operator\/recovery\/backups\/([^/]+)$/u.exec(pathname);
  if (recoverySetRoute !== null && method === 'GET') {
    authorize(options, request, 'operator_recovery_set');
    sendJson(response, 200, inspectRecoverySet({
      backupRoot: recoveryTargets(options).backupRoot,
      backupId: decodeURIComponent(recoverySetRoute[1]!),
    }));
    return;
  }

  const recoverySetVerifyRoute = /^\/api\/operator\/recovery\/backups\/([^/]+)\/verify$/u.exec(pathname);
  if (recoverySetVerifyRoute !== null && method === 'POST') {
    const resolved = authorize(options, request, 'operator_recovery_verification');
    sendJson(response, 200, verifyRecoverySet({
      root: options.root,
      masterKey: options.masterKey,
      backupRoot: recoveryTargets(options).backupRoot,
      backupId: decodeURIComponent(recoverySetVerifyRoute[1]!),
      operator: resolved.operator.username,
    }));
    return;
  }

  if (pathname === '/api/operator/lifecycle/upgrade' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_console_upgrade');
    assertLifecycleIdle(lifecycleJobs.get(options.root));
    const body = await readJson(request);
    // Every required statement is validated before the attempt is registered,
    // so a malformed request can never leave a running job behind.
    const input = {
      bundle: requiredText(body, 'bundle'),
      releaseKey: releaseKeyPath(options.root, body),
      confirmedFingerprint: requiredText(body, 'confirm_release_key_fingerprint'),
      operator: resolved.operator.username,
      ...(text(body, 'license') === '' ? {} : { license: text(body, 'license') }),
      ...(text(body, 'backup_root') === '' ? {} : { backupRoot: text(body, 'backup_root') }),
    };
    const job: LifecycleJob = {
      kind: 'upgrade',
      state: 'running',
      started_at: new Date().toISOString(),
      finished_at: null,
      operator: resolved.operator.username,
      error: null,
      result: null,
    };
    lifecycleJobs.set(options.root, job);
    try {
      startUpgradeJob(options, job, input);
    } catch (error) {
      job.state = 'failed';
      job.finished_at = new Date().toISOString();
      job.error = {
        code: 'LIFECYCLE_JOB_FAILED',
        message: error instanceof Error ? error.message : 'The lifecycle operation failed.',
      };
      throw new HttpError(
        500,
        'LIFECYCLE_JOB_FAILED',
        'The maintenance-window upgrade could not start.',
        'Inspect the durable lifecycle evidence before retrying.',
      );
    }
    sendJson(response, 202, { started: true, job: publicJob(job) });
    return;
  }

  if (pathname === '/api/operator/lifecycle/verify' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_console_verify');
    assertLifecycleIdle(lifecycleJobs.get(options.root));
    sendJson(response, 200, verifyUpgrade({
      root: options.root,
      masterKey: options.masterKey,
      operator: resolved.operator.username,
    }));
    return;
  }

  if (pathname === '/api/operator/recovery/restorations' && method === 'GET') {
    authorize(options, request, 'operator_restorations');
    sendJson(response, 200, listRestorations({
      root: options.root,
      restoreRoot: recoveryTargets(options).restoreRoot,
    }));
    return;
  }

  // Starting a restoration answers before the work runs: the browser polls the
  // durable record instead of holding a request open for the whole restore.
  if (pathname === '/api/operator/recovery/restorations' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_restoration');
    const targets = recoveryTargets(options);
    const body = await readJson(request);
    const backupId = text(body, 'backup_id');
    const spent = consumeOperatorStepUp({
      root: options.root,
      masterKey: options.masterKey,
      token: cookieValue(request) ?? '',
      grant: text(body, 'step_up_grant'),
      purpose: RECOVERY_PURPOSES.restoration,
      target: backupId,
    });
    sendJson(response, 202, startRestoration({
      ...targets,
      masterKey: options.masterKey,
      backupId,
      operator: resolved.operator.username,
      stepUpVerifiedAt: spent.verified_at,
    }));
    return;
  }

  const restorationEnableRoute = /^\/api\/operator\/recovery\/restorations\/([^/]+)\/(enable-workers|enable-connectivity)$/u.exec(pathname);
  if (restorationEnableRoute !== null && method === 'POST') {
    const resolved = authorize(options, request, 'operator_restoration_enable');
    const targets = recoveryTargets(options);
    const body = await readJson(request);
    const restorationId = decodeURIComponent(restorationEnableRoute[1]!);
    const workers = restorationEnableRoute[2] === 'enable-workers';
    const spent = consumeOperatorStepUp({
      root: options.root,
      masterKey: options.masterKey,
      token: cookieValue(request) ?? '',
      grant: text(body, 'step_up_grant'),
      purpose: workers ? RECOVERY_PURPOSES.workers : RECOVERY_PURPOSES.connectivity,
      target: restorationId,
    });
    const enabled = workers
      ? enableRestoredWorkers({ ...targets, masterKey: options.masterKey, operator: resolved.operator.username, restorationId, stepUpVerifiedAt: spent.verified_at })
      : enableRestoredConnectivity({ ...targets, masterKey: options.masterKey, operator: resolved.operator.username, restorationId, stepUpVerifiedAt: spent.verified_at });
    sendJson(response, 200, enabled);
    return;
  }

  const restorationRoute = /^\/api\/operator\/recovery\/restorations\/([^/]+)$/u.exec(pathname);
  if (restorationRoute !== null && method === 'GET') {
    authorize(options, request, 'operator_restoration');
    sendJson(response, 200, showRestoration({
      root: options.root,
      restoreRoot: recoveryTargets(options).restoreRoot,
      restorationId: decodeURIComponent(restorationRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/operator/lifecycle/finalize' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_console_finalize');
    assertLifecycleIdle(lifecycleJobs.get(options.root));
    const body = await readJson(request);
    const stepUp = await operatorStepUp(options, request, body, 'upgrade_finalize', 'deployment');
    sendJson(response, 200, {
      ...finalizeUpgrade({ root: options.root, operator: resolved.operator.username }),
      step_up_verified_at: stepUp.verified_at,
    });
    return;
  }

  if (pathname === '/api/operator/lifecycle/rollback' && method === 'POST') {
    const resolved = authorize(options, request, 'operator_console_rollback');
    assertLifecycleIdle(lifecycleJobs.get(options.root));
    const body = await readJson(request);
    const stepUp = await operatorStepUp(options, request, body, 'application_rollback', 'deployment');
    sendJson(response, 200, {
      ...rollbackDeployment({
        root: options.root,
        masterKey: options.masterKey,
        operator: resolved.operator.username,
      }),
      step_up_verified_at: stepUp.verified_at,
    });
    return;
  }

  // The platform User channel: a separate cookie, a separate sign-in, and the
  // authorized trees the browser application navigates. Every route resolves the
  // session again, so revocation and expiry apply on the very next request.

  if (pathname === '/api/session' && method === 'POST') {
    const body = await readJson(request);
    const signedIn = await login({
      root: options.root,
      masterKey: options.masterKey,
      username: text(body, 'username'),
      password: text(body, 'password'),
      ...(text(body, 'totp') ? { totp: text(body, 'totp') } : {}),
      ...(text(body, 'recovery_code') ? { recoveryCode: text(body, 'recovery_code') } : {}),
    });
    response.setHeader('set-cookie', sessionCookie(String(signedIn.session_token), signedIn.session_expires_at));
    sendJson(response, 200, {
      username: signedIn.username,
      deployment_role: signedIn.deployment_role,
      mfa_enrolled: signedIn.mfa_enrolled,
      session_expires_at: signedIn.session_expires_at,
    });
    return;
  }

  if (pathname === '/api/session' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, browserIdentity({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/session' && method === 'DELETE') {
    const token = cookieValueFor(request, USER_SESSION_COOKIE);
    response.setHeader('set-cookie', sessionCookie('', null));
    if (!token) {
      sendJson(response, 200, { revoked: false });
      return;
    }
    try {
      sendJson(response, 200, logout({ root: options.root, masterKey: options.masterKey, token }));
    } catch (error) {
      // Signing out never traps a User whose session has already ended.
      if (!(error instanceof OperatorError) || error.code !== 'SESSION_INVALID') throw error;
      sendJson(response, 200, { revoked: false });
    }
    return;
  }

  if (pathname === '/api/navigation' && method === 'GET') {
    const token = userSession(request);
    const workspaceId = searchParam(request, 'workspace_id');
    sendJson(response, 200, browserNavigation({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...(workspaceId === null ? {} : { workspaceId }),
    }));
    return;
  }

  if (pathname === '/api/deployment/workspaces' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listWorkspaces({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/workspaces' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createWorkspace({
      root: options.root,
      masterKey: options.masterKey,
      token,
      name: text(body, 'name'),
      administrator: text(body, 'administrator'),
    }));
    return;
  }

  const emergencyRoute = /^\/api\/deployment\/workspaces\/([^/]+)\/emergency-administrator$/u.exec(pathname);
  if (emergencyRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, appointEmergencyAdministrator({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: decodeURIComponent(emergencyRoute[1]!),
      username: text(body, 'username'),
    }));
    return;
  }

  // Deployment-level identity governance. Every route resolves the platform
  // session and each module refuses a non-Administrator, so the browser never
  // decides who may manage identities.
  if (pathname === '/api/deployment/users' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listUsers({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/users' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, await createUser({
      root: options.root,
      masterKey: options.masterKey,
      token,
      username: text(body, 'username'),
      password: text(body, 'password'),
      deploymentAdministrator: flag(body, 'deployment_administrator'),
    }));
    return;
  }

  if (pathname === '/api/deployment/users/deactivate' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, deactivateUser({
      root: options.root,
      masterKey: options.masterKey,
      token,
      username: text(body, 'username'),
    }));
    return;
  }

  if (pathname === '/api/deployment/ownership-transfer' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, transferOwnership({
      root: options.root,
      masterKey: options.masterKey,
      token,
      from: text(body, 'from'),
      to: text(body, 'to'),
    }));
    return;
  }

  if (pathname === '/api/deployment/service-identities' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listServiceIdentities({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/service-identities' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createServiceIdentity({
      root: options.root,
      masterKey: options.masterKey,
      token,
      name: text(body, 'name'),
      workspaceIds: identifiers(body, 'workspace_ids'),
    }));
    return;
  }

  const serviceIdentityRoute = /^\/api\/deployment\/service-identities\/([^/]+)\/revoke$/u.exec(pathname);
  if (serviceIdentityRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeServiceIdentity({
      root: options.root,
      masterKey: options.masterKey,
      token,
      serviceIdentityId: decodeURIComponent(serviceIdentityRoute[1]!),
    }));
    return;
  }

  // Agent Identities are Deployment-scoped principals, so only a Deployment
  // Administrator creates, lists, or revokes them. The governed modules state
  // every scope, Workspace binding, and capability; the browser only renders it.
  if (pathname === '/api/deployment/agent-identities' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listAgentIdentities({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/agent-identities' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createAgentIdentity({
      root: options.root,
      masterKey: options.masterKey,
      token,
      name: text(body, 'name'),
      workspaceIds: identifiers(body, 'workspace_ids'),
      scopes: identifiers(body, 'scopes'),
    }));
    return;
  }

  const agentRevokeRoute = /^\/api\/deployment\/agent-identities\/([^/]+)\/revoke$/u.exec(pathname);
  if (agentRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeAgentIdentity({
      root: options.root,
      masterKey: options.masterKey,
      token,
      agentIdentityId: decodeURIComponent(agentRevokeRoute[1]!),
    }));
    return;
  }

  const agentClientRoute = /^\/api\/deployment\/agent-identities\/([^/]+)\/clients$/u.exec(pathname);
  if (agentClientRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    // The browser states the same Client ID Metadata Document a file would
    // carry; the governed module validates every field and protects the claims
    // the Deployment controls.
    sendJson(response, 201, registerOAuthClient({
      root: options.root,
      masterKey: options.masterKey,
      token,
      agentIdentityId: decodeURIComponent(agentClientRoute[1]!),
      metadata: {
        client_id: text(body, 'client_id'),
        client_name: text(body, 'client_name'),
        redirect_uris: identifiers(body, 'redirect_uris'),
      },
    }));
    return;
  }

  const clientRevokeRoute = /^\/api\/deployment\/oauth-clients\/([^/]+)\/revoke$/u.exec(pathname);
  if (clientRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeOAuthClient({
      root: options.root,
      masterKey: options.masterKey,
      token,
      clientId: decodeURIComponent(clientRevokeRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/workspace/data-products' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listDataProducts({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  // The conversational workbench answers through the very same governed
  // Natural-Language Query engine the lifecycle CLI and MCP use. The browser
  // states one Chinese question, and a clarification only after the platform
  // itself asked for one; every turn is normalized and reauthorized server-side.
  if (pathname === '/api/workspace/nlq' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const clarification = text(body, 'clarification');
    const conversation = text(body, 'conversation');
    const bindingId = text(body, 'binding_id');
    const at = text(body, 'at');
    sendJson(response, 200, await askWorkspaceQuery({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      question: text(body, 'question'),
      ...(clarification === '' ? {} : { clarification }),
      ...(conversation === '' ? {} : { conversation }),
      ...(bindingId === '' ? {} : { bindingId }),
      ...(at === '' ? {} : { now: at }),
    }));
    return;
  }

  // The immutable Report library reads through the same governed reporters the
  // CLI uses. Listing and reading are pure stock operations: they generate
  // nothing and never invoke a model, and every read reauthorizes the caller.
  if (pathname === '/api/workspace/reports' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listReports({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      includeWithdrawn: true,
    }));
    return;
  }

  const reportRoute = /^\/api\/workspace\/reports\/([^/]+)$/u.exec(pathname);
  if (reportRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showReport({
      root: options.root,
      masterKey: options.masterKey,
      token,
      reportId: decodeURIComponent(reportRoute[1]!),
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  // Workspace Administrators publish single-question Report Templates through
  // the same engine as the CLI; the server validates every pinned semantic.
  if (pathname === '/api/workspace/report-templates' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listReportTemplates({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/report-templates' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const freshness = text(body, 'freshness');
    sendJson(response, 201, publishReportTemplate({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      productId: requiredText(body, 'product_id'),
      name: requiredText(body, 'name'),
      config: {
        question: text(body, 'question'),
        parameters: jsonDocument(body, 'parameters'),
        query: jsonDocument(body, 'query'),
        grounded_prompt: text(body, 'grounded_prompt'),
        ...(freshness.trim() === '' ? {} : { freshness: { max_age_minutes: Number(freshness) } }),
      },
    }));
    return;
  }

  const reportTemplateRoute = /^\/api\/workspace\/report-templates\/([^/]+)$/u.exec(pathname);
  if (reportTemplateRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showReportTemplate({
      root: options.root,
      masterKey: options.masterKey,
      token,
      reportTemplateId: decodeURIComponent(reportTemplateRoute[1]!),
    }));
    return;
  }

  const reportTemplateGenerateRoute = /^\/api\/workspace\/report-templates\/([^/]+)\/generate$/u.exec(pathname);
  if (reportTemplateGenerateRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, await generateTemplateReport({
      root: options.root,
      masterKey: options.masterKey,
      token,
      reportTemplateId: decodeURIComponent(reportTemplateGenerateRoute[1]!),
      workspaceId: workspaceFromBody(body),
    }));
    return;
  }

  // Withdrawal is a lifecycle fact, not a deletion: the governed module stops
  // ordinary reuse and future generation while keeping the exact content,
  // Provenance, and Approval history readable to administrators.
  const reportWithdrawRoute = /^\/api\/workspace\/reports\/([^/]+)\/withdraw$/u.exec(pathname);
  if (reportWithdrawRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, withdrawReport({
      root: options.root,
      masterKey: options.masterKey,
      token,
      reportId: decodeURIComponent(reportWithdrawRoute[1]!),
    }));
    return;
  }

  const reportTemplateWithdrawRoute = /^\/api\/workspace\/report-templates\/([^/]+)\/withdraw$/u.exec(pathname);
  if (reportTemplateWithdrawRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const version = number(body, 'version');
    if (!Number.isInteger(version)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'The Report Template Version must be a whole number.');
    }
    sendJson(response, 200, withdrawReportTemplate({
      root: options.root,
      masterKey: options.masterKey,
      token,
      reportTemplateId: decodeURIComponent(reportTemplateWithdrawRoute[1]!),
      version,
    }));
    return;
  }

  // Deduplicated candidate review. The list is administrator-scoped, and
  // Approval publishes the exact reviewed Template Version and Report the
  // reviewer saw: the routes never ask the engine to regenerate anything.
  if (pathname === '/api/workspace/report-candidates' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listReportCandidates({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  const reportCandidateRoute = /^\/api\/workspace\/report-candidates\/([^/]+)(?:\/(approve|reject|reopen))?$/u.exec(pathname);
  if (reportCandidateRoute !== null) {
    const candidateId = decodeURIComponent(reportCandidateRoute[1]!);
    const decision = reportCandidateRoute[2];
    if (decision === undefined && method === 'GET') {
      const token = userSession(request);
      sendJson(response, 200, showReportCandidate({
        root: options.root,
        masterKey: options.masterKey,
        token,
        candidateId,
      }));
      return;
    }
    if (decision !== undefined && method === 'POST') {
      const token = userSession(request);
      if (decision === 'approve') {
        sendJson(response, 200, approveReportCandidate({
          root: options.root,
          masterKey: options.masterKey,
          token,
          candidateId,
        }));
        return;
      }
      if (decision === 'reject') {
        const body = await readJson(request);
        const reason = text(body, 'reason');
        sendJson(response, 200, rejectReportCandidate({
          root: options.root,
          masterKey: options.masterKey,
          token,
          candidateId,
          ...(reason.trim() === '' ? {} : { reason }),
        }));
        return;
      }
      sendJson(response, 200, reopenReportCandidate({
        root: options.root,
        masterKey: options.masterKey,
        token,
        candidateId,
      }));
      return;
    }
  }

  // Report schedules are durable facts evaluated only by an explicit tick. The
  // browser states the designated Consumer and interval; the engine revalidates
  // that Consumer and its Grants on every run rather than trusting the form.
  if (pathname === '/api/workspace/report-schedules' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listReportSchedules({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/report-schedules' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const startAt = text(body, 'start_at');
    sendJson(response, 201, createReportSchedule({
      root: options.root,
      masterKey: options.masterKey,
      token,
      reportTemplateId: requiredText(body, 'report_template_id'),
      consumerUsername: requiredText(body, 'consumer_username'),
      intervalMinutes: number(body, 'interval_minutes'),
      ...(startAt.trim() === '' ? {} : { startAt }),
    }));
    return;
  }

  if (pathname === '/api/workspace/report-schedules/tick' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const at = text(body, 'at');
    const scheduleId = text(body, 'schedule_id');
    sendJson(response, 200, await tickReportSchedules({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      ...(scheduleId.trim() === '' ? {} : { scheduleId }),
      ...(at.trim() === '' ? {} : { at }),
    }));
    return;
  }

  const reportScheduleRoute = /^\/api\/workspace\/report-schedules\/([^/]+)\/(pause|resume)$/u.exec(pathname);
  if (reportScheduleRoute !== null && method === 'POST') {
    const token = userSession(request);
    const scheduleId = decodeURIComponent(reportScheduleRoute[1]!);
    const action = reportScheduleRoute[2] === 'pause' ? pauseReportSchedule : resumeReportSchedule;
    sendJson(response, 200, action({
      root: options.root,
      masterKey: options.masterKey,
      token,
      scheduleId,
    }));
    return;
  }

  // Consumer exploration reads through the very same governed engine the
  // published Data Product API and MCP answer with. The active Workspace is
  // named on every request, so a Product reached from another Workspace answers
  // exactly like one that does not exist.
  const productQueryRoute = /^\/api\/workspace\/products\/([^/]+)\/query$/u.exec(pathname);
  if (productQueryRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, queryDataProductApi({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      dataProductId: decodeURIComponent(productQueryRoute[1]!),
      request: jsonDocument(body, 'request'),
    }));
    return;
  }

  const productReleasesRoute = /^\/api\/workspace\/products\/([^/]+)\/releases$/u.exec(pathname);
  if (productReleasesRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listDataProductReleases({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId: decodeURIComponent(productReleasesRoute[1]!),
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  // A Consumer's curated export runs the same governed query, under the same
  // Grants, Release pin, and short-lived reauthorized download.
  const productExportRoute = /^\/api\/workspace\/products\/([^/]+)\/exports$/u.exec(pathname);
  if (productExportRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createExport({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      dataProductId: decodeURIComponent(productExportRoute[1]!),
      request: jsonDocument(body, 'request'),
    }));
    return;
  }

  if (pathname === '/api/workspace/my-exports' && method === 'GET') {
    const token = userSession(request);
    const dataProductId = searchParam(request, 'data_product_id');
    sendJson(response, 200, listOwnExports({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      ...(dataProductId === null ? {} : { dataProductId }),
    }));
    return;
  }

  // Data Product governance: one administrator-scoped answer names every exact
  // Version and Release, the Dataset freshness and Provenance each Release
  // pinned, the Grants in force, and the consequences of each lifecycle action.
  const productGovernanceRoute = /^\/api\/workspace\/products\/([^/]+)\/governance$/u.exec(pathname);
  if (productGovernanceRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showDataProductGovernance({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId: decodeURIComponent(productGovernanceRoute[1]!),
    }));
    return;
  }

  // Contract evolution is proposed, previewed, and published as exact content.
  // The governed module decides the next major or minor and states the Consumer
  // consequences; the browser only renders that answer.
  const productEvolutionRoute = /^\/api\/workspace\/products\/([^/]+)\/evolution\/(preview|publish)$/u.exec(pathname);
  if (productEvolutionRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const dataProductId = decodeURIComponent(productEvolutionRoute[1]!);
    const contract = jsonDocument(body, 'contract');
    if (productEvolutionRoute[2] === 'preview') {
      sendJson(response, 200, previewDataProductEvolution({
        root: options.root,
        masterKey: options.masterKey,
        token,
        dataProductId,
        contract,
      }));
      return;
    }
    sendJson(response, 201, publishDataProductEvolution({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId,
      contract,
    }));
    return;
  }

  const productLifecycleRoute = /^\/api\/workspace\/products\/([^/]+)\/(rollback|withdraw)$/u.exec(pathname);
  if (productLifecycleRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const version = number(body, 'version');
    if (!Number.isInteger(version)) {
      throw new HttpError(400, 'INVALID_REQUEST', 'The Data Product Version must be a whole number.');
    }
    const dataProductId = decodeURIComponent(productLifecycleRoute[1]!);
    if (productLifecycleRoute[2] === 'rollback') {
      sendJson(response, 200, rollbackDataProductVersion({
        root: options.root,
        masterKey: options.masterKey,
        token,
        dataProductId,
        version,
      }));
      return;
    }
    sendJson(response, 200, withdrawDataProductVersion({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId,
      version,
    }));
    return;
  }

  // One Grant surface narrows either a Workspace member or an Agent Identity;
  // the governed module authorizes the Workspace Administrator and validates
  // every column and row predicate against the published Contract.
  if (pathname === '/api/workspace/product-grants' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const columnText = text(body, 'columns');
    const columns = columnText
      .split(/[,，\n]/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const rowFilters = jsonDocument(body, 'row_filters');
    const agentIdentityId = text(body, 'agent_identity_id');
    sendJson(response, 201, publishGrant({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId: text(body, 'data_product_id'),
      ...(agentIdentityId === ''
        ? { username: text(body, 'username') }
        : { agentIdentityId }),
      request: {
        ...(columns.length === 0 ? {} : { columns }),
        ...(rowFilters === undefined ? {} : { row_filters: rowFilters }),
      },
    }));
    return;
  }

  const productGrantRevokeRoute = /^\/api\/workspace\/product-grants\/([^/]+)\/revoke$/u.exec(pathname);
  if (productGrantRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeGrant({
      root: options.root,
      masterKey: options.masterKey,
      token,
      grantId: decodeURIComponent(productGrantRevokeRoute[1]!),
    }));
    return;
  }

  // Governed curated-result exports: an administrator lists and revokes them,
  // while creation and download still run through the same governed query and
  // Grants the Consumer reads under.
  if (pathname === '/api/workspace/exports' && method === 'GET') {
    const token = userSession(request);
    const dataProductId = searchParam(request, 'data_product_id');
    sendJson(response, 200, listExports({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      ...(dataProductId === null ? {} : { dataProductId }),
    }));
    return;
  }

  if (pathname === '/api/workspace/exports' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createExport({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId: text(body, 'data_product_id'),
      request: jsonDocument(body, 'request'),
    }));
    return;
  }

  const exportActionRoute = /^\/api\/workspace\/exports\/([^/]+)\/(revoke|download)$/u.exec(pathname);
  if (exportActionRoute !== null && method === 'POST') {
    const token = userSession(request);
    const exportId = decodeURIComponent(exportActionRoute[1]!);
    if (exportActionRoute[2] === 'revoke') {
      sendJson(response, 200, revokeExport({
        root: options.root,
        masterKey: options.masterKey,
        token,
        exportId,
      }));
      return;
    }
    sendJson(response, 200, downloadExport({
      root: options.root,
      masterKey: options.masterKey,
      token,
      exportId,
    }));
    return;
  }

  // Agent access inside one Workspace. The Workspace Administrator sees only
  // this Workspace's Grants and consents, publishes narrowings through the same
  // governed module the CLI uses, and records only their own delegated consent.
  if (pathname === '/api/workspace/agents' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showWorkspaceAgentAccess({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/agent-grants' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const columnText = text(body, 'columns');
    const columns = columnText
      .split(/[,，\n]/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const rowFilters = jsonDocument(body, 'row_filters');
    sendJson(response, 201, publishGrant({
      root: options.root,
      masterKey: options.masterKey,
      token,
      dataProductId: text(body, 'data_product_id'),
      agentIdentityId: text(body, 'agent_identity_id'),
      request: {
        ...(columns.length === 0 ? {} : { columns }),
        ...(rowFilters === undefined ? {} : { row_filters: rowFilters }),
      },
    }));
    return;
  }

  const agentGrantRevokeRoute = /^\/api\/workspace\/agent-grants\/([^/]+)\/revoke$/u.exec(pathname);
  if (agentGrantRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeGrant({
      root: options.root,
      masterKey: options.masterKey,
      token,
      grantId: decodeURIComponent(agentGrantRevokeRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/workspace/agent-delegations' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createAgentDelegation({
      root: options.root,
      masterKey: options.masterKey,
      token,
      agentIdentityId: text(body, 'agent_identity_id'),
      workspaceId: workspaceFromBody(body),
    }));
    return;
  }

  const agentDelegationRevokeRoute = /^\/api\/workspace\/agent-delegations\/([^/]+)\/revoke$/u.exec(pathname);
  if (agentDelegationRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeAgentDelegation({
      root: options.root,
      masterKey: options.masterKey,
      token,
      delegationId: decodeURIComponent(agentDelegationRevokeRoute[1]!),
    }));
    return;
  }

  // Retention: Deployment defaults, Workspace overrides, accountable Holds,
  // dependency-aware eligibility, and step-up-authenticated Purge. Every route
  // calls the same governed module the CLI calls, so no clock is judged here.
  if (pathname === '/api/deployment/retention' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showRetentionPolicy({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/retention' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, publishRetentionPolicy({
      root: options.root,
      masterKey: options.masterKey,
      token,
      config: {
        ...(body['defaults'] === undefined ? {} : { defaults: body['defaults'] }),
        ...(body['bounds'] === undefined ? {} : { bounds: body['bounds'] }),
      },
    }));
    return;
  }

  if (pathname === '/api/deployment/retention/holds' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listRetentionHolds({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/retention/holds' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createRetentionHold({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...retentionOptions(body),
      scopeKind: 'deployment',
      reason: text(body, 'reason'),
      reviewAt: text(body, 'review_at'),
    }));
    return;
  }

  if (pathname === '/api/deployment/retention/purges' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listPurgeJobs({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  // Automatic retention is a Deployment decision: one tick evaluates every
  // Workspace, queues eligible work, and retries every due failure.
  if (pathname === '/api/deployment/retention/tick' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const at = text(body, 'at');
    sendJson(response, 200, tickRetention({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...(at === '' ? {} : { at }),
    }));
    return;
  }

  if (pathname === '/api/workspace/retention' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showRetentionPolicy({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/retention/override' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, publishRetentionOverride({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      config: body['terms'] ?? {},
    }));
    return;
  }

  if (pathname === '/api/workspace/retention/evaluate' && method === 'GET') {
    const token = userSession(request);
    const at = searchParam(request, 'at');
    sendJson(response, 200, evaluateRetention({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      ...(at === null ? {} : { at }),
    }));
    return;
  }

  if (pathname === '/api/workspace/retention/holds' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listRetentionHolds({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/retention/holds' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createRetentionHold({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...retentionOptions(body),
      scopeKind: text(body, 'scope_kind'),
      reason: text(body, 'reason'),
      reviewAt: text(body, 'review_at'),
    }));
    return;
  }

  // A Hold is released by whichever administrator accountable for its scope the
  // governed module accepts, so one route serves both navigation trees.
  const holdReleaseRoute = /^\/api\/retention\/holds\/([^/]+)\/release$/u.exec(pathname);
  if (holdReleaseRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, releaseRetentionHold({
      root: options.root,
      masterKey: options.masterKey,
      token,
      holdId: decodeURIComponent(holdReleaseRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/workspace/retention/purges' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listPurgeJobs({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/retention/purge/preview' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, previewPurge({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...retentionOptions(body),
      scopeKind: text(body, 'scope_kind'),
    }));
    return;
  }

  // Manual Purge is irreversible once its asynchronous deletion runs, so this
  // route demands a fresh password and MFA proof beside the standing session
  // before the governed module revokes access and queues the deletion.
  if (pathname === '/api/workspace/retention/purge' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const workspaceId = text(body, 'workspace_id');
    const stepUp = await verifyStepUpAuthentication({
      root: options.root,
      masterKey: options.masterKey,
      token,
      password: text(body, 'password'),
      ...(text(body, 'totp') === '' ? {} : { totp: text(body, 'totp') }),
      ...(text(body, 'recovery_code') === '' ? {} : { recoveryCode: text(body, 'recovery_code') }),
      purpose: 'retention_purge_request',
      ...(workspaceId === '' ? {} : { workspaceId }),
      target: text(body, 'scope_kind'),
    });
    sendJson(response, 201, requestPurge({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...retentionOptions(body),
      scopeKind: text(body, 'scope_kind'),
      stepUpVerifiedAt: stepUp.verified_at,
    }));
    return;
  }

  const purgeShowRoute = /^\/api\/workspace\/retention\/purges\/([^/]+)$/u.exec(pathname);
  if (purgeShowRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showPurgeJob({
      root: options.root,
      masterKey: options.masterKey,
      token,
      purgeId: decodeURIComponent(purgeShowRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/workspace/context' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showContext({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  // A Publication advertises this path. It answers the very same governed read
  // Model Profiles are Deployment-scoped: only a Deployment Administrator may
  // read them, publish a Version, evaluate it, or activate it.
  if (pathname === '/api/deployment/model-profiles' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listModelProfiles({ root: options.root, masterKey: options.masterKey, token }));
    return;
  }

  if (pathname === '/api/deployment/model-profiles' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const credential = text(body, 'credential');
    sendJson(response, 201, publishModelProfile({
      root: options.root,
      masterKey: options.masterKey,
      token,
      name: text(body, 'name'),
      configuration: body,
      ...(credential === '' ? {} : { credential }),
    }));
    return;
  }

  const modelProfileRoute = /^\/api\/deployment\/model-profiles\/([^/]+)\/(evaluate|activate)$/u.exec(pathname);
  if (modelProfileRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const profileId = decodeURIComponent(modelProfileRoute[1]!);
    const version = number(body, 'model_profile_version');
    if (modelProfileRoute[2] === 'evaluate') {
      sendJson(response, 200, await evaluateModelProfile({
        root: options.root,
        masterKey: options.masterKey,
        token,
        profileId,
        version,
      }));
      return;
    }
    sendJson(response, 200, activateModelProfile({
      root: options.root,
      masterKey: options.masterKey,
      token,
      profileId,
      version,
    }));
    return;
  }

  // A Binding is Workspace-scoped: a Workspace Administrator reads, creates,
  // and revokes only the Bindings of the active Workspace.
  if (pathname === '/api/workspace/model-bindings' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showModelBindingWorkspace({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/model-bindings' && method === 'POST') {
    const token = userSession(request);
    const workspaceId = activeWorkspace(request);
    const body = await readJson(request);
    sendJson(response, 201, await publishModelBinding({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId,
      profileId: text(body, 'model_profile_id'),
      configuration: body,
    }));
    return;
  }

  const bindingRevokeRoute = /^\/api\/workspace\/model-bindings\/([^/]+)\/revoke$/u.exec(pathname);
  if (bindingRevokeRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, revokeModelBinding({
      root: options.root,
      masterKey: options.masterKey,
      token,
      bindingId: decodeURIComponent(bindingRevokeRoute[1]!),
    }));
    return;
  }

  // A Publication advertises this path. It answers the very same governed read
  // the MCP direct-query tool answers, with a Consumer's own Bearer credential.
  const queryRoute = /^\/api\/workspaces\/([^/]+)\/data-products\/([^/]+)\/query$/.exec(pathname);
  if (queryRoute !== null && method === 'POST') {
    const credential = bearerCredential(request);
    if (credential === undefined) {
      throw new HttpError(401, 'SESSION_INVALID', 'A Data Product Query requires a Bearer session token.');
    }
    sendJson(response, 200, queryDataProductApi({
      root: options.root,
      masterKey: options.masterKey,
      token: credential,
      workspaceId: decodeURIComponent(queryRoute[1]!),
      dataProductId: decodeURIComponent(queryRoute[2]!),
      request: await readJson(request),
    }));
    return;
  }

  // Acquisition Connections are Workspace Artifacts: the guided form reviews an
  // exact declarative document, publishes one immutable Version, and adopts it.
  // The credential is write-only: no answer below ever returns its value.
  if (pathname === '/api/workspace/connections' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listConnections({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/connections/preview' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, previewConnectionDeclaration({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      name: text(body, 'name'),
      declaration: body['declaration'],
      ...(text(body, 'credential') === '' ? {} : { credential: text(body, 'credential') }),
    }));
    return;
  }

  if (pathname === '/api/workspace/connections' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, publishConnectionDeclaration({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      name: text(body, 'name'),
      declaration: body['declaration'],
      ...(text(body, 'credential') === '' ? {} : { credential: text(body, 'credential') }),
    }));
    return;
  }

  const connectionRoute = /^\/api\/workspace\/connections\/([^/]+)\/(adopt|session|session\/reset|pacing)$/u.exec(pathname);
  if (connectionRoute !== null) {
    const token = userSession(request);
    const connectionId = decodeURIComponent(connectionRoute[1]!);
    const action = connectionRoute[2];
    if (action === 'adopt' && method === 'POST') {
      const body = await readJson(request);
      sendJson(response, 200, adoptConnection({
        root: options.root,
        masterKey: options.masterKey,
        token,
        connectionId,
        version: number(body, 'version'),
      }));
      return;
    }
    if (action === 'session' && method === 'GET') {
      sendJson(response, 200, connectionSession({ root: options.root, masterKey: options.masterKey, token, connectionId }));
      return;
    }
    if (action === 'session/reset' && method === 'POST') {
      sendJson(response, 200, resetConnectionSession({ root: options.root, masterKey: options.masterKey, token, connectionId }));
      return;
    }
    if (action === 'pacing' && method === 'GET') {
      sendJson(response, 200, connectionPacing({ root: options.root, masterKey: options.masterKey, token, connectionId }));
      return;
    }
  }

  // A guided Source workflow: create the Source, review and publish its
  // declarative Configuration, adopt an exact Version, then upload content that
  // integrates into the next Dataset Release. Every route authorizes server-side
  // and none of them ever answers with raw bytes or object locators.
  if (pathname === '/api/workspace/sources' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listWorkspaceSources({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/sources' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, createSource({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      name: text(body, 'name'),
      type: text(body, 'type'),
    }));
    return;
  }

  const sourceRoute = /^\/api\/workspace\/sources\/([^/]+)$/u.exec(pathname);
  if (sourceRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showWorkspaceSource({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(sourceRoute[1]!),
    }));
    return;
  }

  const configurationRoute = /^\/api\/workspace\/sources\/([^/]+)\/configuration\/(preview|publish|adopt)$/u.exec(pathname);
  if (configurationRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const sourceId = decodeURIComponent(configurationRoute[1]!);
    if (configurationRoute[2] === 'preview') {
      sendJson(response, 200, previewIntegrationConfiguration({
        root: options.root,
        masterKey: options.masterKey,
        token,
        sourceId,
        declaration: body['declaration'],
      }));
      return;
    }
    if (configurationRoute[2] === 'publish') {
      sendJson(response, 201, publishIntegrationDeclaration({
        root: options.root,
        masterKey: options.masterKey,
        token,
        sourceId,
        declaration: body['declaration'],
      }));
      return;
    }
    sendJson(response, 200, adoptIntegrationConfiguration({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId,
      version: number(body, 'version'),
    }));
    return;
  }

  // The declarative acquisition configuration a connector Source executes under.
  const acquisitionConfigurationRoute = /^\/api\/workspace\/sources\/([^/]+)\/acquisition\/(preview|publish|adopt)$/u.exec(pathname);
  if (acquisitionConfigurationRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const sourceId = decodeURIComponent(acquisitionConfigurationRoute[1]!);
    if (acquisitionConfigurationRoute[2] === 'preview') {
      sendJson(response, 200, previewSourceAcquisition({
        root: options.root,
        masterKey: options.masterKey,
        token,
        sourceId,
        declaration: body['declaration'],
      }));
      return;
    }
    if (acquisitionConfigurationRoute[2] === 'publish') {
      sendJson(response, 201, publishSourceAcquisitionDeclaration({
        root: options.root,
        masterKey: options.masterKey,
        token,
        sourceId,
        declaration: body['declaration'],
      }));
      return;
    }
    sendJson(response, 200, adoptSourceAcquisition({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId,
      version: number(body, 'version'),
    }));
    return;
  }

  const acquisitionRunRoute = /^\/api\/workspace\/sources\/([^/]+)\/acquisition\/runs$/u.exec(pathname);
  if (acquisitionRunRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const from = text(body, 'from');
    const to = text(body, 'to');
    const rerunOf = text(body, 'rerun_of');
    sendJson(response, 201, enqueueAcquisition({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(acquisitionRunRoute[1]!),
      ...(from === '' ? {} : { from }),
      ...(to === '' ? {} : { to }),
      ...(rerunOf === '' ? {} : { rerunOf }),
    }));
    return;
  }

  const acquisitionWorkRoute = /^\/api\/workspace\/sources\/([^/]+)\/acquisition\/work$/u.exec(pathname);
  if (acquisitionWorkRoute !== null && method === 'POST') {
    const token = userSession(request);
    sendJson(response, 200, await workAcquisition({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(acquisitionWorkRoute[1]!),
    }));
    return;
  }

  const acquisitionCheckpointRoute = /^\/api\/workspace\/sources\/([^/]+)\/acquisition\/checkpoint(\/reset)?$/u.exec(pathname);
  if (acquisitionCheckpointRoute !== null) {
    const token = userSession(request);
    const sourceId = decodeURIComponent(acquisitionCheckpointRoute[1]!);
    if (acquisitionCheckpointRoute[2] === undefined && method === 'GET') {
      sendJson(response, 200, acquisitionCheckpoint({ root: options.root, masterKey: options.masterKey, token, sourceId }));
      return;
    }
    if (acquisitionCheckpointRoute[2] === '/reset' && method === 'POST') {
      sendJson(response, 200, resetAcquisitionCheckpoint({ root: options.root, masterKey: options.masterKey, token, sourceId }));
      return;
    }
  }

  if (pathname === '/api/workspace/acquisition/schedule' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const at = text(body, 'at');
    sendJson(response, 200, tickSchedules({
      root: options.root,
      masterKey: options.masterKey,
      token,
      ...(at === '' ? {} : { at }),
    }));
    return;
  }

  const acquisitionRunActionRoute = /^\/api\/workspace\/acquisition-runs\/([^/]+)\/(cancel|plan)$/u.exec(pathname);
  if (acquisitionRunActionRoute !== null) {
    const token = userSession(request);
    const runId = decodeURIComponent(acquisitionRunActionRoute[1]!);
    if (acquisitionRunActionRoute[2] === 'cancel' && method === 'POST') {
      sendJson(response, 200, cancelAcquisition({ root: options.root, masterKey: options.masterKey, token, runId }));
      return;
    }
    if (acquisitionRunActionRoute[2] === 'plan' && method === 'GET') {
      sendJson(response, 200, readAcquisitionPlan({ root: options.root, masterKey: options.masterKey, token, runId }));
      return;
    }
  }

  const acquisitionRoute = /^\/api\/workspace\/sources\/([^/]+)\/acquisitions$/u.exec(pathname);
  if (acquisitionRoute !== null && method === 'POST') {
    const token = userSession(request);
    const bytes = await readRawBody(request);
    const outcome = acquireUpload({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(acquisitionRoute[1]!),
      bytes,
    });
    if (outcome.failure !== null) {
      // The bytes are retained as a Raw Acquisition; only integration refused
      // them, so the current Release stays in force and the answer says so.
      sendJson(response, 422, { ...outcome.failure, raw_acquisition_saved: true });
      return;
    }
    const raw = outcome.upload['raw_acquisition'] as Record<string, unknown>;
    sendJson(response, 201, {
      source_id: outcome.upload['source_id'],
      acquisition_run_id: outcome.upload['acquisition_run_id'],
      status: outcome.upload['status'],
      raw_acquisition: {
        raw_id: raw['raw_id'],
        content_hash: raw['content_hash'],
        byte_length: raw['byte_length'],
        received_at: raw['received_at'],
      },
      integration_batch: outcome.upload['integration_batch'],
      integration: outcome.integration,
    });
    return;
  }

  // The Scraper Service lifecycle: a guided Task form pins the target, output
  // contract, parameters, fixtures, constraints, and credential references;
  // compilation, versioned-fixture validation and preview, Approval, Publication,
  // isolated live verification, and Source Adoption stay separate exact-version
  // actions over the same governed modules the CLI uses.
  if (pathname === '/api/workspace/scrapers' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listScraperWorkspace({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  // Artifact Proposal governance: the browser states a Chinese requirement and
  // reads the data dictionary, runs the same deterministic validation and
  // isolated preview the CLI runs, then approves, publishes, and adopts exact
  // candidate Versions. Every route re-resolves the session and the governed
  // module authorizes the Workspace Administrator server-side.
  const proposalListRoute = /^\/api\/workspace\/sources\/([^/]+)\/proposals$/u.exec(pathname);
  if (proposalListRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listSourceProposals({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(proposalListRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/workspace/scraper-tasks' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, publishScraperTaskDeclaration({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      name: text(body, 'name'),
      declaration: jsonDocument(body, 'declaration'),
    }));
    return;
  }

  const proposalGenerateRoute = /^\/api\/workspace\/sources\/([^/]+)\/proposals\/generate$/u.exec(pathname);
  if (proposalGenerateRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, await generateProposal({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(proposalGenerateRoute[1]!),
      bindingId: text(body, 'binding_id'),
      requirement: { requirement: text(body, 'requirement'), clarifications: body['clarifications'] ?? [] },
      dictionary: jsonDocument(body, 'dictionary'),
    }));
    return;
  }

  const scraperCompileRoute = /^\/api\/workspace\/scraper-tasks\/([^/]+)\/compile$/u.exec(pathname);
  if (scraperCompileRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const taskVersion = number(body, 'task_version');
    sendJson(response, 201, compileScraperService({
      root: options.root,
      masterKey: options.masterKey,
      token,
      taskId: decodeURIComponent(scraperCompileRoute[1]!),
      ...(Number.isInteger(taskVersion) ? { taskVersion } : {}),
    }));
    return;
  }

  if (pathname === '/api/workspace/scraper-proposals' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listScraperProposals({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  const scraperProposalRoute = /^\/api\/workspace\/scraper-proposals\/([^/]+)\/(show|validate|preview|approve|reject|publish|verify|adopt)$/u.exec(pathname);
  if (scraperProposalRoute !== null && (method === 'POST' || (method === 'GET' && scraperProposalRoute[2] === 'show'))) {
    const token = userSession(request);
    const proposalId = decodeURIComponent(scraperProposalRoute[1]!);
    const action = scraperProposalRoute[2];
    if (action === 'show') {
      sendJson(response, 200, showScraperProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    const body = method === 'POST' ? await readJson(request) : {};
    if (action === 'validate') {
      sendJson(response, 200, validateScraperProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    if (action === 'preview') {
      sendJson(response, 200, previewScraperProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    if (action === 'approve') {
      sendJson(response, 200, approveScraperProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    if (action === 'publish') {
      sendJson(response, 200, publishScraperProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    if (action === 'verify') {
      const parameters = jsonDocument(body, 'parameters');
      sendJson(response, 200, await verifyScraperProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
        ...(parameters === undefined ? {} : { parameters }),
      }));
      return;
    }
    if (action === 'adopt') {
      sendJson(response, 200, adoptScraperProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
        sourceId: text(body, 'source_id'),
      }));
      return;
    }
    sendJson(response, 200, rejectScraperProposal({
      root: options.root,
      masterKey: options.masterKey,
      token,
      proposalId,
      reason: text(body, 'reason'),
    }));
    return;
  }

  const proposalActionRoute = /^\/api\/workspace\/proposals\/([^/]+)\/(validate|preview|approve|reject|publish|adopt)$/u.exec(pathname);
  if (proposalActionRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const proposalId = decodeURIComponent(proposalActionRoute[1]!);
    const action = proposalActionRoute[2];
    if (action === 'validate') {
      sendJson(response, 200, validateProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
        fixtures: jsonDocument(body, 'fixtures'),
      }));
      return;
    }
    if (action === 'preview') {
      sendJson(response, 200, previewProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
        rawId: text(body, 'raw_id'),
      }));
      return;
    }
    if (action === 'approve') {
      sendJson(response, 200, approveProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    if (action === 'publish') {
      sendJson(response, 200, publishProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    if (action === 'adopt') {
      sendJson(response, 200, adoptProposal({ root: options.root, masterKey: options.masterKey, token, proposalId }));
      return;
    }
    sendJson(response, 200, rejectProposal({
      root: options.root,
      masterKey: options.masterKey,
      token,
      proposalId,
      reason: text(body, 'reason'),
    }));
    return;
  }

  if (pathname === '/api/workspace/scraper-runs' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listScraperRuns({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
      sourceId: searchParam(request, 'source_id') ?? '',
    }));
    return;
  }

  // Data Product Proposal governance: the browser states a Chinese requirement
  // and reads the Contract the governed engine validated and previewed against
  // the real Dataset Release, then approves and publishes that exact candidate.
  // The published Version is served by the existing Data Product API; no
  // endpoint or handler is ever generated for it.
  const productProposalListRoute = /^\/api\/workspace\/sources\/([^/]+)\/product-proposals$/u.exec(pathname);
  if (productProposalListRoute !== null && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listProductProposals({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(productProposalListRoute[1]!),
    }));
    return;
  }

  if (pathname === '/api/workspace/scraper-runs' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const parameters = jsonDocument(body, 'parameters');
    sendJson(response, 201, await runScraperService({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: text(body, 'source_id'),
      ...(parameters === undefined ? {} : { parameters }),
    }));
    return;
  }

  const scraperDiagnosticsRoute = /^\/api\/workspace\/scraper-diagnostics\/([^/]+)(\/repair)?$/u.exec(pathname);
  if (scraperDiagnosticsRoute !== null && method === 'GET' && scraperDiagnosticsRoute[2] === undefined) {
    const token = userSession(request);
    sendJson(response, 200, showScraperDiagnostics({
      root: options.root,
      masterKey: options.masterKey,
      token,
      diagnosticsId: decodeURIComponent(scraperDiagnosticsRoute[1]!),
    }));
    return;
  }
  if (scraperDiagnosticsRoute !== null && method === 'POST' && scraperDiagnosticsRoute[2] === '/repair') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, await repairScraperService({
      root: options.root,
      masterKey: options.masterKey,
      token,
      diagnosticsId: decodeURIComponent(scraperDiagnosticsRoute[1]!),
      bindingId: text(body, 'binding_id'),
      taskVersion: number(body, 'task_version'),
    }));
    return;
  }

  const productProposalGenerateRoute = /^\/api\/workspace\/sources\/([^/]+)\/product-proposals\/generate$/u.exec(pathname);
  if (productProposalGenerateRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 201, await generateProductProposal({
      root: options.root,
      masterKey: options.masterKey,
      token,
      sourceId: decodeURIComponent(productProposalGenerateRoute[1]!),
      bindingId: text(body, 'binding_id'),
      requirement: {
        name: text(body, 'name'),
        requirement: text(body, 'requirement'),
        clarifications: body['clarifications'] ?? [],
      },
    }));
    return;
  }

  const productProposalActionRoute = /^\/api\/workspace\/product-proposals\/([^/]+)\/(validate|preview|approve|reject|publish)$/u.exec(pathname);
  if (productProposalActionRoute !== null && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    const proposalId = decodeURIComponent(productProposalActionRoute[1]!);
    const action = productProposalActionRoute[2];
    if (action === 'validate') {
      sendJson(response, 200, validateProductProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
      }));
      return;
    }
    if (action === 'preview') {
      sendJson(response, 200, await previewProductProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
      }));
      return;
    }
    if (action === 'approve') {
      sendJson(response, 200, approveProductProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
      }));
      return;
    }
    if (action === 'publish') {
      sendJson(response, 200, publishProductProposal({
        root: options.root,
        masterKey: options.masterKey,
        token,
        proposalId,
      }));
      return;
    }
    sendJson(response, 200, rejectProductProposal({
      root: options.root,
      masterKey: options.masterKey,
      token,
      proposalId,
      reason: text(body, 'reason'),
    }));
    return;
  }

  if (pathname === '/api/workspace/memberships' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, listMemberships({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/memberships' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, grantMembership({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      username: text(body, 'username'),
      role: text(body, 'role'),
    }));
    return;
  }

  if (pathname === '/api/workspace/memberships/revoke' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, revokeMembership({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      username: text(body, 'username'),
    }));
    return;
  }

  if (pathname === '/api/workspace/context/history' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showContextHistory({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  if (pathname === '/api/workspace/context/publish' && method === 'POST') {
    const token = userSession(request);
    const body = await readJson(request);
    sendJson(response, 200, publishWorkspaceContext({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: workspaceFromBody(body),
      entries: body['entries'],
    }));
    return;
  }

  if (pathname === '/api/workspace/audit' && method === 'GET') {
    const token = userSession(request);
    sendJson(response, 200, showWorkspaceAudit({
      root: options.root,
      masterKey: options.masterKey,
      token,
      workspaceId: activeWorkspace(request),
    }));
    return;
  }

  throw new HttpError(404, 'API_NOT_FOUND', 'No such application API.');
}

/** Where the browser states the signed bundle and its trust anchor. */
function releaseKeyPath(root: string, body: Record<string, unknown>): string {
  const explicit = text(body, 'release_key');
  return explicit === '' ? join(root, 'trust', 'release-key.pem') : explicit;
}

/**
 * Everything one licensing view states: the entitlement, its history, the
 * durable import evidence, and what an unusable license leaves open. It never
 * carries a signature, a License Request secret, or the key that verified it.
 */
function licenseSurface(options: ConsoleServerOptions): Record<string, unknown> {
  const deployment = readDeployment(options.root);
  const license = readLicenseView(options.root, join(options.root, 'license.json'));
  return {
    ...license,
    access: licenseAccess(license),
    release: deployment.release,
    deployment_id: deployment.deployment_id,
    state: deployment.state,
    history: readLicenseHistoryEntries(options.root),
    evidence: recentEvidence(options.root, LICENSE_EVIDENCE_OPERATIONS, 5),
    checked_at: new Date().toISOString(),
  };
}

/** One lifecycle mutation at a time, so a browser never races the migration lock. */
function assertLifecycleIdle(job: LifecycleJob | undefined): void {
  if (job?.state !== 'running') return;
  throw new HttpError(
    409,
    'LIFECYCLE_BUSY',
    'Another lifecycle operation is still running.',
    'Wait for its durable outcome before starting another lifecycle action.',
  );
}

/** Runs the signed maintenance-window upgrade off the request thread. */
function startUpgradeJob(
  options: ConsoleServerOptions,
  job: LifecycleJob,
  input: {
    bundle: string;
    releaseKey: string;
    confirmedFingerprint: string;
    operator: string;
    license?: string;
    backupRoot?: string;
  },
): void {
  const worker = new Worker(new URL('./lifecycle-worker.js', import.meta.url), {
    workerData: {
      kind: 'upgrade',
      root: options.root,
      masterKey: options.masterKey,
      operator: input.operator,
      bundle: input.bundle,
      releaseKey: input.releaseKey,
      confirmedFingerprint: input.confirmedFingerprint,
      ...(input.license === undefined ? {} : { license: input.license }),
      ...(input.backupRoot === undefined ? {} : { backupRoot: input.backupRoot }),
    },
  });
  const finish = (
    state: 'succeeded' | 'failed',
    error: LifecycleJobError | null,
    result: Record<string, unknown> | null,
  ): void => {
    if (job.state !== 'running') return;
    job.state = state;
    job.error = error;
    job.result = result;
    job.finished_at = new Date().toISOString();
  };
  worker.once('message', (message: { ok?: boolean; result?: Record<string, unknown>; error?: LifecycleJobError }) => {
    if (message.ok === true) finish('succeeded', null, message.result ?? null);
    else finish('failed', message.error ?? { code: 'LIFECYCLE_JOB_FAILED', message: 'The lifecycle operation failed.' }, null);
  });
  worker.once('error', (error: Error) => {
    finish('failed', { code: 'LIFECYCLE_JOB_FAILED', message: error.message }, null);
  });
  worker.once('exit', (code) => {
    if (job.state === 'running') {
      finish('failed', { code: 'LIFECYCLE_JOB_FAILED', message: `The lifecycle worker exited with code ${String(code)}.` }, null);
    }
  });
  worker.unref();
}

/** A fresh password and dynamic code prove the Operator before a final act. */
async function operatorStepUp(
  options: ConsoleServerOptions,
  request: IncomingMessage,
  body: Record<string, unknown>,
  purpose: string,
  target: string,
): Promise<{ verified_at: string }> {
  const token = cookieValue(request);
  if (token === undefined) {
    throw new HttpError(401, 'OPERATOR_SESSION_INVALID', 'The Operator Console session is not valid.');
  }
  return verifyOperatorStepUp({
    root: options.root,
    masterKey: options.masterKey,
    token,
    password: requiredText(body, 'password'),
    ...(text(body, 'totp') === '' ? {} : { totp: text(body, 'totp') }),
    ...(text(body, 'recovery_code') === '' ? {} : { recoveryCode: text(body, 'recovery_code') }),
    purpose,
    target,
  });
}

/** Every console request re-resolves the Operator, so revocation takes effect at once. */
function authorize(options: ConsoleServerOptions, request: IncomingMessage, target: string) {
  const token = cookieValue(request);
  const resolved = token ? resolveOperatorSession(options.root, token) : undefined;
  if (!resolved) {
    recordDeniedAccess(options, target);
    throw new HttpError(401, 'OPERATOR_SESSION_INVALID', 'The Operator Console session is not valid.');
  }
  return resolved;
}

/**
 * The one off-host target and restoration directory this console was started
 * with. A console begun without them states that instead of guessing paths.
 */
function recoveryTargets(options: ConsoleServerOptions) {
  return assertRecoveryTargets({
    root: options.root,
    ...(options.backupRoot === undefined ? {} : { backupRoot: options.backupRoot }),
    ...(options.restoreRoot === undefined ? {} : { restoreRoot: options.restoreRoot }),
  });
}

function recordDeniedAccess(options: ConsoleServerOptions, target: string): void {
  try {
    const session = openPlatform(options.root, options.masterKey, 'allow');
    session.audit({
      actor: 'unauthenticated',
      action: 'operator_console_access',
      scope: 'deployment',
      target,
      outcome: 'denied',
      detail: { error_code: 'OPERATOR_SESSION_INVALID' },
    });
  } catch {
    // The Deployment is not open, so there is no governed Audit Event to append.
  }
}

function userSession(request: IncomingMessage): string {
  const token = cookieValueFor(request, USER_SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'SESSION_INVALID', 'The session is not valid.');
  return token;
}

/** Every Workspace-scoped request names the one active Workspace it acts on. */
function activeWorkspace(request: IncomingMessage): string {
  const workspaceId = searchParam(request, 'workspace_id');
  if (workspaceId === null) {
    throw new HttpError(400, 'WORKSPACE_REQUIRED', 'The request must name one Workspace.');
  }
  return workspaceId;
}

/** A write names its Workspace in the body, and an unauthorized one fails closed. */
function workspaceFromBody(body: Record<string, unknown>): string {
  const workspaceId = text(body, 'workspace_id');
  if (workspaceId === '') {
    throw new HttpError(400, 'WORKSPACE_REQUIRED', 'The request must name one Workspace.');
  }
  return workspaceId;
}

/**
 * The explicit scope one retention request names. Absent identifiers stay
 * absent, so the governed module resolves and authorizes the exact scope rather
 * than guessing one from whatever the browser sent.
 */
function retentionOptions(body: Record<string, unknown>): {
  workspaceId?: string;
  sourceId?: string;
  datasetId?: string;
  datasetRelease?: number;
  targetId?: string;
  at?: string;
} {
  const workspaceId = text(body, 'workspace_id');
  const sourceId = text(body, 'source_id');
  const datasetId = text(body, 'dataset_id');
  const targetId = text(body, 'proposal_id') === '' ? text(body, 'export_id') : text(body, 'proposal_id');
  const datasetRelease = number(body, 'dataset_release');
  const at = text(body, 'at');
  return {
    ...(workspaceId === '' ? {} : { workspaceId }),
    ...(sourceId === '' ? {} : { sourceId }),
    ...(datasetId === '' ? {} : { datasetId }),
    ...(Number.isInteger(datasetRelease) ? { datasetRelease } : {}),
    ...(targetId === '' ? {} : { targetId }),
    ...(at === '' ? {} : { at }),
  };
}

function searchParam(request: IncomingMessage, name: string): string | null {
  const value = new URL(request.url ?? '/', 'http://localhost').searchParams.get(name);
  return value === null || value === '' ? null : value;
}

/** The browser never reads this cookie, and it never outlives the session. */
function sessionCookie(token: string, expiresAt: unknown): string {
  const remaining = Date.parse(String(expiresAt)) - Date.now();
  const maxAge = token === '' || !Number.isFinite(remaining) ? 0 : Math.max(0, Math.floor(remaining / 1000));
  return `${USER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Reads the Bearer credential a published Data Product API path presents. */
function bearerCredential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(value.trim());
  return match?.[1];
}

function cookieValue(request: IncomingMessage): string | undefined {
  return cookieValueFor(request, SESSION_COOKIE);
}

function cookieValueFor(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** A cross-origin form cannot forge this: only the Console's own origin is accepted. */
function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  return host !== undefined && origin === `http://${host}`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'The request body is too large.');
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request body must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_REQUEST', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** One governed upload's bytes, bounded before the governed module sniffs them. */
async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'ACQUISITION_FILE_TOO_LARGE', 'The upload exceeds the largest file this surface accepts.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** A field a governed lifecycle action cannot infer on the browser's behalf. */
function requiredText(body: Record<string, unknown>, field: string): string {
  const value = text(body, field);
  if (value === '') {
    throw new HttpError(400, 'INVALID_REQUEST', `The ${field} field is required.`);
  }
  return value;
}

/** A whole number the governed module validates, never a browser-side guess. */
function number(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  return typeof value === 'number' ? value : Number.NaN;
}

/** A checkbox is its own explicit fact; only a JSON boolean states it. */
function flag(body: Record<string, unknown>, field: string): boolean {
  return body[field] === true;
}

/**
 * A JSON document the browser stated, either already parsed or as the text a
 * form field or a file read carries. The governed module validates its shape;
 * the browser never decides what it means.
 */
function jsonDocument(body: Record<string, unknown>, field: string): unknown {
  const value = body[field];
  if (typeof value !== 'string') return value;
  if (value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(400, 'INVALID_REQUEST', `The ${field} document must be valid JSON.`);
  }
}

/** A non-empty list of governed identifiers, in the order the browser sent them. */
function identifiers(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

async function serveAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assets: string,
  pathname: string,
): Promise<void> {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'The browser application is served read-only.');
  }
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = resolve(assets, relativePath);
  const root = resolve(assets);
  const insideRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
  const served = insideRoot && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, 'index.html');
  const extension = extname(served).toLowerCase();
  response.setHeader('content-type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
  response.setHeader(
    'cache-control',
    served.startsWith(join(root, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-store',
  );
  response.statusCode = 200;
  if (method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(served);
    stream.once('error', rejectStream);
    stream.once('end', () => resolveStream());
    stream.pipe(response);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const payload = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(payload);
}

const STATUS_BY_CODE: Record<string, number> = {
  OPERATOR_ENROLLMENT_INVALID: 401,
  OPERATOR_ENROLLMENT_EXPIRED: 401,
  OPERATOR_ENROLLMENT_REVOKED: 401,
  OPERATOR_ENROLLMENT_CONSUMED: 401,
  OPERATOR_AUTHENTICATION_FAILED: 401,
  OPERATOR_SESSION_INVALID: 401,
  OPERATOR_PASSWORD_INVALID: 400,
  // Lifecycle actions are serialized: one signed maintenance window at a time.
  LIFECYCLE_BUSY: 409,
  LIFECYCLE_JOB_FAILED: 500,
  // Preflight refusals are governed answers with actionable next steps.
  BUNDLE_NOT_FOUND: 404,
  BUNDLE_INCOMPLETE: 409,
  BUNDLE_PATH_INVALID: 400,
  BUNDLE_SIGNATURE_INVALID: 409,
  BUNDLE_CHECKSUM_INVALID: 409,
  BUNDLE_IMAGE_DIGEST_INVALID: 409,
  BUNDLE_UNSUPPORTED: 409,
  BUNDLE_ARCHITECTURE_UNSUPPORTED: 409,
  RELEASE_KEY_NOT_FOUND: 404,
  RELEASE_KEY_NOT_CONFIRMED: 409,
  UPGRADE_PATH_UNSUPPORTED: 409,
  UPGRADE_DEPLOYMENT_NOT_OPEN: 409,
  ROLLBACK_WINDOW_OPEN: 409,
  UPGRADE_QUEUES_NOT_DRAINED: 409,
  BACKUP_UNHEALTHY: 409,
  RUNTIME_UNHEALTHY: 409,
  RUNTIME_COMMAND_FAILED: 502,
  UPGRADE_LOCKED: 409,
  PREVIOUS_RELEASE_IMAGES_MISSING: 409,
  PREVIOUS_RELEASE_UNTRUSTED: 409,
  LICENSE_NOT_FOUND: 404,
  LICENSE_RELEASE_INELIGIBLE: 409,
  LICENSE_SIGNATURE_INVALID: 409,
  LICENSE_REQUEST_MISMATCH: 409,
  LICENSE_DEPLOYMENT_MISMATCH: 409,
  LICENSE_WINDOW_INVALID: 409,
  LICENSE_NOT_YET_VALID: 409,
  LICENSE_EXPIRED: 409,
  LICENSE_RELEASE_INVALID: 409,
  // A malformed document and a host clock that moved backwards are both
  // governed refusals an Operator must be able to act on.
  LICENSE_MALFORMED: 409,
  LICENSE_CLOCK_ROLLBACK: 409,
  UPGRADE_NOT_READY: 409,
  UPGRADE_RELEASE_MISMATCH: 409,
  VERIFICATION_REQUIRED: 409,
  UPGRADE_VERIFICATION_FAILED: 422,
  DEPLOYMENT_NOT_OPEN: 409,
  DEPLOYMENT_NOT_FOUND: 404,
  ROLLBACK_NOT_ELIGIBLE: 409,
  ROLLBACK_NOT_APPLICABLE: 409,
  ROLLBACK_DEPLOYMENT_NOT_OPEN: 409,
  ROLLBACK_NOT_EXPAND_ONLY: 409,
  MIGRATION_DOWNGRADE_UNSUPPORTED: 409,
  MIGRATION_NOT_EXPAND_ONLY: 409,
  MIGRATION_FAILED: 500,
  RELEASE_INSTALL_FAILED: 500,
  CHECKPOINT_OBJECTS_UNCOORDINATED: 409,
  CHECKPOINT_DEPLOYMENT_CLOSED: 409,
  CHECKPOINT_AT_INVALID: 400,
  OPERATOR_NAME_INVALID: 400,
  OPERATOR_ALREADY_ENROLLED: 409,
  OPERATOR_STEP_UP_FAILED: 403,
  OPERATOR_STEP_UP_REQUIRED: 403,
  OPERATOR_STEP_UP_PURPOSE_INVALID: 400,
  RECOVERY_TARGET_NOT_CONFIGURED: 409,
  RECOVERY_RESTORE_TARGET_NOT_CONFIGURED: 409,
  RESTORATION_NOT_FOUND: 404,
  RESTORATION_NOT_VERIFIED: 409,
  RESTORATION_IN_PROGRESS: 409,
  RESTORATION_TARGET_MISSING: 409,
  RESTORATION_FAILED: 409,
  BACKUP_NOT_FOUND: 404,
  BACKUP_INTEGRITY_FAILED: 409,
  BACKUP_DEPLOYMENT_CLOSED: 409,
  BACKUP_AT_INVALID: 400,
  BACKUP_EXISTS: 409,
  BACKUP_TARGET_INSIDE_DEPLOYMENT: 400,
  RESTORE_VERIFICATION_FAILED: 409,
  RESTORE_INTEGRITY_FAILED: 409,
  RESTORE_KEY_MISMATCH: 409,
  RESTORE_LEDGER_MISSING: 409,
  RESTORE_LEDGER_TAMPERED: 409,
  RESTORE_RTO_EXCEEDED: 409,
  MASTER_KEY_NOT_FOUND: 409,
  MASTER_KEY_INVALID: 409,
  MASTER_KEY_MISMATCH: 409,
  MASTER_KEY_INSIDE_DEPLOYMENT: 400,
  DEPLOYMENT_EXISTS: 409,
  AUTHENTICATION_FAILED: 401,
  SESSION_INVALID: 401,
  STEP_UP_AUTHENTICATION_FAILED: 401,
  AUTHORIZATION_DENIED: 403,
  WORKSPACE_ACCESS_DENIED: 403,
  ROLE_INVALID: 400,
  MEMBERSHIP_NOT_FOUND: 404,
  LAST_ADMINISTRATOR_PROTECTED: 409,
  USERNAME_INVALID: 400,
  USER_ALREADY_EXISTS: 409,
  USER_NOT_FOUND: 404,
  USER_DEACTIVATED: 409,
  PASSWORD_INVALID: 400,
  OWNER_TRANSFER_REQUIRED: 409,
  OWNERSHIP_TARGET_INVALID: 400,
  OWNER_NOT_ELIGIBLE: 409,
  WORKSPACE_NAME_INVALID: 400,
  WORKSPACE_NAME_TAKEN: 409,
  WORKSPACE_NOT_FOUND: 404,
  EMERGENCY_ADMINISTRATOR_NOT_PERMITTED: 403,
  EMERGENCY_ADMINISTRATOR_NOT_REQUIRED: 409,
  SERVICE_IDENTITY_NAME_INVALID: 400,
  SERVICE_IDENTITY_EXISTS: 409,
  SERVICE_IDENTITY_NAME_CONFLICT: 409,
  SERVICE_IDENTITY_WORKSPACE_INVALID: 400,
  SERVICE_IDENTITY_NOT_FOUND: 404,
  // An Agent Identity is an external Consumer principal with its own scope,
  // Workspace-binding, client, and consent refusals.
  AGENT_NAME_INVALID: 400,
  AGENT_ALREADY_EXISTS: 409,
  AGENT_WORKSPACE_INVALID: 400,
  AGENT_SCOPE_INVALID: 400,
  AGENT_NOT_FOUND: 404,
  OAUTH_CLIENT_METADATA_INVALID: 400,
  OAUTH_CLIENT_METADATA_PROTECTED: 400,
  OAUTH_CLIENT_ALREADY_REGISTERED: 409,
  OAUTH_CLIENT_NOT_FOUND: 404,
  DELEGATION_NOT_AVAILABLE: 404,
  GRANT_GRANTEE_NOT_FOUND: 404,
  GRANT_REQUEST_INVALID: 400,
  GRANT_COLUMNS_INVALID: 400,
  GRANT_ROW_FILTER_INVALID: 400,
  GRANT_NOT_AVAILABLE: 404,
  CONTEXT_NOT_PUBLISHED: 404,
  CONTEXT_SHADOWS_COMMON: 409,
  CROSS_WORKSPACE_REFERENCE: 409,
  CONTEXT_REFERENCE_NOT_QUALIFIED: 400,
  CONTEXT_REFERENCE_UNRESOLVED: 409,
  CONTEXT_ENTRY_INVALID: 400,
  CONTEXT_ENTRY_DUPLICATE: 400,
  CONTEXT_ENTRIES_UNREADABLE: 400,
  // Retention, Holds, and Purge refusals are governed answers, never faults.
  RETENTION_CONFIG_UNREADABLE: 400,
  RETENTION_POLICY_INVALID: 400,
  RETENTION_POLICY_VERSION_NOT_FOUND: 404,
  RETENTION_SCOPE_INVALID: 400,
  RETENTION_HOLD_INVALID: 400,
  RETENTION_HOLD_NOT_FOUND: 404,
  RETENTION_PURGE_NOT_FOUND: 404,
  // A Data Product Query failure is a governed answer, not a server fault.
  DATA_PRODUCT_QUERY_INVALID: 400,
  DATA_PRODUCT_QUERY_CURSOR_INVALID: 400,
  DATA_PRODUCT_QUERY_REFUSED: 403,
  DATA_PRODUCT_NOT_AVAILABLE: 404,
  DATA_PRODUCT_NOT_PUBLISHED: 409,
  // Report library and Template publication refusals are governed decisions.
  REPORT_NOT_AVAILABLE: 404,
  REPORT_WITHDRAWN: 409,
  REPORT_GENERATION_FAILED: 422,
  REPORT_TIMEOUT: 504,
  REPORT_TEMPLATE_NOT_AVAILABLE: 404,
  REPORT_TEMPLATE_VERSION_NOT_FOUND: 404,
  REPORT_TEMPLATE_NOT_PUBLISHED: 409,
  REPORT_TEMPLATE_WITHDRAWN: 409,
  REPORT_TEMPLATE_NAME_INVALID: 400,
  REPORT_TEMPLATE_QUESTION_INVALID: 400,
  REPORT_TEMPLATE_PARAMETERS_INVALID: 400,
  REPORT_TEMPLATE_PARAMETERS_INCONSISTENT: 422,
  REPORT_TEMPLATE_PROMPT_NOT_SIMPLIFIED_CHINESE: 400,
  REPORT_TEMPLATE_FRESHNESS_INVALID: 400,
  REPORT_TEMPLATE_QUERY_INVALID: 400,
  REPORT_TEMPLATE_RELEASE_PIN_REFUSED: 400,
  REPORT_TEMPLATE_CONFIGURATION_UNREADABLE: 400,
  REPORT_TEMPLATE_CONFIGURATION_INVALID: 400,
  // Candidate review refusals keep an unreviewed answer off the stock.
  REPORT_CANDIDATE_NOT_AVAILABLE: 404,
  REPORT_CANDIDATE_NOT_FOUND: 404,
  REPORT_CANDIDATE_EVIDENCE_MISSING: 404,
  REPORT_CANDIDATE_REJECTED: 409,
  REPORT_CANDIDATE_APPROVED: 409,
  REPORT_CANDIDATE_NOT_PUBLISHABLE: 409,
  REPORT_CANDIDATE_CONTENT_CHANGED: 409,
  // Schedule entry facts a governed tick validates before any data or model work.
  REPORT_SCHEDULE_NOT_AVAILABLE: 404,
  REPORT_SCHEDULE_WITHDRAWN: 409,
  REPORT_SCHEDULE_INTERVAL_INVALID: 400,
  REPORT_SCHEDULE_CONSUMER_NOT_FOUND: 404,
  REPORT_SCHEDULE_CONSUMER_NOT_MEMBER: 409,
  REPORT_SCHEDULE_CONSUMER_INACTIVE: 409,
  REPORT_SCHEDULE_START_INVALID: 400,
  REPORT_SCHEDULE_AT_INVALID: 400,
  DATA_PRODUCT_RELEASE_NOT_FOUND: 404,
  DATASET_RELEASE_NOT_FOUND: 409,
  DATA_PRODUCT_QUERY_TOO_COMPLEX: 422,
  DATA_PRODUCT_QUERY_RESULT_TOO_LARGE: 422,
  DATA_PRODUCT_QUERY_TIMEOUT: 504,
  // A Natural-Language Query validates its own entry facts before any model or data work.
  NLQ_QUESTION_REQUIRED: 400,
  NLQ_AT_INVALID: 400,
  DATA_PRODUCT_QUERY_CURSOR_NOT_SUPPORTED: 400,
  DATA_PRODUCT_QUERY_LIMIT_EXCEEDED: 400,
  DATA_PRODUCT_RELEASE_INVALID: 409,
  RETENTION_EXPIRED: 410,
  // Data Product governance lifecycle refusals.
  DATA_PRODUCT_VERSION_NOT_FOUND: 404,
  DATA_PRODUCT_VERSION_WITHDRAWN: 409,
  DATA_PRODUCT_MAJOR_NOT_FOUND: 404,
  DATA_PRODUCT_MAJOR_WITHDRAWN: 409,
  DATA_PRODUCT_NAME_INVALID: 400,
  DATA_PRODUCT_NAME_TAKEN: 409,
  DATA_PRODUCT_CONTRACT_INVALID: 400,
  DATA_PRODUCT_CONTRACT_UNREADABLE: 400,
  DATA_PRODUCT_GRAIN_NOT_UNIQUE: 422,
  DATA_PRODUCT_RELATIONSHIP_UNBOUND: 422,
  DATA_PRODUCT_RELATIONSHIP_UNDECLARED: 422,
  DATA_PRODUCT_RELATIONSHIP_DUPLICATED: 422,
  DATA_PRODUCT_RELATIONSHIP_AMBIGUOUS: 422,
  DATA_PRODUCT_RELATIONSHIP_SCOPE: 422,
  DATA_PRODUCT_RELATIONSHIPS_UNREADABLE: 400,
  EXPORT_NOT_AVAILABLE: 404,
  EXPORT_ACCESS_EXPIRED: 410,
  EXPORT_REVOKED: 410,
  EXPORT_NO_LONGER_AUTHORIZED: 403,
  EXPORT_TOO_LARGE: 422,
  EXPORT_INCOMPLETE: 409,
  EXPORT_OBJECT_UNAVAILABLE: 409,
  MODEL_PROFILE_NAME_INVALID: 400,
  MODEL_ADAPTER_UNSUPPORTED: 400,
  MODEL_PROFILE_CONFIGURATION_INVALID: 400,
  MODEL_PROFILE_CONFIGURATION_UNREADABLE: 400,
  MODEL_PROFILE_NOT_FOUND: 404,
  MODEL_PROFILE_VERSION_NOT_FOUND: 404,
  MODEL_PROFILE_NOT_ACTIVATED: 409,
  MODEL_PROFILE_EVALUATION_REQUIRED: 409,
  MODEL_PROFILE_EVALUATION_FAILED: 409,
  MODEL_PROMPT_NOT_SIMPLIFIED_CHINESE: 422,
  MODEL_BINDING_CONFIGURATION_INVALID: 400,
  MODEL_BINDING_CONFIGURATION_UNREADABLE: 400,
  MODEL_BINDING_NOT_FOUND: 404,
  MODEL_BINDING_PURPOSE_UNSUPPORTED: 422,
  MODEL_BINDING_PURPOSE_NOT_PERMITTED: 422,
  MODEL_BINDING_DATA_CATEGORY_NOT_PERMITTED: 422,
  MODEL_BINDING_DATA_CATEGORY_INCOMPLETE: 422,
  MODEL_BINDING_PREFLIGHT_FAILED: 422,
  // A guided Source workflow refuses invalid configuration and content explicitly.
  SOURCE_NOT_AVAILABLE: 404,
  SOURCE_TYPE_UNSUPPORTED: 400,
  SOURCE_NAME_INVALID: 400,
  SOURCE_NAME_TAKEN: 409,
  SOURCE_INTEGRATION_NOT_ADOPTED: 409,
  ACQUISITION_MODE_MISMATCH: 409,
  ACQUISITION_FILE_UNREADABLE: 422,
  ACQUISITION_FILE_EMPTY: 422,
  ACQUISITION_FILE_SIGNATURE_INVALID: 422,
  ACQUISITION_FILE_ENCODING_INVALID: 422,
  ACQUISITION_DOCUMENT_TOO_LARGE: 413,
  ACQUISITION_FILE_TOO_LARGE: 413,
  INTEGRATION_CONFIGURATION_INVALID: 400,
  INTEGRATION_CLEANING_INVALID: 400,
  INTEGRATION_MAPPING_INVALID: 422,
  INTEGRATION_MAPPING_INCOMPLETE: 422,
  INTEGRATION_MAPPING_UNKNOWN_COLUMN: 422,
  INTEGRATION_VERSION_NOT_FOUND: 404,
  // A Scraper Service lifecycle refusal is a governed answer, never a fault.
  SCRAPER_TASK_NOT_FOUND: 404,
  SCRAPER_TASK_NAME_INVALID: 400,
  SCRAPER_TASK_INVALID: 400,
  SCRAPER_TASK_UNREADABLE: 400,
  SCRAPER_NETWORK_SCOPE_NOT_APPROVED: 422,
  SCRAPER_CREDENTIAL_INVALID: 400,
  SCRAPER_CREDENTIAL_REQUIRED: 400,
  SCRAPER_CREDENTIAL_NOT_FOUND: 409,
  SCRAPER_COMPILATION_FAILED: 422,
  SCRAPER_PROPOSAL_NOT_FOUND: 404,
  SCRAPER_PROPOSAL_STALE: 409,
  SCRAPER_PROPOSAL_TAMPERED: 409,
  SCRAPER_PROPOSAL_DECIDED: 409,
  SCRAPER_VALIDATION_REQUIRED: 409,
  SCRAPER_VALIDATION_FAILED: 422,
  SCRAPER_NOT_APPROVED: 409,
  SCRAPER_ALREADY_PUBLISHED: 409,
  SCRAPER_NOT_PUBLISHED: 409,
  SCRAPER_VERIFICATION_REQUIRED: 409,
  SCRAPER_VERIFICATION_FAILED: 422,
  SCRAPER_ALREADY_ADOPTED: 409,
  SCRAPER_SOURCE_NOT_AVAILABLE: 404,
  SCRAPER_SOURCE_TYPE_UNSUPPORTED: 400,
  SCRAPER_SERVICE_VERSION_NOT_FOUND: 404,
  SCRAPER_REASON_INVALID: 400,
  SCRAPER_PARAMETERS_UNREADABLE: 400,
  SCRAPER_PARAMETER_INVALID: 400,
  SCRAPER_PARAMETER_UNKNOWN: 400,
  SCRAPER_PARAMETER_REQUIRED: 400,
  SCRAPER_SERVICE_NOT_ADOPTED: 409,
  SCRAPER_SERVICE_WITHDRAWN: 409,
  SCRAPER_SERVICE_TAMPERED: 409,
  SCRAPER_DIAGNOSTICS_NOT_FOUND: 404,
  SCRAPER_DIAGNOSTICS_TAMPERED: 409,
  SCRAPER_REPAIR_BINDING_NOT_FOUND: 404,
  SCRAPER_REPAIR_BINDING_REVOKED: 409,
  SCRAPER_REPAIR_PURPOSE_NOT_BOUND: 422,
  SCRAPER_REPAIR_MODEL_STALE: 409,
  SCRAPER_REPAIR_MODEL_NOT_ACTIVATED: 409,
  SCRAPER_REPAIR_STALE: 409,
  SCRAPER_REPAIR_FIXTURES_REQUIRED: 409,
  SCRAPER_REPAIR_OUTPUT_INVALID: 422,
  SCRAPER_REPAIR_FAILED: 422,
  // Declarative business API connections and connector Runs fail closed with
  // explicit codes; each maps to one status the browser can name in Chinese.
  CONNECTION_NAME_INVALID: 400,
  CONNECTION_CONFIGURATION_INVALID: 400,
  CONNECTION_CONFIGURATION_UNREADABLE: 400,
  CONNECTION_AUTH_UNSUPPORTED: 400,
  CONNECTION_CREDENTIAL_REQUIRED: 400,
  CONNECTION_NOT_AVAILABLE: 404,
  CONNECTION_VERSION_NOT_FOUND: 404,
  ACQUISITION_CONFIGURATION_INVALID: 400,
  ACQUISITION_CONFIGURATION_UNREADABLE: 400,
  ACQUISITION_VERSION_NOT_FOUND: 404,
  ACQUISITION_CONFIGURATION_NOT_ADOPTED: 409,
  ACQUISITION_RUN_NOT_FOUND: 404,
  ACQUISITION_RUN_NOT_CANCELLABLE: 409,
  ACQUISITION_QUEUE_EMPTY: 409,
  ACQUISITION_BACKFILL_INVALID: 400,
  ACQUISITION_CONNECTOR_NOT_APPLICABLE: 409,
  ACQUISITION_WORK_AT_INVALID: 400,
  ACQUISITION_SCHEDULE_AT_INVALID: 400,
  ACQUISITION_REQUEST_FAILED: 502,
  ACQUISITION_RESPONSE_STATUS: 502,
  ACQUISITION_RESPONSE_MALFORMED: 502,
  ACQUISITION_CONTENT_TYPE_UNEXPECTED: 422,
  ACQUISITION_PAGINATION_NOT_PROGRESSING: 422,
  ACQUISITION_PLAN_INCOMPLETE: 422,
  ACQUISITION_CHECKPOINT_CURSOR_INVALID: 409,
  ACQUISITION_AUTHENTICATION_INTERVENTION_REQUIRED: 409,
  ACQUISITION_AUTHENTICATION_REFRESH_BUSY: 409,
  ACQUISITION_SCHEMA_DRIFT: 422,
  ACQUISITION_PACING_RATE_EXCEEDED: 429,
  // An Artifact Proposal failure is a governed refusal, never a server fault.
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_EVIDENCE_UNREADABLE: 400,
  PROPOSAL_EVIDENCE_INVALID: 400,
  PROPOSAL_REQUIREMENT_UNREADABLE: 400,
  PROPOSAL_REQUIREMENT_INVALID: 400,
  PROPOSAL_CLARIFICATION_REQUIRED: 409,
  PROPOSAL_BINDING_NOT_FOUND: 404,
  PROPOSAL_BINDING_REVOKED: 409,
  PROPOSAL_PURPOSE_NOT_BOUND: 422,
  PROPOSAL_MODEL_STALE: 409,
  PROPOSAL_MODEL_NOT_ACTIVATED: 409,
  PROPOSAL_FIXTURES_UNREADABLE: 400,
  PROPOSAL_FIXTURES_INVALID: 400,
  PROPOSAL_PREVIEW_RAW_NOT_FOUND: 404,
  PROPOSAL_REASON_INVALID: 400,
  PROPOSAL_ALREADY_DECIDED: 409,
  PROPOSAL_VALIDATION_REQUIRED: 409,
  PROPOSAL_PREVIEW_REQUIRED: 409,
  PROPOSAL_BASE_STALE: 409,
  PROPOSAL_ALREADY_PUBLISHED: 409,
  PROPOSAL_NOT_APPROVED: 409,
  PROPOSAL_ALREADY_ADOPTED: 409,
  PROPOSAL_NOT_PUBLISHED: 409,
  PROPOSAL_TAMPERED: 409,
  // A Data Product Proposal failure is a governed refusal, never a server fault.
  PRODUCT_PROPOSAL_NOT_FOUND: 404,
  PRODUCT_PROPOSAL_REQUIREMENT_UNREADABLE: 400,
  PRODUCT_PROPOSAL_REQUIREMENT_INVALID: 400,
  PRODUCT_PROPOSAL_NAME_INVALID: 400,
  PRODUCT_PROPOSAL_CLARIFICATION_REQUIRED: 409,
  PRODUCT_PROPOSAL_BINDING_NOT_FOUND: 404,
  PRODUCT_PROPOSAL_BINDING_REVOKED: 409,
  PRODUCT_PROPOSAL_PURPOSE_NOT_BOUND: 422,
  PRODUCT_PROPOSAL_MODEL_STALE: 409,
  PRODUCT_PROPOSAL_MODEL_NOT_ACTIVATED: 409,
  PRODUCT_PROPOSAL_REASON_INVALID: 400,
  PRODUCT_PROPOSAL_ALREADY_DECIDED: 409,
  PRODUCT_PROPOSAL_VALIDATION_REQUIRED: 409,
  PRODUCT_PROPOSAL_PREVIEW_REQUIRED: 409,
  PRODUCT_PROPOSAL_BASE_STALE: 409,
  PRODUCT_PROPOSAL_ALREADY_PUBLISHED: 409,
  PRODUCT_PROPOSAL_NOT_APPROVED: 409,
  PRODUCT_PROPOSAL_TAMPERED: 409,
  PRODUCT_PROPOSAL_CANDIDATE_INVALID: 422,
  PRODUCT_PROPOSAL_METRIC_UNDEFINED: 422,
  PRODUCT_PROPOSAL_DATASET_UNAVAILABLE: 422,
  PRODUCT_PROPOSAL_GRAIN_NOT_UNIQUE: 422,
};

function sendFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof OperatorError) {
    sendJson(response, error.status ?? STATUS_BY_CODE[error.code] ?? 503, {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
    });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, {
      code: error.code,
      message: error.message,
      ...(error.nextStep === undefined ? {} : { next_step: error.nextStep }),
    });
    return;
  }
  sendJson(response, 500, {
    code: 'CONSOLE_REQUEST_FAILED',
    message: 'The Operator Console could not complete the request.',
  });
}
