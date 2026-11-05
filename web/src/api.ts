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
  type: 'file' | 'document' | 'http_json';
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
