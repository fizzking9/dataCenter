import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  DECLARATIVE_SCRAPER_ENGINE,
  findArtifactProposal,
  findModelBinding,
  findModelProfile,
  findModelProfileVersion,
  findScraperCredential,
  findScraperDiagnostics,
  findScraperServiceVersion,
  findScraperTask,
  findSource,
  latestScraperServiceVersion,
  latestScraperTaskVersion,
  scraperServiceForTask,
  type ArtifactProposalRecord,
  type ScraperDiagnostic,
  type ScraperDiagnosticsRecord,
  type ScraperFixturePage,
  type ScraperManifestPage,
  type ScraperPreviewFixture,
  type ScraperPreviewRecord,
  type ScraperProposalBase,
  type ScraperProposalCandidates,
  type ScraperProposalEvidence,
  type ScraperProposalProvenance,
  type ScraperProposalRecord,
  type ScraperRepairModelPin,
  type ScraperRepairRecord,
  type ScraperServiceArtifact,
  type ScraperServiceContent,
  type ScraperServiceVersion,
  type ScraperTaskVersion,
  type ScraperValidationCheck,
  type ScraperValidationFixture,
  type ScraperValidationRecord,
  type ScraperVerificationRecord,
  type SourceScraperServiceRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord } from './documents.js';
import { generateScraperRepairCandidate } from './model-generation.js';
import { pinnedForBinding } from './model-profile.js';
import { openPlatform, type PlatformSession } from './session.js';
import { buildScraperDiagnostics, storeScraperDiagnostics } from './scraper-diagnostics.js';
import {
  extractRecords,
  isValidSelector,
  parseSelector,
  pathAllows,
  scopeAllows,
  staticPathPrefix,
} from './scraper-engine.js';
import { credentialMaterial, resolveParameters, scrapeAttempt } from './scraper-run.js';
import { placeholdersOf, viewTask } from './scraper-task.js';
import { requireAdministeredSource } from './sources.js';

const REASON_MAXIMUM = 1000;
const TIMEOUT_CEILING_MS = 15_000;
const BYTE_CEILING = 8_388_608;
const RECORD_CEILING = 100_000;
const RESERVED_KEYS = ['credential', 'credentials', 'secret', 'sealed', 'password', 'token', 'authorization', 'cookie'];
/** How many extracted records one preview shows; the record count stays exact. */
const PREVIEW_RECORD_LIMIT = 20;

function digest(value: unknown): string {
  return canonicalDigest(value);
}

function findScraperProposal(
  proposals: ArtifactProposalRecord[],
  proposalId: string,
): ScraperProposalRecord | undefined {
  const proposal = findArtifactProposal(proposals, proposalId);
  return proposal !== undefined && proposal.kind === 'scraper' ? proposal : undefined;
}

/** The content address of every Proposal fact; a mismatch means tampering. */
function hashOf(proposal: {
  workspace_id: string;
  scraper_task_id: string;
  scraper_task_version: number;
  base: ScraperProposalBase;
  evidence: ScraperProposalEvidence;
  candidates: ScraperProposalCandidates;
  repair?: ScraperProposalRecord['repair'];
}): string {
  return digest({
    kind: 'scraper',
    workspace_id: proposal.workspace_id,
    scraper_task_id: proposal.scraper_task_id,
    scraper_task_version: proposal.scraper_task_version,
    base: proposal.base,
    evidence: proposal.evidence,
    candidates: proposal.candidates,
    // A Proposal compiled normally hashes exactly as it did before repairs
    // existed; a repair states what it repairs inside its own content address.
    ...(proposal.repair === null || proposal.repair === undefined ? {} : { repair: proposal.repair }),
  });
}

function statusOf(proposal: ScraperProposalRecord): string {
  if (proposal.adoptions.length > 0) return 'adopted';
  if (proposal.publications.length > 0) return 'published';
  const decision = proposal.decisions[proposal.decisions.length - 1];
  if (decision?.outcome === 'rejected') return 'rejected';
  if (decision?.outcome === 'approved') return 'approved';
  return 'pending';
}

/** The published Scraper Service Version a Proposal was compiled against, and whether it moved. */
function baseOf(session: PlatformSession, taskId: string): ScraperProposalBase {
  const service = scraperServiceForTask(session.state.scraper_services, taskId);
  const latest = latestScraperServiceVersion(service);
  return latest === undefined
    ? { scraper_service_id: null, scraper_service_version: null, scraper_service_content_hash: null }
    : {
      scraper_service_id: service!.scraper_service_id,
      scraper_service_version: latest.version,
      scraper_service_content_hash: latest.content_hash,
    };
}

function assertFresh(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  proposal: ScraperProposalRecord,
): void {
  const current = baseOf(session, proposal.scraper_task_id);
  if (
    current.scraper_service_id !== proposal.base.scraper_service_id
    || current.scraper_service_version !== proposal.base.scraper_service_version
    || current.scraper_service_content_hash !== proposal.base.scraper_service_content_hash
  ) {
    reject(
      session,
      actor,
      context,
      'SCRAPER_PROPOSAL_STALE',
      'The Scraper Service Version moved after this Proposal was compiled.',
      'Compile a new Proposal against the current Scraper Service Version; a stale Proposal cannot be approved, published, or adopted.',
    );
  }
}

function assertIntact(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  proposal: ScraperProposalRecord,
): void {
  if (proposal.proposal_hash !== hashOf(proposal)) {
    reject(session, actor, context, 'SCRAPER_PROPOSAL_TAMPERED', 'The Proposal record does not match its content address.');
  }
}

/** Any key that could hold a secret rather than a reference to one. */
function carriesSecret(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = carriesSecret(item, path);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_KEYS.includes(key.toLowerCase()) && key !== 'credential_refs') return `${path}${key}`;
    const found = carriesSecret(child, `${path}${key}.`);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The deterministic static checks every candidate clears before Approval. They
 * read declarations only: no target is contacted and no credential is opened.
 */
function staticChecks(content: ScraperServiceContent): ScraperValidationCheck[] {
  const checks: ScraperValidationCheck[] = [];
  const enginePassed = content.engine.name === DECLARATIVE_SCRAPER_ENGINE.name
    && content.engine.version === DECLARATIVE_SCRAPER_ENGINE.version;
  checks.push({
    name: 'engine:supported',
    passed: enginePassed,
    detail: enginePassed ? null : `Unsupported engine ${content.engine.name}/${content.engine.version}.`,
  });

  const scopeViolations: string[] = [];
  const targetOrigin = (() => {
    try {
      const url = new URL(content.target.base_url);
      return `${url.protocol}//${url.host}`;
    } catch {
      return '';
    }
  })();
  if (!content.network_scope.origins.includes(targetOrigin)) {
    scopeViolations.push(`target origin ${targetOrigin} is not approved`);
  }
  const prefix = staticPathPrefix(content.target.path);
  if (!pathAllows(content.network_scope.paths, prefix)) {
    scopeViolations.push(`target path ${prefix} is not approved`);
  }
  checks.push({
    name: 'network_scope:approved',
    passed: scopeViolations.length === 0,
    detail: scopeViolations.length === 0 ? null : scopeViolations.join('; '),
  });

  const parameterViolations: string[] = [];
  const declared = new Set(content.parameters.map((parameter) => parameter.name));
  for (const placeholder of placeholdersOf(content.target.path)) {
    if (!declared.has(placeholder)) parameterViolations.push(`undeclared placeholder ${placeholder}`);
  }
  for (const parameter of content.parameters) {
    if (parameter.type === 'integer' && parameter.default !== null && !/^-?\d+$/u.test(parameter.default)) {
      parameterViolations.push(`default of ${parameter.name} is not an integer`);
    }
  }
  checks.push({
    name: 'parameters:declared',
    passed: parameterViolations.length === 0,
    detail: parameterViolations.length === 0 ? null : parameterViolations.join('; '),
  });

  const outputViolations: string[] = [];
  const recordSelector = parseSelector(content.output.record_selector);
  if (!isValidSelector(content.output.record_selector) || recordSelector?.attribute !== null) {
    outputViolations.push('record selector is invalid');
  }
  for (const field of content.output.fields) {
    if (!isValidSelector(field.selector)) outputViolations.push(`selector of ${field.name} is invalid`);
  }
  if (content.output.fields.length === 0) outputViolations.push('output contract declares no field');
  checks.push({
    name: 'output:contract',
    passed: outputViolations.length === 0,
    detail: outputViolations.length === 0 ? null : outputViolations.join('; '),
  });

  const constraintViolations: string[] = [];
  if (content.constraints.timeout_ms < 100 || content.constraints.timeout_ms > TIMEOUT_CEILING_MS) {
    constraintViolations.push('timeout is outside its ceiling');
  }
  if (content.constraints.max_bytes < 1 || content.constraints.max_bytes > BYTE_CEILING) {
    constraintViolations.push('maximum bytes is outside its ceiling');
  }
  if (content.constraints.max_records < 1 || content.constraints.max_records > RECORD_CEILING) {
    constraintViolations.push('maximum records is outside its ceiling');
  }
  checks.push({
    name: 'constraints:within_limits',
    passed: constraintViolations.length === 0,
    detail: constraintViolations.length === 0 ? null : constraintViolations.join('; '),
  });

  const leaked = carriesSecret(content, '');
  checks.push({
    name: 'credentials:references_only',
    passed: leaked === null,
    detail: leaked === null ? null : `the candidate carries ${leaked} instead of a credential reference`,
  });
  return checks;
}

