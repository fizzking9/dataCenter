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


/** The only Latin tokens new copy may cite: governed identifiers and acronyms. */
const LATIN_TOKENS = [
  'include_totals', 'settled_average', 'handled_total', 'settled_total', 'device_count',
  'limit', 'metrics', 'window', 'SQL', 'SN', 'CNY',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The governed half of an engine result: every number and every comparison,
 * with cache bookkeeping left out because a cache hit changes no number.
 */
function governedNumbers(result: Record<string, unknown>): Record<string, unknown> {
  const groups = Array.isArray(result['groups']) ? result['groups'].filter(isRecord) : [];
  const metrics = Array.isArray(result['metrics']) ? result['metrics'].filter(isRecord) : [];
  return {
    kind: result['kind'] ?? null,
    metrics: metrics.map((metric) => metric['name'] ?? null),
    grouped_by: result['grouped_by'] ?? null,
    groups_total: result['groups_total'] ?? null,
    returned: result['returned'] ?? null,
    groups: groups.map((group) => ({
      group: group['group'] ?? null,
      metrics: group['metrics'] ?? null,
      comparison: group['comparison'] ?? null,
    })),
    totals: result['totals'] ?? null,
    window: result['window'] ?? null,
    comparison_window: result['comparison_window'] ?? null,
  };
}

/** Every numeric token a reader could take as a fact, normalized for comparison. */
function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/gu) ?? []).map((token) => String(Number(token)));
}

test('NLQ computes every number and comparison deterministically and drops unsupported narrative claims', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // A comparison question: the engine computes both windows, the model only phrased it.
  const answered = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 相比 2025-12-01 至 2025-12-31 各城市的处理量合计是多少？']));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  const result = asRecord(answered.result);
  const query = asRecord(answered.query);
  assert.equal(query['kind'], 'aggregate');
  assert.ok(isRecord(query['comparison']), 'the comparison window is part of the compiled request');
  assert.equal(asRecord(answered.resolved)['comparison_window'] !== null, true, 'the resolved comparison window is disclosed');

  // The strongest check: the same request through the deterministic engine
  // returns exactly the numbers the answer carries.
  const direct = command(s.fixture, ['product', 'query', '--product', s.dataProductId, '--request', jsonFile(s.fixture, 'nlq-compiled', query)], { token: s.consumerToken });
  assert.equal(direct.status, 0, direct.stderr);
  const directResult = direct.output as Record<string, unknown>;
  assert.deepEqual(
    governedNumbers(result),
    governedNumbers(directResult),
    'every number and comparison equals what the deterministic engine computes for the compiled request',
  );
  const groups = (result['groups'] as Array<Record<string, unknown>>);
  assert.ok(groups.length > 0, 'the comparison produced governed groups');
  assert.ok(groups.every((group) => isRecord(group['comparison'])), 'each group carries a computed comparison');

  // The narrative may only restate governed numbers, never add one.
  const answer = asRecord(answered.answer);
  const narrative = String(answer['narrative'] ?? '');
  assert.match(narrative, /根据证据/u);
  const stated = numbersIn(narrative);
  assert.ok(stated.length > 0, 'the narrative states a number');
  const governed = new Set(numbersIn(JSON.stringify(governedNumbers(result))));
  for (const token of stated) {
    assert.ok(governed.has(token), `the narrative number ${token} is governed by the engine result`);
  }

  // A causal claim is unsupported by evidence and is never published.
  s.endpoint.behaviour = 'causal_narration';
  const causal = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的处理量合计是多少？']));
  assert.equal(causal.outcome, 'answered', JSON.stringify(causal));
  assert.equal(causal.answer, null, 'a causal claim is dropped rather than published');
  assert.equal(causal.reason_code, 'NARRATIVE_CAUSAL_CLAIM');
  assert.ok((causal.limitations as string[]).some((line) => line.includes('因果')), 'the dropped narrative is disclosed');
  assert.notEqual(asRecord(causal.result)['groups'], undefined, 'the deterministic answer still stands without the narrative');

  // A number the evidence does not contain is dropped the same way.
  s.endpoint.behaviour = 'fabricated_narration';
  const fabricated = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的处理量合计是多少？']));
  assert.equal(fabricated.outcome, 'answered', JSON.stringify(fabricated));
  assert.equal(fabricated.answer, null, 'an ungoverned number is dropped rather than published');
  assert.equal(fabricated.reason_code, 'NARRATIVE_NUMBER_NOT_GOVERNED');
  assert.ok((fabricated.limitations as string[]).some((line) => line.includes('证据之外的数值')), 'the dropped number is disclosed');
});

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

