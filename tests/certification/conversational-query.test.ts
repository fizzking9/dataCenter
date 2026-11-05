import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import {
  EXTENDED_LEDGER_CONTRACT,
  LEDGER,
  publishLedgerProduct,
  publishRefundProduct,
  REFUND_LEDGER,
} from '../support/data-product.js';
import {
  MOCK_MODEL_ID,
  startMockModelEndpoint,
  type MockModelEndpoint,
} from '../support/model-endpoint.js';
import {
  command,
  jsonFile,
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

/** The compound question both parts answer, each within its own Release. */
const COMPOUND = '2026-01-01 至 2026-02-10 设备维修台账的处理量合计是多少？退款台账 2026-02-03 至 2026-02-10 的退款金额合计是多少？';

interface Surface extends WorkspaceFixture {
  sourceId: string;
  ledgerId: string;
  refundId: string;
  endpoint: MockModelEndpoint;
  bindingId: string;
}

interface Output extends Record<string, unknown> {
  outcome: string;
  status: string;
  executed: boolean;
  parts: Array<Record<string, unknown>>;
  as_of: Array<Record<string, unknown>>;
  limitations: string[];
  summary: string;
  conversation: string | null;
  follow_up: boolean;
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
 * One Workspace holding two independently published Data Products, a Consumer,
 * and one activated Model Profile bound for planning, narration, and
 * clarification. Both Products are readable by the Consumer without narrowing.
 */
async function readySurface(): Promise<Surface> {
  const ledger = publishLedgerProduct(EXTENDED_LEDGER_CONTRACT);
  const refund = publishRefundProduct(ledger);
  const endpoint = await startMockModelEndpoint();
  const published = command(
    ledger.fixture,
    ['model', 'publish', '--name', '自然语言查询模型', '--config', jsonFile(ledger.fixture, 'nlq-profile', profileConfig(endpoint))],
    { token: ledger.deploymentAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const profileId = String(published.output['model_profile_id']);
  const version = Number(published.output['model_profile_version']);
  const evaluated = await commandAsync(
    ledger.fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: ledger.deploymentAdministratorToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(
    ledger.fixture,
    ['model', 'activate', '--profile', profileId, '--version', String(version)],
    { token: ledger.deploymentAdministratorToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    ledger.fixture,
    [
      'binding', 'publish',
      '--workspace', ledger.workspaceId,
      '--profile', profileId,
      '--config', jsonFile(ledger.fixture, 'nlq-binding', {
        model_profile_version: version,
        purposes: [...PURPOSES],
        data_categories: [...DATA_CATEGORIES],
      }),
    ],
    { token: ledger.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  return {
    ...ledger,
    ledgerId: ledger.dataProductId,
    refundId: refund.dataProductId,
    endpoint,
    bindingId: String(bound.output['binding_id']),
  };
}

function askWorkspace(s: Surface, args: string[]): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['product', 'ask', '--workspace', s.workspaceId, ...args],
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

/** The most recent Natural-Language Query turn the Deployment recorded. */
function lastNaturalLanguageAudit(fixture: PlatformFixture): Record<string, unknown> {
  const lines = readFileSync(join(fixture.root, 'audit', 'events.jsonl'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  const turns = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['action'] === 'natural_language_query');
  assert.ok(turns.length > 0, 'the turn was audited');
  return asRecord(turns.at(-1)!['detail']);
}

/** The governed half of an engine result, with cache bookkeeping left out. */
function governedNumbers(result: Record<string, unknown>): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** Answers one part directly through the deterministic engine, for comparison. */
function directPart(s: Surface, part: Record<string, unknown>): Record<string, unknown> {
  const identity = asRecord(part['data_product']);
  const result = command(
    s.fixture,
    ['product', 'query', '--product', String(identity['data_product_id']), '--request', jsonFile(s.fixture, 'part-request', part['query'])],
    { token: s.consumerToken },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.output as Record<string, unknown>;
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

/** The only Latin tokens new copy may cite: governed identifiers and acronyms. */
const LATIN_TOKENS = [
  'include_totals', 'settled_average', 'handled_total', 'settled_total', 'device_count',
  'refund_total', 'refund_count', 'refund_amount', 'refunded_on', 'refund_id',
  'limit', 'metrics', 'window', 'SQL', 'SN', 'CNY',
];

function assertChineseCopy(text: string, label: string): void {
  assert.equal(typeof text, 'string', `${label} is a string`);
  let rest = text;
  for (const token of LATIN_TOKENS) rest = rest.split(token).join(' ');
  assert.ok(hanCount(rest) >= 4, `${label} is written in Chinese: ${text}`);
  assert.equal(/[A-Za-z]/u.test(rest), false, `${label} carries no English prose: ${text}`);
}

test('a compound question executes each part against its own Release and discloses differing as-of times', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const auditsBefore = dataProductAudits(s.fixture);
  const answered = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  assert.equal(answered.status, 'complete');
  assert.equal(answered.parts.length, 2, 'one independent part per named product');
  assert.equal(dataProductAudits(s.fixture), auditsBefore + 2, 'each part executes exactly one governed read');

  // No cross-product snapshot and no implicit join: the answer carries no
  // single top-level result, and each part names its own Release and evidence.
  assert.equal(answered.result, null);
  assert.equal(answered.query, null);
  assert.equal(answered.data_product, null);
  const parts = answered.parts;
  const byName = new Map(parts.map((part) => [String(part['name']), part]));
  const ledger = byName.get('设备维修台账');
  const refund = byName.get('退款台账');
  assert.ok(ledger && refund, 'both parts are disclosed by name');
  assert.equal(ledger!['executed'], true);
  assert.equal(refund!['executed'], true);
  for (const part of [ledger!, refund!]) {
    assert.ok(part['query'] !== null && part['result'] !== null, 'the part carries its own compiled query and result');
    const evidence = asRecord(part['evidence']);
    assert.deepEqual(evidence['query'], part['query'], 'the part carries its normalized query as evidence');
    assert.deepEqual(evidence['provenance'], part['provenance'], 'the evidence cites the part Provenance');
    assert.ok((evidence['metrics'] as unknown[]).length > 0, 'the evidence names the metric definitions it used');
    assert.ok(
      (part['defaults_applied'] as Array<Record<string, unknown>>).some((entry) => entry['name'] === 'limit'),
      'the part discloses the governed default it applied',
    );
    const direct = directPart(s, part);
    assert.deepEqual(
      governedNumbers(asRecord(part['result'])),
      governedNumbers(direct),
      `${String(part['name'])} returns exactly what its own Release computes`,
    );
    assert.deepEqual(part['provenance'], direct['provenance'], 'the part cites its own Provenance');
    assert.equal(asRecord(part['data_product'])['data_product_release'], direct['data_product_release']);
  }
  assert.notEqual(
    asRecord(asRecord(ledger!['provenance'])['source'])['source_id'],
    asRecord(asRecord(refund!['provenance'])['source'])['source_id'],
    'each part reads its own Source, never one cross-product snapshot',
  );

  // Differing as-of times are disclosed per part and called out once.
  const ledgerAsOf = asRecord(ledger!['freshness']);
  const refundAsOf = asRecord(refund!['freshness']);
  assert.equal(ledgerAsOf['data_through'], '2026-01-20', 'the ledger reaches only its own last governed day');
  assert.equal(refundAsOf['data_through'], '2026-02-10', 'the refund ledger reaches a different as-of day');
  const asOfTimes = answered.as_of;
  assert.equal(asOfTimes.length, 2);
  assert.equal(asOfTimes.filter((entry) => entry['executed'] === true).length, 2);
  assert.ok(
    answered.limitations.some((line) => line.includes('截止时间不同')),
    `the differing as-of times are stated: ${answered.limitations.join(' | ')}`,
  );

  // The governed Audit Event records how many independent parts ran.
  const audited = lastNaturalLanguageAudit(s.fixture);
  assert.equal(audited['parts'], 2);
  assert.equal(audited['parts_executed'], 2);
  assert.equal(audited['nlq_status'], 'complete');

  // A window past the ledger's coverage makes only that part partial.
  assert.equal(ledger!['partial_period'], true, 'the ledger part is a partial period');
  assert.equal(refund!['partial_period'], false, 'the refund part is complete for the same window');

  // The narrative restates only governed numbers, from both parts.
  const narrative = String(asRecord(answered.answer)['narrative'] ?? '');
  assertChineseCopy(narrative, 'the compound narrative');
  const governed = new Set(
    (JSON.stringify([governedNumbers(asRecord(ledger!['result'])), governedNumbers(asRecord(refund!['result']))])
      .match(/\d+(?:\.\d+)?/gu) ?? []).map((token) => String(Number(token))),
  );
  const stated = (narrative.match(/\d+(?:\.\d+)?/gu) ?? []).map((token) => String(Number(token)));
  assert.ok(stated.length > 0);
  for (const token of stated) {
    assert.ok(governed.has(token), `the narrative number ${token} is governed by an executed part`);
  }

  // A narrative that invents a relationship between the products is dropped.
  s.endpoint.behaviour = 'invented_relationship_narration';
  const relational = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(relational.outcome, 'answered', JSON.stringify(relational));
  assert.equal(relational.answer, null, 'an invented cross-product relationship is dropped');
  assert.equal(relational.reason_code, 'NARRATIVE_INVENTED_RELATIONSHIP');
  assert.ok(
    relational.limitations.some((line) => line.includes('跨产品关联')),
    'the dropped relationship is disclosed',
  );
  assert.equal(relational.parts.length, 2, 'the deterministic parts still stand without the narrative');
});

test('a compound plan may not join products, and an unauthorized part is never executed', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  // A join across products is executable composition and is refused by name.
  s.endpoint.behaviour = 'cross_product_join_plan';
  const before = dataProductAudits(s.fixture);
  const joined = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(joined.outcome, 'refused', JSON.stringify(joined));
  assert.equal(joined.executed, false);
  assert.equal(joined.parts.length, 0);
  assert.equal(dataProductAudits(s.fixture), before, 'a refused join never reaches the engine');

  // A part naming a Product handle this turn never authorized runs nothing, and
  // the remaining independent part still answers.
  s.endpoint.behaviour = 'foreign_product_plan';
  const forged = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(forged.outcome, 'partial', JSON.stringify(forged));
  assert.equal(forged.status, 'incomplete');
  assert.equal(forged.parts.length, 2);
  const refusedPart = forged.parts.find((part) => part['executed'] !== true);
  const answeredPart = forged.parts.find((part) => part['executed'] === true);
  assert.ok(refusedPart && answeredPart, 'one part is refused and one answers');
  assert.equal(refusedPart!['reason_code'], 'NLQ_PART_NOT_AUTHORIZED');
  assert.equal(refusedPart!['data_product'], null, 'an unauthorized part discloses no product metadata');
  assert.equal(refusedPart!['result'], null);
  assert.ok(answeredPart!['result'] !== null, 'the authorized part is not discarded');
  assert.equal(forged.answer, null, 'an incomplete answer is not narrated as if it were whole');
  assert.equal(JSON.stringify(forged).includes('forged-product-handle'), false, 'a forged handle is never echoed');

  // An unauthorized metric in one part refuses only that part.
  s.endpoint.behaviour = 'unpublished_metric_one_part';
  const unpublished = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(unpublished.outcome, 'partial', JSON.stringify(unpublished));
  assert.equal(unpublished.status, 'incomplete');
  assert.equal(unpublished.reason_code, 'NLQ_INCOMPLETE_PARTS');
  const refusedMetric = unpublished.parts.find((part) => part['reason_code'] === 'NLQ_METRIC_NOT_PUBLISHED');
  const answeredMetric = unpublished.parts.find((part) => part['executed'] === true);
  assert.ok(refusedMetric && answeredMetric, 'only the part naming the unpublished metric is refused');
  assert.ok(
    unpublished.limitations.some((line) => line.includes('已发布契约')),
    'the refused part states a safe limitation',
  );
});

test('an unavailable part makes the compound answer visibly incomplete without leaking partial data', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const withdrawn = command(
    s.fixture,
    ['product', 'withdraw', '--product', s.refundId, '--version', '1'],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(withdrawn.status, 0, withdrawn.stderr);

  const turned = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(turned.outcome, 'partial', JSON.stringify(turned));
  assert.equal(turned.status, 'incomplete');
  assert.equal(turned.executed, true, 'the still-available part executed');
  const ledger = turned.parts.find((part) => part['name'] === '设备维修台账');
  const refund = turned.parts.find((part) => part['name'] === '退款台账');
  assert.ok(ledger && refund);
  assert.equal(ledger!['executed'], true);
  assert.equal(ledger!['result'] !== null, true);
  assert.equal(refund!['executed'], false, 'a withdrawn product executes nothing');
  assert.equal(refund!['result'], null, 'no partial data is returned for the withdrawn product');
  assert.equal(refund!['provenance'], null);
  assert.ok(turned.limitations.some((line) => line.includes('退款台账部分')), 'the failed part is named in the limitation');
  assert.ok(turned.summary.includes('不完整'), `the summary states the answer is incomplete: ${turned.summary}`);
  assertChineseCopy(turned.summary, 'the incomplete summary');
});

test('a compound question clarifies the ambiguous part in Chinese before executing anything', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  s.endpoint.behaviour = 'clarify_second_part';
  const before = dataProductAudits(s.fixture);
  const clarified = asOutput(await askWorkspace(s, ['--question', COMPOUND]));
  assert.equal(clarified.outcome, 'clarification', JSON.stringify(clarified));
  assert.equal(clarified.executed, false);
  assert.equal(clarified.parts.length, 0);
  assert.equal(clarified.result, null);
  assert.equal(dataProductAudits(s.fixture), before, 'a clarification executes no part');
  const clarification = asRecord(clarified.clarification);
  assert.deepEqual(clarification['missing'], ['period']);
  assert.equal(asRecord(clarification['part'])['name'], '退款台账', 'the clarification names the ambiguous part');
  const asked = String(clarification['question']);
  assert.ok(asked.includes('退款台账'), `the clarification names the product: ${asked}`);
  assert.match(asked, /时间范围/u);
  assertChineseCopy(asked, 'the compound clarification question');
  assertChineseCopy(clarified.summary, 'the clarification summary');

  // Answering the clarification compiles both parts and executes them.
  s.endpoint.behaviour = 'normal';
  const answered = asOutput(await askWorkspace(s, [
    '--question', COMPOUND,
    '--clarification', '退款台账的时间范围是 2026-02-01 至 2026-02-28',
  ]));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  assert.equal(answered.status, 'complete');
  assert.equal(answered.parts.length, 2);
});

test('a follow-up normalizes and reauthorizes every turn, and never carries authority itself', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const first = asOutput(await askWorkspace(s, ['--question', '2026-01-01 至 2026-01-31 设备维修台账的处理量合计是多少？']));
  assert.equal(first.outcome, 'answered', JSON.stringify(first));
  assert.equal(first.parts.length, 1, 'only the named product is planned');
  assert.equal(first.follow_up, false);
  const conversation = first.conversation;
  assert.ok(typeof conversation === 'string' && conversation.length > 0, 'the turn returns a conversation handle');
  const firstLedgerRelease = asRecord(first.parts[0]!['data_product'])['data_product_release'];

  // The ledger advances to a new Release while the refund ledger does not, so a
  // follow-up must read each part's current Release independently.
  const upload = command(
    s.fixture,
    ['acquisition', 'upload', '--source', s.sourceId, '--file', textFile(s.fixture, 'ledger-next.csv', LEDGER)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(upload.status, 0, upload.stderr);
  const released = command(s.fixture, ['dataset', 'release', '--source', s.sourceId], { token: s.workspaceAdministratorToken });
  assert.equal(released.status, 0, released.stderr);
  const republished = command(
    s.fixture,
    ['product', 'publish', '--source', s.sourceId, '--name', '设备维修台账', '--contract', jsonFile(s.fixture, 'ledger-contract-again', EXTENDED_LEDGER_CONTRACT)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(republished.status, 0, republished.stderr);

  const beforeFollowUp = dataProductAudits(s.fixture);
  const followUp = asOutput(await askWorkspace(s, [
    '--question', '2026-01-01 至 2026-02-10 设备和退款两个台账的合计分别是多少？',
    '--conversation', String(conversation),
  ]));
  assert.equal(followUp.outcome, 'answered', JSON.stringify(followUp));
  assert.equal(followUp.follow_up, true, 'the turn is recognized as a follow-up');
  assert.equal(followUp.parts.length, 2);
  assert.equal(dataProductAudits(s.fixture), beforeFollowUp + 2, 'a follow-up reauthorizes and executes each part again');

  // The plan was given the previous normalized question, not the previous answer.
  const planCall = s.endpoint.calls.filter((call) => call['purpose'] === 'query_plan').at(-1);
  const planInput = asRecord(planCall!['input']);
  assert.equal(planInput['follow_up'], true);
  assert.ok(
    (planInput['prior_questions'] as string[]).includes('2026-01-01 至 2026-01-31 设备维修台账的处理量合计是多少？'),
    'the prior normalized question reaches the planner',
  );

  const ledger = followUp.parts.find((part) => part['name'] === '设备维修台账');
  const refund = followUp.parts.find((part) => part['name'] === '退款台账');
  assert.ok(ledger && refund);
  assert.notEqual(asRecord(ledger!['data_product'])['data_product_release'], firstLedgerRelease, 'the ledger part reads its new Release');
  assert.equal(asRecord(refund!['data_product'])['data_product_release'], 1, 'the refund part keeps its own current Release');

  // A handle is not authority: tampering with it executes nothing.
  const beforeTamper = dataProductAudits(s.fixture);
  const tampered = String(conversation);
  const forged = `${tampered.slice(0, -1)}${tampered.endsWith('A') ? 'B' : 'A'}`;
  const tamperedTurn = asOutput(await askWorkspace(s, [
    '--question', '2026-01-01 至 2026-01-31 设备维修台账的处理量合计是多少？',
    '--conversation', forged,
  ]));
  assert.equal(tamperedTurn.outcome, 'refused', JSON.stringify(tamperedTurn));
  assert.equal(tamperedTurn.executed, false);
  assert.equal(tamperedTurn.reason_code, 'NLQ_CONVERSATION_INVALID');
  assert.equal(tamperedTurn.conversation, null);
  assert.equal(dataProductAudits(s.fixture), beforeTamper, 'a forged handle executes nothing');

  // A handle issued to one actor cannot be presented by another.
  const foreign = await commandAsync(
    s.fixture,
    ['product', 'ask', '--workspace', s.workspaceId, '--question', '2026-01-01 至 2026-01-31 设备维修台账的处理量合计是多少？', '--conversation', String(conversation)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(foreign.output['outcome'], 'refused');
  assert.equal(foreign.output['reason_code'], 'NLQ_CONVERSATION_INVALID');
  assert.equal(foreign.output['executed'], false);
  assert.equal(dataProductAudits(s.fixture), beforeTamper, 'another actor cannot resume the conversation');

  // Revoking the membership takes effect on the very next turn.
  const revoked = command(
    s.fixture,
    ['membership', 'revoke', '--workspace', s.workspaceId, '--username', 'analyst@example.invalid'],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(revoked.status, 0, revoked.stderr);
  const denied = await askWorkspace(s, [
    '--question', '2026-01-01 至 2026-01-31 设备维修台账的处理量合计是多少？',
    '--conversation', String(conversation),
  ]);
  assert.equal(denied.status, 2, denied.stdout);
  assert.equal(denied.error['code'], 'WORKSPACE_ACCESS_DENIED');
  assert.equal(dataProductAudits(s.fixture), beforeTamper, 'a revoked membership executes nothing');

  // Restoring the membership lets the same handle continue, because the handle
  // never carried authority in the first place.
  const restored = command(
    s.fixture,
    ['membership', 'grant', '--workspace', s.workspaceId, '--username', 'analyst@example.invalid', '--role', 'Consumer'],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(restored.status, 0, restored.stderr);
  const resumed = asOutput(await askWorkspace(s, [
    '--question', '2026-01-01 至 2026-01-31 设备维修台账的处理量合计是多少？',
    '--conversation', String(conversation),
  ]));
  assert.equal(resumed.outcome, 'answered', JSON.stringify(resumed));
  assert.equal(resumed.follow_up, true);
});

test('a compound Chinese question with a mixed SN identifier keeps every governed value deterministic', async (t) => {
  const s = await readySurface();
  t.after(() => s.endpoint.close());

  const question = '设备维修台账中 SN 为 sn-002 的 2026-01-01 至 2026-01-31 处理量合计是多少？退款台账的 2026-02-01 至 2026-02-28 退款金额合计是多少？';
  const answered = asOutput(await askWorkspace(s, ['--question', question]));
  assert.equal(answered.outcome, 'answered', JSON.stringify(answered));
  assert.equal(answered.status, 'complete');
  assert.equal(answered.parts.length, 2);

  const ledger = answered.parts.find((part) => part['name'] === '设备维修台账');
  const refund = answered.parts.find((part) => part['name'] === '退款台账');
  assert.ok(ledger && refund);
  assert.deepEqual(asRecord(ledger!['query'])['filters'], [{ field: 'sn', op: 'equals', value: 'sn-002' }], 'the identifier survives unchanged');
  assert.equal(asRecord(refund!['query'])['filters'], undefined, 'the identifier never crosses into another product');
  const ledgerTotals = asRecord(asRecord(asRecord(ledger!['result'])['totals'])['metrics']);
  const refundTotals = asRecord(asRecord(asRecord(refund!['result'])['totals'])['metrics']);
  assert.equal(ledgerTotals['handled_total'], 5);
  assert.equal(refundTotals['refund_total'], '208.00');

  // Every new piece of copy is Simplified Chinese, and numeric equality with the
  // deterministic engine survives across both products.
  assertChineseCopy(answered.summary, 'the compound summary');
  assertChineseCopy(String(asRecord(answered.answer)['narrative']), 'the compound narrative');
  for (const line of answered.limitations) assertChineseCopy(line, 'a compound limitation');
  for (const part of answered.parts) {
    assert.deepEqual(
      governedNumbers(asRecord(part['result'])),
      governedNumbers(directPart(s, part)),
      `${String(part['name'])} is unchanged by Chinese wording`,
    );
  }

  // A Chinese follow-up continues the conversation with the mixed identifier.
  const followUp = asOutput(await askWorkspace(s, [
    '--question', '那 2026-02-01 至 2026-02-28 退款台账的退款金额合计是多少？',
    '--conversation', String(answered.conversation),
  ]));
  assert.equal(followUp.outcome, 'answered', JSON.stringify(followUp));
  assert.equal(followUp.follow_up, true);
  assert.equal(followUp.parts.length, 1, 'the follow-up asks about one product');
  assert.equal(followUp.parts[0]!['name'], '退款台账');
  assert.equal(asRecord(asRecord(asRecord(followUp.parts[0]!['result'])['totals'])['metrics'])['refund_total'], '208.00');
  assertChineseCopy(followUp.summary, 'the follow-up summary');
  assertChineseCopy(String(asRecord(followUp.answer)['narrative']), 'the follow-up narrative');
});

/** The fixture ledgers are frozen inputs; this guards the expected coverage. */
test('the two certification ledgers cover the periods the as-of assertions name', () => {
  assert.ok(LEDGER.includes('2026-01-20'));
  assert.ok(REFUND_LEDGER.includes('2026-02-10'));
});
