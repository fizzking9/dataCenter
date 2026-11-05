import {
  type DataProductContract,
  type DataProductMetric,
  type DataProductQueryLimits,
  type DataProductSearch,
  type DataProductSearchRanking,
  type DataProductTime,
  type DatasetSchemaField,
  type MetricAggregation,
  type MetricValueType,
} from './catalog.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';

const TITLE_MINIMUM = 2;
const TITLE_MAXIMUM = 128;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const LIMIT_CEILING = 10000;

const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const AGGREGATIONS: MetricAggregation[] = ['count', 'sum', 'min', 'max', 'avg'];
const VALUE_TYPES: MetricValueType[] = ['integer', 'decimal', 'money', 'date', 'timestamp'];
const TIME_PRECISIONS: Array<DataProductTime['precision']> = ['date', 'timestamp'];

/** The one ranking this release ships; a Contract names it rather than describing it. */
const SEARCH_RANKINGS: Array<DataProductSearchRanking['kind']> = ['weighted_term_frequency'];
/** Fields every search result already carries, so a Contract field may not shadow them. */
const RESERVED_RESULT_FIELDS = ['score', 'matched_terms'];
const TERM_WEIGHT_CEILING = 100;
const MAX_TERMS_CEILING = 64;
const MIN_TERM_LENGTH_CEILING = 32;
const DEFAULT_MAX_TERMS = 8;
const DEFAULT_MIN_TERM_LENGTH = 2;

/** The resource envelope a Contract gets when it declares none of its own. */
const DEFAULT_QUERY_LIMITS: DataProductQueryLimits = {
  max_scanned_records: 100_000,
  max_groups: 10_000,
  max_execution_ms: 5_000,
};

const QUERY_LIMIT_CEILINGS: DataProductQueryLimits = {
  max_scanned_records: 10_000_000,
  max_groups: 100_000,
  max_execution_ms: 60_000,
};

/**
 * Reads a list of names that must each resolve to one of `allowed`, without
 * repeating itself. Dimensions, grain, filters, and a metric's own dimensions
 * are all the same question asked of different governed sets.
 */
function readNameList(
  fail: Fail,
  raw: unknown,
  allowed: string[],
  messages: { notArray: string; invalid: string },
): string[] {
  const candidates = raw ?? [];
  if (!Array.isArray(candidates)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', messages.notArray);
  }
  const names: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !allowed.includes(candidate)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', messages.invalid);
    }
    if (!names.includes(candidate)) names.push(candidate);
  }
  return names;
}

/**
 * Reads the Consumer-facing Contract and proves every surface it declares —
 * fields, dimensions, metrics, grain, and time — resolves to the exact Dataset
 * Schema behind it. A Contract never restates the Dataset Schema; it selects
 * from it.
 */
export function readContract(fail: Fail, path: string, schema: DatasetSchemaField[]): DataProductContract {
  const parsed = readJsonDocument(
    path,
    fail,
    'DATA_PRODUCT_CONTRACT_UNREADABLE',
    'The Data Product Contract file must contain valid JSON.',
  );
  if (!isRecord(parsed)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'A Data Product Contract must be a JSON object.');
  }
  const title = typeof parsed['title'] === 'string' ? parsed['title'].trim() : '';
  if (title.length < TITLE_MINIMUM || title.length > TITLE_MAXIMUM) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'A Data Product Contract title must contain 2 to 128 characters.');
  }
  const description = parsed['description'];
  if (description !== undefined && typeof description !== 'string') {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'A Data Product Contract description must be a string.');
  }

  const fields = readFields(fail, parsed['fields'], schema);
  const dimensions = readDimensions(fail, parsed['dimensions'], fields);
  const metrics = readMetrics(fail, parsed['metrics'], fields, dimensions, schema);
  const grain = readGrain(fail, parsed['grain'], schema);
  const time = readTime(fail, parsed['time'], schema);
  const filters = readFilters(fail, parsed['filters'], fields);
  const { defaultLimit, maxLimit } = readPageLimits(fail, parsed['limit']);
  const limits = readQueryLimits(fail, parsed['limits']);
  const search = readSearch(fail, parsed['search'], fields, schema);

  return {
    title,
    ...(typeof description === 'string' ? { description } : {}),
    fields,
    dimensions,
    metrics,
    grain,
    ...(time === undefined ? {} : { time }),
    filters,
    default_limit: defaultLimit,
    max_limit: maxLimit,
    limits,
    ...(search === undefined ? {} : { search }),
  };
}

