import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  adoptedIntegrationVersion,
  findDataset,
  findIntegrationConfiguration,
  latestDatasetRelease,
  type AcquisitionRunRecord,
  type IntegrationBatchRecord,
  type RawAcquisitionRecord,
} from './catalog.js';
import { releaseDatasetFor } from './datasets.js';
import { OperatorError } from './errors.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministrableSource } from './sources.js';

/** Raw Acquisition objects live outside the platform state file, as opaque bytes. */
function objectPathOf(rawId: string): string {
  return `raw-acquisitions/${rawId}.bin`;
}

/** The largest file one manual upload may store, whatever its Source declares. */
const MAX_MANUAL_UPLOAD_BYTES = 64 * 1024 * 1024;

/** The byte-order marks that state a text encoding other than UTF-8. */
function declaresWideEncoding(bytes: Buffer): boolean {
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) return true;
  }
  return bytes.length >= 2
    && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

/** A ZIP or OLE container is never the delimited text a manual Source declares. */
function isContainer(bytes: Buffer): boolean {
  if (bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)) return true;
  return bytes.length >= 4
    && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

/**
 * Stores one upload attempt as an immutable Raw Acquisition, then hands the
 * complete attempt to integration as one Integration Batch.
 *
 * Acquisition is at-least-once: a repeated upload is another Run with its own
 * Raw Acquisition. Reconciliation belongs to the Dataset Release, so identical
 * bytes never become duplicate canonical records.
 */
export function uploadAcquisition(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  file: string;
}): Record<string, unknown> {
  return storeAcquisition(options, () => {
    try {
      return readFileSync(options.file);
    } catch {
      return null;
    }
  });
}

/**
 * Stores one upload whose bytes the caller already holds. The bytes decide what
 * the file is, not its name: a wide encoding, an archive, or a binary blob is
 * refused before it is stored, so no Release is ever built on a container the
 * Source never declared.
 */
export function uploadAcquisitionBytes(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  bytes: Buffer;
}): Record<string, unknown> {
  return storeAcquisition(options, () => options.bytes);
}

function storeAcquisition(
  options: { root: string; masterKey: string; token: string; sourceId: string },
  load: () => Buffer | null,
): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'source_acquisition', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministrableSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  if (source.type === 'http_json') {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_MODE_MISMATCH',
      'This Source is acquired by a connector, so it is never acquired by a hand upload.',
      'Queue an Acquisition Run for the Source instead.',
    );
  }

  const configuration = adoptedIntegrationVersion(
    findIntegrationConfiguration(session.state.integration_configurations, source.source_id),
  );
  if (!configuration) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SOURCE_INTEGRATION_NOT_ADOPTED',
      'The Source has no adopted Integration Configuration Version to acquire against.',
      'Publish an Integration Configuration for the Source and adopt the exact version.',
    );
  }
  const bytes = load();
  if (bytes === null) {
    reject(session, actorLabel(actor.user), scoped, 'ACQUISITION_FILE_UNREADABLE', 'The acquisition file cannot be read.');
  }
  if (bytes.length === 0) {
    reject(session, actorLabel(actor.user), scoped, 'ACQUISITION_FILE_EMPTY', 'The acquisition file is empty.');
  }
  if (bytes.length > MAX_MANUAL_UPLOAD_BYTES) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_FILE_TOO_LARGE',
      'The acquisition file exceeds the largest manual upload this surface accepts.',
    );
  }
  if (declaresWideEncoding(bytes)) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_FILE_ENCODING_INVALID',
      'The acquisition file is not UTF-8 encoded text.',
      'Export the file as UTF-8 text before uploading it.',
    );
  }
  if (isContainer(bytes) || bytes.includes(0x00)) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_FILE_SIGNATURE_INVALID',
      'The acquisition file is an archive or binary container, not the delimited text this Source declares.',
      'Export the data as CSV before uploading it.',
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'ACQUISITION_FILE_ENCODING_INVALID',
      'The acquisition file is not UTF-8 encoded text.',
      'Export the file as UTF-8 text before uploading it.',
    );
  }
  const now = new Date().toISOString();
  const runId = randomUUID();
  const rawId = randomUUID();
  const batchId = randomUUID();
  const objectPath = objectPathOf(rawId);
  const absolute = join(session.root, objectPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  // `wx` keeps a Raw Acquisition write-once: no later attempt can rewrite it.
  writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });

  const raw: RawAcquisitionRecord = {
    raw_id: rawId,
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: runId,
    content_hash: createHash('sha256').update(bytes).digest('hex'),
    byte_length: bytes.length,
    object_path: objectPath,
    received_at: now,
  };
  const run: AcquisitionRunRecord = {
    acquisition_run_id: runId,
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    mode: 'manual_upload',
    trigger: 'manual',
    backfill: null,
    integration_configuration_version: configuration.version,
    attempts: 1,
    status: 'complete',
    queued_at: now,
    started_at: now,
    completed_at: now,
    raw_acquisition_ids: [rawId],
    error_code: null,
  };
  const batch: IntegrationBatchRecord = {
    batch_id: batchId,
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: runId,
    integration_configuration_version: configuration.version,
    integration_configuration_content_hash: configuration.content_hash,
    raw_acquisition_ids: [rawId],
    created_at: now,
    quarantined_at: null,
    quarantine_error_code: null,
  };
  session.state.raw_acquisitions.push(raw);
  session.state.acquisition_runs.push(run);
  session.state.integration_batches.push(batch);

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      acquisition_run_id: runId,
      raw_acquisition_count: 1,
      integration_configuration_version: configuration.version,
    },
  });
  session.save();
  return {
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    raw_acquisition: {
      raw_id: raw.raw_id,
      content_hash: raw.content_hash,
      byte_length: raw.byte_length,
      object_path: raw.object_path,
      received_at: raw.received_at,
    },
    integration_batch: {
      batch_id: batch.batch_id,
      acquisition_run_id: batch.acquisition_run_id,
      integration_configuration_version: batch.integration_configuration_version,
      raw_acquisition_ids: batch.raw_acquisition_ids,
      created_at: batch.created_at,
    },
  };
}

