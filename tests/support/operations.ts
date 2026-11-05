import assert from 'node:assert/strict';
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { commandAsync, type CommandResult } from './async-command.js';
import { callApi } from './console.js';
import { EXTENDED_LEDGER_CONTRACT, publishLedgerProduct } from './data-product.js';
import { callTool, mcpResult } from './mcp.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from './model-endpoint.js';
import { command, jsonFile, totpSecretFor, type PlatformFixture, type WorkspaceFixture } from './platform.js';
import { totpCode } from './totp.js';

/** The purposes, data categories, and Chinese prompts the certification model pins. */
export const OPERATIONS_PURPOSES = ['query_plan', 'grounded_narration', 'clarification'];
export const OPERATIONS_DATA_CATEGORIES = ['product_contract', 'sample_records'];
export const OPERATIONS_PROMPTS = {
  query_plan: '你是数据产品查询规划器，只输出简体中文解释，并且只使用受治理契约发布的字段、维度、指标和算子。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据或因果。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};
export const GROUNDED_ANSWER_PROMPT = '只依据给定证据用简体中文撰写报告叙述，不得推测证据之外的数据或因果。';
export const OPERATIONS_QUESTION = '2026-01-05 至 2026-01-20 的处理量合计是多少？';
/**
 * A question the published Template does not answer word for word, so the turn
 * plans and narrates instead of reusing the stocked Report.
 */
export const OPERATIONS_ASK_QUESTION = '2026-01-05 至 2026-01-20 杭州的处理量合计是多少？';

export interface OperationsSurface extends WorkspaceFixture {
  dataProductId: string;
  templateId: string;
  reportId: string;
  endpoint: MockModelEndpoint;
  bindingId: string;
}

export function profileConfig(endpoint: MockModelEndpoint): Record<string, unknown> {
  return {
    adapter: 'generic_local',
    endpoint_url: endpoint.url,
    model_id: MOCK_MODEL_ID,
    purposes: [...OPERATIONS_PURPOSES],
    data_categories: [...OPERATIONS_DATA_CATEGORIES],
    tools: [],
    max_output_bytes: 65_536,
    prompts: { ...OPERATIONS_PROMPTS },
  };
}

export function templateConfig(): Record<string, unknown> {
  return {
    question: OPERATIONS_QUESTION,
    parameters: [
      { name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-20' } },
    ],
    query: {
      kind: 'aggregate',
      metrics: ['handled_total'],
      window: { start: '2026-01-05', end: '2026-01-20' },
      include_totals: true,
      limit: 100,
    },
    grounded_prompt: GROUNDED_ANSWER_PROMPT,
    freshness: { max_age_minutes: 15 },
  };
}

/** Commands governed configuration to the Deployment's stated ceilings. */
export function configureOperations(
  fixture: PlatformFixture,
  token: string,
  config: Record<string, unknown>,
  name = 'operations-config',
): Record<string, unknown> {
  const result = command(
    fixture,
    ['operations', 'configure', '--config', jsonFile(fixture, name, config)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/**
 * One Workspace with a published ledger, one activated Model Profile bound for
 * planning, narration, and clarification, one published Report Template, and one
 * stocked Report — the shape a Consumer operation of every class reads.
 */
export async function readyOperationsSurface(): Promise<OperationsSurface> {
  const base = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  const endpoint = await startMockModelEndpoint();
  const published = command(
    base.fixture,
    ['model', 'publish', '--name', '运营模型', '--config', jsonFile(base.fixture, 'operations-profile', profileConfig(endpoint))],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const profileId = String(published.output['model_profile_id']);
  const version = Number(published.output['model_profile_version']);
  const evaluated = await commandAsync(
    base.fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(
    base.fixture,
    ['model', 'activate', '--profile', profileId, '--version', String(version)],
    { token: base.deploymentAdministratorToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    base.fixture,
    [
      'binding', 'publish',
      '--workspace', base.workspaceId,
      '--profile', profileId,
      '--config', jsonFile(base.fixture, 'operations-binding', {
        model_profile_version: version,
        purposes: [...OPERATIONS_PURPOSES],
        data_categories: [...OPERATIONS_DATA_CATEGORIES],
      }),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const template = command(
    base.fixture,
    [
      'report', 'template-publish',
      '--workspace', base.workspaceId,
      '--product', base.dataProductId,
      '--name', '日处理量报告',
      '--config', jsonFile(base.fixture, 'operations-template', templateConfig()),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(template.status, 0, template.stderr);
  const templateId = String(template.output['report_template_id']);
  const generated = await commandAsync(
    base.fixture,
    ['report', 'generate', '--template', templateId],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const report = generated.output['report'] as Record<string, unknown>;
  return {
    ...base,
    templateId,
    reportId: String(report['report_id']),
    endpoint,
    bindingId: String(bound.output['binding_id']),
  };
}

/** One Natural-Language Query turn, as a Consumer would run it. */
export function askNaturalLanguage(
  surface: OperationsSurface,
  question: string,
  extra: string[] = [],
): Promise<CommandResult> {
  return commandAsync(
    surface.fixture,
    ['product', 'ask', '--product', surface.dataProductId, '--question', question, ...extra],
    { token: surface.consumerToken },
  );
}

/** One generated Report from the published Template, as its administrator runs it. */
export function generateTemplateReport(surface: OperationsSurface): Promise<CommandResult> {
  return commandAsync(
    surface.fixture,
    ['report', 'generate', '--template', surface.templateId],
    { token: surface.workspaceAdministratorToken },
  );
}

/** One stored Report read, as a Consumer arms the workload with. */
export function readStoredReport(surface: OperationsSurface): Promise<CommandResult> {
  return commandAsync(
    surface.fixture,
    ['report', 'show', '--report', surface.reportId],
    { token: surface.consumerToken },
  );
}

/** The Deployment's usage and budget picture, as the operator surface states it. */
export function usageView(fixture: PlatformFixture, token: string): Record<string, unknown> {
  const result = command(fixture, ['operations', 'usage'], { token });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/** One operation the workload harness really ran and really timed. */
export interface WorkloadSample {
  operation: string;
  operation_class: string;
  cache: 'cold' | 'warm';
  elapsed_ms: number;
  outcome: string;
  freshness_seconds?: number | null;
  /** The Run the sample measured, so its publication latency can be read later. */
  run_id?: string;
  /** The structured refusal when the operation failed, for harness diagnosis. */
  error?: string;
}

/**
 * The exact mixed load section 15 certifies: twenty concurrent Consumer
 * operations made of twelve direct API/MCP queries, four stored Report reads,
 * two generated Natural-Language Queries, and two Report generations.
 */
export const WORKLOAD_CONCURRENCY = 20;
export const WORKLOAD_MIX = {
  direct_queries: 12,
  direct_api_queries: 8,
  direct_mcp_queries: 4,
  stored_report_reads: 4,
  natural_language_queries: 2,
  report_generations: 2,
} as const;

/** The external contracts the workload drives; no private function is timed. */
export const WORKLOAD_CONTRACTS = [
  'data_product_http_api',
  'mcp_query_data_product',
  'report_read_api',
  'natural_language_query_api',
  'report_generation_api',
  'acquisition_schedule_api',
  'acquisition_work_api',
] as const;

/**
 * The concurrency model the evidence states honestly. Every round is twenty
 * Consumer operations issued at once against one application process, beside
 * one scheduled acquisition. The application answers reads concurrently; its
 * governed writes — Report generations, Natural-Language Query turns (an
 * answered turn records a Report Review Candidate), and scheduled acquisition
 * — are serialized by an in-process write queue, so each measured duration
 * includes the queueing it really waited through. No cross-process concurrency
 * is claimed or measured.
 */
export const WORKLOAD_CONCURRENCY_MODEL = {
  application_processes: 1,
  consumer_requests_per_round: WORKLOAD_CONCURRENCY,
  request_issue: 'all twenty Consumer operations issued at once over external contracts',
  reads: 'concurrent',
  writes: 'governed writes serialized by the application\'s in-process write queue; measured durations include queueing',
} as const;

/** The MCP credential and error surface the workload calls beside the HTTP API. */
export interface WorkloadMcp {
  token: string;
  /** States whatever the MCP server last reported when a call cannot connect. */
  errors?: () => string;
}

/** The externally reachable sessions one workload round presents. */
export interface WorkloadClients {
  /** The application serving the published API, the browser API, and MCP. */
  url: string;
  /** The Consumer's authenticated browser session, as `/api/session` issued it. */
  consumerCookie: string;
  /** The Workspace Administrator's session, for Report generation. */
  administratorCookie: string;
  /** The Bearer credential the published Data Product API path accepts. */
  consumerBearer: string;
  /** Whatever the application last reported when a call cannot connect. */
  errors?: () => string;
  /** The Agent Identity's MCP credential, when MCP is part of the mix. */
  mcp?: WorkloadMcp;
}

/** One scheduled acquisition the harness keeps active beside the Consumer load. */
export interface WorkloadAcquisition {
  sourceId: string;
  /** The instant the next scheduled tick runs at, advanced one interval per round. */
  at: string;
  /** The Source's schedule cadence, so every round's tick is a due Run. */
  everySeconds: number;
}

/** The single-question aggregate each direct query asks, varied per window. */
export interface WorkloadQuery {
  kind: 'aggregate';
  metrics: string[];
  window: { start: string; end: string };
  include_totals: boolean;
  limit: number;
}

/**
 * The aggregate a window's direct operations ask. Each window shifts the end of
 * the measured period, so the governed page cache really misses on first touch
 * and the reported cold and warm samples are observed rather than assumed.
 */
export function workloadQuery(variant = 0): WorkloadQuery {
  const day = 20 - Math.abs(variant) % 5;
  return {
    kind: 'aggregate',
    metrics: ['handled_total'],
    window: { start: '2026-01-05', end: `2026-01-${String(day).padStart(2, '0')}` },
    include_totals: true,
    limit: 100,
  };
}

/** The measurement windows section 15 certifies, in the order it certifies them. */
export const MEASUREMENT_WINDOWS = ['warmup', 'run_1', 'run_2', 'run_3', 'soak'] as const;
export type MeasurementWindow = typeof MEASUREMENT_WINDOWS[number];

/** The settled durations: a 15-minute warm-up, three two-hour runs, a 24-hour soak. */
export const CERTIFICATION_WINDOW_SECONDS: Record<MeasurementWindow, number> = {
  warmup: 15 * 60,
  run_1: 2 * 60 * 60,
  run_2: 2 * 60 * 60,
  run_3: 2 * 60 * 60,
  soak: 24 * 60 * 60,
};

export interface MeasurementWindowPlan {
  window: MeasurementWindow;
  /** The exact window length this run is configured for, scaled in CI. */
  duration_seconds: number;
}

/**
 * The window sequence with the exact durations it will be measured over. CI
 * passes a scaled duration, so the harness itself is exercised in seconds; a
 * certification run passes no scale and measures the settled durations.
 */
export function measurementWindows(scaledSeconds?: number): MeasurementWindowPlan[] {
  return MEASUREMENT_WINDOWS.map((window) => ({
    window,
    duration_seconds: scaledSeconds ?? CERTIFICATION_WINDOW_SECONDS[window],
  }));
}

/** One signed-in User's browser session and the same session's Bearer token. */
export interface WorkloadSession {
  cookie: string;
  token: string;
}

/**
 * Signs one User in through the browser application's own session contract, so
 * the workload presents the same credential a browser workflow presents.
 */
export async function signInWorkloadUser(
  fixture: PlatformFixture,
  url: string,
  username: string,
  password: string,
): Promise<WorkloadSession> {
  // Administrators are enrolled with TOTP; an ordinary User may not be.
  let totp: string | undefined;
  try {
    totp = totpCode(totpSecretFor(fixture, username));
  } catch {
    totp = undefined;
  }
  const signedIn = await callApi(url, '/api/session', {
    body: {
      username,
      password,
      ...(totp === undefined ? {} : { totp }),
    },
  });
  assert.equal(signedIn.status, 200, signedIn.text);
  const cookie = (signedIn.cookies[0] ?? '').split(';')[0] ?? '';
  assert.notEqual(cookie, '', 'the browser session sign-in issued no cookie');
  return { cookie, token: cookie.slice(cookie.indexOf('=') + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The cache state the answer itself reports. Only governed Data Product pages
 * carry a reusable cache; every other operation executes fresh, so it is warm.
 */
function answerCache(body: Record<string, unknown>): 'cold' | 'warm' {
  const cache = body['cache'];
  return isRecord(cache) && cache['reused'] === true ? 'warm' : 'cold';
}

async function timed(
  operation: string,
  operationClass: string,
  run: () => Promise<{ succeeded: boolean; cache?: 'cold' | 'warm' }>,
): Promise<WorkloadSample> {
  const started = performance.now();
  let succeeded = false;
  let cache: 'cold' | 'warm' = 'warm';
  try {
    const result = await run();
    succeeded = result.succeeded;
    cache = result.cache ?? cache;
  } catch {
    succeeded = false;
  }
  return {
    operation,
    operation_class: operationClass,
    cache,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
    outcome: succeeded ? 'succeeded' : 'OPERATION_FAILED',
  };
}

/**
 * Queues every scheduled Run that is due at the cursor instant through the
 * browser application's own schedule contract. The schedule cursor advances one
 * cadence, so the next round has a due Run.
 */
async function tickScheduledAcquisition(
  clients: WorkloadClients,
  acquisition: WorkloadAcquisition,
): Promise<{ ticked: boolean; elapsed_ms: number; enqueued: number; at: string }> {
  const at = acquisition.at;
  // One cadence plus a margin: the Source judges lateness from the Run that
  // really completed, which is always a little after this virtual tick.
  acquisition.at = new Date(Date.parse(at) + acquisition.everySeconds * 1_000 + 1_000).toISOString();
  const started = performance.now();
  let answer;
  try {
    answer = await callApi(clients.url, '/api/workspace/acquisition/schedule', {
      cookie: clients.administratorCookie,
      body: { at },
    });
  } catch (error) {
    const detail = clients.errors?.() ?? '';
    throw new Error(`the workload application could not tick: ${String(error)}${detail === '' ? '' : ` (${detail})`}`);
  }
  const enqueued = Array.isArray(answer.body['enqueued']) ? answer.body['enqueued'].length : 0;
  return {
    ticked: answer.status === 200,
    elapsed_ms: performance.now() - started,
    enqueued,
    at,
  };
}

/**
 * One scheduled acquisition and its integration, timed as one Run: the worker
 * acquires and integrates the queued work through the application's own work
 * contract while the Consumer operations run. The Source's own target report
 * states the publication latency afterwards, when no other writer is active.
 */
async function workScheduledAcquisition(
  clients: WorkloadClients,
  acquisition: WorkloadAcquisition,
  tick: { elapsed_ms: number; enqueued: number; at: string },
): Promise<WorkloadSample> {
  const started = performance.now();
  const answer = await callApi(
    clients.url,
    `/api/workspace/sources/${encodeURIComponent(acquisition.sourceId)}/acquisition/work`,
    { cookie: clients.administratorCookie, method: 'POST' },
  );
  const runId = typeof answer.body['acquisition_run_id'] === 'string' ? answer.body['acquisition_run_id'] : '';
  const succeeded = answer.status === 200 && answer.body['status'] === 'complete';
  const code = typeof answer.body['code'] === 'string'
    ? answer.body['code']
    : `HTTP ${String(answer.status)}`;
  return {
    operation: 'acquisition_run',
    operation_class: 'acquisition',
    cache: 'warm',
    elapsed_ms: Number((tick.elapsed_ms + performance.now() - started).toFixed(3)),
    outcome: succeeded ? 'succeeded' : 'OPERATION_FAILED',
    freshness_seconds: null,
    ...(runId === '' ? {} : { run_id: runId }),
    ...(succeeded ? {} : { error: `${code} tick_enqueued=${String(tick.enqueued)} at=${tick.at}` }),
  };
}

/** Fills each acquisition sample with the publication latency its own Run states. */
function readAcquisitionFreshness(
  surface: OperationsSurface,
  sourceId: string,
  samples: WorkloadSample[],
): void {
  const targeted = command(
    surface.fixture,
    ['acquisition', 'targets', '--source', sourceId],
    { token: surface.workspaceAdministratorToken },
  );
  if (targeted.status !== 0) return;
  const runs = (targeted.output['runs'] ?? []) as Array<Record<string, unknown>>;
  for (const sample of samples) {
    if (sample.operation !== 'acquisition_run' || sample.run_id === undefined) continue;
    const run = runs.find((candidate) => candidate['acquisition_run_id'] === sample.run_id);
    sample.freshness_seconds = run !== undefined && typeof run['publication_latency_seconds'] === 'number'
      ? run['publication_latency_seconds'] as number
      : null;
  }
}

/** One round of the twenty concurrent Consumer operations. */
async function runConsumerRound(
  surface: OperationsSurface,
  clients: WorkloadClients,
  query: WorkloadQuery,
): Promise<WorkloadSample[]> {
  const { workspaceId, dataProductId, templateId, reportId } = surface;
  const base = clients.url;
  const workspace = encodeURIComponent(workspaceId);
  const apiQuery = (): Promise<WorkloadSample> => timed('api_query', 'direct', async () => {
    const answer = await callApi(
      base,
      `/api/workspaces/${workspace}/data-products/${encodeURIComponent(dataProductId)}/query`,
      { token: clients.consumerBearer, body: query },
    );
    return {
      succeeded: answer.status === 200
        && typeof answer.body['error'] === 'undefined'
        && isRecord(answer.body['cache']),
      cache: answerCache(answer.body),
    };
  });
  const mcpQuery = (): Promise<WorkloadSample> => timed('mcp_query', 'direct', async () => {
    const mcp = clients.mcp;
    if (mcp === undefined) throw new Error('the workload has no MCP credential');
    try {
      const answered = await callTool(base, mcp.token, 'query_data_product', {
        workspace_id: workspaceId,
        data_product_id: dataProductId,
        query,
      });
      const result = mcpResult(answered);
      const structured = result['structuredContent'];
      return {
        succeeded: answered.status === 200 && result['isError'] !== true && isRecord(structured),
        cache: isRecord(structured) ? answerCache(structured) : 'warm',
      };
    } catch (error) {
      const detail = mcp.errors?.() ?? '';
      throw new Error(`the MCP surface could not be reached: ${String(error)}${detail === '' ? '' : ` (${detail})`}`);
    }
  });
  const reportRead = (): Promise<WorkloadSample> => timed('report_read', 'report_read', async () => {
    const answer = await callApi(
      base,
      `/api/workspace/reports/${encodeURIComponent(reportId)}?workspace_id=${workspace}`,
      { cookie: clients.consumerCookie },
    );
    return { succeeded: answer.status === 200 && answer.body['origin'] === 'stock' };
  });
  const naturalLanguage = (): Promise<WorkloadSample> => timed('nlq', 'nlq', async () => {
    const answer = await callApi(base, `/api/workspace/nlq?workspace_id=${workspace}`, {
      cookie: clients.consumerCookie,
      body: { question: OPERATIONS_ASK_QUESTION },
    });
    return { succeeded: answer.status === 200 && answer.body['outcome'] === 'answered' };
  });
  const reportGeneration = (): Promise<WorkloadSample> => timed('report_generation', 'report_generation', async () => {
    const answer = await callApi(
      base,
      `/api/workspace/report-templates/${encodeURIComponent(templateId)}/generate`,
      { cookie: clients.administratorCookie, body: { workspace_id: workspaceId } },
    );
    return { succeeded: answer.status === 201 && isRecord(answer.body['report']) };
  });

  const tasks: Array<Promise<WorkloadSample>> = [];
  for (let index = 0; index < WORKLOAD_MIX.direct_queries; index += 1) {
    const useMcp = clients.mcp !== undefined && index % 3 === 0;
    tasks.push(useMcp ? mcpQuery() : apiQuery());
  }
  for (let index = 0; index < WORKLOAD_MIX.stored_report_reads; index += 1) tasks.push(reportRead());
  for (let index = 0; index < WORKLOAD_MIX.natural_language_queries; index += 1) tasks.push(naturalLanguage());
  for (let index = 0; index < WORKLOAD_MIX.report_generations; index += 1) tasks.push(reportGeneration());
  return Promise.all(tasks);
}

/**
 * Runs the exact twenty-operation mixed Consumer load of section 15 through
 * supported external contracts only — the published Data Product HTTP API, the
 * MCP tool, the Report read API, the Natural-Language Query API, and the Report
 * generation path — while a scheduled acquisition and its integration run
 * concurrently. Every duration is the wall clock of the request that really
 * ran, so queueing, validation, data work, and model time all count.
 */
export async function runMixedWorkload(
  surface: OperationsSurface,
  options: { clients: WorkloadClients; query?: WorkloadQuery; acquisition?: WorkloadAcquisition },
): Promise<WorkloadSample[]> {
  const query = options.query ?? workloadQuery(0);
  if (options.acquisition === undefined) {
    return runConsumerRound(surface, options.clients, query);
  }
  // Scheduling is a durable write, so it is queued first; the acquisition
  // worker then runs at the same time as the twenty Consumer operations.
  const scheduled = await tickScheduledAcquisition(options.clients, options.acquisition);
  if (!scheduled.ticked) {
    return [
      ...await runConsumerRound(surface, options.clients, query),
      {
        operation: 'acquisition_run',
        operation_class: 'acquisition',
        cache: 'warm',
        elapsed_ms: Number(scheduled.elapsed_ms.toFixed(3)),
        outcome: 'OPERATION_FAILED',
        freshness_seconds: null,
        error: 'ACQUISITION_SCHEDULE_TICK_FAILED',
      },
    ];
  }
  const consumer = runConsumerRound(surface, options.clients, query);
  const acquisition = workScheduledAcquisition(options.clients, options.acquisition, scheduled);
  const [samples, worked] = await Promise.all([consumer, acquisition]);
  return [...samples, worked];
}

/** One measured window: the exact duration, rounds, and samples it observed. */
export interface WorkloadWindowResult {
  window: MeasurementWindow;
  /** The exact window length the harness was configured to measure. */
  duration_seconds: number;
  /** The wall-clock time the window really took, including every round. */
  observed_seconds: number;
  started_at: string;
  finished_at: string;
  rounds: number;
  samples: WorkloadSample[];
}

/**
 * Measures one configured window by repeating the mixed round until the window
 * duration elapses (and always at least once). The acquisition schedule cursor
 * advances with every round, so scheduled acquisition stays active throughout.
 */
export async function runMeasurementWindow(
  surface: OperationsSurface,
  plan: MeasurementWindowPlan,
  options: { clients: WorkloadClients; query?: WorkloadQuery; acquisition?: WorkloadAcquisition },
): Promise<WorkloadWindowResult> {
  const started = new Date();
  const deadline = started.getTime() + Math.max(0, plan.duration_seconds * 1_000);
  const samples: WorkloadSample[] = [];
  let rounds = 0;
  do {
    samples.push(...await runMixedWorkload(surface, options));
    rounds += 1;
  } while (Date.now() < deadline);
  // The Source's own target report is read only after the round is over, so a
  // separate command process never appends beside the application's writers.
  if (options.acquisition !== undefined) {
    readAcquisitionFreshness(surface, options.acquisition.sourceId, samples);
  }
  const finished = new Date();
  return {
    window: plan.window,
    duration_seconds: plan.duration_seconds,
    observed_seconds: Number(((finished.getTime() - started.getTime()) / 1_000).toFixed(3)),
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    rounds,
    samples,
  };
}

/** What one window's samples really contain, counted by class and operation. */
function operationMix(samples: WorkloadSample[]): Record<string, number> {
  const count = (predicate: (sample: WorkloadSample) => boolean): number => samples.filter(predicate).length;
  return {
    direct_queries: count((sample) => sample.operation_class === 'direct'),
    direct_api_queries: count((sample) => sample.operation === 'api_query'),
    direct_mcp_queries: count((sample) => sample.operation === 'mcp_query'),
    stored_report_reads: count((sample) => sample.operation === 'report_read'),
    natural_language_queries: count((sample) => sample.operation === 'nlq'),
    report_generations: count((sample) => sample.operation === 'report_generation'),
  };
}

/**
 * Records one measured window exactly as the harness observed it: the exact
 * configured and observed durations, the concurrency and operation mix it
 * launched, the external contracts it drove, the Operations configuration it
 * certified under, and the samples it timed.
 */
export function recordWorkloadRun(
  fixture: PlatformFixture,
  token: string,
  result: WorkloadWindowResult,
  evidence: { limits?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const parameters = {
    harness: 'external-contracts',
    window_seconds: result.duration_seconds,
    observed_seconds: result.observed_seconds,
    concurrency: WORKLOAD_CONCURRENCY,
    concurrency_model: { ...WORKLOAD_CONCURRENCY_MODEL },
    rounds: result.rounds,
    operation_mix: operationMix(result.samples),
    samples: result.samples.length,
    active_acquisition: result.samples.some((sample) => sample.operation_class === 'acquisition'),
    cache_observation: 'governed page cache state reported by each answer; uncached operations are warm',
    external_contracts: [...WORKLOAD_CONTRACTS],
    ...(evidence.limits === undefined ? {} : { configured_limits: evidence.limits }),
  };
  const recorded = command(
    fixture,
    [
      'operations', 'measure',
      '--run', `measured-${result.window}`,
      '--window', result.window,
      '--samples', jsonFile(fixture, `samples-${result.window}`, {
        parameters,
        started_at: result.started_at,
        finished_at: result.finished_at,
        samples: result.samples,
      }),
    ],
    { token },
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  return recorded.output;
}

/** Records the host volumes and pressure the harness observed. */
export function observeWorkloadEnvelope(
  fixture: PlatformFixture,
  token: string,
  values: Record<string, number>,
): Record<string, unknown> {
  const result = command(
    fixture,
    ['operations', 'observe', '--values', jsonFile(fixture, 'envelope-observed', values)],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/** The whole certification picture the platform reports from measured samples. */
export function reportWorkload(fixture: PlatformFixture): Record<string, unknown> {
  const result = command(fixture, ['operations', 'report'], { token: fixture.administrator.username });
  assert.equal(result.status, 0, result.stderr);
  return result.output;
}

/** The bytes stored under one directory, as the host really holds them. */
export function directoryBytes(directory: string): number {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

/** The free fraction of the volume that really holds this Deployment, in percent. */
export function ssdFreePercent(directory: string): number {
  const stats = statfsSync(directory);
  return Number(((stats.bavail / stats.blocks) * 100).toFixed(3));
}

/** The harness process's own resident memory as a percentage of host memory. */
export function memoryPercent(): number {
  return Number(((process.memoryUsage().rss / totalmem()) * 100).toFixed(3));
}
