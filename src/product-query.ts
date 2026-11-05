import { resolveActor } from './auth.js';
import { reject, type ActionContext } from './authz.js';
import {
  type DataProductArtifact,
  type DataProductContract,
  type DataProductMetric,
  type DataProductTime,
  type DatasetRecordRow,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { memberReader, type GrantReader, type GrantScope } from './grants.js';
import { workspaceRoleOf } from './platform.js';
import { evaluateAggregate, orderGroups, type EvaluatedGroup, type MetricValue } from './product-aggregate.js';
import { queryCacheKey, readCachedPage, writeCachedPage } from './product-cache.js';
import { decodeCursor, encodeCursor } from './product-cursor.js';
import { readQuery, readQueryTarget, type ParsedQuery, type QueryOperator, type QueryTarget, type Window } from './product-query-document.js';
import { resolveRelease, type ResolvedRelease } from './product-release.js';
import { orderSearchHits, searchRecords, suggestValues } from './product-search.js';
import { requireReadableProduct } from './products.js';
import { openPlatform, type PlatformSession } from './session.js';

/** Applies a typed operator the way the field's own type is compared. */
function matches(actual: string | number | null, op: QueryOperator, expected: string | number | null): boolean {
  if (op === 'is_null') return actual === null;
  if (op === 'is_not_null') return actual !== null;
  if (actual === null) return false;
  if (op === 'equals') return actual === expected;
  if (op === 'not_equals') return actual !== expected;
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (op === 'less_than') return actual < expected;
    if (op === 'less_or_equal') return actual <= expected;
    if (op === 'greater_than') return actual > expected;
    return actual >= expected;
  }
  const left = String(actual);
  const right = String(expected);
  if (op === 'less_than') return left < right;
  if (op === 'less_or_equal') return left <= right;
  if (op === 'greater_than') return left > right;
  return left >= right;
}

/** Reads one record's time value as the comparable key its Contract precision implies. */
function timeKey(value: string | number | null, precision: DataProductTime['precision']): number | string | null {
  if (value === null) return null;
  return precision === 'date' ? String(value) : Date.parse(String(value));
}

function withinWindow(record: DatasetRecordRow, time: DataProductTime, window: Window): boolean {
  const value = timeKey(record.values[time.field] ?? null, time.precision);
  if (value === null) return false;
  return value >= timeKey(window.start, time.precision)! && value <= timeKey(window.end, time.precision)!;
}

/**
 * Selects the records one side of a query reads: its dimension filters first,
 * then its window. Both the queried and the compared window read through this
 * same predicate, so a comparison never measures a different population.
 */
function selectRecords(
  records: DatasetRecordRow[],
  contract: DataProductContract,
  filters: Array<{ field: string; op: QueryOperator; value: string | number | null }>,
  window: Window | undefined,
): DatasetRecordRow[] {
  return records.filter(
    (record) => filters.every((filter) => matches(record.values[filter.field] ?? null, filter.op, filter.value))
      && (window === undefined || contract.time === undefined || withinWindow(record, contract.time, window)),
  );
}

/** The range the pinned Release actually covers, so a partial window is never read as complete. */
function coverageOf(
  records: DatasetRecordRow[],
  time: DataProductTime,
): { start: string; end: string } | null {
  let lowest: { key: number | string; raw: string } | null = null;
  let highest: { key: number | string; raw: string } | null = null;
  for (const record of records) {
    const raw = record.values[time.field] ?? null;
    const key = timeKey(raw, time.precision);
    if (key === null) continue;
    if (lowest === null || key < lowest.key) lowest = { key, raw: String(raw) };
    if (highest === null || key > highest.key) highest = { key, raw: String(raw) };
  }
  return lowest === null || highest === null ? null : { start: lowest.raw, end: highest.raw };
}

function windowView(
  time: DataProductTime,
  window: Window,
  coverage: { start: string; end: string } | null,
): Record<string, unknown> {
  const uncovered = coverage === null
    || timeKey(coverage.start, time.precision)! > timeKey(window.start, time.precision)!
    || timeKey(coverage.end, time.precision)! < timeKey(window.end, time.precision)!;
  return {
    field: time.field,
    precision: time.precision,
    time_zone: time.time_zone,
    start: window.start,
    end: window.end,
    coverage,
    partial: uncovered,
  };
}

/** The value a group holds when it exists in only one of the two compared windows. */
function absentValue(metric: DataProductMetric): MetricValue {
  if (metric.aggregation === 'count') return 0;
  if (metric.aggregation === 'sum') return metric.value_type === 'integer' ? 0 : (0).toFixed(2);
  return null;
}

