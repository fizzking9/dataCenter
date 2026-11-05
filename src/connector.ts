import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AcquisitionConnectionArtifact,
  AcquisitionConnectionVersion,
  AcquisitionPlanPage,
  AcquisitionPlanRecord,
  RawAcquisitionRecord,
  SourceAcquisitionVersion,
} from './catalog.js';
import { assertConnectivityEnabled } from './backup.js';
import {
  AUTHENTICATION_INTERVENTION_REQUIRED,
  openConnectionAuth,
  rateAllows,
  recordRequest,
} from './connection-session.js';
import { valueAtPath } from './documents.js';
import type { PlatformSession } from './session.js';

/** How long one page request may take before the attempt is a failed attempt. */
const PAGE_TIMEOUT_MS = 15_000;

/** How many stored responses one Plan may keep before it is clearly misconfigured. */
const RAW_CEILING = 10_000;

export interface ConnectorOutcome {
  complete: boolean;
  errorCode: string | null;
  /** Every response kept as an immutable Raw Acquisition, including diagnostics. */
  rawIds: string[];
  /** Only the accepted page fragments, which are what an Integration Batch may hold. */
  batchIds: string[];
}

function isDone(
  acquisition: SourceAcquisitionVersion,
  body: unknown,
  recordCount: number,
  pageSize: number,
): boolean {
  const completion = acquisition.completion;
  if (completion.kind === 'empty_page') return recordCount === 0;
  if (completion.kind === 'short_page') return recordCount < pageSize;
  if (typeof body !== 'object' || body === null) return false;
  return (body as Record<string, unknown>)[completion.flag] === completion.done_value;
}

/** Reads a Retry-After header as milliseconds, accepting seconds and an HTTP date. */
export function retryAfterMs(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const instant = Date.parse(raw);
  if (!Number.isFinite(instant)) return null;
  return Math.max(0, instant - Date.now());
}

function backoffMs(attempt: number, base: number, maximum: number): number {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), maximum);
}

function pageUrl(
  connection: AcquisitionConnectionVersion,
  acquisition: SourceAcquisitionVersion,
  plan: AcquisitionPlanRecord,
  page: number,
  cursor: string | null,
): string {
  const url = new URL(`${connection.base_url}${acquisition.path}`);
  if (plan.window !== null) {
    url.searchParams.set(acquisition.window?.start_parameter ?? 'from', plan.window.start);
    const statedEnd = plan.window.end_inclusive
      ? new Date(Date.parse(plan.window.end) - 1).toISOString()
      : plan.window.end;
    url.searchParams.set(acquisition.window?.end_parameter ?? 'to', statedEnd);
  }
  if (connection.pagination.mode === 'cursor') {
    if (cursor !== null) url.searchParams.set(connection.pagination.parameter, cursor);
  } else {
    url.searchParams.set(connection.pagination.parameter, String(page));
  }
  if (connection.pagination.size_parameter !== null) {
    url.searchParams.set(connection.pagination.size_parameter, String(connection.pagination.size));
  }
  return url.toString();
}

/** True when the first non-whitespace byte proves the payload is markup, not JSON. */
function looksLikeMarkup(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x3c;
  }
  return false;
}

function declaredContentType(response: Response): string | null {
  const raw = response.headers.get('content-type');
  if (raw === null) return null;
  return raw.split(';')[0]?.trim().toLowerCase() ?? null;
}

/**
 * Executes one Acquisition Plan against a declarative JSON endpoint.
 *
 * Every response is stored as its own immutable Raw Acquisition before it is
 * interpreted, so a partial attempt keeps exactly the bytes it read. The Plan is
 * durable before the first request and after every page, and only a Plan whose
 * every page completed may hand over an Integration Batch. A rejected response
 * is diagnostic only: the accepted fragment of a page is the one an Integration
 * Batch receives, so no Batch ever mixes fragments across attempts.
 */
