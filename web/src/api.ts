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

/** One announced expiration threshold, as the server states it. */
export interface LicenseWarningView {
  level: '30_day' | '7_day' | '1_day';
  days_remaining: number;
  expires_at: string;
  message: string;
}

/** The operation classes the entitlement allows, decided by the server. */
export interface LicenseAccessView {
  access: 'full' | 'read_only' | 'closed';
  permitted: string[];
  disabled: string[];
}

/** One imported entitlement, stated without its signature. */
export interface LicenseHistoryEntryView {
  license_id: string;
  not_before: string;
  expires_at: string;
  highest_eligible_release: string;
  imported_at: string;
  previous_license_id: string | null;
}

/** One durable record a licensing view states as evidence. */
export interface EvidenceRowView {
  evidence_id: string;
  operation: string;
  outcome: string;
  occurred_at: string;
  error_code?: string;
}

export interface LicenseView {
  status: 'valid' | 'expired' | 'invalid';
  license_id?: string;
  not_before?: string;
  expires_at?: string;
  highest_eligible_release?: string;
  days_remaining: number | null;
  warning: LicenseWarningView | null;
  error_code?: string;
  message?: string;
  release: string;
  deployment_id: string;
  state: string;
  access: LicenseAccessView;
  history: LicenseHistoryEntryView[];
  evidence: EvidenceRowView[];
  checked_at?: string;
}

/** The settled outcome of one offline import, beside the surface it leaves behind. */
export interface LicenseImportView extends LicenseView {
  license_id: string;
  previous_license_id: string | null;
  renewed: boolean;
  service_open: boolean;
  evidence_id: string;
}

/** One live Operator Console session, as the server states it. */
export interface OperatorSessionView {
  current: boolean;
  issued_at: string;
  expires_at: string;
}

export interface OperatorSessionListView {
  operator: string;
  sessions: OperatorSessionView[];
}

/** The settled recovery objectives every recovery view states as numbers. */
export interface RecoveryObjectivesView {
  rpo_limit_seconds: number;
  rto_limit_seconds: number;
  checkpoint_seconds: number;
  object_replication_seconds: number;
  base_backup_hours: number;
  retention_days: number;
}

export interface BackupHealthView {
  health: 'healthy' | 'degraded' | 'not_established';
  rpo_limit_seconds: number;
  last_checkpoint_id: string | null;
  last_checkpoint_at: string | null;
  checkpoint_age_seconds: number | null;
  last_rpo_seconds: number | null;
  rpo_met: boolean | null;
  reasons: string[];
  verification_health: 'healthy' | 'degraded';
  verification_reasons: string[];
}

export interface CheckpointSummaryView {
  checkpoint_id: string;
  sequence: number;
  created_at: string;
  coordinated: boolean;
  database_position: string;
  objects_position: string;
  objects_count: number;
  rpo_interval_seconds: number | null;
  rpo_limit_seconds: number;
  rpo_met: boolean | null;
  wal_continuous: boolean;
}

export interface RecoverySetSummaryView {
  backup_id: string;
  kind: string;
  created_at: string;
  deployment_id: string;
  checkpoint_id: string;
  components: number;
  retain_until: string;
  within_retention: boolean;
  age_seconds: number | null;
  purge_ledger_through_sequence: number;
}

export interface RecoveryComponentView {
  role: string;
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  restores_to: string;
}

export interface RecoveryManifestView {
  schema_version: number;
  backup_id: string;
  kind: string;
  created_at: string;
  deployment_id: string;
  release: string;
  payloads_encrypted: boolean;
  secrets_included: boolean;
  cadence: Record<string, string | number>;
  retention: { days: number; retain_until: string };
  checkpoint_id: string;
  purge_ledger: { through_sequence: number; entries: number; digest: string };
  components: RecoveryComponentView[];
  excluded: Array<{ name: string; rebuildable: boolean }>;
  escrowed_separately: { master_key: boolean };
}

export interface RecoverySetDetailView {
  manifest: RecoveryManifestView;
  integrity: { verified: boolean; checked: number };
  within_retention: boolean;
  age_seconds: number;
}

/** The verification evidence one drill or restoration reports, category by category. */
export interface RecoveryVerificationView {
  integrity: { passed: boolean; components: number; database_position: string };
  objects: { passed: boolean; count: number; verified: number; bytes: number };
  keys: { passed: boolean; data_key_unwrapped: boolean; sealed_credentials: number; decrypted: number };
  manifests: { passed: boolean; release: string; signature_verified: boolean };
  provenance: { passed: boolean; dataset_releases: number; batches: number; dangling: number };
  governed_reads: {
    passed: boolean;
    products: number;
    reads: Array<Record<string, unknown>>;
    purged_refusals: { confirmed: number; failed: number };
  };
  purge_ledger: {
    passed: boolean;
    applied_through_sequence: number;
    entries: number;
    purged_records: number;
    removed: number;
    already_absent: number;
  };
}

export interface RecoveryVerificationViewRow {
  verification_id: string;
  backup_id: string;
  verified: boolean;
  verification: RecoveryVerificationView;
  rto: { started_at: string; finished_at: string; seconds: number; limit_seconds: number; met: boolean };
  evidence: string;
  evidence_id: string;
}

export interface RestorationStepView {
  step: string;
  outcome: string;
  at: string;
}

/** The restored copy's own state, read from the restored Deployment itself. */
export interface RestorationTargetView {
  root: string;
  present: boolean;
  state: string | null;
  service_open: boolean;
  workers_enabled: boolean;
  connectivity_enabled: boolean;
}

export interface RestorationView {
  restoration_id: string;
  backup_id: string;
  deployment_id: string | null;
  release: string | null;
  state: 'running' | 'verified_open' | 'failed';
  requested_at: string;
  requested_by: string;
  step_up_verified_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: RestorationStepView[];
  verification: RecoveryVerificationView | null;
  purge_ledger: {
    applied_through_sequence: number;
    entries: number;
    purged_records: number;
    removed: number;
    already_absent: number;
  } | null;
  rto: { started_at: string; finished_at: string; seconds: number; limit_seconds: number; met: boolean } | null;
  workers_enabled: boolean;
  connectivity_enabled: boolean;
  service_open: boolean;
  error: { code: string; message: string; next_step?: string } | null;
  evidence_id: string | null;
  target: RestorationTargetView;
  changed?: boolean;
}

export interface RecoveryOverviewView {
  deployment_id: string;
  release: string;
  state: string;
  service_open: boolean;
  workers_enabled: boolean;
  connectivity_enabled: boolean;
  backup_root: string;
  restore_root: string;
  objectives: RecoveryObjectivesView;
  backup: BackupHealthView;
  checkpoints: CheckpointSummaryView[];
  recovery_sets: RecoverySetSummaryView[];
  ledger: { head_sequence: number; updated_at: string | null; entries: number };
  restorations: RestorationView[];
  checked_at: string;
}

export interface RecoveryRestorationList {
  restorations: RestorationView[];
}

export interface StepUpGrantView {
  step_up_grant: string;
  purpose: string;
  target: string;
  method: 'totp' | 'recovery_code';
  verified_at: string;
  expires_at: string;
}

