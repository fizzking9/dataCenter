import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  consoleApi,
  type ApiError,
  type FinalizeView,
  type LifecycleView,
  type PreflightView,
  type RollbackView,
  type UpgradeCheckView,
  type UpgradeRecordView,
  type VerifyView,
} from '../api.js';
import { formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel, StatusPill, type DefinitionRow } from '../ui/Panel.js';

export interface LifecycleScreenProps {
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error' | 'warning';
  text: string;
  code?: string;
}

interface StepUpFields {
  password: string;
  totp: string;
}

/** A governed refusal reads as Chinese copy; the ASCII code stays quotable. */
function failureText(error: ApiError, fallback: string): string {
  return optional(`error.api.${error.code}`) ?? fallback;
}

function upgradeStatusLabel(status: string): string {
  return optional(`lifecycle.status.${status}`) ?? status;
}

function jobStateLabel(state: string): string {
  return optional(`lifecycle.job.${state}`) ?? state;
}

function checkLabel(name: string): string {
  return optional(`lifecycle.check.${name}`) ?? name;
}

function evidenceOperation(operation: string): string {
  return optional(`lifecycle.evidence.operation.${operation}`) ?? operation;
}

function evidenceOutcome(outcome: string): string {
  return optional(`lifecycle.evidence.outcome.${outcome}`) ?? outcome;
}

function yesNo(value: boolean): string {
  return value ? t('value.yes') : t('value.no');
}

function stateLabel(state: string): ReactNode {
  return optional(`value.state.${state}`) ?? state;
}

function windowLabel(lifecycle: LifecycleView): string {
  const window = lifecycle.rollback_window;
  if (window === null) return t('lifecycle.window.none');
  if (window.open) {
    return message('lifecycle.window.open', { from: window.from_release, to: window.to_release });
  }
  if (window.closed_by === 'finalize') return t('lifecycle.window.closedByFinalize');
  if (window.closed_by === 'rollback') return t('lifecycle.window.closedByRollback');
  return t('lifecycle.window.none');
}

function upgradeRows(upgrade: UpgradeRecordView): DefinitionRow[] {
  const rows: DefinitionRow[] = [
    { term: t('lifecycle.record.upgradeId'), value: upgrade.upgrade_id, mono: true },
    { term: t('lifecycle.record.attempt'), value: String(upgrade.attempt) },
    { term: t('lifecycle.record.status'), value: upgradeStatusLabel(upgrade.status) },
    { term: t('lifecycle.record.from'), value: upgrade.from_release },
    { term: t('lifecycle.record.to'), value: upgrade.to_release },
    {
      term: t('lifecycle.record.checkpoint'),
      value: upgrade.checkpoint_id ?? t('lifecycle.unknown'),
      mono: true,
    },
    {
      term: t('lifecycle.record.migrations'),
      value: upgrade.migrations.length === 0 ? t('lifecycle.unknown') : upgrade.migrations.join('、'),
    },
    { term: t('lifecycle.record.storeSchema'), value: String(upgrade.store_schema_version) },
    {
      term: t('lifecycle.record.verification'),
      value: upgrade.verification === null
        ? t('lifecycle.unknown')
        : message('lifecycle.record.verificationPassed', {
          checks: String(upgrade.verification.checks.length),
        }),
    },
  ];
  if (upgrade.finalization !== null) {
    rows.push({
      term: t('lifecycle.record.finalization'),
      value: message('lifecycle.record.finalized', {
        at: formatInstant(upgrade.finalization.finalized_at),
        removed: yesNo(upgrade.finalization.previous_release_removed),
      }),
    });
  }
  if (upgrade.rollback !== null) {
    rows.push({
      term: t('lifecycle.record.rollback'),
      value: message('lifecycle.record.rolledBack', {
        at: formatInstant(upgrade.rollback.rolled_back_at),
        release: upgrade.rollback.to_release,
        down: String(upgrade.rollback.down_migrations),
        unchanged: yesNo(upgrade.rollback.data_unchanged),
        records: String(upgrade.rollback.records_after_upgrade),
      }),
    });
  }
  if (upgrade.last_error !== null) {
    rows.push({
      term: t('lifecycle.record.lastError'),
      value: (
        <>
          {optional(`error.api.${upgrade.last_error.code}`) ?? t('lifecycle.unavailable')}{' '}
          <code>{upgrade.last_error.code}</code>
        </>
      ),
    });
  }
  return rows;
}

