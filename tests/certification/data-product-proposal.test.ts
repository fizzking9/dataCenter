import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import { callApi, startConsole } from '../support/console.js';
import { LEDGER, acquireAndRelease, publishSource } from '../support/data-product.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from '../support/model-endpoint.js';
import type { OperatorResult } from '../support/operator.js';
import {
  command,
  contextEntries,
  jsonFile,
  textFile,
  workspaceFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

type Config = Record<string, unknown>;

const PURPOSES = ['data_product_proposal', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['dataset_schema', 'sample_records'];

const PROMPTS = {
  data_product_proposal: '你是数据产品助手，只输出简体中文说明，并按结构化输出返回候选 Data Product Contract。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

/** The Metric Definitions the Workspace Business Context publishes before any Release. */
const METRIC_DEFINITIONS = [
  { key: 'handled_count_total', kind: 'metric', value: '处理量合计', unit: '次' },
  { key: 'settled_amount_total', kind: 'metric', value: '结算金额合计', unit: '元' },
  { key: 'device_count', kind: 'metric', value: '记录条数' },
];

/** A Chinese requirement that names a governed identifier, so it needs no clarification. */
const REQUIREMENT = '按城市统计 SN 的设备数与处理量合计。';
const CLARIFICATION = '请确认要统计的时间范围是哪一段？';

/** The one generic route the Data Product API serves; no endpoint is generated per Product. */
const QUERY_ROUTE = '/api/workspaces/{workspace_id}/data-products/{data_product_id}/query';

const CHECKS = [
  'contract:valid',
  'fields:resolved',
  'dimensions:resolved',
  'metrics:defined',
  'grain:unique',
  'dataset_release:current',
];

interface Surface extends WorkspaceFixture {
  sourceId: string;
}

interface Profile {
  modelProfileId: string;
  version: number;
  contentHash: string;
}

interface StateFile {
  artifact_proposals: Config[];
  data_products: Config[];
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

/** A response without the server-local cache marker, which is not part of the governed answer. */
function withoutCache(payload: Config): Config {
  const copy = { ...payload };
  delete copy['cache'];
  return copy;
}

/** The reusable query pages the server holds; a preview must write none. */
function cachePages(s: Surface): string[] {
  const root = join(s.fixture.root, 'cache', 'query-results');
  return existsSync(root) ? readdirSync(root).sort() : [];
}

function stateOf(s: Surface): StateFile {
  return JSON.parse(readFileSync(join(s.fixture.root, 'state', 'platform.json'), 'utf8')) as StateFile;
}

/**
 * One Workspace whose Business Context already defines the metrics a Proposal may
 * use, holding one file Source with one real Dataset Release.
 */
function surface(entries: unknown[] = METRIC_DEFINITIONS): Surface {
  const base: WorkspaceFixture = workspaceFixture();
  publishDefinitions(base, 'definitions-v1', entries);
  const sourceId = publishSource(base.fixture, base.workspaceAdministratorToken, base.workspaceId);
  acquireAndRelease(base.fixture, base.workspaceAdministratorToken, sourceId);
  return { ...base, sourceId };
}

/** Publishes one immutable Workspace Business Context snapshot. */
function publishDefinitions(s: WorkspaceFixture, name: string, entries: unknown[] = METRIC_DEFINITIONS): void {
  const published = command(
    s.fixture,
    ['context', 'publish-workspace', '--workspace', s.workspaceId, '--entries', contextEntries(s.fixture, name, entries)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
}

function profileConfig(endpoint: MockModelEndpoint, adapter: string, overrides: Config = {}): Config {
  return {
    adapter,
    endpoint_url: endpoint.url,
    model_id: MOCK_MODEL_ID,
    purposes: [...PURPOSES],
    data_categories: [...DATA_CATEGORIES],
    tools: [],
    max_output_bytes: 65_536,
    prompts: { ...PROMPTS },
    ...overrides,
  };
}

function publishProfile(
  s: Surface,
  endpoint: MockModelEndpoint,
  adapter: string,
  name: string,
  overrides: Config = {},
): Profile {
  const published = command(
    s.fixture,
    ['model', 'publish', '--name', name, '--config', jsonFile(s.fixture, `profile-${name}`, profileConfig(endpoint, adapter, overrides))],
    { token: s.deploymentAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  return {
    modelProfileId: String(published.output['model_profile_id']),
    version: Number(published.output['model_profile_version']),
    contentHash: String(published.output['content_hash']),
  };
}

function evaluateProfile(s: Surface, profile: Profile): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['model', 'evaluate', '--profile', profile.modelProfileId, '--version', String(profile.version)],
    { token: s.deploymentAdministratorToken },
  );
}

function activateProfile(s: Surface, profile: Profile): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['model', 'activate', '--profile', profile.modelProfileId, '--version', String(profile.version)],
    { token: s.deploymentAdministratorToken },
  );
}

/** Publishes, evaluates, and activates one Model Profile Version. */
async function activatedProfile(
  s: Surface,
  endpoint: MockModelEndpoint,
  adapter: string,
  name: string,
  overrides: Config = {},
): Promise<Profile> {
  const profile = publishProfile(s, endpoint, adapter, name, overrides);
  const evaluated = await evaluateProfile(s, profile);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.output['passed'], true, JSON.stringify(evaluated.output['checks']));
  const activated = await activateProfile(s, profile);
  assert.equal(activated.status, 0, activated.stderr);
  return profile;
}

/** Binds the exact Version for every purpose this lifecycle reads. */
async function bindProposal(s: Surface, profile: Profile): Promise<string> {
  const bound = await commandAsync(
    s.fixture,
    [
      'binding', 'publish',
      '--workspace', s.workspaceId,
      '--profile', profile.modelProfileId,
      '--config', jsonFile(s.fixture, 'binding-data-product-proposal', {
        model_profile_version: profile.version,
        purposes: [...PURPOSES],
        data_categories: [...DATA_CATEGORIES],
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  return String(bound.output['binding_id']);
}

/** Binds one exact Version to the purposes and data categories a test states. */
async function bindNarrow(
  s: Surface,
  profile: Profile,
  purposes: string[],
  dataCategories: string[],
): Promise<string> {
  const bound = await commandAsync(
    s.fixture,
    [
      'binding', 'publish',
      '--workspace', s.workspaceId,
      '--profile', profile.modelProfileId,
      '--config', jsonFile(s.fixture, `binding-${purposes.join('-')}`, {
        model_profile_version: profile.version,
        purposes,
        data_categories: dataCategories,
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(bound.status, 0, bound.stderr);
  return String(bound.output['binding_id']);
}

let sequence = 0;

function generate(s: Surface, bindingId: string, document: Config): Promise<CommandResult> {
  sequence += 1;
  return commandAsync(
    s.fixture,
    [
      'product-proposal', 'generate',
      '--source', s.sourceId,
      '--binding', bindingId,
      '--requirement', jsonFile(s.fixture, `requirement-${sequence}`, document),
    ],
    { token: s.workspaceAdministratorToken },
  );
}

function validateProposal(s: Surface, proposalId: string): OperatorResult {
  return command(
    s.fixture,
    ['product-proposal', 'validate', '--proposal', proposalId],
    { token: s.workspaceAdministratorToken },
  );
}

function previewProposal(s: Surface, proposalId: string): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['product-proposal', 'preview', '--proposal', proposalId],
    { token: s.workspaceAdministratorToken },
  );
}

function decide(s: Surface, verb: 'approve' | 'reject' | 'publish', proposalId: string, reason?: string): OperatorResult {
  const args = ['product-proposal', verb, '--proposal', proposalId];
  if (reason !== undefined) args.push('--reason', reason);
  return command(s.fixture, args, { token: s.workspaceAdministratorToken });
}

function showProposal(s: Surface, proposalId: string): OperatorResult {
  return command(
    s.fixture,
    ['product-proposal', 'show', '--proposal', proposalId],
    { token: s.workspaceAdministratorToken },
  );
}

/** Generates, validates, and previews one Proposal against the real Release. */
async function prepared(s: Surface, bindingId: string): Promise<{ proposalId: string; generated: CommandResult }> {
  const generated = await generate(s, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
  assert.equal(generated.status, 0, generated.stderr);
  const proposalId = String(generated.output['proposal_id']);
  assert.equal(validateProposal(s, proposalId).status, 0);
  assert.equal((await previewProposal(s, proposalId)).status, 0);
  return { proposalId, generated };
}

test('a Data Product Proposal draws only on the Dataset Release and Business Context the acting Workspace Administrator governs', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '产品提案档案');
    const bindingId = await bindProposal(current, profile);

    const first = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.output['kind'], 'data_product');
    assert.equal(first.output['status'], 'pending');

    // The evidence names exactly the authorised Schema and Metric Definitions.
    const evidence = asRecord(first.output['evidence']);
    assert.deepEqual(evidence['schema_fields'], ['sn', 'city', 'handled_count', 'settled_amount', 'reported_on']);
    assert.equal(evidence['field_count'], 5);
    assert.deepEqual(evidence['metric_definition_keys'], ['handled_count_total', 'settled_amount_total', 'device_count']);
    assert.match(String(evidence['dataset_release_hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(evidence['requirement_hash']), /^[0-9a-f]{64}$/u);

    // The candidate selects from that Schema; it never restates or invents it.
    const candidates = asRecord(first.output['candidates']);
    const contract = asRecord(candidates['contract']);
    assert.equal(candidates['name'], '设备处理量台账');
    assert.deepEqual(
      (contract['fields'] as Config[]).map((field) => field['name']),
      ['sn', 'city', 'handled_count', 'settled_amount', 'reported_on'],
    );
    assert.deepEqual(contract['dimensions'], ['city']);
    assert.deepEqual(contract['grain'], ['sn']);
    assert.deepEqual(contract['time'], { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' });
    assert.deepEqual(
      (contract['metrics'] as Config[]).map((metric) => `${String(metric['name'])}:${String(metric['aggregation'])}:${String(metric['field'] ?? '')}`),
      ['handled_count_total:sum:handled_count', 'settled_amount_total:sum:settled_amount', 'device_count:count:'],
    );
    for (const hash of [candidates['contract_hash'], candidates['content_hash'], first.output['proposal_hash']]) {
      assert.match(String(hash), /^[0-9a-f]{64}$/u);
    }

    // The base pins the exact Release and the exact Business Context Versions.
    const base = asRecord(first.output['base']);
    assert.equal(base['dataset_release'], 1);
    assert.equal(base['workspace_business_context_version'], 1);
    assert.equal(base['common_business_context_version'], 0);
    assert.equal(base['data_product_id'], null);
    assert.equal(base['data_product_version'], null);
    assert.equal(base['data_product_contract_hash'], null);

    // The same evidence and base produce the same content address.
    const second = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(second.output['proposal_id'], first.output['proposal_id']);
    assert.equal(second.output['proposal_hash'], first.output['proposal_hash']);
    assert.deepEqual(second.output['candidates'], first.output['candidates']);

    // A changed requirement is different Proposal content, so it can never
    // ride on the Approval given to the one before it.
    const changed = await generate(current, bindingId, {
      name: '设备处理量台账',
      requirement: '按城市统计 SN 的结算金额合计。',
    });
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(changed.output['proposal_hash'], first.output['proposal_hash']);
    assert.notEqual(asRecord(changed.output['evidence'])['requirement_hash'], evidence['requirement_hash']);

    // Editing the candidate breaks the content address, so the record is refused.
    const proposalId = String(first.output['proposal_id']);
    const statePath = join(current.fixture.root, 'state', 'platform.json');
    const state = stateOf(current);
    const stored = state.artifact_proposals.find((proposal) => proposal['proposal_id'] === proposalId);
    assert.ok(stored !== undefined);
    asRecord(asRecord(stored['candidates'])['contract'])['title'] = '另一个数据产品';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const tampered = showProposal(current, proposalId);
    assert.equal(tampered.status, 2, tampered.stdout);
    assert.equal(tampered.error['code'], 'PRODUCT_PROPOSAL_TAMPERED');
  } finally {
    await endpoint.close();
  }
});

test('a candidate that names an unauthorised field, dimension, metric, or Dataset is refused before any Proposal exists', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '越权档案');
    const bindingId = await bindProposal(current, profile);

    // A field from outside this Dataset Schema is a hard failure, not a warning.
    endpoint.behaviour = 'unauthorized_field';
    const field = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(field.status, 2, field.stdout);
    assert.equal(field.error['code'], 'PRODUCT_PROPOSAL_CANDIDATE_INVALID');
    assert.match(String(field.error['message']), /secret_field/u);

    // A dimension that is not an exposed field of the candidate is refused too.
    endpoint.behaviour = 'unauthorized_dimension';
    const dimension = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(dimension.status, 2, dimension.stdout);
    assert.equal(dimension.error['code'], 'PRODUCT_PROPOSAL_CANDIDATE_INVALID');
    // The Contract reader states the rule; a refused name never reaches the record.
    assert.match(String(dimension.error['message']), /must name an exposed field/u);

    // A metric no Metric Definition of this Workspace defines would invent semantics.
    endpoint.behaviour = 'unauthorized_metric';
    const metric = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(metric.status, 2, metric.stdout);
    assert.equal(metric.error['code'], 'PRODUCT_PROPOSAL_METRIC_UNDEFINED');
    assert.match(String(metric.error['message']), /foreign_total/u);

    // Naming another Workspace's Dataset is refused before the model is asked at all.
    endpoint.behaviour = 'normal';
    const dataset = await generate(current, bindingId, {
      name: '设备处理量台账',
      requirement: REQUIREMENT,
      dataset_id: 'other-workspace-dataset',
    });
    assert.equal(dataset.status, 2, dataset.stdout);
    assert.equal(dataset.error['code'], 'PRODUCT_PROPOSAL_DATASET_UNAVAILABLE');

    // None of the four attempts left a Proposal behind.
    assert.deepEqual(stateOf(current).artifact_proposals, []);
  } finally {
    await endpoint.close();
  }
});

test('validation resolves every Contract name and a preview exposes the API shape, example queries, results, freshness, and Provenance without production writes', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'generic_local', '预览档案');
    const bindingId = await bindProposal(current, profile);

    const generated = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(generated.status, 0, generated.stderr);
    const proposalId = String(generated.output['proposal_id']);
    const contractHash = asRecord(generated.output['candidates'])['contract_hash'];
    const before = stateOf(current);

    // Validation proves every name the candidate declares against the real Release.
    const validated = validateProposal(current, proposalId);
    assert.equal(validated.status, 0, validated.stderr);
    const validation = asRecord(validated.output['validation']);
    assert.deepEqual(validation['checks'], CHECKS);
    assert.equal(validation['dataset_release'], 1);
    assert.equal(validation['contract_hash'], contractHash);
    assert.deepEqual(validation['metric_definition_keys'], ['handled_count_total', 'settled_amount_total', 'device_count']);
    assert.match(String(validation['evidence_hash']), /^[0-9a-f]{64}$/u);

    const previewed = await previewProposal(current, proposalId);
    assert.equal(previewed.status, 0, previewed.stderr);
    assert.equal(previewed.output['status'], 'pending');
    const preview = asRecord(previewed.output['preview']);

    // The API shape is the one generic route; no Product path exists before Publication.
    const apiShape = asRecord(preview['api_shape']);
    assert.equal(apiShape['method'], 'POST');
    assert.equal(apiShape['route'], QUERY_ROUTE);
    assert.equal(apiShape['api_path'], null);
    const request = asRecord(apiShape['request']);
    assert.deepEqual(request['kinds'], ['records', 'aggregate']);
    assert.deepEqual(request['dimensions'], ['city']);
    assert.deepEqual(request['grain'], ['sn']);
    assert.deepEqual(request['filters'], ['sn', 'city', 'handled_count', 'settled_amount', 'reported_on']);
    assert.deepEqual(
      (request['metrics'] as Config[]).map((metric) => `${String(metric['name'])}:${String(metric['aggregation'])}`),
      ['handled_count_total:sum', 'settled_amount_total:sum', 'device_count:count'],
    );

    // Example queries and representative results are the real engine's answers.
    const queries = asArray(preview['example_queries']);
    assert.deepEqual(queries[0], {
      kind: 'aggregate',
      group_by: ['city'],
      metrics: ['handled_count_total', 'settled_amount_total', 'device_count'],
      include_totals: true,
      limit: 10,
    });
    assert.deepEqual(queries[1], { kind: 'records', limit: 10 });
    const aggregate = asRecord(asArray(preview['representative_results'])[0]);
    assert.equal(aggregate['kind'], 'aggregate');
    assert.equal(aggregate['groups_total'], 3);
    assert.deepEqual(asRecord(asRecord(aggregate['totals'])['metrics']), {
      handled_count_total: 10,
      settled_amount_total: '420.50',
      device_count: 3,
    });
    const records = asRecord(asArray(preview['representative_results'])[1]);
    assert.equal(records['kind'], 'records');
    assert.equal(records['matched_count'], 3);
    assert.deepEqual((records['records'] as Config[]).map((row) => row['sn']), ['sn-001', 'sn-002', 'sn-003']);

    // Freshness and Provenance name the exact Release the preview read.
    const freshness = asRecord(preview['freshness']);
    assert.equal(freshness['dataset_release'], 1);
    assert.equal(freshness['dataset_record_count'], 3);
    assert.deepEqual(freshness['time'], { field: 'reported_on', precision: 'date', time_zone: 'Asia/Shanghai' });
    const provenance = asRecord(preview['provenance']);
    assert.equal(provenance['dataset_release'], 1);
    assert.equal(asRecord(provenance['source'])['source_id'], current.sourceId);
    assert.equal(provenance['record_count'], 3);
    assert.equal(asRecord(provenance['business_context'])['common_business_context_version'], 0);
    assert.equal(asRecord(provenance['business_context'])['workspace_business_context_version'], 1);

    // The same Release read twice produces the same evidence address.
    const repeated = await previewProposal(current, proposalId);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(asRecord(repeated.output['preview'])['evidence_hash'], preview['evidence_hash']);

    // Nothing production-visible moved: no Data Product, no Release, no cache page.
    const after = stateOf(current);
    assert.deepEqual(after.data_products, []);
    assert.deepEqual(after.datasets, before.datasets);
    assert.equal(asArray(after.datasets[0]?.['releases']).length, 1);
    const stored = after.artifact_proposals.find((proposal) => proposal['proposal_id'] === proposalId);
    assert.ok(stored !== undefined);
    assert.equal(asArray(stored['previews']).length, 2);
    // The preview ran the real engine but wrote no reusable page of its own.
    assert.deepEqual(cachePages(current), []);
  } finally {
    await endpoint.close();
  }
});

test('exact-version Approval and Publication expose the new Data Product Version through the existing Data Product API with no generated endpoint', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '发布档案');
    const bindingId = await bindProposal(current, profile);

    const generated = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(generated.status, 0, generated.stderr);
    const proposalId = String(generated.output['proposal_id']);
    const contractHash = asRecord(generated.output['candidates'])['contract_hash'];

    // Approval is exact and evidenced: validation, then a preview, then the human.
    const premature = decide(current, 'approve', proposalId);
    assert.equal(premature.status, 2, premature.stdout);
    assert.equal(premature.error['code'], 'PRODUCT_PROPOSAL_VALIDATION_REQUIRED');
    assert.equal(validateProposal(current, proposalId).status, 0);
    const unPreviewed = decide(current, 'approve', proposalId);
    assert.equal(unPreviewed.status, 2, unPreviewed.stdout);
    assert.equal(unPreviewed.error['code'], 'PRODUCT_PROPOSAL_PREVIEW_REQUIRED');
    assert.equal((await previewProposal(current, proposalId)).status, 0);

    const approved = decide(current, 'approve', proposalId);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(approved.output['status'], 'approved');
    const provenance = asRecord(approved.output['provenance']);
    for (const key of ['validation_hash', 'preview_hash', 'candidate_content_hash', 'proposal_hash']) {
      assert.match(String(provenance[key]), /^[0-9a-f]{64}$/u);
    }

    const published = decide(current, 'publish', proposalId);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.output['status'], 'published');
    assert.equal(published.output['data_product_version'], 1);
    assert.equal(published.output['data_product_release'], 1);
    assert.equal(published.output['dataset_release'], 1);
    assert.equal(published.output['contract_hash'], contractHash);
    const dataProductId = String(published.output['data_product_id']);
    const queryPath = String(published.output['api_path']);
    assert.equal(queryPath, `/api/workspaces/${current.workspaceId}/data-products/${dataProductId}/query`);

    // The existing Data Product API serves the new Version; nothing was generated.
    const server = await startConsole(current.fixture);
    try {
      const answer = await callApi(server.url, queryPath, {
        body: { kind: 'aggregate', group_by: ['city'], metrics: ['handled_count_total'], include_totals: true },
        token: current.consumerToken,
      });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.body['contract_hash'], contractHash);
      assert.equal(answer.body['data_product_version'], 1);
      assert.equal(answer.body['data_product_release'], 1);
      assert.deepEqual(asRecord(asRecord(answer.body['totals'])['metrics']), { handled_count_total: 10 });
      assert.equal(answer.body['groups_total'], 3);
    } finally {
      await server.stop();
    }

    // The Product carries a path and a Version, not a generated route or handler.
    const product = stateOf(current).data_products[0];
    assert.ok(product !== undefined);
    assert.equal(product['api_path'], queryPath);
    assert.deepEqual(
      Object.keys(product).filter((key) => ['code', 'endpoint', 'handler', 'module', 'route', 'routes'].includes(key)),
      [],
    );
    assert.equal(asArray(product['versions']).length, 1);
    assert.equal(asArray(product['releases']).length, 1);

    // Publication is once-only.
    const again = decide(current, 'publish', proposalId);
    assert.equal(again.status, 2, again.stdout);
    assert.equal(again.error['code'], 'PRODUCT_PROPOSAL_ALREADY_PUBLISHED');
  } finally {
    await endpoint.close();
  }
});

