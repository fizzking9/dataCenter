import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { percentile } from './acquisition-targets.js';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireDeploymentAdministrator, type ActionContext } from './authz.js';
import type { Fail } from './errors.js';
import {
  readOperationsState,
  withOperationsLock,
  writeOperationsState,
  type MeasurementSample,
  type OperationsState,
} from './operations-state.js';
import { openPlatform } from './session.js';
import { readJsonFile, writeJsonFile } from './state.js';

/**
 * The settled ceilings of the certified first release. Every one of them is
 * configuration: the platform never branches on a business case to decide how
 * much work it will admit, what a token costs, or how large a Deployment may grow.
 *
 * - `limits` bound platform, Workspace, Agent Identity, and worker concurrency.
 * - `token_ceilings` bound what one generation may send and answer, per class.
 * - `prices` are the operator's tariff in CNY per million tokens.
 * - `budgets` bound ordinary operating spend, one profile activation, and a
 *   full three-run release certification.
 * - `envelope` bounds curated volume, storage, host pressure, and failure rate.
 * - `targets` state the latency and freshness targets one operation must meet.
 */
export const SETTLED_OPERATIONS_CONFIGURATION: OperationsConfiguration = {
  limits: {
    consumer_concurrency: 20,
    llm_concurrency: 4,
    workspace_consumer_queue: 20,
    workspace_async_queue: 100,
    agent_direct_concurrency: 4,
    agent_llm_concurrency: 1,
    agent_direct_requests_per_minute: 60,
    agent_llm_requests_per_minute: 10,
    workers: { acquisition: 2, browser_scraper: 1, llm: 4 },
  },
  token_ceilings: {
    nlq: { input: 32_000, output: 2_000, subqueries: 4 },
    report: { input: 32_000, output: 2_000 },
    artifact: { input: 64_000, output: 8_000 },
  },
  prices: { input_cny_per_million_tokens: 2, output_cny_per_million_tokens: 8 },
  budgets: {
    operating_monthly_cny: 500,
    activation_cny: 200,
    certification_cny: 1_000,
    average_cost_ceilings_cny: { nlq: 0.1, report: 0.2, artifact: 2 },
  },
  envelope: {
    maximum_curated_records: 5_000_000,
    maximum_curated_documents: 20_000,
    // 25 GiB of raw/source/scraper payloads inside 150 GiB of platform storage.
    maximum_raw_payload_bytes: 25 * 1024 ** 3,
    maximum_total_storage_bytes: 150 * 1024 ** 3,
    minimum_ssd_free_percent: 20,
    maximum_cpu_p95_percent: 75,
    maximum_memory_p95_percent: 85,
    maximum_oom_kills: 0,
    maximum_swap_thrash: 0,
    maximum_unexpected_failure_rate: 0.001,
  },
  targets: {
    api_query: { p95_ms: 1_000, p99_ms: 2_000 },
    mcp_query: { p95_ms: 1_250, p99_ms: 2_250 },
    report_read: { p95_ms: 1_000, p99_ms: 2_000 },
    nlq: { p95_ms: 25_000, p99_ms: 45_000, timeout_ms: 60_000 },
    report_generation: { p95_ms: 30_000, p99_ms: 55_000, timeout_ms: 90_000 },
  },
};

export interface OperationsLimits {
  consumer_concurrency: number;
  llm_concurrency: number;
  workspace_consumer_queue: number;
  workspace_async_queue: number;
  agent_direct_concurrency: number;
  agent_llm_concurrency: number;
  agent_direct_requests_per_minute: number;
  agent_llm_requests_per_minute: number;
  workers: { acquisition: number; browser_scraper: number; llm: number };
}

export interface TokenCeilings {
  nlq: { input: number; output: number; subqueries: number };
  report: { input: number; output: number };
  artifact: { input: number; output: number };
}

export interface OperationsPrices {
  input_cny_per_million_tokens: number;
  output_cny_per_million_tokens: number;
}

export interface OperationsBudgets {
  operating_monthly_cny: number;
  activation_cny: number;
  certification_cny: number;
  average_cost_ceilings_cny: { nlq: number; report: number; artifact: number };
}

export interface OperationsEnvelope {
  maximum_curated_records: number;
  maximum_curated_documents: number;
  maximum_raw_payload_bytes: number;
  maximum_total_storage_bytes: number;
  minimum_ssd_free_percent: number;
  maximum_cpu_p95_percent: number;
  maximum_memory_p95_percent: number;
  maximum_oom_kills: number;
  maximum_swap_thrash: number;
  maximum_unexpected_failure_rate: number;
}

/** The latency, timeout, and freshness targets one measured operation must meet. */
export interface OperationTarget {
  p95_ms?: number;
  p99_ms?: number;
  timeout_ms?: number;
  p95_seconds?: number;
  p99_seconds?: number;
  cny_average?: number;
  failure_rate_max?: number;
}

