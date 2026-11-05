import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import {
  findReport,
  findReportTemplate,
  findReportTemplateVersion,
  type DataProductContractVersion,
  type ReportCandidateRecord,
  type ReportCandidateStatus,
  type ReportCompletion,
  type ReportNarrative,
  type ReportProductReference,
  type ReportRecord,
  type ReportTemplateArtifact,
  type ReportTemplateVersion,
  type ReviewEmbeddingConfiguration,
  type ReviewSimilarityNomination,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord } from './documents.js';
import {
  LOCAL_EMBEDDING_CONFIGURATION,
  MAX_SIMILARITY_NOMINATIONS,
  SIMILARITY_NOMINATION_THRESHOLD,
  similarityScore,
} from './embeddings.js';
import { findUserById } from './platform.js';
import {
  completionOf,
  normalizeReportQuestion,
  reportView,
  templateVersionView,
} from './reports.js';
import { openPlatform, type PlatformSession } from './session.js';

/**
 * The Chinese grounded-answer prompt a candidate Template pins before any human
 * review. It is a platform default, not a business decision: the reviewer
 * approves or rejects the exact Template Version it belongs to.
 */
export const DEFAULT_CANDIDATE_GROUNDED_PROMPT = '只依据给定证据用简体中文撰写报告叙述，不得推测证据之外的数据或因果。';

/** The freshness a candidate Template pins until an administrator publishes it. */
export const DEFAULT_CANDIDATE_MAX_AGE_MINUTES = 15;

const GROUNDED_PROMPT = {
  id: 'grounded_answer' as const,
  body: DEFAULT_CANDIDATE_GROUNDED_PROMPT,
  hash: canonicalDigest({ id: 'grounded_answer', body: DEFAULT_CANDIDATE_GROUNDED_PROMPT }),
};

/** The content hash a candidate Report's optional narrative is grounded under. */
export const DEFAULT_CANDIDATE_GROUNDED_PROMPT_HASH = GROUNDED_PROMPT.hash;

/** The exact governed values one unmatched answer contributes to review. */
export interface ReviewCandidateInput {
  session: PlatformSession;
  workspaceId: string;
  userId: string;
  question: string;
  interpretation: string;
  request: Record<string, unknown>;
  /** The exact Product Release identity the answer read. */
  identity: Record<string, unknown>;
  result: Record<string, unknown>;
  provenance: Record<string, unknown>;
  freshness: Record<string, unknown> | null;
  narrative: ReportNarrative | null;
  /** The exact authorization the answer was generated under. */
  scope: { fingerprint: string; restricted: boolean; columns: string[]; row_filter_count: number };
  now: Date;
}

/** The outcome of one unmatched answer entering deduplicated review. */
export interface ReviewCandidateResult {
  candidate: ReportCandidateRecord;
  /** Whether this answer opened the review item or joined an existing one. */
  created: boolean;
}

function userNameOf(session: PlatformSession, userId: string): string | null {
  return findUserById(session.state, userId)?.username ?? null;
}

function identityReference(identity: Record<string, unknown>): ReportProductReference {
  const contractVersion = isRecord(identity['contract_version']) ? identity['contract_version'] : {};
  return {
    data_product_id: String(identity['data_product_id']),
    name: String(identity['name']),
    api_path: String(identity['api_path']),
    data_product_version: Number(identity['data_product_version']),
    data_product_release: Number(identity['data_product_release']),
    dataset_release: Number(identity['dataset_release']),
    contract_version: { ...contractVersion } as unknown as DataProductContractVersion,
    contract_hash: String(identity['contract_hash']),
  };
}

function templateNameOf(question: string): string {
  const name = `候选报告：${question}`;
  return name.length <= 128 ? name : name.slice(0, 128);
}

function templateContentHash(
  template: ReportTemplateArtifact,
  version: Omit<ReportTemplateVersion, 'content_hash'>,
): string {
  return canonicalDigest({
    question: version.question,
    normalized_question: version.normalized_question,
    interpretation: version.interpretation,
    parameters: version.parameters,
    data_product_id: version.data_product_id,
    contract_major: version.contract_major,
    request: version.request,
    grounded_prompt: version.grounded_prompt,
    freshness_policy: version.freshness_policy,
    owner_user_id: template.owner_user_id,
  });
}

