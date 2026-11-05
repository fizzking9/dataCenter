/**
 * Workspace Artifact records for acquisition, integration, and consumption.
 *
 * Every list here is Deployment state, so an Artifact belongs to exactly one
 * Workspace and a missing identifier never resolves across Workspaces.
 */

/**
 * First release acquisition types: a hand-uploaded file, a declarative JSON
 * endpoint, an uploaded bundle of documents, or a human-approved Scraper Service.
 */
export type SourceType = 'file' | 'http_json' | 'document' | 'scraper';

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

/**
 * The explicit resource envelope one document bundle is parsed under. Every
 * bound is declared before parsing, and a bundle that would exceed any one of
 * them fails closed rather than being partly read.
 */
export interface DocumentParseLimits {
  /** The raw bytes one Raw Acquisition may hold. */
  max_bytes: number;
  /** How many documents one bundle may state. */
  max_documents: number;
  /** How many characters one document's extracted text may hold. */
  max_text_chars: number;
  /** How many metadata members one document may carry. */
  max_metadata_fields: number;
  /** The wall-clock budget the isolated parse worker is given. */
  max_worker_ms: number;
  /** The heap the isolated parse worker may grow to. */
  max_heap_mb: number;
}

/** The document parser this release ships, named and versioned so a Release pins it. */
export const DOCUMENT_BUNDLE_PARSER = { name: 'document-bundle', version: 1 } as const;

/** The envelope a document bundle is parsed under when its Configuration states none. */
export const DEFAULT_DOCUMENT_PARSE_LIMITS: DocumentParseLimits = {
  max_bytes: 8_388_608,
  max_documents: 5_000,
  max_text_chars: 200_000,
  max_metadata_fields: 64,
  max_worker_ms: 5_000,
  max_heap_mb: 128,
};

/**
 * The exact parser and resource envelope one Dataset Release ran. A Release
 * that curated no document carries none, so a Reader can tell a document
 * Release from a tabular one without guessing.
 */
export interface DocumentProcessingRecord {
  parser: { name: 'document-bundle'; version: 1 };
  limits: DocumentParseLimits;
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
  /** The resource envelope documents are parsed under; unstated takes the default. */
  document_limits?: DocumentParseLimits;
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
  mode: 'manual_upload' | 'connector' | 'scraper';
  trigger: 'manual' | 'scheduled';
  /** The window a manual backfill states; null for a normal Run. */
  backfill: { start: string; end: string } | null;
  /** The earlier Run a manual rerun was requested from; null for a first request. */
  rerun_of?: string | null;
  integration_configuration_version: number | null;
  attempts: number;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  queued_at: string;
  /** The schedule instant a scheduled Run was due; null for a manual Run. */
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  raw_acquisition_ids: string[];
  error_code?: string | null;
}

/** How one Connection authenticates every request its Sources make. */
export type ConnectionAuth =
  | { scheme: 'none' }
  | { scheme: 'basic'; username: string }
  | { scheme: 'bearer' }
  | { scheme: 'api_key'; header: string; prefix: string | null }
  | { scheme: 'oauth_client_credentials'; token_url: string; client_id: string; scope: string | null }
  | {
    scheme: 'login';
    login_path: string;
    username: string;
    /** Where a bearer token sits in the login response; null when the login yields a cookie only. */
    token_path: string | null;
    /** The cookie a login session is carried in; null when the login yields a bearer token only. */
    cookie_name: string | null;
  };

/** How many times one request is attempted and how long the connector waits between attempts. */
export interface ConnectionRetryPolicy {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  retry_on: number[];
}

/** The collective pacing one Connection imposes on every Source and worker that uses it. */
export interface ConnectionPacingPolicy {
  serialization: boolean;
  minimum_interval_seconds: number;
  maximum_requests_per_minute: number | null;
  maximum_concurrent_runs: number;
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
  /** Page-number paging by default; cursor paging hands back an opaque next cursor. */
  mode: 'page_number' | 'cursor';
  /** Where the next cursor sits in a cursor-paged response. */
  cursor_path: string | null;
  /** The cursor a fresh cursor traversal starts from; null starts without one. */
  initial_cursor: string | null;
}

/** The declared planner window of a time-windowed Source. */
export interface AcquisitionWindowPolicy {
  mode: 'fixed' | 'incremental';
  start_parameter: string;
  end_parameter: string;
  initial_start: string;
  /** The end of a fixed window; incremental windows capture their own upper bound. */
  initial_end: string | null;
  maximum_span_minutes: number;
  lookback_minutes: number;
  time_zone: string;
  end_inclusive: boolean;
}

/** The durable resume point of one Source: a watermark and, when relevant, a cursor. */
export interface AcquisitionCheckpointState {
  watermark: string | null;
  cursor: string | null;
  cursor_state: 'valid' | 'invalid';
  updated_at: string | null;
  generation: number;
}

/**
 * How often a scheduled Source reads and how late its Run may start.
 *
 * The tolerance is the promise the schedule makes: a Run that begins within it
 * started on time, and one that begins later is a measurably missed start.
 */
export interface ConnectionSchedule {
  every_minutes: number;
  start_tolerance_seconds: number;
}

/**
 * How quickly a Source's acquisition result must become current after the
 * instant its Run was due. The pair states two measurement points, so a
 * schedule is certified by the distribution it really produced.
 */
export interface ConnectionPublicationTargets {
  p95_seconds: number;
  p99_seconds: number;
}

/** One immutable Acquisition Connection Version: endpoint, auth scheme, and policy. */
export interface AcquisitionConnectionVersion {
  version: number;
  published_at: string;
  published_by: string;
  base_url: string;
  /** The name of this Version's stored credential, which its content hash pins. */
  credential_ref: string;
  /** The sealed credential itself; a later Version never rewrites this one's. */
  credential: SealedSecret | null;
  auth: ConnectionAuth;
  retry: ConnectionRetryPolicy;
  pacing: ConnectionPacingPolicy;
  pagination: ConnectionPagination;
  schedule: ConnectionSchedule | null;
  /** The publication latency the Connection promises; null when none is declared. */
  publication_targets: ConnectionPublicationTargets | null;
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
  /** The planner window this Source reads; null when it is read page by page only. */
  window: AcquisitionWindowPolicy | null;
  /** The response content type the endpoint must state; null keeps the connector's default. */
  content_type: string | null;
  content_hash: string;
}

/** A Source's acquisition configuration Artifact and the version it adopted. */
export interface SourceAcquisitionArtifact {
  source_id: string;
  workspace_id: string;
  owner_user_id: string;
  adopted_version: number | null;
  versions: SourceAcquisitionVersion[];
  /** The durable resume point a completed attempt advances and a failure leaves alone. */
  checkpoint: AcquisitionCheckpointState | null;
}

/** One page a Plan must complete, and what became of it. */
export interface AcquisitionPlanPage {
  page: number;
  /** The accepted fragment of this page; a replayed attempt replaces the rejected one. */
  raw_id: string | null;
  outcome: 'received' | 'empty' | 'failed';
  record_count: number | null;
  error_code: string | null;
  attempts: number;
  /** Rejected responses kept as diagnostics; they never enter an Integration Batch. */
  failed_attempts: Array<{
    raw_id: string | null;
    status: number | null;
    error_code: string;
    retry_after_ms: number | null;
  }>;
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
  /** The half-open window captured at plan time, so no later clock reading extends it. */
  window: AcquisitionPlanWindow | null;
  /** The cursor the first request starts from. */
  start_cursor: string | null;
  checkpoint_before: { watermark: string | null; cursor: string | null } | null;
  checkpoint_after: { watermark: string | null; cursor: string | null } | null;
  /** The last cursor the endpoint handed back, when it is the resume point. */
  end_cursor: string | null;
  status: 'planned' | 'complete' | 'partial' | 'failed';
  created_at: string;
  completed_at: string | null;
}

