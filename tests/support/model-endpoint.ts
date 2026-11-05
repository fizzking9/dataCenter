import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The identity every deterministic mock model answers with. */
export const MOCK_MODEL_ID = 'dc-mock-1';
export const MOCK_CONTRACT = 'datacenter.model.v1';

/**
 * How the mock answers. `normal` is a well-behaved model; every other value is
 * an adverse endpoint an adapter must refuse rather than repair. The plan and
 * narration behaviours are disjoint, so one setting can exercise a whole
 * Natural-Language Query turn without changing the other half of the answer.
 */
export type MockBehaviour =
  | 'normal'
  | 'english_narration'
  | 'ungrounded_narration'
  | 'causal_narration'
  | 'fabricated_narration'
  | 'undeclared_tool'
  | 'malformed_structured_output'
  | 'identity_mismatch'
  | 'sql_plan'
  | 'unknown_key_plan'
  | 'clarify_metric'
  | 'clarify_dimension'
  | 'omitted_metrics_plan'
  | 'unpublished_metric_plan'
  | 'english_plan';

export interface MockModelEndpoint {
  url: string;
  behaviour: MockBehaviour;
  /** Every generation request the endpoint served, for asserting pinned identity. */
  calls: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** A deterministic, network-free inference endpoint two adapters can speak to. */
export async function startMockModelEndpoint(): Promise<MockModelEndpoint> {
  const endpoint = {
    behaviour: 'normal' as MockBehaviour,
    calls: [] as Array<Record<string, unknown>>,
  };
  const server = createServer((request, response) => {
    handle(request, response, endpoint).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    get behaviour(): MockBehaviour {
      return endpoint.behaviour;
    },
    set behaviour(value: MockBehaviour) {
      endpoint.behaviour = value;
    },
    calls: endpoint.calls,
    async close() {
      await closeServer(server);
    },
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  endpoint: { behaviour: MockBehaviour; calls: Array<Record<string, unknown>> },
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (request.method === 'GET' && (path === '/health' || path === '/v1/models')) {
    respond(response, 200, { model: MOCK_MODEL_ID, contracts: [MOCK_CONTRACT] });
    return;
  }
  if (request.method === 'POST' && (path === '/generate' || path === '/v1/generate')) {
    const body = await readJson(request);
    endpoint.calls.push(body);
    respond(response, 200, answer(body, endpoint.behaviour));
    return;
  }
  respond(response, 404, { error: 'not_found' });
}

function answer(body: Record<string, unknown>, behaviour: MockBehaviour): Record<string, unknown> {
  const purpose = String(body['purpose'] ?? '');
  const envelope: Record<string, unknown> = {
    contract: MOCK_CONTRACT,
    model: behaviour === 'identity_mismatch' ? 'not-the-pinned-model' : String(body['model'] ?? ''),
    model_profile_hash: profileHashOf(body),
    output: outputFor(purpose, body, behaviour),
    tool_calls: behaviour === 'undeclared_tool' ? [{ tool: 'shell_exec', arguments: {} }] : [],
  };
  return envelope;
}

function profileHashOf(body: Record<string, unknown>): string {
  const pinned = body['model_profile'];
  return typeof pinned === 'object' && pinned !== null
    ? String((pinned as Record<string, unknown>)['hash'] ?? '')
    : '';
}

function outputFor(purpose: string, body: Record<string, unknown>, behaviour: MockBehaviour): unknown {
  if (purpose === 'query_plan') return queryPlan(body, behaviour);
  if (purpose === 'grounded_narration') return narration(body, behaviour);
  if (purpose === 'clarification') return clarification(body, behaviour);
  return integrationConfiguration(body, behaviour);
}

/**
 * Compiles the supplied question into the Contract vocabulary with the same
 * mechanical determinism the real platform demands of a model. It never emits
 * anything wider than the published query language; the adverse behaviours
 * deliberately do, so certification can prove the platform refuses them.
 */
function queryPlan(body: Record<string, unknown>, behaviour: MockBehaviour): Record<string, unknown> {
  if (behaviour === 'english_plan') {
    return {
      action: 'query',
      interpretation: 'Summarise the handled total for the selected period.',
      query: { kind: 'aggregate', metrics: ['handled_total'], window: { start: '2026-01-01', end: '2026-01-31' } },
    };
  }

  if (behaviour === 'sql_plan') {
    return {
      action: 'query',
      interpretation: '使用 SQL 直接读取受治理记录。',
      query: { kind: 'records', sql: 'SELECT * FROM device_ledger', limit: 10 },
    };
  }
  if (behaviour === 'unknown_key_plan') {
    return {
      action: 'query',
      interpretation: '读取受治理的设备记录。',
      query: { kind: 'records', select: 'sn', limit: 10 },
    };
  }
  if (behaviour === 'unpublished_metric_plan') {
    return {
      action: 'query',
      interpretation: '统计一个未在已发布契约中的指标。',
      query: { kind: 'aggregate', metrics: ['settled_median'], window: { start: '2026-01-01', end: '2026-01-31' } },
    };
  }

  if (behaviour === 'clarify_metric') {
    return {
      action: 'clarify',
      interpretation: '无法确定要统计的已发布指标。',
      missing: ['metric'],
      candidates: [],
    };
  }
  if (behaviour === 'clarify_dimension') {
    return {
      action: 'clarify',
      interpretation: '无法确定要分组使用的已发布维度。',
      missing: ['dimension'],
      candidates: [],
    };
  }

  const input = isRecord(body['input']) ? body['input'] : {};
  const contract = isRecord(input['contract']) ? input['contract'] : {};
  const parts = [input['question'], input['clarification']]
    .filter((part): part is string => typeof part === 'string');
  const question = parts.join(' ');
  const metrics = recordsOf(contract['metrics']).map((metric) => String(metric['name'] ?? '')).filter(Boolean);
  const dimensions = stringsOf(contract['dimensions']);
  const filters = stringsOf(contract['filters']);
  const ranges = rangesIn(question);
  const window = ranges[0];
  const comparison = /相比|对比|环比|同比/u.test(question) ? ranges[1] : undefined;
  const metric = pickMetric(question, metrics);
  const filter = filterIn(question, filters);
  const groupBy = /各|按|每个|分别|分组/u.test(question) && dimensions.length > 0
    ? [dimensions[0]!]
    : [];
  const aggregate = /合计|总计|一共|多少|平均|变化|趋势/u.test(question) || metric !== null;

  if (!aggregate) {
    return {
      action: 'query',
      interpretation: '按已发布的受治理契约读取记录，并限定所选业务范围。',
      query: {
        kind: 'records',
        ...(filter === null ? {} : { filters: [filter] }),
        ...(window === undefined ? {} : { window }),
        limit: 10,
      },
    };
  }
  return {
    action: 'query',
    interpretation: planInterpretation(metric, groupBy, filter, window !== undefined),
    query: {
      kind: 'aggregate',
      ...(behaviour === 'omitted_metrics_plan' || metric === null ? {} : { metrics: [metric] }),
      ...(filter === null ? {} : { filters: [filter] }),
      ...(groupBy.length === 0 ? {} : { group_by: groupBy }),
      ...(window === undefined ? {} : { window }),
      ...(comparison === undefined ? {} : { comparison }),
      ...(behaviour === 'omitted_metrics_plan' ? {} : { include_totals: true }),
    },
  };
}

function planInterpretation(
  metric: string | null,
  groupBy: string[],
  filter: Record<string, unknown> | null,
  hasWindow: boolean,
): string {
  const parts = ['按已发布的受治理契约'];
  if (filter !== null) parts.push('筛选所选业务条件');
  if (groupBy.length > 0) parts.push('按已发布维度分组');
  parts.push(metric === null ? '读取记录' : `统计所选指标 ${metric}`);
  if (hasWindow) parts.push('限定时间范围');
  return `${parts.join('，')}。`;
}

function pickMetric(question: string, metrics: string[]): string | null {
  if (/平均结算|平均金额/u.test(question) && metrics.includes('settled_average')) return 'settled_average';
  if (/结算|金额/u.test(question) && metrics.includes('settled_total')) return 'settled_total';
  if (/多少条|条数|记录数|设备数/u.test(question) && metrics.includes('device_count')) return 'device_count';
  if (/处理量|处理/u.test(question) && metrics.includes('handled_total')) return 'handled_total';
  if (metrics.includes('handled_total')) return 'handled_total';
  return metrics[0] ?? null;
}

function filterIn(question: string, filters: string[]): Record<string, unknown> | null {
  const sn = /SN\s*(?:为|是|=|:)?\s*([A-Za-z0-9_-]+)/iu.exec(question);
  const snValue = sn?.[1];
  if (snValue !== undefined && filters.includes('sn')) {
    return { field: 'sn', op: 'equals', value: snValue };
  }
  if (question.includes('无证据') && filters.includes('city')) {
    return { field: 'city', op: 'is_null' };
  }
  for (const city of ['杭州', '上海', '北京']) {
    if (question.includes(city) && filters.includes('city')) {
      return { field: 'city', op: 'equals', value: city };
    }
  }
  return null;
}

const RANGE = /(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|—|–)\s*(\d{4}-\d{2}-\d{2})/gu;

function rangesIn(question: string): Array<{ start: string; end: string }> {
  return [...question.matchAll(RANGE)].map((match) => ({
    start: String(match[1]),
    end: String(match[2]),
  }));
}

/**
 * Composes the candidate Integration Configuration the supplied data dictionary
 * asks for. It is deliberately mechanical: certification needs a frozen answer,
 * not a model.
 */
function integrationConfiguration(
  body: Record<string, unknown>,
  behaviour: MockBehaviour,
): Record<string, unknown> {
  const input = isRecord(body['input']) ? body['input'] : {};
  const fields = Array.isArray(input['fields'])
    ? input['fields'].filter((field): field is Record<string, unknown> => isRecord(field))
    : [];
  const candidate = {
    identity: fields.filter((field) => field['identity'] === true).map((field) => String(field['name'])),
    schema: fields.map((field) => ({ name: String(field['name']), type: String(field['type']) })),
    cleaning: fields.flatMap((field) => (Array.isArray(field['clean']) ? field['clean'] : []).map((rule) => ({
      rule: String(rule),
      field: String(field['name']),
    }))),
    mapping: Object.fromEntries(fields.map((field) => [String(field['source_column']), String(field['name'])])),
  };
  if (behaviour === 'malformed_structured_output') {
    return { identity: [], schema: [], cleaning: [], mapping: {} };
  }
  return candidate;
}

/**
 * Answers with the first governed record's value, which the evaluation evidence
 * really contains; the adverse modes answer in English, cite a value that is
 * nowhere in the evidence, state a cause the evidence does not support, or add
 * an invented number beside a governed one.
 */
function narration(body: Record<string, unknown>, behaviour: MockBehaviour): Record<string, unknown> {
  const input = isRecord(body['input']) ? body['input'] : {};
  const records = recordsOf(input['records']);
  const first = records[0] ?? {};
  const key = ['value', 'handled_count', 'settled_amount', 'device_count']
    .find((candidate) => typeof first[candidate] === 'number') ?? null;
  const value = key === null ? 0 : Number(first[key]);
  const label = typeof first['label'] === 'string' ? first['label'] : null;
  if (behaviour === 'english_narration') {
    return {
      narrative: `The handled count for the first governed record is ${String(value)}.`,
      evidence_refs: [{ field: key ?? 'value', value }],
    };
  }
  if (behaviour === 'ungrounded_narration') {
    return {
      narrative: '根据证据，合计处理量为 999。',
      evidence_refs: [{ field: key ?? 'value', value: 999 }],
    };
  }
  if (behaviour === 'causal_narration') {
    return {
      narrative: `根据证据，因为处理量发生变化，受治理合计为 ${String(value)}。`,
      evidence_refs: [{ field: key ?? 'value', value }],
    };
  }
  if (behaviour === 'fabricated_narration') {
    return {
      narrative: `根据证据，受治理合计为 ${String(value)}，比上期增加 999。`,
      evidence_refs: [{ field: key ?? 'value', value }],
    };
  }
  if (key === null) {
    return { narrative: '根据证据，所选范围内没有可引用的数值。', evidence_refs: [] };
  }
  return {
    narrative: label === null
      ? `根据证据，第一条受治理记录的数值为 ${String(value)}。`
      : `根据证据，${label}的数值为 ${String(value)}。`,
    evidence_refs: [{ field: key, value }],
  };
}

/**
 * A clarification is targeted by its structured `missing` kind, while the
 * candidate identifiers stay in the response's structured fields. The question
 * itself stays Simplified Chinese even when a candidate is a Latin identifier.
 */
function clarification(body: Record<string, unknown>, behaviour: MockBehaviour): Record<string, unknown> {
  if (behaviour === 'english_narration') {
    return { question: 'Which period should the answer cover?' };
  }
  const input = isRecord(body['input']) ? body['input'] : {};
  const missing = stringsOf(input['missing']);
  if (missing.includes('metric')) {
    return { question: '请确认要统计哪个已发布的指标？' };
  }
  if (missing.includes('dimension')) {
    return { question: '请确认要按哪个已发布的维度分组？' };
  }
  if (missing.includes('filter_value')) {
    return { question: '请确认筛选条件具体对应哪个取值？' };
  }
  return { question: '请确认要统计的时间范围（起止日期）？' };
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