/**
 * The similar Chinese QA pairs one new review item nominates. Similarity reads
 * only the same Workspace's published Template questions and other review
 * candidates; it never merges items, reuses stock, approves anything, or
 * carries authorization of its own.
 */
function nominationsFor(
  session: PlatformSession,
  workspaceId: string,
  question: string,
  exceptCandidateId: string | null,
): { configuration: ReviewEmbeddingConfiguration; threshold: number; nominations: ReviewSimilarityNomination[] } {
  const nominations: ReviewSimilarityNomination[] = [];
  for (const template of session.state.report_templates) {
    if (template.workspace_id !== workspaceId || template.published_version === null) continue;
    const version = findReportTemplateVersion(template, template.published_version);
    if (version === undefined || version.withdrawn_at !== null) continue;
    const score = similarityScore(question, version.question);
    if (score < SIMILARITY_NOMINATION_THRESHOLD) continue;
    nominations.push({
      kind: 'report_template',
      target_id: template.report_template_id,
      question: version.question,
      score,
    });
  }
  for (const candidate of session.state.report_candidates) {
    if (candidate.workspace_id !== workspaceId) continue;
    if (candidate.candidate_id === exceptCandidateId) continue;
    if (candidate.status === 'approved') continue;
    const score = similarityScore(question, candidate.question);
    if (score < SIMILARITY_NOMINATION_THRESHOLD) continue;
    nominations.push({
      kind: 'review_candidate',
      target_id: candidate.candidate_id,
      question: candidate.question,
      score,
    });
  }
  nominations.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return left.target_id < right.target_id ? -1 : 1;
  });
  return {
    configuration: { ...LOCAL_EMBEDDING_CONFIGURATION },
    threshold: SIMILARITY_NOMINATION_THRESHOLD,
    nominations: nominations.slice(0, MAX_SIMILARITY_NOMINATIONS),
  };
}

/** Records the one durable notification an open review item sends its reviewer. */
function notify(
  session: PlatformSession,
  candidate: ReportCandidateRecord,
  actor: string,
  reason: 'created' | 'reopened',
  at: Date,
): void {
  candidate.notification = { notified_at: at.toISOString(), reason };
  session.audit({
    action: 'report_candidate_notification',
    scope: 'workspace',
    workspace_id: candidate.workspace_id,
    target: candidate.candidate_id,
    actor,
    outcome: 'succeeded',
    detail: {
      reason,
      occurrence: candidate.occurrences,
      report_template_id: candidate.report_template_id,
      template_version: candidate.template_version,
      report_id: candidate.report_id,
    },
  });
}

/**
 * Enters one unmatched answer into deduplicated administrator review.
 *
 * The exact draft Template Version and the exact immutable Report are created
 * here, from what the deterministic engine and the grounded narrator already
 * produced, so a later Approval publishes them without rerunning a query or a
 * generation. Repeated normalized semantics (the same normalized question and
 * the same pinned query) share one open item and send no second notification.
 */
