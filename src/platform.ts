import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AcquisitionConnectionArtifact,
  AcquisitionPlanRecord,
  AcquisitionRunRecord,
  ConnectionPacingRecord,
  ConnectionSessionRecord,
  DataProductArtifact,
  DataProductGrantRecord,
  DatasetArtifact,
  ExportRecord,
  IntegrationBatchRecord,
  IntegrationConfigurationArtifact,
  RawAcquisitionRecord,
  ReportRecord,
  ReportTemplateArtifact,
  SourceAcquisitionArtifact,
  SourceRecord,
  ArtifactProposalRecord,
  ModelProfileArtifact,
  ScraperCredentialRecord,
  ScraperRunManifest,
  ScraperServiceArtifact,
  ScraperTaskArtifact,
  SourceScraperServiceRecord,
  WorkspaceModelBindingRecord,
} from './catalog.js';
import type { MfaRecord } from './enrollment.js';
import { readJsonFile, writeJsonFile } from './state.js';

/** A Role is assigned at Deployment or Workspace scope; only administrators hold one at Deployment scope. */
export type DeploymentRole = 'Deployment Administrator';
export type WorkspaceRole = 'Workspace Administrator' | 'Consumer';

export const DEPLOYMENT_CONTEXT_ARTIFACT = 'deployment-business-context';
export const CURRENT_SCHEMA_VERSION = 7;
export const USERNAME_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,189}$/;

export interface UserRecord {
  user_id: string;
  username: string;
  password_hash: string;
  status: 'active' | 'deactivated';
  deployment_role: DeploymentRole | null;
  mfa: MfaRecord | null;
  failure_count: number;
  locked_until: string | null;
  created_at: string;
}

export interface WorkspaceRecord {
  workspace_id: string;
  name: string;
  created_at: string;
}

export interface MembershipRecord {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  granted_at: string;
}

export interface SessionRecord {
  token_hash: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** The lifecycle an Agent Identity passes through; a revoked one authenticates nothing. */
export type AgentIdentityStatus = 'active' | 'revoked';

/**
 * A deployment-owned non-human principal an external API or MCP actor acts as.
 * It belongs to explicit Workspaces and carries explicit MCP scopes, and it
 * reads a Data Product only under a Data Product Grant naming it.
 */
export interface AgentIdentityRecord {
  agent_identity_id: string;
  name: string;
  workspace_ids: string[];
  scopes: string[];
  status: AgentIdentityStatus;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
}

/**
 * A deployment-owned non-human principal for internal platform jobs, bound to
 * the Workspaces where it executes. It is not an Agent Identity: it never holds
 * Consumer grants, MCP scopes, or OAuth clients, and it owns no Artifact.
 */
export interface ServiceIdentityRecord {
  service_identity_id: string;
  name: string;
  workspace_ids: string[];
  status: 'active' | 'revoked';
  created_at: string;
  created_by: string;
  revoked_at: string | null;
}

/**
 * One pre-registered OAuth client an Agent Identity authenticates with. It is
 * registered from a Client ID Metadata Document, so the Deployment never runs
 * open Dynamic Client Registration and never lets a client name its own scope.
 */
export interface OAuthClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  agent_identity_id: string;
  client_secret_hash: string;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
}

/**
 * One access token the Deployment minted for itself. The claims are stored, not
 * only the hash, because every request re-proves the exact issuer, resource,
 * audience, client, and redirect the token was issued under.
 */
