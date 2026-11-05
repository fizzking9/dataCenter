import type { DocumentParseLimits } from './catalog.js';

/** One document as a bundle states it: extracted text plus flat metadata. */
export interface ParsedDocument {
  /** Where inside the Raw Acquisition this document sits, as `document[1]`. */
  locator: string;
  fields: Record<string, string | number>;
}

export type DocumentBundleResult =
  | { ok: true; documents: ParsedDocument[] }
  | { ok: false; code: string; message: string };

/** The member carrying a document's extracted text; every other member is metadata. */
const TEXT_MEMBER = 'text';
const BUNDLE_MEMBERS = ['format', 'documents'];
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Markup and URI schemes that only ever mean something to a renderer or an
 * interpreter. A governed document is read as text, so a bundle that carries
 * any of them is refused rather than handed to something that might act on it.
 */
const ACTIVE_CONTENT = /<\s*!doctype\s+html|<\s*(?:html|head|body|script|style|iframe|object|embed|svg|math|template)\b|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

/** Members that would ask a document to be evaluated rather than read. */
const REFUSED_FIELDS = new Set([
  'formula', 'formulas', 'expression', 'expressions', 'script', 'scripts',
  'javascript', 'html', 'html_body', 'style', 'css', 'macro', 'macros',
  'vba', 'template', 'templates', 'eval', 'xpath', 'sql', 'query',
  'onclick', 'onload', 'onerror', 'onsubmit',
]);

const SHAPE = 'DOCUMENT_SHAPE_INVALID';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(code: string, message: string): DocumentBundleResult {
  return { ok: false, code, message };
}

/**
 * Parses one declared-text document bundle under an explicit envelope.
 *
 * This is the whole document format: a `format` of `text` and a `documents`
 * array whose members are one extracted text and flat metadata. Nothing here
 * renders, interprets, or evaluates a value — markup is refused outright, a
 * member that would need evaluating is refused by name, and every bound fails
 * closed with its own structured code rather than truncating the input.
 */
export function parseDocumentBundle(text: string, limits: DocumentParseLimits): DocumentBundleResult {
  if (Buffer.byteLength(text, 'utf8') > limits.max_bytes) {
    return refuse('DOCUMENT_CONTENT_TOO_LARGE', `A document bundle may hold at most ${limits.max_bytes} bytes.`);
  }
  if (ACTIVE_CONTENT.test(text)) {
    return refuse(
      'DOCUMENT_CONTENT_REFUSED',
      'A document bundle may carry no markup or active content; a document is read as text only.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(SHAPE, 'A document bundle must be a JSON object.');
  }
  if (!isRecord(parsed)) return refuse(SHAPE, 'A document bundle must be a JSON object.');

  const unexpected = Object.keys(parsed).filter((key) => !BUNDLE_MEMBERS.includes(key));
  if (unexpected.length > 0) {
    return refuse(SHAPE, `A document bundle states only ${BUNDLE_MEMBERS.join(' and ')}; it cannot state ${unexpected.join(', ')}.`);
  }
  const format = parsed['format'];
  if (typeof format !== 'string') return refuse(SHAPE, 'A document bundle must declare its format.');
  if (format !== 'text') {
    return refuse(
      'DOCUMENT_FORMAT_REFUSED',
      `A document bundle declares the text format, not ${format}; a rendering format has no governed meaning here.`,
    );
  }
  const documents = parsed['documents'];
  if (!Array.isArray(documents)) return refuse(SHAPE, 'A document bundle must state its documents as an array.');
  if (documents.length === 0) return refuse('DOCUMENT_BUNDLE_EMPTY', 'A document bundle must hold at least one document.');
  if (documents.length > limits.max_documents) {
    return refuse('DOCUMENT_BUNDLE_TOO_LARGE', `A document bundle may hold at most ${limits.max_documents} documents.`);
  }

  const curated: ParsedDocument[] = [];
  for (const [index, candidate] of documents.entries()) {
    if (!isRecord(candidate)) return refuse(SHAPE, `Document ${index + 1} must be an object.`);
    const metadata = Object.keys(candidate).filter((key) => key !== TEXT_MEMBER);
    if (metadata.length > limits.max_metadata_fields) {
      return refuse(
        SHAPE,
        `Document ${index + 1} states ${metadata.length} metadata fields, beyond the ${limits.max_metadata_fields} this Configuration permits.`,
      );
    }
    for (const key of metadata) {
      if (!FIELD_NAME.test(key)) {
        return refuse(SHAPE, `Document ${index + 1} states ${key}, which is not a metadata field name.`);
      }
      if (REFUSED_FIELDS.has(key.toLowerCase())) {
        return refuse(
          'DOCUMENT_CONTENT_REFUSED',
          `Document ${index + 1} states ${key}; a document is read as text and never evaluated.`,
        );
      }
    }
    const extracted = candidate[TEXT_MEMBER];
    if (typeof extracted !== 'string') {
      return refuse(SHAPE, `Document ${index + 1} must carry its extracted text in ${TEXT_MEMBER}.`);
    }
    if (extracted.length > limits.max_text_chars) {
      return refuse(
        'DOCUMENT_TEXT_TOO_LARGE',
        `Document ${index + 1} holds more than ${limits.max_text_chars} characters of text.`,
      );
    }

    const fields: Record<string, string | number> = { [TEXT_MEMBER]: extracted };
    for (const key of metadata) {
      const value = candidate[key];
      if (typeof value === 'string') {
        if (value.length > limits.max_text_chars) {
          return refuse(
            'DOCUMENT_TEXT_TOO_LARGE',
            `Document ${index + 1} holds more than ${limits.max_text_chars} characters in ${key}.`,
          );
        }
        fields[key] = value;
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        fields[key] = value;
        continue;
      }
      if (typeof value === 'boolean') {
        fields[key] = value ? 'true' : 'false';
        continue;
      }
      return refuse(SHAPE, `Document ${index + 1} states ${key}, which is not a flat metadata value.`);
    }
    curated.push({ locator: `document[${index + 1}]`, fields });
  }
  return { ok: true, documents: curated };
}