/** One consequential action only starts after password and dynamic code. */
function StepUpForm({
  idPrefix,
  passwordLabel,
  otpLabel,
  otpHint,
  values,
  disabled,
  submitLabel,
  busyLabel,
  busy,
  onChange,
  onSubmit,
}: {
  idPrefix: string;
  passwordLabel: string;
  otpLabel: string;
  otpHint: string;
  values: StepUpFields;
  disabled: boolean;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  onChange: (values: StepUpFields) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="form">
      <div className="form__grid">
        <Field
          id={`${idPrefix}-password`}
          label={passwordLabel}
          type="password"
          value={values.password}
          onChange={(value) => onChange({ ...values, password: value })}
          autoComplete="current-password"
        />
        <Field
          id={`${idPrefix}-otp`}
          label={otpLabel}
          value={values.totp}
          onChange={(value) => onChange({ ...values, totp: value })}
          hint={otpHint}
          inputMode="numeric"
          maxLength={6}
        />
      </div>
      <div className="form__actions">
        <Button busy={busy || disabled} onClick={onSubmit}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </div>
  );
}

function checkRows(checks: Record<string, UpgradeCheckView>): Array<{ name: string; check: UpgradeCheckView }> {
  return Object.entries(checks).map(([name, check]) => ({ name, check }));
}

