import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ContextHistoryView,
  type ContextView,
  type WorkspaceRoleValue,
} from '../api.js';
import { apiFailureText, formatInstant, roleLabel } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
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

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
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

/**
 * The Business Context of the active Workspace: the exact version in force, its
 * immutable version history with the Artifacts each version pins, and the one
 * workflow that publishes an additive Workspace extension.
 */
export function WorkspaceContext({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [context, setContext] = useState<ContextView | null>(null);
  const [history, setHistory] = useState<ContextHistoryView | null>(null);
  const [failed, setFailed] = useState(false);
  const [entries, setEntries] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Both reads travel together, so a published version and its history entry
  // are never shown one without the other.
  const load = useCallback(async (): Promise<void> => {
    const [nextContext, nextHistory] = await Promise.all([
      platformApi.context(workspaceId),
      platformApi.contextHistory(workspaceId),
    ]);
    if (nextContext === undefined || nextHistory === undefined) return;
    if (!nextContext.ok) {
      if (nextContext.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    if (!nextHistory.ok) {
      if (nextHistory.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setContext(nextContext.data);
    setHistory(nextHistory.data);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const publish = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entries);
    } catch {
      setNotice({ tone: 'error', text: t('workspace.context.publish.invalidJson') });
      return;
    }
    if (!Array.isArray(parsed)) {
      setNotice({ tone: 'error', text: t('workspace.context.publish.invalidJson') });
      return;
    }
    setBusy(true);
    setNotice(null);
    void platformApi.publishWorkspaceContext(workspaceId, parsed).then(async (result) => {
      if (!result.ok) {
        setBusy(false);
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      // The success sentence appears only once the new version is on screen.
      await load();
      setBusy(false);
      setEntries('');
      setNotice({ tone: 'info', text: t('workspace.context.publish.published') });
    });
  };

  return (
    <Panel level={1} title={t('workspace.context.title')} description={t('workspace.context.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
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

      <Panel level={2} title={t('workspace.context.history')}>
        {history === null ? (
          failed ? null : (
            <p className="empty" role="status">
              {t('platform.loading')}
            </p>
          )
        ) : history.versions.length === 0 ? (
          <p className="empty">{t('workspace.context.history.empty')}</p>
        ) : (
          <ol className="context-history">
            {history.versions.map((version) => (
              <li className="context-history__item" key={version.version}>
                <h3 className="context-history__version">
                  {message('workspace.context.versionHeading', { version: String(version.version) })}
                </h3>
                <DefinitionList
                  rows={[
                    { term: t('workspace.context.publishedAt'), value: formatInstant(version.published_at) },
                    { term: t('workspace.context.publishedBy'), value: version.published_by ?? '—' },
                    { term: t('workspace.context.entryCount'), value: String(version.entry_count) },
                    {
                      term: t('workspace.context.commonVersion'),
                      value: String(version.common_business_context_version),
                    },
                    {
                      term: t('workspace.context.previousVersion'),
                      value: version.previous_workspace_business_context_version === null
                        ? '—'
                        : String(version.previous_workspace_business_context_version),
                    },
                    {
                      term: t('workspace.context.affectedArtifacts'),
                      value: version.affected_artifacts.length === 0
                        ? t('workspace.context.affectedArtifacts.empty')
                        : (
                          <ul className="context-history__artifacts">
                            {version.affected_artifacts.map((artifact) => (
                              <li key={`${artifact.kind}-${artifact.source_id}-${String(artifact.version)}`}>
                                {artifact.source_name}
                                {' · '}
                                {optional(`value.artifact.${artifact.kind}`) ?? artifact.kind}
                                {' '}
                                {String(artifact.version)}
                              </li>
                            ))}
                          </ul>
                        ),
                    },
                  ]}
                />
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        level={2}
        title={t('workspace.context.publish.title')}
        description={t('workspace.context.publish.description')}
      >
        <div className="field">
          <label className="field__label" htmlFor="context-entries">
            {t('workspace.context.publish.entries')}
          </label>
          <textarea
            className="field__input field__input--mono"
            id="context-entries"
            name="context-entries"
            rows={6}
            value={entries}
            onChange={(event) => setEntries(event.target.value)}
            spellCheck={false}
          />
        </div>
        <Button busy={busy} onClick={publish}>
          {t('workspace.context.publish.submit')}
        </Button>
      </Panel>
    </Panel>
  );
}
