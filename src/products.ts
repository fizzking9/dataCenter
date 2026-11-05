import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext, type Actor } from './authz.js';
import {
  findDataProduct,
  findDataProductVersion,
  findDataset,
  latestDataProductRelease,
  latestDataProductVersion,
  latestDatasetRelease,
  majorLine,
  type DataProductArtifact,
  type DataProductContract,
  type DataProductMajorLine,
  type DataProductRelationship,
  type DataProductRelease,
  type DataProductVersion,
  type DatasetArtifact,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
  type SourceRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { requireGovernedContract, pinnedMetricDefinitions } from './metric-definition.js';
import { workspaceRoleOf } from './platform.js';
import { readContract } from './product-contract.js';
import { nextContractVersion } from './product-version.js';
import { readableGrantScope, type GrantReader, type GrantScope } from './grants.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;

/** The stable logical path a published Data Product serves; no endpoint is generated. */
export function apiPath(workspaceId: string, dataProductId: string): string {
  return `/api/workspaces/${workspaceId}/data-products/${dataProductId}/query`;
}

/** What one Publication of one Contract Version produced. */
export interface ContractPublication {
  product: DataProductArtifact;
  version: DataProductVersion;
  release: DataProductRelease;
}

/** One declared relationship, bound to the exact Dataset Release it reads. */
export interface RelationshipBinding {
  name: string;
  dataset: DatasetArtifact;
  datasetRelease: DatasetReleaseRecord;
}

/**
 * Publishes one Contract Version and its Data Product Release into the open
 * Session, binding both to the exact Dataset Release the caller pinned for the
 * base Dataset and for every declared relationship. The caller owns the save,
 * so a Proposal Publication and its lifecycle fact land together or not at all.
 */
export function publishContractVersion(options: {
  session: PlatformSession;
  actor: Actor;
  context: ActionContext;
  source: SourceRecord;
  dataset: DatasetArtifact;
  datasetRelease: DatasetReleaseRecord;
  name: string;
  contract: DataProductContract;
  relationships?: RelationshipBinding[];
}): ContractPublication {
  const { session, actor, source, dataset, datasetRelease, contract } = options;
  const relationships = options.relationships ?? [];
  const scoped = options.context;
  const actorName = actorLabel(actor.user);
  const name = options.name.trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actorName, scoped, 'DATA_PRODUCT_NAME_INVALID', 'A Data Product name must contain 2 to 128 characters.');
  }
  requireServeableGrain(session, actorName, scoped, contract, datasetRelease);
  requireGovernedContract(session, actorName, scoped, contract, source.workspace_id, datasetRelease.pins);
  requireBoundRelationships(session, actorName, scoped, contract, relationships, source.workspace_id);
  for (const relationship of contract.relationships ?? []) {
    requireServeableRelationship(
      session,
      actorName,
      scoped,
      relationship,
      relationships.find((binding) => binding.name === relationship.name)!,
    );
  }

  let product = session.state.data_products.find(
    (candidate) => candidate.workspace_id === source.workspace_id && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  const alreadyBound = product === undefined ? undefined : latestDataProductRelease(product)?.dataset_id;
  if (product && alreadyBound !== undefined && alreadyBound !== dataset.dataset_id) {
    reject(
      session,
      actorName,
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
      lines: [],
    };
    session.state.data_products.push(product);
  }
  const contractVersion = nextContractVersion(latestDataProductVersion(product), contract);
  const version: DataProductVersion = {
    version: (latestDataProductVersion(product)?.version ?? 0) + 1,
    contract_version: contractVersion,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    contract,
    contract_hash: canonicalDigest(contract),
    withdrawn_at: null,
  };
  const release: DataProductRelease = {
    release: (latestDataProductRelease(product)?.release ?? 0) + 1,
    data_product_version: version.version,
    dataset_id: dataset.dataset_id,
    dataset_release: datasetRelease.release,
    ...(relationships.length === 0
      ? {}
      : {
        relationships: relationships.map((binding) => ({
          name: binding.name,
          dataset_id: binding.dataset.dataset_id,
          dataset_release: binding.datasetRelease.release,
        })),
      }),
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
  };
  product.versions.push(version);
  product.releases.push(release);
  advanceLine(product, version, release);
  return { product, version, release };
}

/**
 * Publishes one Data Product Version and its Data Product Release from a
 * Contract file, binding both to the current Dataset Release. Publication is
 * the act that exposes the API.
 */
