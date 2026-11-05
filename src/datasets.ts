import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext, type Actor } from './authz.js';
import {
  DEFAULT_DOCUMENT_PARSE_LIMITS,
  DOCUMENT_BUNDLE_PARSER,
  findDataset,
  findIntegrationConfiguration,
  ISO_TIMESTAMP,
  latestDatasetRelease,
  latestIntegrationBatch,
  type CleaningRule,
  type DatasetArtifact,
  type DatasetRecordRow,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
  type DocumentParseLimits,
  type IntegrationConfigurationVersion,
  type ProposalTransformation,
  type RawAcquisitionRecord,
  type RecordRejection,
  type SourceRecord,
} from './catalog.js';
import { parseCsv } from './csv.js';
import { canonicalDigest } from './crypto.js';
import { parseDocumentBundleIsolated } from './document-isolate.js';
import { isRecord, valueAtPath } from './documents.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

/** One Raw Acquisition together with the Integration Batch that handed it over. */
interface BatchFragment {
  batch_id: string;
  raw: RawAcquisitionRecord;
}

interface IntegrationOutcome {
  records: DatasetRecordRow[];
  rejections: RecordRejection[];
}

/** One fragment's source records, whichever representation acquired them. */
export interface FragmentTable {
  header: string[];
  rows: Array<{ row: number; cells: string[]; locator?: string }>;
}

/**
 * The Configuration facts one fragment needs to become a table: the columns it
 * maps, and the envelope a document bundle is parsed under. A full Integration
 * Configuration Version is one, and so is a Proposal candidate.
 */
interface FragmentConfiguration {
  mapping: Record<string, string>;
  document_limits?: DocumentParseLimits;
}

function digest(value: unknown): string {
  return canonicalDigest(value);
}

function cellOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Reads one document bundle into the same header-and-rows table a CSV file
 * becomes, so mapping, cleaning, coercion, identity, and Record Rejection apply
 * to documents exactly as they apply to records.
 *
 * The parse runs in an isolated worker under the envelope the Configuration
 * declared. The columns are the ones the Configuration maps — a bundle is
 * schema-less, so the mapping, not the bundle, states the field set — and each
 * row keeps the locator of the document it was read from.
 */
function documentTable(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  configuration: FragmentConfiguration,
  raw: RawAcquisitionRecord,
  text: string,
): FragmentTable {
  const refuse: (code: string, message: string) => never = (code, message) =>
    reject(session, actorLabel(actor.user), context, code, message);
  // Bytes are opaque until this point; a bundle that is not UTF-8 text has no
  // governed reading, so it is refused rather than decoded with replacements.
  if (Buffer.byteLength(text, 'utf8') !== raw.byte_length || text.includes('\u0000') || text.includes('\uFFFD')) {
    refuse('DOCUMENT_CONTENT_NOT_TEXT', 'A document bundle must be UTF-8 text; this Raw Acquisition is not.');
  }
  const parsed = parseDocumentBundleIsolated(text, configuration.document_limits ?? DEFAULT_DOCUMENT_PARSE_LIMITS);
  if (!parsed.ok) refuse(parsed.code, parsed.message);
  const header = Object.keys(configuration.mapping);
  return {
    header,
    rows: parsed.documents.map((document, index) => ({
      row: index + 1,
      locator: document.locator,
      cells: header.map((column) => cellOf(document.fields[column])),
    })),
  };
}

/**
 * Reads one Raw Acquisition the way its Source was acquired: a manual upload is
 * CSV, and a connector page is the JSON the Plan's record path names. Both become
 * the same header-and-rows table, so one Integration Configuration applies to
 * either without knowing which connector produced the fragment.
 */
