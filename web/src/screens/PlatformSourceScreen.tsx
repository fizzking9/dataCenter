import { useCallback, useEffect, useRef, useState } from 'react';
import {
  platformApi,
  type IntegrationDeclaration,
  type SourceAcquisitionView,
  type SourceConfigurationPreview,
  type SourceDetailView,
  type SourceList,
  type SourceRejectionView,
  type SourceSchemaField,
  type SourceSummary,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import { ApiSourcePanels } from './PlatformApiSourceScreen.js';

export interface WorkspaceSourcesProps {
  workspaceId: string;
  onSessionLost: () => void;
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

interface SchemaRow {
  key: string;
  name: string;
  type: SourceSchemaField['type'];
  identity: boolean;
}

interface CleaningRow {
  key: string;
  rule: IntegrationDeclaration['cleaning'][number]['rule'];
  field: string;
  value: string;
}

interface MappingRow {
  key: string;
  column: string;
  target: string;
}

let nextRowKey = 0;
function rowKey(): string {
  nextRowKey += 1;
  return `source-row-${nextRowKey}`;
}

const FIELD_TYPES: SourceSchemaField['type'][] = ['string', 'integer', 'number', 'date', 'timestamp'];
const CLEANING_RULES: CleaningRow['rule'][] = ['trim', 'uppercase', 'lowercase', 'default', 'require_non_empty'];
const SOURCE_TYPES: Array<{
  value: SourceSummary['type'];
  labelKey: 'value.sourceType.file' | 'value.sourceType.document' | 'value.sourceType.http_json' | 'value.sourceType.scraper';
}> = [
  { value: 'file', labelKey: 'value.sourceType.file' },
  { value: 'document', labelKey: 'value.sourceType.document' },
  { value: 'http_json', labelKey: 'value.sourceType.http_json' },
  { value: 'scraper', labelKey: 'value.sourceType.scraper' },
];

/**
 * The guided Source workflow of one Workspace. The browser collects form fields
 * and renders what the server answers; validation, authorization, byte sniffing,
 * integration, and Release history all belong to the governed modules.
 */
export function WorkspaceSources({ workspaceId, onSessionLost }: WorkspaceSourcesProps) {
  const [list, setList] = useState<SourceList | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<SourceSummary['type']>('file');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<SourceSummary | null>(null);
  const [changed, setChanged] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    const result = await platformApi.sources(workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setList(result.data);
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load, changed]);

  const create = (): void => {
    setCreating(true);
    setNotice(null);
    void platformApi.createSource(workspaceId, name, type).then((result) => {
      setCreating(false);
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
        text: message('workspace.sources.created', { name: result.data.name }),
      });
      setName('');
      setChanged((value) => value + 1);
    });
  };

  return (
    <Panel level={1} title={t('workspace.sources.title')} description={t('workspace.sources.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      <Panel
        level={2}
        title={t('workspace.sources.create.title')}
        description={t('workspace.sources.create.description')}
      >
        {notice === null ? null : (
          <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
            {notice.text}
          </Alert>
        )}
        <Field
          id="source-create-name"
          label={t('workspace.sources.name')}
          value={name}
          onChange={setName}
          maxLength={128}
        />
        <div className="field">
          <label className="field__label" htmlFor="source-create-type">
            {t('workspace.sources.type')}
          </label>
          <select
            className="field__input"
            id="source-create-type"
            value={type}
            onChange={(event) => {
              const chosen = event.target.value;
              if (chosen === 'file' || chosen === 'document' || chosen === 'http_json' || chosen === 'scraper') {
                setType(chosen);
              }
            }}
          >
            {SOURCE_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <Button busy={creating} onClick={create}>
          {creating ? t('workspace.sources.create.creating') : t('workspace.sources.create.submit')}
        </Button>
      </Panel>

      {list === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : list.sources.length === 0 ? (
        <p className="empty">{t('workspace.sources.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('workspace.sources.name')}</th>
              <th scope="col">{t('workspace.sources.type')}</th>
              <th scope="col">{t('workspace.members.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {list.sources.map((source) => (
              <tr key={source.source_id}>
                <td>{source.name}</td>
                <td>{optional(`value.sourceType.${source.type}`) ?? source.type}</td>
                <td>
                  <Button
                    variant="secondary"
                    busy={selected?.source_id === source.source_id}
                    onClick={() => setSelected(source)}
                  >
                    {message('workspace.sources.manage', { name: source.name })}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected === null ? (
        <p className="empty">{t('workspace.sources.select')}</p>
      ) : (
        <SourceManagement
          key={selected.source_id}
          source={selected}
          onSessionLost={onSessionLost}
          onChanged={() => setChanged((value) => value + 1)}
        />
      )}
    </Panel>
  );
}

interface SourceManagementProps {
  source: SourceSummary;
  onSessionLost: () => void;
  onChanged: () => void;
}

function SourceManagement({ source, onSessionLost, onChanged }: SourceManagementProps) {
  const [detail, setDetail] = useState<SourceDetailView | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<SourceConfigurationPreview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uploadNotice, setUploadNotice] = useState<Notice | null>(null);
  const [preserved, setPreserved] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SourceAcquisitionView | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [adopting, setAdopting] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [schema, setSchema] = useState<SchemaRow[]>([
    { key: rowKey(), name: '', type: 'string', identity: false },
  ]);
  const [cleaning, setCleaning] = useState<CleaningRow[]>([]);
  const [mapping, setMapping] = useState<MappingRow[]>([{ key: rowKey(), column: '', target: '' }]);
  const [limits, setLimits] = useState({ maxBytes: '', maxDocuments: '', maxTextChars: '' });

  const load = useCallback(async (): Promise<void> => {
    const result = await platformApi.source(source.source_id);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setDetail(result.data);
  }, [source.source_id, onSessionLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const namedFields = schema.filter((row) => row.name.trim() !== '');
  const isDocument = detail?.source.type === 'document';

  /** The declaration exactly as the form states it; the server fills defaults. */
  const declaration = (): Record<string, unknown> => {
    const documentLimits = isDocument
      ? Object.fromEntries(
        ([['max_bytes', limits.maxBytes], ['max_documents', limits.maxDocuments], ['max_text_chars', limits.maxTextChars]] as const)
          .flatMap(([key, value]) => (value.trim() === '' ? [] : [[key, Number(value)]])),
      )
      : {};
    return {
      identity: namedFields.filter((row) => row.identity).map((row) => row.name),
      schema: namedFields.map((row) => ({ name: row.name, type: row.type })),
      cleaning: cleaning
        .filter((row) => row.field !== '')
        .map((row) => (row.rule === 'default'
          ? { rule: row.rule, field: row.field, value: row.value }
          : { rule: row.rule, field: row.field })),
      mapping: Object.fromEntries(
        mapping
          .filter((row) => row.column.trim() !== '' && row.target !== '')
          .map((row) => [row.column, row.target]),
      ),
      ...(isDocument ? { document_limits: documentLimits } : {}),
    };
  };

  const requestPreview = (): void => {
    setPreviewing(true);
    setNotice(null);
    setPreserved(null);
    void platformApi.previewSourceConfiguration(source.source_id, declaration()).then((result) => {
      setPreviewing(false);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setPreview(result.data);
    });
  };

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setNotice(null);
    const declarationToPublish = preview?.declaration ?? null;
    const result = await platformApi.publishSourceConfiguration(
      source.source_id,
      (declarationToPublish ?? declaration()) as unknown as Record<string, unknown>,
    );
    setPublishing(false);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    // The announced Version appears only once the Version list is on screen.
    setPreview(null);
    await load();
    setNotice({
      tone: 'info',
      text: message('workspace.sources.preview.published', {
        version: String(result.data.integration_configuration_version),
      }),
    });
    onChanged();
  };

  const adopt = async (version: number): Promise<void> => {
    setAdopting(version);
    setNotice(null);
    const result = await platformApi.adoptSourceConfiguration(source.source_id, version);
    setAdopting(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    await load();
    setNotice({
      tone: 'info',
      text: message('workspace.sources.versions.adoptedNotice', { version: String(version) }),
    });
    onChanged();
  };

  const upload = async (): Promise<void> => {
    // Read the control itself: the click must never race the change event.
    const chosen = fileInput.current?.files?.[0] ?? null;
    setUploadNotice(null);
    setPreserved(null);
    setOutcome(null);
    setPreview(null);
    if (chosen === null) return;
    setUploading(true);
    const result = await platformApi.uploadSourceAcquisition(source.source_id, chosen);
    setUploading(false);
    if (fileInput.current !== null) fileInput.current.value = '';
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      await load();
      setUploadNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      if (result.error.raw_acquisition_saved === true) {
        setPreserved(result.error.current_release === undefined
          ? t('workspace.sources.upload.preservedNoRelease')
          : message('workspace.sources.upload.preserved', {
            release: String(result.error.current_release),
          }));
      }
      onChanged();
      return;
    }
    // The success sentence appears only once the new Release and Provenance do.
    setOutcome(result.data);
    await load();
    const integrated = result.data.integration;
    setUploadNotice({
      tone: 'info',
      text: message('workspace.sources.upload.completed', {
        release: String(integrated?.dataset_release ?? 0),
        records: String(integrated?.accepted_records ?? 0),
      }),
    });
    onChanged();
  };

  const updateSchema = (key: string, patch: Partial<SchemaRow>): void => {
    setSchema((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const updateCleaning = (key: string, patch: Partial<CleaningRow>): void => {
    setCleaning((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const updateMapping = (key: string, patch: Partial<MappingRow>): void => {
    setMapping((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const latest = detail?.dataset.latest;
  const rejections = latest?.record_rejections ?? [];
  const runs = detail?.runs ?? [];
  const versions = detail?.configuration.versions ?? [];
  const latestAcquisition = detail?.latest_acquisition ?? null;
  const isConnector = detail?.source.type === 'http_json';

  return (
    <>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      {detail === null || !isConnector ? null : (
        <ApiSourcePanels
          workspaceId={detail.source.workspace_id}
          detail={detail}
          onSessionLost={onSessionLost}
          onReload={load}
          onChanged={onChanged}
        />
      )}
      <Panel
        level={2}
        title={t('workspace.sources.wizard.title')}
        description={t('workspace.sources.wizard.description')}
      >
        <h3 className="panel__title">{t('workspace.sources.wizard.schema')}</h3>
        {schema.map((row, index) => (
          <div className="context-history__item" key={row.key}>
            <Field
              id={`source-schema-name-${String(index + 1)}`}
              label={message('workspace.sources.wizard.fieldName', { index: String(index + 1) })}
              value={row.name}
              onChange={(value) => updateSchema(row.key, { name: value })}
              maxLength={64}
              mono
            />
            <div className="field">
              <label className="field__label" htmlFor={`source-schema-type-${String(index + 1)}`}>
                {message('workspace.sources.wizard.fieldType', { index: String(index + 1) })}
              </label>
              <select
                className="field__input"
                id={`source-schema-type-${String(index + 1)}`}
                value={row.type}
                onChange={(event) => {
                  const chosen = event.target.value;
                  if (FIELD_TYPES.includes(chosen as SourceSchemaField['type'])) {
                    updateSchema(row.key, { type: chosen as SourceSchemaField['type'] });
                  }
                }}
              >
                {FIELD_TYPES.map((fieldType) => (
                  <option key={fieldType} value={fieldType}>
                    {t(`value.fieldType.${fieldType}`)}
                  </option>
                ))}
              </select>
            </div>
            {row.name.trim() === '' ? null : (
              <div className="field">
                <label className="field__label" htmlFor={`source-identity-${row.key}`}>
                  {t('workspace.sources.wizard.identity')}
                </label>
                <input
                  id={`source-identity-${row.key}`}
                  type="checkbox"
                  aria-label={row.name}
                  checked={row.identity}
                  onChange={(event) => updateSchema(row.key, { identity: event.target.checked })}
                />
              </div>
            )}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setSchema((rows) => [
          ...rows,
          { key: rowKey(), name: '', type: 'string', identity: false },
        ])}>
          {t('workspace.sources.wizard.addField')}
        </Button>

        <h3 className="panel__title">{t('workspace.sources.wizard.cleaning')}</h3>
        {cleaning.map((row, index) => (
          <div className="context-history__item" key={row.key}>
            <div className="field">
              <label className="field__label" htmlFor={`source-cleaning-field-${String(index + 1)}`}>
                {message('workspace.sources.wizard.cleaningField', { index: String(index + 1) })}
              </label>
              <select
                className="field__input"
                id={`source-cleaning-field-${String(index + 1)}`}
                value={row.field}
                onChange={(event) => updateCleaning(row.key, { field: event.target.value })}
              >
                <option value="">—</option>
                {namedFields.map((field) => (
                  <option key={field.key} value={field.name}>{field.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`source-cleaning-rule-${String(index + 1)}`}>
                {message('workspace.sources.wizard.cleaningRule', { index: String(index + 1) })}
              </label>
              <select
                className="field__input"
                id={`source-cleaning-rule-${String(index + 1)}`}
                value={row.rule}
                onChange={(event) => {
                  const chosen = event.target.value;
                  if (CLEANING_RULES.includes(chosen as CleaningRow['rule'])) {
                    updateCleaning(row.key, { rule: chosen as CleaningRow['rule'] });
                  }
                }}
              >
                {CLEANING_RULES.map((rule) => (
                  <option key={rule} value={rule}>
                    {t(`value.cleaning.${rule}`)}
                  </option>
                ))}
              </select>
            </div>
            {row.rule === 'default' ? (
              <Field
                id={`source-cleaning-value-${String(index + 1)}`}
                label={message('workspace.sources.wizard.cleaningValue', { index: String(index + 1) })}
                value={row.value}
                onChange={(value) => updateCleaning(row.key, { value })}
                maxLength={256}
              />
            ) : null}
          </div>
        ))}
        <Button variant="secondary" onClick={() => setCleaning((rows) => [
          ...rows,
          { key: rowKey(), rule: 'trim', field: '', value: '' },
        ])}>
          {t('workspace.sources.wizard.addCleaning')}
        </Button>

        <h3 className="panel__title">{t('workspace.sources.wizard.mapping')}</h3>
        {mapping.map((row, index) => (
          <div className="context-history__item" key={row.key}>
            <Field
              id={`source-mapping-column-${String(index + 1)}`}
              label={message('workspace.sources.wizard.sourceColumn', { index: String(index + 1) })}
              value={row.column}
              onChange={(value) => updateMapping(row.key, { column: value })}
              maxLength={256}
              mono
            />
            <div className="field">
              <label className="field__label" htmlFor={`source-mapping-target-${String(index + 1)}`}>
                {message('workspace.sources.wizard.targetField', { index: String(index + 1) })}
              </label>
              <select
                className="field__input"
                id={`source-mapping-target-${String(index + 1)}`}
                value={row.target}
                onChange={(event) => updateMapping(row.key, { target: event.target.value })}
              >
                <option value="">—</option>
                {namedFields.map((field) => (
                  <option key={field.key} value={field.name}>{field.name}</option>
                ))}
              </select>
            </div>
          </div>
        ))}
        <Button variant="secondary" onClick={() => setMapping((rows) => [
          ...rows,
          { key: rowKey(), column: '', target: '' },
        ])}>
          {t('workspace.sources.wizard.addMapping')}
        </Button>

        {isDocument ? (
          <>
            <h3 className="panel__title">{t('workspace.sources.wizard.limits')}</h3>
            <Field
              id="source-limit-max-bytes"
              label={t('workspace.sources.wizard.maxBytes')}
              value={limits.maxBytes}
              onChange={(value) => setLimits((current) => ({ ...current, maxBytes: value }))}
              inputMode="numeric"
            />
            <Field
              id="source-limit-max-documents"
              label={t('workspace.sources.wizard.maxDocuments')}
              value={limits.maxDocuments}
              onChange={(value) => setLimits((current) => ({ ...current, maxDocuments: value }))}
              inputMode="numeric"
            />
            <Field
              id="source-limit-max-text-chars"
              label={t('workspace.sources.wizard.maxTextChars')}
              value={limits.maxTextChars}
              onChange={(value) => setLimits((current) => ({ ...current, maxTextChars: value }))}
              inputMode="numeric"
            />
          </>
        ) : null}

        <Button busy={previewing} onClick={requestPreview}>
          {previewing ? t('workspace.sources.wizard.previewing') : t('workspace.sources.wizard.preview')}
        </Button>
      </Panel>

      {preview === null ? null : (
        <Panel level={2} title={t('workspace.sources.preview.title')}>
          {preview.valid ? (
            <>
              <p role="status">{t('workspace.sources.preview.valid')}</p>
              <pre className="field__input field__input--mono">
                {JSON.stringify(preview.declaration, null, 2)}
              </pre>
              <p>
                {t('workspace.sources.preview.hash')}
                {' '}
                <code>{preview.content_hash}</code>
              </p>
              <Button busy={publishing} onClick={publish}>
                {publishing ? t('workspace.sources.preview.publishing') : t('workspace.sources.preview.publish')}
              </Button>
            </>
          ) : (
            <>
              <p>{t('workspace.sources.preview.invalid')}</p>
              <ul>
                {preview.errors.map((error) => (
                  <li key={error.code}>
                    {apiFailureText(error.code)}
                    {' '}
                    <code>{error.code}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}

      {notice === null ? null : (
        <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
          {notice.text}
        </Alert>
      )}

      <Panel level={2} title={t('workspace.sources.versions.title')}>
        {versions.length === 0 ? (
          <p className="empty">{t('workspace.sources.versions.empty')}</p>
        ) : (
          <ol className="context-history">
            {versions.map((version) => (
              <li className="context-history__item" key={version.version}>
                <h3 className="context-history__version">
                  {message('workspace.sources.versions.version', { version: String(version.version) })}
                </h3>
                <DefinitionList
                  rows={[
                    { term: t('workspace.sources.versions.hash'), value: version.content_hash, mono: true },
                    { term: t('workspace.sources.versions.publishedAt'), value: formatInstant(version.published_at) },
                    ...(detail?.configuration.adopted_version === version.version
                      ? [{ term: t('workspace.sources.versions.adopted'), value: '✓' }]
                      : []),
                  ]}
                />
                <Button
                  variant="secondary"
                  busy={adopting === version.version}
                  onClick={() => adopt(version.version)}
                >
                  {adopting === version.version
                    ? t('workspace.sources.versions.adopting')
                    : message('workspace.sources.versions.adopt', { version: String(version.version) })}
                </Button>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {isConnector ? null : (
        <Panel
          level={2}
          title={t('workspace.sources.upload.title')}
          description={t('workspace.sources.upload.description')}
        >
          <div className="field">
            <label className="field__label" htmlFor="source-upload-file">
              {t('workspace.sources.upload.file')}
            </label>
            <input
              className="field__input"
              id="source-upload-file"
              type="file"
              ref={fileInput}
            />
          </div>
          <Button busy={uploading} onClick={upload}>
            {uploading ? t('workspace.sources.upload.uploading') : t('workspace.sources.upload.submit')}
          </Button>
          {uploadNotice === null ? null : (
            <Alert
              tone={uploadNotice.tone}
              {...(uploadNotice.code === undefined ? {} : { code: uploadNotice.code })}
            >
              {uploadNotice.text}
            </Alert>
          )}
          {preserved === null ? null : <Alert tone="warning">{preserved}</Alert>}
        </Panel>
      )}

      <Panel level={2} title={t('workspace.sources.release.title')}>
        {latest === undefined ? (
          <p className="empty">{t('workspace.sources.release.empty')}</p>
        ) : (
          <>
            <h3 className="context-history__version">
              {message('workspace.sources.release.version', { release: String(latest.release) })}
            </h3>
            <DefinitionList
              rows={[
                { term: t('workspace.sources.release.recordCount'), value: String(latest.record_count) },
                { term: t('workspace.sources.release.rejectionCount'), value: String(latest.record_rejection_count) },
                {
                  term: t('workspace.sources.release.configurationVersion'),
                  value: String(latest.integration_configuration_version),
                },
                { term: t('workspace.sources.release.acquiredAt'), value: formatInstant(latest.provenance.acquired_at) },
                { term: t('workspace.sources.release.integratedAt'), value: formatInstant(latest.provenance.integrated_at) },
                { term: t('workspace.sources.release.releasedAt'), value: formatInstant(latest.created_at) },
                ...(latest.document_processing === undefined
                  ? []
                  : [
                    { term: t('workspace.sources.release.documentProcessing'), value: '✓' },
                    {
                      term: t('workspace.sources.release.documentParser'),
                      value: message('workspace.sources.release.parserVersion', {
                        name: latest.document_processing.parser.name,
                        version: String(latest.document_processing.parser.version),
                      }),
                    },
                    {
                      term: t('workspace.sources.release.documentMaxBytes'),
                      value: String(latest.document_processing.limits.max_bytes),
                    },
                  ]),
              ]}
            />
          </>
        )}
      </Panel>

      <Panel level={2} title={t('workspace.sources.history.title')}>
        {detail === null || detail.dataset.releases.length === 0 ? (
          <p className="empty">{t('workspace.sources.release.empty')}</p>
        ) : (
          <ol className="context-history">
            {detail.dataset.releases.map((release) => (
              <li className="context-history__item" key={release.release}>
                <h3 className="context-history__version">
                  {message('workspace.sources.release.version', { release: String(release.release) })}
                </h3>
                <DefinitionList
                  rows={[
                    { term: t('workspace.sources.release.recordCount'), value: String(release.record_count) },
                    { term: t('workspace.sources.release.releasedAt'), value: formatInstant(release.created_at) },
                  ]}
                />
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {rejections.length === 0 ? null : (
        <Panel level={2} title={t('workspace.sources.rejections.title')}>
          <p>
            {outcome?.integration === null || outcome?.integration === undefined
              ? message('workspace.sources.rejections.summaryOnlyRejected', {
                rejected: String(rejections.length),
              })
              : message('workspace.sources.rejections.summary', {
                valid: String(outcome.integration.accepted_records),
                rejected: String(rejections.length),
              })}
          </p>
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
              {rejections.map((rejection: SourceRejectionView) => (
                <tr key={`${rejection.raw_id}-${String(rejection.row)}-${rejection.reason}`}>
                  <td>{rejection.row}</td>
                  <td>{rejection.field ?? '—'}</td>
                  <td>{optional(`value.rejectionReason.${rejection.reason}`) ?? rejection.reason}</td>
                  <td className="data-table__mono"><code>{rejection.reason}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel level={2} title={t('workspace.sources.provenance.title')}>
        {latestAcquisition === null ? (
          <p className="empty">{t('workspace.sources.runs.empty')}</p>
        ) : (
          <DefinitionList
            rows={[
              { term: t('workspace.sources.provenance.batch'), value: latestAcquisition.batch_id, mono: true },
              { term: t('workspace.sources.provenance.run'), value: latestAcquisition.acquisition_run_id, mono: true },
              {
                term: t('workspace.sources.provenance.raw'),
                value: latestAcquisition.raw_acquisition_ids.join('、'),
                mono: true,
              },
              {
                term: t('workspace.sources.provenance.receivedAt'),
                value: formatInstant(latestAcquisition.created_at),
              },
            ]}
          />
        )}
      </Panel>

      {isConnector ? null : (
        <Panel level={2} title={t('workspace.sources.runs.title')}>
          {runs.length === 0 ? (
            <p className="empty">{t('workspace.sources.runs.empty')}</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.sources.provenance.run')}</th>
                  <th scope="col">{t('workspace.sources.runs.status')}</th>
                  <th scope="col">{t('workspace.sources.runs.queuedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.acquisition_run_id}>
                    <td className="data-table__mono">{run.acquisition_run_id}</td>
                    <td>{optional(`value.state.${run.status}`) ?? run.status}</td>
                    <td>{formatInstant(run.queued_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </>
  );
}