test('a Publication that cannot land whole leaves no Data Product and no publication fact', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'generic_local', '原子档案');
    const bindingId = await bindProposal(current, profile);
    const { proposalId } = await prepared(current, bindingId);
    const approved = decide(current, 'approve', proposalId);
    assert.equal(approved.status, 0, approved.stderr);

    // The Business Context moves after Approval, so the exact inputs are gone.
    publishDefinitions(current, 'definitions-v2', [
      ...METRIC_DEFINITIONS,
      { key: 'refund_rate', kind: 'metric', value: '0.12', unit: 'ratio' },
    ]);
    const refused = decide(current, 'publish', proposalId);
    assert.equal(refused.status, 2, refused.stdout);
    assert.equal(refused.error['code'], 'PRODUCT_PROPOSAL_BASE_STALE');

    // Nothing half-landed: no Product, no Release, no publication record.
    const after = stateOf(current);
    assert.deepEqual(after.data_products, []);
    assert.equal(asArray(after.datasets[0]?.['releases']).length, 1);
    const stored = after.artifact_proposals.find((proposal) => proposal['proposal_id'] === proposalId);
    assert.ok(stored !== undefined);
    assert.deepEqual(asArray(stored['publications']), []);
    assert.equal(showProposal(current, proposalId).output['status'], 'approved');
  } finally {
    await endpoint.close();
  }
});

