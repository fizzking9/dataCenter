import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  LEDGER,
  publishLedgerProduct,
} from '../support/data-product.js';
import {
  installedLicenseRequest,
  installLicenseFile,
  signedLicenseFor,
} from '../support/license.js';
import {
  MOCK_MODEL_ID,
  startMockModelEndpoint,
  type MockModelEndpoint,
} from '../support/model-endpoint.js';
import {
  command,
  createUser,
  grantRole,
  jsonFile,
  sessionFor,
  textFile,
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
const GROUNDED_ANSWER_PROMPT = '只依据给定证据用简体中文撰写报告叙述，不得推测证据之外的数据或因果。';
const QUESTION = '2026-01-05 至 2026-01-20 的处理量合计是多少？';

interface Surface extends WorkspaceFixture {
  sourceId: string;
  dataProductId: string;
  endpoint: MockModelEndpoint;
  bindingId: string;
  templateId: string;
  templateVersion: number;
  reportId: string;
  report: Record<string, unknown>;
}

interface Output extends Record<string, unknown> {
  outcome: string;
  status: string;
  origin: string;
  executed: boolean;
  reason_code: string | null;
  result: Record<string, unknown> | null;
  query: Record<string, unknown> | null;
  answer: Record<string, unknown> | null;
  summary: string;
  limitations: string[];
  stock: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  template: Record<string, unknown> | null;
  authorization: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  data_product: Record<string, unknown> | null;
  conversation: string | null;
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

function templateConfig(): Record<string, unknown> {
  return {
    question: QUESTION,
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

/** Publishes one Report Template and generates its first Report. */
async function publishTemplate(
  s: Surface,
  options: { name?: string; config?: Record<string, unknown> } = {},
): Promise<{ templateId: string; templateVersion: number; reportId: string; report: Record<string, unknown> }> {
  const published = command(
    s.fixture,
    [
      'report', 'template-publish',
      '--workspace', s.workspaceId,
      '--product', s.dataProductId,
      '--name', options.name ?? '日处理量报告',
      '--config', jsonFile(s.fixture, `template-${String(options.name ?? 'daily')}`, options.config ?? templateConfig()),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const templateId = String(published.output['report_template_id']);
  const templateVersion = Number(published.output['template_version']);
  const generated = await commandAsync(s.fixture, ['report', 'generate', '--template', templateId], { token: s.workspaceAdministratorToken });
  assert.equal(generated.status, 0, generated.stderr);
  const report = asRecord(generated.output['report']);
  return { templateId, templateVersion, reportId: String(report['report_id']), report };
}

/**
 * One Workspace holding a published ledger, a Consumer, one activated Model
 * Profile bound for planning, narration, and clarification, and one published
 * Report Template whose first Report is already stocked.
 */
async function readySurface(): Promise<Surface> {
  const base = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  const endpoint = await startMockModelEndpoint();
  const published = command(
    base.fixture,
    ['model', 'publish', '--name', '报告模型', '--config', jsonFile(base.fixture, 'report-profile', profileConfig(endpoint))],
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
      '--config', jsonFile(base.fixture, 'report-binding', {
        model_profile_version: version,
        purposes: [...PURPOSES],
        data_categories: [...DATA_CATEGORIES],
      }),
    ],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const surface: Surface = {
    ...base,
    sourceId: base.sourceId,
    dataProductId: base.dataProductId,
    endpoint,
    bindingId: String(bound.output['binding_id']),
    templateId: '',
    templateVersion: 0,
    reportId: '',
    report: {},
  };
  const template = await publishTemplate(surface);
  Object.assign(surface, template);
  return surface;
}

function ask(s: Surface, args: string[]): Promise<CommandResult> {
  return commandAsync(s.fixture, ['product', 'ask', '--product', s.dataProductId, ...args], { token: s.consumerToken });
}

/** Counts the Audit Events one action recorded. */
function audits(fixture: PlatformFixture, action: string): number {
  const lines = readFileSync(join(fixture.root, 'audit', 'events.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['action'] === action)
    .length;
}

/** Lists the Reports one actor currently may retrieve. */
function stockedReports(s: Surface, token: string): Array<Record<string, unknown>> {
  const listed = command(s.fixture, ['report', 'list', '--workspace', s.workspaceId], { token });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.output['reports'] as Array<Record<string, unknown>>;
}

/** The governed half of an engine result, with cache bookkeeping left out. */
function governedNumbers(result: Record<string, unknown>): Record<string, unknown> {
  const records = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => asRecordOrNull(entry) !== null) : [];
  const groups = records(result['groups']);
  const metrics = records(result['metrics']);
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

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Reads one governed metric grand total from a result, for an independent oracle. */
function totalOf(result: Record<string, unknown> | null, metric: string): unknown {
  assert.ok(result !== null, 'the answer carries a structured result');
  return asRecord(asRecord(result['totals'])['metrics'])[metric];
}

/** Answers the Report's exact pinned query through the deterministic engine. */
function directEngineRead(s: Surface, report: Record<string, unknown>): Record<string, unknown> {
  const product = asRecord(report['data_product']);
  const request = {
    ...asRecord(report['query']),
    release: product['data_product_release'],
  };
  const direct = command(
    s.fixture,
    [
      'product', 'query',
      '--product', String(product['data_product_id']),
      '--request', jsonFile(s.fixture, 'stock-direct-request', request),
    ],
    { token: s.consumerToken },
  );
  assert.equal(direct.status, 0, direct.stderr);
  return direct.output as Record<string, unknown>;
}

/** Counts the Han characters in a string, so copy checks need no locale data. */
function hanCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) count += 1;
  }
  return count;
}

const LATIN_TOKENS = [
  'handled_total', 'handled_count', 'settled_total', 'device_count',
  'include_totals', 'limit', 'metrics', 'window', 'SQL', 'SN', 'sn-002', 'sn', 'CNY',
];

function assertChineseCopy(text: string, label: string): void {
  assert.equal(typeof text, 'string', `${label} is a string`);
  let rest = text;
  for (const token of LATIN_TOKENS) rest = rest.split(token).join(' ');
  assert.ok(hanCount(rest) >= 4, `${label} is written in Chinese: ${text}`);
  assert.equal(/[A-Za-z]/u.test(rest), false, `${label} carries no English prose: ${text}`);
}

test('a Template pins normalized semantics, typed parameters, the grounded-answer prompt, freshness policy, and Owner; a Report preserves the achieved answer', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // The Template Version names its question, typed parameters, exact query,
  // grounded-answer prompt, freshness policy, and accountable Owner.
  const shown = command(s.fixture, ['report', 'template-show', '--template', s.templateId], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(shown.status, 0, shown.stderr);
  const template = shown.output as Record<string, unknown>;
  assert.equal(template['template_version'], 1);
  assert.equal(template['normalized_question'], '2026-01-05 至 2026-01-20 的处理量合计是多少?');
  assert.deepEqual(template['parameters'], [
    { name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-20' } },
  ]);
  const query = asRecord(template['query']);
  assert.equal(query['kind'], 'aggregate');
  assert.deepEqual(query['metrics'], ['handled_total']);
  assert.equal(query['major'], 1, 'the Template pins its Contract line');
  assert.deepEqual(query['window'], { start: '2026-01-05', end: '2026-01-20' });
  assert.equal(query['limit'], 100);
  const groundedPrompt = asRecord(template['grounded_prompt']);
  assert.equal(groundedPrompt['id'], 'grounded_answer');
  assert.equal(groundedPrompt['body'], GROUNDED_ANSWER_PROMPT);
  assert.match(String(groundedPrompt['hash']), /^[0-9a-f]{64}$/u);
  assert.match(String(template['grounded_prompt'] && asRecord(template['grounded_prompt'])['body']), /简体中文/u);
  assert.deepEqual(template['freshness_policy'], { max_age_minutes: 15 });
  const owner = asRecord(template['owner']);
  assert.equal(owner['username'], 'operations@example.invalid', 'the Owner is the publishing Workspace Administrator');
  assert.ok(typeof owner['user_id'] === 'string' && String(owner['user_id']).length > 0);

  // The Report preserves the exact Template, Releases, structured result,
  // optional Chinese narrative, Provenance, freshness, and completion status.
  const report = s.report;
  assert.deepEqual(report['template'], {
    report_template_id: s.templateId,
    name: '日处理量报告',
    version: 1,
    content_hash: template['content_hash'],
    owner_user_id: owner['user_id'],
  });
  const product = asRecord(report['data_product']);
  assert.equal(product['data_product_id'], s.dataProductId);
  assert.equal(product['data_product_release'], 1);
  assert.equal(product['dataset_release'], 1);
  assert.equal(typeof product['contract_hash'], 'string');
  assert.equal(report['question'], QUESTION);
  assert.deepEqual(report['parameters'], template['parameters']);
  assert.deepEqual(report['query'], query);
  const result = asRecord(report['result']);
  assert.equal(asRecord(asRecord(result['totals'])['metrics'])['handled_total'], 10);
  const narrative = asRecord(report['narrative']);
  assertChineseCopy(String(narrative['narrative']), 'the Report narrative');
  assert.equal(narrative['grounded_answer_prompt_hash'], groundedPrompt['hash']);
  const provenance = asRecord(report['provenance']);
  assert.equal(provenance['dataset_release'], 1);
  assert.equal(typeof provenance['released_at'], 'string');
  const freshness = asRecord(report['freshness']);
  assert.equal(freshness['data_through'], '2026-01-20');
  assert.deepEqual(report['completion'], {
    status: 'complete',
    outcome: 'answered',
    partial_period: false,
    truncated: false,
    limitations: [],
  });
  assert.equal(report['generated_by'], owner['user_id']);

  // The structured result is exactly what the deterministic engine computes.
  const direct = directEngineRead(s, report);
  assert.deepEqual(governedNumbers(result), governedNumbers(direct));
  assert.deepEqual(provenance, direct['provenance']);

  // The pinned grounded-answer prompt reached the narration generation.
  const narrationCall = s.endpoint.calls.filter((call) => call['purpose'] === 'grounded_narration').at(-1);
  assert.ok(narrationCall, 'the Report narrative was generated');
  const narrationInput = asRecord(narrationCall['input']);
  assert.equal(asRecord(narrationInput['grounded_answer_prompt'])['body'], GROUNDED_ANSWER_PROMPT);
  assert.equal(asRecord(narrationInput['grounded_answer_prompt'])['hash'], groundedPrompt['hash']);

  // Templates are administrator configuration, not a Consumer surface.
  const denied = command(s.fixture, ['report', 'template-show', '--template', s.templateId], { token: s.consumerToken });
  assert.equal(denied.status, 2);
  assert.equal(denied.error['code'], 'REPORT_TEMPLATE_NOT_AVAILABLE');
});

test('an exact normalized match returns stock without rerunning a query or invoking the model', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const queryAudits = audits(s.fixture, 'data_product_query');
  const generationAudits = audits(s.fixture, 'report_generation');
  const modelCalls = s.endpoint.calls.length;
  const stocked = stockedReports(s, s.workspaceAdministratorToken).length;

  // The question is the same business question with different whitespace and
  // full-width digits, so the exact normalized match still reuses the stock.
  const asked = asOutput(await ask(s, ['--question', '　２０２６-01-05 至 2026-01-20　的处理量合计是多少? ']));
  assert.equal(asked.origin, 'stock', JSON.stringify(asked));
  assert.equal(asked.outcome, 'answered');
  assert.equal(asked.executed, false, 'a stock answer reruns no Data Product Query');
  assert.equal(asked.report === null, false, 'the immutable Report is disclosed');
  assert.deepEqual(asked.report, s.report, 'stock retrieval never alters the stored Report');
  const stock = asRecord(asked.stock);
  assert.equal(stock['reused'], true);
  assert.equal(stock['report_id'], s.reportId);
  assert.equal(stock['max_age_minutes'], 15);
  assert.equal(totalOf(asked.result, 'handled_total'), 10);
  assertChineseCopy(asked.summary, 'the stock summary');
  for (const line of asked.limitations) assertChineseCopy(line, 'a stock limitation');

  // The current effective authorization is disclosed, not the stored claim.
  const authorization = asRecord(asked.authorization);
  assert.equal(authorization['workspace_id'], s.workspaceId);
  assert.equal(authorization['role'], 'Consumer');
  const parts = authorization['parts'] as Array<Record<string, unknown>>;
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!['scope_fingerprint'], asRecord(s.report['security'])['scope_fingerprint']);
  assert.equal(parts[0]!['restricted'], false);
  assert.ok(typeof asked['conversation'] === 'string' && String(asked['conversation']).length > 0, 'the turn returns a conversation handle');

  // No query, no generation, and no model call happened.
  assert.equal(audits(s.fixture, 'data_product_query'), queryAudits, 'stock reuse executed no query');
  assert.equal(audits(s.fixture, 'report_generation'), generationAudits, 'stock reuse generated no Report');
  assert.equal(s.endpoint.calls.length, modelCalls, 'stock reuse invoked no model');
  assert.equal(stockedReports(s, s.workspaceAdministratorToken).length, stocked, 'stock reuse stored nothing');

  // Reading the Report back is itself a stock read that regenerates nothing.
  const shown = command(s.fixture, ['report', 'show', '--report', s.reportId], { token: s.consumerToken });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.output['origin'], 'stock');
  assert.deepEqual(shown.output['report'], s.report);
  assert.equal(audits(s.fixture, 'data_product_query'), queryAudits);
  assert.equal(audits(s.fixture, 'report_generation'), generationAudits);
  assert.equal(s.endpoint.calls.length, modelCalls);
  assertChineseCopy(String(shown.output['summary']), 'the Report retrieval summary');
});

test('stale stock generates a fresh Report, an advanced Release invalidates stock, and an unmatched question uses the Natural-Language Query path', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const generatedAt = String(s.report['generated_at']);
  const staleAt = new Date(Date.parse(generatedAt) + 16 * 60_000).toISOString();
  const queryAudits = audits(s.fixture, 'data_product_query');
  const stocked = stockedReports(s, s.workspaceAdministratorToken).length;

  // Sixteen minutes after generation the 15-minute policy is exceeded, so the
  // matched Template generates a fresh Report and says so.
  const refreshed = asOutput(await ask(s, ['--question', QUESTION, '--at', staleAt]));
  assert.equal(refreshed.origin, 'generated', JSON.stringify(refreshed));
  assert.equal(refreshed.executed, true);
  assert.equal(refreshed.stock, null);
  assert.equal(refreshed.outcome, 'answered');
  const refresh = asRecord(refreshed['refresh']);
  assert.equal(refresh['reason'], 'stale');
  assert.equal(refresh['superseded_report_id'], s.reportId);
  const freshReport = asRecord(refreshed.report);
  assert.notEqual(freshReport['report_id'], s.reportId);
  assert.equal(totalOf(asRecord(freshReport['result']), 'handled_total'), 10);
  assert.equal(audits(s.fixture, 'data_product_query'), queryAudits + 1, 'the stale refresh executed one governed read');
  assert.equal(stockedReports(s, s.workspaceAdministratorToken).length, stocked + 1);

  // The refreshed Report is itself reusable at that instant.
  const reused = asOutput(await ask(s, ['--question', QUESTION, '--at', staleAt]));
  assert.equal(reused.origin, 'stock', JSON.stringify(reused));
  assert.equal(reused.executed, false);
  assert.equal(asRecord(reused.stock)['report_id'], freshReport['report_id']);

  // A new Data Product Release changes what the stock describes, so the exact
  // question refreshes against the new Releases instead of answering stale rows.
  const upload = command(
    s.fixture,
    ['acquisition', 'upload', '--source', s.sourceId, '--file', textFile(s.fixture, 'ledger-again.csv', LEDGER)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(s.fixture, ['dataset', 'release', '--source', s.sourceId], { token: s.workspaceAdministratorToken });
  assert.equal(released.status, 0, released.stderr);
  const republished = command(
    s.fixture,
    ['product', 'publish', '--source', s.sourceId, '--name', '设备维修台账', '--contract', jsonFile(s.fixture, 'ledger-contract-2', EXTENDED_LEDGER_CONTRACT)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(republished.status, 0, republished.stderr);
  const afterRelease = asOutput(await ask(s, ['--question', QUESTION, '--at', staleAt]));
  assert.equal(afterRelease.origin, 'generated', JSON.stringify(afterRelease));
  assert.equal(asRecord(afterRelease['refresh'])['reason'], 'stale');
  assert.equal(asRecord(asRecord(afterRelease.report)['data_product'])['data_product_release'], 2, 'the fresh Report pins the current Release');

  // A near-match with a different period is not equivalent: it takes the
  // settled Natural-Language Query path instead of reusing the wrong stock.
  const planCalls = s.endpoint.calls.filter((call) => call['purpose'] === 'query_plan').length;
  const nearMatch = asOutput(await ask(s, ['--question', '2026-01-10 至 2026-01-20 的处理量合计是多少？']));
  assert.equal(nearMatch.origin, 'generated', JSON.stringify(nearMatch));
  assert.equal(nearMatch.report, null, 'a near-match produced no stock Report');
  assert.equal(nearMatch.template, null, 'a near-match names no Template');
  assert.equal(nearMatch.executed, true);
  assert.equal(nearMatch.outcome, 'answered');
  assert.equal(
    s.endpoint.calls.filter((call) => call['purpose'] === 'query_plan').length,
    planCalls + 1,
    'the unmatched question was planned by the Natural-Language Query path',
  );
  assert.ok(asRecord(nearMatch['result']), 'the Natural-Language Query answered');

  // Publishing a new Template Version changes the semantics stock must match,
  // so the old Report is no longer reusable by the exact question.
  const republishedTemplate = command(
    s.fixture,
    [
      'report', 'template-publish',
      '--workspace', s.workspaceId,
      '--product', s.dataProductId,
      '--name', '日处理量报告',
      '--config', jsonFile(s.fixture, 'template-daily-2', {
        ...templateConfig(),
        freshness: { max_age_minutes: 30 },
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(republishedTemplate.status, 0, republishedTemplate.stderr);
  assert.equal(republishedTemplate.output['template_version'], 2);
  const afterVersion = asOutput(await ask(s, ['--question', QUESTION, '--at', staleAt]));
  assert.equal(afterVersion.origin, 'generated', JSON.stringify(afterVersion));
  assert.equal(asRecord(afterVersion.template)['version'], 2);
  assert.equal(asRecord(afterVersion['refresh'])['reason'], 'initial', 'no Report exists yet for the new Template Version');
});

test('Report retrieval and reuse reauthorize the complete current context and never expose another scope', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // A Grant hides the city and settled amount columns from the Consumer.
  const grant = command(
    s.fixture,
    [
      'grant', 'publish',
      '--product', s.dataProductId,
      '--username', 'analyst@example.invalid',
      '--request', jsonFile(s.fixture, 'report-grant', {
        columns: ['sn', 'handled_count', 'reported_on'],
        row_filters: [],
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(grant.status, 0, grant.stderr);

  // The unrestricted Report is not retrievable under a narrower Grant.
  const denied = command(s.fixture, ['report', 'show', '--report', s.reportId], { token: s.consumerToken });
  assert.equal(denied.status, 2, denied.stdout);
  assert.equal(denied.error['code'], 'REPORT_NOT_AVAILABLE');

  // The exact question does not reuse unrestricted stock; a fresh Report is
  // generated under exactly the current Grants and discloses that scope.
  const narrowed = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(narrowed.origin, 'generated', JSON.stringify(narrowed));
  const narrowedReport = asRecord(narrowed.report);
  const security = asRecord(narrowedReport['security']);
  assert.equal(security['restricted'], true);
  assert.deepEqual(security['columns'], ['sn', 'handled_count', 'reported_on']);
  const authorization = asRecord(narrowed.authorization);
  assert.equal(asRecord((authorization['parts'] as unknown[])[0])['restricted'], true);
  assert.deepEqual(asRecord((authorization['parts'] as unknown[])[0])['columns'], ['sn', 'handled_count', 'reported_on']);

  // The same actor's next exact question reuses the Report generated for that
  // same authorization, without executing anything.
  const queryAudits = audits(s.fixture, 'data_product_query');
  const reused = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(reused.origin, 'stock', JSON.stringify(reused));
  assert.equal(reused.executed, false);
  assert.equal(asRecord(reused.stock)['report_id'], narrowedReport['report_id']);
  assert.equal(audits(s.fixture, 'data_product_query'), queryAudits);

  // Discovery lists only the Report this scope may read, never the other one.
  const visible = stockedReports(s, s.consumerToken);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!['report_id'], narrowedReport['report_id']);

  // Revoking the Grant restores the wider authorization, so the unrestricted
  // stock becomes eligible again; authorization followed the actor's Grants.
  const revoked = command(s.fixture, ['grant', 'revoke', '--grant', String(grant.output['grant_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(revoked.status, 0, revoked.stderr);
  const widened = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(widened.origin, 'stock', JSON.stringify(widened));
  assert.equal(widened.executed, false);
  assert.equal(asRecord(widened.stock)['report_id'], s.reportId, 'the restored scope reuses its own stocked Report');
  assert.equal(asRecord(widened.authorization)['role'], 'Consumer');
  assert.equal(asRecord((asRecord(widened.authorization)['parts'] as unknown[])[0])['restricted'], false);

  // A revoked membership is denied before any Report is disclosed.
  const membership = command(
    s.fixture,
    ['membership', 'revoke', '--workspace', s.workspaceId, '--username', 'analyst@example.invalid'],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(membership.status, 0, membership.stderr);
  const gone = await ask(s, ['--question', QUESTION]);
  assert.equal(gone.status, 2, gone.stdout);
  assert.equal(gone.error['code'], 'DATA_PRODUCT_NOT_AVAILABLE');
});

test('Chinese questions with a mixed SN identifier reuse stock while numbers, filters, Releases, and Provenance stay deterministic', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const snQuestion = 'SN 为 sn-002 的 2026-01-05 至 2026-01-12 处理量合计是多少？';
  const snTemplate = await publishTemplate(s, {
    name: 'SN 对账报告',
    config: {
      question: snQuestion,
      parameters: [
        { name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-12' } },
        { name: 'sn', type: 'string', value: 'sn-002' },
      ],
      query: {
        kind: 'aggregate',
        metrics: ['handled_total'],
        filters: [{ field: 'sn', op: 'equals', value: 'sn-002' }],
        window: { start: '2026-01-05', end: '2026-01-12' },
        include_totals: true,
        limit: 100,
      },
      grounded_prompt: GROUNDED_ANSWER_PROMPT,
      freshness: { max_age_minutes: 15 },
    },
  });
  const report = snTemplate.report;
  const query = asRecord(report['query']);
  assert.deepEqual(query['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }], 'the identifier is pinned unchanged');
  assert.deepEqual(report['parameters'], [
    { name: 'period', type: 'date_window', value: { start: '2026-01-05', end: '2026-01-12' } },
    { name: 'sn', type: 'string', value: 'sn-002' },
  ]);
  assert.equal(totalOf(asRecord(report['result']), 'handled_total'), 5, 'the SN filter selects the one governed device');
  assertChineseCopy(String(asRecord(report['narrative'])['narrative']), 'the SN Report narrative');

  // The same Chinese question with full-width spaces is an exact normalized
  // match, and the stock answer keeps every governed value unchanged.
  const asked = asOutput(await ask(s, ['--question', '　SN 为 sn-002 的 2026-01-05 至 2026-01-12 处理量合计是多少? ']));
  assert.equal(asked.origin, 'stock', JSON.stringify(asked));
  assert.equal(asked.executed, false);
  assert.equal(asRecord(asked.stock)['report_id'], snTemplate.reportId);
  assert.deepEqual(asRecord(asked['query'])['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }]);
  assert.equal(totalOf(asked.result, 'handled_total'), 5);
  assertChineseCopy(asked.summary, 'the SN stock summary');
  assertChineseCopy(String(asRecord(asked.answer)['narrative']), 'the SN stock narrative');
  for (const line of asked.limitations) assertChineseCopy(line, 'an SN stock limitation');

  // The stock result equals what the deterministic engine computes for the
  // pinned request, including Release and Provenance.
  const direct = directEngineRead(s, report);
  assert.deepEqual(governedNumbers(asRecord(asked.result)), governedNumbers(direct));
  assert.deepEqual(asked.provenance, direct['provenance']);
  assert.equal(asRecord(asked.data_product)['data_product_release'], direct['data_product_release']);
});

test('stock reuse needs no model Binding, and a stale refresh stores a structured Report with an explicitly absent narrative', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const revoked = command(s.fixture, ['binding', 'revoke', '--binding', s.bindingId], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(revoked.status, 0, revoked.stderr);

  const modelCalls = s.endpoint.calls.length;
  const fresh = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(fresh.origin, 'stock', JSON.stringify(fresh));
  assert.equal(fresh.executed, false);
  assert.equal(s.endpoint.calls.length, modelCalls, 'a stock answer invokes no model even when no Binding exists');

  // With the Binding revoked, a stale match still generates the structured
  // Report; only the optional narrative is absent, and that is disclosed.
  const staleAt = new Date(Date.parse(String(s.report['generated_at'])) + 16 * 60_000).toISOString();
  const refreshed = asOutput(await ask(s, ['--question', QUESTION, '--at', staleAt]));
  assert.equal(refreshed.origin, 'generated', JSON.stringify(refreshed));
  assert.equal(refreshed.executed, true);
  const report = asRecord(refreshed.report);
  assert.equal(report['narrative'], null, 'the narrative is optional, not fabricated');
  assert.equal(totalOf(asRecordOrNull(report['result']), 'handled_total'), 10);
  assert.ok(
    (asRecord(report['completion'])['limitations'] as string[]).some((line) => line.includes('模型绑定')),
    'the absent narrative states why it is absent',
  );
  assertChineseCopy(String(refreshed.summary), 'the generated summary');
  for (const line of refreshed.limitations) assertChineseCopy(line, 'a generated limitation');

  // An unmatched question now reaches the settled path, which reports the
  // missing Binding rather than inventing an answer.
  const unmatched = asOutput(await ask(s, ['--question', '2026-01-10 至 2026-01-20 的处理量合计是多少？']));
  assert.equal(unmatched.origin, 'generated');
  assert.equal(unmatched.report, null);
  assert.equal(unmatched.executed, false);
  assert.equal(unmatched.outcome, 'unavailable');
  assert.equal(unmatched.reason_code, 'NLQ_BINDING_UNAVAILABLE');
});

/** The review items one Workspace currently lists. */
function candidates(s: Surface): Array<Record<string, unknown>> {
  const listed = command(s.fixture, ['report', 'candidate-list', '--workspace', s.workspaceId], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.output['candidates'] as Array<Record<string, unknown>>;
}

test('an expired license keeps stored Reports readable and answers ephemerally without persisting candidates or Reports', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // An unmatched question ordinarily enters review as one open candidate.
  const nearMatch = '2026-01-10 至 2026-01-20 的处理量合计是多少？';
  const ordinarily = asOutput(await ask(s, ['--question', nearMatch]));
  assert.equal(ordinarily.executed, true, JSON.stringify(ordinarily));
  const candidateCount = candidates(s).length;
  assert.equal(candidateCount, 1, 'an unmatched answer is ordinarily stock review material');
  const reportsBefore = stockedReports(s, s.workspaceAdministratorToken).length;
  const templatesBefore = (command(s.fixture, ['report', 'template-list', '--workspace', s.workspaceId], {
    token: s.workspaceAdministratorToken,
  }).output['report_templates'] as unknown[]).length;
  assert.equal(templatesBefore, 2, 'the published Template plus the candidate draft');
  const auditsBefore = audits(s.fixture, 'natural_language_query');

  const expired = signedLicenseFor(
    s.fixture.scratch,
    'report-stock-expired',
    s.fixture.bundle,
    installedLicenseRequest(s.fixture.root),
    { notBefore: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() },
  );
  installLicenseFile(s.fixture.root, expired);

  // Stored Reports stay retrievable without regenerating their content.
  const stored = command(s.fixture, ['report', 'show', '--report', s.reportId], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(asRecord(stored.output['report'])['report_id'], s.reportId);
  assert.equal(stockedReports(s, s.workspaceAdministratorToken).length, reportsBefore);

  // A stale stock match would ordinarily refresh; ephemerally it neither
  // refreshes nor persists, and the answer states its read-only nature in Chinese.
  const staleAt = new Date(Date.parse(String(s.report['generated_at'])) + 16 * 60_000).toISOString();
  const ephemeral = asOutput(await ask(s, ['--question', QUESTION, '--at', staleAt]));
  assert.equal(ephemeral['ephemeral'], true, JSON.stringify(ephemeral));
  assert.equal(ephemeral.origin, 'generated');
  assert.equal(ephemeral.report, null, 'no refreshed Report is persisted');
  assert.equal(stockedReports(s, s.workspaceAdministratorToken).length, reportsBefore);
  assert.equal(
    ephemeral.limitations.some((line) => /许可已过期/u.test(line) && /不会保存/u.test(line)),
    true,
  );

  // The unmatched question that ordinarily created a candidate persists none.
  const unmatched = asOutput(await ask(s, ['--question', nearMatch]));
  assert.equal(unmatched['ephemeral'], true);
  assert.equal(candidates(s).length, candidateCount, 'no candidate is created while expired');
  assert.equal(unmatched.report, null);
  assert.equal(unmatched.template, null);

  // Required Audit Events continue even though no business state is written.
  assert.ok(
    audits(s.fixture, 'natural_language_query') >= auditsBefore + 2,
    'each ephemeral turn is audited',
  );

  // Explicit generation and schedule ticks stop under the expired entitlement.
  const generated = command(s.fixture, ['report', 'generate', '--template', s.templateId], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(generated.status, 2);
  assert.equal(generated.error['code'], 'LICENSE_EXPIRED');
  const ticked = command(
    s.fixture,
    ['report', 'schedule-tick', '--workspace', s.workspaceId],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(ticked.status, 2);
  assert.equal(ticked.error['code'], 'LICENSE_EXPIRED');
  assert.equal(
    (command(s.fixture, ['report', 'template-list', '--workspace', s.workspaceId], {
      token: s.workspaceAdministratorToken,
    }).output['report_templates'] as unknown[]).length,
    templatesBefore,
    'Template reads stay available and no Template was added',
  );
});
