import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type DataProductSummary,
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

export interface WorkspaceReportTemplatesProps extends WorkspaceViewProps {
  /** A newly generated Report changes the stock the library lists. */
  onGenerated: () => void;
}

interface Draft {
  productId: string;
  name: string;
  question: string;
  parameters: string;
  query: string;
  prompt: string;
  freshness: string;
}

const EMPTY_DRAFT: Draft = {
  productId: '',
  name: '',
  question: '',
  parameters: '',
  query: '',
  prompt: '',
  freshness: '',
};

/**
 * The Workspace Administrator's Report Template surface. The form only states
 * the pinned semantics the engine must validate; publication, normalization,
 * typed-parameter checks, and Template Version numbering all happen server-side.
 */
export function WorkspaceReportTemplates({ workspaceId, onGenerated, onSessionLost }: WorkspaceReportTemplatesProps) {
  const [products, setProducts] = useState<DataProductSummary[] | null>(null);
  const [templates, setTemplates] = useState<ReportTemplateSummaryView[] | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadTemplates = useCallback(async (): Promise<void> => {
    const result = await platformApi.reportTemplates(workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setTemplates(result.data.report_templates);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    let active = true;
    setNotice(null);
    void platformApi.dataProducts(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setProducts(result.data.data_products);
    });
    void loadTemplates();
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost, loadTemplates]);

  const publish = useCallback(async (): Promise<void> => {
    if (busy !== null) return;
    setBusy('publish');
    setNotice(null);
    const result = await platformApi.publishReportTemplate(workspaceId, {
      product_id: draft.productId,
      name: draft.name,
      question: draft.question,
      parameters: draft.parameters,
      query: draft.query,
      grounded_prompt: draft.prompt,
      freshness: draft.freshness,
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
    setNotice({
      tone: 'info',
      text: message('workspace.reportTemplates.published', {
        version: String(result.data.template_version),
        hash: result.data.content_hash,
      }),
    });
    await loadTemplates();
  }, [busy, draft, workspaceId, onSessionLost, loadTemplates]);

  const generate = useCallback(async (template: ReportTemplateSummaryView): Promise<void> => {
    if (busy !== null) return;
    setBusy(`generate:${template.report_template_id}`);
    setNotice(null);
    const result = await platformApi.generateReportFromTemplate(template.report_template_id, workspaceId);
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setNotice({
      tone: 'info',
      text: `${t('workspace.reports.origin.generated')} ${message('workspace.reportTemplates.generated', {
        report_id: result.data.report.report_id,
      })}`,
    });
    onGenerated();
  }, [busy, workspaceId, onSessionLost, onGenerated]);

  return (
    <Panel
      level={2}
      title={t('workspace.reportTemplates.title')}
      description={t('workspace.reportTemplates.description')}
    >
      <div className="field">
        <label className="field__label" htmlFor="report-template-product">
          {t('workspace.reportTemplates.product')}
        </label>
        <select
          className="field__input"
          id="report-template-product"
          value={draft.productId}
          onChange={(event) => setDraft((current) => ({ ...current, productId: event.target.value }))}
        >
          <option value="">—</option>
          {(products ?? []).map((product) => (
            <option key={product.data_product_id} value={product.data_product_id}>
              {product.name}
            </option>
          ))}
        </select>
      </div>
      <Field
        id="report-template-name"
        label={t('workspace.reportTemplates.name')}
        hint={t('workspace.reportTemplates.nameHint')}
        value={draft.name}
        onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
      />
      <Field
        id="report-template-question"
        label={t('workspace.reportTemplates.question')}
        hint={t('workspace.reportTemplates.questionHint')}
        value={draft.question}
        onChange={(value) => setDraft((current) => ({ ...current, question: value }))}
      />
      <div className="field">
        <label className="field__label" htmlFor="report-template-parameters">
          {t('workspace.reportTemplates.parameters')}
        </label>
        <textarea
          className="field__input field__input--mono"
          id="report-template-parameters"
          rows={4}
          value={draft.parameters}
          onChange={(event) => setDraft((current) => ({ ...current, parameters: event.target.value }))}
          spellCheck={false}
        />
        <p className="field__hint">{t('workspace.reportTemplates.parametersHint')}</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="report-template-query">
          {t('workspace.reportTemplates.query')}
        </label>
        <textarea
          className="field__input field__input--mono"
          id="report-template-query"
          rows={6}
          value={draft.query}
          onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))}
          spellCheck={false}
        />
        <p className="field__hint">{t('workspace.reportTemplates.queryHint')}</p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="report-template-prompt">
          {t('workspace.reportTemplates.prompt')}
        </label>
        <textarea
          className="field__input field__input--area"
          id="report-template-prompt"
          rows={3}
          value={draft.prompt}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
          spellCheck={false}
        />
        <p className="field__hint">{t('workspace.reportTemplates.promptHint')}</p>
      </div>
      <Field
        id="report-template-freshness"
        label={t('workspace.reportTemplates.freshness')}
        hint={t('workspace.reportTemplates.freshnessHint')}
        value={draft.freshness}
        onChange={(value) => setDraft((current) => ({ ...current, freshness: value }))}
        inputMode="numeric"
      />
      <div className="form__actions">
        <Button busy={busy === 'publish'} onClick={() => void publish()}>
          {busy === 'publish' ? t('workspace.reportTemplates.publishing') : t('workspace.reportTemplates.publish')}
        </Button>
      </div>
      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}

      <h3 className="panel__title">{t('workspace.reportTemplates.listTitle')}</h3>
      {templates === null ? (
        <p className="empty" role="status">{t('app.checkingSession')}</p>
      ) : templates.length === 0 ? (
        <p className="empty">{t('workspace.reportTemplates.empty')}</p>
      ) : (
        <ul className="report-templates">
          {templates.map((template) => (
            <li className="report-templates__item" key={template.report_template_id}>
              <div className="report-templates__head">
                <div>
                  <p className="report-templates__name">{template.name}</p>
                  <p className="context__meta">
                    <span>
                      {t('workspace.reportTemplates.version')}
                      {' '}
                      {template.published_version ?? '—'}
                    </span>
                    <span>
                      {t('workspace.reportTemplates.owner')}
                      {' '}
                      {template.owner.username ?? template.owner.user_id}
                    </span>
                    {template.freshness_policy === undefined ? null : (
                      <span>
                        {t('workspace.reportTemplates.freshnessValue')}
                        {' '}
                        {message('workspace.reportTemplates.minutes', {
                          minutes: String(template.freshness_policy.max_age_minutes),
                        })}
                      </span>
                    )}
                  </p>
                </div>
                <Button
                  busy={busy === `generate:${template.report_template_id}`}
                  onClick={() => void generate(template)}
                >
                  {busy === `generate:${template.report_template_id}`
                    ? t('workspace.reportTemplates.generating')
                    : t('workspace.reportTemplates.generate')}
                </Button>
              </div>
              {template.question === undefined ? null : <p className="context__body">{template.question}</p>}
              <details className="report-templates__details">
                <summary className="report-templates__summary">{t('workspace.reportTemplates.expand')}</summary>
                <DefinitionList
                  rows={[
                    {
                      term: t('workspace.reportTemplates.normalized'),
                      value: template.normalized_question ?? '—',
                    },
                    {
                      term: t('workspace.reportTemplates.contractMajor'),
                      value: template.contract_major === undefined ? '—' : String(template.contract_major),
                    },
                    {
                      term: t('workspace.reportTemplates.parametersTitle'),
                      value: (
                        <pre className="report-templates__document">
                          {JSON.stringify(template.parameters ?? [], null, 2)}
                        </pre>
                      ),
                    },
                    {
                      term: t('workspace.reportTemplates.queryTitle'),
                      value: (
                        <pre className="report-templates__document">
                          {JSON.stringify(template.query ?? {}, null, 2)}
                        </pre>
                      ),
                    },
                    {
                      term: t('workspace.reportTemplates.groundedPrompt'),
                      value: template.grounded_prompt?.body ?? '—',
                    },
                    {
                      term: t('workspace.reportTemplates.hash'),
                      value: template.content_hash ?? '—',
                      mono: true,
                    },
                    {
                      term: t('workspace.reports.facts.generatedAt'),
                      value: formatInstant(template.published_at),
                    },
                  ]}
                />
              </details>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