/** Runs the exact pinned fixtures and reports what the candidate produces from them. */
function fixtureChecks(
  content: ScraperServiceContent,
  task: ScraperTaskVersion,
): { checks: ScraperValidationCheck[]; fixtures: ScraperValidationFixture[] } {
  const failures: string[] = [];
  const fixtures: ScraperValidationFixture[] = [];
  const scopeViolations: string[] = [];
  for (const page of task.fixtures.pages) {
    const url = `${content.target.base_url}${page.path}`;
    if (!scopeAllows(content.network_scope, url)) {
      scopeViolations.push(`fixture ${page.name} reads outside the approved network scope`);
    }
  }
  for (const page of task.fixtures.pages) {
    const outcome = extractRecords(page.body, content.output, 1);
    const recordsHash = digest(outcome.records);
    fixtures.push({
      name: page.name,
      path: page.path,
      record_count: outcome.records.length,
      expected_record_count: page.expected_record_count,
      records_hash: recordsHash,
      body_hash: digest(page.body),
    });
    if (outcome.records.length !== page.expected_record_count) {
      failures.push(`${page.name} produced ${outcome.records.length} records instead of ${page.expected_record_count}`);
    }
    if (page.expected_records !== undefined) {
      const expected = digest(page.expected_records);
      if (expected !== recordsHash) failures.push(`${page.name} produced records other than the ones it pins`);
    }
  }
  const checks: ScraperValidationCheck[] = [
    {
      name: 'fixtures:scope',
      passed: scopeViolations.length === 0,
      detail: scopeViolations.length === 0 ? null : scopeViolations.join('; '),
    },
    {
      name: 'fixtures:output',
      passed: failures.length === 0,
      detail: failures.length === 0 ? null : failures.join('; '),
    },
  ];
  return { checks, fixtures };
}

/**
 * The checks only a repair must additionally clear: it keeps every fact of its
 * Task Version except the selectors it repairs, it stays inside the published
 * base's network and credential authority, it retains every base fixture
 * unchanged, and it really addresses the recorded failure.
 */
function repairChecks(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  proposal: ScraperProposalRecord,
  content: ScraperServiceContent,
  taskVersion: ScraperTaskVersion,
): ScraperValidationCheck[] {
  const repair = proposal.repair!;
  const baseService = findScraperServiceVersion(
    scraperServiceForTask(session.state.scraper_services, proposal.scraper_task_id),
    repair.base_service_version ?? -1,
  );
  if (!baseService) {
    reject(session, actorName, context, 'SCRAPER_SERVICE_VERSION_NOT_FOUND', 'The published Scraper Service Version this repair is based on no longer exists.');
  }
  const task = findScraperTask(session.state.scraper_tasks, proposal.scraper_task_id);
  const baseTaskVersion = task?.versions.find((candidate) => candidate.version === baseService.content.source_task.version);
  if (!baseTaskVersion) {
    reject(session, actorName, context, 'SCRAPER_TASK_NOT_FOUND', 'The Scraper Task Version this repair is based on no longer exists.');
  }
  const record = findScraperDiagnostics(session.state.scraper_diagnostics, repair.diagnostics_id);
  if (!record || record.evidence_hash !== repair.failure_evidence_hash) {
    reject(
      session,
      actorName,
      context,
      'SCRAPER_REPAIR_STALE',
      'The failure diagnosis this repair addresses is no longer recorded.',
      'Generate a new repair from the recorded failure diagnosis.',
    );
  }
  assertDiagnosticsIntact(session, actorName, context, record);

  const fidelity: string[] = [];
  if (digest(content.target) !== digest(taskVersion.target)) fidelity.push('target differs from its Scraper Task Version');
  if (digest(content.network_scope) !== digest(taskVersion.network_scope)) fidelity.push('network scope differs from its Scraper Task Version');
  if (digest(content.parameters) !== digest(taskVersion.parameters)) fidelity.push('run parameters differ from their Scraper Task Version');
  if (digest(content.constraints) !== digest(taskVersion.constraints)) fidelity.push('constraints differ from their Scraper Task Version');
  if (digest(content.credential_refs) !== digest(taskVersion.credential_refs)) fidelity.push('credential references differ from their Scraper Task Version');
  if (content.source_task.version !== taskVersion.version || content.source_task.content_hash !== taskVersion.content_hash) {
    fidelity.push('the candidate does not pin its Scraper Task Version');
  }
  if (content.fixtures.version !== taskVersion.fixtures.version || content.fixtures.hash !== taskVersion.fixtures_hash) {
    fidelity.push('the candidate does not pin its fixtures');
  }
  if (content.engine.name !== DECLARATIVE_SCRAPER_ENGINE.name || content.engine.version !== DECLARATIVE_SCRAPER_ENGINE.version) {
    fidelity.push('the candidate states another engine');
  }
  if (
    digest(content.output.fields.map((field) => field.name))
    !== digest(taskVersion.output.fields.map((field) => field.name))
  ) {
    fidelity.push('the repaired output columns differ from the declared ones');
  }
  const checks: ScraperValidationCheck[] = [{
    name: 'repair:task_fidelity',
    passed: fidelity.length === 0,
    detail: fidelity.length === 0 ? null : fidelity.join('; '),
  }];

  const scopeViolations: string[] = [];
  for (const origin of content.network_scope.origins) {
    if (!baseService.content.network_scope.origins.includes(origin)) scopeViolations.push(`origin ${origin} is outside the published base`);
  }
  for (const path of content.network_scope.paths) {
    if (!pathAllows(baseService.content.network_scope.paths, staticPathPrefix(path))) {
      scopeViolations.push(`path ${path} is outside the published base`);
    }
  }
  checks.push({
    name: 'network_scope:not_widened',
    passed: scopeViolations.length === 0,
    detail: scopeViolations.length === 0 ? null : scopeViolations.join('; '),
  });

  const widenedCredentials = content.credential_refs.filter(
    (ref) => !baseService.content.credential_refs.includes(ref),
  );
  checks.push({
    name: 'credentials:not_widened',
    passed: widenedCredentials.length === 0,
    detail: widenedCredentials.length === 0 ? null : `the repair adds the credential reference ${widenedCredentials.join(', ')}`,
  });

  const regression: string[] = [];
  for (const basePage of baseTaskVersion.fixtures.pages) {
    const retained = taskVersion.fixtures.pages.find((page) => page.name === basePage.name);
    if (!retained) {
      regression.push(`the base fixture ${basePage.name} was dropped`);
      continue;
    }
    // A controlled target change may replace the page body; it may never move
    // the page or weaken what the fixture requires the Service to produce.
    if (retained.path !== basePage.path) {
      regression.push(`the base fixture ${basePage.name} moved to ${retained.path}`);
    }
    if (
      retained.expected_record_count !== basePage.expected_record_count
      || digest(retained.expected_records ?? null) !== digest(basePage.expected_records ?? null)
    ) {
      regression.push(`the base fixture ${basePage.name} states different expected records`);
    }
  }
  checks.push({
    name: 'fixtures:regression',
    passed: regression.length === 0,
    detail: regression.length === 0 ? null : regression.join('; '),
  });

  const produces = (output: ScraperServiceContent['output'], page: ScraperFixturePage): boolean => {
    const outcome = extractRecords(page.body, output, 1);
    if (outcome.records.length !== page.expected_record_count) return false;
    if (page.expected_records !== undefined && digest(outcome.records) !== digest(page.expected_records)) return false;
    return true;
  };
  const addressed: string[] = [];
  const reproductions = taskVersion.fixtures.pages.filter((page) => !produces(baseService.content.output, page));
  for (const page of taskVersion.fixtures.pages) {
    if (!produces(content.output, page)) addressed.push(`the repair does not produce the pinned records of ${page.name}`);
  }
  if (reproductions.length === 0) {
    addressed.push('no versioned fixture reproduces the recorded failure, so the repair proves nothing');
  }
  checks.push({
    name: 'repair:addresses_failure',
    passed: addressed.length === 0,
    detail: addressed.length === 0 ? null : addressed.join('; '),
  });

  const changed = digest(content.output) !== digest(baseService.content.output);
  checks.push({
    name: 'repair:changes',
    passed: changed,
    detail: changed ? null : 'the repaired output is identical to the published base',
  });
  return checks;
}

