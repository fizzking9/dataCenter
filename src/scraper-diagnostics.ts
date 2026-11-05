/**
 * Sanitized scraper failure diagnostics.
 *
 * A failing attempt is evidence, not a log dump: one immutable record names the
 * stage and category of every diagnostic, the request and page evidence the
 * attempt really saw, the Raw Acquisitions it kept, and the exact Task Version,
 * Service Version, engine, and fixtures that governed it. No credential value,
 * no request header value, and no unbounded page body is ever recorded.
 */
import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  DECLARATIVE_SCRAPER_ENGINE,
  type RawAcquisitionRecord,
  type ScraperDiagnosticCategory,
  type ScraperDiagnosticStage,
  type ScraperDiagnosticsRecord,
  type ScraperEvidencePage,
  type ScraperEvidenceRawRef,
  type ScraperEvidenceRequest,
  type ScraperFailureDiagnostic,
  type ScraperManifestPage,
  type ScraperServiceVersion,
  type ScraperTaskVersion,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { openPlatform, type PlatformSession } from './session.js';
import type { ScraperCredentialMaterial } from './scraper-engine.js';
import type { ScrapeAttempt, ScraperPageReadingRecord } from './scraper-run.js';

/** How many characters of one page an excerpt may carry. */
const EXCERPT_LENGTH = 4096;
const REDACTED = '[已隐去]';

/** The stage and category of every governed scraping diagnostic code. */
const DIAGNOSTIC_CLASSES: Record<string, { stage: ScraperDiagnosticStage; category: ScraperDiagnosticCategory }> = {
  SCRAPER_TARGET_UNRESOLVED: { stage: 'request', category: 'target_unresolved' },
  SCRAPER_NETWORK_SCOPE_REFUSED: { stage: 'request', category: 'network_scope' },
  SCRAPER_PAGE_REQUEST_FAILED: { stage: 'transport', category: 'request_failed' },
  SCRAPER_PAGE_STATUS: { stage: 'page', category: 'http_status' },
  SCRAPER_PAGE_CONTENT_TYPE: { stage: 'page', category: 'content_type' },
  SCRAPER_PAGE_TOO_LARGE: { stage: 'page', category: 'page_too_large' },
  SCRAPER_RECORD_LIMIT_EXCEEDED: { stage: 'extraction', category: 'record_limit' },
  SCRAPER_PAGE_LIMIT_REACHED: { stage: 'sequence', category: 'page_limit' },
  SCRAPER_FIELD_EMPTY: { stage: 'extraction', category: 'field_missing' },
};

export function diagnosticClass(code: string): { stage: ScraperDiagnosticStage; category: ScraperDiagnosticCategory } {
  return DIAGNOSTIC_CLASSES[code] ?? { stage: 'attempt', category: 'unknown' };
}

function redact(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.split(encoded).join(REDACTED);
  }
  return redacted;
}

/** One URL as evidence: no userinfo, no fragment, and no credential value. */
export function sanitizeUrl(url: string, secrets: string[]): string {
  let sanitized = url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    sanitized = parsed.toString();
  } catch {
    sanitized = url;
  }
  return redact(sanitized, secrets);
}

/** One bounded page excerpt: scripts and styles dropped, then secrets redacted. */
export function sanitizeExcerpt(body: string, secrets: string[]): { excerpt: string; truncated: boolean } {
  const withoutPrograms = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '');
  const redacted = redact(withoutPrograms, secrets);
  const truncated = redacted.length > EXCERPT_LENGTH;
  return { excerpt: truncated ? redacted.slice(0, EXCERPT_LENGTH) : redacted, truncated };
}

/** The request evidence one service presents; names and references only. */
function requestEvidence(
  url: string,
  service: ScraperServiceVersion,
  credentials: ScraperCredentialMaterial[],
  secrets: string[],
): ScraperEvidenceRequest {
  const headerNames = ['accept'];
  if (credentials.some((credential) => credential.location === 'bearer')) headerNames.push('authorization');
  if (credentials.some((credential) => credential.location === 'cookie')) headerNames.push('cookie');
  return {
    method: 'GET',
    url: sanitizeUrl(url, secrets),
    header_names: headerNames,
    credential_refs: [...service.content.credential_refs],
  };
}