function numericOf(value: MetricValue): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compares one metric against its comparison window: the change is always
 * numeric, and a zero or missing comparison value yields an explicit
 * non-numeric outcome rather than an invented percentage.
 */
function compareMetric(
  metric: DataProductMetric,
  base: MetricValue,
  compared: MetricValue,
): Record<string, unknown> {
  if (metric.value_type === 'date' || metric.value_type === 'timestamp') {
    return { value: compared, change: null, change_percent: null, change_percent_reason: 'not_numeric' };
  }
  const baseNumber = numericOf(base);
  const comparedNumber = numericOf(compared);
  if (baseNumber === null || comparedNumber === null) {
    return { value: compared, change: null, change_percent: null, change_percent_reason: 'value_missing' };
  }
  const change = baseNumber - comparedNumber;
  const rendered = metric.value_type === 'integer' ? Math.trunc(change) : change.toFixed(2);
  if (comparedNumber === 0) {
    return { value: compared, change: rendered, change_percent: null, change_percent_reason: 'zero_base' };
  }
  return { value: compared, change: rendered, change_percent: ((change / Math.abs(comparedNumber)) * 100).toFixed(2) };
}

interface MergedGroup extends EvaluatedGroup {
  comparison: Record<string, Record<string, unknown>> | null;
}

/** Merges the two windows on their dimension tuple so a compared group appears once. */
function mergeWindows(
  metrics: DataProductMetric[],
  base: EvaluatedGroup[],
  comparison: EvaluatedGroup[] | null,
): MergedGroup[] {
  const baseByKey = new Map(base.map((entry) => [JSON.stringify(entry.dimension_order), entry]));
  const comparedByKey = new Map((comparison ?? []).map((entry) => [JSON.stringify(entry.dimension_order), entry]));
  const keys = [...new Set([...baseByKey.keys(), ...comparedByKey.keys()])];
  return keys.map((key) => {
    const baseEntry = baseByKey.get(key);
    const comparedEntry = comparedByKey.get(key);
    const template = baseEntry ?? comparedEntry!;
    const metrics$: Record<string, MetricValue> = {};
    const order: Record<string, number | null> = {};
    const compared: Record<string, Record<string, unknown>> = {};
    for (const metric of metrics) {
      const baseValue = baseEntry === undefined ? absentValue(metric) : baseEntry.metrics[metric.name]!;
      metrics$[metric.name] = baseValue;
      order[metric.name] = baseEntry === undefined ? null : baseEntry.metric_order[metric.name]!;
      if (comparison !== null) {
        const comparedValue = comparedEntry === undefined ? absentValue(metric) : comparedEntry.metrics[metric.name]!;
        compared[metric.name] = compareMetric(metric, baseValue, comparedValue);
      }
    }
    return {
      group: template.group,
      null_dimensions: template.null_dimensions,
      metrics: metrics$,
      comparison: comparison === null ? null : compared,
      dimension_order: template.dimension_order,
      metric_order: order,
    };
  });
}

