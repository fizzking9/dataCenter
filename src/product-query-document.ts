import {
  ISO_DATE,
  ISO_TIMESTAMP,
  type DataProductContract,
  type DataProductMetric,
  type DataProductRelationship,
  type DataProductSearch,
  type DataProductTime,
  type DatasetSchemaField,
} from './catalog.js';
import { isRecord } from './documents.js';
import type { Fail } from './errors.js';
import { readSearchTerms } from './product-search.js';

export type QueryOperator =
  | 'equals'
  | 'not_equals'
  | 'less_than'
  | 'less_or_equal'
  | 'greater_than'
  | 'greater_or_equal'
  | 'is_null'
  | 'is_not_null';

/** The fixed typed operators a Consumer may state; nothing wider is composable. */
const OPERATORS: QueryOperator[] = [
  'equals', 'not_equals', 'less_than', 'less_or_equal',
  'greater_than', 'greater_or_equal', 'is_null', 'is_not_null',
];
const NULL_TESTS: QueryOperator[] = ['is_null', 'is_not_null'];

/** Keys a query may never carry: the Contract supports no arbitrary computation. */
export const REFUSED_KEYS = [
  'sql', 'query', 'expression', 'formula', 'join', 'joins',
  'relationship', 'relationships', 'select', 'where', 'having',
];

const RECORD_KEYS = ['kind', 'filters', 'limit', 'window', 'cursor', 'release', 'major', 'include'];
const AGGREGATE_KEYS = [
  'kind', 'group_by', 'metrics', 'filters', 'metric_filters',
  'include_totals', 'sort', 'limit', 'window', 'comparison', 'cursor', 'release', 'major', 'include',
];
/** A search reads the same page cursor and Release a record query does; a suggestion never pages. */
const SEARCH_KEYS = ['kind', 'q', 'limit', 'cursor', 'release', 'major'];
/** A query states the text it looks for; it never hands the platform a document to read. */
const MAX_QUERY_LENGTH = 1024;

/** A request the Query document itself cannot express, whatever the Contract says. */
const MALFORMED = 'DATA_PRODUCT_QUERY_INVALID';
/** A well-formed request the Contract does not permit. */
const REFUSED = 'DATA_PRODUCT_QUERY_REFUSED';

export interface QueryFilter {
  field: string;
  op: QueryOperator;
  value: string | number | null;
}

export interface MetricFilter {
  metric: string;
  op: QueryOperator;
  value: number | null;
}

export interface Window {
  start: string;
  end: string;
}

export interface SortClause {
  by: string;
  direction: 'asc' | 'desc';
}

/**
 * Which Release a query reads, and where inside its page sequence it continues.
 * The Release is resolved before the query is read, because the Contract the
 * query must satisfy is the one that Release was published with.
 */
export interface QueryTarget {
  release?: number;
  major?: number;
  cursor?: string;
}

export type ParsedQuery =
  | { kind: 'records'; filters: QueryFilter[]; limit: number; window?: Window; include: IncludeSpec[] }
  | {
    kind: 'search';
    /** The capability the Contract declared, already proven to exist. */
    search: DataProductSearch;
    terms: string[];
    limit: number;
  }
  | { kind: 'suggest'; search: DataProductSearch; q: string; limit: number }
  | {
    kind: 'aggregate';
    groupBy: string[];
    metrics: DataProductMetric[];
    /** Whether the query named its metrics, or took every metric the Contract publishes. */
    metricsExplicit: boolean;
    filters: QueryFilter[];
    metricFilters: MetricFilter[];
    includeTotals: boolean;
    sort: SortClause[];
    limit: number;
    window?: Window;
    comparison?: Window;
  };

/**
 * One declared relationship a record query asked to read, with the filters it
 * states over that linked record set. The relationship was already proven to be
 * one the Contract publishes under exactly this name.
 */
export interface IncludeSpec {
  relationship: DataProductRelationship;
  filters: QueryFilter[];
}

/**
 * Refuses every member the query language does not define. Arbitrary SQL, a
 * Consumer formula, or a join is named for what it is, so the refusal says why
 * the request has no governed meaning rather than merely that a key is unknown.
 */
