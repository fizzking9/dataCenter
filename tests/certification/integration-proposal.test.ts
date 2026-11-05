import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandAsync, type CommandResult } from '../support/async-command.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from '../support/model-endpoint.js';
import {
  command,
  jsonFile,
  textFile,
  workspaceFixture,
  type PlatformFixture,
  type WorkspaceFixture,
} from '../support/platform.js';

type Config = Record<string, unknown>;

const PURPOSES = ['integration_proposal', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['dataset_schema', 'cleaning_rules', 'source_mapping', 'sample_records'];

const PROMPTS = {
  integration_proposal: '你是数据集成助手，只输出简体中文说明，并按结构化输出返回候选 Integration Configuration。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

/** The Integration Configuration a Source already runs before any Proposal. */
const BASE_CONFIGURATION: Config = {
  identity: ['sn'],
  schema: [
    { name: 'sn', type: 'string' },
    { name: 'city', type: 'string' },
    { name: 'handled_count', type: 'integer' },
  ],
  cleaning: [],
  mapping: { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' },
};

/** One representative upload: a value to transform, a value to reject, a column to ignore. */
const RAW_CSV = [
  '设备SN,城市,处理量,备注',
  ' dev-1 ,杭州,12,临时',
  'dev-2,上海,十二,临时',
  '',
].join('\n');

const VALIDATION_FIXTURES: Config = {
  fixtures: [
    {
      name: '标准样本',
      header: ['设备SN', '城市', '处理量', '备注'],
      rows: [
        [' dev-1 ', '杭州', '12', '临时'],
        ['dev-2', '上海', '十二', '临时'],
      ],
    },
  ],
};

const PROVENANCE_KEYS = [
  'adapter',
  'binding_id',
  'candidate_content_hash',
  'data_dictionary_hash',
  'model_id',
  'model_profile_content_hash',
  'model_profile_id',
  'model_profile_version',
  'preview_hash',
  'prompt_hash',
  'prompt_id',
  'proposal_hash',
  'validation_hash',
];

interface Surface {
  fixture: PlatformFixture;
  workspaceId: string;
  deploymentAdministratorToken: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  sourceId: string;
}

interface Profile {
  modelProfileId: string;
  version: number;
  contentHash: string;
}

interface BaseVersion {
  version: number;
  contentHash: string;
}

interface StateFile {
  artifact_proposals: Config[];
  model_profiles: Config[];
  model_bindings: Config[];
  integration_configurations: Array<{ adopted_version: number | null; versions: Config[] }>;
  datasets: unknown[];
  raw_acquisitions: unknown[];
}

function asRecord(value: unknown): Config {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Config;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

/** One Workspace holding a Workspace Administrator, a Consumer, and one file Source. */
function surface(): Surface {
  const base: WorkspaceFixture = workspaceFixture();
  const created = command(
    base.fixture,
    ['source', 'create', '--workspace', base.workspaceId, '--name', '设备台账', '--type', 'file'],
    { token: base.workspaceAdministratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  return {
    fixture: base.fixture,
    workspaceId: base.workspaceId,
    deploymentAdministratorToken: base.deploymentAdministratorToken,
    workspaceAdministratorToken: base.workspaceAdministratorToken,
    consumerToken: base.consumerToken,
    sourceId: String(created.output['source_id']),
  };
}

function stateOf(s: Surface): StateFile {
  return JSON.parse(readFileSync(join(s.fixture.root, 'state', 'platform.json'), 'utf8')) as StateFile;
}

function profileConfig(endpoint: MockModelEndpoint, adapter: string, overrides: Config = {}): Config {
  return {
    adapter,
    endpoint_url: endpoint.url,
    model_id: MOCK_MODEL_ID,
    purposes: [...PURPOSES],
    data_categories: [...DATA_CATEGORIES],
    tools: ['read_data_dictionary'],
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

async function bind(
  s: Surface,
  profile: Profile,
  purposes: readonly string[],
  dataCategories: readonly string[],
  name: string,
): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    [
      'binding', 'publish',
      '--workspace', s.workspaceId,
      '--profile', profile.modelProfileId,
      '--config', jsonFile(s.fixture, `binding-${name}`, {
        model_profile_version: profile.version,
        purposes: [...purposes],
        data_categories: [...dataCategories],
      }),
    ],
    { token: s.workspaceAdministratorToken },
  );
}

async function bindAll(s: Surface, profile: Profile, name = 'all'): Promise<string> {
  const result = await bind(s, profile, PURPOSES, DATA_CATEGORIES, name);
  assert.equal(result.status, 0, result.stderr);
  return String(result.output['binding_id']);
}

function dataDictionary(s: Surface, name = 'data-dictionary'): string {
  return jsonFile(s.fixture, name, {
    dataset_name: '设备台账',
    fields: [
      { source_column: '设备SN', name: 'sn', type: 'string', description: '设备序列号', identity: true, clean: ['trim', 'uppercase'] },
      { source_column: '城市', name: 'city', type: 'string', description: '所在城市' },
      { source_column: '处理量', name: 'handled_count', type: 'integer', description: '当日处理量' },
    ],
  });
}

async function generate(s: Surface, bindingId: string): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    ['proposal', 'generate', '--source', s.sourceId, '--binding', bindingId, '--evidence', dataDictionary(s)],
    { token: s.workspaceAdministratorToken },
  );
}

function requirementDocument(
  s: Surface,
  name: string,
  text: string,
  clarifications: Array<{ question: string; answer: string }> = [],
): string {
  return jsonFile(s.fixture, name, { requirement: text, clarifications });
}

async function generateWithRequirement(s: Surface, bindingId: string, requirementPath: string): Promise<CommandResult> {
  return commandAsync(
    s.fixture,
    [
      'proposal', 'generate', '--source', s.sourceId, '--binding', bindingId,
      '--evidence', dataDictionary(s), '--requirement', requirementPath,
    ],
    { token: s.workspaceAdministratorToken },
  );
}

/** Publishes and adopts the Integration Configuration a Proposal is generated against. */
function baseIntegration(s: Surface): BaseVersion {
  const published = command(
    s.fixture,
    ['integration', 'publish', '--source', s.sourceId, '--config', jsonFile(s.fixture, 'integration-base', BASE_CONFIGURATION)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(published.status, 0, published.stderr);
  const version = Number(published.output['integration_configuration_version']);
  const adopted = command(
    s.fixture,
    ['integration', 'adopt', '--source', s.sourceId, '--version', String(version)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(adopted.status, 0, adopted.stderr);
  return { version, contentHash: String(published.output['content_hash']) };
}

/** Uploads one real Raw Acquisition through the same path production acquisition uses. */
function upload(s: Surface, name: string, content: string): string {
  const uploaded = command(
    s.fixture,
    ['acquisition', 'upload', '--source', s.sourceId, '--file', textFile(s.fixture, `${name}.csv`, content)],
    { token: s.workspaceAdministratorToken },
  );
  assert.equal(uploaded.status, 0, uploaded.stderr);
  return String(asRecord(uploaded.output['raw_acquisition'])['raw_id']);
}

function validate(s: Surface, proposalId: string, fixtures: Config = VALIDATION_FIXTURES): CommandResult {
  return command(
    s.fixture,
    ['proposal', 'validate', '--proposal', proposalId, '--fixtures', jsonFile(s.fixture, 'fixtures', fixtures)],
    { token: s.workspaceAdministratorToken },
  );
}

function preview(s: Surface, proposalId: string, rawId: string): CommandResult {
  return command(
    s.fixture,
    ['proposal', 'preview', '--proposal', proposalId, '--raw', rawId],
    { token: s.workspaceAdministratorToken },
  );
}

function decide(s: Surface, verb: 'approve' | 'publish' | 'adopt', proposalId: string): CommandResult {
  return command(s.fixture, ['proposal', verb, '--proposal', proposalId], { token: s.workspaceAdministratorToken });
}

function showProposal(s: Surface, proposalId: string): CommandResult {
  return command(s.fixture, ['proposal', 'show', '--proposal', proposalId], { token: s.workspaceAdministratorToken });
}

/** Generates, validates, and previews one Proposal over one real Raw Acquisition. */
async function preparedProposal(s: Surface, bindingId: string): Promise<{ proposalId: string; rawId: string }> {
  baseIntegration(s);
  const rawId = upload(s, 'acquisition', RAW_CSV);
  const generated = await generate(s, bindingId);
  assert.equal(generated.status, 0, generated.stderr);
  const proposalId = String(generated.output['proposal_id']);
  const validated = validate(s, proposalId);
  assert.equal(validated.status, 0, validated.stderr);
  const previewed = preview(s, proposalId, rawId);
  assert.equal(previewed.status, 0, previewed.stderr);
  return { proposalId, rawId };
}

test('hosted and generic local adapters enforce structured output, constrained tools, pinned identity, preflight, and activation evaluation', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    for (const adapter of ['hosted', 'generic_local'] as const) {
      const current = surface();
      const profile = await activatedProfile(current, endpoint, adapter, `档案-${adapter}`);

      // Activation evidence names every gate the adapter has to clear.
      const evaluation = await evaluateProfile(current, profile);
      assert.equal(evaluation.status, 0, evaluation.stderr);
      const checks = evaluation.output['checks'] as Array<{ name: string; passed: boolean }>;
      assert.deepEqual(
        checks.filter((check) => !check.passed).map((check) => check.name),
        [],
        JSON.stringify(checks),
      );
      for (const required of [
        'preflight',
        'pinned_identity',
        'structured_output',
        'constrained_tools',
        'simplified_chinese_prompt',
        'simplified_chinese_narrative',
        'grounded_narration',
        'simplified_chinese_clarification',
      ]) {
        assert.ok(checks.some((check) => check.name === required), `${adapter} is missing the ${required} check`);
      }

      // The request carries the exact pinned Model Profile Version and its Chinese prompt.
      const pinnedCall = endpoint.calls.at(-1) as Record<string, unknown>;
      assert.deepEqual(pinnedCall['model_profile'], {
        id: profile.modelProfileId,
        version: profile.version,
        hash: profile.contentHash,
      });
      assert.equal(pinnedCall['model'], MOCK_MODEL_ID);
      assert.match(String((pinnedCall['prompt'] as Record<string, unknown>)['body']), /简体中文/u);

      // A well-formed answer becomes one Proposal.
      endpoint.behaviour = 'normal';
      const bindingId = await bindAll(current, profile);
      const generated = await generate(current, bindingId);
      assert.equal(generated.status, 0, generated.stderr);
      assert.equal(generated.output['status'], 'pending');

      // Malformed structured output is refused, never repaired.
      endpoint.behaviour = 'malformed_structured_output';
      const malformed = await generate(current, bindingId);
      assert.equal(malformed.status, 2, malformed.stdout);
      assert.equal(malformed.error['code'], 'MODEL_STRUCTURED_OUTPUT_INVALID');

      // An undeclared tool call is refused, so only declared tools exist.
      endpoint.behaviour = 'undeclared_tool';
      const tool = await generate(current, bindingId);
      assert.equal(tool.status, 2, tool.stdout);
      assert.equal(tool.error['code'], 'MODEL_TOOL_NOT_PERMITTED');

      // A reply from a different model identity cannot pass as the pinned one.
      endpoint.behaviour = 'identity_mismatch';
      const identity = await generate(current, bindingId);
      assert.equal(identity.status, 2, identity.stdout);
      assert.equal(identity.error['code'], 'MODEL_IDENTITY_MISMATCH');

      endpoint.behaviour = 'normal';
    }
  } finally {
    await endpoint.close();
  }
});

test('Workspace Bindings limit permitted purposes and data categories without exposing provider credentials or settings', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();

    // A narrow profile: one purpose, one data category.
    const narrow = await activatedProfile(current, endpoint, 'generic_local', '受限档案', {
      purposes: ['clarification'],
      data_categories: ['dataset_schema'],
      tools: [],
      prompts: { clarification: PROMPTS.clarification },
    });
    const outsidePurpose = await bind(current, narrow, ['grounded_narration'], ['dataset_schema'], 'outside-purpose');
    assert.equal(outsidePurpose.status, 2, outsidePurpose.stdout);
    assert.equal(outsidePurpose.error['code'], 'MODEL_BINDING_PURPOSE_NOT_PERMITTED');
    const outsideCategory = await bind(current, narrow, ['clarification'], ['dataset_schema', 'sample_records'], 'outside-category');
    assert.equal(outsideCategory.status, 2, outsideCategory.stdout);
    assert.equal(outsideCategory.error['code'], 'MODEL_BINDING_DATA_CATEGORY_NOT_PERMITTED');
    const noCategories = await bind(current, narrow, ['clarification'], [], 'no-categories');
    assert.equal(noCategories.status, 2, noCategories.stdout);
    assert.equal(noCategories.error['code'], 'MODEL_PROFILE_CONFIGURATION_INVALID');
    const allowed = await bind(current, narrow, ['clarification'], ['dataset_schema'], 'allowed');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(allowed.output['purposes'], ['clarification']);
    assert.deepEqual(allowed.output['data_categories'], ['dataset_schema']);

    // A Binding narrows the Profile it references; it never widens it.
    const full = await activatedProfile(current, endpoint, 'hosted', '完整档案');
    const narrowed = await bind(current, full, ['integration_proposal'], ['dataset_schema', 'cleaning_rules', 'source_mapping'], 'narrowed');
    assert.equal(narrowed.status, 0, narrowed.stderr);
    assert.deepEqual(narrowed.output['purposes'], ['integration_proposal']);
    assert.deepEqual(narrowed.output['data_categories'], ['dataset_schema', 'cleaning_rules', 'source_mapping']);

    const bindingId = String(narrowed.output['binding_id']);
    const read = command(current.fixture, ['binding', 'show', '--binding', bindingId], {
      token: current.workspaceAdministratorToken,
    });
    assert.equal(read.status, 0, read.stderr);
    assert.deepEqual(Object.keys(read.output).sort(), [
      'binding_id',
      'created_at',
      'created_by',
      'data_categories',
      'model_profile_content_hash',
      'model_profile_id',
      'model_profile_version',
      'preflight',
      'purposes',
      'revoked_at',
      'workspace_id',
    ]);
    // Resolving a Binding never discloses where the model runs or as whom.
    assert.ok(!JSON.stringify(read.output).includes(endpoint.url), 'the Binding read leaked the endpoint URL');
    const stored = stateOf(current).model_bindings.find((binding) => binding['binding_id'] === bindingId);
    assert.ok(stored !== undefined);
    assert.deepEqual(
      Object.keys(stored).filter((key) => ['credential', 'credential_ref', 'endpoint_url', 'model_id'].includes(key)),
      [],
    );
    assert.ok(!JSON.stringify(stored).includes(endpoint.url), 'the Binding record stored the endpoint URL');

    // A Consumer cannot resolve the Binding at all.
    const asConsumer = command(current.fixture, ['binding', 'show', '--binding', bindingId], {
      token: current.consumerToken,
    });
    assert.equal(asConsumer.status, 2, asConsumer.stdout);
    assert.equal(asConsumer.error['code'], 'WORKSPACE_ACCESS_DENIED');

    // A Binding that does not permit Proposal generation cannot generate one.
    const clarificationBindingId = String(allowed.output['binding_id']);
    const notBound = await generate(current, clarificationBindingId);
    assert.equal(notBound.status, 2, notBound.stdout);
    assert.equal(notBound.error['code'], 'PROPOSAL_PURPOSE_NOT_BOUND');
  } finally {
    await endpoint.close();
  }
});

test('the Proposal holds immutable digest-addressed schema, cleaning, mapping, and Integration Configuration candidates', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '提案档案');
    const bindingId = await bindAll(current, profile);
    const baseline = baseIntegration(current);

    const first = await generate(current, bindingId);
    assert.equal(first.status, 0, first.stderr);
    const proposalId = String(first.output['proposal_id']);
    const candidates = asRecord(first.output['candidates']);
    const schema = asRecord(candidates['schema']);
    const cleaning = asRecord(candidates['cleaning']);
    const mapping = asRecord(candidates['mapping']);
    const integration = asRecord(candidates['integration_configuration']);

    assert.deepEqual((schema['fields'] as Config[]).map((field) => [field['name'], field['type']]), [
      ['sn', 'string'],
      ['city', 'string'],
      ['handled_count', 'integer'],
    ]);
    assert.deepEqual((cleaning['rules'] as Config[]).map((rule) => `${rule['rule']}:${rule['field']}`), [
      'trim:sn',
      'uppercase:sn',
    ]);
    assert.deepEqual(mapping['mapping'], { 设备SN: 'sn', 城市: 'city', 处理量: 'handled_count' });

    // Every component is a digest-addressed Artifact Version of the same composite.
    assert.equal(schema['candidate_version'], baseline.version + 1);
    assert.equal(cleaning['candidate_version'], baseline.version + 1);
    assert.equal(mapping['candidate_version'], baseline.version + 1);
    assert.equal(integration['version'], baseline.version + 1);
    assert.equal(integration['schema_hash'], schema['hash']);
    assert.equal(integration['cleaning_hash'], cleaning['hash']);
    assert.equal(integration['mapping_hash'], mapping['hash']);
    for (const hash of [schema['hash'], cleaning['hash'], mapping['hash'], integration['content_hash']]) {
      assert.match(String(hash), /^[0-9a-f]{64}$/u);
    }
    assert.equal(first.output['base'] !== undefined, true);
    assert.deepEqual(asRecord(first.output['base']), {
      integration_configuration_version: baseline.version,
      integration_configuration_content_hash: baseline.contentHash,
    });

    // The same evidence and base produce the same content address.
    const second = await generate(current, bindingId);
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(second.output['proposal_id'], proposalId);
    assert.equal(second.output['proposal_hash'], first.output['proposal_hash']);
    assert.deepEqual(second.output['candidates'], first.output['candidates']);

    // Editing any candidate breaks the content address and the record is refused.
    const statePath = join(current.fixture.root, 'state', 'platform.json');
    const state = stateOf(current);
    const stored = state.artifact_proposals.find((proposal) => proposal['proposal_id'] === proposalId);
    assert.ok(stored !== undefined);
    const storedMapping = asRecord(asRecord(stored['candidates'])['mapping']);
    asRecord(storedMapping['mapping'])['设备SN'] = 'city';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const tampered = showProposal(current, proposalId);
    assert.equal(tampered.status, 2, tampered.stdout);
    assert.equal(tampered.error['code'], 'PROPOSAL_TAMPERED');
  } finally {
    await endpoint.close();
  }
});

test('validation fixtures and a preview of a real Raw Acquisition expose transformations, rejections, and drift without production writes', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'generic_local', '预览档案');
    const bindingId = await bindAll(current, profile);
    const baseline = baseIntegration(current);
    const rawId = upload(current, 'acquisition', RAW_CSV);
    const generated = await generate(current, bindingId);
    assert.equal(generated.status, 0, generated.stderr);
    const proposalId = String(generated.output['proposal_id']);
    const before = stateOf(current);

    // Validation fixtures show a transformed value and a rejected record.
    const validated = validate(current, proposalId);
    assert.equal(validated.status, 0, validated.stderr);
    const fixture = asArray(validated.output['fixtures'])[0] as Config;
    assert.equal(fixture['record_count'], 1);
    assert.equal(fixture['transformed'], 3, JSON.stringify(fixture['transformations']));
    assert.equal(fixture['rejected'], 1, JSON.stringify(fixture['rejections']));
    assert.deepEqual(
      (fixture['transformations'] as Config[]).map((item) => `${item['row']}:${item['field']}:${item['rule']}:${item['before']}->${item['after']}`),
      [
        '1:sn:trim: dev-1 ->dev-1',
        '1:sn:uppercase:dev-1->DEV-1',
        '2:sn:uppercase:dev-2->DEV-2',
      ],
    );
    const rejection = asRecord(asArray(fixture['rejections'])[0]);
    assert.equal(rejection['row'], 2);
    assert.equal(rejection['field'], 'handled_count');
    assert.equal(rejection['rule'], 'type');
    assert.equal(rejection['reason'], 'NOT_INTEGER');
    const fixtureDrift = asRecord(fixture['drift']);
    assert.equal(fixtureDrift['base_present'], true);
    assert.deepEqual(asRecord(fixtureDrift['raw_columns']), { unmapped: ['备注'], missing: [] });
    assert.deepEqual(asRecord(fixtureDrift['cleaning'])['added'], ['trim:sn:', 'uppercase:sn:']);

    // The preview runs the same candidate over the real Raw Acquisition.
    const previewed = preview(current, proposalId, rawId);
    assert.equal(previewed.status, 0, previewed.stderr);
    const previewRecord = asRecord(previewed.output['preview']);
    assert.equal(previewRecord['raw_id'], rawId);
    assert.equal(previewRecord['record_count'], 1);
    assert.equal(previewRecord['transformed'], 3);
    assert.equal(previewRecord['rejected'], 1);
    // A CSV upload numbers the header as row 1, so its data rows are 2 and 3.
    assert.deepEqual(
      (previewRecord['transformations'] as Config[]).map((item) => `${item['row']}:${item['field']}:${item['rule']}`),
      ['2:sn:trim', '2:sn:uppercase', '3:sn:uppercase'],
    );
    assert.deepEqual(asRecord(previewRecord['drift'])['raw_columns'], { unmapped: ['备注'], missing: [] });
    assert.equal(previewed.output['status'], 'pending');

    // Nothing production-visible moved: no Dataset, Release, or Integration Version.
    const after = stateOf(current);
    assert.deepEqual(after.datasets, before.datasets);
    assert.deepEqual(after.raw_acquisitions, before.raw_acquisitions);
    assert.equal(after.integration_configurations[0]?.versions.length, before.integration_configurations[0]?.versions.length);
    assert.equal(after.integration_configurations[0]?.adopted_version, baseline.version);
  } finally {
    await endpoint.close();
  }
});

