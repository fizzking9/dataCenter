import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The identity every deterministic mock model answers with. */
export const MOCK_MODEL_ID = 'dc-mock-1';
export const MOCK_CONTRACT = 'datacenter.model.v1';

/**
 * How the mock answers. `normal` is a well-behaved model; every other value is
 * an adverse endpoint an adapter must refuse rather than repair.
 */
export type MockBehaviour =
  | 'normal'
  | 'english_narration'
  | 'ungrounded_narration'
  | 'undeclared_tool'
  | 'malformed_structured_output'
  | 'unauthorized_field'
  | 'unauthorized_dimension'
  | 'unauthorized_metric'
  | 'identity_mismatch';

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
  if (purpose === 'grounded_narration') return narration(body, behaviour);
  if (purpose === 'clarification') return clarification(behaviour);
  if (purpose === 'data_product_proposal') return productContract(body, behaviour);
  return integrationConfiguration(body, behaviour);
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
 * really contains; the adverse modes answer in English or cite a value that is
 * nowhere in the evidence.
 */
function narration(body: Record<string, unknown>, behaviour: MockBehaviour): Record<string, unknown> {
  const input = isRecord(body['input']) ? body['input'] : {};
  const records = Array.isArray(input['records'])
    ? input['records'].filter((record): record is Record<string, unknown> => isRecord(record))
    : [];
  const first = records[0] ?? {};
  const value = typeof first['handled_count'] === 'number' ? first['handled_count'] : 0;
  if (behaviour === 'english_narration') {
    return {
      narrative: `The handled count for the first governed record is ${String(value)}.`,
      evidence_refs: [{ field: 'handled_count', value }],
    };
  }
  if (behaviour === 'ungrounded_narration') {
    return {
      narrative: '根据证据，合计处理量为 999。',
      evidence_refs: [{ field: 'handled_count', value: 999 }],
    };
  }
  return {
    narrative: `根据证据，第一条受治理记录的处理量为 ${String(value)}。`,
    evidence_refs: [{ field: 'handled_count', value }],
  };
}

/**
 * Composes the Data Product Contract the supplied authorised evidence asks
 * for. It is deliberately mechanical: certification needs a frozen answer, not
 * a model. Every name it emits comes from the input it was given, except the
 * adverse modes, which name something the input never authorised.
 */
function productContract(body: Record<string, unknown>, behaviour: MockBehaviour): Record<string, unknown> {
  const input = isRecord(body['input']) ? body['input'] : {};
  const dataset = isRecord(input['dataset']) ? input['dataset'] : {};
  const fields = Array.isArray(dataset['fields'])
    ? dataset['fields'].filter((field): field is Record<string, unknown> => isRecord(field))
    : [];
  const identity = Array.isArray(dataset['identity_fields']) ? dataset['identity_fields'].map(String) : [];
  const definitions = Array.isArray(input['metric_definitions'])
    ? input['metric_definitions'].filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const schema: Array<{ name: string; type: string }> = fields.map((field) => ({
    name: String(field['name']),
    type: String(field['type']),
  }));
  const typeOf = (name: string): string | undefined => schema.find((field) => field.name === name)?.type;
  const exposed: Array<Record<string, unknown>> = schema.map((field) => ({ name: field.name, description: `${field.name} 字段` }));
  const dimensions: string[] = schema
    .filter((field) => field.type === 'string' && !identity.includes(field.name))
    .map((field) => field.name);
  const metrics: Array<Record<string, unknown>> = [];
  for (const definition of definitions) {
    const key = String(definition['key']);
    const suffix = ([['_total', 'sum'], ['_count', 'count'], ['_avg', 'avg'], ['_min', 'min'], ['_max', 'max']] as const)
      .find(([ending]) => key.endsWith(ending));
    const field = suffix === undefined ? undefined : key.slice(0, -suffix[0].length);
    const fieldType = field === undefined ? undefined : typeOf(field);
    if (suffix === undefined || fieldType === undefined || suffix[1] === 'count') {
      metrics.push({ name: key, aggregation: 'count', value_type: 'integer' });
      continue;
    }
    const aggregation = suffix[1];
    const valueType = aggregation === 'avg' ? 'decimal' : fieldType === 'integer' ? 'integer' : fieldType === 'number' ? 'decimal' : fieldType;
    metrics.push({
      name: key,
      description: String(definition['value'] ?? key),
      aggregation,
      field,
      value_type: valueType,
      ...(typeof definition['unit'] === 'string' ? { unit: definition['unit'] } : {}),
    });
  }
  const timeField = schema.find((field) => field.type === 'date' || field.type === 'timestamp');
  const grain = identity.length > 0 ? identity : schema.slice(0, 1).map((field) => field.name);
  const contract: Record<string, unknown> = {
    title: String(input['name'] ?? '数据产品契约'),
    description: String(input['requirement'] ?? ''),
    fields: exposed,
    dimensions,
    metrics,
    grain,
    ...(timeField === undefined ? {} : { time: { field: timeField.name, precision: timeField.type, time_zone: 'Asia/Shanghai' } }),
    filters: exposed.map((field) => String(field['name'])),
    limit: { default: 100, max: 500 },
  };
  if (behaviour === 'malformed_structured_output') return { fields: [] };
  if (behaviour === 'unauthorized_field') {
    exposed.push({ name: 'secret_field', description: '另一个工作区的字段' });
  }
  if (behaviour === 'unauthorized_dimension') {
    dimensions.push('secret_dimension');
  }
  if (behaviour === 'unauthorized_metric') {
    const numeric = schema.find((field) => field.type === 'integer' || field.type === 'number');
    if (numeric !== undefined) {
      metrics.push({
        name: 'foreign_total',
        aggregation: 'sum',
        field: numeric.name,
        value_type: numeric.type === 'integer' ? 'integer' : 'decimal',
      });
    }
  }
  return contract;
}

function clarification(behaviour: MockBehaviour): Record<string, unknown> {
  if (behaviour === 'english_narration') {
    return { question: 'Which period should the answer cover?' };
  }
  return { question: '请确认要统计的时间范围是哪一段？' };
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
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
