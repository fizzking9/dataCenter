/** The structured error every application API answers with. */
export interface ApiError {
  code: string;
  message?: string;
  next_step?: string;
  /** A governed upload that was retained although integration refused it. */
  current_release?: number;
  raw_acquisition_saved?: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

export interface SessionView {
  operator_id: string;
  username: string;
  session_expires_at: string;
}

export interface Credentials {
  operator_id: string;
  username: string;
  mfa_enrolled: boolean;
  totp_secret: string;
  recovery_codes: string[];
  enrollment_uri: string;
}

export interface HealthView {
  state: string;
  health: string;
  service_open: boolean;
  runtime_services?: string[];
  mfa_enrolled?: boolean;
  default_credentials?: boolean;
  master_key_external?: boolean;
  evidence_id?: string;
  checked_at?: string;
}

export interface LicenseView {
  license_id: string;
  not_before: string;
  expires_at: string;
  highest_eligible_release: string;
  release: string;
  deployment_id: string;
  state: string;
}

/** A platform User session, which is a different channel from the Operator one. */
export interface PlatformSessionView {
  username: string;
  deployment_role: string | null;
  mfa_enrolled: boolean;
  session_expires_at: string;
}

export type WorkspaceRoleValue = 'Workspace Administrator' | 'Consumer';

/** One authorized Workspace, with the Role the actor holds in it. */
export interface AuthorizedWorkspace {
  workspace_id: string;
  name: string;
  role: WorkspaceRoleValue;
}

/** A stable ASCII navigation key; the Chinese label lives in the text catalog. */
export interface NavigationEntry {
  key: string;
}

export interface ActivityEntry {
  activity_id: string;
  kind: string;
  state: string;
  since: string;
}

export interface ActivityCentreView {
  background: ActivityEntry[];
  attention: ActivityEntry[];
}

/**
 * The authorized shell. A Workspace the actor may not enter answers exactly like
 * one that does not exist: `workspace_id` stays null and the tree stays empty.
 */
export interface NavigationView {
  username: string;
  deployment_role: string | null;
  session_expires_at: string;
  deployment: NavigationEntry[];
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_role: WorkspaceRoleValue | null;
  workspace: NavigationEntry[];
  workspaces: AuthorizedWorkspace[];
  activity: ActivityCentreView;
}

export interface DeploymentWorkspace {
  workspace_id: string;
  name: string;
  created_at: string;
  role: string;
  /** Governance metadata: how many active administrators keep it governable. */
  active_administrators: number | null;
}

export interface CreatedWorkspace {
  workspace_id: string;
  name: string;
  created_at: string;
  administrator: string;
  administrator_role: WorkspaceRoleValue;
  totp_secret?: string;
  recovery_codes?: string[];
  enrollment_uri?: string;
}

export interface EmergencyAdministrator {
  workspace_id: string;
  workspace_name: string;
  username: string;
  role: WorkspaceRoleValue;
  previous_role: WorkspaceRoleValue | null;
  active_administrators: number;
  totp_secret?: string;
  recovery_codes?: string[];
  enrollment_uri?: string;
}

/** One User of this Deployment, with accountability metadata only. */
export interface DeploymentUserView {
  user_id: string;
  username: string;
  status: 'active' | 'deactivated';
  deployment_role: string | null;
  mfa_enrolled: boolean;
  owned_artifacts: number;
  workspace_roles: Array<{
    workspace_id: string;
    workspace_name: string | null;
    role: WorkspaceRoleValue;
  }>;
}

export interface DeploymentUserList {
  users: DeploymentUserView[];
}

/** A created account, with the one-time enrollment material an Administrator gets. */
export interface DeploymentUserCreated {
  user_id: string;
  username: string;
  deployment_role: string | null;
  status: string;
  mfa_enrolled: boolean;
  totp_secret?: string;
  recovery_codes?: string[];
  enrollment_uri?: string;
}

export interface DeploymentUserDeactivated {
  user_id: string;
  username: string;
  status: string;
}

export interface OwnershipTransferResult {
  from: string;
  owner: string;
  transferred: number;
  artifact_ids: string[];
}

/** What a Service Identity may do; it never consumes governed data. */
export interface ServiceIdentityCapabilities {
  executes_jobs: boolean;
  consumes_data_products: boolean;
  owns_artifacts: boolean;
}

export interface ServiceIdentityView {
  service_identity_id: string;
  name: string;
  workspace_ids: string[];
  workspaces: Array<{ workspace_id: string; name: string }>;
  status: 'active' | 'revoked';
  created_at: string;
  created_by: string | null;
  revoked_at: string | null;
  capabilities: ServiceIdentityCapabilities;
  already_revoked?: boolean;
}

export interface ServiceIdentityList {
  service_identities: ServiceIdentityView[];
}

/** One Workspace membership, in the shape the administered Workspace lists it. */
export interface WorkspaceMemberView {
  username: string;
  role: WorkspaceRoleValue;
  granted_at: string;
}

export interface WorkspaceMemberList {
  workspace_id: string;
  members: WorkspaceMemberView[];
}

/**
 * A grant answers with the Role it set and, when it enrolled a new Workspace
 * Administrator, the one-time enrollment material to hand over in person.
 */
export interface WorkspaceMemberGrant {
  workspace_id: string;
  username: string;
  role: WorkspaceRoleValue;
  previous_role: WorkspaceRoleValue | null;
  totp_secret?: string;
  recovery_codes?: string[];
  enrollment_uri?: string;
}

/** One Artifact pinned to an exact Workspace Business Context version. */
export interface ContextArtifactPin {
  kind: 'integration_configuration' | 'dataset_release';
  version: number;
  source_id: string;
  source_name: string;
  dataset_id?: string;
}

/** One immutable Workspace Business Context version, with its Artifact pins. */
export interface ContextVersionView {
  version: number;
  published_at: string;
  published_by: string | null;
  content_hash: string;
  entry_count: number;
  common_business_context_version: number;
  previous_workspace_business_context_version: number | null;
  affected_artifacts: ContextArtifactPin[];
}

export interface ContextHistoryView {
  workspace_id: string;
  versions: ContextVersionView[];
}

export type AuditOutcomeValue = 'succeeded' | 'denied' | 'failed';

/** The attribution a Workspace Audit Event discloses; payloads stay on the server. */
export interface WorkspaceAuditEventView {
  event_id: string;
  occurred_at: string;
  actor: string;
  action: string;
  scope: string;
  target: string | null;
  outcome: AuditOutcomeValue;
}

export interface WorkspaceAuditView {
  workspace_id: string;
  chain_valid: boolean;
  events: WorkspaceAuditEventView[];
}

export interface DataProductSummary {
  data_product_id: string;
  name: string;
  api_path: string;
  title: string;
  data_product_version: number;
  data_product_release: string;
  contract_version: { major: number; minor: number };
}

export interface DataProductList {
  workspace_id: string;
  data_products: DataProductSummary[];
}

export interface ContextEntryView {
  key: string;
  kind: string;
  value: string;
  unit?: string;
  description?: string;
  source: 'common' | 'workspace';
}

export interface ContextView {
  scope: 'deployment' | 'workspace';
  workspace_id: string | null;
  artifact_id: string;
  owner: string | null;
  business_context_version: number;
  content_hash: string;
  entries: ContextEntryView[];
}

/** One Source the active Workspace administers, named without any raw content. */
export interface SourceSummary {
  source_id: string;
  name: string;
  type: 'file' | 'document' | 'http_json' | 'scraper';
  created_at: string;
}

export interface SourceList {
  workspace_id: string;
  sources: SourceSummary[];
}

export interface SourceSchemaField {
  name: string;
  type: 'string' | 'integer' | 'number' | 'date' | 'timestamp';
}

export interface SourceCleaningRule {
  rule: 'trim' | 'uppercase' | 'lowercase' | 'default' | 'require_non_empty';
  field: string;
  value?: string;
}

export interface SourceDocumentLimits {
  max_bytes: number;
  max_documents: number;
  max_text_chars: number;
  max_metadata_fields: number;
  max_worker_ms: number;
  max_heap_mb: number;
}

/** The exact declarative Configuration the guided form reviews and publishes. */
export interface IntegrationDeclaration {
  identity: string[];
  schema: SourceSchemaField[];
  cleaning: SourceCleaningRule[];
  mapping: Record<string, string>;
  document_limits: SourceDocumentLimits;
}

export interface SourceConfigurationVersionView {
  version: number;
  published_at: string;
  content_hash: string;
  schema: SourceSchemaField[];
  identity_fields: string[];
  cleaning: SourceCleaningRule[];
  mapping: Record<string, string>;
  document_limits: SourceDocumentLimits;
}

export interface SourceRejectionView {
  raw_id: string;
  row: number;
  field: string | null;
  rule: string;
  reason: string;
  integration_configuration_version: number;
}

export interface SourceDocumentProcessingView {
  parser: { name: string; version: number };
  limits: SourceDocumentLimits;
}

export interface SourceReleaseView {
  release: number;
  created_at: string;
  record_count: number;
  record_rejection_count: number;
  records_hash: string;
  integration_configuration_version: number;
  provenance: {
    batch_ids: string[];
    acquisition_run_ids: string[];
    raw_acquisition_ids: string[];
    acquired_at: string;
    integrated_at: string;
  };
  document_processing?: SourceDocumentProcessingView;
  record_rejections?: SourceRejectionView[];
}

export interface SourceRunView {
  acquisition_run_id: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  integration_configuration_version: number | null;
}

export interface SourceLatestAcquisitionView {
  batch_id: string;
  acquisition_run_id: string;
  raw_acquisition_ids: string[];
  created_at: string;
  quarantined: boolean;
}

export interface SourceDetailView {
  source: SourceSummary & { workspace_id: string };
  configuration: {
    adopted_version: number | null;
    versions: SourceConfigurationVersionView[];
  };
  dataset: {
    releases: SourceReleaseView[];
    latest?: SourceReleaseView;
  };
  runs: SourceRunView[];
  latest_acquisition: SourceLatestAcquisitionView | null;
}

export interface SourceConfigurationPreview {
  valid: boolean;
  declaration?: IntegrationDeclaration;
  content_hash?: string;
  errors: Array<{ code: string; message?: string }>;
}

export interface SourceConfigurationPublicationView {
  source_id: string;
  integration_configuration_version: number;
  content_hash: string;
  adopted_version: number | null;
  declaration?: IntegrationDeclaration;
}

export interface SourceAcquisitionView {
  source_id: string;
  acquisition_run_id: string;
  status: string;
  raw_acquisition: {
    raw_id: string;
    content_hash: string;
    byte_length: number;
    received_at: string;
  };
  integration_batch: {
    batch_id: string;
    acquisition_run_id: string;
    integration_configuration_version: number;
    raw_acquisition_ids: string[];
    created_at: string;
  };
  integration: {
    dataset_release: number;
    reused: boolean;
    record_count: number;
    record_rejection_count: number;
    accepted_records: number;
    rejected_records: number;
  } | null;
}


/** One pinned Model Profile Version as the browser reads it, never its credential. */
export interface ModelPromptView {
  id: string;
  body: string;
  hash: string;
}

export interface ModelProfileVersionView {
  model_profile_version: number;
  adapter: string;
  model_id: string;
  purposes: string[];
  data_categories: string[];
  tools: string[];
  max_output_bytes: number;
  prompts: ModelPromptView[];
  credential_ref: string;
  has_credential: boolean;
  content_hash: string;
  published_at: string;
  published_by: string;
}

export interface ModelProfileCheckView {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ModelProfileEvaluationView {
  model_profile_version: number;
  model_profile_content_hash: string;
  evaluated_at: string;
  evaluated_by: string;
  adapter: string;
  model_id: string;
  passed: boolean;
  checks: ModelProfileCheckView[];
  evidence_hash: string;
}

export interface ModelProfileView {
  model_profile_id: string;
  name: string;
  created_at: string;
  activated_version: number | null;
  activated_at: string | null;
  versions: ModelProfileVersionView[];
  evaluations: ModelProfileEvaluationView[];
}

export interface ModelProfileList {
  model_profiles: ModelProfileView[];
}

export interface ModelProfileEvaluationResult {
  model_profile_id: string;
  model_profile_version: number;
  content_hash: string;
  passed: boolean;
  checks: ModelProfileCheckView[];
  evidence_hash: string;
  evaluated_at: string;
}

export interface ModelProfileActivationResult {
  model_profile_id: string;
  activated_version: number;
  activated_at: string;
  content_hash: string;
  evaluation_hash: string;
}

/** An activated Profile Version a Workspace Administrator may bind. */
export interface BindableModelProfile {
  model_profile_id: string;
  name: string;
  model_profile_version: number;
  content_hash: string;
  purposes: string[];
  data_categories: string[];
}

/** Where one scraped page lives and how its sequence is asked for. */
export interface ScraperTargetView {
  base_url: string;
  path: string;
  page_parameter: string | null;
  first_page: number;
  page_size: number | null;
  page_size_parameter: string | null;
  max_pages: number;
}

export interface ScraperOutputFieldView {
  name: string;
  selector: string;
}

export interface ScraperOutputView {
  record_selector: string;
  fields: ScraperOutputFieldView[];
}

export interface ScraperParameterView {
  name: string;
  type: 'string' | 'integer';
  required: boolean;
  default: string | null;
}

export interface ScraperConstraintsView {
  timeout_ms: number;
  max_bytes: number;
  max_records: number;
}

export interface ScraperVersionSummaryView {
  scraper_task_version: number;
  content_hash: string;
  published_at: string;
  fixtures_version: number;
  fixtures_hash: string;
}

/** One pinned Scraper Task Version as the guided form and Task list read it. */
export interface ScraperTaskView {
  scraper_task_id: string;
  name: string;
  created_at: string;
  version_count: number;
  versions: ScraperVersionSummaryView[];
  scraper_task_version: number;
  content_hash: string;
  fixtures_version: number;
  fixtures_hash: string;
  target: ScraperTargetView;
  network_scope: { origins: string[]; paths: string[] };
  output: ScraperOutputView;
  parameters: ScraperParameterView[];
  constraints: ScraperConstraintsView;
  credential_refs: string[];
  fixture_count: number;
}

export interface ScraperServiceVersionView {
  version: number;
  published_at: string;
  content_hash: string;
  withdrawn_at: string | null;
  scraper_task_version: number;
  output_fields: string[];
}

export interface ScraperServiceView {
  scraper_service_id: string;
  scraper_task_id: string;
  name: string;
  versions: ScraperServiceVersionView[];
}

export interface ScraperPinView {
  source_id: string;
  source_name: string | null;
  scraper_service_id: string;
  adopted_version: number;
  content_hash: string;
  proposal_id: string;
  adopted_at: string;
}

export interface ScraperCredentialView {
  ref: string;
  location: 'bearer' | 'cookie';
  cookie_name: string | null;
  created_at: string;
}

export interface ScraperWorkspaceView {
  workspace_id: string;
  tasks: ScraperTaskView[];
  services: ScraperServiceView[];
  pins: ScraperPinView[];
  credentials: ScraperCredentialView[];
  sources: Array<{ source_id: string; name: string }>;
}

export interface ScraperValidationCheckView {
  name: string;
  passed: boolean;
  detail: string | null;
}

export interface ScraperValidationFixtureView {
  name: string;
  path: string;
  record_count: number;
  expected_record_count: number;
  records_hash: string;
  body_hash: string;
}

export interface ScraperValidationView {
  validated_at: string;
  validated_by: string;
  checks: ScraperValidationCheckView[];
  fixtures: ScraperValidationFixtureView[];
  passed: boolean;
  evidence_hash: string;
}

export interface ScraperPreviewFixtureView {
  name: string;
  path: string;
  record_count: number;
  expected_record_count: number;
  matches: boolean;
  records: Array<Record<string, string>>;
  records_hash: string;
}

export interface ScraperPreviewView {
  previewed_at: string;
  previewed_by: string;
  fixtures: ScraperPreviewFixtureView[];
  passed: boolean;
  evidence_hash: string;
}

export interface ScraperDiagnosticView {
  code: string;
  page: number | null;
  message: string;
}

export interface ScraperManifestPageView {
  page: number;
  url: string;
  status: number;
  response_hash: string;
  response_bytes: number;
  raw_id: string | null;
  record_count: number;
}

export interface ScraperVerificationView {
  verified_at: string;
  verified_by: string;
  scraper_service_version: number;
  scraper_service_content_hash: string;
  passed: boolean;
  pages: ScraperManifestPageView[];
  record_count: number;
  diagnostics: ScraperDiagnosticView[];
  evidence_hash: string;
}

export interface ScraperRepairView {
  base_service_version: number | null;
  base_service_content_hash: string | null;
  base_task_version: number;
  base_task_content_hash: string;
  diagnostics_id: string;
  failure_evidence_hash: string;
  failure_code: string;
  failure_stage: string;
  failure_category: string;
  model: {
    model_profile_id: string;
    model_profile_version: number;
    model_profile_content_hash: string;
    adapter: string;
    model_id: string;
    binding_id: string;
    prompt_id: string;
    prompt_hash: string;
  };
  input_hash: string;
}

export interface ScraperProvenanceView {
  engine: { name: string; version: number };
  scraper_task_id: string;
  scraper_task_version: number;
  scraper_task_content_hash: string;
  fixtures_hash: string;
  validation_hash: string;
  preview_hash: string;
  verification_hash: string;
  candidate_content_hash: string;
  proposal_hash: string;
  repair: {
    base_service_version: number | null;
    base_service_content_hash: string | null;
    base_task_version: number;
    base_task_content_hash: string;
    diagnostics_id: string;
    failure_evidence_hash: string;
    failure_code: string;
    input_hash: string;
    model: ScraperRepairView['model'];
  } | null;
}

export interface ScraperCandidateServiceView {
  engine: { name: string; version: number };
  target: ScraperTargetView;
  network_scope: { origins: string[]; paths: string[] };
  output: ScraperOutputView;
  parameters: ScraperParameterView[];
  constraints: ScraperConstraintsView;
  credential_refs: string[];
  source_task: { version: number; content_hash: string };
  fixtures: { version: number; hash: string };
}

export interface ScraperDecisionView {
  decided_at: string;
  decided_by: string;
  outcome: 'approved' | 'rejected';
  reason: string | null;
  evidence_hash: string;
  provenance: ScraperProvenanceView;
}

export interface ScraperPublicationView {
  published_at: string;
  published_by: string;
  scraper_service_version: number;
  content_hash: string;
  evidence_hash: string;
  provenance: ScraperProvenanceView;
}

export interface ScraperAdoptionView {
  adopted_at: string;
  adopted_by: string;
  source_id: string;
  scraper_service_version: number;
  previous_adopted_version: number | null;
  evidence_hash: string;
  provenance: ScraperProvenanceView;
}

export type ScraperProposalStatus = 'pending' | 'approved' | 'rejected' | 'published' | 'adopted';

/** One immutable Scraper Proposal with every candidate and evidence fact. */
export interface ScraperProposalView {
  proposal_id: string;
  kind: 'scraper';
  status: ScraperProposalStatus;
  workspace_id: string;
  scraper_task_id: string;
  scraper_task_version: number;
  created_at: string;
  created_by: string;
  base: {
    scraper_service_id: string | null;
    scraper_service_version: number | null;
    scraper_service_content_hash: string | null;
  };
  evidence: {
    task_hash: string;
    fixtures_version: number;
    fixtures_hash: string;
    output_fields: string[];
    network_scope: { origins: string[]; paths: string[] };
    regression_fixtures: string[];
  };
  candidates: {
    service: ScraperCandidateServiceView;
    content_hash: string;
  };
  repair: ScraperRepairView | null;
  proposal_hash: string;
  validations: ScraperValidationView[];
  previews: ScraperPreviewView[];
  verifications: ScraperVerificationView[];
  decisions: ScraperDecisionView[];
  publications: ScraperPublicationView[];
  adoptions: ScraperAdoptionView[];
  /** Whether the published base this Proposal was compiled against still stands. */
  fresh?: boolean;
}

export interface ScraperDiagnosticsSummaryView {
  diagnostics_id: string;
  mode: 'run' | 'verification';
  source_id: string | null;
  proposal_id: string | null;
  acquisition_run_id: string | null;
  recorded_at: string;
  failure_code: string;
  stage: string;
  category: string;
  scraper_task_id: string;
  scraper_task_version: number;
  scraper_service_version: number;
  evidence_hash: string;
}

export interface ScraperProposalList {
  workspace_id: string;
  proposals: ScraperProposalView[];
  diagnostics: ScraperDiagnosticsSummaryView[];
}

export interface ScraperEvidenceRequestView {
  method: string;
  url: string;
  header_names: string[];
  credential_refs: string[];
}

export interface ScraperEvidencePageView {
  status: number | null;
  content_type: string | null;
  response_hash: string | null;
  response_bytes: number | null;
  body_excerpt: string | null;
  excerpt_truncated: boolean;
}

export interface ScraperFailureDiagnosticView {
  code: string;
  stage: string;
  category: string;
  page: number | null;
  message: string;
  request: ScraperEvidenceRequestView;
  page_evidence: ScraperEvidencePageView;
  raw_refs: Array<{ raw_id: string; content_hash: string; byte_length: number }>;
}

/** One sanitized failure diagnosis, with request and page evidence but no secret. */
export interface ScraperDiagnosticsView {
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
  stage: string;
  category: string;
  engine: { name: string; version: number };
  scraper_task_id: string;
  scraper_task_version: number;
  scraper_task_content_hash: string;
  scraper_service_id: string;
  scraper_service_version: number;
  scraper_service_content_hash: string;
  fixtures_version: number;
  fixtures_hash: string;
  parameters: Record<string, string>;
  diagnostics: ScraperFailureDiagnosticView[];
  raw_refs: Array<{ raw_id: string; content_hash: string; byte_length: number }>;
  evidence_hash: string;
  history_count: number;
}

export interface ScraperRunView {
  acquisition_run_id: string;
  status: string;
  error_code: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  integration_configuration_version: number | null;
  diagnostics_id: string | null;
  failure_code: string | null;
  manifest: {
    manifest_id: string;
    scraper_task_version: number;
    scraper_service_version: number;
    parameters: Record<string, string>;
    pages: ScraperManifestPageView[];
    record_count: number;
    status: string;
    started_at: string;
    completed_at: string | null;
    diagnostics: ScraperDiagnosticView[];
  } | null;
  raw_acquisitions: Array<{ raw_id: string; content_hash: string; byte_length: number; received_at: string }>;
  integration_batch_id: string | null;
  dataset_release: number | null;
}

export interface ScraperRunList {
  workspace_id: string;
  source_id: string;
  adopted: {
    scraper_service_id: string;
    adopted_version: number;
    content_hash: string;
    proposal_id: string;
    adopted_at: string;
  } | null;
  latest_release: { release: number; record_count: number; created_at: string } | null;
  runs: ScraperRunView[];
}

export interface ScraperValidationResult {
  proposal_id: string;
  status: ScraperProposalStatus;
  passed: boolean;
  checks: ScraperValidationCheckView[];
  fixtures: ScraperValidationFixtureView[];
  evidence_hash: string;
}

export interface ScraperPreviewResult {
  proposal_id: string;
  status: ScraperProposalStatus;
  passed: boolean;
  fixtures: ScraperPreviewFixtureView[];
  evidence_hash: string;
}

export interface ScraperVerifyResult {
  proposal_id: string;
  status: ScraperProposalStatus;
  verification: {
    passed: boolean;
    scraper_service_version: number;
    pages: ScraperManifestPageView[];
    record_count: number;
    diagnostics: ScraperDiagnosticView[];
    verified_at: string;
    evidence_hash: string;
  };
  provenance: ScraperProvenanceView;
}

export interface ScraperAdoptResult {
  proposal_id: string;
  status: ScraperProposalStatus;
  source_id: string;
  adopted_version: number;
  previous_adopted_version: number | null;
  content_hash: string;
}

/** What one trigger of the adopted Scraper Service Version produced. */
export interface ScraperRunResult {
  source_id: string;
  acquisition_run_id: string;
  status: string;
  error_code: string | null;
  diagnostics_id: string | null;
  scraper_service_id: string;
  scraper_service_version: number;
  scraper_service_content_hash: string;
  acquisition_run: {
    acquisition_run_id: string;
    mode: string;
    trigger: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    integration_configuration_version: number | null;
  };
  raw_acquisitions: Array<{ raw_id: string; content_hash: string; byte_length: number; received_at: string }>;
  manifest: {
    manifest_id: string;
    scraper_service_version: number;
    scraper_task_version: number;
    engine: { name: string; version: number };
    parameters: Record<string, string>;
    pages: ScraperManifestPageView[];
    record_count: number;
    status: string;
    started_at: string;
    completed_at: string | null;
  };
  diagnostics: ScraperDiagnosticView[];
  provenance: {
    engine: { name: string; version: number };
    scraper_task_id: string;
    scraper_task_version: number;
    scraper_task_content_hash: string;
    scraper_service_version: number;
    scraper_service_content_hash: string;
    fixtures_hash: string;
    proposal_id: string;
    adopted_at: string;
    acquisition_run_id: string;
    acquired_at: string;
    integrated_at: string | null;
    released: boolean;
  };
  integration_batch_id: string | null;
  quarantined: boolean;
  dataset_release: number | null;
  record_count: number;
}

export interface ModelBindingPreflightView {
  checked_at: string;
  passed: boolean;
  checks: ModelProfileCheckView[];
  evidence_hash: string;
}

export interface ModelBindingView {
  binding_id: string;
  workspace_id: string;
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  purposes: string[];
  data_categories: string[];
  preflight: ModelBindingPreflightView;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
  /** The listing adds the Profile name; the single-Binding read does not. */
  model_profile_name?: string | null;
}

export interface WorkspaceModelBindingList {
  workspace_id: string;
  bindings: ModelBindingView[];
  model_profiles: BindableModelProfile[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...init,
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK_UNAVAILABLE' } };
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: {
        code: typeof payload.code === 'string' ? payload.code : 'UNKNOWN',
        ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
        ...(typeof payload.next_step === 'string' ? { next_step: payload.next_step } : {}),
        ...(typeof payload.current_release === 'number' ? { current_release: payload.current_release } : {}),
        ...(payload.raw_acquisition_saved === true ? { raw_acquisition_saved: true } : {}),
      },
    };
  }
  return { ok: true, data: payload as T };
}

/**
 * Sends one governed upload as raw bytes. The browser never parses, curates, or
 * validates the file; it only hands the bytes to the server that does.
 */
async function requestUpload<T>(path: string, file: Blob): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK_UNAVAILABLE' } };
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: {
        code: typeof payload.code === 'string' ? payload.code : 'UNKNOWN',
        ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
        ...(typeof payload.next_step === 'string' ? { next_step: payload.next_step } : {}),
        ...(typeof payload.current_release === 'number' ? { current_release: payload.current_release } : {}),
        ...(payload.raw_acquisition_saved === true ? { raw_acquisition_saved: true } : {}),
      },
    };
  }
  return { ok: true, data: payload as T };
}

