import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type AcquisitionPlanView,
  type AcquisitionRunWorkView,
  type ConnectionList,
  type ConnectionPacingView,
  type ConnectionPreview,
  type ConnectionSessionView,
  type ConnectionView,
  type SourceAcquisitionConfigurationPreview,
  type SourceDetailView,
  type SourceRunView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

const AUTH_SCHEMES = [
  'none',
  'basic',
  'bearer',
  'api_key',
  'oauth_client_credentials',
  'login',
] as const;
type AuthScheme = (typeof AUTH_SCHEMES)[number];

const COMPLETIONS = ['short_page', 'empty_page', 'last_page_flag'] as const;
const WINDOW_MODES = ['incremental', 'fixed'] as const;
const PAGINATION_MODES = ['page_number', 'cursor'] as const;

interface SelectOption {
  value: string;
  label: string;
}

function SelectField(props: {
  id: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <select
        className="field__input"
        id={props.id}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckField(props: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </div>
  );
}

function numbered(value: string): number {
  return Number(value);
}

function integerList(value: string): number[] {
  return value
    .split(/[,\s]+/u)
    .filter((entry) => entry !== '')
    .map((entry) => Number(entry));
}

function booleanLabel(value: boolean): string {
  return value ? t('value.yes') : t('value.no');
}

interface AuthorizedActorProps {
  onSessionLost: () => void;
}

export interface ApiSourcePanelsProps extends AuthorizedActorProps {
  workspaceId: string;
  detail: SourceDetailView;
  onReload: () => Promise<void>;
  onChanged: () => void;
}

/**
 * The guided business-API Source surface: one Acquisition Connection (settled
 * authentication, pagination, pacing, retry, schedule), the declarative
 * acquisition configuration (path, records, completion, windows), and the Run
 * console (checkpoints, queue, plans, pacing, retries, cancellation, reruns).
 * Every rule is validated by the server; this screen only states form values.
 */
export function ApiSourcePanels(props: ApiSourcePanelsProps) {
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [failed, setFailed] = useState(false);

  const loadConnections = useCallback(async (): Promise<void> => {
    const result = await platformApi.connections(props.workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        props.onSessionLost();
        return;
      }
      setFailed(true);
      return;
    }
    setFailed(false);
    setConnections(result.data);
  }, [props.workspaceId, props.onSessionLost]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const reloadAll = useCallback(async (): Promise<void> => {
    await Promise.all([props.onReload(), loadConnections()]);
  }, [props.onReload, loadConnections]);

  return (
    <>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      <ConnectionGuide
        workspaceId={props.workspaceId}
        connections={connections}
        onSessionLost={props.onSessionLost}
        onReload={reloadAll}
        onChanged={props.onChanged}
      />
      <AcquisitionGuide
        sourceId={props.detail.source.source_id}
        detail={props.detail}
        connections={connections}
        onSessionLost={props.onSessionLost}
        onReload={reloadAll}
        onChanged={props.onChanged}
      />
      <RunConsole
        sourceId={props.detail.source.source_id}
        detail={props.detail}
        onSessionLost={props.onSessionLost}
        onReload={reloadAll}
        onChanged={props.onChanged}
      />
    </>
  );
}

interface ConnectionGuideProps extends AuthorizedActorProps {
  workspaceId: string;
  connections: ConnectionList | null;
  onReload: () => Promise<void>;
  onChanged: () => void;
}

function ConnectionGuide(props: ConnectionGuideProps) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authScheme, setAuthScheme] = useState<AuthScheme>('bearer');
  const [credential, setCredential] = useState('');
  const [username, setUsername] = useState('');
  const [apiKeyHeader, setApiKeyHeader] = useState('x-api-key');
  const [apiKeyPrefix, setApiKeyPrefix] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [scope, setScope] = useState('');
  const [loginPath, setLoginPath] = useState('/login');
  const [tokenPath, setTokenPath] = useState('');
  const [cookieName, setCookieName] = useState('');
  const [paginationMode, setPaginationMode] = useState<(typeof PAGINATION_MODES)[number]>('page_number');
  const [parameter, setParameter] = useState('page');
  const [sizeParameter, setSizeParameter] = useState('page_size');
  const [start, setStart] = useState('1');
  const [size, setSize] = useState('100');
  const [maxPages, setMaxPages] = useState('10');
  const [cursorPath, setCursorPath] = useState('');
  const [initialCursor, setInitialCursor] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('1');
  const [baseDelay, setBaseDelay] = useState('250');
  const [maxDelay, setMaxDelay] = useState('30000');
  const [retryOn, setRetryOn] = useState('429,500,502,503,504');
  const [serialization, setSerialization] = useState(false);
  const [minimumInterval, setMinimumInterval] = useState('0');
  const [maximumRate, setMaximumRate] = useState('');
  const [maximumConcurrent, setMaximumConcurrent] = useState('1');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleEvery, setScheduleEvery] = useState('60');
  const [scheduleTolerance, setScheduleTolerance] = useState('60');
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);

  const auth = (): Record<string, unknown> => {
    if (authScheme === 'none') return { scheme: 'none' };
    if (authScheme === 'bearer') return { scheme: 'bearer' };
    if (authScheme === 'basic') return { scheme: 'basic', username };
    if (authScheme === 'api_key') {
      return {
        scheme: 'api_key',
        header: apiKeyHeader,
        ...(apiKeyPrefix === '' ? {} : { prefix: apiKeyPrefix }),
      };
    }
    if (authScheme === 'oauth_client_credentials') {
      return {
        scheme: 'oauth_client_credentials',
        token_url: tokenUrl,
        client_id: clientId,
        ...(scope === '' ? {} : { scope }),
      };
    }
    return {
      scheme: 'login',
      login_path: loginPath,
      username,
      ...(tokenPath === '' ? {} : { token_path: tokenPath }),
      ...(cookieName === '' ? {} : { cookie_name: cookieName }),
    };
  };

  /** The declaration exactly as the form states it; the server fills defaults. */
  const declaration = (): Record<string, unknown> => ({
    base_url: baseUrl,
    auth: auth(),
    pagination: {
      parameter,
      ...(sizeParameter === '' ? {} : { size_parameter: sizeParameter }),
      start: numbered(start),
      size: numbered(size),
      max_pages: numbered(maxPages),
      mode: paginationMode,
      ...(paginationMode === 'cursor'
        ? {
          cursor_path: cursorPath,
          ...(initialCursor === '' ? {} : { initial_cursor: initialCursor }),
        }
        : {}),
    },
    retry: {
      max_attempts: numbered(maxAttempts),
      base_delay_ms: numbered(baseDelay),
      max_delay_ms: numbered(maxDelay),
      retry_on: integerList(retryOn),
    },
    pacing: {
      serialization,
      minimum_interval_seconds: numbered(minimumInterval),
      maximum_requests_per_minute: maximumRate === '' ? null : numbered(maximumRate),
      maximum_concurrent_runs: numbered(maximumConcurrent),
    },
    ...(scheduleEnabled
      ? { schedule: { every_minutes: numbered(scheduleEvery), start_tolerance_seconds: numbered(scheduleTolerance) } }
      : { schedule: null }),
  });

  const requestPreview = (): void => {
    setBusy('preview');
    setNotice(null);
    void platformApi.previewConnection(props.workspaceId, name, declaration(), credential).then((result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          props.onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      // The reviewed declaration is what publication hashes; the credential the
      // administrator typed stays only until the Version is sealed.
      setPreview(result.data);
    });
  };

  const publish = async (): Promise<void> => {
    setBusy('publish');
    setNotice(null);
    const result = await platformApi.publishConnection(
      props.workspaceId,
      preview?.name ?? name,
      preview?.declaration ?? declaration(),
      credential,
    );
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        props.onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setPreview(null);
    setCredential('');
    await props.onReload();
    setNotice({
      tone: 'info',
      text: message('workspace.acquisitions.connection.published', {
        version: String(result.data.connection_version),
      }),
    });
    props.onChanged();
  };

  const adopt = async (connection: ConnectionView, version: number): Promise<void> => {
    setAdopting(`${connection.connection_id}:${String(version)}`);
    setNotice(null);
    const result = await platformApi.adoptConnection(connection.connection_id, version);
    setAdopting(null);
    if (!result.ok) {
      if (result.status === 401) {
        props.onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    await props.onReload();
    setNotice({
      tone: 'info',
      text: message('workspace.acquisitions.connection.adoptedNotice', { version: String(version) }),
    });
    props.onChanged();
  };

  const versions = props.connections?.connections ?? [];

  return (
    <>
      <Panel
        level={2}
        title={t('workspace.acquisitions.connection.title')}
        description={t('workspace.acquisitions.connection.description')}
      >
        <Field
          id="connection-name"
          label={t('workspace.acquisitions.connection.name')}
          value={name}
          onChange={setName}
          maxLength={128}
        />
        <Field
          id="connection-base-url"
          label={t('workspace.acquisitions.connection.baseUrl')}
          value={baseUrl}
          onChange={setBaseUrl}
          mono
        />
        <SelectField
          id="connection-auth-scheme"
          label={t('workspace.acquisitions.connection.authScheme')}
          value={authScheme}
          options={AUTH_SCHEMES.map((scheme) => ({
            value: scheme,
            label: t(`value.authScheme.${scheme}`),
          }))}
          onChange={(value) => setAuthScheme(value as AuthScheme)}
        />
        {authScheme === 'basic' || authScheme === 'login' ? (
          <Field
            id="connection-username"
            label={t('workspace.acquisitions.connection.username')}
            value={username}
            onChange={setUsername}
          />
        ) : null}
        {authScheme === 'api_key' ? (
          <>
            <Field
              id="connection-api-key-header"
              label={t('workspace.acquisitions.connection.apiKeyHeader')}
              value={apiKeyHeader}
              onChange={setApiKeyHeader}
              mono
            />
            <Field
              id="connection-api-key-prefix"
              label={t('workspace.acquisitions.connection.apiKeyPrefix')}
              value={apiKeyPrefix}
              onChange={setApiKeyPrefix}
              mono
            />
          </>
        ) : null}
        {authScheme === 'oauth_client_credentials' ? (
          <>
            <Field
              id="connection-token-url"
              label={t('workspace.acquisitions.connection.tokenUrl')}
              value={tokenUrl}
              onChange={setTokenUrl}
              mono
            />
            <Field
              id="connection-client-id"
              label={t('workspace.acquisitions.connection.clientId')}
              value={clientId}
              onChange={setClientId}
              mono
            />
            <Field
              id="connection-scope"
              label={t('workspace.acquisitions.connection.scope')}
              value={scope}
              onChange={setScope}
            />
          </>
        ) : null}
        {authScheme === 'login' ? (
          <>
            <Field
              id="connection-login-path"
              label={t('workspace.acquisitions.connection.loginPath')}
              value={loginPath}
              onChange={setLoginPath}
              mono
            />
            <Field
              id="connection-token-path"
              label={t('workspace.acquisitions.connection.tokenPath')}
              value={tokenPath}
              onChange={setTokenPath}
              mono
            />
            <Field
              id="connection-cookie-name"
              label={t('workspace.acquisitions.connection.cookieName')}
              value={cookieName}
              onChange={setCookieName}
              mono
            />
          </>
        ) : null}
        {authScheme === 'none' ? null : (
          <Field
            id="connection-credential"
            label={t('workspace.acquisitions.connection.credential')}
            hint={t('workspace.acquisitions.connection.credentialHint')}
            value={credential}
            onChange={setCredential}
            type="password"
            autoComplete="new-password"
          />
        )}

        <h3 className="panel__title">{t('workspace.acquisitions.connection.pagination')}</h3>
        <SelectField
          id="connection-pagination-mode"
          label={t('workspace.acquisitions.connection.paginationMode')}
          value={paginationMode}
          options={PAGINATION_MODES.map((mode) => ({
            value: mode,
            label: t(`value.paginationMode.${mode}`),
          }))}
          onChange={(value) => setPaginationMode(value as (typeof PAGINATION_MODES)[number])}
        />
        <Field
          id="connection-parameter"
          label={t('workspace.acquisitions.connection.pageParameter')}
          value={parameter}
          onChange={setParameter}
          mono
        />
        <Field
          id="connection-size-parameter"
          label={t('workspace.acquisitions.connection.sizeParameter')}
          value={sizeParameter}
          onChange={setSizeParameter}
          mono
        />
        {paginationMode === 'page_number' ? (
          <>
            <Field
              id="connection-start"
              label={t('workspace.acquisitions.connection.firstPage')}
              value={start}
              onChange={setStart}
              inputMode="numeric"
            />
            <Field
              id="connection-size"
              label={t('workspace.acquisitions.connection.pageSize')}
              value={size}
              onChange={setSize}
              inputMode="numeric"
            />
          </>
        ) : (
          <>
            <Field
              id="connection-cursor-path"
              label={t('workspace.acquisitions.connection.cursorPath')}
              value={cursorPath}
              onChange={setCursorPath}
              mono
            />
            <Field
              id="connection-initial-cursor"
              label={t('workspace.acquisitions.connection.initialCursor')}
              value={initialCursor}
              onChange={setInitialCursor}
              mono
            />
          </>
        )}
        <Field
          id="connection-max-pages"
          label={t('workspace.acquisitions.connection.maxPages')}
          value={maxPages}
          onChange={setMaxPages}
          inputMode="numeric"
        />

        <h3 className="panel__title">{t('workspace.acquisitions.connection.retry')}</h3>
        <Field
          id="connection-max-attempts"
          label={t('workspace.acquisitions.connection.maxAttempts')}
          value={maxAttempts}
          onChange={setMaxAttempts}
          inputMode="numeric"
        />
        <Field
          id="connection-base-delay"
          label={t('workspace.acquisitions.connection.baseDelay')}
          value={baseDelay}
          onChange={setBaseDelay}
          inputMode="numeric"
        />
        <Field
          id="connection-max-delay"
          label={t('workspace.acquisitions.connection.maxDelay')}
          value={maxDelay}
          onChange={setMaxDelay}
          inputMode="numeric"
        />
        <Field
          id="connection-retry-on"
          label={t('workspace.acquisitions.connection.retryOn')}
          hint={t('workspace.acquisitions.connection.retryOnHint')}
          value={retryOn}
          onChange={setRetryOn}
          mono
        />

        <h3 className="panel__title">{t('workspace.acquisitions.connection.pacing')}</h3>
        <CheckField
          id="connection-serialization"
          label={t('workspace.acquisitions.connection.serialization')}
          checked={serialization}
          onChange={setSerialization}
        />
        <Field
          id="connection-minimum-interval"
          label={t('workspace.acquisitions.connection.minimumInterval')}
          value={minimumInterval}
          onChange={setMinimumInterval}
          inputMode="numeric"
        />
        <Field
          id="connection-maximum-rate"
          label={t('workspace.acquisitions.connection.maximumRate')}
          hint={t('workspace.acquisitions.connection.maximumRateHint')}
          value={maximumRate}
          onChange={setMaximumRate}
          inputMode="numeric"
        />
        <Field
          id="connection-maximum-concurrent"
          label={t('workspace.acquisitions.connection.maximumConcurrent')}
          value={maximumConcurrent}
          onChange={setMaximumConcurrent}
          inputMode="numeric"
        />

        <h3 className="panel__title">{t('workspace.acquisitions.connection.schedule')}</h3>
        <CheckField
          id="connection-schedule-enabled"
          label={t('workspace.acquisitions.connection.scheduleEnabled')}
          checked={scheduleEnabled}
          onChange={setScheduleEnabled}
        />
        {scheduleEnabled ? (
          <>
            <Field
              id="connection-schedule-every"
              label={t('workspace.acquisitions.connection.scheduleEvery')}
              value={scheduleEvery}
              onChange={setScheduleEvery}
              inputMode="numeric"
            />
            <Field
              id="connection-schedule-tolerance"
              label={t('workspace.acquisitions.connection.scheduleTolerance')}
              value={scheduleTolerance}
              onChange={setScheduleTolerance}
              inputMode="numeric"
            />
          </>
        ) : null}

        <Button busy={busy === 'preview'} onClick={requestPreview}>
          {busy === 'preview'
            ? t('workspace.acquisitions.connection.previewing')
            : t('workspace.acquisitions.connection.preview')}
        </Button>
      </Panel>

      {preview === null ? null : (
        <Panel level={2} title={t('workspace.acquisitions.connection.previewTitle')}>
          {preview.valid ? (
            <>
              <p role="status">{t('workspace.acquisitions.connection.previewValid')}</p>
              <pre className="field__input field__input--mono">
                {JSON.stringify(preview.declaration, null, 2)}
              </pre>
              <DefinitionList
                rows={[
                  { term: t('workspace.acquisitions.connection.credentialRef'), value: preview.credential_ref ?? '—', mono: true },
                  { term: t('workspace.acquisitions.connection.hasCredential'), value: booleanLabel(preview.has_credential === true) },
                  { term: t('workspace.acquisitions.connection.hash'), value: preview.content_hash ?? '—', mono: true },
                ]}
              />
              <Button busy={busy === 'publish'} onClick={() => void publish()}>
                {busy === 'publish'
                  ? t('workspace.acquisitions.connection.publishing')
                  : t('workspace.acquisitions.connection.publish')}
              </Button>
            </>
          ) : (
            <>
              <p>{t('workspace.acquisitions.connection.previewInvalid')}</p>
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

      <Panel level={2} title={t('workspace.acquisitions.connection.versionsTitle')}>
        {versions.length === 0 ? (
          <p className="empty">{t('workspace.acquisitions.connection.versionsEmpty')}</p>
        ) : (
          <ol className="context-history">
            {versions.map((connection) => (
              <li className="context-history__item" key={connection.connection_id}>
                <h3 className="context-history__version">{connection.name}</h3>
                {connection.versions.map((version) => (
                  <div key={version.version}>
                    <DefinitionList
                      rows={[
                        { term: t('workspace.acquisitions.connection.version'), value: String(version.version) },
                        { term: t('workspace.acquisitions.connection.authScheme'), value: optional(`value.authScheme.${version.auth_scheme}`) ?? version.auth_scheme },
                        { term: t('workspace.acquisitions.connection.baseUrl'), value: version.base_url, mono: true },
                        { term: t('workspace.acquisitions.connection.credentialRef'), value: version.credential_ref, mono: true },
                        { term: t('workspace.acquisitions.connection.hash'), value: version.content_hash, mono: true },
                        ...(connection.adopted_version === version.version
                          ? [{ term: t('workspace.acquisitions.connection.adopted'), value: '✓' }]
                          : []),
                      ]}
                    />
                    <Button
                      variant="secondary"
                      busy={adopting === `${connection.connection_id}:${String(version.version)}`}
                      onClick={() => void adopt(connection, version.version)}
                    >
                      {adopting === `${connection.connection_id}:${String(version.version)}`
                        ? t('workspace.acquisitions.connection.adopting')
                        : message('workspace.acquisitions.connection.adopt', { version: String(version.version) })}
                    </Button>
                  </div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

interface AcquisitionGuideProps extends AuthorizedActorProps {
  sourceId: string;
  detail: SourceDetailView;
  connections: ConnectionList | null;
  onReload: () => Promise<void>;
  onChanged: () => void;
}

function AcquisitionGuide(props: AcquisitionGuideProps) {
  const [connectionVersion, setConnectionVersion] = useState('');
  const [path, setPath] = useState('');
  const [recordPath, setRecordPath] = useState('');
  const [contentType, setContentType] = useState('');
  const [completionKind, setCompletionKind] = useState<(typeof COMPLETIONS)[number]>('short_page');
  const [completionFlag, setCompletionFlag] = useState('has_more');
  const [completionValue, setCompletionValue] = useState('false');
  const [windowEnabled, setWindowEnabled] = useState(false);
  const [windowMode, setWindowMode] = useState<(typeof WINDOW_MODES)[number]>('incremental');
  const [startParameter, setStartParameter] = useState('from');
  const [endParameter, setEndParameter] = useState('to');
  const [initialStart, setInitialStart] = useState('');
  const [initialEnd, setInitialEnd] = useState('');
  const [maximumSpan, setMaximumSpan] = useState('1440');
  const [lookback, setLookback] = useState('0');
  const [timeZone, setTimeZone] = useState('UTC');
  const [endInclusive, setEndInclusive] = useState(false);
  const [preview, setPreview] = useState<SourceAcquisitionConfigurationPreview | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
  const [adopting, setAdopting] = useState<number | null>(null);

  const versions = props.detail.acquisition.versions;
  const options = (props.connections?.connections ?? []).flatMap((connection) =>
    connection.versions.map((version) => ({
      value: `${connection.connection_id}:${String(version.version)}`,
      label: message('workspace.acquisitions.acquisition.connectionOption', {
        name: connection.name,
        version: String(version.version),
      }),
    })));

  const declaration = (): Record<string, unknown> => ({
    connection: connectionVersion.split(':')[0] ?? '',
    connection_version: numbered(connectionVersion.split(':')[1] ?? 'NaN'),
    path,
    ...(recordPath === '' ? {} : { record_path: recordPath }),
    completion: completionKind === 'last_page_flag'
      ? { kind: completionKind, flag: completionFlag, done_value: completionValue === 'true' }
      : { kind: completionKind },
    ...(windowEnabled
      ? {
        window: {
          mode: windowMode,
          start_parameter: startParameter,
          end_parameter: endParameter,
          initial_start: initialStart,
          ...(windowMode === 'fixed' ? { initial_end: initialEnd } : {}),
          maximum_span_minutes: numbered(maximumSpan),
          lookback_minutes: numbered(lookback),
          time_zone: timeZone,
          end_inclusive: endInclusive,
        },
      }
      : {}),
    ...(contentType === '' ? {} : { content_type: contentType }),
  });

  const requestPreview = (): void => {
    setBusy('preview');
    setNotice(null);
    void platformApi.previewAcquisitionConfiguration(props.sourceId, declaration()).then((result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          props.onSessionLost();
          return;
        }
        setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
        return;
      }
      setPreview(result.data);
    });
  };

  const publish = async (): Promise<void> => {
    setBusy('publish');
    setNotice(null);
    const result = await platformApi.publishAcquisitionConfiguration(
      props.sourceId,
      preview?.declaration ?? declaration(),
    );
    setBusy(null);
    if (!result.ok) {
      if (result.status === 401) {
        props.onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    setPreview(null);
    await props.onReload();
    setNotice({
      tone: 'info',
      text: message('workspace.acquisitions.acquisition.published', {
        version: String(result.data.acquisition_configuration_version),
      }),
    });
    props.onChanged();
  };

  const adopt = async (version: number): Promise<void> => {
    setAdopting(version);
    setNotice(null);
    const result = await platformApi.adoptAcquisitionConfiguration(props.sourceId, version);
    setAdopting(null);
    if (!result.ok) {
      if (result.status === 401) {
        props.onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
      return;
    }
    await props.onReload();
    setNotice({
      tone: 'info',
      text: message('workspace.acquisitions.acquisition.adoptedNotice', { version: String(version) }),
    });
    props.onChanged();
  };

  return (
    <>
      <Panel
        level={2}
        title={t('workspace.acquisitions.acquisition.title')}
        description={t('workspace.acquisitions.acquisition.description')}
      >
        {options.length === 0 ? (
          <p className="empty">{t('workspace.acquisitions.acquisition.connectionRequired')}</p>
        ) : (
          <SelectField
            id="acquisition-connection-version"
            label={t('workspace.acquisitions.acquisition.connectionVersion')}
            value={connectionVersion === '' ? options[0]?.value ?? '' : connectionVersion}
            options={options}
            onChange={setConnectionVersion}
          />
        )}
        <Field
          id="acquisition-path"
          label={t('workspace.acquisitions.acquisition.path')}
          value={path}
          onChange={setPath}
          mono
        />
        <Field
          id="acquisition-record-path"
          label={t('workspace.acquisitions.acquisition.recordPath')}
          hint={t('workspace.acquisitions.acquisition.recordPathHint')}
          value={recordPath}
          onChange={setRecordPath}
          mono
        />
        <Field
          id="acquisition-content-type"
          label={t('workspace.acquisitions.acquisition.contentType')}
          value={contentType}
          onChange={setContentType}
          mono
        />
        <SelectField
          id="acquisition-completion-kind"
          label={t('workspace.acquisitions.acquisition.completion')}
          value={completionKind}
          options={COMPLETIONS.map((kind) => ({
            value: kind,
            label: t(`value.completion.${kind}`),
          }))}
          onChange={(value) => setCompletionKind(value as (typeof COMPLETIONS)[number])}
        />
        {completionKind === 'last_page_flag' ? (
          <>
            <Field
              id="acquisition-completion-flag"
              label={t('workspace.acquisitions.acquisition.completionFlag')}
              value={completionFlag}
              onChange={setCompletionFlag}
              mono
            />
            <SelectField
              id="acquisition-completion-value"
              label={t('workspace.acquisitions.acquisition.completionValue')}
              value={completionValue}
              options={[
                { value: 'false', label: t('value.no') },
                { value: 'true', label: t('value.yes') },
              ]}
              onChange={setCompletionValue}
            />
          </>
        ) : null}

        <CheckField
          id="acquisition-window-enabled"
          label={t('workspace.acquisitions.acquisition.windowEnabled')}
          checked={windowEnabled}
          onChange={setWindowEnabled}
        />
        {windowEnabled ? (
          <>
            <SelectField
              id="acquisition-window-mode"
              label={t('workspace.acquisitions.acquisition.windowMode')}
              value={windowMode}
              options={WINDOW_MODES.map((mode) => ({
                value: mode,
                label: t(`value.window.${mode}`),
              }))}
              onChange={(value) => setWindowMode(value as (typeof WINDOW_MODES)[number])}
            />
            <Field
              id="acquisition-start-parameter"
              label={t('workspace.acquisitions.acquisition.startParameter')}
              value={startParameter}
              onChange={setStartParameter}
              mono
            />
            <Field
              id="acquisition-end-parameter"
              label={t('workspace.acquisitions.acquisition.endParameter')}
              value={endParameter}
              onChange={setEndParameter}
              mono
            />
            <Field
              id="acquisition-initial-start"
              label={t('workspace.acquisitions.acquisition.initialStart')}
              value={initialStart}
              onChange={setInitialStart}
              mono
            />
            {windowMode === 'fixed' ? (
              <Field
                id="acquisition-initial-end"
                label={t('workspace.acquisitions.acquisition.initialEnd')}
                value={initialEnd}
                onChange={setInitialEnd}
                mono
              />
            ) : null}
            <Field
              id="acquisition-maximum-span"
              label={t('workspace.acquisitions.acquisition.maximumSpan')}
              value={maximumSpan}
              onChange={setMaximumSpan}
              inputMode="numeric"
            />
            <Field
              id="acquisition-lookback"
              label={t('workspace.acquisitions.acquisition.lookback')}
              value={lookback}
              onChange={setLookback}
              inputMode="numeric"
            />
            <Field
              id="acquisition-time-zone"
              label={t('workspace.acquisitions.acquisition.timeZone')}
              value={timeZone}
              onChange={setTimeZone}
              mono
            />
            <CheckField
              id="acquisition-end-inclusive"
              label={t('workspace.acquisitions.acquisition.endInclusive')}
              checked={endInclusive}
              onChange={setEndInclusive}
            />
          </>
        ) : null}

        <Button busy={busy === 'preview'} onClick={requestPreview}>
          {busy === 'preview'
            ? t('workspace.acquisitions.acquisition.previewing')
            : t('workspace.acquisitions.acquisition.preview')}
        </Button>
      </Panel>

      {preview === null ? null : (
        <Panel level={2} title={t('workspace.acquisitions.acquisition.previewTitle')}>
          {preview.valid ? (
            <>
              <p role="status">{t('workspace.acquisitions.acquisition.previewValid')}</p>
              <pre className="field__input field__input--mono">
                {JSON.stringify(preview.declaration, null, 2)}
              </pre>
              <p>
                {t('workspace.acquisitions.connection.hash')}
                {' '}
                <code>{preview.content_hash}</code>
              </p>
              <Button busy={busy === 'publish'} onClick={() => void publish()}>
                {busy === 'publish'
                  ? t('workspace.acquisitions.acquisition.publishing')
                  : t('workspace.acquisitions.acquisition.publish')}
              </Button>
            </>
          ) : (
            <>
              <p>{t('workspace.acquisitions.acquisition.previewInvalid')}</p>
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

      <Panel level={2} title={t('workspace.acquisitions.acquisition.versionsTitle')}>
        {versions.length === 0 ? (
          <p className="empty">{t('workspace.acquisitions.acquisition.versionsEmpty')}</p>
        ) : (
          <ol className="context-history">
            {versions.map((version) => (
              <li className="context-history__item" key={version.version}>
                <h3 className="context-history__version">
                  {message('workspace.acquisitions.acquisition.version', { version: String(version.version) })}
                </h3>
                <DefinitionList
                  rows={[
                    { term: t('workspace.acquisitions.acquisition.path'), value: version.path, mono: true },
                    {
                      term: t('workspace.acquisitions.acquisition.completion'),
                      value: optional(`value.completion.${version.completion.kind}`) ?? version.completion.kind,
                    },
                    {
                      term: t('workspace.acquisitions.acquisition.windowMode'),
                      value: version.window === null
                        ? '—'
                        : `${optional(`value.window.${version.window.mode}`) ?? version.window.mode} ${version.window.initial_start} → ${version.window.initial_end ?? t('workspace.acquisitions.acquisition.initialEndAuto')}`,
                    },
                    { term: t('workspace.acquisitions.connection.hash'), value: version.content_hash, mono: true },
                    ...(props.detail.acquisition.adopted_version === version.version
                      ? [{ term: t('workspace.acquisitions.connection.adopted'), value: '✓' }]
                      : []),
                  ]}
                />
                <Button
                  variant="secondary"
                  busy={adopting === version.version}
                  onClick={() => void adopt(version.version)}
                >
                  {adopting === version.version
                    ? t('workspace.acquisitions.acquisition.adopting')
                    : message('workspace.acquisitions.acquisition.adopt', { version: String(version.version) })}
                </Button>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

interface RunConsoleProps extends AuthorizedActorProps {
  sourceId: string;
  detail: SourceDetailView;
  onReload: () => Promise<void>;
  onChanged: () => void;
}

function RunConsole(props: RunConsoleProps) {
  const [backfillFrom, setBackfillFrom] = useState('');
  const [backfillTo, setBackfillTo] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<
    'enqueue' | 'work' | 'tick' | 'reset' | 'cancel' | 'rerun' | 'session' | null
  >(null);
  const [outcome, setOutcome] = useState<AcquisitionRunWorkView | null>(null);
  const [paced, setPaced] = useState<AcquisitionRunWorkView | null>(null);
  const [plan, setPlan] = useState<AcquisitionPlanView | null>(null);
  const [planMissing, setPlanMissing] = useState(false);
  const [session, setSession] = useState<ConnectionSessionView | null>(null);
  const [pacing, setPacing] = useState<ConnectionPacingView | null>(null);

  const connectionId = props.detail.acquisition.connection?.connection_id ?? null;
  const checkpoint = props.detail.acquisition.checkpoint;
  const runs = props.detail.runs;

  const loadConnectionState = useCallback(async (): Promise<void> => {
    if (connectionId === null) {
      setSession(null);
      setPacing(null);
      return;
    }
    const [sessionResult, pacingResult] = await Promise.all([
      platformApi.connectionSession(connectionId),
      platformApi.connectionPacing(connectionId),
    ]);
    if (!sessionResult.ok) {
      if (sessionResult.status === 401) {
        props.onSessionLost();
        return;
      }
      setSession(null);
      setPacing(null);
      return;
    }
    if (!pacingResult.ok) {
      if (pacingResult.status === 401) {
        props.onSessionLost();
        return;
      }
      setSession(null);
      setPacing(null);
      return;
    }
    setSession(sessionResult.data);
    setPacing(pacingResult.data);
  }, [connectionId, props.onSessionLost]);

  useEffect(() => {
    void loadConnectionState();
  }, [loadConnectionState]);

  /** Re-reads the Source detail and the Connection's durable queue together. */
  const refresh = useCallback(async (): Promise<void> => {
    await props.onReload();
    await loadConnectionState();
  }, [props.onReload, loadConnectionState]);

  const failedWrite = (result: { status: number; error: { code: string } }): void => {
    setBusy(null);
    if (result.status === 401) {
      props.onSessionLost();
      return;
    }
    setNotice({ tone: 'error', text: apiFailureText(result.error.code), code: result.error.code });
  };

  const enqueue = (rerunOf?: string): void => {
    setBusy('enqueue');
    setNotice(null);
    setPaced(null);
    setOutcome(null);
    void platformApi.enqueueAcquisitionRun(props.sourceId, {
      ...(backfillFrom === '' ? {} : { from: backfillFrom }),
      ...(backfillTo === '' ? {} : { to: backfillTo }),
      ...(rerunOf === undefined ? {} : { rerunOf }),
    }).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await refresh();
      setBusy(null);
      setNotice({
        tone: 'info',
        text: rerunOf === undefined
          ? t('workspace.acquisitions.runs.queued')
          : t('workspace.acquisitions.runs.rerunDone'),
      });
      props.onChanged();
    });
  };

  const cancel = (run: SourceRunView): void => {
    setBusy('cancel');
    setNotice(null);
    void platformApi.cancelAcquisitionRun(run.acquisition_run_id).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await refresh();
      setBusy(null);
      setNotice({ tone: 'info', text: t('workspace.acquisitions.runs.cancelled') });
      props.onChanged();
    });
  };

  const work = (): void => {
    setBusy('work');
    setNotice(null);
    setPaced(null);
    setPlan(null);
    setPlanMissing(false);
    void platformApi.workAcquisition(props.sourceId).then(async (result) => {
      if (!result.ok) {
        // A refused Batch is quarantined server-side; the ledger is re-read so
        // the failure is visible beside the Release it never touched.
        await refresh();
        failedWrite(result);
        return;
      }
      await refresh();
      setBusy(null);
      if (result.data.paced === true) {
        setPaced(result.data);
        props.onChanged();
        return;
      }
      setOutcome(result.data);
      // The Plan is re-read through the immutable manifest before the attempt
      // is announced, so the manifest is on screen beside its outcome.
      const manifest = await platformApi.acquisitionPlan(result.data.acquisition_run_id);
      if (manifest.ok) setPlan(manifest.data);
      else setPlanMissing(true);
      setNotice({ tone: 'info', text: t('workspace.acquisitions.runs.worked') });
      props.onChanged();
    });
  };

  const tick = (): void => {
    setBusy('tick');
    setNotice(null);
    void platformApi.tickAcquisitionSchedule().then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await refresh();
      setBusy(null);
      setNotice({
        tone: 'info',
        text: message('workspace.acquisitions.runs.ticked', { count: String(result.data.enqueued.length) }),
      });
      props.onChanged();
    });
  };

  const resetCheckpoint = (): void => {
    setBusy('reset');
    setNotice(null);
    void platformApi.resetSourceCheckpoint(props.sourceId).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await refresh();
      setBusy(null);
      setNotice({ tone: 'info', text: t('workspace.acquisitions.runs.resetCheckpointDone') });
      props.onChanged();
    });
  };

  const viewPlan = (run: SourceRunView): void => {
    setPlan(null);
    setPlanMissing(false);
    void platformApi.acquisitionPlan(run.acquisition_run_id).then((result) => {
      if (!result.ok) {
        if (result.status === 401) {
          props.onSessionLost();
          return;
        }
        setPlanMissing(true);
        return;
      }
      setPlan(result.data);
    });
  };

  const resetSession = (): void => {
    if (connectionId === null) return;
    setBusy('session');
    setNotice(null);
    void platformApi.resetConnectionSession(connectionId).then(async (result) => {
      if (!result.ok) {
        failedWrite(result);
        return;
      }
      await loadConnectionState();
      setBusy(null);
      setNotice({ tone: 'info', text: t('workspace.acquisitions.session.resetDone') });
    });
  };

  return (
    <>
      <Panel
        level={2}
        title={t('workspace.acquisitions.runs.title')}
        description={t('workspace.acquisitions.runs.description')}
      >
        <DefinitionList
          rows={[
            { term: t('workspace.acquisitions.runs.checkpoint'), value: formatInstant(checkpoint?.watermark ?? undefined), mono: true },
            { term: t('workspace.acquisitions.runs.cursor'), value: checkpoint?.cursor ?? '—', mono: true },
            {
              term: t('workspace.acquisitions.runs.cursorState'),
              value: checkpoint === null
                ? '—'
                : optional(`value.state.${checkpoint.cursor_state}`) ?? checkpoint.cursor_state,
            },
          ]}
        />
        <Button variant="secondary" busy={busy === 'reset'} onClick={resetCheckpoint}>
          {t('workspace.acquisitions.runs.resetCheckpoint')}
        </Button>

        <h3 className="panel__title">{t('workspace.acquisitions.runs.triggerNew')}</h3>
        <Field
          id="acquisition-backfill-from"
          label={t('workspace.acquisitions.runs.backfillFrom')}
          value={backfillFrom}
          onChange={setBackfillFrom}
          mono
        />
        <Field
          id="acquisition-backfill-to"
          label={t('workspace.acquisitions.runs.backfillTo')}
          value={backfillTo}
          onChange={setBackfillTo}
          mono
        />
        <Button busy={busy === 'enqueue'} onClick={() => enqueue()}>
          {busy === 'enqueue'
            ? t('workspace.acquisitions.runs.enqueueing')
            : t('workspace.acquisitions.runs.enqueue')}
        </Button>
        <Button variant="secondary" busy={busy === 'tick'} onClick={tick}>
          {busy === 'tick'
            ? t('workspace.acquisitions.runs.ticking')
            : t('workspace.acquisitions.runs.tick')}
        </Button>
        <Button variant="secondary" busy={busy === 'work'} onClick={work}>
          {busy === 'work'
            ? t('workspace.acquisitions.runs.working')
            : t('workspace.acquisitions.runs.work')}
        </Button>

        {paced === null ? null : (
          <Alert tone="warning">
            {message('workspace.acquisitions.runs.paced', {
              reason: optional(`value.pacing.${paced.pacing_reason ?? 'fifo'}`) ?? t('value.pacing.fifo'),
            })}
            {paced.not_before === undefined || paced.not_before === null ? '' : ` ${t('workspace.acquisitions.runs.notBefore')} ${formatInstant(paced.not_before)}`}
            {paced.queue_position === undefined ? '' : ` ${t('workspace.acquisitions.runs.queuePosition')} ${String(paced.queue_position)}`}
          </Alert>
        )}

        {notice === null ? null : (
          <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
            {notice.text}
          </Alert>
        )}

        {outcome === null ? null : (
          <DefinitionList
            rows={[
              { term: t('workspace.acquisitions.runs.run'), value: outcome.acquisition_run_id, mono: true },
              { term: t('workspace.acquisitions.runs.status'), value: optional(`value.state.${outcome.status}`) ?? outcome.status },
              { term: t('workspace.acquisitions.runs.release'), value: outcome.dataset_release === null ? '—' : String(outcome.dataset_release) },
              { term: t('workspace.acquisitions.runs.records'), value: outcome.records === null ? '—' : String(outcome.records) },
              { term: t('workspace.acquisitions.runs.batch'), value: outcome.integration_batch_id ?? '—', mono: true },
              ...(outcome.error_code === undefined || outcome.error_code === null
                ? []
                : [{ term: t('workspace.acquisitions.runs.errorCode'), value: apiFailureText(outcome.error_code) }]),
            ]}
          />
        )}

        <h3 className="panel__title">{t('workspace.acquisitions.runs.history')}</h3>
        {runs.length === 0 ? (
          <p className="empty">{t('workspace.acquisitions.runs.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('workspace.acquisitions.runs.run')}</th>
                <th scope="col">{t('workspace.acquisitions.runs.trigger')}</th>
                <th scope="col">{t('workspace.acquisitions.runs.status')}</th>
                <th scope="col">{t('workspace.acquisitions.runs.attempts')}</th>
                <th scope="col">{t('workspace.acquisitions.runs.scheduledFor')}</th>
                <th scope="col">{t('workspace.acquisitions.runs.errorCode')}</th>
                <th scope="col">{t('workspace.acquisitions.runs.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.acquisition_run_id}>
                  <td className="data-table__mono">{run.acquisition_run_id}</td>
                  <td>{optional(`value.trigger.${run.trigger}`) ?? run.trigger}</td>
                  <td>{optional(`value.state.${run.status}`) ?? run.status}</td>
                  <td>{run.attempts}</td>
                  <td>{formatInstant(run.scheduled_for ?? undefined)}</td>
                  <td>
                    {run.error_code === undefined || run.error_code === null
                      ? '—'
                      : apiFailureText(run.error_code)}
                    {run.error_code === undefined || run.error_code === null
                      ? null
                      : <code>{` ${run.error_code}`}</code>}
                    {run.rerun_of === undefined || run.rerun_of === null ? null : (
                      <span>
                        {' '}
                        {t('workspace.acquisitions.runs.rerunOf')}
                        {' '}
                        <code>{run.rerun_of}</code>
                      </span>
                    )}
                  </td>
                  <td>
                    <Button variant="quiet" onClick={() => viewPlan(run)}>
                      {t('workspace.acquisitions.runs.viewPlan')}
                    </Button>
                    {run.status === 'queued' ? (
                      <Button variant="quiet" busy={busy === 'cancel'} onClick={() => cancel(run)}>
                        {t('workspace.acquisitions.runs.cancel')}
                      </Button>
                    ) : null}
                    {run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled' ? (
                      <Button variant="quiet" busy={busy === 'rerun'} onClick={() => enqueue(run.acquisition_run_id)}>
                        {t('workspace.acquisitions.runs.rerun')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel level={2} title={t('workspace.acquisitions.plan.title')}>
        {plan === null ? (
          <p className="empty">
            {planMissing ? t('workspace.acquisitions.plan.notPlanned') : t('workspace.acquisitions.plan.empty')}
          </p>
        ) : (
          <>
            <DefinitionList
              rows={[
                { term: t('workspace.acquisitions.plan.id'), value: plan.plan.plan_id, mono: true },
                { term: t('workspace.acquisitions.plan.status'), value: optional(`value.planStatus.${plan.plan.status}`) ?? plan.plan.status },
                {
                  term: t('workspace.acquisitions.plan.connector'),
                  value: `${plan.plan.connector.name} ${String(plan.plan.connector.version)}`,
                },
                { term: t('workspace.acquisitions.plan.connectionVersion'), value: String(plan.plan.connection_version) },
                { term: t('workspace.acquisitions.plan.configurationVersion'), value: String(plan.plan.acquisition_configuration_version) },
                { term: t('workspace.acquisitions.plan.integrationVersion'), value: String(plan.plan.integration_configuration_version) },
                {
                  term: t('workspace.acquisitions.plan.window'),
                  value: plan.plan.window === null
                    ? '—'
                    : `${optional(`value.window.${plan.plan.window.mode}`) ?? plan.plan.window.mode} ${plan.plan.window.start} → ${plan.plan.window.end}`,
                  mono: true,
                },
                {
                  term: t('workspace.acquisitions.plan.checkpointBefore'),
                  value: plan.plan.checkpoint_before === null
                    ? '—'
                    : `${plan.plan.checkpoint_before.watermark ?? '—'} / ${plan.plan.checkpoint_before.cursor ?? '—'}`,
                  mono: true,
                },
                {
                  term: t('workspace.acquisitions.plan.checkpointAfter'),
                  value: plan.plan.checkpoint_after === null
                    ? '—'
                    : `${plan.plan.checkpoint_after.watermark ?? '—'} / ${plan.plan.checkpoint_after.cursor ?? '—'}`,
                  mono: true,
                },
                { term: t('workspace.acquisitions.plan.rawCount'), value: String(plan.raw_acquisitions.length) },
              ]}
            />
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.acquisitions.plan.pageNumber')}</th>
                  <th scope="col">{t('workspace.acquisitions.plan.pageOutcome')}</th>
                  <th scope="col">{t('workspace.acquisitions.plan.pageRecords')}</th>
                  <th scope="col">{t('workspace.acquisitions.plan.pageAttempts')}</th>
                  <th scope="col">{t('workspace.acquisitions.plan.pageFailures')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.plan.pages.map((page) => (
                  <tr key={page.page}>
                    <td>{page.page}</td>
                    <td>{optional(`value.pageOutcome.${page.outcome}`) ?? page.outcome}</td>
                    <td>{page.record_count ?? '—'}</td>
                    <td>{page.attempts}</td>
                    <td>
                      {page.failed_attempts.length === 0
                        ? '—'
                        : page.failed_attempts
                          .map((attempt) => `${String(attempt.status ?? '—')} ${apiFailureText(attempt.error_code)}`)
                          .join('；')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      {session === null && pacing === null ? null : (
        <>
          <Panel level={2} title={t('workspace.acquisitions.session.title')}>
            {session === null ? (
              <p className="empty">{t('workspace.acquisitions.session.empty')}</p>
            ) : (
              <>
                <DefinitionList
                  rows={[
                    { term: t('workspace.acquisitions.session.state'), value: optional(`value.state.${session.state}`) ?? session.state },
                    { term: t('workspace.acquisitions.session.accessToken'), value: booleanLabel(session.has_access_token) },
                    { term: t('workspace.acquisitions.session.cookie'), value: booleanLabel(session.has_cookie) },
                    { term: t('workspace.acquisitions.session.generation'), value: String(session.generation) },
                  ]}
                />
                <Button variant="secondary" busy={busy === 'session'} onClick={resetSession}>
                  {t('workspace.acquisitions.session.reset')}
                </Button>
              </>
            )}
          </Panel>
          <Panel level={2} title={t('workspace.acquisitions.pacing.title')}>
            {pacing === null ? (
              <p className="empty">{t('workspace.acquisitions.pacing.empty')}</p>
            ) : (
              <DefinitionList
                rows={[
                  { term: t('workspace.acquisitions.pacing.queued'), value: String(pacing.queue.length) },
                  { term: t('workspace.acquisitions.pacing.active'), value: String(pacing.active.length) },
                  { term: t('workspace.acquisitions.pacing.lastFinished'), value: formatInstant(pacing.last_finished_at ?? undefined) },
                  { term: t('workspace.acquisitions.pacing.requestsLastMinute'), value: String(pacing.requests_last_minute) },
                  { term: t('workspace.acquisitions.pacing.minimumInterval'), value: pacing.policy === null ? '—' : String(pacing.policy.minimum_interval_seconds) },
                  { term: t('workspace.acquisitions.pacing.maximumRate'), value: pacing.policy?.maximum_requests_per_minute === null || pacing.policy === null ? '—' : String(pacing.policy.maximum_requests_per_minute) },
                ]}
              />
            )}
          </Panel>
        </>
      )}
    </>
  );
}