function readShape(parsed: Record<string, unknown>, allowed: string[], kind: string, fail: Fail): void {
  for (const key of Object.keys(parsed)) {
    if (allowed.includes(key)) continue;
    if (REFUSED_KEYS.includes(key)) {
      fail(
        MALFORMED,
        `A ${kind} query cannot state ${key}; the Data Product Contract supports no arbitrary SQL, formula, or join.`,
      );
    }
    fail(MALFORMED, `${key} is not a part of a ${kind} query.`);
  }
}

function acceptsValue(field: DatasetSchemaField, value: unknown): value is string | number {
  if (field.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'date') return typeof value === 'string' && ISO_DATE.test(value);
  if (field.type === 'timestamp') return typeof value === 'string' && ISO_TIMESTAMP.test(value);
  return typeof value === 'string';
}

/**
 * Reads the typed filters a query states over one governed record set. A filter
 * must name a filter that surface permits and state a value the field's own type
 * can hold, so a string standing in for a number never silently matches nothing.
 */
function readFilterList(
  raw: unknown,
  allowed: string[],
  schema: DatasetSchemaField[],
  label: string,
  fail: Fail,
): QueryFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(MALFORMED, `${label} filters must be an array.`);
  }
  const filters: QueryFilter[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate['field'] !== 'string') {
      fail(MALFORMED, 'Each query filter must state a field and an operator.');
    }
    const field = candidate['field'];
    const op = candidate['op'] as QueryOperator;
    if (!OPERATORS.includes(op)) {
      fail(MALFORMED, `Each query filter operator must be one of: ${OPERATORS.join(', ')}.`);
    }
    if (!allowed.includes(field)) {
      fail(REFUSED, `${field} is not a filter ${label} permits.`);
    }
    const schemaField = schema.find((candidateField) => candidateField.name === field);
    if (schemaField === undefined) {
      fail(REFUSED, `${field} is not a field ${label} reads.`);
    }
    if (NULL_TESTS.includes(op)) {
      if (candidate['value'] !== undefined) {
        fail(MALFORMED, `The ${op} filter tests for a missing value, so it states no value.`);
      }
      filters.push({ field, op, value: null });
      continue;
    }
    const value = candidate['value'];
    if (!acceptsValue(schemaField, value)) {
      fail(REFUSED, `The ${field} filter must state a ${schemaField.type} value.`);
    }
    filters.push({ field, op, value });
  }
  return filters;
}

function readFilters(
  raw: unknown,
  contract: DataProductContract,
  schema: DatasetSchemaField[],
  fail: Fail,
): QueryFilter[] {
  refuseLinkedFields(fail, contract, raw, 'filter');
  return readFilterList(raw, contract.filters, schema, 'the Data Product Contract', fail);
}

/** Refuses a linked field stated wherever only the Product's own fields belong. */
function refuseLinkedFields(fail: Fail, contract: DataProductContract, raw: unknown, surface: string): void {
  if (!Array.isArray(raw)) return;
  for (const candidate of raw) {
    if (isRecord(candidate) && typeof candidate['field'] === 'string') {
      refuseLinkedField(fail, contract, candidate['field'], surface);
    }
  }
}

/**
 * Reads the declared relationships a record query asks to follow. A relationship
 * is read as its own record set, filtered only by the fields it publishes, so a
 * linked record never changes which base records the query answers.
 */
function readInclude(
  raw: unknown,
  contract: DataProductContract,
  related: Record<string, DatasetSchemaField[]>,
  fail: Fail,
): IncludeSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(MALFORMED, 'Query include must be an array of declared relationships.');
  }
  const specs: IncludeSpec[] = [];
  for (const candidate of raw) {
    const entry = typeof candidate === 'string' ? { name: candidate } : candidate;
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      fail(MALFORMED, 'Each included relationship must name a relationship the Contract declares.');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'name' && key !== 'filters') {
        fail(MALFORMED, `${key} is not a part of an included relationship.`);
      }
    }
    const name = entry['name'];
    const relationship = (contract.relationships ?? []).find((candidateRelationship) => candidateRelationship.name === name);
    if (relationship === undefined) {
      fail(REFUSED, `${name} is not a relationship this Data Product Contract publishes.`);
    }
    if (specs.some((spec) => spec.relationship.name === name)) {
      fail(MALFORMED, `The ${name} relationship is included more than once, so the linked records would be ambiguous.`);
    }
    const schema = related[name];
    if (schema === undefined) {
      fail(REFUSED, `The ${name} relationship has no Dataset Release in the Release this query reads.`);
    }
    specs.push({
      relationship,
      filters: readFilterList(entry['filters'], relationship.filters, schema, `the ${name} relationship`, fail),
    });
  }
  return specs;
}

