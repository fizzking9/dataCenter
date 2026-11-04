/**
 * Workspace Artifact records for acquisition, integration, and consumption.
 *
 * Every list here is Deployment state, so an Artifact belongs to exactly one
 * Workspace and a missing identifier never resolves across Workspaces.
 */

/** First release acquisition types: a hand-uploaded file or a declarative JSON endpoint. */
export type SourceType = 'file' | 'http_json';

/** The one connector this release ships, named and versioned so a Plan pins it. */
export const HTTP_JSON_CONNECTOR = { name: 'http-json', version: 1 } as const;

/** An encrypted secret as the Deployment stores it; the plaintext never leaves memory. */
export interface SealedSecret {
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
  tag: string;
}

/** The exact textual shapes a canonical `date` and `timestamp` value holds. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface SourceRecord {
  source_id: string;
  workspace_id: string;
  name: string;
  type: SourceType;
  owner_user_id: string;
  created_at: string;
}

export type DatasetFieldType = 'string' | 'integer' | 'number' | 'date' | 'timestamp';

export interface DatasetSchemaField {
  name: string;
  type: DatasetFieldType;
}

export type CleaningRuleName = 'trim' | 'uppercase' | 'lowercase' | 'default' | 'require_non_empty';

export interface CleaningRule {
  rule: CleaningRuleName;
  field: string;
  value?: string;
}

/**
 * One immutable Integration Configuration Version. The three component hashes
 * let a Dataset Release name the exact schema, cleaning, and mapping it used
 * without copying any of them into the release.
 */
export interface IntegrationConfigurationVersion {
  version: number;
  published_at: string;
  published_by: string;
  identity_fields: string[];
  schema: DatasetSchemaField[];
  cleaning: CleaningRule[];
  mapping: Record<string, string>;
  schema_hash: string;
  cleaning_hash: string;
  mapping_hash: string;
  content_hash: string;
  pins: { common_business_context_version: number; workspace_business_context_version: number };
}

/** A Source's Integration Configuration Artifact and the version it adopted. */
export interface IntegrationConfigurationArtifact {
  source_id: string;
  workspace_id: string;
  owner_user_id: string;
  adopted_version: number | null;
  versions: IntegrationConfigurationVersion[];
}

/** The immutable uncurated bytes one Acquisition Run attempt produced. */
export interface RawAcquisitionRecord {
  raw_id: string;
  workspace_id: string;
  source_id: string;
  acquisition_run_id: string;
  content_hash: string;
  byte_length: number;
  object_path: string;
  received_at: string;
}

/** One manual or scheduled acquisition request and how its attempt ended. */
export interface AcquisitionRunRecord {
  acquisition_run_id: string;
  workspace_id: string;
  source_id: string;
  mode: 'manual_upload' | 'connector';
  trigger: 'manual' | 'scheduled';
  integration_configuration_version: number | null;
  attempts: number;
  status: 'queued' | 'running' | 'complete' | 'failed';
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  raw_acquisition_ids: string[];
  error_code?: string | null;
}

/** How a paginated endpoint signals that the last page has been read. */
export type PaginationCompletion =
  | { kind: 'empty_page' }
  | { kind: 'short_page' }
  | { kind: 'last_page_flag'; flag: string; done_value: boolean };

/** How one Connection asks for its next page. */
export interface ConnectionPagination {
  parameter: string;
  size_parameter: string | null;
  start: number;
  size: number;
  max_pages: number;
}

/** One immutable Acquisition Connection Version: endpoint, auth scheme, and policy. */
export interface AcquisitionConnectionVersion {
  version: number;
  published_at: string;
  published_by: string;
  base_url: string;
  /** The name of the stored credential, never the credential itself. */
  credential_ref: string;
  pagination: ConnectionPagination;
  schedule: { every_minutes: number } | null;
  content_hash: string;
}

