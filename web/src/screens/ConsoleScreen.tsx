import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { consoleApi, type HealthView, type LicenseView } from '../api.js';
import { daysUntil, formatInstant } from '../format.js';
import { optional, t } from '../i18n/zh-CN.js';
import { Alert, DefinitionList, Panel, StatusPill, type DefinitionRow } from '../ui/Panel.js';
import { Button } from '../ui/Button.js';
import { RecoverySection } from './ConsoleRecoveryScreen.js';

export interface ConsoleScreenProps {
  onSessionLost: () => void;
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) return '—';
  return value ? t('value.yes') : t('value.no');
}

function stateLabel(state: string): ReactNode {
  return optional(`value.state.${state}`) ?? state;
}

function healthRows(health: HealthView): DefinitionRow[] {
  const services = (health.runtime_services ?? []).map((name) => optional(`value.service.${name}`) ?? name);
  return [
    { term: t('health.state'), value: stateLabel(health.state) },
    {
      term: t('health.overall'),
      value: (
        <StatusPill
          tone={health.health === 'healthy' ? 'ok' : 'warn'}
          label={optional(`value.${health.health}`) ?? health.health}
        />
      ),
    },
    { term: t('health.services'), value: services.length === 0 ? t('console.empty') : services.join('、') },
    { term: t('health.serviceOpen'), value: yesNo(health.service_open) },
    { term: t('health.mfa'), value: yesNo(health.mfa_enrolled) },
    { term: t('health.defaultCredentials'), value: yesNo(health.default_credentials) },
    { term: t('health.masterKey'), value: yesNo(health.master_key_external) },
    { term: t('health.evidence'), value: health.evidence_id ?? '—', mono: true },
    { term: t('health.checkedAt'), value: formatInstant(health.checked_at) },
  ];
}

function licenseRows(license: LicenseView): DefinitionRow[] {
  const remaining = daysUntil(license.expires_at);
  return [
    { term: t('license.id'), value: license.license_id, mono: true },
    { term: t('license.release'), value: license.release },
    { term: t('license.highestEligible'), value: license.highest_eligible_release },
    { term: t('license.notBefore'), value: formatInstant(license.not_before) },
    { term: t('license.expiresAt'), value: formatInstant(license.expires_at) },
    {
      term: t('license.remaining'),
      value: remaining === undefined ? '—' : `${remaining} ${t('value.days')}`,
    },
    { term: t('license.state'), value: stateLabel(license.state) },
  ];
}

/** Read-only deployment health and license status, over authenticated APIs. */
export function ConsoleScreen({ onSessionLost }: ConsoleScreenProps) {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [license, setLicense] = useState<LicenseView | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: string } | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setPending(true);
    setFailure(null);
    const [healthResult, licenseResult] = await Promise.all([consoleApi.health(), consoleApi.license()]);
    setPending(false);
    if ((!healthResult.ok && healthResult.status === 401) || (!licenseResult.ok && licenseResult.status === 401)) {
      onSessionLost();
      return;
    }
    if (!healthResult.ok) {
      setFailure({ message: t('console.unavailable'), code: healthResult.error.code });
      return;
    }
    if (!licenseResult.ok) {
      setFailure({ message: t('console.unavailable'), code: licenseResult.error.code });
      return;
    }
    setHealth(healthResult.data);
    setLicense(licenseResult.data);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1 className="page-head__title">{t('console.title')}</h1>
          <p className="page-head__description">{t('console.description')}</p>
        </div>
        <Button variant="secondary" busy={pending} onClick={() => void load()}>
          {pending ? t('console.refreshing') : t('console.refresh')}
        </Button>
      </div>

      {failure ? (
        <Alert tone="error" {...(failure.code ? { code: failure.code } : {})}>
          {failure.message}
        </Alert>
      ) : null}

      {health && license ? (
        <div className="grid">
          <Panel title={t('health.title')}>
            <DefinitionList rows={healthRows(health)} />
          </Panel>
          <Panel title={t('license.title')}>
            <DefinitionList rows={licenseRows(license)} />
          </Panel>
        </div>
      ) : failure ? null : (
        <p className="empty" role="status">
          {t('console.empty')}
        </p>
      )}

      <RecoverySection onSessionLost={onSessionLost} />
    </div>
  );
}