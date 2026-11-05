import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  activeAgentGrants,
  activeGrants,
  ISO_DATE,
  ISO_TIMESTAMP,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductArtifact,
  type DataProductContract,
  type DataProductGrantRecord,
  type DatasetSchemaField,
  type GrantRowFilter,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { findAgentIdentity, findUser, workspaceRoleOf, type UserRecord } from './platform.js';
import { requireAdministeredProduct } from './products.js';
import { openPlatform, type PlatformSession } from './session.js';

/** The typed row predicate operators a Grant may state, matching the query language. */
const OPERATORS: GrantRowFilter['op'][] = [
  'equals', 'not_equals', 'less_than', 'less_or_equal',
  'greater_than', 'greater_or_equal', 'is_null', 'is_not_null',
];
const NULL_TESTS: GrantRowFilter['op'][] = ['is_null', 'is_not_null'];

/**
 * What one actor may read of one Data Product Release, derived fresh on every
 * request. A Workspace Administrator administers the Artifact, and a member
 * with no Grant keeps the Workspace baseline; a Consumer holding Grants reads
 * only the intersection of them.
 */
export interface GrantScope {
  /** The columns this actor may see, in the Contract's own order. */
  columns: string[];
  rowFilters: GrantRowFilter[];
  restricted: boolean;
  /** Content address of the scope, so no cache or cursor can be reused across a change. */
  fingerprint: string;
}

export function grantScopeOf(
  grants: DataProductGrantRecord[],
  contract: DataProductContract,
  restricted: boolean,
): GrantScope {
  const allColumns = contract.fields.map((field) => field.name);
  if (!restricted || grants.length === 0) {
    return {
      columns: allColumns,
      rowFilters: [],
      restricted: false,
      fingerprint: canonicalDigest({ columns: allColumns, row_filters: [], restricted: false }),
    };
  }
  const columns = allColumns.filter(
    (name) => grants.every((grant) => grant.columns === null || grant.columns.includes(name)),
  );
  const rowFilters = grants.flatMap((grant) => grant.row_filters.map((filter) => ({ ...filter })));
  return {
    columns,
    rowFilters,
    restricted: true,
    fingerprint: canonicalDigest({ columns, row_filters: rowFilters, restricted: true }),
  };
}

/**
 * Resolves the scope a request reads under, answering null when the Grant set
 * cannot be applied to the Contract line the request reads.
 *
 * Nothing is inferred from a previous request: the Grant set, the membership,
 * and the identity are all read again.
 */
function applicableScope(
  grants: ReturnType<typeof activeGrants>,
  contract: DataProductContract,
  restricted: boolean,
): GrantScope | null {
  const scope = grantScopeOf(grants, contract, restricted);
  // A Grant names filters of the Contract it was published against. If a later
  // line no longer publishes one, the narrowing cannot be applied, so the read
  // is refused rather than silently reading wider.
  const inapplicable = scope.rowFilters.find((filter) => !contract.filters.includes(filter.field));
  return inapplicable === undefined ? scope : null;
}

export function readableGrantScope(
  session: PlatformSession,
  userId: string,
  role: string | null,
  product: DataProductArtifact,
  contract: DataProductContract,
): GrantScope | null {
  return applicableScope(
    activeGrants(session.state.data_product_grants, product.data_product_id, userId),
    contract,
    role !== 'Workspace Administrator',
  );
}

/**
 * The scope an Agent Identity reads under. An Agent is not a Workspace member,
 * so it holds no baseline at all: a Data Product it has no Grant on is exactly
 * as unavailable to it as one that does not exist.
 */
export function readableAgentGrantScope(
  session: PlatformSession,
  agentIdentityId: string,
  product: DataProductArtifact,
  contract: DataProductContract,
): GrantScope | null {
  const grants = activeAgentGrants(session.state.data_product_grants, product.data_product_id, agentIdentityId);
  if (grants.length === 0) return null;
  return applicableScope(grants, contract, true);
}

