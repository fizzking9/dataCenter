import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext, type Actor } from './authz.js';
import {
  adoptedIntegrationVersion,
  adoptedScraperService,
  findIntegrationConfiguration,
  findScraperCredential,
  findScraperService,
  findScraperServiceVersion,
  findScraperTask,
  type AcquisitionRunRecord,
  type IntegrationBatchRecord,
  type RawAcquisitionRecord,
  type ScraperCredentialRecord,
  type ScraperDiagnostic,
  type ScraperManifestPage,
  type ScraperRunManifest,
  type ScraperServiceArtifact,
  type ScraperServiceVersion,
  type ScraperTaskArtifact,
  type ScraperTaskVersion,
  type SourceRecord,
  type SourceScraperServiceRecord,
} from './catalog.js';
import { toCsv } from './csv.js';
import { releaseDatasetFor } from './datasets.js';
import { OperatorError } from './errors.js';
import { isRecord } from './documents.js';
import { decrypt } from './keys.js';
import { openPlatform, type PlatformSession } from './session.js';
import {
  extractRecords,
  outputColumns,
  pageUrl,
  plannedPages,
  readPage,
  scopeAllows,
  type ScraperCredentialMaterial,
  type ScraperPageReply,
} from './scraper-engine.js';
import { requireAdministeredSource } from './sources.js';

/** One page an attempt read, with the records extracted from it. */
interface ScrapedFragment {
  page: ScraperManifestPage;
  records: Array<Record<string, string>>;
  reply: ScraperPageReply;
}

/** What one attempt read, whatever became of it. */
export interface ScrapeAttempt {
  pages: ScraperManifestPage[];
  fragments: ScrapedFragment[];
  diagnostics: ScraperDiagnostic[];
  record_count: number;
  complete: boolean;
}

/** The credential values one Service Version may present, or the reference that is missing. */
export function credentialMaterial(
  session: PlatformSession,
  workspaceId: string,
  refs: string[],
): { material: ScraperCredentialMaterial[]; missing: string | null } {
  const material: ScraperCredentialMaterial[] = [];
  for (const ref of refs) {
    const stored: ScraperCredentialRecord | undefined = findScraperCredential(
      session.state.scraper_credentials,
      workspaceId,
      ref,
    );
    if (stored === undefined) return { material, missing: ref };
    material.push({
      location: stored.location,
      cookie_name: stored.cookie_name,
      value: decrypt(session.dataKey, stored.sealed).toString('utf8'),
    });
  }
  return { material, missing: null };
}

/** The resolved run parameters, refusing undeclared, missing, and mistyped values. */
export function resolveParameters(
  task: ScraperTaskVersion,
  supplied: unknown,
  fail: (code: string, message: string) => never,
): Record<string, string> {
  const given = supplied === undefined ? {} : supplied;
  if (!isRecord(given)) {
    fail('SCRAPER_PARAMETER_INVALID', 'Run parameters must be a JSON object.');
  }
  const declared = new Map(task.parameters.map((parameter) => [parameter.name, parameter]));
  for (const name of Object.keys(given)) {
    if (!declared.has(name)) {
      fail('SCRAPER_PARAMETER_UNKNOWN', `The Scraper Service declares no run parameter ${name}.`);
    }
  }
  const resolved: Record<string, string> = {};
  for (const parameter of task.parameters) {
    const value = given[parameter.name] ?? parameter.default;
    if (value === null || value === undefined) {
      if (parameter.required) {
        fail('SCRAPER_PARAMETER_REQUIRED', `The run parameter ${parameter.name} is required.`);
      }
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      fail('SCRAPER_PARAMETER_INVALID', `The run parameter ${parameter.name} must be text or a whole number.`);
    }
    const text = String(value);
    if (parameter.type === 'integer' && !/^-?\d+$/u.test(text)) {
      fail('SCRAPER_PARAMETER_INVALID', `The run parameter ${parameter.name} must be a whole number.`);
    }
    resolved[parameter.name] = text;
  }
  return resolved;
}

