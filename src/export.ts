import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  findDataProduct,
  type ExportRecord,
} from './catalog.js';
import { toCsv } from './csv.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { resolveGrantScope, type GrantScope } from './grants.js';
import { decrypt, encryptValue, type WrappedValue } from './keys.js';
import { findUserById, workspaceRoleOf } from './platform.js';
import { queryDataProduct } from './product-query.js';
import { releasedVersion } from './product-release.js';
import { requireReadableProduct } from './products.js';
import { openPlatform, type PlatformSession } from './session.js';

/** A curated export is readable only through a reauthorized, short-lived download. */
const EXPORT_LIFETIME_MS = 5 * 60 * 1000;
/** No export may assemble more rows than this, so one request cannot exhaust storage. */
const EXPORT_ROW_CEILING = 100_000;

function objectPathOf(exportId: string): string {
  return `exports/${exportId}.json`;
}

interface CuratedTable {
  header: string[];
  rows: Array<Array<string | number | null>>;
}

/**
 * Turns one governed answer into the curated table an export carries. The shape
 * is the answer's own: a record read exports its permitted columns, an
 * aggregate read exports its grouped dimensions and evaluated metrics.
 */
function tableOf(response: Record<string, unknown>): CuratedTable {
  if (response['kind'] === 'records') {
    const header = (response['columns'] as string[] | undefined) ?? [];
    const records = (response['records'] as Array<Record<string, string | number | null>> | undefined) ?? [];
    return { header, rows: records.map((record) => header.map((name) => record[name] ?? null)) };
  }
  const groupedBy = (response['grouped_by'] as string[] | undefined) ?? [];
  const metrics = (response['metrics'] as Array<Record<string, unknown>> | undefined) ?? [];
  const header = [...groupedBy, ...metrics.map((metric) => String(metric['name']))];
  const groups = (response['groups'] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    header,
    rows: groups.map((entry) => {
      const group = (entry['group'] as Record<string, string | number | null>) ?? {};
      const values = (entry['metrics'] as Record<string, string | number | null>) ?? {};
      return [
        ...groupedBy.map((name) => group[name] ?? null),
        ...metrics.map((metric) => values[String(metric['name'])] ?? null),
      ];
    }),
  };
}

/** The Grant scope in force for one actor on one published Release. */
function scopeOfRelease(
  session: PlatformSession,
  userId: string,
  dataProductId: string,
  releaseNumber: number,
  fail: Fail,
): GrantScope {
  const product = findDataProduct(session.state.data_products, dataProductId);
  const pinned = releasedVersion(product, releaseNumber);
  if (!product || pinned === undefined) {
    fail('EXPORT_NOT_AVAILABLE', 'The export is not available to this actor.');
  }
  const role = workspaceRoleOf(session.state, userId, product.workspace_id);
  if (role === null) {
    fail('EXPORT_NOT_AVAILABLE', 'The export is not available to this actor.');
  }
  return resolveGrantScope(session, userId, role, product, pinned.version.contract, fail);
}

/**
 * Reads every page of one governed answer.
 *
 * A page is all the governed read promises, so an export that stopped at the
 * first one would silently drop the rows it did not read and report the partial
 * count as the whole. Each page is requested through the same governed read, so
 * no page escapes the Grants, the row filters, or the Release the first one
 * pinned.
 */
function readEveryPage(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  requestPath: string;
  request: Record<string, unknown>;
  scratchDirectory: string;
}): { header: string[]; rows: Array<Array<string | number | null>>; pages: number; release: number } {
  let header: string[] | null = null;
  const rows: Array<Array<string | number | null>> = [];
  let cursor: string | null = null;
  let pages = 0;
  let release = 0;

  for (;;) {
    const requestPath = cursor === null
      ? options.requestPath
      : (() => {
        const pagePath = join(options.scratchDirectory, `page-${pages}.json`);
        writeFileSync(pagePath, `${JSON.stringify({ ...options.request, cursor })}\n`, { mode: 0o600 });
        return pagePath;
      })();
    const answer = queryDataProduct({
      root: options.root,
      masterKey: options.masterKey,
      token: options.token,
      dataProductId: options.dataProductId,
      requestPath,
    });
    const table = tableOf(answer);
    if (header === null) header = table.header;
    else if (JSON.stringify(header) !== JSON.stringify(table.header)) {
      throw new Error('EXPORT_PAGES_DISAGREE');
    }
    rows.push(...table.rows);
    pages += 1;
    release = Number(answer['data_product_release']);
    if (rows.length > EXPORT_ROW_CEILING) throw new Error('EXPORT_ROW_CEILING_REACHED');
    if (answer['truncated'] !== true) break;
    const next = answer['next_cursor'];
    if (typeof next !== 'string') throw new Error('EXPORT_PAGE_UNREACHABLE');
    cursor = next;
  }

  return { header: header ?? [], rows, pages, release };
}

