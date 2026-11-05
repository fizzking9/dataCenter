import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ApiError,
  type ModelBindingView,
  type ScraperDiagnosticsSummaryView,
  type ScraperDiagnosticsView,
  type ScraperProposalList,
  type ScraperProposalView,
  type ScraperProvenanceView,
  type ScraperPreviewView,
  type ScraperRunList,
  type ScraperRunView,
  type ScraperTaskView,
  type ScraperValidationView,
  type ScraperWorkspaceView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel, StatusPill } from '../ui/Panel.js';

export interface WorkspaceScrapersProps {
  workspaceId: string;
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

let nextKey = 0;
function rowKey(prefix: string): string {
  nextKey += 1;
  return `${prefix}-${String(nextKey)}`;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function joined(values: string[]): string {
  return values.length === 0 ? t('scraper.task.list.none') : values.join('、');
}

function statusLabel(status: ScraperProposalView['status']): string {
  return optional(`scraper.proposal.status.${status}`) ?? status;
}

function statusTone(status: ScraperProposalView['status']): 'ok' | 'warn' {
  return status === 'pending' || status === 'rejected' ? 'warn' : 'ok';
}

function stageLabel(stage: string): string {
  return optional(`value.scraperStage.${stage}`) ?? stage;
}

function categoryLabel(category: string): string {
  return optional(`value.scraperCategory.${category}`) ?? category;
}

function modeLabel(mode: string): string {
  return optional(`value.scraperDiagnosticMode.${mode}`) ?? mode;
}

function parameterTypeLabel(type: string): string {
  return optional(`value.scraperParameterType.${type}`) ?? type;
}

function parameterText(parameter: { name: string; type: string; required: boolean; default: string | null }): string {
  return message('scraper.proposal.parameterSummary', {
    name: parameter.name,
    type: parameterTypeLabel(parameter.type),
    requirement: parameter.required ? t('scraper.proposal.required') : t('scraper.proposal.optional'),
  });
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
      {notice.text}
    </Alert>
  );
}

function failureNotice(error: ApiError): Notice {
  return {
    tone: 'error',
    text: apiFailureText(error.code),
    ...(error.code === 'UNKNOWN' ? {} : { code: error.code }),
  };
}

interface FormRow {
  key: string;
}

interface FieldRow extends FormRow {
  name: string;
  selector: string;
}

interface ParameterRow extends FormRow {
  name: string;
  type: 'string' | 'integer';
  required: boolean;
  fallback: string;
}

interface FixtureRow extends FormRow {
  name: string;
  path: string;
  body: string;
  expectedCount: string;
  expectedRecords: string;
}

interface TaskFormProps {
  workspaceId: string;
  credentials: ScraperWorkspaceView['credentials'];
  onPublished: (task: ScraperTaskView) => void;
  onSessionLost: () => void;
}

/**
 * The guided Scraper Task form. It collects the facts a Task Version pins and
 * states them as one declaration; the governed module parses, validates,
 * authorizes, and audits it exactly as it does for the CLI.
 */
function TaskForm({ workspaceId, credentials, onPublished, onSessionLost }: TaskFormProps) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [path, setPath] = useState('');
  const [pageParameter, setPageParameter] = useState('page');
  const [firstPage, setFirstPage] = useState('1');
  const [maxPages, setMaxPages] = useState('3');
  const [pageSize, setPageSize] = useState('');
  const [pageSizeParameter, setPageSizeParameter] = useState('');
  const [origins, setOrigins] = useState('');
  const [paths, setPaths] = useState('');
  const [recordSelector, setRecordSelector] = useState('tr.record');
  const [fields, setFields] = useState<FieldRow[]>([{ key: rowKey('field'), name: 'sn', selector: 'td.sn' }]);
  const [parameters, setParameters] = useState<ParameterRow[]>([]);
  const [fixtureVersion, setFixtureVersion] = useState('1');
  const [fixtures, setFixtures] = useState<FixtureRow[]>([
    { key: rowKey('fixture'), name: '', path: '', body: '', expectedCount: '0', expectedRecords: '' },
  ]);
  const [timeout, setTimeoutValue] = useState('5000');
  const [maxBytes, setMaxBytes] = useState('1048576');
  const [maxRecords, setMaxRecords] = useState('1000');
  const [refs, setRefs] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const declaration = (): Record<string, unknown> | null => {
    const pages: Array<Record<string, unknown>> = [];
    for (const [index, fixture] of fixtures.entries()) {
      let expected: unknown;
      if (fixture.expectedRecords.trim() !== '') {
        try {
          expected = JSON.parse(fixture.expectedRecords) as unknown;
        } catch {
          setNotice({
            tone: 'error',
            text: message('scraper.task.form.expectedRecordsInvalid', { index: String(index + 1) }),
          });
          return null;
        }
        if (!Array.isArray(expected)) {
          setNotice({
            tone: 'error',
            text: message('scraper.task.form.expectedRecordsInvalid', { index: String(index + 1) }),
          });
          return null;
        }
      }
      pages.push({
        name: fixture.name,
        path: fixture.path,
        content_type: 'text/html',
        body: fixture.body,
        expected_record_count: Number(fixture.expectedCount),
        ...(expected === undefined ? {} : { expected_records: expected }),
      });
    }
    return {
      target: {
        base_url: baseUrl.trim(),
        path: path.trim(),
        page_parameter: pageParameter.trim() === '' ? null : pageParameter.trim(),
        first_page: Number(firstPage),
        max_pages: Number(maxPages),
        ...(pageSize.trim() === '' ? {} : { page_size: Number(pageSize) }),
        ...(pageSizeParameter.trim() === '' ? {} : { page_size_parameter: pageSizeParameter.trim() }),
      },
      network_scope: { origins: lines(origins), paths: lines(paths) },
      output: {
        record_selector: recordSelector.trim(),
        fields: fields
          .filter((field) => field.name.trim() !== '' && field.selector.trim() !== '')
          .map((field) => ({ name: field.name.trim(), selector: field.selector.trim() })),
      },
      parameters: parameters
        .filter((parameter) => parameter.name.trim() !== '')
        .map((parameter) => ({
          name: parameter.name.trim(),
          type: parameter.type,
          required: parameter.required,
          default: parameter.fallback.trim() === '' ? null : parameter.fallback.trim(),
        })),
      fixtures: { version: Number(fixtureVersion), pages },
      constraints: {
        timeout_ms: Number(timeout),
        max_bytes: Number(maxBytes),
        max_records: Number(maxRecords),
      },
      credential_refs: [...refs],
    };
  };

  const publish = async (): Promise<void> => {
    if (name.trim() === '') {
      setNotice({ tone: 'error', text: t('scraper.task.form.nameRequired') });
      return;
    }
    const stated = declaration();
    if (stated === null) return;
    setPublishing(true);
    setNotice(null);
    const result = await platformApi.publishScraperTask(workspaceId, name.trim(), stated);
    setPublishing(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice(failureNotice(result.error));
      return;
    }
    setNotice({
      tone: 'info',
      text: message('scraper.task.form.published', { version: String(result.data.scraper_task_version) }),
    });
    onPublished(result.data);
  };