export async function runConnector(options: {
  session: PlatformSession;
  plan: AcquisitionPlanRecord;
  connection: AcquisitionConnectionArtifact;
  connectionVersion: AcquisitionConnectionVersion;
  acquisition: SourceAcquisitionVersion;
}): Promise<ConnectorOutcome> {
  const { session, plan, connection, connectionVersion, acquisition } = options;
  // A restored Deployment has no route to a Source until an Operator opens one.
  assertConnectivityEnabled(session.root);
  const rawIds: string[] = [];
  const batchIds: string[] = [];
  const retry = connectionVersion.retry;
  const auth = openConnectionAuth({ session, connection, version: connectionVersion });

  const refused = await auth.prepare();
  if (refused !== null) {
    return { complete: false, errorCode: refused, rawIds, batchIds };
  }
  session.save();

  const stop = (errorCode: string): ConnectorOutcome => ({ complete: false, errorCode, rawIds, batchIds });

  // An empty half-open window states that nothing is due; it is a complete
  // attempt with no page, not a failed one.
  if (plan.window !== null && Date.parse(plan.window.end) <= Date.parse(plan.window.start)) {
    return { complete: true, errorCode: null, rawIds, batchIds };
  }

  let previousHash: string | null = null;
  let cursor = connectionVersion.pagination.mode === 'cursor' ? plan.start_cursor : null;
  if (connectionVersion.pagination.mode === 'cursor' && cursor === null) {
    cursor = connectionVersion.pagination.initial_cursor;
  }
  const checkpointCursor = plan.start_cursor;

  for (let index = 0; index < connectionVersion.pagination.max_pages; index += 1) {
    const pageNumber = connectionVersion.pagination.start + index;
    const url = pageUrl(connectionVersion, acquisition, plan, pageNumber, cursor);
    const page: AcquisitionPlanPage = {
      page: pageNumber,
      raw_id: null,
      outcome: 'failed',
      record_count: null,
      error_code: null,
      attempts: 0,
      failed_attempts: [],
    };
    let attempt = 0;
    let replayed = false;
    const rejectPage = (errorCode: string): void => {
      page.attempts = attempt;
      page.outcome = 'failed';
      page.error_code = errorCode;
      plan.pages.push(page);
      session.save();
    };

    for (;;) {
      const at = new Date().toISOString();
      if (!rateAllows(session, connection, connectionVersion.pacing, at)) {
        rejectPage('ACQUISITION_PACING_RATE_EXCEEDED');
        return stop('ACQUISITION_PACING_RATE_EXCEEDED');
      }
      attempt += 1;
      recordRequest(session, connection, at);

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { accept: 'application/json', ...auth.headers() },
          redirect: 'error',
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
      } catch {
        page.failed_attempts.push({
          raw_id: null,
          status: null,
          error_code: 'ACQUISITION_REQUEST_FAILED',
          retry_after_ms: null,
        });
        if (attempt < retry.max_attempts) {
          await new Promise((resolve) => {
            setTimeout(resolve, backoffMs(attempt, retry.base_delay_ms, retry.max_delay_ms));
          });
          continue;
        }
        rejectPage('ACQUISITION_REQUEST_FAILED');
        return stop('ACQUISITION_REQUEST_FAILED');
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const rawId = randomUUID();
      const objectPath = `raw-acquisitions/${rawId}.bin`;
      mkdirSync(dirname(join(session.root, objectPath)), { recursive: true, mode: 0o700 });
      writeFileSync(join(session.root, objectPath), bytes, { flag: 'wx', mode: 0o600 });
      const raw: RawAcquisitionRecord = {
        raw_id: rawId,
        workspace_id: plan.workspace_id,
        source_id: plan.source_id,
        acquisition_run_id: plan.acquisition_run_id,
        content_hash: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.length,
        object_path: objectPath,
        received_at: new Date().toISOString(),
      };
      session.state.raw_acquisitions.push(raw);
      if (rawIds.length < RAW_CEILING) rawIds.push(rawId);

      if (response.status === 401 || response.status === 403) {
        page.failed_attempts.push({
          raw_id: rawId,
          status: response.status,
          error_code: AUTHENTICATION_INTERVENTION_REQUIRED,
          retry_after_ms: null,
        });
        // Exactly one replay: a second rejection is not a retry, it is an
        // operator's decision that this Connection may not read again.
        if (replayed) {
          auth.requireIntervention();
          rejectPage(AUTHENTICATION_INTERVENTION_REQUIRED);
          return stop(AUTHENTICATION_INTERVENTION_REQUIRED);
        }
        const refusal = await auth.refresh();
        if (refusal !== null) {
          rejectPage(refusal);
          return stop(refusal);
        }
        replayed = true;
        continue;
      }

      if (!response.ok) {
        const wait = retryAfterMs(response.headers.get('retry-after'));
        page.failed_attempts.push({
          raw_id: rawId,
          status: response.status,
          error_code: 'ACQUISITION_RESPONSE_STATUS',
          retry_after_ms: wait,
        });
        const retryable = retry.retry_on.includes(response.status);
        // A checkpoint cursor the endpoint refuses is drift, not a transient
        // failure: recovering means resetting the checkpoint, never guessing.
        if (
          index === 0
          && checkpointCursor !== null
          && [400, 409, 410, 422].includes(response.status)
        ) {
          rejectPage('ACQUISITION_CHECKPOINT_CURSOR_INVALID');
          return stop('ACQUISITION_CHECKPOINT_CURSOR_INVALID');
        }
        if (retryable && attempt < retry.max_attempts) {
          await new Promise((resolve) => {
            setTimeout(resolve, wait ?? backoffMs(attempt, retry.base_delay_ms, retry.max_delay_ms));
          });
          continue;
        }
        rejectPage('ACQUISITION_RESPONSE_STATUS');
        return stop('ACQUISITION_RESPONSE_STATUS');
      }

      // A declared content type is a promise the endpoint must keep, and the
      // bytes must still parse: neither the header alone nor the body alone is
      // trusted.
      const stated = declaredContentType(response);
      if (acquisition.content_type !== null && stated !== acquisition.content_type.toLowerCase()) {
        page.failed_attempts.push({
          raw_id: rawId,
          status: response.status,
          error_code: 'ACQUISITION_CONTENT_TYPE_UNEXPECTED',
          retry_after_ms: null,
        });
        rejectPage('ACQUISITION_CONTENT_TYPE_UNEXPECTED');
        return stop('ACQUISITION_CONTENT_TYPE_UNEXPECTED');
      }
      if (looksLikeMarkup(bytes)) {
        page.failed_attempts.push({
          raw_id: rawId,
          status: response.status,
          error_code: 'ACQUISITION_CONTENT_TYPE_UNEXPECTED',
          retry_after_ms: null,
        });
        rejectPage('ACQUISITION_CONTENT_TYPE_UNEXPECTED');
        return stop('ACQUISITION_CONTENT_TYPE_UNEXPECTED');
      }

      let body: unknown;
      try {
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        rejectPage('ACQUISITION_RESPONSE_MALFORMED');
        return stop('ACQUISITION_RESPONSE_MALFORMED');
      }
      const records = valueAtPath(body, acquisition.record_path);
      if (!Array.isArray(records)) {
        rejectPage('ACQUISITION_RESPONSE_MALFORMED');
        return stop('ACQUISITION_RESPONSE_MALFORMED');
      }

      // A page that repeats the previous one means the endpoint is not advancing;
      // paging on would only duplicate data, so the attempt stops and is partial.
      if (previousHash !== null && raw.content_hash === previousHash) {
        rejectPage('ACQUISITION_PAGINATION_NOT_PROGRESSING');
        return stop('ACQUISITION_PAGINATION_NOT_PROGRESSING');
      }
      previousHash = raw.content_hash;

      let nextCursor: string | null = null;
      if (connectionVersion.pagination.mode === 'cursor' && connectionVersion.pagination.cursor_path !== null) {
        const value = valueAtPath(body, connectionVersion.pagination.cursor_path);
        nextCursor = typeof value === 'string' && value.length > 0 ? value : null;
      }
      if (
        connectionVersion.pagination.mode === 'cursor'
        && nextCursor !== null
        && nextCursor === cursor
      ) {
        rejectPage('ACQUISITION_PAGINATION_NOT_PROGRESSING');
        return stop('ACQUISITION_PAGINATION_NOT_PROGRESSING');
      }

      const done = isDone(acquisition, body, records.length, connectionVersion.pagination.size);
      page.attempts = attempt;
      page.raw_id = rawId;
      page.outcome = records.length === 0 ? 'empty' : 'received';
      page.record_count = records.length;
      page.error_code = null;
      plan.pages.push(page);
      batchIds.push(rawId);
      plan.end_cursor = nextCursor;
      session.save();
      if (done) return { complete: true, errorCode: null, rawIds, batchIds };
      cursor = nextCursor;
      break;
    }
  }

  // The endpoint declared more pages than the Connection permits reading, so the
  // Plan is incomplete rather than silently truncated.
  return stop('ACQUISITION_PLAN_INCOMPLETE');
}
