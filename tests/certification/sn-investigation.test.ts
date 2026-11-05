import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHttpSource } from '../support/http-source.js';
import {
  command,
  createUser,
  createWorkspace,
  grantRole,
  jsonFile,
  sessionFor,
  textFile,
} from '../support/platform.js';
import {
  SN_GOLDEN,
  SN_PRODUCT_NAME,
  SN_RELATIONSHIPS,
  SN_CONTRACT,
  acquireSnSnapshot,
  configureSnWorkload,
  publishSnProduct,
  snReplies,
  type SnWorkload,
} from '../support/sn-investigation.js';

/**
 * The SN-centred device investigation of the Reference Workload, certified at the
 * black-box seam: seven Sources and one Workspace-owned Contract are configured
 * through the ordinary governed path, and every observation below is a supported
 * external contract — the lifecycle CLI against a controlled HTTP fixture.
 */

interface QueryResponse {
  kind: string;
  records?: Array<Record<string, unknown>>;
  groups?: Array<{ group: Record<string, string | number | null>; metrics: Record<string, unknown> }>;
  matched_count?: number;
  returned: number;
  truncated: boolean;
  scanned_records: number;
  provenance: {
    source: { source_id: string; name: string };
    dataset_release: number;
    integration_configuration_version: number;
    record_count: number;
    acquired_at: string;
    integrated_at: string;
    released_at: string;
    relationships?: Array<{
      name: string;
      cardinality: string;
      source: { source_id: string; name: string };
      dataset_release: number;
      integration_configuration_version: number;
      record_count: number;
      acquired_at: string;
      integrated_at: string;
      released_at: string;
    }>;
  };
}

function query(workload: SnWorkload, token: string, productId: string, request: Record<string, unknown>): QueryResponse {
  const result = command(
    workload.fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(workload.fixture, 'sn-query', { include_totals: true, ...request })],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as QueryResponse;
}

/** The governed records one linked record set returned, by its published identifier. */
function linkedIdentities(record: Record<string, unknown>): Record<string, string[] | string | null> {
  const linked = record['linked'] as Record<string, unknown>;
  const identities: Record<string, string[] | string | null> = {
    service_plan: linked['service_plan'] === null
      ? null
      : String((linked['service_plan'] as Record<string, unknown>)['plan_no']),
  };
  const byName: Record<string, string> = {
    service_orders: 'order_no',
    refunds: 'refund_no',
    returns: 'return_no',
    device_tags: 'tag_code',
    service_requests: 'request_no',
  };
  for (const [name, field] of Object.entries(byName)) {
    const set = linked[name] as { records: Array<Record<string, unknown>> };
    identities[name] = set.records.map((entry) => String(entry[field]));
  }
  return identities;
}

