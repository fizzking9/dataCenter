/**
 * Workspace Artifact records for acquisition, integration, and consumption.
 *
 * Every list here is Deployment state, so an Artifact belongs to exactly one
 * Workspace and a missing identifier never resolves across Workspaces.
 */

/** First release acquisition types; business APIs and scrapers arrive later. */
export type SourceType = 'file';

export interface SourceRecord {
  source_id: string;
  workspace_id: string;
  name: string;
  type: SourceType;
  owner_user_id: string;
  created_at: string;
}

export type DatasetFieldType = 'string' | 'integer' | 'number' | 'date';

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
  mode: 'manual_upload';
  integration_configuration_version: number;
  attempts: number;
  status: 'complete' | 'failed';
  started_at: string;
  completed_at: string;
  raw_acquisition_ids: string[];
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

/**
 * The Consumer-facing Contract of a Data Product. It names the fields a Consumer
 * may read and the filters they may state, and nothing about the Dataset behind
 * them.
 */
export interface DataProductContract {
  title: string;
  description?: string;
  fields: Array<{ name: string; description?: string }>;
  filters: string[];
  default_limit: number;
  max_limit: number;
}

export interface DataProductVersion {
  version: number;
  published_at: string;
  published_by: string;
  contract: DataProductContract;
  contract_hash: string;
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
