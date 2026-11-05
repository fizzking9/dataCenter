import { useCallback, useEffect, useState } from 'react';
import {
  consoleApi,
  type BackupHealthView,
  type RecoveryOverviewView,
  type RecoverySetDetailView,
  type RecoveryVerificationView,
  type RecoveryVerificationViewRow,
  type RestorationView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel, StatusPill, type DefinitionRow } from '../ui/Panel.js';

export interface RecoverySectionProps {
  onSessionLost: () => void;
}

type EnableAction = 'workers' | 'connectivity';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

/** A settled recovery objective rendered in the catalog's own units. */
function durationText(seconds: number): string {
  if (seconds >= 86_400) return message('console.recovery.duration.days', { value: String(Math.round(seconds / 86_400)) });
  if (seconds >= 3_600) return message('console.recovery.duration.hours', { value: String(Math.round(seconds / 3_600)) });
  if (seconds >= 60) return message('console.recovery.duration.minutes', { value: String(Math.round(seconds / 60)) });
  return message('console.recovery.duration.seconds', { value: String(seconds) });
}

function healthLabel(health: string): string {
  return optional(`value.recoveryHealth.${health}`) ?? health;
}

function reasonLabel(reason: string): string {
  return optional(`value.recoveryReason.${reason}`) ?? reason;
}

function roleLabel(role: string): string {
  return optional(`value.recoveryRole.${role}`) ?? role;
}

function restorationStateLabel(state: string): string {
  return optional(`value.recoveryState.${state}`) ?? state;
}

function stepLabel(step: string): string {
  return optional(`value.recoveryStep.${step}`) ?? step;
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value ? t('value.yes') : t('value.no');
}

function enabledLabel(enabled: boolean): string {
  return enabled ? t('console.recovery.enabled') : t('console.recovery.disabled');
}

function passedLabel(passed: boolean): string {
  return passed ? t('console.recovery.passed') : t('console.recovery.notPassed');
}

function categoryRow(term: string, passed: boolean, detail: string): DefinitionRow {
  return { term, value: `${passedLabel(passed)}（${detail}）` };
}

/** One verification, stated category by category, exactly as the engine reported it. */
function verificationRows(verification: RecoveryVerificationView): DefinitionRow[] {
  return [
    categoryRow(t('console.recovery.category.integrity'), verification.integrity.passed, message('console.recovery.detail.components', {
      count: String(verification.integrity.components),
    })),
    categoryRow(t('console.recovery.category.objects'), verification.objects.passed, message('console.recovery.detail.objects', {
      verified: String(verification.objects.verified),
      count: String(verification.objects.count),
    })),
    categoryRow(t('console.recovery.category.keys'), verification.keys.passed, message('console.recovery.detail.keys', {
      sealed: String(verification.keys.sealed_credentials),
      decrypted: String(verification.keys.decrypted),
    })),
    categoryRow(t('console.recovery.category.manifests'), verification.manifests.passed, message('console.recovery.detail.manifests', {
      release: verification.manifests.release,
      signature: yesNo(verification.manifests.signature_verified),
    })),
    categoryRow(t('console.recovery.category.provenance'), verification.provenance.passed, message('console.recovery.detail.provenance', {
      releases: String(verification.provenance.dataset_releases),
      dangling: String(verification.provenance.dangling),
    })),
    categoryRow(t('console.recovery.category.reads'), verification.governed_reads.passed, message('console.recovery.detail.reads', {
      products: String(verification.governed_reads.products),
      confirmed: String(verification.governed_reads.purged_refusals.confirmed),
      failed: String(verification.governed_reads.purged_refusals.failed),
    })),
    categoryRow(t('console.recovery.category.purgeLedger'), verification.purge_ledger.passed, message('console.recovery.detail.purgeLedger', {
      sequence: String(verification.purge_ledger.applied_through_sequence),
      removed: String(verification.purge_ledger.removed),
    })),
  ];
}

function rtoRows(rto: { seconds: number; limit_seconds: number; met: boolean }): DefinitionRow[] {
  return [
    { term: t('console.recovery.rto.elapsed'), value: durationText(rto.seconds) },
    { term: t('console.recovery.rto.limit'), value: durationText(rto.limit_seconds) },
    { term: t('console.recovery.rto.met'), value: yesNo(rto.met) },
  ];
}