/**
 * A query reads linked records only through `include`, under the Data Product's
 * own grain. Naming a linked field anywhere else would silently change which base
 * records match or how they group, which is exactly the join fanout the Contract
 * refuses to guess at.
 */
function refuseLinkedField(fail: Fail, contract: DataProductContract, name: string, surface: string): void {
  const prefix = name.slice(0, name.indexOf('.'));
  const relationship = (contract.relationships ?? []).find((candidate) => candidate.name === prefix);
  if (name.includes('.') && relationship !== undefined) {
    fail(
      REFUSED,
      `${name} belongs to the ${relationship.name} relationship, so it cannot ${surface} the Data Product's own records; linked records are read through include.`,
    );
  }
}

/**
 * Reads a window at the precision the Contract declares, so a date window covers
 * whole days and a timestamp window ends on an exact instant.
 */
function readWindow(raw: unknown, time: DataProductTime | undefined, label: string, fail: Fail): Window | undefined {
  if (raw === undefined) return undefined;
  if (time === undefined) {
    fail(REFUSED, `This Data Product Contract declares no time field, so a ${label} cannot be applied.`);
  }
  if (!isRecord(raw)) {
    fail(MALFORMED, `A ${label} must state a start and an end.`);
  }
  const pattern = time.precision === 'date' ? ISO_DATE : ISO_TIMESTAMP;
  const start = raw['start'];
  const end = raw['end'];
  if (typeof start !== 'string' || !pattern.test(start) || typeof end !== 'string' || !pattern.test(end)) {
    fail(MALFORMED, `A ${label} must state a start and an end at ${time.precision} precision.`);
  }
  const startKey = time.precision === 'date' ? start : Date.parse(start);
  const endKey = time.precision === 'date' ? end : Date.parse(end);
  if (!(startKey <= endKey)) {
    fail(REFUSED, `A ${label} must start no later than it ends.`);
  }
  return { start, end };
}

function readLimit(raw: unknown, contract: DataProductContract, fail: Fail): number {
  const limit = raw ?? contract.default_limit;
  if (!Number.isInteger(limit) || (limit as number) < 1) {
    fail(MALFORMED, 'A query limit must be a whole number of at least 1.');
  }
  if ((limit as number) > contract.max_limit) {
    fail('DATA_PRODUCT_QUERY_LIMIT_EXCEEDED', `A query limit cannot exceed ${contract.max_limit}.`);
  }
  return limit as number;
}

/** Reads the metrics a query requests, defaulting to every metric the Contract publishes. */
function readMetrics(
  raw: unknown,
  contract: DataProductContract,
  fail: Fail,
): { metrics: DataProductMetric[]; explicit: boolean } {
  if (raw === undefined) {
    if (contract.metrics.length === 0) {
      fail(REFUSED, 'This Data Product Contract publishes no metric, so it cannot answer an aggregate query.');
    }
    return { metrics: [...contract.metrics], explicit: false };
  }
  if (!Array.isArray(raw)) {
    fail(MALFORMED, 'Query metrics must be an array of metric names.');
  }
  const requested: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string') {
      fail(MALFORMED, 'Each requested metric must name a metric the Contract publishes.');
    }
    if (!contract.metrics.some((metric) => metric.name === candidate)) {
      fail(REFUSED, `${candidate} is not a metric the Data Product Contract publishes.`);
    }
    if (!requested.includes(candidate)) requested.push(candidate);
  }
  if (requested.length === 0) {
    fail(MALFORMED, 'An aggregate query must request at least one metric.');
  }
  return { metrics: requested.map((name) => contract.metrics.find((metric) => metric.name === name)!), explicit: true };
}

