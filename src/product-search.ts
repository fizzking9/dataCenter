import type { DataProductContract, DataProductSearch, DatasetRecordRow } from './catalog.js';

/**
 * One document a search matched, with the evidence its rank was computed from.
 * The record itself never leaves this module projected: the caller decides
 * which of its columns the Grant permits a Consumer to read.
 */
export interface SearchHit {
  record: DatasetRecordRow;
  score: number;
  matched: string[];
}

/** One value a suggest request completes to, and how many documents offer it. */
export interface SearchSuggestion {
  value: string;
  count: number;
}

/** An ASCII run is one word; a Han run is written without separators. */
const RUN = /[A-Za-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const WORD_ONLY = /^[A-Za-z0-9]+$/;
const HAN_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_CHARACTER = /[A-Za-z0-9]/;

/**
 * Splits text the one way this Release indexes it: an ASCII run becomes one
 * lowercased word, and a Han run becomes its sliding bigrams, because Han text
 * has no separators to split on. A one-character run stays a single token.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(RUN)) {
    const run = match[0];
    if (WORD_ONLY.test(run)) {
      tokens.push(run.toLowerCase());
      continue;
    }
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let start = 0; start + 1 < run.length; start += 1) {
      tokens.push(run.slice(start, start + 2));
    }
  }
  return tokens;
}

/**
 * Counts how many times a term occurs in one field. A term that carries a Han
 * character occurs wherever its characters occur, because Han text is written
 * without separators; an ASCII term occurs only as a whole word, so a term
 * never matches inside a longer word it was not stated as.
 */
function countOccurrences(text: string, term: string): number {
  if (term.length === 0) return 0;
  let count = 0;
  let at = text.indexOf(term);
  if (HAN_CHARACTER.test(term)) {
    while (at !== -1) {
      count += 1;
      at = text.indexOf(term, at + term.length);
    }
    return count;
  }
  while (at !== -1) {
    const before = at === 0 ? '' : text[at - 1] ?? '';
    const after = text[at + term.length] ?? '';
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) count += 1;
    at = text.indexOf(term, at + term.length);
  }
  return count;
}

/**
 * The distinct terms a query states, folded the way the index is. A term the
 * Contract is too short to index is dropped rather than matched loosely, so a
 * query that states only short terms answers nothing instead of everything.
 */
export function readSearchTerms(search: DataProductSearch, q: string): string[] {
  const terms: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const term = raw.trim();
    if (term.length === 0) continue;
    if ([...term].length < search.min_term_length) continue;
    const folded = term.toLowerCase();
    if (!terms.includes(folded)) terms.push(folded);
  }
  return terms;
}

/**
 * Scores every permitted record against the stated terms. The text field always
 * counts; the title field counts only when the Contract declares one and the
 * Grant permits it, so a hidden column never influences a rank.
 */
export function searchRecords(
  records: DatasetRecordRow[],
  search: DataProductSearch,
  terms: string[],
  permittedColumns: string[],
): SearchHit[] {
  if (!permittedColumns.includes(search.text_field)) return [];
  const titleName = search.title_field !== undefined && permittedColumns.includes(search.title_field)
    ? search.title_field
    : undefined;
  const hits: SearchHit[] = [];
  for (const record of records) {
    const text = record.values[search.text_field];
    if (typeof text !== 'string') continue;
    const body = text.toLowerCase();
    const title = titleName === undefined ? undefined : record.values[titleName];
    const heading = typeof title === 'string' ? title.toLowerCase() : undefined;
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const inText = countOccurrences(body, term);
      const inTitle = heading === undefined ? 0 : countOccurrences(heading, term);
      if (inText === 0 && inTitle === 0) continue;
      matched.push(term);
      score += inText * search.ranking.text_weight + inTitle * search.ranking.title_weight;
    }
    if (matched.length === 0) continue;
    hits.push({ record, score, matched });
  }
  return hits;
}

/** Compares two record values by their own type, never by a host locale. */
function compareValues(left: string | number | null, right: string | number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

/**
 * Score first, then the Contract's own grain, then the record's stable
 * identity: a total order, so the same query over the same Release can never
 * answer two orders and a page can always be resumed.
 */
export function orderSearchHits(hits: SearchHit[], contract: DataProductContract): SearchHit[] {
  return [...hits].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    for (const field of contract.grain) {
      const comparison = compareValues(left.record.values[field] ?? null, right.record.values[field] ?? null);
      if (comparison !== 0) return comparison;
    }
    if (left.record.identity === right.record.identity) return 0;
    return left.record.identity < right.record.identity ? -1 : 1;
  });
}

/**
 * Offers the values a prefix completes to. A suggestion is either a term the
 * index holds under a permitted suggest field, or a whole value that permitted
 * suggest field publishes — never a value drawn from a row or a column the
 * Grant withholds. Higher counts come first, then the value, so the answer is
 * a total order too.
 */
export function suggestValues(
  records: DatasetRecordRow[],
  search: DataProductSearch,
  prefix: string,
  permittedColumns: string[],
  limit: number,
): SearchSuggestion[] {
  const folded = prefix.toLowerCase();
  const counts = new Map<string, number>();
  for (const record of records) {
    const offered = new Set<string>();
    for (const field of search.suggest_fields) {
      if (!permittedColumns.includes(field)) continue;
      const value = record.values[field];
      if (typeof value !== 'string') continue;
      if (value.toLowerCase().startsWith(folded)) offered.add(value);
      for (const term of tokenize(value)) {
        if (term.startsWith(folded)) offered.add(term);
      }
    }
    for (const value of offered) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => (right[1] - left[1]) || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}
