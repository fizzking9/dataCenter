import { useCallback, useEffect, useState } from 'react';
import {
  consoleApi,
  type ApiError,
  type LicenseAccessView,
  type LicenseHistoryEntryView,
  type LicenseView,
} from '../api.js';
import { formatInstant } from '../format.js';
import { message, optional, t, type MessageKey } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel, StatusPill, type DefinitionRow } from '../ui/Panel.js';

export interface LicenseScreenProps {
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error' | 'warning';
  text: string;
  code?: string;
}

/** A governed refusal reads as Chinese copy; the ASCII code stays quotable. */
function failureText(error: ApiError, fallback: string): string {
  return optional(`error.api.${error.code}`) ?? fallback;
}

/** The one accessibility label each access list carries. */
const ACCESS_LABELS: Record<'permitted' | 'disabled', MessageKey> = {
  permitted: 'license.access.permitted',
  disabled: 'license.access.disabled',
};

/**
 * A durable operation keeps its ASCII identifier at the boundary; only the label
 * the Operator reads is Chinese, and a governed identifier carrying a hyphen
 * cannot be a catalog key.
 */
const EVIDENCE_OPERATION_KEYS: Record<string, MessageKey> = {
  'import-license': 'license.evidence.operation.importLicense',
};

function evidenceOperation(operation: string): string {
  const key = EVIDENCE_OPERATION_KEYS[operation];
  return key === undefined ? operation : t(key);
}

function licenseStatusLabel(license: LicenseView): string {
  return optional(`license.value.${license.status}`) ?? license.status;
}

function licenseRows(license: LicenseView): DefinitionRow[] {
  const remaining = license.days_remaining;
  return [
    {
      term: t('license.status'),
      value: (
        <StatusPill
          tone={license.status === 'valid' ? 'ok' : 'warn'}
          label={licenseStatusLabel(license)}
        />
      ),
    },
    { term: t('license.id'), value: license.license_id ?? '—', mono: true },
    { term: t('license.release'), value: license.release },
    { term: t('license.highestEligible'), value: license.highest_eligible_release ?? '—' },
    { term: t('license.notBefore'), value: formatInstant(license.not_before) },
    { term: t('license.expiresAt'), value: formatInstant(license.expires_at) },
    {
      term: t('license.remaining'),
      value: remaining === null ? '—' : `${remaining} ${t('value.days')}`,
    },
    { term: t('license.state'), value: optional(`value.state.${license.state}`) ?? license.state },
    { term: t('license.deployment'), value: license.deployment_id, mono: true },
  ];
}

function historyRows(entries: LicenseHistoryEntryView[]): Array<Array<string>> {
  return entries.map((entry) => [
    entry.license_id,
    entry.previous_license_id ?? t('license.history.first'),
    entry.highest_eligible_release,
    formatInstant(entry.imported_at),
    formatInstant(entry.expires_at),
  ]);
}