function fragmentTable(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  configuration: FragmentConfiguration,
  raw: RawAcquisitionRecord,
  text: string,
): FragmentTable {
  const source = session.state.sources.find((candidate) => candidate.source_id === raw.source_id);
  if (source?.type === 'document') {
    return documentTable(session, actor, context, configuration, raw, text);
  }
  if (source?.type !== 'http_json') {
    const document = parseCsv(text, (code, message) => reject(session, actorLabel(actor.user), context, code, message));
    return { header: document.header, rows: document.rows };
  }
  const plan = session.state.acquisition_plans.find(
    (candidate) => candidate.acquisition_run_id === raw.acquisition_run_id
      && candidate.pages.some((page) => page.raw_id === raw.raw_id),
  );
  const acquisition = session.state.source_acquisitions
    .find((candidate) => candidate.source_id === raw.source_id)
    ?.versions.find((candidate) => candidate.version === plan?.acquisition_configuration_version);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    reject(session, actorLabel(actor.user), context, 'INTEGRATION_FRAGMENT_MALFORMED', 'A connector Raw Acquisition does not hold the JSON its Plan read.');
  }
  const records = valueAtPath(body, acquisition?.record_path ?? null);
  if (!Array.isArray(records)) {
    reject(session, actorLabel(actor.user), context, 'INTEGRATION_FRAGMENT_MALFORMED', 'A connector Raw Acquisition holds no records array at its configured path.');
  }
  // The columns are the ones the records actually carry, so a mapping that names
  // a column the endpoint never sends is refused here exactly as it is for CSV.
  // An empty page names no columns and has no rows to lose, so it keeps the
  // mapped ones and lets the mapping check pass on evidence it does not have.
  const header = records.length === 0
    ? Object.keys(configuration.mapping)
    : [...new Set(records.flatMap((record) => (isRecord(record) ? Object.keys(record) : [])))];
  if (records.length > 0 && header.length === 0) {
    reject(session, actorLabel(actor.user), context, 'INTEGRATION_FRAGMENT_MALFORMED', 'A connector Raw Acquisition holds records that are not objects.');
  }
  return {
    header,
    rows: records.map((record, index) => ({
      row: index + 1,
      cells: header.map((column) => cellOf(
        typeof record === 'object' && record !== null ? (record as Record<string, unknown>)[column] : undefined,
      )),
    })),
  };
}

/**
 * Reads one Raw Acquisition into the same header-and-rows table whichever way
 * it was acquired, so a Proposal preview runs what a Release would run.
 */
export function rawTableOf(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  configuration: FragmentConfiguration,
  raw: RawAcquisitionRecord,
): FragmentTable {
  let text: string;
  try {
    text = readFileSync(join(session.root, raw.object_path), 'utf8');
  } catch {
    reject(session, actorLabel(actor.user), context, 'RAW_ACQUISITION_UNAVAILABLE', 'A Raw Acquisition for this Batch cannot be read.');
  }
  return fragmentTable(session, actor, context, configuration, raw, text);
}

function applyCleaning(rules: CleaningRule[], field: string, value: string): { value: string } | { rejected: string } {
  let cleaned = value;
  for (const rule of rules) {
    if (rule.field !== field) continue;
    if (rule.rule === 'trim') cleaned = cleaned.trim();
    if (rule.rule === 'uppercase') cleaned = cleaned.toUpperCase();
    if (rule.rule === 'lowercase') cleaned = cleaned.toLowerCase();
    if (rule.rule === 'default' && cleaned === '') cleaned = rule.value ?? '';
    if (rule.rule === 'require_non_empty' && cleaned === '') return { rejected: 'VALUE_MISSING' };
  }
  return { value: cleaned };
}

/**
 * Coerces one cleaned source cell into its canonical value. A cell that holds
 * nothing becomes a null value whatever the field type, so a missing value is
 * always the same governed fact rather than an empty string in some columns.
 */
