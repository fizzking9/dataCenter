import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type DeploymentRetentionView,
  type OverridableRetentionClassKey,
  type PurgeJobList,
  type PurgeJobView,
  type PurgeOutcomeView,
  type PurgePlanEntryView,
  type PurgePreviewView,
  type RetentionBoundsView,
  type RetentionClassKey,
  type RetentionEvaluationView,
  type RetentionHoldList,
  type RetentionHoldView,
  type RetentionPolicyVersionView,
  type RetentionScopeInput,
  type RetentionScopeView,
  type RetentionTermView,
  type RetentionTickView,
  type WorkspaceRetentionView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

export interface DeploymentRetentionProps {
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

/** The nine settled data classes, in the order the tables state them. */
const RETENTION_CLASSES: RetentionClassKey[] = [
  'raw_acquisition',
  'dataset_release_history',
  'report',
  'artifact_version',
  'provenance',
  'audit_event',
  'proposal_evidence',
  'export',
  'derived_data',
];

/** The three classes a Workspace Administrator may override. */
const OVERRIDABLE_CLASSES: OverridableRetentionClassKey[] = [
  'raw_acquisition',
  'dataset_release_history',
  'report',
];

const HOLD_SCOPES: Array<RetentionScopeView['kind']> = [
  'workspace',
  'source',
  'dataset',
  'release',
  'proposal_evidence',
  'export',
];

/** The scopes a manual Purge supports. */
const PURGE_SCOPES: Array<RetentionScopeView['kind']> = [
  'workspace',
  'source',
  'dataset',
  'release',
  'proposal_evidence',
  'export',
];

function termLabel(term: RetentionTermView): string {
  if (term.kind === 'days') return message('value.retentionTerm.days', { days: String(term.days) });
  return term.kind === 'indefinite' ? t('value.retentionTerm.indefinite') : t('value.retentionTerm.noGuarantee');
}

function classLabel(dataClass: string): string {
  return optional(`value.retentionClass.${dataClass}`) ?? dataClass;
}

function clockLabel(dataClass: string): string {
  return optional(`value.retentionClock.${dataClass}`) ?? dataClass;
}

function scopeKindLabel(kind: string): string {
  return optional(`value.retentionScope.${kind}`) ?? kind;
}

function recordKindLabel(kind: string): string {
  return optional(`value.purgeRecord.${kind}`) ?? kind;
}

function reasonLabel(reason: string): string {
  return optional(`value.purgeReason.${reason}`) ?? reason;
}

function purgeStatusLabel(status: string): string {
  return optional(`value.purgeStatus.${status}`) ?? status;
}

function purgeModeLabel(mode: string): string {
  return optional(`value.purgeMode.${mode}`) ?? mode;
}

function holdStatusLabel(active: boolean): string {
  return active ? t('value.holdStatus.active') : t('value.holdStatus.released');
}

/** One scope, stated by kind and the exact identifiers it names. */
function scopeSummary(scope: RetentionScopeView): string {
  const parts = [scopeKindLabel(scope.kind)];
  if (scope.workspace_id !== null) parts.push(scope.workspace_id);
  if (scope.source_id !== null) parts.push(scope.source_id);
  if (scope.dataset_id !== null) parts.push(scope.dataset_id);
  if (scope.dataset_release !== null) parts.push(`v${scope.dataset_release}`);
  if (scope.target_id !== null) parts.push(scope.target_id);
  return parts.join(' · ');
}

function planDependencyText(entry: PurgePlanEntryView): string {
  const parts = [...entry.held_by, ...entry.dependencies];
  return parts.length === 0 ? '—' : parts.join('、');
}

/** The exact records one scope reaches, and why each is or is not eligible. */
function PurgePlanTable({ plan }: { plan: PurgePlanEntryView[] }) {
  if (plan.length === 0) {
    return <p className="empty">{t('workspace.retention.evaluate.empty')}</p>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{t('workspace.retention.plan.kind')}</th>
          <th scope="col">{t('workspace.retention.plan.id')}</th>
          <th scope="col">{t('workspace.retention.plan.class')}</th>
          <th scope="col">{t('workspace.retention.plan.eligible')}</th>
          <th scope="col">{t('workspace.retention.plan.reason')}</th>
          <th scope="col">{t('workspace.retention.plan.dependencies')}</th>
        </tr>
      </thead>
      <tbody>
        {plan.map((entry) => (
          <tr key={`${entry.record_kind}:${entry.record_id}`}>
            <td>{recordKindLabel(entry.record_kind)}</td>
            <td className="data-table__mono">{entry.record_id}</td>
            <td>{classLabel(entry.data_class)}</td>
            <td>{entry.eligible ? t('workspace.retention.plan.eligibleYes') : t('workspace.retention.plan.eligibleNo')}</td>
            <td>{reasonLabel(entry.reason)}</td>
            <td className="data-table__mono">{planDependencyText(entry)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The durable Purge jobs and the sequenced ledger entries they produced. */
function PurgeJobsPanel({
  view,
  title,
  description,
  empty,
}: {
  view: PurgeJobList | null;
  title: string;
  description?: string;
  empty: string;
}) {
  return (
    <Panel level={2} title={title} {...(description === undefined ? {} : { description })}>
      {view === null ? (
        <p className="empty" role="status">
          {t('platform.loading')}
        </p>
      ) : (
        <>
          {view.health.health === 'degraded' ? (
            <Alert tone="warning">
              {message('workspace.retention.health.degraded', { failed: String(view.health.failed_purges) })}
            </Alert>
          ) : null}
          {view.jobs.length === 0 ? (
            <p className="empty">{empty}</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.retention.purge.jobs.id')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.mode')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.status')}</th>
                  <th scope="col">{t('workspace.retention.purge.scopeKind')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.requestedAt')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.revokedAt')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.attempts')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.retryAt')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.purged')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.deferred')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.ledger')}</th>
                  <th scope="col">{t('workspace.retention.purge.jobs.lastError')}</th>
                </tr>
              </thead>
              <tbody>
                {view.jobs.map((job: PurgeJobView) => (
                  <tr key={job.purge_id}>
                    <td className="data-table__mono">{job.purge_id}</td>
                    <td>{purgeModeLabel(job.mode)}</td>
                    <td>{purgeStatusLabel(job.status)}</td>
                    <td>{scopeSummary(job.scope)}</td>
                    <td>{formatInstant(job.requested_at)}</td>
                    <td>{formatInstant(job.access_revoked_at ?? undefined)}</td>
                    <td>{job.attempts}</td>
                    <td>{formatInstant(job.retry_at ?? undefined)}</td>
                    <td>{job.purged_count}</td>
                    <td>{job.deferred_count}</td>
                    <td>{job.ledger_sequence ?? '—'}</td>
                    <td>{job.last_error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {view.ledger.length === 0 ? null : (
            <DefinitionList
              rows={view.ledger.map((entry) => ({
                term: `#${entry.sequence}`,
                value: `${formatInstant(entry.recorded_at)} · ${scopeSummary(entry.scope)} · ${entry.purged.length}`,
                mono: true,
              }))}
            />
          )}
        </>
      )}
    </Panel>
  );
}

function overrideTerm(view: WorkspaceRetentionView, dataClass: RetentionClassKey): string {
  if (!(OVERRIDABLE_CLASSES as string[]).includes(dataClass)) return '—';
  const term = view.overrides[dataClass as OverridableRetentionClassKey];
  return term === undefined ? '—' : termLabel(term);
}

function EffectiveRetentionTable({ view }: { view: WorkspaceRetentionView }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{t('workspace.retention.dataClass')}</th>
          <th scope="col">{t('workspace.retention.term')}</th>
          <th scope="col">{t('workspace.retention.clock')}</th>
          <th scope="col">{t('workspace.retention.overridden')}</th>
        </tr>
      </thead>
      <tbody>
        {RETENTION_CLASSES.map((dataClass) => (
          <tr key={dataClass}>
            <td>{classLabel(dataClass)}</td>
            <td>{termLabel(view.effective[dataClass])}</td>
            <td>{clockLabel(dataClass)}</td>
            <td>{overrideTerm(view, dataClass)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PolicyHistoryTable({ history }: { history: RetentionPolicyVersionView[] }) {
  if (history.length === 0) {
    return <p className="empty">{t('workspace.retention.history.empty')}</p>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{t('workspace.retention.history.version')}</th>
          <th scope="col">{t('workspace.retention.history.at')}</th>
          <th scope="col">{t('workspace.retention.history.by')}</th>
          <th scope="col">{t('deployment.retention.policy.contentHash')}</th>
        </tr>
      </thead>
      <tbody>
        {history.map((version) => (
          <tr key={version.version}>
            <td>{version.version}</td>
            <td>{formatInstant(version.published_at)}</td>
            <td>{version.published_by}</td>
            <td className="data-table__mono">{version.content_hash}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HoldsTable({ holds, busy, onRelease }: {
  holds: RetentionHoldView[];
  busy: boolean;
  onRelease: (hold: RetentionHoldView) => void;
}) {
  if (holds.length === 0) {
    return <p className="empty">{t('workspace.retention.holds.empty')}</p>;
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{t('workspace.retention.holds.id')}</th>
          <th scope="col">{t('workspace.retention.holds.scopeKind')}</th>
          <th scope="col">{t('workspace.retention.holds.reason')}</th>
          <th scope="col">{t('workspace.retention.holds.reviewAt')}</th>
          <th scope="col">{t('workspace.retention.holds.createdBy')}</th>
          <th scope="col">{t('workspace.retention.holds.status')}</th>
          <th scope="col">{t('workspace.retention.holds.releasedAt')}</th>
          <th scope="col">{t('workspace.retention.holds.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {holds.map((hold) => (
          <tr key={hold.hold_id}>
            <td className="data-table__mono">{hold.hold_id}</td>
            <td>{scopeSummary(hold.scope)}</td>
            <td>{hold.reason}</td>
            <td>{formatInstant(hold.review_at)}</td>
            <td>{hold.created_by}</td>
            <td>{holdStatusLabel(hold.active)}</td>
            <td>{formatInstant(hold.released_at ?? undefined)}</td>
            <td>
              {hold.active ? (
                <Button variant="quiet" busy={busy} onClick={() => onRelease(hold)}>
                  {t('workspace.retention.holds.releaseAction')}
                </Button>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface HoldDraft {
  scopeKind: RetentionScopeView['kind'];
  sourceId: string;
  datasetId: string;
  release: string;
  proposalId: string;
  exportId: string;
  reason: string;
  reviewAt: string;
}

interface OverrideDraft {
  raw: string;
  history: string;
  report: string;
}

interface PurgeDraft {
  scopeKind: RetentionScopeView['kind'];
  sourceId: string;
  datasetId: string;
  release: string;
  proposalId: string;
  exportId: string;
}

function emptyHoldDraft(): HoldDraft {
  return {
    scopeKind: 'workspace',
    sourceId: '',
    datasetId: '',
    release: '',
    proposalId: '',
    exportId: '',
    reason: '',
    reviewAt: '',
  };
}

function emptyOverrideDraft(): OverrideDraft {
  return { raw: '', history: '', report: '' };
}

function emptyPurgeDraft(): PurgeDraft {
  return {
    scopeKind: 'workspace',
    sourceId: '',
    datasetId: '',
    release: '',
    proposalId: '',
    exportId: '',
  };
}

/** The explicit scope one draft states; absent identifiers stay absent. */
function scopeOfDraft(workspaceId: string, draft: HoldDraft | PurgeDraft): RetentionScopeInput {
  const base: RetentionScopeInput = { workspaceId, scopeKind: draft.scopeKind };
  if (draft.scopeKind === 'source') return { ...base, sourceId: draft.sourceId.trim() };
  if (draft.scopeKind === 'dataset') return { ...base, datasetId: draft.datasetId.trim() };
  if (draft.scopeKind === 'release') {
    return {
      ...base,
      datasetId: draft.datasetId.trim(),
      datasetRelease: Number(draft.release.trim()),
    };
  }
  if (draft.scopeKind === 'proposal_evidence') return { ...base, proposalId: draft.proposalId.trim() };
  if (draft.scopeKind === 'export') return { ...base, exportId: draft.exportId.trim() };
  return base;
}

/** The same identifiers, stated for the confirmation before anything is sent. */
function draftScopeSummary(workspaceId: string, draft: HoldDraft | PurgeDraft): string {
  const kind = scopeKindLabel(draft.scopeKind);
  if (draft.scopeKind === 'source') return `${kind} · ${draft.sourceId.trim()}`;
  if (draft.scopeKind === 'dataset') return `${kind} · ${draft.datasetId.trim()}`;
  if (draft.scopeKind === 'release') return `${kind} · ${draft.datasetId.trim()} · v${draft.release.trim()}`;
  if (draft.scopeKind === 'proposal_evidence') return `${kind} · ${draft.proposalId.trim()}`;
  if (draft.scopeKind === 'export') return `${kind} · ${draft.exportId.trim()}`;
  return `${kind} · ${workspaceId}`;
}

function overrideTermsOf(draft: OverrideDraft): Partial<Record<OverridableRetentionClassKey, RetentionTermView>> {
  const terms: Partial<Record<OverridableRetentionClassKey, RetentionTermView>> = {};
  if (draft.raw.trim() !== '') terms.raw_acquisition = { kind: 'days', days: Number(draft.raw.trim()) };
  if (draft.history.trim() !== '') terms.dataset_release_history = { kind: 'days', days: Number(draft.history.trim()) };
  if (draft.report.trim() !== '') terms.report = { kind: 'days', days: Number(draft.report.trim()) };
  return terms;
}

/**
 * The Workspace Administrator's retention surface: the effective clocks, the
 * Workspace override, accountable Holds, dependency-aware eligibility, and a
 * step-up-authenticated manual Purge. Every decision comes from the server.
 */
export function WorkspaceRetention({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [retention, setRetention] = useState<WorkspaceRetentionView | null>(null);
  const [holds, setHolds] = useState<RetentionHoldList | null>(null);
  const [purges, setPurges] = useState<PurgeJobList | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const [overrideDraft, setOverrideDraft] = useState<OverrideDraft>(emptyOverrideDraft);
  const [pendingOverride, setPendingOverride] = useState<Partial<Record<OverridableRetentionClassKey, RetentionTermView>> | null>(null);

  const [holdDraft, setHoldDraft] = useState<HoldDraft>(emptyHoldDraft);
  const [pendingHold, setPendingHold] = useState<HoldDraft | null>(null);
  const [pendingRelease, setPendingRelease] = useState<RetentionHoldView | null>(null);

  const [evaluation, setEvaluation] = useState<RetentionEvaluationView | null>(null);
  const [purgeDraft, setPurgeDraft] = useState<PurgeDraft>(emptyPurgeDraft);
  const [preview, setPreview] = useState<PurgePreviewView | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [stepPassword, setStepPassword] = useState('');
  const [stepTotp, setStepTotp] = useState('');
  const [stepRecovery, setStepRecovery] = useState('');
  const [outcome, setOutcome] = useState<PurgeOutcomeView | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [policy, holdList, purgeList] = await Promise.all([
      platformApi.workspaceRetention(workspaceId),
      platformApi.workspaceRetentionHolds(workspaceId),
      platformApi.workspacePurges(workspaceId),
    ]);
    if (!policy.ok) {
      if (policy.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setRetention(policy.data);
    if (holdList.ok) setHolds(holdList.data);
    if (purgeList.ok) setPurges(purgeList.data);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const failedWrite = (result: { status: number; error: { code: string } }): void => {
    setBusy(false);
    setPendingOverride(null);
    setPendingHold(null);
    setPendingRelease(null);
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
  };

  const publishOverride = (): void => {
    if (pendingOverride === null) return;
    setBusy(true);
    setNotice(null);
    void platformApi.publishRetentionOverride(workspaceId, pendingOverride).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPendingOverride(null);
      setOverrideDraft(emptyOverrideDraft());
      setNotice({
        tone: 'info',
        text: message('workspace.retention.override.published', { version: String(result.data.override_version) }),
      });
    });
  };

  const createHold = (): void => {
    if (pendingHold === null) return;
    setBusy(true);
    setNotice(null);
    void platformApi.createRetentionHold(
      scopeOfDraft(workspaceId, pendingHold),
      pendingHold.reason.trim(),
      pendingHold.reviewAt.trim(),
    ).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPendingHold(null);
      setHoldDraft(emptyHoldDraft());
      setNotice({
        tone: 'info',
        text: message('workspace.retention.holds.created', { hold: result.data.hold_id }),
      });
    });
  };

  const releaseHold = (): void => {
    if (pendingRelease === null) return;
    setBusy(true);
    setNotice(null);
    void platformApi.releaseRetentionHold(pendingRelease.hold_id).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPendingRelease(null);
      setNotice({
        tone: 'info',
        text: message('workspace.retention.holds.released', { hold: result.data.hold_id }),
      });
    });
  };

  const runEvaluation = (): void => {
    setBusy(true);
    setNotice(null);
    void platformApi.evaluateRetention(workspaceId).then((result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      setBusy(false);
      setEvaluation(result.data);
    });
  };

  const runPreview = (): void => {
    setBusy(true);
    setNotice(null);
    setPreview(null);
    setConfirmingPurge(false);
    setOutcome(null);
    void platformApi.previewPurge(scopeOfDraft(workspaceId, purgeDraft)).then((result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      setBusy(false);
      setPreview(result.data);
    });
  };

  const requestPurge = (): void => {
    setBusy(true);
    setNotice(null);
    void platformApi.requestPurge(scopeOfDraft(workspaceId, purgeDraft), {
      password: stepPassword,
      ...(stepTotp.trim() === '' ? {} : { totp: stepTotp.trim() }),
      ...(stepTotp.trim() !== '' || stepRecovery.trim() === '' ? {} : { recovery_code: stepRecovery.trim() }),
    }).then(async (result) => {
      if (!result.ok) {
        // A refused re-authentication is not a lost session: the standing
        // session stays signed in and the challenge simply fails closed.
        if (result.error.code === 'STEP_UP_AUTHENTICATION_FAILED') {
          setBusy(false);
          setConfirmingPurge(false);
          setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
          return;
        }
        failedWrite(result);
        setConfirmingPurge(false);
        return;
      }
      await load();
      setBusy(false);
      setConfirmingPurge(false);
      setStepPassword('');
      setStepTotp('');
      setStepRecovery('');
      setOutcome(result.data);
      setNotice({
        tone: 'info',
        text: result.data.purge_id === null
          ? t('workspace.retention.purge.nothingEligible')
          : message('workspace.retention.purge.revoked', { purge: result.data.purge_id }),
      });
    });
  };

  const updatePurgeDraft = (update: Partial<PurgeDraft>): void => {
    setPurgeDraft((current) => ({ ...current, ...update }));
    setPreview(null);
    setConfirmingPurge(false);
    setOutcome(null);
  };

  const updateHoldDraft = (update: Partial<HoldDraft>): void => {
    setHoldDraft((current) => ({ ...current, ...update }));
  };

  const previewEntries = preview?.plan ?? outcome?.plan ?? [];
  const dependencies = [
    ...new Set(previewEntries.flatMap((entry) => [...entry.held_by, ...entry.dependencies])),
  ];

  return (
    <Panel level={1} title={t('workspace.retention.title')} description={t('workspace.retention.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {retention === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : (
        <Panel level={2} title={t('workspace.retention.policy.title')} description={t('workspace.retention.policy.description')}>
          <DefinitionList
            rows={[
              { term: t('workspace.retention.policyVersion'), value: String(retention.policy_version) },
              { term: t('workspace.retention.overrideVersion'), value: retention.override_version === null ? '—' : String(retention.override_version) },
              { term: t('workspace.retention.policy.scope'), value: t('value.retentionScope.workspace') },
              { term: t('workspace.retention.effect'), value: t('workspace.retention.effectExisting') },
            ]}
          />
          {retention.clamped.length === 0 ? null : (
            <Alert tone="warning">
              {message('workspace.retention.clamped', {
                classes: retention.clamped.map((dataClass) => classLabel(dataClass)).join('、'),
              })}
            </Alert>
          )}
          <EffectiveRetentionTable view={retention} />
          <Panel level={2} title={t('workspace.retention.history.title')}>
            <PolicyHistoryTable history={retention.policy_history} />
            {retention.override_history.length === 0 ? null : (
              <DefinitionList
                rows={retention.override_history.map((version) => ({
                  term: `${t('workspace.retention.overrideVersion')} ${version.version}`,
                  value: `${formatInstant(version.updated_at)} · ${version.updated_by}`,
                }))}
              />
            )}
          </Panel>
        </Panel>
      )}

      <Panel level={2} title={t('workspace.retention.override.title')} description={t('workspace.retention.override.description')}>
        <div className="field">
          <Field
            id="retention-override-raw"
            label={t('workspace.retention.override.raw')}
            value={overrideDraft.raw}
            onChange={(value) => setOverrideDraft((current) => ({ ...current, raw: value }))}
            inputMode="numeric"
          />
          <Field
            id="retention-override-history"
            label={t('workspace.retention.override.history')}
            value={overrideDraft.history}
            onChange={(value) => setOverrideDraft((current) => ({ ...current, history: value }))}
            inputMode="numeric"
          />
          <Field
            id="retention-override-report"
            label={t('workspace.retention.override.report')}
            value={overrideDraft.report}
            onChange={(value) => setOverrideDraft((current) => ({ ...current, report: value }))}
            inputMode="numeric"
          />
        </div>
        <Button busy={busy} onClick={() => setPendingOverride(overrideTermsOf(overrideDraft))}>
          {t('workspace.retention.override.publish')}
        </Button>
        {pendingOverride === null ? null : (
          <Confirmation
            title={t('workspace.retention.override.confirmTitle')}
            target={workspaceId}
            scope={t('value.retentionScope.workspace')}
            consequence={t('workspace.retention.override.confirmConsequence')}
            confirmLabel={t('workspace.retention.override.publish')}
            busy={busy}
            onConfirm={publishOverride}
            onCancel={() => setPendingOverride(null)}
          />
        )}
      </Panel>

      <Panel level={2} title={t('workspace.retention.holds.title')} description={t('workspace.retention.holds.description')}>
        <HoldsTable holds={holds?.holds ?? []} busy={busy} onRelease={(hold) => setPendingRelease(hold)} />
        <div className="field">
          <label className="field__label" htmlFor="retention-hold-scope">
            {t('workspace.retention.holds.scopeKind')}
          </label>
          <select
            className="field__input"
            id="retention-hold-scope"
            value={holdDraft.scopeKind}
            onChange={(event) => updateHoldDraft({ scopeKind: event.target.value as RetentionScopeView['kind'] })}
          >
            {HOLD_SCOPES.map((kind) => (
              <option key={kind} value={kind}>
                {scopeKindLabel(kind)}
              </option>
            ))}
          </select>
          {holdDraft.scopeKind === 'source' ? (
            <Field id="retention-hold-source" label={t('workspace.retention.holds.sourceId')} value={holdDraft.sourceId} onChange={(value) => updateHoldDraft({ sourceId: value })} mono />
          ) : null}
          {holdDraft.scopeKind === 'dataset' || holdDraft.scopeKind === 'release' ? (
            <Field id="retention-hold-dataset" label={t('workspace.retention.holds.datasetId')} value={holdDraft.datasetId} onChange={(value) => updateHoldDraft({ datasetId: value })} mono />
          ) : null}
          {holdDraft.scopeKind === 'release' ? (
            <Field id="retention-hold-release" label={t('workspace.retention.holds.releaseNumber')} value={holdDraft.release} onChange={(value) => updateHoldDraft({ release: value })} inputMode="numeric" />
          ) : null}
          {holdDraft.scopeKind === 'proposal_evidence' ? (
            <Field id="retention-hold-proposal" label={t('workspace.retention.holds.proposalId')} value={holdDraft.proposalId} onChange={(value) => updateHoldDraft({ proposalId: value })} mono />
          ) : null}
          {holdDraft.scopeKind === 'export' ? (
            <Field id="retention-hold-export" label={t('workspace.retention.holds.exportId')} value={holdDraft.exportId} onChange={(value) => updateHoldDraft({ exportId: value })} mono />
          ) : null}
          <Field
            id="retention-hold-reason"
            label={t('workspace.retention.holds.reason')}
            value={holdDraft.reason}
            onChange={(value) => updateHoldDraft({ reason: value })}
            hint={t('workspace.retention.holds.description')}
          />
          <Field
            id="retention-hold-review"
            label={t('workspace.retention.holds.reviewAt')}
            value={holdDraft.reviewAt}
            onChange={(value) => updateHoldDraft({ reviewAt: value })}
            hint={t('value.timestampHint')}
            mono
          />
        </div>
        <Button busy={busy} onClick={() => setPendingHold(holdDraft)}>
          {t('workspace.retention.holds.create')}
        </Button>
        {pendingHold === null ? null : (
          <Confirmation
            title={t('workspace.retention.holds.confirmCreateTitle')}
            target={draftScopeSummary(workspaceId, pendingHold)}
            scope={t('value.retentionScope.workspace')}
            consequence={t('workspace.retention.holds.confirmCreateConsequence')}
            confirmLabel={t('workspace.retention.holds.create')}
            busy={busy}
            onConfirm={createHold}
            onCancel={() => setPendingHold(null)}
          />
        )}
        {pendingRelease === null ? null : (
          <Confirmation
            title={t('workspace.retention.holds.releaseConfirmTitle')}
            target={pendingRelease.hold_id}
            scope={scopeSummary(pendingRelease.scope)}
            consequence={t('workspace.retention.holds.releaseConfirmConsequence')}
            confirmLabel={t('workspace.retention.holds.releaseAction')}
            busy={busy}
            onConfirm={releaseHold}
            onCancel={() => setPendingRelease(null)}
          />
        )}
      </Panel>

      <Panel level={2} title={t('workspace.retention.evaluate.title')} description={t('workspace.retention.evaluate.description')}>
        <Button busy={busy} onClick={runEvaluation}>
          {t('workspace.retention.evaluate.run')}
        </Button>
        {evaluation === null ? null : (
          <>
            <DefinitionList
              rows={[
                { term: t('workspace.retention.evaluate.eligible'), value: String(evaluation.eligible_count) },
                { term: t('workspace.retention.evaluate.blocked'), value: String(evaluation.blocked_count) },
                { term: t('workspace.retention.evaluate.held'), value: String(evaluation.held_count) },
              ]}
            />
            <p className="field__hint">{t('workspace.retention.evaluate.expiredNote')}</p>
            <PurgePlanTable plan={evaluation.plan} />
          </>
        )}
      </Panel>

      <Panel level={2} title={t('workspace.retention.purge.title')} description={t('workspace.retention.purge.description')}>
        <div className="field">
          <label className="field__label" htmlFor="retention-purge-scope">
            {t('workspace.retention.purge.scopeKind')}
          </label>
          <select
            className="field__input"
            id="retention-purge-scope"
            value={purgeDraft.scopeKind}
            onChange={(event) => updatePurgeDraft({ scopeKind: event.target.value as RetentionScopeView['kind'] })}
          >
            {PURGE_SCOPES.map((kind) => (
              <option key={kind} value={kind}>
                {scopeKindLabel(kind)}
              </option>
            ))}
          </select>
          {purgeDraft.scopeKind === 'source' ? (
            <Field id="retention-purge-source" label={t('workspace.retention.holds.sourceId')} value={purgeDraft.sourceId} onChange={(value) => updatePurgeDraft({ sourceId: value })} mono />
          ) : null}
          {purgeDraft.scopeKind === 'dataset' || purgeDraft.scopeKind === 'release' ? (
            <Field id="retention-purge-dataset" label={t('workspace.retention.holds.datasetId')} value={purgeDraft.datasetId} onChange={(value) => updatePurgeDraft({ datasetId: value })} mono />
          ) : null}
          {purgeDraft.scopeKind === 'release' ? (
            <Field id="retention-purge-release" label={t('workspace.retention.holds.releaseNumber')} value={purgeDraft.release} onChange={(value) => updatePurgeDraft({ release: value })} inputMode="numeric" />
          ) : null}
          {purgeDraft.scopeKind === 'proposal_evidence' ? (
            <Field id="retention-purge-proposal" label={t('workspace.retention.holds.proposalId')} value={purgeDraft.proposalId} onChange={(value) => updatePurgeDraft({ proposalId: value })} mono />
          ) : null}
          {purgeDraft.scopeKind === 'export' ? (
            <Field id="retention-purge-export" label={t('workspace.retention.holds.exportId')} value={purgeDraft.exportId} onChange={(value) => updatePurgeDraft({ exportId: value })} mono />
          ) : null}
        </div>
        <div className="form__actions">
          <Button busy={busy} onClick={runPreview}>
            {t('workspace.retention.purge.preview')}
          </Button>
          {preview === null ? null : (
            <Button variant="secondary" busy={busy} onClick={() => setConfirmingPurge(true)}>
              {t('workspace.retention.purge.request')}
            </Button>
          )}
        </div>
        {preview === null ? null : (
          <>
            <DefinitionList
              rows={[
                { term: t('workspace.retention.purge.scopeKind'), value: scopeSummary(preview.scope) },
                {
                  term: t('workspace.retention.purge.dependencies'),
                  value: message('workspace.retention.purge.planSummary', {
                    eligible: String(preview.eligible_count),
                    blocked: String(preview.blocked_count),
                    held: String(preview.held_count),
                  }),
                },
              ]}
            />
            <PurgePlanTable plan={preview.plan} />
          </>
        )}
        {confirmingPurge && preview !== null ? (
          <Panel
            level={2}
            title={t('workspace.retention.purge.confirmTitle')}
            description={t('workspace.retention.purge.confirmDescription')}
          >
            <DefinitionList
              rows={[
                { term: t('workspace.retention.purge.target'), value: scopeSummary(preview.scope), mono: true },
                {
                  term: t('workspace.retention.purge.dependencies'),
                  value: dependencies.length === 0 ? '—' : dependencies.join('、'),
                  mono: true,
                },
                { term: t('workspace.retention.purge.consequence'), value: t('workspace.retention.purge.consequenceText') },
              ]}
            />
            <Panel level={2} title={t('workspace.retention.purge.stepUpTitle')} description={t('workspace.retention.purge.stepUpDescription')}>
              <Field
                id="retention-purge-password"
                label={t('workspace.retention.purge.password')}
                value={stepPassword}
                onChange={setStepPassword}
                type="password"
                autoComplete="current-password"
              />
              <Field
                id="retention-purge-totp"
                label={t('workspace.retention.purge.totp')}
                value={stepTotp}
                onChange={setStepTotp}
                inputMode="numeric"
                maxLength={6}
              />
              <Field
                id="retention-purge-recovery"
                label={t('workspace.retention.purge.recovery')}
                value={stepRecovery}
                onChange={setStepRecovery}
                hint={t('workspace.retention.purge.recoveryHint')}
                mono
              />
            </Panel>
            <div className="form__actions">
              <Button busy={busy} onClick={requestPurge}>
                {t('workspace.retention.purge.confirm')}
              </Button>
              <Button variant="quiet" busy={busy} onClick={() => setConfirmingPurge(false)}>
                {t('confirm.cancel')}
              </Button>
            </div>
          </Panel>
        ) : null}
        {outcome === null ? null : (
          <DefinitionList
            rows={[
              { term: t('workspace.retention.purge.jobs.id'), value: outcome.purge_id ?? '—', mono: true },
              { term: t('workspace.retention.purge.jobs.revokedAt'), value: formatInstant(outcome.access_revoked_at ?? undefined) },
              {
                term: t('workspace.retention.purge.consequence'),
                value: message('workspace.retention.purge.planSummary', {
                  eligible: String(outcome.eligible_count),
                  blocked: String(outcome.blocked_count),
                  held: String(outcome.held_count),
                }),
              },
            ]}
          />
        )}
      </Panel>

      <PurgeJobsPanel
        view={purges}
        title={t('workspace.retention.purge.jobs.title')}
        empty={t('workspace.retention.purge.jobs.empty')}
      />
    </Panel>
  );
}

interface PolicyDraft {
  raw: string;
  history: string;
  report: string;
  audit: string;
  rawMin: string;
  rawMax: string;
  historyMin: string;
  historyMax: string;
  reportMin: string;
  reportMax: string;
}

function emptyPolicyDraft(): PolicyDraft {
  return {
    raw: '',
    history: '',
    report: '',
    audit: '',
    rawMin: '',
    rawMax: '',
    historyMin: '',
    historyMax: '',
    reportMin: '',
    reportMax: '',
  };
}

function policyDefaultsOf(draft: PolicyDraft): Partial<Record<RetentionClassKey, RetentionTermView>> {
  const defaults: Partial<Record<RetentionClassKey, RetentionTermView>> = {};
  if (draft.raw.trim() !== '') defaults.raw_acquisition = { kind: 'days', days: Number(draft.raw.trim()) };
  if (draft.history.trim() !== '') defaults.dataset_release_history = { kind: 'days', days: Number(draft.history.trim()) };
  if (draft.report.trim() !== '') defaults.report = { kind: 'days', days: Number(draft.report.trim()) };
  if (draft.audit.trim() !== '') defaults.audit_event = { kind: 'days', days: Number(draft.audit.trim()) };
  return defaults;
}

function policyBoundsOf(draft: PolicyDraft): Partial<Record<OverridableRetentionClassKey, RetentionBoundsView>> {
  const bounds: Partial<Record<OverridableRetentionClassKey, RetentionBoundsView>> = {};
  const pairs: Array<[OverridableRetentionClassKey, string, string]> = [
    ['raw_acquisition', draft.rawMin, draft.rawMax],
    ['dataset_release_history', draft.historyMin, draft.historyMax],
    ['report', draft.reportMin, draft.reportMax],
  ];
  for (const [dataClass, min, max] of pairs) {
    if (min.trim() === '' || max.trim() === '') continue;
    bounds[dataClass] = { min_days: Number(min.trim()), max_days: Number(max.trim()) };
  }
  return bounds;
}

/**
 * The Deployment Administrator's retention surface: the versioned defaults and
 * bounds every Workspace inherits, the deployment-scope Holds, and the
 * automatic Purge tick that queues and retries eligible deletion.
 */
export function DeploymentRetention({ onSessionLost }: DeploymentRetentionProps) {
  const [policy, setPolicy] = useState<DeploymentRetentionView | null>(null);
  const [holds, setHolds] = useState<RetentionHoldList | null>(null);
  const [purges, setPurges] = useState<PurgeJobList | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<PolicyDraft>(emptyPolicyDraft);
  const [pendingPolicy, setPendingPolicy] = useState<{
    defaults: Partial<Record<RetentionClassKey, RetentionTermView>>;
    bounds: Partial<Record<OverridableRetentionClassKey, RetentionBoundsView>>;
  } | null>(null);

  const [holdReason, setHoldReason] = useState('');
  const [holdReviewAt, setHoldReviewAt] = useState('');
  const [pendingHold, setPendingHold] = useState<{ reason: string; reviewAt: string } | null>(null);
  const [pendingRelease, setPendingRelease] = useState<RetentionHoldView | null>(null);
  const [ticked, setTicked] = useState<RetentionTickView | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [policyView, holdList, purgeList] = await Promise.all([
      platformApi.deploymentRetention(),
      platformApi.deploymentRetentionHolds(),
      platformApi.deploymentPurges(),
    ]);
    if (!policyView.ok) {
      if (policyView.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setPolicy(policyView.data);
    if (holdList.ok) setHolds(holdList.data);
    if (purgeList.ok) setPurges(purgeList.data);
  }, [onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const failedWrite = (result: { status: number; error: { code: string } }): void => {
    setBusy(false);
    setPendingPolicy(null);
    setPendingHold(null);
    setPendingRelease(null);
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
  };

  const publishPolicy = (): void => {
    if (pendingPolicy === null) return;
    setBusy(true);
    setNotice(null);
    void platformApi.publishRetentionPolicy(pendingPolicy.defaults, pendingPolicy.bounds).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPendingPolicy(null);
      setDraft(emptyPolicyDraft());
      setNotice({
        tone: 'info',
        text: message('deployment.retention.publish.published', { version: String(result.data.policy_version) }),
      });
    });
  };

  const createHold = (): void => {
    if (pendingHold === null) return;
    setBusy(true);
    setNotice(null);
    void platformApi.createDeploymentRetentionHold(pendingHold.reason.trim(), pendingHold.reviewAt.trim()).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPendingHold(null);
      setHoldReason('');
      setHoldReviewAt('');
      setNotice({
        tone: 'info',
        text: message('deployment.retention.holds.created', { hold: result.data.hold_id }),
      });
    });
  };

  const releaseHold = (): void => {
    if (pendingRelease === null) return;
    setBusy(true);
    setNotice(null);
    void platformApi.releaseRetentionHold(pendingRelease.hold_id).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setPendingRelease(null);
      setNotice({
        tone: 'info',
        text: message('workspace.retention.holds.released', { hold: result.data.hold_id }),
      });
    });
  };

  const runTick = (): void => {
    setBusy(true);
    setNotice(null);
    void platformApi.tickRetention().then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await load();
      setBusy(false);
      setTicked(result.data);
      setNotice({
        tone: 'info',
        text: message('deployment.retention.tick.result', {
          created: String(result.data.created_jobs.length),
          executed: String(result.data.jobs.length),
          ledger: String(result.data.ledger.length),
        }),
      });
    });
  };

  return (
    <Panel level={1} title={t('deployment.retention.title')} description={t('deployment.retention.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {policy === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : (
        <>
          <Panel level={2} title={t('deployment.retention.policy.title')}>
            <DefinitionList
              rows={[
                { term: t('deployment.retention.policy.version'), value: String(policy.policy_version) },
                {
                  term: t('deployment.retention.policy.source'),
                  value: policy.source === 'settled'
                    ? t('deployment.retention.policy.sourceSettled')
                    : t('deployment.retention.policy.sourcePublished'),
                },
                ...(policy.content_hash === null
                  ? []
                  : [{ term: t('deployment.retention.policy.contentHash'), value: policy.content_hash, mono: true }]),
                { term: t('workspace.retention.policy.scope'), value: t('value.retentionScope.deployment') },
                { term: t('workspace.retention.effect'), value: t('workspace.retention.effectExisting') },
              ]}
            />
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.retention.dataClass')}</th>
                  <th scope="col">{t('workspace.retention.term')}</th>
                  <th scope="col">{t('workspace.retention.clock')}</th>
                </tr>
              </thead>
              <tbody>
                {RETENTION_CLASSES.map((dataClass) => (
                  <tr key={dataClass}>
                    <td>{classLabel(dataClass)}</td>
                    <td>{termLabel(policy.defaults[dataClass])}</td>
                    <td>{clockLabel(dataClass)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <DefinitionList
              rows={OVERRIDABLE_CLASSES.map((dataClass) => ({
                term: classLabel(dataClass),
                value: `${policy.bounds[dataClass].min_days} – ${policy.bounds[dataClass].max_days} ${t('value.days')}`,
              }))}
            />
          </Panel>

          <Panel level={2} title={t('deployment.retention.publish.title')} description={t('deployment.retention.publish.description')}>
            <div className="field">
              <Field id="policy-raw" label={t('workspace.retention.override.raw')} value={draft.raw} onChange={(value) => setDraft((current) => ({ ...current, raw: value }))} inputMode="numeric" />
              <Field id="policy-history" label={t('workspace.retention.override.history')} value={draft.history} onChange={(value) => setDraft((current) => ({ ...current, history: value }))} inputMode="numeric" />
              <Field id="policy-report" label={t('workspace.retention.override.report')} value={draft.report} onChange={(value) => setDraft((current) => ({ ...current, report: value }))} inputMode="numeric" />
              <Field id="policy-audit" label={t('deployment.retention.policy.audit')} value={draft.audit} onChange={(value) => setDraft((current) => ({ ...current, audit: value }))} inputMode="numeric" />
              <Field id="policy-raw-min" label={`${classLabel('raw_acquisition')} ${t('deployment.retention.policy.boundsMin')}`} value={draft.rawMin} onChange={(value) => setDraft((current) => ({ ...current, rawMin: value }))} inputMode="numeric" />
              <Field id="policy-raw-max" label={`${classLabel('raw_acquisition')} ${t('deployment.retention.policy.boundsMax')}`} value={draft.rawMax} onChange={(value) => setDraft((current) => ({ ...current, rawMax: value }))} inputMode="numeric" />
              <Field id="policy-history-min" label={`${classLabel('dataset_release_history')} ${t('deployment.retention.policy.boundsMin')}`} value={draft.historyMin} onChange={(value) => setDraft((current) => ({ ...current, historyMin: value }))} inputMode="numeric" />
              <Field id="policy-history-max" label={`${classLabel('dataset_release_history')} ${t('deployment.retention.policy.boundsMax')}`} value={draft.historyMax} onChange={(value) => setDraft((current) => ({ ...current, historyMax: value }))} inputMode="numeric" />
              <Field id="policy-report-min" label={`${classLabel('report')} ${t('deployment.retention.policy.boundsMin')}`} value={draft.reportMin} onChange={(value) => setDraft((current) => ({ ...current, reportMin: value }))} inputMode="numeric" />
              <Field id="policy-report-max" label={`${classLabel('report')} ${t('deployment.retention.policy.boundsMax')}`} value={draft.reportMax} onChange={(value) => setDraft((current) => ({ ...current, reportMax: value }))} inputMode="numeric" />
            </div>
            <Button busy={busy} onClick={() => setPendingPolicy({ defaults: policyDefaultsOf(draft), bounds: policyBoundsOf(draft) })}>
              {t('deployment.retention.publish.submit')}
            </Button>
            {pendingPolicy === null ? null : (
              <Confirmation
                title={t('deployment.retention.publish.confirmTitle')}
                target={`${t('deployment.retention.policy.version')} ${policy.policy_version + 1}`}
                scope={t('value.retentionScope.deployment')}
                consequence={t('deployment.retention.publish.confirmConsequence')}
                confirmLabel={t('deployment.retention.publish.submit')}
                busy={busy}
                onConfirm={publishPolicy}
                onCancel={() => setPendingPolicy(null)}
              />
            )}
          </Panel>

          <Panel level={2} title={t('deployment.retention.history.title')}>
            <PolicyHistoryTable history={policy.history} />
          </Panel>
        </>
      )}

      <Panel level={2} title={t('deployment.retention.holds.title')} description={t('deployment.retention.holds.description')}>
        <HoldsTable holds={holds?.holds ?? []} busy={busy} onRelease={(hold) => setPendingRelease(hold)} />
        <div className="field">
          <Field
            id="deployment-hold-reason"
            label={t('deployment.retention.holds.reason')}
            value={holdReason}
            onChange={setHoldReason}
            hint={t('workspace.retention.holds.description')}
          />
          <Field
            id="deployment-hold-review"
            label={t('deployment.retention.holds.reviewAt')}
            value={holdReviewAt}
            onChange={setHoldReviewAt}
            hint={t('value.timestampHint')}
            mono
          />
        </div>
        <Button busy={busy} onClick={() => setPendingHold({ reason: holdReason, reviewAt: holdReviewAt })}>
          {t('deployment.retention.holds.create')}
        </Button>
        {pendingHold === null ? null : (
          <Confirmation
            title={t('workspace.retention.holds.confirmCreateTitle')}
            target={t('value.retentionScope.deployment')}
            scope={t('value.retentionScope.deployment')}
            consequence={t('workspace.retention.holds.confirmCreateConsequence')}
            confirmLabel={t('deployment.retention.holds.create')}
            busy={busy}
            onConfirm={createHold}
            onCancel={() => setPendingHold(null)}
          />
        )}
        {pendingRelease === null ? null : (
          <Confirmation
            title={t('workspace.retention.holds.releaseConfirmTitle')}
            target={pendingRelease.hold_id}
            scope={scopeSummary(pendingRelease.scope)}
            consequence={t('workspace.retention.holds.releaseConfirmConsequence')}
            confirmLabel={t('workspace.retention.holds.releaseAction')}
            busy={busy}
            onConfirm={releaseHold}
            onCancel={() => setPendingRelease(null)}
          />
        )}
      </Panel>

      <Panel level={2} title={t('deployment.retention.tick.title')} description={t('deployment.retention.tick.description')}>
        <Button busy={busy} onClick={runTick}>
          {t('deployment.retention.tick.run')}
        </Button>
        {ticked === null ? null : (
          <DefinitionList
            rows={[
              { term: t('deployment.retention.tick.health'), value: optional(`value.retentionHealth.${ticked.health}`) ?? ticked.health },
              { term: t('deployment.retention.tick.created'), value: String(ticked.created_jobs.length) },
              { term: t('deployment.retention.tick.executed'), value: String(ticked.jobs.length) },
              { term: t('deployment.retention.tick.ledger'), value: String(ticked.ledger.length) },
            ]}
          />
        )}
        {purges?.health.health === 'degraded' ? (
          <Alert tone="warning">
            {message('workspace.retention.health.degraded', { failed: String(purges.health.failed_purges) })}
          </Alert>
        ) : null}
      </Panel>

      <PurgeJobsPanel
        view={purges}
        title={t('deployment.retention.purge.title')}
        empty={t('deployment.retention.purge.empty')}
      />
    </Panel>
  );
}
