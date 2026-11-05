import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type DataProductSummary,
  type ProductComparedMetric,
  type ProductQueryAnswer,
  type ProductQueryGroup,
  type ProductQueryWindowView,
  type ProductReleaseView,
  type WorkspaceExportView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

type Mode = 'records' | 'documents' | 'aggregate';

interface FilterDraft {
  field: string;
  op: string;
  value: string;
}

interface MetricFilterDraft {
  metric: string;
  op: string;
  value: string;
}

interface PageState {
  /** The cursor each page was requested with; the first page needs none. */
  trail: Array<string | null>;
  index: number;
}

const FILTER_OPERATORS = [
  'equals', 'not_equals', 'less_than', 'less_or_equal',
  'greater_than', 'greater_or_equal', 'is_null', 'is_not_null',
] as const;
const NULL_TESTS = ['is_null', 'is_not_null'];

function emptyFilter(): FilterDraft {
  return { field: '', op: 'equals', value: '' };
}

function operatorLabel(op: string): string {
  return optional(`value.grantOp.${op}`) ?? op;
}

function aggregationLabel(aggregation: string): string {
  return optional(`value.aggregation.${aggregation}`) ?? aggregation;
}

function typeLabel(type: string | undefined): string {
  return optional(`value.fieldType.${type ?? ''}`) ?? type ?? '—';
}

/** One exact value as the governed answer states it; a missing value is shown as absent. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return t('workspace.explore.results.nullValue');
  if (Array.isArray(value)) return value.map(String).join('、');
  return String(value);
}

function join(values: string[]): string {
  return values.length === 0 ? t('workspace.explore.details.none') : values.join('、');
}

function releaseStatus(release: ProductReleaseView): string {
  if (release.withdrawn) return t('workspace.explore.releases.withdrawn');
  if (release.current) return t('workspace.explore.releases.current');
  if (release.retention_expired) return t('workspace.explore.releases.expired');
  return t('workspace.explore.releases.history');
}

function statusLabel(status: WorkspaceExportView['status']): string {
  return optional(`workspace.explore.exports.status.${status}`) ?? status;
}

function percentText(entry: ProductComparedMetric | undefined): string {
  if (entry === undefined) return '—';
  if (entry.change_percent !== null) return entry.change_percent;
  if (entry.change_percent_reason === 'zero_base') return t('workspace.explore.results.percentZeroBase');
  if (entry.change_percent_reason === 'value_missing') return t('workspace.explore.results.percentMissing');
  if (entry.change_percent_reason === 'not_numeric') return t('workspace.explore.results.percentNotNumeric');
  return t('workspace.explore.results.percentUnavailable');
}

function changeText(entry: ProductComparedMetric | undefined): string {
  if (entry === undefined || entry.change === null) return '—';
  return String(entry.change);
}

/** The window one answer evaluated, including the coverage the pinned Release holds. */
function WindowSummary({ label, window }: { label: string; window: ProductQueryWindowView }) {
  return (
    <DefinitionList
      rows={[
        { term: label, value: `${window.start} ~ ${window.end}` },
        { term: t('workspace.explore.releases.contract'), value: `${window.field} · ${typeLabel(window.precision)} · ${window.time_zone}` },
        {
          term: t('workspace.explore.window.coverage'),
          value: window.coverage === null ? '—' : `${window.coverage.start} ~ ${window.coverage.end}`,
        },
        {
          term: t('workspace.explore.releases.status'),
          value: window.partial ? t('workspace.explore.window.partial') : t('workspace.explore.window.complete'),
        },
        ...(window.same_elapsed_interval === undefined
          ? []
          : [{
            term: t('workspace.explore.window.sameElapsed'),
            value: window.same_elapsed_interval
              ? t('workspace.explore.provenance.yes')
              : t('workspace.explore.provenance.no'),
          }]),
      ]}
    />
  );
}

/**
 * The Consumer's Data Product exploration surface. Discovery, Contract
 * metadata, records, document search, aggregates, comparisons, Provenance,
 * freshness, and exports all come from governed server answers; this component
 * only states the request and renders the exact result it receives.
 */