export interface OperationsConfiguration {
  limits: OperationsLimits;
  token_ceilings: TokenCeilings;
  prices: OperationsPrices;
  budgets: OperationsBudgets;
  envelope: OperationsEnvelope;
  targets: Record<string, OperationTarget>;
}

export function operationsConfigurationPath(root: string): string {
  return join(root, 'config', 'operations.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The Deployment's effective configuration: the settled ceilings, with every
 * value the operator configured laid over them. A Deployment that never
 * configured anything reads the settled ceilings.
 */
export function readOperationsConfiguration(root: string): OperationsConfiguration {
  const path = operationsConfigurationPath(root);
  const configuration = deepCopy(SETTLED_OPERATIONS_CONFIGURATION);
  if (!existsSync(path)) return configuration;
  const stored = readJsonFile<unknown>(path);
  if (!isRecord(stored)) return configuration;
  mergeStored(configuration, stored);
  return configuration;
}

function mergeStored(configuration: OperationsConfiguration, stored: Record<string, unknown>): void {
  for (const key of ['limits', 'token_ceilings', 'prices', 'budgets', 'envelope'] as const) {
    const value = stored[key];
    if (!isRecord(value)) continue;
    if (key === 'token_ceilings') {
      mergeTokenCeilings(configuration.token_ceilings, value);
      continue;
    }
    if (key === 'budgets') {
      mergeBudgets(configuration.budgets, value);
      continue;
    }
    if (key === 'limits') {
      mergeLimits(configuration.limits, value);
      continue;
    }
    Object.assign(configuration[key], value);
  }
  if (isRecord(stored['targets'])) {
    configuration.targets = { ...configuration.targets, ...(stored['targets'] as Record<string, OperationTarget>) };
  }
}

function mergeLimits(limits: OperationsLimits, stored: Record<string, unknown>): void {
  for (const key of [
    'consumer_concurrency', 'llm_concurrency', 'workspace_consumer_queue', 'workspace_async_queue',
    'agent_direct_concurrency', 'agent_llm_concurrency',
    'agent_direct_requests_per_minute', 'agent_llm_requests_per_minute',
  ] as const) {
    if (typeof stored[key] === 'number') limits[key] = stored[key];
  }
  if (isRecord(stored['workers'])) {
    for (const key of ['acquisition', 'browser_scraper', 'llm'] as const) {
      const value = stored['workers'][key];
      if (typeof value === 'number') limits.workers[key] = value;
    }
  }
}

function mergeTokenCeilings(ceilings: TokenCeilings, stored: Record<string, unknown>): void {
  for (const key of ['nlq', 'report', 'artifact'] as const) {
    const value = stored[key];
    if (!isRecord(value)) continue;
    const target = ceilings[key] as Record<string, number>;
    for (const field of Object.keys(target)) {
      const configured = value[field];
      if (typeof configured === 'number') target[field] = configured;
    }
  }
}

function mergeBudgets(budgets: OperationsBudgets, stored: Record<string, unknown>): void {
  for (const key of ['operating_monthly_cny', 'activation_cny', 'certification_cny'] as const) {
    if (typeof stored[key] === 'number') budgets[key] = stored[key];
  }
  if (isRecord(stored['average_cost_ceilings_cny'])) {
    for (const key of ['nlq', 'report', 'artifact'] as const) {
      const value = stored['average_cost_ceilings_cny'][key];
      if (typeof value === 'number') budgets.average_cost_ceilings_cny[key] = value;
    }
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function pricePerMillion(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
}

/** The configuration view an operator and every measured surface reads. */
export function operationsView(root: string): Record<string, unknown> {
  const configuration = readOperationsConfiguration(root);
  return {
    limits: deepCopy(configuration.limits),
    token_ceilings: deepCopy(configuration.token_ceilings),
    prices: {
      input_cny_per_million_tokens: configuration.prices.input_cny_per_million_tokens,
      output_cny_per_million_tokens: configuration.prices.output_cny_per_million_tokens,
      configured: existsSync(operationsConfigurationPath(root)),
    },
    budgets: deepCopy(configuration.budgets),
    envelope: deepCopy(configuration.envelope),
    targets: deepCopy(configuration.targets),
  };
}

/**
 * States the Deployment's service, token, price, budget, and envelope ceilings.
 * Every value is validated against the settled contract before anything is
 * written, so a half-configured Deployment never runs on an incoherent ceiling.
 */
export function configureOperations(options: {
  root: string;
  masterKey: string;
  token: string;
  configPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'operations_configure', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  const stated = readJsonFile<unknown>(options.configPath);
  if (!isRecord(stated)) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'The operations configuration must be a JSON object.');
  }
  const current = readOperationsConfiguration(options.root);
  const merged = deepCopy(current);
  mergeStored(merged, stated);
  validateConfiguration(merged, fail);

  writeJsonFile(operationsConfigurationPath(options.root), {
    limits: merged.limits,
    token_ceilings: merged.token_ceilings,
    prices: merged.prices,
    budgets: merged.budgets,
    envelope: merged.envelope,
    targets: merged.targets,
  });
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      input_cny_per_million_tokens: merged.prices.input_cny_per_million_tokens,
      output_cny_per_million_tokens: merged.prices.output_cny_per_million_tokens,
      consumer_concurrency: merged.limits.consumer_concurrency,
      llm_concurrency: merged.limits.llm_concurrency,
    },
  });
  return operationsView(options.root);
}

