import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { canonicalJson, sha256File } from '../../src/crypto.js';
import { LOCAL_EMBEDDING_CONFIGURATION } from '../../src/embeddings.js';
import { MODEL_ADAPTERS } from '../../src/model-adapter.js';
import { createBundleFixture, type BundleFixture } from './bundle.js';
import { startConsole } from './console.js';
import { EXTENDED_LEDGER_CONTRACT, acquireAndRelease, publishSource } from './data-product.js';
import { blockedEgressEnvironment, recordedEgressAttempts, type EgressGuard } from './egress-guard.js';
import { verifyEvidenceManifest, writeEvidenceManifest, type WrittenEvidence } from './evidence.js';
import { fakeDockerEnvironment } from './fake-docker.js';
import { issueLicense } from './license.js';
import {
  MOCK_MODEL_ID,
  startMockModelEndpoint,
  type MockBehaviour,
  type MockModelEndpoint,
} from './model-endpoint.js';
import { commandAsync } from './async-command.js';
import { runOperator, type OperatorResult } from './operator.js';
import {
  command,
  createUser,
  createWorkspace,
  grantRole,
  jsonFile,
  registerTotp,
  sessionFor,
  totpSecretFor,
  type PlatformFixture,
} from './platform.js';
import { totpCode } from './totp.js';
import { inspectChineseSurface, type ChinesePageReport } from './ui-language.js';

/** The fixed labels and numbers this certification uses; no business logic lives here. */
const OPERATOR = 'certification-operator@example.invalid';
const OPERATOR_PASSWORD = 'certification-operator-password';
const OPERATIONS = 'operations@example.invalid';
const OPERATIONS_PASSWORD = 'operations-administrator';
const ANALYST = 'analyst@example.invalid';
const ANALYST_PASSWORD = 'analyst-consumer';
const OUTSIDER = 'outsider@example.invalid';
const OUTSIDER_PASSWORD = 'outsider-administrator';
const RELEASE = '0.1.0';
const NEXT_RELEASE = '0.2.0';
const PRODUCT_NAME = '设备维修台账';
const WORKSPACE_NAME = '华东运营';

const PURPOSES = ['integration_proposal', 'grounded_narration', 'clarification'] as const;
const LOCAL_PURPOSES = [...PURPOSES, 'query_plan'] as const;
const DATA_CATEGORIES = ['dataset_schema', 'cleaning_rules', 'source_mapping', 'sample_records'] as const;
const NLQ_CATEGORIES = ['product_contract', 'sample_records'] as const;
const PROMPTS: Record<string, string> = {
  integration_proposal: '你是数据集成助手，只输出简体中文说明，并按结构化输出返回候选 Integration Configuration。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
  query_plan: '你是数据产品查询规划器，只输出简体中文解释，并且只使用受治理契约发布的字段、维度、指标和算子。',
};

/** The exact governed values the frozen fixture ledger implies, computed independently. */
export const LEDGER_ORACLE = {
  totals: { device_count: 3, handled_total: 10, settled_total: '420.50' },
  records: [
    { sn: 'sn-001', city: '杭州', handled_count: 3, settled_amount: 120.5, reported_on: '2026-01-05' },
    { sn: 'sn-002', city: '上海', handled_count: 5, settled_amount: 300, reported_on: '2026-01-12' },
    { sn: 'sn-003', city: null, handled_count: 2, settled_amount: null, reported_on: '2026-01-20' },
  ],
} as const;

/**
 * The shipped adapter profile set, plus the two platform-contract adapters that
 * keep disconnected generation working. Every native provider speaks its own
 * wire protocol; the generic adapter speaks OpenAI-compatible Chat Completions.
 */
export const PROVIDER_PROFILES = [
  { key: 'alibaba-qwen', name: '通义千问（阿里云原生）', adapter: 'alibaba_qwen' },
  { key: 'deepseek', name: '深度求索（DeepSeek 原生）', adapter: 'deepseek' },
  { key: 'openai-compatible', name: 'OpenAI 兼容端点', adapter: 'openai_compatible' },
  { key: 'hosted-contract', name: '托管契约端点', adapter: 'hosted' },
  { key: 'local-generic', name: '本地通用生成（离线）', adapter: 'generic_local' },
] as const;

type ProviderKey = typeof PROVIDER_PROFILES[number]['key'];
type RealProviderKey = 'alibaba-qwen' | 'deepseek' | 'openai-compatible';
const REAL_MODEL_ENV: Record<RealProviderKey, string> = {
  'alibaba-qwen': 'DC_CERT_REAL_MODEL_QWEN',
  deepseek: 'DC_CERT_REAL_MODEL_DEEPSEEK',
  'openai-compatible': 'DC_CERT_REAL_MODEL_OPENAI',
};

/** The provider-native adapter each real-model suite exercises. */
const REAL_MODEL_ADAPTERS: Record<RealProviderKey, string> = {
  'alibaba-qwen': 'alibaba_qwen',
  deepseek: 'deepseek',
  'openai-compatible': 'openai_compatible',
};

/** One deliberately incompatible behaviour each shipped adapter must refuse. */
const ADVERSE_BEHAVIOURS: Partial<Record<string, MockBehaviour>> = {
  hosted: 'undeclared_tool',
  generic_local: 'malformed_structured_output',
  alibaba_qwen: 'identity_mismatch',
  deepseek: 'identity_mismatch',
  openai_compatible: 'malformed_structured_output',
};

export interface Scenario {
  name: string;
  area: string;
  passed: boolean;
  detail: Record<string, unknown>;
}

export interface CertificationOptions {
  generatedAt?: string;
  scratchDirectory?: string;
  /** Records a browser smoke unless explicitly disabled by a caller. */
  ui?: boolean;
  /** Operator-supplied hosted endpoints, read from the environment when absent. */
  realModels?: Partial<Record<ProviderKey, { endpoint_url: string; model_id: string; credential?: string }>>;
}

export interface ChannelResult {
  name: 'connected-download' | 'removable-media';
  observations: Record<string, unknown>;
  passed: boolean;
}

export interface AdapterResult {
  provider: string;
  label: string;
  adapter: string;
  model_id: string;
  purposes: string[];
  model_profile_id: string;
  runs: Array<{
    run: number;
    passed: boolean;
    checks: Array<{ name: string; passed: boolean }>;
    evidence_hash: string;
    budget: Record<string, unknown>;
  }>;
  consecutive_passes: number;
  passed: boolean;
  binding: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean }>;
    evidence_hash: string;
  };
  adverse: Array<{ behaviour: string; refused: boolean; failed_checks: string[] }>;
}

export interface RealModelResult {
  provider: string;
  adapter: string;
  model_id: string | null;
  status: 'not_configured' | 'passed' | 'failed';
  runs: Array<{ run: number; passed: boolean }>;
  reason: string | null;
}

export interface UiSurfaceResult {
  surface: string;
  pages: ChinesePageReport[];
  passed: boolean;
}

export interface CertificationRun {
  manifestPath: string;
  signaturePath: string;
  digest: string;
  manifest: Record<string, unknown>;
  bundle: BundleFixture;
  scratch: string;
  verify(): boolean;
}

