import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  adoptedIntegrationVersion,
  findIntegrationConfiguration,
  type AcquisitionRunRecord,
  type IntegrationBatchRecord,
  type RawAcquisitionRecord,
} from './catalog.js';
import { openPlatform } from './session.js';
import { requireAdministeredSource } from './sources.js';

/** Raw Acquisition objects live outside the platform state file, as opaque bytes. */
function objectPathOf(rawId: string): string {
  return `raw-acquisitions/${rawId}.bin`;
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
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'source_acquisition', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

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
  let bytes: Buffer;
  try {
    bytes = readFileSync(options.file);
  } catch {
    reject(session, actorLabel(actor.user), scoped, 'ACQUISITION_FILE_UNREADABLE', 'The acquisition file cannot be read.');
  }
  if (bytes.length === 0) {
    reject(session, actorLabel(actor.user), scoped, 'ACQUISITION_FILE_EMPTY', 'The acquisition file is empty.');
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
    integration_configuration_version: configuration.version,
    attempts: 1,
    status: 'complete',
    started_at: now,
    completed_at: now,
    raw_acquisition_ids: [rawId],
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