function healthRows(overview: RecoveryOverviewView): DefinitionRow[] {
  const backup: BackupHealthView = overview.backup;
  const reasons = [...backup.reasons, ...backup.verification_reasons];
  return [
    {
      term: t('console.recovery.health.backup'),
      value: (
        <StatusPill
          tone={backup.health === 'healthy' && backup.verification_health === 'healthy' ? 'ok' : 'warn'}
          label={healthLabel(backup.health !== 'healthy' ? backup.health : backup.verification_health)}
        />
      ),
    },
    { term: t('console.recovery.health.reasons'), value: reasons.length === 0 ? t('console.recovery.health.noReasons') : reasons.map(reasonLabel).join('、') },
    { term: t('console.recovery.health.lastCheckpoint'), value: backup.last_checkpoint_id ?? '—', mono: true },
    { term: t('console.recovery.health.checkpointAt'), value: formatInstant(backup.last_checkpoint_at ?? undefined) },
    {
      term: t('console.recovery.health.checkpointAge'),
      value: backup.checkpoint_age_seconds === null ? '—' : durationText(backup.checkpoint_age_seconds),
    },
    {
      term: t('console.recovery.health.lastRpo'),
      value: backup.last_rpo_seconds === null ? '—' : durationText(backup.last_rpo_seconds),
    },
    { term: t('console.recovery.health.rpoLimit'), value: durationText(backup.rpo_limit_seconds) },
    { term: t('console.recovery.health.workers'), value: enabledLabel(overview.workers_enabled) },
    { term: t('console.recovery.health.connectivity'), value: enabledLabel(overview.connectivity_enabled) },
    { term: t('console.recovery.health.backupRoot'), value: overview.backup_root, mono: true },
    { term: t('console.recovery.health.restoreRoot'), value: overview.restore_root, mono: true },
    { term: t('console.recovery.health.checkedAt'), value: formatInstant(overview.checked_at) },
  ];
}

function objectiveRows(overview: RecoveryOverviewView): DefinitionRow[] {
  return [
    { term: t('console.recovery.rpoLimit'), value: durationText(overview.objectives.rpo_limit_seconds) },
    { term: t('console.recovery.rtoLimit'), value: durationText(overview.objectives.rto_limit_seconds) },
    { term: t('console.recovery.retention'), value: durationText(overview.objectives.retention_days * 86_400) },
    { term: t('console.recovery.checkpointInterval'), value: durationText(overview.objectives.checkpoint_seconds) },
    { term: t('console.recovery.baseBackup'), value: durationText(overview.objectives.base_backup_hours * 3_600) },
    { term: t('console.recovery.ledgerHead'), value: String(overview.ledger.head_sequence) },
    { term: t('console.recovery.ledgerEntries'), value: String(overview.ledger.entries) },
  ];
}

/**
 * The Operator recovery workflow: inspect coordinated checkpoints and recovery
 * sets, verify a set, start an isolated restoration behind a server-enforced
 * step-up challenge, follow its durable evidence, and explicitly enable the
 * restored workers and external connectivity. Every request calls the governed
 * recovery module the lifecycle CLI calls; nothing here decides authorization.
 */
