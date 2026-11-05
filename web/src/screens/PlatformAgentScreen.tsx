import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type AgentClientCreated,
  type AgentClientView,
  type AgentDelegationView,
  type AgentGrantView,
  type AgentIdentityList,
  type AgentIdentityView,
  type WorkspaceAgentAccessView,
  type WorkspaceAgentView,
} from '../api.js';
import { apiFailureText, formatInstant, roleLabel } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

export interface AgentScreenProps {
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

type Pending =
  | { kind: 'create'; name: string; workspaceIds: string[]; scopes: string[] }
  | { kind: 'revoke'; agent: AgentIdentityView }
  | { kind: 'register'; agent: AgentIdentityView; clientId: string; clientName: string; redirectUris: string[] }
  | { kind: 'revokeClient'; client: AgentClientView };

/** The governed scope id picks the Chinese label; the id itself never becomes a catalog key. */
function scopeLabel(scope: string): string {
  return optional(`value.mcpScope.${scope.replace(/:/gu, '.')}`) ?? scope;
}

function scopesLabel(scopes: string[]): string {
  return scopes.map(scopeLabel).join('、');
}

/** Splits the one-per-line redirect field without deciding anything itself. */
function lines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * External Consumer principals: explicit Workspace bindings, MCP scope ceilings,
 * pre-registered OAuth clients, and delegated consent. The screen never offers a
 * way to grant administrative authority or raw-data access, because the
 * governed module has no such state to set.
 */
export function AgentIdentities({ onSessionLost }: AgentScreenProps) {
  const [list, setList] = useState<AgentIdentityList | null>(null);
  const [workspaces, setWorkspaces] = useState<Array<{ workspace_id: string; name: string }>>([]);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [bound, setBound] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>(['mcp:read']);
  const [clientAgent, setClientAgent] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [redirects, setRedirects] = useState('');
  const [secret, setSecret] = useState<AgentClientCreated | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [identities, deploymentWorkspaces] = await Promise.all([
      platformApi.agentIdentities(),
      platformApi.deploymentWorkspaces(),
    ]);
    if (!identities.ok) {
      if (identities.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setList(identities.data);
    if (deploymentWorkspaces.ok) {
      setWorkspaces(deploymentWorkspaces.data.workspaces.map((entry) => ({
        workspace_id: entry.workspace_id,
        name: entry.name,
      })));
    }
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const failedWrite = (result: { status: number; error: { code: string } }): void => {
    setBusy(false);
    setPending(null);
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
  };

  const confirm = (): void => {
    if (pending === null) return;
    setBusy(true);
    setNotice(null);
    if (pending.kind === 'create') {
      void platformApi.createAgentIdentity(pending.name, pending.workspaceIds, pending.scopes).then(async (result) => {
        if (!result.ok) {
          failedWrite(result);
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setName('');
        setBound([]);
        setScopes(['mcp:read']);
        setNotice({ tone: 'info', text: message('deployment.agents.created', { name: result.data.name }) });
      });
      return;
    }
    if (pending.kind === 'revoke') {
      void platformApi.revokeAgentIdentity(pending.agent.agent_identity_id).then(async (result) => {
        if (!result.ok) {
          failedWrite(result);
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setNotice({ tone: 'info', text: message('deployment.agents.revoked', { name: pending.agent.name }) });
      });
      return;
    }
    if (pending.kind === 'register') {
      void platformApi.registerAgentClient(pending.agent.agent_identity_id, {
        client_id: pending.clientId,
        client_name: pending.clientName,
        redirect_uris: pending.redirectUris,
      }).then(async (result) => {
        if (!result.ok) {
          failedWrite(result);
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setSecret(result.data);
        setClientId('');
        setClientName('');
        setRedirects('');
        setNotice({
          tone: 'info',
          text: message('deployment.agentClients.registered', { client_id: result.data.client_id }),
        });
      });
      return;
    }
    void platformApi.revokeAgentClient(pending.client.client_id).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPending(null);
      setNotice({
        tone: 'info',
        text: message('deployment.agentClients.revokedMessage', { client_id: pending.client.client_id }),
      });
    });
  };

  const agents = list?.agent_identities ?? [];
  const activeAgents = agents.filter((agent) => agent.status === 'active');
  const clients = agents.flatMap((agent) => agent.clients.map((client) => ({ agent, client })));
  const selectedClientAgent = activeAgents.find((agent) => agent.agent_identity_id === clientAgent) ?? null;

  return (
    <Panel level={2} title={t('deployment.agents.title')} description={t('deployment.agents.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {list === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : agents.length === 0 ? (
        <p className="empty">{t('deployment.agents.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('deployment.agents.name')}</th>
              <th scope="col">{t('deployment.agents.workspaces')}</th>
              <th scope="col">{t('deployment.agents.scopes')}</th>
              <th scope="col">{t('deployment.agents.grants')}</th>
              <th scope="col">{t('deployment.agents.clients')}</th>
              <th scope="col">{t('deployment.agents.authority')}</th>
              <th scope="col">{t('deployment.agents.status')}</th>
              <th scope="col">{t('deployment.agents.createdAt')}</th>
              <th scope="col">{t('deployment.agents.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.agent_identity_id}>
                <td className="data-table__mono">{agent.name}</td>
                <td>{agent.workspaces.map((entry) => entry.name).join('、') || '—'}</td>
                <td>{scopesLabel(agent.scopes)}</td>
                <td>
                  {message('deployment.agents.grantCount', {
                    count: String(agent.active_grant_count),
                  })}
                </td>
                <td>
                  {message('deployment.agents.clientCount', {
                    count: String(agent.clients.filter((client) => client.revoked_at === null).length),
                  })}
                </td>
                <td>{t('deployment.agents.authorityValue')}</td>
                <td>
                  {agent.status === 'active'
                    ? t('value.identityStatus.active')
                    : t('deployment.agents.revokedStatus')}
                </td>
                <td>{formatInstant(agent.created_at)}</td>
                <td>
                  {agent.status === 'active' ? (
                    <Button
                      variant="quiet"
                      busy={busy}
                      onClick={() => {
                        setNotice(null);
                        setPending({ kind: 'revoke', agent });
                      }}
                    >
                      {message('deployment.agents.revoke', { name: agent.name })}
                    </Button>
                  ) : (
                    t('deployment.users.none')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Panel
        level={2}
        title={t('deployment.agents.create.title')}
        description={t('deployment.agents.create.description')}
      >
        <div className="form__grid">
          <Field
            id="agent-name"
            label={t('deployment.agents.create.name')}
            value={name}
            onChange={setName}
            hint={t('deployment.agents.create.nameHint')}
            mono
          />
        </div>
        <fieldset className="fieldset">
          <legend className="field__label">{t('deployment.agents.workspaces')}</legend>
          {workspaces.length === 0 ? (
            <p className="empty">{t('deployment.serviceIdentities.noWorkspace')}</p>
          ) : (
            <div className="choices">
              {workspaces.map((workspace) => (
                <label className="choice" key={workspace.workspace_id} htmlFor={`agent-workspace-${workspace.workspace_id}`}>
                  <input
                    id={`agent-workspace-${workspace.workspace_id}`}
                    name="agent-workspaces"
                    type="checkbox"
                    value={workspace.workspace_id}
                    checked={bound.includes(workspace.workspace_id)}
                    onChange={(event) => {
                      setBound((current) => event.target.checked
                        ? [...current, workspace.workspace_id]
                        : current.filter((id) => id !== workspace.workspace_id));
                    }}
                  />
                  {workspace.name}
                </label>
              ))}
            </div>
          )}
          <p className="field__hint">{t('deployment.agents.create.nameHint')}</p>
        </fieldset>
        <fieldset className="fieldset">
          <legend className="field__label">{t('deployment.agents.scopes')}</legend>
          <p className="field__hint">{t('deployment.agents.create.scopesHint')}</p>
          <div className="choices">
            {['mcp:read', 'mcp:nlq'].map((scope) => (
              <label className="choice" key={scope} htmlFor={`agent-scope-${scope}`}>
                <input
                  id={`agent-scope-${scope}`}
                  name="agent-scopes"
                  type="checkbox"
                  value={scope}
                  checked={scopes.includes(scope)}
                  onChange={(event) => {
                    setScopes((current) => event.target.checked
                      ? [...current, scope]
                      : current.filter((entry) => entry !== scope));
                  }}
                />
                {scopeLabel(scope)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form__actions">
          <Button
            busy={busy}
            onClick={() => {
              setNotice(null);
              setPending({ kind: 'create', name: name.trim(), workspaceIds: bound, scopes });
            }}
          >
            {t('deployment.agents.create.submit')}
          </Button>
        </div>
      </Panel>

      <Panel
        level={2}
        title={t('deployment.agentClients.title')}
        description={t('deployment.agentClients.description')}
      >
        {secret === null ? null : (
          <Panel
            level={2}
            title={t('deployment.agentClients.oneTimeTitle')}
            description={t('deployment.agentClients.oneTimeDescription')}
          >
            <DefinitionList
              rows={[
                { term: t('deployment.agentClients.clientId'), value: secret.client_id, mono: true },
                { term: t('deployment.agentClients.secret'), value: secret.client_secret, mono: true },
              ]}
            />
          </Panel>
        )}
        {clients.length === 0 ? (
          <p className="empty">{t('deployment.agentClients.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('deployment.agentClients.clientId')}</th>
                <th scope="col">{t('deployment.agentClients.agent')}</th>
                <th scope="col">{t('deployment.agentClients.redirects')}</th>
                <th scope="col">{t('deployment.agentClients.status')}</th>
                <th scope="col">{t('deployment.agentClients.createdAt')}</th>
                <th scope="col">{t('deployment.agentClients.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(({ agent, client }) => (
                <tr key={client.client_id}>
                  <td className="data-table__mono">{client.client_id}</td>
                  <td>{agent.name}</td>
                  <td className="data-table__mono">{client.redirect_uris.join('、')}</td>
                  <td>
                    {client.revoked_at === null
                      ? t('deployment.agentClients.active')
                      : t('deployment.agentClients.revoked')}
                  </td>
                  <td>{formatInstant(client.created_at)}</td>
                  <td>
                    {client.revoked_at === null ? (
                      <Button
                        variant="quiet"
                        busy={busy}
                        onClick={() => {
                          setNotice(null);
                          setPending({ kind: 'revokeClient', client });
                        }}
                      >
                        {message('deployment.agentClients.revoke', { client_id: client.client_id })}
                      </Button>
                    ) : (
                      t('deployment.users.none')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="form__grid">
          <div className="field">
            <label className="field__label" htmlFor="agent-client-agent">
              {t('deployment.agentClients.agent')}
            </label>
            <select
              className="field__input"
              id="agent-client-agent"
              name="agent-client-agent"
              value={clientAgent}
              onChange={(event) => setClientAgent(event.target.value)}
            >
              <option value="">—</option>
              {activeAgents.map((agent) => (
                <option key={agent.agent_identity_id} value={agent.agent_identity_id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          <Field
            id="agent-client-id"
            label={t('deployment.agentClients.clientId')}
            value={clientId}
            onChange={setClientId}
            hint={t('deployment.agentClients.registerHint')}
            mono
          />
          <Field
            id="agent-client-name"
            label={t('deployment.agentClients.clientName')}
            value={clientName}
            onChange={setClientName}
            mono
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="agent-client-redirects">
            {t('deployment.agentClients.redirects')}
          </label>
          <textarea
            className="field__input field__input--mono"
            id="agent-client-redirects"
            name="agent-client-redirects"
            rows={3}
            value={redirects}
            onChange={(event) => setRedirects(event.target.value)}
            spellCheck={false}
          />
          <p className="field__hint">{t('deployment.agentClients.redirectHint')}</p>
        </div>
        <div className="form__actions">
          <Button
            busy={busy}
            onClick={() => {
              if (selectedClientAgent === null) {
                setNotice({ tone: 'error', text: t('deployment.agentClients.selectAgent') });
                return;
              }
              setNotice(null);
              setPending({
                kind: 'register',
                agent: selectedClientAgent,
                clientId: clientId.trim(),
                clientName: clientName.trim(),
                redirectUris: lines(redirects),
              });
            }}
          >
            {t('deployment.agentClients.register')}
          </Button>
        </div>
      </Panel>

      {pending?.kind === 'create' ? (
        <Confirmation
          title={t('deployment.agents.create.confirmTitle')}
          target={pending.name}
          scope={t('value.auditScope.deployment')}
          consequence={t('deployment.agents.create.consequence')}
          confirmLabel={t('deployment.agents.create.confirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'revoke' ? (
        <Confirmation
          title={t('deployment.agents.revokeConfirmTitle')}
          target={pending.agent.name}
          scope={t('value.auditScope.deployment')}
          consequence={t('deployment.agents.revokeConsequence')}
          confirmLabel={t('deployment.agents.revokeConfirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'register' ? (
        <Confirmation
          title={t('deployment.agentClients.registerConfirmTitle')}
          target={`${pending.agent.name} · ${pending.clientId}`}
          scope={t('value.auditScope.deployment')}
          consequence={t('deployment.agentClients.registerConsequence')}
          confirmLabel={t('deployment.agentClients.registerConfirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'revokeClient' ? (
        <Confirmation
          title={t('deployment.agentClients.revokeConfirmTitle')}
          target={pending.client.client_id}
          scope={t('value.auditScope.deployment')}
          consequence={t('deployment.agentClients.revokeConsequence')}
          confirmLabel={t('deployment.agentClients.revokeConfirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </Panel>
  );
}

function filterText(grant: AgentGrantView): string {
  return grant.row_filters
    .map((filter) => `${filter.field} ${filter.op} ${filter.value === null ? '空值' : String(filter.value)}`)
    .join('；');
}

function grantDetail(grant: AgentGrantView): string {
  const columns = grant.columns === null
    ? t('workspace.agents.grantAllColumns')
    : message('workspace.agents.grantColumns', { columns: grant.columns.join('、') });
  if (grant.row_filters.length === 0) return columns;
  return `${columns}；${message('workspace.agents.grantFilters', { filters: filterText(grant) })}`;
}

function delegationStatus(delegation: AgentDelegationView): string {
  return delegation.status === 'active'
    ? t('workspace.agents.delegationActive')
    : t('workspace.agents.delegationInactive');
}

type WorkspacePending =
  | { kind: 'grant'; agent: WorkspaceAgentView; product: { data_product_id: string; name: string } }
  | { kind: 'revokeGrant'; agent: WorkspaceAgentView; grant: AgentGrantView }
  | { kind: 'delegate'; agent: WorkspaceAgentView }
  | { kind: 'revokeDelegation'; agent: WorkspaceAgentView; delegation: AgentDelegationView };

/**
 * Agent access inside the active Workspace. A Workspace Administrator narrows
 * an Agent Identity with Data Product Grants, records only their own delegated
 * consent, and can revoke either. The effective delegated authority is always
 * the intersection of both parties, and every revocation binds the next request.
 */
export function WorkspaceAgents({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [view, setView] = useState<WorkspaceAgentAccessView | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<WorkspacePending | null>(null);
  const [busy, setBusy] = useState(false);
  const [grantAgent, setGrantAgent] = useState('');
  const [grantProduct, setGrantProduct] = useState('');
  const [grantColumns, setGrantColumns] = useState('');
  const [grantFilters, setGrantFilters] = useState('');
  const [delegationAgent, setDelegationAgent] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const result = await platformApi.workspaceAgents(workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setView(result.data);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const failedWrite = (result: { status: number; error: { code: string } }): void => {
    setBusy(false);
    setPending(null);
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
  };

  const confirm = (): void => {
    if (pending === null) return;
    setBusy(true);
    setNotice(null);
    if (pending.kind === 'grant') {
      void platformApi.publishAgentGrant(
        pending.agent.agent_identity_id,
        pending.product.data_product_id,
        grantColumns,
        grantFilters,
      ).then(async (result) => {
        if (!result.ok) {
          failedWrite(result);
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setGrantColumns('');
        setGrantFilters('');
        setNotice({
          tone: 'info',
          text: message('workspace.agents.grant.published', {
            agent: pending.agent.name,
            product: pending.product.name,
          }),
        });
      });
      return;
    }
    if (pending.kind === 'revokeGrant') {
      void platformApi.revokeAgentGrant(pending.grant.grant_id).then(async (result) => {
        if (!result.ok) {
          failedWrite(result);
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setNotice({ tone: 'info', text: t('workspace.agents.grant.revoked') });
      });
      return;
    }
    if (pending.kind === 'delegate') {
      void platformApi.recordAgentDelegation(workspaceId, pending.agent.agent_identity_id).then(async (result) => {
        if (!result.ok) {
          failedWrite(result);
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setNotice({
          tone: 'info',
          text: result.data.already_existing === true
            ? t('workspace.agents.delegation.existing')
            : message('workspace.agents.delegation.recorded', { agent: pending.agent.name }),
        });
      });
      return;
    }
    void platformApi.revokeAgentDelegation(pending.delegation.delegation_id).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPending(null);
      setNotice({
        tone: 'info',
        text: message('workspace.agents.delegation.revoked', {
          username: pending.delegation.username ?? pending.agent.name,
        }),
      });
    });
  };

  const agents = view?.agents ?? [];
  const activeAgents = agents.filter((agent) => agent.status === 'active');
  const products = view?.data_products ?? [];
  const selectedGrantAgent = activeAgents.find((agent) => agent.agent_identity_id === grantAgent) ?? null;
  const selectedProduct = products.find((product) => product.data_product_id === grantProduct) ?? null;
  const selectedDelegationAgent = activeAgents.find((agent) => agent.agent_identity_id === delegationAgent) ?? null;
  const delegations = agents.flatMap((agent) => agent.delegations.map((delegation) => ({ agent, delegation })));

  return (
    <Panel level={1} title={t('workspace.agents.title')} description={t('workspace.agents.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {view === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : agents.length === 0 ? (
        <p className="empty">{t('workspace.agents.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('workspace.agents.name')}</th>
              <th scope="col">{t('workspace.agents.scopes')}</th>
              <th scope="col">{t('workspace.agents.grants')}</th>
              <th scope="col">{t('workspace.agents.delegations')}</th>
              <th scope="col">{t('workspace.agents.status')}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.agent_identity_id}>
                <td className="data-table__mono">{agent.name}</td>
                <td>{scopesLabel(agent.scopes)}</td>
                <td>
                  {agent.grants.length === 0 ? t('workspace.agents.noGrants') : agent.grants.map((grant) => (
                    <div key={grant.grant_id}>
                      {message('workspace.agents.grantValue', {
                        product: grant.data_product_name ?? grant.data_product_id,
                        detail: grantDetail(grant),
                      })}
                      <Button
                        variant="quiet"
                        busy={busy}
                        onClick={() => {
                          setNotice(null);
                          setPending({ kind: 'revokeGrant', agent, grant });
                        }}
                      >
                        {t('workspace.agents.grant.revoke')}
                      </Button>
                    </div>
                  ))}
                </td>
                <td>
                  {agent.delegations.length === 0
                    ? t('workspace.agents.noDelegations')
                    : agent.delegations.map((delegation) => (
                      <div key={delegation.delegation_id}>
                        {message('workspace.agents.delegationValue', {
                          username: delegation.username ?? '—',
                          role: roleLabel(delegation.role),
                          status: delegationStatus(delegation),
                        })}
                      </div>
                    ))}
                </td>
                <td>{agent.status === 'active' ? t('value.identityStatus.active') : t('deployment.agents.revokedStatus')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Panel
        level={2}
        title={t('workspace.agents.grant.title')}
        description={t('workspace.agents.grant.description')}
      >
        {activeAgents.length === 0 ? (
          <p className="empty">{t('workspace.agents.grant.noAgent')}</p>
        ) : products.length === 0 ? (
          <p className="empty">{t('workspace.agents.grant.emptyProducts')}</p>
        ) : (
          <>
            <div className="form__grid">
              <div className="field">
                <label className="field__label" htmlFor="workspace-agent-grant-agent">
                  {t('workspace.agents.grant.agent')}
                </label>
                <select
                  className="field__input"
                  id="workspace-agent-grant-agent"
                  name="workspace-agent-grant-agent"
                  value={grantAgent}
                  onChange={(event) => setGrantAgent(event.target.value)}
                >
                  <option value="">—</option>
                  {activeAgents.map((agent) => (
                    <option key={agent.agent_identity_id} value={agent.agent_identity_id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="workspace-agent-grant-product">
                  {t('workspace.agents.grant.product')}
                </label>
                <select
                  className="field__input"
                  id="workspace-agent-grant-product"
                  name="workspace-agent-grant-product"
                  value={grantProduct}
                  onChange={(event) => setGrantProduct(event.target.value)}
                >
                  <option value="">—</option>
                  {products.map((product) => (
                    <option key={product.data_product_id} value={product.data_product_id}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                id="workspace-agent-grant-columns"
                label={t('workspace.agents.grant.columns')}
                value={grantColumns}
                onChange={setGrantColumns}
                hint={t('workspace.agents.grant.columnsHint')}
                mono
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="workspace-agent-grant-filters">
                {t('workspace.agents.grant.rowFilters')}
              </label>
              <textarea
                className="field__input field__input--mono"
                id="workspace-agent-grant-filters"
                name="workspace-agent-grant-filters"
                rows={3}
                value={grantFilters}
                onChange={(event) => setGrantFilters(event.target.value)}
                spellCheck={false}
              />
              <p className="field__hint">{t('workspace.agents.grant.rowFiltersHint')}</p>
            </div>
            <div className="form__actions">
              <Button
                busy={busy}
                onClick={() => {
                  if (selectedGrantAgent === null || selectedProduct === null) {
                    setNotice({ tone: 'error', text: t('workspace.agents.grant.choose') });
                    return;
                  }
                  setNotice(null);
                  setPending({ kind: 'grant', agent: selectedGrantAgent, product: selectedProduct });
                }}
              >
                {t('workspace.agents.grant.submit')}
              </Button>
            </div>
          </>
        )}
      </Panel>

      <Panel
        level={2}
        title={t('workspace.agents.delegation.title')}
        description={t('workspace.agents.delegation.description')}
      >
        {activeAgents.length === 0 ? (
          <p className="empty">{t('workspace.agents.delegation.emptyAgents')}</p>
        ) : (
          <div className="form__grid">
            <div className="field">
              <label className="field__label" htmlFor="workspace-agent-delegation-agent">
                {t('workspace.agents.delegation.agent')}
              </label>
              <select
                className="field__input"
                id="workspace-agent-delegation-agent"
                name="workspace-agent-delegation-agent"
                value={delegationAgent}
                onChange={(event) => setDelegationAgent(event.target.value)}
              >
                <option value="">—</option>
                {activeAgents.map((agent) => (
                  <option key={agent.agent_identity_id} value={agent.agent_identity_id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {activeAgents.length === 0 ? null : (
          <div className="form__actions">
            <Button
              busy={busy}
              onClick={() => {
                if (selectedDelegationAgent === null) {
                  setNotice({ tone: 'error', text: t('workspace.agents.delegation.choose') });
                  return;
                }
                setNotice(null);
                setPending({ kind: 'delegate', agent: selectedDelegationAgent });
              }}
            >
              {t('workspace.agents.delegation.submit')}
            </Button>
          </div>
        )}
        <h3 className="panel__title">{t('workspace.agents.delegation.tableTitle')}</h3>
        {delegations.length === 0 ? (
          <p className="empty">{t('workspace.agents.delegation.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('workspace.agents.delegation.user')}</th>
                <th scope="col">{t('workspace.agents.delegation.role')}</th>
                <th scope="col">{t('workspace.agents.delegation.agent')}</th>
                <th scope="col">{t('workspace.agents.delegation.status')}</th>
                <th scope="col">{t('workspace.agents.delegation.createdAt')}</th>
                <th scope="col">{t('workspace.agents.delegations')}</th>
                <th scope="col">{t('workspace.agents.delegation.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {delegations.map(({ agent, delegation }) => (
                <tr key={delegation.delegation_id}>
                  <td className="data-table__mono">{delegation.username ?? '—'}</td>
                  <td>{roleLabel(delegation.role)}</td>
                  <td>{agent.name}</td>
                  <td>{delegationStatus(delegation)}</td>
                  <td>{formatInstant(delegation.created_at)}</td>
                  <td>
                    {delegation.status === 'active'
                      ? message('workspace.agents.delegation.effective', {
                        agent: agent.name,
                        username: delegation.username ?? '—',
                        role: roleLabel(delegation.role),
                        workspace: view?.workspace_name ?? '',
                      })
                      : t('workspace.agents.delegation.effectiveInactive')}
                  </td>
                  <td>
                    {delegation.revoked_at === null ? (
                      <Button
                        variant="quiet"
                        busy={busy}
                        onClick={() => {
                          setNotice(null);
                          setPending({ kind: 'revokeDelegation', agent, delegation });
                        }}
                      >
                        {t('workspace.agents.delegation.revoke')}
                      </Button>
                    ) : (
                      t('deployment.users.none')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {pending?.kind === 'grant' ? (
        <Confirmation
          title={t('workspace.agents.grant.confirmTitle')}
          target={`${pending.agent.name} · ${pending.product.name}`}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.agents.grant.consequence')}
          confirmLabel={t('workspace.agents.grant.confirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'revokeGrant' ? (
        <Confirmation
          title={t('workspace.agents.grant.revokeTitle')}
          target={`${pending.agent.name} · ${pending.grant.data_product_name ?? pending.grant.data_product_id}`}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.agents.grant.revokeConsequence')}
          confirmLabel={t('workspace.agents.grant.revokeConfirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'delegate' ? (
        <Confirmation
          title={t('workspace.agents.delegation.confirmTitle')}
          target={pending.agent.name}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.agents.delegation.consequence')}
          confirmLabel={t('workspace.agents.delegation.confirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'revokeDelegation' ? (
        <Confirmation
          title={t('workspace.agents.delegation.revokeTitle')}
          target={`${pending.delegation.username ?? '—'} · ${pending.agent.name}`}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.agents.delegation.revokeConsequence')}
          confirmLabel={t('workspace.agents.delegation.revokeConfirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </Panel>
  );
}
