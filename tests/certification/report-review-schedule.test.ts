import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandAsync, type CommandResult } from '../support/async-command.js';
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
  createUser,
  grantRole,
  jsonFile,
  sessionFor,
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
/** A question the stock Template does not answer, so it enters review. */
const CANDIDATE_QUESTION = '2026-01-06 至 2026-01-20 的处理量合计是多少？';
/** The same business question as CANDIDATE_QUESTION, worded differently. */
const PARAPHRASE_QUESTION = '请查询 2026-01-06 到 2026-01-20 的处理量总计';

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
  candidate: Record<string, unknown> | null;
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

function records(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), 'expected an array');
  return value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
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

function templateConfig(question: string, window: { start: string; end: string }): Record<string, unknown> {
  return {
    question,
    parameters: [{ name: 'period', type: 'date_window', value: window }],
    query: {
      kind: 'aggregate',
      metrics: ['handled_total'],
      window: { ...window },
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
  name: string,
  question: string,
  window: { start: string; end: string },
): Promise<{ templateId: string; templateVersion: number; reportId: string; report: Record<string, unknown> }> {
  const published = command(
    s.fixture,
    ['report', 'template-publish', '--workspace', s.workspaceId, '--product', s.dataProductId, '--name', name, '--config', jsonFile(s.fixture, `template-${name}`, templateConfig(question, window))],
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
 * One Workspace holding a published ledger, one activated Model Profile bound for
 * planning, narration, and clarification, and one published Report Template whose
 * first Report is already stocked.
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
  const evaluated = await commandAsync(base.fixture, ['model', 'evaluate', '--profile', profileId, '--version', String(version)], { token: base.deploymentAdministratorToken });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(base.fixture, ['model', 'activate', '--profile', profileId, '--version', String(version)], { token: base.deploymentAdministratorToken });
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    base.fixture,
    ['binding', 'publish', '--workspace', base.workspaceId, '--profile', profileId, '--config', jsonFile(base.fixture, 'report-binding', { model_profile_version: version, purposes: [...PURPOSES], data_categories: [...DATA_CATEGORIES] })],
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
  const template = await publishTemplate(surface, '日处理量报告', QUESTION, { start: '2026-01-05', end: '2026-01-20' });
  Object.assign(surface, template);
  return surface;
}

function ask(s: Surface, args: string[]): Promise<CommandResult> {
  return commandAsync(s.fixture, ['product', 'ask', '--product', s.dataProductId, ...args], { token: s.consumerToken });
}

function askAs(s: Surface, token: string, question: string): Promise<CommandResult> {
  return commandAsync(s.fixture, ['product', 'ask', '--product', s.dataProductId, '--question', question], { token });
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

function notifications(fixture: PlatformFixture): number {
  return audits(fixture, 'report_candidate_notification');
}

function candidateList(s: Surface, token = s.workspaceAdministratorToken): Array<Record<string, unknown>> {
  const listed = command(s.fixture, ['report', 'candidate-list', '--workspace', s.workspaceId], { token });
  assert.equal(listed.status, 0, listed.stderr);
  return records(listed.output['candidates']);
}

function showCandidate(s: Surface, candidateId: string): Record<string, unknown> {
  const shown = command(s.fixture, ['report', 'candidate-show', '--candidate', candidateId], { token: s.workspaceAdministratorToken });
  assert.equal(shown.status, 0, shown.stderr);
  return shown.output as Record<string, unknown>;
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
  'handled_total', 'device_count', 'include_totals', 'limit', 'metrics', 'window', 'SQL', 'SN', 'CNY',
];

function assertChineseCopy(text: string, label: string): void {
  assert.equal(typeof text, 'string', `${label} is a string`);
  let rest = text;
  for (const token of LATIN_TOKENS) rest = rest.split(token).join(' ');
  assert.ok(hanCount(rest) >= 4, `${label} is written in Chinese: ${text}`);
  assert.equal(/[A-Za-z]/u.test(rest), false, `${label} carries no English prose: ${text}`);
}

test('similarity nominates Chinese QA candidates without establishing equivalence, and repeated normalized semantics share one open review item and one notification', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // The unmatched Chinese question is answered immediately, but no stock is
  // published: it enters administrator review as an unapproved candidate.
  const first = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  assert.equal(first.origin, 'generated', JSON.stringify(first));
  assert.equal(first.executed, true);
  assert.equal(first.report, null, 'an unmatched answer publishes no stock');
  const candidate = asRecord(first.candidate);
  assert.equal(candidate['status'], 'open');
  assertChineseCopy(first.summary, 'the candidate summary');
  for (const line of first.limitations) assertChineseCopy(line, 'a candidate limitation');

  const listed = candidateList(s);
  assert.equal(listed.length, 1, 'one open review item');
  const item = listed[0]!;
  assert.equal(item['candidate_id'], candidate['candidate_id']);
  assert.equal(item['status'], 'open');
  assert.equal(item['question'], CANDIDATE_QUESTION);
  assert.equal(item['occurrences'], 1);
  assert.equal(typeof item['report_template_id'], 'string');
  assert.equal(typeof item['report_id'], 'string');
  assert.equal(item['notification'] !== null, true, 'the first occurrence notified the reviewer');
  assert.equal(notifications(s.fixture), 1);

  // The settled local embedding configuration nominates the stocked Template's
  // Chinese question as similar, but the score is neither equality nor reuse.
  const similarity = asRecord(item['similarity']);
  const configuration = asRecord(similarity['configuration']);
  assert.equal(configuration['model_id'], 'Qwen3-Embedding-0.6B');
  assert.ok(Number(configuration['dimensions']) > 0);
  const nominations = records(similarity['nominations']);
  const templateNomination = nominations.find((entry) => entry['target_id'] === s.templateId);
  assert.ok(templateNomination, 'the stocked Template question is nominated as similar');
  assert.equal(templateNomination['kind'], 'report_template');
  const score = Number(templateNomination['score']);
  assert.ok(score > 0 && score < 1, `similarity nominates but never equates: ${score}`);
  assert.equal(first.stock, null, 'a similarity nomination never reuses stock');

  // Review is administrator-only; a Consumer sees no candidate at all.
  const denied = command(s.fixture, ['report', 'candidate-list', '--workspace', s.workspaceId], { token: s.consumerToken });
  assert.equal(denied.status, 2);
  assert.equal(denied.error['code'], 'WORKSPACE_ACCESS_DENIED');

  // The same Chinese semantics, written with different whitespace and a
  // full-width question mark, share the one open item and send no new notice.
  const repeated = asOutput(await ask(s, ['--question', '　2026-01-06 至 2026-01-20　的处理量合计是多少? ']));
  assert.equal(repeated.origin, 'generated');
  assert.equal(asRecord(repeated.candidate)['candidate_id'], candidate['candidate_id']);
  const shared = candidateList(s);
  assert.equal(shared.length, 1, `repeated normalized semantics share one open review item: ${JSON.stringify(shared)}`);
  assert.equal(shared[0]!['occurrences'], 2, JSON.stringify(shared));
  assert.equal(notifications(s.fixture), 1, 'the duplicate occurrence sends no notification');

  // A paraphrase is nominated against the first item but is never merged with
  // it, approved, or reused: business equivalence is a human decision.
  const paraphrase = asOutput(await ask(s, ['--question', PARAPHRASE_QUESTION]));
  assert.equal(paraphrase.origin, 'generated');
  assert.equal(paraphrase.executed, true);
  assert.equal(paraphrase.report, null);
  const second = asRecord(paraphrase.candidate);
  assert.notEqual(second['candidate_id'], candidate['candidate_id'], 'a paraphrase is not silently equivalent');
  assert.equal(second['status'], 'open');
  const two = candidateList(s);
  assert.equal(two.length, 2);
  const paraphrased = two.find((entry) => entry['candidate_id'] === second['candidate_id'])!;
  const paraphraseNominations = records(asRecord(paraphrased['similarity'])['nominations']);
  const candidateNomination = paraphraseNominations.find((entry) => entry['target_id'] === candidate['candidate_id']);
  assert.ok(candidateNomination, 'the paraphrase nominates the earlier Chinese QA pair');
  assert.equal(candidateNomination['kind'], 'review_candidate');
  assert.ok(Number(candidateNomination['score']) > 0);
  assert.equal(notifications(s.fixture), 2, 'the semantic change notified once more');

  // Stock matching is unchanged: the exact Template question still reuses the
  // exact stocked Report, and no nomination ever became an Approval.
  const stock = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(stock.origin, 'stock', JSON.stringify(stock));
  assert.equal(asRecord(stock.stock)['report_id'], s.reportId);
  assert.equal(stock.executed, false);
  for (const entry of candidateList(s)) assert.equal(entry['status'], 'open');

  // Chinese QA pairs may carry a mixed English/Chinese identifier. The SN
  // filter reaches the candidate Report unchanged, and its narrative is the
  // grounded Simplified Chinese one the model wrote.
  const snQuestion = 'SN 为 sn-002 的 2026-01-05 至 2026-01-20 处理量合计是多少？';
  const sn = asOutput(await ask(s, ['--question', snQuestion]));
  assert.equal(sn.origin, 'generated');
  assert.equal(sn.stock, null);
  const snCandidate = asRecord(sn.candidate);
  assert.equal(snCandidate['status'], 'open');
  const snEvidence = showCandidate(s, String(snCandidate['candidate_id']));
  const snReport = asRecord(snEvidence['report']);
  assert.deepEqual(asRecord(snReport['query'])['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }], 'the identifier is pinned unchanged');
  assert.equal(totalOf(snReport['result']), 5, 'the SN filter selects the one governed device');
  assertChineseCopy(String(asRecord(snReport['narrative'])['narrative']), 'the SN candidate narrative');
});

test('candidate Approval publishes the exact reviewed Template and Report without rerunning queries or generation', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const answered = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  const candidate = asRecord(answered.candidate);
  const reviewed = showCandidate(s, String(candidate['candidate_id']));
  const reviewedReport = asRecord(reviewed['report']);
  const reviewedReportId = String(reviewedReport['report_id']);
  const reviewedTemplate = asRecord(reviewed['template']);
  assert.equal(asRecord(reviewed['candidate'])['status'], 'open');
  assert.equal(totalOf(reviewedReport['result']), 7);

  const queryAudits = audits(s.fixture, 'data_product_query');
  const generationAudits = audits(s.fixture, 'report_generation');
  const modelCalls = s.endpoint.calls.length;

  const approved = command(s.fixture, ['report', 'candidate-approve', '--candidate', String(candidate['candidate_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(approved.status, 0, approved.stderr);
  assertChineseCopy(String(approved.output['summary']), 'the approval summary');
  const approvedCandidate = asRecord(approved.output['candidate']);
  assert.equal(approvedCandidate['status'], 'approved');
  assert.equal(asRecord(approved.output['template'])['published_version'], 1);
  const approvedReport = asRecord(approved.output['report']);
  assert.equal(approvedReport['report_id'], reviewedReportId, 'the exact reviewed Report is published');
  assert.deepEqual(approvedReport, reviewedReport, 'Approval rewrites no reviewed content');
  const approvedTemplate = asRecord(approved.output['template']);
  assert.equal(reviewedTemplate['published_version'], null, 'the reviewed draft was unpublished');
  assert.equal(approvedTemplate['published_version'], 1, 'Approval publishes the exact reviewed Version');
  assert.equal(approvedTemplate['content_hash'], reviewedTemplate['content_hash'], 'the reviewed Template content is unchanged');
  assert.equal(approvedTemplate['question'], reviewedTemplate['question']);
  assert.equal(approvedTemplate['template_version'], reviewedTemplate['template_version']);
  assert.deepEqual(approvedTemplate['query'], reviewedTemplate['query']);

  // Approval reran no query, generated no Report, and invoked no model.
  assert.equal(audits(s.fixture, 'data_product_query'), queryAudits, 'Approval reran no Data Product Query');
  assert.equal(audits(s.fixture, 'report_generation'), generationAudits, 'Approval generated no Report');
  assert.equal(s.endpoint.calls.length, modelCalls, 'Approval invoked no model');

  // The published Template now matches the exact question and returns the exact
  // reviewed Report without executing anything.
  const questioned = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  assert.equal(questioned.origin, 'stock', JSON.stringify(questioned));
  assert.equal(questioned.executed, false);
  assert.equal(asRecord(questioned.stock)['report_id'], reviewedReportId);
  assert.equal(asRecord(questioned.report)['report_id'], reviewedReportId);
  assert.equal(totalOf(questioned.result), 7, 'the governed number is the reviewed one');
  assert.equal(audits(s.fixture, 'data_product_query'), queryAudits);
  assert.equal(s.endpoint.calls.length, modelCalls);

  // A second Consumer holding the same effective authorization reuses the same
  // published Report; Approval published it once rather than per Consumer.
  createUser(s.fixture, s.deploymentAdministratorToken, 'reviewer@example.invalid', 'reviewer-consumer');
  grantRole(s.fixture, s.workspaceAdministratorToken, s.workspaceId, 'reviewer@example.invalid', 'Consumer');
  const otherToken = sessionFor(s.fixture, 'reviewer@example.invalid', 'reviewer-consumer');
  const other = asOutput(await askAs(s, otherToken, CANDIDATE_QUESTION));
  assert.equal(other.origin, 'stock', JSON.stringify(other));
  assert.equal(asRecord(other.stock)['report_id'], reviewedReportId);

  // The approved Report is now ordinary stock: listable and readable.
  const listed = command(s.fixture, ['report', 'list', '--workspace', s.workspaceId], { token: s.consumerToken });
  assert.equal(listed.status, 0, listed.stderr);
  const ids = records(listed.output['reports']).map((entry) => entry['report_id']);
  assert.ok(ids.includes(reviewedReportId));
  const shown = command(s.fixture, ['report', 'show', '--report', reviewedReportId], { token: s.consumerToken });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(asRecord(shown.output['report'])['report_id'], reviewedReportId);
  assert.deepEqual(shown.output['report'], reviewedReport);
});

test('rejection suppresses identical notifications until reopening or semantic change', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const first = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  const candidate = asRecord(first.candidate);
  const rejected = command(
    s.fixture,
    ['report', 'candidate-reject', '--candidate', String(candidate['candidate_id']), '--reason', '该问题与已发布模板语义不一致'],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(rejected.status, 0, rejected.stderr);
  assertChineseCopy(String(rejected.output['summary']), 'the rejection summary');
  assert.equal(asRecord(rejected.output['candidate'])['status'], 'rejected');
  assert.equal(asRecord(asRecord(rejected.output['candidate'])['rejection'])['reason'], '该问题与已发布模板语义不一致');
  assert.equal(notifications(s.fixture), 1);

  // Identical semantics after rejection: one item, no second notification.
  const repeated = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  assert.equal(asRecord(repeated.candidate)['candidate_id'], candidate['candidate_id']);
  assert.equal(asRecord(repeated.candidate)['status'], 'rejected');
  const suppressed = candidateList(s);
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0]!['occurrences'], 2);
  assert.equal(notifications(s.fixture), 1, 'rejection suppresses identical notifications');

  // A semantic change opens a new item and notifies once more.
  const changed = asOutput(await ask(s, ['--question', PARAPHRASE_QUESTION]));
  assert.notEqual(asRecord(changed.candidate)['candidate_id'], candidate['candidate_id']);
  assert.equal(candidateList(s).length, 2);
  assert.equal(notifications(s.fixture), 2);

  // Reopening the rejected item notifies the reviewer once, and later identical
  // occurrences share the reopened item without further notices.
  const reopened = command(s.fixture, ['report', 'candidate-reopen', '--candidate', String(candidate['candidate_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(asRecord(reopened.output['candidate'])['status'], 'open');
  assert.equal(notifications(s.fixture), 3);
  const again = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  assert.equal(asRecord(again.candidate)['candidate_id'], candidate['candidate_id']);
  assert.equal(notifications(s.fixture), 3, 'the reopened item never notifies twice for one semantic');
});

/** Reads the governed metric grand total from a Report result. */
function totalOf(result: unknown): unknown {
  return asRecord(asRecord(asRecord(result)['totals'])['metrics'])['handled_total'];
}

function createSchedule(s: Surface, startAt: string, intervalMinutes = 60): Record<string, unknown> {
  const created = command(
    s.fixture,
    [
      'report', 'schedule-create',
      '--template', s.templateId,
      '--consumer', 'analyst@example.invalid',
      '--interval-minutes', String(intervalMinutes),
      '--start-at', startAt,
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  assertChineseCopy(String(created.output['summary']), 'the schedule creation summary');
  return asRecord(created.output['schedule']);
}

function scheduleList(s: Surface): Array<Record<string, unknown>> {
  const listed = command(s.fixture, ['report', 'schedule-list', '--workspace', s.workspaceId], { token: s.workspaceAdministratorToken });
  assert.equal(listed.status, 0, listed.stderr);
  return records(listed.output['schedules']);
}

function tick(s: Surface, at: string): { runs: Array<Record<string, unknown>>; summary: string } {
  const run = command(s.fixture, ['report', 'schedule-tick', '--workspace', s.workspaceId, '--at', at], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(run.status, 0, run.stderr);
  assertChineseCopy(String(run.output['summary']), 'the schedule tick summary');
  return { runs: records(run.output['runs']), summary: String(run.output['summary']) };
}

function stockedReportCount(s: Surface): number {
  const listed = command(s.fixture, ['report', 'list', '--workspace', s.workspaceId], { token: s.workspaceAdministratorToken });
  assert.equal(listed.status, 0, listed.stderr);
  return records(listed.output['reports']).length;
}

test('scheduled runs revalidate the designated Consumer, coalesce overlaps, and produce at most one catch-up', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const generatedAt = String(s.report['generated_at']);
  const start = new Date(Date.parse(generatedAt) + 16 * 60_000).toISOString();
  const schedule = createSchedule(s, start);
  assert.equal(schedule['next_due_at'], start);
  assert.equal(schedule['interval_minutes'], 60);
  assert.equal(schedule['designated_username'], 'analyst@example.invalid');
  assert.equal(typeof schedule['designated_user_id'], 'string');

  // The due run generates exactly one Report from the published Template.
  const reportsBefore = stockedReportCount(s);
  const queriesBefore = audits(s.fixture, 'data_product_query');
  const due = tick(s, start);
  assert.equal(due.runs.length, 1);
  const firstRun = due.runs[0]!;
  assert.equal(firstRun['outcome'], 'generated');
  assert.equal(firstRun['due_count'], 1);
  assert.equal(firstRun['catch_up'], false);
  assert.equal(typeof firstRun['report_id'], 'string');
  assert.equal(stockedReportCount(s), reportsBefore + 1);
  assert.equal(audits(s.fixture, 'data_product_query'), queriesBefore + 1);
  const scheduledReport = command(s.fixture, ['report', 'show', '--report', String(firstRun['report_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(scheduledReport.status, 0, scheduledReport.stderr);
  assert.equal(asRecord(scheduledReport.output['report'])['generated_by'], schedule['designated_user_id'], 'the run acts as the designated Consumer');

  // A second tick at the same instant overlaps the first and coalesces to none.
  const overlap = tick(s, start);
  assert.equal(overlap.runs.length, 0, 'overlapping ticks produce no second run');
  assert.equal(stockedReportCount(s), reportsBefore + 1);

  // Five hours later five further instants are due; exactly one catch-up runs.
  const catchUpAt = new Date(Date.parse(start) + 5 * 60 * 60_000).toISOString();
  const catchUp = tick(s, catchUpAt);
  assert.equal(catchUp.runs.length, 1, 'missed schedules produce at most one catch-up');
  const catchUpRun = catchUp.runs[0]!;
  assert.equal(catchUpRun['catch_up'], true);
  assert.equal(catchUpRun['due_from'], new Date(Date.parse(start) + 60 * 60_000).toISOString());
  assert.equal(catchUpRun['due_count'], 5);
  assert.equal(catchUpRun['outcome'], 'generated');
  assert.equal(stockedReportCount(s), reportsBefore + 2);
  const afterCatchUp = scheduleList(s)[0]!;
  assert.ok(Date.parse(String(afterCatchUp['next_due_at'])) > Date.parse(catchUpAt), 'the schedule advances past the tick');

  // The designated Consumer's Grants are revalidated: a narrowed Grant makes
  // the next run generate under exactly the new scope, never the old stock.
  const grant = command(
    s.fixture,
    [
      'grant', 'publish',
      '--product', s.dataProductId,
      '--username', 'analyst@example.invalid',
      '--request', jsonFile(s.fixture, 'schedule-grant', { columns: ['sn', 'handled_count', 'reported_on'], row_filters: [] }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(grant.status, 0, grant.stderr);
  const narrowedAt = new Date(Date.parse(start) + 6 * 60 * 60_000).toISOString();
  const narrowed = tick(s, narrowedAt);
  assert.equal(narrowed.runs.length, 1);
  assert.equal(narrowed.runs[0]!['outcome'], 'generated', 'a changed Grant invalidates the earlier stock');
  const narrowedReport = command(s.fixture, ['report', 'show', '--report', String(narrowed.runs[0]!['report_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(narrowedReport.status, 0, narrowedReport.stderr);
  const security = asRecord(asRecord(narrowedReport.output['report'])['security']);
  assert.equal(security['restricted'], true, 'the run re-reads the designated Consumer Grants');
  assert.deepEqual(security['columns'], ['sn', 'handled_count', 'reported_on']);

  // A revoked membership fails closed without executing a query.
  const membership = command(
    s.fixture,
    ['membership', 'revoke', '--workspace', s.workspaceId, '--username', 'analyst@example.invalid'],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(membership.status, 0, membership.stderr);
  const revokedAt = new Date(Date.parse(start) + 7 * 60 * 60_000).toISOString();
  const revokedQueries = audits(s.fixture, 'data_product_query');
  const revokedReports = stockedReportCount(s);
  const revoked = tick(s, revokedAt);
  assert.equal(revoked.runs.length, 1);
  assert.equal(revoked.runs[0]!['outcome'], 'failed');
  assert.equal(revoked.runs[0]!['reason_code'], 'SCHEDULE_CONSUMER_NOT_MEMBER');
  assertChineseCopy(String(revoked.runs[0]!['limitation']), 'the revocation limitation');
  assert.equal(audits(s.fixture, 'data_product_query'), revokedQueries, 'a revoked Consumer executes no query');
  assert.equal(stockedReportCount(s), revokedReports, 'a revoked Consumer stores no Report');

  // Restoring the membership lets the next due run succeed again.
  grantRole(s.fixture, s.workspaceAdministratorToken, s.workspaceId, 'analyst@example.invalid', 'Consumer');
  const restoredAt = new Date(Date.parse(start) + 8 * 60 * 60_000).toISOString();
  const restored = tick(s, restoredAt);
  assert.equal(restored.runs.length, 1);
  assert.equal(restored.runs[0]!['outcome'], 'generated');

  // A deactivated User status is revalidated as well.
  const deactivated = command(s.fixture, ['user', 'deactivate', '--username', 'analyst@example.invalid'], {
    token: s.deploymentAdministratorToken,
  });
  assert.equal(deactivated.status, 0, deactivated.stderr);
  const inactiveAt = new Date(Date.parse(start) + 9 * 60 * 60_000).toISOString();
  const inactiveQueries = audits(s.fixture, 'data_product_query');
  const inactive = tick(s, inactiveAt);
  assert.equal(inactive.runs.length, 1);
  assert.equal(inactive.runs[0]!['outcome'], 'failed');
  assert.equal(inactive.runs[0]!['reason_code'], 'SCHEDULE_CONSUMER_INACTIVE');
  assert.equal(audits(s.fixture, 'data_product_query'), inactiveQueries);
  assert.ok(scheduleList(s).length === 1, 'the durable schedule itself survives every failed run');
});

function reportedIds(s: Surface, token: string, extra: string[] = []): string[] {
  const listed = command(s.fixture, ['report', 'list', '--workspace', s.workspaceId, ...extra], { token });
  assert.equal(listed.status, 0, listed.stderr);
  return records(listed.output['reports']).map((entry) => String(entry['report_id']));
}

function showReportCommand(s: Surface, token: string, reportId: string): CommandResult {
  return command(s.fixture, ['report', 'show', '--report', reportId], { token });
}

test('Report Withdrawal stops ordinary reuse and retrieval while preserving governed history', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const stock = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(stock.origin, 'stock');

  const withdrawn = command(s.fixture, ['report', 'withdraw', '--report', s.reportId], { token: s.workspaceAdministratorToken });
  assert.equal(withdrawn.status, 0, withdrawn.stderr);
  assertChineseCopy(String(withdrawn.output['summary']), 'the Report withdrawal summary');
  assert.equal(typeof withdrawn.output['withdrawn_at'], 'string');
  assert.equal(audits(s.fixture, 'report_withdrawal'), 1);

  // Ordinary retrieval stops for a Consumer; the exact content stays readable
  // as governed history for the administrator.
  const denied = showReportCommand(s, s.consumerToken, s.reportId);
  assert.equal(denied.status, 2, denied.stdout);
  assert.equal(denied.error['code'], 'REPORT_WITHDRAWN');
  const history = showReportCommand(s, s.workspaceAdministratorToken, s.reportId);
  assert.equal(history.status, 0, history.stderr);
  assert.equal(history.output['withdrawn'], true);
  assert.equal(asRecord(history.output['report'])['withdrawn_at'], withdrawn.output['withdrawn_at']);
  assert.deepEqual(asRecord(history.output['report'])['result'], s.report['result'], 'withdrawal erases no governed result');
  assertChineseCopy(String(history.output['summary']), 'the Report history summary');

  // Stock listing leaves the withdrawn Report; administrators may list history.
  assert.equal(reportedIds(s, s.consumerToken).includes(s.reportId), false);
  assert.equal(reportedIds(s, s.workspaceAdministratorToken).includes(s.reportId), false);
  assert.equal(reportedIds(s, s.workspaceAdministratorToken, ['--include-withdrawn']).includes(s.reportId), true);

  // The exact question no longer reuses the withdrawn Report; the still
  // published Template generates a fresh, separately stored Report.
  const queriesBefore = audits(s.fixture, 'data_product_query');
  const refreshed = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(refreshed.origin, 'generated', JSON.stringify(refreshed));
  assert.equal(refreshed.executed, true);
  const fresh = asRecord(refreshed.report);
  assert.notEqual(fresh['report_id'], s.reportId);
  assert.equal(audits(s.fixture, 'data_product_query'), queriesBefore + 1);
  assert.equal(asOutput(await ask(s, ['--question', QUESTION])).origin, 'stock', 'the fresh Report is ordinary stock');
  assert.equal(reportedIds(s, s.consumerToken).includes(String(fresh['report_id'])), true);

  // A candidate whose reviewed Report was withdrawn cannot be approved: the
  // withdrawn answer is history, not a publishable stock Report.
  const candidateAnswer = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  const candidate = asRecord(candidateAnswer.candidate);
  const reviewed = showCandidate(s, String(candidate['candidate_id']));
  const candidateReportId = String(asRecord(reviewed['report'])['report_id']);
  const withdrawnCandidate = command(s.fixture, ['report', 'withdraw', '--report', candidateReportId], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(withdrawnCandidate.status, 0, withdrawnCandidate.stderr);
  const approve = command(s.fixture, ['report', 'candidate-approve', '--candidate', String(candidate['candidate_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(approve.status, 2);
  assert.equal(approve.error['code'], 'REPORT_WITHDRAWN');
  assert.equal(asRecord(showCandidate(s, String(candidate['candidate_id']))['candidate'])['status'], 'open');
});

test('Template Withdrawal stops matching and future generation while keeping generated Reports readable', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const start = new Date(Date.parse(String(s.report['generated_at'])) + 16 * 60_000).toISOString();
  const schedule = createSchedule(s, start);
  assert.equal(schedule['next_due_at'], start);

  const withdrawn = command(
    s.fixture,
    ['report', 'template-withdraw', '--template', s.templateId, '--version', String(s.templateVersion)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(withdrawn.status, 0, withdrawn.stderr);
  assertChineseCopy(String(withdrawn.output['summary']), 'the Template withdrawal summary');
  assert.equal(audits(s.fixture, 'report_template_withdrawal'), 1);
  const shown = command(s.fixture, ['report', 'template-show', '--template', s.templateId], { token: s.workspaceAdministratorToken });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.output['withdrawn_at'], withdrawn.output['withdrawn_at']);

  // Future generation is refused outright.
  const generate = await commandAsync(s.fixture, ['report', 'generate', '--template', s.templateId], { token: s.workspaceAdministratorToken });
  assert.equal(generate.status, 2);
  assert.equal(generate.error['code'], 'REPORT_TEMPLATE_WITHDRAWN');

  // Matching stops: the exact question takes the Natural-Language Query path
  // instead of returning the old stock, and publishes no stock Report.
  const queriesBefore = audits(s.fixture, 'data_product_query');
  const asked = asOutput(await ask(s, ['--question', QUESTION]));
  assert.equal(asked.origin, 'generated', JSON.stringify(asked));
  assert.equal(asked.stock, null);
  assert.equal(asked.template, null);
  assert.equal(asked.executed, true);
  assert.equal(audits(s.fixture, 'data_product_query'), queriesBefore + 1);

  // Governed history is preserved: the Report generated before Withdrawal is
  // still readable by its Consumer, unchanged.
  const history = showReportCommand(s, s.consumerToken, s.reportId);
  assert.equal(history.status, 0, history.stderr);
  assert.deepEqual(asRecord(history.output['report']), s.report);

  // A due schedule on the withdrawn Version fails closed without a query.
  const queriesAtTick = audits(s.fixture, 'data_product_query');
  const ticked = tick(s, start);
  assert.equal(ticked.runs.length, 1);
  assert.equal(ticked.runs[0]!['outcome'], 'failed');
  assert.equal(ticked.runs[0]!['reason_code'], 'REPORT_TEMPLATE_WITHDRAWN');
  assertChineseCopy(String(ticked.runs[0]!['limitation']), 'the Template withdrawal limitation');
  assert.equal(audits(s.fixture, 'data_product_query'), queriesAtTick, 'a withdrawn Template executes no query');

  // Withdrawal is idempotent: repeating it changes no history.
  const again = command(
    s.fixture,
    ['report', 'template-withdraw', '--template', s.templateId, '--version', String(s.templateVersion)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.output['already_withdrawn'], true);
  assert.equal(audits(s.fixture, 'report_template_withdrawal'), 1);

  // A candidate whose reviewed Template Version was withdrawn cannot be
  // approved, and its evidence stays intact for the reviewer.
  const candidateAnswer = asOutput(await ask(s, ['--question', CANDIDATE_QUESTION]));
  const candidate = asRecord(candidateAnswer.candidate);
  const reviewed = showCandidate(s, String(candidate['candidate_id']));
  const reviewedTemplateId = String(asRecord(reviewed['template'])['report_template_id']);
  const drafted = command(
    s.fixture,
    ['report', 'template-withdraw', '--template', reviewedTemplateId, '--version', String(asRecord(reviewed['template'])['template_version'])],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(drafted.status, 0, drafted.stderr);
  const approve = command(s.fixture, ['report', 'candidate-approve', '--candidate', String(candidate['candidate_id'])], {
    token: s.workspaceAdministratorToken,
  });
  assert.equal(approve.status, 2);
  assert.equal(approve.error['code'], 'REPORT_TEMPLATE_WITHDRAWN');
  assert.equal(asRecord(showCandidate(s, String(candidate['candidate_id']))['candidate'])['status'], 'open');
});

test('an unchanged scheduled input reuses fresh stock without executing a query or generation', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const start = new Date(Date.parse(String(s.report['generated_at'])) + 60_000).toISOString();
  createSchedule(s, start);
  const queriesBefore = audits(s.fixture, 'data_product_query');
  const reportsBefore = stockedReportCount(s);
  const modelCalls = s.endpoint.calls.length;

  const ticked = tick(s, start);
  assert.equal(ticked.runs.length, 1);
  assert.equal(ticked.runs[0]!['outcome'], 'reused', 'unchanged inputs reuse stock');
  assert.equal(ticked.runs[0]!['report_id'], s.reportId);
  assert.equal(ticked.runs[0]!['catch_up'], false);
  assert.equal(audits(s.fixture, 'data_product_query'), queriesBefore, 'stock reuse executes no query');
  assert.equal(stockedReportCount(s), reportsBefore, 'stock reuse stores no Report');
  assert.equal(s.endpoint.calls.length, modelCalls, 'stock reuse invokes no model');
});
