import { resolveActor } from './auth.js';
import { actorLabel, type ActionContext } from './authz.js';
import {
  findWorkspace,
  isDeploymentAdministrator,
  type PlatformState,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './platform.js';
import { openPlatform } from './session.js';

/**
 * Stable, ASCII navigation keys. The browser owns every Chinese label, so a
 * surface this module does not name is never rendered as raw English.
 */
export type NavigationKey =
  | 'deployment.workspaces'
  | 'deployment.users'
  | 'deployment.modelProfiles'
  | 'deployment.retention'
  | 'workspace.overview'
  | 'workspace.sources'
  | 'workspace.scrapers'
  | 'workspace.products'
  | 'workspace.nlq'
  | 'workspace.reports'
  | 'workspace.productGovernance'
  | 'workspace.context'
  | 'workspace.members'
  | 'workspace.agents'
  | 'workspace.audit'
  | 'workspace.models'
  | 'workspace.retention'
  | 'workspace.proposals'
  | 'workspace.productProposals';

/**
 * The two trees are separate by construction: a Deployment Administrator holds
 * no Workspace key unless a membership grants one, so deployment authority never
 * opens Workspace content.
 */
const WORKSPACE_NAVIGATION: Record<WorkspaceRole, NavigationKey[]> = {
  'Workspace Administrator': [
    'workspace.overview',
    'workspace.sources',
    'workspace.scrapers',
    'workspace.products',
    'workspace.nlq',
    'workspace.reports',
    'workspace.productGovernance',
    'workspace.context',
    'workspace.members',
    'workspace.agents',
    'workspace.audit',
    'workspace.models',
    'workspace.proposals',
    'workspace.productProposals',
    'workspace.retention',
  ],
  Consumer: ['workspace.overview', 'workspace.products', 'workspace.nlq', 'workspace.reports'],
};

const DEPLOYMENT_NAVIGATION: NavigationKey[] = [
  'deployment.workspaces',
  'deployment.users',
  'deployment.modelProfiles',
  'deployment.retention',
];

export interface ActivityItem {
  activity_id: string;
  kind: 'acquisition_run';
  state: string;
  since: string;
}

export interface ActivityCentre {
  background: ActivityItem[];
  attention: ActivityItem[];
}

interface AuthorizedWorkspace {
  workspace: WorkspaceRecord;
  role: WorkspaceRole;
}

/**
 * Lists the Workspaces the actor actually belongs to. Deployment authority is
 * deliberately absent here: it grants governance metadata, never content.
 */
function authorizedWorkspaces(state: PlatformState, userId: string): AuthorizedWorkspace[] {
  return state.memberships
    .filter((membership) => membership.user_id === userId)
    .flatMap((membership) => {
      const workspace = findWorkspace(state, membership.workspace_id);
      // A membership whose Workspace no longer exists grants nothing.
      return workspace === undefined ? [] : [{ workspace, role: membership.role }];
    })
    .sort((left, right) => left.workspace.created_at.localeCompare(right.workspace.created_at)
      || left.workspace.name.localeCompare(right.workspace.name));
}

/**
 * Background work and required attention for the active Workspace. Acquisition
 * Runs are the only long-running governed work the first release records today,
 * so later surfaces extend this feed rather than re-deriving it in the browser.
 */
function activityCentre(state: PlatformState, workspaceId: string | null): ActivityCentre {
  if (workspaceId === null) return { background: [], attention: [] };
  const runs = state.acquisition_runs.filter((run) => run.workspace_id === workspaceId);
  const background = runs
    .filter((run) => run.status === 'queued' || run.status === 'running')
    .sort((left, right) => left.queued_at.localeCompare(right.queued_at))
    .slice(0, 5)
    .map((run) => ({
      activity_id: run.acquisition_run_id,
      kind: 'acquisition_run' as const,
      state: run.status,
      since: run.started_at ?? run.queued_at,
    }));
  const attention = runs
    .filter((run) => run.status === 'failed')
    .sort((left, right) => (right.completed_at ?? right.queued_at).localeCompare(left.completed_at ?? left.queued_at))
    .slice(0, 5)
    .map((run) => ({
      activity_id: run.acquisition_run_id,
      kind: 'acquisition_run' as const,
      state: run.status,
      since: run.completed_at ?? run.queued_at,
    }));
  return { background, attention };
}

export interface BrowserIdentity {
  username: string;
  deployment_role: string | null;
  mfa_enrolled: boolean;
  session_expires_at: string;
}

/** The signed-in identity, resolved from the session token on every request. */
export function browserIdentity(options: {
  root: string;
  masterKey: string;
  token: string;
}): BrowserIdentity {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const actor = resolveActor(session, options.token, { action: 'session_check', scope: 'deployment' });
  return {
    username: actor.user.username,
    deployment_role: actor.user.deployment_role,
    mfa_enrolled: actor.user.mfa !== null,
    session_expires_at: actor.session.expires_at,
  };
}

export interface NavigationOptions {
  root: string;
  masterKey: string;
  token: string;
  /** The Workspace the browser asked for; an unauthorized one grants nothing. */
  workspaceId?: string;
}

/**
 * The authorized shell: the two navigation trees, the Workspaces the actor may
 * enter, the active Workspace and its activity. A Workspace the actor does not
 * belong to answers exactly like one that does not exist, so no identifier ever
 * confirms an existence the actor may not see.
 */
export function browserNavigation(options: NavigationOptions): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'browser_navigation', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);

  const authorized = authorizedWorkspaces(session.state, actor.user.user_id);
  const active = options.workspaceId === undefined
    ? undefined
    : authorized.find((entry) => entry.workspace.workspace_id === options.workspaceId);
  const deployment = isDeploymentAdministrator(actor.user)
    ? DEPLOYMENT_NAVIGATION.map((key) => ({ key }))
    : [];
  const workspace = active === undefined
    ? []
    : WORKSPACE_NAVIGATION[active.role].map((key) => ({ key }));

  session.audit({
    action: 'browser_navigation',
    scope: active === undefined ? 'deployment' : 'workspace',
    ...(active === undefined ? {} : { workspace_id: active.workspace.workspace_id }),
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
  });

  return {
    username: actor.user.username,
    deployment_role: actor.user.deployment_role,
    session_expires_at: actor.session.expires_at,
    deployment,
    workspace_id: active?.workspace.workspace_id ?? null,
    workspace_name: active?.workspace.name ?? null,
    workspace_role: active?.role ?? null,
    workspace,
    workspaces: authorized.map((entry) => ({
      workspace_id: entry.workspace.workspace_id,
      name: entry.workspace.name,
      role: entry.role,
    })),
    activity: activityCentre(session.state, active?.workspace.workspace_id ?? null),
  };
}
