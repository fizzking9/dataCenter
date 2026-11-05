import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  findDataProductVersion,
  latestDataProductRelease,
  latestDataProductVersion,
  majorLine,
  type DataProductArtifact,
  type DataProductRelease,
  type DataProductVersion,
} from './catalog.js';
import { publishedColumns } from './grants.js';
import { readContractChange } from './product-version.js';
import { requireAdministeredProduct } from './products.js';
import { isPastRetention, purgeRevoked } from './retention.js';
import { openPlatform, type PlatformSession } from './session.js';
import { findUserById } from './platform.js';

/** The exact Dataset Release one Data Product Release pinned, with its freshness. */
function releaseFreshness(
  session: PlatformSession,
  release: DataProductRelease,
): Record<string, unknown> | null {
  const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
  const datasetRelease = dataset?.releases.find((candidate) => candidate.release === release.dataset_release);
  if (!dataset || !datasetRelease) return null;
  return {
    dataset_id: dataset.dataset_id,
    dataset_release: datasetRelease.release,
    record_count: datasetRelease.record_count,
    records_hash: datasetRelease.records_hash,
    schema_hash: datasetRelease.schema_hash,
    integration_configuration_version: datasetRelease.integration_configuration_version,
    released_at: datasetRelease.created_at,
    acquired_at: datasetRelease.provenance.acquired_at,
    integrated_at: datasetRelease.provenance.integrated_at,
    provenance: {
      batch_ids: [...datasetRelease.provenance.batch_ids],
      acquisition_run_ids: [...datasetRelease.provenance.acquisition_run_ids],
      raw_acquisition_ids: [...datasetRelease.provenance.raw_acquisition_ids],
      acquired_at: datasetRelease.provenance.acquired_at,
      integrated_at: datasetRelease.provenance.integrated_at,
      released_at: datasetRelease.created_at,
    },
  };
}

/** The Chinese statement of what Withdrawal of one Version would do. */
function withdrawConsequence(
  product: DataProductArtifact,
  version: DataProductVersion,
  release: DataProductRelease | undefined,
): string {
  if (version.withdrawn_at !== null) return '该版本已撤下，不能再次撤下。';
  const line = majorLine(product, version.contract_version.major);
  if (line !== undefined && line.current_version === version.version) {
    return `撤下后，主版本 ${version.contract_version.major} 将停止提供新查询；发布版本 ${release?.release ?? version.version} 不再执行。历史、来源追溯与审计事件保留。`;
  }
  return `撤下后，发布版本 ${release?.release ?? version.version} 不再执行新查询；主版本 ${version.contract_version.major} 的当前发布版本 ${line?.current_release ?? '—'} 不受影响。历史与来源追溯保留。`;
}

/** The Chinese statement of what Rollback to one Version would do. */
function rollbackConsequence(
  product: DataProductArtifact,
  version: DataProductVersion,
  release: DataProductRelease | undefined,
  defaultMajor: number | null,
): string {
  const line = majorLine(product, version.contract_version.major);
  if (version.withdrawn_at !== null) return '已撤下的版本不能作为回滚目标。';
  if (line === undefined || line.withdrawn_at !== null) {
    return `主版本 ${version.contract_version.major} 已撤下，不能回滚到该版本。`;
  }
  if (line.current_version === version.version) return '该版本已是主版本的当前发布版本，无需回滚。';
  const defaultText = defaultMajor === line.major ? '默认查询将读取该版本' : `默认查询仍读取主版本 ${defaultMajor ?? '—'}`;
  return `回滚后，主版本 ${line.major} 的当前发布版本恢复为 ${release?.release ?? version.version}（数据产品版本 ${version.version}）。此后发布仍作为历史保留；${defaultText}。`;
}

/**
 * The Workspace Administrator's complete governance view of one Data Product:
 * exact Versions and Releases, the Dataset freshness and Provenance each
 * Release pinned, the Grants in force, and the consequences of the two
 * lifecycle actions. The browser renders this answer; it decides nothing.
 */
