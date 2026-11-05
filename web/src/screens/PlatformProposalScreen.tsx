import { useCallback, useEffect, useRef, useState } from 'react';
import {
  platformApi,
  type ApiError,
  type ModelBindingView,
  type ProposalProvenanceView,
  type ProposalView,
  type SourceSummary,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Alert, DefinitionList, Panel, StatusPill } from '../ui/Panel.js';

export interface WorkspaceProposalsProps {
  workspaceId: string;
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

type Action = 'approve' | 'reject' | 'publish' | 'adopt';

const STATUS_TONE: Record<ProposalView['status'], 'ok' | 'warn'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'warn',
  published: 'ok',
  adopted: 'ok',
};

function statusLabel(status: ProposalView['status']): string {
  return optional(`proposal.status.${status}`) ?? status;
}

function typeLabel(type: string): string {
  return optional(`value.fieldType.${type}`) ?? type;
}

function cleaningLabel(rule: string, field: string, value?: string): string {
  return value === undefined ? `${rule}:${field}` : `${rule}:${field}=${value}`;
}

function reasonLabel(reason: string): string {
  return optional(`value.rejectionReason.${reason}`) ?? reason;
}

function join(values: string[]): string {
  return values.length === 0 ? t('proposal.drift.none') : values.join('、');
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
      {notice.text}
    </Alert>
  );
}

interface TransformationRow {
  row: number;
  field: string;
  rule: string;
  before: string;
  after: string;
}

