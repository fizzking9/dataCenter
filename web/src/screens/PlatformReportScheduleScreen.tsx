import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ReportScheduleTickResponse,
  type ReportScheduleView,
  type ReportTemplateSummaryView,
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

interface Draft {
  templateId: string;
  consumer: string;
  interval: string;
  startAt: string;
}

const EMPTY_DRAFT: Draft = { templateId: '', consumer: '', interval: '', startAt: '' };

function scheduleStateLabel(state: string): string {
  if (state === 'paused') return t('workspace.reportSchedules.state.paused');
  if (state === 'withdrawn') return t('workspace.reportSchedules.state.withdrawn');
  return t('workspace.reportSchedules.state.active');
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'reused') return t('workspace.reportSchedules.runOutcome.reused');
  if (outcome === 'failed') return t('workspace.reportSchedules.runOutcome.failed');
  return t('workspace.reportSchedules.runOutcome.generated');
}

/**
 * The Workspace Administrator's Report schedule surface. The form names one
 * published Template, a designated Consumer, and an interval; every governed
 * decision (Consumer status, membership, Grants, coalescing, catch-up, stock
 * reuse) stays in the schedule engine, which only an explicit tick evaluates.
 */
export function WorkspaceReportSchedules({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [templates, setTemplates] = useState<ReportTemplateSummaryView[] | null>(null);
  const [schedules, setSchedules] = useState<ReportScheduleView[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [ticked, setTicked] = useState<ReportScheduleTickResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
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
    void platformApi.reportSchedules(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setSchedules(result.data.schedules);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, reload, onSessionLost]);

  const create = useCallback(async (): Promise<void> => {
    if (busy !== null) return;
    setBusy('create');
    setNotice(null);
    const result = await platformApi.createReportSchedule(workspaceId, {
      report_template_id: draft.templateId,
      consumer_username: draft.consumer,
      interval_minutes: Number(draft.interval),
      start_at: draft.startAt,
    });
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setDraft(EMPTY_DRAFT);
    setNotice({ tone: 'info', text: result.data.summary });
    setReload((value) => value + 1);
  }, [busy, draft, workspaceId, onSessionLost]);

  const lifecycle = useCallback(async (
    scheduleId: string,
    action: 'pause' | 'resume',
  ): Promise<void> => {
    if (busy !== null) return;
    setBusy(`${action}:${scheduleId}`);
    setNotice(null);
    const result = action === 'pause'
      ? await platformApi.pauseReportSchedule(scheduleId)
      : await platformApi.resumeReportSchedule(scheduleId);
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
    setReload((value) => value + 1);
  }, [busy, onSessionLost]);

  const tick = useCallback(async (): Promise<void> => {
    if (busy !== null) return;
    setBusy('tick');
    setNotice(null);
    const result = await platformApi.tickReportSchedules(workspaceId);
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setTicked(result.data);
    setNotice({ tone: 'info', text: result.data.summary });
    setReload((value) => value + 1);
  }, [busy, workspaceId, onSessionLost]);

  const templateName = (schedule: ReportScheduleView): string => {
    const template = (templates ?? []).find(
      (entry) => entry.report_template_id === schedule.report_template_id,
    );
    return template === undefined ? t('workspace.reportSchedules.templateUnavailable') : template.name;
  };

  return (
    <Panel
      level={2}
      title={t('workspace.reportSchedules.title')}
      description={t('workspace.reportSchedules.description')}
    >
      <div className="field">
        <label className="field__label" htmlFor="report-schedule-template">
          {t('workspace.reportSchedules.formTemplate')}
        </label>
        <select
          className="field__input"
          id="report-schedule-template"
          value={draft.templateId}
          onChange={(event) => setDraft((current) => ({ ...current, templateId: event.target.value }))}
        >
          <option value="">—</option>
          {(templates ?? [])
            .filter((template) => template.published_version !== null && (template.withdrawn_at ?? null) === null)
            .map((template) => (
              <option key={template.report_template_id} value={template.report_template_id}>
                {template.name}
              </option>
            ))}
        </select>
      </div>
      <Field
        id="report-schedule-consumer"
        label={t('workspace.reportSchedules.formConsumer')}
        value={draft.consumer}
        onChange={(value) => setDraft((current) => ({ ...current, consumer: value }))}
      />
      <Field
        id="report-schedule-interval"
        label={t('workspace.reportSchedules.formInterval')}
        value={draft.interval}
        onChange={(value) => setDraft((current) => ({ ...current, interval: value }))}
        inputMode="numeric"
      />
      <Field
        id="report-schedule-start"
        label={t('workspace.reportSchedules.formStartAt')}
        value={draft.startAt}
        onChange={(value) => setDraft((current) => ({ ...current, startAt: value }))}
        mono
      />
      <div className="form__actions">
        <Button busy={busy === 'create'} onClick={() => void create()}>
          {busy === 'create'
            ? t('workspace.reportSchedules.creating')
            : t('workspace.reportSchedules.create')}
        </Button>
        <Button variant="secondary" busy={busy === 'tick'} onClick={() => void tick()}>
          {busy === 'tick'
            ? t('workspace.reportSchedules.ticking')
            : t('workspace.reportSchedules.tick')}
        </Button>
      </div>
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}

      <h3 className="panel__title">{t('workspace.reportSchedules.listTitle')}</h3>
      {schedules === null ? (
        <p className="empty" role="status">{t('app.checkingSession')}</p>
      ) : schedules.length === 0 ? (
        <>
          <p className="empty">{t('workspace.reportSchedules.empty')}</p>
          <p className="field__hint">{t('workspace.reportSchedules.emptyHint')}</p>
        </>
      ) : (
        <ul className="report-schedules">
          {schedules.map((schedule) => (
            <li className="report-schedules__item" key={schedule.schedule_id}>
              <div className="report-schedules__head">
                <div>
                  <p className="report-templates__name">
                    {templateName(schedule)}
                    {' '}
                    {t('workspace.reportSchedules.template')}
                  </p>
                  <p className="context__meta">
                    <span>{scheduleStateLabel(schedule.state)}</span>
                    <span>
                      {t('workspace.reportSchedules.designated')}
                      {' '}
                      {schedule.designated_username ?? schedule.designated_user_id}
                    </span>
                    <span>
                      {t('workspace.reportSchedules.interval')}
                      {' '}
                      {message('workspace.reportSchedules.minutes', {
                        minutes: String(schedule.interval_minutes),
                      })}
                    </span>
                    <span>
                      {t('workspace.reportSchedules.nextDue')}
                      {' '}
                      {formatInstant(schedule.next_due_at)}
                    </span>
                    <span>
                      {t('workspace.reportWithdrawal.templateVersion')}
                      {' '}
                      {schedule.template_version}
                    </span>
                  </p>
                </div>
                <div className="form__actions">
                  {schedule.state === 'active' ? (
                    <Button
                      variant="secondary"
                      busy={busy === `pause:${schedule.schedule_id}`}
                      onClick={() => void lifecycle(schedule.schedule_id, 'pause')}
                    >
                      {busy === `pause:${schedule.schedule_id}`
                        ? t('workspace.reportSchedules.pausing')
                        : t('workspace.reportSchedules.pause')}
                    </Button>
                  ) : schedule.state === 'paused' ? (
                    <Button
                      busy={busy === `resume:${schedule.schedule_id}`}
                      onClick={() => void lifecycle(schedule.schedule_id, 'resume')}
                    >
                      {busy === `resume:${schedule.schedule_id}`
                        ? t('workspace.reportSchedules.resuming')
                        : t('workspace.reportSchedules.resume')}
                    </Button>
                  ) : null}
                </div>
              </div>
              {schedule.paused_at === null ? null : (
                <p className="context__meta">
                  <span>
                    {t('workspace.reportSchedules.state.paused')}
                    {' '}
                    {formatInstant(schedule.paused_at)}
                  </span>
                </p>
              )}
              <h3 className="panel__title">{t('workspace.reportSchedules.runsTitle')}</h3>
              {schedule.runs.length === 0 ? (
                <p className="empty">{t('workspace.reportSchedules.runsEmpty')}</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('workspace.reportSchedules.runTriggeredAt')}</th>
                      <th scope="col">{t('workspace.reportSchedules.runOutcome.generated')}</th>
                      <th scope="col">{t('workspace.reportSchedules.runDueCount')}</th>
                      <th scope="col">{t('workspace.reportSchedules.runCatchUp')}</th>
                      <th scope="col">{t('workspace.reportSchedules.runReport')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.runs.map((run) => (
                      <tr key={run.run_id}>
                        <td>{formatInstant(run.triggered_at)}</td>
                        <td>{outcomeLabel(run.outcome)}</td>
                        <td>{run.due_count}</td>
                        <td>
                          {run.catch_up
                            ? t('workspace.reports.value.yes')
                            : t('workspace.reports.value.no')}
                        </td>
                        <td>
                          {run.report_id ?? run.limitation ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}
      {ticked === null ? null : (
        <Panel level={2} title={t('workspace.reportSchedules.tickTitle')}>
          <p className="context__body">{ticked.summary}</p>
          <DefinitionList
            rows={[
              { term: t('workspace.reportSchedules.runTriggeredAt'), value: formatInstant(ticked.at) },
              { term: t('workspace.reportSchedules.runsTitle'), value: String(ticked.runs.length) },
            ]}
          />
          {ticked.runs.length === 0 ? (
            <p className="empty">{t('workspace.reportSchedules.runsEmpty')}</p>
          ) : (
            <ul className="nlq-limitations">
              {ticked.runs.map((run) => (
                <li key={run.run_id}>
                  {outcomeLabel(run.outcome)}
                  {' · '}
                  {t('workspace.reportSchedules.runDueCount')}
                  {' '}
                  {run.due_count}
                  {run.catch_up ? ` · ${t('workspace.reportSchedules.runCatchUp')}` : ''}
                  {run.report_id === null ? '' : ` · ${run.report_id}`}
                  {run.limitation === null ? '' : ` · ${run.limitation}`}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </Panel>
  );
}