function emptyPageEvidence(): ScraperEvidencePage {
  return {
    status: null,
    content_type: null,
    response_hash: null,
    response_bytes: null,
    body_excerpt: null,
    excerpt_truncated: false,
  };
}

/**
 * Builds the one immutable diagnosis of a failed attempt. The caller supplies
 * the exact versions the attempt ran under, so the record never restates them
 * from a later read.
 */
export function buildScraperDiagnostics(options: {
  workspaceId: string;
  sourceId: string | null;
  mode: 'run' | 'verification';
  actor: string;
  proposalId: string | null;
  attempt: ScrapeAttempt;
  taskId: string;
  serviceId: string;
  service: ScraperServiceVersion;
  taskVersion: ScraperTaskVersion;
  parameters: Record<string, string>;
  credentials: ScraperCredentialMaterial[];
  rawAcquisitions: RawAcquisitionRecord[];
  acquisitionRunId: string | null;
  manifestId: string | null;
}): ScraperDiagnosticsRecord {
  const secrets = options.credentials.map((credential) => credential.value).filter((value) => value.length > 0);
  const pages: ScraperManifestPage[] = options.attempt.pages;
  const readings = new Map<number, ScraperPageReadingRecord>();
  for (const reading of options.attempt.readings) readings.set(reading.page, reading);

  const rawRefOfPage = (page: number | null): ScraperEvidenceRawRef[] => {
    if (page === null) return [];
    const manifestPage = pages.find((candidate) => candidate.page === page);
    if (manifestPage === undefined || manifestPage.raw_id === null) return [];
    const raw = options.rawAcquisitions.find((candidate) => candidate.raw_id === manifestPage.raw_id);
    if (raw === undefined) return [];
    return [{ raw_id: raw.raw_id, content_hash: raw.content_hash, byte_length: raw.byte_length }];
  };

  const diagnostics: ScraperFailureDiagnostic[] = options.attempt.diagnostics.map((diagnostic) => {
    const classification = diagnosticClass(diagnostic.code);
    const read = diagnostic.page === null ? undefined : readings.get(diagnostic.page);
    const excerpt = read?.reading.body == null
      ? { excerpt: null, truncated: false }
      : (() => {
        const sanitized = sanitizeExcerpt(read.reading.body, secrets);
        return { excerpt: sanitized.excerpt, truncated: sanitized.truncated };
      })();
    return {
      code: diagnostic.code,
      stage: classification.stage,
      category: classification.category,
      page: diagnostic.page,
      message: redact(diagnostic.message, secrets),
      request: requestEvidence(
        read?.url ?? `${options.service.content.target.base_url}${options.service.content.target.path}`,
        options.service,
        options.credentials,
        secrets,
      ),
      page_evidence: read === undefined
        ? emptyPageEvidence()
        : {
          status: read.reading.status,
          content_type: read.reading.content_type,
          response_hash: read.reading.response_hash,
          response_bytes: read.reading.response_bytes,
          body_excerpt: excerpt.excerpt,
          excerpt_truncated: excerpt.truncated,
        },
      raw_refs: rawRefOfPage(diagnostic.page),
    };
  });

  const first = diagnostics[0];
  const classification = first === undefined
    ? { stage: 'attempt' as const, category: 'unknown' as const }
    : { stage: first.stage, category: first.category };
  const content = {
    diagnostics_id: randomUUID(),
    workspace_id: options.workspaceId,
    source_id: options.sourceId,
    mode: options.mode,
    acquisition_run_id: options.acquisitionRunId,
    manifest_id: options.manifestId,
    proposal_id: options.proposalId,
    recorded_at: new Date().toISOString(),
    recorded_by: options.actor,
    failure_code: first?.code ?? 'SCRAPER_ATTEMPT_FAILED',
    stage: classification.stage,
    category: classification.category,
    engine: { ...DECLARATIVE_SCRAPER_ENGINE },
    scraper_task_id: options.taskId,
    scraper_task_version: options.taskVersion.version,
    scraper_task_content_hash: options.taskVersion.content_hash,
    scraper_service_id: options.serviceId,
    scraper_service_version: options.service.version,
    scraper_service_content_hash: options.service.content_hash,
    fixtures_version: options.taskVersion.fixtures.version,
    fixtures_hash: options.taskVersion.fixtures_hash,
    parameters: { ...options.parameters },
    diagnostics,
    raw_refs: options.rawAcquisitions.map((raw) => ({
      raw_id: raw.raw_id,
      content_hash: raw.content_hash,
      byte_length: raw.byte_length,
    })),
  };
  return { ...content, evidence_hash: canonicalDigest(content) };
}