/** One immutable logical half-open interval one attempt reads. */
export interface AcquisitionPlanWindow {
  mode: 'fixed' | 'incremental' | 'backfill';
  start: string;
  end: string;
  lookback_minutes: number;
  end_inclusive: boolean;
  captured_at: string;
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
  /** Set when integration refused the Batch for drift; it never governs a Release. */
  quarantined_at: string | null;
  quarantine_error_code: string | null;
}

/** The durable authentication session one exact Connection Version established. */
export interface ConnectionSessionRecord {
  connection_id: string;
  workspace_id: string;
  connection_version: number;
  credential_ref: string;
  access_token: SealedSecret | null;
  cookie: { name: string; value: SealedSecret } | null;
  issued_at: string | null;
  expires_at: string | null;
  generation: number;
  state: 'active' | 'intervention_required';
  updated_at: string;
}

/** One Connection's durable FIFO admission queue and its request history. */
export interface ConnectionPacingRecord {
  connection_id: string;
  workspace_id: string;
  queue: Array<{
    acquisition_run_id: string;
    source_id: string;
    enqueued_at: string;
    not_before: string | null;
  }>;
  active: Array<{ acquisition_run_id: string; source_id: string; started_at: string }>;
  last_finished_at: string | null;
  requests: string[];
  updated_at: string;
}

/** One canonical record; the values are already cleaned and type-coerced. */
export interface DatasetRecordRow {
  identity: string;
  values: Record<string, string | number | null>;
  /**
   * The Raw Acquisition this record was read from, and its locator inside it.
   * A tabular record carries none; a curated document always names both.
   */
  raw?: { raw_id: string; locator: string };
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
  /** The parser and resource envelope this Release ran, when it curates documents. */
  document_processing?: DocumentProcessingRecord;
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
  /**
   * The Business Context Metric Definition this metric binds. When stated, the
   * approved definition governs the metric's formula, unit, and value type, and
   * supplies its favourable direction.
   */
  definition?: string;
  /** The dimensions this metric may be grouped by; absent permits every declared dimension. */
  dimensions?: string[];
}

/** The time field a Contract resolves windows against and the precision it declares. */
export interface DataProductTime {
  field: string;
  precision: 'date' | 'timestamp';
  time_zone: string;
  /**
   * The Business Context definition the business time zone is approved by.
   * When stated, the Contract's zone must be exactly the approved value.
   */
  definition?: string;
}

/** The natural period a comparison window names, so a partial period is labelled. */
export type DataProductPeriod = 'day' | 'week';

/** How a Document Contract ranks the documents one search matches. */
export interface DataProductSearchRanking {
  kind: 'weighted_term_frequency';
  title_weight: number;
  text_weight: number;
}

/**
 * The search capability a Document Contract declares: which field carries the
 * extracted text, where a title weight applies, which fields suggest terms, and
 * the ranking it returns. A Contract that declares none cannot be searched.
 */
export interface DataProductSearch {
  text_field: string;
  title_field?: string;
  suggest_fields: string[];
  ranking: DataProductSearchRanking;
  /** How many distinct terms one query may state. */
  max_terms: number;
  /** The shortest term the index keeps. */
  min_term_length: number;
}

/** The resource envelope one Data Product Query may consume. */
export interface DataProductQueryLimits {
  max_scanned_records: number;
  max_groups: number;
  max_execution_ms: number;
}

/**
 * One declared link from a Contract's own record grain to another Dataset of the
 * same Workspace. Its cardinality says whether one base record reaches at most
 * one related record or several, and its own grain says what one linked record
 * is — so a link can be read without fanning metrics out.
 */
