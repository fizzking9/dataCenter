import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AcquisitionConnectionArtifact,
  AcquisitionConnectionVersion,
  AcquisitionPlanRecord,
  RawAcquisitionRecord,
  SourceAcquisitionVersion,
} from './catalog.js';
import { decrypt } from './keys.js';
import type { PlatformSession } from './session.js';

/** How long one page request may take before the attempt is a failed attempt. */
const PAGE_TIMEOUT_MS = 15_000;

export interface ConnectorOutcome {
  complete: boolean;
  errorCode: string | null;
  rawIds: string[];
}

/** Reads the array of records out of a response body at the configured path. */
function recordsAt(body: unknown, recordPath: string | null): unknown {
  if (recordPath === null) return body;
  let current: unknown = body;
  for (const segment of recordPath.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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

function pageUrl(
  connection: AcquisitionConnectionVersion,
  acquisition: SourceAcquisitionVersion,
  page: number,
): string {
  const url = new URL(`${connection.base_url}${acquisition.path}`);
  url.searchParams.set(connection.pagination.parameter, String(page));
  if (connection.pagination.size_parameter !== null) {
    url.searchParams.set(connection.pagination.size_parameter, String(connection.pagination.size));
  }
  return url.toString();
}

/**
 * Executes one Acquisition Plan against a declarative JSON endpoint.
 *
 * Every response is stored as its own immutable Raw Acquisition before it is
 * interpreted, so a partial attempt keeps exactly the bytes it read. The Plan is
 * durable before the first request and after every page, and only a Plan whose
 * every page completed may hand over an Integration Batch.
 */
export async function runConnector(options: {
  session: PlatformSession;
  plan: AcquisitionPlanRecord;
  connection: AcquisitionConnectionArtifact;
  connectionVersion: AcquisitionConnectionVersion;
  acquisition: SourceAcquisitionVersion;
}): Promise<ConnectorOutcome> {
  const { session, plan, connection, connectionVersion, acquisition } = options;
  const rawIds: string[] = [];
  let previousHash: string | null = null;
  const credential = connection.credential === null
    ? null
    : decrypt(session.dataKey, connection.credential).toString('utf8');
  const stop = (errorCode: string): ConnectorOutcome => ({ complete: false, errorCode, rawIds });

  for (let index = 0; index < connectionVersion.pagination.max_pages; index += 1) {
    const page = connectionVersion.pagination.start + index;
    let response: Response;
    try {
      response = await fetch(pageUrl(connectionVersion, acquisition, page), {
        headers: {
          accept: 'application/json',
          ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
    } catch {
      plan.pages.push({ page, raw_id: null, outcome: 'failed', record_count: null, error_code: 'ACQUISITION_REQUEST_FAILED' });
      session.save();
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
    rawIds.push(rawId);

    if (!response.ok) {
      plan.pages.push({ page, raw_id: rawId, outcome: 'failed', record_count: null, error_code: 'ACQUISITION_RESPONSE_STATUS' });
      session.save();
      return stop('ACQUISITION_RESPONSE_STATUS');
    }

    let body: unknown;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      plan.pages.push({ page, raw_id: rawId, outcome: 'failed', record_count: null, error_code: 'ACQUISITION_RESPONSE_MALFORMED' });
      session.save();
      return stop('ACQUISITION_RESPONSE_MALFORMED');
    }
    const records = recordsAt(body, acquisition.record_path);
    if (!Array.isArray(records)) {
      plan.pages.push({ page, raw_id: rawId, outcome: 'failed', record_count: null, error_code: 'ACQUISITION_RESPONSE_MALFORMED' });
      session.save();
      return stop('ACQUISITION_RESPONSE_MALFORMED');
    }

    // A page that repeats the previous one means the endpoint is not advancing;
    // paging on would only duplicate data, so the attempt stops and is partial.
    if (previousHash !== null && raw.content_hash === previousHash) {
      plan.pages.push({ page, raw_id: rawId, outcome: 'failed', record_count: records.length, error_code: 'ACQUISITION_PAGINATION_NOT_PROGRESSING' });
      session.save();
      return stop('ACQUISITION_PAGINATION_NOT_PROGRESSING');
    }
    previousHash = raw.content_hash;

    const done = isDone(acquisition, body, records.length, connectionVersion.pagination.size);
    plan.pages.push({
      page,
      raw_id: rawId,
      outcome: records.length === 0 ? 'empty' : 'received',
      record_count: records.length,
      error_code: null,
    });
    session.save();
    if (done) return { complete: true, errorCode: null, rawIds };
  }

  // The endpoint declared more pages than the Connection permits reading, so the
  // Plan is incomplete rather than silently truncated.
  return stop('ACQUISITION_PLAN_INCOMPLETE');
}