/** Provenance restated by every Approval, Publication, verification, and Adoption. */
function provenanceOf(proposal: ScraperProposalRecord): ScraperProposalProvenance {
  const validation = proposal.validations[proposal.validations.length - 1];
  const previews = proposal.previews ?? [];
  const preview = previews[previews.length - 1];
  const verification = proposal.verifications[proposal.verifications.length - 1];
  return {
    engine: { ...proposal.candidates.service.engine },
    scraper_task_id: proposal.scraper_task_id,
    scraper_task_version: proposal.scraper_task_version,
    scraper_task_content_hash: proposal.evidence.task_hash,
    fixtures_hash: proposal.evidence.fixtures_hash,
    validation_hash: validation?.evidence_hash ?? '',
    preview_hash: preview?.evidence_hash ?? '',
    verification_hash: verification?.evidence_hash ?? '',
    candidate_content_hash: proposal.candidates.content_hash,
    proposal_hash: proposal.proposal_hash,
    repair: proposal.repair === null
      ? null
      : {
        base_service_version: proposal.repair.base_service_version,
        base_service_content_hash: proposal.repair.base_service_content_hash,
        base_task_version: proposal.repair.base_task_version,
        base_task_content_hash: proposal.repair.base_task_content_hash,
        diagnostics_id: proposal.repair.diagnostics_id,
        failure_evidence_hash: proposal.repair.failure_evidence_hash,
        failure_code: proposal.repair.failure_code,
        input_hash: proposal.repair.input_hash,
        model: { ...proposal.repair.model },
      },
  };
}

/** Resolves a Proposal the actor may read or change, refusing a tampered record. */
function requireScraperProposal(
  session: PlatformSession,
  actor: ReturnType<typeof resolveActor>,
  context: ActionContext,
  proposalId: string,
): ScraperProposalRecord {
  const actorName = actorLabel(actor.user);
  const proposal = findScraperProposal(session.state.artifact_proposals, proposalId);
  if (!proposal) {
    reject(session, actorName, context, 'SCRAPER_PROPOSAL_NOT_FOUND', 'The requested Scraper Proposal does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, proposal.workspace_id);
  // A Proposal compiled before repairs and previews existed reads as a plain one.
  proposal.repair ??= null;
  proposal.previews ??= [];
  assertIntact(session, actorName, { ...context, workspace_id: proposal.workspace_id }, proposal);
  return proposal;
}

function taskVersionOf(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  taskId: string,
  version: number | undefined,
): { task: ReturnType<typeof findScraperTask>; version: ScraperTaskVersion } {
  const task = findScraperTask(session.state.scraper_tasks, taskId);
  const taskVersion = version === undefined
    ? latestScraperTaskVersion(task)
    : task?.versions.find((candidate) => candidate.version === version);
  if (!task || !taskVersion) {
    reject(session, actor, context, 'SCRAPER_TASK_NOT_FOUND', 'The requested Scraper Task Version does not exist.');
  }
  return { task, version: taskVersion };
}

/**
 * Compiles one candidate Scraper Service Version from one exact Scraper Task
 * Version. Compilation is deterministic: the same Task Version always yields the
 * same candidate content address, and nothing is published or adopted.
 */
export function compileScraperService(options: {
  root: string;
  masterKey: string;
  token: string;
  taskId: string;
  taskVersion?: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_compilation', scope: 'workspace', target: options.taskId };
  const actor = resolveActor(session, options.token, context);
  const task = findScraperTask(session.state.scraper_tasks, options.taskId);
  if (!task) {
    reject(session, actorLabel(actor.user), context, 'SCRAPER_TASK_NOT_FOUND', 'The requested Scraper Task does not exist.');
  }
  const scoped: ActionContext = { ...context, workspace_id: task.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, task.workspace_id);
  const resolved = taskVersionOf(session, actorLabel(actor.user), scoped, task.scraper_task_id, options.taskVersion);
  const taskVersion = resolved.version;

  const service: ScraperServiceContent = {
    engine: { ...DECLARATIVE_SCRAPER_ENGINE },
    target: { ...taskVersion.target },
    network_scope: {
      origins: [...taskVersion.network_scope.origins],
      paths: [...taskVersion.network_scope.paths],
    },
    output: {
      record_selector: taskVersion.output.record_selector,
      fields: taskVersion.output.fields.map((field) => ({ ...field })),
    },
    parameters: taskVersion.parameters.map((parameter) => ({ ...parameter })),
    constraints: { ...taskVersion.constraints },
    credential_refs: [...taskVersion.credential_refs],
    source_task: { version: taskVersion.version, content_hash: taskVersion.content_hash },
    fixtures: { version: taskVersion.fixtures.version, hash: taskVersion.fixtures_hash },
  };
  const failed = staticChecks(service).filter((check) => !check.passed);
  if (failed.length > 0) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_COMPILATION_FAILED',
      `The Scraper Task cannot compile: ${failed.map((check) => `${check.name} (${check.detail ?? ''})`).join('; ')}.`,
      'Correct the Scraper Task Version and publish a new one before compiling.',
    );
  }

  const base = baseOf(session, task.scraper_task_id);
  const content = {
    service,
    content_hash: digest(service),
  };
  const evidence: ScraperProposalEvidence = {
    task_hash: taskVersion.content_hash,
    fixtures_version: taskVersion.fixtures.version,
    fixtures_hash: taskVersion.fixtures_hash,
    output_fields: taskVersion.output.fields.map((field) => field.name),
    network_scope: {
      origins: [...taskVersion.network_scope.origins],
      paths: [...taskVersion.network_scope.paths],
    },
    regression_fixtures: [],
  };
  const proposal: ScraperProposalRecord = {
    kind: 'scraper',
    proposal_id: randomUUID(),
    workspace_id: task.workspace_id,
    scraper_task_id: task.scraper_task_id,
    scraper_task_version: taskVersion.version,
    created_at: new Date().toISOString(),
    created_by: actorLabel(actor.user),
    created_by_user_id: actor.user.user_id,
    base,
    evidence,
    candidates: content,
    repair: null,
    proposal_hash: hashOf({
      workspace_id: task.workspace_id,
      scraper_task_id: task.scraper_task_id,
      scraper_task_version: taskVersion.version,
      base,
      evidence,
      candidates: content,
    }),
    validations: [],
    previews: [],
    verifications: [],
    decisions: [],
    publications: [],
    adoptions: [],
  };
  session.state.artifact_proposals.push(proposal);
  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      proposal_hash: proposal.proposal_hash,
      scraper_task_version: taskVersion.version,
      scraper_task_content_hash: taskVersion.content_hash,
      candidate_content_hash: content.content_hash,
      base_version: base.scraper_service_version ?? 0,
    },
  });
  session.save();
  return viewProposal(proposal);
}