export function publishDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  name: string;
  contractPath: string;
  /** The JSON object binding each declared relationship to a Source of this Workspace. */
  relatedPath?: string;
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
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), scoped, code, message, nextStep);
  const baseSchema = schemaOf(session, actorLabel(actor.user), scoped, source.source_id, datasetRelease);
  const bindings = options.relatedPath === undefined
    ? []
    : readRelationshipBindings(session, actor, scoped, options.relatedPath, source.workspace_id);
  const relatedSchemas = Object.fromEntries(bindings.map((binding) => [
    binding.name,
    schemaOf(session, actorLabel(actor.user), scoped, binding.dataset.source_id, binding.datasetRelease),
  ]));
  const contract = readContract(fail, options.contractPath, baseSchema, relatedSchemas);
  const { product, version, release } = publishContractVersion({
    session,
    actor,
    context: scoped,
    source,
    dataset,
    datasetRelease,
    name: options.name,
    contract,
    relationships: bindings,
  });

  session.audit({
    ...scoped,
    target: product.data_product_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      data_product_version: version.version,
      data_product_release: release.release,
      dataset_release: release.dataset_release,
      contract_major: version.contract_version.major,
      contract_minor: version.contract_version.minor,
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
    contract_version: { ...version.contract_version },
    contract_hash: version.contract_hash,
    published_at: version.published_at,
    released_at: release.created_at,
  };
}

/**
 * Advances the major line this Publication belongs to. A line opened by a
 * breaking change starts its own pointer; the previous line keeps serving the
 * Release its own Consumers already pin.
 */
function advanceLine(
  product: { lines: DataProductMajorLine[] },
  version: DataProductVersion,
  release: DataProductRelease,
): void {
  const major = version.contract_version.major;
  const line = product.lines.find((candidate) => candidate.major === major);
  if (line === undefined) {
    product.lines.push({
      major,
      current_version: version.version,
      current_release: release.release,
      opened_at: release.created_at,
      withdrawn_at: null,
    });
    return;
  }
  line.current_version = version.version;
  line.current_release = release.release;
  line.withdrawn_at = null;
}

/**
 * Reads the binding of each declared relationship to one Source of the same
 * Workspace. A relationship never reaches another Workspace's Dataset, and a
 * Source without a Release has nothing a link could read.
 */
function readRelationshipBindings(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  path: string,
  workspaceId: string,
): RelationshipBinding[] {
  const actorName = actorLabel(actor.user);
  const fail: Fail = (code, message, nextStep) => reject(session, actorName, context, code, message, nextStep);
  const parsed = readJsonDocument(
    path,
    fail,
    'DATA_PRODUCT_RELATIONSHIPS_UNREADABLE',
    'The relationship binding file must contain valid JSON.',
  );
  if (!isRecord(parsed)) {
    fail(
      'DATA_PRODUCT_RELATIONSHIPS_UNREADABLE',
      'The relationship binding must map each declared relationship to one Source of this Workspace.',
    );
  }
  const bindings: RelationshipBinding[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      fail('DATA_PRODUCT_RELATIONSHIPS_UNREADABLE', `The ${name} relationship must name the Source it links to.`);
    }
    const related = requireAdministeredSource(session, actor, context, value);
    if (related.workspace_id !== workspaceId) {
      reject(
        session,
        actorName,
        context,
        'DATA_PRODUCT_RELATIONSHIP_SCOPE',
        `${name} would link a Dataset of another Workspace, and a Data Product never reaches across Workspaces.`,
        'Bind a Source of the Data Product\'s own Workspace.',
      );
    }
    const dataset = findDataset(session.state.datasets, related.source_id);
    const datasetRelease = latestDatasetRelease(dataset);
    if (!dataset || !datasetRelease) {
      reject(
        session,
        actorName,
        { ...context, target: related.source_id },
        'DATASET_RELEASE_NOT_FOUND',
        `The ${name} relationship Source has no Dataset Release to link.`,
        'Release the related Dataset before publishing a Data Product that links to it.',
      );
    }
    bindings.push({ name, dataset, datasetRelease });
  }
  return bindings;
}

/**
 * Proves the Publication binds exactly the relationships its Contract declares:
 * every declared relationship to one Release of this Workspace, and nothing a
 * Consumer could not have read from the Contract.
 */
