import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHttpSource, type HttpSource } from '../support/http-source.js';
import {
  command,
  jsonFile,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

type Config = Record<string, unknown>;

const CREDENTIAL = 'report-token-7f3c';

/** One table-shaped page: two records, one padded value, one empty remark column. */
const TABLE_PAGE = [
  '<html><body><table>',
  '<tr class="record"><td class="sn"> dev-1 </td><td class="city">杭州</td><td class="count">12</td></tr>',
  '<tr class="record"><td class="sn">dev-2</td><td class="city">上海</td><td class="count">3</td></tr>',
  '</table></body></html>',
].join('');

/** The next page proves exhaustion; a scraper never guesses that the end was reached. */
const EMPTY_PAGE = '<html><body><table></table></body></html>';

/** A structurally different site: list items with an attribute-borne link. */
const LIST_PAGE = [
  '<html><body>',
  '<div class="item"><span class="name">甲</span><a class="link" href="/detail/1">详情</a></div>',
  '<div class="item"><span class="name">乙</span><a class="link" href="/detail/2">详情</a></div>',
  '</body></html>',
].join('');

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

function cjk(text: string): number {
  return (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? []).length;
}

/** One Workspace holding a Workspace Administrator, a Consumer, and one scraper Source. */
function surface(): Surface {
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

/** The task document: target, approved network scope, output contract, parameters, fixtures, constraints, and credential references. */
function tableTask(source: HttpSource, overrides: Config = {}): Config {
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
      { name: 'limit', type: 'integer', required: false, default: null },
    ],
    fixtures: {
      version: 3,
      pages: [
        {
          name: '处理量第一页',
          path: '/reports/2026-01?page=1',
          content_type: 'text/html',
          body: TABLE_PAGE,
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

function listTask(source: HttpSource): Config {
  return {
    target: { base_url: source.url, path: '/list', page_parameter: null, first_page: 1, max_pages: 2 },
    network_scope: { origins: [source.url], paths: ['/list'] },
    output: {
      record_selector: 'div.item',
      fields: [
        { name: 'name', selector: 'span.name' },
        { name: 'link', selector: 'a.link@href' },
      ],
    },
    parameters: [],
    fixtures: {
      version: 1,
      pages: [
        {
          name: '目录页',
          path: '/list?page=1',
          content_type: 'text/html',
          body: LIST_PAGE,
          expected_record_count: 2,
          expected_records: [{ name: '甲', link: '/detail/1' }, { name: '乙', link: '/detail/2' }],
        },
      ],
    },
    constraints: { timeout_ms: 5_000, max_bytes: 1_048_576, max_records: 1_000 },
    credential_refs: [],
  };
}

function publishTask(s: Surface, name: string, config: Config): { taskId: string; version: number; output: Config } {
  const published = command(
    s.fixture,
    ['scraper', 'task', '--workspace', s.workspaceId, '--name', name, '--config', jsonFile(s.fixture, `task-${name}`, config)],
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
    [
      'scraper', 'compile', '--task', taskId,
      ...(version === undefined ? [] : ['--version', String(version)]),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  return compiled.output;
}

function validate(s: Surface, proposalId: string): Config {
  const validated = command(
    s.fixture,
    ['scraper', 'validate', '--proposal', proposalId],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(validated.status, 0, validated.stderr);
  return validated.output;
}

function decide(s: Surface, verb: 'approve' | 'publish' | 'verify', proposalId: string, extra: string[] = []): Config {
  const result = verb === 'verify'
    ? command(
      s.fixture,
      ['scraper', 'verify', '--proposal', proposalId, ...extra],
      { token: s.workspaceAdministratorToken },
    )
    : command(s.fixture, ['scraper', verb, '--proposal', proposalId], { token: s.workspaceAdministratorToken });
  return { ...result.output, exit: result.status, error: result.error, stderr: result.stderr };
}

function adopt(s: Surface, proposalId: string, sourceId: string): Config {
  const adopted = command(
    s.fixture,
    ['scraper', 'adopt', '--proposal', proposalId, '--source', sourceId],
    { token: s.workspaceAdministratorToken },
  );
  return { ...adopted.output, exit: adopted.status, error: adopted.error, stderr: adopted.stderr };
}

function show(s: Surface, proposalId: string): Config {
  const shown = command(
    s.fixture,
    ['scraper', 'show', '--proposal', proposalId],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(shown.status, 0, shown.stderr);
  return shown.output;
}

/** Publishes the credential a run and a live verification present, sealing its value. */
function publishCredential(s: Surface, ref = '报表账号'): void {
  const published = command(
    s.fixture,
    ['scraper', 'credential', '--workspace', s.workspaceId, '--name', ref, '--location', 'bearer', '--credential-stdin'],
    { token: s.workspaceAdministratorToken, input: `${CREDENTIAL}\n` },
  );
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.output['has_value'], true);
}

/** Publishes and adopts an Integration Configuration so a scraper Run can govern a Dataset. */
function adoptIntegration(s: Surface): void {
  const published = command(
    s.fixture,
    ['integration', 'publish', '--source', s.sourceId, '--config', jsonFile(s.fixture, 'integration', INTEGRATION)],
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
      ...(parameters === undefined ? [] : ['--parameters', jsonFile(s.fixture, 'run-parameters', parameters)]),
    ],
    { token: s.workspaceAdministratorToken },
  );
  return { ...result.output, exit: result.status, error: result.error, stderr: result.stderr };
}

/** Publishes, validates, approves, publishes, verifies, and adopts one Scraper Service. */
function adoptScraper(s: Surface, config: Config, name: string, sourceId = s.sourceId): { proposalId: string; version: number } {
  const task = publishTask(s, name, config);
  const proposal = compile(s, task.taskId);
  const proposalId = String(proposal['proposal_id']);
  assert.equal(validate(s, proposalId)['passed'], true);
  assert.equal(decide(s, 'approve', proposalId)['exit'], 0);
  assert.equal(decide(s, 'publish', proposalId)['exit'], 0);
  const verified = decide(s, 'verify', proposalId, ['--parameters', jsonFile(s.fixture, 'verify-parameters', { region: 'east' })]);
  assert.equal(verified['exit'], 0, String(verified['stderr']));
  const adopted = adopt(s, proposalId, sourceId);
  assert.equal(adopted['exit'], 0, String(adopted['stderr']));
  return { proposalId, version: Number(adopted['adopted_version']) };
}

test('a Scraper Task pins its target, output contract, parameters, fixtures, constraints, and credential references', async () => {
  const target = await startHttpSource({
    replies: [
      { body: TABLE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
    ],
  });
  try {
    const current = surface();
    const task = publishTask(current, '处理量报表', tableTask(target));
    assert.equal(task.version, 1);

    // Every fact compilation draws on is pinned, named, and digest-addressed.
    assert.equal(task.output['fixtures_version'], 3);
    assert.match(String(task.output['content_hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(task.output['fixtures_hash']), /^[0-9a-f]{64}$/u);
    assert.deepEqual(asRecord(task.output['target']), {
      base_url: target.url,
      path: '/reports/{month}',
      page_parameter: 'page',
      first_page: 1,
      page_size: null,
      page_size_parameter: null,
      max_pages: 3,
    });
    assert.deepEqual(asRecord(task.output['network_scope']), { origins: [target.url], paths: ['/reports'] });
    assert.deepEqual(
      asArray(asRecord(task.output['output'])['fields']).map((field) => asRecord(field)['name']),
      ['sn', 'city', 'handled_count'],
    );
    assert.deepEqual(
      asArray(task.output['parameters']).map((parameter) => `${asRecord(parameter)['name']}:${asRecord(parameter)['required']}`),
      ['month:false', 'region:true', 'limit:false'],
    );
    assert.deepEqual(task.output['constraints'], { timeout_ms: 5_000, max_bytes: 1_048_576, max_records: 1_000 });
    assert.deepEqual(task.output['credential_refs'], ['报表账号']);
    assert.equal(task.output['fixture_count'], 1);

    // A second Version appends rather than rewriting the first.
    const second = publishTask(current, '处理量报表', tableTask(target, { fixtures: (tableTask(target)['fixtures'] as Config) }));
    assert.equal(second.version, 2);
    assert.equal(second.taskId, task.taskId);
    const shown = command(current.fixture, ['scraper', 'task-show', '--task', task.taskId], {
      token: current.workspaceAdministratorToken,
    });
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(
      asArray(shown.output['versions']).map((version) => asRecord(version)['scraper_task_version']),
      [1, 2],
    );
    assert.equal(stateOf(current).scraper_tasks.length, 1);
    assert.equal(asArray(stateOf(current).scraper_tasks[0]?.['versions']).length, 2);

    // The engine is generic: a structurally different site with attribute selectors validates unchanged.
    const listed = publishTask(current, '目录页', listTask(target));
    const proposalId = String(compile(current, listed.taskId)['proposal_id']);
    const validation = validate(current, proposalId);
    assert.equal(validation['passed'], true, JSON.stringify(validation['checks']));
    const fixture = asRecord(asArray(validation['fixtures'])[0]);
    assert.equal(fixture['record_count'], 2);
    assert.equal(fixture['expected_record_count'], 2);
  } finally {
    await target.close();
  }
});

test('static checks and versioned fixtures validate parameters, output, and approved network scope before Approval', async () => {
  const target = await startHttpSource({
    replies: [{ body: TABLE_PAGE, content_type: 'text/html; charset=utf-8' }],
  });
  try {
    const current = surface();

    // A target outside its own approved scope never becomes a Task Version at all.
    const outOfScope = command(
      current.fixture,
      [
        'scraper', 'task', '--workspace', current.workspaceId, '--name', '越界目标',
        '--config', jsonFile(current.fixture, 'task-out-of-scope', tableTask(target, {
          network_scope: { origins: ['http://other.invalid'], paths: ['/reports'] },
        })),
      ],
      { token: current.workspaceAdministratorToken },
    );
    assert.equal(outOfScope.status, 2, outOfScope.stdout);
    assert.equal(outOfScope.error['code'], 'SCRAPER_NETWORK_SCOPE_NOT_APPROVED');
    assert.deepEqual(stateOf(current).scraper_tasks, []);

    // A fixture that reads outside the approved scope compiles but fails validation.
    const strayFixture = tableTask(target, {
      fixtures: {
        version: 4,
        pages: [
          {
            name: '越界夹具',
            path: '/outside/export.html',
            content_type: 'text/html',
            body: TABLE_PAGE,
            expected_record_count: 2,
          },
        ],
      },
    });
    const stray = publishTask(current, '越界夹具任务', strayFixture);
    const strayProposal = String(compile(current, stray.taskId)['proposal_id']);
    const strayValidation = validate(current, strayProposal);
    assert.equal(strayValidation['passed'], false);
    const failedChecks = asArray(strayValidation['checks'])
      .map((check) => asRecord(check))
      .filter((check) => check['passed'] !== true);
    assert.deepEqual(failedChecks.map((check) => check['name']), ['fixtures:scope']);
    assert.match(String(failedChecks[0]?.['detail']), /outside the approved network scope/u);

    // Approval refuses a failed candidate and every governed fact stays where it was.
    const refused = decide(current, 'approve', strayProposal);
    assert.equal(refused['exit'], 2, String(refused['stderr']));
    assert.equal(asRecord(refused['error'])['code'], 'SCRAPER_VALIDATION_FAILED');
    assert.deepEqual(stateOf(current).scraper_services, []);
    assert.deepEqual(stateOf(current).source_scraper_services, []);

    // A candidate with no validation at all cannot be approved either.
    const unvalidated = publishTask(current, '未校验任务', tableTask(target));
    const unvalidatedProposal = String(compile(current, unvalidated.taskId)['proposal_id']);
    const noEvidence = decide(current, 'approve', unvalidatedProposal);
    assert.equal(noEvidence['exit'], 2);
    assert.equal(asRecord(noEvidence['error'])['code'], 'SCRAPER_VALIDATION_REQUIRED');

    // The passing path reports every check it cleared, parameter and output contract included.
    const passing = validate(current, unvalidatedProposal);
    assert.equal(passing['passed'], true, JSON.stringify(passing['checks']));
    assert.deepEqual(
      asArray(passing['checks']).map((check) => `${asRecord(check)['name']}:${asRecord(check)['passed']}`),
      [
        'engine:supported:true',
        'network_scope:approved:true',
        'parameters:declared:true',
        'output:contract:true',
        'constraints:within_limits:true',
        'credentials:references_only:true',
        'fixtures:scope:true',
        'fixtures:output:true',
      ],
    );
    assert.match(String(passing['evidence_hash']), /^[0-9a-f]{64}$/u);

    // Output drift in the frozen fixture fails validation even inside the scope.
    const drifted = publishTask(current, '输出漂移任务', tableTask(target, {
      fixtures: {
        version: 5,
        pages: [
          {
            name: '漂移夹具',
            path: '/reports/2026-01?page=1',
            content_type: 'text/html',
            body: TABLE_PAGE,
            expected_record_count: 3,
          },
        ],
      },
    }));
    const driftedValidation = validate(current, String(compile(current, drifted.taskId)['proposal_id']));
    assert.equal(driftedValidation['passed'], false);
    const outputCheck = asArray(driftedValidation['checks'])
      .map((check) => asRecord(check))
      .find((check) => check['name'] === 'fixtures:output');
    assert.equal(outputCheck?.['passed'], false);
    assert.match(String(outputCheck?.['detail']), /instead of 3/u);

    // A Consumer cannot compile or read any Scraper Proposal.
    const asConsumer = command(
      current.fixture,
      ['scraper', 'show', '--proposal', unvalidatedProposal],
      { token: current.consumerToken },
    );
    assert.equal(asConsumer.status, 2, asConsumer.stdout);
    assert.equal(asConsumer.error['code'], 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await target.close();
  }
});

test('a pre-Approval candidate has no production credentials, production writes, or governed-data effect', async () => {
  const target = await startHttpSource({
    replies: [{ body: TABLE_PAGE, content_type: 'text/html; charset=utf-8' }],
  });
  try {
    const current = surface();
    publishCredential(current);
    const before = stateOf(current);
    const task = publishTask(current, '处理量报表', tableTask(target));
    const proposal = compile(current, task.taskId);
    const proposalId = String(proposal['proposal_id']);
    const validation = validate(current, proposalId);

    // The credential exists, yet neither compilation nor validation touches the target.
    assert.deepEqual(target.requests(), []);

    // The candidate carries the reference, never the value.
    const candidateJson = JSON.stringify(proposal['candidates']);
    assert.match(candidateJson, /报表账号/u);
    assert.ok(!candidateJson.includes(CREDENTIAL), 'the candidate leaked the credential value');
    assert.ok(!JSON.stringify(validation).includes(CREDENTIAL), 'the validation evidence leaked the credential value');
    const shownTask = command(current.fixture, ['scraper', 'task-show', '--task', task.taskId], {
      token: current.workspaceAdministratorToken,
    });
    assert.ok(!JSON.stringify(shownTask.output).includes(CREDENTIAL), 'the Task read leaked the credential value');
    assert.ok(!JSON.stringify(before.scraper_credentials).includes(CREDENTIAL), 'the stored credential is not sealed');

    // No Scraper Service Version, Source pin, Run, Raw Acquisition, Batch, or Release exists yet.
    const after = stateOf(current);
    assert.deepEqual(after.scraper_services, []);
    assert.deepEqual(after.source_scraper_services, []);
    assert.deepEqual(after.scraper_runs, []);
    assert.deepEqual(after.raw_acquisitions, before.raw_acquisitions);
    assert.deepEqual(after.acquisition_runs, before.acquisition_runs);
    assert.deepEqual(after.integration_batches, before.integration_batches);
    assert.deepEqual(after.datasets, before.datasets);
    assert.equal(after.artifact_proposals.length, 1);
    assert.equal(asRecord(after.artifact_proposals[0])['kind'], 'scraper');

    // Only Approval, Publication, verification, and Adoption introduce those facts.
    assert.equal(decide(current, 'approve', proposalId)['exit'], 0);
    assert.equal(decide(current, 'publish', proposalId)['exit'], 0);
    assert.equal(stateOf(current).scraper_services.length, 1);
    assert.deepEqual(stateOf(current).source_scraper_services, []);
    assert.deepEqual(stateOf(current).raw_acquisitions, []);
    assert.deepEqual(stateOf(current).scraper_runs, []);
  } finally {
    await target.close();
  }
});

test('approved live verification is isolated and non-integrating before explicit Source Adoption', async () => {
  const target = await startHttpSource({
    replies: [
      { body: TABLE_PAGE, content_type: 'text/html; charset=utf-8' },
      { body: EMPTY_PAGE, content_type: 'text/html; charset=utf-8' },
    ],
  });
  const broken = await startHttpSource({
    replies: [{ status: 500, body: '{"error":"boom"}', content_type: 'text/html; charset=utf-8' }],
  });
  try {
    const current = surface();
    publishCredential(current);
    const task = publishTask(current, '处理量报表', tableTask(target));
    const proposalId = String(compile(current, task.taskId)['proposal_id']);
    assert.equal(validate(current, proposalId)['passed'], true);

    // Verification is refused before Approval and Publication.
    const early = decide(current, 'verify', proposalId);
    assert.equal(early['exit'], 2);
    assert.equal(asRecord(early['error'])['code'], 'SCRAPER_NOT_PUBLISHED');
    assert.deepEqual(target.requests(), []);

    // Adoption is refused before Publication, and again before any verification.
    const adoptEarly = adopt(current, proposalId, current.sourceId);
    assert.equal(adoptEarly['exit'], 2);
    assert.equal(asRecord(adoptEarly['error'])['code'], 'SCRAPER_NOT_PUBLISHED');
    assert.equal(decide(current, 'approve', proposalId)['exit'], 0);
    assert.equal(decide(current, 'publish', proposalId)['exit'], 0);
    const adoptUnverified = adopt(current, proposalId, current.sourceId);
    assert.equal(adoptUnverified['exit'], 2);
    assert.equal(asRecord(adoptUnverified['error'])['code'], 'SCRAPER_VERIFICATION_REQUIRED');

    // Verification reads the real target with the stored credential and integrates nothing.
    const before = stateOf(current);
    const verified = decide(current, 'verify', proposalId, ['--parameters', jsonFile(current.fixture, 'verify-parameters', { region: 'east' })]);
    assert.equal(verified['exit'], 0, String(verified['stderr']));
    const verification = asRecord(verified['verification']);
    assert.equal(verification['passed'], true);
    assert.equal(verification['record_count'], 2);
    assert.equal(asArray(verification['pages']).length, 2);
    assert.deepEqual(verification['diagnostics'], []);
    const page = asRecord(asArray(verification['pages'])[0]);
    assert.match(String(page['response_hash']), /^[0-9a-f]{64}$/u);
    assert.equal(page['raw_id'], null);

    const requests = target.requests();
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.query['page'], '1');
    assert.equal(requests[0]?.authorization, `Bearer ${CREDENTIAL}`);
    assert.ok(!JSON.stringify(verified).includes(CREDENTIAL), 'the verification output leaked the credential value');

    const after = stateOf(current);
    assert.deepEqual(after.raw_acquisitions, before.raw_acquisitions);
    assert.deepEqual(after.acquisition_runs, before.acquisition_runs);
    assert.deepEqual(after.integration_batches, before.integration_batches);
    assert.deepEqual(after.datasets, before.datasets);
    assert.deepEqual(after.scraper_runs, before.scraper_runs);
    assert.deepEqual(after.source_scraper_services, []);

    // Adoption binds exactly the published Version the verification judged.
    const adopted = adopt(current, proposalId, current.sourceId);
    assert.equal(adopted['exit'], 0, String(adopted['stderr']));
    assert.equal(adopted['adopted_version'], 1);
    assert.equal(adopted['previous_adopted_version'], null);
    const pins = stateOf(current).source_scraper_services;
    assert.equal(pins.length, 1);
    assert.equal(pins[0]?.['source_id'], current.sourceId);
    assert.equal(pins[0]?.['adopted_version'], 1);
    assert.equal(pins[0]?.['content_hash'], adopted['content_hash']);
    assert.equal(pins[0]?.['proposal_id'], proposalId);
    assert.equal(show(current, proposalId)['status'], 'adopted');

    // A failing live target prevents Adoption and preserves any existing Source pin.
    const failing = surface();
    publishCredential(failing);
    const failingTask = publishTask(failing, '失败报表', tableTask(broken));
    const failingProposal = String(compile(failing, failingTask.taskId)['proposal_id']);
    assert.equal(validate(failing, failingProposal)['passed'], true);
    assert.equal(decide(failing, 'approve', failingProposal)['exit'], 0);
    assert.equal(decide(failing, 'publish', failingProposal)['exit'], 0);
    const failed = decide(failing, 'verify', failingProposal, ['--parameters', jsonFile(failing.fixture, 'verify-parameters', { region: 'east' })]);
    assert.equal(failed['exit'], 2, String(failed['stderr']));
    assert.equal(asRecord(failed['error'])['code'], 'SCRAPER_VERIFICATION_FAILED');
    const refusedAdoption = adopt(failing, failingProposal, failing.sourceId);
    assert.equal(refusedAdoption['exit'], 2);
    assert.equal(asRecord(refusedAdoption['error'])['code'], 'SCRAPER_VERIFICATION_FAILED');
    const failingState = stateOf(failing);
    assert.deepEqual(failingState.source_scraper_services, []);
    assert.deepEqual(failingState.raw_acquisitions, []);
    assert.deepEqual(failingState.datasets, []);
    // The failed verification stays readable as evidence rather than being erased.
    const failedEvidence = asRecord(asArray(show(failing, failingProposal)['verifications'])[0]);
    assert.equal(failedEvidence['passed'], false);
    assert.equal(asRecord(asArray(failedEvidence['diagnostics'])[0])['code'], 'SCRAPER_PAGE_STATUS');

    // Live verification needs the production credential to exist at all.
    const credentialless = surface();
    const credentiallessTask = publishTask(credentialless, '无凭据任务', tableTask(target));
    const credentiallessProposal = String(compile(credentialless, credentiallessTask.taskId)['proposal_id']);
    assert.equal(validate(credentialless, credentiallessProposal)['passed'], true);
    assert.equal(decide(credentialless, 'approve', credentiallessProposal)['exit'], 0);
    assert.equal(decide(credentialless, 'publish', credentiallessProposal)['exit'], 0);
    const missing = decide(credentialless, 'verify', credentiallessProposal, ['--parameters', jsonFile(credentialless.fixture, 'verify-parameters', { region: 'east' })]);
    assert.equal(missing['exit'], 2);
    assert.equal(asRecord(missing['error'])['code'], 'SCRAPER_CREDENTIAL_NOT_FOUND');
  } finally {
    await target.close();
    await broken.close();
  }
});

test('repeated Runs reuse the exact published Service version and return Raw Acquisitions, manifests, diagnostics, and Provenance', async () => {
  const target = await startHttpSource({
    replies: Array.from({ length: 8 }, (_, index) => ({
      body: index % 2 === 0 ? TABLE_PAGE : EMPTY_PAGE,
      content_type: 'text/html; charset=utf-8',
    })),
  });
  try {
    const current = surface();
    publishCredential(current);
    adoptIntegration(current);

    // Running before any Service is adopted fails closed and reads nothing.
    assert.equal(stateOf(current).source_scraper_services.length, 0);
    const notAdopted = run(current, { region: 'east' });
    assert.equal(notAdopted['exit'], 2);
    assert.equal(asRecord(notAdopted['error'])['code'], 'SCRAPER_SERVICE_NOT_ADOPTED');
    assert.deepEqual(target.requests(), []);

    const adopted = adoptScraper(current, tableTask(target), '处理量报表');
    const requestsAfterVerification = target.requests().length;
    assert.equal(requestsAfterVerification, 2);

    // A first Run returns its Raw Acquisitions, manifest, diagnostics, and Provenance.
    const first = run(current, { region: 'east' });
    assert.equal(first['exit'], 0, String(first['stderr']));
    assert.equal(first['scraper_service_version'], adopted.version);
    assert.equal(first['status'], 'complete');
    assert.equal(first['record_count'], 2);
    assert.equal(first['dataset_release'], 1);
    const raws = asArray(first['raw_acquisitions']) as Config[];
    assert.equal(raws.length, 2);
    for (const raw of raws) {
      assert.match(String(raw['content_hash']), /^[0-9a-f]{64}$/u);
      assert.ok(Number(raw['byte_length']) > 0);
    }
    const manifest = asRecord(first['manifest']);
    assert.equal(manifest['scraper_task_version'], 1);
    assert.equal(manifest['scraper_service_version'], adopted.version);
    assert.equal(manifest['record_count'], 2);
    assert.deepEqual(manifest['parameters'], { month: '2026-01', region: 'east' });
    assert.equal(asArray(manifest['pages']).length, 2);
    assert.equal(asRecord(asArray(manifest['pages'])[0])['record_count'], 2);
    assert.equal(asRecord(asArray(manifest['pages'])[1])['record_count'], 0);
    assert.equal(asRecord(asArray(manifest['pages'])[0])['raw_id'], raws[0]?.['raw_id']);
    assert.equal(asRecord(asArray(manifest['pages'])[1])['raw_id'], raws[1]?.['raw_id']);
    assert.deepEqual(first['diagnostics'], []);
    const provenance = asRecord(first['provenance']);
    assert.equal(provenance['scraper_service_version'], adopted.version);
    assert.equal(provenance['proposal_id'], adopted.proposalId);
    assert.match(String(provenance['scraper_task_content_hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(provenance['fixtures_hash']), /^[0-9a-f]{64}$/u);
    assert.equal(provenance['released'], true);
    assert.ok(!JSON.stringify(first).includes(CREDENTIAL), 'the Run output leaked the credential value');

    // The Run integrated a Raw Acquisition fragment, so a governed Dataset Release exists.
    const releases = asArray(stateOf(current).datasets[0]?.['releases']) as Config[];
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.['record_count'], 2);
    assert.equal(asArray(stateOf(current).acquisition_runs).length, 1);
    assert.equal(asRecord(asArray(stateOf(current).acquisition_runs)[0])['mode'], 'scraper');
    assert.equal(stateOf(current).scraper_runs.length, 1);

    // A repeated Run reuses exactly that Version and acquires again without duplicating records.
    const second = run(current, { region: 'east' });
    assert.equal(second['exit'], 0, String(second['stderr']));
    assert.equal(second['scraper_service_version'], adopted.version);
    assert.equal(second['scraper_service_content_hash'], first['scraper_service_content_hash']);
    assert.equal(second['dataset_release'], 1);
    assert.equal(second['record_count'], 2);
    assert.notEqual(
      asRecord(asArray(second['raw_acquisitions'])[0])['raw_id'],
      raws[0]?.['raw_id'],
    );
    assert.equal(asArray(stateOf(current).datasets[0]?.['releases']).length, 1);
    assert.equal(asArray(stateOf(current).raw_acquisitions).length, 4);
    assert.equal(stateOf(current).scraper_runs.length, 2);

    // Publishing a newer Service Version does not move an adopted Source's pin.
    publishTask(current, '处理量报表', tableTask(target));
    const newer = compile(current, String(stateOf(current).scraper_tasks[0]?.['scraper_task_id']));
    assert.equal(validate(current, String(newer['proposal_id']))['passed'], true);
    assert.equal(decide(current, 'approve', String(newer['proposal_id']))['exit'], 0);
    assert.equal(decide(current, 'publish', String(newer['proposal_id']))['exit'], 0);
    assert.equal(asArray(stateOf(current).scraper_services[0]?.['versions']).length, 2);
    assert.equal(stateOf(current).source_scraper_services[0]?.['adopted_version'], adopted.version);
    const third = run(current, { region: 'east' });
    assert.equal(third['exit'], 0, String(third['stderr']));
    assert.equal(third['scraper_service_version'], adopted.version);
    assert.equal(third['scraper_service_content_hash'], first['scraper_service_content_hash']);

    // Run parameters are validated before any target is read.
    const missingRequired = run(current);
    assert.equal(missingRequired['exit'], 2);
    assert.equal(asRecord(missingRequired['error'])['code'], 'SCRAPER_PARAMETER_REQUIRED');
    const unknown = run(current, { region: 'east', bogus: 'x' });
    assert.equal(unknown['exit'], 2);
    assert.equal(asRecord(unknown['error'])['code'], 'SCRAPER_PARAMETER_UNKNOWN');
    const mistyped = run(current, { region: 'east', limit: '很多' });
    assert.equal(mistyped['exit'], 2);
    assert.equal(asRecord(mistyped['error'])['code'], 'SCRAPER_PARAMETER_INVALID');

    // A scraper Source never accepts a hand upload, and a file Source never runs a Scraper Service.
    const upload = command(
      current.fixture,
      ['acquisition', 'upload', '--source', current.sourceId, '--file', textFile(current.fixture, 'upload.csv', 'sn,city,handled_count\nx,y,1\n')],
      { token: current.workspaceAdministratorToken },
    );
    assert.equal(upload.status, 2);
    assert.equal(upload.error['code'], 'ACQUISITION_MODE_MISMATCH');
    const fileSource = command(
      current.fixture,
      ['source', 'create', '--workspace', current.workspaceId, '--name', '手工台账', '--type', 'file'],
      { token: current.workspaceAdministratorToken },
    );
    assert.equal(fileSource.status, 0, fileSource.stderr);
    const wrongType = command(
      current.fixture,
      ['scraper', 'run', '--source', String(fileSource.output['source_id'])],
      { token: current.workspaceAdministratorToken },
    );
    assert.equal(wrongType.status, 2);
    assert.equal(wrongType.error['code'], 'SCRAPER_SOURCE_TYPE_UNSUPPORTED');
  } finally {
    await target.close();
  }
});

test('every user-facing string this ticket introduces is Simplified Chinese while governed codes stay unchanged', () => {
  const catalogPath = fileURLToPath(new URL('../../../web/src/i18n/zh-CN.ts', import.meta.url));
  const text = readFileSync(catalogPath, 'utf8');
  const entries: Array<{ key: string; value: string }> = [];
  for (const match of text.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',$/gmu)) {
    entries.push({ key: String(match[1]), value: String(match[2]) });
  }
  assert.ok(entries.length > 100, `the catalog lost entries: ${entries.length}`);

  const introduced = entries.filter((entry) => entry.key.startsWith('scraper.'));
  assert.ok(introduced.length >= 30, `too few introduced strings: ${introduced.length}`);

  // No introduced string is English-only, and every one is written in Chinese.
  for (const entry of introduced) {
    assert.ok(cjk(entry.value) >= 2, `${entry.key} is not Simplified Chinese: ${entry.value}`);
    assert.ok(!/^[\x20-\x7E]*$/u.test(entry.value), `${entry.key} is English-only: ${entry.value}`);
  }

  // Labels, forms, validation and error copy, empty/no-evidence, provenance, freshness, and status.
  for (const key of [
    'scraper.title',
    'scraper.task.title',
    'scraper.task.target',
    'scraper.task.networkScope',
    'scraper.task.outputContract',
    'scraper.task.parameters',
    'scraper.task.fixtures',
    'scraper.task.constraints',
    'scraper.task.credentialRefs',
    'scraper.validation.title',
    'scraper.validation.required',
    'scraper.validation.failed',
    'scraper.validation.noNetwork',
    'scraper.verification.title',
    'scraper.verification.required',
    'scraper.verification.failed',
    'scraper.verification.isolated',
    'scraper.reject.reason',
    'scraper.run.empty',
    'scraper.run.noEvidence',
    'scraper.provenance.title',
    'scraper.provenance.task',
    'scraper.provenance.service',
    'scraper.freshness.fresh',
    'scraper.freshness.stale',
    'scraper.proposal.status.pending',
    'scraper.proposal.status.approved',
    'scraper.proposal.status.rejected',
    'scraper.proposal.status.published',
    'scraper.proposal.status.adopted',
  ]) {
    const entry = entries.find((candidate) => candidate.key === key);
    assert.ok(entry !== undefined, `missing copy for ${key}`);
    assert.ok(cjk(entry.value) >= 2, `${key} is not Simplified Chinese: ${entry.value}`);
  }

  // Governed values are untouched: no catalog value is a bare API code, and codes stay ASCII.
  for (const entry of entries) {
    assert.ok(
      !/^[A-Z][A-Z0-9_]{3,}$/u.test(entry.value),
      `${entry.key} stores the governed code ${entry.value} as user-facing copy`,
    );
    assert.ok(!entry.key.startsWith('code.'), `the catalog must not translate governed codes: ${entry.key}`);
  }
});