/**
 * The Workspace Administrator's read of the whole scraper surface: Tasks and
 * the facts they pin, the stored credential references, published Service
 * Versions, and the exact Version each scraper Source pins. No credential value,
 * sealed secret, or object locator is among it.
 */
export function listScraperWorkspace(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'scraper_workspace_read',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });

  const tasks = session.state.scraper_tasks
    .filter((task) => task.workspace_id === options.workspaceId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.name.localeCompare(right.name))
    .map((task) => {
      const latest = latestScraperTaskVersion(task);
      const versions = task.versions.map((version) => ({
        scraper_task_version: version.version,
        content_hash: version.content_hash,
        published_at: version.published_at,
        fixtures_version: version.fixtures.version,
        fixtures_hash: version.fixtures_hash,
      }));
      return {
        scraper_task_id: task.scraper_task_id,
        name: task.name,
        created_at: task.created_at,
        version_count: task.versions.length,
        versions,
        ...(latest === undefined ? {} : viewTask(task, latest)),
      };
    });

  const services = session.state.scraper_services
    .filter((service) => service.workspace_id === options.workspaceId)
    .map((service) => ({
      scraper_service_id: service.scraper_service_id,
      scraper_task_id: service.scraper_task_id,
      name: service.name,
      versions: service.versions.map((version) => ({
        version: version.version,
        published_at: version.published_at,
        content_hash: version.content_hash,
        withdrawn_at: version.withdrawn_at,
        scraper_task_version: version.content.source_task.version,
        output_fields: version.content.output.fields.map((field) => field.name),
      })),
    }));

  const pins = session.state.source_scraper_services
    .filter((pin) => pin.workspace_id === options.workspaceId)
    .map((pin) => ({
      source_id: pin.source_id,
      source_name: findSource(session.state.sources, pin.source_id)?.name ?? null,
      scraper_service_id: pin.scraper_service_id,
      adopted_version: pin.adopted_version,
      content_hash: pin.content_hash,
      proposal_id: pin.proposal_id,
      adopted_at: pin.adopted_at,
    }));

  const credentials = session.state.scraper_credentials
    .filter((credential) => credential.workspace_id === options.workspaceId)
    .map((credential) => ({
      ref: credential.ref,
      location: credential.location,
      cookie_name: credential.cookie_name,
      created_at: credential.created_at,
    }));

  const sources = session.state.sources
    .filter((source) => source.workspace_id === options.workspaceId && source.type === 'scraper')
    .map((source) => ({ source_id: source.source_id, name: source.name }));

  return {
    workspace_id: options.workspaceId,
    tasks,
    services,
    pins,
    credentials,
    sources,
  };
}

/** One failure diagnosis as a list row: identity, stage, category, and versions. */
function diagnosticsSummary(record: ScraperDiagnosticsRecord): Record<string, unknown> {
  return {
    diagnostics_id: record.diagnostics_id,
    mode: record.mode,
    source_id: record.source_id,
    proposal_id: record.proposal_id,
    acquisition_run_id: record.acquisition_run_id,
    recorded_at: record.recorded_at,
    failure_code: record.failure_code,
    stage: record.stage,
    category: record.category,
    scraper_task_id: record.scraper_task_id,
    scraper_task_version: record.scraper_task_version,
    scraper_service_version: record.scraper_service_version,
    evidence_hash: record.evidence_hash,
  };
}

/**
 * Every Scraper Proposal of one Workspace with its evidence, plus the failure
 * diagnoses a repair can be generated from. A Proposal whose published base has
 * moved reads as stale rather than silently current.
 */
export function listScraperProposals(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'scraper_proposal_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded' });

  const proposals = session.state.artifact_proposals
    .filter((proposal): proposal is ScraperProposalRecord => proposal.kind === 'scraper' && proposal.workspace_id === options.workspaceId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((proposal) => {
      const current = baseOf(session, proposal.scraper_task_id);
      const fresh = current.scraper_service_id === proposal.base.scraper_service_id
        && current.scraper_service_version === proposal.base.scraper_service_version
        && current.scraper_service_content_hash === proposal.base.scraper_service_content_hash;
      return { ...viewProposal(proposal), fresh };
    });

  const diagnostics = session.state.scraper_diagnostics
    .filter((record) => record.workspace_id === options.workspaceId)
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at))
    .map(diagnosticsSummary);

  return { workspace_id: options.workspaceId, proposals, diagnostics };
}

/**
 * The isolated preview every candidate may run before Approval. It reads the
 * exact fixtures its Scraper Task Version pins and extracts the candidate's
 * output from them: no target is contacted, no credential is opened, and no
 * governed data is written.
 */
export function previewScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_preview', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PROPOSAL_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  const resolved = taskVersionOf(
    session,
    actorLabel(actor.user),
    scoped,
    proposal.scraper_task_id,
    proposal.scraper_task_version,
  );
  const taskVersion = resolved.version;
  if (
    taskVersion.content_hash !== proposal.evidence.task_hash
    || taskVersion.content_hash !== proposal.candidates.service.source_task.content_hash
    || taskVersion.fixtures_hash !== proposal.candidates.service.fixtures.hash
  ) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_PROPOSAL_STALE',
      'The Scraper Task Version moved after this Proposal was compiled.',
      'Compile a new Proposal against the current Scraper Task Version.',
    );
  }

  const fixtures: ScraperPreviewFixture[] = taskVersion.fixtures.pages.map((page) => {
    const outcome = extractRecords(page.body, proposal.candidates.service.output, 1);
    const matches = outcome.records.length === page.expected_record_count
      && (page.expected_records === undefined || digest(outcome.records) === digest(page.expected_records));
    return {
      name: page.name,
      path: page.path,
      record_count: outcome.records.length,
      expected_record_count: page.expected_record_count,
      matches,
      records: outcome.records.slice(0, PREVIEW_RECORD_LIMIT).map((record) => ({ ...record })),
      records_hash: digest(outcome.records),
    };
  });
  const passed = fixtures.every((fixture) => fixture.matches);
  const record: ScraperPreviewRecord = {
    previewed_at: new Date().toISOString(),
    previewed_by: actorLabel(actor.user),
    fixtures,
    passed,
    evidence_hash: digest({ proposal_hash: proposal.proposal_hash, fixtures }),
  };
  proposal.previews.push(record);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      passed,
      fixtures: fixtures.length,
      evidence_hash: record.evidence_hash,
      contacted_target: false,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    passed,
    fixtures,
    evidence_hash: record.evidence_hash,
  };
}