/** Resolves the Agent Identity scope a read must honour, failing closed when it cannot. */
export function resolveAgentGrantScope(
  session: PlatformSession,
  agentIdentityId: string,
  product: DataProductArtifact,
  contract: DataProductContract,
  fail: Fail,
): GrantScope {
  const grants = activeAgentGrants(session.state.data_product_grants, product.data_product_id, agentIdentityId);
  if (grants.length === 0) {
    fail(
      'DATA_PRODUCT_NOT_AVAILABLE',
      'No Data Product Grant permits this Agent Identity to read this Data Product.',
      'Ask a Workspace Administrator for a Grant naming this Agent Identity.',
    );
  }
  const scope = applicableScope(grants, contract, true);
  if (scope === null) {
    const stale = grants
      .flatMap((grant) => grant.row_filters)
      .find((filter) => !contract.filters.includes(filter.field));
    fail(
      'DATA_PRODUCT_QUERY_REFUSED',
      `A Grant on ${stale?.field ?? 'a withdrawn filter'} does not apply to this Contract line, so the read is refused.`,
      'Republish the Grant against the Contract line its Consumers read.',
    );
  }
  return scope;
}

/** Resolves the scope a governed read must honour, failing closed when it cannot. */
export function resolveGrantScope(
  session: PlatformSession,
  userId: string,
  role: string | null,
  product: DataProductArtifact,
  contract: DataProductContract,
  fail: Fail,
): GrantScope {
  const scope = readableGrantScope(session, userId, role, product, contract);
  if (scope === null) {
    const stale = activeGrants(session.state.data_product_grants, product.data_product_id, userId)
      .flatMap((grant) => grant.row_filters)
      .find((filter) => !contract.filters.includes(filter.field));
    fail(
      'DATA_PRODUCT_QUERY_REFUSED',
      `A Grant on ${stale?.field ?? 'a withdrawn filter'} does not apply to this Contract line, so the read is refused.`,
      'Republish the Grant against the Contract line its Consumers read.',
    );
  }
  return scope;
}

/**
 * Who a governed read runs for. The query engine and the Contract projection take
 * one of these instead of an identity of their own, so the lifecycle CLI, the
 * Data Product API, and MCP cannot authorize, narrow, or audit a read differently.
 */
export interface GrantReader {
  /** The Actor label every Audit Event of this read records. */
  readonly label: string;
  /** The subject a cached page is bound to, so no two principals share one. */
  readonly subject: string;
  /** The scope this reader reads one Contract line under, or null when none applies. */
  scopeOf(product: DataProductArtifact, contract: DataProductContract): GrantScope | null;
  /** The same scope, failing closed with the codes the Deployment publishes. */
  requireScope(product: DataProductArtifact, contract: DataProductContract, fail: Fail): GrantScope;
}

/** A Workspace member reads under their Role and their own Grants. */
export function memberReader(
  session: PlatformSession,
  user: UserRecord,
  role: string | null,
): GrantReader {
  return {
    label: actorLabel(user),
    subject: user.user_id,
    scopeOf: (product, contract) => readableGrantScope(session, user.user_id, role, product, contract),
    requireScope: (product, contract, fail) => resolveGrantScope(session, user.user_id, role, product, contract, fail),
  };
}

/**
 * An Agent Identity is not a Workspace member, so it reads under the Grants that
 * name it and holds no baseline of its own.
 */
export function agentReader(
  session: PlatformSession,
  agentIdentityId: string,
  label: string,
): GrantReader {
  return {
    label,
    subject: agentIdentityId,
    scopeOf: (product, contract) => readableAgentGrantScope(session, agentIdentityId, product, contract),
    requireScope: (product, contract, fail) => resolveAgentGrantScope(session, agentIdentityId, product, contract, fail),
  };
}

function schemaField(schema: DatasetSchemaField[], name: string): DatasetSchemaField | undefined {
  return schema.find((field) => field.name === name);
}

function acceptsValue(field: DatasetSchemaField, value: unknown): boolean {
  if (field.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'date') return typeof value === 'string' && ISO_DATE.test(value);
  if (field.type === 'timestamp') return typeof value === 'string' && ISO_TIMESTAMP.test(value);
  return typeof value === 'string';
}