test('rejection, a stale base, audit failure, and generation failure leave published behaviour unchanged', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    // Generation failure: the endpoint answers malformed structured output.
    const failing = surface();
    const failingProfile = await activatedProfile(failing, endpoint, 'hosted', '失败档案');
    const failingBinding = await bindAll(failing, failingProfile);
    const failingBase = baseIntegration(failing);
    const rawId = upload(failing, 'acquisition', RAW_CSV);
    const generated = await generate(failing, failingBinding);
    assert.equal(generated.status, 0, generated.stderr);
    const failingProposalId = String(generated.output['proposal_id']);
    assert.equal(validate(failing, failingProposalId).status, 0);
    assert.equal(preview(failing, failingProposalId, rawId).status, 0);
    const beforeFailure = stateOf(failing);
    endpoint.behaviour = 'malformed_structured_output';
    const failed = await generate(failing, failingBinding);
    assert.equal(failed.status, 2, failed.stdout);
    assert.equal(failed.error['code'], 'MODEL_STRUCTURED_OUTPUT_INVALID');
    endpoint.behaviour = 'normal';
    const afterFailure = stateOf(failing);
    assert.equal(afterFailure.artifact_proposals.length, beforeFailure.artifact_proposals.length);
    assert.equal(afterFailure.integration_configurations[0]?.versions.length, 1);
    assert.equal(afterFailure.integration_configurations[0]?.adopted_version, failingBase.version);

    // Rejection is a decision: the Proposal can never be approved afterwards.
    const rejected = command(
      failing.fixture,
      ['proposal', 'reject', '--proposal', failingProposalId, '--reason', '候选映射与业务口径不符'],
      { token: failing.workspaceAdministratorToken },
    );
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(rejected.output['status'], 'rejected');
    const approveRejected = decide(failing, 'approve', failingProposalId);
    assert.equal(approveRejected.status, 2, approveRejected.stdout);
    assert.equal(approveRejected.error['code'], 'PROPOSAL_ALREADY_DECIDED');
    const afterRejection = stateOf(failing);
    assert.equal(afterRejection.integration_configurations[0]?.versions.length, 1);
    assert.equal(afterRejection.integration_configurations[0]?.adopted_version, failingBase.version);

    // A stale base: the Source gained a newer Integration Configuration Version.
    const stale = surface();
    const staleProfile = await activatedProfile(stale, endpoint, 'generic_local', '过期档案');
    const staleBinding = await bindAll(stale, staleProfile);
    const staleBase = baseIntegration(stale);
    const staleRaw = upload(stale, 'acquisition', RAW_CSV);
    const staleGenerated = await generate(stale, staleBinding);
    assert.equal(staleGenerated.status, 0, staleGenerated.stderr);
    const staleProposalId = String(staleGenerated.output['proposal_id']);
    assert.equal(validate(stale, staleProposalId).status, 0);
    assert.equal(preview(stale, staleProposalId, staleRaw).status, 0);
    const moved = command(
      stale.fixture,
      ['integration', 'publish', '--source', stale.sourceId, '--config', jsonFile(stale.fixture, 'integration-moved', BASE_CONFIGURATION)],
      { token: stale.workspaceAdministratorToken },
    );
    assert.equal(moved.status, 0, moved.stderr);
    const approveStale = decide(stale, 'approve', staleProposalId);
    assert.equal(approveStale.status, 2, approveStale.stdout);
    assert.equal(approveStale.error['code'], 'PROPOSAL_BASE_STALE');
    const adoptStale = decide(stale, 'adopt', staleProposalId);
    assert.equal(adoptStale.status, 2, adoptStale.stdout);
    assert.equal(adoptStale.error['code'], 'PROPOSAL_NOT_PUBLISHED');
    const afterStale = stateOf(stale);
    assert.equal(afterStale.integration_configurations[0]?.versions.length, 2);
    assert.equal(afterStale.integration_configurations[0]?.adopted_version, staleBase.version);

    // Audit failure aborts the whole operation, so nothing is written.
    const audited = surface();
    const auditedProfile = await activatedProfile(audited, endpoint, 'hosted', '审计档案');
    const auditedBinding = await bindAll(audited, auditedProfile);
    const auditedBase = baseIntegration(audited);
    const auditedRaw = upload(audited, 'acquisition', RAW_CSV);
    const auditedGenerated = await generate(audited, auditedBinding);
    assert.equal(auditedGenerated.status, 0, auditedGenerated.stderr);
    const auditedProposalId = String(auditedGenerated.output['proposal_id']);
    assert.equal(validate(audited, auditedProposalId).status, 0);
    assert.equal(preview(audited, auditedProposalId, auditedRaw).status, 0);
    const auditPath = join(audited.fixture.root, 'audit', 'events.jsonl');
    const statePath = join(audited.fixture.root, 'state', 'platform.json');
    const stateBefore = readFileSync(statePath, 'utf8');
    appendFileSync(auditPath, `${JSON.stringify({ sequence: 999_999, event_id: 'forged' })}\n`);
    const approveUnaudited = decide(audited, 'approve', auditedProposalId);
    assert.equal(approveUnaudited.status, 2, approveUnaudited.stdout);
    assert.equal(approveUnaudited.error['code'], 'AUDIT_INTEGRITY_FAILED');
    assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
    // With the forged line removed the Proposal is still undecided and adoptable evidence is intact.
    const lines = readFileSync(auditPath, 'utf8').split('\n').filter((line) => line.length > 0);
    writeFileSync(auditPath, `${lines.slice(0, -1).join('\n')}\n`);
    const restored = showProposal(audited, auditedProposalId);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(restored.output['status'], 'pending');
    assert.equal(asArray(restored.output['decisions']).length, 0);
    assert.equal(stateOf(audited).integration_configurations[0]?.adopted_version, auditedBase.version);
  } finally {
    await endpoint.close();
  }
});