  const updateField = (key: string, patch: Partial<FieldRow>): void =>
    setFields((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const updateParameter = (key: string, patch: Partial<ParameterRow>): void =>
    setParameters((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const updateFixture = (key: string, patch: Partial<FixtureRow>): void =>
    setFixtures((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <Panel level={2} title={t('scraper.task.form.title')} description={t('scraper.task.form.description')}>
      <NoticeLine notice={notice} />
      <Field id="scraper-task-name" label={t('scraper.task.name')} value={name} onChange={setName} maxLength={128} />

      <h3 className="panel__title">{t('scraper.task.form.targetSection')}</h3>
      <Field
        id="scraper-target-base-url"
        label={t('scraper.task.target.baseUrl')}
        value={baseUrl}
        onChange={setBaseUrl}
        mono
        maxLength={512}
      />
      <Field
        id="scraper-target-path"
        label={t('scraper.task.target.path')}
        value={path}
        onChange={setPath}
        hint={t('scraper.task.target.pathHint')}
        mono
      />
      <Field
        id="scraper-target-page-parameter"
        label={t('scraper.task.target.pageParameter')}
        value={pageParameter}
        onChange={setPageParameter}
        hint={t('scraper.task.target.pageParameterHint')}
        mono
      />
      <Field
        id="scraper-target-first-page"
        label={t('scraper.task.target.firstPage')}
        value={firstPage}
        onChange={setFirstPage}
        inputMode="numeric"
      />
      <Field
        id="scraper-target-max-pages"
        label={t('scraper.task.target.maxPages')}
        value={maxPages}
        onChange={setMaxPages}
        inputMode="numeric"
      />
      <Field
        id="scraper-target-page-size"
        label={t('scraper.task.target.pageSize')}
        value={pageSize}
        onChange={setPageSize}
        inputMode="numeric"
      />
      <Field
        id="scraper-target-page-size-parameter"
        label={t('scraper.task.target.pageSizeParameter')}
        value={pageSizeParameter}
        onChange={setPageSizeParameter}
        mono
      />

      <h3 className="panel__title">{t('scraper.task.form.scopeSection')}</h3>
      <div className="field">
        <label className="field__label" htmlFor="scraper-scope-origins">
          {t('scraper.task.scope.origins')}
        </label>
        <textarea
          className="field__input field__input--area"
          id="scraper-scope-origins"
          rows={2}
          value={origins}
          onChange={(event) => setOrigins(event.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="scraper-scope-paths">
          {t('scraper.task.scope.paths')}
        </label>
        <textarea
          className="field__input field__input--area"
          id="scraper-scope-paths"
          rows={2}
          value={paths}
          onChange={(event) => setPaths(event.target.value)}
          spellCheck={false}
        />
        <p className="field__hint">{t('scraper.task.scope.hint')}</p>
      </div>

      <h3 className="panel__title">{t('scraper.task.output.fieldsSection')}</h3>
      <Field
        id="scraper-output-record-selector"
        label={t('scraper.task.output.recordSelector')}
        value={recordSelector}
        onChange={setRecordSelector}
        mono
      />
      {fields.map((row, index) => (
        <div className="context-history__item" key={row.key}>
          <Field
            id={`scraper-field-name-${String(index + 1)}`}
            label={message('scraper.task.output.fieldName', { index: String(index + 1) })}
            value={row.name}
            onChange={(value) => updateField(row.key, { name: value })}
            mono
            maxLength={64}
          />
          <Field
            id={`scraper-field-selector-${String(index + 1)}`}
            label={message('scraper.task.output.fieldSelector', { index: String(index + 1) })}
            value={row.selector}
            onChange={(value) => updateField(row.key, { selector: value })}
            mono
          />
        </div>
      ))}
      <Button variant="secondary" onClick={() => setFields((rows) => [
        ...rows,
        { key: rowKey('field'), name: '', selector: '' },
      ])}>
        {t('scraper.task.output.addField')}
      </Button>

      <h3 className="panel__title">{t('scraper.task.parametersSection')}</h3>
      {parameters.map((row, index) => (
        <div className="context-history__item" key={row.key}>
          <Field
            id={`scraper-parameter-name-${String(index + 1)}`}
            label={message('scraper.task.parameter.name', { index: String(index + 1) })}
            value={row.name}
            onChange={(value) => updateParameter(row.key, { name: value })}
            mono
            maxLength={64}
          />
          <div className="field">
            <label className="field__label" htmlFor={`scraper-parameter-type-${String(index + 1)}`}>
              {message('scraper.task.parameter.type', { index: String(index + 1) })}
            </label>
            <select
              className="field__input"
              id={`scraper-parameter-type-${String(index + 1)}`}
              value={row.type}
              onChange={(event) => {
                if (event.target.value === 'integer' || event.target.value === 'string') {
                  updateParameter(row.key, { type: event.target.value });
                }
              }}
            >
              <option value="string">{parameterTypeLabel('string')}</option>
              <option value="integer">{parameterTypeLabel('integer')}</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`scraper-parameter-required-${String(index + 1)}`}>
              {message('scraper.task.parameter.required', { index: String(index + 1) })}
            </label>
            <input
              id={`scraper-parameter-required-${String(index + 1)}`}
              type="checkbox"
              aria-label={message('scraper.task.parameter.required', { index: String(index + 1) })}
              checked={row.required}
              onChange={(event) => updateParameter(row.key, { required: event.target.checked })}
            />
          </div>
          <Field
            id={`scraper-parameter-default-${String(index + 1)}`}
            label={message('scraper.task.parameter.default', { index: String(index + 1) })}
            value={row.fallback}
            onChange={(value) => updateParameter(row.key, { fallback: value })}
            mono
          />
        </div>
      ))}
      <Button variant="secondary" onClick={() => setParameters((rows) => [
        ...rows,
        { key: rowKey('parameter'), name: '', type: 'string', required: false, fallback: '' },
      ])}>
        {t('scraper.task.parameter.add')}
      </Button>

      <h3 className="panel__title">{t('scraper.task.fixturesSection')}</h3>
      <p className="field__hint">{t('scraper.task.fixtures.hint')}</p>
      <Field
        id="scraper-fixture-version"
        label={t('scraper.task.fixture.version')}
        value={fixtureVersion}
        onChange={setFixtureVersion}
        inputMode="numeric"
      />
      {fixtures.map((row, index) => (
        <div className="context-history__item" key={row.key}>
          <Field
            id={`scraper-fixture-name-${String(index + 1)}`}
            label={message('scraper.task.fixture.name', { index: String(index + 1) })}
            value={row.name}
            onChange={(value) => updateFixture(row.key, { name: value })}
            maxLength={128}
          />
          <Field
            id={`scraper-fixture-path-${String(index + 1)}`}
            label={message('scraper.task.fixture.path', { index: String(index + 1) })}
            value={row.path}
            onChange={(value) => updateFixture(row.key, { path: value })}
            mono
          />
          <div className="field">
            <label className="field__label" htmlFor={`scraper-fixture-body-${String(index + 1)}`}>
              {message('scraper.task.fixture.body', { index: String(index + 1) })}
            </label>
            <textarea
              className="field__input field__input--area field__input--mono"
              id={`scraper-fixture-body-${String(index + 1)}`}
              rows={4}
              value={row.body}
              onChange={(event) => updateFixture(row.key, { body: event.target.value })}
              spellCheck={false}
            />
          </div>
          <Field
            id={`scraper-fixture-expected-count-${String(index + 1)}`}
            label={message('scraper.task.fixture.expectedCount', { index: String(index + 1) })}
            value={row.expectedCount}
            onChange={(value) => updateFixture(row.key, { expectedCount: value })}
            inputMode="numeric"
          />
          <div className="field">
            <label className="field__label" htmlFor={`scraper-fixture-expected-records-${String(index + 1)}`}>
              {message('scraper.task.fixture.expectedRecords', { index: String(index + 1) })}
            </label>
            <textarea
              className="field__input field__input--area field__input--mono"
              id={`scraper-fixture-expected-records-${String(index + 1)}`}
              rows={3}
              value={row.expectedRecords}
              onChange={(event) => updateFixture(row.key, { expectedRecords: event.target.value })}
              spellCheck={false}
            />
            <p className="field__hint">{t('scraper.task.fixture.expectedRecordsHint')}</p>
          </div>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setFixtures((rows) => [
        ...rows,
        { key: rowKey('fixture'), name: '', path: '', body: '', expectedCount: '0', expectedRecords: '' },
      ])}>
        {t('scraper.task.fixture.add')}
      </Button>

      <h3 className="panel__title">{t('scraper.task.constraintsSection')}</h3>
      <Field
        id="scraper-constraint-timeout"
        label={t('scraper.task.constraints.timeout')}
        value={timeout}
        onChange={setTimeoutValue}
        inputMode="numeric"
      />
      <Field
        id="scraper-constraint-max-bytes"
        label={t('scraper.task.constraints.maxBytes')}
        value={maxBytes}
        onChange={setMaxBytes}
        inputMode="numeric"
      />
      <Field
        id="scraper-constraint-max-records"
        label={t('scraper.task.constraints.maxRecords')}
        value={maxRecords}
        onChange={setMaxRecords}
        inputMode="numeric"
      />

      <h3 className="panel__title">{t('scraper.task.credentialsSection')}</h3>
      {credentials.length === 0 ? (
        <p className="empty">{t('scraper.task.credentials.empty')}</p>
      ) : (
        credentials.map((credential) => (
          <div className="field" key={credential.ref}>
            <label className="field__label" htmlFor={`scraper-credential-${credential.ref}`}>
              {credential.ref}
            </label>
            <input
              id={`scraper-credential-${credential.ref}`}
              type="checkbox"
              aria-label={credential.ref}
              checked={refs.includes(credential.ref)}
              onChange={(event) => setRefs((current) => event.target.checked
                ? [...current, credential.ref]
                : current.filter((entry) => entry !== credential.ref))}
            />
            <p className="field__hint">{t('scraper.task.credentialRefsHint')}</p>
          </div>
        ))
      )}

      <Button busy={publishing} onClick={() => void publish()}>
        {publishing ? t('scraper.task.form.publishing') : t('scraper.task.publish')}
      </Button>
    </Panel>
  );
}

interface TaskListProps {
  tasks: ScraperTaskView[];
  compiling: string | null;
  onCompile: (task: ScraperTaskView) => void;
}

/** The published Task Versions and the exact facts each latest Version pins. */
function TaskList({ tasks, compiling, onCompile }: TaskListProps) {
  return (
    <Panel level={2} title={t('scraper.task.list.title')}>
      {tasks.length === 0 ? (
        <p className="empty">{t('scraper.task.list.empty')}</p>
      ) : (
        tasks.map((task) => (
          <div className="context-history__item" key={task.scraper_task_id}>
            <h3 className="context-history__version">
              {task.name}
              {' · '}
              {message('scraper.task.list.version', { version: String(task.scraper_task_version) })}
            </h3>
            <DefinitionList
              rows={[
                { term: t('scraper.task.list.target'), value: `${task.target.base_url}${task.target.path}`, mono: true },
                {
                  term: t('scraper.task.outputContract'),
                  value: message('scraper.proposal.summary', {
                    selector: task.output.record_selector,
                    fields: String(task.output.fields.length),
                  }),
                },
                {
                  term: t('scraper.task.output.fieldsSection'),
                  value: task.output.fields.map((field) => `${field.name} ← ${field.selector}`).join('、'),
                },
                { term: t('scraper.task.parameters'), value: task.parameters.map(parameterText).join('、') },
                {
                  term: t('scraper.task.constraints'),
                  value: message('scraper.proposal.constraintsSummary', {
                    timeout: String(task.constraints.timeout_ms),
                    bytes: String(task.constraints.max_bytes),
                    records: String(task.constraints.max_records),
                  }),
                },
                { term: t('scraper.task.list.fixtureCount'), value: String(task.fixture_count) },
                { term: t('scraper.task.list.credentials'), value: joined(task.credential_refs) },
                { term: t('scraper.task.list.contentHash'), value: task.content_hash, mono: true },
                { term: t('scraper.task.list.fixturesHash'), value: task.fixtures_hash, mono: true },
                {
                  term: t('scraper.task.list.versions'),
                  value: task.versions
                    .map((version) => message('scraper.task.list.version', { version: String(version.scraper_task_version) }))
                    .join('、'),
                },
              ]}
            />
            <Button
              variant="secondary"
              busy={compiling === task.scraper_task_id}
              onClick={() => onCompile(task)}
            >
              {compiling === task.scraper_task_id
                ? t('scraper.task.list.compiling')
                : message('scraper.task.list.compile', { version: String(task.scraper_task_version) })}
            </Button>
          </div>
        ))
      )}
    </Panel>
  );
}

/** The published Service Versions, and the exact Version each scraper Source pins. */
function ServicePanels({ workspace }: { workspace: ScraperWorkspaceView }) {
  return (
    <>
      <Panel level={2} title={t('scraper.service.title')}>
        {workspace.services.length === 0 ? (
          <p className="empty">{t('scraper.service.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('scraper.service.title')}</th>
                <th scope="col">{t('scraper.service.taskVersion')}</th>
                <th scope="col">{t('scraper.service.fields')}</th>
                <th scope="col">{t('scraper.service.publishedAt')}</th>
                <th scope="col">{t('scraper.service.hash')}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.services.flatMap((service) => service.versions.map((version) => (
                <tr key={`${service.scraper_service_id}-${String(version.version)}`}>
                  <td>
                    {service.name}
                    {' · '}
                    {message('scraper.service.version', { version: String(version.version) })}
                    {version.withdrawn_at === null ? '' : `（${t('scraper.service.withdrawn')}）`}
                  </td>
                  <td>{message('scraper.service.version', { version: String(version.scraper_task_version) })}</td>
                  <td>{version.output_fields.join('、')}</td>
                  <td>{formatInstant(version.published_at)}</td>
                  <td className="data-table__mono"><code>{version.content_hash}</code></td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel level={2} title={t('scraper.service.pins.title')}>
        {workspace.pins.length === 0 ? (
          <p className="empty">{t('scraper.service.pins.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('scraper.service.pins.source')}</th>
                <th scope="col">{t('scraper.service.pins.version')}</th>
                <th scope="col">{t('scraper.service.pins.adoptedAt')}</th>
                <th scope="col">{t('scraper.service.pins.proposal')}</th>
                <th scope="col">{t('scraper.service.pins.contentHash')}</th>
              </tr>
            </thead>
            <tbody>
              {workspace.pins.map((pin) => (
                <tr key={pin.source_id}>
                  <td>{pin.source_name ?? pin.source_id}</td>
                  <td>{message('scraper.service.version', { version: String(pin.adopted_version) })}</td>
                  <td>{formatInstant(pin.adopted_at)}</td>
                  <td className="data-table__mono"><code>{pin.proposal_id}</code></td>
                  <td className="data-table__mono"><code>{pin.content_hash}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function provenanceOf(proposal: ScraperProposalView): ScraperProvenanceView | null {
  return proposal.decisions[proposal.decisions.length - 1]?.provenance
    ?? proposal.publications[proposal.publications.length - 1]?.provenance
    ?? proposal.adoptions[proposal.adoptions.length - 1]?.provenance
    ?? null;
}

function EvidencePanel({ proposal }: { proposal: ScraperProposalView }) {
  const service = proposal.candidates.service;
  const base = proposal.base.scraper_service_version;
  return (
    <Panel level={2} title={t('scraper.proposal.evidence.title')}>
      <DefinitionList
        rows={[
          {
            term: t('scraper.proposal.evidence.base'),
            value: base === null ? t('scraper.proposal.evidence.baseNone') : message('scraper.service.version', { version: String(base) }),
          },
          {
            term: t('scraper.proposal.evidence.sourceTask'),
            value: message('scraper.task.list.version', { version: String(service.source_task.version) }),
          },
          {
            term: t('scraper.proposal.evidence.fresh'),
            value: proposal.fresh === false
              ? t('scraper.proposal.evidence.stale')
              : t('scraper.proposal.evidence.fresh'),
          },
          { term: t('scraper.proposal.evidence.taskHash'), value: proposal.evidence.task_hash, mono: true },
          { term: t('scraper.proposal.evidence.fixturesHash'), value: proposal.evidence.fixtures_hash, mono: true },
          { term: t('scraper.proposal.evidence.candidateHash'), value: proposal.candidates.content_hash, mono: true },
          { term: t('scraper.proposal.evidence.proposalHash'), value: proposal.proposal_hash, mono: true },
          {
            term: t('scraper.proposal.evidence.outputFields'),
            value: message('scraper.proposal.summary', {
              selector: service.output.record_selector,
              fields: String(service.output.fields.length),
            }),
          },
          {
            term: t('scraper.proposal.evidence.recordSelector'),
            value: service.output.fields
              .map((field) => message('scraper.proposal.evidence.fieldSelector', { name: field.name, selector: field.selector }))
              .join('、'),
          },
          { term: t('scraper.proposal.evidence.parameters'), value: service.parameters.map(parameterText).join('、') },
          {
            term: t('scraper.proposal.evidence.constraints'),
            value: message('scraper.proposal.constraintsSummary', {
              timeout: String(service.constraints.timeout_ms),
              bytes: String(service.constraints.max_bytes),
              records: String(service.constraints.max_records),
            }),
          },
          { term: t('scraper.proposal.evidence.credentialRefs'), value: joined(service.credential_refs) },
          {
            term: t('scraper.proposal.evidence.networkScope'),
            value: `${service.network_scope.origins.join('、')} · ${service.network_scope.paths.join('、')}`,
            mono: true,
          },
          {
            term: t('scraper.proposal.evidence.regression'),
            value: proposal.evidence.regression_fixtures.length === 0
              ? t('scraper.proposal.evidence.regressionNone')
              : proposal.evidence.regression_fixtures.join('、'),
          },
          { term: t('scraper.proposal.createdBy'), value: proposal.created_by },
        ]}
      />
    </Panel>
  );
}

function ValidationPanel({
  proposal,
  validation,
  busy,
  onRun,
}: {
  proposal: ScraperProposalView;
  validation: ScraperValidationView | undefined;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <Panel level={2} title={t('scraper.validation.title')} description={t('scraper.validation.noNetwork')}>
      {validation === undefined ? (
        <p className="empty">{t('scraper.validation.empty')}</p>
      ) : (
        <>
          <p role="status">
            {validation.passed ? t('scraper.validation.passedNotice') : t('scraper.validation.failed')}
          </p>
          <DefinitionList
            rows={[
              { term: t('scraper.validation.validatedAt'), value: formatInstant(validation.validated_at) },
              { term: t('scraper.validation.evidence'), value: validation.evidence_hash, mono: true },
              ...validation.checks.map((check) => ({
                term: check.name,
                value: check.passed ? t('scraper.validation.checkPassed') : `${t('scraper.validation.checkFailed')} · ${check.detail ?? ''}`,
              })),
              ...validation.fixtures.map((fixture) => ({
                term: message('scraper.validation.fixture', { name: fixture.name }),
                value: message('scraper.validation.counts', {
                  records: String(fixture.record_count),
                  expected: String(fixture.expected_record_count),
                }),
              })),
            ]}
          />
        </>
      )}
      <Button variant="secondary" busy={busy} onClick={onRun}>
        {busy ? t('scraper.validation.running') : t('scraper.validation.run')}
      </Button>
      {proposal.validations.length === 0 ? <p className="field__hint">{t('scraper.validation.required')}</p> : null}
    </Panel>
  );
}

/** One preview's extracted records, with the columns the candidate declares. */
function PreviewFixtures({ preview }: { preview: ScraperPreviewView }) {
  return (
    <>
      {preview.fixtures.map((fixture) => {
        const columns = [...new Set(fixture.records.flatMap((record) => Object.keys(record)))];
        return (
          <div className="context-history__item" key={fixture.name}>
            <h3 className="context-history__version">
              {message('scraper.preview.fixture', { name: fixture.name })}
              {' · '}
              {fixture.matches ? t('scraper.preview.matches') : t('scraper.preview.differs')}
            </h3>
            <p>
              {message('scraper.validation.counts', {
                records: String(fixture.record_count),
                expected: String(fixture.expected_record_count),
              })}
            </p>
            {fixture.records.length === 0 ? (
              <p className="empty">{t('scraper.preview.noRecords')}</p>
            ) : (
              <>
                <table className="data-table">
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th scope="col" key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fixture.records.map((record, index) => (
                      <tr key={`${fixture.name}-${String(index)}`}>
                        {columns.map((column) => (
                          <td key={column}>{record[column] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {fixture.records.length < fixture.record_count ? (
                  <p className="field__hint">
                    {message('scraper.preview.shown', {
                      shown: String(fixture.records.length),
                      total: String(fixture.record_count),
                    })}
                  </p>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function PreviewPanel({
  preview,
  busy,
  onRun,
}: {
  preview: ScraperPreviewView | undefined;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <Panel level={2} title={t('scraper.preview.title')} description={t('scraper.preview.description')}>
      {preview === undefined ? (
        <p className="empty">{t('scraper.preview.empty')}</p>
      ) : (
        <>
          <p role="status">
            {preview.passed ? t('scraper.preview.passedNotice') : t('scraper.preview.failedNotice')}
          </p>
          <DefinitionList
            rows={[
              { term: t('scraper.preview.previewedAt'), value: formatInstant(preview.previewed_at) },
              { term: t('scraper.preview.evidence'), value: preview.evidence_hash, mono: true },
            ]}
          />
          <PreviewFixtures preview={preview} />
        </>
      )}
      <Button variant="secondary" busy={busy} onClick={onRun}>
        {busy ? t('scraper.preview.running') : t('scraper.preview.run')}
      </Button>
    </Panel>
  );
}

interface ActionsPanelProps {
  proposal: ScraperProposalView;
  sources: ScraperWorkspaceView['sources'];
  busy: string | null;
  notice: Notice | null;
  onAct: (action: 'approve' | 'publish' | 'verify' | 'adopt' | 'reject', extra: { sourceId: string; parameters: string; reason: string }) => void;
}

function ActionsPanel({ proposal, sources, busy, notice, onAct }: ActionsPanelProps) {
  const [pending, setPending] = useState<'approve' | 'publish' | 'verify' | 'adopt' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [sourceId, setSourceId] = useState(sources[0]?.source_id ?? '');
  const [parameters, setParameters] = useState('{}');

  const act = (action: 'approve' | 'publish' | 'verify' | 'adopt' | 'reject'): void => {
    onAct(action, { sourceId, parameters, reason });
    setPending(null);
  };

  return (
    <Panel level={2} title={t('scraper.actions.title')} description={t('scraper.actions.description')}>
      <NoticeLine notice={notice} />
      <p className="binding__state">
        <StatusPill tone={statusTone(proposal.status)} label={statusLabel(proposal.status)} />
      </p>

      <div className="form__actions">
        <Button busy={busy === 'approve'} onClick={() => setPending('approve')}>
          {t('scraper.approve')}
        </Button>
        <Button variant="secondary" busy={busy === 'publish'} onClick={() => setPending('publish')}>
          {t('scraper.publish')}
        </Button>
        <Button variant="secondary" busy={busy === 'verify'} onClick={() => setPending('verify')}>
          {t('scraper.verify')}
        </Button>
        <Button variant="secondary" busy={busy === 'adopt'} onClick={() => setPending('adopt')}>
          {t('scraper.adopt')}
        </Button>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="scraper-verify-parameters">
          {t('scraper.verify.parameters')}
        </label>
        <textarea
          className="field__input field__input--area field__input--mono"
          id="scraper-verify-parameters"
          rows={2}
          value={parameters}
          onChange={(event) => setParameters(event.target.value)}
          spellCheck={false}
        />
        <p className="field__hint">{t('scraper.verify.parametersHint')}</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="scraper-adopt-source">
          {t('scraper.adopt.source')}
        </label>
        <select
          className="field__input"
          id="scraper-adopt-source"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
        >
          {sources.length === 0 ? <option value="">{t('scraper.adopt.sourceEmpty')}</option> : null}
          {sources.map((source) => (
            <option key={source.source_id} value={source.source_id}>{source.name}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="scraper-reject-reason">
          {t('scraper.reject.reason')}
        </label>
        <textarea
          className="field__input field__input--area"
          id="scraper-reject-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <Button variant="quiet" busy={busy === 'reject'} onClick={() => setPending('reject')}>
        {t('scraper.reject')}
      </Button>

      {pending === 'approve' ? (
        <Confirmation
          title={t('scraper.confirm.approveTitle')}
          target={message('scraper.confirm.target', { proposal: proposal.proposal_id })}
          scope={t('scraper.confirm.scope')}
          consequence={t('scraper.confirm.approveConsequence')}
          confirmLabel={t('scraper.confirm.approve')}
          busy={busy === 'approve'}
          onConfirm={() => act('approve')}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending === 'publish' ? (
        <Confirmation
          title={t('scraper.confirm.publishTitle')}
          target={message('scraper.confirm.candidate', { version: String(proposal.candidates.service.source_task.version) })}
          scope={t('scraper.confirm.scope')}
          consequence={t('scraper.confirm.publishConsequence')}
          confirmLabel={t('scraper.confirm.publish')}
          busy={busy === 'publish'}
          onConfirm={() => act('publish')}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending === 'verify' ? (
        <Confirmation
          title={t('scraper.confirm.verifyTitle')}
          target={message('scraper.confirm.candidate', { version: String(proposal.candidates.service.source_task.version) })}
          scope={t('scraper.confirm.scope')}
          consequence={t('scraper.confirm.verifyConsequence')}
          confirmLabel={t('scraper.confirm.verify')}
          busy={busy === 'verify'}
          onConfirm={() => act('verify')}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending === 'adopt' ? (
        <Confirmation
          title={t('scraper.confirm.adoptTitle')}
          target={message('scraper.confirm.candidate', { version: String(proposal.candidates.service.source_task.version) })}
          scope={t('scraper.confirm.scope')}
          consequence={t('scraper.confirm.adoptConsequence')}
          confirmLabel={t('scraper.confirm.adopt')}
          busy={busy === 'adopt'}
          onConfirm={() => act('adopt')}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending === 'reject' ? (
        <Confirmation
          title={t('scraper.confirm.rejectTitle')}
          target={message('scraper.confirm.target', { proposal: proposal.proposal_id })}
          scope={t('scraper.confirm.scope')}
          consequence={t('scraper.confirm.rejectConsequence')}
          confirmLabel={t('scraper.confirm.reject')}
          busy={busy === 'reject'}
          onConfirm={() => act('reject')}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </Panel>
  );
}

function VerificationPanel({ proposal }: { proposal: ScraperProposalView }) {
  const verification = proposal.verifications[proposal.verifications.length - 1];
  return (
    <Panel level={2} title={t('scraper.verification.title')} description={t('scraper.verification.isolated')}>
      {verification === undefined ? (
        <p className="empty">{t('scraper.verification.none')}</p>
      ) : (
        <>
          <DefinitionList
            rows={[
              {
                term: t('scraper.verification.result'),
                value: verification.passed
                  ? t('scraper.verification.resultPassed')
                  : t('scraper.verification.resultFailed'),
              },
              { term: t('scraper.verification.passedAt'), value: formatInstant(verification.verified_at) },
              {
                term: t('scraper.verification.pages'),
                value: message('scraper.service.version', { version: String(verification.scraper_service_version) }),
              },
              { term: t('scraper.verification.records'), value: String(verification.record_count) },
              { term: t('scraper.verification.evidence'), value: verification.evidence_hash, mono: true },
            ]}
          />
          {verification.pages.length === 0 ? null : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('scraper.diagnostics.page')}</th>
                  <th scope="col">{t('scraper.run.pageStatus')}</th>
                  <th scope="col">{t('scraper.run.pageRecords')}</th>
                  <th scope="col">{t('scraper.run.hash')}</th>
                </tr>
              </thead>
              <tbody>
                {verification.pages.map((page) => (
                  <tr key={page.page}>
                    <td>{page.page}</td>
                    <td>{page.status}</td>
                    <td>{page.record_count}</td>
                    <td className="data-table__mono"><code>{page.response_hash}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {verification.diagnostics.length === 0 ? null : (
            <ul>
              {verification.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}-${String(index)}`}>
                  <code>{diagnostic.code}</code>
                  {' · '}
                  {diagnostic.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

function LifecyclePanel({ proposal }: { proposal: ScraperProposalView }) {
  const rows = [
    ...proposal.decisions.map((decision) => ({
      at: decision.decided_at,
      action: decision.outcome === 'approved' ? t('scraper.lifecycle.approved') : t('scraper.lifecycle.rejected'),
      actor: decision.decided_by,
      detail: decision.reason ?? t('scraper.task.list.none'),
      evidence: decision.evidence_hash,
    })),
    ...proposal.publications.map((publication) => ({
      at: publication.published_at,
      action: message('scraper.lifecycle.published', { version: String(publication.scraper_service_version) }),
      actor: publication.published_by,
      detail: t('scraper.task.list.none'),
      evidence: publication.evidence_hash,
    })),
    ...proposal.adoptions.map((adoption) => ({
      at: adoption.adopted_at,
      action: message('scraper.lifecycle.adopted', { version: String(adoption.scraper_service_version) }),
      actor: adoption.adopted_by,
      detail: adoption.previous_adopted_version === null
        ? t('scraper.run.adoptedNone')
        : message('scraper.lifecycle.adopted', { version: String(adoption.previous_adopted_version) }),
      evidence: adoption.evidence_hash,
    })),
  ];
  return (
    <Panel level={2} title={t('scraper.lifecycle.title')}>
      {rows.length === 0 ? (
        <p className="empty">{t('scraper.lifecycle.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('scraper.lifecycle.time')}</th>
              <th scope="col">{t('scraper.lifecycle.action')}</th>
              <th scope="col">{t('scraper.lifecycle.actor')}</th>
              <th scope="col">{t('scraper.lifecycle.detail')}</th>
              <th scope="col">{t('scraper.lifecycle.evidence')}</th>
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

function ProvenancePanel({ proposal, provenance }: { proposal: ScraperProposalView; provenance: ScraperProvenanceView | null }) {
  const repair = proposal.repair;
  return (
    <Panel level={2} title={t('scraper.provenance.title')}>
      {provenance === null ? (
        <DefinitionList
          rows={[
            { term: t('scraper.provenance.candidate'), value: proposal.candidates.content_hash, mono: true },
            { term: t('scraper.provenance.proposal'), value: proposal.proposal_hash, mono: true },
          ]}
        />
      ) : (
        <DefinitionList
          rows={[
            { term: t('scraper.provenance.engine'), value: `${provenance.engine.name} · ${String(provenance.engine.version)}`, mono: true },
            {
              term: t('scraper.provenance.task'),
              value: `${message('scraper.task.list.version', { version: String(provenance.scraper_task_version) })} · ${provenance.scraper_task_content_hash}`,
              mono: true,
            },
            { term: t('scraper.provenance.fixtures'), value: provenance.fixtures_hash, mono: true },
            { term: t('scraper.provenance.validation'), value: provenance.validation_hash === '' ? t('scraper.task.list.none') : provenance.validation_hash, mono: true },
            { term: t('scraper.provenance.preview'), value: provenance.preview_hash === '' ? t('scraper.task.list.none') : provenance.preview_hash, mono: true },
            { term: t('scraper.provenance.verification'), value: provenance.verification_hash === '' ? t('scraper.task.list.none') : provenance.verification_hash, mono: true },
            { term: t('scraper.provenance.candidate'), value: provenance.candidate_content_hash, mono: true },
            { term: t('scraper.provenance.proposal'), value: provenance.proposal_hash, mono: true },
          ]}
        />
      )}
      {repair === null ? (
        <p className="field__hint">{t('scraper.provenance.repairNone')}</p>
      ) : (
        <>
          <h3 className="panel__title">{t('scraper.provenance.repairTitle')}</h3>
          <DefinitionList
            rows={[
              {
                term: t('scraper.provenance.repairBase'),
                value: `${repair.base_service_version === null ? t('scraper.proposal.evidence.baseNone') : message('scraper.service.version', { version: String(repair.base_service_version) })} · ${message('scraper.task.list.version', { version: String(repair.base_task_version) })}`,
              },
              {
                term: t('scraper.provenance.repairFailure'),
                value: `${repair.failure_code} · ${repair.diagnostics_id}`,
                mono: true,
              },
              {
                term: t('scraper.provenance.repairModel'),
                value: `${repair.model.model_id} · v${String(repair.model.model_profile_version)} · ${repair.model.binding_id}`,
              },
              { term: t('scraper.provenance.repairInput'), value: repair.input_hash, mono: true },
            ]}
          />
        </>
      )}
    </Panel>
  );
}

interface ProposalDetailProps {
  proposal: ScraperProposalView;
  sources: ScraperWorkspaceView['sources'];
  onChanged: (selectId?: string) => Promise<void>;
  onSessionLost: () => void;
}

/** One Proposal: candidates, evidence, review, the four exact-version actions. */
function ProposalDetail({ proposal, sources, onChanged, onSessionLost }: ProposalDetailProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const validation = proposal.validations[proposal.validations.length - 1];
  const preview = proposal.previews[proposal.previews.length - 1];
  const provenance = provenanceOf(proposal);

  const review = async (action: 'validate' | 'preview'): Promise<void> => {
    setBusy(action);
    setNotice(null);
    const result = action === 'validate'
      ? await platformApi.validateScraperProposal(proposal.proposal_id)
      : await platformApi.previewScraperProposal(proposal.proposal_id);
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice(failureNotice(result.error));
      return;
    }
    await onChanged(proposal.proposal_id);
    setNotice({
      tone: 'info',
      text: result.data.passed
        ? (action === 'validate' ? t('scraper.validation.passedNotice') : t('scraper.preview.passedNotice'))
        : (action === 'validate' ? t('scraper.validation.failed') : t('scraper.preview.failedNotice')),
    });
  };

  const act = async (
    action: 'approve' | 'publish' | 'verify' | 'adopt' | 'reject',
    extra: { sourceId: string; parameters: string; reason: string },
  ): Promise<void> => {
    if (busy !== null) return;
    setBusy(action);
    setNotice(null);
    if (action === 'verify') {
      try {
        JSON.parse(extra.parameters) as unknown;
      } catch {
        setBusy(null);
        setNotice({ tone: 'error', text: t('scraper.parameters.invalidJson') });
        return;
      }
    }
    const result = action === 'approve'
      ? await platformApi.approveScraperProposal(proposal.proposal_id)
      : action === 'reject'
        ? await platformApi.rejectScraperProposal(proposal.proposal_id, extra.reason.trim())
        : action === 'publish'
          ? await platformApi.publishScraperProposal(proposal.proposal_id)
          : action === 'verify'
            ? await platformApi.verifyScraperProposal(
              proposal.proposal_id,
              JSON.parse(extra.parameters) as Record<string, string>,
            )
            : await platformApi.adoptScraperProposal(proposal.proposal_id, extra.sourceId);
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      // Evidence a refusal produced is still governed evidence: reload it.
      await onChanged(proposal.proposal_id);
      setNotice(failureNotice(result.error));
      return;
    }
    await onChanged(proposal.proposal_id);
    if (action === 'approve') setNotice({ tone: 'info', text: t('scraper.notice.approved') });
    else if (action === 'reject') setNotice({ tone: 'info', text: t('scraper.notice.rejected') });
    else if (action === 'publish' && 'scraper_service_version' in result.data) {
      setNotice({
        tone: 'info',
        text: message('scraper.notice.published', { version: String(result.data.scraper_service_version) }),
      });
    } else if (action === 'verify') {
      setNotice({ tone: 'info', text: t('scraper.notice.verified') });
    } else if (action === 'adopt' && 'adopted_version' in result.data) {
      setNotice({
        tone: 'info',
        text: message('scraper.notice.adopted', { version: String(result.data.adopted_version) }),
      });
    }
  };

  return (
    <Panel level={2} title={t('scraper.proposal.detail.title')}>
      <EvidencePanel proposal={proposal} />
      <ValidationPanel
        proposal={proposal}
        validation={validation}
        busy={busy === 'validate'}
        onRun={() => void review('validate')}
      />
      <PreviewPanel preview={preview} busy={busy === 'preview'} onRun={() => void review('preview')} />
      <VerificationPanel proposal={proposal} />
      <ActionsPanel
        proposal={proposal}
        sources={sources}
        busy={busy}
        notice={notice}
        onAct={(action, extra) => void act(action, extra)}
      />
      <LifecyclePanel proposal={proposal} />
      <ProvenancePanel proposal={proposal} provenance={provenance} />
    </Panel>
  );
}

interface DiagnosticsProps {
  summaries: ScraperDiagnosticsSummaryView[];
  selected: ScraperDiagnosticsView | null;
  busy: boolean;
  onSelect: (diagnosticsId: string) => void;
}

function DiagnosticsPanels({ summaries, selected, busy, onSelect }: DiagnosticsProps) {
  return (
    <>
      <Panel level={2} title={t('scraper.diagnostics.title')} description={t('scraper.diagnostics.description')}>
        {summaries.length === 0 ? (
          <p className="empty">{t('scraper.diagnostics.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('scraper.diagnostics.failure')}</th>
                <th scope="col">{t('scraper.diagnostics.stage')}</th>
                <th scope="col">{t('scraper.diagnostics.category')}</th>
                <th scope="col">{t('scraper.diagnostics.mode')}</th>
                <th scope="col">{t('scraper.diagnostics.recordedAt')}</th>
                <th scope="col">{t('workspace.members.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr key={summary.diagnostics_id}>
                  <td className="data-table__mono"><code>{summary.failure_code}</code></td>
                  <td>{stageLabel(summary.stage)}</td>
                  <td>{categoryLabel(summary.category)}</td>
                  <td>{modeLabel(summary.mode)}</td>
                  <td>{formatInstant(summary.recorded_at)}</td>
                  <td>
                    <Button
                      variant="secondary"
                      busy={busy}
                      onClick={() => onSelect(summary.diagnostics_id)}
                    >
                      {t('scraper.diagnostics.inspect')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel level={2} title={t('scraper.diagnostics.detailTitle')}>
        {selected === null ? (
          <p className="empty">{t('scraper.diagnostics.select')}</p>
        ) : (
          <>
            <DefinitionList
              rows={[
                { term: t('scraper.diagnostics.failure'), value: selected.failure_code, mono: true },
                { term: t('scraper.diagnostics.stage'), value: stageLabel(selected.stage) },
                { term: t('scraper.diagnostics.category'), value: categoryLabel(selected.category) },
                { term: t('scraper.diagnostics.mode'), value: modeLabel(selected.mode) },
                { term: t('scraper.diagnostics.recordedAt'), value: formatInstant(selected.recorded_at) },
                { term: t('scraper.diagnostics.taskVersion'), value: message('scraper.task.list.version', { version: String(selected.scraper_task_version) }) },
                { term: t('scraper.diagnostics.serviceVersion'), value: message('scraper.service.version', { version: String(selected.scraper_service_version) }) },
                { term: t('scraper.diagnostics.fixturesHash'), value: selected.fixtures_hash, mono: true },
                { term: t('scraper.diagnostics.evidence'), value: selected.evidence_hash, mono: true },
                { term: t('scraper.diagnostics.sanitized'), value: t('scraper.diagnostics.sanitized') },
              ]}
            />
            {selected.diagnostics.length === 0 ? (
              <p className="empty">{t('scraper.diagnostics.noEvidence')}</p>
            ) : (
              selected.diagnostics.map((diagnostic, index) => (
                <div className="context-history__item" key={`${diagnostic.code}-${String(index)}`}>
                  <h3 className="context-history__version">
                    <code>{diagnostic.code}</code>
                    {diagnostic.page === null ? '' : ` · ${message('scraper.diagnostics.pageNumber', { page: String(diagnostic.page) })}`}
                  </h3>
                  <p>{diagnostic.message}</p>
                  <DefinitionList
                    rows={[
                      { term: t('scraper.diagnostics.method'), value: diagnostic.request.method, mono: true },
                      { term: t('scraper.diagnostics.url'), value: diagnostic.request.url, mono: true },
                      { term: t('scraper.diagnostics.headers'), value: diagnostic.request.header_names.join('、') },
                      { term: t('scraper.diagnostics.credentials'), value: joined(diagnostic.request.credential_refs) },
                      {
                        term: t('scraper.diagnostics.status'),
                        value: diagnostic.page_evidence.status === null ? t('scraper.task.list.none') : String(diagnostic.page_evidence.status),
                      },
                      {
                        term: t('scraper.diagnostics.contentType'),
                        value: diagnostic.page_evidence.content_type ?? t('scraper.task.list.none'),
                        mono: true,
                      },
                      {
                        term: t('scraper.diagnostics.responseHash'),
                        value: diagnostic.page_evidence.response_hash ?? t('scraper.task.list.none'),
                        mono: true,
                      },
                      {
                        term: t('scraper.diagnostics.responseBytes'),
                        value: diagnostic.page_evidence.response_bytes === null ? t('scraper.task.list.none') : String(diagnostic.page_evidence.response_bytes),
                      },
                      {
                        term: t('scraper.diagnostics.raw'),
                        value: diagnostic.raw_refs.length === 0
                          ? t('scraper.task.list.none')
                          : diagnostic.raw_refs.map((raw) => raw.raw_id).join('、'),
                        mono: true,
                      },
                    ]}
                  />
                  {diagnostic.page_evidence.body_excerpt === null ? null : (
                    <pre className="field__input field__input--mono">{diagnostic.page_evidence.body_excerpt}</pre>
                  )}
                  {diagnostic.page_evidence.excerpt_truncated ? (
                    <p className="field__hint">{t('scraper.diagnostics.excerptTruncated')}</p>
                  ) : null}
                </div>
              ))
            )}
          </>
        )}
      </Panel>
    </>
  );
}

interface RepairPanelProps {
  summaries: ScraperDiagnosticsSummaryView[];
  tasks: ScraperTaskView[];
  bindings: ModelBindingView[];
  busy: boolean;
  onRepair: (diagnosticsId: string, bindingId: string, taskVersion: number) => void;
}

function RepairPanel({ summaries, tasks, bindings, busy, onRepair }: RepairPanelProps) {
  const [diagnosticsId, setDiagnosticsId] = useState(summaries[summaries.length - 1]?.diagnostics_id ?? '');
  const [bindingId, setBindingId] = useState(bindings[0]?.binding_id ?? '');
  const [taskId, setTaskId] = useState(tasks[0]?.scraper_task_id ?? '');
  const task = tasks.find((candidate) => candidate.scraper_task_id === taskId);
  const [taskVersion, setTaskVersion] = useState(
    String(tasks[0]?.scraper_task_version ?? 1),
  );
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (summaries.length === 0) return;
    setDiagnosticsId((current) => (summaries.some((summary) => summary.diagnostics_id === current)
      ? current
      : summaries[summaries.length - 1]!.diagnostics_id));
  }, [summaries]);

  useEffect(() => {
    if (bindings.length === 0) return;
    setBindingId((current) => (bindings.some((binding) => binding.binding_id === current)
      ? current
      : bindings[0]!.binding_id));
  }, [bindings]);

  const submit = (): void => {
    if (diagnosticsId === '') {
      setNotice({ tone: 'error', text: t('scraper.repair.selectDiagnostics') });
      return;
    }
    if (bindingId === '') {
      setNotice({ tone: 'error', text: t('scraper.repair.bindingMissing') });
      return;
    }
    setNotice(null);
    onRepair(diagnosticsId, bindingId, Number(taskVersion));
  };

  return (
    <Panel level={2} title={t('scraper.repair.title')} description={t('scraper.repair.description')}>
      <NoticeLine notice={notice} />
      <p className="field__hint">{t('scraper.repair.failed')}</p>
      <div className="field">
        <label className="field__label" htmlFor="scraper-repair-task">
          {t('scraper.task.title')}
        </label>
        <select
          className="field__input"
          id="scraper-repair-task"
          value={taskId}
          onChange={(event) => {
            setTaskId(event.target.value);
            const chosen = tasks.find((candidate) => candidate.scraper_task_id === event.target.value);
            setTaskVersion(String(chosen?.scraper_task_version ?? 1));
          }}
        >
          {tasks.map((candidate) => (
            <option key={candidate.scraper_task_id} value={candidate.scraper_task_id}>{candidate.name}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="scraper-repair-task-version">
          {t('scraper.repair.taskVersion')}
        </label>
        <select
          className="field__input"
          id="scraper-repair-task-version"
          value={taskVersion}
          onChange={(event) => setTaskVersion(event.target.value)}
        >
          {(task?.versions ?? []).map((version) => (
            <option key={version.scraper_task_version} value={String(version.scraper_task_version)}>
              {message('scraper.task.list.version', { version: String(version.scraper_task_version) })}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="scraper-repair-diagnostics">
          {t('scraper.repair.diagnostics')}
        </label>
        <select
          className="field__input"
          id="scraper-repair-diagnostics"
          value={diagnosticsId}
          onChange={(event) => setDiagnosticsId(event.target.value)}
        >
          {summaries.length === 0 ? <option value="">{t('scraper.diagnostics.empty')}</option> : null}
          {summaries.map((summary) => (
            <option key={summary.diagnostics_id} value={summary.diagnostics_id}>
              {`${summary.failure_code} · ${formatInstant(summary.recorded_at)}`}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="scraper-repair-binding">
          {t('scraper.repair.binding')}
        </label>
        <select
          className="field__input"
          id="scraper-repair-binding"
          value={bindingId}
          onChange={(event) => setBindingId(event.target.value)}
        >
          {bindings.length === 0 ? <option value="">{t('scraper.repair.bindingEmpty')}</option> : null}
          {bindings.map((binding) => (
            <option key={binding.binding_id} value={binding.binding_id}>
              {`${binding.model_profile_name ?? binding.model_profile_id} · v${String(binding.model_profile_version)}`}
            </option>
          ))}
        </select>
      </div>
      <Button busy={busy} onClick={submit}>
        {busy ? t('scraper.repair.generating') : t('scraper.repair.generate')}
      </Button>
    </Panel>
  );
}

interface RunConsoleProps {
  workspaceId: string;
  sources: ScraperWorkspaceView['sources'];
  onChanged: () => Promise<void>;
  onInspectDiagnostics: (diagnosticsId: string) => void;
  onSessionLost: () => void;
}

/** Repeated acquisition through the adopted Version, with manifest and evidence. */
function RunConsole({ workspaceId, sources, onChanged, onInspectDiagnostics, onSessionLost }: RunConsoleProps) {
  const [sourceId, setSourceId] = useState(sources[0]?.source_id ?? '');
  const [parameters, setParameters] = useState('{"region":"east"}');
  const [runs, setRuns] = useState<ScraperRunList | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sourceId === '') {
      setRuns(null);
      return;
    }
    const result = await platformApi.scraperRuns(workspaceId, sourceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice(failureNotice(result.error));
      return;
    }
    setRuns(result.data);
    setSelectedRunId((current) => result.data.runs.some((run) => run.acquisition_run_id === current)
      ? current
      : (result.data.runs[result.data.runs.length - 1]?.acquisition_run_id ?? null));
  }, [workspaceId, sourceId, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (): Promise<void> => {
    if (sourceId === '') {
      setNotice({ tone: 'error', text: t('scraper.run.chooseSource') });
      return;
    }
    let stated: Record<string, string>;
    try {
      stated = JSON.parse(parameters) as Record<string, string>;
    } catch {
      setNotice({ tone: 'error', text: t('scraper.parameters.invalidJson') });
      return;
    }
    setRunning(true);
    setNotice(null);
    const result = await platformApi.runScraperSource(workspaceId, sourceId, stated);
    setRunning(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      await load();
      setNotice({
        tone: 'error',
        text: t('scraper.run.failedNotice'),
        ...(result.error.code === 'UNKNOWN' ? {} : { code: result.error.code }),
      });
      return;
    }
    await load();
    await onChanged();
    setNotice({
      tone: 'info',
      text: message('scraper.run.completed', {
        release: String(result.data.dataset_release ?? 0),
        records: String(result.data.record_count),
      }),
    });
  };

  const selected = runs?.runs.find((entry) => entry.acquisition_run_id === selectedRunId) ?? null;

  return (
    <Panel level={2} title={t('scraper.run.title')} description={t('scraper.task.description')}>
      <NoticeLine notice={notice} />
      {sources.length === 0 ? (
        <p className="empty">{t('scraper.run.noSources')}</p>
      ) : (
        <>
          <div className="field">
            <label className="field__label" htmlFor="scraper-run-source">
              {t('scraper.run.source')}
            </label>
            <select
              className="field__input"
              id="scraper-run-source"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">{t('scraper.run.chooseSource')}</option>
              {sources.map((source) => (
                <option key={source.source_id} value={source.source_id}>{source.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="scraper-run-parameters">
              {t('scraper.run.parameters')}
            </label>
            <textarea
              className="field__input field__input--area field__input--mono"
              id="scraper-run-parameters"
              rows={2}
              value={parameters}
              onChange={(event) => setParameters(event.target.value)}
              spellCheck={false}
            />
            <p className="field__hint">{t('scraper.run.parametersHint')}</p>
          </div>
          <Button busy={running} onClick={() => void run()}>
            {running ? t('scraper.run.running') : t('scraper.run.submit')}
          </Button>
        </>
      )}

      {runs === null ? null : (
        <>
          <Panel level={2} title={t('scraper.run.listTitle')}>
          <DefinitionList
            rows={[
              {
                term: t('scraper.run.adoptedVersion'),
                value: runs.adopted === null
                  ? t('scraper.run.adoptedNone')
                  : message('scraper.service.version', { version: String(runs.adopted.adopted_version) }),
              },
              {
                term: t('scraper.run.latestRelease'),
                value: runs.latest_release === null
                  ? t('scraper.run.releaseEmpty')
                  : message('scraper.run.releaseSummary', {
                    release: String(runs.latest_release.release),
                    records: String(runs.latest_release.record_count),
                  }),
              },
            ]}
          />
          {runs.runs.length === 0 ? (
            <p className="empty">{t('scraper.run.listEmpty')}</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('scraper.run.status')}</th>
                  <th scope="col">{t('scraper.run.version')}</th>
                  <th scope="col">{t('scraper.run.records')}</th>
                  <th scope="col">{t('scraper.run.release')}</th>
                  <th scope="col">{t('scraper.run.startedAt')}</th>
                  <th scope="col">{t('workspace.members.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.runs.map((entry) => (
                  <tr key={entry.acquisition_run_id}>
                    <td>{optional(`value.state.${entry.status}`) ?? entry.status}</td>
                    <td>
                      {entry.manifest === null
                        ? t('scraper.task.list.none')
                        : message('scraper.service.version', { version: String(entry.manifest.scraper_service_version) })}
                    </td>
                    <td>{entry.manifest?.record_count ?? 0}</td>
                    <td>
                      {entry.dataset_release === null
                        ? t('scraper.run.releaseNone')
                        : message('scraper.service.version', { version: String(entry.dataset_release) })}
                    </td>
                    <td>{formatInstant(entry.started_at ?? entry.queued_at)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => setSelectedRunId(entry.acquisition_run_id)}
                      >
                        {t('scraper.run.inspect')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </Panel>
          {selected === null ? null : (
            <RunManifest run={selected} onInspectDiagnostics={onInspectDiagnostics} />
          )}
        </>
      )}
    </Panel>
  );
}

function RunManifest({
  run,
  onInspectDiagnostics,
}: {
  run: ScraperRunView;
  onInspectDiagnostics: (diagnosticsId: string) => void;
}) {
  return (
    <Panel level={2} title={t('scraper.run.manifest')}>
      <DefinitionList
        rows={[
          {
            term: t('scraper.provenance.task'),
            value: run.manifest === null
              ? t('scraper.task.list.none')
              : message('scraper.run.manifestVersions', {
                task: String(run.manifest.scraper_task_version),
                service: String(run.manifest.scraper_service_version),
              }),
          },
          {
            term: t('scraper.run.parameters'),
            value: run.manifest === null
              ? t('scraper.task.list.none')
              : Object.entries(run.manifest.parameters).map(([key, value]) => `${key}=${value}`).join('、'),
            mono: true,
          },
          { term: t('scraper.run.records'), value: String(run.manifest?.record_count ?? 0) },
          {
            term: t('scraper.run.raw'),
            value: run.raw_acquisitions.length === 0
              ? t('scraper.task.list.none')
              : run.raw_acquisitions.map((raw) => `${raw.raw_id} · ${raw.content_hash}`).join('、'),
            mono: true,
          },
        ]}
      />
      {run.manifest === null || run.manifest.pages.length === 0 ? (
        <p className="empty">{t('scraper.run.noEvidence')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('scraper.diagnostics.page')}</th>
              <th scope="col">{t('scraper.run.pageUrl')}</th>
              <th scope="col">{t('scraper.run.pageStatus')}</th>
              <th scope="col">{t('scraper.run.pageRecords')}</th>
              <th scope="col">{t('scraper.run.hash')}</th>
            </tr>
          </thead>
          <tbody>
            {run.manifest.pages.map((page) => (
              <tr key={page.page}>
                <td>{page.page}</td>
                <td className="data-table__mono">{page.url}</td>
                <td>{page.status}</td>
                <td>{page.record_count}</td>
                <td className="data-table__mono"><code>{page.response_hash}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run.diagnostics_id === null ? (
        <p className="field__hint">{t('scraper.run.noEvidence')}</p>
      ) : (
        <Button variant="secondary" onClick={() => onInspectDiagnostics(run.diagnostics_id!)}>
          {t('scraper.run.diagnosticsLink')}
        </Button>
      )}
    </Panel>
  );
}

/**
 * The Workspace Administrator's Scraper Service surface: the guided Task form,
 * the published Versions and Source pins, the Proposal review with its four
 * separate exact-version actions, the recorded failure diagnoses and isolated
 * repair, and the repeated Runs of the adopted Version.
 */
export function WorkspaceScrapers({ workspaceId, onSessionLost }: WorkspaceScrapersProps) {
  const [workspace, setWorkspace] = useState<ScraperWorkspaceView | null>(null);
  const [proposals, setProposals] = useState<ScraperProposalList | null>(null);
  const [bindings, setBindings] = useState<ModelBindingView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedProposal, setSelectedProposal] = useState<string | null>(null);
  const [selectedDiagnostics, setSelectedDiagnostics] = useState<ScraperDiagnosticsView | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [compiling, setCompiling] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [changed, setChanged] = useState(0);

  const reloadProposals = useCallback(async (selectId?: string): Promise<void> => {
    const result = await platformApi.scraperProposals(workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setProposals(result.data);
    if (selectId !== undefined) {
      setSelectedProposal(selectId);
      return;
    }
    setSelectedProposal((current) => result.data.proposals.some((proposal) => proposal.proposal_id === current)
      ? current
      : (result.data.proposals[result.data.proposals.length - 1]?.proposal_id ?? null));
  }, [workspaceId, onSessionLost]);

  const loadWorkspace = useCallback(async (): Promise<void> => {
    const result = await platformApi.scrapers(workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setWorkspace(result.data);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    void loadWorkspace();
    void reloadProposals();
  }, [loadWorkspace, reloadProposals, changed]);

  useEffect(() => {
    void platformApi.modelBindings(workspaceId).then((result) => {
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setBindings([]);
        return;
      }
      setBindings(result.data.bindings);
    });
  }, [workspaceId, onSessionLost]);

  const compile = async (task: ScraperTaskView): Promise<void> => {
    setCompiling(task.scraper_task_id);
    setNotice(null);
    const result = await platformApi.compileScraperTask(task.scraper_task_id, task.scraper_task_version);
    setCompiling(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice(failureNotice(result.error));
      return;
    }
    await reloadProposals(result.data.proposal_id);
    setNotice({ tone: 'info', text: t('scraper.task.list.compiled') });
  };

  const inspectDiagnostics = async (diagnosticsId: string): Promise<void> => {
    setDiagnosticsBusy(true);
    const result = await platformApi.scraperDiagnostics(diagnosticsId);
    setDiagnosticsBusy(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice(failureNotice(result.error));
      return;
    }
    setSelectedDiagnostics(result.data);
  };

  const repair = async (diagnosticsId: string, bindingId: string, taskVersion: number): Promise<void> => {
    setRepairing(true);
    setNotice(null);
    const result = await platformApi.repairScraper(diagnosticsId, bindingId, taskVersion);
    setRepairing(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice(failureNotice(result.error));
      return;
    }
    await reloadProposals(result.data.proposal_id);
    setNotice({ tone: 'info', text: t('scraper.notice.repairGenerated') });
  };

  const selected = proposals?.proposals.find((proposal) => proposal.proposal_id === selectedProposal) ?? null;

  return (
    <Panel level={1} title={t('scraper.title')} description={t('scraper.task.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      <NoticeLine notice={notice} />

      {workspace === null ? (
        <p className="empty" role="status">{t('platform.loading')}</p>
      ) : (
        <>
          <TaskForm
            workspaceId={workspaceId}
            credentials={workspace.credentials}
            onPublished={() => {
              setChanged((value) => value + 1);
            }}
            onSessionLost={onSessionLost}
          />
          <TaskList tasks={workspace.tasks} compiling={compiling} onCompile={(task) => void compile(task)} />
          <ServicePanels workspace={workspace} />

          <Panel level={2} title={t('scraper.proposal.list.title')}>
            {proposals === null ? (
              <p className="empty">{t('scraper.proposal.list.empty')}</p>
            ) : proposals.proposals.length === 0 ? (
              <p className="empty">{t('scraper.proposal.list.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('scraper.proposal.title')}</th>
                    <th scope="col">{t('scraper.proposal.list.taskVersion')}</th>
                    <th scope="col">{t('scraper.proposal.list.base')}</th>
                    <th scope="col">{t('scraper.proposal.list.repair')}</th>
                    <th scope="col">{t('scraper.proposal.list.fresh')}</th>
                    <th scope="col">{t('workspace.members.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.proposals.map((proposal) => (
                    <tr key={proposal.proposal_id}>
                      <td>{statusLabel(proposal.status)}</td>
                      <td>{message('scraper.task.list.version', { version: String(proposal.scraper_task_version) })}</td>
                      <td>
                        {proposal.base.scraper_service_version === null
                          ? t('scraper.proposal.list.baseNone')
                          : message('scraper.service.version', { version: String(proposal.base.scraper_service_version) })}
                      </td>
                      <td>{proposal.repair === null ? t('scraper.proposal.list.plain') : proposal.repair.failure_code}</td>
                      <td>{proposal.fresh === false ? t('scraper.proposal.list.stale') : t('scraper.proposal.list.fresh')}</td>
                      <td>
                        <Button
                          variant="secondary"
                          busy={selectedProposal === proposal.proposal_id}
                          onClick={() => setSelectedProposal(proposal.proposal_id)}
                        >
                          {t('scraper.proposal.list.inspect')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          {selected === null ? (
            <p className="empty">{t('scraper.proposal.select')}</p>
          ) : (
            <ProposalDetail
              key={selected.proposal_id}
              proposal={selected}
              sources={workspace.sources}
              onChanged={async (selectId) => {
                await reloadProposals(selectId);
                // Approval, Publication, and Adoption change the Task, Service,
                // and Source surface too, so it is read again from the server.
                setChanged((value) => value + 1);
              }}
              onSessionLost={onSessionLost}
            />
          )}

          <DiagnosticsPanels
            summaries={proposals?.diagnostics ?? []}
            selected={selectedDiagnostics}
            busy={diagnosticsBusy}
            onSelect={(diagnosticsId) => void inspectDiagnostics(diagnosticsId)}
          />
          <RepairPanel
            summaries={proposals?.diagnostics ?? []}
            tasks={workspace.tasks}
            bindings={bindings ?? []}
            busy={repairing}
            onRepair={(diagnosticsId, bindingId, taskVersion) =>
              void repair(diagnosticsId, bindingId, taskVersion)}
          />
          <RunConsole
            workspaceId={workspaceId}
            sources={workspace.sources}
            onChanged={async () => {
              setChanged((value) => value + 1);
            }}
            onInspectDiagnostics={(diagnosticsId) => void inspectDiagnostics(diagnosticsId)}
            onSessionLost={onSessionLost}
          />
        </>
      )}
    </Panel>
  );
}