function requireBoundRelationships(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  contract: DataProductContract,
  bindings: RelationshipBinding[],
  workspaceId: string,
): void {
  const declared = (contract.relationships ?? []).map((relationship) => relationship.name);
  const bound = bindings.map((binding) => binding.name);
  const duplicated = bound.filter((name, index) => bound.indexOf(name) !== index);
  if (duplicated.length > 0) {
    reject(
      session,
      actor,
      context,
      'DATA_PRODUCT_RELATIONSHIP_DUPLICATED',
      `${duplicated.join(', ')} is bound to more than one Dataset, so the link would be ambiguous.`,
      'Bind each declared relationship once.',
    );
  }
  const unbound = declared.filter((name) => !bound.includes(name));
  if (unbound.length > 0) {
    reject(
      session,
      actor,
      context,
      'DATA_PRODUCT_RELATIONSHIP_UNBOUND',
      `${unbound.join(', ')} is declared without a Dataset Release, so its join has no governed meaning.`,
      'Bind every declared relationship to one Source of this Workspace.',
    );
  }
  const undeclared = bound.filter((name) => !declared.includes(name));
  if (undeclared.length > 0) {
    reject(
      session,
      actor,
      context,
      'DATA_PRODUCT_RELATIONSHIP_UNDECLARED',
      `${undeclared.join(', ')} is bound to a Dataset, but the Contract declares no such relationship.`,
      'Bind exactly the relationships the Contract declares, or declare this one.',
    );
  }
  const foreign = bindings.find((binding) => binding.dataset.workspace_id !== workspaceId);
  if (foreign !== undefined) {
    reject(
      session,
      actor,
      context,
      'DATA_PRODUCT_RELATIONSHIP_SCOPE',
      `${foreign.name} links a Dataset of another Workspace, and a Data Product never reaches across Workspaces.`,
    );
  }
}

/**
 * Proves a declared relationship really can be read from the Release it was
 * bound to: its own grain identifies one linked record, and a relationship that
 * promises at most one record really reaches at most one, so no query can fan
 * out and no linked record is guessed between two candidates.
 */
function requireServeableRelationship(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  relationship: DataProductRelationship,
  binding: RelationshipBinding,
): void {
  const seen = new Set<string>();
  for (const record of binding.datasetRelease.records) {
    const key = JSON.stringify(relationship.grain.map((field) => record.values[field] ?? null));
    if (seen.has(key)) {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_GRAIN_NOT_UNIQUE',
        `The ${relationship.grain.join(', ')} grain of the ${relationship.name} relationship does not identify each linked record, so its results would double count.`,
        'Declare the related grain the Dataset holds one record at.',
      );
    }
    seen.add(key);
  }
  if (relationship.cardinality !== 'one') return;
  const reached = new Set<string>();
  for (const record of binding.datasetRelease.records) {
    const key = JSON.stringify(Object.values(relationship.on).map((field) => record.values[field] ?? null));
    if (reached.has(key)) {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_RELATIONSHIP_AMBIGUOUS',
        `The ${relationship.name} relationship promises one record per device, but this Release holds several for the same join, so the answer would be ambiguous.`,
        'Link to a Dataset Release whose join identifies at most one record, or declare the relationship as many.',
      );
    }
    reached.add(key);
  }
}

/**
 * Proves the Contract's declared grain really identifies each record of the
 * Release it is published over. A coarser grain would let one record stand for
 * several and double count every metric, so the Publication is refused instead.
 */