export interface AcquisitionFailure {
  code: string;
  message: string;
  /** The Release that still governs after the failed integration, if any. */
  current_release: number | null;
}

export interface AcquisitionOutcome {
  upload: Record<string, unknown>;
  integration: Record<string, unknown> | null;
  failure: AcquisitionFailure | null;
}

/**
 * Acquires one upload and integrates it at once, which is the guided workflow's
 * whole promise. The Raw Acquisition is durable before integration starts, so a
 * breaking Batch leaves the current Release in force and still explains what
 * happened to the bytes that were received.
 */
export function acquireUpload(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  bytes: Buffer;
}): AcquisitionOutcome {
  const upload = uploadAcquisitionBytes(options);
  const raw = upload['raw_acquisition'] as Record<string, unknown>;
  const rawId = String(raw['raw_id']);
  const runId = String(upload['acquisition_run_id']);

  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'dataset_release', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministrableSource(session, actor, context, options.sourceId);
  try {
    const released = releaseDatasetFor(session, actor, source);
    session.save();
    const outcomes = Array.isArray(released['acquisition_outcomes'])
      ? released['acquisition_outcomes'] as Array<Record<string, unknown>>
      : [];
    const mine = outcomes.find((outcome) => outcome['raw_id'] === rawId);
    return {
      upload,
      integration: {
        dataset_release: released['dataset_release'],
        reused: released['reused'],
        record_count: released['record_count'],
        record_rejection_count: released['record_rejection_count'],
        accepted_records: mine?.['accepted'] ?? 0,
        rejected_records: mine?.['rejected'] ?? 0,
      },
      failure: null,
    };
  } catch (error) {
    if (!(error instanceof OperatorError)) throw error;
    // The attempt is quarantined as one Batch: its fragments never join a later
    // Release, and the Run states why it ended, so the gap is never silent.
    const now = new Date().toISOString();
    const run = session.state.acquisition_runs.find((candidate) => candidate.acquisition_run_id === runId);
    if (run !== undefined) {
      run.status = 'failed';
      run.completed_at = now;
      run.error_code = error.code;
    }
    const batch = session.state.integration_batches.find((candidate) => candidate.acquisition_run_id === runId);
    if (batch !== undefined) {
      batch.quarantined_at = now;
      batch.quarantine_error_code = error.code;
    }
    session.save();
    return { upload, integration: null, failure: failureOf(session, source.source_id, error) };
  }
}

function failureOf(session: PlatformSession, sourceId: string, error: OperatorError): AcquisitionFailure {
  const dataset = findDataset(session.state.datasets, sourceId);
  return {
    code: error.code,
    message: error.message,
    current_release: latestDatasetRelease(dataset)?.release ?? null,
  };
}
