import { useEffect, useState } from 'react';
import { platformApi, type DeploymentWorkspace } from '../api.js';
import { roleLabel } from '../format.js';
import { t } from '../i18n/zh-CN.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';

export interface PlatformDeploymentScreenProps {
  onSessionLost: () => void;
}

/**
 * Deployment-level governance: the Workspaces that exist, and the Role the actor
 * holds in each. It deliberately reads no Workspace business content.
 */
export function PlatformDeploymentScreen({ onSessionLost }: PlatformDeploymentScreenProps) {
  const [workspaces, setWorkspaces] = useState<DeploymentWorkspace[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void platformApi.deploymentWorkspaces().then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setWorkspaces(result.data.workspaces);
    });
    return () => {
      active = false;
    };
  }, [onSessionLost]);

  return (
    <Panel level={1} title={t('deployment.workspaces.title')} description={t('deployment.workspaces.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {workspaces === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : workspaces.length === 0 ? (
        <p className="empty">{t('deployment.workspaces.empty')}</p>
      ) : (
        <DefinitionList
          rows={workspaces.map((workspace) => ({ term: workspace.name, value: roleLabel(workspace.role) }))}
        />
      )}
    </Panel>
  );
}