/** A Workspace-owned Connection shared by the Sources of one physical system. */
export interface AcquisitionConnectionArtifact {
  connection_id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  adopted_version: number | null;
  versions: AcquisitionConnectionVersion[];
  credential: SealedSecret | null;
}

/** One immutable per-Source acquisition configuration, pinning its Connection. */
export interface SourceAcquisitionVersion {
  version: number;
  published_at: string;
  published_by: string;
  connection_id: string;
  connection_version: number;
  connector: { name: string; version: number };
  path: string;
  record_path: string | null;
  completion: PaginationCompletion;
  content_hash: string;
}

/** A Source's acquisition configuration Artifact and the version it adopted. */
export interface SourceAcquisitionArtifact {
  source_id: string;
  workspace_id: string;
  owner_user_id: string;
  adopted_version: number | null;
  versions: SourceAcquisitionVersion[];
}

/** One page a Plan must complete, and what became of it. */
export interface AcquisitionPlanPage {
  page: number;
  raw_id: string | null;
  outcome: 'received' | 'empty' | 'failed';
  record_count: number | null;
  error_code: string | null;
}

/**
 * The immutable set of pages one Acquisition Run attempt must complete before
 * its result may become an Integration Batch. It is durable before the first
 * request, so an interrupted attempt keeps the pages it really read.
 */
export interface AcquisitionPlanRecord {
  plan_id: string;
  workspace_id: string;
  source_id: string;
  acquisition_run_id: string;
  trigger: 'manual' | 'scheduled';
  connector: { name: string; version: number };
  connection_id: string;
  connection_version: number;
  acquisition_configuration_version: number;
  integration_configuration_version: number;
  pages: AcquisitionPlanPage[];
  status: 'planned' | 'complete' | 'partial' | 'failed';
  created_at: string;
  completed_at: string | null;
}

/** The complete handoff from one successful Acquisition Run to integration. */
export interface IntegrationBatchRecord {
  batch_id: string;
  workspace_id: string;
  source_id: string;
  acquisition_run_id: string;
  integration_configuration_version: number;
  integration_configuration_content_hash: string;
  raw_acquisition_ids: string[];
  created_at: string;
}

/** One canonical record; the values are already cleaned and type-coerced. */
export interface DatasetRecordRow {
  identity: string;
  values: Record<string, string | number | null>;
}

export type RejectionRule = 'identity' | 'type' | CleaningRuleName;

/** Why one source record did not become a canonical record. */
export interface RecordRejection {
  raw_id: string;
  /** The physical CSV record number, where the header is row 1. */
  row: number;
  field: string | null;
  rule: RejectionRule;
  reason: string;
  integration_configuration_version: number;
}

/**
 * One immutable, logically complete snapshot of a Dataset. It names the exact
 * Artifact Versions it was produced under rather than restating them.
 */
export interface DatasetReleaseRecord {
  dataset_id: string;
  workspace_id: string;
  source_id: string;
  release: number;
  created_at: string;
  created_by: string;
  record_count: number;
  records_hash: string;
  integration_configuration_version: number;
  schema_hash: string;
  cleaning_hash: string;
  mapping_hash: string;
  pins: { common_business_context_version: number; workspace_business_context_version: number };
  provenance: {
    batch_ids: string[];
    acquisition_run_ids: string[];
    raw_acquisition_ids: string[];
    acquired_at: string;
    integrated_at: string;
  };
  records: DatasetRecordRow[];
  record_rejections: RecordRejection[];
}

/** A Dataset Artifact and its ordered, append-only Releases. */
export interface DatasetArtifact {
  dataset_id: string;
  workspace_id: string;
  source_id: string;
  owner_user_id: string;
  created_at: string;
  releases: DatasetReleaseRecord[];
}

export type MetricAggregation = 'count' | 'sum' | 'min' | 'max' | 'avg';

/** How a Consumer reads the values a metric produces. */
export type MetricValueType = 'integer' | 'decimal' | 'money' | 'date' | 'timestamp';

