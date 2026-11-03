import type { DataProductMetric, DatasetRecordRow, DatasetSchemaField } from './catalog.js';

/** How a Consumer reads one governed metric value. */
export type MetricValue = string | number | null;

/** One evaluated group, with the order keys that make paging deterministic. */
export interface EvaluatedGroup {
  group: Record<string, string | number | null>;
  null_dimensions: string[];
  metrics: Record<string, MetricValue>;
  /** The dimension tuple in declaration order, used when no metric orders a result. */
  dimension_order: Array<string | number | null>;
  /** One order key per metric; a null value sorts last whichever direction is asked. */
  metric_order: Record<string, number | null>;
}

interface Extremum {
  value: string | number;
  /** The instant a date or timestamp extremum compares on. */
  instant: number;
}

interface Accumulator {
  records: number;
  sum: number;
  numbered: number;
  lowest: Extremum | null;
  highest: Extremum | null;
}

interface Bucket {
  group: Record<string, string | number | null>;
  nullDimensions: string[];
  dimensionOrder: Array<string | number | null>;
  accumulators: Map<string, Accumulator>;
}

const DECIMAL_PLACES = 2;

/** Date and timestamp fields compare on their instant, never on their text. */
function isTemporal(field: DatasetSchemaField | undefined): boolean {
  return field?.type === 'date' || field?.type === 'timestamp';
}

function emptyAccumulator(): Accumulator {
  return { records: 0, sum: 0, numbered: 0, lowest: null, highest: null };
}