/** The Binding and activated Profile Version one repair generation runs under. */
function requireRepairBinding(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  bindingId: string,
  workspaceId: string,
): { bindingId: string; pin: ScraperRepairModelPin; pinned: ReturnType<typeof pinnedForBinding> } {
  const binding = findModelBinding(session.state.model_bindings, bindingId);
  if (!binding || binding.workspace_id !== workspaceId) {
    reject(session, actorName, context, 'SCRAPER_REPAIR_BINDING_NOT_FOUND', 'The Workspace Model Binding is not available for this Scraper Task.');
  }
  if (binding.revoked_at !== null) {
    reject(session, actorName, context, 'SCRAPER_REPAIR_BINDING_REVOKED', 'The Workspace Model Binding has been revoked.');
  }
  if (!binding.purposes.includes('scraper_repair')) {
    reject(
      session,
      actorName,
      context,
      'SCRAPER_REPAIR_PURPOSE_NOT_BOUND',
      'The Workspace Model Binding does not permit Scraper Service repair generation.',
    );
  }
  const profile = findModelProfile(session.state.model_profiles, binding.model_profile_id);
  const version = findModelProfileVersion(profile, binding.model_profile_version);
  if (!profile || !version || version.content_hash !== binding.model_profile_content_hash) {
    reject(session, actorName, context, 'SCRAPER_REPAIR_MODEL_STALE', 'The Bound Model Profile Version is no longer the one the Binding pinned.');
  }
  if (profile.activated_version !== version.version) {
    reject(session, actorName, context, 'SCRAPER_REPAIR_MODEL_NOT_ACTIVATED', 'The Bound Model Profile Version is no longer activated.');
  }
  const prompt = version.prompts.find((candidate) => candidate.id === 'scraper_repair');
  if (!prompt) {
    reject(session, actorName, context, 'SCRAPER_REPAIR_PURPOSE_NOT_BOUND', 'The Model Profile Version pins no Scraper Service repair prompt.');
  }
  return {
    bindingId: binding.binding_id,
    pinned: pinnedForBinding(session, profile, version, binding),
    pin: {
      model_profile_id: profile.model_profile_id,
      model_profile_version: version.version,
      model_profile_content_hash: version.content_hash,
      adapter: version.adapter,
      model_id: version.model_id,
      binding_id: binding.binding_id,
      prompt_id: 'scraper_repair',
      prompt_hash: prompt.hash,
    },
  };
}

/** A diagnosis that no longer matches its own content address cannot seed a repair. */
function assertDiagnosticsIntact(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  record: ScraperDiagnosticsRecord,
): void {
  const { evidence_hash: recorded, ...content } = record;
  if (recorded !== digest(content)) {
    reject(session, actorName, context, 'SCRAPER_DIAGNOSTICS_TAMPERED', 'The failure diagnosis does not match its content address.');
  }
}

/** The fixture pages a repair adds beside the retained base fixtures. */
function regressionFixtureNames(taskVersion: ScraperTaskVersion, baseVersion: ScraperTaskVersion): string[] {
  const baseNames = new Set(baseVersion.fixtures.pages.map((page) => page.name));
  return taskVersion.fixtures.pages
    .filter((page) => !baseNames.has(page.name))
    .map((page) => page.name);
}

/**
 * Generates one Scraper Service repair from one recorded failure.
 *
 * The candidate receives only the exact Task Version, the published base
 * Version it repairs, the sanitized diagnosis, and the versioned fixtures. It
 * answers with the output contract alone: the target, approved network scope,
 * run parameters, constraints, credential references, engine, and fixture pins
 * are the platform's, so a repair can neither widen its authority nor choose
 * another Task Version.
 */
export async function repairScraperService(options: {
  root: string;
  masterKey: string;
  token: string;
  diagnosticsId: string;
  bindingId: string;
  taskVersion: number;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_repair', scope: 'workspace', target: options.diagnosticsId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const record = findScraperDiagnostics(session.state.scraper_diagnostics, options.diagnosticsId);
  if (!record) {
    reject(session, actorName, context, 'SCRAPER_DIAGNOSTICS_NOT_FOUND', 'The requested failure diagnosis does not exist.');
  }
  const scoped: ActionContext = { ...context, workspace_id: record.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, record.workspace_id);
  assertDiagnosticsIntact(session, actorName, scoped, record);

  const task = findScraperTask(session.state.scraper_tasks, record.scraper_task_id);
  if (!task || task.workspace_id !== record.workspace_id) {
    reject(session, actorName, scoped, 'SCRAPER_TASK_NOT_FOUND', 'The Scraper Task this failure names no longer exists.');
  }
  const taskVersion = task.versions.find((candidate) => candidate.version === options.taskVersion);
  if (!taskVersion) {
    reject(session, actorName, scoped, 'SCRAPER_TASK_NOT_FOUND', 'The requested Scraper Task Version does not exist.');
  }
  const serviceArtifact = scraperServiceForTask(session.state.scraper_services, task.scraper_task_id);
  const baseService = findScraperServiceVersion(serviceArtifact, record.scraper_service_version);
  if (!serviceArtifact || !baseService) {
    reject(session, actorName, scoped, 'SCRAPER_SERVICE_VERSION_NOT_FOUND', 'The published Scraper Service Version this failure names no longer exists.');
  }
  if (
    baseService.content_hash !== record.scraper_service_content_hash
    || baseService.content.source_task.version !== record.scraper_task_version
    || baseService.content.source_task.content_hash !== record.scraper_task_content_hash
  ) {
    reject(session, actorName, scoped, 'SCRAPER_DIAGNOSTICS_TAMPERED', 'The failure diagnosis does not describe the published Scraper Service Version.');
  }
  const currentBase = baseOf(session, task.scraper_task_id);
  if (
    currentBase.scraper_service_version !== record.scraper_service_version
    || currentBase.scraper_service_content_hash !== record.scraper_service_content_hash
  ) {
    reject(
      session,
      actorName,
      scoped,
      'SCRAPER_REPAIR_STALE',
      'The Scraper Service Version moved after this failure was diagnosed.',
      'Diagnose a failure of the current Scraper Service Version before generating a repair.',
    );
  }
  const baseTaskVersion = task.versions.find(
    (candidate) => candidate.version === baseService.content.source_task.version,
  );
  if (!baseTaskVersion || baseTaskVersion.version === taskVersion.version) {
    reject(
      session,
      actorName,
      scoped,
      'SCRAPER_REPAIR_FIXTURES_REQUIRED',
      'A repair is generated against a newer Scraper Task Version that retains the base fixtures and adds the changed page.',
      'Publish a Scraper Task Version whose fixtures keep the base pages and pin the page the failure was recorded on.',
    );
  }
  const regressionFixtures = regressionFixtureNames(taskVersion, baseTaskVersion);
  if (regressionFixtures.length === 0) {
    reject(
      session,
      actorName,
      scoped,
      'SCRAPER_REPAIR_FIXTURES_REQUIRED',
      'The Scraper Task Version adds no regression fixture, so a repair could not prove it addresses the recorded failure.',
      'Add the changed page and its expected records to the Scraper Task Version fixtures.',
    );
  }

  const binding = requireRepairBinding(session, actorName, scoped, options.bindingId, task.workspace_id);
  // The exact isolated input: the Task, the base Version, the sanitized
  // diagnosis, and the fixtures. No credential value, no Raw Acquisition bytes,
  // and nothing from another Workspace is among it.
  const input = {
    task: {
      scraper_task_version: taskVersion.version,
      content_hash: taskVersion.content_hash,
      target: { ...taskVersion.target },
      network_scope: {
        origins: [...taskVersion.network_scope.origins],
        paths: [...taskVersion.network_scope.paths],
      },
      output: {
        record_selector: taskVersion.output.record_selector,
        fields: taskVersion.output.fields.map((field) => ({ ...field })),
      },
      parameters: taskVersion.parameters.map((parameter) => ({ ...parameter })),
      constraints: { ...taskVersion.constraints },
      credential_refs: [...taskVersion.credential_refs],
      fixtures: {
        version: taskVersion.fixtures.version,
        hash: taskVersion.fixtures_hash,
        pages: taskVersion.fixtures.pages.map((page) => ({ ...page })),
      },
    },
    base: {
      scraper_service_version: baseService.version,
      content_hash: baseService.content_hash,
      content: JSON.parse(JSON.stringify(baseService.content)) as Record<string, unknown>,
    },
    failure: {
      diagnostics_id: record.diagnostics_id,
      evidence_hash: record.evidence_hash,
      failure_code: record.failure_code,
      stage: record.stage,
      category: record.category,
      mode: record.mode,
      parameters: { ...record.parameters },
      diagnostics: record.diagnostics.map((diagnostic) => JSON.parse(JSON.stringify(diagnostic)) as Record<string, unknown>),
      raw_refs: record.raw_refs.map((raw) => ({ ...raw })),
    },
  };
  const repaired = await generateScraperRepairCandidate(binding.pinned, input, (code, message) => {
    reject(session, actorName, scoped, code, message);
  });
  const declared = new Set(taskVersion.output.fields.map((field) => field.name));
  if (
    repaired.fields.length !== taskVersion.output.fields.length
    || repaired.fields.some((field) => !declared.has(field.name))
  ) {
    reject(
      session,
      actorName,
      scoped,
      'SCRAPER_REPAIR_OUTPUT_INVALID',
      'A repaired output contract states exactly the output columns of its Scraper Task Version.',
      'Repair the selectors of the declared columns rather than adding or removing columns.',
    );
  }
  const output: ScraperServiceContent['output'] = {
    record_selector: repaired.record_selector,
    fields: taskVersion.output.fields.map((field) => ({
      name: field.name,
      selector: repaired.fields.find((candidate) => candidate.name === field.name)!.selector,
    })),
  };
  const service: ScraperServiceContent = {
    engine: { ...DECLARATIVE_SCRAPER_ENGINE },
    target: { ...taskVersion.target },
    network_scope: {
      origins: [...taskVersion.network_scope.origins],
      paths: [...taskVersion.network_scope.paths],
    },
    output,
    parameters: taskVersion.parameters.map((parameter) => ({ ...parameter })),
    constraints: { ...taskVersion.constraints },
    credential_refs: [...taskVersion.credential_refs],
    source_task: { version: taskVersion.version, content_hash: taskVersion.content_hash },
    fixtures: { version: taskVersion.fixtures.version, hash: taskVersion.fixtures_hash },
  };
  const failed = staticChecks(service).filter((check) => !check.passed);
  if (failed.length > 0) {
    reject(
      session,
      actorName,
      scoped,
      'SCRAPER_REPAIR_FAILED',
      `The repaired candidate is invalid: ${failed.map((check) => `${check.name} (${check.detail ?? ''})`).join('; ')}.`,
      'Generate a repair that states valid selectors for every declared output column.',
    );
  }

  const base = baseOf(session, task.scraper_task_id);
  const content = { service, content_hash: digest(service) };
  const evidence: ScraperProposalEvidence = {
    task_hash: taskVersion.content_hash,
    fixtures_version: taskVersion.fixtures.version,
    fixtures_hash: taskVersion.fixtures_hash,
    output_fields: taskVersion.output.fields.map((field) => field.name),
    network_scope: {
      origins: [...taskVersion.network_scope.origins],
      paths: [...taskVersion.network_scope.paths],
    },
    regression_fixtures: regressionFixtures,
  };
  const repair: ScraperRepairRecord = {
    base_service_version: base.scraper_service_version,
    base_service_content_hash: base.scraper_service_content_hash,
    base_task_version: baseTaskVersion.version,
    base_task_content_hash: baseTaskVersion.content_hash,
    diagnostics_id: record.diagnostics_id,
    failure_evidence_hash: record.evidence_hash,
    failure_code: record.failure_code,
    failure_stage: record.stage,
    failure_category: record.category,
    model: { ...binding.pin },
    input_hash: digest(input),
  };
  const proposal: ScraperProposalRecord = {
    kind: 'scraper',
    proposal_id: randomUUID(),
    workspace_id: task.workspace_id,
    scraper_task_id: task.scraper_task_id,
    scraper_task_version: taskVersion.version,
    created_at: new Date().toISOString(),
    created_by: actorName,
    created_by_user_id: actor.user.user_id,
    base,
    evidence,
    candidates: content,
    repair,
    proposal_hash: hashOf({
      workspace_id: task.workspace_id,
      scraper_task_id: task.scraper_task_id,
      scraper_task_version: taskVersion.version,
      base,
      evidence,
      candidates: content,
      repair,
    }),
    validations: [],
    previews: [],
    verifications: [],
    decisions: [],
    publications: [],
    adoptions: [],
  };
  session.state.artifact_proposals.push(proposal);
  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      proposal_hash: proposal.proposal_hash,
      diagnostics_id: record.diagnostics_id,
      failure_code: record.failure_code,
      base_service_version: base.scraper_service_version ?? 0,
      scraper_task_version: taskVersion.version,
      candidate_content_hash: content.content_hash,
      model_profile_id: binding.pin.model_profile_id,
      model_profile_version: binding.pin.model_profile_version,
      input_hash: repair.input_hash,
      regression_fixtures: regressionFixtures.length,
    },
  });
  session.save();
  return viewProposal(proposal);
}

