import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from '../support/model-endpoint.js';
import { startHttpSource, type HttpSource } from '../support/http-source.js';
import {
  command,
  jsonFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

type Config = Record<string, unknown>;

const CREDENTIAL = 'report-token-7f3c';

/** One record-bearing row: the cells the output contract reads. */
function row(containerClass: string, serialClass: string, sn: string, city: string, count: string): string {
  return `<tr class="${containerClass}"><td class="${serialClass}">${sn}</td><td class="city">${city}</td><td class="count">${count}</td></tr>`;
}

/** The page the Task Version pins, and the target before it changes. */
const BASE_PAGE = [
  '<html><body><table>',
  row('record', 'sn', 'dev-1', '杭州', '12'),
  row('record', 'sn', 'dev-2', '上海', '3'),
  '</table></body></html>',
].join('');

/** The same records after a controlled target change renames one cell class. */
const CHANGED_PAGE = [
  '<html><body><table>',
  row('record', 'serial', 'dev-1', '杭州', '12'),
  row('record', 'serial', 'dev-2', '上海', '3'),
  '</table></body></html>',
].join('');

/** The next page proves exhaustion; a scraper never guesses that the end was reached. */
const EMPTY_PAGE = '<html><body><table></table></body></html>';

const TABLE_RECORDS = [
  { sn: 'dev-1', city: '杭州', handled_count: '12' },
  { sn: 'dev-2', city: '上海', handled_count: '3' },
];

const INTEGRATION: Config = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
  ],
  cleaning: [],
  mapping: { sn: 'sn', city: 'city', handled_count: 'handled_count' },
};

interface Surface extends WorkspaceFixture {
  sourceId: string;
}

interface StateFile {
  artifact_proposals: Config[];
  scraper_tasks: Config[];
  scraper_services: Config[];
  source_scraper_services: Config[];
  scraper_credentials: Config[];
  scraper_runs: Config[];
  scraper_diagnostics: Config[];
  model_profiles: Config[];
  model_bindings: Config[];
  raw_acquisitions: unknown[];
  acquisition_runs: unknown[];
  integration_batches: unknown[];
  datasets: Config[];
}