export function WorkspaceExplore({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [products, setProducts] = useState<DataProductSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [releases, setReleases] = useState<ProductReleaseView[] | null>(null);
  const [selectedRelease, setSelectedRelease] = useState('');
  const [exports, setExports] = useState<WorkspaceExportView[] | null>(null);
  const [mode, setMode] = useState<Mode>('records');
  const [limit, setLimit] = useState('100');
  const [filters, setFilters] = useState<FilterDraft[]>([emptyFilter()]);
  const [recordStart, setRecordStart] = useState('');
  const [recordEnd, setRecordEnd] = useState('');
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [includeTotals, setIncludeTotals] = useState(true);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [comparisonStart, setComparisonStart] = useState('');
  const [comparisonEnd, setComparisonEnd] = useState('');
  const [metricFilters, setMetricFilters] = useState<MetricFilterDraft[]>([]);
  const [answer, setAnswer] = useState<ProductQueryAnswer | null>(null);
  /** The query the answer was read from, without any page cursor. */
  const [lastRequest, setLastRequest] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState<PageState>({ trail: [null], index: 0 });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selected = products?.find((product) => product.data_product_id === selectedId) ?? null;

  useEffect(() => {
    let active = true;
    setFailed(false);
    void platformApi.dataProducts(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setProducts(result.data.data_products);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost]);

  const loadExports = useCallback(async (dataProductId: string): Promise<void> => {
    const result = await platformApi.myExports(workspaceId, dataProductId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setExports(result.data.exports);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    if (selectedId === '') return undefined;
    let active = true;
    setReleases(null);
    setExports(null);
    setAnswer(null);
    setLastRequest(null);
    setPage({ trail: [null], index: 0 });
    setNotice(null);
    void platformApi.productReleases(selectedId, workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setReleases(result.data.releases);
    });
    void loadExports(selectedId);
    return () => {
      active = false;
    };
  }, [selectedId, workspaceId, onSessionLost, loadExports]);

  function browse(product: DataProductSummary): void {
    setSelectedId(product.data_product_id);
    setSelectedRelease('');
    setMode('records');
    setLimit(String(product.default_limit));
    setFilters([emptyFilter()]);
    setRecordStart('');
    setRecordEnd('');
    setQuery('');
    setGroupBy([]);
    setSelectedMetrics(product.metrics.map((metric) => metric.name));
    setSortBy('');
    setSortDirection('asc');
    setIncludeTotals(true);
    setWindowStart('');
    setWindowEnd('');
    setComparisonStart('');
    setComparisonEnd('');
    setMetricFilters([]);
  }

  function switchMode(next: Mode): void {
    setMode(next);
    setAnswer(null);
    setLastRequest(null);
    setPage({ trail: [null], index: 0 });
    setNotice(null);
  }

  function typedValue(field: string, raw: string): string | number {
    const type = selected?.field_types[field];
    if ((type === 'integer' || type === 'number') && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return raw;
  }

  function filterRequest(): Array<Record<string, unknown>> {
    return filters
      .filter((filter) => filter.field !== '')
      .map((filter) => (NULL_TESTS.includes(filter.op)
        ? { field: filter.field, op: filter.op }
        : { field: filter.field, op: filter.op, value: typedValue(filter.field, filter.value) }));
  }

  function metricFilterRequest(): Array<Record<string, unknown>> {
    return metricFilters
      .filter((filter) => filter.metric !== '')
      .map((filter) => {
        if (NULL_TESTS.includes(filter.op)) return { metric: filter.metric, op: filter.op };
        const parsed = filter.value.trim() === '' ? filter.value : Number(filter.value);
        return { metric: filter.metric, op: filter.op, value: Number.isFinite(parsed as number) ? parsed : filter.value };
      });
  }

  function pageLimit(): number {
    const parsed = Number(limit);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : (selected?.default_limit ?? 100);
  }

  function withRelease(request: Record<string, unknown>): Record<string, unknown> {
    if (selectedRelease === '') return request;
    return { ...request, release: Number(selectedRelease) };
  }

  function recordsRequest(): Record<string, unknown> {
    const request: Record<string, unknown> = { kind: 'records', limit: pageLimit() };
    const stated = filterRequest();
    if (stated.length > 0) request['filters'] = stated;
    if (recordStart !== '' || recordEnd !== '') request['window'] = { start: recordStart, end: recordEnd };
    return withRelease(request);
  }

  function documentsRequest(): Record<string, unknown> {
    return withRelease({ kind: 'search', q: query, limit: pageLimit() });
  }

  function aggregateRequest(): Record<string, unknown> {
    const request: Record<string, unknown> = { kind: 'aggregate', limit: pageLimit(), include_totals: includeTotals };
    if (groupBy.length > 0) request['group_by'] = groupBy;
    if (selectedMetrics.length > 0) request['metrics'] = selectedMetrics;
    const stated = filterRequest();
    if (stated.length > 0) request['filters'] = stated;
    const statedMetrics = metricFilterRequest();
    if (statedMetrics.length > 0) request['metric_filters'] = statedMetrics;
    if (groupBy.length > 0 && sortBy !== '') {
      request['sort'] = [{ by: sortBy, direction: sortDirection }];
    }
    if (windowStart !== '' || windowEnd !== '') request['window'] = { start: windowStart, end: windowEnd };
    if (comparisonStart !== '' || comparisonEnd !== '') {
      request['comparison'] = { start: comparisonStart, end: comparisonEnd };
    }
    return withRelease(request);
  }

  async function run(request: Record<string, unknown>, resetPaging: boolean): Promise<void> {
    setBusy('query');
    setNotice(null);
    const result = await platformApi.queryProduct(selectedId, workspaceId, request);
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setAnswer(result.data);
    setLastRequest(request);
    if (resetPaging) setPage({ trail: [null], index: 0 });
  }

  function queryRecords(): void {
    void run(recordsRequest(), true);
  }

  function queryDocuments(): void {
    void run(documentsRequest(), true);
  }

  function queryAggregate(): void {
    void run(aggregateRequest(), true);
  }

  function nextPage(): void {
    if (answer === null || lastRequest === null || answer.next_cursor === null) return;
    const cursor = answer.next_cursor;
    const base = lastRequest;
    const request = { ...base, cursor };
    setBusy('query');
    setNotice(null);
    void platformApi.queryProduct(selectedId, workspaceId, request).then((result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setAnswer(result.data);
      setLastRequest(base);
      setPage((current) => ({
        trail: [...current.trail.slice(0, current.index + 1), cursor],
        index: current.index + 1,
      }));
    });
  }

  function previousPage(): void {
    if (lastRequest === null || page.index === 0) return;
    const targetIndex = page.index - 1;
    const cursor = page.trail[targetIndex] ?? null;
    const base = lastRequest;
    const request = cursor === null ? base : { ...base, cursor };
    setBusy('query');
    setNotice(null);
    void platformApi.queryProduct(selectedId, workspaceId, request).then((result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setAnswer(result.data);
      setPage({ trail: page.trail, index: targetIndex });
    });
  }

  function createExport(): void {
    if (selectedId === '' || lastRequest === null || answer === null) return;
    if (answer.kind !== 'records' && answer.kind !== 'aggregate') return;
    setBusy('export');
    setNotice(null);
    void platformApi.createProductExport(selectedId, workspaceId, lastRequest).then(async (result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      await loadExports(selectedId);
      setNotice({
        tone: 'info',
        text: message('workspace.explore.exports.created', {
          export_id: result.data.export_id,
          rows: String(result.data.row_count),
        }),
      });
    });
  }

  function download(record: WorkspaceExportView): void {
    setBusy(`download-${record.export_id}`);
    setNotice(null);
    void platformApi.downloadWorkspaceExport(record.export_id).then((result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      const bytes = Uint8Array.from(atob(result.data.content), (character) => character.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `export-${result.data.export_id}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }

  function renderRecords(result: ProductQueryAnswer) {
    const columns = result.columns ?? [];
    const records = result.records ?? [];
    return (
      <Panel level={2} title={t('workspace.explore.results.records')}>
        {records.length === 0 ? (
          <p className="empty">{t('workspace.explore.results.emptyRecords')}</p>
        ) : (
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
        )}
        <p className="context__meta">
          <span>{t('workspace.explore.results.matchedRecords')} <strong>{result.matched_count ?? 0}</strong></span>
          <span>{t('workspace.explore.results.returned')} <strong>{result.returned}</strong></span>
          <span>{message('workspace.explore.results.page', { page: String(page.index + 1) })}</span>
          {result.truncated === true ? <span>{t('workspace.explore.results.truncated')}</span> : null}
        </p>
        <div className="form__actions">
          {page.index > 0 ? (
            <Button variant="secondary" busy={busy === 'query'} onClick={previousPage}>
              {t('workspace.explore.results.previous')}
            </Button>
          ) : null}
          {result.next_cursor === null ? null : (
            <Button variant="secondary" busy={busy === 'query'} onClick={nextPage}>
              {t('workspace.explore.results.next')}
            </Button>
          )}
        </div>
        {result.window === null ? null : (
          <WindowSummary label={t('workspace.explore.provenance.window')} window={result.window} />
        )}
      </Panel>
    );
  }

  function renderDocuments(result: ProductQueryAnswer) {
    const columns = result.columns ?? [];
    const records = result.records ?? [];
    return (
      <Panel level={2} title={t('workspace.explore.results.documents')}>
        {records.length === 0 ? (
          <p className="empty">{t('workspace.explore.results.emptyDocuments')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((name) => <th key={name} scope="col">{name}</th>)}
                <th scope="col">{t('workspace.explore.results.score')}</th>
                <th scope="col">{t('workspace.explore.results.matchedTerms')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record, index) => (
                <tr key={String(index)}>
                  {columns.map((name) => <td key={name}>{cellText(record[name])}</td>)}
                  <td>{cellText(record['score'])}</td>
                  <td>{cellText(record['matched_terms'])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="context__meta">
          <span>{t('workspace.explore.results.matchedDocuments')} <strong>{result.matched_count ?? 0}</strong></span>
          <span>{t('workspace.explore.results.returned')} <strong>{result.returned}</strong></span>
          <span>{message('workspace.explore.results.page', { page: String(page.index + 1) })}</span>
        </p>
        <div className="form__actions">
          {page.index > 0 ? (
            <Button variant="secondary" busy={busy === 'query'} onClick={previousPage}>
              {t('workspace.explore.results.previous')}
            </Button>
          ) : null}
          {result.next_cursor === null ? null : (
            <Button variant="secondary" busy={busy === 'query'} onClick={nextPage}>
              {t('workspace.explore.results.next')}
            </Button>
          )}
        </div>
      </Panel>
    );
  }

  function comparisonCell(entry: ProductComparedMetric | undefined, field: 'change' | 'percent'): string {
    return field === 'change' ? changeText(entry) : percentText(entry);
  }

  function renderAggregate(result: ProductQueryAnswer) {
    const dimensions = result.grouped_by ?? [];
    const metrics = result.metrics ?? [];
    const groups = result.groups ?? [];
    const compared = result.comparison_window !== null && result.comparison_window !== undefined;
    return (
      <Panel level={2} title={t('workspace.explore.results.aggregate')}>
        {groups.length === 0 ? (
          <p className="empty">{t('workspace.explore.results.emptyAggregate')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                {dimensions.map((name) => <th key={name} scope="col">{name}</th>)}
                {metrics.map((metric) => <th key={metric.name} scope="col">{metric.name}</th>)}
                {compared
                  ? metrics.flatMap((metric) => [
                    <th key={`${metric.name}-change`} scope="col">
                      {message('workspace.explore.results.changeColumn', { metric: metric.name })}
                    </th>,
                    <th key={`${metric.name}-percent`} scope="col">
                      {message('workspace.explore.results.changePercentColumn', { metric: metric.name })}
                    </th>,
                  ])
                  : null}
              </tr>
            </thead>
            <tbody>
              {groups.map((group: ProductQueryGroup, index) => (
                <tr key={String(index)}>
                  {dimensions.map((name) => <td key={name}>{cellText(group.group[name])}</td>)}
                  {metrics.map((metric) => <td key={metric.name}>{cellText(group.metrics[metric.name])}</td>)}
                  {compared
                    ? metrics.flatMap((metric) => [
                      <td key={`${metric.name}-change`}>{comparisonCell(group.comparison?.[metric.name], 'change')}</td>,
                      <td key={`${metric.name}-percent`}>{comparisonCell(group.comparison?.[metric.name], 'percent')}</td>,
                    ])
                    : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {groups.some((group) => group.null_dimensions.length > 0) ? (
          <p className="field__hint">
            {message('workspace.explore.results.nullDimensions', {
              dimensions: [...new Set(groups.flatMap((group) => group.null_dimensions))].join('、'),
            })}
          </p>
        ) : null}
        {result.totals === null || result.totals === undefined ? null : (
          <table className="data-table">
            <caption className="panel__description">{t('workspace.explore.results.total')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('workspace.explore.results.metric')}</th>
                <th scope="col">{t('workspace.explore.results.value')}</th>
                <th scope="col">{t('workspace.explore.results.change')}</th>
                <th scope="col">{t('workspace.explore.results.changePercent')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.name}>
                  <td>{metric.name}</td>
                  <td>{cellText(result.totals?.metrics[metric.name])}</td>
                  <td>{comparisonCell(result.totals?.comparison?.[metric.name], 'change')}</td>
                  <td>{comparisonCell(result.totals?.comparison?.[metric.name], 'percent')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="context__meta">
          <span>{t('workspace.explore.results.groups')} <strong>{result.groups_total ?? 0}</strong></span>
          <span>{t('workspace.explore.results.returned')} <strong>{result.returned}</strong></span>
          <span>{message('workspace.explore.results.page', { page: String(page.index + 1) })}</span>
        </p>
        <div className="form__actions">
          {page.index > 0 ? (
            <Button variant="secondary" busy={busy === 'query'} onClick={previousPage}>
              {t('workspace.explore.results.previous')}
            </Button>
          ) : null}
          {result.next_cursor === null ? null : (
            <Button variant="secondary" busy={busy === 'query'} onClick={nextPage}>
              {t('workspace.explore.results.next')}
            </Button>
          )}
        </div>
        {result.window === null ? null : (
          <WindowSummary label={t('workspace.explore.provenance.window')} window={result.window} />
        )}
        {result.comparison_window === null || result.comparison_window === undefined ? null : (
          <WindowSummary label={t('workspace.explore.provenance.comparisonWindow')} window={result.comparison_window} />
        )}
      </Panel>
    );
  }

  function renderAnswer() {
    if (answer === null) return null;
    if (answer.kind === 'records') return renderRecords(answer);
    if (answer.kind === 'search') return renderDocuments(answer);
    if (answer.kind === 'aggregate') return renderAggregate(answer);
    return null;
  }

  function renderProvenance(result: ProductQueryAnswer) {
    const provenance = result.provenance;
    return (
      <Panel
        level={2}
        title={t('workspace.explore.provenance.title')}
        description={t('workspace.explore.provenance.description')}
      >
        <DefinitionList
          rows={[
            { term: t('workspace.explore.provenance.productVersion'), value: String(result.data_product_version) },
            { term: t('workspace.explore.provenance.release'), value: String(result.data_product_release) },
            {
              term: t('workspace.explore.provenance.contract'),
              value: `${result.contract_version.major}.${result.contract_version.minor}`,
            },
            { term: t('workspace.explore.provenance.contractHash'), value: result.contract_hash, mono: true },
            { term: t('workspace.explore.provenance.datasetRelease'), value: String(provenance.dataset_release) },
            { term: t('workspace.explore.provenance.source'), value: provenance.source.name ?? provenance.source.source_id },
            {
              term: t('workspace.explore.provenance.configuration'),
              value: String(provenance.integration_configuration_version),
            },
            {
              term: t('workspace.explore.provenance.businessContext'),
              value: Object.entries(provenance.business_context)
                .map(([key, value]) => `${key} ${value}`)
                .join('、') || '—',
            },
            {
              term: t('workspace.explore.provenance.recordCount'),
              value: provenance.record_count === null ? '—' : String(provenance.record_count),
            },
            ...(provenance.permitted_record_count === undefined
              ? []
              : [{ term: t('workspace.explore.provenance.permittedRecordCount'), value: String(provenance.permitted_record_count) }]),
            { term: t('workspace.explore.provenance.scanned'), value: String(result.scanned_records) },
            { term: t('workspace.explore.provenance.acquiredAt'), value: formatInstant(provenance.acquired_at) },
            { term: t('workspace.explore.provenance.integratedAt'), value: formatInstant(provenance.integrated_at) },
            { term: t('workspace.explore.provenance.releasedAt'), value: formatInstant(provenance.released_at) },
            {
              term: t('workspace.explore.provenance.relationships'),
              value: provenance.relationships.length === 0
                ? t('workspace.explore.details.none')
                : provenance.relationships.map((entry) => `${entry.name} · ${entry.dataset_release}`).join('、'),
            },
            {
              term: t('workspace.explore.provenance.cache'),
              value: result.cache?.reused === true
                ? t('workspace.explore.provenance.yes')
                : t('workspace.explore.provenance.no'),
            },
          ]}
        />
      </Panel>
    );
  }

  function renderExports() {
    const exportable = answer !== null && lastRequest !== null
      && (answer.kind === 'records' || answer.kind === 'aggregate');
    return (
      <Panel
        level={2}
        title={t('workspace.explore.exports.title')}
        description={t('workspace.explore.exports.description')}
      >
        <p className="field__hint">
          {exportable ? t('workspace.explore.exports.hint') : t('workspace.explore.exports.unavailable')}
        </p>
        <div className="form__actions">
          {exportable ? (
            <Button busy={busy === 'export'} onClick={createExport}>
              {busy === 'export'
                ? t('workspace.explore.exports.creating')
                : t('workspace.explore.exports.create')}
            </Button>
          ) : null}
        </div>
        {exports === null ? (
          <p className="empty" role="status">{t('platform.loading')}</p>
        ) : exports.length === 0 ? (
          <p className="empty">{t('workspace.explore.exports.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('workspace.explore.exports.id')}</th>
                <th scope="col">{t('workspace.explore.exports.release')}</th>
                <th scope="col">{t('workspace.explore.exports.rows')}</th>
                <th scope="col">{t('workspace.explore.exports.columns')}</th>
                <th scope="col">{t('workspace.explore.exports.createdAt')}</th>
                <th scope="col">{t('workspace.explore.exports.expiresAt')}</th>
                <th scope="col">{t('workspace.explore.exports.status')}</th>
                <th scope="col">{t('workspace.explore.exports.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {exports.map((record) => (
                <tr key={record.export_id}>
                  <td className="data-table__mono">{record.export_id}</td>
                  <td>{record.data_product_release}</td>
                  <td>{record.row_count}</td>
                  <td>{join(record.columns)}</td>
                  <td>{formatInstant(record.created_at)}</td>
                  <td>{formatInstant(record.expires_at)}</td>
                  <td>{statusLabel(record.status)}</td>
                  <td>
                    {record.can_download ? (
                      <Button
                        variant="secondary"
                        busy={busy === `download-${record.export_id}`}
                        onClick={() => download(record)}
                      >
                        {busy === `download-${record.export_id}`
                          ? t('workspace.explore.exports.downloading')
                          : t('workspace.explore.exports.download')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    );
  }

  /** The typed dimension filters a record or aggregate request may state. */
  function renderFilterEditor() {
    return (
      <>
        {filters.map((filter, index) => (
          <div className="form__grid" key={String(index)}>
            <div className="field">
              <label className="field__label" htmlFor={`explore-filter-field-${index}`}>
                {message('workspace.explore.workbench.filterField', { index: String(index + 1) })}
              </label>
              <select
                className="field__input"
                id={`explore-filter-field-${index}`}
                value={filter.field}
                onChange={(event) => setFilters((current) => current.map((entry, position) => (
                  position === index ? { ...entry, field: event.target.value } : entry
                )))}
              >
                <option value="">—</option>
                {selected?.filters.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`explore-filter-op-${index}`}>
                {message('workspace.explore.workbench.filterOp', { index: String(index + 1) })}
              </label>
              <select
                className="field__input"
                id={`explore-filter-op-${index}`}
                value={filter.op}
                onChange={(event) => setFilters((current) => current.map((entry, position) => (
                  position === index ? { ...entry, op: event.target.value } : entry
                )))}
              >
                {FILTER_OPERATORS.map((op) => <option key={op} value={op}>{operatorLabel(op)}</option>)}
              </select>
            </div>
            {NULL_TESTS.includes(filter.op) ? null : (
              <Field
                id={`explore-filter-value-${index}`}
                label={message('workspace.explore.workbench.filterValue', { index: String(index + 1) })}
                value={filter.value}
                onChange={(value) => setFilters((current) => current.map((entry, position) => (
                  position === index ? { ...entry, value } : entry
                )))}
              />
            )}
          </div>
        ))}
        <div className="form__actions">
          <Button variant="secondary" onClick={() => setFilters((current) => [...current, emptyFilter()])}>
            {t('workspace.explore.workbench.addFilter')}
          </Button>
          <Button variant="quiet" onClick={() => setFilters([emptyFilter()])}>
            {t('workspace.explore.workbench.clearFilters')}
          </Button>
        </div>
      </>
    );
  }

  const metrics = selected?.metrics ?? [];
  const sortableDimensions = [...groupBy, ...selectedMetrics];

  return (
    <Panel level={1} title={t('workspace.products.title')} description={t('workspace.explore.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}

      <Panel
        level={2}
        title={t('workspace.explore.discovery.title')}
        description={t('workspace.explore.discovery.description')}
      >
        {products === null ? (
          failed ? null : <p className="empty" role="status">{t('platform.loading')}</p>
        ) : products.length === 0 ? (
          <p className="empty">{t('workspace.products.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('workspace.explore.discovery.name')}</th>
                <th scope="col">{t('workspace.explore.discovery.apiPath')}</th>
                <th scope="col">{t('workspace.explore.discovery.contract')}</th>
                <th scope="col">{t('workspace.explore.discovery.version')}</th>
                <th scope="col">{t('workspace.explore.discovery.release')}</th>
                <th scope="col">{t('workspace.explore.discovery.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.data_product_id}>
                  <td>{product.name}</td>
                  <td className="data-table__mono">{product.api_path}</td>
                  <td>{`${product.contract_version.major}.${product.contract_version.minor}`}</td>
                  <td>{product.data_product_version}</td>
                  <td>{product.data_product_release}</td>
                  <td>
                    <Button variant="secondary" onClick={() => browse(product)}>
                      {t('workspace.explore.discovery.browse')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {selected === null ? null : (
        <>
          <Panel
            level={2}
            title={t('workspace.explore.details.title')}
            description={t('workspace.explore.details.description')}
          >
            <DefinitionList
              rows={[
                { term: t('workspace.explore.details.product'), value: selected.name },
                { term: t('workspace.explore.details.apiPath'), value: selected.api_path, mono: true },
                { term: t('workspace.explore.details.version'), value: String(selected.data_product_version) },
                { term: t('workspace.explore.details.release'), value: String(selected.data_product_release) },
                {
                  term: t('workspace.explore.details.contract'),
                  value: `${selected.contract_version.major}.${selected.contract_version.minor}`,
                },
                { term: t('workspace.explore.details.titleField'), value: selected.title },
                { term: t('workspace.explore.details.fields'), value: join(selected.fields) },
                { term: t('workspace.explore.details.dimensions'), value: join(selected.dimensions) },
                { term: t('workspace.explore.details.metrics'), value: join(selected.metrics.map((metric) => metric.name)) },
                { term: t('workspace.explore.details.grain'), value: join(selected.grain) },
                {
                  term: t('workspace.explore.details.time'),
                  value: selected.time === null
                    ? t('workspace.explore.details.none')
                    : `${selected.time.field} · ${typeLabel(selected.time.precision)} · ${selected.time.time_zone}`,
                },
                { term: t('workspace.explore.details.filters'), value: join(selected.filters) },
                {
                  term: t('workspace.explore.details.limit'),
                  value: message('workspace.explore.details.limitValue', {
                    default: String(selected.default_limit),
                    max: String(selected.max_limit),
                  }),
                },
                {
                  term: t('workspace.explore.details.search'),
                  value: selected.search === null
                    ? t('workspace.explore.details.searchUnsupported')
                    : t('workspace.explore.details.searchSupported'),
                },
                {
                  term: t('workspace.explore.details.relationships'),
                  value: selected.relationships.length === 0
                    ? t('workspace.explore.details.none')
                    : selected.relationships.map((relationship) => relationship.name).join('、'),
                },
              ]}
            />
            {metrics.length === 0 ? null : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('workspace.explore.details.metricName')}</th>
                    <th scope="col">{t('workspace.explore.details.metricAggregation')}</th>
                    <th scope="col">{t('workspace.explore.details.metricType')}</th>
                    <th scope="col">{t('workspace.explore.details.metricField')}</th>
                    <th scope="col">{t('workspace.explore.details.metricUnit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((metric) => (
                    <tr key={metric.name}>
                      <td className="data-table__mono">{metric.name}</td>
                      <td>{aggregationLabel(metric.aggregation)}</td>
                      <td>{typeLabel(metric.value_type)}</td>
                      <td className="data-table__mono">{metric.field ?? '—'}</td>
                      <td>{metric.unit ?? metric.currency ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            level={2}
            title={t('workspace.explore.releases.title')}
            description={t('workspace.explore.releases.description')}
          >
            {releases === null ? (
              <p className="empty" role="status">{t('platform.loading')}</p>
            ) : (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="explore-release">
                    {t('workspace.explore.releases.select')}
                  </label>
                  <select
                    className="field__input"
                    id="explore-release"
                    value={selectedRelease}
                    onChange={(event) => {
                      setSelectedRelease(event.target.value);
                      setAnswer(null);
                      setLastRequest(null);
                      setPage({ trail: [null], index: 0 });
                      setNotice(null);
                    }}
                  >
                    <option value="">
                      {message('workspace.explore.releases.currentOption', { release: String(selected.data_product_release) })}
                    </option>
                    {releases.map((release) => (
                      <option key={release.release} value={String(release.release)}>
                        {message('workspace.explore.releases.explicitOption', { release: String(release.release) })}
                      </option>
                    ))}
                  </select>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('workspace.explore.releases.release')}</th>
                      <th scope="col">{t('workspace.explore.releases.contract')}</th>
                      <th scope="col">{t('workspace.explore.releases.dataset')}</th>
                      <th scope="col">{t('workspace.explore.releases.status')}</th>
                      <th scope="col">{t('workspace.explore.releases.createdAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {releases.map((release) => (
                      <tr key={release.release}>
                        <td>{release.release}</td>
                        <td>{release.contract_version === null ? '—' : `${release.contract_version.major}.${release.contract_version.minor}`}</td>
                        <td>{release.dataset_release}</td>
                        <td>{releaseStatus(release)}</td>
                        <td>{formatInstant(release.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Panel>

          <Panel
            level={2}
            title={t('workspace.explore.workbench.title')}
            description={t('workspace.explore.workbench.description')}
          >
            <div className="form__actions">
              <Button
                variant={mode === 'records' ? 'primary' : 'secondary'}
                onClick={() => switchMode('records')}
              >
                {t('workspace.explore.workbench.records')}
              </Button>
              <Button
                variant={mode === 'documents' ? 'primary' : 'secondary'}
                onClick={() => switchMode('documents')}
              >
                {t('workspace.explore.workbench.documents')}
              </Button>
              <Button
                variant={mode === 'aggregate' ? 'primary' : 'secondary'}
                onClick={() => switchMode('aggregate')}
              >
                {t('workspace.explore.workbench.aggregate')}
              </Button>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="explore-limit">
                {t('workspace.explore.workbench.limit')}
              </label>
              <input
                className="field__input"
                id="explore-limit"
                inputMode="numeric"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </div>

            {mode === 'records' ? (
              <>
                {renderFilterEditor()}
                {selected.time === null ? null : (
                  <div className="form__grid">
                    <Field
                      id="explore-record-start"
                      label={t('workspace.explore.workbench.recordsStart')}
                      value={recordStart}
                      onChange={setRecordStart}
                      hint={t('workspace.explore.workbench.windowHint')}
                    />
                    <Field
                      id="explore-record-end"
                      label={t('workspace.explore.workbench.recordsEnd')}
                      value={recordEnd}
                      onChange={setRecordEnd}
                    />
                  </div>
                )}
                <div className="form__actions">
                  <Button busy={busy === 'query'} onClick={queryRecords}>
                    {t('workspace.explore.workbench.runRecords')}
                  </Button>
                </div>
              </>
            ) : mode === 'documents' ? (
              selected.search === null ? (
                <p className="empty">{t('workspace.explore.workbench.noSearch')}</p>
              ) : (
                <>
                  <Field
                    id="explore-query"
                    label={t('workspace.explore.workbench.query')}
                    value={query}
                    onChange={setQuery}
                  />
                  <div className="form__actions">
                    <Button busy={busy === 'query'} onClick={queryDocuments}>
                      {t('workspace.explore.workbench.runDocuments')}
                    </Button>
                  </div>
                </>
              )
            ) : (
              <>
                <fieldset className="fieldset">
                  <legend className="field__label">{t('workspace.explore.workbench.groupBy')}</legend>
                  <div className="choices">
                    {selected.dimensions.map((dimension) => (
                      <label className="choice" key={dimension}>
                        <input
                          type="checkbox"
                          checked={groupBy.includes(dimension)}
                          onChange={(event) => {
                            setGroupBy((current) => (event.target.checked
                              ? [...current, dimension]
                              : current.filter((entry) => entry !== dimension)));
                            setSortBy('');
                          }}
                        />
                        {dimension}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="fieldset">
                  <legend className="field__label">{t('workspace.explore.workbench.metrics')}</legend>
                  <div className="choices">
                    {metrics.map((metric) => (
                      <label className="choice" key={metric.name}>
                        <input
                          type="checkbox"
                          checked={selectedMetrics.includes(metric.name)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...selectedMetrics, metric.name]
                              : selectedMetrics.filter((entry) => entry !== metric.name);
                            setSelectedMetrics(next);
                            setSortBy('');
                            setMetricFilters((current) => current.filter((entry) => next.includes(entry.metric)));
                          }}
                        />
                        {metric.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="form__grid">
                  <div className="field">
                    <label className="field__label" htmlFor="explore-sort">
                      {t('workspace.explore.workbench.sortBy')}
                    </label>
                    <select
                      className="field__input"
                      id="explore-sort"
                      value={sortBy}
                      onChange={(event) => setSortBy(event.target.value)}
                    >
                      <option value="">{t('workspace.explore.workbench.sortNone')}</option>
                      {sortableDimensions.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor="explore-sort-direction">
                      {t('workspace.explore.workbench.sortDirection')}
                    </label>
                    <select
                      className="field__input"
                      id="explore-sort-direction"
                      value={sortDirection}
                      onChange={(event) => setSortDirection(event.target.value === 'desc' ? 'desc' : 'asc')}
                    >
                      <option value="asc">{t('workspace.explore.workbench.sortAsc')}</option>
                      <option value="desc">{t('workspace.explore.workbench.sortDesc')}</option>
                    </select>
                  </div>
                </div>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={includeTotals}
                    onChange={(event) => setIncludeTotals(event.target.checked)}
                  />
                  {t('workspace.explore.workbench.includeTotals')}
                </label>
                {selected.time === null ? null : (
                  <div className="form__grid">
                    <Field
                      id="explore-window-start"
                      label={t('workspace.explore.workbench.windowStart')}
                      value={windowStart}
                      onChange={setWindowStart}
                    />
                    <Field
                      id="explore-window-end"
                      label={t('workspace.explore.workbench.windowEnd')}
                      value={windowEnd}
                      onChange={setWindowEnd}
                    />
                    <Field
                      id="explore-comparison-start"
                      label={t('workspace.explore.workbench.comparisonStart')}
                      value={comparisonStart}
                      onChange={setComparisonStart}
                    />
                    <Field
                      id="explore-comparison-end"
                      label={t('workspace.explore.workbench.comparisonEnd')}
                      value={comparisonEnd}
                      onChange={setComparisonEnd}
                    />
                  </div>
                )}
                {renderFilterEditor()}
                {metricFilters.map((filter, index) => (
                  <div className="form__grid" key={String(index)}>
                    <div className="field">
                      <label className="field__label" htmlFor={`explore-metric-field-${index}`}>
                        {message('workspace.explore.workbench.metricFilterField', { index: String(index + 1) })}
                      </label>
                      <select
                        className="field__input"
                        id={`explore-metric-field-${index}`}
                        value={filter.metric}
                        onChange={(event) => setMetricFilters((current) => current.map((entry, position) => (
                          position === index ? { ...entry, metric: event.target.value } : entry
                        )))}
                      >
                        <option value="">—</option>
                        {selectedMetrics.map((name) => <option key={name} value={name}>{name}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor={`explore-metric-op-${index}`}>
                        {message('workspace.explore.workbench.metricFilterOp', { index: String(index + 1) })}
                      </label>
                      <select
                        className="field__input"
                        id={`explore-metric-op-${index}`}
                        value={filter.op}
                        onChange={(event) => setMetricFilters((current) => current.map((entry, position) => (
                          position === index ? { ...entry, op: event.target.value } : entry
                        )))}
                      >
                        {FILTER_OPERATORS.map((op) => <option key={op} value={op}>{operatorLabel(op)}</option>)}
                      </select>
                    </div>
                    {NULL_TESTS.includes(filter.op) ? null : (
                      <Field
                        id={`explore-metric-value-${index}`}
                        label={message('workspace.explore.workbench.metricFilterValue', { index: String(index + 1) })}
                        value={filter.value}
                        onChange={(value) => setMetricFilters((current) => current.map((entry, position) => (
                          position === index ? { ...entry, value } : entry
                        )))}
                        inputMode="numeric"
                      />
                    )}
                  </div>
                ))}
                <div className="form__actions">
                  <Button
                    variant="secondary"
                    onClick={() => setMetricFilters((current) => [
                      ...current,
                      { metric: selectedMetrics[0] ?? '', op: 'greater_or_equal', value: '' },
                    ])}
                  >
                    {t('workspace.explore.workbench.addMetricFilter')}
                  </Button>
                  <Button variant="quiet" onClick={() => setMetricFilters([])}>
                    {t('workspace.explore.workbench.clearMetricFilters')}
                  </Button>
                </div>
                <div className="form__actions">
                  <Button busy={busy === 'query'} onClick={queryAggregate}>
                    {t('workspace.explore.workbench.runAggregate')}
                  </Button>
                </div>
              </>
            )}
          </Panel>

          {renderAnswer()}
          {answer === null ? null : renderProvenance(answer)}
          {renderExports()}
        </>
      )}
    </Panel>
  );
}