test('NLQ returns a distinct structured outcome and limitation for empty, no-evidence, unavailable, and refused turns', async (t) => {
  const s = await readySurface({ contract: EXTENDED_LEDGER_CONTRACT });
  t.after(() => s.endpoint.close());

  // Empty: the window holds no rows, so no number is invented.
  const empty = asOutput(await ask(s, ['--question', '2024-01-01 至 2024-01-31 杭州的处理量合计是多少？']));
  assert.equal(empty.outcome, 'empty', JSON.stringify(empty));
  assert.equal(empty.executed, true);
  assert.equal(empty.reason_code, 'NLQ_EMPTY_RESULT');
  assert.equal(asRecord(empty.result)['groups_total'], 0);
  assert.equal(empty.answer, null, 'an empty window never yields a narrated zero');
  assert.ok((empty.limitations as string[]).some((line) => line.includes('没有记录')), 'the empty case states its limitation');

  // No evidence: rows match, but the governed metric carries no value.
  const noEvidence = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 无证据的平均结算金额是多少？']));
  assert.equal(noEvidence.outcome, 'no_evidence', JSON.stringify(noEvidence));
  assert.equal(noEvidence.executed, true);
  assert.equal(noEvidence.reason_code, 'NLQ_NO_EVIDENCE');
  assert.equal(noEvidence.answer, null);
  const evidenceGroup = (asRecord(noEvidence.result)['groups'] as Array<Record<string, unknown>>)[0];
  assert.ok(evidenceGroup, 'the no-evidence read still returns its governed group');
  assert.equal(asRecord(evidenceGroup['metrics'])['settled_average'], null, 'a missing value is never rendered as a zero');
  assert.ok((noEvidence.limitations as string[]).some((line) => line.includes('没有可引用的数值')), 'the no-evidence case states its limitation');

  // Refused: the plan asks for a metric the Contract does not publish.
  s.endpoint.behaviour = 'unpublished_metric_plan';
  const refused = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的平均结算金额合计是多少？']));
  assert.equal(refused.outcome, 'refused', JSON.stringify(refused));
  assert.equal(refused.executed, false);
  assert.equal(refused.reason_code, 'NLQ_METRIC_NOT_PUBLISHED');
  assert.equal(refused.result, null);
  assert.equal(refused.answer, null);
  assert.ok((refused.limitations as string[]).some((line) => line.includes('已发布契约')), 'the refused case states its limitation');

  // Unavailable: the pinned endpoint no longer answers, so nothing executes.
  await s.endpoint.close();
  const unavailable = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的处理量合计是多少？']));
  assert.equal(unavailable.outcome, 'unavailable', JSON.stringify(unavailable));
  assert.equal(unavailable.executed, false);
  assert.equal(unavailable.result, null);
  assert.equal(unavailable.answer, null);
  assert.equal(unavailable.reason_code, 'MODEL_ENDPOINT_UNREACHABLE');
  assert.ok((unavailable.limitations as string[]).some((line) => line.includes('不可用')), 'the unavailable case states its limitation');

  // Four distinct outcomes, each a structured answer rather than an error page.
  const outcomes = [empty.outcome, noEvidence.outcome, refused.outcome, unavailable.outcome];
  assert.equal(new Set(outcomes).size, 4, 'empty, no evidence, refused, and unavailable stay distinct');
  for (const turn of [empty, noEvidence, refused, unavailable]) {
    assert.ok((turn.limitations as string[]).length > 0, `${turn.outcome} states an explicit limitation`);
    assert.ok((turn.limitations as string[]).every((line) => (line.match(/[\u4e00-\u9fff]/gu) ?? []).length >= 4), `${turn.outcome} states it in Chinese`);
  }
});

