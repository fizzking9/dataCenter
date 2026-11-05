import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ReportListViewEntry,
  type ReportTemplateSummaryView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Alert, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';
import { WorkspaceReportCandidates } from './PlatformReportCandidatesScreen.js';
import { WorkspaceReportSchedules } from './PlatformReportScheduleScreen.js';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

interface WithdrawalProps extends WorkspaceViewProps {
  /** Approving a candidate publishes stock, so the withdrawal list refreshes. */
  revision: number;
  onWithdrawn: () => void;
}

/**
 * Withdrawal is a lifecycle fact, not a deletion: a Report leaves stock reuse
 * and ordinary retrieval, a Template Version stops matching and generating, and
 * the exact content, Provenance, and Approval history stay readable here.
 */
function WithdrawalPanel({ workspaceId, revision, onWithdrawn, onSessionLost }: WithdrawalProps) {
  const [reports, setReports] = useState<ReportListViewEntry[] | null>(null);
  const [templates, setTemplates] = useState<ReportTemplateSummaryView[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void platformApi.reports(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setReports(result.data.reports);
    });
    void platformApi.reportTemplates(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setTemplates(result.data.report_templates);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, revision, onSessionLost]);

  const withdraw = useCallback(async (
    target: { kind: 'report'; reportId: string } | { kind: 'template'; templateId: string; version: number },
  ): Promise<void> => {
    if (busy !== null) return;
    const key = target.kind === 'report' ? `report:${target.reportId}` : `template:${target.templateId}`;
    setBusy(key);
    setNotice(null);
    const result = target.kind === 'report'
      ? await platformApi.withdrawReport(target.reportId)
      : await platformApi.withdrawReportTemplate(target.templateId, target.version);
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
    onWithdrawn();
  }, [busy, onSessionLost, onWithdrawn]);

  return (
    <Panel
      level={2}
      title={t('workspace.reportWithdrawal.title')}
      description={t('workspace.reportWithdrawal.description')}
    >
      <h3 className="panel__title">{t('workspace.reportWithdrawal.reportsTitle')}</h3>
      {reports === null ? (
        <p className="empty" role="status">{t('app.checkingSession')}</p>
      ) : reports.length === 0 ? (
        <p className="empty">{t('workspace.reportWithdrawal.reportsEmpty')}</p>
      ) : (
        <ul className="report-library">
          {reports.map((report) => (
            <li className="report-library__item" key={report.report_id}>
              <div>
                <p className="report-library__question">{report.question}</p>
                <p className="context__meta">
                  <span>
                    {report.withdrawn_at === null
                      ? t('workspace.reportWithdrawal.active')
                      : t('workspace.reportWithdrawal.withdrawn')}
                  </span>
                  <span>{report.report_id}</span>
                  <span>{formatInstant(report.generated_at)}</span>
                </p>
              </div>
              {report.withdrawn_at === null ? (
                <Button
                  variant="secondary"
                  busy={busy === `report:${report.report_id}`}
                  onClick={() => void withdraw({ kind: 'report', reportId: report.report_id })}
                >
                  {busy === `report:${report.report_id}`
                    ? t('workspace.reportWithdrawal.withdrawingReport')
                    : t('workspace.reportWithdrawal.report')}
                </Button>
              ) : (
                <span className="context__meta">
                  {t('workspace.reportWithdrawal.withdrawn')}
                  {' '}
                  {formatInstant(report.withdrawn_at)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="panel__title">{t('workspace.reportWithdrawal.templatesTitle')}</h3>
      {templates === null ? (
        <p className="empty" role="status">{t('app.checkingSession')}</p>
      ) : templates.length === 0 ? (
        <p className="empty">{t('workspace.reportWithdrawal.templatesEmpty')}</p>
      ) : (
        <ul className="report-templates">
          {templates.map((template) => {
            const version = template.published_version;
            const withdrawnAt = template.withdrawn_at ?? null;
            return (
              <li className="report-templates__item" key={template.report_template_id}>
                <div className="report-templates__head">
                  <div>
                    <p className="report-templates__name">{template.name}</p>
                    <p className="context__meta">
                      <span>
                        {t('workspace.reportWithdrawal.templateVersion')}
                        {' '}
                        {version ?? '—'}
                      </span>
                      <span>
                        {withdrawnAt === null
                          ? t('workspace.reportWithdrawal.active')
                          : t('workspace.reportWithdrawal.withdrawn')}
                      </span>
                      {withdrawnAt === null ? null : <span>{formatInstant(withdrawnAt)}</span>}
                    </p>
                  </div>
                  {version !== null && withdrawnAt === null ? (
                    <Button
                      variant="secondary"
                      busy={busy === `template:${template.report_template_id}`}
                      onClick={() => void withdraw({
                        kind: 'template',
                        templateId: template.report_template_id,
                        version,
                      })}
                    >
                      {busy === `template:${template.report_template_id}`
                        ? t('workspace.reportWithdrawal.withdrawingTemplate')
                        : t('workspace.reportWithdrawal.template')}
                    </Button>
                  ) : null}
                </div>
                {template.question === undefined ? null : (
                  <p className="context__body">{template.question}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
    </Panel>
  );
}

/**
 * The administrator's Report governance page: deduplicated candidate review,
 * durable schedules, and withdrawal, all answered by the same governed modules
 * the CLI and APIs call. The browser states intent and renders the answer; it
 * holds no approval, authorization, similarity, or scheduling logic of its own.
 */
export function WorkspaceReportGovernance({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [revision, setRevision] = useState(0);

  const bump = useCallback((): void => {
    setRevision((value) => value + 1);
  }, []);

  return (
    <Panel
      level={1}
      title={t('workspace.reportGovernance.title')}
      description={t('workspace.reportGovernance.description')}
    >
      <WorkspaceReportCandidates
        workspaceId={workspaceId}
        onDecided={bump}
        onSessionLost={onSessionLost}
      />
      <WorkspaceReportSchedules workspaceId={workspaceId} onSessionLost={onSessionLost} />
      <WithdrawalPanel
        workspaceId={workspaceId}
        revision={revision}
        onWithdrawn={bump}
        onSessionLost={onSessionLost}
      />
    </Panel>
  );
}