function readFields(fail: Fail, raw: unknown, schema: DatasetSchemaField[]): DataProductContract['fields'] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'A Data Product Contract must expose at least one field.');
  }
  const declared: DataProductContract['fields'] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate['name'] !== 'string') {
      fail('DATA_PRODUCT_CONTRACT_INVALID', 'Each Data Product Contract field must name a Dataset Schema field.');
    }
    const name = candidate['name'];
    if (!schema.some((field) => field.name === name)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `${name} is not a field of this Dataset Schema.`);
    }
    if (declared.some((field) => field.name === name)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', 'Each Data Product Contract field must appear once.');
    }
    const fieldDescription = candidate['description'];
    declared.push({
      name,
      ...(typeof fieldDescription === 'string' ? { description: fieldDescription } : {}),
    });
  }
  return declared;
}

function readDimensions(fail: Fail, raw: unknown, fields: DataProductContract['fields']): string[] {
  return readNameList(fail, raw, fields.map((field) => field.name), {
    notArray: 'Contract dimensions must be an array of exposed field names.',
    invalid: 'Each Contract dimension must name an exposed field.',
  });
}

/**
 * Reads the governed metrics, proving each one is evaluable: a count names no
 * field, an arithmetic metric names a field it can really sum or average, a
 * temporal extremum keeps its own value type, and a monetary metric states the
 * currency a Consumer needs in order to read the amount.
 */
function readMetrics(
  fail: Fail,
  raw: unknown,
  fields: DataProductContract['fields'],
  dimensions: string[],
  schema: DatasetSchemaField[],
): DataProductMetric[] {
  const candidates = raw ?? [];
  if (!Array.isArray(candidates)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract metrics must be an array of metric definitions.');
  }
  const metrics: DataProductMetric[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate['name'] !== 'string' || !METRIC_NAME.test(candidate['name'])) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', 'Each metric name must be a lowercase identifier of up to 64 characters.');
    }
    const name = candidate['name'];
    if (metrics.some((metric) => metric.name === name)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', 'Each metric name must appear once.');
    }
    if (dimensions.includes(name) || fields.some((field) => field.name === name)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `${name} is already a published field or dimension, so it cannot name a metric.`);
    }
    const aggregation = candidate['aggregation'] as MetricAggregation;
    if (!AGGREGATIONS.includes(aggregation)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `Each metric aggregation must be one of: ${AGGREGATIONS.join(', ')}.`);
    }
    const valueType = candidate['value_type'] as MetricValueType;
    if (!VALUE_TYPES.includes(valueType)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `Each metric value type must be one of: ${VALUE_TYPES.join(', ')}.`);
    }
    const field = readMetricField(fail, name, aggregation, candidate['field'], valueType, schema);
    const unit = readUnit(fail, name, candidate['unit']);
    const currency = readCurrency(fail, name, valueType, candidate['currency']);
    const metricDimensions = readMetricDimensions(fail, name, candidate['dimensions'], dimensions);
    metrics.push({
      name,
      ...(typeof candidate['description'] === 'string' ? { description: candidate['description'] } : {}),
      aggregation,
      ...(field === undefined ? {} : { field }),
      value_type: valueType,
      ...(unit === undefined ? {} : { unit }),
      ...(currency === undefined ? {} : { currency }),
      ...(metricDimensions === undefined ? {} : { dimensions: metricDimensions }),
    });
  }
  return metrics;
}

function readMetricField(
  fail: Fail,
  name: string,
  aggregation: MetricAggregation,
  raw: unknown,
  valueType: MetricValueType,
  schema: DatasetSchemaField[],
): string | undefined {
  if (aggregation === 'count') {
    if (raw !== undefined) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric counts records, so it names no Dataset Schema field.`);
    }
    if (valueType !== 'integer') {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric counts records, so it always yields integers.`);
    }
    return undefined;
  }
  const field = typeof raw === 'string' ? schema.find((candidate) => candidate.name === raw) : undefined;
  if (!field) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric must aggregate a Dataset Schema field.`);
  }
  const numeric = field.type === 'integer' || field.type === 'number';
  const temporal = field.type === 'date' || field.type === 'timestamp';
  if (aggregation === 'min' || aggregation === 'max') {
    if (!numeric && !temporal) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric cannot take a ${field.type} extremum.`);
    }
    if (temporal && valueType !== field.type) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric reads a ${field.type} field, so its value type is ${field.type}.`);
    }
    if (numeric && (valueType === 'date' || valueType === 'timestamp')) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric reads a ${field.type} field, so it cannot claim ${valueType} values.`);
    }
  } else {
    if (!numeric) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric must aggregate an integer or number Dataset Schema field.`);
    }
    if (valueType === 'date' || valueType === 'timestamp') {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric cannot produce ${valueType} values.`);
    }
  }
  if (aggregation === 'avg' && valueType === 'integer') {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric averages a field, so its values cannot be integers.`);
  }
  if (field.type === 'number' && valueType === 'integer' && aggregation !== 'avg') {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric reads a number field, so it cannot claim integers.`);
  }
  return field.name;
}

