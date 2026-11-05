import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { callApi, startConsole } from '../support/console.js';
import { MOCK_MODEL_ID, startMockModelEndpoint, type MockModelEndpoint } from '../support/model-endpoint.js';
import {
  command,
  createUser,
  grantRole,
  initializePlatform,
  registerTotp,
  sessionFor,
  type PlatformFixture,
} from '../support/platform.js';
import { totpCode } from '../support/totp.js';

const PURPOSES = ['integration_proposal', 'grounded_narration', 'clarification'];
const DATA_CATEGORIES = ['dataset_schema', 'cleaning_rules', 'source_mapping', 'sample_records'];

const PROMPTS: Record<string, string> = {
  integration_proposal: '你是数据集成助手，只输出简体中文说明，并按结构化输出返回候选 Integration Configuration。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';

interface Credentials {
  username: string;
  password: string;
  totp?: string;
}

interface World {
  fixture: PlatformFixture;
  workspaceId: string;
  deploymentAdministratorToken: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  deploymentAdministrator: Credentials;
  workspaceAdministrator: Credentials;
  consumer: Credentials;
}

/** One Deployment with a Deployment Administrator, a Workspace Administrator, and a Consumer. */
function world(): World {
  const fixture = initializePlatform();
  const deploymentAdministratorToken = sessionFor(
    fixture,
    fixture.administrator.username,
    fixture.administrator.password,
  );
  createUser(fixture, deploymentAdministratorToken, OPERATIONS, OPERATIONS_PASSWORD);
  const createdWorkspace = command(
    fixture,
    ['workspace', 'create', '--name', 'Operations', '--administrator', OPERATIONS],
    { token: deploymentAdministratorToken },
  );
  assert.equal(createdWorkspace.status, 0, createdWorkspace.stderr);
  const workspaceId = String(createdWorkspace.output['workspace_id']);
  const workspaceAdministratorTotp = String(createdWorkspace.output['totp_secret']);
  registerTotp(fixture, OPERATIONS, workspaceAdministratorTotp);
  const workspaceAdministratorToken = sessionFor(fixture, OPERATIONS, OPERATIONS_PASSWORD);
  createUser(fixture, deploymentAdministratorToken, ANALYST, ANALYST_PASSWORD);
  grantRole(fixture, workspaceAdministratorToken, workspaceId, ANALYST, 'Consumer');
  const consumerToken = sessionFor(fixture, ANALYST, ANALYST_PASSWORD);
  return {
    fixture,
    workspaceId,
    deploymentAdministratorToken,
    workspaceAdministratorToken,
    consumerToken,
    deploymentAdministrator: {
      username: fixture.administrator.username,
      password: fixture.administrator.password,
      totp: fixture.administrator.totp_secret,
    },
    workspaceAdministrator: {
      username: OPERATIONS,
      password: OPERATIONS_PASSWORD,
      totp: workspaceAdministratorTotp,
    },
    consumer: { username: ANALYST, password: ANALYST_PASSWORD },
  };
}

function userCookie(token: string): string {
  return `dc_user_session=${token}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value as unknown[];
}

function checksOf(body: Record<string, unknown>): Map<string, Record<string, unknown>> {
  return new Map(
    asArray(body['checks']).map((check) => {
      const record = asRecord(check);
      return [String(record['name']), record];
    }),
  );
}

function profileInput(
  endpoint: MockModelEndpoint,
  adapter: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    adapter,
    endpoint_url: endpoint.url,
    model_id: MOCK_MODEL_ID,
    purposes: [...PURPOSES],
    data_categories: [...DATA_CATEGORIES],
    tools: ['read_data_dictionary', 'read_governed_result'],
    max_output_bytes: 65_536,
    prompts: { ...PROMPTS },
    ...overrides,
  };
}

function bindingInput(
  modelProfileId: string,
  modelProfileVersion: number,
  purposes: string[],
  dataCategories: string[],
): Record<string, unknown> {
  return {
    model_profile_id: modelProfileId,
    model_profile_version: modelProfileVersion,
    purposes,
    data_categories: dataCategories,
  };
}

async function publishProfile(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  return callApi(url, '/api/deployment/model-profiles', {
    method: 'POST',
    cookie: userCookie(token),
    body,
  });
}

async function evaluateProfile(
  url: string,
  token: string,
  modelProfileId: string,
  version: number,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  return callApi(url, `/api/deployment/model-profiles/${modelProfileId}/evaluate`, {
    method: 'POST',
    cookie: userCookie(token),
    body: { model_profile_version: version },
  });
}

async function activateProfile(
  url: string,
  token: string,
  modelProfileId: string,
  version: number,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  return callApi(url, `/api/deployment/model-profiles/${modelProfileId}/activate`, {
    method: 'POST',
    cookie: userCookie(token),
    body: { model_profile_version: version },
  });
}

async function publishBinding(
  url: string,
  token: string,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  return callApi(url, `/api/workspace/model-bindings?workspace_id=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    cookie: userCookie(token),
    body,
  });
}

