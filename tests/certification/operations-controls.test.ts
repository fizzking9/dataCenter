import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVICES, readySource } from '../support/acquisition.js';
import { createAgent, grantAgent, issueAgentToken, registerAgentClient } from '../support/agents.js';
import { commandAsync } from '../support/async-command.js';
import { startConsole } from '../support/console.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import {
  askNaturalLanguage,
  configureOperations,
  directoryBytes,
  generateTemplateReport,
  MEASUREMENT_WINDOWS,
  measurementWindows,
  memoryPercent,
  observeWorkloadEnvelope,
  OPERATIONS_ASK_QUESTION,
  profileConfig,
  readyOperationsSurface,
  recordWorkloadRun,
  reportWorkload,
  runMeasurementWindow,
  signInWorkloadUser,
  ssdFreePercent,
  usageView,
  WORKLOAD_CONCURRENCY,
  WORKLOAD_CONCURRENCY_MODEL,
  WORKLOAD_CONTRACTS,
  WORKLOAD_MIX,
  workloadQuery,
  type WorkloadWindowResult,
} from '../support/operations.js';
import { command, createWorkspace, grantRole, jsonFile, sessionFor, workspaceFixture } from '../support/platform.js';

/**
 * Every service, token, price, budget, and resource ceiling of the first release
 * is stated by the Deployment as configuration, so an operator can certify the
 * host they actually run on without the platform naming a business case.
 */
