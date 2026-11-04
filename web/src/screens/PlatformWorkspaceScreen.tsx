import { useEffect, useState } from 'react';
import { platformApi, type ContextView, type DataProductList, type WorkspaceRoleValue } from '../api.js';
import { formatInstant, roleLabel } from '../format.js';
import { optional, t } from '../i18n/zh-CN.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';

export interface WorkspaceViewProps {
  workspaceId: string;
  onSessionLost: () => void;
}

export interface WorkspaceOverviewProps {
  workspaceName: string;
  role: WorkspaceRoleValue;
  sessionExpiresAt: string;
}

/** Identity and authorization for the one active Workspace. */
export function WorkspaceOverview({ workspaceName, role, sessionExpiresAt }: WorkspaceOverviewProps) {
  return (
    <Panel level={1} title={t('workspace.overview.title')} description={t('workspace.overview.description')}>
      <DefinitionList
        rows={[
          { term: t('workspace.overview.workspace'), value: workspaceName },
          { term: t('workspace.overview.role'), value: roleLabel(role) },
          { term: t('session.expires'), value: formatInstant(sessionExpiresAt) },
        ]}
      />
    </Panel>
  );
}

/** The Data Products published in the active Workspace. */
export function WorkspaceProducts({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [list, setList] = useState<DataProductList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setList(null);
    setFailed(false);
    void platformApi.dataProducts(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setList(result.data);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost]);

  return (
    <Panel level={1} title={t('workspace.products.title')} description={t('workspace.products.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {list === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : list.data_products.length === 0 ? (
        <p className="empty">{t('workspace.products.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('workspace.products.name')}</th>
              <th scope="col">{t('workspace.products.apiPath')}</th>
              <th scope="col">{t('workspace.products.version')}</th>
              <th scope="col">{t('workspace.products.release')}</th>
            </tr>
          </thead>
          <tbody>
            {list.data_products.map((product) => (
              <tr key={product.data_product_id}>
                <td>{product.name}</td>
                <td className="data-table__mono">{product.api_path}</td>
                <td>{product.data_product_version}</td>
                <td>{product.data_product_release}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** The Business Context published for the active Workspace, never merged. */
export function WorkspaceContext({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [context, setContext] = useState<ContextView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setContext(null);
    setFailed(false);
    void platformApi.context(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setContext(result.data);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost]);

  return (
    <Panel level={1} title={t('workspace.context.title')} description={t('workspace.context.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {context === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : (
        <>
          <p className="context__meta">
            <span>
              {t('workspace.context.version')} <strong>{context.business_context_version}</strong>
            </span>
            <span>
              {t('workspace.context.hash')} <code>{context.content_hash}</code>
            </span>
          </p>
          {context.entries.length === 0 ? (
            <p className="empty">{t('workspace.context.empty')}</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.context.key')}</th>
                  <th scope="col">{t('workspace.context.value')}</th>
                  <th scope="col">{t('workspace.context.unit')}</th>
                  <th scope="col">{t('workspace.context.source')}</th>
                </tr>
              </thead>
              <tbody>
                {context.entries.map((entry) => (
                  <tr key={entry.key}>
                    <td className="data-table__mono">{entry.key}</td>
                    <td>{entry.value}</td>
                    <td>{entry.unit ?? '—'}</td>
                    <td>{optional(`value.contextSource.${entry.source}`) ?? entry.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}