/**
 * Validates the candidate against the exact fixtures its Task Version pins. The
 * checks read declarations and frozen fixtures only: no target is contacted and
 * no production credential is opened.
 */
export function validateScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_validation', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PROPOSAL_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  const resolved = taskVersionOf(
    session,
    actorLabel(actor.user),
    scoped,
    proposal.scraper_task_id,
    proposal.scraper_task_version,
  );
  const taskVersion = resolved.version;
  if (
    taskVersion.content_hash !== proposal.evidence.task_hash
    || taskVersion.content_hash !== proposal.candidates.service.source_task.content_hash
    || taskVersion.fixtures_hash !== proposal.candidates.service.fixtures.hash
  ) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_PROPOSAL_STALE',
      'The Scraper Task Version moved after this Proposal was compiled.',
      'Compile a new Proposal against the current Scraper Task Version.',
    );
  }
  const fixtures = fixtureChecks(proposal.candidates.service, taskVersion);
  const checks = [...staticChecks(proposal.candidates.service), ...fixtures.checks];
  if (proposal.repair !== null && proposal.repair !== undefined) {
    // A repair is held to the base it repairs: retained fixtures, the recorded
    // failure, and no widened network or credential authority.
    checks.push(...repairChecks(
      session,
      actorLabel(actor.user),
      scoped,
      proposal,
      proposal.candidates.service,
      taskVersion,
    ));
  }
  const passed = checks.every((check) => check.passed);
  const record: ScraperValidationRecord = {
    validated_at: new Date().toISOString(),
    validated_by: actorLabel(actor.user),
    checks,
    fixtures: fixtures.fixtures,
    passed,
    evidence_hash: digest({ proposal_hash: proposal.proposal_hash, checks, fixtures: fixtures.fixtures }),
  };
  proposal.validations.push(record);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      passed,
      checks: checks.length,
      failed_checks: checks.filter((check) => !check.passed).map((check) => check.name).join(', '),
      fixtures: fixtures.fixtures.length,
      evidence_hash: record.evidence_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    passed,
    checks,
    fixtures: fixtures.fixtures,
    evidence_hash: record.evidence_hash,
  };
}

/** Records one Workspace Administrator rejection of one exact Scraper Proposal. */
export function rejectScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  reason: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_rejection', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  const reason = options.reason.trim();
  if (reason.length === 0 || reason.length > REASON_MAXIMUM) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_REASON_INVALID', `A rejection reason must contain 1 to ${REASON_MAXIMUM} characters.`);
  }
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PROPOSAL_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  proposal.decisions.push({
    decided_at: new Date().toISOString(),
    decided_by: actor.user.user_id,
    actor: actorLabel(actor.user),
    outcome: 'rejected',
    reason,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { decision: 'rejected', proposal_hash: proposal.proposal_hash },
  });
  session.save();
  return { proposal_id: proposal.proposal_id, status: statusOf(proposal), reason };
}

/**
 * Records the mandatory human Approval. A Proposal reaches Approval only with a
 * passing validation on a base that has not moved; live verification happens
 * after Publication, never before Approval.
 */