export function RecoverySection({ onSessionLost }: RecoverySectionProps) {
  const [overview, setOverview] = useState<RecoveryOverviewView | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<RecoverySetDetailView | null>(null);
  const [drill, setDrill] = useState<{ backupId: string; result: RecoveryVerificationViewRow } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [enableTarget, setEnableTarget] = useState<{ id: string; which: EnableAction } | null>(null);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');

  const load = useCallback(async () => {
    const result = await consoleApi.recovery();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setUnavailable(result.error.code);
      return;
    }
    setUnavailable(null);
    setOverview(result.data);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  // A restoration reports its own progress durably, so the page polls while one
  // is running instead of holding a request open or asking the Operator to guess.
  const running = overview?.restorations.some((restoration) => restoration.state === 'running') ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void load();
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const selected: RestorationView | null = overview?.restorations.find(
    (restoration) => restoration.restoration_id === selectedId,
  ) ?? null;

  function beginRestore(backupId: string): void {
    setRestoreTarget(backupId);
    setEnableTarget(null);
    setPassword('');
    setTotp('');
    setNotice(null);
  }

  function beginEnable(restorationId: string, which: EnableAction): void {
    setEnableTarget({ id: restorationId, which });
    setRestoreTarget(null);
    setPassword('');
    setTotp('');
    setNotice(null);
  }

  function cancelChallenge(): void {
    setRestoreTarget(null);
    setEnableTarget(null);
    setPassword('');
    setTotp('');
  }

  async function stepUp(purpose: string, target: string): Promise<string | null> {
    const grant = await consoleApi.stepUp({
      purpose,
      target,
      password,
      ...(totp.trim() === '' ? {} : { totp: totp.trim() }),
    });
    if (!grant.ok) {
      if (grant.status === 401) onSessionLost();
      setNotice({ tone: 'error', text: t('console.recovery.stepUpFailed'), code: grant.error.code });
      return null;
    }
    return grant.data.step_up_grant;
  }

  async function confirmRestore(): Promise<void> {
    if (restoreTarget === null) return;
    setBusy(true);
    setNotice(null);
    const grant = await stepUp('deployment_restoration', restoreTarget);
    if (grant === null) {
      setBusy(false);
      return;
    }
    const started = await consoleApi.startRestoration(restoreTarget, grant);
    setBusy(false);
    setPassword('');
    setTotp('');
    if (!started.ok) {
      if (started.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(started.error.code), code: started.error.code });
      return;
    }
    setRestoreTarget(null);
    setSelectedId(started.data.restoration_id);
    setNotice({ tone: 'info', text: t('console.recovery.restorationStarted') });
    await load();
  }

  async function confirmEnable(): Promise<void> {
    if (enableTarget === null) return;
    const purpose = enableTarget.which === 'workers' ? 'restoration_workers' : 'restoration_connectivity';
    setBusy(true);
    setNotice(null);
    const grant = await stepUp(purpose, enableTarget.id);
    if (grant === null) {
      setBusy(false);
      return;
    }
    const enabled = enableTarget.which === 'workers'
      ? await consoleApi.enableRestoredWorkers(enableTarget.id, grant)
      : await consoleApi.enableRestoredConnectivity(enableTarget.id, grant);
    setBusy(false);
    setPassword('');
    setTotp('');
    if (!enabled.ok) {
      if (enabled.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(enabled.error.code), code: enabled.error.code });
      return;
    }
    setEnableTarget(null);
    setNotice({
      tone: 'info',
      text: enableTarget.which === 'workers' ? t('console.recovery.workersEnabled') : t('console.recovery.connectivityEnabled'),
    });
    await load();
  }

  async function inspect(backupId: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await consoleApi.recoverySet(backupId);
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setDetail(result.data);
    setDrill(null);
  }

  async function verify(backupId: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    const result = await consoleApi.verifyRecoverySet(backupId);
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setDrill(null);
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setDrill({ backupId, result: result.data });
    setNotice({ tone: 'info', text: t('console.recovery.verificationPassed') });
  }

  if (unavailable !== null) {
    return (
      <Panel title={t('console.recovery.unavailableTitle')} description={t('console.recovery.unavailableDescription')}>
        <Alert tone="warning" code={unavailable}>
          {apiFailureText(unavailable)}
        </Alert>
      </Panel>
    );
  }

  if (overview === null) {
    return (
      <Panel title={t('console.recovery.healthTitle')}>
        <p className="empty" role="status">
          {t('console.empty')}
        </p>
      </Panel>
    );
  }

  return (
    <div className="recovery">
      {notice ? (
        <Alert tone={notice.tone} {...(notice.code ? { code: notice.code } : {})}>
          {notice.text}
        </Alert>
      ) : null}

      <div className="grid">
        <Panel title={t('console.recovery.healthTitle')} description={t('console.recovery.healthDescription')}>
          <DefinitionList rows={healthRows(overview)} />
        </Panel>
        <Panel title={t('console.recovery.objectivesTitle')} description={t('console.recovery.objectivesDescription')}>
          <DefinitionList rows={objectiveRows(overview)} />
        </Panel>
      </div>

      <Panel title={t('console.recovery.checkpointsTitle')} description={t('console.recovery.checkpointsDescription')}>
        {overview.checkpoints.length === 0 ? (
          <p className="empty" role="status">
            {t('console.recovery.checkpointsEmpty')}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('console.recovery.checkpoint.id')}</th>
                <th scope="col">{t('console.recovery.checkpoint.createdAt')}</th>
                <th scope="col">{t('console.recovery.checkpoint.database')}</th>
                <th scope="col">{t('console.recovery.checkpoint.objects')}</th>
                <th scope="col">{t('console.recovery.checkpoint.rpo')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.checkpoints.map((checkpoint) => (
                <tr key={checkpoint.checkpoint_id}>
                  <td>
                    <code>{checkpoint.checkpoint_id}</code>
                  </td>
                  <td>{formatInstant(checkpoint.created_at)}</td>
                  <td>
                    <code>{checkpoint.database_position}</code>
                  </td>
                  <td>{message('console.recovery.detail.objects', {
                    verified: String(checkpoint.objects_count),
                    count: String(checkpoint.objects_count),
                  })}</td>
                  <td>
                    {checkpoint.rpo_interval_seconds === null
                      ? t('console.recovery.checkpoint.first')
                      : `${durationText(checkpoint.rpo_interval_seconds)} / ${durationText(checkpoint.rpo_limit_seconds)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={t('console.recovery.setsTitle')} description={t('console.recovery.setsDescription')}>
        {overview.recovery_sets.length === 0 ? (
          <p className="empty" role="status">
            {t('console.recovery.setsEmpty')}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('console.recovery.set.id')}</th>
                <th scope="col">{t('console.recovery.set.createdAt')}</th>
                <th scope="col">{t('console.recovery.set.checkpoint')}</th>
                <th scope="col">{t('console.recovery.set.components')}</th>
                <th scope="col">{t('console.recovery.set.age')}</th>
                <th scope="col">{t('console.recovery.set.retainUntil')}</th>
                <th scope="col">{t('console.recovery.set.retention')}</th>
                <th scope="col">{t('console.recovery.set.ledger')}</th>
                <th scope="col">{t('console.recovery.set.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.recovery_sets.map((set) => (
                <tr key={set.backup_id}>
                  <td>
                    <code>{set.backup_id}</code>
                  </td>
                  <td>{formatInstant(set.created_at)}</td>
                  <td>
                    <code>{set.checkpoint_id}</code>
                  </td>
                  <td>{set.components}</td>
                  <td>{set.age_seconds === null ? '—' : durationText(set.age_seconds)}</td>
                  <td>{formatInstant(set.retain_until)}</td>
                  <td>{set.within_retention ? t('console.recovery.withinRetention') : t('console.recovery.outsideRetention')}</td>
                  <td>{set.purge_ledger_through_sequence}</td>
                  <td>
                    <div className="form__actions">
                      <Button variant="quiet" busy={busy} onClick={() => void inspect(set.backup_id)}>
                        {t('console.recovery.inspect')}
                      </Button>
                      <Button variant="quiet" busy={busy} onClick={() => void verify(set.backup_id)}>
                        {t('console.recovery.verify')}
                      </Button>
                      <Button variant="secondary" busy={busy} onClick={() => beginRestore(set.backup_id)}>
                        {t('console.recovery.restore')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {detail === null ? null : (
        <Panel title={t('console.recovery.detailTitle')} description={t('console.recovery.detailDescription')}>
          <DefinitionList
            rows={[
              { term: t('console.recovery.set.id'), value: detail.manifest.backup_id, mono: true },
              { term: t('console.recovery.set.createdAt'), value: formatInstant(detail.manifest.created_at) },
              { term: t('console.recovery.set.deployment'), value: detail.manifest.deployment_id, mono: true },
              { term: t('console.recovery.set.release'), value: detail.manifest.release },
              { term: t('console.recovery.set.checkpoint'), value: detail.manifest.checkpoint_id, mono: true },
              { term: t('console.recovery.set.payloads'), value: yesNo(detail.manifest.payloads_encrypted) },
              {
                term: t('console.recovery.set.secrets'),
                value: detail.manifest.secrets_included
                  ? t('console.recovery.set.secretsIncluded')
                  : t('console.recovery.set.secretsExcluded'),
              },
              { term: t('console.recovery.set.escrow'), value: yesNo(detail.manifest.escrowed_separately.master_key) },
              { term: t('console.recovery.set.retainUntil'), value: formatInstant(detail.manifest.retention.retain_until) },
              { term: t('console.recovery.set.age'), value: durationText(detail.age_seconds) },
              {
                term: t('console.recovery.detail.integrity'),
                value: detail.integrity.verified ? t('console.recovery.integrityPassed') : t('console.recovery.integrityFailed'),
              },
              {
                term: t('console.recovery.detail.componentsLabel'),
                value: message('console.recovery.detail.components', { count: String(detail.integrity.checked) }),
              },
            ]}
          />
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('console.recovery.component.role')}</th>
                <th scope="col">{t('console.recovery.component.name')}</th>
                <th scope="col">{t('console.recovery.component.path')}</th>
                <th scope="col">{t('console.recovery.component.digest')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.manifest.components.map((component) => (
                <tr key={component.path}>
                  <td>{roleLabel(component.role)}</td>
                  <td>{component.name}</td>
                  <td>
                    <code>{component.path}</code>
                  </td>
                  <td>
                    <code>{component.sha256}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {drill === null ? null : (
        <Panel title={t('console.recovery.verificationTitle')} description={t('console.recovery.verificationDescription')}>
          <DefinitionList
            rows={[
              { term: t('console.recovery.verification.id'), value: drill.result.verification_id, mono: true },
              { term: t('console.recovery.verification.backup'), value: drill.backupId, mono: true },
              ...verificationRows(drill.result.verification),
              ...rtoRows(drill.result.rto),
              { term: t('console.recovery.evidence'), value: drill.result.evidence_id, mono: true },
            ]}
          />
        </Panel>
      )}

      <Panel title={t('console.recovery.restorationsTitle')} description={t('console.recovery.restorationsDescription')}>
        {overview.restorations.length === 0 ? (
          <p className="empty" role="status">
            {t('console.recovery.restorationsEmpty')}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('console.recovery.restoration.id')}</th>
                <th scope="col">{t('console.recovery.restoration.backup')}</th>
                <th scope="col">{t('console.recovery.restoration.state')}</th>
                <th scope="col">{t('console.recovery.restoration.requestedAt')}</th>
                <th scope="col">{t('console.recovery.restoration.finishedAt')}</th>
                <th scope="col">{t('console.recovery.restoration.workers')}</th>
                <th scope="col">{t('console.recovery.restoration.connectivity')}</th>
                <th scope="col">{t('console.recovery.restoration.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {overview.restorations.map((restoration) => (
                <tr key={restoration.restoration_id}>
                  <td>
                    <code>{restoration.restoration_id}</code>
                  </td>
                  <td>
                    <code>{restoration.backup_id}</code>
                  </td>
                  <td>
                    <StatusPill
                      tone={restoration.state === 'verified_open' ? 'ok' : 'warn'}
                      label={restorationStateLabel(restoration.state)}
                    />
                  </td>
                  <td>{formatInstant(restoration.requested_at)}</td>
                  <td>{formatInstant(restoration.finished_at ?? undefined)}</td>
                  <td>{enabledLabel(restoration.target.workers_enabled)}</td>
                  <td>{enabledLabel(restoration.target.connectivity_enabled)}</td>
                  <td>
                    <Button variant="quiet" busy={busy} onClick={() => setSelectedId(restoration.restoration_id)}>
                      {t('console.recovery.evidenceView')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {selected === null ? null : (
        <Panel title={t('console.recovery.evidenceTitle')} description={t('console.recovery.evidenceDescription')}>
          <DefinitionList
            rows={[
              { term: t('console.recovery.restoration.id'), value: selected.restoration_id, mono: true },
              { term: t('console.recovery.restoration.backup'), value: selected.backup_id, mono: true },
              { term: t('console.recovery.restoration.state'), value: restorationStateLabel(selected.state) },
              { term: t('console.recovery.restoration.target'), value: selected.target.root, mono: true },
              { term: t('console.recovery.restoration.isolation'), value: t('console.recovery.restoration.isolationBoundary') },
              { term: t('console.recovery.restoration.serviceOpen'), value: yesNo(selected.service_open) },
              { term: t('console.recovery.restoration.workers'), value: enabledLabel(selected.target.workers_enabled) },
              { term: t('console.recovery.restoration.connectivity'), value: enabledLabel(selected.target.connectivity_enabled) },
              ...(selected.error === null
                ? []
                : [{
                  term: t('console.recovery.restoration.failure'),
                  value: `${apiFailureText(selected.error.code)}（${selected.error.code}）`,
                }]),
              ...(selected.rto === null ? [] : rtoRows(selected.rto)),
              ...(selected.verification === null ? [] : verificationRows(selected.verification)),
              ...(selected.evidence_id === null
                ? []
                : [{ term: t('console.recovery.evidence'), value: selected.evidence_id, mono: true }]),
            ]}
          />
          <ol className="timeline">
            {selected.progress.map((entry) => (
              <li key={`${entry.step}-${entry.at}`}>
                {stepLabel(entry.step)} · {formatInstant(entry.at)}
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {selected === null || selected.state !== 'verified_open' ? null : (
        <Panel title={t('console.recovery.enableTitle')} description={t('console.recovery.enableDescription')}>
          <DefinitionList
            rows={[
              { term: t('console.recovery.restoration.workers'), value: enabledLabel(selected.target.workers_enabled) },
              { term: t('console.recovery.restoration.connectivity'), value: enabledLabel(selected.target.connectivity_enabled) },
            ]}
          />
          <div className="form__actions">
            <Button busy={busy || selected.target.workers_enabled} onClick={() => beginEnable(selected.restoration_id, 'workers')}>
              {t('console.recovery.enableWorkers')}
            </Button>
            <Button busy={busy || selected.target.connectivity_enabled} onClick={() => beginEnable(selected.restoration_id, 'connectivity')}>
              {t('console.recovery.enableConnectivity')}
            </Button>
          </div>
        </Panel>
      )}

      {restoreTarget === null ? null : (
        <Panel title={t('console.recovery.stepUpTitle')} description={t('console.recovery.stepUpDescription')}>
          <DefinitionList
            rows={[
              { term: t('console.recovery.stepUp.target'), value: restoreTarget, mono: true },
              {
                term: t('console.recovery.stepUp.scope'),
                value: message('console.recovery.stepUp.restoreScope', { root: overview.restore_root }),
              },
              { term: t('console.recovery.stepUp.consequence'), value: t('console.recovery.stepUp.restoreConsequence') },
            ]}
          />
          <Field
            id="recovery-restore-password"
            label={t('console.recovery.stepUp.password')}
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="current-password"
          />
          <Field
            id="recovery-restore-totp"
            label={t('console.recovery.stepUp.totp')}
            value={totp}
            onChange={setTotp}
            inputMode="numeric"
            maxLength={6}
          />
          <div className="form__actions">
            <Button busy={busy} onClick={() => void confirmRestore()}>
              {t('console.recovery.confirmRestore')}
            </Button>
            <Button variant="quiet" busy={busy} onClick={cancelChallenge}>
              {t('confirm.cancel')}
            </Button>
          </div>
        </Panel>
      )}

      {enableTarget === null ? null : (
        <Panel title={t('console.recovery.enableStepUpTitle')} description={t('console.recovery.stepUpDescription')}>
          <DefinitionList
            rows={[
              { term: t('console.recovery.stepUp.target'), value: enableTarget.id, mono: true },
              {
                term: t('console.recovery.stepUp.scope'),
                value: t('console.recovery.stepUp.enableScope'),
              },
              {
                term: t('console.recovery.stepUp.consequence'),
                value: enableTarget.which === 'workers'
                  ? t('console.recovery.stepUp.workersConsequence')
                  : t('console.recovery.stepUp.connectivityConsequence'),
              },
            ]}
          />
          <Field
            id="recovery-enable-password"
            label={t('console.recovery.stepUp.password')}
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete="current-password"
          />
          <Field
            id="recovery-enable-totp"
            label={t('console.recovery.stepUp.totp')}
            value={totp}
            onChange={setTotp}
            inputMode="numeric"
            maxLength={6}
          />
          <div className="form__actions">
            <Button busy={busy} onClick={() => void confirmEnable()}>
              {enableTarget.which === 'workers' ? t('console.recovery.confirmEnableWorkers') : t('console.recovery.confirmEnableConnectivity')}
            </Button>
            <Button variant="quiet" busy={busy} onClick={cancelChallenge}>
              {t('confirm.cancel')}
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