export function recordReviewCandidate(input: ReviewCandidateInput): ReviewCandidateResult {
  const { session } = input;
  const question = input.question;
  const normalized = normalizeReportQuestion(question);
  const semanticHash = canonicalDigest({
    normalized_question: normalized,
    data_product_id: String(input.identity['data_product_id']),
    request: input.request,
  });
  const at = input.now.toISOString();
  const actorName = userNameOf(session, input.userId) ?? input.userId;

  const existing = session.state.report_candidates.find(
    (candidate) => candidate.workspace_id === input.workspaceId
      && candidate.semantic_hash === semanticHash
      && candidate.status !== 'approved',
  );
  if (existing !== undefined) {
    existing.occurrences += 1;
    existing.last_seen_at = at;
    if (!existing.requested_by.includes(input.userId)) existing.requested_by.push(input.userId);
    // The shared item is a durable fact: the next listing must see the new
    // occurrence even though no notification is sent again.
    session.save();
    return { candidate: existing, created: false };
  }

  const template: ReportTemplateArtifact = {
    report_template_id: randomUUID(),
    workspace_id: input.workspaceId,
    name: templateNameOf(question),
    owner_user_id: input.userId,
    created_at: at,
    published_version: null,
    versions: [],
  };
  const version: ReportTemplateVersion = {
    version: 1,
    published_at: at,
    published_by: input.userId,
    question,
    normalized_question: normalized,
    interpretation: input.interpretation,
    parameters: [],
    data_product_id: String(input.identity['data_product_id']),
    contract_major: Number((input.identity['contract_version'] as unknown as DataProductContractVersion).major),
    request: { ...input.request },
    grounded_prompt: { ...GROUNDED_PROMPT },
    freshness_policy: { max_age_minutes: DEFAULT_CANDIDATE_MAX_AGE_MINUTES },
    content_hash: '',
    withdrawn_at: null,
    withdrawn_by: null,
  };
  version.content_hash = templateContentHash(template, version);
  template.versions.push(version);
  session.state.report_templates.push(template);

  const completion: ReportCompletion = completionOf(input.result);
  const report: ReportRecord = {
    report_id: randomUUID(),
    workspace_id: input.workspaceId,
    template: {
      report_template_id: template.report_template_id,
      name: template.name,
      version: version.version,
      content_hash: version.content_hash,
      owner_user_id: template.owner_user_id,
    },
    data_product: identityReference(input.identity),
    question,
    normalized_question: normalized,
    parameters: [],
    interpretation: input.interpretation,
    query: { ...input.request },
    result: input.result,
    narrative: input.narrative,
    provenance: input.provenance,
    freshness: input.freshness,
    completion,
    security: {
      scope_fingerprint: input.scope.fingerprint,
      restricted: input.scope.restricted,
      columns: [...input.scope.columns],
      row_filter_count: input.scope.row_filter_count,
    },
    freshness_policy: { ...version.freshness_policy },
    generated_at: at,
    generated_by: input.userId,
    withdrawn_at: null,
    withdrawn_by: null,
  };
  session.state.reports.push(report);

  const candidate: ReportCandidateRecord = {
    candidate_id: randomUUID(),
    workspace_id: input.workspaceId,
    status: 'open',
    question,
    normalized_question: normalized,
    semantic_hash: semanticHash,
    data_product_id: version.data_product_id,
    report_template_id: template.report_template_id,
    template_version: version.version,
    report_id: report.report_id,
    occurrences: 1,
    first_seen_at: at,
    last_seen_at: at,
    requested_by: [input.userId],
    similarity: nominationsFor(session, input.workspaceId, normalized, null),
    notification: null,
    approval: null,
    rejection: null,
  };
  session.state.report_candidates.push(candidate);
  notify(session, candidate, actorName, 'created', input.now);
  session.save();
  return { candidate, created: true };
}

function candidateView(
  session: PlatformSession,
  candidate: ReportCandidateRecord,
): Record<string, unknown> {
  return {
    candidate_id: candidate.candidate_id,
    workspace_id: candidate.workspace_id,
    status: candidate.status,
    question: candidate.question,
    normalized_question: candidate.normalized_question,
    semantic_hash: candidate.semantic_hash,
    data_product_id: candidate.data_product_id,
    report_template_id: candidate.report_template_id,
    template_version: candidate.template_version,
    report_id: candidate.report_id,
    occurrences: candidate.occurrences,
    first_seen_at: candidate.first_seen_at,
    last_seen_at: candidate.last_seen_at,
    requested_by: candidate.requested_by.map((userId) => ({
      user_id: userId,
      username: userNameOf(session, userId),
    })),
    similarity: {
      configuration: { ...candidate.similarity.configuration },
      threshold: candidate.similarity.threshold,
      nominations: candidate.similarity.nominations.map((nomination) => ({ ...nomination })),
    },
    notification: candidate.notification === null ? null : { ...candidate.notification },
    approval: candidate.approval === null ? null : { ...candidate.approval },
    rejection: candidate.rejection === null ? null : { ...candidate.rejection },
  };
}