interface ChannelWorld extends PlatformFixture {
  name: 'connected-download' | 'removable-media';
  workspaceId: string;
  dataProductId: string;
  sourceId: string;
  deploymentAdministratorToken: string;
  workspaceAdministratorToken: string;
  consumerToken: string;
  egress: EgressGuard | null;
  dockerLogPath: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected an object, received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A lifecycle step either succeeded or the certification stops with its own words. */
function ok(result: OperatorResult, step: string): Record<string, unknown> {
  if (result.status !== 0) {
    throw new Error(`${step} failed (${String(result.error['code'] ?? result.status)}): ${result.stderr || result.stdout}`);
  }
  return result.output;
}

/** One governed read, projected to the values two channels must agree on. */
function readProjection(world: ChannelWorld): Record<string, unknown> {
  const records = ok(command(world, [
    'product', 'query', '--product', world.dataProductId,
    '--request', requestFile(world, { kind: 'records', limit: 10 }),
  ], { token: world.consumerToken }), 'governed records read');
  const aggregate = ok(command(world, [
    'product', 'query', '--product', world.dataProductId,
    '--request', requestFile(world, {
      kind: 'aggregate',
      metrics: ['device_count', 'handled_total', 'settled_total'],
      include_totals: true,
    }),
  ], { token: world.consumerToken }), 'governed aggregate read');
  return {
    records: asArray(records['records']),
    matched_count: records['matched_count'],
    returned: records['returned'],
    dataset_release: asRecord(records['provenance'])['dataset_release'],
    record_count: asRecord(records['provenance'])['record_count'],
    totals: asRecord(aggregate['totals'])['metrics'],
  };
}

function statusProjection(status: Record<string, unknown>): Record<string, unknown> {
  const window = asRecord(status['rollback_window'] ?? {});
  return {
    state: status['state'],
    health: status['health'],
    service_open: status['service_open'],
    access: status['access'],
    release: status['release'],
    runtime_services: status['runtime_services'],
    mfa_enrolled: status['mfa_enrolled'],
    default_credentials: status['default_credentials'],
    master_key_external: status['master_key_external'],
    license_status: asRecord(status['license'] ?? {})['status'],
    rollback_open: window['open'] ?? null,
    rollback_eligible: window['eligible'] ?? null,
  };
}

function checkPasses(report: unknown): Record<string, boolean> {
  const record = asRecord(report ?? {});
  const result: Record<string, boolean> = {};
  for (const [name, check] of Object.entries(record)) {
    if (check !== null && typeof check === 'object' && !Array.isArray(check)) {
      const passed = (check as Record<string, unknown>)['passed'];
      if (typeof passed === 'boolean') result[name] = passed;
    }
  }
  return result;
}

function verifyProjection(verify: Record<string, unknown>): Record<string, unknown> {
  const checks = asRecord(verify['checks'] ?? {});
  const consumer = asRecord(checks['consumer_reads'] ?? {});
  const firstRead = asRecord(asArray(consumer['reads'])[0] ?? {});
  return {
    passed: verify['passed'],
    store_schema_version: verify['store_schema_version'],
    expand_only: asRecord(verify['migrations'] ?? {})['expand_only'],
    checks: checkPasses(checks),
    counts: {
      objects: asRecord(checks['objects'] ?? {})['verified'] ?? null,
      users: asRecord(checks['identities'] ?? {})['users'] ?? null,
      workspaces: asRecord(checks['workspace_isolation'] ?? {})['workspaces'] ?? null,
      dataset_releases: asRecord(checks['releases'] ?? {})['dataset_releases'] ?? null,
      product_releases: asRecord(checks['releases'] ?? {})['product_releases'] ?? null,
      consumer_products: consumer['products'] ?? null,
      consumer_returned: firstRead['returned'] ?? null,
    },
  };
}

let requestCounter = 0;
function requestFile(fixture: PlatformFixture, value: unknown): string {
  requestCounter += 1;
  return jsonFile(fixture, `certification-request-${String(requestCounter)}`, value);
}

function signedArguments(
  fixture: PlatformFixture,
  bundle: BundleFixture,
  bundlePath = bundle.directory,
): string[] {
  return [
    '--bundle', bundlePath,
    '--release-key', join(fixture.root, 'trust', 'release-key.pem'),
    '--confirm-release-key-fingerprint', fixture.bundle.releaseFingerprint,
    '--operator', OPERATOR,
  ];
}

interface Provisioned {
  world: ChannelWorld;
  install: Record<string, unknown>;
  license: Record<string, unknown>;
  initialize: Record<string, unknown>;
}

/**
 * Installs, licenses, initializes, and populates one channel through the
 * supported Operator CLI. The bytes being installed are the same signed bundle;
 * only the delivery directory differs.
 */
function provisionChannel(options: {
  name: 'connected-download' | 'removable-media';
  bundle: BundleFixture;
  bundlePath: string;
  scratch: string;
  egress: EgressGuard | null;
}): Provisioned {
  const docker = fakeDockerEnvironment(options.scratch);
  const env = { ...docker, ...(options.egress === null ? {} : options.egress.env) };
  const root = join(options.scratch, 'deployment');
  const masterKey = join(options.scratch, 'master-key');
  writeFileSync(masterKey, randomBytes(32), { mode: 0o600 });

  const installed = ok(runOperator([
    'install',
    '--bundle', options.bundlePath,
    '--root', root,
    '--release-key', options.bundle.releasePublicKeyPath,
    '--confirm-release-key-fingerprint', options.bundle.releaseFingerprint,
    '--operator', OPERATOR,
  ], { env }), 'install');
  const request = JSON.parse(readFileSync(String(installed['license_request']), 'utf8')) as {
    request_id: string;
    deployment_id: string;
    release: string;
  };
  const licensePath = join(options.scratch, 'deployment-license.json');
  issueLicense(licensePath, options.bundle, request, { highestEligibleRelease: NEXT_RELEASE });
  const imported = ok(runOperator([
    'import-license', '--root', root, '--license', licensePath, '--operator', OPERATOR,
  ], { env }), 'import-license');
  const initialized = ok(runOperator([
    'initialize', '--root', root, '--master-key', masterKey,
    '--admin-username', 'bootstrap@example.invalid', '--admin-password-stdin',
    '--operator', OPERATOR,
  ], { env, input: 'certification-bootstrap-password\n' }), 'initialize');

  const fixture: PlatformFixture = {
    root,
    masterKey,
    docker: env,
    scratch: options.scratch,
    bundle: options.bundle,
    administrator: {
      username: String(initialized['admin_username'] ?? 'bootstrap@example.invalid'),
      password: 'certification-bootstrap-password',
      totp_secret: String(initialized['totp_secret']),
      recovery_codes: asArray(initialized['recovery_codes']) as string[],
    },
  };
  registerTotp(fixture, fixture.administrator.username, fixture.administrator.totp_secret);

  const deploymentAdministratorToken = sessionFor(fixture, fixture.administrator.username, fixture.administrator.password);
  createUser(fixture, deploymentAdministratorToken, OPERATIONS, OPERATIONS_PASSWORD);
  const workspaceId = createWorkspace(fixture, deploymentAdministratorToken, WORKSPACE_NAME, OPERATIONS);
  const workspaceAdministratorToken = sessionFor(fixture, OPERATIONS, OPERATIONS_PASSWORD);
  createUser(fixture, deploymentAdministratorToken, ANALYST, ANALYST_PASSWORD);
  grantRole(fixture, workspaceAdministratorToken, workspaceId, ANALYST, 'Consumer');
  const consumerToken = sessionFor(fixture, ANALYST, ANALYST_PASSWORD);
  const sourceId = publishSource(fixture, workspaceAdministratorToken, workspaceId);
  acquireAndRelease(fixture, workspaceAdministratorToken, sourceId);
  const published = ok(command(fixture, [
    'product', 'publish', '--source', sourceId, '--name', PRODUCT_NAME,
    '--contract', jsonFile(fixture, 'certification-contract', EXTENDED_LEDGER_CONTRACT),
  ], { token: workspaceAdministratorToken }), 'product publish');

  const world: ChannelWorld = {
    ...fixture,
    name: options.name,
    workspaceId,
    dataProductId: String(published['data_product_id']),
    sourceId,
    deploymentAdministratorToken,
    workspaceAdministratorToken,
    consumerToken,
    egress: options.egress,
    dockerLogPath: String(docker['DC_DOCKER_LOG']),
  };
  return { world, install: installed, license: imported, initialize: initialized };
}

function dockerCalls(logPath: string): string[][] {
  const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * Runs the full certified lifecycle on one channel: install, verify, status,
 * N -> N+1 upgrade, Application Rollback with the media removed, backup, and an
 * isolated restoration. Every step is driven through the Operator CLI only.
 */
function runLifecycle(options: {
  world: ChannelWorld;
  nextBundle: BundleFixture;
  upgradeBundlePath: string;
  install: Record<string, unknown>;
  license: Record<string, unknown>;
  initialize: Record<string, unknown>;
}): Record<string, unknown> {
  const { world } = options;
  const observations: Record<string, unknown> = {};
  observations['install'] = {
    state: options.install['state'],
    release: options.install['release'],
    service_open: options.install['service_open'],
    license_request_present: existsSync(String(options.install['license_request'])),
    evidence_present: existsSync(join(world.root, 'evidence', `${String(options.install['evidence_id'])}.json`)),
  };
  observations['license'] = {
    state: options.license['state'],
    service_open: options.license['service_open'],
    license_id: typeof options.license['license_id'] === 'string',
  };
  observations['initialize'] = {
    state: options.initialize['state'],
    service_open: options.initialize['service_open'],
    mfa_enrolled: options.initialize['mfa_enrolled'],
    default_credentials: options.initialize['default_credentials'],
    master_key_external: options.initialize['master_key_external'],
    runtime_services: options.initialize['runtime_services'],
  };

  const beforeStatus = ok(command(world, ['status', '--operator', OPERATOR]), 'status before upgrade');
  observations['status_before_upgrade'] = statusProjection(beforeStatus);
  observations['read_before_upgrade'] = readProjection(world);

  const preflightResult = ok(command(world, ['preflight', ...signedArguments(world, options.nextBundle, options.upgradeBundlePath)]), 'preflight');
  observations['preflight'] = {
    passed: preflightResult['passed'],
    from_release: preflightResult['from_release'],
    to_release: preflightResult['to_release'],
    previous_images: asRecord(preflightResult['previous_images'] ?? {})['images'],
    stores: asRecord(preflightResult['stores'] ?? {})['services'],
    pending_queue: asRecord(preflightResult['queues'] ?? {})['pending'],
  };

  const upgraded = ok(command(world, ['upgrade', ...signedArguments(world, options.nextBundle, options.upgradeBundlePath)]), 'upgrade');
  const window = asRecord(upgraded['rollback_window'] ?? {});
  const migrations = asRecord(upgraded['migrations'] ?? {});
  observations['upgrade'] = {
    status: upgraded['status'],
    from_release: upgraded['from_release'],
    to_release: upgraded['to_release'],
    service_open: upgraded['service_open'],
    state: upgraded['state'],
    checkpoint_required: upgraded['checkpoint_required'],
    migrations: {
      expand_only: migrations['expand_only'],
      destructive: migrations['destructive'],
      applied_steps: migrations['applied_steps'],
      skipped_steps: migrations['skipped_steps'],
    },
    rollback_window: {
      open: window['open'],
      eligible: window['eligible'],
      from_release: window['from_release'],
      to_release: window['to_release'],
    },
  };
  const verifyAfter = ok(command(world, ['verify', '--operator', OPERATOR]), 'verify after upgrade');
  observations['verify_after_upgrade'] = verifyProjection(verifyAfter);
  observations['read_after_upgrade'] = readProjection(world);

  // An Application Rollback has to work from the local image copies alone, so
  // the delivered media is removed before the Operator asks for it.
  renameSync(options.upgradeBundlePath, `${options.upgradeBundlePath}-withdrawn`);
  writeFileSync(world.dockerLogPath, '');
  const rolledBack = ok(command(world, ['rollback', '--operator', OPERATOR]), 'rollback');
  const closedWindow = asRecord(rolledBack['rollback_window'] ?? {});
  observations['rollback'] = {
    from_release: rolledBack['from_release'],
    to_release: rolledBack['to_release'],
    release: rolledBack['release'],
    service_open: rolledBack['service_open'],
    down_migrations: rolledBack['down_migrations'],
    state_schema_version: rolledBack['state_schema_version'],
    data_unchanged: rolledBack['data_unchanged'],
    offline: rolledBack['offline'],
    records_after_upgrade: rolledBack['records_after_upgrade'],
    rollback_window: {
      open: closedWindow['open'],
      eligible: closedWindow['eligible'],
      closed_by: closedWindow['closed_by'],
    },
  };
  observations['status_after_rollback'] = statusProjection(
    ok(command(world, ['status', '--operator', OPERATOR]), 'status after rollback'),
  );
  observations['read_after_rollback'] = readProjection(world);

  const backupRoot = join(world.scratch, 'recovery');
  const backup = ok(command(world, [
    'backup', 'create', '--backup-root', backupRoot, '--operator', OPERATOR,
  ]), 'backup create');
  const backupId = String(backup['backup_id']);
  const retention = asRecord(backup['retention'] ?? {});
  observations['backup'] = {
    kind: backup['kind'],
    schema_version: backup['schema_version'],
    cadence: backup['cadence'],
    retention_days: retention['days'],
    component_roles: asArray(backup['components']).map((entry) => asRecord(entry)['role']).sort(),
    excluded: asArray(backup['excluded']).map((entry) => asRecord(entry)['name']).sort(),
    payloads_encrypted: backup['payloads_encrypted'],
    secrets_included: backup['secrets_included'],
    escrowed_separately: backup['escrowed_separately'],
  };
  const verifiedBackup = ok(command(world, [
    'backup', 'verify', '--backup-root', backupRoot, '--backup', backupId, '--operator', OPERATOR,
  ]), 'backup verify');
  const verifiedRto = asRecord(verifiedBackup['rto'] ?? {});
  observations['backup_verify'] = {
    verified: verifiedBackup['verified'],
    rto_met: verifiedRto['met'],
    rto_limit_seconds: verifiedRto['limit_seconds'],
    checks: checkPasses(verifiedBackup['verification']),
  };

  const isolated = join(world.scratch, 'restored');
  const restored = ok(runOperator([
    'restore', '--root', isolated, '--backup-root', backupRoot, '--backup', backupId,
    '--master-key', world.masterKey, '--operator', OPERATOR,
  ], { env: world.docker }), 'restore');
  const restoredRto = asRecord(restored['rto'] ?? {});
  const purgeLedger = asRecord(restored['purge_ledger'] ?? {});
  observations['restore'] = {
    state: restored['state'],
    service_open: restored['service_open'],
    release: restored['release'],
    workers_enabled: restored['workers_enabled'],
    connectivity_enabled: restored['connectivity_enabled'],
    rto_met: restoredRto['met'],
    rto_limit_seconds: restoredRto['limit_seconds'],
    checks: checkPasses(restored['verification']),
    purge_ledger: { entries: purgeLedger['entries'], removed: purgeLedger['removed'] },
  };

  // The restored Deployment serves the same governed data to the same Consumer.
  const restoredFixture: ChannelWorld = { ...world, root: isolated };
  registerTotp(restoredFixture, OPERATIONS, totpSecretFor(world, OPERATIONS));
  const restoredToken = sessionFor(restoredFixture, OPERATIONS, OPERATIONS_PASSWORD);
  const restoredRead = ok(command(restoredFixture, [
    'product', 'query', '--product', world.dataProductId,
    '--request', requestFile(restoredFixture, { kind: 'records', limit: 10 }),
  ], { token: restoredToken }), 'restored governed read');
  observations['restored_read'] = {
    returned: restoredRead['returned'],
    matched_count: restoredRead['matched_count'],
    records: asArray(restoredRead['records']),
    dataset_release: asRecord(restoredRead['provenance'])['dataset_release'],
  };

  const calls = dockerCalls(world.dockerLogPath);
  observations['offline'] = {
    registry_pulls: calls.filter((args) => args[0] === 'pull').length,
    compose_up_without_pull: calls.some(
      (args) => args.includes('up') && args.includes('--pull') && args.includes('never'),
    ),
  };
  return observations;
}

function profilePrompts(purposes: readonly string[]): Record<string, string> {
  return Object.fromEntries(purposes.map((purpose) => [purpose, PROMPTS[purpose] ?? PROMPTS['clarification']!]));
}

interface PublishedProfile {
  model_profile_id: string;
  model_profile_version: number;
  content_hash: string;
  credential: string | null;
}

async function publishProfile(options: {
  world: ChannelWorld;
  name: string;
  adapter: string;
  endpointUrl: string;
  modelId?: string;
  purposes: readonly string[];
  categories: readonly string[];
  credential: string | null;
  tools?: readonly string[];
}): Promise<PublishedProfile> {
  const config = jsonFile(options.world, `certification-profile-${options.adapter}-${options.purposes.length}`, {
    adapter: options.adapter,
    endpoint_url: options.endpointUrl,
    model_id: options.modelId ?? MOCK_MODEL_ID,
    purposes: [...options.purposes],
    data_categories: [...options.categories],
    tools: [...(options.tools ?? [])],
    max_output_bytes: 65_536,
    prompts: profilePrompts(options.purposes),
  });
  const args = ['model', 'publish', '--name', options.name, '--config', config];
  if (options.credential !== null) args.push('--credential-stdin');
  const published = ok(command(options.world, args, {
    token: options.world.deploymentAdministratorToken,
    ...(options.credential === null ? {} : { input: `${options.credential}\n` }),
  }), `model publish ${options.name}`);
  return {
    model_profile_id: String(published['model_profile_id']),
    model_profile_version: Number(published['model_profile_version']),
    content_hash: String(published['content_hash']),
    credential: options.credential,
  };
}

async function evaluateProfile(
  world: ChannelWorld,
  profileId: string,
  version: number,
): Promise<Record<string, unknown>> {
  const evaluated = await commandAsync(
    world,
    ['model', 'evaluate', '--profile', profileId, '--version', String(version)],
    { token: world.deploymentAdministratorToken },
  );
  return ok(evaluated as unknown as OperatorResult, 'model evaluate');
}

function failedChecks(evaluation: Record<string, unknown>): string[] {
  return asArray(evaluation['checks'])
    .map((check) => asRecord(check))
    .filter((check) => check['passed'] !== true)
    .map((check) => String(check['name']));
}

/**
 * Certifies every shipped adapter against the controllable local endpoint:
 * three consecutive evaluated runs per provider profile, then deliberate
 * adverse endpoints that must be refused rather than repaired.
 */
async function adapterConformance(
  world: ChannelWorld,
  endpoint: MockModelEndpoint,
): Promise<{
  adapters: AdapterResult[];
  models: Array<Record<string, unknown>>;
  activation: Record<string, unknown>;
  redactionSample: { profile_id: string; credential: string; endpoint_url: string };
}> {
  const adapters: AdapterResult[] = [];
  const models: Array<Record<string, unknown>> = [];
  let localActivation: Record<string, unknown> | null = null;
  let redactionSample: { profile_id: string; credential: string; endpoint_url: string } | null = null;
  for (const provider of PROVIDER_PROFILES) {
    const purposes = provider.key === 'local-generic' ? LOCAL_PURPOSES : PURPOSES;
    const categories = provider.key === 'local-generic'
      ? [...DATA_CATEGORIES, 'product_contract']
      : [...DATA_CATEGORIES];
    // A native provider needs its credential; the local contract adapter does not.
    const credential = provider.adapter === 'generic_local'
      ? null
      : `certification-credential-${provider.key}`;
    const published = await publishProfile({
      world,
      name: provider.name,
      adapter: provider.adapter,
      endpointUrl: endpoint.url,
      purposes,
      categories,
      credential,
      tools: ['read_data_dictionary', 'read_governed_result'],
    });
    if (provider.key === 'alibaba-qwen') {
      redactionSample = {
        profile_id: published.model_profile_id,
        credential: String(credential),
        endpoint_url: endpoint.url,
      };
    }
    models.push({
      provider: provider.key,
      name: provider.name,
      adapter: provider.adapter,
      model_id: MOCK_MODEL_ID,
      purposes: [...purposes],
      data_categories: categories,
      endpoint_class: 'controllable-local-fixture',
      credential_ref: credential === null ? null : 'profile-credential-stored',
      has_credential: credential !== null,
      content_hash: published.content_hash,
      model_profile_id: published.model_profile_id,
      model_profile_version: published.model_profile_version,
    });

    const runs: AdapterResult['runs'] = [];
    for (let run = 1; run <= 3; run += 1) {
      const evaluation = await evaluateProfile(world, published.model_profile_id, published.model_profile_version);
      const budget = asRecord(evaluation['budget'] ?? {});
      runs.push({
        run,
        passed: evaluation['passed'] === true,
        checks: asArray(evaluation['checks']).map((check) => {
          const record = asRecord(check);
          return { name: String(record['name']), passed: record['passed'] === true };
        }),
        evidence_hash: String(evaluation['evidence_hash']),
        budget: { consumption_cny: budget['consumption_cny'], ceiling_cny: budget['ceiling_cny'], met: budget['met'] },
      });
    }
    const consecutive = runs.every((run) => run.passed) ? runs.length : 0;
    // Activation reads the Version's latest evaluation, so it happens while the
    // three certified runs are still the newest evidence.
    const activated = ok(command(world, [
      'model', 'activate', '--profile', published.model_profile_id, '--version', String(published.model_profile_version),
    ], { token: world.deploymentAdministratorToken }), `model activate ${provider.key}`);
    if (provider.key === 'local-generic') localActivation = activated;

    // Every shipped adapter also clears a Workspace Model Binding preflight for
    // the purposes it was certified against, Chinese narration and clarification
    // included.
    const bound = ok(await commandAsync(world, [
      'binding', 'publish',
      '--workspace', world.workspaceId,
      '--profile', published.model_profile_id,
      '--config', jsonFile(world, `certification-binding-${provider.key}`, {
        model_profile_version: published.model_profile_version,
        purposes: [...purposes],
        data_categories: [...categories],
      }),
    ], { token: world.workspaceAdministratorToken }) as unknown as OperatorResult, `binding publish ${provider.key}`);
    const preflight = asRecord(bound['preflight'] ?? {});
    const bindingChecks = asArray(preflight['checks']).map((check) => {
      const record = asRecord(check);
      return { name: String(record['name']), passed: record['passed'] === true };
    });

    adapters.push({
      provider: provider.key,
      label: provider.name,
      adapter: provider.adapter,
      model_id: MOCK_MODEL_ID,
      purposes: [...purposes],
      model_profile_id: published.model_profile_id,
      runs,
      consecutive_passes: consecutive,
      passed: consecutive === 3,
      binding: {
        passed: preflight['passed'] === true && bindingChecks.every((check) => check.passed),
        checks: bindingChecks,
        evidence_hash: String(preflight['evidence_hash']),
      },
      adverse: [],
    });
  }

  // Deliberately incompatible endpoints must be refused, never repaired. One
  // adverse family per shipped adapter keeps the run exact and representative.
  for (const adapter of adapters) {
    const behaviour = ADVERSE_BEHAVIOURS[adapter.adapter];
    if (behaviour === undefined) continue;
    endpoint.behaviour = behaviour;
    const adverse = await evaluateProfile(world, adapter.model_profile_id, 1);
    adapter.adverse.push({
      behaviour,
      refused: adverse['passed'] !== true && failedChecks(adverse).length > 0,
      failed_checks: failedChecks(adverse),
    });
  }
  endpoint.behaviour = 'normal';

  return {
    adapters,
    models,
    activation: {
      provider: 'local-generic',
      activated_version: localActivation!['activated_version'],
      evaluation_hash: localActivation!['evaluation_hash'],
      content_hash: localActivation!['content_hash'],
    },
    redactionSample: redactionSample!,
  };
}

/** Every numeric token a reader could take as a fact, normalized for comparison. */
function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/gu) ?? []).map((token) => String(Number(token)));
}