test('a moved Business Context Version makes a Proposal stale while the published Contract keeps serving', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '上下文档案');
    const bindingId = await bindProposal(current, profile);
    const { proposalId } = await prepared(current, bindingId);
    assert.equal(decide(current, 'approve', proposalId).status, 0);
    const published = decide(current, 'publish', proposalId);
    assert.equal(published.status, 0, published.stderr);
    const queryPath = String(published.output['api_path']);
    const contractHash = String(published.output['contract_hash']);

    let second: CommandResult | undefined;
    const server = await startConsole(current.fixture);
    try {
      const query = { kind: 'aggregate', group_by: ['city'], metrics: ['handled_count_total'], include_totals: true };
      const before = await callApi(server.url, queryPath, { body: query, token: current.consumerToken });
      assert.equal(before.status, 200, before.text);

      // A second Proposal is validated and previewed against the exact inputs...
      second = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
      assert.equal(second.status, 0, second.stderr);
      const secondId = String(second.output['proposal_id']);
      assert.equal(validateProposal(current, secondId).status, 0);
      assert.equal((await previewProposal(current, secondId)).status, 0);

      // ...then the Metric Definition it relies on moves to a new Version.
      publishDefinitions(current, 'definitions-v2', [
        { key: 'handled_count_total', kind: 'metric', value: '处理量合计（修正口径）', unit: '次' },
        { key: 'settled_amount_total', kind: 'metric', value: '结算金额合计', unit: '元' },
        { key: 'device_count', kind: 'metric', value: '记录条数' },
      ]);

      const staleApproval = decide(current, 'approve', secondId);
      assert.equal(staleApproval.status, 2, staleApproval.stdout);
      assert.equal(staleApproval.error['code'], 'PRODUCT_PROPOSAL_BASE_STALE');
      const staleValidation = validateProposal(current, secondId);
      assert.equal(staleValidation.status, 2, staleValidation.stdout);
      assert.equal(staleValidation.error['code'], 'PRODUCT_PROPOSAL_BASE_STALE');

      // The published Contract serves exactly what it served before the move.
      const after = await callApi(server.url, queryPath, { body: query, token: current.consumerToken });
      assert.equal(after.status, 200, after.text);
      assert.deepEqual(withoutCache(after.body), withoutCache(before.body));
      assert.equal(after.body['contract_hash'], contractHash);
    } finally {
      await server.stop();
    }

    // Only a new Proposal, generated against the new Business Context, may proceed.
    assert.ok(second !== undefined);
    const third = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(third.status, 0, third.stderr);
    assert.notEqual(third.output['proposal_hash'], second.output['proposal_hash']);
    assert.equal(asRecord(third.output['base'])['workspace_business_context_version'], 2);
    const product = stateOf(current).data_products[0];
    assert.ok(product !== undefined);
    assert.equal(asArray(product['versions']).length, 1);
    assert.equal(asArray(product['releases']).length, 1);
  } finally {
    await endpoint.close();
  }
});

