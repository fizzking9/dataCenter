import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type ApiError,
  type ApiResult,
  type DataProductSummary,
  type ProductContractView,
  type ProductEvolutionPreviewView,
  type ProductGovernanceGrantView,
  type ProductGovernanceReleaseView,
  type ProductGovernanceVersionView,
  type ProductGovernanceView,
  type WorkspaceExportView,
} from '../api.js';
import { apiFailureText, formatInstant } from '../format.js';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Confirmation } from '../ui/Confirm.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import type { WorkspaceViewProps } from './PlatformWorkspaceScreen.js';

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

function join(values: unknown): string {
  return Array.isArray(values) && values.length > 0 ? values.map(String).join('、') : t('workspace.productGovernance.contracts.none');
}

function filterText(filters: Array<{ field: string; op: string; value: string | number | null }>): string {
  return filters
    .map((filter) => `${filter.field} ${optional(`value.grantOp.${filter.op}`) ?? filter.op} ${filter.value === null ? '空值' : String(filter.value)}`)
    .join('；');
}

function aggregationLabel(aggregation: string): string {
  return optional(`value.aggregation.${aggregation}`) ?? aggregation;
}

function typeLabel(type: string): string {
  return optional(`value.fieldType.${type}`) ?? type;
}

function releaseStatus(release: ProductGovernanceReleaseView): string {
  if (release.withdrawn) return t('workspace.productGovernance.releases.withdrawn');
  if (release.current) return t('workspace.productGovernance.releases.current');
  if (release.retention_expired) return t('workspace.productGovernance.releases.expired');
  return t('workspace.productGovernance.releases.history');
}

function versionStatus(version: ProductGovernanceVersionView): string {
  if (version.withdrawn) return t('workspace.productGovernance.releases.withdrawn');
  return version.current
    ? t('workspace.productGovernance.releases.current')
    : t('workspace.productGovernance.releases.history');
}

function changeLabel(change: ProductGovernanceVersionView['change']): string {
  if (change === 'initial') return t('workspace.productGovernance.contracts.initial');
  return change === 'additive'
    ? t('workspace.productGovernance.contracts.additive')
    : t('workspace.productGovernance.contracts.breaking');
}

function exportStatus(status: WorkspaceExportView['status']): string {
  return optional(`workspace.productGovernance.exports.${status}`) ?? status;
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
      {notice.text}
    </Alert>
  );
}