async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  if (credentials.totp !== undefined) {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(credentials.totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出登录' }).click();
  await page.getByRole('heading', { name: '登录数据中心' }).waitFor();
}

/** Acceptance criterion 1: pinned configuration, credential never readable. */
test('Model Profiles pin adapter, endpoint, model identity, credential reference, purpose presets, and generation configuration without exposing provider credentials', async () => {
  const current = world();
  const endpoint = await startMockModelEndpoint();
  const otherEndpoint = await startMockModelEndpoint();
  const consoleServer = await startConsole(current.fixture);
  try {
    const credential = 't67-provider-credential-9f3c2a';
    const input = profileInput(endpoint, 'hosted', 'Pinned Model', { credential });
    const published = await publishProfile(consoleServer.url, current.deploymentAdministratorToken, input);
    assert.equal(published.status, 201, published.text);
    assert.equal(published.text.includes(credential), false, published.text);

    const body = published.body;
    assert.equal(body['name'], 'Pinned Model');
    assert.equal(body['adapter'], 'hosted');
    assert.equal(body['model_id'], MOCK_MODEL_ID);
    assert.deepEqual(body['purposes'], PURPOSES);
    assert.deepEqual(body['data_categories'], DATA_CATEGORIES);
    assert.deepEqual(body['tools'], ['read_data_dictionary', 'read_governed_result']);
    assert.equal(body['max_output_bytes'], 65_536);
    const prompts = asArray(body['prompts']).map((prompt) => asRecord(prompt));
assert.deepEqual(prompts.map((prompt) => prompt['id']), PURPOSES);
assert.deepEqual(prompts.map((prompt) => prompt['body']), PURPOSES.map((purpose) => PROMPTS[purpose]));
for (const prompt of prompts) assert.match(String(prompt['hash']), /^[0-9a-f]{64}$/u);
    assert.match(String(body['credential_ref']), /^bearer:[0-9a-f]{16}$/u);
    assert.equal(String(body['credential_ref']).includes(credential), false, String(body['credential_ref']));
    assert.equal(body['has_credential'], true);
    assert.match(String(body['content_hash']), /^[0-9a-f]{64}$/u);

    // The endpoint is pinned into the Version content: another endpoint is another hash.
    const second = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(otherEndpoint, 'hosted', 'Pinned Model', { credential }),
    );
    assert.equal(second.status, 201, second.text);
    assert.equal(second.body['model_profile_version'], 2);
    assert.notEqual(second.body['content_hash'], body['content_hash']);
    assert.equal(second.text.includes(credential), false, second.text);

    const listed = await callApi(consoleServer.url, '/api/deployment/model-profiles', {
      cookie: userCookie(current.deploymentAdministratorToken),
    });
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.text.includes(credential), false, listed.text);
    const profiles = asArray(listed.body['model_profiles']);
    assert.equal(profiles.length, 1);
    const profile = asRecord(profiles[0]);
    assert.equal(profile['name'], 'Pinned Model');
    const versions = asArray(profile['versions']);
    assert.equal(versions.length, 2);
    for (const version of versions) {
      const record = asRecord(version);
      assert.equal(record['credential_ref'] !== undefined, true);
      assert.equal(record['has_credential'], true);
      assert.equal(JSON.stringify(record).includes(credential), false);
    }
  } finally {
    await consoleServer.stop();
    await endpoint.close();
    await otherEndpoint.close();
  }
});

