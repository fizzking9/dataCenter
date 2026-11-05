import { resolveActor } from './auth.js';
import { reject, type ActionContext } from './authz.js';
import {
  type DataProductArtifact,
  type DataProductContract,
  type DataProductMetric,
  type DataProductRelationship,
  type DataProductTime,
  type DatasetArtifact,
  type DatasetRecordRow,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
  type SourceRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { memberReader, type GrantReader, type GrantScope } from './grants.js';
import { pinnedMetricDefinitions } from './metric-definition.js';
import { workspaceRoleOf, type ContextEntry } from './platform.js';
import { evaluateAggregate, orderGroups, type EvaluatedGroup, type MetricValue } from './product-aggregate.js';
import { queryCacheKey, readCachedPage, writeCachedPage } from './product-cache.js';
import { decodeCursor, encodeCursor } from './product-cursor.js';
import { periodComplete, sameElapsedInterval } from './product-period.js';
import {
  readQuery,
  readQueryTarget,
  type IncludeSpec,
  type ParsedQuery,
  type QueryOperator,
  type QueryTarget,
  type Window,
} from './product-query-document.js';
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
  sameElapsed?: boolean,
): Record<string, unknown> {
  const uncovered = coverage === null
    || timeKey(coverage.start, time.precision)! > timeKey(window.start, time.precision)!
    || timeKey(coverage.end, time.precision)! < timeKey(window.end, time.precision)!;
  const partial = uncovered || !periodComplete(time, window);
  return {
    field: time.field,
    precision: time.precision,
    time_zone: time.time_zone,
    start: window.start,
    end: window.end,
    coverage,
    partial,
    ...(window.period === undefined
      ? {}
      : { period: window.period, complete: !partial }),
    ...(sameElapsed === undefined ? {} : { same_elapsed_interval: sameElapsed }),
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

/** The direction a numeric change moved, in the vocabulary a comparison reports. */
type ChangeDirection = 'up' | 'down' | 'flat';

function changeDirection(change: number): ChangeDirection {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

/**
 * Judges one numeric change against the favourable direction the approved
 * Metric Definition states. A metric that binds no direction reports the
 * change without inventing a judgement.
 */
function judge(change: number, favorable: ContextEntry['favorable_direction']): Record<string, unknown> {
  const direction = changeDirection(change);
  if (favorable === undefined) return { direction };
  const judgment = direction === 'flat'
    ? 'neutral'
    : direction === favorable
      ? 'favorable'
      : 'adverse';
  return { direction, judgment };
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
  favorable?: ContextEntry['favorable_direction'],
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
  const judged = favorable === undefined ? {} : judge(change, favorable);
  if (comparedNumber === 0) {
    return { value: compared, change: rendered, ...judged, change_percent: null, change_percent_reason: 'zero_base' };
  }
  return { value: compared, change: rendered, ...judged, change_percent: ((change / Math.abs(comparedNumber)) * 100).toFixed(2) };
}

interface MergedGroup extends EvaluatedGroup {
  comparison: Record<string, Record<string, unknown>> | null;
}

/** Merges the two windows on their dimension tuple so a compared group appears once. */
function mergeWindows(
  metrics: DataProductMetric[],
  base: EvaluatedGroup[],
  comparison: EvaluatedGroup[] | null,
  directionOf: (metric: DataProductMetric) => ContextEntry['favorable_direction'],
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
        compared[metric.name] = compareMetric(metric, baseValue, comparedValue, directionOf(metric));
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

function metricView(metric: DataProductMetric, definition: ContextEntry | undefined): Record<string, unknown> {
  return {
    name: metric.name,
    aggregation: metric.aggregation,
    value_type: metric.value_type,
    unit: metric.unit ?? null,
    currency: metric.currency ?? null,
    ...(metric.definition === undefined
      ? {}
      : {
        definition: metric.definition,
        favorable_direction: definition?.favorable_direction ?? null,
      }),
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

/** One declared relationship resolved to the exact Dataset Release it was bound to. */
interface LinkedDataset {
  relationship: DataProductRelationship;
  dataset: DatasetArtifact;
  datasetRelease: DatasetReleaseRecord;
  schema: DatasetSchemaField[];
  source: SourceRecord | undefined;
}

/**
 * Resolves every relationship the Release bound to the Dataset Release it pinned.
 * A linked record is read from the Release the Data Product Release names, never
 * from the newest data, so an answer stays reproducible.
 */
function linkedDatasets(
  session: PlatformSession,
  contract: DataProductContract,
  release: { release: number; relationships?: Array<{ name: string; dataset_id: string; dataset_release: number }> },
  fail: Fail,
): LinkedDataset[] {
  return (release.relationships ?? []).map((binding) => {
    const relationship = (contract.relationships ?? []).find((candidate) => candidate.name === binding.name);
    if (relationship === undefined) {
      fail(
        'DATA_PRODUCT_RELEASE_INVALID',
        `Data Product Release ${release.release} links a relationship its Contract does not declare.`,
      );
    }
    const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === binding.dataset_id);
    const datasetRelease = dataset?.releases.find((candidate) => candidate.release === binding.dataset_release);
    if (!dataset || !datasetRelease) {
      fail(
        'DATASET_RELEASE_NOT_FOUND',
        `The Dataset Release the ${relationship.name} relationship pins is not available.`,
      );
    }
    const schema = session.state.integration_configurations
      .find((artifact) => artifact.source_id === dataset.source_id)
      ?.versions.find((candidate) => candidate.version === datasetRelease.integration_configuration_version)
      ?.schema ?? [];
    const source = session.state.sources.find((candidate) => candidate.source_id === dataset.source_id);
    return { relationship, dataset, datasetRelease, schema, source };
  });
}

/** The base columns one reader may project, in the Contract's own order. */
function permittedBaseColumns(contract: DataProductContract, scope: GrantScope): string[] {
  return contract.fields.map((field) => field.name).filter((name) => scope.columns.includes(name));
}

/** The linked columns one reader may project, in the relationship's own order. */
function permittedLinkedColumns(relationship: DataProductRelationship, scope: GrantScope): string[] {
  return relationship.fields
    .map((field) => field.name)
    .filter((name) => scope.columns.includes(`${relationship.name}.${name}`));
}

/** Whether a Grant permits any field of one relationship at all. */
function visibleRelationship(relationship: DataProductRelationship, scope: GrantScope): boolean {
  return permittedLinkedColumns(relationship, scope).length > 0;
}

/**
 * Orders linked records the way the relationship's own grain says they are one
 * record, so a many relationship answers the same sequence on every read.
 */
function orderLinkedRecords(records: DatasetRecordRow[], relationship: DataProductRelationship): DatasetRecordRow[] {
  return [...records].sort((left, right) => {
    for (const field of relationship.grain) {
      const comparison = compareValues(left.values[field] ?? null, right.values[field] ?? null);
      if (comparison !== 0) return comparison;
    }
    if (left.identity === right.identity) return 0;
    return left.identity < right.identity ? -1 : 1;
  });
}

/** A missing join value reaches nothing, because a link names equal values, not equal absence. */
function joinKey(values: Array<string | number | null>): string | null {
  return values.some((value) => value === null) ? null : JSON.stringify(values);
}

/**
 * Reads one included relationship the way its record grain and cardinality
 * declare: every linked record falls under exactly one base record, so reading
 * links never multiplies the records, the counts, or the metrics of the product.
 */
function linkedIndex(datasetRelease: DatasetReleaseRecord, spec: IncludeSpec): Map<string, DatasetRecordRow[]> {
  const { relationship, filters } = spec;
  const relatedFields = Object.keys(relationship.on).map((local) => relationship.on[local]!);
  const index = new Map<string, DatasetRecordRow[]>();
  for (const record of datasetRelease.records) {
    if (!filters.every((filter) => matches(record.values[filter.field] ?? null, filter.op, filter.value))) continue;
    const key = joinKey(relatedFields.map((field) => record.values[field] ?? null));
    if (key === null) continue;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [record]);
    else bucket.push(record);
  }
  for (const [key, rows] of index) index.set(key, orderLinkedRecords(rows, relationship));
  return index;
}

function projectLinkedRecord(
  record: DatasetRecordRow,
  relationship: DataProductRelationship,
  scope: GrantScope,
): Record<string, string | number | null> {
  return Object.fromEntries(
    permittedLinkedColumns(relationship, scope).map((name) => [name, record.values[name] ?? null]),
  );
}

/**
 * The linked records of one base record: exactly one record or an explicit null
 * for a one relationship, and a bounded, ordered list for a many relationship.
 */
function linkedValue(
  base: DatasetRecordRow,
  spec: IncludeSpec,
  index: Map<string, DatasetRecordRow[]>,
  scope: GrantScope,
): unknown {
  const relationship = spec.relationship;
  const key = joinKey(Object.keys(relationship.on).map((local) => base.values[local] ?? null));
  const rows = key === null ? [] : index.get(key) ?? [];
  if (relationship.cardinality === 'one') {
    const record = rows[0];
    return record === undefined ? null : projectLinkedRecord(record, relationship, scope);
  }
  const page = rows.slice(0, relationship.limit);
  return {
    records: page.map((record) => projectLinkedRecord(record, relationship, scope)),
    returned: page.length,
    truncated: rows.length > relationship.limit,
  };
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
    return {
      release,
      major,
      scope: scopeFingerprint,
      kind: 'records',
      filters: query.filters,
      window: query.window ?? null,
      include: query.include.map((spec) => ({ relationship: spec.relationship.name, filters: spec.filters })),
    };
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
  if (query.kind !== 'aggregate') {
    if (query.kind === 'records') {
      for (const spec of query.include) {
        if (!visibleRelationship(spec.relationship, scope)) {
          fail(
            'DATA_PRODUCT_QUERY_REFUSED',
            `The ${spec.relationship.name} relationship publishes no column this Grant permits, so it cannot be included.`,
            'Query only the relationships and columns the Grant permits.',
          );
        }
        for (const filter of spec.filters) {
          if (!scope.columns.includes(`${spec.relationship.name}.${filter.field}`)) {
            fail(
              'DATA_PRODUCT_QUERY_REFUSED',
              `The ${spec.relationship.name}.${filter.field} column is not one this Grant permits, so it cannot filter the linked records.`,
              'Query only the relationships and columns the Grant permits.',
            );
          }
        }
      }
    }
    return;
  }
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
 * with the cursor, which the offset check refuses. A suggestion never pages, so
 * its cursor is left to the document reader, which refuses it by name.
 */
function pinnedToCursor(
  session: PlatformSession,
  request: Record<string, unknown>,
  target: QueryTarget,
  fail: Fail,
): QueryTarget {
  const kind = request['kind'];
  if (kind !== 'search' || target.cursor === undefined || target.release !== undefined) {
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
  // The approved Metric Definitions the Release pinned interpret its metrics;
  // a metric that binds none reports its change without a judgement.
  const definitions = pinnedMetricDefinitions(session, dataset.workspace_id, datasetRelease.pins);
  const directionOf = (metric: DataProductMetric): ContextEntry['favorable_direction'] =>
    metric.definition === undefined ? undefined : definitions.get(metric.definition)?.favorable_direction;
  const linked = linkedDatasets(session, contract, release, fail);
  const relatedSchemas = Object.fromEntries(linked.map((entry) => [entry.relationship.name, entry.schema]));

  const query = readQuery(request as Record<string, unknown>, contract, schema, fail, relatedSchemas);
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

  // Reading a linked record set scans that Release too, so the declared resource
  // envelope holds the same total whether or not a query follows its links.
  const linkedScanned = query.kind === 'records'
    ? query.include.reduce((total, spec) => {
      const entry = linked.find((candidate) => candidate.relationship.name === spec.relationship.name);
      return total + (entry?.datasetRelease.records.length ?? 0);
    }, 0)
    : 0;
  const scanned = datasetRelease.records.length + linkedScanned;
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
    // A relationship the Grant withholds entirely is not disclosed here either:
    // Provenance explains what the reader was permitted to read, not what else
    // the Release happens to link.
    relationships: linked
      .filter((entry) => visibleRelationship(entry.relationship, scope))
      .map((entry) => ({
        name: entry.relationship.name,
        cardinality: entry.relationship.cardinality,
        source: { source_id: entry.dataset.source_id, name: entry.source?.name ?? null },
        dataset_id: entry.dataset.dataset_id,
        dataset_release: entry.datasetRelease.release,
        integration_configuration_version: entry.datasetRelease.integration_configuration_version,
        business_context: { ...entry.datasetRelease.pins },
        record_count: entry.datasetRelease.record_count,
        acquired_at: entry.datasetRelease.provenance.acquired_at,
        integrated_at: entry.datasetRelease.provenance.integrated_at,
        released_at: entry.datasetRelease.created_at,
      })),
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
    const baseColumns = permittedBaseColumns(contract, scope);
    const hits = orderSearchHits(
      searchRecords(permittedRows, query.search, query.terms, scope.columns),
      contract,
    );
    requireOffsetWithin(offset, hits.length, fail);
    const page = hits.slice(offset, offset + query.limit);
    const records = page.map((hit) => {
      const values: Record<string, string | number | null> = {};
      for (const name of baseColumns) {
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
      columns: [...baseColumns],
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
    const baseColumns = permittedBaseColumns(contract, scope);
    const included = query.include.map((spec) => {
      const entry = linked.find((candidate) => candidate.relationship.name === spec.relationship.name)!;
      return { spec, index: linkedIndex(entry.datasetRelease, spec) };
    });
    const selected = orderRecords(
      selectRecords(datasetRelease.records, contract, queryFilters, query.window),
      contract,
    );
    requireOffsetWithin(offset, selected.length, fail);
    const page = selected.slice(offset, offset + query.limit);
    const projected = page.map((record) => {
      const values: Record<string, string | number | null> = {};
      for (const name of baseColumns) {
        values[name] = record.values[name] ?? null;
      }
      if (included.length === 0) return values;
      const links: Record<string, unknown> = {};
      for (const { spec, index } of included) {
        links[spec.relationship.name] = linkedValue(record, spec, index, scope);
      }
      return { ...values, linked: links };
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
      columns: [...baseColumns],
      ...(included.length === 0
        ? {}
        : { linked: included.map(({ spec }) => spec.relationship.name) }),
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
      scanned_records: permitted + linkedScanned,
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
  const merged = mergeWindows(metrics, base.groups, compared?.groups ?? null, directionOf)
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
    metrics: metrics.map((metric) => metricView(metric, metric.definition === undefined ? undefined : definitions.get(metric.definition))),
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
              compareMetric(metric, base.totals[metric.name] ?? null, compared.totals[metric.name] ?? null, directionOf(metric)),
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
      : {
        comparison_window: windowView(
          contract.time,
          query.comparison,
          coverage,
          query.window === undefined ? undefined : sameElapsedInterval(contract.time, query.window, query.comparison),
        ),
      }),
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