test('NLQ discloses the resolved interpretation, filters, window, Release, Provenance, freshness, and partial period', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // The window runs past the Release's coverage, so the answer is partial.
  const partial = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-02-28 杭州的处理量合计是多少？']));
  assert.equal(partial.outcome, 'answered', JSON.stringify(partial));
  assert.equal(partial.partial_period, true, 'a window past the data is reported as partial');

  // The resolved interpretation is the same one the model stated, not a rewrite.
  const resolved = asRecord(partial.resolved);
  assert.equal(typeof resolved['interpretation'], 'string');
  assert.ok(String(resolved['interpretation']).length > 0, 'the resolved interpretation is stated');
  assert.equal(resolved['interpretation'], partial.interpretation, 'the resolved interpretation is the one the model stated');
  assert.deepEqual(resolved['metrics'], ['handled_total'], 'the resolved metric is named');
  assert.deepEqual(resolved['dimensions'], [], 'the resolved grouping is named');
  assert.deepEqual(resolved['filters'], [{ field: 'city', op: 'equals', value: '杭州' }], 'the resolved filter is named');

  // The queried and resolved windows agree, coverage included.
  const window = asRecord(resolved['window']);
  assert.equal(window['start'], '2026-01-01');
  assert.equal(window['end'], '2026-02-28');
  assert.equal(window['partial'], true);
  assert.equal(asRecord(window['coverage'])['end'], '2026-01-20', 'coverage names the last governed day');
  assert.deepEqual(partial.window, window, 'the top-level window is the resolved window');
  assert.deepEqual(asRecord(partial.result)['window'], window, 'the engine result carries the same window');
  assert.deepEqual(resolved['defaults_applied'], partial.defaults_applied);

  // Release and Provenance come from the executed read itself.
  const release = asRecord(partial.data_product);
  const engineResult = asRecord(partial.result);
  assert.equal(typeof release['data_product_release'], 'number');
  assert.equal(release['data_product_release'], engineResult['data_product_release']);
  assert.equal(release['dataset_release'], asRecord(engineResult['provenance'])['dataset_release'], 'the Release names the Dataset Release the read used');
  assert.equal(typeof release['contract_hash'], 'string');
  assert.deepEqual(partial.provenance, engineResult['provenance'], 'Provenance is the executed read Provenance');
  const provenance = asRecord(partial.provenance);
  assert.equal(typeof provenance['released_at'], 'string');
  assert.equal(typeof provenance['acquired_at'], 'string');
  assert.equal(typeof provenance['integrated_at'], 'string');
  assert.ok(String(provenance['source'] && asRecord(provenance['source'])['name']).length > 0);

  // Freshness states how far the data actually reaches, and the partial status is called out.
  const freshness = asRecord(partial.freshness);
  assert.equal(freshness['data_through'], '2026-01-20');
  assert.equal(freshness['released_at'], provenance['released_at']);
  assert.ok((partial.limitations as string[]).some((line) => line.includes('部分期间')), 'the partial period is stated as a limitation');

  // A window inside coverage is complete, so the partial status clears.
  const complete = asOutput(await ask(s, ['--question', '2026-01-05 至 2026-01-20 杭州的处理量合计是多少？']));
  assert.equal(complete.outcome, 'answered', JSON.stringify(complete));
  assert.equal(complete.partial_period, false, 'a window inside coverage is not partial');
  assert.equal(asRecord(complete.resolved)['partial_period'], false);
  assert.equal((complete.limitations as string[]).some((line) => line.includes('部分期间')), false);
});

/** Counts the Han characters in a string, so copy checks need no locale data. */
function hanCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) count += 1;
  }
  return count;
}

/** Copy is Chinese when no English word survives once governed identifiers are set aside. */
function assertChineseCopy(text: string, label: string): void {
  assert.equal(typeof text, 'string', `${label} is a string`);
  let rest = text;
  for (const token of LATIN_TOKENS) rest = rest.split(token).join(' ');
  assert.ok(hanCount(rest) >= 4, `${label} is written in Chinese: ${text}`);
  assert.equal(/[A-Za-z]/u.test(rest), false, `${label} carries no English prose: ${text}`);
}

