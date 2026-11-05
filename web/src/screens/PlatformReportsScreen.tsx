import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type NlqProvenanceView,
  type NlqResultView,
  type ReportAuthorizationView,
  type ReportListViewEntry,
  type ReportRetrievalResponse,
  type ReportView,
  type WorkspaceRoleValue,
} from '../api.js';
import { apiFailureText, formatInstant, roleLabel } from '../format.js';
import { optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import { WorkspaceReportTemplates } from './PlatformReportTemplateScreen.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

export interface WorkspaceReportsProps extends WorkspaceViewProps {
  role: WorkspaceRoleValue;
}

function statusLabel(withdrawnAt: string | null, fresh: boolean): string {
  if (withdrawnAt !== null) return t('workspace.reports.status.withdrawn');
  return fresh ? t('workspace.reports.status.fresh') : t('workspace.reports.status.stale');
}

function completionStatusLabel(status: string): string {
  return optional(`value.reportStatus.${status}`) ?? status;
}

function outcomeLabel(outcome: string): string {
  return optional(`value.reportOutcome.${outcome}`) ?? outcome;
}

/** One governed scalar exactly as the engine preserved it; a missing value stays absent. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return t('workspace.reports.result.nullValue');
  if (Array.isArray(value)) return value.map(String).join('、');
  return String(value);
}

function joinOrNone(values: string[]): string {
  return values.length === 0 ? '—' : values.join('、');
}

/** The deterministic structured result exactly as the Report preserved it. */
function ReportResult({ result }: { result: NlqResultView }) {
  if (result.kind === 'aggregate') {
    const dimensions = result.grouped_by ?? [];
    const metrics = result.metrics ?? [];
    const groups = result.groups ?? [];
    const totals = result.totals ?? null;
    if (groups.length === 0 && totals === null) {
      return <p className="empty">{t('workspace.reports.result.empty')}</p>;
    }
    return (
      <>
        {dimensions.length > 0 && groups.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                {dimensions.map((name) => <th key={name} scope="col">{name}</th>)}
                {metrics.map((metric) => <th key={metric.name} scope="col">{metric.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map((group, index) => (
                <tr key={String(index)}>
                  {dimensions.map((name) => <td key={name}>{cellText(group.group[name])}</td>)}
                  {metrics.map((metric) => <td key={metric.name}>{cellText(group.metrics[metric.name])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="context__meta">
          <span>{t('workspace.reports.result.groups')} <strong>{result.groups_total ?? groups.length}</strong></span>
          <span>{t('workspace.reports.result.returned')} <strong>{result.returned ?? groups.length}</strong></span>
        </p>
        {totals === null ? null : (
          <table className="data-table">
            <caption className="panel__description">{t('workspace.reports.result.total')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('workspace.reports.result.metric')}</th>
                <th scope="col">{t('workspace.reports.result.value')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.name}>
                  <td>{metric.name}</td>
                  <td>{cellText(totals.metrics[metric.name])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }
  if (result.kind === 'suggest') {
    const suggestions = result.suggestions ?? [];
    return suggestions.length === 0 ? (
      <p className="empty">{t('workspace.reports.result.empty')}</p>
    ) : (
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.reports.result.value')}</th>
            <th scope="col">{t('workspace.reports.result.count')}</th>
          </tr>
        </thead>
        <tbody>
          {suggestions.map((suggestion) => (
            <tr key={suggestion.value}>
              <td>{suggestion.value}</td>
              <td>{suggestion.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const columns = result.columns ?? [];
  const records = result.records ?? [];
  if (records.length === 0) return <p className="empty">{t('workspace.reports.result.empty')}</p>;
  return (
    <table className="data-table">
      <thead>
        <tr>{columns.map((name) => <th key={name} scope="col">{name}</th>)}</tr>
      </thead>
      <tbody>
        {records.map((record, index) => (
          <tr key={String(index)}>
            {columns.map((name) => <td key={name}>{cellText(record[name])}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The exact Template and Data Product Releases the Report pinned. */
function References({ report }: { report: ReportView }) {
  const contract = report.data_product.contract_version;
  return (
    <>
      <Panel level={2} title={t('workspace.reports.template.title')}>
        <DefinitionList
          rows={[
            { term: t('workspace.reports.template.name'), value: report.template.name },
            { term: t('workspace.reports.template.version'), value: String(report.template.version) },
            { term: t('workspace.reports.template.contentHash'), value: report.template.content_hash, mono: true },
            { term: t('workspace.reports.template.owner'), value: report.template.owner_user_id, mono: true },
          ]}
        />
      </Panel>
      <Panel level={2} title={t('workspace.reports.release.title')}>
        <DefinitionList
          rows={[
            { term: t('workspace.reports.release.product'), value: report.data_product.name },
            { term: t('workspace.reports.release.productVersion'), value: String(report.data_product.data_product_version) },
            { term: t('workspace.reports.release.productRelease'), value: String(report.data_product.data_product_release) },
            { term: t('workspace.reports.release.datasetRelease'), value: String(report.data_product.dataset_release) },
            { term: t('workspace.reports.release.contract'), value: `${contract.major}.${contract.minor}` },
            { term: t('workspace.reports.release.contractHash'), value: report.data_product.contract_hash, mono: true },
            {
              term: t('workspace.reports.release.releasedAt'),
              value: formatInstant(report.freshness === null || report.freshness.released_at === null
                ? undefined
                : report.freshness.released_at),
            },
            { term: t('workspace.reports.release.dataThrough'), value: report.freshness?.data_through ?? '—' },
            { term: t('workspace.reports.facts.generatedAt'), value: formatInstant(report.generated_at) },
            { term: t('workspace.reports.facts.generatedBy'), value: report.generated_by, mono: true },
          ]}
        />
      </Panel>
    </>
  );
}

/** The permitted lineage and the normalized query, collapsed until asked for. */
function ReportProvenance({ report }: { report: ReportView }) {
  const provenance: NlqProvenanceView | null = report.provenance;
  const documented = provenance === null ? [] : (provenance as unknown as Record<string, unknown>)['metrics'];
  const metrics: Array<Record<string, unknown>> = Array.isArray(documented)
    ? documented.filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  return (
    <Panel
      level={2}
      title={t('workspace.reports.provenance.title')}
      description={t('workspace.reports.provenance.description')}
    >
      <details className="nlq-provenance">
        <summary className="nlq-provenance__summary">{t('workspace.reports.provenance.expand')}</summary>
        <h3 className="panel__title">{t('workspace.reports.provenance.query')}</h3>
        <pre className="nlq-provenance__query">{JSON.stringify(report.query, null, 2)}</pre>
        {provenance === null ? null : (
          <DefinitionList
            rows={[
              {
                term: t('workspace.reports.provenance.source'),
                value: provenance.source.name ?? provenance.source.source_id,
              },
              { term: t('workspace.reports.release.datasetRelease'), value: String(provenance.dataset_release) },
              {
                term: t('workspace.reports.provenance.configuration'),
                value: String(provenance.integration_configuration_version),
              },
              {
                term: t('workspace.reports.provenance.recordCount'),
                value: provenance.record_count === null ? '—' : String(provenance.record_count),
              },
              { term: t('workspace.reports.provenance.acquiredAt'), value: formatInstant(provenance.acquired_at) },
              { term: t('workspace.reports.provenance.integratedAt'), value: formatInstant(provenance.integrated_at) },
              { term: t('workspace.reports.provenance.releasedAt'), value: formatInstant(provenance.released_at) },
            ]}
          />
        )}
        {metrics.length === 0 ? null : (
          <>
            <h3 className="panel__title">{t('workspace.reports.provenance.metrics')}</h3>
            <DefinitionList
              rows={metrics.map((metric) => ({
                term: String(metric['name'] ?? ''),
                value: String(metric['description'] ?? metric['aggregation'] ?? ''),
              }))}
            />
          </>
        )}
      </details>
    </Panel>
  );
}

/** The complete current authorization the retrieval was answered under. */
function ReportAuthorization({ authorization }: { authorization: ReportAuthorizationView }) {
  return (
    <Panel level={2} title={t('workspace.reports.authorization.title')}>
      <DefinitionList
        rows={[
          { term: t('workspace.reports.authorization.role'), value: roleLabel(authorization.role) },
          ...authorization.parts.flatMap((part) => [
            {
              term: `${t('workspace.reports.authorization.restricted')} · ${part.data_product_id}`,
              value: part.restricted ? t('workspace.reports.value.yes') : t('workspace.reports.value.no'),
            },
            { term: t('workspace.reports.authorization.columns'), value: joinOrNone(part.columns) },
            { term: t('workspace.reports.authorization.rowFilters'), value: String(part.row_filter_count) },
            { term: t('workspace.reports.authorization.fingerprint'), value: part.scope_fingerprint, mono: true },
          ]),
        ]}
      />
    </Panel>
  );
}

/**
 * One immutable Report, rendered exactly as the server preserved it. The screen
 * never derives, recomputes, or widens anything: every number, Release,
 * Provenance fact, freshness, completion status, and authorization comes from
 * the retrieval response, and reading never regenerates content.
 */
function ReportDetail({ retrieval }: { retrieval: ReportRetrievalResponse }) {
  const report = retrieval.report;
  const freshness = report.freshness;
  const completion = report.completion;
  return (
    <Panel level={2} title={t('workspace.reports.detail.title')}>
      <p className="field__hint">
        {retrieval.origin === 'stock'
          ? t('workspace.reports.origin.stock')
          : t('workspace.reports.origin.generated')}
      </p>
      <p className="context__body">{retrieval.summary}</p>
      <p className="context__meta">
        <span>{statusLabel(report.withdrawn_at, retrieval.stock.fresh)}</span>
        <span>
          {t('workspace.reports.facts.age')}
          {' '}
          {retrieval.stock.age_minutes}
        </span>
        <span>
          {t('workspace.reports.facts.freshnessPolicy')}
          {' '}
          {retrieval.stock.max_age_minutes}
        </span>
      </p>
      <DefinitionList
        rows={[
          { term: t('workspace.reports.facts.question'), value: report.question },
          { term: t('workspace.reports.facts.normalizedQuestion'), value: report.normalized_question },
          { term: t('workspace.reports.facts.interpretation'), value: report.interpretation },
          {
            term: t('workspace.reports.facts.parameters'),
            value: (
              <pre className="report-templates__document">{JSON.stringify(report.parameters, null, 2)}</pre>
            ),
          },
          { term: t('workspace.reports.facts.generatedAt'), value: formatInstant(report.generated_at) },
        ]}
      />
      <h3 className="panel__title">{t('workspace.reports.result.title')}</h3>
      <ReportResult result={report.result} />
      <h3 className="panel__title">{t('workspace.reports.narrative.title')}</h3>
      {report.narrative === null ? (
        <p className="empty">{t('workspace.reports.narrative.absent')}</p>
      ) : (
        <p className="context__body">{report.narrative.narrative}</p>
      )}
      <Panel level={2} title={t('workspace.reports.completion.title')}>
        <DefinitionList
          rows={[
            { term: t('workspace.reports.completion.status'), value: completionStatusLabel(completion.status) },
            { term: t('workspace.reports.completion.outcome'), value: outcomeLabel(completion.outcome) },
            {
              term: t('workspace.reports.completion.partial'),
              value: completion.partial_period ? t('workspace.reports.value.yes') : t('workspace.reports.value.no'),
            },
            {
              term: t('workspace.reports.completion.truncated'),
              value: completion.truncated ? t('workspace.reports.value.yes') : t('workspace.reports.value.no'),
            },
          ]}
        />
        {completion.limitations.length === 0 ? null : (
          <>
            <h3 className="panel__title">{t('workspace.reports.completion.limitations')}</h3>
            <ul className="nlq-limitations">
              {completion.limitations.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </>
        )}
      </Panel>
      <References report={report} />
      <ReportProvenance report={report} />
      <ReportAuthorization authorization={retrieval.authorization} />
      {freshness === null ? null : (
        <p className="context__meta">
          <span>{t('workspace.reports.release.dataThrough')}：{freshness.data_through ?? '—'}</span>
        </p>
      )}
    </Panel>
  );
}

/**
 * The authorized Report library. Listing and reading come from the server's
 * current authorization; the screen only renders what an authenticated read
 * returned and offers no path that would regenerate content.
 */
export function WorkspaceReports({ workspaceId, role, onSessionLost }: WorkspaceReportsProps) {
  const [reports, setReports] = useState<ReportListViewEntry[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [retrieval, setRetrieval] = useState<ReportRetrievalResponse | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<'list' | 'detail' | null>(null);

  useEffect(() => {
    let active = true;
    setBusy('list');
    setListFailed(false);
    void platformApi.reports(workspaceId).then((result) => {
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
      setReports(result.data.reports);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, reload, onSessionLost]);

  useEffect(() => {
    if (selectedId === '') return undefined;
    let active = true;
    setBusy('detail');
    setNotice(null);
    void platformApi.report(selectedId, workspaceId).then((result) => {
      if (!active) return;
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setRetrieval(null);
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setRetrieval(result.data);
    });
    return () => {
      active = false;
    };
  }, [selectedId, workspaceId, onSessionLost, reload]);

  const refresh = useCallback((): void => {
    setReports(null);
    setRetrieval(null);
    setSelectedId('');
    setNotice(null);
    setReload((value) => value + 1);
  }, []);

  const reloadDetail = useCallback((): void => {
    setReload((value) => value + 1);
  }, []);

  return (
    <Panel
      level={1}
      title={t('workspace.reports.title')}
      description={t('workspace.reports.description')}
    >
      {role === 'Workspace Administrator' ? (
        <WorkspaceReportTemplates
          workspaceId={workspaceId}
          onSessionLost={onSessionLost}
          onGenerated={refresh}
        />
      ) : null}

      <Panel
        level={2}
        title={t('workspace.reports.listTitle')}
        description={t('workspace.reports.list.description')}
      >
        <div className="form__actions">
          <Button busy={busy === 'list'} onClick={refresh}>
            {busy === 'list' ? t('workspace.reports.refreshing') : t('workspace.reports.refresh')}
          </Button>
        </div>
        {listFailed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
        {reports === null ? (
          <p className="empty" role="status">{t('app.checkingSession')}</p>
        ) : reports.length === 0 ? (
          <>
            <p className="empty">{t('workspace.reports.empty')}</p>
            <p className="field__hint">{t('workspace.reports.emptyHint')}</p>
          </>
        ) : (
          <ul className="report-library">
            {reports.map((entry) => (
              <li className="report-library__item" key={entry.report_id}>
                <div>
                  <p className="report-library__question">{entry.question}</p>
                  <p className="context__meta">
                    <span>{statusLabel(entry.withdrawn_at, entry.fresh)}</span>
                    <span>
                      {t('workspace.reports.template.version')}
                      {' '}
                      {entry.template.version}
                    </span>
                    <span>{formatInstant(entry.generated_at)}</span>
                    <span>
                      {t('workspace.reports.facts.freshnessPolicy')}
                      {' '}
                      {entry.max_age_minutes}
                    </span>
                  </p>
                </div>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setSelectedId(entry.report_id);
                  }}
                >
                  {t('workspace.reports.view')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {notice === null ? null : (
          <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
            {notice.text}
          </Alert>
        )}
        {retrieval === null ? null : (
          <>
            <div className="form__actions">
              <Button busy={busy === 'detail'} onClick={reloadDetail}>
                {busy === 'detail' ? t('workspace.reports.detail.reloading') : t('workspace.reports.detail.reload')}
              </Button>
            </div>
            <ReportDetail retrieval={retrieval} />
          </>
        )}
      </Panel>
    </Panel>
  );
}