/**
 * Produces one encrypted, audited, Workspace-scoped curated-result export by
 * running the same governed query a Consumer would read, so every Grant, row
 * filter, and Release pin applies to the export exactly as it does on screen.
 */
export function createExport(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  /** The active Workspace a browser names, so a foreign Product is never exported. */
  workspaceId?: string;
  /** A query document on disk, which the CLI reads. */
  requestPath?: string;
  /** The same query a browser form already parsed on the server. */
  request?: unknown;
}): Record<string, unknown> {
  const authorizer = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'data_product_export', scope: 'workspace' };
  const actor = resolveActor(authorizer, options.token, context);
  const product = requireReadableProduct(authorizer, actor, context, options.dataProductId);
  if (options.workspaceId !== undefined && product.workspace_id !== options.workspaceId) {
    deny(
      authorizer,
      actorLabel(actor.user),
      { ...context, workspace_id: options.workspaceId, target: product.data_product_id },
      'DATA_PRODUCT_NOT_AVAILABLE',
      'The Data Product is not available to this actor.',
    );
  }
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const fail: Fail = (code, message, nextStep) => reject(authorizer, actorLabel(actor.user), scoped, code, message, nextStep);
  const request = options.request !== undefined
    ? options.request
    : readJsonDocument(
      options.requestPath ?? '',
      fail,
      'DATA_PRODUCT_QUERY_INVALID',
      'The Data Product Query document must contain valid JSON.',
    );
  if (!isRecord(request)) {
    fail('DATA_PRODUCT_QUERY_INVALID', 'A Data Product Query must be a JSON object.');
  }

  const exportId = randomUUID();
  const scratch = join(authorizer.root, 'tmp', `export-${exportId}`);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // The governed read reads its request from a document, so a browser-stated
  // request is written into the private scratch directory under the exact bytes
  // the administrator submitted.
  const requestPath = options.request !== undefined
    ? (() => {
      const path = join(scratch, 'request.json');
      writeFileSync(path, `${JSON.stringify(request)}\n`, { mode: 0o600 });
      return path;
    })()
    : options.requestPath ?? '';
  let table: { header: string[]; rows: Array<Array<string | number | null>>; pages: number; release: number };
  try {
    table = readEveryPage({
      root: options.root,
      masterKey: options.masterKey,
      token: options.token,
      dataProductId: options.dataProductId,
      requestPath,
      request,
      scratchDirectory: scratch,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'EXPORT_ROW_CEILING_REACHED') {
      fail(
        'EXPORT_TOO_LARGE',
        `This export would carry more than ${EXPORT_ROW_CEILING} rows.`,
        'Narrow the query with filters or a time window before exporting it.',
      );
    }
    if (error instanceof Error && error.message === 'EXPORT_PAGES_DISAGREE') {
      fail(
        'EXPORT_INCOMPLETE',
        'The pages of this export do not share the same columns.',
        'Export the Data Product again without changing its Contract while it is read.',
      );
    }
    if (error instanceof Error && error.message === 'EXPORT_PAGE_UNREACHABLE') {
      fail(
        'EXPORT_INCOMPLETE',
        'The export stopped before every matched row was read.',
        'Export the Data Product again with a narrower query.',
      );
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // The pages each saved their own audit row, so the recording session is opened
  // afterwards and never overwrites what the governed reads wrote.
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const csv = toCsv(table.header, table.rows);
  const bytes = Buffer.from(csv, 'utf8');
  const objectPath = objectPathOf(exportId);
  const absolute = join(session.root, objectPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const wrapped: WrappedValue = encryptValue(session.dataKey, bytes);
  writeFileSync(absolute, `${JSON.stringify(wrapped)}\n`, { flag: 'wx', mode: 0o600 });

  // The grant expires exactly one lifetime after the instant it is recorded, so
  // the window never widens by a clock tick between the two readings.
  const createdAt = new Date();
  const record: ExportRecord = {
    export_id: exportId,
    workspace_id: product.workspace_id,
    data_product_id: product.data_product_id,
    data_product_release: table.release,
    actor_user_id: actor.user.user_id,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + EXPORT_LIFETIME_MS).toISOString(),
    row_count: table.rows.length,
    columns: [...table.header],
    row_filters: scopeOfRelease(session, actor.user.user_id, product.data_product_id, table.release, fail)
      .rowFilters
      .map((filter) => ({ ...filter })),
    content_hash: createHash('sha256').update(bytes).digest('hex'),
    object_path: objectPath,
    downloaded_at: null,
  };
  session.state.exports.push(record);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      export_id: exportId,
      data_product_release: record.data_product_release,
      row_count: record.row_count,
      column_count: record.columns.length,
      pages_read: table.pages,
    },
  });
  session.save();
  return {
    export_id: exportId,
    workspace_id: record.workspace_id,
    data_product_id: record.data_product_id,
    data_product_release: record.data_product_release,
    content_type: 'text/csv',
    columns: [...record.columns],
    row_count: record.row_count,
    content_hash: record.content_hash,
    object_path: record.object_path,
    created_at: record.created_at,
    expires_at: record.expires_at,
  };
}

