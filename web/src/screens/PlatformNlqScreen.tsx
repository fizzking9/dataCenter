import { useCallback, useState } from 'react';
import {
  platformApi,
  type NaturalLanguageAnswerView,
  type NlqAsOfView,
  type NlqPartView,
  type NlqProvenanceView,
  type NlqResolvedView,
  type NlqResultView,
  type NlqWindowView,
  type ProductComparedMetric,
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

function outcomeLabel(outcome: string): string {
  return optional(`workspace.nlq.outcome.${outcome}`) ?? outcome;
}

function statusLabel(status: string): string {
  return optional(`workspace.nlq.status.${status}`) ?? status;
}

function missingLabel(kind: string): string {
  return optional(`workspace.nlq.missing.${kind}`) ?? kind;
}

function operatorLabel(op: string): string {
  return optional(`value.grantOp.${op}`) ?? op;
}

function joinOrNone(values: string[]): string {
  return values.length === 0 ? t('workspace.nlq.resolved.none') : values.join('、');
}

/** One governed value exactly as the engine states it; a missing value stays absent. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return t('workspace.nlq.result.nullValue');
  if (Array.isArray(value)) return value.map(String).join('、');
  return String(value);
}

function filterText(filter: Record<string, unknown>): string {
  const field = String(filter['field'] ?? '');
  const op = operatorLabel(String(filter['op'] ?? ''));
  if (filter['value'] === undefined) return `${field} ${op}`;
  return `${field} ${op} ${String(filter['value'])}`;
}

function percentText(entry: ProductComparedMetric | undefined): string {
  return entry === undefined || entry.change_percent === null ? '—' : entry.change_percent;
}

function changeText(entry: ProductComparedMetric | undefined): string {
  return entry === undefined || entry.change === null ? '—' : String(entry.change);
}

/** The window one part evaluated, including the coverage its Release holds. */
function WindowFacts({ label, window }: { label: string; window: NlqWindowView }) {
  return (
    <DefinitionList
      rows={[
        { term: label, value: `${window.start} ~ ${window.end}` },
        {
          term: t('workspace.nlq.resolved.coverage'),
          value: window.coverage === null ? '—' : `${window.coverage.start} ~ ${window.coverage.end}`,
        },
        {
          term: t('workspace.nlq.resolved.partialPeriod'),
          value: window.partial ? t('workspace.nlq.resolved.yes') : t('workspace.nlq.resolved.no'),
        },
      ]}
    />
  );
}

/** The deterministic result exactly as the governed query returned it. */
function ResultFacts({ result }: { result: NlqResultView }) {
  if (result.kind === 'aggregate') {
    const dimensions = result.grouped_by ?? [];
    const metrics = result.metrics ?? [];
    const groups = result.groups ?? [];
    const compared = result.comparison_window !== null && result.comparison_window !== undefined;
    const total = result.totals === null || result.totals === undefined ? null : result.totals;
    return (
      <>
        {(result.groups_total ?? groups.length) === 0 ? (
          <p className="empty">{t('workspace.nlq.result.empty')}</p>
        ) : dimensions.length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                {dimensions.map((name) => <th key={name} scope="col">{name}</th>)}
                {metrics.map((metric) => <th key={metric.name} scope="col">{metric.name}</th>)}
                {compared
                  ? metrics.map((metric) => (
                    <th key={`${metric.name}-percent`} scope="col">
                      {message('workspace.nlq.result.changePercent', { metric: metric.name })}
                    </th>
                  ))
                  : null}
              </tr>
            </thead>
            <tbody>
              {groups.map((group, index) => (
                <tr key={String(index)}>
                  {dimensions.map((name) => <td key={name}>{cellText(group.group[name])}</td>)}
                  {metrics.map((metric) => <td key={metric.name}>{cellText(group.metrics[metric.name])}</td>)}
                  {compared
                    ? metrics.map((metric) => (
                      <td key={`${metric.name}-percent`}>{percentText(group.comparison?.[metric.name])}</td>
                    ))
                    : null}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('workspace.nlq.result.metric')}</th>
                <th scope="col">{t('workspace.nlq.result.value')}</th>
                {compared ? <th scope="col">{t('workspace.nlq.result.change')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.name}>
                  <td>{metric.name}</td>
                  <td>{cellText(groupValue(groups, total, metric.name))}</td>
                  {compared ? <td>{changeText(total?.comparison?.[metric.name])}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="context__meta">
          <span>{t('workspace.nlq.result.groups')} <strong>{result.groups_total ?? groups.length}</strong></span>
          <span>{t('workspace.nlq.result.returned')} <strong>{result.returned ?? groups.length}</strong></span>
        </p>
        {total === null ? null : (
          <table className="data-table">
            <caption className="panel__description">{t('workspace.nlq.result.total')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('workspace.nlq.result.metric')}</th>
                <th scope="col">{t('workspace.nlq.result.value')}</th>
                {compared ? <th scope="col">{t('workspace.nlq.result.change')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.name}>
                  <td>{metric.name}</td>
                  <td>{cellText(total.metrics[metric.name])}</td>
                  {compared ? <td>{changeText(total.comparison?.[metric.name])}</td> : null}
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
      <p className="empty">{t('workspace.nlq.result.empty')}</p>
    ) : (
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.nlq.result.value')}</th>
            <th scope="col">{t('workspace.nlq.result.count')}</th>
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
  if (records.length === 0) return <p className="empty">{t('workspace.nlq.result.empty')}</p>;
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

/**
 * The one governed value a metric carries when the answer has no grouping: the
 * grand total the engine computed, never a browser-side sum.
 */
function groupValue(
  groups: NlqResultView['groups'],
  totals: NlqResultView['totals'],
  metric: string,
): unknown {
  if (totals !== null && totals !== undefined && totals.metrics[metric] !== undefined) {
    return totals.metrics[metric];
  }
  return groups?.[0]?.metrics[metric];
}

/** The interpretation the deterministic layer resolved, disclosed in full. */
function ResolvedFacts({ resolved }: { resolved: NlqResolvedView }) {
  return (
    <Panel level={2} title={t('workspace.nlq.resolved.title')}>
      <DefinitionList
        rows={[
          { term: t('workspace.nlq.resolved.interpretation'), value: resolved.interpretation },
          { term: t('workspace.nlq.resolved.metrics'), value: joinOrNone(resolved.metrics) },
          { term: t('workspace.nlq.resolved.dimensions'), value: joinOrNone(resolved.dimensions) },
          {
            term: t('workspace.nlq.resolved.filters'),
            value: resolved.filters.length === 0
              ? t('workspace.nlq.resolved.none')
              : resolved.filters.map((filter) => filterText(filter)).join('；'),
          },
          {
            term: t('workspace.nlq.resolved.defaults'),
            value: resolved.defaults_applied.length === 0
              ? t('workspace.nlq.resolved.none')
              : resolved.defaults_applied
                .map((entry) => `${entry.name} ${Array.isArray(entry.value) ? entry.value.join('、') : String(entry.value)}`)
                .join('；'),
          },
          {
            term: t('workspace.nlq.resolved.partialPeriod'),
            value: resolved.partial_period ? t('workspace.nlq.resolved.yes') : t('workspace.nlq.resolved.no'),
          },
        ]}
      />
      {resolved.window === null ? null : (
        <WindowFacts label={t('workspace.nlq.resolved.window')} window={resolved.window} />
      )}
      {resolved.comparison_window === null ? null : (
        <WindowFacts label={t('workspace.nlq.resolved.comparisonWindow')} window={resolved.comparison_window} />
      )}
    </Panel>
  );
}

/** The exact Release one part read and how far its data reaches. */
function ReleaseFacts({ part }: { part: NlqPartView }) {
  const identity = part.data_product;
  const freshness = part.freshness;
  if (identity === null || freshness === null) return null;
  const contract = identity['contract_version'];
  const contractVersion = contract !== null && typeof contract === 'object'
    ? `${String((contract as Record<string, unknown>)['major'] ?? '')}.${String((contract as Record<string, unknown>)['minor'] ?? '')}`
    : '—';
  return (
    <Panel level={2} title={t('workspace.nlq.release.title')}>
      <DefinitionList
        rows={[
          { term: t('workspace.nlq.release.product'), value: String(identity['name'] ?? '') },
          { term: t('workspace.nlq.release.version'), value: String(identity['data_product_version'] ?? '') },
          { term: t('workspace.nlq.release.release'), value: String(identity['data_product_release'] ?? '') },
          { term: t('workspace.nlq.release.contract'), value: contractVersion },
          { term: t('workspace.nlq.release.datasetRelease'), value: String(identity['dataset_release'] ?? '') },
          { term: t('workspace.nlq.release.contractHash'), value: String(identity['contract_hash'] ?? ''), mono: true },
          { term: t('workspace.nlq.release.releasedAt'), value: formatInstant(freshness.released_at ?? undefined) },
          { term: t('workspace.nlq.release.dataThrough'), value: freshness.data_through ?? '—' },
          {
            term: t('workspace.nlq.release.partial'),
            value: part.partial_period
              ? t('workspace.nlq.release.partialValue')
              : t('workspace.nlq.release.completeValue'),
          },
        ]}
      />
    </Panel>
  );
}

/** The permitted lineage, definitions, and authorization, collapsed until asked for. */
function ProvenanceFacts({
  part,
  answer,
}: {
  part: NlqPartView;
  answer: NaturalLanguageAnswerView;
}) {
  const provenance: NlqProvenanceView | null = part.provenance;
  const metrics = Array.isArray(part.evidence?.['metrics'])
    ? (part.evidence['metrics'] as Array<Record<string, unknown>>)
    : [];
  const scope = answer.authorization?.parts.find(
    (entry) => entry.data_product_id === part.data_product?.['data_product_id'],
  );
  return (
    <Panel
      level={2}
      title={t('workspace.nlq.provenance.title')}
      description={t('workspace.nlq.provenance.description')}
    >
      <details className="nlq-provenance">
        <summary className="nlq-provenance__summary">{t('workspace.nlq.provenance.expand')}</summary>
        <h3 className="panel__title">{t('workspace.nlq.provenance.query')}</h3>
        <pre className="nlq-provenance__query">{JSON.stringify(part.query, null, 2)}</pre>
        {provenance === null ? null : (
          <DefinitionList
            rows={[
              { term: t('workspace.nlq.provenance.source'), value: provenance.source.name ?? provenance.source.source_id },
              { term: t('workspace.nlq.provenance.datasetRelease'), value: String(provenance.dataset_release) },
              {
                term: t('workspace.nlq.provenance.configuration'),
                value: String(provenance.integration_configuration_version),
              },
              {
                term: t('workspace.nlq.provenance.recordCount'),
                value: provenance.record_count === null ? '—' : String(provenance.record_count),
              },
              { term: t('workspace.nlq.provenance.acquiredAt'), value: formatInstant(provenance.acquired_at) },
              { term: t('workspace.nlq.provenance.integratedAt'), value: formatInstant(provenance.integrated_at) },
              { term: t('workspace.nlq.provenance.releasedAt'), value: formatInstant(provenance.released_at) },
            ]}
          />
        )}
        {metrics.length === 0 ? null : (
          <>
            <h3 className="panel__title">{t('workspace.nlq.provenance.metrics')}</h3>
            <DefinitionList
              rows={metrics.map((metric) => ({
                term: String(metric['name'] ?? ''),
                value: String(metric['description'] ?? metric['aggregation'] ?? ''),
              }))}
            />
          </>
        )}
        {scope === undefined ? null : (
          <>
            <h3 className="panel__title">{t('workspace.nlq.provenance.authorization')}</h3>
            <DefinitionList
              rows={[
                { term: t('workspace.nlq.provenance.role'), value: String(answer.authorization?.role ?? '') },
                { term: t('workspace.nlq.provenance.columns'), value: scope.columns.join('、') },
                { term: t('workspace.nlq.provenance.rowFilters'), value: String(scope.row_filter_count) },
                { term: t('workspace.nlq.provenance.fingerprint'), value: scope.scope_fingerprint, mono: true },
              ]}
            />
          </>
        )}
      </details>
    </Panel>
  );
}

/** The as-of story every independent part discloses, so no snapshot is implied. */
function AsOfFacts({ entries }: { entries: NlqAsOfView[] }) {
  if (entries.length < 2) return null;
  return (
    <Panel
      level={2}
      title={t('workspace.nlq.asOf.title')}
      description={t('workspace.nlq.asOf.description')}
    >
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.nlq.asOf.part')}</th>
            <th scope="col">{t('workspace.nlq.asOf.release')}</th>
            <th scope="col">{t('workspace.nlq.asOf.releasedAt')}</th>
            <th scope="col">{t('workspace.nlq.asOf.dataThrough')}</th>
            <th scope="col">{t('workspace.nlq.asOf.status')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={`${entry.data_product_id ?? 'part'}-${String(index)}`}>
              <td>{entry.name ?? t('workspace.nlq.asOf.unnamed')}</td>
              <td>{entry.data_product_release === null ? '—' : String(entry.data_product_release)}</td>
              <td>{formatInstant(entry.released_at ?? undefined)}</td>
              <td>{entry.data_through ?? '—'}</td>
              <td>{entry.executed ? t('workspace.nlq.asOf.executed') : t('workspace.nlq.asOf.notExecuted')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/** One independent answer part with its own result, Release, freshness, and evidence. */
function PartSection({ part, answer }: { part: NlqPartView; answer: NaturalLanguageAnswerView }) {
  const title = part.name === null
    ? t('workspace.nlq.result.title')
    : `${part.name}：${t('workspace.nlq.result.title')}`;
  if (!part.executed) {
    return (
      <Panel level={2} title={title}>
        <p className="context__meta">
          <span>{outcomeLabel(part.outcome)}</span>
          {part.reason_code === null ? null : <code>{part.reason_code}</code>}
        </p>
        <ul className="nlq-limitations">
          {part.limitations.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Panel>
    );
  }
  return (
    <Panel level={2} title={title}>
      <p className="context__meta">
        <span>{outcomeLabel(part.outcome)}</span>
        {part.reason_code === null ? null : <code>{part.reason_code}</code>}
      </p>
      {part.result === null ? null : <ResultFacts result={part.result} />}
      {part.resolved === null ? null : <ResolvedFacts resolved={part.resolved} />}
      <ReleaseFacts part={part} />
      <ProvenanceFacts part={part} answer={answer} />
      {part.limitations.length === 0 ? null : (
        <>
          <h3 className="panel__title">{t('workspace.nlq.limitations')}</h3>
          <ul className="nlq-limitations">
            {part.limitations.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </>
      )}
    </Panel>
  );
}

/**
 * The Consumer's conversational workbench. It states one Chinese question, shows
 * the platform's targeted Chinese clarification when the question is materially
 * ambiguous, and renders the governed answer with its resolved interpretation,
 * Release, freshness, and expandable Provenance. Every fact comes from the
 * server; this component never computes, decides, or widens a query.
 */
export function WorkspaceNlq({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [question, setQuestion] = useState('');
  const [clarification, setClarification] = useState('');
  const [answer, setAnswer] = useState<NaturalLanguageAnswerView | null>(null);
  const [asked, setAsked] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'ask' | 'clarify' | null>(null);
  // The opaque handle the server issued for this conversation. It is only ever
  // echoed back: the server re-resolves the actor, Grants, and Releases on every
  // turn, so holding it cannot widen what this Consumer may read.
  const [conversation, setConversation] = useState('');

  const turn = useCallback(async (
    body: Record<string, unknown>,
    askedQuestion: string,
    mode: 'ask' | 'clarify',
  ): Promise<void> => {
    setBusy(mode);
    setNotice(null);
    const result = await platformApi.askWorkspaceQuestion(workspaceId, body);
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
    setAsked(askedQuestion);
    setClarification('');
    // A refused handle is forgotten so the next question starts cleanly; every
    // other turn keeps the last server-issued handle, which the server verifies.
    if (result.data.conversation !== null) {
      setConversation(result.data.conversation);
    } else if (result.data.reason_code === 'NLQ_CONVERSATION_INVALID') {
      setConversation('');
    }
  }, [workspaceId, onSessionLost]);

  const ask = useCallback((): void => {
    if (question.trim() === '') return;
    void turn(
      { question, ...(conversation === '' ? {} : { conversation }) },
      question,
      'ask',
    );
  }, [question, conversation, turn]);

  const clarify = useCallback((): void => {
    if (answer === null || answer.clarification === null || clarification.trim() === '') return;
    void turn(
      { question: asked, clarification, ...(conversation === '' ? {} : { conversation }) },
      asked,
      'clarify',
    );
  }, [answer, asked, clarification, conversation, turn]);

  const startNewConversation = useCallback((): void => {
    setAnswer(null);
    setAsked('');
    setClarification('');
    setConversation('');
    setNotice(null);
  }, []);

  const originating = answer === null ? null : answer.clarification;

  return (
    <Panel
      level={1}
      title={t('workspace.nlq.title')}
      description={t('workspace.nlq.description')}    >
      <div className="field">
        <Field
          id="nlq-question"
          label={t('workspace.nlq.question')}
          hint={t('workspace.nlq.questionHint')}
          value={question}
          onChange={setQuestion}
        />
      </div>
      <div className="form__actions">
        <Button busy={busy === 'ask'} onClick={ask}>
          {busy === 'ask' ? t('workspace.nlq.asking') : t('workspace.nlq.ask')}
        </Button>
        {conversation === '' ? null : (
          <Button variant="secondary" onClick={startNewConversation}>
            {t('workspace.nlq.conversation.reset')}
          </Button>
        )}
      </div>
      {conversation === '' ? null : (
        <p className="field__hint">{t('workspace.nlq.conversation.active')}</p>
      )}
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}
      {answer === null ? null : (
        <Panel level={2} title={t('workspace.nlq.answer.title')}>
          <p className="context__meta">
            <span>{outcomeLabel(answer.outcome)}</span>
            <span>{statusLabel(answer.status)}</span>
            {answer.follow_up ? <span>{t('workspace.nlq.followUp')}</span> : null}
            <span>{t('workspace.nlq.answer.question')}：{asked}</span>
            {answer.reason_code === null ? null : <code>{answer.reason_code}</code>}
          </p>
          <DefinitionList rows={[{ term: t('workspace.nlq.summary'), value: answer.summary }]} />
          {answer.origin === 'stock' && answer.stock !== null ? (
            <p className="field__hint">
              {t('workspace.nlq.origin.stock')}
              {' '}
              {message('workspace.nlq.origin.stockDetail', { report_id: answer.stock.report_id })}
            </p>
          ) : answer.origin === 'generated' && answer.report !== null ? (
            <p className="field__hint">{t('workspace.nlq.origin.generated')}</p>
          ) : null}
          {answer.answer === null ? null : (
            <>
              <h3 className="panel__title">{t('workspace.nlq.narrative')}</h3>
              <p className="context__body">{answer.answer.narrative}</p>
            </>
          )}
          {answer.limitations.length === 0 ? null : (
            <>
              <h3 className="panel__title">{t('workspace.nlq.limitations')}</h3>
              <ul className="nlq-limitations">
                {answer.limitations.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </>
          )}
          {originating === null ? null : (
            <Panel
              level={2}
              title={t('workspace.nlq.clarification.title')}
              description={t('workspace.nlq.clarification.description')}
            >
              <p className="context__body">{originating.question}</p>
              {originating.part === null ? null : (
                <p className="field__hint">
                  {t('workspace.nlq.clarification.part')}：{originating.part.name}
                </p>
              )}
              <DefinitionList
                rows={[
                  {
                    term: t('workspace.nlq.clarification.missing'),
                    value: originating.missing.map((kind) => missingLabel(kind)).join('、'),
                  },
                  {
                    term: t('workspace.nlq.clarification.candidates'),
                    value: joinOrNone(originating.candidates),
                  },
                ]}
              />
              <Field
                id="nlq-clarification"
                label={t('workspace.nlq.clarification.answer')}
                hint={t('workspace.nlq.clarification.answerHint')}
                value={clarification}
                onChange={setClarification}
              />
              <div className="form__actions">
                <Button busy={busy === 'clarify'} onClick={clarify}>
                  {busy === 'clarify'
                    ? t('workspace.nlq.clarification.submitting')
                    : t('workspace.nlq.clarification.submit')}
                </Button>
              </div>
            </Panel>
          )}
          <AsOfFacts entries={answer.as_of} />
          {answer.parts.map((part, index) => (
            <PartSection key={`${part.name ?? 'part'}-${String(index)}`} part={part} answer={answer} />
          ))}
        </Panel>
      )}
    </Panel>
  );
}