/** Acceptance criterion 2: both adapters preflight, and no provider fallback exists. */
test('hosted and local preflight verifies structured output, constrained tools, pinned identity, and never falls back to another Profile', async () => {
  const current = world();
  const failingEndpoint = await startMockModelEndpoint();
  const fallbackEndpoint = await startMockModelEndpoint();
  const consoleServer = await startConsole(current.fixture);
  try {
    const hosted = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(failingEndpoint, 'hosted', 'Primary Hosted'),
    );
    assert.equal(hosted.status, 201, hosted.text);
    const hostedId = String(hosted.body['model_profile_id']);

    const local = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(fallbackEndpoint, 'generic_local', 'Secondary Local'),
    );
    assert.equal(local.status, 201, local.text);
    const localId = String(local.body['model_profile_id']);

    // The hosted Version passes while its endpoint behaves.
    const healthy = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, hostedId, 1);
    assert.equal(healthy.status, 200, healthy.text);
    assert.equal(healthy.body['passed'], true, JSON.stringify(healthy.body['checks']));
    const activated = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, hostedId, 1);
    assert.equal(activated.status, 200, activated.text);

    // Structured output is a real gate, not a declaration.
    failingEndpoint.behaviour = 'malformed_structured_output';
    const structured = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, hostedId, 1);
    assert.equal(structured.status, 200, structured.text);
    assert.equal(structured.body['passed'], false);
    const structuredChecks = checksOf(structured.body);
    assert.equal(structuredChecks.get('preflight')?.['passed'], true);
    assert.equal(structuredChecks.get('pinned_identity')?.['passed'], true);
    assert.equal(structuredChecks.get('structured_output')?.['passed'], false);
    assert.equal(structuredChecks.get('structured_output')?.['detail'], 'MODEL_STRUCTURED_OUTPUT_INVALID');

    // Constrained tools: a tool the request did not expose is refused.
    failingEndpoint.behaviour = 'undeclared_tool';
    const tools = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, hostedId, 1);
    assert.equal(tools.status, 200, tools.text);
    assert.equal(checksOf(tools.body).get('constrained_tools')?.['passed'], false);

    // Pinned identity: an answer from another model identity is refused.
    failingEndpoint.behaviour = 'identity_mismatch';
    const identity = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, hostedId, 1);
    assert.equal(identity.status, 200, identity.text);
    assert.equal(checksOf(identity.body).get('pinned_identity')?.['passed'], false);
    assert.equal(checksOf(identity.body).get('preflight')?.['passed'], true);

    // The bound Profile fails its preflight, and the second Profile is never called.
    failingEndpoint.behaviour = 'malformed_structured_output';
    const refused = await publishBinding(
      consoleServer.url,
      current.workspaceAdministratorToken,
      current.workspaceId,
      bindingInput(hostedId, 1, PURPOSES, DATA_CATEGORIES),
    );
    assert.equal(refused.status, 422, refused.text);
    assert.equal(refused.body['code'], 'MODEL_BINDING_PREFLIGHT_FAILED');
    assert.match(String(refused.body['message']), /structured_output/u);
    assert.equal(fallbackEndpoint.calls.length, 0, 'the second Profile must never be invoked');

    // The local adapter clears the same gates on its own endpoint.
    const localEvaluation = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, localId, 1);
    assert.equal(localEvaluation.status, 200, localEvaluation.text);
    assert.equal(localEvaluation.body['passed'], true, JSON.stringify(localEvaluation.body['checks']));
    const localChecks = checksOf(localEvaluation.body);
    for (const name of [
      'preflight',
      'pinned_identity',
      'structured_output',
      'constrained_tools',
      'simplified_chinese_prompt',
      'grounded_narration',
      'simplified_chinese_narrative',
      'simplified_chinese_clarification',
    ]) {
      assert.equal(localChecks.get(name)?.['passed'], true, name);
    }
    assert.equal(fallbackEndpoint.calls.length > 0, true);
  } finally {
    await consoleServer.stop();
    await failingEndpoint.close();
    await fallbackEndpoint.close();
  }
});