export function approveScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_approval', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PROPOSAL_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  if (proposal.validations.length === 0) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_VALIDATION_REQUIRED',
      'A Scraper Proposal cannot be approved without validation evidence.',
      'Run scraper validate against the fixtures the Scraper Task Version pins.',
    );
  }
  const validation = proposal.validations[proposal.validations.length - 1]!;
  if (!validation.passed) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_VALIDATION_FAILED',
      'The candidate did not pass its static checks and versioned fixtures.',
      'Correct the Scraper Task Version and compile a new Proposal; a failed candidate cannot be approved.',
    );
  }
  assertFresh(session, actorLabel(actor.user), scoped, proposal);
  proposal.decisions.push({
    decided_at: new Date().toISOString(),
    decided_by: actor.user.user_id,
    actor: actorLabel(actor.user),
    outcome: 'approved',
    reason: null,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  const decision = proposal.decisions[proposal.decisions.length - 1]!;
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      decision: 'approved',
      proposal_hash: proposal.proposal_hash,
      validation_hash: decision.provenance.validation_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    decided_at: decision.decided_at,
    provenance: decision.provenance,
  };
}

/** Publishes the approved candidate as the next Scraper Service Version. */
export function publishScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_publication', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (proposal.publications.length > 0) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_ALREADY_PUBLISHED', 'This Proposal has already been published.');
  }
  if (statusOf(proposal) !== 'approved') {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_NOT_APPROVED',
      'Only an approved Proposal can be published.',
      'A Workspace Administrator must approve the Proposal first.',
    );
  }
  assertFresh(session, actorLabel(actor.user), scoped, proposal);
  if (digest(proposal.candidates.service) !== proposal.candidates.content_hash) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PROPOSAL_TAMPERED', 'The candidate does not match its content address.');
  }
  let artifact = scraperServiceForTask(session.state.scraper_services, proposal.scraper_task_id);
  const task = findScraperTask(session.state.scraper_tasks, proposal.scraper_task_id)!;
  if (!artifact) {
    artifact = {
      scraper_service_id: randomUUID(),
      workspace_id: proposal.workspace_id,
      scraper_task_id: proposal.scraper_task_id,
      name: task.name,
      owner_user_id: actor.user.user_id,
      created_at: new Date().toISOString(),
      versions: [],
    } satisfies ScraperServiceArtifact;
    session.state.scraper_services.push(artifact);
  }
  const version: ScraperServiceVersion = {
    version: (latestScraperServiceVersion(artifact)?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    content: proposal.candidates.service,
    content_hash: proposal.candidates.content_hash,
    withdrawn_at: null,
  };
  artifact.versions.push(version);
  proposal.publications.push({
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    actor: actorLabel(actor.user),
    scraper_service_version: version.version,
    content_hash: version.content_hash,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      scraper_service_id: artifact.scraper_service_id,
      scraper_service_version: version.version,
      content_hash: version.content_hash,
      proposal_hash: proposal.proposal_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    scraper_service_id: artifact.scraper_service_id,
    scraper_service_version: version.version,
    content_hash: version.content_hash,
  };
}

/**
 * Verifies the published Scraper Service Version against its real target.
 *
 * Verification runs after Approval and Publication, is isolated, and integrates
 * nothing: it stores no Raw Acquisition, no Integration Batch, no Dataset
 * Release, and it can only prevent Adoption, never cause it.
 */
export async function verifyScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  parametersPath?: string;
  /** Run parameters a browser stated directly; the same resolver validates them. */
  parameters?: unknown;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_verification', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  const publication = proposal.publications[proposal.publications.length - 1];
  if (!publication) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_NOT_PUBLISHED',
      'Live verification runs only after Approval and Publication.',
      'Approve and publish the Proposal first.',
    );
  }
  const serviceArtifact = scraperServiceForTask(session.state.scraper_services, proposal.scraper_task_id);
  const service = findScraperServiceVersion(serviceArtifact, publication.scraper_service_version);
  if (!service || !serviceArtifact) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_SERVICE_VERSION_NOT_FOUND', 'The published Scraper Service Version no longer exists.');
  }
  const resolved = taskVersionOf(
    session,
    actorLabel(actor.user),
    scoped,
    proposal.scraper_task_id,
    proposal.scraper_task_version,
  );
  let supplied: unknown = options.parameters;
  if (options.parametersPath !== undefined) {
    try {
      supplied = JSON.parse(readFileSync(options.parametersPath, 'utf8')) as unknown;
    } catch {
      reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PARAMETERS_UNREADABLE', 'The verification parameters must be a readable JSON document.');
    }
  }
  const parameters = resolveParameters(resolved.version, supplied, (code, message) => {
    reject(session, actorLabel(actor.user), scoped, code, message);
  });
  const credentials = credentialMaterial(session, proposal.workspace_id, service.content.credential_refs);
  if (credentials.missing !== null) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_CREDENTIAL_NOT_FOUND',
      `Live verification needs the stored credential ${credentials.missing}, which this Workspace does not hold.`,
      'Publish the credential reference, then verify against the real target.',
    );
  }

  const attempt = await scrapeAttempt({ service, parameters, credentials: credentials.material });
  // A page that answered but produced no contracted value is a failure too: the
  // published Version did not return the output contract it was approved for.
  const passed = attempt.complete && attempt.diagnostics.length === 0;
  const record: ScraperVerificationRecord = {
    verified_at: new Date().toISOString(),
    verified_by: actorLabel(actor.user),
    scraper_service_version: service.version,
    scraper_service_content_hash: service.content_hash,
    passed,
    pages: attempt.pages,
    record_count: attempt.record_count,
    diagnostics: attempt.diagnostics,
    evidence_hash: digest({
      proposal_hash: proposal.proposal_hash,
      scraper_service_version: service.version,
      scraper_service_content_hash: service.content_hash,
      pages: attempt.pages,
      diagnostics: attempt.diagnostics,
    }),
  };
  proposal.verifications.push(record);
  // Evidence is durable before the decision, so a failed verification is still
  // readable and every existing Source pin stays exactly where it was.
  session.save();
  if (!passed) {
    const diagnostics = storeScraperDiagnostics(
      session,
      buildScraperDiagnostics({
        workspaceId: proposal.workspace_id,
        sourceId: null,
        mode: 'verification',
        actor: actorLabel(actor.user),
        proposalId: proposal.proposal_id,
        attempt,
        taskId: proposal.scraper_task_id,
        serviceId: serviceArtifact.scraper_service_id,
        service,
        taskVersion: resolved.version,
        parameters,
        credentials: credentials.material,
        rawAcquisitions: [],
        acquisitionRunId: null,
        manifestId: null,
      }),
    );
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: {
        scraper_service_version: service.version,
        failure_code: diagnostics.failure_code,
        diagnostics_id: diagnostics.diagnostics_id,
        diagnostics_stage: diagnostics.stage,
        diagnostics_category: diagnostics.category,
      },
    });
    session.save();
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_VERIFICATION_FAILED',
      `Live verification failed: ${attempt.diagnostics.map((diagnostic) => diagnostic.code).join(', ') || 'SCRAPER_ATTEMPT_FAILED'}.`,
      'Adoption is refused until the published Version passes verification against its real target; read the diagnostics with scraper diagnostics --proposal.',
    );
  }
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      scraper_service_version: service.version,
      pages: attempt.pages.length,
      record_count: attempt.record_count,
      diagnostics: attempt.diagnostics.length,
      evidence_hash: record.evidence_hash,
      isolated: true,
      integrated: false,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    verification: {
      passed: record.passed,
      scraper_service_version: record.scraper_service_version,
      pages: record.pages.map((page) => ({ ...page })),
      record_count: record.record_count,
      diagnostics: record.diagnostics.map((diagnostic: ScraperDiagnostic) => ({ ...diagnostic })),
      verified_at: record.verified_at,
      evidence_hash: record.evidence_hash,
    },
    provenance: provenanceOf(proposal),
  };
}

