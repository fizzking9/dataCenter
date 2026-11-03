import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from './state.js';
import type { WrappedValue } from './keys.js';

/** A Role is assigned at Deployment or Workspace scope; only administrators hold one at Deployment scope. */
export type DeploymentRole = 'Deployment Administrator';
export type WorkspaceRole = 'Workspace Administrator' | 'Consumer';

export const DEPLOYMENT_CONTEXT_ARTIFACT = 'deployment-business-context';
export const USERNAME_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,189}$/;

export interface UserRecord {
  user_id: string;
  username: string;
  password_hash: string;
  status: 'active' | 'deactivated';
  deployment_role: DeploymentRole | null;
  mfa: { type: 'TOTP'; secret: WrappedValue; recovery_codes: string[] } | null;
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
  workspaces: WorkspaceRecord[];
  memberships: MembershipRecord[];
  sessions: SessionRecord[];
  context_artifacts: ContextArtifact[];
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
  if (!existsSync(path)) {
    return {
      schema_version: 1,
      users: [],
      workspaces: [],
      memberships: [],
      sessions: [],
      context_artifacts: [],
    };
  }
  return readJsonFile<PlatformState>(path);
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

/** Active Workspace Administrators other than the named User, used for orphan safeguards. */
export function otherActiveWorkspaceAdministrators(
  state: PlatformState,
  workspaceId: string,
  userId: string,
): UserRecord[] {
  return state.memberships
    .filter(
      (membership) => membership.workspace_id === workspaceId
        && membership.role === 'Workspace Administrator'
        && membership.user_id !== userId,
    )
    .map((membership) => findUserById(state, membership.user_id))
    .filter((user): user is UserRecord => user !== undefined && user.status === 'active');
}

export function findContextArtifact(state: PlatformState, artifactId: string): ContextArtifact | undefined {
  return state.context_artifacts.find((artifact) => artifact.artifact_id === artifactId);
}

export function latestVersion(artifact: ContextArtifact | undefined): ContextVersion | undefined {
  return artifact?.versions[artifact.versions.length - 1];
}
