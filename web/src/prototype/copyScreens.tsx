/**
 * PROTOTYPE — THROWAWAY. Wayfinder ticket #82.
 *
 * Three replicas, chosen because between them they exercise every axis the
 * ticket names: a page-level narrative description, a nested enforced rule, a
 * contract hint, a narrative hint, empty states with and without a way out, a
 * consequential-action confirmation, a warning and an error.
 *
 * Titles, labels, column headers and alerts all come from the real catalog via
 * `t()`. Only the data is invented.
 */
import { useState } from 'react';
import { message, optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Alert, DefinitionList } from '../ui/Panel.js';
import * as fx from './copyFixtures.js';
import {
  ProtoConfirmation,
  ProtoEmpty,
  ProtoField,
  ProtoPanel,
  type CopyPolicy,
} from './copyPolicy.js';

function looksLikeJsonArray(value: string): boolean {
  try {
    return Array.isArray(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

/** 工作区 · 业务上下文: nested panel descriptions, an empty state, a JSON error. */
export function ContextScreen({ policy }: { policy: CopyPolicy }) {
  const [entries, setEntries] = useState('');
  const [rejected, setRejected] = useState(false);
  const [published, setPublished] = useState(false);

  const submit = (): void => {
    if (!looksLikeJsonArray(entries)) {
      setRejected(true);
      setPublished(false);
      return;
    }
    setRejected(false);
    setPublished(true);
  };

  return (
    <ProtoPanel level={1} title={t('workspace.context.title')} description={fx.CONTEXT_PAGE_DESCRIPTION} policy={policy}>
      {rejected ? <Alert tone="error">{t('workspace.context.publish.invalidJson')}</Alert> : null}
      {published ? <Alert tone="info">{t('workspace.context.publish.published')}</Alert> : null}

      <p className="context__meta">
        <span>
          {t('workspace.context.version')} <strong>7</strong>
        </span>
        <span>
          {t('workspace.context.hash')} <code>a91f0c7e…42d8</code>
        </span>
      </p>

      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.context.key')}</th>
            <th scope="col">{t('workspace.context.value')}</th>
            <th scope="col">{t('workspace.context.unit')}</th>
            <th scope="col">{t('workspace.context.source')}</th>
          </tr>
        </thead>
        <tbody>
          {fx.CONTEXT_ROWS.map((row) => (
            <tr key={row.key}>
              <td className="data-table__mono">{row.key}</td>
              <td>{row.value}</td>
              <td>{row.unit ?? '—'}</td>
              <td>{optional(`value.contextSource.${row.source}`) ?? row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ProtoPanel level={2} title={t('workspace.context.history')} policy={policy}>
        <ProtoEmpty copy={fx.CONTEXT_HISTORY_EMPTY} policy={policy} />
      </ProtoPanel>

      <ProtoPanel
        level={2}
        title={t('workspace.context.publish.title')}
        description={fx.CONTEXT_PUBLISH_DESCRIPTION}
        policy={policy}
      >
        <ProtoField
          id="proto-context-entries"
          label={t('workspace.context.publish.entries')}
          value={entries}
          onChange={setEntries}
          mono
          area
          policy={policy}
          error={rejected ? t('workspace.context.publish.invalidJson') : undefined}
        />
        <div className="form__actions">
          <Button onClick={submit}>{t('workspace.context.publish.submit')}</Button>
          <Button
            variant="quiet"
            onClick={() => {
              setEntries('');
              setRejected(false);
              setPublished(false);
            }}
          >
            清空
          </Button>
        </div>
      </ProtoPanel>
    </ProtoPanel>
  );
}

/** 工作区 · 代理授权: the longest shipped description, both hint kinds, a confirmation. */
export function AgentsScreen({ policy }: { policy: CopyPolicy }) {
  const [columns, setColumns] = useState('sn, city, handled_count');
  const [rowFilters, setRowFilters] = useState('');
  const [pending, setPending] = useState(false);
  const [published, setPublished] = useState(false);
  const [agent, setAgent] = useState('agent-aftermarket-east');
  const [product, setProduct] = useState('华东保外维修月报');

  return (
    <ProtoPanel level={1} title={t('workspace.agents.title')} description={fx.AGENTS_PAGE_DESCRIPTION} policy={policy}>
      {published ? (
        <Alert tone="info">
          {message('workspace.agents.grant.published', { agent, product })}
        </Alert>
      ) : null}

      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.agents.name')}</th>
            <th scope="col">{t('workspace.agents.scopes')}</th>
            <th scope="col">{t('workspace.agents.grants')}</th>
            <th scope="col">{t('workspace.agents.delegations')}</th>
            <th scope="col">{t('workspace.agents.status')}</th>
          </tr>
        </thead>
        <tbody>
          {fx.AGENT_ROWS.map((row) => (
            <tr key={row.name}>
              <td className="data-table__mono">{row.name}</td>
              <td className="data-table__mono">{row.scopes}</td>
              <td>{row.grants}</td>
              <td>{row.delegations}</td>
              <td>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {pending ? (
        <ProtoConfirmation
          title={t('workspace.agents.grant.confirmTitle')}
          target={`${agent} → ${product}`}
          scope={`${t('session.workspace')}：${fx.FRAME_WORKSPACE_NAME}`}
          consequence={fx.AGENTS_GRANT_CONSEQUENCE}
          preamble={fx.AGENTS_CONFIRM_PREAMBLE}
          confirmLabel={t('workspace.agents.grant.confirm')}
          policy={policy}
          onConfirm={() => {
            setPending(false);
            setPublished(true);
          }}
          onCancel={() => {
            setPending(false);
            setPublished(false);
          }}
        />
      ) : (
        <>
          <ProtoPanel
            level={2}
            title={t('workspace.agents.grant.title')}
            description={fx.AGENTS_GRANT_DESCRIPTION}
            policy={policy}
          >
            <div className="form__grid">
              <ProtoField
                id="proto-grant-agent"
                label={t('workspace.agents.grant.agent')}
                value={agent}
                onChange={setAgent}
                policy={policy}
              />
              <ProtoField
                id="proto-grant-product"
                label={t('workspace.agents.grant.product')}
                value={product}
                onChange={setProduct}
                policy={policy}
              />
              <ProtoField
                id="proto-grant-columns"
                label={t('workspace.agents.grant.columns')}
                value={columns}
                onChange={setColumns}
                hint={fx.AGENTS_COLUMNS_HINT}
                policy={policy}
              />
            </div>
            <ProtoField
              id="proto-grant-filters"
              label={t('workspace.agents.grant.rowFilters')}
              value={rowFilters}
              onChange={setRowFilters}
              hint={fx.AGENTS_ROW_FILTERS_HINT}
              mono
              policy={policy}
            />
            <div className="form__actions">
              <Button
                onClick={() => {
                  setPublished(false);
                  setPending(true);
                }}
              >
                {t('workspace.agents.grant.submit')}
              </Button>
            </div>
          </ProtoPanel>

          <ProtoPanel
            level={2}
            title={t('workspace.agents.delegation.title')}
            description={fx.AGENTS_DELEGATION_DESCRIPTION}
            policy={policy}
          >
            <ProtoEmpty copy={fx.AGENTS_GRANT_EMPTY_PRODUCTS} policy={policy} />
            <div className="form__actions">
              <Button variant="quiet" onClick={() => setPublished(false)}>
                {t('workspace.agents.delegation.submit')}
              </Button>
            </div>
          </ProtoPanel>
        </>
      )}
    </ProtoPanel>
  );
}

/** 运维控制台 · 许可证与续期: the Operator surface, a warning, a path contract. */
export function LicenseScreen({ policy }: { policy: CopyPolicy }) {
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState(false);
  const [renewed, setRenewed] = useState(false);

  return (
    <ProtoPanel level={1} title={t('license.page.title')} description={fx.LICENSE_PAGE_DESCRIPTION} policy={policy}>
      <Alert tone="warning">{fx.LICENSE_WARNING}</Alert>
      {refused ? <Alert tone="error" code="license_import_refused">{fx.LICENSE_REFUSED}</Alert> : null}
      {renewed ? <Alert tone="info">{t('license.import.done')}</Alert> : null}

      <DefinitionList rows={fx.LICENSE_ROWS} />

      {pending ? (
        <ProtoConfirmation
          title={t('license.import.confirmTitle')}
          target={path}
          scope="当前部署"
          consequence={fx.LICENSE_IMPORT_CONSEQUENCE}
          preamble={fx.AGENTS_CONFIRM_PREAMBLE}
          confirmLabel={t('license.import.submit')}
          policy={policy}
          onConfirm={() => {
            setPending(false);
            setRefused(true);
            setRenewed(false);
          }}
          onCancel={() => setPending(false)}
        />
      ) : (
        <ProtoPanel
          level={2}
          title={t('license.import.title')}
          description={fx.LICENSE_IMPORT_DESCRIPTION}
          policy={policy}
        >
          <ProtoField
            id="proto-license-path"
            label={t('license.import.path')}
            value={path}
            onChange={setPath}
            hint={fx.LICENSE_PATH_HINT}
            mono
            policy={policy}
            error={refused ? fx.LICENSE_PATH_REQUIRED : undefined}
          />
          <div className="form__actions">
            <Button
              onClick={() => {
                setRefused(false);
                setRenewed(false);
                setPending(true);
              }}
            >
              {t('license.import.submit')}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setPending(false);
                setRefused(false);
                setRenewed(true);
              }}
            >
              模拟续期成功
            </Button>
          </div>
        </ProtoPanel>
      )}
    </ProtoPanel>
  );
}