/** Reads the grouping, proving every metric may really be evaluated at that grain. */
function readGroupBy(raw: unknown, contract: DataProductContract, metrics: DataProductMetric[], fail: Fail): string[] {
  const candidates = raw ?? [];
  if (!Array.isArray(candidates)) {
    fail(MALFORMED, 'Query group_by must be an array of Contract dimensions.');
  }
  const groupBy: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      fail(MALFORMED, 'Each grouping must name a Contract dimension.');
    }
    refuseLinkedField(fail, contract, candidate, 'group');
    if (!contract.dimensions.includes(candidate)) {
      fail(REFUSED, `${candidate} is not a dimension the Data Product Contract declares.`);
    }
    if (!groupBy.includes(candidate)) groupBy.push(candidate);
  }
  for (const metric of metrics) {
    if (metric.dimensions === undefined) continue;
    const forbidden = groupBy.find((dimension) => !metric.dimensions!.includes(dimension));
    if (forbidden !== undefined) {
      fail(REFUSED, `The ${metric.name} metric cannot be grouped by ${forbidden}, so this combination is ambiguous.`);
    }
  }
  return groupBy;
}

/** Metric filters apply to the aggregate result, so they name a metric the query already requests. */
function readMetricFilters(raw: unknown, metrics: DataProductMetric[], fail: Fail): MetricFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(MALFORMED, 'Query metric_filters must be an array.');
  }
  const filters: MetricFilter[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate['metric'] !== 'string') {
      fail(MALFORMED, 'Each metric filter must state a metric and an operator.');
    }
    const metric = metrics.find((candidateMetric) => candidateMetric.name === candidate['metric']);
    if (!metric) {
      fail(REFUSED, `${candidate['metric']} is not a metric this query requests.`);
    }
    const op = candidate['op'] as QueryOperator;
    if (!OPERATORS.includes(op)) {
      fail(MALFORMED, `Each metric filter operator must be one of: ${OPERATORS.join(', ')}.`);
    }
    if (metric.value_type === 'date' || metric.value_type === 'timestamp') {
      fail(REFUSED, `The ${metric.name} metric states a ${metric.value_type}, so it cannot be filtered numerically.`);
    }
    if (NULL_TESTS.includes(op)) {
      filters.push({ metric: metric.name, op, value: null });
      continue;
    }
    const value = candidate['value'];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(REFUSED, `The ${metric.name} metric filter must state a number.`);
    }
    filters.push({ metric: metric.name, op, value });
  }
  return filters;
}

/** Ordering names a dimension or a requested metric; the dimension tuple breaks every tie. */
function readSort(
  raw: unknown,
  contract: DataProductContract,
  groupBy: string[],
  metrics: DataProductMetric[],
  fail: Fail,
): SortClause[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(MALFORMED, 'Query sort must be an array of ordering clauses.');
  }
  if (groupBy.length === 0) {
    fail(REFUSED, 'An ungrouped aggregate query forms one result, so it cannot be ordered.');
  }
  const sort: SortClause[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate['by'] !== 'string') {
      fail(MALFORMED, 'Each ordering clause must state a dimension or metric to order by.');
    }
    const by = candidate['by'];
    refuseLinkedField(fail, contract, by, 'order');
    if (!groupBy.includes(by) && !metrics.some((metric) => metric.name === by)) {
      fail(REFUSED, `${by} is neither a grouped dimension nor a requested metric.`);
    }
    const direction = candidate['direction'] ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc') {
      fail(MALFORMED, 'Each ordering clause must sort ascending or descending.');
    }
    sort.push({ by, direction });
  }
  return sort;
}

function readAggregate(
  parsed: Record<string, unknown>,
  contract: DataProductContract,
  schema: DatasetSchemaField[],
  fail: Fail,
): ParsedQuery {
  if (parsed['include'] !== undefined) {
    fail(
      REFUSED,
      'An aggregate query counts the Data Product\'s own records, so it cannot include linked records; read them through a record query.',
    );
  }
  const metrics$ = readMetrics(parsed['metrics'], contract, fail);
  const metrics = metrics$.metrics;
  const groupBy = readGroupBy(parsed['group_by'], contract, metrics, fail);
  const window = readWindow(parsed['window'], contract.time, 'time window', fail);
  const comparison = readWindow(parsed['comparison'], contract.time, 'comparison window', fail);
  if (comparison !== undefined && window === undefined) {
    fail(REFUSED, 'A comparison window compares against a time window, so the query must state both.');
  }
  const includeTotals = parsed['include_totals'] ?? false;
  if (typeof includeTotals !== 'boolean') {
    fail(MALFORMED, 'include_totals must be true or false.');
  }
  return {
    kind: 'aggregate',
    groupBy,
    metrics,
    metricsExplicit: metrics$.explicit,
    filters: readFilters(parsed['filters'], contract, schema, fail),
    metricFilters: readMetricFilters(parsed['metric_filters'], metrics, fail),
    includeTotals,
    sort: readSort(parsed['sort'], contract, groupBy, metrics, fail),
    limit: readLimit(parsed['limit'], contract, fail),
    ...(window === undefined ? {} : { window }),
    ...(comparison === undefined ? {} : { comparison }),
  };
}