function candidateStatusSummary(status: ReportCandidateStatus): string {
  if (status === 'approved') return '该候选已批准，审阅时的模板与报告已发布。';
  if (status === 'rejected') return '该候选已被拒绝，相同语义不再重复通知。';
  return '该候选等待工作空间管理员审核。';
}

/** Lists the deduplicated review items one Workspace Administrator governs. */
export function listReportCandidates(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_candidate_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const candidates = session.state.report_candidates
    .filter((candidate) => candidate.workspace_id === options.workspaceId)
    .map((candidate) => candidateView(session, candidate));
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { candidates_returned: candidates.length },
  });
  return {
    workspace_id: options.workspaceId,
    summary: `当前工作空间共有 ${candidates.length} 个报告候选，审核后才可作为库存答案复用。`,
    candidates,
  };
}

/** Shows one review item with the exact Template Version and Report under review. */
export function showReportCandidate(options: {
  root: string;
  masterKey: string;
  token: string;
  candidateId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_candidate_read',
    scope: 'workspace',
    target: options.candidateId,
  };
  const actor = resolveActor(session, options.token, context);
  const candidate = session.state.report_candidates.find((entry) => entry.candidate_id === options.candidateId);
  if (!candidate) {
    deny(session, actorLabel(actor.user), context, 'REPORT_CANDIDATE_NOT_AVAILABLE', 'The Report candidate is not available to this actor.');
  }
  requireWorkspaceAdministrator(session, actor, { ...context, workspace_id: candidate.workspace_id }, candidate.workspace_id);
  const template = findReportTemplate(session.state.report_templates, candidate.report_template_id);
  const version = findReportTemplateVersion(template, candidate.template_version);
  const report = findReport(session.state.reports, candidate.report_id);
  if (!template || !version || !report) {
    reject(
      session,
      actorLabel(actor.user),
      { ...context, workspace_id: candidate.workspace_id },
      'REPORT_CANDIDATE_EVIDENCE_MISSING',
      'The exact Template Version and Report this candidate reviewed are not present.',
    );
  }
  session.audit({
    ...context,
    workspace_id: candidate.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { candidate_status: candidate.status, template_version: version.version },
  });
  return {
    summary: candidateStatusSummary(candidate.status),
    candidate: candidateView(session, candidate),
    template: templateVersionView(session, template, version),
    report: reportView(report),
  };
}

/**
 * Approves one review candidate. Approval publishes the exact Template Version
 * and the exact Report the reviewer saw: nothing is regenerated, re-planned, or
 * re-narrated, and both artifacts keep the content hashes they were reviewed at.
 */
