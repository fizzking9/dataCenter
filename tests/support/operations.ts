import assert from 'node:assert/strict';
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { askDataProduct } from '../../src/natural-language-query.js';
import { queryDataProduct } from '../../src/product-query.js';
import { generateTemplateReport as generateReportFromTemplate, showReport } from '../../src/reports.js';
import { commandAsync, type CommandResult } from './async-command.js';
import { EXTENDED_LEDGER_CONTRACT, publishLedgerProduct } from './data-product.js';
import { callTool } from './mcp.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from './model-endpoint.js';
import { command, jsonFile, type PlatformFixture, type WorkspaceFixture } from './platform.js';

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
}

/** The MCP surface a workload measures beside the CLI's direct API. */
export interface WorkloadMcp {
  url: string;
  token: string;
  workspaceId: string;
  dataProductId: string;
  /** States whatever the MCP server last reported when a call cannot connect. */
  errors?: () => string;
}

/** One scheduled acquisition the harness keeps active beside the Consumer load. */
export interface WorkloadAcquisition {
  sourceId: string;
  /** The instant the schedule is ticked at, so each scaled window is due once. */
  at: string;
}

async function timed(
  operation: string,
  operationClass: string,
  cache: 'cold' | 'warm',
  run: () => Promise<boolean>,
): Promise<WorkloadSample> {
  const started = performance.now();
  let ok = false;
  try {
    ok = await run();
  } catch {
    ok = false;
  }
  return {
    operation,
    operation_class: operationClass,
    cache,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
    outcome: ok ? 'succeeded' : 'OPERATION_FAILED',
  };
}

/**
 * Runs the exact twenty-operation mixed Consumer load of section 15 — twelve
 * direct API/MCP queries, four stored Report reads, two Natural-Language
 * Queries, and two Report generations — while a scheduled acquisition keeps
 * working. Every duration is the wall clock of the operation that really ran.
 *
 * The CLI is a single-writer surface over one Deployment's state, so the
 * harness issues the twenty operations one after another; the twenty-operation
 * occupancy itself is what the admission controls certify.
 */
export async function runMixedWorkload(
  surface: OperationsSurface,
  options: { cache: 'cold' | 'warm'; mcp?: WorkloadMcp; acquisition?: WorkloadAcquisition },
): Promise<WorkloadSample[]> {
  const { fixture, consumerToken, workspaceAdministratorToken } = surface;
  const query = {
    kind: 'aggregate',
    metrics: ['handled_total'],
    window: { start: '2026-01-05', end: '2026-01-20' },
    include_totals: true,
    limit: 100,
  };
  const queryPath = jsonFile(fixture, `workload-query-${options.cache}`, query);
  // Section 15 measures server-side elapsed time, so the direct operations call
  // the platform itself rather than paying a CLI process's start-up cost.
  const directApi = (): Record<string, unknown> => queryDataProduct({
    root: fixture.root,
    masterKey: fixture.masterKey,
    token: consumerToken,
    dataProductId: surface.dataProductId,
    requestPath: queryPath,
  });
  const directMcp = async (): Promise<boolean> => {
    const mcp = options.mcp!;
    try {
      const answered = await callTool(mcp.url, mcp.token, 'query_data_product', {
        workspace_id: mcp.workspaceId,
        data_product_id: mcp.dataProductId,
        query,
      });
      return answered.status === 200 && answered.body['isError'] !== true;
    } catch (error) {
      const detail = mcp.errors?.() ?? '';
      throw new Error(`the MCP surface could not be reached: ${String(error)}${detail === '' ? '' : ` (${detail})`}`);
    }
  };
  const tasks: Array<() => Promise<WorkloadSample>> = [];
  for (let index = 0; index < 12; index += 1) {
    const useMcp = options.mcp !== undefined && index % 3 === 0;
    tasks.push(() => timed(
      useMcp ? 'mcp_query' : 'api_query',
      'direct',
      options.cache,
      useMcp ? directMcp : async () => {
        directApi();
        return true;
      },
    ));
  }
  for (let index = 0; index < 4; index += 1) {
    tasks.push(() => timed('report_read', 'report_read', options.cache, async () => {
      showReport({
        root: fixture.root,
        masterKey: fixture.masterKey,
        token: consumerToken,
        reportId: surface.reportId,
      });
      return true;
    }));
  }
  for (let index = 0; index < 2; index += 1) {
    tasks.push(() => timed('nlq', 'nlq', options.cache, async () => {
      const asked = await askDataProduct({
        root: fixture.root,
        masterKey: fixture.masterKey,
        token: consumerToken,
        dataProductId: surface.dataProductId,
        question: OPERATIONS_ASK_QUESTION,
      });
      return asked['outcome'] === 'answered';
    }));
  }
  for (let index = 0; index < 2; index += 1) {
    tasks.push(() => timed('report_generation', 'report_generation', options.cache, async () => {
      await generateReportFromTemplate({
        root: fixture.root,
        masterKey: fixture.masterKey,
        token: workspaceAdministratorToken,
        reportTemplateId: surface.templateId,
      });
      return true;
    }));
  }

  // Scheduled acquisition runs beside the Consumer load; its publication
  // freshness is read from the Source's own measured target report afterwards.
  let acquisition: WorkloadSample | null = null;
  if (options.acquisition !== undefined) {
    const { sourceId, at } = options.acquisition;
    acquisition = await (async (): Promise<WorkloadSample> => {
      const started = performance.now();
      const ticked = command(fixture, ['acquisition', 'tick', '--at', at], { token: workspaceAdministratorToken });
      assert.equal(ticked.status, 0, ticked.stderr);
      const worked = await commandAsync(
        fixture,
        ['acquisition', 'work', '--source', sourceId, '--at', at],
        { token: workspaceAdministratorToken },
      );
      const targeted = command(fixture, ['acquisition', 'targets', '--source', sourceId], { token: workspaceAdministratorToken });
      assert.equal(targeted.status, 0, targeted.stderr);
      const runs = (targeted.output['runs'] ?? []) as Array<Record<string, unknown>>;
      const latest = runs.at(-1);
      return {
        operation: 'acquisition_run',
        operation_class: 'acquisition',
        cache: options.cache,
        elapsed_ms: Number((performance.now() - started).toFixed(3)),
        outcome: worked.status === 0 && worked.output['status'] === 'complete' ? 'succeeded' : 'OPERATION_FAILED',
        freshness_seconds: typeof latest?.['publication_latency_seconds'] === 'number'
          ? latest['publication_latency_seconds'] as number
          : null,
      };
    })();
  }
  const samples: WorkloadSample[] = [];
  for (const task of tasks) samples.push(await task());
  if (acquisition !== null) samples.push(acquisition);
  return samples;
}

/** Records one measured window exactly as the harness observed it. */
export function recordWorkloadRun(
  fixture: PlatformFixture,
  token: string,
  run: { runId: string; window: string; startedAt: string; finishedAt: string; parameters: Record<string, unknown> },
  samples: WorkloadSample[],
): Record<string, unknown> {
  const result = command(
    fixture,
    [
      'operations', 'measure',
      '--run', run.runId,
      '--window', run.window,
      '--samples', jsonFile(fixture, `samples-${run.window}`, {
        parameters: run.parameters,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        samples,
      }),
    ],
    { token },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output;
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