/**
 * Reads every planned page exactly once through the generic engine, stopping at
 * the first page that yields no record. Reaching the page ceiling while records
 * remain fails the attempt instead of truncating it silently.
 */
export async function scrapeAttempt(options: {
  service: ScraperServiceVersion;
  parameters: Record<string, string>;
  credentials: ScraperCredentialMaterial[];
}): Promise<ScrapeAttempt> {
  const { service, parameters, credentials } = options;
  const pages: ScraperManifestPage[] = [];
  const fragments: ScrapedFragment[] = [];
  const diagnostics: ScraperDiagnostic[] = [];
  let recordCount = 0;
  let complete = false;

  for (const page of plannedPages(service.content.target)) {
    const url = pageUrl(service.content.target, parameters, page);
    if (url === null) {
      diagnostics.push({
        code: 'SCRAPER_TARGET_UNRESOLVED',
        page,
        message: 'The target path could not be resolved from the declared run parameters.',
      });
      break;
    }
    if (!scopeAllows(service.content.network_scope, url)) {
      diagnostics.push({
        code: 'SCRAPER_NETWORK_SCOPE_REFUSED',
        page,
        message: 'The page URL is outside the approved network scope of this Scraper Service.',
      });
      break;
    }
    const read = await readPage({
      url,
      scope: service.content.network_scope,
      constraints: service.content.constraints,
      credentials,
      page,
    });
    if (read.reply === null) {
      if (read.diagnostic !== null) diagnostics.push(read.diagnostic);
      break;
    }
    const extraction = extractRecords(read.reply.body, service.content.output, page);
    diagnostics.push(...extraction.diagnostics);
    const entry: ScraperManifestPage = {
      page,
      url,
      status: read.reply.status,
      response_hash: read.reply.responseHash,
      response_bytes: read.reply.responseBytes,
      raw_id: null,
      record_count: extraction.records.length,
    };
    pages.push(entry);
    // Every accepted page is a response the attempt kept, even the empty page
    // that proves the sequence ended.
    fragments.push({ page: entry, records: extraction.records, reply: read.reply });
    if (extraction.records.length === 0) {
      complete = true;
      break;
    }
    recordCount += extraction.records.length;
    if (recordCount > service.content.constraints.max_records) {
      diagnostics.push({
        code: 'SCRAPER_RECORD_LIMIT_EXCEEDED',
        page,
        message: 'The attempt read more records than the Scraper Service permits.',
      });
      break;
    }
  }

  if (!complete && diagnostics.length === 0) {
    diagnostics.push({
      code: 'SCRAPER_PAGE_LIMIT_REACHED',
      page: pages.length > 0 ? pages[pages.length - 1]!.page : null,
      message: 'Every permitted page carried records, so the sequence could not be proven exhausted.',
    });
  }
  return { pages, fragments, diagnostics, record_count: recordCount, complete };
}

/** The tabular logical output one page produced, written the way integration reads it. */
function csvOf(service: ScraperServiceVersion, records: Array<Record<string, string>>): string {
  const columns = outputColumns(service.content);
  return toCsv(columns, records.map((record) => columns.map((column) => record[column] ?? '')));
}

/** Stores one scraped page's logical output as an immutable Raw Acquisition. */
function storeRaw(
  session: PlatformSession,
  run: AcquisitionRunRecord,
  service: ScraperServiceVersion,
  fragment: ScrapedFragment,
): RawAcquisitionRecord {
  const rawId = randomUUID();
  const objectPath = `raw-acquisitions/${rawId}.bin`;
  const bytes = Buffer.from(csvOf(service, fragment.records), 'utf8');
  mkdirSync(dirname(join(session.root, objectPath)), { recursive: true, mode: 0o700 });
  // `wx` keeps a Raw Acquisition write-once: no later attempt can rewrite it.
  writeFileSync(join(session.root, objectPath), bytes, { flag: 'wx', mode: 0o600 });
  const raw: RawAcquisitionRecord = {
    raw_id: rawId,
    workspace_id: run.workspace_id,
    source_id: run.source_id,
    acquisition_run_id: run.acquisition_run_id,
    content_hash: createHash('sha256').update(bytes).digest('hex'),
    byte_length: bytes.byteLength,
    object_path: objectPath,
    received_at: new Date().toISOString(),
  };
  session.state.raw_acquisitions.push(raw);
  return raw;
}