export function approveReportCandidate(options: {
  root: string;
  masterKey: string;
  token: string;
  candidateId: string;
  now?: Date;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_candidate_approval',
    scope: 'workspace',
    target: options.candidateId,
  };
  const actor = resolveActor(session, options.token, context);
  const candidate = session.state.report_candidates.find((entry) => entry.candidate_id === options.candidateId);
  if (!candidate) {
    reject(session, actorLabel(actor.user), context, 'REPORT_CANDIDATE_NOT_FOUND', 'The Report candidate does not exist.');
  }
  const scoped: ActionContext = { ...context, workspace_id: candidate.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, candidate.workspace_id);
  if (candidate.status === 'rejected') {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'REPORT_CANDIDATE_REJECTED',
      'A rejected candidate must be reopened before it can be approved.',
    );
  }
  const template = findReportTemplate(session.state.report_templates, candidate.report_template_id);
  const version = findReportTemplateVersion(template, candidate.template_version);
  const report = findReport(session.state.reports, candidate.report_id);
  if (!template || !version || !report) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_CANDIDATE_EVIDENCE_MISSING', 'The exact reviewed Template Version and Report are not present.');
  }
  if (version.withdrawn_at !== null) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_TEMPLATE_WITHDRAWN', 'The reviewed Template Version has been withdrawn.');
  }
  if (report.withdrawn_at !== null) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_WITHDRAWN', 'The reviewed Report has been withdrawn.');
  }
  if (template.published_version !== null && template.published_version !== version.version) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'REPORT_CANDIDATE_NOT_PUBLISHABLE',
      'The reviewed Template Version is not the one the Template would publish.',
    );
  }
  if (version.content_hash !== templateContentHash(template, version)) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_CANDIDATE_CONTENT_CHANGED', 'The reviewed Template content no longer matches its pinned hash.');
  }
  if (report.template.content_hash !== version.content_hash
    || report.template.report_template_id !== template.report_template_id
    || report.template.version !== version.version) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_CANDIDATE_CONTENT_CHANGED', 'The reviewed Report no longer matches its reviewed Template Version.');
  }
  if (candidate.status !== 'approved') {
    const decidedAt = (options.now ?? new Date()).toISOString();
    candidate.status = 'approved';
    candidate.approval = { decided_at: decidedAt, decided_by: actor.user.user_id, reason: null };
    template.published_version = version.version;
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: {
        report_id: report.report_id,
        report_template_id: template.report_template_id,
        template_version: version.version,
        regenerated: false,
      },
    });
    session.save();
  }
  return {
    summary: '已批准候选：审阅时的模板版本与报告原样发布，未重新执行查询，也未重新生成内容。',
    candidate: candidateView(session, candidate),
    template: templateVersionView(session, template, version),
    report: reportView(report),
  };
}

/** Rejects one review candidate; identical semantics stop notifying until reopening. */
export function rejectReportCandidate(options: {
  root: string;
  masterKey: string;
  token: string;
  candidateId: string;
  reason?: string;
  now?: Date;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_candidate_rejection',
    scope: 'workspace',
    target: options.candidateId,
  };
  const actor = resolveActor(session, options.token, context);
  const candidate = session.state.report_candidates.find((entry) => entry.candidate_id === options.candidateId);
  if (!candidate) {
    reject(session, actorLabel(actor.user), context, 'REPORT_CANDIDATE_NOT_FOUND', 'The Report candidate does not exist.');
  }
  const scoped: ActionContext = { ...context, workspace_id: candidate.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, candidate.workspace_id);
  if (candidate.status === 'approved') {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_CANDIDATE_APPROVED', 'An approved candidate is already published and cannot be rejected.');
  }
  if (candidate.status === 'open') {
    candidate.status = 'rejected';
    candidate.rejection = {
      decided_at: (options.now ?? new Date()).toISOString(),
      decided_by: actor.user.user_id,
      reason: options.reason?.trim() || null,
    };
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: { notification_suppressed: true },
    });
    session.save();
  }
  return {
    summary: '已拒绝候选：相同语义不再重复通知，重新开启或语义变化后才会再次进入审核。',
    candidate: candidateView(session, candidate),
  };
}

/** Reopens one rejected review candidate so a human may judge it again. */
export function reopenReportCandidate(options: {
  root: string;
  masterKey: string;
  token: string;
  candidateId: string;
  now?: Date;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_candidate_reopen',
    scope: 'workspace',
    target: options.candidateId,
  };
  const actor = resolveActor(session, options.token, context);
  const candidate = session.state.report_candidates.find((entry) => entry.candidate_id === options.candidateId);
  if (!candidate) {
    reject(session, actorLabel(actor.user), context, 'REPORT_CANDIDATE_NOT_FOUND', 'The Report candidate does not exist.');
  }
  const scoped: ActionContext = { ...context, workspace_id: candidate.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, candidate.workspace_id);
  if (candidate.status === 'approved') {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_CANDIDATE_APPROVED', 'An approved candidate is already published.');
  }
  if (candidate.status === 'rejected') {
    candidate.status = 'open';
    candidate.notification = null;
    notify(session, candidate, actorLabel(actor.user), 'reopened', options.now ?? new Date());
    session.save();
  }
  return {
    summary: '已重新开启候选审核，相同语义将重新进入审核通知。',
    candidate: candidateView(session, candidate),
  };
}