export function requireServeableGrain(
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

export function schemaOf(
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

/** The Business Context versions one published Release pinned through its Dataset Release. */
function datasetPins(
  session: PlatformSession,
  datasetId: string,
  datasetReleaseNumber: number,
): DatasetReleaseRecord['pins'] {
  return session.state.datasets
    .find((candidate) => candidate.dataset_id === datasetId)
    ?.releases.find((candidate) => candidate.release === datasetReleaseNumber)
    ?.pins ?? { common_business_context_version: 0, workspace_business_context_version: 0 };
}

/**
 * The relationships one reader may see: a Grant narrows each linked record set
 * the same way it narrows the base fields, so a withheld field is absent rather
 * than empty, and a relationship with nothing permitted is not disclosed at all.
 */
function relationshipViews(
  contract: DataProductContract,
  scope: GrantScope,
): Array<Record<string, unknown>> {
  return (contract.relationships ?? []).flatMap((relationship) => {
    const fields = relationship.fields
      .filter((field) => scope.columns.includes(`${relationship.name}.${field.name}`))
      .map((field) => ({ ...field }));
    if (fields.length === 0) return [];
    return [{
      name: relationship.name,
      description: relationship.description ?? null,
      cardinality: relationship.cardinality,
      on: Object.fromEntries(
        Object.entries(relationship.on).filter(([local]) => scope.columns.includes(local)),
      ),
      fields,
      grain: relationship.grain.filter((field) => scope.columns.includes(`${relationship.name}.${field}`)),
      filters: relationship.filters.filter((field) => scope.columns.includes(`${relationship.name}.${field}`)),
      limit: relationship.limit,
    }];
  });
}

/**
 * The Contract as one reader may see it. A Grant narrows the columns, so the
 * fields, dimensions, metrics, and filters it hides are absent rather than
 * empty: no surface may disclose that a withheld column exists.
 */
export function contractView(contract: DataProductContract, scope: GrantScope): Record<string, unknown> {
  const dimensions = contract.dimensions.filter((dimension) => scope.columns.includes(dimension));
  return {
    title: contract.title,
    fields: contract.fields
      .filter((field) => scope.columns.includes(field.name))
      .map((field) => ({ ...field })),
    dimensions: [...dimensions],
    metrics: contract.metrics
      .filter((metric) => metric.field === undefined || scope.columns.includes(metric.field))
      .map((metric) => ({
        name: metric.name,
        aggregation: metric.aggregation,
        value_type: metric.value_type,
        unit: metric.unit ?? null,
        currency: metric.currency ?? null,
        ...(metric.definition === undefined ? {} : { definition: metric.definition }),
        dimensions: metric.dimensions === undefined
          ? [...dimensions]
          : metric.dimensions.filter((dimension) => scope.columns.includes(dimension)),
      })),
    grain: [...contract.grain],
    time: contract.time === undefined ? null : { ...contract.time },
    filters: contract.filters.filter((filter) => scope.columns.includes(filter)),
    relationships: relationshipViews(contract, scope),
    limits: { ...contract.limits },
  };
}

/** The identity every read of a published Data Product answers with. */
export function productIdentity(
  product: DataProductArtifact,
  version: DataProductVersion,
  release: DataProductRelease,
): Record<string, unknown> {
  return {
    data_product_id: product.data_product_id,
    name: product.name,
    api_path: product.api_path,
    data_product_version: version.version,
    data_product_release: release.release,
    dataset_release: release.dataset_release,
    contract_version: { ...version.contract_version },
    contract_hash: version.contract_hash,
  };
}

/**
 * One published Data Product as a reader may see it, or nothing at all when the
 * reader's Grants do not apply to its current Contract line.
 */
export function describeDataProduct(
  product: DataProductArtifact,
  reader: GrantReader,
): Record<string, unknown> | null {
  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  if (!version || !release) return null;
  const scope = reader.scopeOf(product, version.contract);
  if (scope === null) return null;
  return {
    ...productIdentity(product, version, release),
    ...contractView(version.contract, scope),
  };
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
  const role = workspaceRoleOf(session.state, actor.user.user_id, options.workspaceId);
  if (role === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  const visible = session.state.data_products
    .filter((product) => product.workspace_id === options.workspaceId && product.releases.length > 0)
    .flatMap((product) => {
      const version = latestDataProductVersion(product);
      const release = latestDataProductRelease(product);
      if (!version || !release) return [];
      // Discovery is narrowed the same way a read is, so a Grant never hides a
      // value while still disclosing that it exists. A Grant that no longer
      // applies to its Contract line hides only its own Product instead of
      // refusing the whole Workspace listing.
      const scope = readableGrantScope(session, actor.user.user_id, role, product, version.contract);
      if (scope === null) return [];
      const definitions = pinnedMetricDefinitions(
        session,
        product.workspace_id,
        datasetPins(session, release.dataset_id, release.dataset_release),
      );
      return [{
        data_product_id: product.data_product_id,
        name: product.name,
        api_path: product.api_path,
        title: version.contract.title,
        fields: version.contract.fields.map((field) => field.name).filter((name) => scope.columns.includes(name)),
        dimensions: version.contract.dimensions.filter((dimension) => scope.columns.includes(dimension)),
        metrics: version.contract.metrics
          .filter((metric) => metric.field === undefined || scope.columns.includes(metric.field))
          .map((metric) => ({
            name: metric.name,
            aggregation: metric.aggregation,
            value_type: metric.value_type,
            unit: metric.unit ?? null,
            currency: metric.currency ?? null,
            ...(metric.definition === undefined
              ? {}
              : {
                definition: metric.definition,
                favorable_direction: definitions.get(metric.definition)?.favorable_direction ?? null,
              }),
            dimensions: metric.dimensions === undefined
              ? version.contract.dimensions.filter((dimension) => scope.columns.includes(dimension))
              : metric.dimensions.filter((dimension) => scope.columns.includes(dimension)),
          })),
        grain: [...version.contract.grain],
        time: version.contract.time === undefined ? null : { ...version.contract.time },
        filters: version.contract.filters.filter((filter) => scope.columns.includes(filter)),
        relationships: relationshipViews(version.contract, scope),
        data_product_version: version.version,
        data_product_release: release.release,
        dataset_release: release.dataset_release,
        contract_version: { ...version.contract_version },
      }];
    });
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { products_returned: visible.length } });
  return { workspace_id: options.workspaceId, data_products: visible };
}

/**
 * Resolves a Data Product the actor may read in its own Workspace. A Data
 * Product in another Workspace answers exactly like one that does not exist.
 */
export function requireReadableProduct(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  dataProductId: string,
): DataProductArtifact {
  const product = findDataProduct(session.state.data_products, dataProductId);
  const role = product === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  if (!product || role === null) {
    deny(session, actorLabel(actor.user), context, 'DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this actor.');
  }
  return product;
}

/**
 * Resolves a Data Product only a Workspace Administrator may administer. A
 * member who may merely read it answers exactly like a stranger, so the
 * existence of the Artifact is never confirmed to an actor who may not govern it.
 */
export function requireAdministeredProduct(
  session: PlatformSession,
  actor: Actor,
  context: ActionContext,
  dataProductId: string,
): DataProductArtifact {
  const product = findDataProduct(session.state.data_products, dataProductId);
  const role = product === undefined
    ? null
    : workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  if (!product || role !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this actor.');
  }
  return product;
}

/** Lists every Release a Consumer may read, with the Contract line each one served. */
export function listDataProductReleases(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_release_listing', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = requireReadableProduct(session, actor, context, options.dataProductId);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const releases = product.releases.map((release) => {
    const version = findDataProductVersion(product, release.data_product_version);
    return {
      release: release.release,
      data_product_version: release.data_product_version,
      contract_version: version === undefined ? null : { ...version.contract_version },
      withdrawn: version?.withdrawn_at !== null && version?.withdrawn_at !== undefined,
      dataset_release: release.dataset_release,
      relationships: (release.relationships ?? []).map((binding) => ({ ...binding })),
      created_at: release.created_at,
    };
  });
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { releases_returned: releases.length } });
  return {
    data_product_id: product.data_product_id,
    name: product.name,
    api_path: product.api_path,
    lines: product.lines.map((line) => ({ ...line })),
    releases,
  };
}