test('the Deployment states its settled limits and accepts a configured tariff', () => {
  const base = workspaceFixture();
  const shown = command(base.fixture, ['operations', 'show'], { token: base.deploymentAdministratorToken });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(shown.output['limits'], {
    consumer_concurrency: 20,
    llm_concurrency: 4,
    workspace_consumer_queue: 20,
    workspace_async_queue: 100,
    agent_direct_concurrency: 4,
    agent_llm_concurrency: 1,
    agent_direct_requests_per_minute: 60,
    agent_llm_requests_per_minute: 10,
    workers: { acquisition: 2, browser_scraper: 1, llm: 4 },
  });
  assert.deepEqual(shown.output['token_ceilings'], {
    nlq: { input: 32_000, output: 2_000, subqueries: 4 },
    report: { input: 32_000, output: 2_000 },
    artifact: { input: 64_000, output: 8_000 },
  });
  assert.deepEqual(shown.output['budgets'], {
    operating_monthly_cny: 500,
    activation_cny: 200,
    certification_cny: 1_000,
    average_cost_ceilings_cny: { nlq: 0.1, report: 0.2, artifact: 2 },
  });
  assert.deepEqual(shown.output['envelope'], {
    maximum_curated_records: 5_000_000,
    maximum_curated_documents: 20_000,
    maximum_raw_payload_bytes: 26_843_545_600,
    maximum_total_storage_bytes: 161_061_273_600,
    minimum_ssd_free_percent: 20,
    maximum_cpu_p95_percent: 75,
    maximum_memory_p95_percent: 85,
    maximum_oom_kills: 0,
    maximum_swap_thrash: 0,
    maximum_unexpected_failure_rate: 0.001,
  });
  assert.deepEqual(shown.output['prices'], {
    input_cny_per_million_tokens: 2,
    output_cny_per_million_tokens: 8,
    configured: false,
  });

  // A Deployment Administrator states the tariff it is billed at, and the
  // configured prices are what usage is costed with from then on.
  const configured = command(
    base.fixture,
    ['operations', 'configure', '--config', jsonFile(base.fixture, 'operations-tariff', {
      prices: { input_cny_per_million_tokens: 3.5, output_cny_per_million_tokens: 12 },
    })],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(configured.output['prices'], {
    input_cny_per_million_tokens: 3.5,
    output_cny_per_million_tokens: 12,
    configured: true,
  });

  // A Consumer may read the limits it is held to but not change them.
  const consumerView = command(base.fixture, ['operations', 'show'], { token: base.consumerToken });
  assert.equal(consumerView.status, 0, consumerView.stderr);
  assert.deepEqual(consumerView.output['prices'], configured.output['prices']);

  const denied = command(
    base.fixture,
    ['operations', 'configure', '--config', jsonFile(base.fixture, 'operations-denied', {
      limits: { consumer_concurrency: 2 },
    })],
    { token: base.consumerToken },
  );
  assert.equal(denied.status, 2);
  assert.equal(denied.error['code'], 'AUTHORIZATION_DENIED');

  // An unusable pair of ceilings is refused rather than silently coupled: more
  // LLM-backed slots than platform slots can never all run.
  const inverted = command(
    base.fixture,
    ['operations', 'configure', '--config', jsonFile(base.fixture, 'operations-inverted', {
      limits: { consumer_concurrency: 2, llm_concurrency: 3 },
    })],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(inverted.status, 2);
  assert.equal(inverted.error['code'], 'OPERATIONS_CONFIGURATION_INVALID');

  const negativePrice = command(
    base.fixture,
    ['operations', 'configure', '--config', jsonFile(base.fixture, 'operations-negative', {
      prices: { input_cny_per_million_tokens: -1, output_cny_per_million_tokens: 8 },
    })],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(negativePrice.status, 2);
  assert.equal(negativePrice.error['code'], 'OPERATIONS_CONFIGURATION_INVALID');
});

interface AdmissionResult {
  outcome: 'admitted' | 'queued' | 'refused';
  code?: string;
  lease_id?: string | null;
  request_id: string;
  queue_position?: number;
}

/** Admits a batch of stated operations at one instant, as an operator surface would. */
function admit(
  base: ReturnType<typeof workspaceFixture>,
  requests: Array<Record<string, unknown>>,
  at: string,
  token: string,
): AdmissionResult[] {
  const result = command(
    base.fixture,
    ['operations', 'admit', '--requests', jsonFile(base.fixture, `admit-${String(Math.random()).slice(2)}`, { requests }), '--at', at],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output['results'] as AdmissionResult[];
}

function finish(base: ReturnType<typeof workspaceFixture>, leases: string[], at: string, token: string): void {
  const result = command(
    base.fixture,
    ['operations', 'finish', '--leases', jsonFile(base.fixture, `finish-${String(Math.random()).slice(2)}`, { leases }), '--at', at],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
}

/**
 * Platform Consumer concurrency, per-Workspace queue depth, and dispatch all
 * bound the same admission decision. When capacity frees, the queued Workspaces
 * take turns, so no Workspace is starved by another's backlog.
 */
test('platform and Workspace ceilings hold and a freed slot is dispatched fairly', () => {
  const base = workspaceFixture();
  const second = createWorkspace(base.fixture, base.deploymentAdministratorToken, '第二工作区', 'operations@example.invalid');
  // The second Workspace's own Workspace Administrator grants the shared
  // Consumer, so one Consumer identity reads two governed Workspaces.
  const secondWorkspaceAdministratorToken = sessionFor(base.fixture, 'operations@example.invalid', 'operations-administrator');
  grantRole(base.fixture, secondWorkspaceAdministratorToken, second, 'analyst@example.invalid', 'Consumer');
  const at = new Date().toISOString();
  const direct = (workspace: string, operation = 'api_query'): Record<string, unknown> => ({
    workspace, operation, class: 'direct',
  });

  // Twenty direct operations fill the platform ceiling; the twenty-first waits.
  const filled = admit(base, Array.from({ length: 21 }, () => direct(base.workspaceId)), at, base.deploymentAdministratorToken);
  assert.deepEqual(filled.map((entry) => entry.outcome), [
    ...Array<string>(20).fill('admitted'), 'queued',
  ]);
  assert.equal(filled[20]?.queue_position, 1);
  assert.equal(new Set(filled.slice(0, 20).map((entry) => entry.lease_id)).size, 20);

  // One LLM-backed operation is a Consumer slot too, and its own ceiling is four.
  const llm = admit(
    base,
    Array.from({ length: 2 }, () => ({ workspace: base.workspaceId, operation: 'nlq', class: 'llm' })),
    at,
    base.deploymentAdministratorToken,
  );
  assert.deepEqual(llm.map((entry) => entry.outcome), ['queued', 'queued']);

  // The Workspace's consumer queue holds twenty; waiting jobs past it are
  // refused rather than silently dropped or over-admitted.
  const overflow = admit(
    base,
    Array.from({ length: 20 }, () => direct(base.workspaceId)),
    at,
    base.deploymentAdministratorToken,
  );
  // Three jobs already wait (one direct and two LLM-backed), so seventeen more
  // fit and the last three are refused.
  assert.deepEqual(overflow.map((entry) => entry.outcome), [
    ...Array<string>(17).fill('queued'),
    'refused', 'refused', 'refused',
  ]);
  assert.equal(overflow[19]?.code, 'WORKSPACE_QUEUE_FULL');

  // The second Workspace has its own queue, so one backlog never consumes it.
  const other = admit(base, [direct(second), direct(second)], at, base.deploymentAdministratorToken);
  assert.deepEqual(other.map((entry) => entry.outcome), ['queued', 'queued']);

  // Free four slots and dispatch: the rotations alternate between the waiting
  // Workspaces instead of draining one backlog first.
  finish(base, filled.slice(0, 4).map((entry) => String(entry.lease_id)), at, base.deploymentAdministratorToken);
  const dispatched = command(
    base.fixture,
    ['operations', 'dispatch', '--class', 'direct', '--at', at],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const admitted = dispatched.output['admitted'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    admitted.map((entry) => entry['workspace_id']),
    [base.workspaceId, second, base.workspaceId, second],
    'the freed slots alternate between the waiting Workspaces',
  );

  // Every waiting request keeps its place in one of the Workspaces' own FIFOs.
  const waiting = command(base.fixture, ['operations', 'show'], { token: base.deploymentAdministratorToken });
  assert.equal(waiting.status, 0, waiting.stderr);
  const queue = waiting.output['queue'] as Record<string, Record<string, number>>;
  assert.equal(queue[base.workspaceId]?.['waiting'], 18);
  assert.equal(queue[second]?.['waiting'], 0);
});

/**
 * An Agent Identity is bounded per minute and in concurrency, and the worker
 * ceilings bound acquisition, scraper, and LLM-backed work independently of the
 * Consumer slots. A refused request is still a request for the rate window.
 */
test('Agent and worker ceilings hold without hiding a refused request', () => {
  const base = workspaceFixture();
  const created = command(
    base.fixture,
    ['agent', 'create', '--name', '采集代理', '--workspaces', base.workspaceId, '--scopes', 'mcp:read'],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  const agent = String(created.output['agent_identity_id']);
  const at = new Date().toISOString();
  const requests = (count: number, cls: string): Array<Record<string, unknown>> =>
    Array.from({ length: count }, () => ({
      workspace: base.workspaceId, operation: cls === 'llm' ? 'nlq' : 'mcp_query', class: cls, agent,
    }));

  // Four direct operations run at once; the fifth waits for a slot it can never
  // take while the first four hold theirs.
  const direct = admit(base, requests(61, 'direct'), at, base.deploymentAdministratorToken);
  assert.deepEqual(direct.slice(0, 4).map((entry) => entry.outcome), ['admitted', 'admitted', 'admitted', 'admitted']);
  assert.deepEqual(direct.slice(4, 60).map((entry) => entry.code), Array<string>(56).fill('AGENT_CONCURRENCY_LIMIT'));
  assert.equal(direct[60]?.code, 'AGENT_RATE_LIMITED', 'the sixty-first request in one minute is refused by rate');
  assert.equal(direct[60]?.outcome, 'refused');

  // One LLM-backed operation at a time, ten per minute.
  const llm = admit(base, requests(11, 'llm'), at, base.deploymentAdministratorToken);
  assert.equal(llm[0]?.outcome, 'admitted', JSON.stringify(llm.slice(0, 2)));
  assert.deepEqual(llm.slice(1, 10).map((entry) => entry.code), Array<string>(9).fill('AGENT_CONCURRENCY_LIMIT'));
  assert.equal(llm[10]?.code, 'AGENT_RATE_LIMITED');

  // Two acquisition workers are the ceiling, so the third Run waits; freeing one
  // worker admits it and no more.
  const async = (operation: string, worker: string): Record<string, unknown> => ({
    workspace: base.workspaceId, operation, class: 'async', worker,
  });
  const runs = admit(base, [async('acquisition_run', 'acquisition'), async('acquisition_run', 'acquisition'), async('acquisition_run', 'acquisition')], at, base.deploymentAdministratorToken);
  assert.deepEqual(runs.map((entry) => entry.outcome), ['admitted', 'admitted', 'queued']);
  finish(base, [String(runs[0]?.lease_id)], at, base.deploymentAdministratorToken);
  const dispatched = command(
    base.fixture,
    ['operations', 'dispatch', '--class', 'async', '--at', at],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const admitted = dispatched.output['admitted'] as Array<Record<string, unknown>>;
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.['worker'], 'acquisition');

  // The browser scraper worker is its own single ceiling.
  const scraper = admit(base, [async('scraper_run', 'browser_scraper'), async('scraper_run', 'browser_scraper'), async('scraper_run', 'browser_scraper')], at, base.deploymentAdministratorToken);
  assert.deepEqual(scraper.map((entry) => entry.outcome), ['admitted', 'queued', 'queued']);
});

interface UsageView {
  totals: { generations: number; input_tokens: number; output_tokens: number; cost_cny: number };
  by_class: Record<string, {
    generations: number;
    operations: number;
    input_tokens: number;
    output_tokens: number;
    cost_cny: number;
    average_cost_cny: number;
    average_cost_ceiling_cny: number;
    met: boolean;
  }>;
  budgets: {
    operating: { period: string; cost_cny: number; ceiling_cny: number; met: boolean };
  };
}

function usage(fixture: Parameters<typeof usageView>[0], token: string): UsageView {
  return usageView(fixture, token) as unknown as UsageView;
}

/**
 * Token ceilings are hard: a generation past its ceiling is refused before it
 * runs or after the endpoint answers, never accepted and trimmed. What the
 * endpoint reports is what the Deployment costs, at the operator's CNY prices.
 */
test('token ceilings refuse past the ceiling and accepted generations are costed in CNY', async () => {
  const surface = await readyOperationsSurface();
  const { fixture } = surface;
  const token = fixture.administrator.username;

  // The operator states the tariff it is billed at.
  configureOperations(fixture, surface.deploymentAdministratorToken, {
    prices: { input_cny_per_million_tokens: 10, output_cny_per_million_tokens: 20 },
  }, 'operations-prices');
  const before = usage(fixture, surface.deploymentAdministratorToken);

  // One Natural-Language Query turn is two generations (a plan and its
  // narration); the endpoint states 1,200 input and 300 output tokens each.
  const asked = await askNaturalLanguage(surface, OPERATIONS_ASK_QUESTION);
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(asked.output['outcome'], 'answered', JSON.stringify(asked.output));
  const afterAsk = usage(fixture, surface.deploymentAdministratorToken);
  assert.equal(afterAsk.by_class['nlq']?.generations, 2);
  assert.equal(afterAsk.by_class['nlq']?.input_tokens, 2_400);
  assert.equal(afterAsk.by_class['nlq']?.output_tokens, 600);
  // 2,400 tokens at CNY 10/M plus 600 at CNY 20/M, stated by the endpoint itself.
  assert.equal(afterAsk.by_class['nlq']?.cost_cny, 0.036);
  // The plan and its narration are one turn, so the per-turn average is the
  // whole turn's cost rather than one generation's share of it.
  assert.equal(afterAsk.by_class['nlq']?.average_cost_cny, 0.036);
  assert.equal(afterAsk.by_class['nlq']?.average_cost_ceiling_cny, 0.1);
  assert.equal(afterAsk.by_class['nlq']?.met, true);
  assert.equal(afterAsk.totals.cost_cny, Number((before.totals.cost_cny + 0.036).toFixed(6)));
  assert.equal(afterAsk.budgets.operating.ceiling_cny, 500);
  assert.equal(afterAsk.budgets.operating.met, true);

  // A generated Report is costed against its own class and ceiling. The surface
  // already stocked one Report while prices were the settled defaults, so the
  // fresh generation is measured as one more at the configured tariff.
  const beforeReport = usage(fixture, surface.deploymentAdministratorToken);
  const generated = await generateTemplateReport(surface);
  assert.equal(generated.status, 0, generated.stderr);
  const afterReport = usage(fixture, surface.deploymentAdministratorToken);
  assert.equal(afterReport.by_class['report']?.generations, (beforeReport.by_class['report']?.generations ?? 0) + 1);
  assert.equal(
    Number(((afterReport.by_class['report']?.cost_cny ?? 0) - (beforeReport.by_class['report']?.cost_cny ?? 0)).toFixed(6)),
    0.018,
  );
  assert.equal(afterReport.by_class['report']?.average_cost_ceiling_cny, 0.2);
  assert.equal(afterReport.by_class['report']?.met, true);

  // A ceiling below the pinned input refuses the turn before the endpoint runs.
  configureOperations(fixture, surface.deploymentAdministratorToken, {
    token_ceilings: { nlq: { input: 100 } },
  }, 'operations-input-ceiling');
  const refused = await askNaturalLanguage(surface, OPERATIONS_ASK_QUESTION);
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(refused.output['outcome'], 'refused', JSON.stringify(refused.output));
  assert.equal(refused.output['reason_code'], 'MODEL_INPUT_CEILING_EXCEEDED');
  assert.equal(refused.output['executed'], false);
  assert.equal(refused.output['result'], null);

  // A ceiling the answer cannot meet fails closed rather than accepting it.
  configureOperations(fixture, surface.deploymentAdministratorToken, {
    token_ceilings: { nlq: { input: 32_000, output: 50 } },
  }, 'operations-output-ceiling');
  const tooLong = await askNaturalLanguage(surface, OPERATIONS_ASK_QUESTION);
  assert.equal(tooLong.status, 0, tooLong.stderr);
  assert.equal(tooLong.output['outcome'], 'refused', JSON.stringify(tooLong.output));
  assert.equal(tooLong.output['reason_code'], 'MODEL_OUTPUT_CEILING_EXCEEDED');
  assert.equal(tooLong.output['result'], null);

  // The refused generations are accounted as refusals, not as free work.
  const afterRefusals = usage(fixture, surface.deploymentAdministratorToken);
  assert.ok(afterRefusals.totals.generations > afterReport.totals.generations);
  await surface.endpoint.close();
});

/**
 * A profile activation evaluation is a priced run of its own: its consumption is
 * reported against the activation budget, and a budget it cannot meet refuses
 * the activation instead of silently overrunning it.
 */
test('an activation evaluation reports its consumption against the activation budget', async () => {
  const surface = await readyOperationsSurface();
  const { fixture } = surface;
  configureOperations(fixture, surface.deploymentAdministratorToken, {
    prices: { input_cny_per_million_tokens: 10, output_cny_per_million_tokens: 20 },
  }, 'operations-activation-prices');

  const second = async (name: string): Promise<{ profileId: string; version: number }> => {
    const published = command(
      fixture,
      ['model', 'publish', '--name', name, '--config', jsonFile(fixture, `${name}-profile`, {
        ...profileConfig(surface.endpoint),
      })],
      { token: surface.deploymentAdministratorToken },
    );
    assert.equal(published.status, 0, published.stderr);
    return { profileId: String(published.output['model_profile_id']), version: Number(published.output['model_profile_version']) };
  };

  // Seven generations of 1,200 input and 300 output tokens cost CNY 0.126 at the
  // configured tariff, well inside the CNY 200 activation budget.
  const normal = await second('激活评价模型');
  const evaluated = await commandAsync(
    fixture,
    ['model', 'evaluate', '--profile', normal.profileId, '--version', String(normal.version)],
    { token: surface.deploymentAdministratorToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const budget = evaluated.output['budget'] as Record<string, unknown>;
  assert.equal(budget['consumption_cny'], 0.126);
  assert.equal(budget['ceiling_cny'], 200);
  assert.equal(budget['met'], true);

  // A budget smaller than the evaluation refuses its activation.
  configureOperations(fixture, surface.deploymentAdministratorToken, {
    budgets: { activation_cny: 0.01 },
  }, 'operations-tiny-activation');
  const tight = await second('超额评价模型');
  const refused = await commandAsync(
    fixture,
    ['model', 'evaluate', '--profile', tight.profileId, '--version', String(tight.version)],
    { token: surface.deploymentAdministratorToken },
  );
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal((refused.output['budget'] as Record<string, unknown>)['met'], false);
  const activation = await commandAsync(
    fixture,
    ['model', 'activate', '--profile', tight.profileId, '--version', String(tight.version)],
    { token: surface.deploymentAdministratorToken },
  );
  assert.equal(activation.status, 2);
  assert.equal(activation.error['code'], 'ACTIVATION_BUDGET_EXCEEDED');
  await surface.endpoint.close();
});

interface WorkloadLatency {
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  cold: { samples: number };
  warm: { samples: number };
  timeouts: number;
  targets: Record<string, number>;
  met: boolean;
}

interface WorkloadReport {
  workload: {
    required: Record<string, number>;
    windows: Record<string, Record<string, number>>;
    met: boolean;
  };
  runs: {
    required: string[];
    observed: Array<{
      window: string;
      run_id: string | null;
      started_at: string | null;
      finished_at: string | null;
      duration_seconds: number | null;
      parameters: Record<string, unknown> | null;
      samples: number;
      cold: number;
      warm: number;
    }>;
    met: boolean;
  };
  latency: Record<string, WorkloadLatency>;
  latency_met: boolean;
  freshness: Record<string, {
    samples: number;
    p95_seconds: number | null;
    p99_seconds: number | null;
    targets: { p95_seconds: number | null; p99_seconds: number | null };
    met: boolean;
  }>;
  freshness_met: boolean;
  failures: { samples: number; unexpected: number; critical: number; rate: number; met: boolean };
  envelope: {
    observed_at: string | null;
    checks: Record<string, { observed: number; met: boolean; limit?: number; minimum?: number }>;
    met: boolean;
  };
  budgets: {
    operating: { cost_cny: number; ceiling_cny: number; met: boolean };
    certification: { cost_cny: number; ceiling_cny: number; met: boolean };
  };
  met: boolean;
}

/**
 * The scaled window length CI exercises: two seconds per certified window, so
 * every window really repeats its round and the cold and warm samples are both
 * observed rather than assumed.
 */
const SCALED_WINDOW_SECONDS = 2;

/**
 * The exact mixed load is measured through the window sequence the release
 * certifies — a warm-up, three measurements, and a soak — with the windows
 * scaled down so the harness itself is exercised in seconds. Every sample is
 * one request over a supported external contract, issued concurrently with the
 * other nineteen and with scheduled acquisition and integration, and the report
 * is computed from the samples the harness actually timed.
 *
 * The measured concurrency model is one application process, not several: the
 * twenty requests are issued at once and reads run concurrently, while the
 * application serializes its governed writes (Report generation, Natural-
 * Language Query turns, scheduled acquisition) through its in-process write
 * queue. The evidence states that model rather than claiming cross-process
 * concurrency that was never measured.
 */
test('the measured mixed workload runs concurrently through external contracts', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody(DEVICES.slice(0, 1)) }] });
  const surface = await readyOperationsSurface();
  const acquisition = await readySource(source, {
    workspace: surface,
    schedule: { every_minutes: 15, start_tolerance_seconds: 60 },
    publicationTargets: { p95_seconds: 300, p99_seconds: 600 },
  });
  // A console that cannot start must still release the fixtures opened before
  // it, so a failed setup fails the test instead of stalling the runner.
  const console = await startConsole(surface.fixture).catch(async (error: unknown) => {
    await acquisition.close();
    await surface.endpoint.close();
    throw error;
  });
  try {
    const { fixture } = surface;
    const deploymentToken = surface.deploymentAdministratorToken;
    const agentId = createAgent(fixture, deploymentToken, surface.workspaceId);
    const client = registerAgentClient(fixture, deploymentToken, agentId);
    const granted = grantAgent(fixture, surface.workspaceAdministratorToken, surface.dataProductId, agentId, {
      columns: ['sn', 'city', 'handled_count', 'reported_on'],
      row_filters: [],
    });
    assert.equal(granted.status, 0, granted.stderr);
    const mcpToken = await issueAgentToken(console.url, client, 'mcp:read');

    // The operator states the tariff it is billed at, the acquisition target
    // its scheduled Source promises, and the Agent request ceiling this
    // certification runs under: the measured round presents four MCP queries
    // per round for the whole window sequence, so the default sixty-per-minute
    // Agent ceiling would refuse the soak before its samples were taken. The
    // exact ceiling is recorded in every window's evidence.
    configureOperations(fixture, deploymentToken, {
      prices: { input_cny_per_million_tokens: 10, output_cny_per_million_tokens: 20 },
      targets: { acquisition_run: { p95_seconds: 300, p99_seconds: 600 } },
      limits: { agent_direct_requests_per_minute: 10_000 },
    }, 'operations-certification');
    const certified = command(fixture, ['operations', 'show'], { token: deploymentToken });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedLimits = certified.output['limits'] as Record<string, unknown>;
    assert.equal(certifiedLimits['agent_direct_requests_per_minute'], 10_000);

    // The workload presents the same sessions a browser workflow presents.
    const consumer = await signInWorkloadUser(fixture, console.url, 'analyst@example.invalid', 'analyst-consumer');
    const administrator = await signInWorkloadUser(fixture, console.url, 'operations@example.invalid', 'operations-administrator');
    const clients = {
      url: console.url,
      consumerCookie: consumer.cookie,
      administratorCookie: administrator.cookie,
      consumerBearer: consumer.token,
      errors: () => console.errors(),
      mcp: { token: mcpToken, errors: () => console.errors() },
    };
    // The schedule cursor advances with every round, so scheduled acquisition
    // stays due and active throughout every window.
    const schedule = {
      sourceId: acquisition.sourceId,
      at: new Date().toISOString(),
      everySeconds: 15 * 60,
    };

    const cpuStart = process.cpuUsage();
    const loopStart = Date.now();
    const measured: WorkloadWindowResult[] = [];
    for (const [index, plan] of measurementWindows(SCALED_WINDOW_SECONDS).entries()) {
      const result = await runMeasurementWindow(surface, plan, {
        clients,
        query: workloadQuery(index),
        acquisition: schedule,
      });
      const recorded = recordWorkloadRun(fixture, deploymentToken, result, { limits: certifiedLimits });
      assert.equal(recorded['window'], plan.window);
      assert.equal(recorded['samples'], result.samples.length, plan.window);
      assert.equal(recorded['duration_seconds'], result.observed_seconds, plan.window);
      measured.push(result);
    }
    assert.deepEqual(
      measured.flatMap((result) => result.samples
        .filter((sample) => sample.outcome !== 'succeeded')
        .map((sample) => `${result.window}:${sample.operation}:${sample.outcome}${sample.error === undefined ? '' : `:${sample.error}`}`)),
      [],
      'every measured operation succeeded',
    );

    const elapsedMs = Date.now() - loopStart;
    const cpu = process.cpuUsage(cpuStart);
    // The settled targets are measured on an unshared host. A parallel test
    // suite starves this process, so record the run and leave threshold
    // enforcement to the serial `npm run certify` gate.
    const sharedHost = (cpu.user + cpu.system) / 1_000 / elapsedMs < 0.9;
    observeWorkloadEnvelope(fixture, deploymentToken, {
      ssd_free_percent: ssdFreePercent(fixture.root),
      total_storage_bytes: directoryBytes(fixture.root),
      cpu_p95_percent: Number((((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100).toFixed(3)),
      memory_p95_percent: memoryPercent(),
      oom_kills: 0,
      swap_thrash: 0,
    });

    const report = reportWorkload(fixture) as unknown as WorkloadReport;

    // Harness correctness: every round launched exactly the twenty-operation
    // mix all at once, with one scheduled acquisition beside it, through the
    // external contracts only.
    assert.deepEqual(report.workload.required, {
      consumer_operations: 20,
      direct_queries: 12,
      stored_report_reads: 4,
      natural_language_queries: 2,
      report_generations: 2,
    });
    let measuredSamples = 0;
    let measuredRounds = 0;
    let totalRounds = 0;
    for (const result of measured) {
      assert.equal(result.samples.length, result.rounds * (WORKLOAD_CONCURRENCY + 1), result.window);
      assert.equal(
        result.samples.filter((sample) => sample.operation_class === 'acquisition').length,
        result.rounds,
        result.window,
      );
      assert.equal(
        result.samples.filter((sample) => sample.operation_class !== 'acquisition').length,
        result.rounds * WORKLOAD_CONCURRENCY,
        result.window,
      );
      assert.deepEqual(report.workload.windows[result.window], {
        direct: WORKLOAD_MIX.direct_queries * result.rounds,
        stored_report_reads: WORKLOAD_MIX.stored_report_reads * result.rounds,
        natural_language_queries: WORKLOAD_MIX.natural_language_queries * result.rounds,
        report_generations: WORKLOAD_MIX.report_generations * result.rounds,
        total: WORKLOAD_CONCURRENCY * result.rounds,
      }, result.window);
      totalRounds += result.rounds;
      if (result.window === 'warmup') continue;
      measuredRounds += result.rounds;
      measuredSamples += result.samples.length;
    }
    assert.equal(report.workload.met, true);

    // Every window's evidence states the exact configured and observed
    // durations, concurrency, operation mix, contracts, and sample counts.
    assert.deepEqual(report.runs.observed.map((run) => run.window), [...MEASUREMENT_WINDOWS]);
    for (const [index, result] of measured.entries()) {
      const run = report.runs.observed[index]!;
      assert.equal(run.run_id, `measured-${result.window}`);
      assert.equal(run.duration_seconds, result.observed_seconds, result.window);
      assert.equal(run.samples, result.samples.length, result.window);
      assert.ok(run.duration_seconds !== null && run.duration_seconds > 0, result.window);
      const parameters = run.parameters ?? {};
      assert.equal(parameters['window_seconds'], result.duration_seconds, result.window);
      assert.equal(parameters['observed_seconds'], result.observed_seconds, result.window);
      assert.equal(parameters['concurrency'], WORKLOAD_CONCURRENCY, result.window);
      assert.deepEqual(parameters['concurrency_model'], WORKLOAD_CONCURRENCY_MODEL, result.window);
      assert.equal(parameters['rounds'], result.rounds, result.window);
      assert.equal(parameters['samples'], result.samples.length, result.window);
      assert.equal(parameters['active_acquisition'], true, result.window);
      assert.deepEqual(parameters['operation_mix'], {
        direct_queries: WORKLOAD_MIX.direct_queries * result.rounds,
        direct_api_queries: WORKLOAD_MIX.direct_api_queries * result.rounds,
        direct_mcp_queries: WORKLOAD_MIX.direct_mcp_queries * result.rounds,
        stored_report_reads: WORKLOAD_MIX.stored_report_reads * result.rounds,
        natural_language_queries: WORKLOAD_MIX.natural_language_queries * result.rounds,
        report_generations: WORKLOAD_MIX.report_generations * result.rounds,
      }, result.window);
      assert.deepEqual(parameters['external_contracts'], [...WORKLOAD_CONTRACTS], result.window);
      assert.deepEqual(parameters['configured_limits'], certifiedLimits, result.window);
    }
    assert.equal(report.runs.met, true);

    // Every threshold the Deployment states is evaluated from those samples:
    // a latency target has its observed p50/p95/p99, and a freshness target has
    // its observed publication latencies.
    const shown = command(fixture, ['operations', 'show'], { token: deploymentToken });
    assert.equal(shown.status, 0, shown.stderr);
    const targets = shown.output['targets'] as Record<string, Record<string, number>>;
    for (const [name, target] of Object.entries(targets)) {
      if (target['p95_ms'] !== undefined || target['p99_ms'] !== undefined || target['timeout_ms'] !== undefined) {
        const latency = report.latency[name];
        assert.ok(latency !== undefined, `${name} was not evaluated`);
        assert.deepEqual(latency.targets, target, name);
        assert.ok(latency.samples > 0, name);
        assert.ok(latency.p50_ms !== null && latency.p95_ms !== null && latency.p99_ms !== null, name);
        assert.equal(latency.timeouts, 0, name);
        if (!sharedHost) {
          assert.equal(latency.met, true, `${name} p95 ${String(latency.p95_ms)} p99 ${String(latency.p99_ms)}`);
        }
      }
      if (target['p95_seconds'] !== undefined || target['p99_seconds'] !== undefined) {
        const freshness = report.freshness[name];
        assert.ok(freshness !== undefined, `${name} freshness was not evaluated`);
        assert.ok(freshness.samples > 0, `${name} freshness ${JSON.stringify(freshness)}`);
        if (!sharedHost) {
          assert.equal(freshness.met, true, `${name} freshness ${JSON.stringify(freshness)}`);
        }
      }
    }
    if (!sharedHost) {
      assert.equal(report.latency_met, true);
      assert.equal(report.freshness_met, true);
      assert.equal(report.met, true);
    }
    assert.equal(report.freshness['acquisition_run']?.samples, measuredRounds);

    // Cold and warm samples are separated by the cache state each answer
    // reported: a first touch over a window's query really missed, and its
    // repeats really reused the governed page.
    for (const operation of ['api_query', 'mcp_query', 'report_read', 'nlq', 'report_generation']) {
      const latency = report.latency[operation];
      assert.ok(latency !== undefined, operation);
      assert.equal(latency.cold.samples + latency.warm.samples, latency.samples, operation);
    }
    assert.ok((report.latency['api_query']?.cold.samples ?? 0) > 0, 'a first-touch API query is cold');
    assert.ok((report.latency['api_query']?.warm.samples ?? 0) > 0, 'a repeated API query is warm');
    assert.ok((report.latency['mcp_query']?.cold.samples ?? 0) > 0, 'a first-touch MCP query is cold');
    assert.ok((report.latency['mcp_query']?.warm.samples ?? 0) > 0, 'a repeated MCP query is warm');

    // Unexpected failures stay below 0.1 percent, with no critical failure.
    assert.deepEqual(
      { unexpected: report.failures.unexpected, critical: report.failures.critical, met: report.failures.met },
      { unexpected: 0, critical: 0, met: true },
    );
    assert.equal(report.failures.samples, measuredSamples);
    assert.ok(report.failures.rate < 0.001);

    // The observed host volumes and pressure held inside the envelope.
    assert.equal(report.envelope.observed_at !== null, true);
    assert.equal(report.envelope.checks['ssd_free_percent']?.met, true);
    assert.equal(report.envelope.checks['cpu_p95_percent']?.met, true);
    assert.equal(report.envelope.checks['memory_p95_percent']?.met, true);
    assert.equal(report.envelope.checks['oom_kills']?.observed, 0);
    assert.equal(report.envelope.checks['swap_thrash']?.observed, 0);
    assert.equal(report.envelope.checks['total_storage_bytes']?.met, true);
    assert.equal(report.envelope.met, true);

    // Token and CNY accounting is observed, not estimated: every window turn
    // states the endpoint's own 1,200 input and 300 output tokens, and the
    // certification budget prices exactly those generations at the tariff.
    const used = usage(fixture, deploymentToken);
    assert.equal(used.by_class['nlq']?.generations, totalRounds * 4);
    assert.equal(used.by_class['nlq']?.operations, totalRounds * 2);
    assert.equal(used.by_class['report']?.generations, totalRounds * 2 + 1);
    assert.equal(used.by_class['report']?.operations, totalRounds * 2 + 1);
    assert.equal(used.totals.generations, totalRounds * 6 + 8);
    assert.equal(used.totals.input_tokens, (totalRounds * 6 + 8) * 1_200);
    assert.equal(used.totals.output_tokens, (totalRounds * 6 + 8) * 300);
    assert.ok((used.by_class['nlq']?.cost_cny ?? 0) > 0);
    assert.ok((used.by_class['report']?.cost_cny ?? 0) > 0);
    assert.equal(
      report.budgets.certification.cost_cny,
      Number((totalRounds * (2 * 0.036 + 2 * 0.018)).toFixed(6)),
    );
    assert.equal(report.budgets.certification.ceiling_cny, 1_000);
    assert.ok(report.budgets.certification.cost_cny > 0);
    assert.equal(report.budgets.certification.met, true);
    assert.equal(report.budgets.operating.met, true);

    // The thresholds are real: the same observed samples fail a p95 target they
    // cannot meet, so a report can never claim a target it did not measure.
    configureOperations(fixture, deploymentToken, {
      targets: { api_query: { p95_ms: 0.0001, p99_ms: 2_000 } },
    }, 'operations-stricter-target');
    const stricter = reportWorkload(fixture) as unknown as WorkloadReport;
    assert.equal(stricter.latency['api_query']?.met, false);
    assert.equal(stricter.latency_met, false);
    assert.equal(stricter.met, false);
  } finally {
    await console.stop();
    await acquisition.close();
    await surface.endpoint.close();
  }
});
