import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  commandAsync,
  type CommandResult,
} from '../support/async-command.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  publishLedgerProduct,
} from '../support/data-product.js';
import {
  MOCK_MODEL_ID,
  startMockModelEndpoint,
  type MockModelEndpoint,
} from '../support/model-endpoint.js';
import {
  command,
  jsonFile,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

const PURPOSES = ['query_plan', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['product_contract', 'sample_records'];
const PROMPTS = {
  query_plan: '你是数据产品查询规划器，只输出简体中文解释，并且只使用受治理契约发布的字段、维度、指标和算子。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据或因果。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

interface Surface extends WorkspaceFixture {
  dataProductId: string;
  endpoint: MockModelEndpoint;
  bindingId: string;
}

interface Output extends Record<string, unknown> {
  outcome: string;
  executed: boolean;
  result: Record<string, unknown> | null;
  answer: Record<string, unknown> | null;
  summary: string;
  limitations: string[];
}

function asOutput(result: CommandResult): Output {
  assert.equal(result.status, 0, result.stderr);
  return result.output as Output;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function profileConfig(endpoint: MockModelEndpoint): Record<string, unknown> {
  return {
    adapter: 'generic_local',
    endpoint_url: endpoint.url,
    model_id: MOCK_MODEL_ID,
    purposes: [...PURPOSES],
    data_categories: [...DATA_CATEGORIES],
    tools: [],
    max_output_bytes: 65_536,
    prompts: { ...PROMPTS },
  };
}

/**
 * One Workspace holding a published ledger, one Consumer, and one activated
 * Model Profile bound for query planning, narration, and clarification.
 */
async function readySurface(options: { contract?: unknown } = {}): Promise<Surface> {
  const base = options.contract === undefined
    ? publishLedgerProduct()
    : publishLedgerProduct(options.contract);
  const endpoint = await startMockModelEndpoint();
  const published = command(
    base.fixture,
    ['model', 'publish', '--name', '自然语言查询模型', '--config', jsonFile(base.fixture, 'nlq-profile', profileConfig(endpoint))],
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
      '--config', jsonFile(base.fixture, 'nlq-binding', {
        model_profile_version: version,
        purposes: [...PURPOSES],
        data_categories: [...DATA_CATEGORIES],
      }),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  return {
    ...base,
    dataProductId: base.dataProductId,
    endpoint,
    bindingId: String(bound.output['binding_id']),
  };
}

function ask(s: Surface, args: string[]): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['product', 'ask', '--product', s.dataProductId, ...args],
    { token: s.consumerToken },
  );
}

function dataProductAudits(fixture: PlatformFixture): number {
  const lines = readFileSync(join(fixture.root, 'audit', 'events.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['action'] === 'data_product_query')
    .length;
}

test('NLQ gives the model only the authorized Contract and refuses a plan that carries executable code', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // A Grant withholds settled_amount and the metric aggregated over it.
  const grant = command(
    s.fixture,
    [
      'grant', 'publish',
      '--product', s.dataProductId,
      '--username', 'analyst@example.invalid',
      '--request', jsonFile(s.fixture, 'nlq-grant', {
        columns: ['sn', 'city', 'handled_count', 'reported_on'],
        row_filters: [],
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(grant.status, 0, grant.stderr);

  const answered = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的处理量合计是多少？']));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));

  // The model only ever receives the effective authorized metadata.
  const planCall = s.endpoint.calls.find((call) => call['purpose'] === 'query_plan');
  assert.ok(planCall, 'the model received one query plan request');
  const contract = asRecord(asRecord(planCall['input'])['contract']);
  const serialized = JSON.stringify(contract);
  assert.equal(serialized.includes('settled_amount'), false, 'a Grant-hidden field never reaches the model');
  assert.equal(serialized.includes('settled_total'), false, 'a Grant-hidden metric never reaches the model');
  assert.equal(serialized.includes('grain'), false, 'the model sees no Dataset grain');
  assert.deepEqual(
    (contract['metrics'] as Array<Record<string, unknown>>).map((metric) => metric['name']).sort(),
    ['device_count', 'handled_total'],
  );
  assert.deepEqual(contract['dimensions'], ['city']);

  const auditsBefore = dataProductAudits(s.fixture);

  // A plan carrying SQL is refused before the deterministic engine is reached.
  s.endpoint.behaviour = 'sql_plan';
  const sql = asOutput(await ask(s, ['--question', '请用 SQL 查询 2026 年 1 月的处理量']));
  assert.equal(sql.outcome, 'refused', JSON.stringify(sql));
  assert.equal(sql.executed, false);
  assert.equal(sql.result, null);
  assert.equal(sql.answer, null);
  assert.ok(sql.limitations.length > 0);
  assert.equal(dataProductAudits(s.fixture), auditsBefore, 'a refused plan never reaches the deterministic query engine');

  // A request key the Contract does not publish is refused the same way.
  s.endpoint.behaviour = 'unknown_key_plan';
  const unknown = asOutput(await ask(s, ['--question', '读取 2026 年 1 月的设备记录']));
  assert.equal(unknown.outcome, 'refused', JSON.stringify(unknown));
  assert.equal(unknown.executed, false);
  assert.equal(unknown.result, null);
  assert.equal(dataProductAudits(s.fixture), auditsBefore, 'an unpublished request key never reaches the engine');
});

test('NLQ asks a targeted clarification before executing and discloses governed defaults', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());
  const auditsBefore = dataProductAudits(s.fixture);

  // A missing period is material: nothing executes and no number comes back.
  const missingPeriod = asOutput(await ask(s, ['--question', '杭州的处理量合计是多少？']));
  assert.equal(missingPeriod.outcome, 'clarification', JSON.stringify(missingPeriod));
  assert.equal(missingPeriod.executed, false);
  assert.equal(missingPeriod.result, null);
  assert.equal(missingPeriod.answer, null);
  const period = asRecord(missingPeriod.clarification);
  assert.deepEqual(period['missing'], ['period']);
  const periodQuestion = String(period['question'] ?? '');
  assert.ok((periodQuestion.match(/[\u4e00-\u9fff]/gu) ?? []).length >= 6, periodQuestion);
  assert.match(periodQuestion, /时间范围/u);
  assert.equal(dataProductAudits(s.fixture), auditsBefore, 'a clarification executes nothing');

  // The clarification is asked in Chinese, targeted by its missing kind.
  const clarifyCall = s.endpoint.calls.filter((call) => call['purpose'] === 'clarification').at(-1);
  assert.ok(clarifyCall, 'the model was asked for a clarification');
  assert.deepEqual(asRecord(clarifyCall['input'])['missing'], ['period']);

  // Answering the clarification supplies the period and the query executes.
  const answered = asOutput(await ask(s, ['--question', '杭州的处理量合计是多少？', '--clarification', '2026-01-01 至 2026-01-31']));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  const auditsAfterAnswer = dataProductAudits(s.fixture);
  assert.equal(auditsAfterAnswer, auditsBefore + 1, 'the answered turn executed exactly one governed read');
  const defaults = answered.defaults_applied as Array<Record<string, unknown>>;
  assert.ok(defaults.some((entry) => entry['name'] === 'limit' && entry['value'] === 100), 'the applied limit is disclosed');
  assert.equal(defaults.some((entry) => entry['name'] === 'window'), false, 'an explicit window is not a default');
  assert.ok((answered.limitations as string[]).some((line) => line.includes('默认值')), 'the answer states the defaults it applied');

  // An unresolved metric is material even when the model itself asks.
  s.endpoint.behaviour = 'clarify_metric';
  const metric = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的合计是多少？']));
  assert.equal(metric.outcome, 'clarification', JSON.stringify(metric));
  assert.deepEqual(asRecord(metric.clarification)['missing'], ['metric']);
  assert.deepEqual(asRecord(metric.clarification)['candidates'], ['device_count', 'handled_total', 'settled_total']);
  assert.equal(metric.executed, false);
  assert.equal(metric.result, null);

  // An unresolved grouping dimension is material as well.
  s.endpoint.behaviour = 'clarify_dimension';
  const dimension = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 各城市的处理量合计是多少？']));
  assert.equal(dimension.outcome, 'clarification', JSON.stringify(dimension));
  assert.deepEqual(asRecord(dimension.clarification)['missing'], ['dimension']);
  assert.deepEqual(asRecord(dimension.clarification)['candidates'], ['city']);

  assert.equal(dataProductAudits(s.fixture), auditsAfterAnswer, 'no clarification executes a governed read');

  // A plan that states no metric is resolved by a disclosed governed default.
  s.endpoint.behaviour = 'omitted_metrics_plan';
  const allMetrics = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的全部指标合计是多少？']));
  assert.equal(allMetrics.outcome, 'answered', JSON.stringify(allMetrics));
  const applied = allMetrics.defaults_applied as Array<Record<string, unknown>>;
  const metricDefault = applied.find((entry) => entry['name'] === 'metrics');
  assert.ok(metricDefault, 'the applied metric default is disclosed');
  assert.deepEqual(metricDefault['value'], ['device_count', 'handled_total', 'settled_total']);
  const totalsDefault = applied.find((entry) => entry['name'] === 'include_totals');
  assert.ok(totalsDefault, 'the applied totals default is disclosed');
  assert.equal(totalsDefault['value'], true);
});

// The remaining acceptance criteria are added one at a time, each red before green.
void EXTENDED_LEDGER_CONTRACT;
