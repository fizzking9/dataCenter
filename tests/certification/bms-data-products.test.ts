import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BMS_BUSINESS_CONTEXT } from '../fixtures/reference-workload/bms/business-context.js';
import {
  BMS_COMPLAINT_CONTRACT,
  BMS_OPERATING_CONTRACT,
  BMS_REFUND_CONTRACT,
} from '../fixtures/reference-workload/bms/contracts.js';
import { BMS_DICTIONARIES, dictionarySchema } from '../fixtures/reference-workload/bms/data-dictionary.js';
import {
  BMS_COMPLAINT_EXPECTED,
  BMS_OPERATING_EXPECTED,
  BMS_REFUND_EXPECTED,
  type ExpectedComparison,
} from '../fixtures/reference-workload/bms/expected.js';
import {
  BMS_TODAY_ELAPSED,
  BMS_WEEK_CURRENT_WINDOW,
  BMS_WEEK_PREVIOUS_WINDOW,
  BMS_YESTERDAY_ELAPSED,
} from '../fixtures/reference-workload/bms/exports.js';
import { startHttpSource } from '../support/http-source.js';
import { command, jsonFile, type PlatformFixture } from '../support/platform.js';
import {
  bmsReplies,
  bmsSource,
  configureBmsWorkload,
  recordsOnSweep,
  sweepBmsWorkload,
  type ReferenceWorkload,
} from '../support/reference-workload.js';

/**
 * The three BMS business Data Products at the black-box certification seam.
 *
 * The Reference Workload is configured the way an operator configures any
 * Workspace: nine Sources, one serialized Connection, an approved Business
 * Context, and three Data Product Contracts. Every number below is read back
 * through the published Data Product API/CLI seam and compared with the frozen
 * manually validated oracle; nothing reaches inside the engine.
 */

interface WindowView {
  field: string;
  precision: string;
  time_zone: string;
  start: string;
  end: string;
  coverage: { start: string; end: string } | null;
  partial: boolean;
  period?: string;
  complete?: boolean;
  same_elapsed_interval?: boolean;
}

interface AggregateView {
  data_product_id: string;
  data_product_release: number;
  contract_version: { major: number; minor: number };
  grouped_by: string[];
  metrics: Array<Record<string, unknown>>;
  groups: Array<{
    group: Record<string, string | number | null>;
    null_dimensions: string[];
    metrics: Record<string, string | number | null>;
    comparison?: Record<string, ExpectedComparison>;
  }>;
  totals: {
    metrics: Record<string, string | number | null>;
    comparison?: Record<string, ExpectedComparison>;
  } | null;
  groups_total: number;
  window: WindowView | null;
  comparison_window: WindowView | null;
  provenance: {
    source: { source_id: string; name: string | null };
    dataset_release: number;
    integration_configuration_version: number;
    business_context: { common_business_context_version: number; workspace_business_context_version: number };
    record_count: number;
    acquired_at: string;
    integrated_at: string;
    released_at: string;
  };
}

interface Publication {
  data_product_id: string;
  name: string;
  data_product_version: number;
  data_product_release: number;
  dataset_release: number;
  contract_version: { major: number; minor: number };
}