/** The exact published Service Version, Task Version, and Source pin a Run must reuse. */
interface PinnedService {
  artifact: ScraperServiceArtifact;
  service: ScraperServiceVersion;
  task: ScraperTaskArtifact;
  taskVersion: ScraperTaskVersion;
  pin: SourceScraperServiceRecord;
}

function pinnedService(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  source: SourceRecord,
): PinnedService {
  const pin = adoptedScraperService(session.state.source_scraper_services, source.source_id);
  if (pin === undefined) {
    reject(
      session,
      actor,
      context,
      'SCRAPER_SERVICE_NOT_ADOPTED',
      'The Source has no adopted Scraper Service Version to run.',
      'Publish a Scraper Service Version and adopt it for this Source.',
    );
  }
  const artifact = findScraperService(session.state.scraper_services, pin.scraper_service_id);
  const service = findScraperServiceVersion(artifact, pin.adopted_version);
  if (artifact === undefined || service === undefined) {
    reject(session, actor, context, 'SCRAPER_SERVICE_VERSION_NOT_FOUND', 'The Scraper Service Version this Source pins no longer exists.');
  }
  if (service.withdrawn_at !== null) {
    reject(session, actor, context, 'SCRAPER_SERVICE_WITHDRAWN', 'The Scraper Service Version this Source pins has been withdrawn.');
  }
  if (service.content_hash !== pin.content_hash) {
    reject(session, actor, context, 'SCRAPER_SERVICE_TAMPERED', 'The Scraper Service Version does not match the content the Source adopted.');
  }
  const task = findScraperTask(session.state.scraper_tasks, artifact.scraper_task_id);
  const taskVersion = task?.versions.find(
    (candidate) => candidate.version === service.content.source_task.version,
  );
  if (
    task === undefined
    || taskVersion === undefined
    || taskVersion.content_hash !== service.content.source_task.content_hash
  ) {
    reject(session, actor, context, 'SCRAPER_TASK_NOT_FOUND', 'The Scraper Task Version this Service was compiled from no longer exists.');
  }
  return { artifact, service, task, taskVersion, pin };
}

/**
 * Runs the exact published Scraper Service Version one Source adopted.
 *
 * Each trigger is one Acquisition Run. Every page it reads becomes an immutable
 * Raw Acquisition; a complete attempt alone hands over one Integration Batch and
 * releases the Dataset, so a failed attempt leaves governed data untouched.
 */