test('NLQ writes every new piece of user-facing copy in Simplified Chinese', async (t) => {
  const s = await readySurface({ contract: EXTENDED_LEDGER_CONTRACT });
  t.after(() => s.endpoint.close());

  const answered = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 各城市的处理量合计是多少？']));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  assertChineseCopy(answered.summary, 'the answered summary');
  assertChineseCopy(String(answered.interpretation), 'the resolved interpretation');
  assertChineseCopy(String(asRecord(answered.answer)['narrative']), 'the grounded narrative');

  const clarified = asOutput(await ask(s, ['--question', '杭州的处理量合计是多少？']));
  assert.equal(clarified.outcome, 'clarification', JSON.stringify(clarified));
  assertChineseCopy(String(asRecord(clarified.clarification)['question']), 'the clarification question');
  assertChineseCopy(clarified.summary, 'the clarification summary');

  const empty = asOutput(await ask(s, ['--question', '2024-01-01 至 2024-01-31 杭州的处理量合计是多少？']));
  assert.equal(empty.outcome, 'empty', JSON.stringify(empty));
  assertChineseCopy(empty.summary, 'the empty summary');

  // An English plan is refused, and its English prose never reaches the consumer.
  s.endpoint.behaviour = 'english_plan';
  const english = asOutput(await ask(s, ['--question', '2026-01-01 至 2026-01-31 杭州的处理量合计是多少？']));
  assert.equal(english.outcome, 'refused', JSON.stringify(english));
  assert.equal(english.reason_code, 'QUERY_PLAN_NOT_SIMPLIFIED_CHINESE');
  assert.equal(english.interpretation, null, 'an English interpretation is not echoed back');
  assert.equal(JSON.stringify(english).includes('Summarise'), false, 'no English model prose reaches the consumer');
  assertChineseCopy(english.summary, 'the refused summary');

  // Every structured limitation of every turn is Chinese too.
  for (const turn of [answered, clarified, empty, english]) {
    const limitations = turn.limitations as string[];
    assert.ok(limitations.length > 0, `${turn.outcome} states a limitation`);
    for (const line of limitations) {
      assertChineseCopy(line, `the ${turn.outcome} limitation`);
    }
  }
});

test('NLQ answers a Chinese question with a mixed identifier, clarifies in Chinese, and keeps every governed field unchanged', async (t) => {
  const s = await readySurface({ contract: EXTENDED_LEDGER_CONTRACT });
  t.after(() => s.endpoint.close());

  // The question is Chinese and carries a Latin device identifier verbatim.
  const answered = asOutput(await ask(s, ['--question', '请查询 SN 为 sn-002 的 2026-01-01 至 2026-01-31 处理量合计是多少？']));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  assert.deepEqual(asRecord(answered.query)['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }], 'the identifier survives unchanged');
  assert.equal(asRecord(answered.resolved)['filters'] !== null, true);
  assert.deepEqual(asRecord(answered.resolved)['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }]);

  // The narrative is Simplified Chinese and restates the governed number.
  const answer = asRecord(answered.answer);
  const narrative = String(answer['narrative'] ?? '');
  assertChineseCopy(narrative, 'the grounded narrative');
  const result = asRecord(answered.result);
  const totals = asRecord(asRecord(result['totals'])['metrics']);
  assert.equal(totals['handled_total'], 5, 'the filtered read totals the one matching device');
  assert.ok(narrative.includes(String(totals['handled_total'])), `the narrative states the governed total: ${narrative}`);

  // Chinese input changes nothing deterministic: the same compiled request
  // through the engine returns the same numbers, filters, Release, and Provenance.
  const direct = command(s.fixture, ['product', 'query', '--product', s.dataProductId, '--request', jsonFile(s.fixture, 'nlq-cn', asRecord(answered.query))], { token: s.consumerToken });
  assert.equal(direct.status, 0, direct.stderr);
  const directResult = direct.output as Record<string, unknown>;
  assert.deepEqual(governedNumbers(result), governedNumbers(directResult), 'the numbers are unchanged');
  assert.deepEqual(answered.provenance, directResult['provenance'], 'Provenance is unchanged');
  assert.deepEqual(answered.data_product && asRecord(answered.data_product)['data_product_release'], directResult['data_product_release'], 'the Release is unchanged');

  // A Chinese question missing its period is clarified in Chinese, with the
  // mixed identifier carried into the model input untouched.
  const clarified = asOutput(await ask(s, ['--question', 'SN 为 sn-002 的处理量是多少？']));
  assert.equal(clarified.outcome, 'clarification', JSON.stringify(clarified));
  assert.equal(clarified.executed, false);
  assert.deepEqual(asRecord(clarified.clarification)['missing'], ['period']);
  assertChineseCopy(String(asRecord(clarified.clarification)['question']), 'the clarification question');
  assertChineseCopy(clarified.summary, 'the clarification summary');
  const clarifyCall = s.endpoint.calls.filter((call) => call['purpose'] === 'clarification').at(-1);
  assert.ok(clarifyCall, 'the model was asked for a clarification');
  assert.ok(String(asRecord(clarifyCall['input'])['question']).includes('sn-002'), 'the identifier reaches the model unchanged');
});
