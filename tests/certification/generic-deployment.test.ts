import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEVICES, readySource } from '../support/acquisition.js';
import { pageBody, startHttpSource } from '../support/http-source.js';
import { command, jsonFile } from '../support/platform.js';

const ENGINE_DIRECTORY = fileURLToPath(new URL('../../../src', import.meta.url));

/** Every application, connector-engine, and semantic-execution source file. */
function engineSources(): Array<{ name: string; text: string }> {
  return readdirSync(ENGINE_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(`${ENGINE_DIRECTORY}/${name}`, 'utf8') }));
}

/**
 * The reference workload is configuration, so the engine must not know it
 * exists. A business-case-named module, branch, schema key, or special case
 * would make one customer's data the platform's behavior; this reads the
 * application the Deployment actually ships and proves it carries none.
 */
test('the application and connector engine carry no business-case name, branch, or schema key', () => {
  const sources = engineSources();
  assert.ok(sources.length > 40, 'the application source is what is being read');

  const businessNames = /\bai[-_ ]?acc\b|\baiacc\b|\bbms\b|受理工单|接管状态|设备编号/u;
  const named = sources
    .filter((source) => businessNames.test(source.text))
    .map((source) => source.name);
  assert.deepEqual(named, [], 'no module, branch, or schema key names a business case');

  // The connector engine is one declarative implementation with no per-source
  // switch: it executes whatever versioned configuration a Plan pinned.
  const connector = sources.find((source) => source.name === 'connector.ts')!;
  assert.equal(/case\s+['"]/u.test(connector.text), false, 'the connector dispatches on configuration, never on a source name');
  assert.equal(connector.text.includes('source_id ==='), false, 'no engine path special-cases one Source');
});

/**
 * With the reference workload removed, what is left is a generic Deployment:
 * the same commands, a different declarative configuration, and the numbers
 * that configuration's own data produces. The declared span is honoured as
 * written, which is what makes the seven-day reference ceiling configuration
 * rather than an engine constant.
 */
test('a Deployment configured without the reference workload reads its own windows and its own results', async () => {
  const source = await startHttpSource({ replies: [{ body: pageBody(DEVICES) }] });
  const ready = await readySource(source, {
    name: '巡检处理导出',
    connectionName: '巡检系统',
    pagination: { parameter: 'page', size_parameter: 'page_size', start: 1, size: 10, max_pages: 2 },
    window: {
      mode: 'incremental',
      start_parameter: 'from',
      end_parameter: 'to',
      initial_start: '2026-04-25T00:00:00.000Z',
      maximum_span_minutes: 2 * 24 * 60,
      lookback_minutes: 0,
    },
    integration: {
      identity: ['device'],
      schema: [
        { name: 'device', type: 'string' },
        { name: 'city', type: 'string' },
        { name: 'handled', type: 'integer' },
      ],
      cleaning: [{ rule: 'trim', field: 'device' }],
      mapping: { device_sn: 'device', city: 'city', handled_count: 'handled' },
    },
  });
  const { fixture, sourceId, workspaceAdministratorToken: token } = ready;

  const windows: string[][] = [];
  for (const at of ['2026-04-27T00:00:00.000Z', '2026-04-29T00:00:00.000Z']) {
    const enqueued = command(fixture, ['acquisition', 'enqueue', '--source', sourceId], { token });
    assert.equal(enqueued.status, 0, enqueued.stderr);
    const worked = command(fixture, ['acquisition', 'work', '--source', sourceId, '--at', at], { token });
    assert.equal(worked.status, 0, worked.stderr);
    assert.equal(worked.output['status'], 'complete');
    const window = (worked.output['plan'] as { window: { start: string; end: string } }).window;
    windows.push([window.start, window.end]);
  }
  assert.deepEqual(windows, [
    ['2026-04-25T00:00:00.000Z', '2026-04-27T00:00:00.000Z'],
    ['2026-04-27T00:00:00.000Z', '2026-04-29T00:00:00.000Z'],
  ], 'a two-day declared span is read exactly as declared, so the seven-day ceiling is configuration');

  const published = command(
    fixture,
    [
      'product', 'publish', '--source', sourceId, '--name', '巡检处理量',
      '--contract', jsonFile(fixture, 'inspection-contract', {
        title: '巡检处理量',
        fields: [{ name: 'device' }, { name: 'city' }, { name: 'handled' }],
        dimensions: ['city'],
        metrics: [
          { name: 'record_count', aggregation: 'count', value_type: 'integer' },
          { name: 'handled_total', aggregation: 'sum', field: 'handled', value_type: 'integer' },
        ],
        grain: ['device'],
        filters: ['city'],
      }),
    ],
    { token },
  );
  assert.equal(published.status, 0, published.stderr);
  const queried = command(
    fixture,
    [
      'product', 'query', '--product', String(published.output['data_product_id']),
      '--request', jsonFile(fixture, 'inspection-query', {
        kind: 'aggregate',
        metrics: ['record_count', 'handled_total'],
        include_totals: true,
      }),
    ],
    { token },
  );
  assert.equal(queried.status, 0, queried.stderr);
  assert.deepEqual(
    (queried.output['totals'] as { metrics: Record<string, number> }).metrics,
    { record_count: 5, handled_total: 21 },
    'the results are this Deployment\'s own data: 3+5+2+7+4',
  );

  const measured = command(fixture, ['acquisition', 'targets', '--source', sourceId], { token });
  assert.equal(measured.status, 0, measured.stderr);
  assert.deepEqual(
    {
      schedule: measured.output['schedule'],
      targets: measured.output['publication_targets'],
      start: measured.output['start'],
      publication: measured.output['publication'],
    },
    { schedule: null, targets: null, start: null, publication: null },
    'a Source that declared no cadence claims no target it never stated',
  );
  await source.close();
});