/** Acceptance criterion 3: Chinese grounded narration and clarification gate activation. */
test('activation evaluation requires grounded Simplified Chinese narration and clarification and refuses incompatible adapters', async () => {
  const current = world();
  const endpoint = await startMockModelEndpoint();
  const consoleServer = await startConsole(current.fixture);
  try {
    const published = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(endpoint, 'hosted', 'Narration Model'),
    );
    assert.equal(published.status, 201, published.text);
    const modelProfileId = String(published.body['model_profile_id']);

    const passed = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 1);
    assert.equal(passed.status, 200, passed.text);
    assert.equal(passed.body['passed'], true, JSON.stringify(passed.body['checks']));
    const passedChecks = checksOf(passed.body);
    assert.equal(passedChecks.get('grounded_narration')?.['passed'], true);
    assert.equal(passedChecks.get('simplified_chinese_narrative')?.['passed'], true);
    assert.equal(passedChecks.get('simplified_chinese_clarification')?.['passed'], true);
    const activated = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 1);
    assert.equal(activated.status, 200, activated.text);

    // Version 2 is the same endpoint, judged again under a degraded behaviour.
    const second = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(endpoint, 'hosted', 'Narration Model'),
    );
    assert.equal(second.status, 201, second.text);
    assert.equal(second.body['model_profile_version'], 2);

    endpoint.behaviour = 'english_narration';
    const english = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 2);
    assert.equal(english.status, 200, english.text);
    assert.equal(english.body['passed'], false);
    const englishChecks = checksOf(english.body);
    assert.equal(englishChecks.get('simplified_chinese_narrative')?.['passed'], false);
    assert.equal(englishChecks.get('simplified_chinese_narrative')?.['detail'], 'NARRATION_NOT_SIMPLIFIED_CHINESE');
    assert.equal(englishChecks.get('simplified_chinese_clarification')?.['passed'], false);
    assert.equal(englishChecks.get('simplified_chinese_clarification')?.['detail'], 'CLARIFICATION_NOT_SIMPLIFIED_CHINESE');

    const refused = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 2);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body['code'], 'MODEL_PROFILE_EVALUATION_FAILED');
    const stillOne = await callApi(consoleServer.url, '/api/deployment/model-profiles', {
      cookie: userCookie(current.deploymentAdministratorToken),
    });
    assert.equal(asRecord(asArray(stillOne.body['model_profiles'])[0])['activated_version'], 1);

    endpoint.behaviour = 'ungrounded_narration';
    const ungrounded = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 2);
    assert.equal(ungrounded.status, 200, ungrounded.text);
    assert.equal(ungrounded.body['passed'], false);
    const ungroundedChecks = checksOf(ungrounded.body);
    assert.equal(ungroundedChecks.get('grounded_narration')?.['passed'], false);
    assert.equal(ungroundedChecks.get('grounded_narration')?.['detail'], 'EVIDENCE_REF_NOT_GOVERNED');
    const refusedAgain = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 2);
    assert.equal(refusedAgain.status, 409, refusedAgain.text);
    assert.equal(refusedAgain.body['code'], 'MODEL_PROFILE_EVALUATION_FAILED');

    // A Version with no evaluation at all cannot activate.
    const third = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(endpoint, 'hosted', 'Narration Model'),
    );
    assert.equal(third.status, 201, third.text);
    const unevaluated = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 3);
    assert.equal(unevaluated.status, 409, unevaluated.text);
    assert.equal(unevaluated.body['code'], 'MODEL_PROFILE_EVALUATION_REQUIRED');

    // Once the endpoint is well behaved again, the Version activates.
    endpoint.behaviour = 'normal';
    const recovered = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 2);
    assert.equal(recovered.status, 200, recovered.text);
    assert.equal(recovered.body['passed'], true, JSON.stringify(recovered.body['checks']));
    const activatedAgain = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 2);
    assert.equal(activatedAgain.status, 200, activatedAgain.text);
    assert.equal(activatedAgain.body['activated_version'], 2);
  } finally {
    await consoleServer.stop();
    await endpoint.close();
  }
});

