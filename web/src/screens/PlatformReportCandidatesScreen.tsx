import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ReportCandidateEvidenceResponse,
  type ReportCandidateView,
  type ReportView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

export interface WorkspaceReportCandidatesProps extends WorkspaceViewProps {
  /** A decision changes governed stock the Reports library lists. */
  onDecided: () => void;
}

function statusLabel(status: string): string {
  if (status === 'approved') return t('workspace.reportCandidates.status.approved');
  if (status === 'rejected') return t('workspace.reportCandidates.status.rejected');
  return t('workspace.reportCandidates.status.open');
}

function nominationKindLabel(kind: string): string {
  return kind === 'report_template'
    ? t('workspace.reportCandidates.similarityTemplate')
    : t('workspace.reportCandidates.similarityCandidate');
}

/** The governed grand totals one reviewed Report preserved, exactly as stored. */
function totalsText(report: ReportView): string {
  const totals = report.result.totals;
  if (totals === null || totals === undefined) return '—';
  const metrics = totals.metrics ?? {};
  const entries = Object.entries(metrics).map(([name, value]) => `${name}：${String(value)}`);
  return entries.length === 0 ? '—' : entries.join('、');
}

/**
 * The exact reviewed content one candidate names. The screen renders the pinned
 * Template Version and the immutable Report the server preserved, so Approval
 * cannot silently publish anything the reviewer did not see.
 */
function CandidateEvidence({ evidence }: { evidence: ReportCandidateEvidenceResponse }) {
  const { candidate, template, report } = evidence;
  return (
    <Panel level={2} title={t('workspace.reportCandidates.evidenceTitle')}>
      <p className="context__body">{evidence.summary}</p>
      <DefinitionList
        rows={[
          { term: t('workspace.reportCandidates.evidenceReport'), value: report.report_id, mono: true },
          { term: t('workspace.reportCandidates.evidenceTemplateVersion'), value: String(template.template_version) },
          {
            term: t('workspace.reportCandidates.evidenceTemplateHash'),
            value: template.content_hash,
            mono: true,
          },
          { term: t('workspace.reports.facts.question'), value: template.question },
          { term: t('workspace.reports.facts.normalizedQuestion'), value: template.normalized_question },
          { term: t('workspace.reportTemplates.groundedPrompt'), value: template.grounded_prompt.body },
          { term: t('workspace.reportCandidates.evidenceResult'), value: totalsText(report) },
          {
            term: t('workspace.reportCandidates.evidenceTemplateState'),
            value: template.withdrawn_at === null
              ? t('workspace.reportCandidates.state.available')
              : message('workspace.reportCandidates.evidenceWithdrawnAt', {
                at: formatInstant(template.withdrawn_at),
              }),
          },
          {
            term: t('workspace.reportCandidates.evidenceReportState'),
            value: report.withdrawn_at === null
              ? t('workspace.reportCandidates.state.available')
              : message('workspace.reportCandidates.evidenceWithdrawnAt', {
                at: formatInstant(report.withdrawn_at),
              }),
          },
          { term: t('workspace.reports.facts.generatedAt'), value: formatInstant(report.generated_at) },
          { term: t('workspace.reportCandidates.occurrences'), value: String(candidate.occurrences) },
        ]}
      />
      <h3 className="panel__title">{t('workspace.reportCandidates.evidenceNarrative')}</h3>
      {report.narrative === null ? (
        <p className="empty">{t('workspace.reportCandidates.evidenceNarrativeAbsent')}</p>
      ) : (
        <p className="context__body">{report.narrative.narrative}</p>
      )}
    </Panel>
  );
}

/**
 * The Workspace Administrator's deduplicated review surface. Listing, evidence,
 * Approval, rejection, and reopening all come from the governed engine; the
 * screen never merges items, infers equivalence from a similarity score, or
 * regenerates the reviewed content.
 */