function readUnit(fail: Fail, name: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 32) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric unit must be a unit of up to 32 characters.`);
  }
  return raw;
}

function readCurrency(fail: Fail, name: string, valueType: MetricValueType, raw: unknown): string | undefined {
  if (valueType !== 'money') {
    if (raw !== undefined) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric is not monetary, so it cannot declare a currency.`);
    }
    return undefined;
  }
  if (typeof raw !== 'string' || !/^[A-Z]{3}$/.test(raw)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} metric states a monetary value, so it must declare a three-letter currency.`);
  }
  return raw;
}

function readMetricDimensions(fail: Fail, name: string, raw: unknown, dimensions: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  return readNameList(fail, raw, dimensions, {
    notArray: `The ${name} metric dimensions must be an array of Contract dimensions.`,
    invalid: `Every ${name} metric dimension must be a declared Contract dimension.`,
  });
}

function readGrain(fail: Fail, raw: unknown, schema: DatasetSchemaField[]): string[] {
  return readNameList(fail, raw, schema.map((field) => field.name), {
    notArray: 'Contract grain must be an array of Dataset Schema field names.',
    invalid: 'Each Contract grain field must be a Dataset Schema field.',
  });
}

/** Proves a Contract's declared time field really carries the precision a window is read at. */
function readTime(fail: Fail, raw: unknown, schema: DatasetSchemaField[]): DataProductTime | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract time must state a field, a precision, and the business time zone.');
  }
  const field = typeof raw['field'] === 'string' ? schema.find((candidate) => candidate.name === raw['field']) : undefined;
  if (!field) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'The Contract time field must be a Dataset Schema field.');
  }
  const precision = raw['precision'] as DataProductTime['precision'];
  if (!TIME_PRECISIONS.includes(precision)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `Contract time precision must be one of: ${TIME_PRECISIONS.join(', ')}.`);
  }
  if (field.type !== precision) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${field.name} field is a ${field.type}, so its Contract time precision is ${field.type}.`);
  }
  const timeZone = raw['time_zone'];
  if (typeof timeZone !== 'string' || !resolvesTimeZone(timeZone)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'The Contract must state a business time zone the platform can resolve.');
  }
  return { field: field.name, precision, time_zone: timeZone };
}

function resolvesTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readFilters(fail: Fail, raw: unknown, fields: DataProductContract['fields']): string[] {
  return readNameList(fail, raw, fields.map((field) => field.name), {
    notArray: 'Contract filters must be an array of exposed field names.',
    invalid: 'Each Contract filter must name an exposed field.',
  });
}

function readPageLimits(fail: Fail, raw: unknown): { defaultLimit: number; maxLimit: number } {
  const limits = raw ?? {};
  if (!isRecord(limits)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract limits must be an object.');
  }
  const defaultLimit = limits['default'] ?? DEFAULT_LIMIT;
  const maxLimit = limits['max'] ?? MAX_LIMIT;
  if (!Number.isInteger(defaultLimit) || !Number.isInteger(maxLimit)
    || (defaultLimit as number) < 1 || (maxLimit as number) < 1
    || (maxLimit as number) > LIMIT_CEILING || (defaultLimit as number) > (maxLimit as number)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `Contract limits must be whole numbers between 1 and ${LIMIT_CEILING}, with a default no larger than the maximum.`);
  }
  return { defaultLimit: defaultLimit as number, maxLimit: maxLimit as number };
}