/** Acceptance criterion 4: a Binding narrows a Profile and discloses no provider settings. */
test('Workspace Bindings narrow purposes and data categories without exposing Deployment provider settings or credentials', async () => {
  const current = world();
  const endpoint = await startMockModelEndpoint();
  const consoleServer = await startConsole(current.fixture);
  try {
    const credential = 't67-binding-credential-4b7e';
    const published = await publishProfile(
      consoleServer.url,
      current.deploymentAdministratorToken,
      profileInput(endpoint, 'hosted', 'Narrow Model', {
        credential,
        purposes: ['grounded_narration', 'clarification'],
        data_categories: ['sample_records'],
      }),
    );
    assert.equal(published.status, 201, published.text);
    const modelProfileId = String(published.body['model_profile_id']);
    const evaluated = await evaluateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 1);
    assert.equal(evaluated.status, 200, evaluated.text);
    assert.equal(evaluated.body['passed'], true, JSON.stringify(evaluated.body['checks']));
    const activated = await activateProfile(consoleServer.url, current.deploymentAdministratorToken, modelProfileId, 1);
    assert.equal(activated.status, 200, activated.text);

    // The Workspace Administrator sees only a bindable summary, never provider settings.
    const options = await callApi(
      consoleServer.url,
      `/api/workspace/model-bindings?workspace_id=${current.workspaceId}`,
      { cookie: userCookie(current.workspaceAdministratorToken) },
    );
    assert.equal(options.status, 200, options.text);
    assert.equal(options.text.includes(endpoint.url), false, options.text);
    assert.equal(options.text.includes(MOCK_MODEL_ID), false, options.text);
    assert.equal(options.text.includes(credential), false, options.text);
    const bindable = asArray(options.body['model_profiles']);
    assert.equal(bindable.length, 1);
    assert.equal(asRecord(bindable[0])['model_profile_id'], modelProfileId);
    assert.deepEqual(asRecord(bindable[0])['purposes'], ['grounded_narration', 'clarification']);
    assert.deepEqual(asRecord(bindable[0])['data_categories'], ['sample_records']);

    // A Binding may only enable what the Profile Version declares.
    const allowed = await publishBinding(
      consoleServer.url,
      current.workspaceAdministratorToken,
      current.workspaceId,
      bindingInput(modelProfileId, 1, ['grounded_narration'], ['sample_records']),
    );
    assert.equal(allowed.status, 201, allowed.text);
    assert.deepEqual(allowed.body['purposes'], ['grounded_narration']);
    assert.deepEqual(allowed.body['data_categories'], ['sample_records']);
    assert.equal(allowed.text.includes(endpoint.url), false, allowed.text);
    assert.equal(allowed.text.includes(MOCK_MODEL_ID), false, allowed.text);
    assert.equal(allowed.text.includes(credential), false, allowed.text);

    const outsidePurpose = await publishBinding(
      consoleServer.url,
      current.workspaceAdministratorToken,
      current.workspaceId,
      bindingInput(modelProfileId, 1, ['integration_proposal'], ['sample_records']),
    );
    assert.equal(outsidePurpose.status, 422, outsidePurpose.text);
    assert.equal(outsidePurpose.body['code'], 'MODEL_BINDING_PURPOSE_NOT_PERMITTED');

    const outsideCategory = await publishBinding(
      consoleServer.url,
      current.workspaceAdministratorToken,
      current.workspaceId,
      bindingInput(modelProfileId, 1, ['grounded_narration'], ['dataset_schema']),
    );
    assert.equal(outsideCategory.status, 422, outsideCategory.text);
    assert.equal(outsideCategory.body['code'], 'MODEL_BINDING_DATA_CATEGORY_NOT_PERMITTED');

    // Every Binding read is Workspace-scoped and secret-free.
    const listed = await callApi(
      consoleServer.url,
      `/api/workspace/model-bindings?workspace_id=${current.workspaceId}`,
      { cookie: userCookie(current.workspaceAdministratorToken) },
    );
    assert.equal(listed.status, 200, listed.text);
    assert.equal(asArray(listed.body['bindings']).length, 1);
    assert.equal(listed.text.includes(endpoint.url), false, listed.text);
    assert.equal(listed.text.includes(MOCK_MODEL_ID), false, listed.text);
    assert.equal(listed.text.includes(credential), false, listed.text);

    const consumer = await callApi(
      consoleServer.url,
      `/api/workspace/model-bindings?workspace_id=${current.workspaceId}`,
      { cookie: userCookie(current.consumerToken) },
    );
    assert.equal(consumer.status, 403, consumer.text);
    assert.equal(consumer.body['code'], 'WORKSPACE_ACCESS_DENIED');
    assert.equal(consumer.text.includes(endpoint.url), false, consumer.text);
  } finally {
    await consoleServer.stop();
    await endpoint.close();
  }
});

