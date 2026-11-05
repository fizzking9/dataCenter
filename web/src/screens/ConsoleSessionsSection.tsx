import { useCallback, useEffect, useState } from 'react';
import { consoleApi, type OperatorSessionListView } from '../api.js';
import { formatInstant } from '../format.js';
import { t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';

export interface SessionsSectionProps {
  onSessionLost: () => void;
}

/**
 * The Operator's own console sessions: the one in front of them, how many are
 * open, and the way to end the ones left open elsewhere. Each ended session is
 * refused on its next request, and none of them is a platform User session.
 */
export function SessionsSection({ onSessionLost }: SessionsSectionProps) {
  const [listed, setListed] = useState<OperatorSessionListView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await consoleApi.sessions();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailure(t('sessions.failed'));
      return;
    }
    setFailure(null);
    setListed(result.data);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const revokeOthers = (): void => {
    setBusy(true);
    setNotice(null);
    void consoleApi.revokeOtherSessions().then((result) => {
      setBusy(false);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailure(t('sessions.failed'));
        return;
      }
      setFailure(null);
      setNotice(t('sessions.revoked'));
      void load();
    });
  };

  const current = listed?.sessions.find((session) => session.current);
  return (
    <Panel title={t('sessions.title')} description={t('sessions.description')}>
      {failure === null ? null : <Alert tone="error">{failure}</Alert>}
      {notice === null ? null : <Alert tone="info">{notice}</Alert>}
      <DefinitionList
        rows={[
          { term: t('sessions.currentExpiresAt'), value: formatInstant(current?.expires_at) },
          {
            term: t('sessions.count'),
            value: listed === null ? '—' : String(listed.sessions.length),
          },
        ]}
      />
      <div className="form__actions">
        <Button variant="secondary" busy={busy || listed === null} onClick={revokeOthers}>
          {busy ? t('sessions.revoking') : t('sessions.revokeOthers')}
        </Button>
      </div>
    </Panel>
  );
}