test('a moved Dataset Release makes a Proposal stale and only a new Proposal over the new Release may be approved', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '发布基线档案');
    const bindingId = await bindProposal(current, profile);
    const { proposalId } = await prepared(current, bindingId);

    // A second Release lands under the same Source, carrying one more record,
    // because an identical redelivery reconciles to the same Release.
    const extended = [LEDGER, 'sn-004,深圳,1,50.00,2026-01-25'].join('\n');
    const upload = command(
      current.fixture,
      ['acquisition', 'upload', '--source', current.sourceId, '--file', textFile(current.fixture, 'ledger-extended.csv', extended)],
      { token: current.workspaceAdministratorToken },
    );
    assert.equal(upload.status, 0, upload.stderr);
    const released = command(current.fixture, ['dataset', 'release', '--source', current.sourceId], {
      token: current.workspaceAdministratorToken,
    });
    assert.equal(released.status, 0, released.stderr);
    assert.equal(released.output['dataset_release'], 2);
    const stale = decide(current, 'approve', proposalId);
    assert.equal(stale.status, 2, stale.stdout);
    assert.equal(stale.error['code'], 'PRODUCT_PROPOSAL_BASE_STALE');
    const staleValidation = validateProposal(current, proposalId);
    assert.equal(staleValidation.status, 2, staleValidation.stdout);
    assert.equal(staleValidation.error['code'], 'PRODUCT_PROPOSAL_BASE_STALE');

    // A new Proposal over the new Release is the only one that can be approved.
    const fresh = await generate(current, bindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(fresh.status, 0, fresh.stderr);
    const base = asRecord(fresh.output['base']);
    assert.equal(base['dataset_release'], 2);
    assert.notEqual(fresh.output['proposal_hash'], showProposal(current, proposalId).output['proposal_hash']);
    const freshId = String(fresh.output['proposal_id']);
    assert.equal(validateProposal(current, freshId).status, 0);
    assert.equal((await previewProposal(current, freshId)).status, 0);
    assert.equal(decide(current, 'approve', freshId).status, 0);
    const published = decide(current, 'publish', freshId);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.output['dataset_release'], 2);

    // The stale Proposal never became a decision.
    assert.equal(showProposal(current, proposalId).output['status'], 'pending');
  } finally {
    await endpoint.close();
  }
});

