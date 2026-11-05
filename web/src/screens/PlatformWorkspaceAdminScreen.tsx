import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type WorkspaceAuditView,
  type WorkspaceMemberGrant,
  type WorkspaceMemberList,
  type WorkspaceRoleValue,
} from '../api.js';
import { apiFailureText, formatInstant, roleLabel } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

/** The two governed Workspace Roles, in the order the grant form offers them. */
const ROLES: WorkspaceRoleValue[] = ['Consumer', 'Workspace Administrator'];

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

/**
 * The membership roster of the one active Workspace. Every row comes from the
 * server's scoped listing, and every change binds the member's next request:
 * a revoked Consumer fails on their very next call, not at the next sign-in.
 */
export function WorkspaceMembers({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [list, setList] = useState<WorkspaceMemberList | null>(null);
  const [failed, setFailed] = useState(false);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState<WorkspaceRoleValue>('Consumer');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [enrollment, setEnrollment] = useState<WorkspaceMemberGrant | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await platformApi.workspaceMembers(workspaceId);
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
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const failedWrite = (result: { status: number; error: { code: string } }): void => {
    setBusy(false);
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
  };

  const grant = (): void => {
    setBusy(true);
    setNotice(null);
    void platformApi.grantWorkspaceMember(workspaceId, account.trim(), role).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      // The roster is re-read first, so the sentence never runs ahead of the row.
      await load();
      setBusy(false);
      setEnrollment(result.data.totp_secret === undefined ? null : result.data);
      setNotice({
        tone: 'info',
        text: message('workspace.members.granted', { username: result.data.username }),
      });
      setAccount('');
    });
  };

  const revoke = (username: string): void => {
    setBusy(true);
    setNotice(null);
    setEnrollment(null);
    void platformApi.revokeWorkspaceMember(workspaceId, username).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setNotice({
        tone: 'info',
        text: message('workspace.members.removed', { username: result.data.username }),
      });
    });
  };

  return (
    <Panel level={1} title={t('workspace.members.title')} description={t('workspace.members.description')}>
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
      ) : list.members.length === 0 ? (
        <p className="empty">{t('workspace.members.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('workspace.members.account')}</th>
              <th scope="col">{t('workspace.members.role')}</th>
              <th scope="col">{t('workspace.members.grantedAt')}</th>
              <th scope="col">{t('workspace.members.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {list.members.map((member) => (
              <tr key={member.username}>
                <td>{member.username}</td>
                <td>{roleLabel(member.role)}</td>
                <td>{formatInstant(member.granted_at)}</td>
                <td>
                  <Button variant="quiet" busy={busy} onClick={() => revoke(member.username)}>
                    {message('workspace.members.remove', { username: member.username })}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="field">
        <Field
          id="members-account"
          label={t('workspace.members.account')}
          value={account}
          onChange={setAccount}
          hint={t('workspace.members.roleHint')}
        />
        <label className="field__label" htmlFor="members-role">
          {t('workspace.members.role')}
        </label>
        <select
          className="field__input"
          id="members-role"
          name="members-role"
          value={role}
          onChange={(event) => setRole(event.target.value as WorkspaceRoleValue)}
        >
          {ROLES.map((value) => (
            <option key={value} value={value}>
              {roleLabel(value)}
            </option>
          ))}
        </select>
      </div>
      <Button busy={busy} onClick={grant}>
        {t('workspace.members.grant')}
      </Button>

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

/**
 * This Workspace's Audit Events, newest first, as attribution only: actor,
 * action, scope, target, and outcome. The server withholds detail payloads and
 * every other Workspace's events, so nothing here can leak configuration.
 */
export function WorkspaceAudit({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [view, setView] = useState<WorkspaceAuditView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void platformApi.workspaceAudit(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setView(result.data);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost]);

  return (
    <Panel level={1} title={t('workspace.audit.title')} description={t('workspace.audit.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {view !== null && !view.chain_valid ? <Alert tone="error">{t('workspace.audit.broken')}</Alert> : null}
      {view === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : view.events.length === 0 ? (
        <p className="empty">{t('workspace.audit.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('workspace.audit.occurredAt')}</th>
              <th scope="col">{t('workspace.audit.actor')}</th>
              <th scope="col">{t('workspace.audit.action')}</th>
              <th scope="col">{t('workspace.audit.scope')}</th>
              <th scope="col">{t('workspace.audit.target')}</th>
              <th scope="col">{t('workspace.audit.outcome')}</th>
            </tr>
          </thead>
          <tbody>
            {view.events.map((event) => (
              <tr key={event.event_id}>
                <td>{formatInstant(event.occurred_at)}</td>
                <td>{event.actor}</td>
                <td className="data-table__mono">{event.action}</td>
                <td>{optional(`value.auditScope.${event.scope}`) ?? event.scope}</td>
                <td className="data-table__mono">{event.target ?? '—'}</td>
                <td>{optional(`value.auditOutcome.${event.outcome}`) ?? event.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