/** Acceptance criterion 5: the governed browser workflow, end to end. */
test('the browser covers successful activation, evaluation failure, revocation, authorization, and Simplified Chinese status and evidence', async () => {
  const current = world();
  const endpoint = await startMockModelEndpoint();
  const consoleServer = await startConsole(current.fixture);
  const credential = 't67-browser-credential-51ad';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);

    // A Workspace Administrator cannot manage a Deployment-scoped Model Profile.
    await page.goto(`${consoleServer.url}/app`);
    await signIn(page, current.workspaceAdministrator);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: '部署导航' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '模型绑定' }).count(), 1);
    await page.goto(`${consoleServer.url}/app/deployment/model-profiles`);
    await page.getByRole('heading', { name: '工作区不可用' }).waitFor();
    const denied = await callApi(consoleServer.url, '/api/deployment/model-profiles', {
      method: 'POST',
      cookie: userCookie(current.workspaceAdministratorToken),
      body: profileInput(endpoint, 'hosted', 'Forbidden Model'),
    });
    assert.equal(denied.status, 403, denied.text);
    assert.equal(denied.body['code'], 'AUTHORIZATION_DENIED');
    await signOut(page);

    // A Deployment Administrator publishes, evaluates, and activates.
    await signIn(page, current.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    await page.getByRole('link', { name: '模型档案' }).click();
    await page.getByRole('heading', { name: '模型档案' }).waitFor();

    await page.getByLabel('档案名称').fill('Primary Model');
    await page.getByLabel('适配方式').selectOption('hosted');
    await page.getByLabel('端点地址').fill(endpoint.url);
    await page.getByLabel('模型标识').fill(MOCK_MODEL_ID);
    await page.getByLabel('凭据').fill(credential);
    assert.equal(await page.getByLabel('integration_proposal', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('sample_records', { exact: true }).isChecked(), true);
    await page.getByLabel('可用工具').fill('read_data_dictionary, read_governed_result');
    await page.getByLabel('输出上限（字节）').fill('65536');
    await page.getByRole('button', { name: '发布模型档案版本' }).click();
    await page.getByText('模型档案版本已发布。').waitFor();

    const primary = page.getByRole('region', { name: 'Primary Model' });
    await primary.waitFor();
    assert.equal((await page.locator('body').innerText()).includes(credential), false);

    await primary.getByRole('button', { name: '运行启用评价' }).click();
    await primary.getByText('启用评价已通过。').waitFor();
    const evidence = await primary.innerText();
    for (const label of ['简体中文提示词', '有据叙述', '简体中文叙述', '简体中文澄清']) {
      assert.match(evidence, new RegExp(label, 'u'));
    }
    for (const code of ['simplified_chinese_narrative', 'simplified_chinese_clarification', 'grounded_narration']) {
      assert.match(evidence, new RegExp(code, 'u'));
    }
    assert.match(evidence, /通过/u);

    await primary.getByRole('button', { name: '启用此版本' }).click();
    await primary.getByText('模型档案版本已启用。').waitFor();
    assert.match(await primary.innerText(), /当前启用版本[\s\S]*1/u);

    // An incompatible endpoint is refused, and the failing check is named in Chinese.
    endpoint.behaviour = 'english_narration';
    await page.getByLabel('档案名称').fill('Rejected Model');
    await page.getByRole('button', { name: '发布模型档案版本' }).click();
    await page.getByText('模型档案版本已发布。').waitFor();
    const rejected = page.getByRole('region', { name: 'Rejected Model' });
    await rejected.waitFor();
    await rejected.getByRole('button', { name: '运行启用评价' }).click();
    await rejected.getByText('启用评价未通过，端点未能稳定给出有据的简体中文结果。').waitFor();
    const rejectedEvidence = await rejected.innerText();
    assert.match(rejectedEvidence, /简体中文叙述/u);
    assert.match(rejectedEvidence, /simplified_chinese_narrative/u);
    assert.match(rejectedEvidence, /简体中文澄清/u);
    assert.match(rejectedEvidence, /simplified_chinese_clarification/u);
    assert.match(rejectedEvidence, /未通过/u);

    await rejected.getByRole('button', { name: '启用此版本' }).click();
    await rejected.getByText('模型档案版本未通过启用评价，不能启用。').waitFor();
    assert.match(await rejected.innerText(), /MODEL_PROFILE_EVALUATION_FAILED/u);

    endpoint.behaviour = 'ungrounded_narration';
    await rejected.getByRole('button', { name: '运行启用评价' }).click();
    await rejected.getByText('EVIDENCE_REF_NOT_GOVERNED').waitFor();
    const ungroundedEvidence = await rejected.innerText();
    assert.match(ungroundedEvidence, /有据叙述/u);
    assert.match(ungroundedEvidence, /grounded_narration/u);
    await rejected.getByRole('button', { name: '启用此版本' }).click();
    await rejected.getByText('模型档案版本未通过启用评价，不能启用。').waitFor();
    endpoint.behaviour = 'normal';
    await signOut(page);

    // A Workspace Administrator binds the activated Profile, then revokes the Binding.
    await signIn(page, current.workspaceAdministrator);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    await page.getByRole('link', { name: '模型绑定' }).click();
    await page.getByRole('heading', { name: '模型绑定' }).waitFor();
    await page.getByLabel('绑定的模型档案').selectOption({ label: 'Primary Model · v1' });
    await page.getByLabel('grounded_narration', { exact: true }).check();
    await page.getByLabel('sample_records', { exact: true }).check();
    await page.getByRole('button', { name: '建立绑定' }).click();
    await page.getByText('绑定已建立。').waitFor();

    const binding = page.getByRole('region', { name: /^绑定 /u }).first();
    await binding.waitFor();
    const bindingText = await binding.innerText();
    assert.match(bindingText, /生效中/u);
    assert.match(bindingText, /Primary Model/u);
    assert.match(bindingText, /grounded_narration/u);
    assert.match(bindingText, /sample_records/u);
    const bindingPage = await page.locator('body').innerText();
    assert.equal(bindingPage.includes(endpoint.url), false, bindingPage);
    assert.equal(bindingPage.includes(MOCK_MODEL_ID), false, bindingPage);
    assert.equal(bindingPage.includes(credential), false, bindingPage);

    await binding.getByRole('button', { name: '撤销绑定' }).click();
    await page.getByText('绑定已撤销，后续生成不会再使用它。').waitFor();
    assert.match(await binding.innerText(), /已撤销/u);

    const bindings = await callApi(
      consoleServer.url,
      `/api/workspace/model-bindings?workspace_id=${current.workspaceId}`,
      { cookie: userCookie(current.workspaceAdministratorToken) },
    );
    assert.equal(bindings.status, 200, bindings.text);
    const stored = asRecord(asArray(bindings.body['bindings'])[0]);
    assert.equal(typeof stored['revoked_at'], 'string');
    await signOut(page);

    // A Consumer cannot see or call the Binding surface.
    await signIn(page, current.consumer);
    await page.getByRole('heading', { name: '工作区概览' }).waitFor();
    assert.equal(await page.getByRole('link', { name: '模型绑定' }).count(), 0);
    await page.goto(`${consoleServer.url}/app/w/${current.workspaceId}/models`);
    await page.getByRole('heading', { name: '工作区不可用' }).waitFor();
    const consumerCall = await callApi(
      consoleServer.url,
      `/api/workspace/model-bindings?workspace_id=${current.workspaceId}`,
      { cookie: userCookie(current.consumerToken) },
    );
    assert.equal(consumerCall.status, 403, consumerCall.text);
    assert.equal(consumerCall.body['code'], 'WORKSPACE_ACCESS_DENIED');
  } finally {
    await browser?.close();
    await consoleServer.stop();
    await endpoint.close();
  }
});