test('a Chinese requirement with a mixed SN identifier is clarified in Chinese and narrated in Simplified Chinese with deterministic results', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '中文档案');
    const bindingId = await bindProposal(current, profile);

    // A requirement that names nothing governed is asked back in Chinese.
    const vague = await generate(current, bindingId, { requirement: '整理一下数据' });
    assert.equal(vague.status, 2, vague.stdout);
    assert.equal(vague.error['code'], 'PRODUCT_PROPOSAL_CLARIFICATION_REQUIRED');
    assert.match(String(vague.error['message']), /请确认要统计的时间范围是哪一段？/u);
    assert.deepEqual(stateOf(current).artifact_proposals, []);

    // The answer is recorded, and the requirement keeps its mixed SN identifier.
    const generated = await generate(current, bindingId, {
      name: '设备处理量台账',
      requirement: REQUIREMENT,
      clarifications: [{ question: CLARIFICATION, answer: '全部数据。' }],
    });
    assert.equal(generated.status, 0, generated.stderr);
    assert.deepEqual(asArray(asRecord(generated.output['requirement'])['clarifications']), [
      { question: CLARIFICATION, answer: '全部数据。' },
    ]);
    const proposalId = String(generated.output['proposal_id']);
    assert.equal(validateProposal(current, proposalId).status, 0);
    const previewed = await previewProposal(current, proposalId);
    assert.equal(previewed.status, 0, previewed.stderr);
    const preview = asRecord(previewed.output['preview']);

    // The narrative is Simplified Chinese and cites a number the Release really holds.
    const narrative = asRecord(preview['narrative']);
    const text = String(narrative['text']);
    assert.ok(cjk(text) >= 6, `the narrative is not Simplified Chinese: ${text}`);
    const cited = /处理量为 (\d+)/u.exec(text);
    assert.ok(cited !== null, `the narrative cites no governed number: ${text}`);
    const rows = asArray(asRecord(asArray(preview['representative_results'])[1])['records']) as Config[];
    assert.ok(rows.some((row) => row['handled_count'] === Number(cited[1])), 'the narrative cites a number the Release does not hold');
    assert.deepEqual(narrative['evidence_refs'], [{ field: 'handled_count', value: Number(cited[1]) }]);

    // Numbers, filters, Release, and Provenance stay deterministic across previews.
    const aggregate = asRecord(asArray(preview['representative_results'])[0]);
    assert.deepEqual(asRecord(asRecord(aggregate['totals'])['metrics']), {
      handled_count_total: 10,
      settled_amount_total: '420.50',
      device_count: 3,
    });
    assert.equal(asRecord(preview['freshness'])['dataset_release'], 1);
    assert.equal(asRecord(preview['provenance'])['dataset_release'], 1);
    const repeated = await previewProposal(current, proposalId);
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedPreview = asRecord(repeated.output['preview']);
    assert.equal(repeatedPreview['evidence_hash'], preview['evidence_hash']);
    assert.equal(asRecord(repeatedPreview['narrative'])['text'], text);
  } finally {
    await endpoint.close();
  }
});