/**
 * A ceiling only means something if it can be met: platform slots bound the
 * LLM-backed ones, an Agent never exceeds the platform, optional ceilings stay
 * ordered, and the weights and prices are whole, non-negative numbers.
 */
function validateConfiguration(configuration: OperationsConfiguration, fail: Fail): void {
  const { limits } = configuration;
  for (const [name, value] of Object.entries({
    consumer_concurrency: limits.consumer_concurrency,
    llm_concurrency: limits.llm_concurrency,
    workspace_consumer_queue: limits.workspace_consumer_queue,
    workspace_async_queue: limits.workspace_async_queue,
    agent_direct_concurrency: limits.agent_direct_concurrency,
    agent_llm_concurrency: limits.agent_llm_concurrency,
    agent_direct_requests_per_minute: limits.agent_direct_requests_per_minute,
    agent_llm_requests_per_minute: limits.agent_llm_requests_per_minute,
    acquisition_workers: limits.workers.acquisition,
    browser_scraper_workers: limits.workers.browser_scraper,
    llm_workers: limits.workers.llm,
  })) {
    if (!positiveInteger(value)) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} ceiling must be a whole number of at least one.`);
    }
  }
  if (limits.llm_concurrency > limits.consumer_concurrency) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'The LLM-backed ceiling cannot exceed the platform Consumer concurrency.');
  }
  if (limits.agent_direct_concurrency > limits.consumer_concurrency) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'The Agent direct ceiling cannot exceed the platform Consumer concurrency.');
  }
  if (limits.agent_llm_concurrency > limits.llm_concurrency) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'The Agent LLM-backed ceiling cannot exceed the platform LLM ceiling.');
  }
  for (const [name, ceiling] of Object.entries(configuration.token_ceilings)) {
    for (const [field, value] of Object.entries(ceiling)) {
      if (!positiveInteger(value)) {
        fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} ${field} token ceiling must be a whole number of at least one.`);
      }
    }
  }
  if (!pricePerMillion(configuration.prices.input_cny_per_million_tokens)
    || !pricePerMillion(configuration.prices.output_cny_per_million_tokens)) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'Both CNY prices must be finite, non-negative amounts per million tokens.');
  }
  if (!nonNegativeNumber(configuration.budgets.operating_monthly_cny)
    || !nonNegativeNumber(configuration.budgets.activation_cny)
    || !nonNegativeNumber(configuration.budgets.certification_cny)) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'Every budget must be a finite, non-negative CNY amount.');
  }
  for (const [name, ceiling] of Object.entries(configuration.budgets.average_cost_ceilings_cny)) {
    if (!nonNegativeNumber(ceiling)) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} average cost ceiling must be a finite, non-negative CNY amount.`);
    }
  }
  for (const [name, value] of Object.entries(configuration.envelope)) {
    if (!nonNegativeNumber(value)) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} envelope limit must be a finite, non-negative number.`);
    }
  }
  if (configuration.envelope.minimum_ssd_free_percent > 100
    || configuration.envelope.maximum_cpu_p95_percent > 100
    || configuration.envelope.maximum_memory_p95_percent > 100) {
    fail('OPERATIONS_CONFIGURATION_INVALID', 'A percentage ceiling cannot exceed one hundred.');
  }
  for (const [name, target] of Object.entries(configuration.targets)) {
    if (!isRecord(target)) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} target must be a JSON object.`);
    }
    for (const [field, value] of Object.entries(target)) {
      if (!nonNegativeNumber(value)) {
        fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} ${field} target must be a finite, non-negative number.`);
      }
    }
    const numeric = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const p95ms = numeric(target['p95_ms']);
    const p99ms = numeric(target['p99_ms']);
    const timeout = numeric(target['timeout_ms']);
    if (p95ms !== null && p99ms !== null && p95ms > p99ms) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} p95 target cannot exceed its p99 target.`);
    }
    if (p99ms !== null && timeout !== null && timeout < p99ms) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} timeout cannot be shorter than its p99 target.`);
    }
    const p95s = numeric(target['p95_seconds']);
    const p99s = numeric(target['p99_seconds']);
    if (p95s !== null && p99s !== null && p95s > p99s) {
      fail('OPERATIONS_CONFIGURATION_INVALID', `The ${name} freshness p95 target cannot exceed its p99 target.`);
    }
  }
}

