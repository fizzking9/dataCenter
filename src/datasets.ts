import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext, type Actor } from './authz.js';
import {
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
  type IntegrationConfigurationVersion,
  type RawAcquisitionRecord,
  type RecordRejection,
} from './catalog.js';
import { parseCsv } from './csv.js';
import { canonicalDigest } from './crypto.js';
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

function digest(value: unknown): string {
  return canonicalDigest(value);
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
function integrate(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  version: IntegrationConfigurationVersion,
  fragments: BatchFragment[],
): IntegrationOutcome {
  const records = new Map<string, DatasetRecordRow>();
  const rejections: RecordRejection[] = [];
  const mapped = Object.entries(version.mapping);
  const seenInBatch = new Set<string>();
  let currentBatch: string | null = null;

  for (const fragment of fragments) {
    const raw = fragment.raw;
    if (fragment.batch_id !== currentBatch) {
      currentBatch = fragment.batch_id;
      seenInBatch.clear();
    }
    let text: string;
    try {
      text = readFileSync(join(session.root, raw.object_path), 'utf8');
    } catch {
      reject(session, actorLabel(actor.user), context, 'RAW_ACQUISITION_UNAVAILABLE', 'A Raw Acquisition for this Batch cannot be read.');
    }
    const document = parseCsv(text, (code, message) => reject(session, actorLabel(actor.user), context, code, message));
    const unknown = mapped.map(([column]) => column).filter((column) => !document.header.includes(column));
    if (unknown.length > 0) {
      reject(
        session,
        actorLabel(actor.user),
        context,
        'INTEGRATION_MAPPING_UNKNOWN_COLUMN',
        `The acquired file has no source column named: ${unknown.join(', ')}.`,
      );
    }

    const seenInFragment = new Set<string>();
    for (const row of document.rows) {
      const rejectRow = (field: string | null, rule: RecordRejection['rule'], reason: string): void => {
        rejections.push({
          raw_id: raw.raw_id,
          row: row.row,
          field,
          rule,
          reason,
          integration_configuration_version: version.version,
        });
      };

      const values: Record<string, string | number | null> = {};
      let failed = false;
      for (const [column, field] of mapped) {
        const schemaField = version.schema.find((candidate) => candidate.name === field)!;
        const rawValue = row.cells[document.header.indexOf(column)] ?? '';
        const cleaned = applyCleaning(version.cleaning, field, rawValue);
        if ('rejected' in cleaned) {
          rejectRow(field, 'require_non_empty', cleaned.rejected);
          failed = true;
          break;
        }
        const coerced = coerce(schemaField, cleaned.value);
        if ('rejected' in coerced) {
          rejectRow(field, 'type', coerced.rejected);
          failed = true;
          break;
        }
        values[field] = coerced.value;
      }
      if (failed) continue;

      const missing = version.identity_fields.find((field) => values[field] === null || values[field] === '');
      if (missing !== undefined) {
        rejectRow(missing, 'identity', 'IDENTITY_MISSING');
        continue;
      }
      const identity = version.identity_fields.map((field) => `${field}=${String(values[field])}`).join('|');
      // A repeat inside one Batch is an ambiguous record, but a repeat across
      // Batches is a later acquisition of the same record and wins.
      if (seenInFragment.has(identity) || seenInBatch.has(identity)) {
        rejectRow(version.identity_fields[0] ?? null, 'identity', 'DUPLICATE_IDENTITY');
        continue;
      }
      seenInFragment.add(identity);
      seenInBatch.add(identity);
      records.set(identity, { identity, values });
    }
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
      && candidate.integration_configuration_version === version.version,
  );
  const fragments = batches.flatMap((batch) => batch.raw_acquisition_ids.flatMap((rawId) => {
    const raw = session.state.raw_acquisitions.find((candidate) => candidate.raw_id === rawId);
    return raw === undefined
      ? []
      : [{ batch_id: batch.batch_id, raw }];
  }));
  const outcome = integrate(session, actor, scoped, version, fragments);
  const recordsHash = digest(outcome.records);

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
  session.save();
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