/** The Deployment publishes its governed vocabulary once, so no surface restates it. */
test('the Model Profile list publishes every governed purpose, data category, and adapter exactly once', async () => {
  const fixture = initializePlatform();
  const token = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  const consoleServer = await startConsole(fixture);
  try {
    const listed = await callApi(consoleServer.url, '/api/deployment/model-profiles', {
      cookie: userCookie(token),
    });
    assert.equal(listed.status, 200, listed.text);
    const vocabulary = asRecord(listed.body['vocabulary']);
    assert.deepEqual(vocabulary['purposes'], [
      'integration_proposal',
      'data_product_proposal',
      'scraper_repair',
      'grounded_narration',
      'clarification',
      'query_plan',
    ]);
    assert.deepEqual(vocabulary['data_categories'], [
      'dataset_schema',
      'cleaning_rules',
      'source_mapping',
      'sample_records',
      'product_contract',
      'scraper_diagnostics',
    ]);
    assert.deepEqual(vocabulary['adapters'], ['hosted', 'generic_local']);
  } finally {
    await consoleServer.stop();
  }
});

/** The browser renders the server's vocabulary, so a governed value cannot go missing. */
test('the Model Profile form renders every purpose and data category the server publishes', async () => {
  const current = world();
  const consoleServer = await startConsole(current.fixture);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(`${consoleServer.url}/app`);
    await signIn(page, current.deploymentAdministrator);
    await page.getByRole('heading', { name: '工作区', exact: true }).waitFor();
    await page.getByRole('link', { name: '模型档案' }).click();
    await page.getByRole('heading', { name: '模型档案' }).waitFor();

    for (const purpose of [
      'integration_proposal',
      'data_product_proposal',
      'scraper_repair',
      'grounded_narration',
      'clarification',
      'query_plan',
    ]) {
      assert.equal(await page.getByLabel(purpose, { exact: true }).count(), 1, purpose);
    }
    for (const category of [
      'dataset_schema',
      'cleaning_rules',
      'source_mapping',
      'sample_records',
      'product_contract',
      'scraper_diagnostics',
    ]) {
      assert.equal(await page.getByLabel(category, { exact: true }).count(), 1, category);
    }
    assert.equal(await page.getByLabel('适配方式').locator('option').count(), 2);
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
});