/** One governed metric a Data Product Contract publishes for Consumers to request. */
export interface DataProductMetric {
  name: string;
  description?: string;
  aggregation: MetricAggregation;
  /** The Dataset Schema field the metric aggregates; a record count has none. */
  field?: string;
  value_type: MetricValueType;
  unit?: string;
  currency?: string;
  /** The dimensions this metric may be grouped by; absent permits every declared dimension. */
  dimensions?: string[];
}

/** The time field a Contract resolves windows against and the precision it declares. */
export interface DataProductTime {
  field: string;
  precision: 'date' | 'timestamp';
  time_zone: string;
}

/** The resource envelope one Data Product Query may consume. */
export interface DataProductQueryLimits {
  max_scanned_records: number;
  max_groups: number;
  max_execution_ms: number;
}

/**
 * The Consumer-facing Contract of a Data Product. It names the fields a Consumer
 * may read, the dimensions they may group by, the metrics they may request, the
 * record grain, and the time field, and nothing about the Dataset behind them.
 */
export interface DataProductContract {
  title: string;
  description?: string;
  fields: Array<{ name: string; description?: string }>;
  dimensions: string[];
  metrics: DataProductMetric[];
  /** The Dataset Schema fields that identify one record. */
  grain: string[];
  time?: DataProductTime;
  filters: string[];
  /** The most results one page may hold. */
  default_limit: number;
  max_limit: number;
  /** The resource envelope one query may consume, distinct from its page size. */
  limits: DataProductQueryLimits;
}

export interface DataProductVersion {
  version: number;
  /** The Contract line this Version belongs to: a major line never changes shape. */
  contract_version: DataProductContractVersion;
  published_at: string;
  published_by: string;
  contract: DataProductContract;
  contract_hash: string;
  /** Set when the Version may no longer execute, while its history stays readable. */
  withdrawn_at: string | null;
}

/**
 * The Consumer-facing version of a Contract: a major line only ever grows
 * additively, so a Consumer pinned to it keeps working as Releases advance.
 */
export interface DataProductContractVersion {
  major: number;
  minor: number;
}

/**
 * One active major Contract line and the Release it currently serves. Each line
 * advances its own pointer, so publishing a new major never moves a Consumer
 * pinned to the previous one.
 */
export interface DataProductMajorLine {
  major: number;
  current_version: number;
  current_release: number;
  opened_at: string;
  withdrawn_at: string | null;
}

/** One declarative row predicate a Grant imposes on every read of a Data Product. */
export interface GrantRowFilter {
  field: string;
  op:
    | 'equals'
    | 'not_equals'
    | 'less_than'
    | 'less_or_equal'
    | 'greater_than'
    | 'greater_or_equal'
    | 'is_null'
    | 'is_not_null';
  value: string | number | null;
}

/**
 * A Workspace-scoped authorization configuration narrowing one principal's
 * reads of one published Data Product: the columns it may see and the rows it
 * may count. It never widens what the Contract publishes.
 */
export interface DataProductGrantRecord {
  grant_id: string;
  workspace_id: string;
  data_product_id: string;
  grantee: { type: 'user' | 'agent_identity'; id: string };
  /** Permitted Contract fields; every field the Contract publishes when unstated. */
  columns: string[] | null;
  row_filters: GrantRowFilter[];
  created_at: string;
  created_by: string;
  revoked_at: string | null;
}

/** One encrypted, short-lived curated-result export a Consumer requested. */
export interface ExportRecord {
  export_id: string;
  workspace_id: string;
  data_product_id: string;
  data_product_release: number;
  actor_user_id: string;
  created_at: string;
  expires_at: string;
  row_count: number;
  columns: string[];
  content_hash: string;
  /** The ciphertext object, relative to the Deployment root. */
  object_path: string;
  downloaded_at: string | null;
}