function publish(
  fixture: PlatformFixture,
  token: string,
  sourceId: string,
  name: string,
  contract: unknown,
  slug: string,
): Publication {
  const result = command(
    fixture,
    ['product', 'publish', '--source', sourceId, '--name', name, '--contract', jsonFile(fixture, `contract-${slug}`, contract)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as Publication;
}

function aggregate(
  fixture: PlatformFixture,
  token: string,
  productId: string,
  request: Record<string, unknown>,
  slug: string,
): AggregateView {
  const result = command(
    fixture,
    ['product', 'query', '--product', productId, '--request', jsonFile(fixture, `query-${slug}`, request)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as unknown as AggregateView;
}

function groupsOf(view: AggregateView): Array<{ group: Record<string, string | number | null>; metrics: Record<string, string | number | null> }> {
  return view.groups.map((entry) => ({ group: entry.group, metrics: entry.metrics }));
}

function comparisonOf(entry: { comparison?: Record<string, ExpectedComparison> }): Record<string, ExpectedComparison> {
  assert.ok(entry.comparison !== undefined, 'the bound metric states its comparison');
  const picked: Record<string, ExpectedComparison> = {};
  for (const [name, value] of Object.entries(entry.comparison)) {
    picked[name] = {
      value: value.value,
      change: value.change,
      change_percent: value.change_percent,
      direction: value.direction,
      judgment: value.judgment,
    };
  }
  return picked;
}

test('the Reference Workload answers the operating, four-route refund, and three-source complaint Data Products exactly', async () => {
  const server = await startHttpSource({ replies: bmsReplies(2) });
  const workload: ReferenceWorkload = configureBmsWorkload(server, { context: BMS_BUSINESS_CONTEXT });
  const { fixture, workspaceId, workspaceAdministratorToken: admin, consumerToken: consumer } = workload.workspace;

  // The first sweep governs the frozen two weeks; the overlapping second sweep
  // re-reads them, corrects one record, and adds the current partial day.
  const sweptAt = Date.now();
  const firstSweep = sweepBmsWorkload(workload, sweptAt);
  assert.equal(firstSweep.length, 9, 'one sweep reads every Source of the physical system');
  const secondSweep = sweepBmsWorkload(workload, Date.now());
  assert.equal(secondSweep.length, 9);

  // -------------------------------------------------------------------------
  // Each business Source curates the frozen export through the dictionary the
  // Workspace published, pinning the approved Business Context version it was
  // integrated under.
  // -------------------------------------------------------------------------
  const business = [
    { source: bmsSource(workload, '服务工单'), dictionary: 'service_orders' as const, workIndex: 0 },
    { source: bmsSource(workload, '退款单'), dictionary: 'refunds' as const, workIndex: 1 },
    { source: bmsSource(workload, '投诉工单'), dictionary: 'complaints' as const, workIndex: 5 },
  ];
  for (const { source, dictionary, workIndex } of business) {
    assert.equal(firstSweep[workIndex]!['records'], recordsOnSweep(0, workIndex));
    const result = secondSweep[workIndex]!;
    assert.equal(result['status'], 'complete');
    assert.equal(result['dataset_release'], 2);
    assert.equal(result['records'], recordsOnSweep(1, workIndex));

    const shown = command(fixture, ['dataset', 'show', '--source', source.sourceId], { token: admin });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.output['record_count'], recordsOnSweep(1, workIndex));
    assert.equal(shown.output['record_rejection_count'], 0);
    assert.deepEqual(shown.output['pins'], {
      common_business_context_version: 0,
      workspace_business_context_version: 1,
    }, 'the Release pinned the approved Business Context it was integrated under');
    const records = shown.output['records'] as Array<{ values: Record<string, unknown> }>;
    const canonical = dictionarySchema(dictionary).map((field) => field.name).sort();
    for (const record of records) {
      assert.deepEqual(Object.keys(record.values).sort(), canonical, 'the dictionary mapping governs every canonical field');
    }
    // The source's own columns never survive curation under their own names.
    const renamed = BMS_DICTIONARIES[dictionary].find((entry) => entry.column !== entry.field);
    if (renamed !== undefined) {
      assert.equal(records[0]!.values[renamed.column], undefined, 'a source column is curated into its canonical field');
    }
  }

  // -------------------------------------------------------------------------
  // The three Contracts are published through the ordinary governed path; the
  // approved Metric Definitions govern each metric, and the listing exposes the
  // binding and the favourable direction a Consumer reads beside a result.
  // -------------------------------------------------------------------------
  const operating = publish(fixture, admin, business[0]!.source.sourceId, BMS_OPERATING_CONTRACT.title, BMS_OPERATING_CONTRACT, 'operating');
  const refund = publish(fixture, admin, business[1]!.source.sourceId, BMS_REFUND_CONTRACT.title, BMS_REFUND_CONTRACT, 'refund');
  const complaint = publish(fixture, admin, business[2]!.source.sourceId, BMS_COMPLAINT_CONTRACT.title, BMS_COMPLAINT_CONTRACT, 'complaint');
  for (const publication of [operating, refund, complaint]) {
    assert.equal(publication.dataset_release, 2);
    assert.deepEqual(publication.contract_version, { major: 1, minor: 0 });
  }

  const listed = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumer });
  assert.equal(listed.status, 0, listed.stderr);
  const listedProducts = listed.output['data_products'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    listedProducts.map((product) => product['name']).sort(),
    [BMS_OPERATING_CONTRACT.title, BMS_REFUND_CONTRACT.title, BMS_COMPLAINT_CONTRACT.title].sort(),
  );
  const refundListing = listedProducts.find((product) => product['name'] === BMS_REFUND_CONTRACT.title)!;
  assert.deepEqual(
    (refundListing['metrics'] as Array<Record<string, unknown>>).map((metric) => ({
      name: metric['name'],
      definition: metric['definition'],
      favorable_direction: metric['favorable_direction'],
    })),
    [
      { name: 'refund_count', definition: 'refund_count', favorable_direction: 'down' },
      { name: 'refund_amount_total', definition: 'refund_amount_total', favorable_direction: 'down' },
    ],
    'discovery states the approved Metric Definition each metric binds',
  );
  assert.deepEqual(refundListing['time'], {
    field: 'refunded_at',
    precision: 'timestamp',
    time_zone: 'Asia/Shanghai',
    definition: 'business_time_zone',
  }, 'the Contract hands its business time zone to the approved definition');

  // -------------------------------------------------------------------------
  // 经营总览: reception volume, handled volume, status distribution, and the
  // daily trend over the current complete week.
  // -------------------------------------------------------------------------
  const operatingWeek = (window: Record<string, string>, slug: string): AggregateView => aggregate(
    fixture,
    consumer,
    operating.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['service_status'],
      metrics: ['reception_count', 'handled_total'],
      include_totals: true,
      window,
    },
    slug,
  );
  const previousWeek = operatingWeek(BMS_WEEK_PREVIOUS_WINDOW, 'operating-previous');
  assert.deepEqual(
    groupsOf(previousWeek).map((entry) => ({ service_status: entry.group['service_status'], ...entry.metrics })),
    BMS_OPERATING_EXPECTED.week_previous.groups,
  );
  assert.deepEqual(previousWeek.totals?.metrics, BMS_OPERATING_EXPECTED.week_previous.totals);

  const currentWeek = operatingWeek(BMS_WEEK_CURRENT_WINDOW, 'operating-current');
  assert.deepEqual(
    groupsOf(currentWeek).map((entry) => ({ service_status: entry.group['service_status'], ...entry.metrics })),
    BMS_OPERATING_EXPECTED.week_current.groups,
  );
  assert.deepEqual(currentWeek.totals?.metrics, BMS_OPERATING_EXPECTED.week_current.totals);

  const operatingTrend = aggregate(
    fixture,
    consumer,
    operating.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['registered_on'],
      metrics: ['reception_count', 'handled_total'],
      sort: [{ by: 'registered_on', direction: 'asc' }],
      window: BMS_WEEK_CURRENT_WINDOW,
    },
    'operating-trend',
  );
  assert.deepEqual(
    groupsOf(operatingTrend).map((entry) => ({ day: entry.group['registered_on'], ...entry.metrics })),
    BMS_OPERATING_EXPECTED.trend_current,
  );

  // The current partial day compared with the previous day's same elapsed
  // interval: both windows are partial days, and the comparison says so.
  const operatingDaily = aggregate(
    fixture,
    consumer,
    operating.data_product_id,
    {
      kind: 'aggregate',
      metrics: ['reception_count', 'handled_total'],
      include_totals: true,
      window: { ...BMS_TODAY_ELAPSED, period: 'day' },
      comparison: { ...BMS_YESTERDAY_ELAPSED, period: 'day' },
    },
    'operating-daily',
  );
  assert.deepEqual(operatingDaily.totals?.metrics, BMS_OPERATING_EXPECTED.daily.totals);
  assert.deepEqual(comparisonOf(operatingDaily.totals!), BMS_OPERATING_EXPECTED.daily.comparison);
  assert.deepEqual(
    {
      period: operatingDaily.window?.period,
      partial: operatingDaily.window?.partial,
      complete: operatingDaily.window?.complete,
      start: operatingDaily.window?.start,
      end: operatingDaily.window?.end,
    },
    {
      period: 'day',
      partial: true,
      complete: false,
      start: BMS_TODAY_ELAPSED.start,
      end: BMS_TODAY_ELAPSED.end,
    },
    'the current day is a visibly partial period',
  );
  assert.deepEqual(
    {
      period: operatingDaily.comparison_window?.period,
      partial: operatingDaily.comparison_window?.partial,
      complete: operatingDaily.comparison_window?.complete,
      same_elapsed_interval: operatingDaily.comparison_window?.same_elapsed_interval,
    },
    { period: 'day', partial: true, complete: false, same_elapsed_interval: true },
  );

  // The current complete week compared with the previous complete week: both
  // are complete periods and the same elapsed interval of their week.
  const operatingWeekly = aggregate(
    fixture,
    consumer,
    operating.data_product_id,
    {
      kind: 'aggregate',
      metrics: ['reception_count', 'handled_total'],
      include_totals: true,
      window: { ...BMS_WEEK_CURRENT_WINDOW, period: 'week' },
      comparison: { ...BMS_WEEK_PREVIOUS_WINDOW, period: 'week' },
    },
    'operating-weekly',
  );
  assert.deepEqual(comparisonOf(operatingWeekly.totals!), BMS_OPERATING_EXPECTED.weekly.comparison);
  assert.deepEqual(
    {
      partial: operatingWeekly.window?.partial,
      complete: operatingWeekly.window?.complete,
      comparison_partial: operatingWeekly.comparison_window?.partial,
      comparison_complete: operatingWeekly.comparison_window?.complete,
      same_elapsed_interval: operatingWeekly.comparison_window?.same_elapsed_interval,
    },
    { partial: false, complete: true, comparison_partial: false, comparison_complete: true, same_elapsed_interval: true },
  );

  // -------------------------------------------------------------------------
  // 四路退款: every route with its own count and amount, the amount trend over
  // the current week, and the week-over-week change per route.
  // -------------------------------------------------------------------------
  const refundComparison = aggregate(
    fixture,
    consumer,
    refund.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['refund_route'],
      metrics: ['refund_count', 'refund_amount_total'],
      include_totals: true,
      sort: [{ by: 'refund_amount_total', direction: 'desc' }],
      window: BMS_WEEK_CURRENT_WINDOW,
      comparison: BMS_WEEK_PREVIOUS_WINDOW,
    },
    'refund-routes',
  );
  assert.deepEqual(
    refundComparison.groups.map((entry) => ({ refund_route: entry.group['refund_route'], ...entry.metrics })),
    [...BMS_REFUND_EXPECTED.week_current.groups].sort((left, right) =>
      Number(right.refund_amount_total) - Number(left.refund_amount_total)),
    'the four refund routes carry their own amounts and counts',
  );
  assert.deepEqual(refundComparison.totals?.metrics, BMS_REFUND_EXPECTED.week_current.totals);
  const refundRouteComparison = Object.fromEntries(
    refundComparison.groups.map((entry) => [entry.group['refund_route'], comparisonOf(entry)]),
  );
  for (const [route, expected] of Object.entries(BMS_REFUND_EXPECTED.route_comparison)) {
    assert.deepEqual(refundRouteComparison[route], expected, `${route} states its own governed change`);
  }
  assert.deepEqual(comparisonOf(refundComparison.totals!), BMS_REFUND_EXPECTED.weekly.comparison);

  const refundTrend = aggregate(
    fixture,
    consumer,
    refund.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['refunded_on'],
      metrics: ['refund_amount_total'],
      sort: [{ by: 'refunded_on', direction: 'asc' }],
      window: BMS_WEEK_CURRENT_WINDOW,
    },
    'refund-trend',
  );
  assert.deepEqual(
    groupsOf(refundTrend).map((entry) => ({ day: entry.group['refunded_on'], ...entry.metrics })),
    BMS_REFUND_EXPECTED.trend_current,
  );

  const refundDaily = aggregate(
    fixture,
    consumer,
    refund.data_product_id,
    {
      kind: 'aggregate',
      metrics: ['refund_count', 'refund_amount_total'],
      include_totals: true,
      window: { ...BMS_TODAY_ELAPSED, period: 'day' },
      comparison: { ...BMS_YESTERDAY_ELAPSED, period: 'day' },
    },
    'refund-daily',
  );
  assert.deepEqual(refundDaily.totals?.metrics, BMS_REFUND_EXPECTED.daily.totals);
  assert.deepEqual(comparisonOf(refundDaily.totals!), BMS_REFUND_EXPECTED.daily.comparison);
  assert.equal(refundDaily.window?.partial, true);
  assert.equal(refundDaily.comparison_window?.same_elapsed_interval, true);

  // -------------------------------------------------------------------------
  // 三源投诉: registrations, handling, and backlog per source. Falling complaint
  // volume is favourable because the approved definition says so; falling
  // handling is adverse for the same reason, not the sign of the change.
  // -------------------------------------------------------------------------
  const complaintToday = aggregate(
    fixture,
    consumer,
    complaint.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['complaint_source'],
      metrics: ['complaint_registered', 'complaint_handled', 'complaint_backlog'],
      include_totals: true,
      window: { ...BMS_TODAY_ELAPSED, period: 'day' },
      comparison: { ...BMS_YESTERDAY_ELAPSED, period: 'day' },
    },
    'complaint-today',
  );
  assert.deepEqual(
    complaintToday.groups.map((entry) => ({ complaint_source: entry.group['complaint_source'], ...entry.metrics })),
    BMS_COMPLAINT_EXPECTED.daily.groups,
  );
  assert.deepEqual(complaintToday.totals?.metrics, BMS_COMPLAINT_EXPECTED.daily.totals);
  assert.deepEqual(comparisonOf(complaintToday.totals!), BMS_COMPLAINT_EXPECTED.daily.comparison);
  assert.equal(complaintToday.window?.partial, true, 'the current complaint snapshot is a partial day');

  const complaintWeekly = aggregate(
    fixture,
    consumer,
    complaint.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['complaint_source'],
      metrics: ['complaint_registered', 'complaint_handled'],
      include_totals: true,
      window: BMS_WEEK_CURRENT_WINDOW,
      comparison: BMS_WEEK_PREVIOUS_WINDOW,
    },
    'complaint-weekly',
  );
  assert.deepEqual(
    complaintWeekly.groups.map((entry) => ({ complaint_source: entry.group['complaint_source'], ...entry.metrics })),
    BMS_COMPLAINT_EXPECTED.week_current.groups,
  );
  assert.deepEqual(complaintWeekly.totals?.metrics, BMS_COMPLAINT_EXPECTED.week_current.totals);
  assert.deepEqual(comparisonOf(complaintWeekly.totals!), BMS_COMPLAINT_EXPECTED.weekly.comparison);
  assert.equal(
    complaintWeekly.totals?.comparison?.['complaint_registered']?.judgment,
    'favorable',
    'falling complaint volume receives the approved favourable direction',
  );
  assert.equal(
    complaintWeekly.totals?.comparison?.['complaint_handled']?.judgment,
    'adverse',
    'the same fall is adverse where the approved direction says more is better',
  );

  const complaintTrend = aggregate(
    fixture,
    consumer,
    complaint.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['snapshot_on'],
      metrics: ['complaint_registered', 'complaint_handled'],
      sort: [{ by: 'snapshot_on', direction: 'asc' }],
      window: BMS_WEEK_CURRENT_WINDOW,
    },
    'complaint-trend',
  );
  assert.deepEqual(
    groupsOf(complaintTrend).map((entry) => ({ day: entry.group['snapshot_on'], ...entry.metrics })),
    BMS_COMPLAINT_EXPECTED.trend_current,
  );

  // -------------------------------------------------------------------------
  // Provenance, freshness, and the applied windows are exact: the Release, the
  // pinned context, the record count, and the distinct source, acquisition,
  // integration, and release instants all explain the answer.
  // -------------------------------------------------------------------------
  const provenance = complaintToday.provenance;
  assert.deepEqual(provenance.source, { source_id: business[2]!.source.sourceId, name: '投诉工单' });
  assert.equal(provenance.dataset_release, 2);
  assert.equal(provenance.integration_configuration_version, 1);
  assert.deepEqual(provenance.business_context, {
    common_business_context_version: 0,
    workspace_business_context_version: 1,
  });
  assert.equal(provenance.record_count, recordsOnSweep(1, business[2]!.workIndex));
  for (const field of ['acquired_at', 'integrated_at', 'released_at'] as const) {
    assert.ok(Number.isFinite(Date.parse(provenance[field])), `${field} is a governed instant`);
  }
  assert.ok(Date.parse(provenance.released_at) >= sweptAt, 'the Release was published after this sweep began');
  assert.deepEqual(complaintToday.window?.coverage, {
    start: '2026-10-18T12:26:00+08:00',
    end: '2026-11-02T12:26:00+08:00',
  }, 'coverage states the exact data every read can reach');

  // -------------------------------------------------------------------------
  // No evidence is explicit: a window nothing covers and a filter nothing
  // matches both answer with zero groups and identity-bearing totals, never a
  // fabricated value, while the provenance still says what was read.
  // -------------------------------------------------------------------------
  const noEvidence = aggregate(
    fixture,
    consumer,
    complaint.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['complaint_source'],
      metrics: ['complaint_registered', 'complaint_handled', 'complaint_backlog'],
      include_totals: true,
      window: {
        start: '2026-12-07T00:00:00.000+08:00',
        end: '2026-12-13T23:59:59.999+08:00',
        period: 'week',
      },
    },
    'complaint-no-evidence',
  );
  assert.deepEqual(noEvidence.groups, []);
  assert.equal(noEvidence.groups_total, 0);
  assert.deepEqual(noEvidence.totals, {
    metrics: { complaint_registered: 0, complaint_handled: 0, complaint_backlog: 0 },
  });
  assert.equal(noEvidence.window?.partial, true, 'a window the Release does not cover is partial');
  assert.equal(noEvidence.provenance.record_count, recordsOnSweep(1, business[2]!.workIndex), 'no evidence still names the Release it read');

  const unmatched = aggregate(
    fixture,
    consumer,
    refund.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['refund_route'],
      metrics: ['refund_count', 'refund_amount_total'],
      include_totals: true,
      filters: [{ field: 'refund_route', op: 'equals', value: 'Z 不存在' }],
    },
    'refund-unmatched',
  );
  assert.deepEqual(unmatched.groups, []);
  assert.deepEqual(unmatched.totals, {
    metrics: { refund_count: 0, refund_amount_total: '0.00' },
  });

  // -------------------------------------------------------------------------
  // Consumer authorization is enforced by the same read: a Grant narrows the
  // columns and rows, the hidden metric disappears from discovery and is
  // refused, and an untrusted request never widens the answer.
  // -------------------------------------------------------------------------
  const grant = command(
    fixture,
    [
      'grant', 'publish', '--product', refund.data_product_id,
      '--username', 'analyst@example.invalid',
      '--request', jsonFile(fixture, 'refund-grant', {
        columns: ['refund_no', 'updated_at', 'refunded_at', 'refunded_on', 'refund_route'],
        row_filters: [{ field: 'refund_route', op: 'equals', value: 'A 线上直退' }],
      }),
    ],
    { token: admin },
  );
  assert.equal(grant.status, 0, grant.stderr);

  const narrowedListing = command(fixture, ['product', 'list', '--workspace', workspaceId], { token: consumer });
  assert.equal(narrowedListing.status, 0, narrowedListing.stderr);
  const narrowedRefund = (narrowedListing.output['data_products'] as Array<Record<string, unknown>>)
    .find((product) => product['name'] === BMS_REFUND_CONTRACT.title)!;
  assert.deepEqual((narrowedRefund['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']), ['refund_count']);
  assert.equal((narrowedRefund['fields'] as string[]).includes('refund_amount'), false, 'a withheld column is absent, not empty');
  assert.deepEqual(narrowedRefund['dimensions'], ['refund_route', 'refunded_on']);

  const narrowedRead = aggregate(
    fixture,
    consumer,
    refund.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['refund_route'],
      include_totals: true,
      window: BMS_WEEK_CURRENT_WINDOW,
    },
    'refund-narrowed',
  );
  assert.deepEqual(groupsOf(narrowedRead).map((entry) => ({ refund_route: entry.group['refund_route'], ...entry.metrics })), [
    { refund_route: 'A 线上直退', refund_count: 7 },
  ], 'the Grant row filter narrows what the Consumer may count');
  assert.deepEqual(narrowedRead.totals?.metrics, { refund_count: 7 });

  const refusedMetric = command(
    fixture,
    [
      'product', 'query', '--product', refund.data_product_id,
      '--request', jsonFile(fixture, 'refund-hidden-metric', {
        kind: 'aggregate',
        metrics: ['refund_amount_total'],
        window: BMS_WEEK_CURRENT_WINDOW,
      }),
    ],
    { token: consumer },
  );
  assert.equal(refusedMetric.status, 2);
  assert.equal(refusedMetric.error['code'], 'DATA_PRODUCT_QUERY_REFUSED');
  assert.equal((refusedMetric.error['message'] as string).includes('refund_amount_total'), true);

  // The administrator is not narrowed by the Consumer's Grant: the governed
  // answer stays exactly what it was.
  const administratorRead = aggregate(
    fixture,
    admin,
    refund.data_product_id,
    {
      kind: 'aggregate',
      group_by: ['refund_route'],
      metrics: ['refund_count', 'refund_amount_total'],
      include_totals: true,
      window: BMS_WEEK_CURRENT_WINDOW,
    },
    'refund-administrator',
  );
  assert.deepEqual(administratorRead.totals?.metrics, BMS_REFUND_EXPECTED.week_current.totals);

  await server.close();
});