export interface AccessTokenRecord {
  token_hash: string;
  issuer: string;
  audience: string;
  resource: string;
  client_id: string;
  agent_identity_id: string;
  scopes: string[];
  redirect_uri: string | null;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface ContextEntry {
  key: string;
  kind: 'metric' | 'definition' | 'dimension';
  value: string;
  unit?: string;
  description?: string;
  references?: string[];
}

export interface ContextVersion {
  version: number;
  published_at: string;
  published_by: string;
  content_hash: string;
  pins: { common_version: number; previous_version: number | null };
  entries: ContextEntry[];
}

export interface ContextArtifact {
  artifact_id: string;
  scope: 'deployment' | 'workspace';
  workspace_id: string | null;
  owner_user_id: string;
  versions: ContextVersion[];
}

export interface PlatformState {
  schema_version: number;
  users: UserRecord[];
  agent_identities: AgentIdentityRecord[];
  service_identities: ServiceIdentityRecord[];
  oauth_clients: OAuthClientRecord[];
  access_tokens: AccessTokenRecord[];
  workspaces: WorkspaceRecord[];
  memberships: MembershipRecord[];
  sessions: SessionRecord[];
  context_artifacts: ContextArtifact[];
  sources: SourceRecord[];
  acquisition_connections: AcquisitionConnectionArtifact[];
  source_acquisitions: SourceAcquisitionArtifact[];
  acquisition_plans: AcquisitionPlanRecord[];
  integration_configurations: IntegrationConfigurationArtifact[];
  raw_acquisitions: RawAcquisitionRecord[];
  acquisition_runs: AcquisitionRunRecord[];
  integration_batches: IntegrationBatchRecord[];
  connection_sessions: ConnectionSessionRecord[];
  connection_pacing: ConnectionPacingRecord[];
  datasets: DatasetArtifact[];
  data_products: DataProductArtifact[];
  data_product_grants: DataProductGrantRecord[];
  exports: ExportRecord[];
  model_profiles: ModelProfileArtifact[];
  model_bindings: WorkspaceModelBindingRecord[];
  artifact_proposals: ArtifactProposalRecord[];
  scraper_tasks: ScraperTaskArtifact[];
  scraper_services: ScraperServiceArtifact[];
  source_scraper_services: SourceScraperServiceRecord[];
  scraper_credentials: ScraperCredentialRecord[];
  scraper_runs: ScraperRunManifest[];
  report_templates: ReportTemplateArtifact[];
  reports: ReportRecord[];
}

/** Every human identity is stated as one account identifier of the form name@domain. */
export function isUsernameValid(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return value === 'Workspace Administrator' || value === 'Consumer';
}

export function workspaceContextArtifact(workspaceId: string): string {
  return `workspace-${workspaceId}-business-context`;
}

function platformPath(root: string): string {
  return join(root, 'state', 'platform.json');
}

export function readPlatform(root: string): PlatformState {
  const path = platformPath(root);
  const state: PlatformState = existsSync(path)
    ? readJsonFile<PlatformState>(path)
    : {
        schema_version: CURRENT_SCHEMA_VERSION,
        users: [],
        agent_identities: [],
        service_identities: [],
        oauth_clients: [],
        access_tokens: [],
        workspaces: [],
        memberships: [],
        sessions: [],
        context_artifacts: [],
        sources: [],
        acquisition_connections: [],
        source_acquisitions: [],
        acquisition_plans: [],
        integration_configurations: [],
        raw_acquisitions: [],
        acquisition_runs: [],
        integration_batches: [],
        connection_sessions: [],
        connection_pacing: [],
        datasets: [],
        data_products: [],
        data_product_grants: [],
        exports: [],
        model_profiles: [],
        model_bindings: [],
        artifact_proposals: [],
        scraper_tasks: [],
        scraper_services: [],
        source_scraper_services: [],
        scraper_credentials: [],
        scraper_runs: [],
        report_templates: [],
        reports: [],
      };
  // A Deployment installed under an earlier schema keeps working: the added
  // Collections start empty rather than failing the read closed.
  state.schema_version = CURRENT_SCHEMA_VERSION;
  state.agent_identities ??= [];
  // A Deployment written before Service Identities existed has none, and every
  // one it does have keeps exactly the bindings it was created with.
  state.service_identities ??= [];
  state.oauth_clients ??= [];
  state.access_tokens ??= [];
  state.sources ??= [];
  state.acquisition_connections ??= [];
  state.source_acquisitions ??= [];
  state.acquisition_plans ??= [];
  state.integration_configurations ??= [];
  state.raw_acquisitions ??= [];
  state.acquisition_runs ??= [];
  state.integration_batches ??= [];
  state.connection_sessions ??= [];
  state.connection_pacing ??= [];
  state.datasets ??= [];
  state.data_products ??= [];
  state.data_product_grants ??= [];
  state.exports ??= [];
  // Documents added no Collection: an Integration Configuration Version may
  // carry a document envelope and a Dataset Release may name the parser it ran,
  // and both read as absent on a Deployment written before they existed. A
  // tabular Release therefore never pretends to have parsed a document.
  state.model_profiles ??= [];
  state.model_bindings ??= [];
  state.artifact_proposals ??= [];
  state.scraper_tasks ??= [];
  state.scraper_services ??= [];
  state.source_scraper_services ??= [];
  state.scraper_credentials ??= [];
  state.scraper_runs ??= [];
  // A Deployment written before Reports existed simply holds no stock; the
  // Templates and Reports Collections start empty rather than failing the read.
  state.report_templates ??= [];
  state.reports ??= [];
  // A Run recorded before acquisition was queued still reads as a completed
  // manual attempt rather than a Run that never started.
  for (const run of state.acquisition_runs) {
    run.trigger ??= 'manual';
    run.queued_at ??= run.started_at ?? new Date().toISOString();
    run.backfill ??= null;
  }
  // A Connection published before authentication, retries, and pacing were
  // declarative keeps authenticating exactly as it did: bearer when it holds a
  // credential, nothing when it does not.
  for (const connection of state.acquisition_connections) {
    for (const version of connection.versions) {
      version.auth ??= version.credential === null ? { scheme: 'none' } : { scheme: 'bearer' };
      version.retry ??= { max_attempts: 1, base_delay_ms: 250, max_delay_ms: 30_000, retry_on: [429, 500, 502, 503, 504] };
      version.pacing ??= {
        serialization: false,
        minimum_interval_seconds: 0,
        maximum_requests_per_minute: null,
        maximum_concurrent_runs: 1,
      };
      version.pagination.mode ??= 'page_number';
      version.pagination.cursor_path ??= null;
      version.pagination.initial_cursor ??= null;
    }
  }
  // A Source acquired before planner windows existed simply has no checkpoint,
  // and an attempt recorded before replay attempts existed has one attempt.
  for (const artifact of state.source_acquisitions) {
    artifact.checkpoint ??= null;
    for (const version of artifact.versions) {
      version.window ??= null;
      version.content_type ??= null;
    }
  }
  for (const plan of state.acquisition_plans) {
    plan.window ??= null;
    plan.start_cursor ??= null;
    plan.checkpoint_before ??= null;
    plan.checkpoint_after ??= null;
    plan.end_cursor ??= null;
    for (const page of plan.pages) {
      page.attempts ??= 1;
      page.failed_attempts ??= [];
    }
  }
  for (const batch of state.integration_batches) {
    batch.quarantined_at ??= null;
    batch.quarantine_error_code ??= null;
  }
  // A Data Product published before Contract lines existed belongs to the single
  // line its oldest Contract states, so an older Deployment keeps serving it.
  for (const product of state.data_products) {
    for (const version of product.versions) {
      version.contract_version ??= { major: 1, minor: version.version - 1 };
      version.withdrawn_at ??= null;
    }
    product.lines ??= [];
    if (product.lines.length > 0) continue;
    for (const release of product.releases) {
      const version = product.versions.find((candidate) => candidate.version === release.data_product_version);
      if (version === undefined) continue;
      const line = product.lines.find((candidate) => candidate.major === version.contract_version.major);
      if (line === undefined) {
        product.lines.push({
          major: version.contract_version.major,
          current_version: version.version,
          current_release: release.release,
          opened_at: release.created_at,
          withdrawn_at: null,
        });
        continue;
      }
      line.current_version = version.version;
      line.current_release = release.release;
    }
  }
  return state;
}

export function writePlatform(root: string, state: PlatformState): void {
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 });
  writeJsonFile(platformPath(root), state);
}