function coerce(
  field: DatasetSchemaField,
  value: string,
): { value: string | number | null } | { rejected: string } {
  if (value === '') return { value: null };
  if (field.type === 'string') return { value };
  if (field.type === 'integer') {
    return /^-?\d+$/.test(value) ? { value: Number(value) } : { rejected: 'NOT_INTEGER' };
  }
  if (field.type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? { value: parsed } : { rejected: 'NOT_NUMBER' };
  }
  if (field.type === 'timestamp') {
    return ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
      ? { value }
      : { rejected: 'NOT_TIMESTAMP' };
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    ? { value }
    : { rejected: 'NOT_DATE' };
}

/**
 * Applies one Integration Configuration Version to every Raw Acquisition in the
 * Batch. A source record that cannot become a canonical record becomes a Record
 * Rejection, so the rest of the snapshot still governs.
 */
/**
 * The exact integration semantics a candidate is exercised under, named without
 * a published Version so a Proposal can run before anything is published.
 */
export interface IntegrationRules {
  identity: string[];
  schema: DatasetSchemaField[];
  cleaning: CleaningRule[];
  mapping: Record<string, string>;
  /** The Version number every Record Rejection is recorded under. */
  version: number;
}

/**
 * What one Integration Configuration would do to one table. `unmapped` names
 * raw columns the configuration ignores; `missing` names mapped columns the
 * table does not carry, so a caller can report drift instead of guessing.
 */
export interface TableOutcome {
  records: DatasetRecordRow[];
  rejections: RecordRejection[];
  transformations: ProposalTransformation[];
  unmapped: string[];
  missing: string[];
}

/**
 * Applies one Integration Configuration to one table without writing anything.
 * A Dataset Release and a Proposal preview both run here, so a preview reports
 * exactly what a Release would do, and neither invents a second semantic.
 */
export function applyIntegrationTable(
  rules: IntegrationRules,
  table: FragmentTable,
  rawId: string,
  seenInBatch: Set<string> = new Set<string>(),
): TableOutcome {
  const records = new Map<string, DatasetRecordRow>();
  const rejections: RecordRejection[] = [];
  const transformations: ProposalTransformation[] = [];
  const mapped = Object.entries(rules.mapping);
  const unmapped = table.header.filter((column) => rules.mapping[column] === undefined);
  const missing = mapped.map(([column]) => column).filter((column) => !table.header.includes(column));
  const seenInFragment = new Set<string>();

  if (missing.length === 0) {
    for (const row of table.rows) {
      const rejectRow = (field: string | null, rule: RecordRejection['rule'], reason: string): void => {
        rejections.push({
          raw_id: rawId,
          row: row.row,
          field,
          rule,
          reason,
          integration_configuration_version: rules.version,
        });
      };

      const values: Record<string, string | number | null> = {};
      let failed = false;
      for (const [column, field] of mapped) {
        const schemaField = rules.schema.find((candidate) => candidate.name === field)!;
        const rawValue = row.cells[table.header.indexOf(column)] ?? '';
        let cleanedValue = rawValue;
        for (const rule of rules.cleaning) {
          if (rule.field !== field) continue;
          const cleaned = applyCleaning([rule], field, cleanedValue);
          if ('rejected' in cleaned) {
            rejectRow(field, rule.rule, cleaned.rejected);
            failed = true;
            break;
          }
          if (cleaned.value !== cleanedValue) {
            // A preview reports what the rule really changed, not that it ran.
            transformations.push({
              raw_id: rawId,
              row: row.row,
              field,
              rule: rule.rule,
              before: cleanedValue,
              after: cleaned.value,
            });
            cleanedValue = cleaned.value;
          }
        }
        if (failed) break;
        const coerced = coerce(schemaField, cleanedValue);
        if ('rejected' in coerced) {
          rejectRow(field, 'type', coerced.rejected);
          failed = true;
          break;
        }
        values[field] = coerced.value;
      }
      if (failed) continue;

      const absent = rules.identity.find((field) => values[field] === null || values[field] === '');
      if (absent !== undefined) {
        rejectRow(absent, 'identity', 'IDENTITY_MISSING');
        continue;
      }
      const identity = rules.identity.map((field) => `${field}=${String(values[field])}`).join('|');
      // A repeat inside one Batch is an ambiguous record, but a repeat across
      // Batches is a later acquisition of the same record and wins.
      if (seenInFragment.has(identity) || seenInBatch.has(identity)) {
        rejectRow(rules.identity[0] ?? null, 'identity', 'DUPLICATE_IDENTITY');
        continue;
      }
      seenInFragment.add(identity);
      seenInBatch.add(identity);
      records.set(identity, {
        identity,
        values,
        ...(row.locator === undefined ? {} : { raw: { raw_id: rawId, locator: row.locator } }),
      });
    }
  }

  return { records: [...records.values()], rejections, transformations, unmapped, missing };
}

/**
 * Applies one Integration Configuration Version to every Raw Acquisition in the
 * Batch. A source record that cannot become a canonical record becomes a Record
 * Rejection, so the rest of the snapshot still governs.
 */
function integrate(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  version: IntegrationConfigurationVersion,
  fragments: BatchFragment[],
): IntegrationOutcome {
  const records = new Map<string, DatasetRecordRow>();
  const rejections: RecordRejection[] = [];
  const rules: IntegrationRules = {
    identity: version.identity_fields,
    schema: version.schema,
    cleaning: version.cleaning,
    mapping: version.mapping,
    version: version.version,
  };
  const mapped = Object.keys(version.mapping);
  let currentBatch: string | null = null;
  let seenInBatch = new Set<string>();

  for (const fragment of fragments) {
    if (fragment.batch_id !== currentBatch) {
      currentBatch = fragment.batch_id;
      seenInBatch = new Set<string>();
    }
    const table = rawTableOf(session, actor, context, version, fragment.raw);
    const unknown = mapped.filter((column) => !table.header.includes(column));
    if (unknown.length > 0) {
      reject(
        session,
        actorLabel(actor.user),
        context,
        'INTEGRATION_MAPPING_UNKNOWN_COLUMN',
        `The acquired file has no source column named: ${unknown.join(', ')}.`,
      );
    }
    const outcome = applyIntegrationTable(rules, table, fragment.raw.raw_id, seenInBatch);
    for (const record of outcome.records) records.set(record.identity, record);
    rejections.push(...outcome.rejections);
  }

  return {
    records: [...records.values()].sort((left, right) => left.identity.localeCompare(right.identity)),
    rejections,
  };
}

/**
 * Produces the next Dataset Release by reconciling every Integration Batch that
 * was acquired under one Integration Configuration Version.
 *
 * A Dataset Release is a logically complete snapshot, so a later acquisition of
 * one record updates it by stable identity and earlier records survive. A
 * redelivery that reconciles to the same canonical record set is not a new
 * release, so repeated acquisition never duplicates records or Releases.
 *
 * Deletion of a record that a source stopped reporting is not this command's
 * decision; it arrives with source tombstones and full-snapshot deletion.
 */
export function releaseDataset(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'dataset_release', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const released = releaseDatasetFor(session, actor, source);
  session.save();
  return released;
}

/**
 * Produces the next Dataset Release inside a session the caller already holds,
 * so an Acquisition Run persists the Release and its checkpoint in one save.
 * The caller owns the save; this never persists on its own.
 */
export function releaseDatasetFor(
  session: PlatformSession,
  actor: Actor,
  source: SourceRecord,
): Record<string, unknown> {
  const context: ActionContext = { action: 'dataset_release', scope: 'workspace' };
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  const latestBatch = latestIntegrationBatch(session.state.integration_batches, source.source_id);
  if (!latestBatch) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'INTEGRATION_BATCH_NOT_FOUND',
      'The Source has no complete Integration Batch to integrate.',
      'Acquire the Source so one complete Acquisition Run hands over an Integration Batch.',
    );
  }
  const version = findIntegrationConfiguration(
    session.state.integration_configurations,
    source.source_id,
  )?.versions.find((candidate) => candidate.version === latestBatch.integration_configuration_version);
  if (!version) {
    reject(session, actorLabel(actor.user), scoped, 'INTEGRATION_VERSION_NOT_FOUND', 'The Integration Configuration Version this Batch pins no longer exists.');
  }
  const batches = session.state.integration_batches.filter(
    (candidate) => candidate.source_id === source.source_id
      && candidate.integration_configuration_version === version.version
      && candidate.quarantined_at === null,
  );
  const fragments = batches.flatMap((batch) => batch.raw_acquisition_ids.flatMap((rawId) => {
    const raw = session.state.raw_acquisitions.find((candidate) => candidate.raw_id === rawId);
    return raw === undefined
      ? []
      : [{ batch_id: batch.batch_id, raw }];
  }));
  const outcome = integrate(session, actor, scoped, version, fragments);
  // The hash covers the curated values alone, so a redelivery that reconciles
  // to the same records is the same Release even though its Raw Acquisition — 
  // and so its per-document locator — is a different one.
  const recordsHash = digest(outcome.records.map((record) => ({ identity: record.identity, values: record.values })));

  let dataset = findDataset(session.state.datasets, source.source_id);
  if (!dataset) {
    dataset = {
      dataset_id: randomUUID(),
      workspace_id: source.workspace_id,
      source_id: source.source_id,
      owner_user_id: source.owner_user_id,
      created_at: new Date().toISOString(),
      releases: [],
    };
    session.state.datasets.push(dataset);
  }
  const latest = latestDatasetRelease(dataset);

  if (latest
    && latest.records_hash === recordsHash
    && latest.integration_configuration_version === version.version) {
    session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { reused_release: latest.release } });
    return { ...view(dataset, latest), reused: true };
  }

  const release: DatasetReleaseRecord = {
    dataset_id: dataset.dataset_id,
    workspace_id: dataset.workspace_id,
    source_id: dataset.source_id,
    release: (latest?.release ?? 0) + 1,
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    record_count: outcome.records.length,
    records_hash: recordsHash,
    integration_configuration_version: version.version,
    schema_hash: version.schema_hash,
    cleaning_hash: version.cleaning_hash,
    mapping_hash: version.mapping_hash,
    pins: { ...version.pins },
    provenance: {
      batch_ids: batches.map((batch) => batch.batch_id),
      acquisition_run_ids: batches.map((batch) => batch.acquisition_run_id),
      raw_acquisition_ids: batches.flatMap((batch) => batch.raw_acquisition_ids),
      acquired_at: fragments.map((fragment) => fragment.raw.received_at).sort()[0] ?? latestBatch.created_at,
      integrated_at: new Date().toISOString(),
    },
    records: outcome.records,
    record_rejections: outcome.rejections,
    ...(source.type === 'document'
      ? {
        document_processing: {
          parser: { ...DOCUMENT_BUNDLE_PARSER },
          limits: { ...(version.document_limits ?? DEFAULT_DOCUMENT_PARSE_LIMITS) },
        },
      }
      : {}),
  };
  dataset.releases.push(release);

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      dataset_release: release.release,
      record_count: release.record_count,
      record_rejection_count: release.record_rejections.length,
      integration_configuration_version: release.integration_configuration_version,
    },
  });
  return { ...view(dataset, release), reused: false };
}