/** The two lists an unusable entitlement states: what stays open, what closed. */
function AccessLists({ access }: { access: LicenseAccessView }) {
  const list = (kind: 'permitted' | 'disabled') => (
    <div className="access-list">
      <h3 className="access-list__title">
        {kind === 'permitted' ? t('license.access.permitted') : t('license.access.disabled')}
      </h3>
      <ul aria-label={t(ACCESS_LABELS[kind])} className={`access-list__items access-list__items--${kind}`}>
        {access[kind].map((operation) => (
          <li key={operation}>{optional(`license.access.${operation}`) ?? operation}</li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="access-lists">
      {list('permitted')}
      {list('disabled')}
    </div>
  );
}

/**
 * The licensing workflow: the current entitlement, offline renewal from the
 * Operator's own media, the import history, its durable evidence, and the
 * operations an expired or unusable license leaves open or closes. Every
 * decision is the server's; this screen only states it in Chinese.
 */
export function LicenseScreen({ onSessionLost }: LicenseScreenProps) {
  const [license, setLicense] = useState<LicenseView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [licensePath, setLicensePath] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const result = await consoleApi.license();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setLicense(result.data);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A refused import is stated as such, so nobody believes the license changed. */
  const refuse = useCallback((status: number, error: ApiError, fallback: string): void => {
    if (status === 401 && error.code === 'OPERATOR_SESSION_INVALID') {
      onSessionLost();
      return;
    }
    setNotice({
      tone: 'error',
      text: `${t('license.import.refused')}${failureText(error, fallback)}`,
      code: error.code,
    });
    void load();
  }, [load, onSessionLost]);

  const refresh = (): void => {
    setBusy('refresh');
    void load().then(() => setBusy(null));
  };

  const startImport = (): void => {
    setNotice(null);
    if (licensePath.trim() === '') {
      setPathError(t('license.import.pathRequired'));
      return;
    }
    setPathError(null);
    setConfirming(true);
  };

  const runImport = (): void => {
    setBusy('import');
    setNotice(null);
    void consoleApi.importLicense(licensePath.trim()).then((result) => {
      setBusy(null);
      setConfirming(false);
      if (!result.ok) {
        refuse(result.status, result.error, t('license.import.failed'));
        return;
      }
      setLicensePath('');
      setLicense(result.data);
      setNotice({ tone: 'info', text: t('license.import.done') });
    });
  };

  const stateNotice = (): Notice | null => {
    if (license === null) return null;
    if (license.status === 'expired') {
      return { tone: 'warning', text: `${t('license.expired.title')}：${t('license.expired.description')}` };
    }
    if (license.status === 'invalid') {
      const detail = license.error_code === undefined
        ? t('license.unavailable')
        : optional(`error.api.${license.error_code}`) ?? t('license.unavailable');
      return {
        tone: 'error',
        text: `${t('license.invalid.title')}：${detail}`,
        ...(license.error_code === undefined ? {} : { code: license.error_code }),
      };
    }
    return null;
  };

  const warning = license?.warning ?? null;
  const access = license?.access ?? null;
  const expired = license !== null && license.status !== 'valid';
  const state = stateNotice();

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1 className="page-head__title">{t('license.page.title')}</h1>
          <p className="page-head__description">{t('license.page.description')}</p>
        </div>
        <Button variant="secondary" busy={busy === 'refresh'} onClick={refresh}>
          {busy === 'refresh' ? t('license.refreshing') : t('license.refresh')}
        </Button>
      </div>

      {failed ? <Alert tone="error">{t('license.unavailable')}</Alert> : null}
      {state === null ? null : (
        <Alert tone={state.tone} {...(state.code === undefined ? {} : { code: state.code })}>
          {state.text}
        </Alert>
      )}
      {warning === null ? null : (
        <Alert tone="warning">{message('license.warning.message', { days: String(warning.days_remaining) })}</Alert>
      )}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}

      {license === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('license.loading')}
          </p>
        )
      ) : (
        <div className="grid">
          <Panel title={t('license.title')}>
            <DefinitionList rows={licenseRows(license)} />
          </Panel>

          <Panel title={t('license.access.title')} description={t('license.access.description')}>
            {access === null || !expired ? (
              <p className="empty">{t('license.access.full')}</p>
            ) : (
              <AccessLists access={access} />
            )}
          </Panel>

          <Panel title={t('license.import.title')} description={t('license.import.description')}>
            {confirming ? (
              <Confirmation
                title={t('license.import.confirmTitle')}
                target={licensePath.trim()}
                scope={license.deployment_id}
                consequence={t('license.import.consequence')}
                confirmLabel={t('license.import.submit')}
                busy={busy === 'import'}
                onConfirm={runImport}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <div className="form">
                <div className="form__grid">
                  <Field
                    id="license-import-path"
                    label={t('license.import.path')}
                    value={licensePath}
                    onChange={setLicensePath}
                    hint={t('license.import.pathHint')}
                    {...(pathError === null ? {} : { error: pathError })}
                    mono
                  />
                </div>
                <div className="form__actions">
                  <Button busy={busy === 'import'} onClick={startImport}>
                    {busy === 'import' ? t('license.import.submitting') : t('license.import.submit')}
                  </Button>
                </div>
              </div>
            )}
          </Panel>

          <Panel title={t('license.history.title')} description={t('license.history.description')}>
            {license.history.length === 0 ? (
              <p className="empty">{t('license.history.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('license.id')}</th>
                    <th scope="col">{t('license.history.previous')}</th>
                    <th scope="col">{t('license.highestEligible')}</th>
                    <th scope="col">{t('license.history.importedAt')}</th>
                    <th scope="col">{t('license.expiresAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows(license.history).map((row) => (
                    <tr key={row[0]}>
                      <td className="data-table__mono">{row[0]}</td>
                      <td className="data-table__mono">{row[1]}</td>
                      <td>{row[2]}</td>
                      <td>{row[3]}</td>
                      <td>{row[4]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title={t('license.evidence.title')} description={t('license.evidence.description')}>
            {license.evidence.length === 0 ? (
              <p className="empty">{t('license.evidence.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('license.evidence.operation')}</th>
                    <th scope="col">{t('license.evidence.outcome')}</th>
                    <th scope="col">{t('license.evidence.time')}</th>
                    <th scope="col">{t('license.evidence.id')}</th>
                  </tr>
                </thead>
                <tbody>
                  {license.evidence.map((entry) => (
                    <tr key={entry.evidence_id}>
                      <td>{evidenceOperation(entry.operation)}</td>
                      <td>{optional(`license.evidence.outcome.${entry.outcome}`) ?? entry.outcome}</td>
                      <td>{formatInstant(entry.occurred_at)}</td>
                      <td className="data-table__mono">{entry.evidence_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