export function findUser(state: PlatformState, username: string): UserRecord | undefined {
  const normalized = username.trim().toLowerCase();
  return state.users.find((user) => user.username.toLowerCase() === normalized);
}

export function findUserById(state: PlatformState, userId: string): UserRecord | undefined {
  return state.users.find((user) => user.user_id === userId);
}

export function findAgentIdentity(state: PlatformState, agentIdentityId: string): AgentIdentityRecord | undefined {
  return state.agent_identities.find((agent) => agent.agent_identity_id === agentIdentityId);
}

export function findServiceIdentity(state: PlatformState, serviceIdentityId: string): ServiceIdentityRecord | undefined {
  return state.service_identities.find((identity) => identity.service_identity_id === serviceIdentityId);
}

export function findOAuthClient(state: PlatformState, clientId: string): OAuthClientRecord | undefined {
  return state.oauth_clients.find((client) => client.client_id === clientId);
}

export function findWorkspace(state: PlatformState, workspaceId: string): WorkspaceRecord | undefined {
  return state.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
}

export function workspaceRoleOf(state: PlatformState, userId: string, workspaceId: string): WorkspaceRole | null {
  return state.memberships.find(
    (membership) => membership.user_id === userId && membership.workspace_id === workspaceId,
  )?.role ?? null;
}

export function isDeploymentAdministrator(user: UserRecord): boolean {
  return user.deployment_role === 'Deployment Administrator';
}

/** Active Workspace Administrators of one Workspace, used for orphan safeguards. */
export function activeWorkspaceAdministrators(state: PlatformState, workspaceId: string): UserRecord[] {
  return state.memberships
    .filter((membership) => membership.workspace_id === workspaceId && membership.role === 'Workspace Administrator')
    .map((membership) => findUserById(state, membership.user_id))
    .filter((user): user is UserRecord => user !== undefined && user.status === 'active');
}

/** Active Workspace Administrators other than the named User, used for orphan safeguards. */
export function otherActiveWorkspaceAdministrators(
  state: PlatformState,
  workspaceId: string,
  userId: string,
): UserRecord[] {
  return activeWorkspaceAdministrators(state, workspaceId)
    .filter((user) => user.user_id !== userId);
}

export function findContextArtifact(state: PlatformState, artifactId: string): ContextArtifact | undefined {
  return state.context_artifacts.find((artifact) => artifact.artifact_id === artifactId);
}

export function latestVersion(artifact: ContextArtifact | undefined): ContextVersion | undefined {
  return artifact?.versions[artifact.versions.length - 1];
}