function readRowFilters(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  contract: DataProductContract,
  schema: DatasetSchemaField[],
): GrantRowFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    reject(session, actor, context, 'GRANT_ROW_FILTER_INVALID', 'Grant row filters must be an array.');
  }
  const filters: GrantRowFilter[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate['field'] !== 'string') {
      reject(session, actor, context, 'GRANT_ROW_FILTER_INVALID', 'Each Grant row filter must state a field and an operator.');
    }
    const field = candidate['field'];
    const op = candidate['op'] as GrantRowFilter['op'];
    if (!OPERATORS.includes(op)) {
      reject(session, actor, context, 'GRANT_ROW_FILTER_INVALID', `Each Grant row filter operator must be one of: ${OPERATORS.join(', ')}.`);
    }
    if (!contract.filters.includes(field)) {
      reject(
        session,
        actor,
        context,
        'GRANT_ROW_FILTER_INVALID',
        `${field} is not a filter this Data Product Contract publishes.`,
      );
    }
    if (NULL_TESTS.includes(op)) {
      filters.push({ field, op, value: null });
      continue;
    }
    const field_ = schemaField(schema, field);
    if (!field_ || !acceptsValue(field_, candidate['value'])) {
      reject(
        session,
        actor,
        context,
        'GRANT_ROW_FILTER_INVALID',
        `The ${field} row filter must state a ${field_?.type ?? 'published'} value.`,
      );
    }
    filters.push({ field, op, value: candidate['value'] as string | number });
  }
  return filters;
}

function readColumns(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  contract: DataProductContract,
): string[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    reject(session, actor, context, 'GRANT_COLUMNS_INVALID', 'Grant columns must name at least one field the Contract publishes.');
  }
  const columns: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string' || !contract.fields.some((field) => field.name === candidate)) {
      reject(
        session,
        actor,
        context,
        'GRANT_COLUMNS_INVALID',
        `${String(candidate)} is not a field this Data Product Contract publishes.`,
      );
    }
    if (!columns.includes(candidate)) columns.push(candidate);
  }
  return columns;
}

/** The Contract and Dataset Schema the Data Product's current Release serves. */
function currentContract(
  session: PlatformSession,
  product: DataProductArtifact,
  fail: Fail,
): { contract: DataProductContract; schema: DatasetSchemaField[] } {
  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  if (!version || !release) {
    fail('DATA_PRODUCT_NOT_PUBLISHED', 'The Data Product has no Publication to grant over.', 'Publish the Data Product first.');
  }
  const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
  const datasetRelease = dataset?.releases.find((candidate) => candidate.release === release.dataset_release);
  if (!dataset || !datasetRelease) {
    fail('DATA_PRODUCT_NOT_AVAILABLE', 'The Dataset Release this Data Product pins is not available.');
  }
  const schema = session.state.integration_configurations
    .find((artifact) => artifact.source_id === dataset.source_id)
    ?.versions.find((candidate) => candidate.version === datasetRelease.integration_configuration_version)
    ?.schema ?? [];
  return { contract: version.contract, schema };
}

/**
 * Publishes one Grant narrowing a principal's reads of a published Data
 * Product. Only a Workspace Administrator of that Workspace may narrow another
 * principal's access, and only to what the Contract already publishes.
 */
