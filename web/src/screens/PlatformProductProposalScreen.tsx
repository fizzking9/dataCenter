import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ApiError,
  type ModelBindingView,
  type ProductContractView,
  type ProductProposalPreviewView,
  type ProductProposalProvenanceView,
  type ProductProposalView,
  type SourceSummary,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Alert, DefinitionList, Panel, StatusPill } from '../ui/Panel.js';

export interface WorkspaceProductProposalsProps {
  workspaceId: string;
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

type Action = 'approve' | 'reject' | 'publish';

const STATUS_TONE: Record<ProductProposalView['status'], 'ok' | 'warn'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'warn',
  published: 'ok',
};

function statusLabel(status: ProductProposalView['status']): string {
  return optional(`productProposal.status.${status}`) ?? status;
}

function typeLabel(type: string): string {
  return optional(`value.fieldType.${type}`) ?? type;
}

function aggregationLabel(aggregation: string): string {
  return optional(`value.aggregation.${aggregation}`) ?? aggregation;
}

function checkLabel(check: string): string {
  return optional(`productProposal.check.${check}`) ?? check;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '—';
}

function join(values: unknown): string {
  return Array.isArray(values) && values.length > 0 ? values.map(stringOf).join('、') : t('productProposal.contract.none');
}

function metricValue(value: unknown): string {
  return value === null || value === undefined ? '空' : stringOf(value);
}

/** The two Business Context Versions a Release pins, as the preview restates them. */
function pinnedContextText(value: unknown): string {
  const pins = recordOf(value);
  return `通用 ${stringOf(pins['common_business_context_version'])} · 工作区 ${stringOf(pins['workspace_business_context_version'])}`;
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
      {notice.text}
    </Alert>
  );
}

