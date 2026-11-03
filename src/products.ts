import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  findDataset,
  latestDataProductRelease,
  latestDataProductVersion,
  latestDatasetRelease,
  type DataProductContract,
  type DataProductRelease,
  type DataProductVersion,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import type { Fail } from './errors.js';
import { workspaceRoleOf } from './platform.js';
import { readContract } from './product-contract.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;

/** The stable logical path a published Data Product serves; no endpoint is generated. */
function apiPath(workspaceId: string, dataProductId: string): string {
  return `/api/workspaces/${workspaceId}/data-products/${dataProductId}/query`;
}

/**
 * Publishes one Data Product Version and its Data Product Release, binding both
 * to the current Dataset Release. Publication is the act that exposes the API.
 *
 * A name is the identity of one published API, so reusing it for another Dataset
 * is refused rather than silently repointing a Consumer's endpoint.
 */
export function publishDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  name: string;
  contractPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_publication', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };

  const dataset = findDataset(session.state.datasets, source.source_id);
  const datasetRelease = latestDatasetRelease(dataset);
  if (!dataset || !datasetRelease) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'DATASET_RELEASE_NOT_FOUND',
      'The Source has no Dataset Release to publish as a Data Product.',
      'Release the Dataset before publishing a Data Product over it.',
    );
  }
  const name = options.name.trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actorLabel(actor.user), scoped, 'DATA_PRODUCT_NAME_INVALID', 'A Data Product name must contain 2 to 128 characters.');
  }
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  const contract = readContract(
    fail,
    options.contractPath,
    schemaOf(session, actorLabel(actor.user), scoped, source.source_id, datasetRelease),
  );
  requireServeableGrain(session, actorLabel(actor.user), scoped, contract, datasetRelease);

  let product = session.state.data_products.find(
    (candidate) => candidate.workspace_id === source.workspace_id && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  const alreadyBound = product === undefined
    ? undefined
    : latestDataProductRelease(product)?.dataset_id;
  if (product && alreadyBound !== undefined && alreadyBound !== dataset.dataset_id) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'DATA_PRODUCT_NAME_TAKEN',
      'This name is already the published Data Product API of another Dataset.',
      'Publish the Data Product for this Source under its own name.',
    );
  }
  if (!product) {
    const dataProductId = randomUUID();
    product = {
      data_product_id: dataProductId,
      workspace_id: source.workspace_id,
      name,
      owner_user_id: source.owner_user_id,
      api_path: apiPath(source.workspace_id, dataProductId),
      created_at: new Date().toISOString(),
      versions: [],
      releases: [],
    };
    session.state.data_products.push(product);
  }
  const version: DataProductVersion = {
    version: (latestDataProductVersion(product)?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    contract,
    contract_hash: canonicalDigest(contract),
  };
  const release: DataProductRelease = {
    release: (latestDataProductRelease(product)?.release ?? 0) + 1,
    data_product_version: version.version,
    dataset_id: dataset.dataset_id,
    dataset_release: datasetRelease.release,
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
  };
  product.versions.push(version);
  product.releases.push(release);

  session.audit({
    ...scoped,
    target: product.data_product_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      data_product_version: version.version,
      data_product_release: release.release,
      dataset_release: release.dataset_release,
    },
  });
  session.save();
  return {
    data_product_id: product.data_product_id,
    workspace_id: product.workspace_id,
    name: product.name,
    api_path: product.api_path,
    data_product_version: version.version,
    data_product_release: release.release,
    dataset_release: release.dataset_release,
    contract_hash: version.contract_hash,
    published_at: version.published_at,
    released_at: release.created_at,
  };
}

/**
 * Proves the Contract's declared grain really identifies each record of the
 * Release it is published over. A coarser grain would let one record stand for
 * several and double count every metric, so the Publication is refused instead.
 */
function requireServeableGrain(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  contract: DataProductContract,
  release: DatasetReleaseRecord,
): void {
  if (contract.grain.length === 0) return;
  const seen = new Set<string>();
  for (const record of release.records) {
    const key = JSON.stringify(contract.grain.map((field) => record.values[field] ?? null));
    if (seen.has(key)) {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_GRAIN_NOT_UNIQUE',
        `The ${contract.grain.join(', ')} grain does not identify each record of this Dataset Release, so its metrics would double count.`,
        'Declare the grain the Dataset holds one record at.',
      );
    }
    seen.add(key);
  }
}

function schemaOf(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  sourceId: string,
  release: DatasetReleaseRecord,
): DatasetSchemaField[] {
  const version = session.state.integration_configurations
    .find((artifact) => artifact.source_id === sourceId)
    ?.versions.find((candidate) => candidate.version === release.integration_configuration_version);
  if (!version) {
    reject(session, actor, context, 'INTEGRATION_VERSION_NOT_FOUND', 'The Integration Configuration Version this Dataset Release pins no longer exists.');
  }
  return version.schema;
}

/** Lists only published Data Products the actor is entitled to see in one Workspace. */
export function listDataProducts(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'data_product_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  if (workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId) === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const visible = session.state.data_products
    .filter((product) => product.workspace_id === options.workspaceId && product.releases.length > 0)
    .flatMap((product) => {
      const version = latestDataProductVersion(product);
      const release = latestDataProductRelease(product);
      if (!version || !release) return [];
      return [{
        data_product_id: product.data_product_id,
        name: product.name,
        api_path: product.api_path,
        title: version.contract.title,
        fields: version.contract.fields.map((field) => field.name),
        dimensions: [...version.contract.dimensions],
        metrics: version.contract.metrics.map((metric) => ({
          name: metric.name,
          aggregation: metric.aggregation,
          value_type: metric.value_type,
          unit: metric.unit ?? null,
          currency: metric.currency ?? null,
          dimensions: metric.dimensions === undefined ? [...version.contract.dimensions] : [...metric.dimensions],
        })),
        grain: [...version.contract.grain],
        time: version.contract.time === undefined ? null : { ...version.contract.time },
        filters: [...version.contract.filters],
        data_product_version: version.version,
        data_product_release: release.release,
        dataset_release: release.dataset_release,
      }];
    });
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { products_returned: visible.length } });
  return { workspace_id: options.workspaceId, data_products: visible };
}