export function publishGrant(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  /** The member whose reads to narrow, or the Agent Identity instead. */
  username?: string;
  agentIdentityId?: string;
  requestPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_grant_publication', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = requireAdministeredProduct(session, actor, context, options.dataProductId);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  const { contract, schema } = currentContract(session, product, fail);

  const grantee = options.agentIdentityId === undefined ? findUser(session.state, options.username ?? '') : undefined;
  if (options.agentIdentityId === undefined
    && (!grantee || grantee.status !== 'active'
      || workspaceRoleOf(session.state, grantee.user_id, product.workspace_id) === null)) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'GRANT_GRANTEE_NOT_FOUND',
      'A Grant names an active member of this Workspace.',
      'Grant Workspace membership before narrowing what that member may read.',
    );
  }
  const agent = options.agentIdentityId === undefined ? undefined : findAgentIdentity(session.state, options.agentIdentityId);
  if (options.agentIdentityId !== undefined
    && (!agent || agent.status !== 'active' || !agent.workspace_ids.includes(product.workspace_id))) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'GRANT_GRANTEE_NOT_FOUND',
      'A Grant names an active Agent Identity bound to this Workspace.',
      'Create the Agent Identity for this Workspace before narrowing what it may read.',
    );
  }
  const request = readJsonDocument(
    options.requestPath,
    fail,
    'GRANT_REQUEST_INVALID',
    'The Grant request must contain valid JSON.',
  );
  if (!isRecord(request)) {
    fail('GRANT_REQUEST_INVALID', 'A Grant request must be a JSON object.');
  }
  const columns = readColumns(session, actorLabel(actor.user), scoped, request['columns'], contract);
  const rowFilters = readRowFilters(session, actorLabel(actor.user), scoped, request['row_filters'], contract, schema);

  const granteeLabel = agent === undefined ? String(grantee?.username) : `agent:${agent.name}`;
  const grant: DataProductGrantRecord = {
    grant_id: randomUUID(),
    workspace_id: product.workspace_id,
    data_product_id: product.data_product_id,
    grantee_user_id: grantee?.user_id ?? null,
    ...(agent === undefined ? {} : { grantee_agent_identity_id: agent.agent_identity_id }),
    columns,
    row_filters: rowFilters,
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    revoked_at: null,
  };
  session.state.data_product_grants.push(grant);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      grant_id: grant.grant_id,
      grantee: granteeLabel,
      column_count: columns === null ? -1 : columns.length,
      row_filter_count: rowFilters.length,
    },
  });
  session.save();
  return {
    grant_id: grant.grant_id,
    workspace_id: grant.workspace_id,
    data_product_id: grant.data_product_id,
    grantee: agent === undefined
      ? { type: 'user', username: grantee?.username ?? null }
      : { type: 'agent', agent_identity_id: agent.agent_identity_id },
    columns,
    row_filters: rowFilters.map((filter) => ({ ...filter })),
    created_at: grant.created_at,
  };
}

/** Lists the Grants still in force on one Data Product, for its administrators. */
export function listGrants(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_grant_listing', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = requireAdministeredProduct(session, actor, context, options.dataProductId);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const grants = session.state.data_product_grants
    .filter((grant) => grant.data_product_id === product.data_product_id && grant.revoked_at === null)
    .map((grant) => ({
      grant_id: grant.grant_id,
      grantee: grant.grantee_agent_identity_id !== undefined && grant.grantee_agent_identity_id !== null
        ? { type: 'agent', agent_identity_id: grant.grantee_agent_identity_id }
        : { type: 'user', username: findUserById(session, grant.grantee_user_id ?? '') },
      columns: grant.columns === null ? null : [...grant.columns],
      row_filters: grant.row_filters.map((filter) => ({ ...filter })),
      created_at: grant.created_at,
    }));
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { grants_returned: grants.length } });
  return { data_product_id: product.data_product_id, grants };
}

function findUserById(session: PlatformSession, userId: string): string | null {
  return session.state.users.find((user) => user.user_id === userId)?.username ?? null;
}

/** Withdraws one Grant, so the next request evaluates the wider baseline again. */
export function revokeGrant(options: {
  root: string;
  masterKey: string;
  token: string;
  grantId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_grant_revocation', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const grant = session.state.data_product_grants.find((candidate) => candidate.grant_id === options.grantId);
  const role = grant === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, grant.workspace_id);
  if (!grant || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'GRANT_NOT_AVAILABLE', 'The Grant is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: grant.workspace_id, target: grant.grant_id };
  if (grant.revoked_at !== null) {
    return { grant_id: grant.grant_id, revoked_at: grant.revoked_at, already_revoked: true };
  }
  grant.revoked_at = new Date().toISOString();
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { data_product_id: grant.data_product_id } });
  session.save();
  return { grant_id: grant.grant_id, revoked_at: grant.revoked_at };
}
