import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DocumentParseLimits } from './catalog.js';
import type { DocumentBundleResult, ParsedDocument } from './document-bundle.js';

/** The compiled worker that parses a bundle outside this process. */
const WORKER = fileURLToPath(new URL('./document-worker.js', import.meta.url));
const FAILED = 'DOCUMENT_PARSE_FAILED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failed(message: string): DocumentBundleResult {
  return { ok: false, code: FAILED, message };
}

/** Rebuilds the worker's answer, so nothing outside the declared shape is trusted. */
function readAnswer(output: string): DocumentBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return failed('The isolated document parser answered nothing a reader can govern.');
  }
  if (!isRecord(parsed) || typeof parsed['ok'] !== 'boolean') {
    return failed('The isolated document parser answered nothing a reader can govern.');
  }
  if (parsed['ok'] === false) {
    const code = typeof parsed['code'] === 'string' ? parsed['code'] : FAILED;
    const message = typeof parsed['message'] === 'string' ? parsed['message'] : 'The document bundle was refused.';
    return { ok: false, code, message };
  }
  const documents = parsed['documents'];
  if (!Array.isArray(documents)) return failed('The isolated document parser answered no documents.');
  const curated: ParsedDocument[] = [];
  for (const candidate of documents) {
    if (!isRecord(candidate) || typeof candidate['locator'] !== 'string' || !isRecord(candidate['fields'])) {
      return failed('The isolated document parser answered a document it cannot govern.');
    }
    const fields: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(candidate['fields'])) {
      if (typeof value === 'string') {
        fields[key] = value;
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        fields[key] = value;
        continue;
      }
      return failed('The isolated document parser answered a value it cannot govern.');
    }
    curated.push({ locator: candidate['locator'], fields });
  }
  return { ok: true, documents: curated };
}

/**
 * Parses one document bundle in an isolated, resource-limited worker process.
 *
 * The bundle crosses the boundary as opaque bytes on stdin. The worker gets an
 * explicit heap ceiling and is killed when its wall-clock budget runs out, so
 * one hostile bundle can neither exhaust this process nor hold a request open.
 * Nothing is rendered and nothing is evaluated: a bundle carrying active
 * content was refused inside the worker. A worker that dies, overruns, or
 * answers outside its protocol fails closed with a structured error, so a
 * parser failure can never become curated results.
 */
export function parseDocumentBundleIsolated(text: string, limits: DocumentParseLimits): DocumentBundleResult {
  // The byte bound is enforced before anything reaches a parser at all.
  if (Buffer.byteLength(text, 'utf8') > limits.max_bytes) {
    return {
      ok: false,
      code: 'DOCUMENT_CONTENT_TOO_LARGE',
      message: `A document bundle may hold at most ${limits.max_bytes} bytes.`,
    };
  }
  const startedAt = Date.now();
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [`--max-old-space-size=${limits.max_heap_mb}`, WORKER, JSON.stringify(limits)],
      {
        input: text,
        encoding: 'utf8',
        timeout: limits.max_worker_ms,
        maxBuffer: Math.max(1_048_576, limits.max_bytes * 4),
      },
    );
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; status?: unknown };
    if (failure.code === 'ETIMEDOUT' || typeof failure.signal === 'string'
      || (failure.status === null && Date.now() - startedAt >= limits.max_worker_ms)) {
      return {
        ok: false,
        code: 'DOCUMENT_PARSE_TIMEOUT',
        message: `Parsing exceeded the ${limits.max_worker_ms}ms this Configuration permits.`,
      };
    }
    if (failure.code === 'ENOBUFS') {
      return {
        ok: false,
        code: 'DOCUMENT_CONTENT_TOO_LARGE',
        message: 'The parsed documents exceed the size this Configuration permits.',
      };
    }
    return failed('The isolated document parser did not complete.');
  }
  return readAnswer(output);
}