function asRecord(value: unknown): Config {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Config;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

/** One Workspace holding a Workspace Administrator, a Consumer, and one scraper Source. */function surface(): Surface {
  const base: WorkspaceFixture = workspaceFixture();
  const created = command(
    base.fixture,
    ['source', 'create', '--workspace', base.workspaceId, '--name', '设备处理量报表', '--type', 'scraper'],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...base, sourceId: String(created.output['source_id']) };
}

function stateOf(s: Surface): StateFile {
  return JSON.parse(readFileSync(join(s.fixture.root, 'state', 'platform.json'), 'utf8')) as StateFile;
}

/** The Task document the base Service Version was compiled from. */
function taskConfig(source: HttpSource, overrides: Config = {}): Config {
  return {
    target: {
      base_url: source.url,
      path: '/reports/{month}',
      page_parameter: 'page',
      first_page: 1,
      max_pages: 3,
    },
    network_scope: { origins: [source.url], paths: ['/reports'] },
    output: {
      record_selector: 'tr.record',
      fields: [
        { name: 'sn', selector: 'td.sn' },
        { name: 'city', selector: 'td.city' },
        { name: 'handled_count', selector: 'td.count' },
      ],
    },
    parameters: [
      { name: 'month', type: 'string', required: false, default: '2026-01' },
      { name: 'region', type: 'string', required: true },
    ],
    fixtures: {
      version: 1,
      pages: [
        {
          name: '处理量第一页',
          path: '/reports/2026-01?page=1',
          content_type: 'text/html',
          body: BASE_PAGE,
          expected_record_count: 2,
          expected_records: TABLE_RECORDS,
        },
      ],
    },
    constraints: { timeout_ms: 5_000, max_bytes: 1_048_576, max_records: 1_000 },
    credential_refs: ['报表账号'],
    ...overrides,
  };
}

function publishTask(s: Surface, name: string, config: Config): { taskId: string; version: number; output: Config } {
  const published = command(
    s.fixture,
    ['scraper', 'task', '--workspace', s.workspaceId, '--name', name, '--config', jsonFile(s.fixture, `task-${name}-${Math.random()}`, config)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  return {
    taskId: String(published.output['scraper_task_id']),
    version: Number(published.output['scraper_task_version']),
    output: published.output,
  };
}

function compile(s: Surface, taskId: string, version?: number): Config {
  const compiled = command(
    s.fixture,
    ['scraper', 'compile', '--task', taskId, ...(version === undefined ? [] : ['--version', String(version)])],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  return compiled.output;
}

function validate(s: Surface, proposalId: string): Config {
  const validated = command(s.fixture, ['scraper', 'validate', '--proposal', proposalId], {
    token: s.workspaceAdministratorToken,
  });
  return { ...validated.output, exit: validated.status, error: validated.error, stderr: validated.stderr };
}

function decide(s: Surface, verb: 'approve' | 'publish' | 'verify', proposalId: string, extra: string[] = []): Config {
  const result = command(s.fixture, ['scraper', verb, '--proposal', proposalId, ...extra], {
    token: s.workspaceAdministratorToken,
  });
  return { ...result.output, exit: result.status, error: result.error, stderr: result.stderr };
}

function adopt(s: Surface, proposalId: string, sourceId: string): Config {
  const result = command(
    s.fixture,
    ['scraper', 'adopt', '--proposal', proposalId, '--source', sourceId],
    { token: s.workspaceAdministratorToken },
  );
  return { ...result.output, exit: result.status, error: result.error, stderr: result.stderr };
}

function publishCredential(s: Surface, ref = '报表账号'): void {
  const published = command(
    s.fixture,
    ['scraper', 'credential', '--workspace', s.workspaceId, '--name', ref, '--location', 'bearer', '--credential-stdin'],
    { token: s.workspaceAdministratorToken, input: `${CREDENTIAL}\n` },
  );
  assert.equal(published.status, 0, published.stderr);
}

function adoptIntegration(s: Surface): void {
  const published = command(
    s.fixture,
    ['integration', 'publish', '--source', s.sourceId, '--config', jsonFile(s.fixture, `integration-${Math.random()}`, INTEGRATION)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const adopted = command(
    s.fixture,
    ['integration', 'adopt', '--source', s.sourceId, '--version', String(published.output['integration_configuration_version'])],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
}

function run(s: Surface, parameters?: Config): Config {
  const result = command(
    s.fixture,
    [
      'scraper', 'run', '--source', s.sourceId,
      ...(parameters === undefined ? [] : ['--parameters', jsonFile(s.fixture, `run-parameters-${Math.random()}`, parameters)]),
    ],
    { token: s.workspaceAdministratorToken },
  );
  return { ...result.output, exit: result.status, error: result.error, stderr: result.stderr };
}

function diagnostics(s: Surface, selector: { run?: string; proposal?: string; id?: string }): Config {
  const result = command(
    s.fixture,
    [
      'scraper', 'diagnostics',
      ...(selector.run === undefined ? [] : ['--run', selector.run]),
      ...(selector.proposal === undefined ? [] : ['--proposal', selector.proposal]),
      ...(selector.id === undefined ? [] : ['--diagnostics', selector.id]),
    ],
    { token: s.workspaceAdministratorToken },
  );
  return { ...result.output, exit: result.status, error: result.error, stderr: result.stderr };
}

/** Publishes, validates, approves, publishes, verifies, and adopts one Scraper Service. */
function adoptScraper(s: Surface, config: Config, name: string): { proposalId: string; version: number; taskId: string } {
  const task = publishTask(s, name, config);
  const proposalId = String(compile(s, task.taskId)['proposal_id']);
  assert.equal(validate(s, proposalId)['passed'], true, JSON.stringify(validate(s, proposalId)['checks']));
  assert.equal(decide(s, 'approve', proposalId)['exit'], 0);
  assert.equal(decide(s, 'publish', proposalId)['exit'], 0);
  const verified = decide(s, 'verify', proposalId, ['--parameters', jsonFile(s.fixture, `verify-parameters-${Math.random()}`, { region: 'east' })]);
  assert.equal(verified['exit'], 0, String(verified['stderr']));
  const adopted = adopt(s, proposalId, s.sourceId);
  assert.equal(adopted['exit'], 0, String(adopted['stderr']));
  return { proposalId, version: Number(adopted['adopted_version']), taskId: task.taskId };
}

test('a failing attempt yields sanitized diagnostics naming stage, category, evidence, raw references, and governing versions', async () => {
  // Two pages for the first verification, then the target fails on its second
  // page of the first Run, after the first page was really acquired.
  const target = await startHttpSource({
    replies: [
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { status: 500, body: '{"error":"boom"}', content_type: 'text/html; charset=utf-8' },
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
    ],
  });
  try {
    const current = surface();
    publishCredential(current);
    adoptIntegration(current);
    const adopted = adoptScraper(current, taskConfig(target), '处理量报表');

    const failed = run(current, { region: 'east' });
    assert.equal(failed['status'], 'failed');
    const runId = String(failed['acquisition_run_id']);
    const diagnosticsId = String(failed['diagnostics_id']);
    assert.match(diagnosticsId, /^[0-9a-f-]{36}$/u);

    const read = diagnostics(current, { run: runId });
    assert.equal(read['exit'], 0, String(read['stderr']));
    assert.equal(read['mode'], 'run');
    assert.equal(read['acquisition_run_id'], runId);
    assert.equal(read['failure_code'], 'SCRAPER_PAGE_STATUS');
    assert.equal(read['stage'], 'page');
    assert.equal(read['category'], 'http_status');
    assert.deepEqual(read['parameters'], { month: '2026-01', region: 'east' });
    assert.deepEqual(read['engine'], { name: 'declarative-scraper', version: 1 });

    // Exact governing versions, so a repair is generated against facts.
    const service = asRecord(asArray(stateOf(current).scraper_services)[0]);
    const serviceVersion = asRecord(asArray(service['versions'])[0]);
    const taskVersion = asRecord(asArray(asRecord(asArray(stateOf(current).scraper_tasks)[0])['versions'])[0]);
    assert.equal(read['scraper_task_id'], adopted.taskId);
    assert.equal(read['scraper_task_version'], 1);
    assert.equal(read['scraper_task_content_hash'], taskVersion['content_hash']);
    assert.equal(read['scraper_service_version'], 1);
    assert.equal(read['scraper_service_content_hash'], serviceVersion['content_hash']);
    assert.equal(read['fixtures_version'], 1);
    assert.equal(read['fixtures_hash'], taskVersion['fixtures_hash']);
    assert.match(String(read['evidence_hash']), /^[0-9a-f]{64}$/u);

    // Request evidence: the address, the header names, and the credential
    // references, never a header value or the credential itself.
    const diagnostic = asRecord(asArray(read['diagnostics'])[0]);
    assert.equal(diagnostic['page'], 2);
    const request = asRecord(diagnostic['request']);
    assert.equal(request['method'], 'GET');
    assert.match(String(request['url']), /\/reports\/2026-01\?page=2$/u);
    assert.deepEqual(request['header_names'], ['accept', 'authorization']);
    assert.deepEqual(request['credential_refs'], ['报表账号']);

    // Page evidence: what the target really answered, bounded and sanitized.
    const page = asRecord(diagnostic['page_evidence']);
    assert.equal(page['status'], 500);
    assert.equal(page['content_type'], 'text/html');
    assert.match(String(page['response_hash']), /^[0-9a-f]{64}$/u);
    assert.ok(Number(page['response_bytes']) > 0);
    assert.match(String(page['body_excerpt']), /boom/u);
    assert.equal(page['excerpt_truncated'], false);

    // The Raw Acquisition the attempt kept is named by reference, never inlined.
    const raws = asArray(read['raw_refs']) as Config[];
    assert.equal(raws.length, 1);
    assert.equal(raws[0]?.['raw_id'], asRecord(asArray(failed['raw_acquisitions'])[0])['raw_id']);
    assert.match(String(raws[0]?.['content_hash']), /^[0-9a-f]{64}$/u);
    assert.ok(Number(raws[0]?.['byte_length']) > 0);

    // No credential value leaks into any diagnostic surface.
    assert.ok(!JSON.stringify(read).includes(CREDENTIAL), 'the diagnostics leaked the credential value');
    assert.ok(!JSON.stringify(stateOf(current).scraper_diagnostics).includes(CREDENTIAL), 'the stored diagnosis is not sanitized');

    // The diagnosis is durable, addressable, and readable only by an administrator.
    const byId = diagnostics(current, { id: diagnosticsId });
    assert.equal(byId['exit'], 0, String(byId['stderr']));
    assert.equal(byId['diagnostics_id'], diagnosticsId);
    const asConsumer = command(
      current.fixture,
      ['scraper', 'diagnostics', '--run', runId],
      { token: current.consumerToken },
    );
    assert.equal(asConsumer.status, 2);
    assert.equal(asConsumer.error['code'], 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await target.close();
  }
});

/** The purposes and data categories a repair Binding permits, and its pinned prompt. */
const REPAIR_PURPOSES = ['scraper_repair'];
const REPAIR_CATEGORIES = ['scraper_diagnostics'];
const REPAIR_PROMPT = '你是抓取服务修复助手，只输出简体中文说明，并且只返回修好的输出契约。';

/** Publishes, evaluates, activates, and binds one deterministic repair endpoint. */
async function repairBinding(s: Surface, endpoint: MockModelEndpoint): Promise<string> {
  const published = command(
    s.fixture,
    ['model', 'publish', '--name', '修复模型', '--config', jsonFile(s.fixture, `profile-${Math.random()}`, {
      adapter: 'generic_local',
      endpoint_url: endpoint.url,
      model_id: MOCK_MODEL_ID,
      purposes: [...REPAIR_PURPOSES],
      data_categories: [...REPAIR_CATEGORIES],
      tools: [],
      max_output_bytes: 65_536,
      prompts: { scraper_repair: REPAIR_PROMPT },
    })],
    { token: s.deploymentAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const profileId = String(published.output['model_profile_id']);
  const version = String(published.output['model_profile_version']);
  const evaluated = await commandAsync(
    s.fixture,
    ['model', 'evaluate', '--profile', profileId, '--version', version],
    { token: s.deploymentAdministratorToken },
  );
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await commandAsync(
    s.fixture,
    ['model', 'activate', '--profile', profileId, '--version', version],
    { token: s.deploymentAdministratorToken },
  );
  assert.equal(activated.status, 0, activated.stderr);
  const bound = await commandAsync(
    s.fixture,
    [
      'binding', 'publish', '--workspace', s.workspaceId, '--profile', profileId,
      '--config', jsonFile(s.fixture, `binding-${Math.random()}`, {
        model_profile_version: Number(version),
        purposes: [...REPAIR_PURPOSES],
        data_categories: [...REPAIR_CATEGORIES],
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  return String(bound.output['binding_id']);
}

function repair(s: Surface, diagnosticsId: string, bindingId: string, taskVersion: number): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['scraper', 'repair', '--diagnostics', diagnosticsId, '--binding', bindingId, '--task-version', String(taskVersion)],
    { token: s.workspaceAdministratorToken },
  );
}

/** The Task Version a controlled target change requires: same page, new markup, same expectations. */
function changedFixtures(): Config {
  return {
    version: 2,
    pages: [
      {
        name: '处理量第一页',
        path: '/reports/2026-01?page=1',
        content_type: 'text/html',
        body: CHANGED_PAGE,
        expected_record_count: 2,
        expected_records: TABLE_RECORDS,
      },
      {
        name: '处理量第二页',
        path: '/reports/2026-01?page=2',
        content_type: 'text/html',
        body: EMPTY_PAGE,
        expected_record_count: 0,
      },
    ],
  };
}

test('a recorded failure seeds an isolated repair candidate that passes retained fixtures through Approval, Publication, verification, and Adoption', async () => {
  const endpoint = await startMockModelEndpoint();
  // 1-2 adopt the base Service, 3-4 re-verify it after the target changed, 5-6 verify the repair.
  const target = await startHttpSource({
    replies: [
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
    ],
  });
  try {
    const current = surface();
    publishCredential(current);
    adoptIntegration(current);
    const base = adoptScraper(current, taskConfig(target), '处理量报表');
    const bindingId = await repairBinding(current, endpoint);
    const parameterFile = jsonFile(current.fixture, 'repair-verify', { region: 'east' });

    // The target changes: the published Service no longer produces its contract.
    const failed = decide(current, 'verify', base.proposalId, ['--parameters', parameterFile]);
    assert.equal(failed['exit'], 2, String(failed['stderr']));
    assert.equal(asRecord(failed['error'])['code'], 'SCRAPER_VERIFICATION_FAILED');
    const diagnosis = diagnostics(current, { proposal: base.proposalId });
    assert.equal(diagnosis['exit'], 0, String(diagnosis['stderr']));
    assert.equal(diagnosis['mode'], 'verification');
    assert.equal(diagnosis['failure_code'], 'SCRAPER_FIELD_EMPTY');
    assert.equal(diagnosis['stage'], 'extraction');
    assert.equal(diagnosis['category'], 'field_missing');
    const evidence = asRecord(asArray(diagnosis['diagnostics'])[0]);
    assert.equal(asRecord(evidence['page_evidence'])['status'], 200);
    assert.match(String(asRecord(evidence['page_evidence'])['body_excerpt']), /class="serial"/u);

    // A failure never moves a Source pin or erases the published Service.
    assert.equal(asRecord(asArray(stateOf(current).source_scraper_services)[0])['adopted_version'], 1);

    // The administrator publishes a Task Version with the changed page and the retained trailing page.
    const task = publishTask(current, '处理量报表', taskConfig(target, { fixtures: changedFixtures() }));
    assert.equal(task.taskId, base.taskId);
    assert.equal(task.version, 2);

    const requestsBeforeRepair = target.requests().length;
    const repaired = await repair(current, String(diagnosis['diagnostics_id']), bindingId, 2);
    assert.equal(repaired.status, 0, repaired.stderr);
    const repairRecord = asRecord(repaired.output['repair']);
    assert.equal(repairRecord['base_service_version'], 1);
    assert.equal(repairRecord['base_task_version'], 1);
    assert.equal(repairRecord['diagnostics_id'], diagnosis['diagnostics_id']);
    assert.equal(repairRecord['failure_code'], 'SCRAPER_FIELD_EMPTY');
    const model = asRecord(repairRecord['model']);
    assert.equal(model['adapter'], 'generic_local');
    assert.equal(model['model_id'], MOCK_MODEL_ID);
    assert.equal(model['binding_id'], bindingId);
    assert.equal(model['prompt_id'], 'scraper_repair');
    assert.match(String(model['prompt_hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(repairRecord['input_hash']), /^[0-9a-f]{64}$/u);

    // The candidate repairs only the selectors; every other fact stays the Task's.
    const candidate = asRecord(repaired.output['candidates']);
    const service = asRecord(candidate['service']);
    const output = asRecord(service['output']);
    assert.equal(output['record_selector'], 'tr.record');
    assert.deepEqual(
      asArray(output['fields']).map((field) => `${asRecord(field)['name']}:${asRecord(field)['selector']}`),
      ['sn:td.serial', 'city:td.city', 'handled_count:td.count'],
    );
    assert.deepEqual(asRecord(service['source_task']), { version: 2, content_hash: task.output['content_hash'] });

    // The model received the Task, the base Version, the sanitized diagnosis, and
    // the fixtures — and nothing else: no credential, no Raw Acquisition, no other Workspace.
    assert.equal(target.requests().length, requestsBeforeRepair, 'generation must not contact the target');
    const call = asRecord(endpoint.calls[endpoint.calls.length - 1]);
    assert.equal(call['purpose'], 'scraper_repair');
    assert.deepEqual(call['tools'], []);
    const input = asRecord(call['input']);
    assert.deepEqual(Object.keys(input).sort(), ['base', 'failure', 'task']);
    assert.equal(asRecord(input['base'])['scraper_service_version'], 1);
    assert.equal(asRecord(input['task'])['scraper_task_version'], 2);
    assert.equal(asArray(asRecord(asRecord(input['task'])['fixtures'])['pages']).length, 2);
    assert.equal(asRecord(input['failure'])['diagnostics_id'], diagnosis['diagnostics_id']);
    const modelInput = JSON.stringify(input);
    assert.ok(!modelInput.includes(CREDENTIAL), 'the model received the credential value');
    assert.ok(!modelInput.includes(current.workspaceId), 'the model received the Workspace identity');
    assert.ok(!modelInput.includes(current.sourceId), 'the model received the Source identity');
    assert.ok(!modelInput.includes('raw-acquisitions'), 'the model received acquisition storage paths');
    assert.ok(!JSON.stringify(repaired.output).includes(CREDENTIAL), 'the repair output leaked the credential value');

    // Validation proves the repair without touching the target or integrating anything.
    const proposalId = String(repaired.output['proposal_id']);
    const before = stateOf(current);
    const validation = validate(current, proposalId);
    assert.equal(validation['exit'], 0, String(validation['stderr']));
    assert.equal(validation['passed'], true, JSON.stringify(validation['checks']));
    assert.deepEqual(
      asArray(validation['checks']).map((check) => `${asRecord(check)['name']}:${asRecord(check)['passed']}`),
      [
        'engine:supported:true',
        'network_scope:approved:true',
        'parameters:declared:true',
        'output:contract:true',
        'constraints:within_limits:true',
        'credentials:references_only:true',
        'fixtures:scope:true',
        'fixtures:output:true',
        'repair:task_fidelity:true',
        'network_scope:not_widened:true',
        'credentials:not_widened:true',
        'fixtures:regression:true',
        'repair:addresses_failure:true',
        'repair:changes:true',
      ],
    );
    const after = stateOf(current);
    assert.deepEqual(after.raw_acquisitions, before.raw_acquisitions);
    assert.deepEqual(after.acquisition_runs, before.acquisition_runs);
    assert.deepEqual(after.datasets, before.datasets);
    assert.deepEqual(after.source_scraper_services, before.source_scraper_services);
    assert.equal(target.requests().length, requestsBeforeRepair);

    // Approval, Publication, isolated verification, and explicit Adoption follow as before.
    assert.equal(decide(current, 'approve', proposalId)['exit'], 0);
    assert.equal(decide(current, 'publish', proposalId)['exit'], 0);
    assert.equal(asArray(asRecord(asArray(stateOf(current).scraper_services)[0])['versions']).length, 2);
    assert.equal(asRecord(asArray(stateOf(current).source_scraper_services)[0])['adopted_version'], 1);
    const premature = adopt(current, proposalId, current.sourceId);
    assert.equal(premature['exit'], 2);
    assert.equal(asRecord(premature['error'])['code'], 'SCRAPER_VERIFICATION_REQUIRED');
    const verified = decide(current, 'verify', proposalId, ['--parameters', parameterFile]);
    assert.equal(verified['exit'], 0, String(verified['stderr']));
    assert.equal(asRecord(verified['verification'])['passed'], true);
    assert.deepEqual(asRecord(verified['verification'])['diagnostics'], []);

    const adopted = adopt(current, proposalId, current.sourceId);
    assert.equal(adopted['exit'], 0, String(adopted['stderr']));
    assert.equal(adopted['adopted_version'], 2);
    assert.equal(adopted['previous_adopted_version'], 1);
    assert.equal(asRecord(asArray(stateOf(current).source_scraper_services)[0])['adopted_version'], 2);

    // Provenance restates the base, the failure, the model, the validation, and every lifecycle fact.
    const shown = command(current.fixture, ['scraper', 'show', '--proposal', proposalId], {
      token: current.workspaceAdministratorToken,
    });
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.output['status'], 'adopted');
    assert.equal(asRecord(shown.output['repair'])['diagnostics_id'], diagnosis['diagnostics_id']);
    const decision = asRecord(asArray(shown.output['decisions'])[0]);
    const provenance = asRecord(decision['provenance']);
    const provenanceRepair = asRecord(provenance['repair']);
    assert.equal(provenanceRepair['base_service_version'], 1);
    assert.equal(provenanceRepair['base_task_version'], 1);
    assert.equal(provenanceRepair['failure_code'], 'SCRAPER_FIELD_EMPTY');
    assert.equal(asRecord(provenanceRepair['model'])['model_id'], MOCK_MODEL_ID);
    assert.match(String(provenanceRepair['input_hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(provenance['validation_hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(provenance['candidate_content_hash']), /^[0-9a-f]{64}$/u);
    assert.equal(asArray(shown.output['publications']).length, 1);
    assert.equal(asArray(shown.output['adoptions']).length, 1);
    assert.equal(asRecord(asArray(shown.output['adoptions'])[0])['previous_adopted_version'], 1);
  } finally {
    await endpoint.close();
    await target.close();
  }
});

function cjk(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? []).length;
}

/** The names of the checks a validation reported as failed. */
function failedChecks(validation: Config): string[] {
  return asArray(validation['checks'])
    .map((check) => asRecord(check))
    .filter((check) => check['passed'] !== true)
    .map((check) => String(check['name']));
}

/** Publishes, approves, and publishes one compiled Proposal, moving the base forward. */
function compileAndPublish(s: Surface, taskId: string, version: number): Config {
  const proposalId = String(compile(s, taskId, version)['proposal_id']);
  const validation = validate(s, proposalId);
  assert.equal(validation['passed'], true, JSON.stringify(validation['checks']));
  assert.equal(decide(s, 'approve', proposalId)['exit'], 0);
  assert.equal(decide(s, 'publish', proposalId)['exit'], 0);
  return { proposal_id: proposalId };
}

test('a repair that weakens retained fixtures, widens approved authority, or addresses no failure cannot be approved', async () => {
  const endpoint = await startMockModelEndpoint();
  const target = await startHttpSource({
    replies: [
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
    ],
  });
  try {
    const current = surface();
    publishCredential(current);
    adoptIntegration(current);
    const base = adoptScraper(current, taskConfig(target), '处理量报表');
    const bindingId = await repairBinding(current, endpoint);
    const parameterFile = jsonFile(current.fixture, 'negative-verify', { region: 'east' });
    assert.equal(decide(current, 'verify', base.proposalId, ['--parameters', parameterFile])['exit'], 2);
    const diagnosisId = String(diagnostics(current, { proposal: base.proposalId })['diagnostics_id']);

    // A Consumer may not generate a repair at all.
    const asConsumer = await commandAsync(
      current.fixture,
      ['scraper', 'repair', '--diagnostics', diagnosisId, '--binding', bindingId, '--task-version', '2'],
      { token: current.consumerToken },
    );
    assert.equal(asConsumer.status, 2);
    assert.equal(asConsumer.error['code'], 'WORKSPACE_ACCESS_DENIED');

    // (a) Dropping a retained base fixture is refused deterministically.
    const renamed = publishTask(current, '处理量报表', taskConfig(target, {
      fixtures: {
        version: 2,
        pages: [
          {
            name: '改版后第一页',
            path: '/reports/2026-01?page=1',
            content_type: 'text/html',
            body: CHANGED_PAGE,
            expected_record_count: 2,
            expected_records: TABLE_RECORDS,
          },
          { name: '处理量第二页', path: '/reports/2026-01?page=2', content_type: 'text/html', body: EMPTY_PAGE, expected_record_count: 0 },
        ],
      },
    }));
    const dropped = await repair(current, diagnosisId, bindingId, renamed.version);
    assert.equal(dropped.status, 0, dropped.stderr);
    const droppedValidation = validate(current, String(dropped.output['proposal_id']));
    assert.equal(droppedValidation['passed'], false);
    assert.deepEqual(failedChecks(droppedValidation), ['fixtures:regression']);
    const refusedDropped = decide(current, 'approve', String(dropped.output['proposal_id']));
    assert.equal(refusedDropped['exit'], 2);
    assert.equal(asRecord(refusedDropped['error'])['code'], 'SCRAPER_VALIDATION_FAILED');
    assert.equal(asArray(asRecord(asArray(stateOf(current).scraper_services)[0])['versions']).length, 1);

    // (b) A Task Version that widens the approved network scope is refused.
    const widened = publishTask(current, '处理量报表', taskConfig(target, {
      network_scope: { origins: [target.url, 'http://outside.invalid'], paths: ['/reports', '/outside'] },
      fixtures: changedFixtures(),
    }));
    const widenedCandidate = await repair(current, diagnosisId, bindingId, widened.version);
    assert.equal(widenedCandidate.status, 0, widenedCandidate.stderr);
    const widenedValidation = validate(current, String(widenedCandidate.output['proposal_id']));
    assert.equal(widenedValidation['passed'], false);
    assert.deepEqual(failedChecks(widenedValidation), ['network_scope:not_widened']);
    assert.match(String(asRecord(asArray(widenedValidation['checks']).find((check) => asRecord(check)['name'] === 'network_scope:not_widened'))['detail']), /outside/u);
    assert.equal(decide(current, 'approve', String(widenedCandidate.output['proposal_id']))['exit'], 2);

    // (c) A repair whose fixtures no longer reproduce the failure proves nothing.
    const unchanged = publishTask(current, '处理量报表', taskConfig(target, {
      fixtures: {
        version: 4,
        pages: [
          {
            name: '处理量第一页',
            path: '/reports/2026-01?page=1',
            content_type: 'text/html',
            body: BASE_PAGE,
            expected_record_count: 2,
            expected_records: TABLE_RECORDS,
          },
          {
            name: '原样第一页',
            path: '/reports/2026-01?page=1',
            content_type: 'text/html',
            body: BASE_PAGE,
            expected_record_count: 2,
            expected_records: TABLE_RECORDS,
          },
        ],
      },
    }));
    const unchangedCandidate = await repair(current, diagnosisId, bindingId, unchanged.version);
    assert.equal(unchangedCandidate.status, 0, unchangedCandidate.stderr);
    const unchangedValidation = validate(current, String(unchangedCandidate.output['proposal_id']));
    assert.equal(unchangedValidation['passed'], false);
    assert.deepEqual(failedChecks(unchangedValidation), ['repair:addresses_failure', 'repair:changes']);
    const unchangedCandidateService = asRecord(asRecord(unchangedCandidate.output['candidates'])['service']);
    assert.deepEqual(asRecord(unchangedCandidateService['output']), {
      record_selector: 'tr.record',
      fields: [
        { name: 'sn', selector: 'td.sn' },
        { name: 'city', selector: 'td.city' },
        { name: 'handled_count', selector: 'td.count' },
      ],
    });

    // (d) A diagnosis of a base that has since moved cannot seed a repair.
    compileAndPublish(current, base.taskId, unchanged.version);
    assert.equal(asArray(asRecord(asArray(stateOf(current).scraper_services)[0])['versions']).length, 2);
    const stale = await repair(current, diagnosisId, bindingId, unchanged.version);
    assert.equal(stale.status, 2);
    assert.equal(stale.error['code'], 'SCRAPER_REPAIR_STALE');
    assert.equal(asArray(stateOf(current).source_scraper_services)[0] !== undefined, true);
    assert.equal(asRecord(asArray(stateOf(current).source_scraper_services)[0])['adopted_version'], 1);
  } finally {
    await endpoint.close();
    await target.close();
  }
});

test('a failed repair verification preserves the published Service and every Source pin while recording the failure', async () => {
  const endpoint = await startMockModelEndpoint();
  const target = await startHttpSource({
    replies: [
      { body: BASE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: CHANGED_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
      { status: 503, body: '{"error":"maintenance"}', content_type: 'text/html; charset=utf-8' },
    ],
  });
  try {
    const current = surface();
    publishCredential(current);
    adoptIntegration(current);
    const base = adoptScraper(current, taskConfig(target), '处理量报表');
    const bindingId = await repairBinding(current, endpoint);
    const parameterFile = jsonFile(current.fixture, 'failed-verify', { region: 'east' });
    assert.equal(decide(current, 'verify', base.proposalId, ['--parameters', parameterFile])['exit'], 2);
    const diagnosisId = String(diagnostics(current, { proposal: base.proposalId })['diagnostics_id']);
    const publishedService = asArray(asRecord(asArray(stateOf(current).scraper_services)[0])['versions'])[0];

    publishTask(current, '处理量报表', taskConfig(target, { fixtures: changedFixtures() }));
    const repaired = await repair(current, diagnosisId, bindingId, 2);
    assert.equal(repaired.status, 0, repaired.stderr);
    const proposalId = String(repaired.output['proposal_id']);
    assert.equal(validate(current, proposalId)['passed'], true);
    assert.equal(decide(current, 'approve', proposalId)['exit'], 0);
    assert.equal(decide(current, 'publish', proposalId)['exit'], 0);
    assert.equal(asArray(asRecord(asArray(stateOf(current).scraper_services)[0])['versions']).length, 2);

    // The target fails the repair's isolated live verification.
    const failed = decide(current, 'verify', proposalId, ['--parameters', parameterFile]);
    assert.equal(failed['exit'], 2);
    assert.equal(asRecord(failed['error'])['code'], 'SCRAPER_VERIFICATION_FAILED');
    const refused = adopt(current, proposalId, current.sourceId);
    assert.equal(refused['exit'], 2);
    assert.equal(asRecord(refused['error'])['code'], 'SCRAPER_VERIFICATION_FAILED');

    // The published Service is intact, the pin never moved, and the failure is evidence.
    const state = stateOf(current);
    const versions = asArray(asRecord(asArray(state.scraper_services)[0])['versions']);
    assert.equal(asRecord(versions[0])['content_hash'], asRecord(publishedService)['content_hash']);
    assert.equal(asRecord(versions[1])['withdrawn_at'], null);
    assert.equal(asRecord(asArray(state.source_scraper_services)[0])['adopted_version'], 1);
    assert.equal(asRecord(asArray(state.source_scraper_services)[0])['proposal_id'], base.proposalId);
    assert.deepEqual(state.raw_acquisitions, []);
    const evidence = diagnostics(current, { proposal: proposalId });
    assert.equal(evidence['mode'], 'verification');
    assert.equal(evidence['failure_code'], 'SCRAPER_PAGE_STATUS');
    assert.equal(evidence['stage'], 'page');
    assert.equal(evidence['category'], 'http_status');
    assert.equal(evidence['scraper_service_version'], 2);
    assert.equal(evidence['scraper_task_version'], 2);
    const shown = command(current.fixture, ['scraper', 'show', '--proposal', proposalId], {
      token: current.workspaceAdministratorToken,
    });
    assert.equal(shown.output['status'], 'published');
    const verification = asRecord(asArray(shown.output['verifications'])[0]);
    assert.equal(verification['passed'], false);
    assert.equal(asRecord(asArray(verification['diagnostics'])[0])['code'], 'SCRAPER_PAGE_STATUS');
    assert.equal(asArray(shown.output['adoptions']).length, 0);
  } finally {
    await endpoint.close();
    await target.close();
  }
});

test('every repair and diagnostics string this ticket introduces is Simplified Chinese', () => {
  const catalogPath = fileURLToPath(new URL('../../../web/src/i18n/zh-CN.ts', import.meta.url));
  const text = readFileSync(catalogPath, 'utf8');
  const entries: Array<{ key: string; value: string }> = [];
  for (const match of text.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',$/gmu)) {
    entries.push({ key: String(match[1]), value: String(match[2]) });
  }
  const introduced = entries.filter(
    (entry) => entry.key.startsWith('scraper.repair.') || entry.key.startsWith('scraper.diagnostics.'),
  );
  assert.ok(introduced.length >= 25, `too few introduced strings: ${introduced.length}`);
  for (const entry of introduced) {
    assert.ok(cjk(entry.value) >= 2, `${entry.key} is not Simplified Chinese: ${entry.value}`);
    assert.ok(!/^[\x20-\x7E]*$/u.test(entry.value), `${entry.key} is English-only: ${entry.value}`);
  }
  for (const key of [
    'scraper.diagnostics.title',
    'scraper.diagnostics.stage',
    'scraper.diagnostics.category',
    'scraper.diagnostics.request',
    'scraper.diagnostics.page',
    'scraper.diagnostics.raw',
    'scraper.diagnostics.versions',
    'scraper.diagnostics.empty',
    'scraper.diagnostics.noEvidence',
    'scraper.repair.title',
    'scraper.repair.base',
    'scraper.repair.failure',
    'scraper.repair.model',
    'scraper.repair.fixtures',
    'scraper.repair.regression',
    'scraper.repair.failed',
    'scraper.repair.stale',
    'scraper.repair.adopt',
  ]) {
    const entry = entries.find((candidate) => candidate.key === key);
    assert.ok(entry !== undefined, `missing copy for ${key}`);
    assert.ok(cjk(entry.value) >= 2, `${key} is not Simplified Chinese: ${entry.value}`);
  }
});
