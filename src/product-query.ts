import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  findDataProduct,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductContract,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
} from './catalog.js';
import { isRecord, readJsonDocument } from './documents.js';
import { workspaceRoleOf } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

interface QueryFilter {
  field: string;
  op: 'equals';
  value: string | number;
}

/** Which JavaScript value a Dataset Schema field can be compared against. */
function acceptsValue(field: DatasetSchemaField, value: unknown): value is string | number {
  return field.type === 'integer' || field.type === 'number'
    ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === 'string';
}

/**
 * Reads the Data Product Query document a Consumer composes against the Contract.
 *
 * A filter must name a declared filter field and state a value the field's type
 * can hold, so a string standing in for a number never silently matches nothing.
 */
function readQuery(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  path: string,
  contract: DataProductContract,
  schema: DatasetSchemaField[],
): { filters: QueryFilter[]; limit: number } {
  const parsed = readJsonDocument(
    path,
    (code, message) => reject(session, actor, context, code, message),
    'DATA_PRODUCT_QUERY_INVALID',
    'The Data Product Query document must contain valid JSON.',
  );
  if (!isRecord(parsed)) {
    reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', 'A Data Product Query must be a JSON object.');
  }
  if (parsed['kind'] !== 'records') {
    reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', 'This release answers record queries only.');
  }

  const rawFilters = parsed['filters'] ?? [];
  if (!Array.isArray(rawFilters)) {
    reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', 'Query filters must be an array.');
  }
  const filters: QueryFilter[] = [];
  for (const candidate of rawFilters) {
    if (!isRecord(candidate) || typeof candidate['field'] !== 'string' || candidate['op'] !== 'equals') {
      reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', 'Each query filter must state a field and the equals operator.');
    }
    const field = candidate['field'];
    if (!contract.filters.includes(field)) {
      reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', `${field} is not a filter the Data Product Contract permits.`);
    }
    const schemaField = schema.find((candidateField) => candidateField.name === field)!;
    const value = candidate['value'];
    if (!acceptsValue(schemaField, value)) {
      reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', `The ${field} filter must state a ${schemaField.type} value.`);
    }
    filters.push({ field, op: 'equals', value });
  }

  const limit = parsed['limit'] ?? contract.default_limit;
  if (!Number.isInteger(limit) || (limit as number) < 1) {
    reject(session, actor, context, 'DATA_PRODUCT_QUERY_INVALID', 'A query limit must be a whole number of at least 1.');
  }
  if ((limit as number) > contract.max_limit) {
    reject(session, actor, context, 'DATA_PRODUCT_QUERY_LIMIT_EXCEEDED', `A query limit cannot exceed ${contract.max_limit}.`);
  }
  return { filters, limit: limit as number };
}

/**
 * Answers one Data Product Query against the Data Product Release the Contract
 * was published with, so a later Dataset Release never changes an open Contract.
 *
 * A Data Product in a Workspace the actor does not belong to answers exactly like
 * one that does not exist, and the response carries curated records and permitted
 * Provenance only.
 */
export function queryDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  requestPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_query', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);

  const product = findDataProduct(session.state.data_products, options.dataProductId);
  const role = product === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  if (!product || role === null) {
    deny(session, actorLabel(actor.user), context, 'DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };

  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  if (!version || !release) {
    reject(session, actorLabel(actor.user), scoped, 'DATA_PRODUCT_NOT_PUBLISHED', 'The Data Product has no Publication to query.');
  }
  const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
  const datasetRelease: DatasetReleaseRecord | undefined = dataset?.releases.find(
    (candidate) => candidate.release === release.dataset_release,
  );
  if (!dataset || !datasetRelease) {
    reject(session, actorLabel(actor.user), scoped, 'DATASET_RELEASE_NOT_FOUND', 'The Dataset Release this Data Product pins is not available.');
  }
  const schema = session.state.integration_configurations
    .find((artifact) => artifact.source_id === dataset.source_id)
    ?.versions.find((candidate) => candidate.version === datasetRelease.integration_configuration_version)
    ?.schema ?? [];
  const source = session.state.sources.find((candidate) => candidate.source_id === dataset.source_id);

  const query = readQuery(session, actorLabel(actor.user), scoped, options.requestPath, version.contract, schema);
  const matched = datasetRelease.records.filter((record) => query.filters.every(
    (filter) => record.values[filter.field] === filter.value,
  ));
  const projected = matched.slice(0, query.limit).map((record) => {
    const values: Record<string, string | number | null> = {};
    for (const field of version.contract.fields) {
      values[field.name] = record.values[field.name] ?? null;
    }
    return values;
  });

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { data_product_release: release.release, matched_count: matched.length, returned: projected.length },
  });
  return {
    data_product_id: product.data_product_id,
    name: product.name,
    api_path: product.api_path,
    data_product_version: version.version,
    data_product_release: release.release,
    contract_hash: version.contract_hash,
    records: projected,
    matched_count: matched.length,
    returned: projected.length,
    truncated: matched.length > projected.length,
    limit: query.limit,
    provenance: {
      source: { source_id: dataset.source_id, name: source?.name ?? null },
      dataset_release: datasetRelease.release,
      integration_configuration_version: datasetRelease.integration_configuration_version,
      business_context: { ...datasetRelease.pins },
      record_count: datasetRelease.record_count,
      acquired_at: datasetRelease.provenance.acquired_at,
      integrated_at: datasetRelease.provenance.integrated_at,
      released_at: datasetRelease.created_at,
    },
  };
}