/**
 * True when the current scope still permits every row the export carries.
 *
 * Filters narrow, so the rows an export was produced under remain permitted
 * only while the scope in force is at least as wide as the one recorded: an
 * unrestricted scope covers everything, and a restricted one must apply no
 * filter the export was not already produced under.
 */
function coversExport(recorded: ExportRecord['row_filters'], scope: GrantScope): boolean {
  if (!scope.restricted) return true;
  return scope.rowFilters.every(
    (current) => recorded.some(
      (filter) => filter.field === current.field && filter.op === current.op && filter.value === current.value,
    ),
  );
}

/**
 * Reauthorizes and decrypts one export. Authorization is recomputed from the
 * current Workspace membership and Grants, so a narrower Grant refuses a
 * download it no longer permits, and access expires on its own.
 */
export function downloadExport(options: {
  root: string;
  masterKey: string;
  token: string;
  exportId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'data_product_export_download', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  // Only the Consumer who produced an export may read it, and an export in
  // another Workspace is indistinguishable from one that never existed.
  const record = session.state.exports.find(
    (candidate) => candidate.export_id === options.exportId && candidate.actor_user_id === actor.user.user_id,
  );
  if (!record) {
    // A purged export is retention-expired only to the Consumer who produced it.
    // To everyone else it stays indistinguishable from an export that never
    // existed, so a purged id never discloses someone else's activity.
    for (const ledger of session.state.purge_ledger) {
      const purged = ledger.purged.find(
        (recorded) => recorded.record_kind === 'export' && recorded.record_id === options.exportId,
      );
      if (purged === undefined) continue;
      if (purged.owner_user_id === actor.user.user_id) {
        reject(
          session,
          actorLabel(actor.user),
          ledger.scope.workspace_id == null ? context : { ...context, workspace_id: ledger.scope.workspace_id },
          'RETENTION_EXPIRED',
          'This export has expired under the retention policy and was purged.',
          'Produce the export again to receive a fresh short-lived download.',
        );
      }
      break;
    }
  }
  if (!record || workspaceRoleOf(session.state, actor.user.user_id, record.workspace_id) === null) {
    deny(session, actorLabel(actor.user), context, 'EXPORT_NOT_AVAILABLE', 'The export is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: record.workspace_id, target: record.export_id };
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  if (Date.parse(record.expires_at) <= Date.now()) {
    fail(
      'EXPORT_ACCESS_EXPIRED',
      'This export download has expired.',
      'Produce the export again to receive a fresh short-lived download.',
    );
  }
  if (record.revoked_at !== null && record.revoked_at !== undefined) {
    fail(
      'EXPORT_REVOKED',
      'A Workspace Administrator revoked this export download.',
      'Produce the export again to receive a fresh short-lived download.',
    );
  }
  const scope = scopeOfRelease(session, actor.user.user_id, record.data_product_id, record.data_product_release, fail);
  const withheld = record.columns.filter((column) => !scope.columns.includes(column));
  if (withheld.length > 0) {
    fail(
      'EXPORT_NO_LONGER_AUTHORIZED',
      `This export carries ${withheld.join(', ')}, which the current Grant does not permit.`,
      'Produce the export again under the current Grant.',
    );
  }
  if (!coversExport(record.row_filters, scope)) {
    fail(
      'EXPORT_NO_LONGER_AUTHORIZED',
      'This export was produced under row filters that the current Grant narrows.',
      'Produce the export again under the current Grant.',
    );
  }

  let wrapped: WrappedValue;
  try {
    wrapped = JSON.parse(readFileSync(join(session.root, record.object_path), 'utf8')) as WrappedValue;
  } catch {
    fail('EXPORT_OBJECT_UNAVAILABLE', 'The encrypted export object is unavailable.');
  }
  const bytes = decrypt(session.dataKey, wrapped);
  record.downloaded_at = new Date().toISOString();
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { data_product_release: record.data_product_release, row_count: record.row_count },
  });
  session.save();
  return {
    export_id: record.export_id,
    data_product_id: record.data_product_id,
    data_product_release: record.data_product_release,
    content_type: 'text/csv',
    encoding: 'base64',
    content: bytes.toString('base64'),
    content_hash: record.content_hash,
    columns: [...record.columns],
    row_count: record.row_count,
    expires_at: record.expires_at,
  };
}

/** One export's lifecycle state, derived from its own recorded facts. */
function exportStatus(record: ExportRecord, now: number): 'active' | 'expired' | 'revoked' {
  if (record.revoked_at !== null && record.revoked_at !== undefined) return 'revoked';
  if (Date.parse(record.expires_at) <= now) return 'expired';
  return 'active';
}

/** One export as an authorized reader may see it, never another producer's content. */
function exportView(
  session: PlatformSession,
  record: ExportRecord,
  now: number,
  viewerUserId: string,
): Record<string, unknown> {
  const product = findDataProduct(session.state.data_products, record.data_product_id);
  const status = exportStatus(record, now);
  return {
    export_id: record.export_id,
    data_product_id: record.data_product_id,
    data_product_name: product?.name ?? null,
    data_product_release: record.data_product_release,
    producer: findUserById(session.state, record.actor_user_id)?.username ?? null,
    created_at: record.created_at,
    expires_at: record.expires_at,
    status,
    revoked_at: record.revoked_at ?? null,
    row_count: record.row_count,
    columns: [...record.columns],
    row_filters: record.row_filters.map((filter) => ({ ...filter })),
    content_hash: record.content_hash,
    downloaded_at: record.downloaded_at,
    can_download: record.actor_user_id === viewerUserId && status === 'active',
  };
}

/**
 * Lists the governed exports of one Workspace, for its administrators. A
 * Consumer never reaches this surface; the export a Consumer may download is
 * still reauthorized on its own request.
 */
export function listExports(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  dataProductId?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'data_product_export_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const now = Date.now();
  const exports = session.state.exports
    .filter((record) => record.workspace_id === options.workspaceId)
    .filter((record) => options.dataProductId === undefined || record.data_product_id === options.dataProductId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((record) => exportView(session, record, now, actor.user.user_id));
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { exports_returned: exports.length } });
  return { workspace_id: options.workspaceId, exports };
}