/**
 * Withdraws one Data Product Version. A withdrawn Version serves no new query
 * and, where it was the head of its major line, that line stops advancing until
 * a later Publication claims it again. History and provenance are preserved.
 */
export function withdrawDataProductVersion(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_withdrawal', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = requireAdministeredProduct(session, actor, context, options.dataProductId);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const version = findDataProductVersion(product, options.version);
  if (!version) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'DATA_PRODUCT_VERSION_NOT_FOUND',
      `This Data Product has no Version ${options.version}.`,
      'List the Releases the Data Product published before withdrawing one.',
    );
  }
  if (version.withdrawn_at !== null) {
    return { data_product_id: product.data_product_id, data_product_version: version.version, withdrawn_at: version.withdrawn_at, already_withdrawn: true };
  }
  version.withdrawn_at = new Date().toISOString();
  const line: DataProductMajorLine | undefined = majorLine(product, version.contract_version.major);
  if (line !== undefined && line.current_version === version.version) {
    line.withdrawn_at = version.withdrawn_at;
  }
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      data_product_version: version.version,
      contract_major: version.contract_version.major,
      line_withdrawn: line?.withdrawn_at === version.withdrawn_at,
    },
  });
  session.save();
  return {
    data_product_id: product.data_product_id,
    data_product_version: version.version,
    withdrawn_at: version.withdrawn_at,
    contract_version: { ...version.contract_version },
  };
}