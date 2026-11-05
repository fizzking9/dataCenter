/**
 * The generic declarative scraping engine.
 *
 * It knows nothing about any business case: a record selector, output columns,
 * page parameters, and an approved network scope are all the semantics there
 * are. Validation fixtures, live verification, and repeated Runs execute the
 * same functions, so a candidate that validated is the candidate that runs.
 */
import { createHash } from 'node:crypto';
import type {
  ScraperConstraints,
  ScraperDiagnostic,
  ScraperNetworkScope,
  ScraperOutput,
  ScraperOutputField,
  ScraperServiceContent,
  ScraperTarget,
} from './catalog.js';
import { egressRefusal } from './egress.js';

/** One element the selector matched, with its opening tag so attributes are readable. */
interface MatchedElement {
  open: string;
  inner: string;
}

export interface ExtractionOutcome {
  records: Array<Record<string, string>>;
  diagnostics: ScraperDiagnostic[];
}

/** A credential as a request presents it; the value never leaves this object. */
export interface ScraperCredentialMaterial {
  location: 'bearer' | 'cookie';
  cookie_name: string | null;
  value: string;
}

export interface ScraperPageReply {
  status: number;
  body: string;
  content_type: string | null;
  responseHash: string;
  responseBytes: number;
}

const SELECTOR = /^([a-zA-Z][a-zA-Z0-9-]*)(?:\.([A-Za-z0-9_-]+))?(?:@([a-zA-Z][a-zA-Z0-9:-]*))?$/u;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Whether one selector is well formed; validation reports the ones that are not. */
export function isValidSelector(selector: string): boolean {
  return SELECTOR.test(selector);
}

/** The element name, class token, and attribute a selector states. */
export function parseSelector(selector: string): { tag: string; className: string | null; attribute: string | null } | null {
  const match = SELECTOR.exec(selector);
  if (match === null) return null;
  return { tag: match[1]!, className: match[2] ?? null, attribute: match[3] ?? null };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&([a-z]+);/giu, (whole: string, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** The visible text of one HTML fragment, with markup and entities resolved. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();
}

function classMatches(openTag: string, className: string | null): boolean {
  if (className === null) return true;
  const match = /\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(openTag);
  const value = match?.[2] ?? match?.[3] ?? match?.[4] ?? '';
  return value.split(/\s+/u).includes(className);
}

/**
 * Every element one selector matches, in document order. Nesting is tracked by
 * depth, so a record's inner markup is exactly its own content.
 */
export function matchElements(html: string, selector: string): MatchedElement[] {
  const parsed = parseSelector(selector);
  if (parsed === null) return [];
  const opening = new RegExp(`<${parsed.tag}\\b[^>]*>`, 'giu');
  const token = new RegExp(`<(/?)${parsed.tag}\\b[^>]*>`, 'giu');
  const matches: MatchedElement[] = [];
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html)) !== null) {
    const open = match[0];
    if (!classMatches(open, parsed.className)) continue;
    if (open.endsWith('/>')) {
      matches.push({ open, inner: '' });
      continue;
    }
    const bodyStart = match.index + open.length;
    token.lastIndex = bodyStart;
    let depth = 1;
    let end = html.length;
    let inner: RegExpExecArray | null;
    while ((inner = token.exec(html)) !== null) {
      if (inner[1] === '/') {
        depth -= 1;
        if (depth === 0) {
          end = inner.index;
          break;
        }
      } else if (!inner[0].endsWith('/>')) {
        depth += 1;
      }
    }
    matches.push({ open, inner: html.slice(bodyStart, end) });
  }
  return matches;
}

/** The attribute value one opening tag states, or an empty string. */
function attributeOf(openTag: string, attribute: string): string {
  const match = new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(openTag);
  return decodeEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim();
}

/** One output column's value inside one record's markup. */
export function fieldValue(recordHtml: string, field: ScraperOutputField): string {
  const parsed = parseSelector(field.selector);
  if (parsed === null) return '';
  const element = matchElements(recordHtml, field.selector)[0];
  if (element === undefined) return '';
  return parsed.attribute === null ? textOf(element.inner) : attributeOf(element.open, parsed.attribute);
}

/**
 * Extracts the declared output from one page. A missing field is reported as a
 * diagnostic and left empty rather than guessed, so the output contract is
 * never silently widened.
 */
export function extractRecords(html: string, output: ScraperOutput, page: number): ExtractionOutcome {
  const diagnostics: ScraperDiagnostic[] = [];
  const containers = matchElements(html, output.record_selector);
  const records = containers.map((container) => {
    const record: Record<string, string> = {};
    for (const field of output.fields) {
      const value = fieldValue(container.inner, field);
      if (value === '') {
        diagnostics.push({
          code: 'SCRAPER_FIELD_EMPTY',
          page,
          message: `A record on page ${page} carries no value for the output field ${field.name}.`,
        });
      }
      record[field.name] = value;
    }
    return record;
  });
  return { records, diagnostics };
}

/** The path one target reads, with its declared placeholders resolved. */
export function resolveTargetPath(
  path: string,
  parameters: Record<string, string>,
): string | null {
  let refused = false;
  const resolved = path.replace(/\{([a-z][a-z0-9_]*)\}/gu, (whole: string, name: string) => {
    const value = parameters[name];
    if (value === undefined) {
      refused = true;
      return whole;
    }
    return encodeURIComponent(value);
  });
  return refused ? null : resolved;
}

