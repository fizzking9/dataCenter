import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  findDataProduct,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductContract,
  type DataProductMetric,
  type DataProductTime,
  type DatasetRecordRow,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
} from './catalog.js';
import type { Fail } from './errors.js';
import { workspaceRoleOf } from './platform.js';
import { evaluateAggregate, orderGroups, type EvaluatedGroup, type MetricValue } from './product-aggregate.js';
import { readQueryDocument, type QueryOperator, type Window } from './product-query-document.js';
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

/**
 * Answers one Data Product Query against the Data Product Release the Contract
 * was published with, so a later Dataset Release never changes an open Contract.
 *
 * A Data Product in a Workspace the actor does not belong to answers exactly like
 * one that does not exist, and the response carries curated records and permitted
 * Provenance only.
 */
export function queryDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  requestPath: string;
}): Record<string, unknown> {
  const startedAt = Date.now();
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_query', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);

  const product = findDataProduct(session.state.data_products, options.dataProductId);
  const role = product === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  if (!product || role === null) {
    deny(session, actorLabel(actor.user), context, 'DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };

  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  if (!version || !release) {
    reject(session, actorLabel(actor.user), scoped, 'DATA_PRODUCT_NOT_PUBLISHED', 'The Data Product has no Publication to query.');
  }
  const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
  const datasetRelease: DatasetReleaseRecord | undefined = dataset?.releases.find(
    (candidate) => candidate.release === release.dataset_release,
  );
  if (!dataset || !datasetRelease) {
    reject(session, actorLabel(actor.user), scoped, 'DATASET_RELEASE_NOT_FOUND', 'The Dataset Release this Data Product pins is not available.');
  }
  const contract = version.contract;
  const schema = session.state.integration_configurations
    .find((artifact) => artifact.source_id === dataset.source_id)
    ?.versions.find((candidate) => candidate.version === datasetRelease.integration_configuration_version)
    ?.schema ?? [];
  const source = session.state.sources.find((candidate) => candidate.source_id === dataset.source_id);

  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  const query = readQueryDocument(options.requestPath, contract, schema, fail);

  const scanned = datasetRelease.records.length;
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
    record_count: datasetRelease.record_count,
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
    contract_hash: version.contract_hash,
  };
  const coverage = contract.time === undefined ? null : coverageOf(datasetRelease.records, contract.time);

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

  if (query.kind === 'records') {
    const selected = selectRecords(datasetRelease.records, contract, query.filters, query.window);
    const projected = selected.slice(0, query.limit).map((record) => {
      const values: Record<string, string | number | null> = {};
      for (const field of contract.fields) {
        values[field.name] = record.values[field.name] ?? null;
      }
      return values;
    });
    requireBudget();
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'succeeded',
      detail: { data_product_release: release.release, matched_count: selected.length, returned: projected.length },
    });
    return {
      ...identity,
      kind: 'records',
      records: projected,
      matched_count: selected.length,
      returned: projected.length,
      truncated: selected.length > projected.length,
      limit: query.limit,
      scanned_records: scanned,
      ...(query.window === undefined || contract.time === undefined
        ? { window: null }
        : { window: windowView(contract.time, query.window, coverage) }),
      provenance,
    };
  }

  const spec = { groupBy: query.groupBy, metrics: query.metrics, schema };
  const base = evaluateAggregate(selectRecords(datasetRelease.records, contract, query.filters, query.window), spec);
  const compared = query.comparison === undefined || contract.time === undefined
    ? null
    : evaluateAggregate(selectRecords(datasetRelease.records, contract, query.filters, query.comparison), spec);
  const merged = mergeWindows(query.metrics, base.groups, compared?.groups ?? null)
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
  const returned = orderGroups(merged, query.sort).slice(0, query.limit);
  requireBudget();

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      data_product_release: release.release,
      group_count: merged.length,
      returned: returned.length,
    },
  });
  return {
    ...identity,
    kind: 'aggregate',
    grouped_by: [...query.groupBy],
    metrics: query.metrics.map(metricView),
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
            comparison: Object.fromEntries(query.metrics.map((metric) => [
              metric.name,
              compareMetric(metric, base.totals[metric.name] ?? null, compared.totals[metric.name] ?? null),
            ])),
          }),
      }
      : null,
    groups_total: merged.length,
    returned: returned.length,
    truncated: merged.length > returned.length,
    limit: query.limit,
    scanned_records: scanned,
    ...(query.window === undefined || contract.time === undefined
      ? { window: null }
      : { window: windowView(contract.time, query.window, coverage) }),
    ...(query.comparison === undefined || contract.time === undefined
      ? { comparison_window: null }
      : { comparison_window: windowView(contract.time, query.comparison, coverage) }),
    provenance,
  };
}