test('one SN investigation links exactly the frozen plan, order, refund, return, tag, and service-request records', async () => {
  const server = await startHttpSource({ replies: snReplies() });
  const workload = configureSnWorkload(server);
  acquireSnSnapshot(workload);
  const product = publishSnProduct(workload);

  // ---------------------------------------------------------------------------
  // The publication binds the device record and one exact Dataset Release for
  // every declared relationship of the Contract, all in one Workspace.
  // ---------------------------------------------------------------------------
  assert.equal(product.data_product_version, 1);
  assert.equal(product.data_product_release, 1);
  assert.equal(product.dataset_release, 1);
  assert.equal(
    product.api_path,
    `/api/workspaces/${workload.workspaceId}/data-products/${product.data_product_id}/query`,
  );

  const listed = command(workload.fixture, ['product', 'list', '--workspace', workload.workspaceId], { token: workload.token });
  assert.equal(listed.status, 0, listed.stderr);
  const advertised = (listed.output['data_products'] as Array<Record<string, unknown>>)[0]!;
  assert.equal(advertised['title'], SN_PRODUCT_NAME);
  assert.deepEqual(
    (advertised['relationships'] as Array<Record<string, unknown>>).map((entry) => [entry['name'], entry['cardinality']]),
    [
      ['service_plan', 'one'],
      ['service_orders', 'many'],
      ['refunds', 'many'],
      ['returns', 'many'],
      ['device_tags', 'many'],
      ['service_requests', 'many'],
    ],
    'the Contract advertises every relationship and the cardinality it declared',
  );
  for (const entry of advertised['relationships'] as Array<Record<string, unknown>>) {
    assert.equal(typeof entry['description'], 'string', `${String(entry['name'])} carries the business definition`);
    assert.ok((entry['fields'] as unknown[]).length > 0, `${String(entry['name'])} exposes its own fields`);
    assert.ok((entry['grain'] as unknown[]).length > 0, `${String(entry['name'])} declares its own record grain`);
    assert.ok(Array.isArray(entry['filters']), `${String(entry['name'])} declares its own filterable fields`);
  }

  // ---------------------------------------------------------------------------
  // Each golden SN resolves to exactly the linked records the frozen exports
  // carry: a one relationship is one record or explicitly none, a many
  // relationship is the complete set, and an unlinked device is visibly empty
  // rather than silently absent.
  // ---------------------------------------------------------------------------
  for (const golden of SN_GOLDEN) {
    const answer = query(workload, workload.token, product.data_product_id, {
      kind: 'records',
      filters: [{ field: 'device_sn', op: 'equals', value: golden.device_sn }],
      include: [...SN_RELATIONSHIPS],
    });
    assert.equal(answer.kind, 'records');
    assert.equal(answer.records?.length, 1, `${golden.device_sn} is one governed device record`);
    const record = answer.records![0]!;
    assert.deepEqual(
      {
        device_sn: record['device_sn'],
        site_name: record['site_name'],
        service_years: record['service_years'],
      },
      { device_sn: golden.device_sn, site_name: golden.site_name, service_years: golden.service_years },
    );
    assert.deepEqual(linkedIdentities(record), golden.links, `${golden.device_sn} links exactly its frozen records`);

    const plan = (record['linked'] as Record<string, unknown>)['service_plan'];
    if (golden.links.service_plan === null) {
      assert.equal(plan, null, `${golden.device_sn} has no service plan, and the answer says so`);
    } else {
      assert.equal((plan as Record<string, unknown>)['plan_no'], golden.links.service_plan);
      assert.equal(typeof (plan as Record<string, unknown>)['plan_name'], 'string');
    }
    assert.equal(answer.matched_count, 1);
    assert.equal(answer.returned, 1);
    assert.equal(answer.truncated, false);

    // -------------------------------------------------------------------------
    // The governed metrics are evaluated at the device grain, so every metric
    // counts the device once no matter how many linked records it has.
    // -------------------------------------------------------------------------
    const metrics = query(workload, workload.token, product.data_product_id, {
      kind: 'aggregate',
      filters: [{ field: 'device_sn', op: 'equals', value: golden.device_sn }],
    });
    assert.equal(metrics.kind, 'aggregate');
    assert.deepEqual(metrics.groups?.[0]?.metrics, golden.metrics, `${golden.device_sn} returns its frozen metrics`);

    // -------------------------------------------------------------------------
    // The answer explains every returned record: which Source, which Acquisition,
    // which Integration Configuration, and which Dataset Release the value came
    // from, plus the Data Product Release the whole answer was read under.
    // -------------------------------------------------------------------------
    assert.equal(answer.provenance.source.name, '设备档案');
    assert.equal(answer.provenance.dataset_release, 1);
    assert.equal(answer.provenance.integration_configuration_version, 1);
    assert.equal(answer.provenance.record_count, SN_GOLDEN.length);
    for (const field of ['acquired_at', 'integrated_at', 'released_at'] as const) {
      assert.ok(Number.isFinite(Date.parse(answer.provenance[field])), `${field} is a governed instant`);
    }
    const lineage = answer.provenance.relationships ?? [];
    assert.deepEqual(lineage.map((entry) => entry.name), [...SN_RELATIONSHIPS]);
    assert.deepEqual(
      lineage.map((entry) => [entry.name, entry.cardinality, entry.source.name, entry.dataset_release]),
      [
        ['service_plan', 'one', '服务计划', 1],
        ['service_orders', 'many', '服务工单', 1],
        ['refunds', 'many', '退款单', 1],
        ['returns', 'many', '退货单', 1],
        ['device_tags', 'many', '设备标签', 1],
        ['service_requests', 'many', '服务请求', 1],
      ],
      'every linked record names the Source and Dataset Release it was read from',
    );
    for (const entry of lineage) {
      assert.equal(entry.integration_configuration_version, 1);
      assert.ok(entry.record_count > 0);
      for (const field of ['acquired_at', 'integrated_at', 'released_at'] as const) {
        assert.ok(Number.isFinite(Date.parse(entry[field])), `${entry.name}.${field} is a governed instant`);
      }
    }

    const releases = command(workload.fixture, ['product', 'releases', '--product', product.data_product_id], { token: workload.token });
    assert.equal(releases.status, 0, releases.stderr);
    const release = (releases.output['releases'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(
      (release['relationships'] as Array<Record<string, unknown>>).map((entry) => entry['name']),
      [...SN_RELATIONSHIPS],
      'the Data Product Release records the exact Dataset Releases it binds',
    );
  }

  // ---------------------------------------------------------------------------
  // A serial number the Workload holds no record for is an explicit empty
  // answer, not a fabricated device and not an error.
  // ---------------------------------------------------------------------------
  const unknown = query(workload, workload.token, product.data_product_id, {
    kind: 'records',
    filters: [{ field: 'device_sn', op: 'equals', value: 'SN-9999' }],
    include: [...SN_RELATIONSHIPS],
  });
  assert.deepEqual(unknown.records, []);
  assert.equal(unknown.matched_count, 0);
  assert.equal(unknown.truncated, false);

  await server.close();
});

/** A structured refusal from the same governed seam, named by its published code. */
function refusal(workload: SnWorkload, token: string, productId: string, request: unknown, slug: string): string {
  const result = command(
    workload.fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(workload.fixture, `sn-refused-${slug}`, request)],
    { token },
  );
  assert.equal(result.status, 2, `expected a structured refusal for ${slug}: ${result.stdout}`);
  assert.equal(result.stdout, '', 'a refused query never returns data');
  return String(result.error['code']);
}

function publishGrant(
  workload: SnWorkload,
  token: string,
  productId: string,
  request: unknown,
  slug: string,
): Record<string, unknown> {
  const result = command(
    workload.fixture,
    ['grant', 'publish', '--product', productId, '--username', 'analyst@example.invalid', '--request', jsonFile(workload.fixture, `sn-grant-${slug}`, request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

test('Workspace and Data Product Grants narrow every linked record and aggregate the same way', async () => {
  const server = await startHttpSource({ replies: snReplies() });
  const workload = configureSnWorkload(server);
  acquireSnSnapshot(workload);
  const product = publishSnProduct(workload);
  const { fixture, workspaceId, token } = workload;
  const consumerToken = workload.workspace.consumerToken;

  publishGrant(workload, token, product.data_product_id, {
    columns: ['device_sn', 'site_name', 'refunds.refund_no', 'refunds.refund_status'],
    row_filters: [{ field: 'device_sn', op: 'equals', value: 'SN-0002' }],
  }, 'narrowed');

  // ---------------------------------------------------------------------------
  // Discovery is narrowed exactly like a read: the relationship the Grant keeps
  // is advertised with only its permitted fields, and the ones it withholds are
  // absent rather than disclosed as empty.
  // ---------------------------------------------------------------------------
  const listed = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumerToken });
  assert.equal(listed.status, 0, listed.stderr);
  const view = (listed.output['data_products'] as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(view['fields'], ['device_sn', 'site_name']);
  const relationships = view['relationships'] as Array<Record<string, unknown>>;
  assert.deepEqual(relationships.map((entry) => entry['name']), ['refunds'], 'a withheld relationship is not disclosed');
  assert.deepEqual((relationships[0]!['fields'] as Array<Record<string, unknown>>).map((field) => field['name']), ['refund_no', 'refund_status']);
  assert.deepEqual(relationships[0]!['on'], { device_sn: 'device_sn' });

  const narrowed = query(workload, consumerToken, product.data_product_id, {
    kind: 'records',
    include: ['refunds'],
  });
  assert.equal(narrowed.records?.length, 1, 'the Grant row filter caps the counted population');
  const record = narrowed.records![0]!;
  assert.deepEqual(Object.keys(record).sort(), ['device_sn', 'linked', 'site_name']);
  const refunds = (record['linked'] as Record<string, unknown>)['refunds'] as { records: Array<Record<string, unknown>> };
  assert.deepEqual(refunds.records, [
    { refund_no: 'RF-2026-0102', refund_status: '待审批' },
    { refund_no: 'RF-2026-0103', refund_status: '已退款' },
  ], 'linked records carry only the columns the Grant permits');
  assert.deepEqual(
    (narrowed.provenance.relationships ?? []).map((entry) => entry.name),
    ['refunds'],
    'Provenance explains only what this reader was permitted to read',
  );

  // A linked record set is filtered only by the fields the Grant also permits.
  const filtered = query(workload, consumerToken, product.data_product_id, {
    kind: 'records',
    include: [{ name: 'refunds', filters: [{ field: 'refund_status', op: 'equals', value: '已退款' }] }],
  });
  assert.deepEqual(
    ((filtered.records![0]!['linked'] as Record<string, unknown>)['refunds'] as { records: Array<Record<string, unknown>> }).records.map((entry) => entry['refund_no']),
    ['RF-2026-0103'],
    'a relationship filter reads only the linked records, never the base population',
  );

  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, { kind: 'records', include: ['service_orders'] }, 'grant-hidden-relationship'),
    'DATA_PRODUCT_QUERY_REFUSED',
    'a relationship with no permitted column cannot be included',
  );
  assert.equal(
    refusal(
      workload,
      consumerToken,
      product.data_product_id,
      { kind: 'aggregate', metrics: ['longest_service_years'] },
      'grant-hidden-metric',
    ),
    'DATA_PRODUCT_QUERY_REFUSED',
    'a metric over a withheld column is refused rather than silently dropped',
  );

  const grouped = query(workload, consumerToken, product.data_product_id, { kind: 'aggregate', metrics: ['device_count'] });
  assert.deepEqual(grouped.groups?.[0]?.metrics, { device_count: 1 }, 'the row filter applies to aggregates exactly as to records');

  // ---------------------------------------------------------------------------
  // A second Grant narrows the same Product further: columns intersect, and a
  // relationship filter over a column the intersection no longer permits fails
  // deterministically rather than reading a hidden value.
  // ---------------------------------------------------------------------------
  publishGrant(workload, token, product.data_product_id, {
    columns: ['device_sn', 'refunds.refund_no'],
  }, 'narrower');
  const intersection = query(workload, consumerToken, product.data_product_id, {
    kind: 'records',
    include: ['refunds'],
  });
  const refundsAfter = (intersection.records![0]!['linked'] as Record<string, unknown>)['refunds'] as { records: Array<Record<string, unknown>> };
  assert.deepEqual(refundsAfter.records, [
    { refund_no: 'RF-2026-0102' },
    { refund_no: 'RF-2026-0103' },
  ]);
  assert.equal(
    refusal(
      workload,
      consumerToken,
      product.data_product_id,
      { kind: 'records', include: [{ name: 'refunds', filters: [{ field: 'refund_status', op: 'equals', value: '已退款' }] }] },
      'grant-hidden-filter',
    ),
    'DATA_PRODUCT_QUERY_REFUSED',
  );

  await server.close();
});

/** A one-relationship Contract over the device record, for adverse Publications. */
function linkedContract(relationship: Record<string, unknown>): unknown {
  return {
    title: '设备关联校验',
    fields: [{ name: 'device_sn' }, { name: 'site_name' }],
    dimensions: ['site_name'],
    grain: ['device_sn'],
    filters: ['device_sn'],
    limit: { default: 50, max: 200 },
    relationships: [relationship],
  };
}

function publicationRefusal(workload: SnWorkload, contract: unknown, related: Record<string, string>, slug: string): string {
  const result = command(
    workload.fixture,
    [
      'product', 'publish',
      '--source', workload.sources[0]!.sourceId,
      '--name', `设备关联校验-${slug}`,
      '--contract', jsonFile(workload.fixture, `sn-adverse-${slug}-contract`, contract),
      '--related', jsonFile(workload.fixture, `sn-adverse-${slug}-related`, related),
    ],
    { token: workload.token },
  );
  assert.equal(result.status, 2, `expected a structured publication refusal for ${slug}: ${result.stdout}`);
  return String(result.error['code']);
}

test('ambiguous relationships, unsupported joins, and undeclared links fail deterministic validation', async () => {
  const server = await startHttpSource({ replies: snReplies() });
  const workload = configureSnWorkload(server);
  acquireSnSnapshot(workload);
  const product = publishSnProduct(workload);
  const { fixture, token } = workload;
  const consumerToken = workload.workspace.consumerToken;

  // ---------------------------------------------------------------------------
  // A query follows declared links and nothing else: no related field may filter,
  // group, or order the Product's own records, and an aggregate never includes a
  // linked set, so no combination can fan its metrics out.
  // ---------------------------------------------------------------------------
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, {
      kind: 'records',
      filters: [{ field: 'refunds.refund_status', op: 'equals', value: '已退款' }],
    }, 'join-filter'),
    'DATA_PRODUCT_QUERY_REFUSED',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, {
      kind: 'aggregate',
      group_by: ['refunds.refund_status'],
      metrics: ['device_count'],
    }, 'join-group'),
    'DATA_PRODUCT_QUERY_REFUSED',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, {
      kind: 'aggregate',
      group_by: ['site_name'],
      metrics: ['device_count'],
      sort: [{ by: 'refunds.refund_status', direction: 'asc' }],
    }, 'join-sort'),
    'DATA_PRODUCT_QUERY_REFUSED',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, {
      kind: 'aggregate',
      metrics: ['device_count'],
      include: ['refunds'],
    }, 'aggregate-include'),
    'DATA_PRODUCT_QUERY_REFUSED',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, { kind: 'records', include: ['orders'] }, 'unknown-relationship'),
    'DATA_PRODUCT_QUERY_REFUSED',
    'an undeclared relationship is refused by name',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, { kind: 'records', include: ['refunds', 'refunds'] }, 'duplicate-relationship'),
    'DATA_PRODUCT_QUERY_INVALID',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, {
      kind: 'records',
      include: [{ name: 'refunds', filters: [{ field: 'refund_amount', op: 'equals', value: 80 }] }],
    }, 'unfilterable-linked-field'),
    'DATA_PRODUCT_QUERY_REFUSED',
    'a linked field the relationship does not publish as a filter cannot narrow it',
  );
  assert.equal(
    refusal(workload, consumerToken, product.data_product_id, {
      kind: 'records',
      include: [{ name: 'refunds', limit: 2 }],
    }, 'linked-limit-override'),
    'DATA_PRODUCT_QUERY_INVALID',
    'a Consumer cannot widen the bounded linked list a Contract declares',
  );

  // ---------------------------------------------------------------------------
  // A Publication whose declared cardinality or grain the pinned Releases do not
  // support is refused before it can expose an ambiguous or fanning-out answer.
  // ---------------------------------------------------------------------------
  const orders = workload.related['service_orders']!;
  assert.equal(
    publicationRefusal(workload, linkedContract({
      name: 'service_plan', cardinality: 'one', on: { device_sn: 'device_sn' },
      fields: [{ name: 'order_no' }], grain: ['order_no'], filters: [], limit: 1,
    }), { service_plan: orders }, 'ambiguous-one'),
    'DATA_PRODUCT_RELATIONSHIP_AMBIGUOUS',
    'a one relationship that reaches several records would answer ambiguously',
  );
  assert.equal(
    publicationRefusal(workload, linkedContract({
      name: 'service_orders', cardinality: 'many', on: { device_sn: 'device_sn' },
      fields: [{ name: 'order_no' }, { name: 'service_status' }], grain: ['service_status'], filters: [], limit: 50,
    }), { service_orders: orders }, 'non-unique-grain'),
    'DATA_PRODUCT_GRAIN_NOT_UNIQUE',
    'a linked record set whose declared grain repeats would double count',
  );
  assert.equal(
    publicationRefusal(workload, linkedContract({
      name: 'service_plan', cardinality: 'one', on: { device_sn: 'covered_months' },
      fields: [{ name: 'plan_no' }], grain: ['plan_no'], filters: [], limit: 1,
    }), { service_plan: workload.related['service_plan']! }, 'join-type'),
    'DATA_PRODUCT_CONTRACT_INVALID',
    'a join that compares a string with an integer can never match',
  );
  assert.equal(
    publicationRefusal(workload, SN_CONTRACT, { ...workload.related, audit_logs: orders }, 'undeclared'),
    'DATA_PRODUCT_RELATIONSHIP_UNDECLARED',
  );
  const partial = { ...workload.related };
  delete partial['service_requests'];
  assert.equal(
    publicationRefusal(workload, SN_CONTRACT, partial, 'unbound'),
    'DATA_PRODUCT_CONTRACT_INVALID',
    'a declared relationship without a bound Dataset has no governed meaning',
  );

  // ---------------------------------------------------------------------------
  // A relationship never reaches another Workspace, even when the same actor
  // administers both: the binding itself is refused.
  // ---------------------------------------------------------------------------
  createUser(fixture, workload.workspace.deploymentAdministratorToken, 'isolation@example.invalid', 'isolation-administrator');
  const isolationId = createWorkspace(fixture, workload.workspace.deploymentAdministratorToken, '隔离工作区', 'isolation@example.invalid');
  const isolationToken = sessionFor(fixture, 'isolation@example.invalid', 'isolation-administrator');
  grantRole(fixture, isolationToken, isolationId, 'operations@example.invalid', 'Workspace Administrator');
  const foreign = command(fixture, ['source', 'create', '--workspace', isolationId, '--name', '隔离账本', '--type', 'file'], { token: isolationToken });
  assert.equal(foreign.status, 0, foreign.stderr);
  const foreignSource = String(foreign.output['source_id']);
  const foreignIntegration = command(fixture, ['integration', 'publish', '--source', foreignSource, '--config', jsonFile(fixture, 'isolation-integration', {
    identity: ['device_sn'],
    schema: [{ name: 'device_sn', type: 'string' }, { name: 'plan_no', type: 'string' }],
    cleaning: [],
    mapping: { device_sn: 'device_sn', plan_no: 'plan_no' },
  })], { token: isolationToken });
  assert.equal(foreignIntegration.status, 0, foreignIntegration.stderr);
  command(fixture, ['integration', 'adopt', '--source', foreignSource, '--version', String(foreignIntegration.output['integration_configuration_version'])], { token: isolationToken });
  assert.equal(
    command(fixture, ['acquisition', 'upload', '--source', foreignSource, '--file', textFile(fixture, 'isolation.csv', 'device_sn,plan_no\nSN-0001,PL-X\n')], { token: isolationToken }).status,
    0,
  );
  assert.equal(command(fixture, ['dataset', 'release', '--source', foreignSource], { token: isolationToken }).status, 0);
  assert.equal(
    publicationRefusal(workload, SN_CONTRACT, { ...workload.related, service_requests: foreignSource }, 'cross-workspace'),
    'DATA_PRODUCT_RELATIONSHIP_SCOPE',
  );

  // No refused Publication left a Product behind.
  const listed = command(fixture, ['product', 'list', '--workspace', workload.workspaceId], { token });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual((listed.output['data_products'] as Array<Record<string, unknown>>).map((entry) => entry['name']), [SN_PRODUCT_NAME]);

  await server.close();
});

/**
 * The investigation is configuration and frozen certification assets. A module,
 * branch, schema key, or special case named after the business case in the
 * application or the browser would mean removing the Reference Workload could
 * not leave a fully functional generic Deployment.
 */
test('the application and the browser hold no device-investigation case', () => {
  const CASE = /SN-000[0-9]|service-plans|device-tags|service-requests|设备全貌|服务计划|设备标签|退货单|服务请求|device_sn|service_orders/u;
  const roots = ['../../../src', '../../../web/src'].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  const files = roots.flatMap((root) => {
    const walk = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(ts|tsx)$/u.test(path) ? [path] : [];
    });
    return walk(root);
  });
  const offenders = files.filter((file) => CASE.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], 'the device investigation lives only in Workspace configuration and certification assets');
});