test('a Contract that contradicts the approved Metric Definitions is refused before it publishes', async () => {
  const server = await startHttpSource({ replies: bmsReplies(1) });
  const workload = configureBmsWorkload(server, { context: BMS_BUSINESS_CONTEXT });
  sweepBmsWorkload(workload);
  const { fixture, workspaceAdministratorToken: admin } = workload.workspace;
  const refunds = bmsSource(workload, '退款单');

  const base = BMS_REFUND_CONTRACT;
  const variants: Array<[string, Record<string, unknown>, string]> = [
    [
      'unit',
      {
        ...base,
        metrics: base.metrics.map((metric) => (metric.name === 'refund_count' ? { ...metric, unit: '元' } : metric)),
      },
      'DATA_PRODUCT_METRIC_DEFINITION_MISMATCH',
    ],
    [
      'aggregation',
      {
        ...base,
        metrics: base.metrics.map((metric) => (metric.name === 'refund_amount_total' ? { ...metric, aggregation: 'avg' } : metric)),
      },
      'DATA_PRODUCT_METRIC_DEFINITION_MISMATCH',
    ],
    [
      'undefined',
      {
        ...base,
        metrics: base.metrics.map((metric) => (metric.name === 'refund_count' ? { ...metric, definition: 'invented_count' } : metric)),
      },
      'DATA_PRODUCT_METRIC_DEFINITION_UNRESOLVED',
    ],
    [
      'zone',
      { ...base, time: { ...base.time, time_zone: 'UTC' } },
      'DATA_PRODUCT_TIME_ZONE_MISMATCH',
    ],
    [
      'zone-definition',
      { ...base, time: { ...base.time, definition: 'invented_zone' } },
      'DATA_PRODUCT_TIME_ZONE_UNRESOLVED',
    ],
  ];
  for (const [slug, contract, code] of variants) {
    const result = command(
      fixture,
      ['product', 'publish', '--source', refunds.sourceId, '--name', `BMS 四路退款-${slug}`, '--contract', jsonFile(fixture, `bad-contract-${slug}`, contract)],
      { token: admin },
    );
    assert.equal(result.status, 2, `${slug}: ${result.stderr}`);
    assert.equal(result.error['code'], code, `${slug} must be refused as ${code}`);
    assert.equal(result.stdout, '', 'a refused Contract publishes nothing');
  }

  // A Contract that binds no definition keeps the behaviour it always had, and
  // the three business Contracts still publish unchanged.
  const published = publish(fixture, admin, refunds.sourceId, BMS_REFUND_CONTRACT.title, BMS_REFUND_CONTRACT, 'refund-after-refusals');
  assert.equal(published.dataset_release, 1);

  await server.close();
});