/** The exact Contract a Version published, reduced to its Consumer-facing shape. */
function ContractShape({ contract }: { contract: ProductContractView }) {
  return (
    <>
      <DefinitionList
        rows={[
          { term: t('workspace.productGovernance.contracts.titleField'), value: contract.title },
          ...(contract.description === undefined ? [] : [{ term: t('workspace.productGovernance.contracts.metrics'), value: contract.description }]),
          { term: t('workspace.productGovernance.contracts.fields'), value: join(contract.fields.map((field) => field.name)) },
          { term: t('workspace.productGovernance.contracts.dimensions'), value: join(contract.dimensions) },
          { term: t('workspace.productGovernance.contracts.grain'), value: join(contract.grain) },
          {
            term: t('workspace.productGovernance.contracts.time'),
            value: contract.time === undefined
              ? t('workspace.productGovernance.contracts.none')
              : `${contract.time.field} · ${typeLabel(contract.time.precision)} · ${contract.time.time_zone}`,
          },
          { term: t('workspace.productGovernance.contracts.filters'), value: join(contract.filters) },
          {
            term: t('workspace.productGovernance.contracts.limit'),
            value: message('workspace.productGovernance.contracts.limitValue', {
              default: String(contract.default_limit),
              max: String(contract.max_limit),
            }),
          },
        ]}
      />
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.productGovernance.contracts.metricName')}</th>
            <th scope="col">{t('workspace.productGovernance.contracts.metricAggregation')}</th>
            <th scope="col">{t('workspace.productGovernance.contracts.metricType')}</th>
            <th scope="col">{t('workspace.productGovernance.contracts.metricField')}</th>
            <th scope="col">{t('workspace.productGovernance.contracts.metricUnit')}</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

type Pending =
  | { kind: 'publish'; preview: ProductEvolutionPreviewView; contract: unknown }
  | { kind: 'rollback'; version: ProductGovernanceVersionView }
  | { kind: 'withdraw'; version: ProductGovernanceVersionView }
  | { kind: 'grant'; grantee: string }
  | { kind: 'revokeGrant'; grant: ProductGovernanceGrantView }
  | { kind: 'revokeExport'; record: WorkspaceExportView };

/**
 * The Workspace Administrator's Data Product governance surface. Every exact
 * Version, Release, freshness, Provenance, Grant, and export comes from one
 * governed server answer; every action is confirmed with its exact target,
 * scope, and consequence, and the browser makes no authorization or lifecycle
 * decision of its own.
 */
export function WorkspaceProductGovernance({ workspaceId, onSessionLost }: WorkspaceViewProps) {
  const [products, setProducts] = useState<DataProductSummary[] | null>(null);
  const [productId, setProductId] = useState('');
  const [view, setView] = useState<ProductGovernanceView | null>(null);
  const [exports, setExports] = useState<WorkspaceExportView[]>([]);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedRelease, setSelectedRelease] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<ProductEvolutionPreviewView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [granteeType, setGranteeType] = useState<'user' | 'agent'>('user');
  const [grantee, setGrantee] = useState('');
  const [grantColumns, setGrantColumns] = useState('');
  const [grantFilters, setGrantFilters] = useState('');
  const [exportQuery, setExportQuery] = useState('{"kind":"records"}');

  const fail = useCallback((error: ApiError): void => {
    setNotice({ tone: 'error', text: apiFailureText(error.code), code: error.code });
  }, []);

  useEffect(() => {
    let active = true;
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

  const load = useCallback(async (id: string): Promise<void> => {
    const [governance, exportList] = await Promise.all([
      platformApi.productGovernance(id),
      platformApi.workspaceExports(workspaceId, id),
    ]);
    if (!governance.ok) {
      if (governance.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      fail(governance.error);
      return;
    }
    if (!exportList.ok) {
      if (exportList.status === 401) {
        onSessionLost();
        return;
      }
      setFailed(true);
      fail(exportList.error);
      return;
    }
    setFailed(false);
    setView(governance.data);
    setExports(exportList.data.exports);
    setSelectedRelease((current) => governance.data.releases.some((release) => release.release === current)
      ? current
      : (governance.data.releases[governance.data.releases.length - 1]?.release ?? null));
    setSelectedVersion((current) => governance.data.versions.some((version) => version.version === current)
      ? current
      : (governance.data.versions[governance.data.versions.length - 1]?.version ?? null));
    setDraft(JSON.stringify(governance.data.latest?.contract ?? {}, null, 2));
    setPreview(null);
  }, [workspaceId, onSessionLost, fail]);

  useEffect(() => {
    if (productId === '') {
      setView(null);
      setExports([]);
      setSelectedRelease(null);
      setSelectedVersion(null);
      setPreview(null);
      return;
    }
    void load(productId);
  }, [productId, load]);

  async function run<T>(label: string, action: () => Promise<ApiResult<T>>): Promise<boolean> {
    setBusy(label);
    setNotice(null);
    const result = await action();
    setBusy(null);
    setPending(null);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return false;
      }
      fail(result.error);
      return false;
    }
    await load(productId);
    return true;
  }

  function previewEvolution(): void {
    let contract: unknown;
    try {
      contract = JSON.parse(draft);
    } catch {
      setNotice({ tone: 'error', text: t('workspace.productGovernance.evolution.invalidJson') });
      return;
    }
    setBusy('preview');
    setNotice(null);
    setPreview(null);
    void platformApi.previewProductEvolution(productId, contract).then((result) => {
      setBusy(null);
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        fail(result.error);
        return;
      }
      setPreview(result.data);
    });
  }

  function createExport(): void {
    let query: unknown;
    try {
      query = JSON.parse(exportQuery);
    } catch {
      setNotice({ tone: 'error', text: t('workspace.productGovernance.exports.invalidJson') });
      return;
    }
    setBusy('export');
    setNotice(null);
    void platformApi.createGovernedExport(productId, query).then(async (result) => {
      if (!result.ok) {
        setBusy(null);
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        fail(result.error);
        return;
      }
      await load(productId);
      setBusy(null);
      setNotice({
        tone: 'info',
        text: message('workspace.productGovernance.exports.created', {
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
        fail(result.error);
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

  const confirm = (): void => {
    if (pending === null) return;
    if (pending.kind === 'publish') {
      void run('publish', () => platformApi.publishProductEvolution(productId, pending.contract)).then((ok) => {
        if (!ok) return;
        setNotice({
          tone: 'info',
          text: message('workspace.productGovernance.evolution.published', {
            version: String(pending.preview.base.data_product_version + 1),
            contract: `${pending.preview.candidate.contract_version.major}.${pending.preview.candidate.contract_version.minor}`,
          }),
        });
      });
      return;
    }
    if (pending.kind === 'rollback') {
      const target = pending.version;
      void run('rollback', () => platformApi.rollbackProductVersion(productId, target.version)).then((ok) => {
        if (!ok) return;
        setNotice({
          tone: 'info',
          text: message('workspace.productGovernance.rollback.done', {
            major: String(target.contract_version.major),
            version: String(target.version),
          }),
        });
      });
      return;
    }
    if (pending.kind === 'withdraw') {
      const target = pending.version;
      void run('withdraw', () => platformApi.withdrawProductVersion(productId, target.version)).then((ok) => {
        if (!ok) return;
        setNotice({
          tone: 'info',
          text: message('workspace.productGovernance.withdraw.done', { version: String(target.version) }),
        });
      });
      return;
    }
    if (pending.kind === 'grant') {
      const target = pending.grantee;
      void run('grant', () => platformApi.publishProductGrant(
        productId,
        granteeType === 'user' ? { username: target } : { agentIdentityId: target },
        grantColumns,
        grantFilters,
      )).then((ok) => {
        if (!ok) return;
        setNotice({
          tone: 'info',
          text: message('workspace.productGovernance.grants.published', {
            grantee: granteeLabel(target),
            product: view?.name ?? '',
          }),
        });
        setGrantColumns('');
        setGrantFilters('');
      });
      return;
    }
    if (pending.kind === 'revokeGrant') {
      void run('revokeGrant', () => platformApi.revokeProductGrant(pending.grant.grant_id)).then((ok) => {
        if (ok) setNotice({ tone: 'info', text: t('workspace.productGovernance.grants.revoked') });
      });
      return;
    }
    const record = pending.record;
    void run('revokeExport', () => platformApi.revokeWorkspaceExport(record.export_id)).then((ok) => {
      if (!ok) return;
      setNotice({
        tone: 'info',
        text: message('workspace.productGovernance.exports.revokedMessage', { export_id: record.export_id }),
      });
    });
  };

  function granteeLabel(id: string): string {
    if (granteeType === 'user') return id;
    return view?.agents.find((agent) => agent.agent_identity_id === id)?.name ?? id;
  }

  const selectedGrantee = grantee === ''
    ? null
    : granteeType === 'user'
      ? (view?.members.find((member) => member.username === grantee)?.username ?? null)
      : (view?.agents.find((agent) => agent.agent_identity_id === grantee)?.name ?? null);
  const release = view?.releases.find((candidate) => candidate.release === selectedRelease) ?? null;
  const version = view?.versions.find((candidate) => candidate.version === selectedVersion) ?? null;

  return (
    <Panel
      level={1}
      title={t('workspace.productGovernance.title')}
      description={t('workspace.productGovernance.description')}
    >
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      <NoticeLine notice={notice} />

      <Panel
        level={2}
        title={t('workspace.productGovernance.select.title')}
        description={t('workspace.productGovernance.select.description')}
      >
        {products === null ? (
          failed ? null : <p className="empty" role="status">{t('platform.loading')}</p>
        ) : products.length === 0 ? (
          <p className="empty">{t('workspace.productGovernance.select.empty')}</p>
        ) : (
          <div className="field">
            <label className="field__label" htmlFor="governance-product">
              {t('workspace.productGovernance.select.product')}
            </label>
            <select
              className="field__input"
              id="governance-product"
              value={productId}
              onChange={(event) => {
                setProductId(event.target.value);
                setNotice(null);
                setPreview(null);
              }}
            >
              <option value="">{t('workspace.productGovernance.select.choose')}</option>
              {products.map((product) => (
                <option key={product.data_product_id} value={product.data_product_id}>{product.name}</option>
              ))}
            </select>
          </div>
        )}
      </Panel>

      {view === null ? null : (
        <>
          <Panel
            level={2}
            title={t('workspace.productGovernance.releases.title')}
            description={t('workspace.productGovernance.releases.description')}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.productGovernance.releases.release')}</th>
                  <th scope="col">{t('workspace.productGovernance.releases.version')}</th>
                  <th scope="col">{t('workspace.productGovernance.releases.contract')}</th>
                  <th scope="col">{t('workspace.productGovernance.releases.dataset')}</th>
                  <th scope="col">{t('workspace.productGovernance.releases.status')}</th>
                  <th scope="col">{t('workspace.productGovernance.releases.createdAt')}</th>
                  <th scope="col">{t('workspace.productGovernance.releases.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {view.releases.map((releaseRecord) => (
                  <tr key={releaseRecord.release}>
                    <td>{releaseRecord.release}</td>
                    <td>{releaseRecord.data_product_version}</td>
                    <td>{releaseRecord.contract_version === null ? '—' : `${releaseRecord.contract_version.major}.${releaseRecord.contract_version.minor}`}</td>
                    <td>{releaseRecord.dataset_release}</td>
                    <td>{releaseStatus(releaseRecord)}</td>
                    <td>{formatInstant(releaseRecord.created_at)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSelectedRelease(releaseRecord.release);
                          setNotice(null);
                        }}
                      >
                        {message('workspace.productGovernance.releases.inspect', { release: String(releaseRecord.release) })}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {release === null ? null : (
            <Panel
              level={2}
              title={message('workspace.productGovernance.releases.detail', { release: String(release.release) })}
            >
              {release.freshness === null ? (
                <p className="empty">{t('workspace.productGovernance.releases.noFreshness')}</p>
              ) : (
                <>
                  <DefinitionList
                    rows={[
                      { term: t('workspace.productGovernance.releases.dataset'), value: String(release.freshness.dataset_release) },
                      { term: t('workspace.productGovernance.releases.recordCount'), value: String(release.freshness.record_count) },
                      { term: t('workspace.productGovernance.releases.configurationVersion'), value: String(release.freshness.integration_configuration_version) },
                      { term: t('workspace.productGovernance.releases.recordsHash'), value: release.freshness.records_hash, mono: true },
                      { term: t('workspace.productGovernance.releases.schemaHash'), value: release.freshness.schema_hash, mono: true },
                      { term: t('workspace.productGovernance.releases.publishedAt'), value: formatInstant(release.freshness.released_at) },
                      { term: t('workspace.productGovernance.releases.acquiredAt'), value: formatInstant(release.freshness.acquired_at) },
                      { term: t('workspace.productGovernance.releases.integratedAt'), value: formatInstant(release.freshness.integrated_at) },
                      { term: t('workspace.productGovernance.releases.batches'), value: join(release.freshness.provenance.batch_ids) },
                      { term: t('workspace.productGovernance.releases.runs'), value: join(release.freshness.provenance.acquisition_run_ids) },
                      { term: t('workspace.productGovernance.releases.raw'), value: join(release.freshness.provenance.raw_acquisition_ids) },
                      {
                        term: t('workspace.productGovernance.releases.relationships'),
                        value: release.relationships.length === 0
                          ? t('workspace.productGovernance.contracts.none')
                          : release.relationships.map((binding) => `${binding.name} · ${binding.dataset_release}`).join('、'),
                      },
                      {
                        term: t('workspace.productGovernance.releases.retention'),
                        value: release.retention_expired
                          ? t('workspace.productGovernance.releases.retentionExpired')
                          : t('workspace.productGovernance.releases.retentionValid'),
                      },
                    ]}
                  />
                </>
              )}
            </Panel>
          )}

          <Panel
            level={2}
            title={t('workspace.productGovernance.lines.title')}
            description={t('workspace.productGovernance.lines.description')}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.productGovernance.lines.major')}</th>
                  <th scope="col">{t('workspace.productGovernance.lines.version')}</th>
                  <th scope="col">{t('workspace.productGovernance.lines.release')}</th>
                  <th scope="col">{t('workspace.productGovernance.lines.openedAt')}</th>
                  <th scope="col">{t('workspace.productGovernance.lines.status')}</th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.major}>
                    <td>{line.major}</td>
                    <td>{line.current_version}</td>
                    <td>{line.current_release}</td>
                    <td>{formatInstant(line.opened_at)}</td>
                    <td>
                      {line.withdrawn_at === null
                        ? t('workspace.productGovernance.lines.active')
                        : t('workspace.productGovernance.releases.withdrawn')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel
            level={2}
            title={t('workspace.productGovernance.contracts.title')}
            description={t('workspace.productGovernance.contracts.description')}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('workspace.productGovernance.contracts.version')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.contract')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.change')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.status')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.publishedBy')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.publishedAt')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.hash')}</th>
                  <th scope="col">{t('workspace.productGovernance.contracts.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {view.versions.map((versionRecord) => (
                  <tr key={versionRecord.version}>
                    <td>{versionRecord.version}</td>
                    <td>{`${versionRecord.contract_version.major}.${versionRecord.contract_version.minor}`}</td>
                    <td>{changeLabel(versionRecord.change)}</td>
                    <td>{versionStatus(versionRecord)}</td>
                    <td>{versionRecord.published_by}</td>
                    <td>{formatInstant(versionRecord.published_at)}</td>
                    <td className="data-table__mono">{versionRecord.contract_hash}</td>
                    <td>
                      <div className="form__actions">
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setSelectedVersion(versionRecord.version);
                            setNotice(null);
                          }}
                        >
                          {message('workspace.productGovernance.contracts.inspect', { version: String(versionRecord.version) })}
                        </Button>
                        {versionRecord.actions.rollback.enabled ? (
                          <Button
                            variant="secondary"
                            busy={busy === 'rollback'}
                            onClick={() => {
                              setNotice(null);
                              setPending({ kind: 'rollback', version: versionRecord });
                            }}
                          >
                            {t('workspace.productGovernance.rollback.button')}
                          </Button>
                        ) : null}
                        {versionRecord.actions.withdraw.enabled ? (
                          <Button
                            variant="quiet"
                            busy={busy === 'withdraw'}
                            onClick={() => {
                              setNotice(null);
                              setPending({ kind: 'withdraw', version: versionRecord });
                            }}
                          >
                            {t('workspace.productGovernance.withdraw.button')}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          {version === null ? null : (
            <Panel
              level={2}
              title={message('workspace.productGovernance.contracts.detail', { version: String(version.version) })}
            >
              <ContractShape contract={version.contract} />
            </Panel>
          )}

          <Panel
            level={2}
            title={t('workspace.productGovernance.evolution.title')}
            description={t('workspace.productGovernance.evolution.description')}
          >
            <div className="field">
              <label className="field__label" htmlFor="governance-contract">
                {t('workspace.productGovernance.evolution.contract')}
              </label>
              <textarea
                className="field__input field__input--mono"
                id="governance-contract"
                rows={12}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setPreview(null);
                }}
                spellCheck={false}
              />
              <p className="field__hint">{t('workspace.productGovernance.evolution.hint')}</p>
            </div>
            <div className="form__actions">
              <Button variant="secondary" busy={busy === 'preview'} onClick={previewEvolution}>
                {busy === 'preview'
                  ? t('workspace.productGovernance.evolution.previewing')
                  : t('workspace.productGovernance.evolution.preview')}
              </Button>
              {preview === null ? null : (
                <Button
                  busy={busy === 'publish'}
                  onClick={() => {
                    let contract: unknown;
                    try {
                      contract = JSON.parse(draft);
                    } catch {
                      setNotice({ tone: 'error', text: t('workspace.productGovernance.evolution.invalidJson') });
                      return;
                    }
                    setNotice(null);
                    setPending({ kind: 'publish', preview, contract });
                  }}
                >
                  {t('workspace.productGovernance.evolution.publish')}
                </Button>
              )}
            </div>
            {preview === null ? null : (
              <Panel level={2} title={t('workspace.productGovernance.evolution.impactTitle')}>
                <DefinitionList
                  rows={[
                    { term: t('workspace.productGovernance.evolution.base'), value: String(preview.base.data_product_version) },
                    {
                      term: t('workspace.productGovernance.evolution.version'),
                      value: `契约 ${preview.candidate.contract_version.major}.${preview.candidate.contract_version.minor}`,
                    },
                    {
                      term: t('workspace.productGovernance.evolution.change'),
                      value: preview.candidate.change === 'additive'
                        ? t('workspace.productGovernance.contracts.additive')
                        : t('workspace.productGovernance.contracts.breaking'),
                    },
                    { term: t('workspace.productGovernance.evolution.hash'), value: preview.candidate.contract_hash, mono: true },
                  ]}
                />
                <h3 className="panel__title">{t('workspace.productGovernance.evolution.consequences')}</h3>
                <ol className="context-history">
                  {preview.consequences.map((consequence, index) => (
                    <li className="context-history__item" key={String(index)}>
                      <p>{consequence}</p>
                    </li>
                  ))}
                </ol>
              </Panel>
            )}
          </Panel>

          <Panel
            level={2}
            title={t('workspace.productGovernance.grants.title')}
            description={t('workspace.productGovernance.grants.description')}
          >
            {view.grants.length === 0 ? (
              <p className="empty">{t('workspace.productGovernance.grants.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('workspace.productGovernance.grants.grantee')}</th>
                    <th scope="col">{t('workspace.productGovernance.grants.columns')}</th>
                    <th scope="col">{t('workspace.productGovernance.grants.rowFilters')}</th>
                    <th scope="col">{t('workspace.productGovernance.grants.createdAt')}</th>
                    <th scope="col">{t('workspace.productGovernance.contracts.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.grants.map((grant) => (
                    <tr key={grant.grant_id}>
                      <td className="data-table__mono">{grant.grantee ?? '—'}</td>
                      <td>
                        {grant.columns === null
                          ? t('workspace.productGovernance.grants.allColumns')
                          : message('workspace.productGovernance.grants.columnsValue', { columns: grant.columns.join('、') })}
                      </td>
                      <td>
                        {grant.row_filters.length === 0
                          ? t('workspace.productGovernance.contracts.none')
                          : message('workspace.productGovernance.grants.filtersValue', { filters: filterText(grant.row_filters) })}
                      </td>
                      <td>{formatInstant(grant.created_at)}</td>
                      <td>
                        <Button
                          variant="quiet"
                          busy={busy === 'revokeGrant'}
                          onClick={() => {
                            setNotice(null);
                            setPending({ kind: 'revokeGrant', grant });
                          }}
                        >
                          {t('workspace.productGovernance.grants.revoke')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="form__grid">
              <div className="field">
                <label className="field__label" htmlFor="governance-grantee-type">
                  {t('workspace.productGovernance.grants.granteeType')}
                </label>
                <select
                  className="field__input"
                  id="governance-grantee-type"
                  value={granteeType}
                  onChange={(event) => {
                    setGranteeType(event.target.value === 'agent' ? 'agent' : 'user');
                    setGrantee('');
                  }}
                >
                  <option value="user">{t('workspace.productGovernance.grants.memberType')}</option>
                  <option value="agent">{t('workspace.productGovernance.grants.agentType')}</option>
                </select>
              </div>
              {granteeType === 'user' ? (
                <div className="field">
                  <label className="field__label" htmlFor="governance-grantee-member">
                    {t('workspace.productGovernance.grants.member')}
                  </label>
                  <select
                    className="field__input"
                    id="governance-grantee-member"
                    value={grantee}
                    onChange={(event) => setGrantee(event.target.value)}
                  >
                    <option value="">—</option>
                    {view.members.map((member) => (
                      <option key={member.username} value={member.username}>{member.username}</option>
                    ))}
                  </select>
                  {view.members.length === 0 ? <p className="field__hint">{t('workspace.productGovernance.grants.noMembers')}</p> : null}
                </div>
              ) : (
                <div className="field">
                  <label className="field__label" htmlFor="governance-grantee-agent">
                    {t('workspace.productGovernance.grants.agent')}
                  </label>
                  <select
                    className="field__input"
                    id="governance-grantee-agent"
                    value={grantee}
                    onChange={(event) => setGrantee(event.target.value)}
                  >
                    <option value="">—</option>
                    {view.agents.map((agent) => (
                      <option key={agent.agent_identity_id} value={agent.agent_identity_id}>{agent.name}</option>
                    ))}
                  </select>
                  {view.agents.length === 0 ? <p className="field__hint">{t('workspace.productGovernance.grants.noAgents')}</p> : null}
                </div>
              )}
              <Field
                id="governance-grant-columns"
                label={t('workspace.productGovernance.grants.columns')}
                value={grantColumns}
                onChange={setGrantColumns}
                hint={message('workspace.productGovernance.grants.columnsHint', {
                  columns: view.published_columns.join('、'),
                })}
                mono
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="governance-grant-filters">
                {t('workspace.productGovernance.grants.rowFilters')}
              </label>
              <textarea
                className="field__input field__input--mono"
                id="governance-grant-filters"
                rows={3}
                value={grantFilters}
                onChange={(event) => setGrantFilters(event.target.value)}
                spellCheck={false}
              />
              <p className="field__hint">{t('workspace.productGovernance.grants.rowFiltersHint')}</p>
            </div>
            <div className="form__actions">
              <Button
                busy={busy === 'grant'}
                onClick={() => {
                  if (selectedGrantee === null) {
                    setNotice({ tone: 'error', text: t('workspace.productGovernance.grants.choose') });
                    return;
                  }
                  setNotice(null);
                  setPending({ kind: 'grant', grantee });
                }}
              >
                {t('workspace.productGovernance.grants.submit')}
              </Button>
            </div>
          </Panel>

          <Panel
            level={2}
            title={t('workspace.productGovernance.exports.title')}
            description={t('workspace.productGovernance.exports.description')}
          >
            <div className="field">
              <label className="field__label" htmlFor="governance-export-query">
                {t('workspace.productGovernance.exports.query')}
              </label>
              <textarea
                className="field__input field__input--mono"
                id="governance-export-query"
                rows={3}
                value={exportQuery}
                onChange={(event) => setExportQuery(event.target.value)}
                spellCheck={false}
              />
              <p className="field__hint">{t('workspace.productGovernance.exports.queryHint')}</p>
            </div>
            <div className="form__actions">
              <Button busy={busy === 'export'} onClick={createExport}>
                {busy === 'export'
                  ? t('workspace.productGovernance.exports.creating')
                  : t('workspace.productGovernance.exports.create')}
              </Button>
            </div>

            {exports.length === 0 ? (
              <p className="empty">{t('workspace.productGovernance.exports.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{t('workspace.productGovernance.exports.id')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.release')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.producer')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.rows')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.columns')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.createdAt')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.expiresAt')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.status')}</th>
                    <th scope="col">{t('workspace.productGovernance.exports.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map((record) => (
                    <tr key={record.export_id}>
                      <td className="data-table__mono">{record.export_id}</td>
                      <td>{record.data_product_release}</td>
                      <td>{record.producer ?? '—'}</td>
                      <td>{record.row_count}</td>
                      <td>{record.columns.join('、')}</td>
                      <td>{formatInstant(record.created_at)}</td>
                      <td>{formatInstant(record.expires_at)}</td>
                      <td>{exportStatus(record.status)}</td>
                      <td>
                        <div className="form__actions">
                          {record.can_download ? (
                            <Button
                              variant="secondary"
                              busy={busy === `download-${record.export_id}`}
                              onClick={() => download(record)}
                            >
                              {busy === `download-${record.export_id}`
                                ? t('workspace.productGovernance.exports.downloading')
                                : t('workspace.productGovernance.exports.download')}
                            </Button>
                          ) : null}
                          {record.status === 'revoked' ? null : (
                            <Button
                              variant="quiet"
                              busy={busy === 'revokeExport'}
                              onClick={() => {
                                setNotice(null);
                                setPending({ kind: 'revokeExport', record });
                              }}
                            >
                              {t('workspace.productGovernance.exports.revoke')}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}

      {pending?.kind === 'publish' ? (
        <Confirmation
          title={t('workspace.productGovernance.evolution.confirmTitle')}
          target={message('workspace.productGovernance.evolution.confirmTarget', {
            contract: `${pending.preview.candidate.contract_version.major}.${pending.preview.candidate.contract_version.minor}`,
            version: String(pending.preview.base.data_product_version + 1),
          })}
          scope={t('value.auditScope.workspace')}
          consequence={message('workspace.productGovernance.evolution.confirmConsequence', {
            change: pending.preview.candidate.change === 'additive'
              ? t('workspace.productGovernance.contracts.additive')
              : t('workspace.productGovernance.contracts.breaking'),
          })}
          confirmLabel={t('workspace.productGovernance.evolution.confirm')}
          busy={busy === 'publish'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'rollback' ? (
        <Confirmation
          title={t('workspace.productGovernance.rollback.confirmTitle')}
          target={message('workspace.productGovernance.rollback.target', {
            version: String(pending.version.version),
            release: pending.version.release === null ? '—' : String(pending.version.release),
          })}
          scope={t('value.auditScope.workspace')}
          consequence={pending.version.actions.rollback.consequence}
          confirmLabel={t('workspace.productGovernance.rollback.confirm')}
          busy={busy === 'rollback'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'withdraw' ? (
        <Confirmation
          title={t('workspace.productGovernance.withdraw.confirmTitle')}
          target={message('workspace.productGovernance.withdraw.target', {
            version: String(pending.version.version),
            release: pending.version.release === null ? '—' : String(pending.version.release),
          })}
          scope={t('value.auditScope.workspace')}
          consequence={pending.version.actions.withdraw.consequence}
          confirmLabel={t('workspace.productGovernance.withdraw.confirm')}
          busy={busy === 'withdraw'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'grant' ? (
        <Confirmation
          title={t('workspace.productGovernance.grants.confirmTitle')}
          target={message('workspace.productGovernance.grants.confirmTarget', {
            grantee: granteeLabel(pending.grantee),
            product: view?.name ?? '',
          })}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.productGovernance.grants.confirmConsequence')}
          confirmLabel={t('workspace.productGovernance.grants.confirm')}
          busy={busy === 'grant'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'revokeGrant' ? (
        <Confirmation
          title={t('workspace.productGovernance.grants.revokeTitle')}
          target={pending.grant.grantee ?? '—'}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.productGovernance.grants.revokeConsequence')}
          confirmLabel={t('workspace.productGovernance.grants.revokeConfirm')}
          busy={busy === 'revokeGrant'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pending?.kind === 'revokeExport' ? (
        <Confirmation
          title={t('workspace.productGovernance.exports.revokeTitle')}
          target={pending.record.export_id}
          scope={t('value.auditScope.workspace')}
          consequence={t('workspace.productGovernance.exports.revokeConsequence')}
          confirmLabel={t('workspace.productGovernance.exports.revokeConfirm')}
          busy={busy === 'revokeExport'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </Panel>
  );
}
