import { readFileSync, writeFileSync } from 'node:fs';
import type { DocumentParseLimits } from './catalog.js';
import { parseDocumentBundle } from './document-bundle.js';

/**
 * The isolated half of document parsing.
 *
 * It runs in its own process, under an explicit heap and wall-clock budget the
 * host enforces, reads one bundle from stdin, and writes either the parsed
 * documents or one structured refusal to stdout. It holds no Platform state
 * and knows no Workspace, so a bundle can never reach a Grant or a Release from
 * here: it can only become text.
 */
const FAILED = 'DOCUMENT_PARSE_FAILED';

function answer(payload: unknown): void {
  // A synchronous write to fd 1 is complete before the process exits, so a
  // large bundle is never truncated by an unflushed stream.
  writeFileSync(1, JSON.stringify(payload));
}

let limits: DocumentParseLimits | null = null;
try {
  limits = JSON.parse(process.argv[2] ?? '') as DocumentParseLimits;
} catch {
  limits = null;
}
if (limits === null) {
  answer({ ok: false, code: FAILED, message: 'The isolated document parser was given no resource envelope.' });
} else {
  try {
    answer(parseDocumentBundle(readFileSync(0, 'utf8'), limits));
  } catch {
    answer({ ok: false, code: FAILED, message: 'The isolated document parser did not complete.' });
  }
}