/** One immutable result binding an exact Data Product Version to a Dataset Release. */
export interface DataProductRelease {
  release: number;
  data_product_version: number;
  dataset_id: string;
  dataset_release: number;
  created_at: string;
  created_by: string;
}

export interface DataProductArtifact {
  data_product_id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  api_path: string;
  created_at: string;
  versions: DataProductVersion[];
  releases: DataProductRelease[];
  /** One entry per major Contract line ever opened. */
  lines: DataProductMajorLine[];
}

export function findSource(sources: SourceRecord[], sourceId: string): SourceRecord | undefined {
  return sources.find((source) => source.source_id === sourceId);
}

export function findIntegrationConfiguration(
  artifacts: IntegrationConfigurationArtifact[],
  sourceId: string,
): IntegrationConfigurationArtifact | undefined {
  return artifacts.find((artifact) => artifact.source_id === sourceId);
}

export function latestIntegrationVersion(
  artifact: IntegrationConfigurationArtifact | undefined,
): IntegrationConfigurationVersion | undefined {
  return artifact?.versions[artifact.versions.length - 1];
}

export function adoptedIntegrationVersion(
  artifact: IntegrationConfigurationArtifact | undefined,
): IntegrationConfigurationVersion | undefined {
  if (!artifact || artifact.adopted_version === null) return undefined;
  return artifact.versions.find((version) => version.version === artifact.adopted_version);
}

/** The latest Batch a Source has handed to integration. */
export function latestIntegrationBatch(
  batches: IntegrationBatchRecord[],
  sourceId: string,
): IntegrationBatchRecord | undefined {
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (batch?.source_id === sourceId) return batch;
  }
  return undefined;
}

export function findDataset(datasets: DatasetArtifact[], sourceId: string): DatasetArtifact | undefined {
  return datasets.find((dataset) => dataset.source_id === sourceId);
}

export function latestDatasetRelease(dataset: DatasetArtifact | undefined): DatasetReleaseRecord | undefined {
  return dataset?.releases[dataset.releases.length - 1];
}

export function findDataProduct(
  products: DataProductArtifact[],
  dataProductId: string,
): DataProductArtifact | undefined {
  return products.find((product) => product.data_product_id === dataProductId);
}

export function latestDataProductVersion(
  product: DataProductArtifact | undefined,
): DataProductVersion | undefined {
  return product?.versions[product.versions.length - 1];
}

export function latestDataProductRelease(
  product: DataProductArtifact | undefined,
): DataProductRelease | undefined {
  return product?.releases[product.releases.length - 1];
}

/** The major line a query reads when it names none: the newest one still serving. */
export function activeMajorLine(product: DataProductArtifact | undefined): DataProductMajorLine | undefined {
  let active: DataProductMajorLine | undefined;
  for (const line of product?.lines ?? []) {
    if (line.withdrawn_at !== null) continue;
    if (active === undefined || line.major > active.major) active = line;
  }
  return active;
}

export function majorLine(
  product: DataProductArtifact | undefined,
  major: number,
): DataProductMajorLine | undefined {
  return (product?.lines ?? []).find((line) => line.major === major);
}

export function findDataProductVersion(
  product: DataProductArtifact | undefined,
  version: number,
): DataProductVersion | undefined {
  return product?.versions.find((candidate) => candidate.version === version);
}

export function findDataProductRelease(
  product: DataProductArtifact | undefined,
  release: number,
): DataProductRelease | undefined {
  return product?.releases.find((candidate) => candidate.release === release);
}

/** The Grants still in force for one principal on one Data Product. */
export function activeGrants(
  grants: DataProductGrantRecord[],
  dataProductId: string,
  granteeId: string,
): DataProductGrantRecord[] {
  return grants.filter(
    (grant) => grant.data_product_id === dataProductId
      && grant.grantee.id === granteeId
      && grant.revoked_at === null,
  );
}