export interface DataProductRelationship {
  /** The name a Consumer includes and a Grant permits columns of. */
  name: string;
  description?: string;
  cardinality: 'one' | 'many';
  /** Published base-side fields, each mapped to the related Dataset Schema field it equals. */
  on: Record<string, string>;
  /** The related Dataset Schema fields this link publishes. */
  fields: Array<{ name: string; description?: string }>;
  /** The related Dataset Schema fields that identify exactly one linked record. */
  grain: string[];
  /** The related fields a Consumer may filter the linked records by. */
  filters: string[];
  /** The most linked records one base record returns from a many relationship. */
  limit: number;
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
  /** The search capability this Contract declares; absent means it cannot be searched. */
  search?: DataProductSearch;
  /**
   * The other Datasets this Contract links to its own records. A Contract that
   * declares none publishes one Dataset and can link to nothing.
   */
  relationships?: DataProductRelationship[];
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
  /** The member whose reads this Grant narrows; null when it names an Agent Identity. */
  grantee_user_id: string | null;
  /** The Agent Identity whose reads this Grant narrows; absent on a member's Grant. */
  grantee_agent_identity_id?: string | null;
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
  /** The row predicates the export was produced under, so a narrower Grant refuses it. */
  row_filters: GrantRowFilter[];
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
  /**
   * The exact Dataset Release each declared relationship was bound to, so a
   * linked record is reproducible under the Release rather than the latest data.
   */
  relationships?: Array<{ name: string; dataset_id: string; dataset_release: number }>;
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

/** The latest Batch a Source has handed to integration, skipping quarantined ones. */
export function latestIntegrationBatch(
  batches: IntegrationBatchRecord[],
  sourceId: string,
): IntegrationBatchRecord | undefined {
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index];
    if (batch?.source_id === sourceId && batch.quarantined_at === null) return batch;
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

/** The Grants still in force for one member on one Data Product. */
export function activeGrants(
  grants: DataProductGrantRecord[],
  dataProductId: string,
  granteeUserId: string,
): DataProductGrantRecord[] {
  return grants.filter(
    (grant) => grant.data_product_id === dataProductId
      && grant.grantee_user_id === granteeUserId
      && grant.revoked_at === null,
  );
}

/** The Grants still in force for one Agent Identity on one Data Product. */
export function activeAgentGrants(
  grants: DataProductGrantRecord[],
  dataProductId: string,
  agentIdentityId: string,
): DataProductGrantRecord[] {
  return grants.filter(
    (grant) => grant.data_product_id === dataProductId
      && grant.grantee_agent_identity_id === agentIdentityId
      && grant.revoked_at === null,
  );
}

// ---------------------------------------------------------------------------
// Reports and QA stock: Report Templates and immutable stocked Reports.
// ---------------------------------------------------------------------------

/** The typed values one Report Template parameter may pin. */
export type ReportParameterType = 'date_window' | 'date' | 'integer' | 'string';

/** The bounded window a `date_window` parameter pins. */
export interface ReportDateWindow {
  start: string;
  end: string;
}

/** One typed parameter a Report Template pins, and the value this Version fixes. */
export interface ReportParameter {
  name: string;
  type: ReportParameterType;
  value: string | number | ReportDateWindow;
}

/** How old a stocked Report may be before it must be regenerated. */
export interface ReportFreshnessPolicy {
  max_age_minutes: number;
}

/** The grounded-answer prompt an exact Template Version pins for Report prose. */
export interface ReportGroundedPrompt {
  id: 'grounded_answer';
  body: string;
  hash: string;
}

/**
 * One immutable Report Template Version: the normalized question semantics, the
 * typed parameters, the normalized Data Product Query, the grounded-answer
 * prompt, and the freshness policy that every Report generated from it pins.
 */
export interface ReportTemplateVersion {
  version: number;
  published_at: string;
  published_by: string;
  question: string;
  normalized_question: string;
  /** The deterministic Chinese description of the pinned query semantics. */
  interpretation: string;
  parameters: ReportParameter[];
  data_product_id: string;
  /** The Contract line this Version pins its semantics to. */
  contract_major: number;
  /** The normalized Data Product Query, including its pinned major line and limit. */
  request: Record<string, unknown>;
  grounded_prompt: ReportGroundedPrompt;
  freshness_policy: ReportFreshnessPolicy;
  content_hash: string;
  /** The lifecycle fact withdrawing this exact Version from future generation. */
  withdrawn_at: string | null;
  withdrawn_by: string | null;
}

/** A Workspace Artifact holding the Template Versions and the published one. */
export interface ReportTemplateArtifact {
  report_template_id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  published_version: number | null;
  versions: ReportTemplateVersion[];
}

/** The exact Template a Report was generated from. */
export interface ReportTemplateReference {
  report_template_id: string;
  name: string;
  version: number;
  content_hash: string;
  owner_user_id: string;
}

/** The exact Data Product Releases a Report pins. */
export interface ReportProductReference {
  data_product_id: string;
  name: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_version: DataProductContractVersion;
  contract_hash: string;
}

/** The authorization scope a Report was generated under, and is reauthorized against. */
export interface ReportSecurityContext {
  scope_fingerprint: string;
  restricted: boolean;
  columns: string[];
  row_filter_count: number;
}

/** How complete the governed answer a Report stores really is. */
export interface ReportCompletion {
  status: 'complete' | 'incomplete';
  outcome: 'answered' | 'empty' | 'no_evidence';
  partial_period: boolean;
  truncated: boolean;
  limitations: string[];
}

/** The optional grounded narrative a Report stores beside its structured result. */
export interface ReportNarrative {
  narrative: string;
  evidence_refs: Array<Record<string, unknown>>;
  grounded_answer_prompt_hash: string;
  prompt_hash: string;
  model: Record<string, unknown>;
}

/**
 * One immutable stored answer generated from an exact Report Template Version
 * and exact Data Product Releases. Retrieving it never regenerates its content.
 */
export interface ReportRecord {
  report_id: string;
  workspace_id: string;
  template: ReportTemplateReference;
  data_product: ReportProductReference;
  question: string;
  normalized_question: string;
  parameters: ReportParameter[];
  interpretation: string;
  query: Record<string, unknown>;
  result: Record<string, unknown>;
  narrative: ReportNarrative | null;
  provenance: Record<string, unknown>;
  freshness: Record<string, unknown> | null;
  completion: ReportCompletion;
  security: ReportSecurityContext;
  freshness_policy: ReportFreshnessPolicy;
  generated_at: string;
  generated_by: string;
  /** The lifecycle fact withdrawing this exact Report from stock and retrieval. */
  withdrawn_at: string | null;
  withdrawn_by: string | null;
}

// ---------------------------------------------------------------------------
// QA stock review: deduplicated administrator review of unmatched answers.
// ---------------------------------------------------------------------------

/** The settled local embedding configuration similarity nomination runs under. */
export interface ReviewEmbeddingConfiguration {
  model_id: string;
  revision: string;
  dimensions: number;
  normalization: string;
  metric: string;
}

/** One QA pair a candidate is nominated against, never declared equivalent. */
export interface ReviewSimilarityNomination {
  kind: 'report_template' | 'review_candidate';
  target_id: string;
  question: string;
  /** The cosine score under the settled local embedding configuration. */
  score: number;
}

/** The one durable notification an open review item sent its reviewer. */
export interface ReportCandidateNotification {
  notified_at: string;
  reason: 'created' | 'reopened';
}

/** One Workspace Administrator decision on one exact review candidate. */
export interface ReportCandidateDecision {
  decided_at: string;
  decided_by: string;
  reason: string | null;
}

/** How a review candidate currently stands. */
export type ReportCandidateStatus = 'open' | 'approved' | 'rejected';

/**
 * One deduplicated administrator review item for one unmatched business
 * question. It names the exact draft Template Version and exact immutable
 * Report a human reviews, so Approval can publish both without regenerating.
 */
export interface ReportCandidateRecord {
  candidate_id: string;
  workspace_id: string;
  status: ReportCandidateStatus;
  question: string;
  normalized_question: string;
  /** The content address of the normalized semantics this item is keyed by. */
  semantic_hash: string;
  data_product_id: string;
  report_template_id: string;
  template_version: number;
  report_id: string;
  /** How many times these normalized semantics arrived while this item existed. */
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  requested_by: string[];
  similarity: {
    configuration: ReviewEmbeddingConfiguration;
    threshold: number;
    nominations: ReviewSimilarityNomination[];
  };
  notification: ReportCandidateNotification | null;
  approval: ReportCandidateDecision | null;
  rejection: ReportCandidateDecision | null;
}

// ---------------------------------------------------------------------------
// Report schedules: durable facts evaluated by an explicit tick.
// ---------------------------------------------------------------------------

/** One evaluation of one due Report schedule, coalescing every due instant. */
export interface ReportScheduleRunRecord {
  run_id: string;
  schedule_id: string;
  template_version: number;
  /** The tick instant that evaluated the schedule. */
  triggered_at: string;
  /** The first schedule instant this run covers. */
  due_from: string;
  /** How many schedule instants were coalesced into this one run. */
  due_count: number;
  /** Whether more than one due instant was coalesced (a catch-up). */
  catch_up: boolean;
  designated_user_id: string;
  outcome: 'generated' | 'reused' | 'failed';
  report_id: string | null;
  reason_code: string | null;
  limitation: string | null;
  scope_fingerprint: string | null;
}

/**
 * One durable schedule on one published Report Template Version. The tick
 * revalidates the designated Consumer and its Grants on every run, never
 * remembering an earlier authorization.
 */
export interface ReportScheduleRecord {
  schedule_id: string;
  workspace_id: string;
  report_template_id: string;
  template_version: number;
  designated_user_id: string;
  interval_minutes: number;
  next_due_at: string;
  created_at: string;
  created_by: string;
  withdrawn_at: string | null;
  runs: ReportScheduleRunRecord[];
}

// ---------------------------------------------------------------------------
// Governed generation: Model Profiles, Workspace Model Bindings, and Proposals.
// ---------------------------------------------------------------------------

/** How a Model Profile Version speaks to its administrator-supplied endpoint. */
export type ModelAdapterKind = 'hosted' | 'generic_local';

/** The generation purposes a Model Profile Version supports. */
export type ModelPurpose =
  | 'integration_proposal'
  | 'data_product_proposal'
  | 'scraper_repair'
  | 'grounded_narration'
  | 'clarification'
  | 'query_plan';

/**
 * The data categories a Model Profile Version may receive for a purpose.
 * `scraper_diagnostics` covers the sanitized failure diagnostics and the
 * versioned fixture pages a Scraper Service repair is given.
 */
export type ModelDataCategory =
  | 'dataset_schema'
  | 'cleaning_rules'
  | 'source_mapping'
  | 'sample_records'
  | 'product_contract'
  | 'scraper_diagnostics';

/** One prompt an exact Model Profile Version pins for one purpose. */
export interface ModelPrompt {
  id: ModelPurpose;
  body: string;
  hash: string;
}

/** One gate an activation evaluation, or a Binding preflight, reports on. */
export interface ModelProfileCheck {
  name: string;
  passed: boolean;
  detail: string | null;
}

/**
 * The activation evidence one exact Model Profile Version produced. A Deployment
 * Administrator evaluates a Version; the Version cannot activate without it.
 */
export interface ModelProfileEvaluation {
  model_profile_version: number;
  model_profile_content_hash: string;
  evaluated_at: string;
  evaluated_by: string;
  adapter: ModelAdapterKind;
  model_id: string;
  passed: boolean;
  checks: ModelProfileCheck[];
  evidence_hash: string;
}

/** One immutable Model Profile Version: endpoint, contract, credential, and prompts. */
export interface ModelProfileVersion {
  version: number;
  published_at: string;
  published_by: string;
  adapter: ModelAdapterKind;
  /** The administrator-supplied endpoint this Version may call, and only it. */
  endpoint_url: string;
  model_id: string;
  /** The name of this Version's stored credential, which its content hash pins. */
  credential_ref: string;
  /** The sealed credential itself; a later Version never rewrites this one's. */
  credential: SealedSecret | null;
  purposes: ModelPurpose[];
  data_categories: ModelDataCategory[];
  /** The declarative tools this Version may expose; nothing else exists. */
  tools: string[];
  max_output_bytes: number;
  prompts: ModelPrompt[];
  content_hash: string;
}

/** A Deployment Artifact holding the Model Profile Versions and the activated one. */
export interface ModelProfileArtifact {
  model_profile_id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  activated_version: number | null;
  activated_at: string | null;
  versions: ModelProfileVersion[];
  /** Append-only activation evidence, always naming the exact Version it judged. */
  evaluations: ModelProfileEvaluation[];
}

/** The preflight evidence a Workspace Model Binding was created under. */
export interface ModelBindingPreflight {
  checked_at: string;
  passed: boolean;
  checks: ModelProfileCheck[];
  evidence_hash: string;
}

/**
 * A Workspace-scoped reference enabling one exact Model Profile Version for a
 * permitted purpose and data-category set. It carries no endpoint and no
 * credential, so resolving it never discloses provider settings.
 */
export interface WorkspaceModelBindingRecord {
  binding_id: string;
  workspace_id: string;
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  purposes: ModelPurpose[];
  data_categories: ModelDataCategory[];
  preflight: ModelBindingPreflight;
  created_at: string;
  created_by: string;
  created_by_user_id: string;
  revoked_at: string | null;
}

/** The Artifact Versions one Proposal was generated against. */
export interface ProposalBase {
  integration_configuration_version: number | null;
  integration_configuration_content_hash: string | null;
}

/** The exact model, prompt, and Binding one Proposal was generated under. */
export interface ProposalModelPin {
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  adapter: ModelAdapterKind;
  model_id: string;
  prompt_id: ModelPurpose;
  prompt_hash: string;
}

/** What the generated change was derived from, and how much of it there was. */
export interface ProposalEvidence {
  data_dictionary_hash: string;
  data_dictionary_fields: string[];
  field_count: number;
}

/**
 * The candidate Artifact Versions one Proposal groups. The schema, cleaning, and
 * mapping candidates are the components of the composite Integration
 * Configuration candidate, so Approval covers all of them or none.
 */
export interface ProposalCandidates {
  schema: { candidate_version: number; fields: DatasetSchemaField[]; hash: string };
  cleaning: { candidate_version: number; rules: CleaningRule[]; hash: string };
  mapping: { candidate_version: number; mapping: Record<string, string>; hash: string };
  integration_configuration: {
    version: number;
    identity_fields: string[];
    schema_hash: string;
    cleaning_hash: string;
    mapping_hash: string;
    content_hash: string;
  };
}

/** One value a cleaning rule changed while a candidate was exercised. */
export interface ProposalTransformation {
  raw_id: string;
  row: number;
  field: string;
  rule: CleaningRuleName;
  before: string;
  after: string;
}

/** What a candidate would change relative to its base and to a real source table. */
export interface ProposalDrift {
  base_present: boolean;
  schema: {
    added: string[];
    removed: string[];
    retyped: Array<{ field: string; from: DatasetFieldType; to: DatasetFieldType }>;
  };
  cleaning: { added: string[]; removed: string[] };
  mapping: {
    added: string[];
    removed: string[];
    retargeted: Array<{ column: string; from: string; to: string }>;
  };
  /** How a real raw table lines up with the candidate mapping. */
  raw_columns: { unmapped: string[]; missing: string[] };
}

/** The evidence one deterministic validation run produced for one Proposal. */
export interface ProposalValidationRecord {
  validated_at: string;
  validated_by: string;
  fixtures: Array<{
    name: string;
    header: string[];
    record_count: number;
    transformed: number;
    rejected: number;
    transformations: ProposalTransformation[];
    rejections: RecordRejection[];
    drift: ProposalDrift;
  }>;
  evidence_hash: string;
}

/** The evidence one isolated preview of a real Raw Acquisition produced. */
export interface ProposalPreviewRecord {
  previewed_at: string;
  previewed_by: string;
  raw_id: string;
  acquisition_run_id: string;
  record_count: number;
  transformed: number;
  rejected: number;
  records_hash: string;
  transformations: ProposalTransformation[];
  rejections: RecordRejection[];
  drift: ProposalDrift;
  evidence_hash: string;
}

/** The lineage every Approval, Publication, and Adoption restates. */
export interface ProposalProvenance {
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  adapter: ModelAdapterKind;
  model_id: string;
  binding_id: string;
  prompt_id: ModelPurpose;
  prompt_hash: string;
  /** Present only when the Proposal was generated from an administrator requirement. */
  requirement_hash?: string;
  data_dictionary_hash: string;
  validation_hash: string;
  preview_hash: string;
  candidate_content_hash: string;
  proposal_hash: string;
}

/** One Workspace Administrator decision on one exact Proposal. */
export interface ProposalDecisionRecord {
  decided_at: string;
  decided_by: string;
  actor: string;
  outcome: 'approved' | 'rejected';
  reason: string | null;
  model: ProposalModelPin;
  evidence_hash: string;
  provenance: ProposalProvenance;
}

/** The lifecycle fact making the approved candidate available for Adoption. */
export interface ProposalPublicationRecord {
  published_at: string;
  published_by: string;
  actor: string;
  integration_configuration_version: number;
  model: ProposalModelPin;
  evidence_hash: string;
  provenance: ProposalProvenance;
}

/** The lifecycle fact binding the Source to the published candidate. */
export interface ProposalAdoptionRecord {
  adopted_at: string;
  adopted_by: string;
  actor: string;
  integration_configuration_version: number;
  previous_adopted_version: number | null;
  model: ProposalModelPin;
  evidence_hash: string;
  provenance: ProposalProvenance;
}

/**
 * The Chinese requirement that asked for one integration change, the
 * clarifications that completed it, and their common content address.
 */
export interface IntegrationProposalRequirement {
  text: string;
  clarifications: RequirementClarification[];
  hash: string;
}

/**
 * One immutable review unit for one logical generated change, grouping the exact
 * candidate Artifact Versions and their evidence for all-or-nothing Approval.
 */
export interface IntegrationProposalRecord {
  /** Discriminates the Proposal kinds one collection holds; absent reads as integration. */
  kind?: 'integration';
  proposal_id: string;
  workspace_id: string;
  source_id: string;
  created_at: string;
  created_by: string;
  created_by_user_id: string;
  binding_id: string;
  /** The requirement the change was asked for, when one was stated in the browser. */
  requirement?: IntegrationProposalRequirement;
  base: ProposalBase;
  model: ProposalModelPin;
  evidence: ProposalEvidence;
  candidates: ProposalCandidates;
  /** The content address of everything above; a mismatched record is refused. */
  proposal_hash: string;
  validations: ProposalValidationRecord[];
  previews: ProposalPreviewRecord[];
  decisions: ProposalDecisionRecord[];
  publications: ProposalPublicationRecord[];
  adoptions: ProposalAdoptionRecord[];
}

/** The Dataset Release and Business Context facts a Data Product Proposal was generated against. */
export interface DataProductProposalBase {
  dataset_id: string;
  dataset_release: number;
  dataset_records_hash: string;
  dataset_schema_hash: string;
  common_business_context_version: number;
  common_business_context_content_hash: string;
  workspace_business_context_version: number;
  workspace_business_context_content_hash: string;
  data_product_id: string | null;
  data_product_version: number | null;
  data_product_contract_hash: string | null;
}

/** One administrator clarification that completed a requirement before generation. */
export interface RequirementClarification {
  question: string;
  answer: string;
}

/** The natural-language requirement, its clarifications, and their content address. */
export interface DataProductRequirement {
  text: string;
  clarifications: RequirementClarification[];
  hash: string;
}

/** What the generated Contract was allowed to draw on, and how much of it there was. */
export interface DataProductProposalEvidence {
  requirement_hash: string;
  dataset_release_hash: string;
  schema_fields: string[];
  field_count: number;
  metric_definition_keys: string[];
  business_context_hash: string;
}

/** The one candidate Data Product a Proposal submits for all-or-nothing Approval. */
export interface DataProductProposalCandidates {
  name: string;
  contract: DataProductContract;
  contract_hash: string;
  content_hash: string;
}

/** The evidence one deterministic validation run produced for one Data Product Proposal. */
export interface DataProductProposalValidationRecord {
  validated_at: string;
  validated_by: string;
  dataset_release: number;
  contract_hash: string;
  metric_definition_keys: string[];
  checks: string[];
  evidence_hash: string;
}

/** The evidence one isolated preview of the real Dataset Release produced. */
export interface DataProductProposalPreviewRecord {
  previewed_at: string;
  previewed_by: string;
  dataset_release: number;
  contract_hash: string;
  api_shape: Record<string, unknown>;
  example_queries: Array<Record<string, unknown>>;
  representative_results: Array<Record<string, unknown>>;
  freshness: Record<string, unknown>;
  provenance: Record<string, unknown>;
  narrative: Record<string, unknown>;
  evidence_hash: string;
}

/** The lineage every Data Product Approval and Publication restates. */
export interface DataProductProposalProvenance {
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  adapter: ModelAdapterKind;
  model_id: string;
  binding_id: string;
  prompt_id: ModelPurpose;
  prompt_hash: string;
  requirement_hash: string;
  validation_hash: string;
  preview_hash: string;
  candidate_content_hash: string;
  proposal_hash: string;
}

/** One Workspace Administrator decision on one exact Data Product Proposal. */
export interface DataProductProposalDecisionRecord {
  decided_at: string;
  decided_by: string;
  actor: string;
  outcome: 'approved' | 'rejected';
  reason: string | null;
  model: ProposalModelPin;
  evidence_hash: string;
  provenance: DataProductProposalProvenance;
}

/** The lifecycle fact making the approved Data Product available to Consumers. */
export interface DataProductProposalPublicationRecord {
  published_at: string;
  published_by: string;
  actor: string;
  data_product_id: string;
  data_product_version: number;
  data_product_release: number;
  contract_hash: string;
  model: ProposalModelPin;
  evidence_hash: string;
  provenance: DataProductProposalProvenance;
}

/** One immutable review unit for one generated Data Product Contract. */
export interface DataProductProposalRecord {
  kind: 'data_product';
  proposal_id: string;
  workspace_id: string;
  source_id: string;
  dataset_id: string;
  created_at: string;
  created_by: string;
  created_by_user_id: string;
  binding_id: string;
  requirement: DataProductRequirement;
  base: DataProductProposalBase;
  model: ProposalModelPin;
  evidence: DataProductProposalEvidence;
  candidates: DataProductProposalCandidates;
  proposal_hash: string;
  validations: DataProductProposalValidationRecord[];
  previews: DataProductProposalPreviewRecord[];
  decisions: DataProductProposalDecisionRecord[];
  publications: DataProductProposalPublicationRecord[];
}

// ---------------------------------------------------------------------------
// Scraping: Scraper Tasks, Scraper Services, and the Runs that reuse them.
// ---------------------------------------------------------------------------

/** The one declarative scraper engine this release ships, pinned by every Service Version. */
export const DECLARATIVE_SCRAPER_ENGINE = { name: 'declarative-scraper', version: 1 } as const;

/**
 * The approved network scope of one Scraper Service: the exact origins and path
 * prefixes it may reach. Every request, fixture, and live verification is
 * checked against it, so a compiled candidate cannot widen its own reach.
 */
export interface ScraperNetworkScope {
  origins: string[];
  paths: string[];
}

/** Where one scraped page lives and how the page sequence is asked for. */
export interface ScraperTarget {
  /** The one endpoint origin the pages are read from. */
  base_url: string;
  /** A path template; `{parameter}` placeholders are filled from run parameters. */
  path: string;
  /** The query parameter that carries the page number; null reads one page only. */
  page_parameter: string | null;
  first_page: number;
  page_size: number | null;
  page_size_parameter: string | null;
  /** The most pages one attempt may read; reaching it with records left fails. */
  max_pages: number;
}

/** One output column and the element inside a record that carries its value. */
export interface ScraperOutputField {
  name: string;
  /** `element`, `element.class`, or `element.class@attribute`. */
  selector: string;
}

/** The logical output one Scraper Service returns: records and their columns. */
export interface ScraperOutput {
  /** The element that delimits one record, such as `tr.row`. */
  record_selector: string;
  fields: ScraperOutputField[];
}

/** One declared run parameter, never a value captured from the target. */
export interface ScraperParameter {
  name: string;
  type: 'string' | 'integer';
  required: boolean;
  default: string | null;
}

/** The operational constraints one attempt is held to. */
export interface ScraperConstraints {
  timeout_ms: number;
  max_bytes: number;
  max_records: number;
}

/** One versioned fixture page: a frozen response and the output it must produce. */
export interface ScraperFixturePage {
  name: string;
  /** The path the page answers, checked against the approved network scope. */
  path: string;
  content_type: string;
  body: string;
  expected_record_count: number;
  /** The exact records the page must extract, when the fixture states them. */
  expected_records?: Array<Record<string, string>>;
}

/** The fixtures one Scraper Task Version pins, so validation needs no live target. */
export interface ScraperFixtureSet {
  version: number;
  pages: ScraperFixturePage[];
}

/** One immutable Scraper Task Version: every fact compilation draws on. */
export interface ScraperTaskVersion {
  version: number;
  published_at: string;
  published_by: string;
  target: ScraperTarget;
  network_scope: ScraperNetworkScope;
  output: ScraperOutput;
  parameters: ScraperParameter[];
  fixtures: ScraperFixtureSet;
  constraints: ScraperConstraints;
  /** Names of stored credentials, never their values. */
  credential_refs: string[];
  fixtures_hash: string;
  content_hash: string;
}

/** A versioned Workspace Artifact from which Scraper Services are compiled. */
export interface ScraperTaskArtifact {
  scraper_task_id: string;
  workspace_id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  versions: ScraperTaskVersion[];
}

/** Everything a published Scraper Service Version carries; no secret is among it. */
export interface ScraperServiceContent {
  engine: { name: 'declarative-scraper'; version: 1 };
  target: ScraperTarget;
  network_scope: ScraperNetworkScope;
  output: ScraperOutput;
  parameters: ScraperParameter[];
  constraints: ScraperConstraints;
  credential_refs: string[];
  /** The exact Scraper Task Version this Service was compiled from. */
  source_task: { version: number; content_hash: string };
  fixtures: { version: number; hash: string };
}

/** One immutable published Scraper Service Version, ready for repeated Runs. */
export interface ScraperServiceVersion {
  version: number;
  published_at: string;
  published_by: string;
  content: ScraperServiceContent;
  content_hash: string;
  /** Set when the Version may no longer execute, while its history stays readable. */
  withdrawn_at: string | null;
}

/** The Scraper Service Artifact one Scraper Task compiles into. */
export interface ScraperServiceArtifact {
  scraper_service_id: string;
  workspace_id: string;
  scraper_task_id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  versions: ScraperServiceVersion[];
}

/** The exact published Scraper Service Version one Source pins through Source Adoption. */
export interface SourceScraperServiceRecord {
  source_id: string;
  workspace_id: string;
  scraper_service_id: string;
  adopted_version: number;
  content_hash: string;
  proposal_id: string;
  adopted_at: string;
  adopted_by: string;
}

/** One stored credential reference a Scraper Service may present; the value is sealed. */
export interface ScraperCredentialRecord {
  ref: string;
  workspace_id: string;
  location: 'bearer' | 'cookie';
  cookie_name: string | null;
  sealed: SealedSecret;
  created_at: string;
  created_by: string;
}

/** One structured, sanitized diagnostic a scraping attempt produced. */
export interface ScraperDiagnostic {
  code: string;
  page: number | null;
  message: string;
}

/** What one scraped page produced, and the response it was read from. */
export interface ScraperManifestPage {
  page: number;
  url: string;
  status: number;
  response_hash: string;
  response_bytes: number;
  raw_id: string | null;
  record_count: number;
}

/**
 * The manifest and diagnostics one scraping attempt returns alongside its Raw
 * Acquisitions. It never holds a credential value or a request header.
 */
export interface ScraperRunManifest {
  manifest_id: string;
  workspace_id: string;
  source_id: string;
  acquisition_run_id: string;
  scraper_service_id: string;
  scraper_service_version: number;
  scraper_service_content_hash: string;
  scraper_task_id: string;
  scraper_task_version: number;
  scraper_task_content_hash: string;
  engine: { name: 'declarative-scraper'; version: 1 };
  /** The resolved run parameters the attempt was held to. */
  parameters: Record<string, string>;
  pages: ScraperManifestPage[];
  record_count: number;
  diagnostics: ScraperDiagnostic[];
  started_at: string;
  completed_at: string | null;
  status: 'running' | 'complete' | 'failed';
}

/** The pipeline stage one scraper diagnostic was raised in. */
export type ScraperDiagnosticStage = 'request' | 'transport' | 'page' | 'extraction' | 'sequence' | 'attempt';

/** The governed category one scraper diagnostic belongs to. */
export type ScraperDiagnosticCategory =
  | 'network_scope'
  | 'target_unresolved'
  | 'request_failed'
  | 'http_status'
  | 'content_type'
  | 'page_too_large'
  | 'record_limit'
  | 'page_limit'
  | 'field_missing'
  | 'unknown';

/**
 * The request evidence one diagnostic carries: the address that was read, the
 * header names it presented, and the credential references it resolved. A value
 * is never among them.
 */
export interface ScraperEvidenceRequest {
  method: 'GET';
  url: string;
  header_names: string[];
  credential_refs: string[];
}

/** The sanitized page evidence one diagnostic carries: no credential value, one bounded excerpt. */
export interface ScraperEvidencePage {
  status: number | null;
  content_type: string | null;
  response_hash: string | null;
  response_bytes: number | null;
  body_excerpt: string | null;
  excerpt_truncated: boolean;
}

/** One immutable Raw Acquisition a failed attempt kept, named only by reference. */
export interface ScraperEvidenceRawRef {
  raw_id: string;
  content_hash: string;
  byte_length: number;
}

/** One sanitized diagnostic: stage, category, request and page evidence, raw references. */
export interface ScraperFailureDiagnostic {
  code: string;
  stage: ScraperDiagnosticStage;
  category: ScraperDiagnosticCategory;
  page: number | null;
  message: string;
  request: ScraperEvidenceRequest;
  page_evidence: ScraperEvidencePage;
  raw_refs: ScraperEvidenceRawRef[];
}

/**
 * One immutable failure diagnosis. It names the exact Task and Service Versions,
 * engine, and fixtures that governed the failing attempt, so a repair is
 * generated against facts rather than a reconstructed guess.
 */
export interface ScraperDiagnosticsRecord {
  diagnostics_id: string;
  workspace_id: string;
  source_id: string | null;
  mode: 'run' | 'verification';
  acquisition_run_id: string | null;
  manifest_id: string | null;
  proposal_id: string | null;
  recorded_at: string;
  recorded_by: string;
  failure_code: string;
  stage: ScraperDiagnosticStage;
  category: ScraperDiagnosticCategory;
  engine: { name: 'declarative-scraper'; version: 1 };
  scraper_task_id: string;
  scraper_task_version: number;
  scraper_task_content_hash: string;
  scraper_service_id: string;
  scraper_service_version: number;
  scraper_service_content_hash: string;
  fixtures_version: number;
  fixtures_hash: string;
  /** The resolved run parameters the failing attempt was held to. */
  parameters: Record<string, string>;
  diagnostics: ScraperFailureDiagnostic[];
  raw_refs: ScraperEvidenceRawRef[];
  evidence_hash: string;
}

/** The Scraper Service Versions a Proposal was compiled against. */
export interface ScraperProposalBase {
  scraper_service_id: string | null;
  scraper_service_version: number | null;
  scraper_service_content_hash: string | null;
}

/** What the compiled Service was derived from, and how much of it there was. */
export interface ScraperProposalEvidence {
  task_hash: string;
  fixtures_version: number;
  fixtures_hash: string;
  output_fields: string[];
  network_scope: ScraperNetworkScope;
  /**
   * The fixture pages a repair adds beside the retained base fixtures. A
   * compiled candidate adds none, so its Approval covers existing fixtures only.
   */
  regression_fixtures: string[];
}

/** The one candidate Scraper Service a Proposal submits for all-or-nothing Approval. */
export interface ScraperProposalCandidates {
  service: ScraperServiceContent;
  content_hash: string;
}

/** The exact immutable Model Profile Version one repair candidate was generated under. */
export interface ScraperRepairModelPin {
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  adapter: ModelAdapterKind;
  model_id: string;
  binding_id: string;
  prompt_id: 'scraper_repair';
  prompt_hash: string;
}

/**
 * What one repair addresses: the published base it repairs, the exact failure
 * diagnosis it was generated from, and the isolated model call that produced it.
 * A Proposal generated by ordinary compilation carries no repair at all.
 */
export interface ScraperRepairRecord {
  base_service_version: number | null;
  base_service_content_hash: string | null;
  base_task_version: number;
  base_task_content_hash: string;
  diagnostics_id: string;
  failure_evidence_hash: string;
  failure_code: string;
  failure_stage: ScraperDiagnosticStage;
  failure_category: ScraperDiagnosticCategory;
  model: ScraperRepairModelPin;
  /** The content address of the exact isolated input the model received. */
  input_hash: string;
}

/** The repair lineage every Approval, Publication, verification, and Adoption restates. */
export interface ScraperRepairProvenance {
  base_service_version: number | null;
  base_service_content_hash: string | null;
  base_task_version: number;
  base_task_content_hash: string;
  diagnostics_id: string;
  failure_evidence_hash: string;
  failure_code: string;
  input_hash: string;
  model: ScraperRepairModelPin;
}

/** One deterministic check the validation evidence reports on. */
export interface ScraperValidationCheck {
  name: string;
  passed: boolean;
  detail: string | null;
}

/** What one versioned fixture page produced while validating. */
export interface ScraperValidationFixture {
  name: string;
  path: string;
  record_count: number;
  expected_record_count: number;
  records_hash: string;
  body_hash: string;
}

/** The evidence one deterministic validation run against the pinned fixtures produced. */
export interface ScraperValidationRecord {
  validated_at: string;
  validated_by: string;
  checks: ScraperValidationCheck[];
  fixtures: ScraperValidationFixture[];
  passed: boolean;
  evidence_hash: string;
}

/**
 * The evidence one isolated live verification produced. It is recorded only
 * after Approval and Publication, and it integrates nothing.
 */
export interface ScraperVerificationRecord {
  verified_at: string;
  verified_by: string;
  scraper_service_version: number;
  scraper_service_content_hash: string;
  passed: boolean;
  pages: ScraperManifestPage[];
  record_count: number;
  diagnostics: ScraperDiagnostic[];
  evidence_hash: string;
}

/** What one versioned fixture page produced during an isolated preview. */
export interface ScraperPreviewFixture {
  name: string;
  path: string;
  record_count: number;
  expected_record_count: number;
  /** Whether the extracted records are exactly the ones the fixture pins. */
  matches: boolean;
  /** The extracted records, bounded for display; `record_count` stays exact. */
  records: Array<Record<string, string>>;
  records_hash: string;
}

/** The evidence one isolated fixture preview produced before Approval. */
export interface ScraperPreviewRecord {
  previewed_at: string;
  previewed_by: string;
  fixtures: ScraperPreviewFixture[];
  passed: boolean;
  evidence_hash: string;
}

/** The lineage every Approval, Publication, verification, and Adoption restates. */
export interface ScraperProposalProvenance {
  engine: { name: 'declarative-scraper'; version: 1 };
  scraper_task_id: string;
  scraper_task_version: number;
  scraper_task_content_hash: string;
  fixtures_hash: string;
  validation_hash: string;
  preview_hash: string;
  verification_hash: string;
  candidate_content_hash: string;
  proposal_hash: string;
  /** The repair this Proposal carries, or null when it was compiled normally. */
  repair: ScraperRepairProvenance | null;
}

/** One Workspace Administrator decision on one exact Scraper Proposal. */
export interface ScraperDecisionRecord {
  decided_at: string;
  decided_by: string;
  actor: string;
  outcome: 'approved' | 'rejected';
  reason: string | null;
  evidence_hash: string;
  provenance: ScraperProposalProvenance;
}

/** The lifecycle fact making the approved Scraper Service Version available. */
export interface ScraperPublicationRecord {
  published_at: string;
  published_by: string;
  actor: string;
  scraper_service_version: number;
  content_hash: string;
  evidence_hash: string;
  provenance: ScraperProposalProvenance;
}

/** The lifecycle fact explicitly binding one Source to the published Version. */
export interface ScraperAdoptionRecord {
  adopted_at: string;
  adopted_by: string;
  actor: string;
  source_id: string;
  scraper_service_version: number;
  previous_adopted_version: number | null;
  content_hash: string;
  evidence_hash: string;
  provenance: ScraperProposalProvenance;
}

/** One immutable review unit for one compiled Scraper Service candidate. */
export interface ScraperProposalRecord {
  kind: 'scraper';
  proposal_id: string;
  workspace_id: string;
  scraper_task_id: string;
  scraper_task_version: number;
  created_at: string;
  created_by: string;
  created_by_user_id: string;
  base: ScraperProposalBase;
  evidence: ScraperProposalEvidence;
  candidates: ScraperProposalCandidates;
  /** Set only when this Proposal repairs a recorded failure. */
  repair: ScraperRepairRecord | null;
  proposal_hash: string;
  validations: ScraperValidationRecord[];
  /** The isolated fixture previews Approval may cover. */
  previews: ScraperPreviewRecord[];
  verifications: ScraperVerificationRecord[];
  decisions: ScraperDecisionRecord[];
  publications: ScraperPublicationRecord[];
  adoptions: ScraperAdoptionRecord[];
}

/**
 * Every Proposal the Deployment holds, of any kind. One collection keeps a
 * Proposal one all-or-nothing review unit whichever Artifact it proposes.
 */
export type ArtifactProposalRecord = IntegrationProposalRecord | DataProductProposalRecord | ScraperProposalRecord;

export function findModelProfile(
  profiles: ModelProfileArtifact[],
  modelProfileId: string,
): ModelProfileArtifact | undefined {
  return profiles.find((profile) => profile.model_profile_id === modelProfileId);
}

export function findModelProfileVersion(
  profile: ModelProfileArtifact | undefined,
  version: number,
): ModelProfileVersion | undefined {
  return profile?.versions.find((candidate) => candidate.version === version);
}

export function findModelBinding(
  bindings: WorkspaceModelBindingRecord[],
  bindingId: string,
): WorkspaceModelBindingRecord | undefined {
  return bindings.find((binding) => binding.binding_id === bindingId);
}

export function findArtifactProposal(
  proposals: ArtifactProposalRecord[],
  proposalId: string,
): ArtifactProposalRecord | undefined {
  return proposals.find((proposal) => proposal.proposal_id === proposalId);
}

export function findScraperTask(tasks: ScraperTaskArtifact[], taskId: string): ScraperTaskArtifact | undefined {
  return tasks.find((task) => task.scraper_task_id === taskId);
}

export function latestScraperTaskVersion(task: ScraperTaskArtifact | undefined): ScraperTaskVersion | undefined {
  return task?.versions[task.versions.length - 1];
}

export function findScraperService(
  services: ScraperServiceArtifact[],
  serviceId: string,
): ScraperServiceArtifact | undefined {
  return services.find((service) => service.scraper_service_id === serviceId);
}

export function scraperServiceForTask(
  services: ScraperServiceArtifact[],
  taskId: string,
): ScraperServiceArtifact | undefined {
  return services.find((service) => service.scraper_task_id === taskId);
}

export function latestScraperServiceVersion(
  service: ScraperServiceArtifact | undefined,
): ScraperServiceVersion | undefined {
  return service?.versions[service.versions.length - 1];
}

export function findScraperServiceVersion(
  service: ScraperServiceArtifact | undefined,
  version: number,
): ScraperServiceVersion | undefined {
  return service?.versions.find((candidate) => candidate.version === version);
}

export function findScraperCredential(
  credentials: ScraperCredentialRecord[],
  workspaceId: string,
  ref: string,
): ScraperCredentialRecord | undefined {
  return credentials.find((credential) => credential.workspace_id === workspaceId && credential.ref === ref);
}

export function adoptedScraperService(
  pins: SourceScraperServiceRecord[],
  sourceId: string,
): SourceScraperServiceRecord | undefined {
  return pins.find((pin) => pin.source_id === sourceId);
}

/** The failure diagnosis one attempt recorded, by its own identity. */
export function findScraperDiagnostics(
  records: ScraperDiagnosticsRecord[],
  diagnosticsId: string,
): ScraperDiagnosticsRecord | undefined {
  return records.find((record) => record.diagnostics_id === diagnosticsId);
}

export function findReportTemplate(
  templates: ReportTemplateArtifact[],
  reportTemplateId: string,
): ReportTemplateArtifact | undefined {
  return templates.find((template) => template.report_template_id === reportTemplateId);
}

export function latestReportTemplateVersion(
  template: ReportTemplateArtifact | undefined,
): ReportTemplateVersion | undefined {
  return template?.versions[template.versions.length - 1];
}

export function findReportTemplateVersion(
  template: ReportTemplateArtifact | undefined,
  version: number,
): ReportTemplateVersion | undefined {
  return template?.versions.find((candidate) => candidate.version === version);
}

export function findReport(reports: ReportRecord[], reportId: string): ReportRecord | undefined {
  return reports.find((report) => report.report_id === reportId);
}

// ---------------------------------------------------------------------------
// Retention: versioned policies, Workspace overrides, Holds, and Purge.
// ---------------------------------------------------------------------------

/**
 * Every class of produced data one retention clock governs. Raw payloads,
 * Release history, Reports, Artifact versions and lifecycle facts, Provenance,
 * Audit Events, terminal Proposal evidence, exports, and derived data each age
 * on their own settled rule.
 */
export type RetentionDataClass =
  | 'raw_acquisition'
  | 'dataset_release_history'
  | 'report'
  | 'artifact_version'
  | 'provenance'
  | 'audit_event'
  | 'proposal_evidence'
  | 'export'
  | 'derived_data';

/**
 * One settled retention clock: a number of days from creation, an indefinite
 * preservation, or no guarantee at all. A policy is UTC-based and applies to
 * existing and future data alike, so this carries no instant of its own.
 */
export type RetentionTerm =
  | { kind: 'days'; days: number }
  | { kind: 'indefinite' }
  | { kind: 'no_guarantee' };

/** The finite envelope one Workspace override must stay inside. */
export interface RetentionBounds {
  min_days: number;
  max_days: number;
}

/** The classes a Workspace Administrator may override within Deployment bounds. */
export type OverridableRetentionClass = 'raw_acquisition' | 'dataset_release_history' | 'report';

/** One immutable Deployment retention policy version. */
export interface RetentionPolicyVersion {
  version: number;
  published_at: string;
  published_by: string;
  defaults: Record<RetentionDataClass, RetentionTerm>;
  bounds: Record<OverridableRetentionClass, RetentionBounds>;
  content_hash: string;
}

/** The Deployment retention policy Artifact and its append-only versions. */
export interface RetentionPolicyArtifact {
  artifact_id: 'retention-policy';
  versions: RetentionPolicyVersion[];
}

/** One Workspace retention override revision, naming the policy it was made under. */
export interface WorkspaceRetentionOverrideVersion {
  version: number;
  policy_version: number;
  terms: Partial<Record<OverridableRetentionClass, RetentionTerm>>;
  updated_at: string;
  updated_by: string;
}

/** A Workspace's append-only retention overrides within Deployment bounds. */
export interface WorkspaceRetentionOverrideArtifact {
  workspace_id: string;
  versions: WorkspaceRetentionOverrideVersion[];
}

/** The scope a retention Hold protects or a Purge targets. */
export type RetentionScopeKind =
  | 'deployment'
  | 'workspace'
  | 'source'
  | 'dataset'
  | 'release'
  | 'proposal_evidence'
  | 'export';

/**
 * One resolved retention scope. Every identifier is explicit, so a scope never
 * reaches content the requesting administrator does not administer.
 */
export interface RetentionScope {
  kind: RetentionScopeKind;
  workspace_id: string | null;
  source_id: string | null;
  dataset_id: string | null;
  dataset_release: number | null;
  target_id: string | null;
}

/**
 * One audited Retention Hold. It names an accountable administrator, the exact
 * scope it protects, a reason, and the date its necessity must be reviewed.
 * An active Hold blocks automatic and manual Purge until it is released.
 */
export interface RetentionHoldRecord {
  hold_id: string;
  scope: RetentionScope;
  reason: string;
  review_at: string;
  created_at: string;
  created_by: string;
  created_by_user_id: string;
  released_at: string | null;
  released_by: string | null;
  released_by_user_id: string | null;
}

/** The kind of governed record one plan entry would delete. */
export type PurgeRecordKind =
  | 'raw_acquisition'
  | 'dataset_release'
  | 'data_product_release'
  | 'report'
  | 'proposal_evidence'
  | 'export';

/** Why one record is, or is not, eligible for physical deletion. */
export type PurgeEligibilityReason =
  | 'eligible'
  | 'within_retention'
  | 'current'
  | 'held'
  | 'dependent'
  | 'indefinite'
  | 'no_guarantee';

/** One evaluated record in a Purge plan. */
export interface PurgePlanEntry {
  data_class: RetentionDataClass;
  record_kind: PurgeRecordKind;
  /** The stable key of the record: a raw id, `<artifact>#<release>`, or an id. */
  record_id: string;
  workspace_id: string;
  eligible: boolean;
  reason: PurgeEligibilityReason;
  /** The active Holds that keep this record ineligible. */
  held_by: string[];
  /** The retained or current results that still depend on this record. */
  dependencies: string[];
  /** Set when one execution pass deleted the record. */
  purged?: boolean;
  /** Set when a dependency or Hold appeared after the plan was made. */
  deferred?: boolean;
}

/** One durable Purge request and its asynchronous deletion work. */
export interface PurgeJobRecord {
  purge_id: string;
  mode: 'manual' | 'automatic';
  scope: RetentionScope;
  requested_at: string;
  requested_by: string;
  requested_by_user_id: string;
  status: 'pending' | 'failed' | 'completed';
  /** Logical access is revoked from this instant, before any deletion. */
  access_revoked_at: string;
  plan: PurgePlanEntry[];
  attempts: number;
  retry_at: string | null;
  last_error: string | null;
  completed_at: string | null;
  ledger_sequence: number | null;
}

/** One sequenced Purge Ledger entry, the durable proof content was purged. */
export interface PurgeLedgerEntry {
  sequence: number;
  purge_id: string;
  mode: 'manual' | 'automatic';
  recorded_at: string;
  scope: RetentionScope;
  purged: Array<{
    record_kind: PurgeRecordKind;
    record_id: string;
    data_class: RetentionDataClass;
  }>;
}