/** Every value a cleaning rule changed, as the engine reported it. */
function TransformationTable({ items }: { items: TransformationRow[] }) {
  if (items.length === 0) return null;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{t('proposal.transformation.row')}</th>
          <th scope="col">{t('proposal.transformation.field')}</th>
          <th scope="col">{t('proposal.transformation.rule')}</th>
          <th scope="col">{t('proposal.transformation.before')}</th>
          <th scope="col">{t('proposal.transformation.after')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${String(item.row)}-${item.field}-${item.rule}-${String(index)}`}>
            <td>{item.row}</td>
            <td>{item.field}</td>
            <td>{item.rule}</td>
            <td className="data-table__mono">{item.before}</td>
            <td className="data-table__mono">{item.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RejectionTable({ items }: { items: Array<{ row: number; field: string | null; reason: string; rule: string }> }) {
  if (items.length === 0) return null;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{t('workspace.sources.rejections.row')}</th>
          <th scope="col">{t('workspace.sources.rejections.field')}</th>
          <th scope="col">{t('workspace.sources.rejections.reason')}</th>
          <th scope="col">{t('workspace.sources.rejections.code')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${String(item.row)}-${item.field ?? ''}-${item.reason}-${String(index)}`}>
            <td>{item.row}</td>
            <td>{item.field ?? '—'}</td>
            <td>{reasonLabel(item.reason)}</td>
            <td className="data-table__mono"><code>{item.reason}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What the candidate would change relative to its base and the real raw table. */
function DriftList({ drift }: { drift: ProposalView['validations'][number]['fixtures'][number]['drift'] }) {
  return (
    <DefinitionList
      rows={[
        { term: t('proposal.drift.schemaAdded'), value: join(drift.schema.added) },
        { term: t('proposal.drift.schemaRemoved'), value: join(drift.schema.removed) },
        {
          term: t('proposal.drift.schemaRetyped'),
          value: join(drift.schema.retyped.map((entry) => `${entry.field}: ${typeLabel(entry.from)} → ${typeLabel(entry.to)}`)),
        },
        { term: t('proposal.drift.cleaningAdded'), value: join(drift.cleaning.added) },
        { term: t('proposal.drift.cleaningRemoved'), value: join(drift.cleaning.removed) },
        { term: t('proposal.drift.mappingAdded'), value: join(drift.mapping.added) },
        { term: t('proposal.drift.mappingRemoved'), value: join(drift.mapping.removed) },
        {
          term: t('proposal.drift.mappingRetargeted'),
          value: join(drift.mapping.retargeted.map((entry) => `${entry.column}: ${entry.from} → ${entry.to}`)),
        },
        { term: t('proposal.drift.unmapped'), value: join(drift.raw_columns.unmapped) },
        { term: t('proposal.drift.missing'), value: join(drift.raw_columns.missing) },
      ]}
    />
  );
}

function ProvenancePanel({ provenance, createdBy }: { provenance: ProposalProvenanceView; createdBy: string }) {
  return (
    <Panel level={2} title={t('proposal.provenance.title')}>
      <DefinitionList
        rows={[
          { term: t('proposal.provenance.model'), value: `${provenance.model_id} · v${String(provenance.model_profile_version)}` },
          { term: t('proposal.provenance.adapter'), value: provenance.adapter, mono: true },
          { term: t('proposal.provenance.profileHash'), value: provenance.model_profile_content_hash, mono: true },
          { term: t('proposal.provenance.binding'), value: provenance.binding_id, mono: true },
          { term: t('proposal.provenance.prompt'), value: `${provenance.prompt_id} · ${provenance.prompt_hash}`, mono: true },
          ...(provenance.requirement_hash === undefined
            ? []
            : [{ term: t('proposal.provenance.requirement'), value: provenance.requirement_hash, mono: true }]),
          { term: t('proposal.provenance.evidence'), value: provenance.data_dictionary_hash, mono: true },
          { term: t('proposal.provenance.validation'), value: provenance.validation_hash === '' ? '—' : provenance.validation_hash, mono: true },
          { term: t('proposal.provenance.preview'), value: provenance.preview_hash === '' ? '—' : provenance.preview_hash, mono: true },
          { term: t('proposal.provenance.candidate'), value: provenance.candidate_content_hash, mono: true },
          { term: t('proposal.provenance.proposal'), value: provenance.proposal_hash, mono: true },
          { term: t('proposal.provenance.actor'), value: createdBy },
        ]}
      />
    </Panel>
  );
}

/** The immutable lifecycle facts: who decided, published, and adopted exactly what. */
function LifecyclePanel({ proposal }: { proposal: ProposalView }) {
  const rows: Array<{ at: string; action: string; actor: string; evidence: string; detail: string }> = [
    ...proposal.decisions.map((decision) => ({
      at: decision.decided_at,
      action: decision.outcome === 'approved' ? t('proposal.lifecycle.approved') : t('proposal.lifecycle.rejected'),
      actor: decision.decided_by,
      evidence: decision.evidence_hash,
      detail: decision.reason ?? '—',
    })),
    ...proposal.publications.map((publication) => ({
      at: publication.published_at,
      action: message('proposal.lifecycle.published', { version: String(publication.integration_configuration_version) }),
      actor: publication.published_by,
      evidence: publication.evidence_hash,
      detail: '—',
    })),
    ...proposal.adoptions.map((adoption) => ({
      at: adoption.adopted_at,
      action: message('proposal.lifecycle.adopted', { version: String(adoption.integration_configuration_version) }),
      actor: adoption.adopted_by,
      evidence: adoption.evidence_hash,
      detail: '—',
    })),
  ];
  return (
    <Panel level={2} title={t('proposal.lifecycle.title')}>
      {rows.length === 0 ? (
        <p className="empty">{t('proposal.lifecycle.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('proposal.lifecycle.time')}</th>
              <th scope="col">{t('proposal.lifecycle.action')}</th>
              <th scope="col">{t('proposal.provenance.actor')}</th>
              <th scope="col">{t('proposal.lifecycle.detail')}</th>
              <th scope="col">{t('proposal.provenance.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.at}-${row.action}`}>
                <td>{formatInstant(row.at)}</td>
                <td>{row.action}</td>
                <td>{row.actor}</td>
                <td>{row.detail}</td>
                <td className="data-table__mono"><code>{row.evidence}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

interface ProposalDetailProps {
  proposal: ProposalView;
  rawAcquisitions: Array<{ raw_id: string; received_at: string }>;
  onChanged: (selectId?: string) => Promise<boolean>;
  onSessionLost: () => void;
}

/**
 * One Proposal: the exact candidates, the requirement and dictionary evidence,
 * deterministic validation and isolated preview, then the three visibly
 * distinct actions. Every decision, run, and refusal stays on the server.
 */
function ProposalDetail({ proposal, rawAcquisitions, onChanged, onSessionLost }: ProposalDetailProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [rawId, setRawId] = useState(rawAcquisitions[0]?.raw_id ?? '');
  const fixturesInput = useRef<HTMLInputElement | null>(null);

  const latestValidation = proposal.validations[proposal.validations.length - 1];
  const latestPreview = proposal.previews[proposal.previews.length - 1];
  const provenance: ProposalProvenanceView = proposal.decisions[proposal.decisions.length - 1]?.provenance
    ?? proposal.publications[proposal.publications.length - 1]?.provenance
    ?? proposal.adoptions[proposal.adoptions.length - 1]?.provenance
    ?? {
      model_profile_id: proposal.model.model_profile_id,
      model_profile_version: proposal.model.model_profile_version,
      model_profile_content_hash: proposal.model.model_profile_content_hash,
      adapter: proposal.model.adapter,
      model_id: proposal.model.model_id,
      binding_id: proposal.binding_id,
      prompt_id: proposal.model.prompt_id,
      prompt_hash: proposal.model.prompt_hash,
      ...(proposal.requirement === undefined ? {} : { requirement_hash: proposal.requirement.hash }),
      data_dictionary_hash: proposal.evidence.data_dictionary_hash,
      validation_hash: latestValidation?.evidence_hash ?? '',
      preview_hash: latestPreview?.evidence_hash ?? '',
      candidate_content_hash: proposal.candidates.integration_configuration.content_hash,
      proposal_hash: proposal.proposal_hash,
    };

  function reportFailure(error: ApiError): void {
    setNotice({ tone: 'error', text: apiFailureText(error.code), code: error.code });
  }

  async function runValidation(): Promise<void> {
    const chosen = fixturesInput.current?.files?.[0] ?? null;
    if (chosen === null) {
      setNotice({ tone: 'error', text: t('proposal.validation.fixturesMissing') });
      return;
    }
    setBusy('validate');
    setNotice(null);
    const result = await platformApi.validateProposal(proposal.proposal_id, await chosen.text());
    setBusy(null);
    if (fixturesInput.current !== null) fixturesInput.current.value = '';
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      reportFailure(result.error);
      return;
    }
    await onChanged(proposal.proposal_id);
    setNotice({ tone: 'info', text: t('proposal.validation.passed') });
  }

  async function runPreview(): Promise<void> {
    if (rawId === '') {
      setNotice({ tone: 'error', text: t('proposal.preview.rawMissing') });
      return;
    }
    setBusy('preview');
    setNotice(null);
    const result = await platformApi.previewProposal(proposal.proposal_id, rawId);
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
    setNotice({ tone: 'info', text: t('proposal.preview.passed') });
  }

  async function act(action: Action): Promise<void> {
    if (busy !== null) return;
    setBusy(action);
    setNotice(null);
    const result = action === 'approve'
      ? await platformApi.approveProposal(proposal.proposal_id)
      : action === 'reject'
        ? await platformApi.rejectProposal(proposal.proposal_id, reason.trim())
        : action === 'publish'
          ? await platformApi.publishProposal(proposal.proposal_id)
          : await platformApi.adoptProposal(proposal.proposal_id);
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
      setNotice({ tone: 'info', text: t('proposal.approved') });
    } else if (action === 'reject') {
      setNotice({ tone: 'info', text: t('proposal.rejected') });
    } else if (action === 'publish' && 'integration_configuration_version' in result.data) {
      setNotice({
        tone: 'info',
        text: message('proposal.published', { version: String(result.data.integration_configuration_version) }),
      });
    } else if (action === 'adopt' && 'adopted_version' in result.data) {
      setNotice({
        tone: 'info',
        text: message('proposal.adopted', { version: String(result.data.adopted_version) }),
      });
    }
  }

  return (
    <Panel level={2} title={t('proposal.detail.title')}>
      <p className="binding__state">
        <StatusPill tone={STATUS_TONE[proposal.status]} label={statusLabel(proposal.status)} />
      </p>
      <NoticeLine notice={notice} />

      <DefinitionList
        rows={[
          { term: t('proposal.requirement'), value: proposal.requirement?.text ?? t('proposal.requirement.missing') },
          ...(proposal.requirement === undefined
            ? []
            : [{ term: t('proposal.requirement.hash'), value: proposal.requirement.hash, mono: true }]),
          {
            term: t('proposal.base'),
            value: proposal.base.integration_configuration_version === null
              ? t('proposal.base.empty')
              : String(proposal.base.integration_configuration_version),
          },
          {
            term: t('proposal.freshness.title'),
            value: proposal.freshness === undefined || proposal.freshness.fresh
              ? t('proposal.freshness.fresh')
              : t('proposal.freshness.stale'),
          },
          { term: t('proposal.model'), value: `${proposal.model.model_id} · v${String(proposal.model.model_profile_version)}` },
          { term: t('proposal.prompt'), value: `${proposal.model.prompt_id} · ${proposal.model.prompt_hash}`, mono: true },
          { term: t('proposal.evidence'), value: proposal.evidence.data_dictionary_hash, mono: true },
          { term: t('proposal.evidence.fields'), value: proposal.evidence.data_dictionary_fields.join('、') },
          { term: t('proposal.provenance.proposal'), value: proposal.proposal_hash, mono: true },
          { term: t('proposal.provenance.actor'), value: proposal.created_by },
        ]}
      />

      {proposal.requirement === undefined || proposal.requirement.clarifications.length === 0 ? null : (
        <Panel level={2} title={t('proposal.clarification.title')} description={t('proposal.clarification.description')}>
          <ol className="context-history">
            {proposal.requirement.clarifications.map((clarification, index) => (
              <li className="context-history__item" key={`${clarification.question}-${String(index)}`}>
                <p>{clarification.question}</p>
                <p className="context__meta">{clarification.answer}</p>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      <Panel level={2} title={t('proposal.candidate.title')} description={t('proposal.candidate.description')}>
        <DefinitionList
          rows={[
            {
              term: t('proposal.candidate.schema'),
              value: `${message('proposal.candidate.version', { version: String(proposal.candidates.schema.candidate_version) })} · ${proposal.candidates.schema.fields.map((field) => `${field.name}: ${typeLabel(field.type)}`).join('、')}`,
            },
            {
              term: t('proposal.candidate.cleaning'),
              value: proposal.candidates.cleaning.rules.length === 0
                ? t('proposal.drift.none')
                : proposal.candidates.cleaning.rules.map((rule) => cleaningLabel(rule.rule, rule.field, rule.value)).join('、'),
            },
            {
              term: t('proposal.candidate.mapping'),
              value: Object.entries(proposal.candidates.mapping.mapping)
                .map(([column, target]) => `${column} → ${target}`)
                .join('、'),
            },
            {
              term: t('proposal.candidate.integration'),
              value: message('proposal.candidate.version', {
                version: String(proposal.candidates.integration_configuration.version),
              }),
            },
            {
              term: t('proposal.candidate.identity'),
              value: proposal.candidates.integration_configuration.identity_fields.join('、'),
            },
            { term: t('proposal.candidate.hash'), value: proposal.candidates.integration_configuration.content_hash, mono: true },
          ]}
        />
      </Panel>

      <Panel level={2} title={t('proposal.validation.title')}>
        {latestValidation === undefined ? (
          <p className="empty">{t('proposal.validation.empty')}</p>
        ) : (
          <>
            <DefinitionList
              rows={[
                { term: t('proposal.validation.validatedAt'), value: formatInstant(latestValidation.validated_at) },
                { term: t('proposal.provenance.validation'), value: latestValidation.evidence_hash, mono: true },
                ...latestValidation.fixtures.map((fixture) => ({
                  term: message('proposal.validation.fixture', { name: fixture.name }),
                  value: message('proposal.validation.counts', {
                    records: String(fixture.record_count),
                    transformed: String(fixture.transformed),
                    rejected: String(fixture.rejected),
                  }),
                })),
              ]}
            />
            <TransformationTable items={latestValidation.fixtures.flatMap((fixture) => fixture.transformations)} />
            <RejectionTable items={latestValidation.fixtures.flatMap((fixture) => fixture.rejections)} />
            {latestValidation.fixtures[0] === undefined ? null : <DriftList drift={latestValidation.fixtures[0].drift} />}
          </>
        )}
        <div className="field">
          <label className="field__label" htmlFor="proposal-fixtures">
            {t('proposal.validation.fixtures')}
          </label>
          <input className="field__input" id="proposal-fixtures" type="file" accept="application/json,.json" ref={fixturesInput} />
        </div>
        <Button variant="secondary" busy={busy === 'validate'} onClick={() => void runValidation()}>
          {busy === 'validate' ? t('proposal.validation.running') : t('proposal.validation.run')}
        </Button>
        {latestValidation === undefined ? <p className="field__hint">{t('proposal.validation.required')}</p> : null}
      </Panel>

      <Panel level={2} title={t('proposal.preview.title')} description={t('proposal.preview.noWrites')}>
        {latestPreview === undefined ? (
          <p className="empty">{t('proposal.preview.empty')}</p>
        ) : (
          <>
            <DefinitionList
              rows={[
                { term: t('proposal.preview.raw'), value: latestPreview.raw_id, mono: true },
                { term: t('proposal.preview.recordCount'), value: String(latestPreview.record_count) },
                { term: t('proposal.preview.transformed'), value: String(latestPreview.transformed) },
                { term: t('proposal.preview.rejected'), value: String(latestPreview.rejected) },
                { term: t('proposal.preview.evidence'), value: latestPreview.evidence_hash, mono: true },
              ]}
            />
            <TransformationTable items={latestPreview.transformations} />
            <RejectionTable items={latestPreview.rejections} />
            <DriftList drift={latestPreview.drift} />
          </>
        )}
        <div className="field">
          <label className="field__label" htmlFor="proposal-preview-raw">
            {t('proposal.preview.rawSelect')}
          </label>
          <select
            className="field__input"
            id="proposal-preview-raw"
            value={rawId}
            onChange={(event) => setRawId(event.target.value)}
          >
            <option value="">{t('proposal.preview.rawEmpty')}</option>
            {rawAcquisitions.map((raw) => (
              <option key={raw.raw_id} value={raw.raw_id}>
                {`${raw.raw_id} · ${formatInstant(raw.received_at)}`}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" busy={busy === 'preview'} onClick={() => void runPreview()}>
          {busy === 'preview' ? t('proposal.preview.running') : t('proposal.preview.run')}
        </Button>
        {latestPreview === undefined ? <p className="field__hint">{t('proposal.preview.required')}</p> : null}
      </Panel>

      <Panel level={2} title={t('proposal.actions.title')} description={t('proposal.actions.description')}>
        <div className="form__actions">
          <Button busy={busy === 'approve'} onClick={() => setPendingAction('approve')}>
            {t('proposal.approve')}
          </Button>
          <Button variant="secondary" busy={busy === 'publish'} onClick={() => setPendingAction('publish')}>
            {t('proposal.publish')}
          </Button>
          <Button variant="secondary" busy={busy === 'adopt'} onClick={() => setPendingAction('adopt')}>
            {t('proposal.adopt')}
          </Button>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="proposal-reject-reason">
            {t('proposal.reject.reason')}
          </label>
          <textarea
            className="field__input field__input--area"
            id="proposal-reject-reason"
            value={reason}
            rows={2}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <Button variant="quiet" busy={busy === 'reject'} onClick={() => setPendingAction('reject')}>
          {t('proposal.reject')}
        </Button>

        {pendingAction === 'approve' ? (
          <Confirmation
            title={t('proposal.confirm.approveTitle')}
            target={message('proposal.confirm.target', { proposal: proposal.proposal_id })}
            scope={t('proposal.confirm.scope')}
            consequence={t('proposal.confirm.approveConsequence')}
            confirmLabel={t('proposal.confirm.approve')}
            busy={busy === 'approve'}
            onConfirm={() => void act('approve')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
        {pendingAction === 'publish' ? (
          <Confirmation
            title={t('proposal.confirm.publishTitle')}
            target={message('proposal.confirm.version', {
              version: String(proposal.candidates.integration_configuration.version),
            })}
            scope={t('proposal.confirm.scope')}
            consequence={t('proposal.confirm.publishConsequence')}
            confirmLabel={t('proposal.confirm.publish')}
            busy={busy === 'publish'}
            onConfirm={() => void act('publish')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
        {pendingAction === 'adopt' ? (
          <Confirmation
            title={t('proposal.confirm.adoptTitle')}
            target={message('proposal.confirm.version', {
              version: String(proposal.candidates.integration_configuration.version),
            })}
            scope={t('proposal.confirm.scope')}
            consequence={t('proposal.confirm.adoptConsequence')}
            confirmLabel={t('proposal.confirm.adopt')}
            busy={busy === 'adopt'}
            onConfirm={() => void act('adopt')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
        {pendingAction === 'reject' ? (
          <Confirmation
            title={t('proposal.confirm.rejectTitle')}
            target={message('proposal.confirm.target', { proposal: proposal.proposal_id })}
            scope={t('proposal.confirm.scope')}
            consequence={t('proposal.confirm.rejectConsequence')}
            confirmLabel={t('proposal.confirm.reject')}
            busy={busy === 'reject'}
            onConfirm={() => void act('reject')}
            onCancel={() => setPendingAction(null)}
          />
        ) : null}
      </Panel>

      <LifecyclePanel proposal={proposal} />
      <ProvenancePanel provenance={provenance} createdBy={proposal.created_by} />
    </Panel>
  );
}

/**
 * The Workspace Administrator's Artifact Proposal surface. The browser states a
 * requirement, reads the dictionary and fixtures from files, and renders the
 * evidence the governed module produced; it makes no approval, freshness, or
 * authorization decision of its own.
 */
export function WorkspaceProposals({ workspaceId, onSessionLost }: WorkspaceProposalsProps) {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [bindings, setBindings] = useState<ModelBindingView[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [bindingId, setBindingId] = useState('');
  const [list, setList] = useState<{
    raw_acquisitions: Array<{ raw_id: string; received_at: string }>;
    proposals: ProposalView[];
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [requirement, setRequirement] = useState('');
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const dictionaryInput = useRef<HTMLInputElement | null>(null);

  const loadProposals = useCallback(async (id: string, select?: string): Promise<boolean> => {
    const result = await platformApi.proposals(id);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return false;
      }
      setFailed(true);
      return false;
    }
    setFailed(false);
    setList({ proposals: result.data.proposals, raw_acquisitions: result.data.raw_acquisitions });
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
      setList(null);
      setSelectedId(null);
      return;
    }
    let active = true;
    setList(null);
    setSelectedId(null);
    setNotice(null);
    setClarification(null);
    void platformApi.proposals(sourceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setList({ proposals: result.data.proposals, raw_acquisitions: result.data.raw_acquisitions });
      setSelectedId(result.data.proposals[0]?.proposal_id ?? null);
    });
    return () => {
      active = false;
    };
  }, [sourceId, onSessionLost]);

  async function generateRecord(clarifications: Array<{ question: string; answer: string }>): Promise<void> {
    const chosen = dictionaryInput.current?.files?.[0] ?? null;
    if (bindingId === '') {
      setNotice({ tone: 'error', text: t('proposal.binding.missing') });
      return;
    }
    if (requirement.trim() === '') {
      setNotice({ tone: 'error', text: t('proposal.requirement.missing') });
      return;
    }
    if (chosen === null) {
      setNotice({ tone: 'error', text: t('proposal.dictionary.missing') });
      return;
    }
    setGenerating(true);
    setNotice(null);
    const result = await platformApi.generateProposal(sourceId, {
      binding_id: bindingId,
      requirement: requirement.trim(),
      clarifications,
      dictionary: await chosen.text(),
    });
    setGenerating(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      if (result.error.code === 'PROPOSAL_CLARIFICATION_REQUIRED') {
        setClarification(result.error.message ?? t('proposal.clarification.required'));
        setNotice({ tone: 'error', text: t('proposal.clarification.required'), code: result.error.code });
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setClarification(null);
    setAnswer('');
    await loadProposals(sourceId, result.data.proposal_id);
    setNotice({ tone: 'info', text: t('proposal.generated') });
  }

  const selected = list?.proposals.find((proposal) => proposal.proposal_id === selectedId) ?? null;

  return (
    <Panel level={1} title={t('proposal.title')} description={t('proposal.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}

      <Panel level={2} title={t('proposal.source.title')} description={t('proposal.source.description')}>
        {sources === null ? (
          <p className="empty" role="status">{t('platform.loading')}</p>
        ) : sources.length === 0 ? (
          <p className="empty">{t('proposal.source.empty')}</p>
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="proposal-source">
              {t('proposal.source.select')}
            </label>
            <select
              className="field__input"
              id="proposal-source"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">{t('proposal.source.choose')}</option>
              {sources.map((source) => (
                <option key={source.source_id} value={source.source_id}>{source.name}</option>
              ))}
            </select>
          </div>
        )}
      </Panel>

      <Panel level={2} title={t('proposal.generate.title')} description={t('proposal.generate.description')}>
        <NoticeLine notice={notice} />
        {bindings === null ? (
          <p className="empty" role="status">{t('platform.loading')}</p>
        ) : bindings.length === 0 ? (
          <p className="empty">{t('proposal.binding.empty')}</p>
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="proposal-binding">
              {t('proposal.binding.select')}
            </label>
            <select
              className="field__input"
              id="proposal-binding"
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
          <label className="field__label" htmlFor="proposal-requirement">
            {t('proposal.requirement')}
          </label>
          <textarea
            className="field__input field__input--area"
            id="proposal-requirement"
            value={requirement}
            rows={3}
            maxLength={4000}
            onChange={(event) => setRequirement(event.target.value)}
          />
          <p className="field__hint">{t('proposal.requirement.hint')}</p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="proposal-dictionary">
            {t('proposal.dictionary')}
          </label>
          <input
            className="field__input"
            id="proposal-dictionary"
            type="file"
            accept="application/json,.json"
            ref={dictionaryInput}
          />
        </div>
        <Button busy={generating} onClick={() => void generateRecord([])}>
          {generating ? t('proposal.specifying') : t('proposal.generate.submit')}
        </Button>
      </Panel>

      {clarification === null ? null : (
        <Panel level={2} title={t('proposal.clarification.title')} description={t('proposal.clarification.description')}>
          <p role="status">{clarification}</p>
          <div className="field">
            <label className="field__label" htmlFor="proposal-clarification-answer">
              {t('proposal.clarification.answer')}
            </label>
            <textarea
              className="field__input field__input--area"
              id="proposal-clarification-answer"
              value={answer}
              rows={2}
              maxLength={2000}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </div>
          <Button
            busy={generating}
            onClick={() => void generateRecord([{ question: clarification, answer: answer.trim() }])}
          >
            {generating ? t('proposal.specifying') : t('proposal.clarification.submit')}
          </Button>
        </Panel>
      )}

      <Panel level={2} title={t('proposal.list.title')}>
        {list === null ? (
          <p className="empty">{t('proposal.empty')}</p>
        ) : list.proposals.length === 0 ? (
          <p className="empty">{t('proposal.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('proposal.status.column')}</th>
                <th scope="col">{t('proposal.base')}</th>
                <th scope="col">{t('proposal.lifecycle.time')}</th>
                <th scope="col">{t('workspace.members.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.proposals.map((proposal) => (
                <tr key={proposal.proposal_id}>
                  <td>{statusLabel(proposal.status)}</td>
                  <td>{proposal.base.integration_configuration_version === null ? '—' : proposal.base.integration_configuration_version}</td>
                  <td>{formatInstant(proposal.created_at)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      busy={selectedId === proposal.proposal_id}
                      onClick={() => setSelectedId(proposal.proposal_id)}
                    >
                      {t('proposal.list.inspect')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {selected === null ? (
        <p className="empty">{t('proposal.select')}</p>
      ) : (
        <ProposalDetail
          key={selected.proposal_id}
          proposal={selected}
          rawAcquisitions={list?.raw_acquisitions ?? []}
          onChanged={async (selectId) => loadProposals(sourceId, selectId)}
          onSessionLost={onSessionLost}
        />
      )}
    </Panel>
  );
}