test('Approval, Publication, and Adoption record the full model, prompt, evidence, actor, and Artifact Provenance', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '追溯档案');
    const bindingId = await bindAll(current, profile);
    const baseline = baseIntegration(current);
    const rawId = upload(current, 'acquisition', RAW_CSV);
    const generated = await generate(current, bindingId);
    assert.equal(generated.status, 0, generated.stderr);
    const proposalId = String(generated.output['proposal_id']);
    const validated = validate(current, proposalId);
    assert.equal(validated.status, 0, validated.stderr);
    const previewed = preview(current, proposalId, rawId);
    assert.equal(previewed.status, 0, previewed.stderr);
    const previewHash = String(asRecord(previewed.output['preview'])['evidence_hash']);

    // Approval restates the complete lineage; the human is a Workspace Administrator.
    const approved = decide(current, 'approve', proposalId);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(approved.output['status'], 'approved');
    const provenance = asRecord(approved.output['provenance']);
    assert.deepEqual(Object.keys(provenance).sort(), [...PROVENANCE_KEYS].sort());
    for (const key of PROVENANCE_KEYS) {
      assert.notEqual(provenance[key], '', `the provenance left ${key} empty`);
    }
    const model = asRecord(generated.output['model']);
    assert.equal(provenance['model_profile_id'], model['model_profile_id']);
    assert.equal(provenance['model_profile_version'], model['model_profile_version']);
    assert.equal(provenance['model_profile_content_hash'], model['model_profile_content_hash']);
    assert.equal(provenance['adapter'], 'hosted');
    assert.equal(provenance['model_id'], MOCK_MODEL_ID);
    assert.equal(provenance['binding_id'], bindingId);
    assert.equal(provenance['prompt_id'], 'integration_proposal');
    assert.equal(provenance['prompt_hash'], model['prompt_hash']);
    assert.equal(provenance['validation_hash'], validated.output['evidence_hash']);
    assert.equal(provenance['preview_hash'], previewHash);
    assert.equal(provenance['candidate_content_hash'], asRecord(asRecord(generated.output['candidates'])['integration_configuration'])['content_hash']);
    assert.equal(provenance['proposal_hash'], generated.output['proposal_hash']);

    // Publication appends the exact approved candidate as the next Integration Version.
    const published = decide(current, 'publish', proposalId);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.output['status'], 'published');
    assert.equal(published.output['integration_configuration_version'], baseline.version + 1);
    assert.equal(published.output['content_hash'], provenance['candidate_content_hash']);

    // Adoption binds the Source to exactly that Version.
    const adopted = decide(current, 'adopt', proposalId);
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.equal(adopted.output['status'], 'adopted');
    assert.equal(adopted.output['adopted_version'], baseline.version + 1);
    assert.equal(adopted.output['previous_adopted_version'], baseline.version);

    // Every lifecycle record carries the same provenance and the same actor.
    const shown = showProposal(current, proposalId);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.output['created_by'], 'operations@example.invalid');
    const decision = asRecord(asArray(shown.output['decisions'])[0]);
    const publication = asRecord(asArray(shown.output['publications'])[0]);
    const adoption = asRecord(asArray(shown.output['adoptions'])[0]);
    assert.deepEqual(decision['provenance'], provenance);
    assert.deepEqual(publication['provenance'], provenance);
    assert.deepEqual(adoption['provenance'], provenance);
    assert.equal(decision['reason'], null);
    for (const actor of [decision['decided_by'], publication['published_by'], adoption['adopted_by']]) {
      assert.equal(typeof actor, 'string');
      assert.ok(String(actor).length > 0);
    }

    // The audit trail names the actor, target, outcome, and correlation of every step.
    const audit = command(current.fixture, ['audit', 'list', '--workspace', current.workspaceId], {
      token: current.deploymentAdministratorToken,
    });
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(audit.output['chain_valid'], true);
    const events = asArray(audit.output['events']) as Config[];
    for (const action of [
      'proposal_generation',
      'proposal_validation',
      'proposal_preview',
      'proposal_approval',
      'proposal_publication',
      'proposal_adoption',
    ]) {
      const matches = events.filter((event) => event['action'] === action);
      assert.ok(matches.length > 0, `no audit event for ${action}`);
      for (const event of matches) {
        assert.equal(event['actor'], 'operations@example.invalid');
        assert.equal(event['outcome'], 'succeeded');
        assert.equal(event['workspace_id'], current.workspaceId);
        assert.match(String(event['correlation_id']), /^[0-9a-f-]{36}$/u);
        assert.ok(String(event['target']).startsWith(proposalId));
      }
    }
  } finally {
    await endpoint.close();
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

  const cjk = (value: string): number => (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? []).length;
  const namespaces = ['model.', 'binding.', 'proposal.', 'clarification.'];
  const introduced = entries.filter((entry) => namespaces.some((namespace) => entry.key.startsWith(namespace)));
  assert.ok(introduced.length >= 60, `too few introduced strings: ${introduced.length}`);

  // No introduced string is English-only, and every one is written in Chinese.
  for (const entry of introduced) {
    assert.ok(cjk(entry.value) >= 2, `${entry.key} is not Simplified Chinese: ${entry.value}`);
    assert.ok(!/^[\x20-\x7E]*$/u.test(entry.value), `${entry.key} is English-only: ${entry.value}`);
  }

  // Labels, forms, validation and error copy, clarification, empty/no-evidence, provenance and freshness.
  for (const key of [
    'model.profile.title',
    'binding.title',
    'proposal.title',
    'model.profile.endpoint',
    'model.profile.purposes',
    'model.profile.dataCategories',
    'binding.purposes',
    'binding.dataCategories',
    'proposal.reject.reason',
    'model.profile.prompt.simplifiedChineseRequired',
    'model.profile.evaluation.required',
    'model.profile.evaluation.failed',
    'binding.preflight.failed',
    'proposal.validation.required',
    'proposal.preview.required',
    'proposal.freshness.stale',
    'clarification.question',
    'proposal.clarification.title',
    'model.profile.empty',
    'binding.empty',
    'proposal.empty',
    'proposal.noEvidence',
    'proposal.evidence.missing',
    'proposal.provenance.title',
    'proposal.provenance.model',
    'proposal.provenance.prompt',
    'proposal.provenance.evidence',
    'proposal.provenance.actor',
    'proposal.freshness.fresh',
    'proposal.status.pending',
    'proposal.status.approved',
    'proposal.status.rejected',
    'proposal.status.published',
    'proposal.status.adopted',
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
  const errorCode = entries.find((entry) => entry.key === 'error.code');
  assert.ok(errorCode !== undefined);
  assert.equal(errorCode.value, '错误代码');
});

test('activation and Binding preflight require grounded Simplified Chinese narration and clarification', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();

    // A prompt that does not pin Simplified Chinese is refused at publication.
    const unpinned = command(
      current.fixture,
      [
        'model', 'publish', '--name', '未固定语言档案',
        '--config', jsonFile(current.fixture, 'profile-unpinned', profileConfig(endpoint, 'hosted', {
          prompts: { ...PROMPTS, grounded_narration: 'Summarise the governed result.' },
        })),
      ],
      { token: current.deploymentAdministratorToken },
    );
    assert.equal(unpinned.status, 2, unpinned.stdout);
    assert.equal(unpinned.error['code'], 'MODEL_PROMPT_NOT_SIMPLIFIED_CHINESE');
    assert.equal(stateOf(current).model_profiles.length, 0);

    // An endpoint that answers English narration fails activation instead of degrading.
    const english = publishProfile(current, endpoint, 'generic_local', '英文档案');
    endpoint.behaviour = 'english_narration';
    const evaluated = await evaluateProfile(current, english);
    assert.equal(evaluated.status, 0, evaluated.stderr);
    assert.equal(evaluated.output['passed'], false);
    const failedChecks = (evaluated.output['checks'] as Array<{ name: string; passed: boolean; detail: string | null }>)
      .filter((check) => !check.passed);
    assert.deepEqual(failedChecks.map((check) => check.name).sort(), [
      'simplified_chinese_clarification',
      'simplified_chinese_narrative',
    ]);
    for (const check of failedChecks) {
      assert.match(String(check.detail), /NOT_SIMPLIFIED_CHINESE$/u);
    }
    const refused = await activateProfile(current, english);
    assert.equal(refused.status, 2, refused.stdout);
    assert.equal(refused.error['code'], 'MODEL_PROFILE_EVALUATION_FAILED');
    const afterRefusal = command(current.fixture, ['model', 'show', '--profile', english.modelProfileId], {
      token: current.deploymentAdministratorToken,
    });
    assert.equal(afterRefusal.output['activated_version'], null);

    // Ungrounded narration also fails: Chinese alone is not enough.
    endpoint.behaviour = 'ungrounded_narration';
    const ungrounded = await evaluateProfile(current, english);
    assert.equal(ungrounded.status, 0, ungrounded.stderr);
    assert.equal(ungrounded.output['passed'], false);
    const ungroundedCheck = (ungrounded.output['checks'] as Array<{ name: string; passed: boolean; detail: string | null }>)
      .find((check) => check.name === 'grounded_narration');
    assert.ok(ungroundedCheck !== undefined);
    assert.equal(ungroundedCheck.passed, false);
    assert.equal(ungroundedCheck.detail, 'EVIDENCE_REF_NOT_GOVERNED');
    const refusedAgain = await activateProfile(current, english);
    assert.equal(refusedAgain.status, 2, refusedAgain.stdout);
    assert.equal(refusedAgain.error['code'], 'MODEL_PROFILE_EVALUATION_FAILED');

    // Grounded Simplified Chinese passes, and the Version activates.
    endpoint.behaviour = 'normal';
    const passed = await evaluateProfile(current, english);
    assert.equal(passed.output['passed'], true, JSON.stringify(passed.output['checks']));
    const activated = await activateProfile(current, english);
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(activated.output['activated_version'], english.version);

    // Activation evidence is not a licence to drift: the Binding preflight re-checks Chinese.
    endpoint.behaviour = 'english_narration';
    const drifted = await bind(current, english, PURPOSES, DATA_CATEGORIES, 'drifted');
    assert.equal(drifted.status, 2, drifted.stdout);
    assert.equal(drifted.error['code'], 'MODEL_BINDING_PREFLIGHT_FAILED');
    assert.match(String(drifted.error['message']), /simplified_chinese_narrative/u);
    assert.match(String(drifted.error['message']), /simplified_chinese_clarification/u);
    endpoint.behaviour = 'normal';
    const bound = await bind(current, english, PURPOSES, DATA_CATEGORIES, 'grounded');
    assert.equal(bound.status, 0, bound.stderr);
    assert.deepEqual(
      (asRecord(bound.output['preflight'])['checks'] as Config[])
        .filter((check) => check['passed'] !== true)
        .map((check) => check['name']),
      [],
    );
  } finally {
    await endpoint.close();
  }
});

