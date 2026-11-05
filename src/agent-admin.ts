import { resolveActor } from './auth.js';
import {
  actorLabel,
  requireDeploymentAdministrator,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import {
  findUserById,
  findWorkspace,
  workspaceRoleOf,
  type AgentIdentityRecord,
  type PlatformState,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';

/**
 * What an Agent Identity may do, stated once so no browser surface has to infer
 * it. An Agent Identity consumes governed data and nothing else: it never owns,
 * approves, publishes, or mutates an Artifact, never receives administrative
 * authority, and never reaches raw acquisitions or credentials.
 */
const AGENT_CAPABILITIES = {
  consumes_data_products: true,
  administrative_authority: false,
  raw_data_access: false,
  owns_artifacts: false,
} as const;

function workspaceBindings(state: PlatformState, workspaceIds: string[]): Array<{ workspace_id: string; name: string }> {
  return workspaceIds.flatMap((workspaceId) => {
    const workspace = findWorkspace(state, workspaceId);
    return workspace === undefined ? [] : [{ workspace_id: workspace.workspace_id, name: workspace.name }];
  });
}

function delegationView(session: PlatformSession, delegation: PlatformState['agent_delegations'][number]): Record<string, unknown> {
  const user = findUserById(session.state, delegation.user_id);
  const role = workspaceRoleOf(session.state, delegation.user_id, delegation.workspace_id);
  const agent = session.state.agent_identities.find(
    (candidate) => candidate.agent_identity_id === delegation.agent_identity_id,
  );
  const active = delegation.revoked_at === null
    && user?.status === 'active'
    && role !== null
    && agent?.status === 'active';
  return {
    delegation_id: delegation.delegation_id,
    workspace_id: delegation.workspace_id,
    workspace_name: findWorkspace(session.state, delegation.workspace_id)?.name ?? null,
    user_id: delegation.user_id,
    username: user?.username ?? null,
    role,
    status: active ? 'active' : 'inactive',
    created_at: delegation.created_at,
    revoked_at: delegation.revoked_at,
  };
}

function agentView(session: PlatformSession, agent: AgentIdentityRecord): Record<string, unknown> {
  return {
    agent_identity_id: agent.agent_identity_id,
    name: agent.name,
    workspace_ids: [...agent.workspace_ids],
    workspaces: workspaceBindings(session.state, agent.workspace_ids),
    scopes: [...agent.scopes],
    status: agent.status,
    created_at: agent.created_at,
    revoked_at: agent.revoked_at,
    capabilities: { ...AGENT_CAPABILITIES },
    // Grants and their narrowings stay Workspace-scoped; the Deployment view
    // discloses only how many are in force, never a product name or column.
    active_grant_count: session.state.data_product_grants.filter(
      (grant) => grant.grantee_agent_identity_id === agent.agent_identity_id && grant.revoked_at === null,
    ).length,
    clients: session.state.oauth_clients
      .filter((client) => client.agent_identity_id === agent.agent_identity_id)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .map((client) => ({
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: [...client.redirect_uris],
        created_at: client.created_at,
        revoked_at: client.revoked_at,
      })),
    delegations: session.state.agent_delegations
      .filter((delegation) => delegation.agent_identity_id === agent.agent_identity_id)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .map((delegation) => delegationView(session, delegation)),
  };
}

/**
 * Lists every Agent Identity with the Workspaces, scopes, OAuth clients, and
 * delegated consents it holds. Client secrets, secret hashes, and access tokens
 * are absent rather than redacted: the record only ever stores hashes, and this
 * view never reads them.
 */
export function listAgentIdentities(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'agent_identity_listing', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const agentIdentities = [...session.state.agent_identities]
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.name.localeCompare(right.name))
    .map((agent) => agentView(session, agent));
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { agent_identities_returned: agentIdentities.length },
  });
  return { agent_identities: agentIdentities };
}

/**
 * What one Workspace Administrator administers of each Agent Identity bound to
 * the Workspace: the scope ceiling, the Grants narrowing its reads, and every
 * delegated consent with the User role that bounds it right now. A Workspace
 * the actor does not administer answers exactly like one that does not exist.
 */
export function showWorkspaceAgentAccess(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'workspace_agent_access_read',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  const workspace = requireWorkspaceAdministrator(session, actor, context, options.workspaceId);

  const agents = session.state.agent_identities
    .filter((agent) => agent.workspace_ids.includes(workspace.workspace_id))
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.name.localeCompare(right.name))
    .map((agent) => ({
      agent_identity_id: agent.agent_identity_id,
      name: agent.name,
      scopes: [...agent.scopes],
      status: agent.status,
      created_at: agent.created_at,
      grants: session.state.data_product_grants
        .filter(
          (grant) => grant.workspace_id === workspace.workspace_id
            && grant.grantee_agent_identity_id === agent.agent_identity_id
            && grant.revoked_at === null,
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((grant) => {
          const product = session.state.data_products.find(
            (candidate) => candidate.data_product_id === grant.data_product_id,
          );
          return {
            grant_id: grant.grant_id,
            data_product_id: grant.data_product_id,
            data_product_name: product?.name ?? null,
            columns: grant.columns === null ? null : [...grant.columns],
            row_filters: grant.row_filters.map((filter) => ({ ...filter })),
            created_at: grant.created_at,
          };
        }),
      delegations: session.state.agent_delegations
        .filter(
          (delegation) => delegation.workspace_id === workspace.workspace_id
            && delegation.agent_identity_id === agent.agent_identity_id,
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((delegation) => delegationView(session, delegation)),
    }));

  // Only published Data Products can receive a Grant, so the form offers only
  // those; the governed module still validates every name against the Contract.
  const dataProducts = session.state.data_products
    .filter((product) => product.workspace_id === workspace.workspace_id && product.releases.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((product) => ({ data_product_id: product.data_product_id, name: product.name }));

  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { agents_returned: agents.length },
  });
  return {
    workspace_id: workspace.workspace_id,
    workspace_name: workspace.name,
    agents,
    data_products: dataProducts,
  };
}
