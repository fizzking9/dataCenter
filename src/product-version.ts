import type {
  DataProductContract,
  DataProductContractVersion,
  DataProductMetric,
  DataProductVersion,
} from './catalog.js';

/**
 * What one Publication changes about its Contract.
 *
 * A major line only ever grows: a Consumer pinned to it keeps its fields,
 * dimensions, filters, metrics, grain, and time field, and every declared
 * budget still holds the next Release to no less than before. Anything that
 * takes one of those away is a new major line instead of a silent break.
 */
export interface ContractChange {
  /** The surfaces the next Contract withdraws or narrows; empty means compatible. */
  breaking: string[];
}

function metricKey(metric: DataProductMetric): string {
  return JSON.stringify([
    metric.name,
    metric.aggregation,
    metric.field ?? null,
    metric.value_type,
    metric.unit ?? null,
    metric.currency ?? null,
  ]);
}

function sameTime(previous: DataProductContract, next: DataProductContract): boolean {
  if (previous.time === undefined || next.time === undefined) return previous.time === next.time;
  return previous.time.field === next.time.field
    && previous.time.precision === next.time.precision
    && previous.time.time_zone === next.time.time_zone;
}

function narrower(previous: string[], next: string[]): string[] {
  return previous.filter((name) => !next.includes(name));
}

export function readContractChange(
  previous: DataProductContract,
  next: DataProductContract,
): ContractChange {
  const breaking: string[] = [];
  // A grain or time change re-defines what one row means and which rows a
  // window covers, so grouped results would not reconcile with earlier ones.
  if (JSON.stringify(previous.grain) !== JSON.stringify(next.grain)) breaking.push('grain');
  if (!sameTime(previous, next)) breaking.push('time');

  const nextFields = next.fields.map((field) => field.name);
  if (narrower(previous.fields.map((field) => field.name), nextFields).length > 0) breaking.push('fields');
  if (narrower(previous.dimensions, next.dimensions).length > 0) breaking.push('dimensions');
  if (narrower(previous.filters, next.filters).length > 0) breaking.push('filters');

  for (const metric of previous.metrics) {
    const candidate = next.metrics.find((other) => other.name === metric.name);
    if (!candidate || metricKey(candidate) !== metricKey(metric)) {
      breaking.push('metrics');
      break;
    }
    const previousDimensions = metric.dimensions;
    if (previousDimensions !== undefined
      && narrower(previousDimensions, candidate.dimensions ?? next.dimensions).length > 0) {
      breaking.push('metrics');
      break;
    }
  }

  // A budget only ever widens: lowering one would refuse a query the previous
  // Contract's own Consumers already compose.
  if (next.max_limit < previous.max_limit) breaking.push('limit');
  if (next.limits.max_scanned_records < previous.limits.max_scanned_records
    || next.limits.max_groups < previous.limits.max_groups
    || next.limits.max_execution_ms < previous.limits.max_execution_ms) {
    breaking.push('limits');
  }
  return { breaking };
}

/**
 * The Contract version this Publication takes: the previous line's next minor
 * while every change is additive, otherwise a fresh major line.
 */
export function nextContractVersion(
  previous: DataProductVersion | undefined,
  contract: DataProductContract,
): DataProductContractVersion {
  if (previous === undefined) return { major: 1, minor: 0 };
  const change = readContractChange(previous.contract, contract);
  if (change.breaking.length > 0) {
    return { major: previous.contract_version.major + 1, minor: 0 };
  }
  return { major: previous.contract_version.major, minor: previous.contract_version.minor + 1 };
}