/**
 * Binds one Source to exactly the published Scraper Service Version. Adoption is
 * a separate lifecycle fact from Approval and Publication, and it is refused
 * until the Version has passed its isolated live verification.
 */
export function adoptScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_adoption', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id, target: `${proposal.proposal_id}:${options.sourceId}` };
  if (proposal.adoptions.length > 0) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_ALREADY_ADOPTED', 'This Proposal has already been adopted.');
  }
  const publication = proposal.publications[proposal.publications.length - 1];
  if (!publication) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_NOT_PUBLISHED',
      'Only a published Proposal can be adopted.',
      'Publish the approved Proposal first.',
    );
  }
  const latest = latestScraperServiceVersion(
    scraperServiceForTask(session.state.scraper_services, proposal.scraper_task_id),
  );
  if (latest === undefined || latest.version !== publication.scraper_service_version) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_PROPOSAL_STALE',
      'The Scraper Service Version moved after this Proposal was published.',
      'Compile and approve a new Proposal against the current Scraper Service Version.',
    );
  }
  const verification = proposal.verifications[proposal.verifications.length - 1];
  if (!verification || verification.scraper_service_version !== publication.scraper_service_version) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_VERIFICATION_REQUIRED',
      'Adoption requires an isolated live verification of the published Version.',
      'Run scraper verify against the real target before adopting the Version.',
    );
  }
  if (!verification.passed) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_VERIFICATION_FAILED',
      'The published Scraper Service Version failed live verification, so it cannot be adopted.',
      'Repair the Scraper Task Version and compile a new Proposal; every existing Source pin stays as it was.',
    );
  }
  const source = requireAdministeredSource(session, actor, scoped, options.sourceId);
  if (source.workspace_id !== proposal.workspace_id) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_SOURCE_NOT_AVAILABLE', 'The Source is not available to this actor.');
  }
  if (source.type !== 'scraper') {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_SOURCE_TYPE_UNSUPPORTED',
      'Only a scraper Source can pin a Scraper Service Version.',
      'Create the Source as a scraper Source first.',
    );
  }
  const serviceArtifact = scraperServiceForTask(session.state.scraper_services, proposal.scraper_task_id);
  const service = findScraperServiceVersion(serviceArtifact, publication.scraper_service_version);
  if (!service || service.content_hash !== publication.content_hash || !serviceArtifact) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PROPOSAL_TAMPERED', 'The published Version does not match the approved candidate.');
  }
  const previous = session.state.source_scraper_services.find(
    (pin) => pin.source_id === source.source_id,
  );
  const previousVersion = previous?.adopted_version ?? null;
  const pin: SourceScraperServiceRecord = {
    source_id: source.source_id,
    workspace_id: source.workspace_id,
    scraper_service_id: serviceArtifact.scraper_service_id,
    adopted_version: service.version,
    content_hash: service.content_hash,
    proposal_id: proposal.proposal_id,
    adopted_at: new Date().toISOString(),
    adopted_by: actor.user.user_id,
  };
  if (previous === undefined) session.state.source_scraper_services.push(pin);
  else Object.assign(previous, pin);
  proposal.adoptions.push({
    adopted_at: pin.adopted_at,
    adopted_by: actor.user.user_id,
    actor: actorLabel(actor.user),
    source_id: source.source_id,
    scraper_service_version: service.version,
    previous_adopted_version: previousVersion,
    content_hash: service.content_hash,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      source_id: source.source_id,
      scraper_service_version: service.version,
      previous_adopted_version: previousVersion ?? 0,
      proposal_hash: proposal.proposal_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    source_id: source.source_id,
    adopted_version: service.version,
    previous_adopted_version: previousVersion,
    content_hash: service.content_hash,
  };
}

/** Reads one Scraper Proposal and its evidence. */
export function showScraperProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'scraper_proposal_read', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = requireScraperProposal(session, actor, context, options.proposalId);
  session.audit({
    ...context,
    workspace_id: proposal.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
  });
  return viewProposal(proposal);
}

function viewVerification(record: ScraperVerificationRecord): Record<string, unknown> {
  return {
    verified_at: record.verified_at,
    verified_by: record.verified_by,
    scraper_service_version: record.scraper_service_version,
    scraper_service_content_hash: record.scraper_service_content_hash,
    passed: record.passed,
    pages: record.pages.map((page: ScraperManifestPage) => ({ ...page })),
    record_count: record.record_count,
    diagnostics: record.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    evidence_hash: record.evidence_hash,
  };
}

function viewProposal(proposal: ScraperProposalRecord): Record<string, unknown> {
  return {
    proposal_id: proposal.proposal_id,
    kind: proposal.kind,
    status: statusOf(proposal),
    workspace_id: proposal.workspace_id,
    scraper_task_id: proposal.scraper_task_id,
    scraper_task_version: proposal.scraper_task_version,
    created_at: proposal.created_at,
    created_by: proposal.created_by,
    base: { ...proposal.base },
    evidence: {
      ...proposal.evidence,
      network_scope: {
        origins: [...proposal.evidence.network_scope.origins],
        paths: [...proposal.evidence.network_scope.paths],
      },
      regression_fixtures: [...(proposal.evidence.regression_fixtures ?? [])],
    },
    candidates: {
      service: {
        ...proposal.candidates.service,
        target: { ...proposal.candidates.service.target },
        network_scope: {
          origins: [...proposal.candidates.service.network_scope.origins],
          paths: [...proposal.candidates.service.network_scope.paths],
        },
        output: {
          record_selector: proposal.candidates.service.output.record_selector,
          fields: proposal.candidates.service.output.fields.map((field) => ({ ...field })),
        },
        parameters: proposal.candidates.service.parameters.map((parameter) => ({ ...parameter })),
        constraints: { ...proposal.candidates.service.constraints },
        credential_refs: [...proposal.candidates.service.credential_refs],
        source_task: { ...proposal.candidates.service.source_task },
        fixtures: { ...proposal.candidates.service.fixtures },
      },
      content_hash: proposal.candidates.content_hash,
    },
    repair: proposal.repair === null || proposal.repair === undefined
      ? null
      : { ...proposal.repair, model: { ...proposal.repair.model } },
    proposal_hash: proposal.proposal_hash,
    validations: proposal.validations.map((validation) => ({
      validated_at: validation.validated_at,
      validated_by: validation.validated_by,
      passed: validation.passed,
      checks: validation.checks.map((check) => ({ ...check })),
      fixtures: validation.fixtures.map((fixture) => ({ ...fixture })),
      evidence_hash: validation.evidence_hash,
    })),
    previews: (proposal.previews ?? []).map((preview) => ({
      previewed_at: preview.previewed_at,
      previewed_by: preview.previewed_by,
      passed: preview.passed,
      fixtures: preview.fixtures.map((fixture) => ({
        ...fixture,
        records: fixture.records.map((record) => ({ ...record })),
      })),
      evidence_hash: preview.evidence_hash,
    })),
    verifications: proposal.verifications.map(viewVerification),
    decisions: proposal.decisions.map((decision) => ({
      decided_at: decision.decided_at,
      decided_by: decision.decided_by,
      outcome: decision.outcome,
      reason: decision.reason,
      evidence_hash: decision.evidence_hash,
      provenance: { ...decision.provenance },
    })),
    publications: proposal.publications.map((publication) => ({
      published_at: publication.published_at,
      published_by: publication.published_by,
      scraper_service_version: publication.scraper_service_version,
      content_hash: publication.content_hash,
      evidence_hash: publication.evidence_hash,
      provenance: { ...publication.provenance },
    })),
    adoptions: proposal.adoptions.map((adoption) => ({
      adopted_at: adoption.adopted_at,
      adopted_by: adoption.adopted_by,
      source_id: adoption.source_id,
      scraper_service_version: adoption.scraper_service_version,
      previous_adopted_version: adoption.previous_adopted_version,
      evidence_hash: adoption.evidence_hash,
      provenance: { ...adoption.provenance },
    })),
  };
}