/** Reads the resource envelope a Consumer query is held to; unstated limits take the default. */
function readQueryLimits(fail: Fail, raw: unknown): DataProductQueryLimits {
  const limits = raw ?? {};
  if (!isRecord(limits)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract query limits must be an object.');
  }
  const read = (name: keyof DataProductQueryLimits): number => {
    const value = limits[name] ?? DEFAULT_QUERY_LIMITS[name];
    // An execution budget of zero is meaningful: the Contract refuses every
    // query that has records to scan rather than promising time it will not give.
    const minimum = name === 'max_execution_ms' ? 0 : 1;
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > QUERY_LIMIT_CEILINGS[name]) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `Contract ${name} must be a whole number between ${minimum} and ${QUERY_LIMIT_CEILINGS[name]}.`);
    }
    return value as number;
  };
  return {
    max_scanned_records: read('max_scanned_records'),
    max_groups: read('max_groups'),
    max_execution_ms: read('max_execution_ms'),
  };
}

function readWholeNumber(
  fail: Fail,
  label: string,
  raw: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = raw ?? fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `Contract search ${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function readSearchRanking(fail: Fail, raw: unknown): DataProductSearchRanking {
  if (!isRecord(raw)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract search ranking must state its kind and term weights.');
  }
  const kind = raw['kind'] as DataProductSearchRanking['kind'];
  if (!SEARCH_RANKINGS.includes(kind)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', `Contract search ranking kind must be one of: ${SEARCH_RANKINGS.join(', ')}.`);
  }
  const weight = (label: string, value: unknown): number => {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > TERM_WEIGHT_CEILING) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `Contract search ${label} must be a whole number between 1 and ${TERM_WEIGHT_CEILING}.`);
    }
    return value as number;
  };
  return {
    kind,
    title_weight: weight('title_weight', raw['title_weight'] ?? 1),
    text_weight: weight('text_weight', raw['text_weight'] ?? 1),
  };
}

/**
 * Reads the search capability a Document Contract declares. Every field it
 * names is one the Contract already exposes and one the Dataset Schema holds
 * string values in, so a search never reaches a field a Consumer cannot read.
 */
function readSearch(
  fail: Fail,
  raw: unknown,
  fields: DataProductContract['fields'],
  schema: DatasetSchemaField[],
): DataProductSearch | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract search must state the field it searches and how it ranks.');
  }
  const exposed = fields.map((field) => field.name);
  const stringFields = schema.filter((field) => field.type === 'string').map((field) => field.name);
  const shadowed = exposed.filter((name) => RESERVED_RESULT_FIELDS.includes(name));
  if (shadowed.length > 0) {
    fail(
      'DATA_PRODUCT_CONTRACT_INVALID',
      `${shadowed.join(', ')} already names a value every search result carries, so a searchable Contract cannot publish it as a field.`,
    );
  }

  const textField = raw['text_field'];
  if (typeof textField !== 'string' || !stringFields.includes(textField)) {
    fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract search text_field must name an exposed string field.');
  }
  let titleField: string | undefined;
  const rawTitle = raw['title_field'];
  if (rawTitle !== undefined) {
    if (typeof rawTitle !== 'string' || !stringFields.includes(rawTitle)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract search title_field must name an exposed string field.');
    }
    if (rawTitle === textField) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', 'Contract search title_field must differ from its text_field.');
    }
    titleField = rawTitle;
  }
  const suggestFields = readNameList(fail, raw['suggest_fields'] ?? [], exposed, {
    notArray: 'Contract search suggest_fields must be an array of exposed field names.',
    invalid: 'Each Contract search suggest field must name an exposed field.',
  });
  for (const name of suggestFields) {
    if (!stringFields.includes(name)) {
      fail('DATA_PRODUCT_CONTRACT_INVALID', `The ${name} suggest field is not a string field, so it can suggest no term.`);
    }
  }
  return {
    text_field: textField,
    ...(titleField === undefined ? {} : { title_field: titleField }),
    suggest_fields: suggestFields,
    ranking: readSearchRanking(fail, raw['ranking']),
    max_terms: readWholeNumber(fail, 'max_terms', raw['max_terms'], DEFAULT_MAX_TERMS, 1, MAX_TERMS_CEILING),
    min_term_length: readWholeNumber(
      fail,
      'min_term_length',
      raw['min_term_length'],
      DEFAULT_MIN_TERM_LENGTH,
      1,
      MIN_TERM_LENGTH_CEILING,
    ),
  };
}