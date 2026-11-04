/**
 * A standalone HTTP source process.
 *
 * It must be its own process: a governed command is run synchronously from the
 * test process, so an in-process server could never answer the connector.
 *
 * argv[2] is a JSON scenario: `{ replies: [{ status?, body }], repeat_last, log }`.
 * The last request line is appended to `log` as JSON, and the chosen port is
 * printed to stdout once the server is listening.
 */
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Reply {
  status?: number;
  body: string;
}

interface Scenario {
  replies: Reply[];
  repeat_last?: boolean;
  log: string;
}

const scenario = JSON.parse(process.argv[2] ?? '{}') as Scenario;
let served = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  appendFileSync(scenario.log, `${JSON.stringify({
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    authorization: request.headers.authorization ?? null,
  })}\n`);

  const index = scenario.repeat_last === false ? served : Math.min(served, scenario.replies.length - 1);
  served += 1;
  const reply = scenario.replies[index];
  if (reply === undefined) {
    response.statusCode = 500;
    response.end('{"error":"no reply configured"}');
    return;
  }
  response.statusCode = reply.status ?? 200;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(reply.body);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