/** Reads one record value as a number, or null when the record has no usable value. */
function numberAt(record: DatasetRecordRow, field: string): number | null {
  const value = record.values[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function accumulate(
  accumulator: Accumulator,
  metric: DataProductMetric,
  record: DatasetRecordRow,
  schemaField: DatasetSchemaField | undefined,
): void {
  accumulator.records += 1;
  if (metric.aggregation === 'count') return;
  const field = metric.field!;
  if (isTemporal(schemaField)) {
    const raw = record.values[field];
    if (raw === null || raw === undefined) return;
    const instant = Date.parse(String(raw));
    if (!Number.isFinite(instant)) return;
    if (accumulator.lowest === null || instant < accumulator.lowest.instant) {
      accumulator.lowest = { value: String(raw), instant };
    }
    if (accumulator.highest === null || instant > accumulator.highest.instant) {
      accumulator.highest = { value: String(raw), instant };
    }
    return;
  }
  const value = numberAt(record, field);
  if (value === null) return;
  accumulator.sum += value;
  accumulator.numbered += 1;
  if (accumulator.lowest === null || value < Number(accumulator.lowest.value)) {
    accumulator.lowest = { value, instant: value };
  }
  if (accumulator.highest === null || value > Number(accumulator.highest.value)) {
    accumulator.highest = { value, instant: value };
  }
}

/**
 * Renders one metric value the way its Contract declares it: counts stay
 * integers, decimals and monetary amounts are strings rounded to two places,
 * dates and timestamps stay ISO, and a value the Release cannot supply is null.
 */
function formatMetricValue(metric: DataProductMetric, raw: number | string | null): MetricValue {
  if (raw === null) return null;
  if (metric.value_type === 'integer') return Math.trunc(Number(raw));
  if (metric.value_type === 'decimal' || metric.value_type === 'money') {
    return Number(raw).toFixed(DECIMAL_PLACES);
  }
  return String(raw);
}

function finalize(
  metric: DataProductMetric,
  accumulator: Accumulator,
): { value: MetricValue; order: number | null } {
  if (metric.aggregation === 'count') {
    return { value: accumulator.records, order: accumulator.records };
  }
  if (metric.aggregation === 'sum') {
    // An empty sum is the arithmetic identity, so a group that only holds null
    // amounts still reconciles with the grand total.
    return { value: formatMetricValue(metric, accumulator.sum), order: accumulator.sum };
  }
  if (metric.aggregation === 'avg') {
    if (accumulator.numbered === 0) return { value: null, order: null };
    const average = accumulator.sum / accumulator.numbered;
    return { value: formatMetricValue(metric, average), order: average };
  }
  const extremum = metric.aggregation === 'min' ? accumulator.lowest : accumulator.highest;
  if (extremum === null) return { value: null, order: null };
  return { value: formatMetricValue(metric, extremum.value), order: extremum.instant };
}

/**
 * Evaluates every declared metric over the records at the Release's record
 * grain, so each record falls into exactly one group and grouped results always
 * add up to the grand total.
 */
export function evaluateAggregate(
  records: DatasetRecordRow[],
  options: { groupBy: string[]; metrics: DataProductMetric[]; schema: DatasetSchemaField[] },
): { groups: EvaluatedGroup[]; totals: Record<string, MetricValue> } {
  const buckets = new Map<string, Bucket>();
  const totalsAccumulators = new Map<string, Accumulator>(
    options.metrics.map((metric) => [metric.name, emptyAccumulator()]),
  );

  for (const record of records) {
    const dimensionValues = options.groupBy.map((dimension) => record.values[dimension] ?? null);
    const key = JSON.stringify(dimensionValues);
    let bucket = buckets.get(key);
    if (!bucket) {
      const group: Record<string, string | number | null> = {};
      options.groupBy.forEach((dimension, index) => {
        group[dimension] = dimensionValues[index] ?? null;
      });
      bucket = {
        group,
        nullDimensions: options.groupBy.filter((_, index) => dimensionValues[index] === null),
        dimensionOrder: dimensionValues,
        accumulators: new Map(options.metrics.map((metric) => [metric.name, emptyAccumulator()])),
      };
      buckets.set(key, bucket);
    }
    for (const metric of options.metrics) {
      const schemaField = options.schema.find((field) => field.name === metric.field);
      accumulate(bucket.accumulators.get(metric.name)!, metric, record, schemaField);
      accumulate(totalsAccumulators.get(metric.name)!, metric, record, schemaField);
    }
  }

  const groups: EvaluatedGroup[] = [];
  for (const bucket of buckets.values()) {
    const metrics: Record<string, MetricValue> = {};
    const metricOrder: Record<string, number | null> = {};
    for (const metric of options.metrics) {
      const finalized = finalize(metric, bucket.accumulators.get(metric.name)!);
      metrics[metric.name] = finalized.value;
      metricOrder[metric.name] = finalized.order;
    }
    groups.push({
      group: bucket.group,
      null_dimensions: bucket.nullDimensions,
      metrics,
      dimension_order: bucket.dimensionOrder,
      metric_order: metricOrder,
    });
  }

  const totals: Record<string, MetricValue> = {};
  for (const metric of options.metrics) {
    totals[metric.name] = finalize(metric, totalsAccumulators.get(metric.name)!).value;
  }
  return { groups, totals };
}

/** Compares two order keys by UTF-16 code unit, so ordering never depends on a host locale. */
function compareKeys(left: string | number | null, right: string | number | null): number {
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
 * Orders groups the way the settled contract requires: a requested sort first,
 * then the whole dimension tuple as a tie-breaker, and null keys always last.
 */
export function orderGroups<T extends EvaluatedGroup>(
  groups: T[],
  sort: Array<{ by: string; direction: 'asc' | 'desc' }>,
): T[] {
  const ordered = [...groups];
  ordered.sort((left, right) => {
    for (const clause of sort) {
      const leftKey = clause.by in left.metric_order ? left.metric_order[clause.by]! : left.group[clause.by] ?? null;
      const rightKey = clause.by in right.metric_order ? right.metric_order[clause.by]! : right.group[clause.by] ?? null;
      if (leftKey === null || rightKey === null) {
        const nullOrder = compareKeys(leftKey, rightKey);
        if (nullOrder !== 0) return nullOrder;
        continue;
      }
      const comparison = compareKeys(leftKey, rightKey);
      if (comparison !== 0) return clause.direction === 'desc' ? -comparison : comparison;
    }
    for (let index = 0; index < left.dimension_order.length; index += 1) {
      const comparison = compareKeys(left.dimension_order[index] ?? null, right.dimension_order[index] ?? null);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
  return ordered;
}