export function showDataProductGovernance(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'data_product_governance_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const product = requireAdministeredProduct(session, actor, context, options.dataProductId);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const now = new Date();
  const latest = latestDataProductVersion(product);
  const latestRelease = latestDataProductRelease(product);
  if (!latest || !latestRelease) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'DATA_PRODUCT_NOT_PUBLISHED',
      'The Data Product has no Publication to govern.',
      'Publish the Data Product first.',
    );
  }
  const active = product.lines
    .filter((line) => line.withdrawn_at === null)
    .sort((left, right) => right.major - left.major)[0];
  const defaultMajor = active?.major ?? null;

  const versions = product.versions.map((version, index) => {
    const line = majorLine(product, version.contract_version.major);
    const release = product.releases.find((candidate) => candidate.data_product_version === version.version);
    const previous = product.versions[index - 1];
    const change = previous === undefined
      ? { kind: 'initial' as const, breaking: [] as string[] }
      : (() => {
        const difference = readContractChange(previous.contract, version.contract);
        return {
          kind: difference.breaking.length === 0 ? 'additive' as const : 'breaking' as const,
          breaking: difference.breaking,
        };
      })();
    const current = line !== undefined && line.current_version === version.version;
    return {
      version: version.version,
      contract_version: { ...version.contract_version },
      published_at: version.published_at,
      published_by: version.published_by,
      contract_hash: version.contract_hash,
      withdrawn_at: version.withdrawn_at,
      withdrawn: version.withdrawn_at !== null,
      current,
      release: release?.release ?? null,
      dataset_release: release?.dataset_release ?? null,
      change: change.kind,
      breaking: change.breaking,
      contract: version.contract,
      actions: {
        withdraw: {
          enabled: version.withdrawn_at === null,
          consequence: withdrawConsequence(product, version, release),
        },
        rollback: {
          enabled: version.withdrawn_at === null
            && line !== undefined
            && line.withdrawn_at === null
            && line.current_version !== version.version,
          consequence: rollbackConsequence(product, version, release, defaultMajor),
        },
      },
    };
  });

  const releases = product.releases.map((release) => {
    const version = findDataProductVersion(product, release.data_product_version);
    const current = product.lines.some((line) => line.current_release === release.release);
    return {
      release: release.release,
      data_product_version: release.data_product_version,
      contract_version: version === undefined ? null : { ...version.contract_version },
      contract_hash: version?.contract_hash ?? null,
      withdrawn: version?.withdrawn_at !== null && version?.withdrawn_at !== undefined,
      current,
      created_at: release.created_at,
      created_by: release.created_by,
      dataset_id: release.dataset_id,
      dataset_release: release.dataset_release,
      relationships: (release.relationships ?? []).map((binding) => ({ ...binding })),
      retention_expired: !current
        && (purgeRevoked(session.state, 'data_product_release', `${product.data_product_id}#${release.release}`)
          || isPastRetention(session.state, product.workspace_id, 'dataset_release_history', release.created_at, now)),
      freshness: releaseFreshness(session, release),
    };
  });

  const grants = session.state.data_product_grants
    .filter((grant) => grant.data_product_id === product.data_product_id && grant.revoked_at === null)
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((grant) => ({
      grant_id: grant.grant_id,
      grantee_type: grant.grantee_agent_identity_id === undefined || grant.grantee_agent_identity_id === null
        ? 'user'
        : 'agent',
      grantee: grant.grantee_agent_identity_id === undefined || grant.grantee_agent_identity_id === null
        ? (findUserById(session.state, grant.grantee_user_id ?? '')?.username ?? null)
        : (session.state.agent_identities.find((agent) => agent.agent_identity_id === grant.grantee_agent_identity_id)?.name ?? null),
      columns: grant.columns === null ? null : [...grant.columns],
      row_filters: grant.row_filters.map((filter) => ({ ...filter })),
      created_at: grant.created_at,
    }));

  const members = session.state.memberships
    .filter((membership) => membership.workspace_id === product.workspace_id)
    .flatMap((membership) => {
      const user = findUserById(session.state, membership.user_id);
      return user === undefined || user.status !== 'active'
        ? []
        : [{ username: user.username, role: membership.role }];
    })
    .sort((left, right) => left.username.localeCompare(right.username));

  const agents = session.state.agent_identities
    .filter((agent) => agent.status === 'active' && agent.workspace_ids.includes(product.workspace_id))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((agent) => ({ agent_identity_id: agent.agent_identity_id, name: agent.name, scopes: [...agent.scopes] }));

  const rollbacks = (product.rollbacks ?? []).map((rollback) => ({
    ...rollback,
    actor: findUserById(session.state, rollback.created_by)?.username ?? null,
  }));

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { versions_returned: versions.length, releases_returned: releases.length, grants_returned: grants.length },
  });
  return {
    data_product_id: product.data_product_id,
    workspace_id: product.workspace_id,
    name: product.name,
    api_path: product.api_path,
    lines: product.lines.map((line) => ({ ...line })),
    active_major: defaultMajor,
    versions,
    releases,
    grants,
    members,
    agents,
    rollbacks,
    published_columns: latest === undefined ? [] : publishedColumns(latest.contract),
    published_filters: latest === undefined ? [] : [...latest.contract.filters],
    latest: latest === undefined
      ? null
      : {
        data_product_version: latest.version,
        contract_version: { ...latest.contract_version },
        data_product_release: latestRelease?.release ?? null,
        dataset_release: latestRelease?.dataset_release ?? null,
        contract: latest.contract,
      },
  };
}