test('a Chinese requirement and its clarifications become immutable Proposal content and Provenance', async () => {
  const endpoint = await startMockModelEndpoint();
  try {
    const current = surface();
    const profile = await activatedProfile(current, endpoint, 'hosted', '需求档案');
    const bindingId = await bindAll(current, profile);
    const baseline = baseIntegration(current);
    const rawId = upload(current, 'acquisition', RAW_CSV);

    // A requirement too broad to name governed data is refused with one Chinese
    // clarification, and the refusal creates no Proposal at all.
    const broad = await generateWithRequirement(
      current,
      bindingId,
      requirementDocument(current, 'requirement-broad', '请帮我整理一下这份数据。'),
    );
    assert.equal(broad.status, 2, broad.stdout);
    assert.equal(broad.error['code'], 'PROPOSAL_CLARIFICATION_REQUIRED');
    assert.match(String(broad.error['message']), /^请确认/u);
    assert.equal(stateOf(current).artifact_proposals.length, 0);

    // A malformed requirement is refused before any model call.
    const empty = await generateWithRequirement(
      current,
      bindingId,
      jsonFile(current.fixture, 'requirement-empty', { requirement: '   ', clarifications: [] }),
    );
    assert.equal(empty.status, 2, empty.stdout);
    assert.equal(empty.error['code'], 'PROPOSAL_REQUIREMENT_INVALID');

    // The recorded Chinese answer lets generation proceed, and the requirement,
    // its clarifications, and their content address are immutable Proposal content.
    const clarifications = [{ question: '请确认要映射哪些源列，以及数据集覆盖的业务范围？', answer: '映射设备SN、城市与处理量三列。' }];
    const clarified = await generateWithRequirement(
      current,
      bindingId,
      requirementDocument(current, 'requirement-clarified', '请帮我整理一下这份数据。', clarifications),
    );
    assert.equal(clarified.status, 0, clarified.stderr);
    const requirement = asRecord(clarified.output['requirement']);
    assert.equal(requirement['text'], '请帮我整理一下这份数据。');
    assert.deepEqual(requirement['clarifications'], clarifications);
    assert.match(String(requirement['hash']), /^[0-9a-f]{64}$/u);

    // Identical requirement content keeps the content address; a changed answer moves it.
    const repeated = await generateWithRequirement(
      current,
      bindingId,
      requirementDocument(current, 'requirement-clarified', '请帮我整理一下这份数据。', clarifications),
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.output['proposal_hash'], clarified.output['proposal_hash']);
    const changed = await generateWithRequirement(
      current,
      bindingId,
      requirementDocument(current, 'requirement-changed', '请帮我整理一下这份数据。', [
        { ...clarifications[0]!, answer: '只映射设备SN一列。' },
      ]),
    );
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(changed.output['proposal_hash'], clarified.output['proposal_hash']);

    // Approval restates the requirement hash beside the model, prompt, and evidence.
    const proposalId = String(clarified.output['proposal_id']);
    assert.equal(validate(current, proposalId).status, 0);
    assert.equal(preview(current, proposalId, rawId).status, 0);
    const approved = decide(current, 'approve', proposalId);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(asRecord(approved.output['provenance'])['requirement_hash'], requirement['hash']);

    // Editing the recorded requirement breaks the content address.
    const statePath = join(current.fixture.root, 'state', 'platform.json');
    const state = stateOf(current);
    const stored = state.artifact_proposals.find((proposal) => proposal['proposal_id'] === proposalId);
    assert.ok(stored !== undefined);
    asRecord(stored['requirement'])['text'] = '另一个需求';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const tampered = showProposal(current, proposalId);
    assert.equal(tampered.status, 2, tampered.stdout);
    assert.equal(tampered.error['code'], 'PROPOSAL_TAMPERED');
    assert.equal(stateOf(current).integration_configurations[0]?.adopted_version, baseline.version);
  } finally {
    await endpoint.close();
  }
});