export async function runScraperService(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  parametersPath?: string;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_run', scope: 'workspace' };
  const actor: Actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  if (source.type !== 'scraper') {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_SOURCE_TYPE_UNSUPPORTED',
      'This Source is not acquired by a Scraper Service.',
      'Create the Source as a scraper Source before adopting a Scraper Service for it.',
    );
  }
  const pinned = pinnedService(session, actorLabel(actor.user), scoped, source);
  const integration = adoptedIntegrationVersion(
    findIntegrationConfiguration(session.state.integration_configurations, source.source_id),
  );
  if (!integration) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SOURCE_INTEGRATION_NOT_ADOPTED',
      'The Source has no adopted Integration Configuration Version to integrate against.',
      'Publish an Integration Configuration for the Source and adopt the exact version.',
    );
  }

  let supplied: unknown;
  if (options.parametersPath !== undefined) {
    try {
      supplied = JSON.parse(readFileSync(options.parametersPath, 'utf8')) as unknown;
    } catch {
      reject(session, actorLabel(actor.user), scoped, 'SCRAPER_PARAMETERS_UNREADABLE', 'The run parameters must be a readable JSON document.');
    }
  }
  const parameters = resolveParameters(pinned.taskVersion, supplied, (code, message) => {
    reject(session, actorLabel(actor.user), scoped, code, message);
  });
  const resolvedCredentials = credentialMaterial(session, source.workspace_id, pinned.service.content.credential_refs);
  if (resolvedCredentials.missing !== null) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'SCRAPER_CREDENTIAL_NOT_FOUND',
      `The Scraper Service presents the stored credential ${resolvedCredentials.missing}, which this Workspace does not hold.`,
      'Publish the credential reference before running the Scraper Service.',
    );
  }

  const startedAt = new Date().toISOString();
  const run: AcquisitionRunRecord = {
    acquisition_run_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    mode: 'scraper',
    trigger: 'manual',
    backfill: null,
    scheduled_for: null,
    integration_configuration_version: integration.version,
    attempts: 1,
    status: 'running',
    queued_at: startedAt,
    started_at: startedAt,
    completed_at: null,
    raw_acquisition_ids: [],
    error_code: null,
  };
  const manifest: ScraperRunManifest = {
    manifest_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    scraper_service_id: pinned.artifact.scraper_service_id,
    scraper_service_version: pinned.service.version,
    scraper_service_content_hash: pinned.service.content_hash,
    scraper_task_id: pinned.task.scraper_task_id,
    scraper_task_version: pinned.taskVersion.version,
    scraper_task_content_hash: pinned.taskVersion.content_hash,
    engine: { ...pinned.service.content.engine },
    parameters,
    pages: [],
    record_count: 0,
    diagnostics: [],
    started_at: startedAt,
    completed_at: null,
    status: 'running',
  };
  session.state.acquisition_runs.push(run);
  session.state.scraper_runs.push(manifest);
  // The Run and its manifest are durable before the first request, so an
  // interrupted attempt keeps the pages it really read.
  session.save();

  const attempt = await scrapeAttempt({
    service: pinned.service,
    parameters,
    credentials: resolvedCredentials.material,
  });
  const raws: RawAcquisitionRecord[] = [];
  for (const fragment of attempt.fragments) {
    const raw = storeRaw(session, run, pinned.service, fragment);
    raws.push(raw);
    run.raw_acquisition_ids.push(raw.raw_id);
    fragment.page.raw_id = raw.raw_id;
  }
  manifest.pages = attempt.pages;
  manifest.diagnostics = attempt.diagnostics;
  manifest.record_count = attempt.record_count;
  run.completed_at = new Date().toISOString();
  manifest.completed_at = run.completed_at;

  if (!attempt.complete) {
    run.status = 'failed';
    run.error_code = attempt.diagnostics[0]?.code ?? 'SCRAPER_ATTEMPT_FAILED';
    manifest.status = 'failed';
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: {
        acquisition_run_id: run.acquisition_run_id,
        manifest_id: manifest.manifest_id,
        error_code: run.error_code,
        raw_acquisition_count: run.raw_acquisition_ids.length,
      },
    });
    session.save();
    return viewRun(source, run, manifest, pinned, raws, null, null, false);
  }

  const batch: IntegrationBatchRecord = {
    batch_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    integration_configuration_version: integration.version,
    integration_configuration_content_hash: integration.content_hash,
    raw_acquisition_ids: [...run.raw_acquisition_ids],
    created_at: new Date().toISOString(),
    quarantined_at: null,
    quarantine_error_code: null,
  };
  session.state.integration_batches.push(batch);
  run.status = 'complete';
  run.error_code = null;
  manifest.status = 'complete';
  session.save();

  let released: Record<string, unknown>;
  try {
    released = releaseDatasetFor(session, actor, source);
  } catch (error) {
    const code = error instanceof OperatorError ? error.code : 'ACQUISITION_SCHEMA_DRIFT';
    batch.quarantined_at = new Date().toISOString();
    batch.quarantine_error_code = code;
    run.status = 'failed';
    run.error_code = 'ACQUISITION_SCHEMA_DRIFT';
    manifest.status = 'failed';
    session.audit({
      ...scoped,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: {
        acquisition_run_id: run.acquisition_run_id,
        manifest_id: manifest.manifest_id,
        error_code: 'ACQUISITION_SCHEMA_DRIFT',
        integration_error_code: code,
      },
    });
    session.save();
    return viewRun(source, run, manifest, pinned, raws, batch, null, false);
  }

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      acquisition_run_id: run.acquisition_run_id,
      manifest_id: manifest.manifest_id,
      scraper_service_version: pinned.service.version,
      raw_acquisition_count: run.raw_acquisition_ids.length,
      integration_batch_id: batch.batch_id,
      dataset_release: String(released['dataset_release'] ?? ''),
    },
  });
  session.save();
  return viewRun(source, run, manifest, pinned, raws, batch, released, true);
}