/**
 * The metered generation classes. The three Consumer-facing classes each have
 * their own token and average-cost ceiling; `activation` is the priced run of a
 * Model Profile evaluation, which is bounded by the activation budget instead.
 */
export type UsageClass = 'nlq' | 'report' | 'artifact' | 'activation';

/** One settled generation, as the meter reports it to its caller. */
export interface SettledUsage {
  input_tokens: number;
  output_tokens: number;
  cost_cny: number;
  outcome: 'succeeded' | 'refused';
}

/**
 * A documented local token count, used to check a request's ceiling before it is
 * sent and to account an answer whose endpoint states no usage: one token per
 * CJK character and one per four other non-whitespace characters.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(character)) cjk += 1;
    else if (!/\s/u.test(character)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** What one generation is, so its usage is attributed at the operator's prices. */
export interface GenerationMetering {
  root: string;
  class: UsageClass;
  /**
   * The settled token ceiling that bounds this generation. Only the three
   * Consumer classes state ceilings, so an evaluation states the ceiling class
   * of the work it performs rather than inventing a fourth one.
   */
  ceiling_class?: 'nlq' | 'report' | 'artifact';
  operation: string;
  /** Groups the generations of one logical operation, so averages stay per operation. */
  operation_id: string;
  workspace_id: string | null;
  agent_identity_id?: string | null;
  /**
   * States each settled generation to its caller, so a priced run such as an
   * activation evaluation can total what it consumed without re-reading state.
   */
  on_settled?: (usage: SettledUsage) => void;
}

export interface GenerationMeter {
  input_tokens: number;
  settle(result: {
    output: unknown;
    usage: { input_tokens: number; output_tokens: number } | null;
  }): void;
}

function priceGeneration(prices: OperationsPrices, inputTokens: number, outputTokens: number): number {
  return Number((
    (inputTokens / 1_000_000) * prices.input_cny_per_million_tokens
    + (outputTokens / 1_000_000) * prices.output_cny_per_million_tokens
  ).toFixed(6));
}

function recordUsage(
  metering: GenerationMetering,
  measured: {
    input_tokens: number;
    output_tokens: number;
    estimated: boolean;
    cost_cny: number;
    outcome: 'succeeded' | 'refused';
  },
): void {
  withOperationsLock(metering.root, () => {
    const state = readOperationsState(metering.root);
    state.usage.push({
      usage_id: randomUUID(),
      class: metering.class,
      operation: metering.operation,
      operation_id: metering.operation_id,
      workspace_id: metering.workspace_id,
      agent_identity_id: metering.agent_identity_id ?? null,
      purpose: metering.operation,
      input_tokens: measured.input_tokens,
      output_tokens: measured.output_tokens,
      estimated: measured.estimated,
      cost_cny: measured.cost_cny,
      outcome: measured.outcome,
      at: new Date().toISOString(),
    });
    writeOperationsState(metering.root, state);
  });
  metering.on_settled?.({
    input_tokens: measured.input_tokens,
    output_tokens: measured.output_tokens,
    cost_cny: measured.cost_cny,
    outcome: measured.outcome,
  });
}

/**
 * Opens one metered generation. The input ceiling is checked against the request
 * the endpoint will actually receive, so a request that could never fit is
 * refused before the endpoint is called; the output ceiling is checked against
 * what the endpoint answered, so an over-long answer is refused rather than
 * accepted and trimmed.
 */