/** The maintenance window, its verification, finalization, and Application Rollback. */
export function LifecycleScreen({ onSessionLost }: LifecycleScreenProps) {
  const [lifecycle, setLifecycle] = useState<LifecycleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [bundle, setBundle] = useState('');
  const [releaseKey, setReleaseKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [license, setLicense] = useState('');
  const [preflight, setPreflight] = useState<PreflightView | null>(null);
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  const [verification, setVerification] = useState<VerifyView | null>(null);
  const [finalizeResult, setFinalizeResult] = useState<FinalizeView | null>(null);
  const [rollbackResult, setRollbackResult] = useState<RollbackView | null>(null);
  const [finalizeStepUp, setFinalizeStepUp] = useState<StepUpFields>({ password: '', totp: '' });
  const [rollbackStepUp, setRollbackStepUp] = useState<StepUpFields>({ password: '', totp: '' });

  const load = useCallback(async (): Promise<void> => {
    const result = await consoleApi.lifecycle();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setLifecycle(result.data);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  // A running upgrade is followed through its durable record and ledger; the
  // browser never guesses progress from the request it started.
  useEffect(() => {
    if (lifecycle?.job?.state !== 'running') return;
    const timer = setTimeout(() => {
      void load();
    }, 1200);
    return () => clearTimeout(timer);
  }, [lifecycle, load]);

  // The terminal outcome of the background attempt becomes an explicit state
  // once per transition, so a later refresh never overwrites a newer action.
  const lastJobState = useRef<string | null>(null);
  useEffect(() => {
    const job = lifecycle?.job ?? null;
    if (job === null || job.state === lastJobState.current) return;
    lastJobState.current = job.state;
    if (job.state === 'failed' && job.error !== null) {
      setNotice({
        tone: 'error',
        text: failureText(job.error, t('lifecycle.upgrade.failed')),
        code: job.error.code,
      });
      return;
    }
    if (job.state === 'succeeded') {
      setNotice({ tone: 'info', text: t('lifecycle.upgrade.completed') });
    }
  }, [lifecycle]);

  const refuse = useCallback((status: number, error: ApiError, fallback: string): void => {
    if (status === 401 && error.code === 'OPERATOR_SESSION_INVALID') {
      onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: failureText(error, fallback), code: error.code });
    void load();
  }, [load, onSessionLost]);

  /** A changed field invalidates the preflight answer it no longer describes. */
  const updateField = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPreflight(null);
    setConfirmingUpgrade(false);
  };

  const runPreflight = (): void => {
    setBusy('preflight');
    setNotice(null);
    setPreflight(null);
    void consoleApi
      .preflight({
        bundle: bundle.trim(),
        release_key: releaseKey.trim(),
        confirm_release_key_fingerprint: fingerprint.trim(),
        ...(license.trim() === '' ? {} : { license: license.trim() }),
      })
      .then((result) => {
        setBusy(null);
        if (!result.ok) {
          refuse(result.status, result.error, t('lifecycle.preflight.failed'));
          return;
        }
        setPreflight(result.data);
      });
  };

  const confirmUpgrade = (): void => {
    if (preflight === null) return;
    setBusy('upgrade');
    setNotice(null);
    void consoleApi
      .upgrade({
        bundle: bundle.trim(),
        release_key: releaseKey.trim(),
        confirm_release_key_fingerprint: fingerprint.trim(),
        ...(license.trim() === '' ? {} : { license: license.trim() }),
      })
      .then((result) => {
        setBusy(null);
        setConfirmingUpgrade(false);
        if (!result.ok) {
          refuse(result.status, result.error, t('lifecycle.upgrade.failed'));
          return;
        }
        setNotice({ tone: 'info', text: t('lifecycle.upgrade.started') });
        void load();
      });
  };

  const runVerify = (): void => {
    setBusy('verify');
    setNotice(null);
    setVerification(null);
    void consoleApi.verify().then((result) => {
      setBusy(null);
      if (!result.ok) {
        setNotice({
          tone: 'error',
          text: `${t('lifecycle.verify.failed')} ${failureText(result.error, '')}`.trim(),
          code: result.error.code,
        });
        void load();
        return;
      }
      setVerification(result.data);
      setNotice({
        tone: 'info',
        text: message('lifecycle.verify.passed', { evidence: result.data.evidence_id }),
      });
      void load();
    });
  };

  const runFinalize = (): void => {
    setBusy('finalize');
    setNotice(null);
    setFinalizeResult(null);
    void consoleApi
      .finalize({
        password: finalizeStepUp.password,
        ...(finalizeStepUp.totp === '' ? {} : { totp: finalizeStepUp.totp }),
      })
      .then((result) => {
        setBusy(null);
        if (!result.ok) {
          refuse(result.status, result.error, t('lifecycle.finalize.notReady'));
          return;
        }
        setFinalizeResult(result.data);
        setFinalizeStepUp({ password: '', totp: '' });
        setNotice({ tone: 'info', text: t('lifecycle.finalize.done') });
        void load();
      });
  };

  const runRollback = (): void => {
    setBusy('rollback');
    setNotice(null);
    setRollbackResult(null);
    void consoleApi
      .rollback({
        password: rollbackStepUp.password,
        ...(rollbackStepUp.totp === '' ? {} : { totp: rollbackStepUp.totp }),
      })
      .then((result) => {
        setBusy(null);
        if (!result.ok) {
          refuse(result.status, result.error, t('lifecycle.rollback.notEligible'));
          return;
        }
        setRollbackResult(result.data);
        setRollbackStepUp({ password: '', totp: '' });
        setNotice({
          tone: 'info',
          text: message('lifecycle.rollback.done', {
            from: result.data.from_release,
            to: result.data.to_release,
          }),
        });
        void load();
      });
  };

  const upgrade = lifecycle?.upgrade ?? null;
  const job = lifecycle?.job ?? null;
  const running = job?.state === 'running';
  const windowOpen = lifecycle?.rollback_window?.open === true;
  const verified = upgrade?.verification?.passed === true;
  const canVerify = upgrade !== null && (upgrade.status === 'upgraded' || upgrade.status === 'verified') && !running;
  const canFinalize = windowOpen && verified && !running;
  const canRollback = windowOpen && lifecycle?.rollback_window?.eligible === true && !running;
  const busyNow = busy !== null;

  const refresh = (): void => {
    setBusy('refresh');
    void load().then(() => setBusy(null));
  };

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <h1 className="page-head__title">{t('lifecycle.title')}</h1>
          <p className="page-head__description">{t('lifecycle.description')}</p>
        </div>
        <Button variant="secondary" busy={busy === 'refresh'} onClick={refresh}>
          {busy === 'refresh' ? t('lifecycle.refreshing') : t('lifecycle.refresh')}
        </Button>
      </div>

      {failed ? <Alert tone="error">{t('lifecycle.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}

      {lifecycle === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('lifecycle.loading')}
          </p>
        )
      ) : (
        <div className="grid">
          <Panel title={t('lifecycle.deployment.title')}>
            <DefinitionList
              rows={[
                { term: t('lifecycle.deployment.release'), value: lifecycle.deployment.release },
                { term: t('lifecycle.deployment.state'), value: stateLabel(lifecycle.deployment.state) },
                { term: t('lifecycle.deployment.serviceOpen'), value: yesNo(lifecycle.deployment.service_open) },
                { term: t('lifecycle.deployment.rollbackWindow'), value: windowLabel(lifecycle) },
              ]}
            />
          </Panel>

          <Panel title={t('lifecycle.record.title')} description={t('lifecycle.record.empty')}>
            {upgrade === null ? (
              <p className="empty">{t('lifecycle.record.empty')}</p>
            ) : (
              <DefinitionList rows={upgradeRows(upgrade)} />
            )}
            {job === null ? null : (
              <DefinitionList
                rows={[
                  { term: t('lifecycle.record.job'), value: jobStateLabel(job.state) },
                  { term: t('lifecycle.record.jobStarted'), value: formatInstant(job.started_at) },
                  { term: t('lifecycle.record.jobFinished'), value: formatInstant(job.finished_at ?? undefined) },
                  ...(job.error === null
                    ? []
                    : [{
                      term: t('lifecycle.record.jobError'),
                      value: (
                        <>
                          {optional(`error.api.${job.error.code}`) ?? t('lifecycle.unavailable')}{' '}
                          <code>{job.error.code}</code>
                        </>
                      ),
                    }]),
                ]}
              />
            )}
            {job?.state === 'running' ? <p className="empty">{t('lifecycle.record.jobRunning')}</p> : null}
            {running ? <p className="empty">{t('lifecycle.upgrade.inProgress')}</p> : null}
          </Panel>

          <Panel title={t('lifecycle.ledger.title')}>
            {lifecycle.ledger.migrations.length === 0 ? (
              <p className="empty">{t('lifecycle.ledger.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('lifecycle.ledger.migration')}</th>
                    <th scope="col">{t('lifecycle.ledger.path')}</th>
                    <th scope="col">{t('lifecycle.ledger.expandOnly')}</th>
                    <th scope="col">{t('lifecycle.ledger.steps')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lifecycle.ledger.migrations.map((migration) => (
                    <tr key={migration.id}>
                      <td className="data-table__mono">{migration.id}</td>
                      <td>{migration.from_release} → {migration.to_release}</td>
                      <td>{migration.expand_only ? t('value.yes') : t('value.no')}</td>
                      <td>
                        {migration.steps.map((step) => (
                          <div key={step.name}>
                            <code>{step.name}</code> · {formatInstant(step.applied_at)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title={t('lifecycle.preflight.title')} description={t('lifecycle.preflight.description')}>
            <div className="form">
              <div className="form__grid">
                <Field
                  id="lifecycle-bundle"
                  label={t('lifecycle.preflight.bundle')}
                  value={bundle}
                  onChange={updateField(setBundle)}
                  hint={t('lifecycle.preflight.bundleHint')}
                  mono
                />
                <Field
                  id="lifecycle-release-key"
                  label={t('lifecycle.preflight.releaseKey')}
                  value={releaseKey}
                  onChange={updateField(setReleaseKey)}
                  hint={t('lifecycle.preflight.releaseKeyHint')}
                  mono
                />
                <Field
                  id="lifecycle-fingerprint"
                  label={t('lifecycle.preflight.fingerprint')}
                  value={fingerprint}
                  onChange={updateField(setFingerprint)}
                  hint={t('lifecycle.preflight.fingerprintHint')}
                  mono
                />
                <Field
                  id="lifecycle-license"
                  label={t('lifecycle.preflight.license')}
                  value={license}
                  onChange={updateField(setLicense)}
                  hint={t('lifecycle.preflight.licenseHint')}
                  mono
                />
              </div>
              <div className="form__actions">
                <Button busy={busy === 'preflight'} onClick={runPreflight}>
                  {busy === 'preflight' ? t('lifecycle.preflight.running') : t('lifecycle.preflight.submit')}
                </Button>
              </div>
            </div>
          </Panel>

          {preflight === null ? null : (
            <Panel title={t('lifecycle.preflight.result.title')}>
              <DefinitionList
                rows={[
                  { term: t('lifecycle.preflight.result.source'), value: preflight.from_release },
                  { term: t('lifecycle.preflight.result.target'), value: preflight.to_release },
                  { term: t('lifecycle.preflight.result.path'), value: t('lifecycle.preflight.result.pathValue') },
                  { term: t('lifecycle.preflight.result.migration'), value: preflight.upgrade_path.migration_id, mono: true },
                  {
                    term: t('lifecycle.preflight.result.bundle'),
                    value: message('lifecycle.preflight.result.bundleValue', {
                      files: String(preflight.bundle.files),
                      images: String(preflight.bundle.images),
                      fingerprint: preflight.bundle.release_key_fingerprint,
                    }),
                  },
                  {
                    term: t('lifecycle.preflight.result.previousImages'),
                    value: message('lifecycle.preflight.result.previousImagesValue', {
                      release: preflight.previous_images.release,
                      images: String(preflight.previous_images.images),
                    }),
                  },
                  {
                    term: t('lifecycle.preflight.result.license'),
                    value: message('lifecycle.preflight.result.licenseValue', {
                      release: preflight.license.highest_eligible_release,
                    }),
                  },
                  { term: t('lifecycle.preflight.result.masterKey'), value: t('lifecycle.preflight.result.masterKeyValue') },
                  { term: t('lifecycle.preflight.result.stores'), value: t('lifecycle.preflight.result.storesValue') },
                  {
                    term: t('lifecycle.preflight.result.queues'),
                    value: message('lifecycle.preflight.result.queuesValue', {
                      queued: String(preflight.queues.queued),
                      running: String(preflight.queues.running),
                      purges: String(preflight.queues.pending_purges),
                    }),
                  },
                  {
                    term: t('lifecycle.preflight.result.backups'),
                    value: message('lifecycle.preflight.result.backupsValue', {
                      health: optional(`value.${preflight.backups.health}`) ?? t('lifecycle.unknown'),
                      checkpoint: preflight.backups.last_checkpoint_id ?? t('lifecycle.unknown'),
                    }),
                  },
                  {
                    term: t('lifecycle.preflight.result.capacity'),
                    value: message('lifecycle.preflight.result.capacityValue', {
                      free: String(preflight.capacity.free_bytes ?? 0),
                      required: String(preflight.capacity.required_bytes),
                    }),
                  },
                  {
                    term: t('lifecycle.preflight.result.checkpoint'),
                    value: preflight.checkpoint_required
                      ? t('lifecycle.preflight.result.checkpointRequired')
                      : t('lifecycle.preflight.result.checkpointReused'),
                  },
                  { term: t('lifecycle.preflight.result.evidence'), value: preflight.evidence_id, mono: true },
                ]}
              />
              <p className="panel__description">
                {message('lifecycle.preflight.result.consequence', {
                  from: preflight.from_release,
                  to: preflight.to_release,
                })}
              </p>
              {confirmingUpgrade ? (
                <Confirmation
                  title={t('lifecycle.preflight.confirm.title')}
                  target={`${preflight.from_release} → ${preflight.to_release}`}
                  scope={t('lifecycle.deployment.title')}
                  consequence={t('lifecycle.preflight.confirm.consequence')}
                  confirmLabel={t('lifecycle.preflight.result.run')}
                  busy={busy === 'upgrade'}
                  onConfirm={confirmUpgrade}
                  onCancel={() => setConfirmingUpgrade(false)}
                />
              ) : (
                <div className="form__actions">
                  <Button busy={busyNow || running || windowOpen} onClick={() => setConfirmingUpgrade(true)}>
                    {t('lifecycle.preflight.result.run')}
                  </Button>
                </div>
              )}
            </Panel>
          )}

          <Panel title={t('lifecycle.verify.title')} description={t('lifecycle.verify.description')}>
            <div className="form__actions">
              <Button busy={busy === 'verify' || !canVerify} onClick={runVerify}>
                {busy === 'verify' ? t('lifecycle.verify.running') : t('lifecycle.verify.run')}
              </Button>
            </div>
            {verification === null ? null : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('lifecycle.verify.check')}</th>
                    <th scope="col">{t('lifecycle.verify.result')}</th>
                    <th scope="col">{t('lifecycle.verify.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {checkRows(verification.checks).map(({ name, check }) => (
                    <tr key={name}>
                      <td>{checkLabel(name)}</td>
                      <td>
                        <StatusPill
                          tone={check.passed ? 'ok' : 'warn'}
                          label={check.passed ? t('lifecycle.verify.pass') : t('lifecycle.verify.fail')}
                        />
                      </td>
                      <td>
                        {check.error_code === undefined
                          ? t('lifecycle.unknown')
                          : (
                            <>
                              {optional(`error.api.${check.error_code}`) ?? t('lifecycle.unavailable')}{' '}
                              <code>{check.error_code}</code>
                            </>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title={t('lifecycle.finalize.title')} description={t('lifecycle.finalize.description')}>
            {finalizeResult === null ? null : (
              <p className="empty">
                {message('lifecycle.record.finalized', {
                  at: formatInstant(finalizeResult.finalization.finalized_at),
                  removed: yesNo(finalizeResult.cleanup.removed),
                })}
              </p>
            )}
            {!canFinalize ? (
              <p className="empty">{t('lifecycle.finalize.notReady')}</p>
            ) : (
              <>
                <DefinitionList
                  rows={[
                    {
                      term: t('lifecycle.finalize.target'),
                      value: `${upgrade?.from_release ?? ''} → ${upgrade?.to_release ?? ''}`,
                    },
                    { term: t('confirm.consequence'), value: t('lifecycle.finalize.consequence') },
                  ]}
                />
                <StepUpForm
                  idPrefix="finalize"
                  passwordLabel={t('lifecycle.finalize.password')}
                  otpLabel={t('lifecycle.finalize.otp')}
                  otpHint={t('lifecycle.finalize.otpHint')}
                  values={finalizeStepUp}
                  disabled={busyNow}
                  submitLabel={t('lifecycle.finalize.submit')}
                  busyLabel={t('lifecycle.finalize.submitting')}
                  busy={busy === 'finalize'}
                  onChange={setFinalizeStepUp}
                  onSubmit={runFinalize}
                />
              </>
            )}
          </Panel>

          <Panel title={t('lifecycle.rollback.title')} description={t('lifecycle.rollback.description')}>
            {rollbackResult === null ? null : (
              <DefinitionList
                rows={[
                  { term: t('lifecycle.rollback.result.from'), value: rollbackResult.from_release },
                  { term: t('lifecycle.rollback.result.to'), value: rollbackResult.to_release },
                  { term: t('lifecycle.rollback.result.service'), value: yesNo(rollbackResult.service_open) },
                  { term: t('lifecycle.rollback.result.downMigrations'), value: String(rollbackResult.down_migrations) },
                  { term: t('lifecycle.rollback.result.dataUnchanged'), value: yesNo(rollbackResult.data_unchanged) },
                  { term: t('lifecycle.rollback.result.records'), value: String(rollbackResult.records_after_upgrade) },
                  { term: t('lifecycle.rollback.result.offline'), value: yesNo(rollbackResult.offline) },
                  { term: t('lifecycle.rollback.result.evidence'), value: rollbackResult.evidence_id, mono: true },
                ]}
              />
            )}
            {!canRollback ? (
              rollbackResult === null ? <p className="empty">{t('lifecycle.rollback.notEligible')}</p> : null
            ) : (
              <>
                <DefinitionList
                  rows={[
                    {
                      term: t('lifecycle.rollback.target'),
                      value: message('lifecycle.rollback.targetValue', {
                        from: lifecycle?.rollback_window?.to_release ?? '',
                        to: lifecycle?.rollback_window?.from_release ?? '',
                      }),
                    },
                    { term: t('confirm.consequence'), value: t('lifecycle.rollback.consequence') },
                  ]}
                />
                <StepUpForm
                  idPrefix="rollback"
                  passwordLabel={t('lifecycle.rollback.password')}
                  otpLabel={t('lifecycle.rollback.otp')}
                  otpHint={t('lifecycle.rollback.otpHint')}
                  values={rollbackStepUp}
                  disabled={busyNow}
                  submitLabel={t('lifecycle.rollback.submit')}
                  busyLabel={t('lifecycle.rollback.submitting')}
                  busy={busy === 'rollback'}
                  onChange={setRollbackStepUp}
                  onSubmit={runRollback}
                />
              </>
            )}
          </Panel>

          <Panel title={t('lifecycle.evidence.title')}>
            {lifecycle.evidence.length === 0 ? (
              <p className="empty">{t('lifecycle.evidence.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('lifecycle.evidence.operation')}</th>
                    <th scope="col">{t('lifecycle.evidence.outcome')}</th>
                    <th scope="col">{t('lifecycle.evidence.time')}</th>
                    <th scope="col">{t('lifecycle.evidence.id')}</th>
                  </tr>
                </thead>
                <tbody>
                  {lifecycle.evidence.map((entry) => (
                    <tr key={entry.evidence_id}>
                      <td>{evidenceOperation(entry.operation)}</td>
                      <td>
                        {evidenceOutcome(entry.outcome)}
                        {entry.error_code === undefined ? null : (
                          <>
                            {' '}
                            <code>{entry.error_code}</code>
                          </>
                        )}
                      </td>
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