/**
 * Reads which Release the query names, and the cursor it continues from. These
 * are read before the Contract, so a historical Release is answered under its
 * own Contract rather than under the newest one.
 */
export function readQueryTarget(parsed: Record<string, unknown>, fail: Fail): QueryTarget {
  const positive = (name: 'release' | 'major'): number | undefined => {
    const raw = parsed[name];
    if (raw === undefined) return undefined;
    if (!Number.isInteger(raw) || (raw as number) < 1) {
      fail(MALFORMED, `A query ${name} must be a whole number of at least 1.`);
    }
    return raw as number;
  };
  const cursor = parsed['cursor'];
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) {
    fail(MALFORMED, 'A query cursor must be the opaque value a previous page returned.');
  }
  const release = positive('release');
  const major = positive('major');
  return {
    ...(release === undefined ? {} : { release }),
    ...(major === undefined ? {} : { major }),
    ...(cursor === undefined ? {} : { cursor: cursor as string }),
  };
}

/**
 * Reads the Data Product Query a Consumer composes against the Contract. Every
 * surface it names — fields, dimensions, metrics, operators, windows, and the
 * declared relationships it includes — must be one the Contract publishes, so
 * nothing ungoverned can reach the records.
 */
export function readQuery(
  parsed: Record<string, unknown>,
  contract: DataProductContract,
  schema: DatasetSchemaField[],
  fail: Fail,
  related: Record<string, DatasetSchemaField[]> = {},
): ParsedQuery {
  const kind = parsed['kind'];
  if (kind === 'records') {
    readShape(parsed, RECORD_KEYS, 'record', fail);
    const window = readWindow(parsed['window'], contract.time, 'time window', fail);
    const include = readInclude(parsed['include'], contract, related, fail);
    return {
      kind: 'records',
      filters: readFilters(parsed['filters'], contract, schema, fail),
      limit: readLimit(parsed['limit'], contract, fail),
      ...(window === undefined ? {} : { window }),
      include,
    };
  }
  if (kind === 'aggregate') {
    readShape(parsed, AGGREGATE_KEYS, 'aggregate', fail);
    return readAggregate(parsed, contract, schema, fail);
  }
  if (kind === 'search' || kind === 'suggest') {
    readShape(parsed, SEARCH_KEYS, kind, fail);
    const search = contract.search;
    if (search === undefined) {
      fail(REFUSED, 'This Data Product Contract publishes no search, so it cannot answer a search or a suggestion.');
    }
    const q = parsed['q'];
    if (typeof q !== 'string' || q.trim().length === 0) {
      fail(MALFORMED, 'A search or a suggestion must state the text it looks for.');
    }
    if ([...q].length > MAX_QUERY_LENGTH) {
      fail(MALFORMED, `A search may not state more than ${MAX_QUERY_LENGTH} characters.`);
    }
    const limit = readLimit(parsed['limit'], contract, fail);
    if (kind === 'suggest') {
      // Suggestions are a bounded top-N list, not a paged result: replaying a
      // cursor would silently answer page one again, so the cursor is refused.
      if (parsed['cursor'] !== undefined) {
        fail(
          'DATA_PRODUCT_QUERY_CURSOR_NOT_SUPPORTED',
          'Suggestions are a bounded list, not a paged result, so a suggestion accepts no cursor.',
        );
      }
      return { kind: 'suggest', search, q: q.trim(), limit };
    }
    const terms = readSearchTerms(search, q);
    if (terms.length === 0) {
      fail(
        REFUSED,
        `Every term this search states is shorter than the ${search.min_term_length} characters the Contract indexes.`,
      );
    }
    if (terms.length > search.max_terms) {
      fail(REFUSED, `This search states ${terms.length} terms, beyond the ${search.max_terms} the Contract permits.`);
    }
    return { kind: 'search', search, terms, limit };
  }
  fail(MALFORMED, 'A Data Product Query must state whether it reads records, aggregates, searches, or suggests.');
}