test('every Data Product Proposal string this ticket introduces is Simplified Chinese', () => {
  const catalogPath = fileURLToPath(new URL('../../../web/src/i18n/zh-CN.ts', import.meta.url));
  const text = readFileSync(catalogPath, 'utf8');
  const entries: Array<{ key: string; value: string }> = [];
  for (const match of text.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',$/gmu)) {
    entries.push({ key: String(match[1]), value: String(match[2]) });
  }

  const introduced = entries.filter((entry) => entry.key.startsWith('productProposal.'));
  assert.ok(introduced.length >= 30, `too few Data Product Proposal strings: ${introduced.length}`);

  // No introduced string is English-only, and none stores a governed code as copy.
  for (const entry of introduced) {
    assert.ok(cjk(entry.value) >= 2, `${entry.key} is not Simplified Chinese: ${entry.value}`);
    assert.ok(!/^[\x20-\x7E]*$/u.test(entry.value), `${entry.key} is English-only: ${entry.value}`);
    assert.ok(!/^[A-Z][A-Z0-9_]{3,}$/u.test(entry.value), `${entry.key} stores a governed code as copy`);
  }

  // Labels, clarification, validation, preview, freshness, Provenance, and Publication.
  for (const key of [
    'productProposal.title',
    'productProposal.clarification.required',
    'productProposal.candidate.metrics',
    'productProposal.metric.undefined',
    'productProposal.validation.required',
    'productProposal.preview.required',
    'productProposal.preview.apiShape',
    'productProposal.preview.representativeResults',
    'productProposal.preview.noWrites',
    'productProposal.freshness.fresh',
    'productProposal.freshness.stale',
    'productProposal.provenance.title',
    'productProposal.published',
    'productProposal.empty',
  ]) {
    const entry = introduced.find((candidate) => candidate.key === key);
    assert.ok(entry !== undefined, `missing copy for ${key}`);
    assert.ok(cjk(entry.value) >= 2, `${key} is not Simplified Chinese: ${entry.value}`);
  }
});