export function beginGeneration(
  metering: GenerationMetering,
  request: { prompt_body: string; input: unknown; tools: string[]; structured_output: string },
  fail: (code: string, message: string) => never,
): GenerationMeter {
  const configuration = readOperationsConfiguration(metering.root);
  // An evaluation that does not name a ceiling class is bounded by the widest
  // settled generation ceiling, so it can never run unbounded.
  const declaredClass = metering.class;
  const ceilingClass: 'nlq' | 'report' | 'artifact' = metering.ceiling_class
    ?? (declaredClass === 'activation' ? 'artifact' : declaredClass);
  const ceiling = configuration.token_ceilings[ceilingClass];
  const inputTokens = estimateTokens(request.prompt_body)
    + estimateTokens(JSON.stringify(request.input ?? null))
    + estimateTokens([...request.tools, request.structured_output].join(' '));
  if (inputTokens > ceiling.input) {
    recordUsage(metering, {
      input_tokens: inputTokens,
      output_tokens: 0,
      estimated: true,
      cost_cny: 0,
      outcome: 'refused',
    });
    fail(
      'MODEL_INPUT_CEILING_EXCEEDED',
      `The ${metering.class} generation would send ${String(inputTokens)} tokens, past the settled ceiling of ${String(ceiling.input)}.`,
    );
  }
  return {
    input_tokens: inputTokens,
    settle(result) {
      const outputTokens = result.usage === null
        ? estimateTokens(JSON.stringify(result.output))
        : result.usage.output_tokens;
      const billedInput = result.usage === null ? inputTokens : result.usage.input_tokens;
      const refused = outputTokens > ceiling.output;
      recordUsage(metering, {
        input_tokens: billedInput,
        output_tokens: outputTokens,
        estimated: result.usage === null,
        cost_cny: priceGeneration(configuration.prices, billedInput, outputTokens),
        outcome: refused ? 'refused' : 'succeeded',
      });
      if (refused) {
        fail(
          'MODEL_OUTPUT_CEILING_EXCEEDED',
          `The ${metering.class} generation answered ${String(outputTokens)} tokens, past the settled ceiling of ${String(ceiling.output)}.`,
        );
      }
    },
  };
}

/**
 * What the Deployment has generated and what it cost, read at one instant. The
 * operating budget is the calendar month's spend, and each class states its own
 * average cost per operation beside the ceiling it is measured against.
 */
export function usageView(root: string, at?: string): Record<string, unknown> {
  const configuration = readOperationsConfiguration(root);
  const state = readOperationsState(root);
  const instant = at ?? new Date().toISOString();
  const month = instant.slice(0, 7);
  const byClass: Record<string, Record<string, unknown>> = {};
  for (const cls of ['nlq', 'report', 'artifact'] as const) {
    const entries = state.usage.filter((entry) => entry.class === cls);
    const operations = new Set(entries.map((entry) => entry.operation_id)).size;
    const cost = Number(entries.reduce((total, entry) => total + entry.cost_cny, 0).toFixed(6));
    const ceilingCny = configuration.budgets.average_cost_ceilings_cny[cls];
    byClass[cls] = {
      generations: entries.length,
      operations,
      input_tokens: entries.reduce((total, entry) => total + entry.input_tokens, 0),
      output_tokens: entries.reduce((total, entry) => total + entry.output_tokens, 0),
      cost_cny: cost,
      average_cost_cny: operations === 0 ? 0 : Number((cost / operations).toFixed(6)),
      average_cost_ceiling_cny: ceilingCny,
      met: operations === 0 || cost / operations <= ceilingCny,
    };
  }
  const monthly = state.usage.filter((entry) => entry.at.startsWith(month));
  const monthlyCost = Number(monthly.reduce((total, entry) => total + entry.cost_cny, 0).toFixed(6));
  return {
    at: instant,
    prices: deepCopy(configuration.prices),
    totals: {
      generations: state.usage.length,
      operations: new Set(state.usage.map((entry) => entry.operation_id)).size,
      input_tokens: state.usage.reduce((total, entry) => total + entry.input_tokens, 0),
      output_tokens: state.usage.reduce((total, entry) => total + entry.output_tokens, 0),
      cost_cny: Number(state.usage.reduce((total, entry) => total + entry.cost_cny, 0).toFixed(6)),
      refused_generations: state.usage.filter((entry) => entry.outcome === 'refused').length,
      estimated_generations: state.usage.filter((entry) => entry.estimated).length,
    },
    by_class: byClass,
    budgets: {
      operating: {
        period: month,
        cost_cny: monthlyCost,
        ceiling_cny: configuration.budgets.operating_monthly_cny,
        met: monthlyCost <= configuration.budgets.operating_monthly_cny,
      },
    },
  };
}

/** The exact mixed load section 15 certifies: twenty concurrent Consumer operations. */
export const MIXED_WORKLOAD = {
  consumer_operations: 20,
  direct_queries: 12,
  stored_report_reads: 4,
  natural_language_queries: 2,
  report_generations: 2,
} as const;

/**
 * The measured windows of one certification: a discarded warm-up, three
 * two-hour measurements, and a twenty-four-hour soak. A test may scale the
 * wall-clock durations, but the sequence and the counts never change.
 */
export const MEASUREMENT_WINDOWS = ['warmup', 'run_1', 'run_2', 'run_3', 'soak'] as const;
export type MeasurementWindow = typeof MEASUREMENT_WINDOWS[number];

/** One operation a harness really ran and really timed, with its cache state. */
export interface MeasurementInput {
  operation: string;
  operation_class: string;
  cache: 'cold' | 'warm';
  elapsed_ms: number;
  outcome: string;
  freshness_seconds?: number | null;
}

function measurementWindow(value: string): value is MeasurementWindow {
  return (MEASUREMENT_WINDOWS as readonly string[]).includes(value);
}

