import { useCallback, useEffect, useState } from 'react';
import { platformApi, type DeploymentUserCreated, type DeploymentUserList } from '../api.js';
import { roleLabel } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';

export interface DeploymentAdminProps {
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

/** The one action awaiting confirmation; nothing is sent until it is confirmed. */
type Pending =
  | { kind: 'create'; username: string; administrator: boolean }
  | { kind: 'deactivate'; username: string };

/**
 * The Deployment's human identities: who may sign in, which Roles they hold,
 * how many Artifacts they are accountable for, and the two lifecycle changes a
 * Deployment Administrator may make. It reads no Workspace business content.
 */
export function DeploymentUsers({ onSessionLost }: DeploymentAdminProps) {
  const [list, setList] = useState<DeploymentUserList | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<DeploymentUserCreated | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [administrator, setAdministrator] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await platformApi.deploymentUsers();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setList(result.data);
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

  const confirmCreate = (): void => {
    if (pending?.kind !== 'create') return;
    setBusy(true);
    setNotice(null);
    void platformApi
      .createDeploymentUser({
        username: pending.username,
        password,
        deployment_administrator: pending.administrator,
      })
      .then(async (result) => {
        if (!result.ok) {
          failedWrite(result, t('deployment.users.createFailed'));
          return;
        }
        await load();
        setBusy(false);
        setPending(null);
        setAccount('');
        setPassword('');
        setAdministrator(false);
        setEnrollment(result.data.totp_secret === undefined ? null : result.data);
        setNotice({
          tone: 'info',
          text: message('deployment.users.created', { username: result.data.username }),
        });
      });
  };

  const confirmDeactivate = (): void => {
    if (pending?.kind !== 'deactivate') return;
    setBusy(true);
    setNotice(null);
    void platformApi.deactivateDeploymentUser(pending.username).then(async (result) => {
      if (!result.ok) {
        failedWrite(result, t('deployment.users.deactivateFailed'));
        return;
      }
      await load();
      setBusy(false);
      setPending(null);
      setNotice({
        tone: 'info',
        text: message('deployment.users.deactivated', { username: result.data.username }),
      });
    });
  };

  return (
    <Panel level={1} title={t('deployment.users.title')} description={t('deployment.users.description')}>
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
      ) : list.users.length === 0 ? (
        <p className="empty">{t('deployment.users.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('deployment.users.account')}</th>
              <th scope="col">{t('deployment.users.status')}</th>
              <th scope="col">{t('deployment.users.deploymentRole')}</th>
              <th scope="col">{t('deployment.users.mfa')}</th>
              <th scope="col">{t('deployment.users.workspaces')}</th>
              <th scope="col">{t('deployment.users.workspaceRoles')}</th>
              <th scope="col">{t('deployment.users.ownedArtifacts')}</th>
              <th scope="col">{t('deployment.users.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {list.users.map((user) => (
              <tr key={user.user_id}>
                <td className="data-table__mono">{user.username}</td>
                <td>{optional(`value.userStatus.${user.status}`) ?? user.status}</td>
                <td>{roleLabel(user.deployment_role)}</td>
                <td>{user.mfa_enrolled ? t('value.yes') : t('value.no')}</td>
                <td>
                  {user.workspace_roles.length === 0
                    ? t('deployment.users.none')
                    : user.workspace_roles.map((entry) => entry.workspace_name ?? entry.workspace_id).join('、')}
                </td>
                <td>
                  {user.workspace_roles.length === 0
                    ? t('deployment.users.none')
                    : user.workspace_roles.map((entry) => roleLabel(entry.role)).join('、')}
                </td>
                <td>{String(user.owned_artifacts)}</td>
                <td>
                  {user.status === 'active' ? (
                    <Button
                      variant="quiet"
                      busy={busy}
                      onClick={() => {
                        setNotice(null);
                        setPending({ kind: 'deactivate', username: user.username });
                      }}
                    >
                      {message('deployment.users.deactivate', { username: user.username })}
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

      {pending?.kind === 'deactivate' ? (
        <Confirmation
          title={t('deployment.users.deactivate.title')}
          target={pending.username}
          scope={t('value.auditScope.deployment')}
          consequence={t('deployment.users.deactivate.consequence')}
          confirmLabel={t('deployment.users.deactivate.confirm')}
          busy={busy}
          onConfirm={confirmDeactivate}
          onCancel={() => setPending(null)}
        />
      ) : null}

      <Panel
        level={2}
        title={t('deployment.users.create.title')}
        description={t('deployment.users.create.description')}
      >
        <div className="form__grid">
          <Field
            id="deployment-user-account"
            label={t('deployment.users.create.username')}
            value={account}
            onChange={setAccount}
            hint={t('deployment.users.create.usernameHint')}
            mono
          />
          <Field
            id="deployment-user-password"
            label={t('deployment.users.create.password')}
            value={password}
            onChange={setPassword}
            hint={t('deployment.users.create.passwordHint')}
            type="password"
            autoComplete="new-password"
          />
        </div>
        <fieldset className="fieldset">
          <legend className="field__label">{t('deployment.users.deploymentRole')}</legend>
          <div className="choices">
            <label className="choice" htmlFor="deployment-user-administrator">
              <input
                id="deployment-user-administrator"
                name="deployment-user-administrator"
                type="checkbox"
                checked={administrator}
                onChange={(event) => setAdministrator(event.target.checked)}
              />
              {t('deployment.users.create.administrator')}
            </label>
          </div>
        </fieldset>
        <div className="form__actions">
          <Button
            busy={busy}
            onClick={() => {
              setNotice(null);
              setPending({ kind: 'create', username: account.trim(), administrator });
            }}
          >
            {t('deployment.users.create.submit')}
          </Button>
        </div>
      </Panel>

      {pending?.kind === 'create' ? (
        <Confirmation
          title={t('deployment.users.create.confirmTitle')}
          target={pending.username}
          scope={t('value.auditScope.deployment')}
          consequence={
            pending.administrator
              ? t('deployment.users.create.consequenceAdministrator')
              : t('deployment.users.create.consequenceMember')
          }
          confirmLabel={t('deployment.users.create.confirm')}
          busy={busy}
          onConfirm={confirmCreate}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {enrollment === null ? null : (
        <Panel
          level={2}
          title={t('workspace.members.enrollment.title')}
          description={t('workspace.members.enrollment.description')}
        >
          <DefinitionList
            rows={[
              ...(enrollment.totp_secret === undefined
                ? []
                : [{ term: t('workspace.members.enrollment.secret'), value: enrollment.totp_secret, mono: true }]),
              ...(enrollment.recovery_codes === undefined
                ? []
                : [{
                    term: t('workspace.members.enrollment.recoveryCodes'),
                    value: enrollment.recovery_codes.join(' '),
                    mono: true,
                  }]),
              ...(enrollment.enrollment_uri === undefined
                ? []
                : [{ term: t('workspace.members.enrollment.uri'), value: enrollment.enrollment_uri, mono: true }]),
            ]}
          />
        </Panel>
      )}
    </Panel>
  );
}