/**
 * Lists only the exports one Consumer produced in the active Workspace. Another
 * Consumer's export is absent rather than redacted, so no producer or content
 * is disclosed to an actor who may not download it.
 */
export function listOwnExports(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  dataProductId?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'data_product_export_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  if (workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId) === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const now = Date.now();
  const exports = session.state.exports
    .filter((record) => record.workspace_id === options.workspaceId)
    .filter((record) => record.actor_user_id === actor.user.user_id)
    .filter((record) => options.dataProductId === undefined || record.data_product_id === options.dataProductId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((record) => exportView(session, record, now, actor.user.user_id));
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { exports_returned: exports.length, own: true },
  });
  return { workspace_id: options.workspaceId, exports };
}

/** Revokes one export download while keeping its audit trail and metadata. */
export function revokeExport(options: {
  root: string;
  masterKey: string;
  token: string;
  exportId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'data_product_export_revocation', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const record = session.state.exports.find((candidate) => candidate.export_id === options.exportId);
  if (!record) {
    deny(session, actorLabel(actor.user), context, 'EXPORT_NOT_AVAILABLE', 'The export is not available to this actor.');
  }
  const workspace = requireWorkspaceAdministrator(session, actor, context, record.workspace_id);
  const scoped: ActionContext = {
    ...context,
    workspace_id: workspace.workspace_id,
    target: record.export_id,
  };
  if (record.revoked_at !== null && record.revoked_at !== undefined) {
    return { export_id: record.export_id, revoked_at: record.revoked_at, already_revoked: true };
  }
  record.revoked_at = new Date().toISOString();
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      data_product_id: record.data_product_id,
      data_product_release: record.data_product_release,
      row_count: record.row_count,
    },
  });
  session.save();
  return { export_id: record.export_id, revoked_at: record.revoked_at };
}
