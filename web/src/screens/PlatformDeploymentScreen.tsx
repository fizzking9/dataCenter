import { useCallback, useEffect, useState } from 'react';
import { platformApi, type CreatedWorkspace, type DeploymentWorkspace, type EmergencyAdministrator } from '../api.js';
import { formatInstant, roleLabel } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';

export interface PlatformDeploymentScreenProps {
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

type Pending =
  | { kind: 'create'; name: string; administrator: string }
  | { kind: 'emergency'; workspace: DeploymentWorkspace; username: string };

/**
 * Deployment-level Workspace governance: which Workspaces exist, how many active
 * administrators keep each governable, the creation that names a first
 * administrator, and the emergency appointment that can never leave a Workspace
 * without one. It reads no Workspace business content.
 */
export function PlatformDeploymentScreen({ onSessionLost }: PlatformDeploymentScreenProps) {
  const [workspaces, setWorkspaces] = useState<DeploymentWorkspace[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [administrator, setAdministrator] = useState('');
  const [selected, setSelected] = useState('');
  const [emergencyAccount, setEmergencyAccount] = useState('');
  const [enrolled, setEnrolled] = useState<CreatedWorkspace | EmergencyAdministrator | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await platformApi.deploymentWorkspaces();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setWorkspaces(result.data.workspaces);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const failedWrite = (result: { status: number; error: { code: string } }, fallback: string): void => {
    setBusy(false);
    setPending(null);
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setNotice({
      tone: 'error',
      text: optional(`error.api.${result.error.code}`) ?? fallback,
      code: result.error.code,
    });
  };

  const confirm = (): void => {
    if (pending === null) return;
    setBusy(true);
    setNotice(null);
    if (pending.kind === 'create') {
      void platformApi.createDeploymentWorkspace(pending.name, pending.administrator).then(async (result) => {
        if (!result.ok) {
          failedWrite(result, t('deployment.workspaces.createFailed'));
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setName('');
        setAdministrator('');
        setEnrolled(result.data.totp_secret === undefined ? null : result.data);
        setNotice({
          tone: 'info',
          text: message('deployment.workspaces.created', { name: result.data.name }),
        });
      });
      return;
    }
    void platformApi.appointEmergencyAdministrator(pending.workspace.workspace_id, pending.username).then(async (result) => {
      if (!result.ok) {
        failedWrite(result, t('deployment.workspaces.emergency.failed'));
        return;
      }
      await load();
      setBusy(false);
      setPending(null);
      setEmergencyAccount('');
      setEnrolled(result.data.totp_secret === undefined ? null : result.data);
      setNotice({
        tone: 'info',
        text: message('deployment.workspaces.emergency.appointed', {
          username: result.data.username,
          workspace: result.data.workspace_name,
        }),
      });
    });
  };

  const selectedWorkspace = workspaces?.find((entry) => entry.workspace_id === selected) ?? null;

  return (
    <Panel
      level={1}
      title={t('deployment.workspaces.title')}
      description={t('deployment.workspaces.description')}
    >
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {workspaces === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : workspaces.length === 0 ? (
        <p className="empty">{t('deployment.workspaces.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('deployment.workspaces.name')}</th>
              <th scope="col">{t('deployment.workspaces.createdAt')}</th>
              <th scope="col">{t('deployment.workspaces.role')}</th>
              <th scope="col">{t('deployment.workspaces.administrators')}</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((workspace) => (
              <tr key={workspace.workspace_id}>
                <td>{workspace.name}</td>
                <td>{formatInstant(workspace.created_at)}</td>
                <td>{roleLabel(workspace.role)}</td>
                <td>{workspace.active_administrators === null ? '—' : String(workspace.active_administrators)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Panel
        level={2}
        title={t('deployment.workspaces.create.title')}
        description={t('deployment.workspaces.create.description')}
      >
        <div className="form__grid">
          <Field
            id="workspace-name"
            label={t('deployment.workspaces.create.name')}
            value={name}
            onChange={setName}
            hint={t('deployment.workspaces.create.nameHint')}
          />
          <Field
            id="workspace-administrator"
            label={t('deployment.workspaces.create.administrator')}
            value={administrator}
            onChange={setAdministrator}
            hint={t('deployment.workspaces.create.administratorHint')}
            mono
          />
        </div>
        <div className="form__actions">
          <Button
            busy={busy}
            onClick={() => {
              setNotice(null);
              setPending({ kind: 'create', name: name.trim(), administrator: administrator.trim() });
            }}
          >
            {t('deployment.workspaces.create.submit')}
          </Button>
        </div>
      </Panel>

      {pending?.kind === 'create' ? (
        <Confirmation
          title={t('deployment.workspaces.create.confirm')}
          target={pending.name}
          scope={t('value.auditScope.deployment')}
          consequence={`${t('deployment.workspaces.create.consequence')} ${pending.administrator}`}
          confirmLabel={t('deployment.workspaces.create.confirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      <Panel
        level={2}
        title={t('deployment.workspaces.emergency.title')}
        description={t('deployment.workspaces.emergency.description')}
      >
        {workspaces !== null && workspaces.length === 0 ? (
          <p className="empty">{t('deployment.workspaces.emergency.empty')}</p>
        ) : (
          <div className="form__grid">
            <div className="field">
              <label className="field__label" htmlFor="emergency-workspace">
                {t('deployment.workspaces.emergency.workspace')}
              </label>
              <select
                className="field__input"
                id="emergency-workspace"
                name="emergency-workspace"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="">—</option>
                {(workspaces ?? []).map((workspace) => (
                  <option key={workspace.workspace_id} value={workspace.workspace_id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
            <Field
              id="emergency-administrator"
              label={t('deployment.workspaces.emergency.account')}
              value={emergencyAccount}
              onChange={setEmergencyAccount}
              hint={t('deployment.workspaces.emergency.accountHint')}
              mono
            />
          </div>
        )}
        {workspaces !== null && workspaces.length === 0 ? null : (
          <div className="form__actions">
            <Button
              busy={busy}
              onClick={() => {
                if (selectedWorkspace === null) {
                  setNotice({ tone: 'error', text: t('deployment.workspaces.emergency.choose') });
                  return;
                }
                setNotice(null);
                setPending({
                  kind: 'emergency',
                  workspace: selectedWorkspace,
                  username: emergencyAccount.trim(),
                });
              }}
            >
              {t('deployment.workspaces.emergency.submit')}
            </Button>
          </div>
        )}
      </Panel>

      {pending?.kind === 'emergency' ? (
        <Confirmation
          title={t('deployment.workspaces.emergency.confirmTitle')}
          target={`${pending.workspace.name} · ${pending.username}`}
          scope={t('value.auditScope.workspace')}
          consequence={t('deployment.workspaces.emergency.consequence')}
          confirmLabel={t('deployment.workspaces.emergency.confirm')}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {enrolled === null ? null : (
        <Panel
          level={2}
          title={t('workspace.members.enrollment.title')}
          description={t('workspace.members.enrollment.description')}
        >
          <DefinitionList
            rows={[
              ...(enrolled.totp_secret === undefined
                ? []
                : [{ term: t('workspace.members.enrollment.secret'), value: enrolled.totp_secret, mono: true }]),
              ...(enrolled.recovery_codes === undefined
                ? []
                : [{
                    term: t('workspace.members.enrollment.recoveryCodes'),
                    value: enrolled.recovery_codes.join(' '),
                    mono: true,
                  }]),
              ...(enrolled.enrollment_uri === undefined
                ? []
                : [{ term: t('workspace.members.enrollment.uri'), value: enrolled.enrollment_uri, mono: true }]),
            ]}
          />
        </Panel>
      )}
    </Panel>
  );
}