/** Reads one exact Dataset Release, including the canonical records it governs. */
export function showDataset(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  release?: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'dataset_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  const dataset = findDataset(session.state.datasets, source.source_id);
  if (!dataset || dataset.releases.length === 0) {
    reject(session, actorLabel(actor.user), scoped, 'DATASET_RELEASE_NOT_FOUND', 'The Source has no Dataset Release.');
  }
  const release = options.release === undefined
    ? latestDatasetRelease(dataset)!
    : dataset.releases.find((candidate) => candidate.release === options.release);
  if (!release) {
    reject(session, actorLabel(actor.user), scoped, 'DATASET_RELEASE_NOT_FOUND', 'The requested Dataset Release does not exist.');
  }

  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { dataset_release: release.release } });
  return {
    ...view(dataset, release),
    records: release.records,
    record_rejections: release.record_rejections,
  };
}

function view(dataset: DatasetArtifact, release: DatasetReleaseRecord): Record<string, unknown> {
  return {
    dataset_id: dataset.dataset_id,
    workspace_id: dataset.workspace_id,
    source_id: dataset.source_id,
    dataset_release: release.release,
    created_at: release.created_at,
    record_count: release.record_count,
    records_hash: release.records_hash,
    integration_configuration_version: release.integration_configuration_version,
    schema_hash: release.schema_hash,
    cleaning_hash: release.cleaning_hash,
    mapping_hash: release.mapping_hash,
    pins: { ...release.pins },
    record_rejection_count: release.record_rejections.length,
    record_rejections: release.record_rejections.map((rejection) => ({ ...rejection })),
    ...(release.document_processing === undefined
      ? {}
      : {
        document_processing: {
          parser: { ...release.document_processing.parser },
          limits: { ...release.document_processing.limits },
        },
      }),
    provenance: {
      batch_ids: [...release.provenance.batch_ids],
      acquisition_run_ids: [...release.provenance.acquisition_run_ids],
      raw_acquisition_ids: [...release.provenance.raw_acquisition_ids],
      acquired_at: release.provenance.acquired_at,
      integrated_at: release.provenance.integrated_at,
      released_at: release.created_at,
    },
  };
}
