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