/**
 * Records what a measurement run actually observed. The platform refuses a
 * sample it cannot believe: a window it never defined, a negative duration, or
 * a missing operation would otherwise turn a failing run into silent evidence.
 */
export function recordMeasurements(options: {
  root: string;
  masterKey: string;
  token: string;
  runId: string;
  window: string;
  parameters: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  samples: MeasurementInput[];
  at?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'operations_measure', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  if (!measurementWindow(options.window)) {
    fail('OPERATIONS_MEASUREMENT_INVALID', `The measurement window ${options.window} is not one of ${MEASUREMENT_WINDOWS.join(', ')}.`);
  }
  const at = options.at ?? new Date().toISOString();
  const started = Date.parse(options.startedAt);
  const finished = Date.parse(options.finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) {
    fail('OPERATIONS_MEASUREMENT_INVALID', 'A measurement run must state the instant it started and finished, in order.');
  }
  options.samples.forEach((sample, index) => {
    if (typeof sample.operation !== 'string' || sample.operation.length === 0
      || typeof sample.operation_class !== 'string' || sample.operation_class.length === 0
      || (sample.cache !== 'cold' && sample.cache !== 'warm')
      || typeof sample.elapsed_ms !== 'number' || !Number.isFinite(sample.elapsed_ms) || sample.elapsed_ms < 0
      || typeof sample.outcome !== 'string' || sample.outcome.length === 0) {
      fail('OPERATIONS_MEASUREMENT_INVALID', `Measurement sample ${String(index)} does not state an operation, class, cache, duration, and outcome.`);
    }
  });
  return withOperationsLock(options.root, () => {
    const state = readOperationsState(options.root);
    state.samples.push(...options.samples.map((sample) => ({
      sample_id: randomUUID(),
      run_id: options.runId,
      window: options.window,
      operation: sample.operation,
      operation_class: sample.operation_class,
      cache: sample.cache,
      elapsed_ms: sample.elapsed_ms,
      outcome: sample.outcome,
      freshness_seconds: typeof sample.freshness_seconds === 'number' ? sample.freshness_seconds : null,
      at,
    })));
    state.runs = [
      ...state.runs.filter((run) => run.run_id !== options.runId),
      {
        run_id: options.runId,
        parameters: deepCopy(options.parameters),
        started_at: new Date(started).toISOString(),
        finished_at: new Date(finished).toISOString(),
      },
    ];
    writeOperationsState(options.root, state);
    return {
      run_id: options.runId,
      window: options.window,
      samples: options.samples.length,
      duration_seconds: Number(((finished - started) / 1_000).toFixed(3)),
    };
  });
}

/** The host values a certification observes, each measured against one envelope limit. */
const OBSERVED_ENVELOPE_KEYS = new Set([
  'ssd_free_percent', 'total_storage_bytes', 'raw_payload_bytes', 'curated_records',
  'curated_documents', 'cpu_p95_percent', 'memory_p95_percent', 'oom_kills', 'swap_thrash',
]);

/**
 * Records the host volumes and pressure a certification observed. The values
 * are observations, never assumptions: reporting them is what lets the report
 * state whether the certified host stayed inside the envelope.
 */
export function observeEnvelope(options: {
  root: string;
  masterKey: string;
  token: string;
  values: Record<string, number>;
  at?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'operations_observe', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  requireDeploymentAdministrator(session, actor, context);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);
  const observed: Record<string, number> = {};
  for (const [key, value] of Object.entries(options.values)) {
    if (!OBSERVED_ENVELOPE_KEYS.has(key)) {
      fail('OPERATIONS_OBSERVATION_INVALID', `${key} is not an observable envelope value.`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('OPERATIONS_OBSERVATION_INVALID', `The observed ${key} must be a finite, non-negative number.`);
    }
    observed[key] = value;
  }
  return withOperationsLock(options.root, () => {
    const state = readOperationsState(options.root);
    state.envelope = { observed_at: options.at ?? new Date().toISOString(), values: observed };
    writeOperationsState(options.root, state);
    return { observed_at: state.envelope.observed_at, values: { ...observed } };
  });
}

interface SampleStatistics {
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

function statistics(samples: MeasurementSample[]): SampleStatistics {
  const elapsed = samples.map((sample) => sample.elapsed_ms).sort((left, right) => left - right);
  return {
    samples: elapsed.length,
    p50_ms: percentile(elapsed, 0.5),
    p95_ms: percentile(elapsed, 0.95),
    p99_ms: percentile(elapsed, 0.99),
  };
}

function latencyMet(stats: SampleStatistics, sampleSet: MeasurementSample[], target: OperationTarget): boolean {
  if (stats.samples === 0) return false;
  if (target.p95_ms !== undefined && (stats.p95_ms === null || stats.p95_ms > target.p95_ms)) return false;
  if (target.p99_ms !== undefined && (stats.p99_ms === null || stats.p99_ms > target.p99_ms)) return false;
  const timeout = target.timeout_ms;
  if (timeout !== undefined && sampleSet.some((sample) => sample.elapsed_ms >= timeout)) return false;
  return true;
}

function latencySection(configuration: OperationsConfiguration, state: OperationsState): {
  operations: Record<string, Record<string, unknown>>;
  met: boolean;
} {
  const operations: Record<string, Record<string, unknown>> = {};
  let met = true;
  for (const [name, target] of Object.entries(configuration.targets)) {
    const timed = target.p95_ms !== undefined || target.p99_ms !== undefined || target.timeout_ms !== undefined;
    if (!timed) continue;
    const sampleSet = state.samples.filter((sample) => sample.operation === name && sample.window !== 'warmup');
    const stats = statistics(sampleSet);
    const timeout = target.timeout_ms;
    const timeouts = timeout === undefined
      ? 0
      : sampleSet.filter((sample) => sample.elapsed_ms >= timeout).length;
    const operationMet = latencyMet(stats, sampleSet, target);
    if (!operationMet) met = false;
    operations[name] = {
      ...stats,
      cold: statistics(sampleSet.filter((sample) => sample.cache === 'cold')),
      warm: statistics(sampleSet.filter((sample) => sample.cache === 'warm')),
      timeouts,
      targets: { ...target },
      met: operationMet,
    };
  }
  return { operations, met };
}

function freshnessSection(configuration: OperationsConfiguration, state: OperationsState): {
  operations: Record<string, Record<string, unknown>>;
  met: boolean;
} {
  const operations: Record<string, Record<string, unknown>> = {};
  let met = true;
  for (const [name, target] of Object.entries(configuration.targets)) {
    if (target.p95_seconds === undefined && target.p99_seconds === undefined) continue;
    const values = state.samples
      .filter((sample) => sample.operation === name && sample.window !== 'warmup' && sample.freshness_seconds !== null)
      .map((sample) => sample.freshness_seconds as number)
      .sort((left, right) => left - right);
    const p95 = percentile(values, 0.95);
    const p99 = percentile(values, 0.99);
    const operationMet = values.length > 0
      && (target.p95_seconds === undefined || (p95 !== null && p95 <= target.p95_seconds))
      && (target.p99_seconds === undefined || (p99 !== null && p99 <= target.p99_seconds));
    if (!operationMet) met = false;
    operations[name] = {
      samples: values.length,
      p95_seconds: p95,
      p99_seconds: p99,
      targets: { p95_seconds: target.p95_seconds ?? null, p99_seconds: target.p99_seconds ?? null },
      met: operationMet,
    };
  }
  return { operations, met };
}

/**
 * The certified picture: what the harness observed, every distribution measured
 * against the target it was stated for, and whether the whole envelope held.
 * Percentiles are nearest-rank over exactly the samples recorded, and a missing
 * measurement is a miss rather than an omission.
 */
export function operationsReport(root: string, at?: string): Record<string, unknown> {
  const configuration = readOperationsConfiguration(root);
  const state = readOperationsState(root);
  const generatedAt = at ?? new Date().toISOString();
  const measured = state.samples.filter((sample) => sample.window !== 'warmup');

  const countsOf = (window: string): Record<string, number> => {
    const inWindow = state.samples.filter((sample) => sample.window === window);
    const count = (operationClass: string): number =>
      inWindow.filter((sample) => sample.operation_class === operationClass).length;
    return {
      direct: count('direct'),
      stored_report_reads: count('report_read'),
      natural_language_queries: count('nlq'),
      report_generations: count('report_generation'),
      total: count('direct') + count('report_read') + count('nlq') + count('report_generation'),
    };
  };
  const measuredWindows = MEASUREMENT_WINDOWS.filter((window) => window !== 'warmup');
  const workloadMet = measuredWindows.every((window) => {
    const counts = countsOf(window);
    return counts.direct! >= MIXED_WORKLOAD.direct_queries
      && counts.stored_report_reads! >= MIXED_WORKLOAD.stored_report_reads
      && counts.natural_language_queries! >= MIXED_WORKLOAD.natural_language_queries
      && counts.report_generations! >= MIXED_WORKLOAD.report_generations;
  });

  const runs = MEASUREMENT_WINDOWS.map((window) => {
    const run = state.runs.find((candidate) => {
      const samples = state.samples.filter((sample) => sample.run_id === candidate.run_id);
      return samples.length > 0 && samples[0]!.window === window;
    });
    const samples = run === undefined ? [] : state.samples.filter((sample) => sample.run_id === run.run_id);
    return {
      window,
      run_id: run?.run_id ?? null,
      started_at: run?.started_at ?? null,
      finished_at: run?.finished_at ?? null,
      duration_seconds: run === undefined || run.finished_at === null
        ? null
        : Number(((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1_000).toFixed(3)),
      parameters: run === undefined ? null : deepCopy(run.parameters),
      samples: samples.length,
      cold: samples.filter((sample) => sample.cache === 'cold').length,
      warm: samples.filter((sample) => sample.cache === 'warm').length,
    };
  });
  const runsMet = runs.every((run) => run.run_id !== null && run.duration_seconds !== null && run.duration_seconds > 0);

  const latency = latencySection(configuration, state);
  const freshness = freshnessSection(configuration, state);
  const failures = {
    samples: measured.length,
    unexpected: measured.filter((sample) => sample.outcome !== 'succeeded').length,
    critical: measured.filter((sample) => /AUTHORIZATION|ISOLATION|PROVENANCE|CORRECTNESS/u.test(sample.outcome)).length,
    ceiling: configuration.envelope.maximum_unexpected_failure_rate,
  };
  const failureRate = failures.samples === 0 ? 0 : failures.unexpected / failures.samples;
  const failuresMet = failures.samples > 0
    && failureRate < configuration.envelope.maximum_unexpected_failure_rate
    && failures.critical === 0;

  const observedEnvelope = state.envelope;
  const checks: Record<string, Record<string, unknown>> = {};
  let envelopeMet = observedEnvelope !== null;
  if (observedEnvelope !== null) {
    // Only what was really observed is stated: an unobserved volume is reported
    // as absent rather than claimed as zero.
    const value = (key: string): number | null =>
      Object.hasOwn(observedEnvelope.values, key) ? observedEnvelope.values[key]! : null;
    const ceiling = (key: keyof OperationsEnvelope, observedKey: string): void => {
      const observed = value(observedKey);
      if (observed === null) return;
      const limit = configuration.envelope[key] as number;
      const met = observed <= limit;
      checks[observedKey] = { observed, limit, met };
      if (!met) envelopeMet = false;
    };
    const floor = (key: keyof OperationsEnvelope, observedKey: string): void => {
      const observed = value(observedKey);
      if (observed === null) return;
      const limit = configuration.envelope[key] as number;
      const met = observed >= limit;
      checks[observedKey] = { observed, minimum: limit, met };
      if (!met) envelopeMet = false;
    };
    floor('minimum_ssd_free_percent', 'ssd_free_percent');
    ceiling('maximum_total_storage_bytes', 'total_storage_bytes');
    ceiling('maximum_raw_payload_bytes', 'raw_payload_bytes');
    ceiling('maximum_curated_records', 'curated_records');
    ceiling('maximum_curated_documents', 'curated_documents');
    ceiling('maximum_cpu_p95_percent', 'cpu_p95_percent');
    ceiling('maximum_memory_p95_percent', 'memory_p95_percent');
    ceiling('maximum_oom_kills', 'oom_kills');
    ceiling('maximum_swap_thrash', 'swap_thrash');
  }

  const usage = usageView(root, generatedAt) as unknown as {
    budgets: { operating: { cost_cny: number; ceiling_cny: number; met: boolean } };
  };
  const firstRun = state.runs
    .map((run) => Date.parse(run.started_at))
    .filter((instant) => !Number.isNaN(instant))
    .sort((left, right) => left - right)[0];
  const certificationCost = firstRun === undefined
    ? 0
    : Number(state.usage
      .filter((entry) => Date.parse(entry.at) >= firstRun)
      .reduce((total, entry) => total + entry.cost_cny, 0)
      .toFixed(6));
  const certificationMet = certificationCost <= configuration.budgets.certification_cny;

  const met = workloadMet && runsMet && latency.met && freshness.met
    && failuresMet && envelopeMet && usage.budgets.operating.met && certificationMet;
  return {
    generated_at: generatedAt,
    workload: {
      required: { ...MIXED_WORKLOAD },
      windows: Object.fromEntries(MEASUREMENT_WINDOWS.map((window) => [window, countsOf(window)])),
      met: workloadMet,
    },
    runs: { required: [...measuredWindows], observed: runs, met: runsMet },
    latency: latency.operations,
    latency_met: latency.met,
    freshness: freshness.operations,
    freshness_met: freshness.met,
    failures: {
      ...failures,
      rate: Number(failureRate.toFixed(6)),
      met: failuresMet,
    },
    envelope: {
      observed_at: observedEnvelope?.observed_at ?? null,
      checks,
      met: envelopeMet,
    },
    budgets: {
      operating: { ...usage.budgets.operating },
      certification: {
        cost_cny: certificationCost,
        ceiling_cny: configuration.budgets.certification_cny,
        met: certificationMet,
      },
    },
    met,
  };
}