/** A Binding's permitted data categories narrow every generation path, not only publication. */
test('a Binding that permits fewer data categories refuses a generation whose evidence leaves its set', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '窄范围档案');

    // This Binding permits only the Proposal purpose and the Schema it sends. The
    // Version still declares grounded narration, whose evidence is sample records.
    const narrowBindingId = await bindNarrow(current, profile, ['data_product_proposal'], ['dataset_schema']);
    const generated = await generate(current, narrowBindingId, { name: '设备处理量台账', requirement: REQUIREMENT });
    assert.equal(generated.status, 0, generated.stderr);
    const proposalId = String(generated.output['proposal_id']);
    assert.equal(validateProposal(current, proposalId).status, 0);

    // The preview's narrative would send sample records the Binding forbids, so it
    // is refused rather than quietly sent or silently skipped.
    const refused = await previewProposal(current, proposalId);
    assert.equal(refused.status, 2, refused.stdout);
    assert.equal(refused.error['code'], 'MODEL_DATA_CATEGORY_NOT_PERMITTED');
    assert.match(String(refused.error['message']), /sample_records/u);

    // Permitting the narration categories restores the whole lifecycle unchanged.
    const permittedBindingId = await bindProposal(current, profile);
    const permitted = await prepared(current, permittedBindingId);
    assert.equal(permitted.generated.status, 0);
  } finally {
    await endpoint.close();
  }
});