/** One Run's Raw Acquisitions, manifest, diagnostics, and Provenance, never a credential. */
function viewRun(
  source: SourceRecord,
  run: AcquisitionRunRecord,
  manifest: ScraperRunManifest,
  pinned: PinnedService,
  raws: RawAcquisitionRecord[],
  batch: IntegrationBatchRecord | null,
  released: Record<string, unknown> | null,
  complete: boolean,
): Record<string, unknown> {
  return {
    source_id: source.source_id,
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    error_code: run.error_code ?? null,
    scraper_service_id: pinned.artifact.scraper_service_id,
    scraper_service_version: pinned.service.version,
    scraper_service_content_hash: pinned.service.content_hash,
    acquisition_run: {
      acquisition_run_id: run.acquisition_run_id,
      mode: run.mode,
      trigger: run.trigger,
      status: run.status,
      started_at: run.started_at,
      completed_at: run.completed_at,
      integration_configuration_version: run.integration_configuration_version,
    },
    raw_acquisitions: raws.map((raw) => ({
      raw_id: raw.raw_id,
      content_hash: raw.content_hash,
      byte_length: raw.byte_length,
      received_at: raw.received_at,
    })),
    manifest: {
      manifest_id: manifest.manifest_id,
      scraper_service_version: manifest.scraper_service_version,
      scraper_task_version: manifest.scraper_task_version,
      engine: { ...manifest.engine },
      parameters: { ...manifest.parameters },
      pages: manifest.pages.map((page) => ({ ...page })),
      record_count: manifest.record_count,
      status: manifest.status,
      started_at: manifest.started_at,
      completed_at: manifest.completed_at,
    },
    diagnostics: manifest.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    provenance: {
      engine: { ...manifest.engine },
      scraper_task_id: manifest.scraper_task_id,
      scraper_task_version: manifest.scraper_task_version,
      scraper_task_content_hash: manifest.scraper_task_content_hash,
      scraper_service_version: manifest.scraper_service_version,
      scraper_service_content_hash: manifest.scraper_service_content_hash,
      fixtures_hash: pinned.taskVersion.fixtures_hash,
      proposal_id: pinned.pin.proposal_id,
      adopted_at: pinned.pin.adopted_at,
      acquisition_run_id: run.acquisition_run_id,
      acquired_at: manifest.started_at,
      integrated_at: released?.['created_at'] ?? null,
      released: complete,
    },
    integration_batch_id: batch?.batch_id ?? null,
    quarantined: batch !== null && batch.quarantined_at !== null,
    dataset_release: released?.['dataset_release'] ?? null,
    record_count: released?.['record_count'] ?? manifest.record_count,
  };
}