function scenario(name: string, area: string, run: () => Record<string, unknown>): Scenario {
  try {
    const detail = run();
    return { name, area, passed: true, detail };
  } catch (error) {
    return {
      name,
      area,
      passed: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Hosted real-model suites. They can only run against endpoints an Operator
 * supplies; when none is configured the result is recorded as not_configured,
 * never as a pass, and the certification stays visibly incomplete.
 */
async function realModelSuites(
  world: ChannelWorld,
  options: CertificationOptions,
): Promise<RealModelResult[]> {
  const results: RealModelResult[] = [];
  for (const provider of ['alibaba-qwen', 'deepseek', 'openai-compatible'] as const) {
    const adapter = REAL_MODEL_ADAPTERS[provider];
    const configured = options.realModels?.[provider] ?? configuredRealModel(provider);
    if (configured === null) {
      results.push({
        provider,
        adapter,
        model_id: null,
        status: 'not_configured',
        runs: [],
        reason: 'The operator supplied no hosted endpoint, so no real-model run was attempted.',
      });
      continue;
    }
    const runs: Array<{ run: number; passed: boolean }> = [];
    try {
      const published = await publishProfile({
        world,
        name: `${provider} 真实模型`,
        adapter,
        endpointUrl: configured.endpoint_url,
        modelId: configured.model_id,
        purposes: PURPOSES,
        categories: DATA_CATEGORIES,
        credential: configured.credential ?? null,
        tools: ['read_data_dictionary', 'read_governed_result'],
      });
      for (let run = 1; run <= 3; run += 1) {
        const evaluation = await evaluateProfile(world, published.model_profile_id, published.model_profile_version);
        runs.push({ run, passed: evaluation['passed'] === true });
      }
      const allPassed = runs.every((run) => run.passed);
      results.push({
        provider,
        adapter,
        model_id: configured.model_id,
        status: allPassed ? 'passed' : 'failed',
        runs,
        reason: allPassed ? null : 'A consecutive real-model run did not pass its rubric.',
      });
    } catch (error) {
      results.push({
        provider,
        adapter,
        model_id: configured.model_id,
        status: 'failed',
        runs,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function configuredRealModel(
  provider: RealProviderKey,
): { endpoint_url: string; model_id: string; credential?: string } | null {
  const raw = process.env[REAL_MODEL_ENV[provider]];
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['endpoint_url'] !== 'string' || typeof parsed['model_id'] !== 'string') return null;
    return {
      endpoint_url: parsed['endpoint_url'],
      model_id: parsed['model_id'],
      ...(typeof parsed['credential'] === 'string' ? { credential: parsed['credential'] } : {}),
    };
  } catch {
    return null;
  }
}

interface BundleFile {
  path: string;
  sha256: string;
}

/** The exact identity and payload inventory one delivered channel carries. */
function bundleIdentity(
  channel: string,
  directory: string,
): {
  channel: string;
  release: string;
  architecture: string;
  manifest_sha256: string;
  signature_sha256: string;
  license_verification_key_id: string;
  files: BundleFile[];
  images: Array<{ name: string; archive: string; digest: string }>;
  embedding_assets: BundleFile[];
  installable: boolean;
} {
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const files = asArray(manifest['files']).map((file) => {
    const record = asRecord(file);
    return { path: String(record['path']), sha256: String(record['sha256']) };
  });
  return {
    channel,
    release: String(manifest['release']),
    architecture: String(manifest['architecture']),
    manifest_sha256: sha256File(manifestPath),
    signature_sha256: sha256File(join(directory, 'manifest.sig')),
    license_verification_key_id: String(asRecord(manifest['license_verification'])['key_id']),
    files,
    images: asArray(manifest['images']).map((image) => {
      const record = asRecord(image);
      return { name: String(record['name']), archive: String(record['archive']), digest: String(record['digest']) };
    }),
    embedding_assets: files.filter((file) => file.path.startsWith('embeddings/')),
    installable: asRecord(manifest['support'])['installable'] === true,
  };
}

function scenarioSuite(name: string, scenarios: Scenario[]): Record<string, unknown> {
  return {
    name,
    passed: scenarios.every((scenario) => scenario.passed),
    passed_count: scenarios.filter((scenario) => scenario.passed).length,
    total_count: scenarios.length,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      area: scenario.area,
      passed: scenario.passed,
      detail: scenario.detail,
    })),
  };
}

/**
 * Fails closed: the certification is certified only when every suite, every
 * three-run adapter sequence, every adverse refusal, the disconnected proof,
 * the Chinese UI pass, and the recovery drills all passed. A real-model suite
 * with no operator endpoint is an explicit blocker, not a silent pass.
 */
export function assessCertification(evidence: Record<string, unknown>): {
  outcome: 'certified' | 'incomplete';
  certified: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  const lifecycle = asRecord(evidence['lifecycle'] ?? {});
  if (lifecycle['identical'] !== true) blockers.push('lifecycle:channels_differ');
  for (const channel of asArray(lifecycle['channels']).map((entry) => asRecord(entry))) {
    if (channel['passed'] !== true) blockers.push(`lifecycle.${String(channel['name'])}:failed`);
  }
  for (const suite of asArray(evidence['suites']).map((entry) => asRecord(entry))) {
    if (suite['passed'] !== true) blockers.push(`suite.${String(suite['name'])}:failed`);
  }
  for (const adapter of asArray(evidence['adapters']).map((entry) => asRecord(entry))) {
    const provider = String(adapter['provider']);
    if (adapter['passed'] !== true || adapter['consecutive_passes'] !== 3) {
      blockers.push(`adapter.${provider}:not_three_consecutive_passes`);
    }
    for (const adverse of asArray(adapter['adverse']).map((entry) => asRecord(entry))) {
      if (adverse['refused'] !== true) blockers.push(`adapter.${provider}:accepted_${String(adverse['behaviour'])}`);
    }
  }
  for (const real of asArray(evidence['real_models']).map((entry) => asRecord(entry))) {
    if (real['status'] !== 'passed') blockers.push(`real_model.${String(real['provider'])}:${String(real['status'])}`);
  }
  const disconnected = asRecord(evidence['disconnected'] ?? {});
  if (disconnected['egress_blocked'] !== true) blockers.push('disconnected:egress_not_blocked');
  if (disconnected['egress_attempts'] !== 0) blockers.push('disconnected:egress_attempted');
  if (disconnected['local_generation'] !== true) blockers.push('disconnected:local_generation_failed');
  if (disconnected['offline_license'] !== true) blockers.push('disconnected:offline_license_failed');
  if (disconnected['bundled_embeddings'] !== true) blockers.push('disconnected:bundled_embeddings_missing');
  if (disconnected['rollback_without_media'] !== true) blockers.push('disconnected:rollback_requires_media');
  if (disconnected['recovery'] !== true) blockers.push('disconnected:recovery_failed');
  const chinese = asRecord(evidence['chinese_ui'] ?? {});
  if (chinese['passed'] !== true) blockers.push('chinese_ui:failed');
  for (const surface of asArray(chinese['surfaces']).map((entry) => asRecord(entry))) {
    if (surface['passed'] !== true) blockers.push(`chinese_ui.${String(surface['surface'])}:failed`);
  }
  if (chinese['api_contract_unchanged'] !== true) blockers.push('chinese_ui:api_contract_changed');
  const recovery = asRecord(evidence['recovery'] ?? {});
  if (recovery['passed'] !== true) blockers.push('recovery:failed');
  return {
    outcome: blockers.length === 0 ? 'certified' : 'incomplete',
    certified: blockers.length === 0,
    blockers,
  };
}

/**
 * Runs the whole release certification over one signed Release Bundle and
 * writes the signed evidence manifest. Nothing here is measured by estimate:
 * every value is read back from the Operator CLI, the console, or the browser.
 */
export async function certifyRelease(options: CertificationOptions = {}): Promise<CertificationRun> {
  const scratch = options.scratchDirectory ?? mkdtempSync(join(tmpdir(), 'dc-release-certification-'));
  mkdirSync(scratch, { recursive: true });
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const base = createBundleFixture(join(scratch, 'vendor-bundle-0.1.0'), { release: RELEASE });
  const next = createBundleFixture(join(scratch, 'vendor-bundle-0.2.0'), {
    release: NEXT_RELEASE,
    upgradeFrom: [RELEASE],
    releaseKeys: { publicKeyPem: base.releasePublicKeyPem, privateKey: base.releasePrivateKey },
    licenseKeys: { publicKeyPem: base.licensePublicKeyPem, privateKey: base.licensePrivateKey },
  });
  const connectedScratch = join(scratch, 'connected');
  const removableScratch = join(scratch, 'removable');
  mkdirSync(connectedScratch, { recursive: true });
  mkdirSync(removableScratch, { recursive: true });
  const mediaBase = join(removableScratch, 'media-0.1.0');
  const mediaNext = join(removableScratch, 'media-0.2.0');
  cpSync(base.directory, mediaBase, { recursive: true });
  cpSync(next.directory, mediaNext, { recursive: true });
  const guard = blockedEgressEnvironment(join(removableScratch, 'egress'));

  const connectedProvision = provisionChannel({
    name: 'connected-download',
    bundle: base,
    bundlePath: base.directory,
    scratch: connectedScratch,
    egress: null,
  });
  const removableProvision = provisionChannel({
    name: 'removable-media',
    bundle: base,
    bundlePath: mediaBase,
    scratch: removableScratch,
    egress: guard,
  });

  const connectedObservations = runLifecycle({
    world: connectedProvision.world,
    nextBundle: next,
    upgradeBundlePath: next.directory,
    install: connectedProvision.install,
    license: connectedProvision.license,
    initialize: connectedProvision.initialize,
  });
  const removableObservations = runLifecycle({
    world: removableProvision.world,
    nextBundle: next,
    upgradeBundlePath: mediaNext,
    install: removableProvision.install,
    license: removableProvision.license,
    initialize: removableProvision.initialize,
  });
  const lifecycleIdentical = canonicalEquals(connectedObservations, removableObservations);

  const endpoint = await startMockModelEndpoint();
  let adapterResults: AdapterResult[] = [];
  let models: Array<Record<string, unknown>> = [];
  let activation: Record<string, unknown> = {};
  let redactionSample: { profile_id: string; credential: string; endpoint_url: string } | null = null;
  let nlScenarios: Scenario[] = [];
  let binding: Record<string, unknown> = {};
  let realModels: RealModelResult[] = [];
  try {
    const adapterInfo = await adapterConformance(removableProvision.world, endpoint);
    adapterResults = adapterInfo.adapters;
    models = adapterInfo.models;
    activation = adapterInfo.activation;
    redactionSample = adapterInfo.redactionSample;
    const natural = await naturalLanguageScenarios(
      removableProvision.world,
      endpoint,
      adapterInfo.adapters.find((adapter) => adapter.provider === 'local-generic')!.model_profile_id,
    );
    nlScenarios = natural.scenarios;
    binding = natural.binding;
    // Hosted endpoints are only reachable from the connected Deployment; the
    // disconnected channel stays behind its egress guard.
    realModels = await realModelSuites(connectedProvision.world, options);
  } finally {
    await endpoint.close();
  }

  const governed = governedScenarios(removableProvision.world, redactionSample!);
  const connectedReadBefore = readProjection(connectedProvision.world);
  const ui = options.ui === false
    ? {
        browser: 'none',
        surfaces: [] as UiSurfaceResult[],
        pages: 0,
        passed: false,
      }
    : await chineseUiSmoke(connectedProvision.world, 'chrome');
  const connectedReadAfter = readProjection(connectedProvision.world);
  const apiContractUnchanged = canonicalEquals(connectedReadBefore, connectedReadAfter);

  const usage = ok(command(removableProvision.world, ['operations', 'usage']), 'operations usage');
  const connectedUsage = ok(command(connectedProvision.world, ['operations', 'usage']), 'connected operations usage');
  const totals = asRecord(usage['totals'] ?? {});
  const connectedTotals = asRecord(connectedUsage['totals'] ?? {});
  const byClass = asRecord(usage['by_class'] ?? {});
  const classSummary = (name: string): Record<string, unknown> => {
    const entry = asRecord(byClass[name] ?? {});
    return {
      generations: entry['generations'],
      operations: entry['operations'],
      input_tokens: entry['input_tokens'],
      output_tokens: entry['output_tokens'],
      cost_cny: entry['cost_cny'],
      average_cost_cny: entry['average_cost_cny'],
      average_cost_ceiling_cny: entry['average_cost_ceiling_cny'],
      met: entry['met'],
    };
  };
  const usageSummary = {
    totals: {
      generations: totals['generations'],
      operations: totals['operations'],
      input_tokens: totals['input_tokens'],
      output_tokens: totals['output_tokens'],
      cost_cny: totals['cost_cny'],
      refused_generations: totals['refused_generations'],
      estimated_generations: totals['estimated_generations'],
    },
    connected_totals: {
      generations: connectedTotals['generations'],
      operations: connectedTotals['operations'],
      input_tokens: connectedTotals['input_tokens'],
      output_tokens: connectedTotals['output_tokens'],
      cost_cny: connectedTotals['cost_cny'],
      refused_generations: connectedTotals['refused_generations'],
      estimated_generations: connectedTotals['estimated_generations'],
    },
    prices: usage['prices'],
    by_class: {
      nlq: classSummary('nlq'),
      report: classSummary('report'),
      artifact: classSummary('artifact'),
    },
  };

  const connectedBackupVerify = asRecord(connectedObservations['backup_verify'] ?? {});
  const connectedRestore = asRecord(connectedObservations['restore'] ?? {});
  const recoveryChecks = {
    backup_integrity: connectedBackupVerify['verified'] === true,
    isolated_restoration: connectedRestore['state'] === 'verified_open'
      && connectedRestore['service_open'] === true
      && connectedRestore['workers_enabled'] === false
      && connectedRestore['connectivity_enabled'] === false,
  };
  const recoveryScenarios: Scenario[] = [
    { name: 'backup_integrity', area: 'recovery', passed: recoveryChecks.backup_integrity, detail: { verify: connectedBackupVerify } },
    { name: 'isolated_restoration', area: 'recovery', passed: recoveryChecks.isolated_restoration, detail: { restore: connectedRestore } },
  ];

  const uiScenarios: Scenario[] = ui.surfaces.map((surface) => ({
    name: `chinese_${surface.surface.toLowerCase().replace(/\s+/gu, '_')}`,
    area: 'chinese_ui',
    passed: surface.passed,
    detail: {
      pages: surface.pages.map((page) => ({ heading: page.heading, passed: page.passed })),
      copy_leaks: surface.pages.reduce((total, page) => total + page.copy_leaks.length, 0),
      contrast_failures: surface.pages.reduce((total, page) => total + page.contrast_failures.length, 0),
      unlabeled_controls: surface.pages.reduce((total, page) => total + page.unlabeled_controls.length, 0),
    },
  }));

  const adaptersPassed = adapterResults.filter((adapter) => adapter.passed).length;
  const egressAttempts = recordedEgressAttempts(guard.logPath);
  const connectedIdentity = bundleIdentity('connected-download', base.directory);
  const mediaIdentity = bundleIdentity('removable-media', mediaBase);
  const embeddingsAsset = mediaIdentity.embedding_assets[0];
  const embeddingsContent = embeddingsAsset === undefined
    ? null
    : JSON.parse(readFileSync(join(mediaBase, embeddingsAsset.path), 'utf8')) as unknown;

  const disconnected = {
    egress_blocked: true,
    egress_policy: 'every non-loopback connection is refused and recorded',
    egress_attempts: egressAttempts.length,
    egress_destinations: egressAttempts,
    required_vendor_egress: 0,
    local_generation: adapterResults.find((adapter) => adapter.provider === 'local-generic')?.passed === true,
    offline_license: removableProvision.license['state'] === 'ready_to_initialize',
    signed_media_installation: removableProvision.install['release'] === RELEASE,
    bundled_embeddings: embeddingsAsset !== undefined,
    rollback_without_media: asRecord(removableObservations['rollback'] ?? {})['offline'] === true,
    upgrade_offline: asRecord(removableObservations['upgrade'] ?? {})['to_release'] === NEXT_RELEASE,
    recovery: asRecord(removableObservations['restore'] ?? {})['state'] === 'verified_open',
  };

  const evidenceWithoutOutcome: Record<string, unknown> = {
    schema_version: 1,
    kind: 'release_certification',
    generated_at: generatedAt,
    parameters: {
      certification_scope: 'representative-scaled',
      lifecycle: {
        channels: ['connected-download', 'removable-media'],
        from_release: RELEASE,
        to_release: NEXT_RELEASE,
        rollback_without_delivered_media: true,
      },
      mock_llm: {
        endpoint: 'controllable-local-fixture',
        runs_per_profile: 3,
        provider_profiles: PROVIDER_PROFILES.map((profile) => profile.key),
        model_id: MOCK_MODEL_ID,
      },
      real_models: {
        source: 'operator-supplied environment',
        providers: ['alibaba-qwen', 'deepseek', 'openai-compatible'],
        runs_per_provider: 3,
      },
      natural_language: { turns: 7, language: 'zh-CN' },
      chinese_ui: { browser: ui.browser, surfaces: 4, locale: 'zh-CN' },
      disconnected: { egress_block: 'non-loopback connections refused', channels: 1 },
    },
    environment: {
      architecture: process.arch,
      platform: process.platform,
      node: process.version,
      locale: 'zh-CN',
      mock_model_id: MOCK_MODEL_ID,
      disconnected_egress_blocked: true,
    },
    release: {
      release: connectedIdentity.release,
      next_release: NEXT_RELEASE,
      release_key_fingerprint: base.releaseFingerprint,
      license_verification_key_id: connectedIdentity.license_verification_key_id,
      next_release_key_fingerprint: next.releaseFingerprint,
      channels: [connectedIdentity, mediaIdentity],
      identical_content: connectedIdentity.manifest_sha256 === mediaIdentity.manifest_sha256
        && connectedIdentity.signature_sha256 === mediaIdentity.signature_sha256
        && canonicalEquals(connectedIdentity.files, mediaIdentity.files)
        && canonicalEquals(connectedIdentity.images, mediaIdentity.images),
      bundled_embeddings: {
        asset: embeddingsAsset ?? null,
        content: embeddingsContent,
        platform_local_configuration: LOCAL_EMBEDDING_CONFIGURATION,
      },
    },
    lifecycle: {
      identical: lifecycleIdentical,
      channels: [
        { name: 'connected-download', passed: true, observations: connectedObservations },
        { name: 'removable-media', passed: true, observations: removableObservations },
      ],
    },
    workloads: [
      {
        name: 'governed-ledger',
        kind: 'reference-fixture',
        workspace: WORKSPACE_NAME,
        product: PRODUCT_NAME,
        records: 3,
        source_type: 'file',
      },
      {
        name: 'chinese-natural-language',
        kind: 'deterministic-mock-llm',
        turns: 7,
        adapter: 'generic_local',
      },
    ],
    suites: [
      scenarioSuite('governed_correctness', governed),
      scenarioSuite('natural_language_chinese', nlScenarios),
      scenarioSuite('recovery', recoveryScenarios),
      scenarioSuite('chinese_ui', uiScenarios),
    ],
    adapters: adapterResults,
    adapter_summary: {
      shipped_adapters: [...MODEL_ADAPTERS],
      certified_profiles: PROVIDER_PROFILES.map((profile) => profile.key),
      profiles_passed: adaptersPassed,
      profiles_total: adapterResults.length,
      runs_per_profile: 3,
      consecutive_rule: 'three consecutive evaluated runs must pass',
      activation,
      model_binding: binding,
    },
    models,
    real_models: realModels,
    services: {
      health: asRecord(connectedObservations['status_before_upgrade'] ?? {})['health'],
      runtime_services: asRecord(connectedObservations['status_before_upgrade'] ?? {})['runtime_services'],
      stores: asRecord(asRecord(connectedObservations['verify_after_upgrade'] ?? {})['checks'] ?? {})['stores'] === true
        ? ['minio', 'postgres']
        : null,
      verify_checks: asRecord(connectedObservations['verify_after_upgrade'] ?? {})['checks'],
    },
    recovery: {
      passed: recoveryChecks.backup_integrity && recoveryChecks.isolated_restoration,
      backup: connectedObservations['backup'],
      verification: connectedBackupVerify,
      restoration: connectedRestore,
      restored_read: connectedObservations['restored_read'],
    },
    disconnected,
    usage: usageSummary,
    chinese_ui: {
      browser: ui.browser,
      gate: 'Simplified Chinese UI gate shared with #55 (copy, contrast, labels, document language)',
      pages: ui.pages,
      passed: ui.passed,
      surfaces: ui.surfaces.map((surface) => ({
        surface: surface.surface,
        pages: surface.pages.length,
        passed: surface.passed,
        copy_leaks: surface.pages.reduce((total, page) => total + page.copy_leaks.length, 0),
        contrast_failures: surface.pages.reduce((total, page) => total + page.contrast_failures.length, 0),
        unlabeled_controls: surface.pages.reduce((total, page) => total + page.unlabeled_controls.length, 0),
        failures: surface.pages.flatMap((page) => page.failures),
      })),
      api_contract_unchanged: apiContractUnchanged,
    },
  };
  const assessment = assessCertification(evidenceWithoutOutcome);
  const body = {
    ...evidenceWithoutOutcome,
    outcome: assessment.outcome,
    certified: assessment.certified,
    blockers: assessment.blockers,
  };
  const written = writeEvidenceManifest({
    directory: join(scratch, 'evidence'),
    body,
    privateKey: base.releasePrivateKey,
    keyId: base.releaseFingerprint,
  });
  return {
    manifestPath: written.manifestPath,
    signaturePath: written.signaturePath,
    digest: written.digest,
    manifest: body,
    bundle: base,
    scratch,
    verify(): boolean {
      return verifySignature(written, base.releasePublicKeyPath);
    },
  };
}

function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function scenarioAsync(
  name: string,
  area: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Scenario> {
  try {
    const detail = await run();
    return { name, area, passed: true, detail };
  } catch (error) {
    return {
      name,
      area,
      passed: false,
      detail: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function verifySignature(written: WrittenEvidence, publicKeyPath: string): boolean {
  return verifyEvidenceManifest({
    manifestPath: written.manifestPath,
    signaturePath: written.signaturePath,
    publicKeyPath,
  }).valid;
}


/**
 * The governed correctness scenarios: exact numbers, typed filters, Releases,
 * isolation, redaction, Provenance, and audit. Each one runs through the same
 * Consumer CLI a real reader uses.
 */
function governedScenarios(
  world: ChannelWorld,
  redactionSample: { profile_id: string; credential: string; endpoint_url: string },
): Scenario[] {
  const recordsRequest = (): string => requestFile(world, { kind: 'records', limit: 10 });
  return [
    scenario('numeric_correctness', 'governed', () => {
      const records = ok(command(world, [
        'product', 'query', '--product', world.dataProductId, '--request', recordsRequest(),
      ], { token: world.consumerToken }), 'records query');
      const aggregate = ok(command(world, [
        'product', 'query', '--product', world.dataProductId,
        '--request', requestFile(world, {
          kind: 'aggregate',
          metrics: ['device_count', 'handled_total', 'settled_total'],
          include_totals: true,
        }),
      ], { token: world.consumerToken }), 'aggregate query');
      const totals = asRecord(aggregate['totals'])['metrics'];
      assert.deepEqual(records['records'], LEDGER_ORACLE.records);
      assert.deepEqual(totals, LEDGER_ORACLE.totals);
      assert.equal(records['matched_count'], 3);
      return { totals, returned: records['returned'], matched_count: records['matched_count'] };
    }),
    scenario('typed_filters', 'governed', () => {
      const filtered = ok(command(world, [
        'product', 'query', '--product', world.dataProductId,
        '--request', requestFile(world, {
          kind: 'records',
          filters: [{ field: 'city', op: 'equals', value: '上海' }],
        }),
      ], { token: world.consumerToken }), 'filtered query');
      assert.deepEqual(filtered['records'], [LEDGER_ORACLE.records[1]]);
      const mistyped = command(world, [
        'product', 'query', '--product', world.dataProductId,
        '--request', requestFile(world, {
          kind: 'records',
          filters: [{ field: 'city', op: 'equals', value: 5 }],
        }),
      ], { token: world.consumerToken });
      assert.equal(mistyped.status, 2);
      assert.equal(mistyped.error['code'], 'DATA_PRODUCT_QUERY_REFUSED');
      return {
        filtered_returned: filtered['returned'],
        filtered_cities: asArray(filtered['records']).map((record) => asRecord(record)['city']),
        mistyped_error: mistyped.error['code'],
      };
    }),
    scenario('release_pinning', 'governed', () => {
      const listed = ok(command(world, ['product', 'releases', '--product', world.dataProductId], {
        token: world.consumerToken,
      }), 'releases list');
      const lines = asArray(listed['lines']).map((line) => asRecord(line));
      const releases = asArray(listed['releases']).map((release) => asRecord(release));
      assert.equal(lines.length, 1);
      assert.equal(lines[0]?.['current_release'], 1);
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.['dataset_release'], 1);
      assert.equal(releases[0]?.['current'], true);
      assert.equal(releases[0]?.['withdrawn'], false);
      const read = ok(command(world, [
        'product', 'query', '--product', world.dataProductId, '--request', recordsRequest(),
      ], { token: world.consumerToken }), 'release-pinned read');
      assert.equal(asRecord(read['provenance'])['dataset_release'], 1);
      return {
        release_lines: lines.length,
        current_release: lines[0]?.['current_release'],
        dataset_release: releases[0]?.['dataset_release'],
        withdrawn: releases[0]?.['withdrawn'],
        read_dataset_release: asRecord(read['provenance'])['dataset_release'],
      };
    }),
    scenario('workspace_isolation', 'governed', () => {
      createUser(world, world.deploymentAdministratorToken, OUTSIDER, OUTSIDER_PASSWORD);
      createWorkspace(world, world.deploymentAdministratorToken, '隔离工作区', OUTSIDER);
      const outsiderToken = sessionFor(world, OUTSIDER, OUTSIDER_PASSWORD);
      const foreign = command(world, [
        'product', 'query', '--product', world.dataProductId, '--request', recordsRequest(),
      ], { token: outsiderToken });
      const absent = command(world, [
        'product', 'query', '--product', '00000000-0000-4000-8000-000000000000',
        '--request', recordsRequest(),
      ], { token: outsiderToken });
      assert.equal(foreign.status, 2);
      assert.equal(absent.status, 2);
      assert.deepEqual(foreign.error, absent.error);
      return {
        foreign_error: foreign.error['code'],
        absent_error: absent.error['code'],
        indistinguishable: true,
      };
    }),
    scenario('redaction', 'governed', () => {
      const shown = ok(command(world, ['model', 'show', '--profile', redactionSample.profile_id], {
        token: world.deploymentAdministratorToken,
      }), 'model profile read');
      const profileText = JSON.stringify(shown);
      assert.equal(profileText.includes(redactionSample.credential), false, 'the profile discloses its credential');
      assert.equal(profileText.includes(redactionSample.endpoint_url), false, 'the profile discloses its endpoint');
      assert.equal(asRecord(asArray(shown['versions'])[0] ?? {})['has_credential'], true);
      const status = ok(command(world, ['status', '--operator', OPERATOR]), 'status');
      const evidenceText = readFileSync(
        join(world.root, 'evidence', `${String(status['evidence_id'])}.json`),
        'utf8',
      );
      const masterKeyBytes = readFileSync(world.masterKey);
      assert.equal(evidenceText.includes(world.masterKey), false);
      assert.equal(evidenceText.includes(masterKeyBytes.toString('hex')), false);
      assert.equal(evidenceText.includes('sn-001'), false, 'evidence carries business bytes');
      return {
        credential_hidden: true,
        endpoint_hidden: true,
        credential_ref_disclosed: true,
        evidence_redacted: true,
      };
    }),
    scenario('provenance', 'governed', () => {
      const read = ok(command(world, [
        'product', 'query', '--product', world.dataProductId, '--request', recordsRequest(),
      ], { token: world.consumerToken }), 'provenance read');
      const provenance = asRecord(read['provenance']);
      const source = asRecord(provenance['source']);
      assert.equal(source['name'], '设备台账');
      assert.equal(provenance['record_count'], 3);
      assert.equal(provenance['integration_configuration_version'], 1);
      const acquired = Date.parse(String(provenance['acquired_at']));
      const integrated = Date.parse(String(provenance['integrated_at']));
      const released = Date.parse(String(provenance['released_at']));
      assert.ok(acquired <= integrated && integrated <= released, 'Provenance times are ordered');
      assert.deepEqual(provenance['relationships'], []);
      return {
        source: source['name'],
        dataset_release: provenance['dataset_release'],
        integration_configuration_version: provenance['integration_configuration_version'],
        record_count: provenance['record_count'],
        times_ordered: true,
        relationships: provenance['relationships'],
      };
    }),
    scenario('audit', 'governed', () => {
      const listed = ok(command(world, ['audit', 'list', '--workspace', world.workspaceId], {
        token: world.deploymentAdministratorToken,
      }), 'audit list');
      assert.equal(listed['chain_valid'], true);
      const events = asArray(listed['events']).map((event) => asRecord(event));
      const queryEvents = events.filter((event) => event['action'] === 'data_product_query');
      assert.ok(queryEvents.length > 0, 'a governed read is audited');
      for (const event of queryEvents) {
        assert.equal(event['workspace_id'], world.workspaceId);
        assert.equal(typeof event['actor'], 'string');
      }
      const succeeded = queryEvents.filter((event) => event['outcome'] === 'succeeded');
      const refused = queryEvents.filter((event) => event['outcome'] === 'failed');
      assert.ok(succeeded.length > 0, 'a successful governed read is audited');
      assert.ok(refused.length > 0, 'a refused governed read is audited as a failure');
      assert.ok(events.every((event) => /^[0-9a-f]{64}$/u.test(String(event['hash']))));
      return {
        chain_valid: true,
        events: events.length,
        query_events: queryEvents.length,
        succeeded: succeeded.length,
        refused: refused.length,
        chained: true,
      };
    }),
  ];
}

/**
 * Chinese Natural-Language Query scenarios: a grounded answer, a Chinese
 * follow-up, partial and empty freshness, and the narrative rubric refusing
 * ungrounded prose. All run against the same deterministic mock endpoint.
 */
async function naturalLanguageScenarios(
  world: ChannelWorld,
  endpoint: MockModelEndpoint,
  localProfileId: string,
): Promise<{ scenarios: Scenario[]; binding: Record<string, unknown> }> {
  const bindingResult = await commandAsync(world, [
    'binding', 'publish',
    '--workspace', world.workspaceId,
    '--profile', localProfileId,
    '--config', jsonFile(world, 'certification-nlq-binding', {
      model_profile_version: 1,
      purposes: ['query_plan', 'grounded_narration', 'clarification'],
      data_categories: [...NLQ_CATEGORIES],
    }),
  ], { token: world.workspaceAdministratorToken });
  const binding = ok(bindingResult as unknown as OperatorResult, 'binding publish');

  const ask = async (question: string, extra: string[] = []): Promise<Record<string, unknown>> => {
    const result = await commandAsync(world, [
      'product', 'ask', '--product', world.dataProductId, '--question', question, ...extra,
    ], { token: world.consumerToken });
    return ok(result as unknown as OperatorResult, 'product ask');
  };

  let conversation: string | null = null;
  let firstAnswer: Record<string, unknown> | null = null;
  const scenarios: Scenario[] = [];
  scenarios.push(await scenarioAsync('chinese_question', 'natural_language', async () => {
    const answered = await ask('2026-01-01 至 2026-01-31 杭州的处理量合计是多少？');
    assert.equal(answered['outcome'], 'answered', JSON.stringify(answered['limitations']));
    assert.equal(answered['executed'], true);
    const answer = asRecord(answered['answer']);
    const narrative = String(answer['narrative'] ?? '');
    assert.match(narrative, /[\u4e00-\u9fff]{4}/u, 'the narrative is Chinese');
    const governed = new Set(numbersIn(JSON.stringify(answered['result'])));
    for (const token of numbersIn(narrative)) {
      assert.ok(governed.has(token), `the narrative number ${token} is governed`);
    }
    conversation = typeof answered['conversation'] === 'string' ? answered['conversation'] : null;
    firstAnswer = answered;
    return {
      outcome: answered['outcome'],
      executed: true,
      narrative,
      narrative_numbers_governed: true,
      conversation_handle: conversation !== null,
      limitations: answered['limitations'],
    };
  }));
  scenarios.push(await scenarioAsync('chinese_follow_up', 'natural_language', async () => {
    assert.ok(conversation !== null, 'the first answer issued a conversation handle');
    const followUp = await ask(
      '那 2026-01-01 至 2026-01-31 各城市的处理量合计是多少？',
      ['--conversation', conversation!],
    );
    assert.equal(followUp['outcome'], 'answered', JSON.stringify(followUp['limitations']));
    assert.equal(followUp['follow_up'], true);
    const narrative = String(asRecord(followUp['answer'])['narrative'] ?? '');
    assert.match(narrative, /[\u4e00-\u9fff]{4}/u);
    return {
      outcome: followUp['outcome'],
      follow_up: true,
      narrative,
      conversation_handle: true,
    };
  }));
  scenarios.push(await scenarioAsync('freshness_partial_and_empty', 'natural_language', async () => {
    const partial = await ask('2026-01-01 至 2026-02-28 杭州的处理量合计是多少？');
    assert.equal(partial['outcome'], 'answered');
    assert.equal(partial['partial_period'], true);
    const empty = await ask('2024-01-01 至 2024-01-31 杭州的处理量合计是多少？');
    assert.equal(empty['outcome'], 'empty');
    assert.equal(empty['executed'], true);
    assert.equal(asRecord(empty['result'])['groups_total'], 0);
    assert.equal(empty['answer'], null);
    return {
      partial_period: true,
      empty_outcome: empty['outcome'],
      empty_groups_total: asRecord(empty['result'])['groups_total'],
      empty_narrated: empty['answer'] !== null,
    };
  }));
  scenarios.push(await scenarioAsync('critical_grounding', 'natural_language', async () => {
    endpoint.behaviour = 'ungrounded_narration';
    try {
      const ungrounded = await ask('2026-01-01 至 2026-01-31 杭州的处理量合计是多少？');
      assert.equal(ungrounded['outcome'], 'answered');
      assert.equal(ungrounded['answer'], null);
      assert.equal(ungrounded['reason_code'], 'NARRATION_NOT_GROUNDED');
      assert.ok(ungrounded['result'] !== null, 'the deterministic answer still stands');
      endpoint.behaviour = 'fabricated_narration';
      const fabricated = await ask('2026-01-01 至 2026-01-31 杭州的处理量合计是多少？');
      assert.equal(fabricated['answer'], null);
      assert.equal(fabricated['reason_code'], 'NARRATIVE_NUMBER_NOT_GOVERNED');
      endpoint.behaviour = 'causal_narration';
      const causal = await ask('2026-01-01 至 2026-01-31 杭州的处理量合计是多少？');
      assert.equal(causal['answer'], null);
      assert.equal(causal['reason_code'], 'NARRATIVE_CAUSAL_CLAIM');
      return {
        ungrounded_narrative: 'NARRATION_NOT_GROUNDED',
        ungoverned_number: 'NARRATIVE_NUMBER_NOT_GOVERNED',
        causal_narrative: 'NARRATIVE_CAUSAL_CLAIM',
        grounded_result_preserved: true,
        first_turn_answered: firstAnswer !== null,
      };
    } finally {
      endpoint.behaviour = 'normal';
    }
  }));
  return {
    scenarios,
    binding: {
      binding_id: binding['binding_id'],
      model_profile_id: binding['model_profile_id'],
      purposes: binding['purposes'],
      data_categories: binding['data_categories'],
    },
  };
}

async function signInUser(page: Page, credentials: { username: string; password: string; totp?: string }): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  if (credentials.totp !== undefined) {
    await page.getByLabel('动态验证码', { exact: true }).fill(totpCode(credentials.totp));
  }
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/**
 * A real browser smoke over the four shipped surfaces. It reuses the #55
 * Simplified-Chinese gate on every page it opens and records each page result
 * instead of stopping at the first failure.
 */
async function chineseUiSmoke(
  world: ChannelWorld,
  browserChannel: 'chrome' | 'msedge',
): Promise<{ browser: string; surfaces: UiSurfaceResult[]; pages: number; passed: boolean }> {
  const consoleServer = await startConsole(world);
  let browser: Browser | undefined;
  const surfaces: UiSurfaceResult[] = [];
  async function surface(
    name: string,
    run: (open: (path: string) => Promise<Page>) => Promise<ChinesePageReport[]>,
  ): Promise<void> {
    const context = await browser!.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    try {
      const reports = await run(async (path) => {
        await page.goto(`${consoleServer.url}${path}`);
        return page;
      });
      surfaces.push({ surface: name, pages: reports, passed: reports.every((report) => report.passed) });
    } catch (error) {
      surfaces.push({
        surface: name,
        pages: [{
          heading: name,
          passed: false,
          copy_leaks: [],
          contrast_failures: [],
          unlabeled_controls: [],
          failures: [error instanceof Error ? error.message : String(error)],
        }],
        passed: false,
      });
    } finally {
      await context.close();
    }
  }
  try {
    browser = await chromium.launch({ channel: browserChannel, headless: true });

    await surface('Operator Console', async (open) => {
      const page = await open('/');
      await page.getByRole('heading', { name: '登录运维控制台' }).waitFor();
      const issued = command(world, ['console', 'enroll', '--operator', OPERATOR]);
      if (issued.status !== 0) throw new Error(issued.stderr);
      await page.goto(`${consoleServer.url}${String(issued.output['enrollment_path'])}`);
      await page.getByLabel('设置密码').fill(OPERATOR_PASSWORD);
      await page.getByLabel('确认密码').fill(OPERATOR_PASSWORD);
      await page.getByRole('button', { name: '登记并生成验证器' }).click();
      await page.getByRole('heading', { name: '验证器已生成' }).waitFor();
      const secret = /动态验证码密钥\s*\n+\s*([A-Z2-7]{16,})/u.exec(await page.locator('body').innerText())?.[1];
      if (secret === undefined) throw new Error('the Operator enrollment never showed its dynamic-code secret');
      await page.getByRole('button', { name: '前往登录' }).click();
      await page.getByLabel('运维账号').fill(OPERATOR);
      await page.getByLabel('密码').fill(OPERATOR_PASSWORD);
      await page.getByLabel('动态验证码').fill(totpCode(secret));
      await page.getByRole('button', { name: '登录' }).click();
      const reports = [await inspectChineseSurface(page, '运行状态')];
      for (const [link, heading] of [
        ['许可证与续期', '许可证与续期'],
        ['升级与应用回滚', '升级与应用回滚'],
      ] as const) {
        await page.getByRole('link', { name: link }).click();
        reports.push(await inspectChineseSurface(page, heading));
      }
      return reports;
    });

    await surface('Deployment Administrator', async (open) => {
      const page = await open('/app');
      await signInUser(page, {
        username: world.administrator.username,
        password: world.administrator.password,
        totp: world.administrator.totp_secret,
      });
      const reports = [await inspectChineseSurface(page, '工作区')];
      for (const [link, heading] of [
        ['用户与身份', '用户'],
        ['模型档案', '模型档案'],
        ['保留策略', '保留策略'],
        ['工作区', '工作区'],
      ] as const) {
        await page.getByRole('link', { name: link, exact: true }).click();
        reports.push(await inspectChineseSurface(page, heading));
      }
      return reports;
    });

    await surface('Workspace Administrator', async (open) => {
      const page = await open('/app');
      await signInUser(page, {
        username: OPERATIONS,
        password: OPERATIONS_PASSWORD,
        totp: totpSecretFor(world, OPERATIONS),
      });
      const reports = [await inspectChineseSurface(page, '工作区概览')];
      for (const [link, heading] of [
        ['数据来源', '数据来源'],
        ['抓取服务', '抓取服务'],
        ['数据产品', '数据产品'],
        ['自然语言问答', '自然语言问答'],
        ['报告', '报告库'],
        ['报告治理', '报告治理'],
        ['数据产品治理', '数据产品治理'],
        ['业务上下文', '业务上下文'],
        ['成员', '工作区成员'],
        ['代理授权', '代理授权'],
        ['审计', '审计事件'],
        ['模型绑定', '工作区模型绑定'],
        ['集成提案', '集成提案'],
        ['数据产品提案', '数据产品提案'],
        ['保留与清除', '保留与清除'],
        ['概览', '工作区概览'],
      ] as const) {
        await page.getByRole('link', { name: link, exact: true }).click();
        reports.push(await inspectChineseSurface(page, heading));
      }
      return reports;
    });

    await surface('Consumer', async (open) => {
      const page = await open('/app');
      await signInUser(page, { username: ANALYST, password: ANALYST_PASSWORD });
      const reports = [await inspectChineseSurface(page, '工作区概览')];
      await page.getByRole('link', { name: '数据产品', exact: true }).click();
      reports.push(await inspectChineseSurface(page, '数据产品'));

      // A refused query is a Chinese validation state, not English server prose.
      const row = page.getByRole('row').filter({ hasText: PRODUCT_NAME });
      await row.waitFor();
      await row.getByRole('button', { name: '浏览此产品' }).click();
      const workbench = page.getByRole('region', { name: '数据探索' });
      await workbench.getByLabel('记录时间起点', { exact: true }).fill('2026-02-10');
      await workbench.getByLabel('记录时间终点', { exact: true }).fill('2026-01-05');
      await workbench.getByRole('button', { name: '查询记录' }).click();
      await page.getByText('DATA_PRODUCT_QUERY_REFUSED').waitFor();
      const refusal = await page.getByRole('alert').innerText();
      if (!refusal.includes('查询被拒绝')) {
        throw new Error(`the refusal is not Chinese: ${refusal}`);
      }
      reports.push(await inspectChineseSurface(page, '数据产品'));

      for (const [link, heading] of [
        ['自然语言问答', '自然语言问答'],
        ['报告', '报告库'],
      ] as const) {
        await page.getByRole('link', { name: link, exact: true }).click();
        reports.push(await inspectChineseSurface(page, heading));
      }
      return reports;
    });
  } finally {
    await browser?.close();
    await consoleServer.stop();
  }
  const pages = surfaces.reduce((total, entry) => total + entry.pages.length, 0);
  return { browser: browserChannel, surfaces, pages, passed: surfaces.every((entry) => entry.passed) };
}