function metricView(metric: DataProductMetric): Record<string, unknown> {
  return {
    name: metric.name,
    aggregation: metric.aggregation,
    value_type: metric.value_type,
    unit: metric.unit ?? null,
    currency: metric.currency ?? null,
  };
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
 * Orders records the way a page can be walked and resumed: the Contract's own
 * grain first, then the record's stable identity, so no two records ever trade
 * places between pages.
 */
function orderRecords(records: DatasetRecordRow[], contract: DataProductContract): DatasetRecordRow[] {
  return [...records].sort((left, right) => {
    for (const field of contract.grain) {
      const comparison = compareValues(left.values[field] ?? null, right.values[field] ?? null);
      if (comparison !== 0) return comparison;
    }
    if (left.identity === right.identity) return 0;
    return left.identity < right.identity ? -1 : 1;
  });
}

/** The query itself, minus the page position, so a cursor pins what it answered. */
function normalizeQuery(
  query: ParsedQuery,
  release: number,
  major: number,
  scopeFingerprint: string,
): Record<string, unknown> {
  if (query.kind === 'search') {
    return { release, major, scope: scopeFingerprint, kind: 'search', terms: [...query.terms] };
  }
  if (query.kind === 'suggest') {
    return { release, major, scope: scopeFingerprint, kind: 'suggest', q: query.q };
  }
  if (query.kind === 'records') {
    return { release, major, scope: scopeFingerprint, kind: 'records', filters: query.filters, window: query.window ?? null };
  }
  return {
    release,
    major,
    scope: scopeFingerprint,
    kind: 'aggregate',
    group_by: [...query.groupBy],
    metrics: query.metrics.map((metric) => metric.name),
    filters: query.filters,
    metric_filters: query.metricFilters,
    include_totals: query.includeTotals,
    sort: query.sort,
    window: query.window ?? null,
    comparison: query.comparison ?? null,
  };
}

/**
 * Proves the query asks for nothing the actor's Grant hides. A hidden column is
 * refused rather than dropped, because filtering, grouping, or aggregating on
 * it would disclose the very values the Grant withholds.
 */
function requireGrantPermits(query: ParsedQuery, scope: GrantScope, fail: Fail): void {
  if (query.kind === 'search' || query.kind === 'suggest') {
    // The text a search reads is a column like any other: a Grant that hides it
    // refuses the search rather than answering it out of hidden content.
    if (!scope.columns.includes(query.search.text_field)) {
      fail(
        'DATA_PRODUCT_QUERY_REFUSED',
        `The ${query.search.text_field} field carries the text this search reads, and this Grant does not permit it.`,
        'Query only the columns the Grant permits.',
      );
    }
    return;
  }
  for (const filter of query.filters) {
    if (!scope.columns.includes(filter.field)) {
      fail(
        'DATA_PRODUCT_QUERY_REFUSED',
        `${filter.field} is not a column this Grant permits, so it cannot filter, group, or total this query.`,
        'Query only the columns the Grant permits.',
      );
    }
  }
  if (query.kind !== 'aggregate') return;
  for (const dimension of query.groupBy) {
    if (!scope.columns.includes(dimension)) {
      fail(
        'DATA_PRODUCT_QUERY_REFUSED',
        `${dimension} is not a column this Grant permits, so it cannot filter, group, or total this query.`,
        'Query only the columns the Grant permits.',
      );
    }
  }
  if (!query.metricsExplicit) return;
  for (const metric of query.metrics) {
    if (metric.field !== undefined && !scope.columns.includes(metric.field)) {
      fail(
        'DATA_PRODUCT_QUERY_REFUSED',
        `The ${metric.name} metric reads a column this Grant does not permit.`,
        'Request a metric the Grant permits.',
      );
    }
  }
}

/**
 * Reads how far into a query a page continues. A cursor answers only the query,
 * Release, and authorization scope it was issued for, so a Grant or membership
 * change takes effect on the very next page.
 */
function readOffset(
  session: PlatformSession,
  target: QueryTarget,
  resolved: ResolvedRelease,
  queryHash: string,
  fail: Fail,
): number {
  if (target.cursor === undefined) return 0;
  const payload = decodeCursor(session.dataKey, target.cursor, fail);
  if (payload.release !== resolved.release.release
    || payload.major !== resolved.major
    || payload.queryHash !== queryHash) {
    fail(
      'DATA_PRODUCT_QUERY_CURSOR_INVALID',
      'This page cursor was issued for a different query, Release, Contract line, or authorization scope.',
      'Read the query again from its first page.',
    );
  }
  return payload.offset;
}

/** A cursor may never point past what the pinned Release holds. */
function requireOffsetWithin(offset: number, available: number, fail: Fail): void {
  if (offset > available) {
    fail(
      'DATA_PRODUCT_QUERY_CURSOR_INVALID',
      'This page cursor points past the results this Release holds.',
      'Read the query again from its first page.',
    );
  }
}

/** What one Data Product Query execution needs, whichever surface reached it. */
export interface DataProductQueryExecution {
  session: PlatformSession;
  /** Who the read runs for: a Workspace member, or an Agent Identity. */
  reader: GrantReader;
  product: DataProductArtifact;
  /** The Audit Event target the calling surface already resolved. */
  context: ActionContext;
  /** The Query document, already parsed out of its transport. */
  request: unknown;
  /** How the calling surface reports a structured failure. */
  fail: Fail;
  /**
   * Whether the answer may be reused from, and written to, the page cache.
   * An isolated preview sets this false so it persists nothing at all.
   */
  persistCache?: boolean;
}

/**
 * A search page belongs to the Release its own cursor names, so a later Release
 * never shifts a page a Consumer already opened. The cursor is read before the
 * Release is resolved, because resolving the newest Release first would answer
 * the newest page. Naming a Release explicitly still wins — and then disagrees
 * with the cursor, which the offset check refuses.
 */
function pinnedToCursor(
  session: PlatformSession,
  request: Record<string, unknown>,
  target: QueryTarget,
  fail: Fail,
): QueryTarget {
  const kind = request['kind'];
  if ((kind !== 'search' && kind !== 'suggest') || target.cursor === undefined || target.release !== undefined) {
    return target;
  }
  return { ...target, release: decodeCursor(session.dataKey, target.cursor, fail).release };
}

/**
 * Answers one Data Product Query against the Data Product Release the Contract
 * was published with, so a later Dataset Release never changes an open Contract.
 *
 * The lifecycle CLI, the Data Product API, and MCP all reach this one function,
 * so their records, cursors, Provenance, freshness, and error codes cannot drift
 * apart: only the transport around the read differs.
 */
export function executeDataProductQuery(options: DataProductQueryExecution): Record<string, unknown> {
  const startedAt = Date.now();
  const { session, reader, product, context: scoped, request } = options;
  /** Reports a structured failure through the surface that reached this read. */
  function fail(code: string, message: string, nextStep?: string): never {
    return options.fail(code, message, nextStep);
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    fail('DATA_PRODUCT_QUERY_INVALID', 'A Data Product Query must be a JSON object.');
  }
  const stated = readQueryTarget(request as Record<string, unknown>, fail);
  const target = pinnedToCursor(session, request as Record<string, unknown>, stated, fail);
  if (product.versions.length === 0 || product.releases.length === 0) {
    fail('DATA_PRODUCT_NOT_PUBLISHED', 'The Data Product has no Publication to query.');
  }
  const { version, release, major } = resolveRelease(product, target, fail);
  const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
  const datasetRelease: DatasetReleaseRecord | undefined = dataset?.releases.find(
    (candidate) => candidate.release === release.dataset_release,
  );
  if (!dataset || !datasetRelease) {
    fail('DATASET_RELEASE_NOT_FOUND', 'The Dataset Release this Data Product pins is not available.');
  }
  const contract = version.contract;
  const schema = session.state.integration_configurations
    .find((artifact) => artifact.source_id === dataset.source_id)
    ?.versions.find((candidate) => candidate.version === datasetRelease.integration_configuration_version)
    ?.schema ?? [];
  const source = session.state.sources.find((candidate) => candidate.source_id === dataset.source_id);

  const query = readQuery(request as Record<string, unknown>, contract, schema, fail);
  const scope = reader.requireScope(product, contract, fail);
  requireGrantPermits(query, scope, fail);
  const queryHash = canonicalDigest(normalizeQuery(query, release.release, major, scope.fingerprint));
  // A search reads its rows through the Grant's own row filters alone; a record
  // or aggregate query adds the filters it states.
  const queryFilters = query.kind === 'records' || query.kind === 'aggregate'
    ? [...scope.rowFilters, ...query.filters]
    : [];
  const offset = readOffset(session, target, { version, release, major }, queryHash, fail);
  const cacheKey = queryCacheKey({
    release: release.release,
    major,
    contractHash: version.contract_hash,
    subject: reader.subject,
    scopeFingerprint: scope.fingerprint,
    queryHash,
    offset,
    limit: query.limit,
  });

  const scanned = datasetRelease.records.length;
  // A narrowed reader must not learn the size of the population they cannot
  // see, so the reported scan, the time coverage, and the Release provenance
  // describe only the rows their Grants permit. The declared limits still
  // measure the work actually done.
  const permittedRows = scope.restricted
    ? selectRecords(datasetRelease.records, contract, scope.rowFilters, undefined)
    : datasetRelease.records;
  const permitted = permittedRows.length;
  if (scanned > contract.limits.max_scanned_records) {
    fail(
      'DATA_PRODUCT_QUERY_TOO_COMPLEX',
      `This query would scan ${scanned} records, beyond the ${contract.limits.max_scanned_records} the Contract permits.`,
      'Publish the Data Product over a smaller Dataset Release, or raise max_scanned_records for a Contract that is meant to serve it.',
    );
  }

  const provenance = {
    source: { source_id: dataset.source_id, name: source?.name ?? null },
    dataset_release: datasetRelease.release,
    integration_configuration_version: datasetRelease.integration_configuration_version,
    business_context: { ...datasetRelease.pins },
    record_count: scope.restricted ? null : datasetRelease.record_count,
    ...(scope.restricted ? { permitted_record_count: permitted } : {}),
    acquired_at: datasetRelease.provenance.acquired_at,
    integrated_at: datasetRelease.provenance.integrated_at,
    released_at: datasetRelease.created_at,
  };
  const identity = {
    data_product_id: product.data_product_id,
    name: product.name,
    api_path: product.api_path,
    data_product_version: version.version,
    data_product_release: release.release,
    contract_version: { ...version.contract_version },
    contract_hash: version.contract_hash,
  };
  const coverage = contract.time === undefined ? null : coverageOf(permittedRows, contract.time);

  /** Holds every answer to the execution budget the Contract declares. */
  const requireBudget = (): void => {
    const elapsed = Date.now() - startedAt;
    if (scanned > 0 && elapsed >= contract.limits.max_execution_ms) {
      fail(
        'DATA_PRODUCT_QUERY_TIMEOUT',
        `This query took ${elapsed}ms, beyond the ${contract.limits.max_execution_ms}ms the Contract permits.`,
        'Narrow the query with filters or a time window.',
      );
    }
  };

  // A page is reused only under the complete security and Release context the
  // key states, and only after this request's reader and Grants have been
  // resolved, so no revocation is ever bypassed.
  const persistCache = options.persistCache !== false;
  const cached = persistCache ? readCachedPage(session.root, session.dataKey, cacheKey) : null;
  if (cached !== null) {
    session.audit({
      ...scoped,
      actor: reader.label,
      outcome: 'succeeded',
      detail: { data_product_release: release.release, cache: 'reused' },
    });
    return { ...cached, cache: { reused: true } };
  }

  /** Records the answer for reuse under exactly this context, then returns it. */
  const remember = (response: Record<string, unknown>): Record<string, unknown> => {
    if (persistCache) writeCachedPage(session.root, session.dataKey, cacheKey, response);
    return { ...response, cache: { reused: false } };
  };

  if (query.kind === 'search') {
    const hits = orderSearchHits(
      searchRecords(permittedRows, query.search, query.terms, scope.columns),
      contract,
    );
    requireOffsetWithin(offset, hits.length, fail);
    const page = hits.slice(offset, offset + query.limit);
    const records = page.map((hit) => {
      const values: Record<string, string | number | null> = {};
      for (const name of scope.columns) {
        values[name] = hit.record.values[name] ?? null;
      }
      return { ...values, score: hit.score, matched_terms: [...hit.matched] };
    });
    const more = offset + records.length < hits.length;
    requireBudget();
    session.audit({
      ...scoped,
      actor: reader.label,
      outcome: 'succeeded',
      detail: { data_product_release: release.release, matched_count: hits.length, returned: records.length },
    });
    return remember({
      ...identity,
      kind: 'search',
      query: { terms: [...query.terms], text_field: query.search.text_field },
      ranking: { ...query.search.ranking },
      columns: [...scope.columns],
      records,
      matched_count: hits.length,
      returned: records.length,
      truncated: more,
      next_cursor: more
        ? encodeCursor(session.dataKey, {
          release: release.release,
          major,
          queryHash,
          offset: offset + records.length,
        })
        : null,
      limit: query.limit,
      scanned_records: permitted,
      provenance,
    });
  }

  if (query.kind === 'suggest') {
    const suggestions = suggestValues(permittedRows, query.search, query.q, scope.columns, query.limit);
    requireBudget();
    session.audit({
      ...scoped,
      actor: reader.label,
      outcome: 'succeeded',
      detail: { data_product_release: release.release, suggestion_count: suggestions.length },
    });
    return remember({
      ...identity,
      kind: 'suggest',
      query: { q: query.q, fields: [...query.search.suggest_fields] },
      suggestions,
      returned: suggestions.length,
      limit: query.limit,
      scanned_records: permitted,
      provenance,
    });
  }

  if (query.kind === 'records') {
    const selected = orderRecords(
      selectRecords(datasetRelease.records, contract, queryFilters, query.window),
      contract,
    );
    requireOffsetWithin(offset, selected.length, fail);
    const page = selected.slice(offset, offset + query.limit);
    const projected = page.map((record) => {
      const values: Record<string, string | number | null> = {};
      for (const name of scope.columns) {
        values[name] = record.values[name] ?? null;
      }
      return values;
    });
    const more = offset + projected.length < selected.length;
    requireBudget();
    session.audit({
      ...scoped,
      actor: reader.label,
      outcome: 'succeeded',
      detail: { data_product_release: release.release, matched_count: selected.length, returned: projected.length },
    });
    return remember({
      ...identity,
      kind: 'records',
      columns: [...scope.columns],
      records: projected,
      matched_count: selected.length,
      returned: projected.length,
      truncated: more,
      next_cursor: more
        ? encodeCursor(session.dataKey, {
          release: release.release,
          major,
          queryHash,
          offset: offset + projected.length,
        })
        : null,
      limit: query.limit,
      scanned_records: permitted,
      ...(query.window === undefined || contract.time === undefined
        ? { window: null }
        : { window: windowView(contract.time, query.window, coverage) }),
      provenance,
    });
  }

  // A hidden column may still be named by a Contract metric; only the metrics
  // this reader may evaluate are computed, and an explicit request for one it
  // may not was already refused.
  const metrics = query.metrics.filter(
    (metric) => metric.field === undefined || scope.columns.includes(metric.field),
  );
  if (metrics.length === 0) {
    fail(
      'DATA_PRODUCT_QUERY_REFUSED',
      'No metric this Data Product publishes reads a column the Grant permits.',
      'Ask its administrator for a Grant over a column this query may aggregate.',
    );
  }
  const spec = { groupBy: query.groupBy, metrics, schema };
  const base = evaluateAggregate(selectRecords(datasetRelease.records, contract, queryFilters, query.window), spec);
  const compared = query.comparison === undefined || contract.time === undefined
    ? null
    : evaluateAggregate(selectRecords(datasetRelease.records, contract, queryFilters, query.comparison), spec);
  const merged = mergeWindows(metrics, base.groups, compared?.groups ?? null)
    .filter((entry) => query.metricFilters.every(
      (filter) => matches(entry.metrics[filter.metric] ?? null, filter.op, filter.value),
    ));
  if (merged.length > contract.limits.max_groups) {
    fail(
      'DATA_PRODUCT_QUERY_RESULT_TOO_LARGE',
      `This query forms ${merged.length} groups, beyond the ${contract.limits.max_groups} the Contract permits.`,
      'Group by fewer dimensions or narrow the query.',
    );
  }
  const ordered = orderGroups(merged, query.sort);
  requireOffsetWithin(offset, ordered.length, fail);
  const returned = ordered.slice(offset, offset + query.limit);
  const more = offset + returned.length < ordered.length;
  requireBudget();

  session.audit({
    ...scoped,
    actor: reader.label,
    outcome: 'succeeded',
    detail: {
      data_product_release: release.release,
      group_count: merged.length,
      returned: returned.length,
    },
  });
  return remember({
    ...identity,
    kind: 'aggregate',
    grouped_by: [...query.groupBy],
    metrics: metrics.map(metricView),
    groups: returned.map((entry) => ({
      group: { ...entry.group },
      null_dimensions: [...entry.null_dimensions],
      metrics: { ...entry.metrics },
      ...(entry.comparison === null ? {} : { comparison: entry.comparison }),
    })),
    totals: query.includeTotals
      ? {
        metrics: { ...base.totals },
        ...(compared === null
          ? {}
          : {
            comparison: Object.fromEntries(metrics.map((metric) => [
              metric.name,
              compareMetric(metric, base.totals[metric.name] ?? null, compared.totals[metric.name] ?? null),
            ])),
          }),
      }
      : null,
    groups_total: merged.length,
    returned: returned.length,
    truncated: more,
    next_cursor: more
      ? encodeCursor(session.dataKey, {
        release: release.release,
        major,
        queryHash,
        offset: offset + returned.length,
      })
      : null,
    limit: query.limit,
    scanned_records: permitted,
    ...(query.window === undefined || contract.time === undefined
      ? { window: null }
      : { window: windowView(contract.time, query.window, coverage) }),
    ...(query.comparison === undefined || contract.time === undefined
      ? { comparison_window: null }
      : { comparison_window: windowView(contract.time, query.comparison, coverage) }),
    provenance,
  });
}

/**
 * Answers one Data Product Query for a Workspace member named by a session token,
 * reading the request from a file so the lifecycle CLI and the Data Product API
 * share one transport-free engine.
 */
export function queryDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  requestPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_query', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = requireReadableProduct(session, actor, context, options.dataProductId);
  const role = workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  const reader = memberReader(session, actor.user, role);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const fail: Fail = (code, message, nextStep) => reject(session, reader.label, scoped, code, message, nextStep);
  const request = readJsonDocument(
    options.requestPath,
    fail,
    'DATA_PRODUCT_QUERY_INVALID',
    'The Data Product Query document must contain valid JSON.',
  );
  return executeDataProductQuery({ session, reader, product, context: scoped, request, fail });
}

