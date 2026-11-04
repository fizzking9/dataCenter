import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  findDataProduct,
  findDataProductRelease,
  findDataProductVersion,
  type ExportRecord,
} from './catalog.js';
import { toCsv } from './csv.js';
import type { Fail } from './errors.js';
import { resolveGrantScope, type GrantScope } from './grants.js';
import { decrypt, encryptValue, type WrappedValue } from './keys.js';
import { workspaceRoleOf, type UserRecord } from './platform.js';
import { queryDataProduct } from './product-query.js';
import { openPlatform, type PlatformSession } from './session.js';

/** A curated export is readable only through a reauthorized, short-lived download. */
const EXPORT_LIFETIME_MS = 5 * 60 * 1000;

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
  requestPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_export', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = findDataProduct(session.state.data_products, options.dataProductId);
  const role = product === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  if (!product || role === null) {
    deny(session, actorLabel(actor.user), context, 'DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };

  // The governed read is what proves authorization, applies Grants, and pins the
  // Release; an export never assembles a table by any other route.
  const answer = queryDataProduct({
    root: options.root,
    masterKey: options.masterKey,
    token: options.token,
    dataProductId: options.dataProductId,
    requestPath: options.requestPath,
  });
  const table = tableOf(answer);
  const csv = toCsv(table.header, table.rows);
  const bytes = Buffer.from(csv, 'utf8');

  const exportId = randomUUID();
  const objectPath = objectPathOf(exportId);
  const absolute = join(session.root, objectPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const wrapped: WrappedValue = encryptValue(session.dataKey, bytes);
  writeFileSync(absolute, `${JSON.stringify(wrapped)}\n`, { flag: 'wx', mode: 0o600 });

  const record: ExportRecord = {
    export_id: exportId,
    workspace_id: product.workspace_id,
    data_product_id: product.data_product_id,
    data_product_release: Number(answer['data_product_release']),
    actor_user_id: actor.user.user_id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + EXPORT_LIFETIME_MS).toISOString(),
    row_count: table.rows.length,
    columns: [...table.header],
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

/** The Contract and Grant scope still in force for one exported Release. */
function currentScope(
  session: PlatformSession,
  user: UserRecord,
  record: ExportRecord,
  fail: Fail,
): GrantScope {
  const product = findDataProduct(session.state.data_products, record.data_product_id);
  const release = findDataProductRelease(product, record.data_product_release);
  const version = release === undefined
    ? undefined
    : findDataProductVersion(product, release.data_product_version);
  if (!product || version === undefined) {
    fail('EXPORT_NOT_AVAILABLE', 'The export is not available to this actor.');
  }
  const role = workspaceRoleOf(session.state, user.user_id, record.workspace_id);
  if (role === null) {
    fail('EXPORT_NOT_AVAILABLE', 'The export is not available to this actor.');
  }
  return resolveGrantScope(session, user, role, product, version.contract, fail);
}

/**
 * Reauthorizes and decrypts one export. Authorization is recomputed from the
 * current Workspace membership and Grants, so a narrowed Grant refuses a
 * download it no longer permits, and access expires on its own.
 */
export function downloadExport(options: {
  root: string;
  masterKey: string;
  token: string;
  exportId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_export_download', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  // Only the Consumer who produced an export may read it, and an export in
  // another Workspace is indistinguishable from one that never existed.
  const record = session.state.exports.find(
    (candidate) => candidate.export_id === options.exportId && candidate.actor_user_id === actor.user.user_id,
  );
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
  const scope = currentScope(session, actor.user, record, fail);
  const withheld = record.columns.filter((column) => !scope.columns.includes(column));
  if (withheld.length > 0) {
    fail(
      'EXPORT_NO_LONGER_AUTHORIZED',
      `This export carries ${withheld.join(', ')}, which the current Grant does not permit.`,
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