/** One page request URL for a target, its resolved path, and the page number. */
export function pageUrl(
  target: ScraperTarget,
  parameters: Record<string, string>,
  page: number,
): string | null {
  const resolved = resolveTargetPath(target.path, parameters);
  if (resolved === null) return null;
  let url: URL;
  try {
    url = new URL(`${target.base_url}${resolved}`);
  } catch {
    return null;
  }
  if (target.page_parameter !== null) url.searchParams.set(target.page_parameter, String(page));
  if (target.page_size !== null && target.page_size_parameter !== null) {
    url.searchParams.set(target.page_size_parameter, String(target.page_size));
  }
  return url.toString();
}

/** The pages one attempt reads, in order, bounded before the first request. */
export function plannedPages(target: ScraperTarget): number[] {
  const pages: number[] = [];
  for (let index = 0; index < target.max_pages; index += 1) pages.push(target.first_page + index);
  return pages;
}

/** Whether one pathname sits under one of the approved path prefixes. */
export function pathAllows(paths: string[], pathname: string): boolean {
  return paths.some((prefix) => {
    if (prefix.endsWith('/')) return pathname.startsWith(prefix);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

/** Whether one URL is inside the approved network scope, origin first and then path. */
export function scopeAllows(scope: ScraperNetworkScope, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!scope.origins.includes(origin)) return false;
  return pathAllows(scope.paths, parsed.pathname);
}

/** The static part of a path template, before its first placeholder. */
export function staticPathPrefix(path: string): string {
  const placeholder = path.indexOf('{');
  return placeholder === -1 ? path : path.slice(0, placeholder);
}

/** What one page request produced, or the diagnostic that stopped it. */
export interface PageReadOutcome {
  reply: ScraperPageReply | null;
  diagnostic: ScraperDiagnostic | null;
  /** What the request really returned, whether or not it was accepted. */
  reading: ScraperPageReading;
}

/**
 * One raw page reading. It is kept in memory so a failure can be diagnosed with
 * the request and page evidence the attempt actually saw; only a sanitized
 * excerpt is ever recorded.
 */
export interface ScraperPageReading {
  status: number | null;
  content_type: string | null;
  body: string | null;
  response_hash: string | null;
  response_bytes: number | null;
}

function emptyReading(): ScraperPageReading {
  return { status: null, content_type: null, body: null, response_hash: null, response_bytes: null };
}

function credentialHeaders(material: ScraperCredentialMaterial[]): Record<string, string> {
  const headers: Record<string, string> = { accept: 'text/html' };
  const cookieParts: string[] = [];
  for (const credential of material) {
    if (credential.location === 'bearer') {
      headers['authorization'] = `Bearer ${credential.value}`;
      continue;
    }
    cookieParts.push(`${credential.cookie_name ?? 'token'}=${credential.value}`);
  }
  if (cookieParts.length > 0) headers['cookie'] = cookieParts.join('; ');
  return headers;
}

/**
 * Reads one page exactly once. A redirect is refused rather than followed, so a
 * target can never move the request outside the approved network scope.
 */
export async function readPage(options: {
  url: string;
  scope: ScraperNetworkScope;
  constraints: ScraperConstraints;
  credentials: ScraperCredentialMaterial[];
  page: number;
}): Promise<PageReadOutcome> {
  if (!scopeAllows(options.scope, options.url)) {
    return {
      reply: null,
      reading: emptyReading(),
      diagnostic: {
        code: 'SCRAPER_NETWORK_SCOPE_REFUSED',
        page: options.page,
        message: 'The page URL is outside the approved network scope of this Scraper Service.',
      },
    };
  }
  // A page is judged by address as well as by approved origin, so a target that
  // resolves into link-local or metadata space is never read.
  if (await egressRefusal(options.url) !== null) {
    return {
      reply: null,
      reading: emptyReading(),
      diagnostic: {
        code: 'SCRAPER_NETWORK_SCOPE_REFUSED',
        page: options.page,
        message: 'The page URL is a link-local or metadata target, which the approved network scope never covers.',
      },
    };
  }
  let response: Response;
  try {
    response = await fetch(options.url, {
      headers: credentialHeaders(options.credentials),
      redirect: 'error',
      signal: AbortSignal.timeout(options.constraints.timeout_ms),
    });
  } catch {
    return {
      reply: null,
      reading: emptyReading(),
      diagnostic: {
        code: 'SCRAPER_PAGE_REQUEST_FAILED',
        page: options.page,
        message: 'The target page could not be read within its declared timeout.',
      },
    };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
  const body = bytes.toString('utf8');
  const reading: ScraperPageReading = {
    status: response.status,
    content_type: declared,
    body,
    response_hash: createHash('sha256').update(bytes).digest('hex'),
    response_bytes: bytes.byteLength,
  };
  if (bytes.byteLength > options.constraints.max_bytes) {
    return {
      reply: null,
      reading: { ...reading, body: null },
      diagnostic: {
        code: 'SCRAPER_PAGE_TOO_LARGE',
        page: options.page,
        message: 'The target page exceeds the maximum bytes this Scraper Service permits.',
      },
    };
  }
  if (!response.ok) {
    return {
      reply: null,
      reading,
      diagnostic: {
        code: 'SCRAPER_PAGE_STATUS',
        page: options.page,
        message: `The target page answered with HTTP ${response.status}.`,
      },
    };
  }
  if (declared !== 'text/html') {
    return {
      reply: null,
      reading,
      diagnostic: {
        code: 'SCRAPER_PAGE_CONTENT_TYPE',
        page: options.page,
        message: 'The target page is not the text/html content this Scraper Service declares.',
      },
    };
  }
  return {
    reply: {
      status: response.status,
      body,
      content_type: declared,
      responseHash: reading.response_hash!,
      responseBytes: reading.response_bytes!,
    },
    reading,
    diagnostic: null,
  };
}

/** The columns one Service publishes, in their declared order. */
export function outputColumns(content: ScraperServiceContent): string[] {
  return content.output.fields.map((field) => field.name);
}