function workspaceQuery(workspaceId: string): string {
  return `?workspace_id=${encodeURIComponent(workspaceId)}`;
}

/**
 * The browser holds no governed rules: it only calls the authenticated HTTP
 * application APIs that back the same modules the lifecycle CLI uses.
 */
export const consoleApi = {
  session: () => request<SessionView>('/api/operator/session'),
  signIn: (body: { username: string; password: string; totp?: string; recovery_code?: string }) =>
    request<SessionView>('/api/operator/session', { method: 'POST', body: JSON.stringify(body) }),
  signOut: () => request<{ revoked: boolean }>('/api/operator/session', { method: 'DELETE' }),
  enroll: (body: { enrollment_secret: string; password: string }) =>
    request<Credentials>('/api/operator/enrollment', { method: 'POST', body: JSON.stringify(body) }),
  health: () => request<HealthView>('/api/operator/health'),
  license: () => request<LicenseView>('/api/operator/license'),
};

/**
 * The platform User channel: a separate sign-in from the Operator Console, and
 * every Workspace-scoped call names the one active Workspace it reads.
 */
export const platformApi = {
  session: () => request<PlatformSessionView>('/api/session'),
  signIn: (body: { username: string; password: string; totp?: string; recovery_code?: string }) =>
    request<PlatformSessionView>('/api/session', { method: 'POST', body: JSON.stringify(body) }),
  signOut: () => request<{ revoked: boolean }>('/api/session', { method: 'DELETE' }),
  navigation: (workspaceId?: string) =>
    request<NavigationView>(
      workspaceId === undefined ? '/api/navigation' : `/api/navigation${workspaceQuery(workspaceId)}`,
    ),
  deploymentWorkspaces: () => request<{ workspaces: DeploymentWorkspace[] }>('/api/deployment/workspaces'),
  createDeploymentWorkspace: (name: string, administrator: string) =>
    request<CreatedWorkspace>('/api/deployment/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, administrator }),
    }),
  appointEmergencyAdministrator: (workspaceId: string, username: string) =>
    request<EmergencyAdministrator>(
      `/api/deployment/workspaces/${encodeURIComponent(workspaceId)}/emergency-administrator`,
      { method: 'POST', body: JSON.stringify({ username }) },
    ),
  deploymentUsers: () => request<DeploymentUserList>('/api/deployment/users'),
  createDeploymentUser: (body: { username: string; password: string; deployment_administrator: boolean }) =>
    request<DeploymentUserCreated>('/api/deployment/users', { method: 'POST', body: JSON.stringify(body) }),
  deactivateDeploymentUser: (username: string) =>
    request<DeploymentUserDeactivated>('/api/deployment/users/deactivate', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  transferOwnership: (from: string, to: string) =>
    request<OwnershipTransferResult>('/api/deployment/ownership-transfer', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  serviceIdentities: () => request<ServiceIdentityList>('/api/deployment/service-identities'),
  createServiceIdentity: (name: string, workspaceIds: string[]) =>
    request<ServiceIdentityView>('/api/deployment/service-identities', {
      method: 'POST',
      body: JSON.stringify({ name, workspace_ids: workspaceIds }),
    }),
  revokeServiceIdentity: (serviceIdentityId: string) =>
    request<ServiceIdentityView>(
      `/api/deployment/service-identities/${encodeURIComponent(serviceIdentityId)}/revoke`,
      { method: 'POST' },
    ),
  dataProducts: (workspaceId: string) =>
    request<DataProductList>(`/api/workspace/data-products${workspaceQuery(workspaceId)}`),
  context: (workspaceId: string) =>
    request<ContextView>(`/api/workspace/context${workspaceQuery(workspaceId)}`),
  workspaceMembers: (workspaceId: string) =>
    request<WorkspaceMemberList>(`/api/workspace/memberships${workspaceQuery(workspaceId)}`),
  grantWorkspaceMember: (workspaceId: string, username: string, role: WorkspaceRoleValue) =>
    request<WorkspaceMemberGrant>('/api/workspace/memberships', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, username, role }),
    }),
  revokeWorkspaceMember: (workspaceId: string, username: string) =>
    request<{ workspace_id: string; username: string; removed: boolean }>('/api/workspace/memberships/revoke', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, username }),
    }),
  contextHistory: (workspaceId: string) =>
    request<ContextHistoryView>(`/api/workspace/context/history${workspaceQuery(workspaceId)}`),
  publishWorkspaceContext: (workspaceId: string, entries: unknown[]) =>
    request<{ business_context_version: number; entry_count: number }>('/api/workspace/context/publish', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, entries }),
    }),
  workspaceAudit: (workspaceId: string) =>
    request<WorkspaceAuditView>(`/api/workspace/audit${workspaceQuery(workspaceId)}`),
  sources: (workspaceId: string) =>
    request<SourceList>(`/api/workspace/sources${workspaceQuery(workspaceId)}`),
  createSource: (workspaceId: string, name: string, type: SourceSummary['type']) =>
    request<SourceSummary>('/api/workspace/sources', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, name, type }),
    }),
  source: (sourceId: string) =>
    request<SourceDetailView>(`/api/workspace/sources/${encodeURIComponent(sourceId)}`),
  previewSourceConfiguration: (sourceId: string, declaration: Record<string, unknown>) =>
    request<SourceConfigurationPreview>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/configuration/preview`,
      { method: 'POST', body: JSON.stringify({ declaration }) },
    ),
  publishSourceConfiguration: (sourceId: string, declaration: Record<string, unknown>) =>
    request<SourceConfigurationPublicationView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/configuration/publish`,
      { method: 'POST', body: JSON.stringify({ declaration }) },
    ),
  adoptSourceConfiguration: (sourceId: string, version: number) =>
    request<SourceConfigurationPublicationView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/configuration/adopt`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  uploadSourceAcquisition: (sourceId: string, file: Blob) =>
    requestUpload<SourceAcquisitionView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisitions`,
      file,
    ),
  modelProfiles: () => request<ModelProfileList>('/api/deployment/model-profiles'),
  publishModelProfile: (body: Record<string, unknown>) =>
    request<{ model_profile_id: string }>('/api/deployment/model-profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  evaluateModelProfile: (profileId: string, version: number) =>
    request<ModelProfileEvaluationResult>(
      `/api/deployment/model-profiles/${encodeURIComponent(profileId)}/evaluate`,
      { method: 'POST', body: JSON.stringify({ model_profile_version: version }) },
    ),
  activateModelProfile: (profileId: string, version: number) =>
    request<ModelProfileActivationResult>(
      `/api/deployment/model-profiles/${encodeURIComponent(profileId)}/activate`,
      { method: 'POST', body: JSON.stringify({ model_profile_version: version }) },
    ),
  modelBindings: (workspaceId: string) =>
    request<WorkspaceModelBindingList>(`/api/workspace/model-bindings${workspaceQuery(workspaceId)}`),
  publishModelBinding: (workspaceId: string, body: Record<string, unknown>) =>
    request<ModelBindingView>(`/api/workspace/model-bindings${workspaceQuery(workspaceId)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeModelBinding: (bindingId: string) =>
    request<ModelBindingView>(`/api/workspace/model-bindings/${encodeURIComponent(bindingId)}/revoke`, {
      method: 'POST',
    }),
  scrapers: (workspaceId: string) =>
    request<ScraperWorkspaceView>(`/api/workspace/scrapers${workspaceQuery(workspaceId)}`),
  publishScraperTask: (workspaceId: string, name: string, declaration: Record<string, unknown>) =>
    request<ScraperTaskView>('/api/workspace/scraper-tasks', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, name, declaration }),
    }),
  compileScraperTask: (taskId: string, taskVersion?: number) =>
    request<ScraperProposalView>(`/api/workspace/scraper-tasks/${encodeURIComponent(taskId)}/compile`, {
      method: 'POST',
      body: JSON.stringify(taskVersion === undefined ? {} : { task_version: taskVersion }),
    }),
  scraperProposals: (workspaceId: string) =>
    request<ScraperProposalList>(`/api/workspace/scraper-proposals${workspaceQuery(workspaceId)}`),
  validateScraperProposal: (proposalId: string) =>
    request<ScraperValidationResult>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/validate`,
      { method: 'POST' },
    ),
  previewScraperProposal: (proposalId: string) =>
    request<ScraperPreviewResult>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/preview`,
      { method: 'POST' },
    ),
  approveScraperProposal: (proposalId: string) =>
    request<ScraperProposalView>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/approve`,
      { method: 'POST' },
    ),
  rejectScraperProposal: (proposalId: string, reason: string) =>
    request<ScraperProposalView>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/reject`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  publishScraperProposal: (proposalId: string) =>
    request<ScraperProposalView>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/publish`,
      { method: 'POST' },
    ),
  verifyScraperProposal: (proposalId: string, parameters: Record<string, string>) =>
    request<ScraperVerifyResult>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/verify`,
      { method: 'POST', body: JSON.stringify({ parameters }) },
    ),
  adoptScraperProposal: (proposalId: string, sourceId: string) =>
    request<ScraperAdoptResult>(
      `/api/workspace/scraper-proposals/${encodeURIComponent(proposalId)}/adopt`,
      { method: 'POST', body: JSON.stringify({ source_id: sourceId }) },
    ),
  scraperRuns: (workspaceId: string, sourceId: string) =>
    request<ScraperRunList>(
      `/api/workspace/scraper-runs${workspaceQuery(workspaceId)}&source_id=${encodeURIComponent(sourceId)}`,
    ),
  runScraperSource: (workspaceId: string, sourceId: string, parameters: Record<string, string>) =>
    request<ScraperRunResult>('/api/workspace/scraper-runs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, source_id: sourceId, parameters }),
    }),
  scraperDiagnostics: (diagnosticsId: string) =>
    request<ScraperDiagnosticsView>(
      `/api/workspace/scraper-diagnostics/${encodeURIComponent(diagnosticsId)}`,
    ),
  repairScraper: (diagnosticsId: string, bindingId: string, taskVersion: number) =>
    request<ScraperProposalView>(
      `/api/workspace/scraper-diagnostics/${encodeURIComponent(diagnosticsId)}/repair`,
      { method: 'POST', body: JSON.stringify({ binding_id: bindingId, task_version: taskVersion }) },
    ),
};

/**
 * The governed generation vocabulary the Model Profile list publishes. The
 * browser renders these values instead of declaring its own copy, so a new
 * purpose, data category, or adapter is configurable without a browser change.
 */
export interface ModelVocabulary {
  purposes: string[];
  data_categories: string[];
  adapters: string[];
}

/** The Model Profile list, with the vocabulary the server publishes beside it. */
export interface ModelProfileListWithVocabulary extends ModelProfileList {
  vocabulary: ModelVocabulary;
}

/** Reads the Model Profile list together with the Deployment's governed vocabulary. */
export function modelProfileList(): Promise<ApiResult<ModelProfileListWithVocabulary>> {
  return platformApi.modelProfiles() as Promise<ApiResult<ModelProfileListWithVocabulary>>;
}