export function WorkspaceReportCandidates({ workspaceId, onDecided, onSessionLost }: WorkspaceReportCandidatesProps) {
  const [candidates, setCandidates] = useState<ReportCandidateView[] | null>(null);
  const [summary, setSummary] = useState('');
  const [listFailed, setListFailed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [evidence, setEvidence] = useState<ReportCandidateEvidenceResponse | null>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setListFailed(false);
    setBusy('list');
    void platformApi.reportCandidates(workspaceId).then((result) => {
      if (!active) return;
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setListFailed(true);
        return;
      }
      setCandidates(result.data.candidates);
      setSummary(result.data.summary);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, reload, onSessionLost]);

  useEffect(() => {
    if (selectedId === '') return undefined;
    let active = true;
    setBusy('evidence');
    void platformApi.reportCandidate(selectedId).then((result) => {
      if (!active) return;
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setEvidence(null);
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setEvidence(result.data);
    });
    return () => {
      active = false;
    };
  }, [selectedId, reload, onSessionLost]);

  const refresh = useCallback((): void => {
    setCandidates(null);
    setEvidence(null);
    setSelectedId('');
    setNotice(null);
    setReload((value) => value + 1);
  }, []);

  const decide = useCallback(async (
    candidateId: string,
    action: 'approve' | 'reject' | 'reopen',
  ): Promise<void> => {
    if (busy !== null) return;
    setBusy(action);
    setNotice(null);
    const result = action === 'approve'
      ? await platformApi.approveReportCandidate(candidateId)
      : action === 'reject'
        ? await platformApi.rejectReportCandidate(candidateId, reason)
        : await platformApi.reopenReportCandidate(candidateId);
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setNotice({ tone: 'info', text: result.data.summary });
    if (action === 'reject') setReason('');
    if (action === 'approve') onDecided();
    setReload((value) => value + 1);
  }, [busy, reason, onDecided, onSessionLost]);

  return (
    <Panel
      level={2}
      title={t('workspace.reportCandidates.title')}
      description={t('workspace.reportCandidates.description')}
    >
      <p className="field__hint">{t('workspace.reportCandidates.approvalHint')}</p>
      <div className="form__actions">
        <Button busy={busy === 'list'} onClick={refresh}>
          {busy === 'list' ? t('workspace.reportGovernance.refreshing') : t('workspace.reportGovernance.refresh')}
        </Button>
      </div>
      {listFailed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {summary === '' ? null : <p className="context__body">{summary}</p>}
      {candidates === null ? (
        <p className="empty" role="status">{t('app.checkingSession')}</p>
      ) : candidates.length === 0 ? (
        <>
          <p className="empty">{t('workspace.reportCandidates.empty')}</p>
          <p className="field__hint">{t('workspace.reportCandidates.emptyHint')}</p>
        </>
      ) : (
        <ul className="report-candidates">
          {candidates.map((candidate) => {
            const similarity = candidate.similarity;
            return (
              <li className="report-candidates__item" key={candidate.candidate_id}>
                <div className="report-candidates__head">
                  <div>
                    <p className="report-library__question">{candidate.question}</p>
                    <p className="context__meta">
                      <span>{statusLabel(candidate.status)}</span>
                      <span>
                        {t('workspace.reportCandidates.occurrences')}
                        {' '}
                        {candidate.occurrences}
                      </span>
                      <span>
                        {t('workspace.reportCandidates.firstSeen')}
                        {' '}
                        {formatInstant(candidate.first_seen_at)}
                      </span>
                      <span>
                        {t('workspace.reportCandidates.lastSeen')}
                        {' '}
                        {formatInstant(candidate.last_seen_at)}
                      </span>
                      <span>
                        {t('workspace.reportCandidates.requestedBy')}
                        {' '}
                        {candidate.requested_by
                          .map((entry) => entry.username ?? entry.user_id)
                          .join('、')}
                      </span>
                    </p>
                    <p className="context__meta">
                      <span>
                        {t('workspace.reportCandidates.notification')}
                        {' '}
                        {candidate.notification === null
                          ? '—'
                          : formatInstant(candidate.notification.notified_at)}
                      </span>
                      <span>
                        {candidate.notification === null
                          ? ''
                          : candidate.notification.reason === 'reopened'
                            ? t('workspace.reportCandidates.notificationReopened')
                            : t('workspace.reportCandidates.notificationCreated')}
                      </span>
                      {candidate.occurrences > 1
                        ? <span>{t('workspace.reportCandidates.notificationSuppressed')}</span>
                        : null}
                    </p>
                  </div>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setSelectedId(candidate.candidate_id);
                    }}
                  >
                    {t('workspace.reportCandidates.evidence')}
                  </Button>
                </div>
                <section className="report-candidates__similarity" aria-label={t('workspace.reportCandidates.similarityTitle')}>
                  <h3 className="panel__title">{t('workspace.reportCandidates.similarityTitle')}</h3>
                  <p className="field__hint">{t('workspace.reportCandidates.similarityDescription')}</p>
                  <p className="context__meta">
                    <span>
                      {t('workspace.reportCandidates.similarityModel')}
                      {' '}
                      {similarity.configuration.model_id}
                    </span>
                    <span>
                      {t('workspace.reportCandidates.similarityThreshold')}
                      {' '}
                      {similarity.threshold}
                    </span>
                  </p>
                  {similarity.nominations.length === 0 ? (
                    <p className="empty">{t('workspace.reportCandidates.similarityEmpty')}</p>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">{t('workspace.reportCandidates.similarityTitle')}</th>
                          <th scope="col">{t('workspace.reports.facts.question')}</th>
                          <th scope="col">{t('workspace.reportCandidates.similarityThreshold')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {similarity.nominations.map((nomination) => (
                          <tr key={`${nomination.kind}:${nomination.target_id}`}>
                            <td>{nominationKindLabel(nomination.kind)}</td>
                            <td>{nomination.question}</td>
                            <td>{nomination.score.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
                <div className="form__actions">
                  <Button
                    busy={busy === 'approve'}
                    onClick={() => void decide(candidate.candidate_id, 'approve')}
                  >
                    {busy === 'approve'
                      ? t('workspace.reportCandidates.approving')
                      : t('workspace.reportCandidates.approve')}
                  </Button>
                  <Button
                    variant="secondary"
                    busy={busy === 'reject'}
                    onClick={() => void decide(candidate.candidate_id, 'reject')}
                  >
                    {busy === 'reject'
                      ? t('workspace.reportCandidates.rejecting')
                      : t('workspace.reportCandidates.reject')}
                  </Button>
                  <Button
                    variant="quiet"
                    busy={busy === 'reopen'}
                    onClick={() => void decide(candidate.candidate_id, 'reopen')}
                  >
                    {busy === 'reopen'
                      ? t('workspace.reportCandidates.reopening')
                      : t('workspace.reportCandidates.reopen')}
                  </Button>
                </div>
                {candidate.approval === null ? null : (
                  <p className="context__meta">
                    <span>
                      {t('workspace.reportCandidates.status.approved')}
                      {' '}
                      {formatInstant(candidate.approval.decided_at)}
                    </span>
                  </p>
                )}
                {candidate.rejection === null ? null : (
                  <p className="context__meta">
                    <span>
                      {t('workspace.reportCandidates.status.rejected')}
                      {' '}
                      {formatInstant(candidate.rejection.decided_at)}
                    </span>
                    <span>{candidate.rejection.reason ?? ''}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Field
        id="report-candidate-reason"
        label={t('workspace.reportCandidates.reason')}
        hint={t('workspace.reportCandidates.reasonHint')}
        value={reason}
        onChange={setReason}
      />
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {evidence === null || busy === 'evidence' ? null : <CandidateEvidence evidence={evidence} />}
    </Panel>
  );
}