/** The Contract shape a Consumer would read, exactly as the candidate declares it. */
function ContractPanel({ contract }: { contract: ProductContractView }) {
  return (
    <Panel level={2} title={t('productProposal.candidate.title')} description={t('productProposal.candidate.description')}>
      <DefinitionList
        rows={[
          { term: t('productProposal.candidate.name'), value: contract.title },
          ...(contract.description === undefined ? [] : [{ term: t('productProposal.contract.metricDescription'), value: contract.description }]),
          { term: t('productProposal.contract.fields'), value: contract.fields.map((field) => field.name).join('、') },
          { term: t('productProposal.contract.dimensions'), value: join(contract.dimensions) },
          { term: t('productProposal.contract.grain'), value: join(contract.grain) },
          {
            term: t('productProposal.contract.time'),
            value: contract.time === undefined
              ? t('productProposal.contract.none')
              : `${contract.time.field} · ${typeLabel(contract.time.precision)} · ${contract.time.time_zone}`,
          },
          { term: t('productProposal.contract.filters'), value: join(contract.filters) },
          {
            term: t('productProposal.contract.limit'),
            value: message('productProposal.contract.limitValue', {
              default: String(contract.default_limit),
              max: String(contract.max_limit),
            }),
          },
        ]}
      />
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('productProposal.contract.metricName')}</th>
            <th scope="col">{t('productProposal.contract.metricAggregation')}</th>
            <th scope="col">{t('productProposal.contract.metricType')}</th>
            <th scope="col">{t('productProposal.contract.metricField')}</th>
            <th scope="col">{t('productProposal.contract.metricUnit')}</th>
            <th scope="col">{t('productProposal.contract.metricDescription')}</th>
          </tr>
        </thead>
        <tbody>
          {contract.metrics.map((metric) => (
            <tr key={metric.name}>
              <td className="data-table__mono">{metric.name}</td>
              <td>{aggregationLabel(metric.aggregation)}</td>
              <td>{typeLabel(metric.value_type)}</td>
              <td className="data-table__mono">{metric.field ?? '—'}</td>
              <td>{metric.unit ?? metric.currency ?? '—'}</td>
              <td>{metric.description ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function exampleQueryLabel(query: Record<string, unknown>): string {
  const limit = typeof query['limit'] === 'number' ? String(query['limit']) : '—';
  if (query['kind'] === 'aggregate') {
    const dimensions = Array.isArray(query['group_by']) && query['group_by'].length > 0
      ? join(query['group_by'])
      : t('productProposal.preview.queryNoDimensions');
    const metrics = join(query['metrics']);
    return message('productProposal.preview.queryAggregate', { dimensions, metrics, limit });
  }
  return message('productProposal.preview.queryRecords', { limit });
}

/** One representative result, reduced to what a reviewer needs to judge it. */
function ResultPanel({ result }: { result: Record<string, unknown> }) {
  const kind = result['kind'] === 'aggregate' ? t('productProposal.preview.kind.aggregate') : t('productProposal.preview.kind.records');
  const totals = recordOf(result['totals']);
  const metrics = recordOf(totals['metrics']);
  const totalText = Object.keys(metrics).length === 0
    ? t('productProposal.contract.none')
    : Object.entries(metrics).map(([name, value]) => `${name}=${metricValue(value)}`).join('、');
  const columns = Array.isArray(result['columns']) ? result['columns'].map(stringOf) : [];
  const records = Array.isArray(result['records']) ? result['records'].map(recordOf) : [];
  return (
    <>
      <DefinitionList
        rows={[
          { term: t('productProposal.preview.resultKind'), value: kind },
          ...(result['matched_count'] === undefined
            ? []
            : [{ term: t('productProposal.preview.matched'), value: stringOf(result['matched_count']) }]),
          ...(result['groups_total'] === undefined
            ? []
            : [{ term: t('productProposal.preview.groupsTotal'), value: stringOf(result['groups_total']) }]),
          ...(result['totals'] === undefined
            ? []
            : [{ term: t('productProposal.preview.totals'), value: totalText }]),
          ...(result['returned'] === undefined
            ? []
            : [{ term: t('productProposal.preview.returned'), value: stringOf(result['returned']) }]),
        ]}
      />
      {columns.length === 0 || records.length === 0 ? null : (
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th scope="col" key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={String(index)}>
                {columns.map((column) => (
                  <td className="data-table__mono" key={`${column}-${String(index)}`}>{stringOf(record[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function PreviewPanel({ preview, productName }: { preview: ProductProposalPreviewView; productName: string }) {
  const freshness = recordOf(preview.freshness);
  const provenance = recordOf(preview.provenance);
  const source = recordOf(provenance['source']);
  const businessContext = recordOf(provenance['business_context']);
  const narrative = typeof preview.narrative.text === 'string' ? preview.narrative.text : '';
  return (
    <>
      <DefinitionList
        rows={[
          { term: t('productProposal.preview.product'), value: productName },
          { term: t('productProposal.preview.method'), value: preview.api_shape.method, mono: true },
          { term: t('productProposal.preview.apiShape'), value: t('productProposal.preview.route') },
          { term: t('productProposal.preview.route'), value: preview.api_shape.route, mono: true },
          {
            term: t('productProposal.preview.apiPath'),
            value: preview.api_shape.api_path ?? t('productProposal.preview.apiPathNone'),
            mono: preview.api_shape.api_path !== null,
          },
          { term: t('productProposal.preview.evidence'), value: preview.evidence_hash, mono: true },
        ]}
      />
      <h3 className="panel__title">{t('productProposal.preview.exampleQueries')}</h3>
      <ol className="context-history">
        {preview.example_queries.map((query, index) => (
          <li className="context-history__item" key={String(index)}>
            <p>{exampleQueryLabel(query)}</p>
          </li>
        ))}
      </ol>
      <h3 className="panel__title">{t('productProposal.preview.results')}</h3>
      {preview.representative_results.map((result, index) => (
        <ResultPanel key={String(index)} result={result} />
      ))}
      <h3 className="panel__title">{t('productProposal.preview.freshness')}</h3>
      <DefinitionList
        rows={[
          { term: t('productProposal.preview.release'), value: stringOf(freshness['dataset_release']) },
          { term: t('productProposal.preview.recordCount'), value: stringOf(freshness['dataset_record_count']) },
          { term: t('productProposal.preview.releasedAt'), value: formatInstant(stringOf(freshness['released_at'])) },
          { term: t('productProposal.preview.acquiredAt'), value: formatInstant(stringOf(freshness['acquired_at'])) },
          { term: t('productProposal.preview.integratedAt'), value: formatInstant(stringOf(freshness['integrated_at'])) },
          ...(freshness['time'] === null || freshness['time'] === undefined
            ? []
            : [{
              term: t('productProposal.preview.timeField'),
              value: `${stringOf(recordOf(freshness['time'])['field'])} · ${stringOf(recordOf(freshness['time'])['precision'])} · ${stringOf(recordOf(freshness['time'])['time_zone'])}`,
            }]),
        ]}
      />
      <h3 className="panel__title">{t('productProposal.preview.provenance')}</h3>
      <DefinitionList
        rows={[
          { term: t('productProposal.source.select'), value: `${stringOf(source['name'])} · ${stringOf(source['source_id'])}` },
          { term: t('productProposal.preview.release'), value: stringOf(provenance['dataset_release']) },
          { term: t('productProposal.preview.recordCount'), value: stringOf(provenance['record_count']) },
          { term: t('productProposal.evidence.context'), value: pinnedContextText(businessContext) },
        ]}
      />
      <h3 className="panel__title">{t('productProposal.preview.narrative')}</h3>
      <p className="empty">{narrative === '' ? t('productProposal.preview.narrativeEmpty') : narrative}</p>
    </>
  );
}

function ProvenancePanel({
  provenance,
  createdBy,
}: {
  provenance: ProductProposalProvenanceView;
  createdBy: string;
}) {
  return (
    <Panel level={2} title={t('productProposal.provenance.title')}>
      <DefinitionList
        rows={[
          { term: t('productProposal.provenance.model'), value: `${provenance.model_id} · v${String(provenance.model_profile_version)}` },
          { term: t('productProposal.provenance.adapter'), value: provenance.adapter, mono: true },
          { term: t('productProposal.provenance.profileHash'), value: provenance.model_profile_content_hash, mono: true },
          { term: t('productProposal.provenance.binding'), value: provenance.binding_id, mono: true },
          { term: t('productProposal.provenance.prompt'), value: `${provenance.prompt_id} · ${provenance.prompt_hash}`, mono: true },
          { term: t('productProposal.provenance.requirement'), value: provenance.requirement_hash, mono: true },
          { term: t('productProposal.provenance.validation'), value: provenance.validation_hash === '' ? '—' : provenance.validation_hash, mono: true },
          { term: t('productProposal.provenance.preview'), value: provenance.preview_hash === '' ? '—' : provenance.preview_hash, mono: true },
          { term: t('productProposal.provenance.candidate'), value: provenance.candidate_content_hash, mono: true },
          { term: t('productProposal.provenance.proposal'), value: provenance.proposal_hash, mono: true },
          { term: t('productProposal.provenance.actor'), value: createdBy },
        ]}
      />
    </Panel>
  );
}

/** The immutable lifecycle facts: who approved, rejected, or published exactly what. */
function LifecyclePanel({ proposal }: { proposal: ProductProposalView }) {
  const rows: Array<{ at: string; action: string; actor: string; evidence: string; detail: string }> = [
    ...proposal.decisions.map((decision) => ({
      at: decision.decided_at,
      action: decision.outcome === 'approved'
        ? t('productProposal.lifecycle.approved')
        : t('productProposal.lifecycle.rejected'),
      actor: decision.decided_by,
      evidence: decision.evidence_hash,
      detail: decision.reason ?? '—',
    })),
    ...proposal.publications.map((publication) => ({
      at: publication.published_at,
      action: message('productProposal.lifecycle.published', { version: String(publication.data_product_version) }),
      actor: publication.published_by,
      evidence: publication.evidence_hash,
      detail: `API ${publication.api_path}`,
    })),
  ];
  return (
    <Panel level={2} title={t('productProposal.lifecycle.title')}>
      {rows.length === 0 ? (
        <p className="empty">{t('productProposal.lifecycle.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('productProposal.lifecycle.time')}</th>
              <th scope="col">{t('productProposal.lifecycle.action')}</th>
              <th scope="col">{t('productProposal.provenance.actor')}</th>
              <th scope="col">{t('productProposal.lifecycle.detail')}</th>
              <th scope="col">{t('productProposal.lifecycle.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.at}-${row.action}`}>
                <td>{formatInstant(row.at)}</td>
                <td>{row.action}</td>
                <td>{row.actor}</td>
                <td className="data-table__mono">{row.detail}</td>
                <td className="data-table__mono"><code>{row.evidence}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** The exact Data Product API a Publication made available, read back from the Proposal. */
function PublishedPanel({ proposal }: { proposal: ProductProposalView }) {
  const publication = proposal.publications[proposal.publications.length - 1];
  if (publication === undefined) return null;
  return (
    <Panel level={2} title={t('productProposal.published.title')} description={t('productProposal.published.description')}>
      <DefinitionList
        rows={[
          { term: t('productProposal.published.product'), value: proposal.candidates.name },
          { term: t('productProposal.published.apiPath'), value: publication.api_path, mono: true },
          { term: t('productProposal.published.version'), value: String(publication.data_product_version) },
          { term: t('productProposal.published.release'), value: String(publication.data_product_release) },
          { term: t('productProposal.published.datasetRelease'), value: String(publication.dataset_release) },
          { term: t('productProposal.published.contractHash'), value: publication.contract_hash, mono: true },
        ]}
      />
    </Panel>
  );
}

interface ProposalDetailProps {
  proposal: ProductProposalView;
  onChanged: (selectId?: string) => Promise<boolean>;
  onSessionLost: () => void;
}

/**
 * One Data Product Proposal: its Chinese requirement and clarifications, the
 * exact candidate Contract, the deterministic validation and representative
 * preview, then Approval and Publication as two visibly distinct actions. Every
 * decision, evidence address, and refusal stays on the server.
 */
function ProposalDetail({ proposal, onChanged, onSessionLost }: ProposalDetailProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [publishedPath, setPublishedPath] = useState<string | null>(null);

  const latestValidation = proposal.validations[proposal.validations.length - 1];
  const latestPreview = proposal.previews[proposal.previews.length - 1];
  const provenance: ProductProposalProvenanceView = proposal.decisions[proposal.decisions.length - 1]?.provenance
    ?? proposal.publications[proposal.publications.length - 1]?.provenance
    ?? {
      model_profile_id: proposal.model.model_profile_id,
      model_profile_version: proposal.model.model_profile_version,
      model_profile_content_hash: proposal.model.model_profile_content_hash,
      adapter: proposal.model.adapter,
      model_id: proposal.model.model_id,
      binding_id: proposal.binding_id,
      prompt_id: proposal.model.prompt_id,
      prompt_hash: proposal.model.prompt_hash,
      requirement_hash: proposal.requirement.hash,
      validation_hash: latestValidation?.evidence_hash ?? '',
      preview_hash: latestPreview?.evidence_hash ?? '',
      candidate_content_hash: proposal.candidates.content_hash,
      proposal_hash: proposal.proposal_hash,
    };

  function reportFailure(error: ApiError): void {
    setNotice({ tone: 'error', text: apiFailureText(error.code), code: error.code });
  }

  async function act(action: Action): Promise<void> {
    if (busy !== null) return;
    setBusy(action);
    setNotice(null);
    const result = action === 'approve'
      ? await platformApi.approveProductProposal(proposal.proposal_id)
      : action === 'reject'
        ? await platformApi.rejectProductProposal(proposal.proposal_id, reason.trim())
        : await platformApi.publishProductProposal(proposal.proposal_id);
    setBusy(null);
    setPendingAction(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      reportFailure(result.error);
      return;
    }
    await onChanged(proposal.proposal_id);
    if (action === 'approve') {
      setNotice({ tone: 'info', text: t('productProposal.approved') });
    } else if (action === 'reject') {
      setNotice({ tone: 'info', text: t('productProposal.rejected') });
    } else if ('api_path' in result.data) {
      setPublishedPath(result.data.api_path);
      setNotice({
        tone: 'info',
        text: message('productProposal.published', {
          name: proposal.candidates.name,
          version: String(result.data.data_product_version),
          path: result.data.api_path,
        }),
      });
    }
  }

  const stale = proposal.freshness !== undefined && !proposal.freshness.fresh;
  const currentRelease = proposal.freshness?.current?.dataset_release;

  return (
    <Panel level={2} title={t('productProposal.detail.title')}>
      <p className="binding__state">
        <StatusPill tone={STATUS_TONE[proposal.status]} label={statusLabel(proposal.status)} />
      </p>
      <NoticeLine notice={notice} />

      <DefinitionList
        rows={[
          { term: t('productProposal.requirement'), value: proposal.requirement.text },
          { term: t('productProposal.requirement.hash'), value: proposal.requirement.hash, mono: true },
          { term: t('productProposal.base.release'), value: String(proposal.base.dataset_release) },
          { term: t('productProposal.base.context'), value: String(proposal.base.workspace_business_context_version) },
          {
            term: t('productProposal.freshness.title'),
            value: stale ? t('productProposal.freshness.stale') : t('productProposal.freshness.fresh'),
          },
          ...(stale && currentRelease !== undefined
            ? [{ term: t('productProposal.freshness.current'), value: String(currentRelease) }]
            : []),
          { term: t('productProposal.model'), value: `${proposal.model.model_id} · v${String(proposal.model.model_profile_version)}` },
          { term: t('productProposal.prompt'), value: `${proposal.model.prompt_id} · ${proposal.model.prompt_hash}`, mono: true },
          { term: t('productProposal.evidence.release'), value: proposal.evidence.dataset_release_hash, mono: true },
          { term: t('productProposal.evidence.fields'), value: proposal.evidence.schema_fields.join('、') },
          { term: t('productProposal.evidence.metrics'), value: proposal.evidence.metric_definition_keys.join('、') },
          { term: t('productProposal.evidence.context'), value: proposal.evidence.business_context_hash, mono: true },
          { term: t('productProposal.candidate.hash'), value: proposal.candidates.contract_hash, mono: true },
          { term: t('productProposal.candidate.contentHash'), value: proposal.candidates.content_hash, mono: true },
          { term: t('productProposal.provenance.proposal'), value: proposal.proposal_hash, mono: true },
          { term: t('productProposal.provenance.actor'), value: proposal.created_by },
        ]}
      />

      <Panel level={2} title={t('productProposal.clarifications.title')}>
        {proposal.requirement.clarifications.length === 0 ? (
          <p className="empty">{t('productProposal.contract.none')}</p>
        ) : (
          <ol className="context-history">
            {proposal.requirement.clarifications.map((clarification, index) => (
              <li className="context-history__item" key={`${clarification.question}-${String(index)}`}>
                <p>{clarification.question}</p>
                <p className="context__meta">{clarification.answer}</p>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <ContractPanel contract={proposal.candidates.contract} />

      <Panel level={2} title={t('productProposal.validation.title')} description={t('productProposal.validation.description')}>
        {latestValidation === undefined ? (
          <p className="empty">{t('productProposal.validation.empty')}</p>
        ) : (
          <DefinitionList
            rows={[
              { term: t('productProposal.validation.validatedAt'), value: formatInstant(latestValidation.validated_at) },
              { term: t('productProposal.validation.release'), value: String(latestValidation.dataset_release) },
              { term: t('productProposal.validation.checks'), value: latestValidation.checks.map(checkLabel).join('、') },
              { term: t('productProposal.evidence.metrics'), value: latestValidation.metric_definition_keys.join('、') },
              { term: t('productProposal.provenance.validation'), value: latestValidation.evidence_hash, mono: true },
            ]}
          />
        )}
        {proposal.status !== 'pending' ? null : (
          <Button
            variant="secondary"
            busy={busy === 'validate'}
            onClick={() => {
              setBusy('validate');
              setNotice(null);
              void platformApi.validateProductProposal(proposal.proposal_id).then(async (result) => {
                setBusy(null);
                if (!result.ok) {
                  if (result.status === 401) {
                    onSessionLost();
                    return;
                  }
                  reportFailure(result.error);
                  return;
                }
                await onChanged(proposal.proposal_id);
                setNotice({ tone: 'info', text: t('productProposal.validation.passed') });
              });
            }}
          >
            {busy === 'validate' ? t('productProposal.validation.running') : t('productProposal.validation.run')}
          </Button>
        )}
        {latestValidation === undefined ? <p className="field__hint">{t('productProposal.validation.required')}</p> : null}
      </Panel>

      <Panel level={2} title={t('productProposal.preview.title')} description={t('productProposal.preview.description')}>
        {latestPreview === undefined ? (
          <p className="empty">{t('productProposal.preview.empty')}</p>
        ) : (
          <PreviewPanel preview={latestPreview} productName={proposal.candidates.name} />
        )}
        <p className="field__hint">{t('productProposal.preview.noWrites')}</p>
        {proposal.status !== 'pending' ? null : (
          <Button
            variant="secondary"
            busy={busy === 'preview'}
            onClick={() => {
              setBusy('preview');
              setNotice(null);
              void platformApi.previewProductProposal(proposal.proposal_id).then(async (result) => {
                setBusy(null);
                if (!result.ok) {
                  if (result.status === 401) {
                    onSessionLost();
                    return;
                  }
                  reportFailure(result.error);
                  return;
                }
                await onChanged(proposal.proposal_id);
              });
            }}
          >
            {busy === 'preview' ? t('productProposal.preview.running') : t('productProposal.preview.run')}
          </Button>
        )}
        {latestPreview === undefined ? <p className="field__hint">{t('productProposal.preview.required')}</p> : null}
      </Panel>

      <Panel level={2} title={t('productProposal.actions.title')} description={t('productProposal.actions.description')}>
        <div className="form__actions">
          <Button busy={busy === 'approve'} onClick={() => setPendingAction('approve')}>
            {t('productProposal.approve')}
          </Button>
          <Button variant="secondary" busy={busy === 'publish'} onClick={() => setPendingAction('publish')}>
            {t('productProposal.publish')}
          </Button>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="product-proposal-reject-reason">
            {t('productProposal.reject.reason')}
          </label>
          <textarea
            className="field__input field__input--area"
            id="product-proposal-reject-reason"
            value={reason}
            rows={2}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <Button variant="quiet" busy={busy === 'reject'} onClick={() => setPendingAction('reject')}>
          {t('productProposal.reject')}
        </Button>

        {pendingAction === 'approve' ? (
          <Confirmation
            title={t('productProposal.confirm.approveTitle')}
            target={message('productProposal.confirm.target', { proposal: proposal.proposal_id })}
            scope={t('productProposal.confirm.scope')}
            consequence={t('productProposal.confirm.approveConsequence')}
            confirmLabel={t('productProposal.confirm.approve')}
            busy={busy === 'approve'}
            onConfirm={() => void act('approve')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
        {pendingAction === 'publish' ? (
          <Confirmation
            title={t('productProposal.confirm.publishTitle')}
            target={message('productProposal.confirm.target', { proposal: proposal.proposal_id })}
            scope={t('productProposal.confirm.scope')}
            consequence={t('productProposal.confirm.publishConsequence')}
            confirmLabel={t('productProposal.confirm.publish')}
            busy={busy === 'publish'}
            onConfirm={() => void act('publish')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
        {pendingAction === 'reject' ? (
          <Confirmation
            title={t('productProposal.confirm.rejectTitle')}
            target={message('productProposal.confirm.target', { proposal: proposal.proposal_id })}
            scope={t('productProposal.confirm.scope')}
            consequence={t('productProposal.confirm.rejectConsequence')}
            confirmLabel={t('productProposal.confirm.reject')}
            busy={busy === 'reject'}
            onConfirm={() => void act('reject')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
        {publishedPath === null ? null : <p className="data-table__mono">{publishedPath}</p>}
      </Panel>

      <PublishedPanel proposal={proposal} />
      <LifecyclePanel proposal={proposal} />
      <ProvenancePanel provenance={provenance} createdBy={proposal.created_by} />
    </Panel>
  );
}

/**
 * The Workspace Administrator's Data Product Proposal surface. The browser states
 * a Chinese requirement, renders the Contract and evidence the governed module
 * produced, and performs the two exact actions; it holds no business logic.
 */
export function WorkspaceProductProposals({ workspaceId, onSessionLost }: WorkspaceProductProposalsProps) {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [bindings, setBindings] = useState<ModelBindingView[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [bindingId, setBindingId] = useState('');
  const [proposals, setProposals] = useState<ProductProposalView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [requirement, setRequirement] = useState('');
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');

  const loadProposals = useCallback(async (id: string, select?: string): Promise<boolean> => {
    const result = await platformApi.productProposals(id);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return false;
      }
      setFailed(true);
      return false;
    }
    setFailed(false);
    setProposals(result.data.proposals);
    setSelectedId((current) => {
      if (select !== undefined) return select;
      return result.data.proposals.some((proposal) => proposal.proposal_id === current)
        ? current
        : (result.data.proposals[0]?.proposal_id ?? null);
    });
    return true;
  }, [onSessionLost]);

  useEffect(() => {
    let active = true;
    void platformApi.sources(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setSources(result.data.sources);
    });
    void platformApi.modelBindings(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setBindings(result.data.bindings);
      setBindingId((current) => current !== '' ? current : (result.data.bindings[0]?.binding_id ?? ''));
    });
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    if (sourceId === '') {
      setProposals(null);
      setSelectedId(null);
      return;
    }
    let active = true;
    setProposals(null);
    setSelectedId(null);
    setNotice(null);
    setClarification(null);
    void platformApi.productProposals(sourceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setProposals(result.data.proposals);
      setSelectedId(result.data.proposals[0]?.proposal_id ?? null);
    });
    return () => {
      active = false;
    };
  }, [sourceId, onSessionLost]);

  async function generate(clarifications: Array<{ question: string; answer: string }>): Promise<void> {
    if (bindingId === '') {
      setNotice({ tone: 'error', text: t('productProposal.binding.missing') });
      return;
    }
    if (name.trim() === '') {
      setNotice({ tone: 'error', text: t('productProposal.generate.nameMissing') });
      return;
    }
    if (requirement.trim() === '') {
      setNotice({ tone: 'error', text: t('productProposal.requirement.missing') });
      return;
    }
    setGenerating(true);
    setNotice(null);
    const result = await platformApi.generateProductProposal(sourceId, {
      binding_id: bindingId,
      name: name.trim(),
      requirement: requirement.trim(),
      clarifications,
    });
    setGenerating(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      if (result.error.code === 'PRODUCT_PROPOSAL_CLARIFICATION_REQUIRED') {
        setClarification(result.error.message ?? apiFailureText(result.error.code));
        setNotice({ tone: 'error', text: t('productProposal.clarification.description') });
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setClarification(null);
    setAnswer('');
    await loadProposals(sourceId, result.data.proposal_id);
    setNotice({ tone: 'info', text: t('productProposal.generated') });
  }

  const selected = proposals?.find((proposal) => proposal.proposal_id === selectedId) ?? null;

  return (
    <Panel level={1} title={t('productProposal.title')} description={t('productProposal.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}

      <Panel level={2} title={t('productProposal.source.title')} description={t('productProposal.source.description')}>
        {sources === null ? (
          <p className="empty" role="status">{t('platform.loading')}</p>
        ) : sources.length === 0 ? (
          <p className="empty">{t('productProposal.source.empty')}</p>
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="product-proposal-source">
              {t('productProposal.source.select')}
            </label>
            <select
              className="field__input"
              id="product-proposal-source"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">{t('productProposal.source.choose')}</option>
              {sources.map((source) => (
                <option key={source.source_id} value={source.source_id}>{source.name}</option>
              ))}
            </select>
          </div>
        )}
      </Panel>

      <Panel level={2} title={t('productProposal.generate.title')} description={t('productProposal.generate.description')}>
        <NoticeLine notice={notice} />
        {bindings === null ? (
          <p className="empty" role="status">{t('platform.loading')}</p>
        ) : bindings.length === 0 ? (
          <p className="empty">{t('productProposal.binding.empty')}</p>
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="product-proposal-binding">
              {t('productProposal.binding.select')}
            </label>
            <select
              className="field__input"
              id="product-proposal-binding"
              value={bindingId}
              onChange={(event) => setBindingId(event.target.value)}
            >
              {bindings.map((binding) => (
                <option key={binding.binding_id} value={binding.binding_id}>
                  {`${binding.model_profile_name ?? binding.model_profile_id} · v${String(binding.model_profile_version)}`}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="product-proposal-name">
            {t('productProposal.generate.name')}
          </label>
          <input
            className="field__input"
            id="product-proposal-name"
            type="text"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="field__hint">{t('productProposal.generate.nameHint')}</p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="product-proposal-requirement">
            {t('productProposal.requirement')}
          </label>
          <textarea
            className="field__input field__input--area"
            id="product-proposal-requirement"
            value={requirement}
            rows={3}
            maxLength={4000}
            onChange={(event) => setRequirement(event.target.value)}
          />
          <p className="field__hint">{t('productProposal.requirement.hint')}</p>
        </div>
        <Button busy={generating} onClick={() => void generate([])}>
          {generating ? t('productProposal.generating') : t('productProposal.generate.submit')}
        </Button>
      </Panel>

      {clarification === null ? null : (
        <Panel level={2} title={t('productProposal.clarification.title')} description={t('productProposal.clarification.description')}>
          <p role="status">{clarification}</p>
          <div className="field">
            <label className="field__label" htmlFor="product-proposal-clarification-answer">
              {t('productProposal.clarification.answer')}
            </label>
            <textarea
              className="field__input field__input--area"
              id="product-proposal-clarification-answer"
              value={answer}
              rows={2}
              maxLength={2000}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </div>
          <Button
            busy={generating}
            onClick={() => void generate([{ question: clarification, answer: answer.trim() }])}
          >
            {generating ? t('productProposal.generating') : t('productProposal.clarification.submit')}
          </Button>
        </Panel>
      )}

      <Panel level={2} title={t('productProposal.list.title')}>
        {proposals === null || proposals.length === 0 ? (
          <p className="empty">{t('productProposal.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('productProposal.list.status')}</th>
                <th scope="col">{t('productProposal.list.name')}</th>
                <th scope="col">{t('productProposal.list.baseRelease')}</th>
                <th scope="col">{t('productProposal.list.freshness')}</th>
                <th scope="col">{t('productProposal.list.createdAt')}</th>
                <th scope="col">{t('workspace.members.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => (
                <tr key={proposal.proposal_id}>
                  <td>{statusLabel(proposal.status)}</td>
                  <td>{proposal.candidates.name}</td>
                  <td>{proposal.base.dataset_release}</td>
                  <td>{proposal.freshness === undefined || proposal.freshness.fresh
                    ? t('productProposal.freshness.fresh')
                    : t('productProposal.freshness.changed')}</td>
                  <td>{formatInstant(proposal.created_at)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      busy={selectedId === proposal.proposal_id}
                      onClick={() => setSelectedId(proposal.proposal_id)}
                    >
                      {t('productProposal.list.inspect')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {selected === null ? (
        <p className="empty">{t('productProposal.select')}</p>
      ) : (
        <ProposalDetail
          key={selected.proposal_id}
          proposal={selected}
          onChanged={async (selectId) => loadProposals(sourceId, selectId)}
          onSessionLost={onSessionLost}
        />
      )}
    </Panel>
  );
}