/** The rollback window one upgrade opens until finalization or rollback closes it. */
export interface RollbackWindowView {
  open: boolean;
  eligible: boolean;
  from_release: string;
  to_release: string;
  upgrade_id: string;
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

export interface UpgradeRecordView {
  upgrade_id: string;
  attempt: number;
  status: string;
  from_release: string;
  to_release: string;
  checkpoint_id: string | null;
  bundle_fingerprint: string;
  started_at: string;
  updated_at: string;
  migrations: string[];
  store_schema_version: number;
  previous_images: { release: string; images: number };
  rollback_window: RollbackWindowView | null;
  verification: { passed: boolean; verified_at: string; evidence_id: string; checks: string[] } | null;
  finalization: { finalized_at: string; previous_release_removed: boolean; evidence_id: string } | null;
  rollback: {
    rolled_back_at: string;
    to_release: string;
    down_migrations: number;
    data_unchanged: boolean;
    records_after_upgrade: number;
    evidence_id: string;
  } | null;
  last_error: { code: string; message: string; at: string } | null;
}

export interface MigrationLedgerView {
  schema_version: number;
  store_schema_version: number;
  updated_at: string;
  migrations: Array<{
    id: string;
    from_release: string;
    to_release: string;
    state_schema_version: number;
    expand_only: boolean;
    applied_at: string;
    steps: Array<{ name: string; applied_at: string }>;
  }>;
}

export interface LifecycleEvidenceView {
  evidence_id: string;
  operation: string;
  outcome: string;
  occurred_at: string;
  error_code?: string;
}

export interface LifecycleJobView {
  kind: string;
  state: string;
  started_at: string;
  finished_at: string | null;
  error: ApiError | null;
  result: Record<string, unknown> | null;
}

export interface LifecycleView {
  deployment: { release: string; state: string; service_open: boolean };
  upgrade: UpgradeRecordView | null;
  ledger: MigrationLedgerView;
  rollback_window: RollbackWindowView | null;
  evidence: LifecycleEvidenceView[];
  job: LifecycleJobView | null;
  checked_at: string;
}

export interface PreflightView {
  passed: boolean;
  from_release: string;
  to_release: string;
  resumable: boolean;
  service_open: boolean;
  upgrade_path: { adjacent: boolean; declared: boolean; from: string; to: string; migration_id: string };
  bundle: {
    release: string;
    release_key_fingerprint: string;
    signature_verified: boolean;
    files: number;
    images: number;
  };
  previous_images: { release: string; images: number; archives: string[] };
  license: { eligible: boolean; highest_eligible_release: string };
  master_key: { valid: boolean };
  stores: { healthy: boolean; services: string[] };
  queues: { queued: number; running: number; pending_purges: number; pending: number };
  backups: { health: string; last_checkpoint_id: string | null; last_checkpoint_at: string | null };
  capacity: { measured: boolean; free_bytes: number | null; required_bytes: number; sufficient: boolean };
  checkpoint_required: boolean;
  evidence_id: string;
}

/** One verification check; a failed one states its governed error code. */
export interface UpgradeCheckView {
  passed: boolean;
  error_code?: string;
  [key: string]: unknown;
}

export interface VerifyView {
  passed: boolean;
  from_release: string;
  to_release: string;
  store_schema_version: number;
  migrations: { applied: string[]; expand_only: boolean; destructive: number };
  checks: Record<string, UpgradeCheckView>;
  rollback_window: RollbackWindowView | null;
  evidence_id: string;
}

export interface FinalizeView {
  upgrade_id: string;
  from_release: string;
  to_release: string;
  rollback_eligible: boolean;
  changed: boolean;
  rollback_window: RollbackWindowView | null;
  cleanup: { previous_release: string; removed: boolean };
  finalization: { finalized_at: string; previous_release_removed: boolean; evidence_id: string };
  evidence_id: string;
  step_up_verified_at: string;
}

export interface RollbackView {
  upgrade_id: string;
  from_release: string;
  to_release: string;
  release: string;
  state: string;
  service_open: boolean;
  down_migrations: number;
  state_schema_version: number;
  data_unchanged: boolean;
  records_after_upgrade: number;
  previous_images: { release: string; images: number; archives: string[] };
  offline: boolean;
  rollback_window: RollbackWindowView;
  evidence_id: string;
  step_up_verified_at: string;
}

export interface LifecyclePreflightRequest {
  bundle: string;
  release_key: string;
  confirm_release_key_fingerprint: string;
  license?: string;
}

/** A consequential lifecycle action proves the Operator with password and MFA. */
export interface LifecycleStepUpRequest {
  password: string;
  totp?: string;
  recovery_code?: string;
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

/** What an Agent Identity may do; it consumes governed data and nothing else. */
export interface AgentIdentityCapabilities {
  consumes_data_products: boolean;
  administrative_authority: boolean;
  raw_data_access: boolean;
  owns_artifacts: boolean;
}

/** One pre-registered OAuth client; its secret is never part of any view. */
export interface AgentClientView {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
  revoked_at: string | null;
}

/** One delegated consent, with the role that bounds it right now. */
export interface AgentDelegationView {
  delegation_id: string;
  workspace_id: string;
  workspace_name: string | null;
  user_id: string;
  username: string | null;
  role: WorkspaceRoleValue | null;
  status: 'active' | 'inactive';
  created_at: string;
  revoked_at: string | null;
}

export interface AgentIdentityView {
  agent_identity_id: string;
  name: string;
  workspace_ids: string[];
  workspaces: Array<{ workspace_id: string; name: string }>;
  scopes: string[];
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
  capabilities: AgentIdentityCapabilities;
  active_grant_count: number;
  clients: AgentClientView[];
  delegations: AgentDelegationView[];
}

export interface AgentIdentityList {
  agent_identities: AgentIdentityView[];
}

/** One client registration answers its secret exactly once. */
export interface AgentClientCreated {
  client_id: string;
  client_name: string;
  client_secret: string;
  redirect_uris: string[];
  agent_identity_id: string;
  created_at: string;
}

/** One Data Product Grant narrowing an Agent Identity inside a Workspace. */
export interface AgentGrantView {
  grant_id: string;
  data_product_id: string;
  data_product_name: string;
  columns: string[] | null;
  row_filters: Array<{ field: string; op: string; value: string | number | null }>;
  created_at: string;
}

/** One Agent Identity as the active Workspace administers its access. */
export interface WorkspaceAgentView {
  agent_identity_id: string;
  name: string;
  scopes: string[];
  status: 'active' | 'revoked';
  created_at: string;
  grants: AgentGrantView[];
  delegations: AgentDelegationView[];
}

export interface WorkspaceAgentAccessView {
  workspace_id: string;
  workspace_name: string;
  agents: WorkspaceAgentView[];
  data_products: Array<{ data_product_id: string; name: string }>;
}

export interface WorkspaceAgentDelegationRecorded {
  delegation_id: string;
  workspace_id: string;
  agent_identity_id: string;
  user: { user_id: string; username: string | null };
  created_at: string;
  revoked_at: string | null;
  already_existing?: boolean;
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
  /** The delegated User beside the Actor, when the operation acted under consent. */
  delegated_user: string | null;
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

export interface DataProductMetricView {
  name: string;
  aggregation: string;
  value_type: string;
  field?: string;
  unit: string | null;
  currency: string | null;
  definition?: string;
  favorable_direction?: string | null;
  dimensions: string[];
}

/** The search capability a Contract publishes to one reader, or null when a Grant hides it. */
export interface DataProductSearchView {
  text_field: string;
  title_field?: string;
  suggest_fields: string[];
  ranking: { kind: string; title_weight: number; text_weight: number };
  max_terms: number;
  min_term_length: number;
}

export interface DataProductRelationshipView {
  name: string;
  description: string | null;
  cardinality: 'one' | 'many';
  on: Record<string, string>;
  fields: Array<{ name: string; description?: string }>;
  grain: string[];
  filters: string[];
  limit: number;
}

/** One authorized published Data Product and the Contract metadata a Consumer may see. */
export interface DataProductSummary {
  data_product_id: string;
  name: string;
  api_path: string;
  title: string;
  fields: string[];
  dimensions: string[];
  metrics: DataProductMetricView[];
  grain: string[];
  time: { field: string; precision: 'date' | 'timestamp'; time_zone: string } | null;
  filters: string[];
  field_types: Record<string, string>;
  search: DataProductSearchView | null;
  limits: { max_scanned_records: number; max_groups: number; max_execution_ms: number };
  default_limit: number;
  max_limit: number;
  relationships: DataProductRelationshipView[];
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_version: { major: number; minor: number };
}

export interface DataProductList {
  workspace_id: string;
  data_products: DataProductSummary[];
}

/** One exact Release a Consumer may read, and the Contract line it served. */
export interface ProductReleaseView {
  release: number;
  data_product_version: number;
  contract_version: { major: number; minor: number } | null;
  withdrawn: boolean;
  dataset_release: number;
  relationships: Array<{ name: string; dataset_id: string; dataset_release: number }>;
  created_at: string;
  current: boolean;
  retention_expired: boolean;
}

export interface ProductReleaseList {
  data_product_id: string;
  name: string;
  api_path: string;
  lines: Array<{
    major: number;
    current_version: number;
    current_release: number;
    opened_at: string;
    withdrawn_at: string | null;
  }>;
  releases: ProductReleaseView[];
}

/** One scalar value exactly as the governed answer states it; missing values are null. */
export type ProductScalar = string | number | null;

/** One window the answer evaluated, with the coverage the pinned Release holds. */
export interface ProductQueryWindowView {
  field: string;
  precision: 'date' | 'timestamp';
  time_zone: string;
  start: string;
  end: string;
  coverage: { start: string; end: string } | null;
  partial: boolean;
  period?: 'day' | 'week';
  complete?: boolean;
  same_elapsed_interval?: boolean;
}

/** One metric compared beside the window it was read against. */
export interface ProductComparedMetric {
  value: ProductScalar;
  change: string | number | null;
  change_percent: string | null;
  change_percent_reason?: string;
  direction?: 'up' | 'down' | 'flat';
  judgment?: 'favorable' | 'adverse' | 'neutral';
}

export interface ProductQueryGroup {
  group: Record<string, ProductScalar>;
  null_dimensions: string[];
  metrics: Record<string, ProductScalar>;
  comparison?: Record<string, ProductComparedMetric>;
}

export interface ProductQueryProvenance {
  source: { source_id: string; name: string | null };
  dataset_release: number;
  integration_configuration_version: number;
  business_context: Record<string, number>;
  record_count: number | null;
  permitted_record_count?: number;
  acquired_at: string;
  integrated_at: string;
  released_at: string;
  relationships: Array<{
    name: string;
    cardinality: 'one' | 'many';
    source: { source_id: string; name: string | null };
    dataset_id: string;
    dataset_release: number;
    integration_configuration_version: number;
    business_context: Record<string, number>;
    record_count: number;
    acquired_at: string;
    integrated_at: string;
    released_at: string;
  }>;
}

/** One governed Data Product Query answer, whichever Contract kind it read. */
export interface ProductQueryAnswer {
  data_product_id: string;
  name: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  contract_version: { major: number; minor: number };
  contract_hash: string;
  kind: 'records' | 'search' | 'suggest' | 'aggregate';
  columns?: string[];
  records?: Array<Record<string, unknown>>;
  linked?: string[];
  matched_count?: number;
  suggestions?: Array<{ value: string; count: number }>;
  grouped_by?: string[];
  metrics?: DataProductMetricView[];
  groups?: ProductQueryGroup[];
  totals?: { metrics: Record<string, ProductScalar>; comparison?: Record<string, ProductComparedMetric> } | null;
  groups_total?: number;
  returned: number;
  truncated?: boolean;
  next_cursor: string | null;
  limit: number;
  scanned_records: number;
  window: ProductQueryWindowView | null;
  comparison_window?: ProductQueryWindowView | null;
  provenance: ProductQueryProvenance;
  cache?: { reused: boolean };
}

/** One window a Natural-Language Query answer evaluated, with the release coverage. */
export interface NlqWindowView {
  field: string;
  precision: string;
  time_zone: string;
  start: string;
  end: string;
  coverage: { start: string; end: string } | null;
  partial: boolean;
}

/** The interpretation the deterministic layer resolved for one part. */
export interface NlqResolvedView {
  interpretation: string;
  metrics: string[];
  dimensions: string[];
  filters: Array<Record<string, unknown>>;
  window: NlqWindowView | null;
  comparison_window: NlqWindowView | null;
  partial_period: boolean;
  defaults_applied: Array<{ name: string; value: unknown }>;
}

/** The permitted lineage one executed part cites, never chain-of-thought. */
export interface NlqProvenanceView {
  source: { source_id: string; name: string | null };
  dataset_release: number;
  integration_configuration_version: number;
  business_context: Record<string, number>;
  record_count: number | null;
  acquired_at: string;
  integrated_at: string;
  released_at: string;
  relationships: Array<Record<string, unknown>>;
}

/** The deterministic result one part may return under its Contract kind. */
export interface NlqResultView {
  kind: string;
  columns?: string[];
  records?: Array<Record<string, unknown>>;
  matched_count?: number;
  suggestions?: Array<{ value: string; count: number }>;
  grouped_by?: string[];
  metrics?: Array<{ name: string; description?: string }>;
  groups?: ProductQueryGroup[];
  totals?: { metrics: Record<string, ProductScalar>; comparison?: Record<string, ProductComparedMetric> } | null;
  groups_total?: number;
  returned?: number;
  window?: NlqWindowView | null;
  comparison_window?: NlqWindowView | null;
}

/** One independent part of an answer, with its own Release, freshness, and evidence. */
export interface NlqPartView {
  name: string | null;
  data_product: Record<string, unknown> | null;
  status?: string;
  outcome: string;
  executed: boolean;
  reason_code: string | null;
  interpretation: string | null;
  query: Record<string, unknown> | null;
  resolved: NlqResolvedView | null;
  result: NlqResultView | null;
  window: NlqWindowView | null;
  comparison_window: NlqWindowView | null;
  partial_period: boolean;
  defaults_applied: Array<{ name: string; value: unknown }>;
  provenance: NlqProvenanceView | null;
  freshness: { acquired_at: string | null; integrated_at: string | null; released_at: string | null; data_through: string | null } | null;
  evidence: Record<string, unknown> | null;
  limitations: string[];
}

/** One part's own Release and as-of facts, disclosed beside the compound answer. */
export interface NlqAsOfView {
  name: string | null;
  data_product_id: string | null;
  data_product_release: number | null;
  executed: boolean;
  released_at: string | null;
  data_through: string | null;
}

/** One governed Natural-Language Query turn, exactly as the server answered it. */
export interface NaturalLanguageAnswerView {
  outcome: 'answered' | 'clarification' | 'empty' | 'no_evidence' | 'unavailable' | 'refused' | 'partial';
  status: 'complete' | 'incomplete';
  workspace_id: string;
  question: string;
  normalized_question: string;
  follow_up: boolean;
  origin: 'stock' | 'generated';
  stock: {
    report_id: string;
    reused: boolean;
    generated_at: string;
    age_minutes: number;
    max_age_minutes: number;
  } | null;
  report: Record<string, unknown> | null;
  template: Record<string, unknown> | null;
  authorization: {
    workspace_id: string;
    role: string;
    parts: Array<{
      data_product_id: string;
      restricted: boolean;
      columns: string[];
      row_filter_count: number;
      scope_fingerprint: string;
    }>;
  } | null;
  reason_code: string | null;
  executed: boolean;
  summary: string;
  limitations: string[];
  data_product: Record<string, unknown> | null;
  parts: NlqPartView[];
  as_of: NlqAsOfView[];
  interpretation: string | null;
  resolved: NlqResolvedView | null;
  clarification: {
    question: string;
    missing: string[];
    candidates: string[];
    part: { name: string; data_product_id: string } | null;
  } | null;
  query: Record<string, unknown> | null;
  result: NlqResultView | null;
  answer: { narrative: string; evidence_refs: Array<Record<string, unknown>>; model: Record<string, unknown> } | null;
  window: NlqWindowView | null;
  comparison_window: NlqWindowView | null;
  partial_period: boolean;
  defaults_applied: Array<{ name: string; value: unknown }>;
  provenance: NlqProvenanceView | null;
  freshness: NlqPartView['freshness'];
  conversation: string | null;
}

/** One typed parameter an exact Report Template Version pinned. */
export interface ReportParameterView {
  name: string;
  type: string;
  value: unknown;
}

/** The exact Template a stocked Report was generated from. */
export interface ReportTemplateReferenceView {
  report_template_id: string;
  name: string;
  version: number;
  content_hash: string;
  owner_user_id: string;
}

/** The exact Data Product Releases a stocked Report pins. */
export interface ReportProductReferenceView {
  data_product_id: string;
  name: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_version: { major: number; minor: number };
  contract_hash: string;
}

/** How complete the governed answer a stocked Report really is. */
export interface ReportCompletionView {
  status: 'complete' | 'incomplete';
  outcome: 'answered' | 'empty' | 'no_evidence';
  partial_period: boolean;
  truncated: boolean;
  limitations: string[];
}

/** The optional grounded narrative stored beside the structured result. */
export interface ReportNarrativeView {
  narrative: string;
  evidence_refs: Array<Record<string, unknown>>;
  grounded_answer_prompt_hash: string;
  prompt_hash: string;
  model: Record<string, unknown>;
}

/** The authorization scope a Report was generated under and is reauthorized against. */
export interface ReportSecurityView {
  scope_fingerprint: string;
  restricted: boolean;
  columns: string[];
  row_filter_count: number;
}

/** One immutable stocked Report exactly as the server preserved it. */
export interface ReportView {
  report_id: string;
  workspace_id: string;
  template: ReportTemplateReferenceView;
  data_product: ReportProductReferenceView;
  question: string;
  normalized_question: string;
  parameters: ReportParameterView[];
  interpretation: string;
  query: Record<string, unknown>;
  result: NlqResultView;
  narrative: ReportNarrativeView | null;
  provenance: NlqProvenanceView | null;
  freshness: NlqPartView['freshness'];
  completion: ReportCompletionView;
  security: ReportSecurityView;
  freshness_policy: { max_age_minutes: number };
  generated_at: string;
  generated_by: string;
  withdrawn_at: string | null;
  withdrawn_by: string | null;
}

/** The current effective authorization one Report response is answered under. */
export interface ReportAuthorizationView {
  workspace_id: string;
  role: string;
  parts: Array<{
    data_product_id: string;
    restricted: boolean;
    columns: string[];
    row_filter_count: number;
    scope_fingerprint: string;
  }>;
}

/** One entry of the authorized Report library. */
export interface ReportListViewEntry {
  report_id: string;
  template: ReportTemplateReferenceView;
  data_product: ReportProductReferenceView;
  question: string;
  generated_at: string;
  completion: ReportCompletionView;
  withdrawn_at: string | null;
  age_minutes: number;
  max_age_minutes: number;
  fresh: boolean;
}

export interface ReportListResponse {
  origin: 'stock';
  workspace_id: string;
  reports: ReportListViewEntry[];
  authorization: ReportAuthorizationView;
}

/** One retrieval: it returns stored content and never regenerates it. */
export interface ReportRetrievalResponse {
  origin: 'stock';
  summary: string;
  report: ReportView;
  withdrawn: boolean;
  stock: {
    report_id: string;
    reused: boolean;
    generated_at: string;
    age_minutes: number;
    max_age_minutes: number;
    fresh: boolean;
  };
  authorization: ReportAuthorizationView;
}

/** One explicit generation from the exact published Template Version. */
export interface ReportGenerationResponse {
  origin: 'generated';
  summary: string;
  report: ReportView;
  authorization: ReportAuthorizationView;
}

/** One published Report Template Version, with every pinned semantic. */
export interface ReportTemplateView {
  report_template_id: string;
  workspace_id: string;
  name: string;
  owner: { user_id: string; username: string | null };
  published_version: number | null;
  template_version: number;
  content_hash: string;
  question: string;
  normalized_question: string;
  interpretation: string;
  parameters: ReportParameterView[];
  data_product_id: string;
  contract_major: number;
  query: Record<string, unknown>;
  grounded_prompt: { id: string; body: string; hash: string };
  freshness_policy: { max_age_minutes: number };
  published_at: string;
  published_by: string;
  withdrawn_at: string | null;
}

/** One Template summary the administrator's list states. */
export interface ReportTemplateSummaryView {
  report_template_id: string;
  name: string;
  owner: { user_id: string; username: string | null };
  published_version: number | null;
  question?: string;
  normalized_question?: string;
  interpretation?: string;
  parameters?: ReportParameterView[];
  data_product_id?: string;
  contract_major?: number;
  query?: Record<string, unknown>;
  grounded_prompt?: { id: string; body: string; hash: string };
  freshness_policy?: { max_age_minutes: number };
  content_hash?: string;
  published_at?: string;
  withdrawn_at?: string | null;
}

export interface ReportTemplateListResponse {
  workspace_id: string;
  report_templates: ReportTemplateSummaryView[];
}

/** The settled local embedding configuration one nomination was scored under. */
export interface ReviewEmbeddingConfigurationView {
  model_id: string;
  revision: string;
  dimensions: number;
  normalization: string;
  metric: string;
}

/** One similar Chinese QA pair a review item nominates; never an equivalence. */
export interface ReviewSimilarityNominationView {
  kind: 'report_template' | 'review_candidate';
  target_id: string;
  question: string;
  score: number;
}

/** One decision a reviewer recorded on a review item. */
export interface ReportCandidateDecisionView {
  decided_at: string;
  decided_by: string;
  reason: string | null;
}

/** The one durable notification an open review item sent its reviewer. */
export interface ReportCandidateNotificationView {
  notified_at: string;
  reason: 'created' | 'reopened';
}

/** One deduplicated review item, exactly as the server preserved it. */
export interface ReportCandidateView {
  candidate_id: string;
  workspace_id: string;
  status: 'open' | 'approved' | 'rejected';
  question: string;
  normalized_question: string;
  semantic_hash: string;
  data_product_id: string;
  report_template_id: string;
  template_version: number;
  report_id: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  requested_by: Array<{ user_id: string; username: string | null }>;
  similarity: {
    configuration: ReviewEmbeddingConfigurationView;
    threshold: number;
    nominations: ReviewSimilarityNominationView[];
  };
  notification: ReportCandidateNotificationView | null;
  approval: ReportCandidateDecisionView | null;
  rejection: ReportCandidateDecisionView | null;
}

export interface ReportCandidateListResponse {
  workspace_id: string;
  summary: string;
  candidates: ReportCandidateView[];
}

/** The exact reviewed Template Version and Report one candidate names. */
export interface ReportCandidateEvidenceResponse {
  summary: string;
  candidate: ReportCandidateView;
  template: ReportTemplateView;
  report: ReportView;
}

export interface ReportCandidateDecisionResponse {
  summary: string;
  candidate: ReportCandidateView;
  template?: ReportTemplateView;
  report?: ReportView;
}

/** One evaluation of one due Report schedule, coalescing every due instant. */
export interface ReportScheduleRunView {
  run_id: string;
  schedule_id: string;
  template_version: number;
  triggered_at: string;
  due_from: string;
  due_count: number;
  catch_up: boolean;
  designated_user_id: string;
  outcome: 'generated' | 'reused' | 'failed';
  report_id: string | null;
  reason_code: string | null;
  limitation: string | null;
  scope_fingerprint: string | null;
}

/** One durable Report schedule naming its designated Consumer and interval. */
export interface ReportScheduleView {
  schedule_id: string;
  workspace_id: string;
  report_template_id: string;
  template_version: number;
  designated_user_id: string;
  designated_username: string | null;
  interval_minutes: number;
  next_due_at: string;
  created_at: string;
  created_by: string;
  state: 'active' | 'paused' | 'withdrawn';
  paused_at: string | null;
  paused_by: string | null;
  resumed_at: string | null;
  resumed_by: string | null;
  withdrawn_at: string | null;
  runs: ReportScheduleRunView[];
}

export interface ReportScheduleListResponse {
  workspace_id: string;
  summary: string;
  schedules: ReportScheduleView[];
}

export interface ReportScheduleResponse {
  summary: string;
  already_paused?: boolean;
  already_running?: boolean;
  schedule: ReportScheduleView;
}

export interface ReportScheduleTickResponse {
  at: string;
  summary: string;
  paused_skipped: number;
  runs: ReportScheduleRunView[];
}

/** One withdrawal: a lifecycle fact that preserves the governed history. */
export interface ReportWithdrawalResponse {
  summary: string;
  report_id?: string;
  report_template_id?: string;
  template_version?: number;
  withdrawn_at: string;
  already_withdrawn: boolean;
}

export interface ProductExportCreated {
  export_id: string;
  workspace_id: string;
  data_product_id: string;
  data_product_release: number;
  content_type: string;
  columns: string[];
  row_count: number;
  content_hash: string;
  object_path: string;
  created_at: string;
  expires_at: string;
}

/** One Data Product Grant in force, narrowed to a member or an Agent Identity. */
export interface ProductGovernanceGrantView {
  grant_id: string;
  grantee_type: 'user' | 'agent';
  grantee: string | null;
  columns: string[] | null;
  row_filters: Array<{ field: string; op: string; value: string | number | null }>;
  created_at: string;
}

/** The freshness and Provenance one Data Product Release pinned. */
export interface ProductReleaseFreshnessView {
  dataset_id: string;
  dataset_release: number;
  record_count: number;
  records_hash: string;
  schema_hash: string;
  integration_configuration_version: number;
  released_at: string;
  acquired_at: string;
  integrated_at: string;
  provenance: {
    batch_ids: string[];
    acquisition_run_ids: string[];
    raw_acquisition_ids: string[];
    acquired_at: string;
    integrated_at: string;
    released_at: string;
  };
}

/** One exact Data Product Release and the Dataset Release it pinned. */
export interface ProductGovernanceReleaseView {
  release: number;
  data_product_version: number;
  contract_version: { major: number; minor: number } | null;
  contract_hash: string | null;
  withdrawn: boolean;
  current: boolean;
  created_at: string;
  created_by: string;
  dataset_id: string;
  dataset_release: number;
  relationships: Array<{ name: string; dataset_id: string; dataset_release: number }>;
  retention_expired: boolean;
  freshness: ProductReleaseFreshnessView | null;
}

/** One exact Data Product Version, its Contract, and the actions it permits. */
export interface ProductGovernanceVersionView {
  version: number;
  contract_version: { major: number; minor: number };
  published_at: string;
  published_by: string;
  contract_hash: string;
  withdrawn_at: string | null;
  withdrawn: boolean;
  current: boolean;
  release: number | null;
  dataset_release: number | null;
  change: 'initial' | 'additive' | 'breaking';
  breaking: string[];
  contract: ProductContractView;
  actions: {
    withdraw: { enabled: boolean; consequence: string };
    rollback: { enabled: boolean; consequence: string };
  };
}

/** One recorded Rollback fact: an exact earlier Version a line returned to. */
export interface ProductRollbackHistoryView {
  rollback_id: string;
  major: number;
  from_version: number;
  from_release: number;
  to_version: number;
  to_release: number;
  created_at: string;
  created_by: string;
  actor: string | null;
}

/** The complete administrator governance answer for one Data Product. */
export interface ProductGovernanceView {
  data_product_id: string;
  workspace_id: string;
  name: string;
  api_path: string;
  lines: Array<{
    major: number;
    current_version: number;
    current_release: number;
    opened_at: string;
    withdrawn_at: string | null;
  }>;
  active_major: number | null;
  versions: ProductGovernanceVersionView[];
  releases: ProductGovernanceReleaseView[];
  grants: ProductGovernanceGrantView[];
  members: Array<{ username: string; role: WorkspaceRoleValue }>;
  agents: Array<{ agent_identity_id: string; name: string; scopes: string[] }>;
  rollbacks: ProductRollbackHistoryView[];
  published_columns: string[];
  published_filters: string[];
  latest: {
    data_product_version: number;
    contract_version: { major: number; minor: number };
    data_product_release: number | null;
    dataset_release: number | null;
    contract: ProductContractView;
  } | null;
}

/** The exact next Contract version and Consumer consequences of a revision. */
export interface ProductEvolutionPreviewView {
  data_product_id: string;
  name: string;
  api_path: string;
  base: {
    data_product_version: number;
    contract_version: { major: number; minor: number };
    data_product_release: number;
    dataset_release: number;
  };
  candidate: {
    contract: ProductContractView;
    contract_hash: string;
    contract_version: { major: number; minor: number };
    change: 'additive' | 'breaking';
    breaking: string[];
  };
  consequences: string[];
}

export interface ProductEvolutionPublicationView {
  data_product_id: string;
  name: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_version: { major: number; minor: number };
  contract_hash: string;
  change: 'additive' | 'breaking';
  breaking: string[];
}

export interface ProductRollbackView {
  data_product_id: string;
  rollback_id?: string;
  contract_major: number;
  from_version?: number;
  from_release?: number;
  data_product_version: number;
  data_product_release: number;
  dataset_release?: number;
  contract_version: { major: number; minor: number };
  rolled_back_at?: string;
  serves_default_queries?: boolean;
  already_current?: boolean;
}

export interface ProductWithdrawalView {
  data_product_id: string;
  data_product_version: number;
  withdrawn_at?: string;
  contract_version?: { major: number; minor: number };
  already_withdrawn?: boolean;
}

/** One governed curated-result export as its Workspace administers it. */
export interface WorkspaceExportView {
  export_id: string;
  data_product_id: string;
  data_product_name: string | null;
  data_product_release: number;
  producer: string | null;
  created_at: string;
  expires_at: string;
  status: 'active' | 'expired' | 'revoked';
  revoked_at: string | null;
  row_count: number;
  columns: string[];
  row_filters: Array<{ field: string; op: string; value: string | number | null }>;
  content_hash: string;
  downloaded_at: string | null;
  can_download: boolean;
}

export interface WorkspaceExportList {
  workspace_id: string;
  exports: WorkspaceExportView[];
}

export interface WorkspaceExportDownload {
  export_id: string;
  data_product_id: string;
  data_product_release: number;
  content_type: string;
  encoding: 'base64';
  content: string;
  content_hash: string;
  columns: string[];
  row_count: number;
  expires_at: string;
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
  mode?: string;
  trigger: string;
  status: string;
  attempts: number;
  backfill?: { start: string; end: string } | null;
  rerun_of?: string | null;
  queued_at: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  integration_configuration_version: number | null;
  error_code?: string | null;
}

/** One immutable acquisition configuration Version a connector Source pins. */
export interface AcquisitionConfigurationVersionView {
  version: number;
  published_at: string;
  content_hash: string;
  connection_id: string;
  connection_version: number;
  connector: { name: string; version: number };
  path: string;
  record_path: string | null;
  completion: { kind: string; flag?: string; done_value?: boolean };
  window: AcquisitionWindowView | null;
  content_type: string | null;
}

export interface AcquisitionWindowView {
  mode: string;
  start_parameter: string;
  end_parameter: string;
  initial_start: string;
  initial_end: string | null;
  maximum_span_minutes: number;
  lookback_minutes: number;
  time_zone: string;
  end_inclusive: boolean;
}

/** The durable resume point a completed attempt advances and a failure leaves alone. */
export interface AcquisitionCheckpointView {
  watermark: string | null;
  cursor: string | null;
  cursor_state: 'valid' | 'invalid';
  updated_at: string | null;
  generation: number;
}

/** One Connection Version as the browser reads it; the credential value is absent. */
export interface ConnectionVersionView {
  version: number;
  base_url: string;
  credential_ref: string;
  has_credential: boolean;
  auth_scheme: string;
  retry: {
    max_attempts: number;
    base_delay_ms: number;
    max_delay_ms: number;
    retry_on: number[];
  };
  pacing: {
    serialization: boolean;
    minimum_interval_seconds: number;
    maximum_requests_per_minute: number | null;
    maximum_concurrent_runs: number;
  };
  schedule: { every_minutes: number; start_tolerance_seconds: number } | null;
  publication_targets: { p95_seconds: number; p99_seconds: number } | null;
  content_hash: string;
}

export interface ConnectionView {
  connection_id: string;
  name: string;
  adopted_version: number | null;
  versions: ConnectionVersionView[];
}

export interface ConnectionList {
  workspace_id: string;
  connections: ConnectionView[];
}

/** A guided Connection review; it names the credential reference, never the secret. */
export interface ConnectionPreview {
  valid: boolean;
  name?: string;
  declaration?: Record<string, unknown>;
  credential_ref?: string;
  has_credential?: boolean;
  content_hash?: string;
  errors: Array<{ code: string; message?: string }>;
}

export interface ConnectionPublicationView {
  connection_id: string;
  workspace_id: string;
  name: string;
  connection_version: number;
  base_url: string;
  credential_ref: string;
  has_credential: boolean;
  auth: Record<string, unknown>;
  retry: ConnectionVersionView['retry'];
  pacing: ConnectionVersionView['pacing'];
  pagination: Record<string, unknown>;
  schedule: ConnectionVersionView['schedule'];
  publication_targets: ConnectionVersionView['publication_targets'];
  content_hash: string;
  published_at: string;
}

export interface SourceAcquisitionConfigurationPreview {
  valid: boolean;
  declaration?: Record<string, unknown>;
  content_hash?: string;
  errors: Array<{ code: string; message?: string }>;
}

export interface SourceAcquisitionConfigurationPublicationView {
  source_id: string;
  acquisition_configuration_version: number;
  connection_id: string;
  connection_version: number;
  connector: { name: string; version: number };
  path: string;
  record_path: string | null;
  completion: AcquisitionConfigurationVersionView['completion'];
  window: AcquisitionWindowView | null;
  content_type: string | null;
  content_hash: string;
}

export interface AcquisitionRunQueuedView {
  source_id: string;
  acquisition_run_id: string;
  status: string;
  trigger: string;
  backfill: { start: string; end: string } | null;
  rerun_of: string | null;
  queued_at: string;
}

export interface AcquisitionRunWorkView {
  acquisition_run_id: string;
  status: string;
  trigger: string;
  paced?: boolean;
  pacing_reason?: 'fifo' | 'serialization' | 'concurrency' | 'interval' | 'rate' | null;
  queue_position?: number;
  not_before?: string | null;
  plan: AcquisitionPlanRecordView | null;
  raw_acquisition_count: number;
  raw_acquisition_ids: string[];
  batch_raw_acquisition_count: number | null;
  integration_batch_id: string | null;
  dataset_release: number | null;
  records: number | null;
  error_code?: string | null;
}

export interface AcquisitionPlanPageView {
  page: number;
  raw_id: string | null;
  outcome: 'received' | 'empty' | 'failed';
  record_count: number | null;
  error_code: string | null;
  attempts: number;
  failed_attempts: Array<{
    raw_id: string | null;
    status: number | null;
    error_code: string;
    retry_after_ms: number | null;
  }>;
}

export interface AcquisitionPlanWindowView {
  mode: string;
  start: string;
  end: string;
  lookback_minutes: number;
  end_inclusive: boolean;
  captured_at: string;
}

export interface AcquisitionPlanRecordView {
  plan_id: string;
  status: 'planned' | 'complete' | 'partial' | 'failed';
  trigger: string;
  connector: { name: string; version: number };
  connection_id: string;
  connection_version: number;
  acquisition_configuration_version: number;
  integration_configuration_version: number;
  pages: AcquisitionPlanPageView[];
  window: AcquisitionPlanWindowView | null;
  start_cursor: string | null;
  checkpoint_before: { watermark: string | null; cursor: string | null } | null;
  checkpoint_after: { watermark: string | null; cursor: string | null } | null;
  end_cursor: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AcquisitionPlanView {
  source_id: string;
  acquisition_run_id: string;
  plan: AcquisitionPlanRecordView;
  raw_acquisitions: Array<{
    raw_id: string;
    content_hash: string;
    byte_length: number;
    received_at: string;
  }>;
}

export interface ConnectionSessionView {
  connection_id: string;
  workspace_id: string;
  connection_version: number | null;
  auth_scheme: string | null;
  state: 'active' | 'intervention_required';
  has_access_token: boolean;
  has_cookie: boolean;
  cookie_name: string | null;
  issued_at: string | null;
  expires_at: string | null;
  generation: number;
  updated_at: string | null;
}

export interface ConnectionPacingView {
  connection_id: string;
  workspace_id: string;
  queue: Array<{ acquisition_run_id: string; source_id: string; enqueued_at: string; not_before: string | null }>;
  active: Array<{ acquisition_run_id: string; source_id: string; started_at: string }>;
  last_finished_at: string | null;
  requests_last_minute: number;
  updated_at: string | null;
  policy: ConnectionVersionView['pacing'] | null;
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
  acquisition: {
    adopted_version: number | null;
    checkpoint: AcquisitionCheckpointView | null;
    versions: AcquisitionConfigurationVersionView[];
    connection: {
      connection_id: string;
      name: string;
      adopted_version: number | null;
      versions: ConnectionVersionView[];
    } | null;
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

/** One Chinese clarification the administrator recorded before generation. */
export interface ProposalClarificationView {
  question: string;
  answer: string;
}

/** The requirement and clarifications one Proposal was generated from. */
export interface ProposalRequirementView {
  text: string;
  clarifications: ProposalClarificationView[];
  hash: string;
}

export interface ProposalTransformationView {
  raw_id: string;
  row: number;
  field: string;
  rule: string;
  before: string;
  after: string;
}

export interface ProposalRejectionView {
  raw_id: string;
  row: number;
  field: string | null;
  rule: string;
  reason: string;
}

/** What a candidate would change relative to its base and a real source table. */
export interface ProposalDriftView {
  base_present: boolean;
  schema: {
    added: string[];
    removed: string[];
    retyped: Array<{ field: string; from: string; to: string }>;
  };
  cleaning: { added: string[]; removed: string[] };
  mapping: {
    added: string[];
    removed: string[];
    retargeted: Array<{ column: string; from: string; to: string }>;
  };
  raw_columns: { unmapped: string[]; missing: string[] };
}

export interface ProposalValidationFixtureView {
  name: string;
  record_count: number;
  transformed: number;
  rejected: number;
  transformations: ProposalTransformationView[];
  rejections: ProposalRejectionView[];
  drift: ProposalDriftView;
}

export interface ProposalValidationView {
  validated_at: string;
  validated_by: string;
  evidence_hash: string;
  fixtures: ProposalValidationFixtureView[];
}

/** What one deterministic validation run answers to the browser. */
export interface ProposalValidationResult {
  proposal_id: string;
  status: ProposalView['status'];
  validated_at: string;
  fixtures: ProposalValidationFixtureView[];
  evidence_hash: string;
}

/** What one isolated preview answers to the browser. */
export interface ProposalPreviewResult {
  proposal_id: string;
  status: ProposalView['status'];
  preview: ProposalPreviewView;
}

export interface ProposalPreviewView {
  raw_id: string;
  record_count: number;
  transformed: number;
  rejected: number;
  transformations: ProposalTransformationView[];
  rejections: ProposalRejectionView[];
  evidence_hash: string;
  drift: ProposalDriftView;
}

/** The exact lineage every Approval, Publication, and Adoption restates. */
export interface ProposalProvenanceView {
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  adapter: string;
  model_id: string;
  binding_id: string;
  prompt_id: string;
  prompt_hash: string;
  requirement_hash?: string;
  data_dictionary_hash: string;
  validation_hash: string;
  preview_hash: string;
  candidate_content_hash: string;
  proposal_hash: string;
}

export interface ProposalLifecycleDecisionView {
  decided_at: string;
  decided_by: string;
  outcome: 'approved' | 'rejected';
  reason: string | null;
  evidence_hash: string;
  provenance: ProposalProvenanceView;
}

export interface ProposalLifecyclePublicationView {
  published_at: string;
  published_by: string;
  integration_configuration_version: number;
  evidence_hash: string;
  provenance: ProposalProvenanceView;
}

export interface ProposalLifecycleAdoptionView {
  adopted_at: string;
  adopted_by: string;
  integration_configuration_version: number;
  previous_adopted_version: number | null;
  evidence_hash: string;
  provenance: ProposalProvenanceView;
}

/** One Artifact Proposal as the browser inspects and decides it. */
export interface ProposalView {
  proposal_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'published' | 'adopted';
  workspace_id: string;
  source_id: string;
  binding_id: string;
  created_at: string;
  created_by: string;
  requirement?: ProposalRequirementView;
  freshness?: { fresh: boolean; current: { integration_configuration_version: number | null } };
  base: { integration_configuration_version: number | null; integration_configuration_content_hash: string | null };
  model: {
    model_profile_id: string;
    model_profile_version: number;
    model_profile_content_hash: string;
    adapter: string;
    model_id: string;
    prompt_id: string;
    prompt_hash: string;
  };
  evidence: { data_dictionary_hash: string; data_dictionary_fields: string[]; field_count: number };
  candidates: {
    schema: { candidate_version: number; fields: SourceSchemaField[]; hash: string };
    cleaning: { candidate_version: number; rules: SourceCleaningRule[]; hash: string };
    mapping: { candidate_version: number; mapping: Record<string, string>; hash: string };
    integration_configuration: {
      version: number;
      identity_fields: string[];
      schema_hash: string;
      cleaning_hash: string;
      mapping_hash: string;
      content_hash: string;
    };
  };
  proposal_hash: string;
  validations: ProposalValidationView[];
  previews: ProposalPreviewView[];
  decisions: ProposalLifecycleDecisionView[];
  publications: ProposalLifecyclePublicationView[];
  adoptions: ProposalLifecycleAdoptionView[];
}

export interface ProposalList {
  source_id: string;
  proposals: ProposalView[];
  raw_acquisitions: Array<{
    raw_id: string;
    acquisition_run_id: string;
    byte_length: number;
    received_at: string;
  }>;
}

export interface ProposalDecisionResult {
  proposal_id: string;
  status: ProposalView['status'];
  reason?: string;
  decided_at?: string;
  provenance?: ProposalProvenanceView;
}
export interface ProposalPublicationResult {
  proposal_id: string;
  status: ProposalView['status'];
  integration_configuration_version: number;
  content_hash: string;
}
export interface ProposalAdoptionResult {
  proposal_id: string;
  status: ProposalView['status'];
  adopted_version: number;
  previous_adopted_version: number | null;
}

/** One metric a candidate Contract publishes for Consumers to request. */
export interface ProductContractMetricView {
  name: string;
  description?: string;
  aggregation: 'count' | 'sum' | 'min' | 'max' | 'avg';
  field?: string;
  value_type: 'integer' | 'decimal' | 'money' | 'date' | 'timestamp';
  unit?: string;
  currency?: string;
  definition?: string;
  dimensions?: string[];
}

/** The Consumer-facing Contract a reviewed candidate would publish. */
export interface ProductContractView {
  title: string;
  description?: string;
  fields: Array<{ name: string; description?: string }>;
  dimensions: string[];
  metrics: ProductContractMetricView[];
  grain: string[];
  time?: { field: string; precision: 'date' | 'timestamp'; time_zone: string };
  filters: string[];
  default_limit: number;
  max_limit: number;
}

/** The exact inputs a Data Product Proposal named. */
export interface ProductProposalBaseView {
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

/** The lineage every Data Product Approval and Publication restates. */
export interface ProductProposalProvenanceView {
  model_profile_id: string;
  model_profile_version: number;
  model_profile_content_hash: string;
  adapter: string;
  model_id: string;
  binding_id: string;
  prompt_id: string;
  prompt_hash: string;
  requirement_hash: string;
  validation_hash: string;
  preview_hash: string;
  candidate_content_hash: string;
  proposal_hash: string;
}

/** The evidence one deterministic validation run produced. */
export interface ProductProposalValidationView {
  validated_at: string;
  validated_by: string;
  dataset_release: number;
  contract_hash: string;
  metric_definition_keys: string[];
  checks: string[];
  evidence_hash: string;
}

/** The API shape, queries, results, freshness, and Provenance a preview exposed. */
export interface ProductProposalPreviewView {
  previewed_at: string;
  previewed_by: string;
  dataset_release: number;
  contract_hash: string;
  api_shape: {
    method: string;
    route: string;
    api_path: string | null;
    contract_version: { major: number; minor: number };
    request: Record<string, unknown>;
  };
  example_queries: Array<Record<string, unknown>>;
  representative_results: Array<Record<string, unknown>>;
  freshness: Record<string, unknown>;
  provenance: Record<string, unknown>;
  narrative: { text?: string; evidence_refs?: unknown };
  evidence_hash: string;
}

export interface ProductProposalDecisionView {
  decided_at: string;
  decided_by: string;
  outcome: 'approved' | 'rejected';
  reason: string | null;
  evidence_hash: string;
  provenance: ProductProposalProvenanceView;
}

export interface ProductProposalPublicationView {
  published_at: string;
  published_by: string;
  data_product_id: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_hash: string;
  evidence_hash: string;
  provenance: ProductProposalProvenanceView;
}

/** One Data Product Proposal as the browser inspects and decides it. */
export interface ProductProposalView {
  proposal_id: string;
  kind: 'data_product';
  status: 'pending' | 'approved' | 'rejected' | 'published';
  workspace_id: string;
  source_id: string;
  dataset_id: string;
  binding_id: string;
  created_at: string;
  created_by: string;
  requirement: {
    text: string;
    clarifications: Array<{ question: string; answer: string }>;
    hash: string;
  };
  base: ProductProposalBaseView;
  model: {
    model_profile_id: string;
    model_profile_version: number;
    model_profile_content_hash: string;
    adapter: string;
    model_id: string;
    prompt_id: string;
    prompt_hash: string;
  };
  evidence: {
    requirement_hash: string;
    dataset_release_hash: string;
    schema_fields: string[];
    field_count: number;
    metric_definition_keys: string[];
    business_context_hash: string;
  };
  candidates: {
    name: string;
    contract: ProductContractView;
    contract_hash: string;
    content_hash: string;
  };
  proposal_hash: string;
  validations: ProductProposalValidationView[];
  previews: ProductProposalPreviewView[];
  decisions: ProductProposalDecisionView[];
  publications: ProductProposalPublicationView[];
  freshness?: { fresh: boolean; current: ProductProposalBaseView | null };
}

export interface ProductProposalList {
  source_id: string;
  proposals: ProductProposalView[];
}

export interface ProductProposalValidationResult {
  proposal_id: string;
  status: ProductProposalView['status'];
  validation: ProductProposalValidationView;
}

export interface ProductProposalPreviewResult {
  proposal_id: string;
  status: ProductProposalView['status'];
  preview: ProductProposalPreviewView;
}

export interface ProductProposalDecisionResult {
  proposal_id: string;
  status: ProductProposalView['status'];
  reason?: string;
  decided_at?: string;
  provenance?: ProductProposalProvenanceView;
}

export interface ProductProposalPublicationResult {
  proposal_id: string;
  status: ProductProposalView['status'];
  data_product_id: string;
  api_path: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_version: { major: number; minor: number };
  contract_hash: string;
}

/** One settled retention clock as the server states it. */
export type RetentionTermView =
  | { kind: 'days'; days: number }
  | { kind: 'indefinite' }
  | { kind: 'no_guarantee' };

export type RetentionClassKey =
  | 'raw_acquisition'
  | 'dataset_release_history'
  | 'report'
  | 'artifact_version'
  | 'provenance'
  | 'audit_event'
  | 'proposal_evidence'
  | 'export'
  | 'derived_data';

export type OverridableRetentionClassKey = 'raw_acquisition' | 'dataset_release_history' | 'report';

export interface RetentionBoundsView {
  min_days: number;
  max_days: number;
}

export interface RetentionPolicyVersionView {
  version: number;
  published_at: string;
  published_by: string;
  content_hash: string;
}

/** The Deployment policy: settled defaults or one published Version. */
/** The governed retention vocabulary the browser renders rather than restates. */
export interface RetentionVocabularyView {
  data_classes: RetentionClassKey[];
  overridable_classes: OverridableRetentionClassKey[];
  hold_scopes: Array<RetentionScopeView['kind']>;
  purge_scopes: Array<RetentionScopeView['kind']>;
}

export interface DeploymentRetentionView {
  policy_version: number;
  source: 'settled' | 'published';
  defaults: Record<RetentionClassKey, RetentionTermView>;
  bounds: Record<OverridableRetentionClassKey, RetentionBoundsView>;
  content_hash: string | null;
  history: RetentionPolicyVersionView[];
  vocabulary: RetentionVocabularyView;
  summary: string;
}

export interface WorkspaceRetentionOverrideVersionView {
  version: number;
  policy_version: number;
  terms: Partial<Record<OverridableRetentionClassKey, RetentionTermView>>;
  updated_at: string;
  updated_by: string;
}

/** One Workspace's effective clocks, its override, and both version lineages. */
export interface WorkspaceRetentionView {
  workspace_id: string;
  policy_version: number;
  override_version: number | null;
  effective: Record<RetentionClassKey, RetentionTermView>;
  overrides: Partial<Record<OverridableRetentionClassKey, RetentionTermView>>;
  clamped: OverridableRetentionClassKey[];
  policy_history: RetentionPolicyVersionView[];
  override_history: WorkspaceRetentionOverrideVersionView[];
  vocabulary: RetentionVocabularyView;
  summary: string;
}

export interface RetentionScopeView {
  kind: 'deployment' | 'workspace' | 'source' | 'dataset' | 'release' | 'proposal_evidence' | 'export';
  workspace_id: string | null;
  source_id: string | null;
  dataset_id: string | null;
  dataset_release: number | null;
  target_id: string | null;
}

export interface RetentionHoldView {
  hold_id: string;
  scope: RetentionScopeView;
  reason: string;
  review_at: string;
  created_at: string;
  created_by: string;
  released_at: string | null;
  released_by: string | null;
  active: boolean;
  pins_restorable_backups: boolean;
}

export interface RetentionHoldList {
  holds: RetentionHoldView[];
  summary: string;
}

export type PurgeRecordKindView =
  | 'raw_acquisition'
  | 'dataset_release'
  | 'data_product_release'
  | 'report'
  | 'proposal_evidence'
  | 'export';

export type PurgeReasonView =
  | 'eligible'
  | 'within_retention'
  | 'current'
  | 'held'
  | 'dependent'
  | 'indefinite'
  | 'no_guarantee';

export interface PurgePlanEntryView {
  data_class: RetentionClassKey;
  record_kind: PurgeRecordKindView;
  record_id: string;
  workspace_id: string;
  eligible: boolean;
  reason: PurgeReasonView;
  held_by: string[];
  dependencies: string[];
  purged?: boolean;
  deferred?: boolean;
}

export interface PurgeJobView {
  purge_id: string;
  mode: 'manual' | 'automatic';
  status: 'pending' | 'failed' | 'completed' | 'nothing_eligible';
  scope: RetentionScopeView;
  requested_at: string;
  requested_by: string;
  access_revoked_at: string | null;
  attempts: number;
  retry_at: string | null;
  last_error: string | null;
  completed_at: string | null;
  ledger_sequence: number | null;
  purged_count: number;
  deferred_count: number;
  plan: PurgePlanEntryView[];
  summary?: string;
}

export interface PurgeLedgerEntryView {
  sequence: number;
  purge_id: string;
  mode: 'manual' | 'automatic';
  recorded_at: string;
  scope: RetentionScopeView;
  purged: Array<{ record_kind: PurgeRecordKindView; record_id: string; data_class: RetentionClassKey }>;
}

export interface RetentionHealthView {
  health: 'healthy' | 'degraded';
  failed_purges: number;
  pending_purges: number;
}

export interface PurgeJobList {
  jobs: PurgeJobView[];
  ledger: PurgeLedgerEntryView[];
  health: RetentionHealthView;
  summary: string;
}

/** A read-only Purge plan: what the named scope would reach and why. */
export interface PurgePreviewView {
  mode: 'preview';
  at: string;
  scope: RetentionScopeView;
  plan: PurgePlanEntryView[];
  eligible_count: number;
  blocked_count: number;
  held_count: number;
  summary: string;
}

/** The Purge request answer; `purge_id` stays null when nothing is eligible. */
export interface PurgeOutcomeView {
  purge_id: string | null;
  mode: 'manual';
  status: 'pending' | 'failed' | 'completed' | 'nothing_eligible';
  access_revoked_at: string | null;
  scope: RetentionScopeView;
  plan: PurgePlanEntryView[];
  eligible_count: number;
  blocked_count: number;
  held_count: number;
  summary: string;
}

export interface RetentionEvaluationView {
  workspace_id: string;
  at: string;
  policy_version: number;
  override_version: number | null;
  terms: Record<RetentionClassKey, RetentionTermView>;
  plan: PurgePlanEntryView[];
  eligible_count: number;
  blocked_count: number;
  held_count: number;
  summary: string;
}

export interface RetentionTickView {
  at: string;
  created_jobs: string[];
  jobs: PurgeJobView[];
  ledger: PurgeLedgerEntryView[];
  health: 'healthy' | 'degraded';
  failed_purges: number;
  pending_purges: number;
  summary: string;
}

export interface RetentionPolicyPublicationView {
  policy_version: number;
  published_at: string;
  published_by: string;
  defaults: Record<RetentionClassKey, RetentionTermView>;
  bounds: Record<OverridableRetentionClassKey, RetentionBoundsView>;
  content_hash: string;
  summary: string;
}

export interface RetentionOverridePublicationView {
  workspace_id: string;
  override_version: number;
  policy_version: number;
  terms: Partial<Record<OverridableRetentionClassKey, RetentionTermView>>;
  effective: Record<RetentionClassKey, RetentionTermView>;
  clamped: OverridableRetentionClassKey[];
  summary: string;
}

/** The explicit scope one retention request names, exactly as it was stated. */
export interface RetentionScopeInput {
  workspaceId: string;
  scopeKind: RetentionScopeView['kind'];
  sourceId?: string;
  datasetId?: string;
  datasetRelease?: number;
  proposalId?: string;
  exportId?: string;
}

/** The one step-up proof a Purge demands beside the standing session. */
export interface StepUpCredentials {
  password: string;
  totp?: string;
  recovery_code?: string;
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

/** The explicit identifiers one retention scope names, and nothing it does not. */
function retentionScopeBody(scope: RetentionScopeInput): Record<string, unknown> {
  return {
    workspace_id: scope.workspaceId,
    scope_kind: scope.scopeKind,
    ...(scope.sourceId === undefined ? {} : { source_id: scope.sourceId }),
    ...(scope.datasetId === undefined ? {} : { dataset_id: scope.datasetId }),
    ...(scope.datasetRelease === undefined ? {} : { dataset_release: scope.datasetRelease }),
    ...(scope.proposalId === undefined ? {} : { proposal_id: scope.proposalId }),
    ...(scope.exportId === undefined ? {} : { export_id: scope.exportId }),
  };
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
  importLicense: (licensePath: string) =>
    request<LicenseImportView>('/api/operator/license', {
      method: 'POST',
      body: JSON.stringify({ license: licensePath }),
    }),
  sessions: () => request<OperatorSessionListView>('/api/operator/sessions'),
  revokeOtherSessions: () =>
    request<{ operator: string; sessions_revoked: number; evidence_id: string }>(
      '/api/operator/sessions/revoke',
      { method: 'POST', body: JSON.stringify({}) },
    ),
  stepUp: (body: { purpose: string; target: string; password: string; totp?: string; recovery_code?: string }) =>
    request<StepUpGrantView>('/api/operator/step-up', { method: 'POST', body: JSON.stringify(body) }),
  recovery: () => request<RecoveryOverviewView>('/api/operator/recovery'),
  recoverySet: (backupId: string) =>
    request<RecoverySetDetailView>(`/api/operator/recovery/backups/${encodeURIComponent(backupId)}`),
  verifyRecoverySet: (backupId: string) =>
    request<RecoveryVerificationViewRow>(
      `/api/operator/recovery/backups/${encodeURIComponent(backupId)}/verify`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  restorations: () => request<RecoveryRestorationList>('/api/operator/recovery/restorations'),
  restoration: (restorationId: string) =>
    request<RestorationView>(`/api/operator/recovery/restorations/${encodeURIComponent(restorationId)}`),
  startRestoration: (backupId: string, stepUpGrant: string) =>
    request<RestorationView>('/api/operator/recovery/restorations', {
      method: 'POST',
      body: JSON.stringify({ backup_id: backupId, step_up_grant: stepUpGrant }),
    }),
  enableRestoredWorkers: (restorationId: string, stepUpGrant: string) =>
    request<RestorationView>(
      `/api/operator/recovery/restorations/${encodeURIComponent(restorationId)}/enable-workers`,
      { method: 'POST', body: JSON.stringify({ step_up_grant: stepUpGrant }) },
    ),
  enableRestoredConnectivity: (restorationId: string, stepUpGrant: string) =>
    request<RestorationView>(
      `/api/operator/recovery/restorations/${encodeURIComponent(restorationId)}/enable-connectivity`,
      { method: 'POST', body: JSON.stringify({ step_up_grant: stepUpGrant }) },
    ),
  lifecycle: () => request<LifecycleView>('/api/operator/lifecycle'),
  preflight: (body: LifecyclePreflightRequest) =>
    request<PreflightView>('/api/operator/lifecycle/preflight', { method: 'POST', body: JSON.stringify(body) }),
  upgrade: (body: LifecyclePreflightRequest & { backup_root?: string }) =>
    request<{ started: boolean; job: LifecycleJobView }>('/api/operator/lifecycle/upgrade', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  verify: () => request<VerifyView>('/api/operator/lifecycle/verify', { method: 'POST' }),
  finalize: (body: LifecycleStepUpRequest) =>
    request<FinalizeView>('/api/operator/lifecycle/finalize', { method: 'POST', body: JSON.stringify(body) }),
  rollback: (body: LifecycleStepUpRequest) =>
    request<RollbackView>('/api/operator/lifecycle/rollback', { method: 'POST', body: JSON.stringify(body) }),
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
  agentIdentities: () => request<AgentIdentityList>('/api/deployment/agent-identities'),
  createAgentIdentity: (name: string, workspaceIds: string[], scopes: string[]) =>
    request<AgentIdentityView>('/api/deployment/agent-identities', {
      method: 'POST',
      body: JSON.stringify({ name, workspace_ids: workspaceIds, scopes }),
    }),
  revokeAgentIdentity: (agentIdentityId: string) =>
    request<{ agent_identity_id: string; status: string; revoked_at: string | null; already_revoked?: boolean }>(
      `/api/deployment/agent-identities/${encodeURIComponent(agentIdentityId)}/revoke`,
      { method: 'POST' },
    ),
  registerAgentClient: (
    agentIdentityId: string,
    body: { client_id: string; client_name: string; redirect_uris: string[] },
  ) =>
    request<AgentClientCreated>(
      `/api/deployment/agent-identities/${encodeURIComponent(agentIdentityId)}/clients`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  revokeAgentClient: (clientId: string) =>
    request<{ client_id: string; revoked_at: string | null; already_revoked?: boolean }>(
      `/api/deployment/oauth-clients/${encodeURIComponent(clientId)}/revoke`,
      { method: 'POST' },
    ),
  dataProducts: (workspaceId: string) =>
    request<DataProductList>(`/api/workspace/data-products${workspaceQuery(workspaceId)}`),
  productReleases: (dataProductId: string, workspaceId: string) =>
    request<ProductReleaseList>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/releases${workspaceQuery(workspaceId)}`,
    ),
  queryProduct: (dataProductId: string, workspaceId: string, query: unknown) =>
    request<ProductQueryAnswer>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/query${workspaceQuery(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ request: query }) },
    ),
  askWorkspaceQuestion: (workspaceId: string, body: Record<string, unknown>) =>
    request<NaturalLanguageAnswerView>(
      `/api/workspace/nlq${workspaceQuery(workspaceId)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  reports: (workspaceId: string) =>
    request<ReportListResponse>(`/api/workspace/reports${workspaceQuery(workspaceId)}`),
  report: (reportId: string, workspaceId: string) =>
    request<ReportRetrievalResponse>(
      `/api/workspace/reports/${encodeURIComponent(reportId)}${workspaceQuery(workspaceId)}`,
    ),
  reportTemplates: (workspaceId: string) =>
    request<ReportTemplateListResponse>(`/api/workspace/report-templates${workspaceQuery(workspaceId)}`),
  publishReportTemplate: (
    workspaceId: string,
    body: {
      product_id: string;
      name: string;
      question: string;
      parameters: string;
      query: string;
      grounded_prompt: string;
      freshness: string;
    },
  ) =>
    request<ReportTemplateView>('/api/workspace/report-templates', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    }),
  generateReportFromTemplate: (reportTemplateId: string, workspaceId: string) =>
    request<ReportGenerationResponse>(
      `/api/workspace/report-templates/${encodeURIComponent(reportTemplateId)}/generate`,
      { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) },
    ),
  withdrawReport: (reportId: string) =>
    request<ReportWithdrawalResponse>(
      `/api/workspace/reports/${encodeURIComponent(reportId)}/withdraw`,
      { method: 'POST' },
    ),
  withdrawReportTemplate: (reportTemplateId: string, version: number) =>
    request<ReportWithdrawalResponse>(
      `/api/workspace/report-templates/${encodeURIComponent(reportTemplateId)}/withdraw`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  reportCandidates: (workspaceId: string) =>
    request<ReportCandidateListResponse>(
      `/api/workspace/report-candidates${workspaceQuery(workspaceId)}`,
    ),
  reportCandidate: (candidateId: string) =>
    request<ReportCandidateEvidenceResponse>(
      `/api/workspace/report-candidates/${encodeURIComponent(candidateId)}`,
    ),
  approveReportCandidate: (candidateId: string) =>
    request<ReportCandidateDecisionResponse>(
      `/api/workspace/report-candidates/${encodeURIComponent(candidateId)}/approve`,
      { method: 'POST' },
    ),
  rejectReportCandidate: (candidateId: string, reason: string) =>
    request<ReportCandidateDecisionResponse>(
      `/api/workspace/report-candidates/${encodeURIComponent(candidateId)}/reject`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  reopenReportCandidate: (candidateId: string) =>
    request<ReportCandidateDecisionResponse>(
      `/api/workspace/report-candidates/${encodeURIComponent(candidateId)}/reopen`,
      { method: 'POST' },
    ),
  reportSchedules: (workspaceId: string) =>
    request<ReportScheduleListResponse>(
      `/api/workspace/report-schedules${workspaceQuery(workspaceId)}`,
    ),
  createReportSchedule: (
    workspaceId: string,
    body: { report_template_id: string; consumer_username: string; interval_minutes: number; start_at: string },
  ) =>
    request<ReportScheduleResponse>('/api/workspace/report-schedules', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    }),
  pauseReportSchedule: (scheduleId: string) =>
    request<ReportScheduleResponse>(
      `/api/workspace/report-schedules/${encodeURIComponent(scheduleId)}/pause`,
      { method: 'POST' },
    ),
  resumeReportSchedule: (scheduleId: string) =>
    request<ReportScheduleResponse>(
      `/api/workspace/report-schedules/${encodeURIComponent(scheduleId)}/resume`,
      { method: 'POST' },
    ),
  tickReportSchedules: (workspaceId: string) =>
    request<ReportScheduleTickResponse>('/api/workspace/report-schedules/tick', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),
  createProductExport: (dataProductId: string, workspaceId: string, query: unknown) =>
    request<ProductExportCreated>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/exports${workspaceQuery(workspaceId)}`,
      { method: 'POST', body: JSON.stringify({ request: query }) },
    ),
  myExports: (workspaceId: string, dataProductId?: string) =>
    request<WorkspaceExportList>(
      `/api/workspace/my-exports${workspaceQuery(workspaceId)}${
        dataProductId === undefined ? '' : `&data_product_id=${encodeURIComponent(dataProductId)}`
      }`,
    ),
  productGovernance: (dataProductId: string) =>
    request<ProductGovernanceView>(`/api/workspace/products/${encodeURIComponent(dataProductId)}/governance`),
  previewProductEvolution: (dataProductId: string, contract: unknown) =>
    request<ProductEvolutionPreviewView>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/evolution/preview`,
      { method: 'POST', body: JSON.stringify({ contract }) },
    ),
  publishProductEvolution: (dataProductId: string, contract: unknown) =>
    request<ProductEvolutionPublicationView>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/evolution/publish`,
      { method: 'POST', body: JSON.stringify({ contract }) },
    ),
  rollbackProductVersion: (dataProductId: string, version: number) =>
    request<ProductRollbackView>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/rollback`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  withdrawProductVersion: (dataProductId: string, version: number) =>
    request<ProductWithdrawalView>(
      `/api/workspace/products/${encodeURIComponent(dataProductId)}/withdraw`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  publishProductGrant: (
    dataProductId: string,
    grantee: { username: string } | { agentIdentityId: string },
    columns: string,
    rowFilters: string,
  ) =>
    request<{ grant_id: string; data_product_id: string }>('/api/workspace/product-grants', {
      method: 'POST',
      body: JSON.stringify({
        data_product_id: dataProductId,
        ...('username' in grantee ? { username: grantee.username } : { agent_identity_id: grantee.agentIdentityId }),
        columns,
        ...(rowFilters.trim() === '' ? {} : { row_filters: rowFilters }),
      }),
    }),
  revokeProductGrant: (grantId: string) =>
    request<{ grant_id: string; revoked_at: string | null }>(
      `/api/workspace/product-grants/${encodeURIComponent(grantId)}/revoke`,
      { method: 'POST' },
    ),
  workspaceExports: (workspaceId: string, dataProductId?: string) =>
    request<WorkspaceExportList>(
      `/api/workspace/exports${workspaceQuery(workspaceId)}${
        dataProductId === undefined ? '' : `&data_product_id=${encodeURIComponent(dataProductId)}`
      }`,
    ),
  createGovernedExport: (dataProductId: string, query: unknown) =>
    request<{
      export_id: string;
      data_product_id: string;
      data_product_release: number;
      row_count: number;
      columns: string[];
      content_hash: string;
      created_at: string;
      expires_at: string;
    }>('/api/workspace/exports', {
      method: 'POST',
      body: JSON.stringify({ data_product_id: dataProductId, request: query }),
    }),
  revokeWorkspaceExport: (exportId: string) =>
    request<{ export_id: string; revoked_at: string | null; already_revoked?: boolean }>(
      `/api/workspace/exports/${encodeURIComponent(exportId)}/revoke`,
      { method: 'POST' },
    ),
  downloadWorkspaceExport: (exportId: string) =>
    request<WorkspaceExportDownload>(
      `/api/workspace/exports/${encodeURIComponent(exportId)}/download`,
      { method: 'POST' },
    ),
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
  workspaceAgents: (workspaceId: string) =>
    request<WorkspaceAgentAccessView>(`/api/workspace/agents${workspaceQuery(workspaceId)}`),
  publishAgentGrant: (
    agentIdentityId: string,
    dataProductId: string,
    columns: string,
    rowFilters: string,
  ) =>
    request<{ grant_id: string; data_product_id: string }>('/api/workspace/agent-grants', {
      method: 'POST',
      body: JSON.stringify({
        agent_identity_id: agentIdentityId,
        data_product_id: dataProductId,
        columns,
        ...(rowFilters.trim() === '' ? {} : { row_filters: rowFilters }),
      }),
    }),
  revokeAgentGrant: (grantId: string) =>
    request<{ grant_id: string; revoked_at: string | null }>(
      `/api/workspace/agent-grants/${encodeURIComponent(grantId)}/revoke`,
      { method: 'POST' },
    ),
  recordAgentDelegation: (workspaceId: string, agentIdentityId: string) =>
    request<WorkspaceAgentDelegationRecorded>('/api/workspace/agent-delegations', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, agent_identity_id: agentIdentityId }),
    }),
  revokeAgentDelegation: (delegationId: string) =>
    request<{ delegation_id: string; revoked_at: string | null }>(
      `/api/workspace/agent-delegations/${encodeURIComponent(delegationId)}/revoke`,
      { method: 'POST' },
    ),
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
  connections: (workspaceId: string) =>
    request<ConnectionList>(`/api/workspace/connections${workspaceQuery(workspaceId)}`),
  previewConnection: (
    workspaceId: string,
    name: string,
    declaration: Record<string, unknown>,
    credential: string,
  ) =>
    request<ConnectionPreview>('/api/workspace/connections/preview', {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: workspaceId,
        name,
        declaration,
        ...(credential === '' ? {} : { credential }),
      }),
    }),
  publishConnection: (
    workspaceId: string,
    name: string,
    declaration: Record<string, unknown>,
    credential: string,
  ) =>
    request<ConnectionPublicationView>('/api/workspace/connections', {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: workspaceId,
        name,
        declaration,
        ...(credential === '' ? {} : { credential }),
      }),
    }),
  adoptConnection: (connectionId: string, version: number) =>
    request<{ connection_id: string; adopted_version: number; content_hash: string }>(
      `/api/workspace/connections/${encodeURIComponent(connectionId)}/adopt`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  connectionSession: (connectionId: string) =>
    request<ConnectionSessionView>(`/api/workspace/connections/${encodeURIComponent(connectionId)}/session`),
  resetConnectionSession: (connectionId: string) =>
    request<{ connection_id: string; reset: boolean; sessions_removed: number; state: string }>(
      `/api/workspace/connections/${encodeURIComponent(connectionId)}/session/reset`,
      { method: 'POST' },
    ),
  connectionPacing: (connectionId: string) =>
    request<ConnectionPacingView>(`/api/workspace/connections/${encodeURIComponent(connectionId)}/pacing`),
  previewAcquisitionConfiguration: (sourceId: string, declaration: Record<string, unknown>) =>
    request<SourceAcquisitionConfigurationPreview>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/preview`,
      { method: 'POST', body: JSON.stringify({ declaration }) },
    ),
  publishAcquisitionConfiguration: (sourceId: string, declaration: Record<string, unknown>) =>
    request<SourceAcquisitionConfigurationPublicationView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/publish`,
      { method: 'POST', body: JSON.stringify({ declaration }) },
    ),
  adoptAcquisitionConfiguration: (sourceId: string, version: number) =>
    request<{ source_id: string; adopted_version: number; content_hash: string }>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/adopt`,
      { method: 'POST', body: JSON.stringify({ version }) },
    ),
  enqueueAcquisitionRun: (
    sourceId: string,
    options: { from?: string; to?: string; rerunOf?: string } = {},
  ) =>
    request<AcquisitionRunQueuedView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/runs`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(options.from === undefined ? {} : { from: options.from }),
          ...(options.to === undefined ? {} : { to: options.to }),
          ...(options.rerunOf === undefined ? {} : { rerun_of: options.rerunOf }),
        }),
      },
    ),
  workAcquisition: (sourceId: string) =>
    request<AcquisitionRunWorkView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/work`,
      { method: 'POST' },
    ),
  sourceCheckpoint: (sourceId: string) =>
    request<{ source_id: string; checkpoint: AcquisitionCheckpointView | null }>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/checkpoint`,
    ),
  resetSourceCheckpoint: (sourceId: string) =>
    request<{ source_id: string; checkpoint: AcquisitionCheckpointView }>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/acquisition/checkpoint/reset`,
      { method: 'POST' },
    ),
  cancelAcquisitionRun: (runId: string) =>
    request<{ acquisition_run_id: string; source_id: string; status: string; error_code: string | null }>(
      `/api/workspace/acquisition-runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    ),
  acquisitionPlan: (runId: string) =>
    request<AcquisitionPlanView>(`/api/workspace/acquisition-runs/${encodeURIComponent(runId)}/plan`),
  tickAcquisitionSchedule: () =>
    request<{ at: string; enqueued: Array<{ source_id: string; acquisition_run_id: string; due_at: string }> }>(
      '/api/workspace/acquisition/schedule',
      { method: 'POST', body: JSON.stringify({}) },
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
  proposals: (sourceId: string) =>
    request<ProposalList>(`/api/workspace/sources/${encodeURIComponent(sourceId)}/proposals`),
  generateProposal: (
    sourceId: string,
    body: { binding_id: string; requirement: string; clarifications: ProposalClarificationView[]; dictionary: string },
  ) =>
    request<ProposalView>(`/api/workspace/sources/${encodeURIComponent(sourceId)}/proposals/generate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  validateProposal: (proposalId: string, fixtures: string) =>
    request<ProposalValidationResult>(`/api/workspace/proposals/${encodeURIComponent(proposalId)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ fixtures }),
    }),
  previewProposal: (proposalId: string, rawId: string) =>
    request<ProposalPreviewResult>(`/api/workspace/proposals/${encodeURIComponent(proposalId)}/preview`, {
      method: 'POST',
      body: JSON.stringify({ raw_id: rawId }),
    }),
  approveProposal: (proposalId: string) =>
    request<ProposalDecisionResult>(`/api/workspace/proposals/${encodeURIComponent(proposalId)}/approve`, {
      method: 'POST',
    }),
  rejectProposal: (proposalId: string, reason: string) =>
    request<ProposalDecisionResult>(`/api/workspace/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  publishProposal: (proposalId: string) =>
    request<ProposalPublicationResult>(`/api/workspace/proposals/${encodeURIComponent(proposalId)}/publish`, {
      method: 'POST',
    }),
  adoptProposal: (proposalId: string) =>
    request<ProposalAdoptionResult>(`/api/workspace/proposals/${encodeURIComponent(proposalId)}/adopt`, {
      method: 'POST',
    }),
  productProposals: (sourceId: string) =>
    request<ProductProposalList>(`/api/workspace/sources/${encodeURIComponent(sourceId)}/product-proposals`),
  generateProductProposal: (
    sourceId: string,
    body: {
      binding_id: string;
      name: string;
      requirement: string;
      clarifications: Array<{ question: string; answer: string }>;
    },
  ) =>
    request<ProductProposalView>(
      `/api/workspace/sources/${encodeURIComponent(sourceId)}/product-proposals/generate`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  validateProductProposal: (proposalId: string) =>
    request<ProductProposalValidationResult>(
      `/api/workspace/product-proposals/${encodeURIComponent(proposalId)}/validate`,
      { method: 'POST' },
    ),
  previewProductProposal: (proposalId: string) =>
    request<ProductProposalPreviewResult>(
      `/api/workspace/product-proposals/${encodeURIComponent(proposalId)}/preview`,
      { method: 'POST' },
    ),
  approveProductProposal: (proposalId: string) =>
    request<ProductProposalDecisionResult>(
      `/api/workspace/product-proposals/${encodeURIComponent(proposalId)}/approve`,
      { method: 'POST' },
    ),
  rejectProductProposal: (proposalId: string, reason: string) =>
    request<ProductProposalDecisionResult>(
      `/api/workspace/product-proposals/${encodeURIComponent(proposalId)}/reject`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  publishProductProposal: (proposalId: string) =>
    request<ProductProposalPublicationResult>(
      `/api/workspace/product-proposals/${encodeURIComponent(proposalId)}/publish`,
      { method: 'POST' },
    ),
  deploymentRetention: () => request<DeploymentRetentionView>('/api/deployment/retention'),
  publishRetentionPolicy: (
    defaults: Partial<Record<RetentionClassKey, RetentionTermView>>,
    bounds: Partial<Record<OverridableRetentionClassKey, RetentionBoundsView>>,
  ) =>
    request<RetentionPolicyPublicationView>('/api/deployment/retention', {
      method: 'POST',
      body: JSON.stringify({ defaults, bounds }),
    }),
  deploymentRetentionHolds: () =>
    request<RetentionHoldList>('/api/deployment/retention/holds'),
  createDeploymentRetentionHold: (reason: string, reviewAt: string) =>
    request<RetentionHoldView>('/api/deployment/retention/holds', {
      method: 'POST',
      body: JSON.stringify({ reason, review_at: reviewAt }),
    }),
  deploymentPurges: () => request<PurgeJobList>('/api/deployment/retention/purges'),
  tickRetention: (at?: string) =>
    request<RetentionTickView>('/api/deployment/retention/tick', {
      method: 'POST',
      body: JSON.stringify(at === undefined ? {} : { at }),
    }),
  workspaceRetention: (workspaceId: string) =>
    request<WorkspaceRetentionView>(`/api/workspace/retention${workspaceQuery(workspaceId)}`),
  publishRetentionOverride: (
    workspaceId: string,
    terms: Partial<Record<OverridableRetentionClassKey, RetentionTermView>>,
  ) =>
    request<RetentionOverridePublicationView>('/api/workspace/retention/override', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, terms }),
    }),
  evaluateRetention: (workspaceId: string) =>
    request<RetentionEvaluationView>(`/api/workspace/retention/evaluate${workspaceQuery(workspaceId)}`),
  workspaceRetentionHolds: (workspaceId: string) =>
    request<RetentionHoldList>(`/api/workspace/retention/holds${workspaceQuery(workspaceId)}`),
  createRetentionHold: (scope: RetentionScopeInput, reason: string, reviewAt: string) =>
    request<RetentionHoldView>('/api/workspace/retention/holds', {
      method: 'POST',
      body: JSON.stringify({ ...retentionScopeBody(scope), reason, review_at: reviewAt }),
    }),
  releaseRetentionHold: (holdId: string) =>
    request<RetentionHoldView>(`/api/retention/holds/${encodeURIComponent(holdId)}/release`, {
      method: 'POST',
    }),
  workspacePurges: (workspaceId: string) =>
    request<PurgeJobList>(`/api/workspace/retention/purges${workspaceQuery(workspaceId)}`),
  previewPurge: (scope: RetentionScopeInput) =>
    request<PurgePreviewView>('/api/workspace/retention/purge/preview', {
      method: 'POST',
      body: JSON.stringify(retentionScopeBody(scope)),
    }),
  requestPurge: (scope: RetentionScopeInput, stepUp: StepUpCredentials) =>
    request<PurgeOutcomeView>('/api/workspace/retention/purge', {
      method: 'POST',
      body: JSON.stringify({
        ...retentionScopeBody(scope),
        password: stepUp.password,
        ...(stepUp.totp === undefined || stepUp.totp === '' ? {} : { totp: stepUp.totp }),
        ...(stepUp.recovery_code === undefined || stepUp.recovery_code === ''
          ? {}
          : { recovery_code: stepUp.recovery_code }),
      }),
    }),
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