/** Appends one immutable diagnosis; the caller persists the session. */
export function storeScraperDiagnostics(
  session: PlatformSession,
  record: ScraperDiagnosticsRecord,
): ScraperDiagnosticsRecord {
  session.state.scraper_diagnostics.push(record);
  return record;
}

/** One diagnosis as read, with every evidence object copied. */
export function viewScraperDiagnostics(record: ScraperDiagnosticsRecord): Record<string, unknown> {
  return {
    diagnostics_id: record.diagnostics_id,
    workspace_id: record.workspace_id,
    source_id: record.source_id,
    mode: record.mode,
    acquisition_run_id: record.acquisition_run_id,
    manifest_id: record.manifest_id,
    proposal_id: record.proposal_id,
    recorded_at: record.recorded_at,
    recorded_by: record.recorded_by,
    failure_code: record.failure_code,
    stage: record.stage,
    category: record.category,
    engine: { ...record.engine },
    scraper_task_id: record.scraper_task_id,
    scraper_task_version: record.scraper_task_version,
    scraper_task_content_hash: record.scraper_task_content_hash,
    scraper_service_id: record.scraper_service_id,
    scraper_service_version: record.scraper_service_version,
    scraper_service_content_hash: record.scraper_service_content_hash,
    fixtures_version: record.fixtures_version,
    fixtures_hash: record.fixtures_hash,
    parameters: { ...record.parameters },
    diagnostics: record.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      request: {
        ...diagnostic.request,
        header_names: [...diagnostic.request.header_names],
        credential_refs: [...diagnostic.request.credential_refs],
      },
      page_evidence: { ...diagnostic.page_evidence },
      raw_refs: diagnostic.raw_refs.map((raw) => ({ ...raw })),
    })),
    raw_refs: record.raw_refs.map((raw) => ({ ...raw })),
    evidence_hash: record.evidence_hash,
  };
}

/**
 * Reads the diagnosis of one failed Run, one failed verification, or one
 * diagnosis identity. A Workspace Administrator of the owning Workspace alone
 * may read it.
 */
export function showScraperDiagnostics(options: {
  root: string;
  masterKey: string;
  token: string;
  diagnosticsId?: string;
  runId?: string;
  proposalId?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'scraper_diagnostics_read',
    scope: 'workspace',
    target: options.diagnosticsId ?? options.runId ?? options.proposalId ?? '',
  };
  const actor = resolveActor(session, options.token, context);
  const matches = session.state.scraper_diagnostics.filter((record) => {
    if (options.diagnosticsId !== undefined) return record.diagnostics_id === options.diagnosticsId;
    if (options.runId !== undefined) return record.acquisition_run_id === options.runId;
    if (options.proposalId !== undefined) return record.proposal_id === options.proposalId;
    return false;
  });
  const record = matches[matches.length - 1];
  if (record === undefined) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'SCRAPER_DIAGNOSTICS_NOT_FOUND',
      'No failure diagnosis is recorded for the requested attempt.',
      'Name the diagnosis, the failed Run, or the Proposal once its attempt has failed.',
    );
  }
  const scoped: ActionContext = { ...context, workspace_id: record.workspace_id, target: record.diagnostics_id };
  requireWorkspaceAdministrator(session, actor, scoped, record.workspace_id);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { failure_code: record.failure_code, diagnostics: record.diagnostics.length },
  });
  return { ...viewScraperDiagnostics(record), history_count: matches.length };
}
