import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
  type Actor,
} from './authz.js';
import {
  activeMajorLine,
  findDataProduct,
  findDataProductRelease,
  findDataProductVersion,
  findModelProfile,
  findModelProfileVersion,
  findReport,
  findReportTemplate,
  findReportTemplateVersion,
  ISO_DATE,
  majorLine,
  type DataProductArtifact,
  type DataProductContract,
  type DataProductRelease,
  type DataProductVersion,
  type DatasetSchemaField,
  type ModelProfileArtifact,
  type ModelProfileVersion,
  type ReportFreshnessPolicy,
  type ReportParameter,
  type ReportParameterType,
  type ReportRecord,
  type ReportTemplateArtifact,
  type ReportTemplateVersion,
  type WorkspaceModelBindingRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { classifyResult, freshnessOf, narrationFacts, narrativeViolation } from './governed-result.js';
import { memberReader, type GrantReader, type GrantScope } from './grants.js';
import { generateGroundedNarration, promptPinsSimplifiedChinese } from './model-generation.js';
import { pinnedForBinding } from './model-profile.js';
import { findUserById, workspaceRoleOf, type UserRecord, type WorkspaceRole } from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { readQuery, readQueryTarget } from './product-query-document.js';
import { isPastRetention, purgeRevoked, retentionExpiredMessage } from './retention.js';
import { openPlatform, type PlatformSession } from './session.js';

/** The most typed parameters one Report Template Version may pin. */
export const MAX_REPORT_PARAMETERS = 32;
/** The longest business question a Report Template may pin. */
export const MAX_REPORT_QUESTION_CHARS = 1024;
/** The longest grounded-answer prompt a Report Template may pin. */
export const MAX_REPORT_PROMPT_CHARS = 8192;
/** The default freshness policy when a Template states none. */
export const DEFAULT_REPORT_MAX_AGE_MINUTES = 15;
/** The longest freshness policy a Template may declare. */
export const MAX_REPORT_MAX_AGE_MINUTES = 525_600;

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;
const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const CHINESE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;
const PARAMETER_TYPES: ReportParameterType[] = ['date_window', 'date', 'integer', 'string'];

/** One refusal the Report path decides before or around the deterministic engine. */
export class ReportGenerationFailure extends Error {
  readonly code: string;
  readonly nextStep: string | undefined;

  constructor(code: string, message: string, nextStep?: string) {
    super(message);
    this.code = code;
    this.nextStep = nextStep;
  }
}

/** The Contract line and Dataset schema one Template Version pins and generates against. */
export interface ServingContract {
  major: number;
  version: DataProductVersion;
  release: DataProductRelease;
  contract: DataProductContract;
  schema: DatasetSchemaField[];
}

/** The narration model a Report may use, or the reason its narrative is absent. */
interface NarrationModel {
  binding: WorkspaceModelBindingRecord;
  profile: ModelProfileArtifact;
  version: ModelProfileVersion;
  pin: ReturnType<typeof pinnedForBinding>;
  promptHash: string;
}

function hasChinese(text: string): boolean {
  return CHINESE.test(text);
}

/**
 * Collapses the deterministic differences two renderings of the same Chinese
 * question may carry, without rewriting the business wording: full-width and
 * half-width forms unify first, then whitespace collapses. Nothing is stemmed,
 * translated, truncated, or guessed, so only exact normalized matches reuse.
 */
export function normalizeReportQuestion(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function groundedPromptHash(body: string): string {
  return canonicalDigest({ id: 'grounded_answer', body });
}

function copyParameter(parameter: ReportParameter): ReportParameter {
  return {
    name: parameter.name,
    type: parameter.type,
    value: parameter.type === 'date_window' && isRecord(parameter.value)
      ? { start: String(parameter.value['start']), end: String(parameter.value['end']) }
      : parameter.value,
  };
}

function copyParameters(parameters: ReportParameter[]): ReportParameter[] {
  return parameters.map(copyParameter);
}

function userNameOf(session: PlatformSession, userId: string): string | null {
  return findUserById(session.state, userId)?.username ?? null;
}

/** The Workspace role of the actor, or a closed denial. */
function memberRole(
  session: PlatformSession,
  actor: Actor,
  workspaceId: string,
  context: ActionContext,
): WorkspaceRole {
  const role = workspaceRoleOf(session.state, actor.user.user_id, workspaceId);
  if (role === null) {
    deny(session, actorLabel(actor.user), context, 'WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this actor.');
  }
  return role;
}

/** The active (or explicitly named) Contract line and the Dataset schema behind it. */
export function servingContract(
  session: PlatformSession,
  product: DataProductArtifact,
  major?: number,
): ServingContract | null {
  const line = major === undefined ? activeMajorLine(product) : majorLine(product, major);
  if (line === undefined || line.withdrawn_at !== null) return null;
  const version = findDataProductVersion(product, line.current_version);
  const release = findDataProductRelease(product, line.current_release);
  if (!version || !release) return null;
  if (version.withdrawn_at !== null) return null;
  const dataset = session.state.datasets.find((candidate) => candidate.dataset_id === release.dataset_id);
  const datasetRelease = dataset?.releases.find((candidate) => candidate.release === release.dataset_release);
  if (!dataset || !datasetRelease) return null;
  const schema = session.state.integration_configurations
    .find((artifact) => artifact.source_id === dataset.source_id)
    ?.versions.find((candidate) => candidate.version === datasetRelease.integration_configuration_version)
    ?.schema ?? [];
  return { major: line.major, version, release, contract: version.contract, schema };
}

function productReference(
  product: DataProductArtifact,
  version: DataProductVersion,
  release: DataProductRelease,
): ReportRecord['data_product'] {
  return {
    data_product_id: product.data_product_id,
    name: product.name,
    api_path: product.api_path,
    data_product_version: version.version,
    data_product_release: release.release,
    dataset_release: release.dataset_release,
    contract_version: { ...version.contract_version },
    contract_hash: version.contract_hash,
  };
}

function templateReference(template: ReportTemplateArtifact, version: ReportTemplateVersion): ReportRecord['template'] {
  return {
    report_template_id: template.report_template_id,
    name: template.name,
    version: version.version,
    content_hash: version.content_hash,
    owner_user_id: template.owner_user_id,
  };
}

function parameterValueValid(type: ReportParameterType, value: unknown): boolean {
  if (type === 'date_window') {
    return isRecord(value)
      && typeof value['start'] === 'string'
      && ISO_DATE.test(value['start'])
      && typeof value['end'] === 'string'
      && ISO_DATE.test(value['end'])
      && value['start'] <= value['end'];
  }
  if (type === 'date') return typeof value === 'string' && ISO_DATE.test(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
}

function readParameters(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
): ReportParameter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_REPORT_PARAMETERS) {
    reject(
      session,
      actor,
      context,
      'REPORT_TEMPLATE_PARAMETERS_INVALID',
      `A Report Template must state at most ${MAX_REPORT_PARAMETERS} typed parameters as an array.`,
    );
  }
  const parameters: ReportParameter[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate['name'] !== 'string' || !PARAMETER_NAME.test(candidate['name'])) {
      reject(
        session,
        actor,
        context,
        'REPORT_TEMPLATE_PARAMETERS_INVALID',
        'Each Report Template parameter must state a lower-case name.',
      );
    }
    const name = candidate['name'];
    if (parameters.some((parameter) => parameter.name === name)) {
      reject(session, actor, context, 'REPORT_TEMPLATE_PARAMETERS_INVALID', `The ${name} parameter is stated twice.`);
    }
    const type = candidate['type'] as ReportParameterType;
    if (!PARAMETER_TYPES.includes(type)) {
      reject(
        session,
        actor,
        context,
        'REPORT_TEMPLATE_PARAMETERS_INVALID',
        `Each Report Template parameter type must be one of: ${PARAMETER_TYPES.join(', ')}.`,
      );
    }
    if (!parameterValueValid(type, candidate['value'])) {
      reject(
        session,
        actor,
        context,
        'REPORT_TEMPLATE_PARAMETERS_INVALID',
        `The ${name} parameter must state a ${type} value.`,
      );
    }
    parameters.push({
      name,
      type,
      value: type === 'date_window'
        ? { start: String((candidate['value'] as Record<string, unknown>)['start']), end: String((candidate['value'] as Record<string, unknown>)['end']) }
        : candidate['value'] as string | number,
    });
  }
  return parameters;
}

/**
 * A parameter describes the same semantics the pinned query states: when both
 * name the same window or filter, they must agree, so a Template can never pin
 * a parameter that silently contradicts its own normalized query.
 */
function requireParameterConsistency(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  parameters: ReportParameter[],
  request: Record<string, unknown>,
): void {
  const window = isRecord(request['window']) ? request['window'] : null;
  const filters = Array.isArray(request['filters'])
    ? request['filters'].filter((filter): filter is Record<string, unknown> => isRecord(filter))
    : [];
  for (const parameter of parameters) {
    if (parameter.type === 'date_window'
      && window !== null
      && isRecord(parameter.value)
      && (window['start'] !== parameter.value['start'] || window['end'] !== parameter.value['end'])) {
      reject(
        session,
        actor,
        context,
        'REPORT_TEMPLATE_PARAMETERS_INCONSISTENT',
        `The ${parameter.name} parameter disagrees with the pinned time window.`,
      );
    }
    const filter = filters.find((candidate) => candidate['field'] === parameter.name && candidate['op'] === 'equals');
    if (filter !== undefined && filter['value'] !== parameter.value) {
      reject(
        session,
        actor,
        context,
        'REPORT_TEMPLATE_PARAMETERS_INCONSISTENT',
        `The ${parameter.name} parameter disagrees with the pinned filter.`,
      );
    }
  }
}

function readFreshness(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
): ReportFreshnessPolicy {
  if (raw === undefined) return { max_age_minutes: DEFAULT_REPORT_MAX_AGE_MINUTES };
  if (!isRecord(raw)) {
    reject(session, actor, context, 'REPORT_TEMPLATE_FRESHNESS_INVALID', 'A Report Template freshness policy must be a JSON object.');
  }
  const minutes = raw['max_age_minutes'];
  if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_REPORT_MAX_AGE_MINUTES) {
    reject(
      session,
      actor,
      context,
      'REPORT_TEMPLATE_FRESHNESS_INVALID',
      `A Report Template must state max_age_minutes as a whole number from 1 to ${MAX_REPORT_MAX_AGE_MINUTES}.`,
    );
  }
  return { max_age_minutes: minutes as number };
}

function readQuestion(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
): string {
  const question = typeof raw === 'string' ? raw.trim() : '';
  if (question.length === 0 || question.length > MAX_REPORT_QUESTION_CHARS || !hasChinese(question)) {
    reject(
      session,
      actor,
      context,
      'REPORT_TEMPLATE_QUESTION_INVALID',
      `A Report Template question must be a Simplified Chinese question of at most ${MAX_REPORT_QUESTION_CHARS} characters.`,
    );
  }
  return question;
}

function readGroundedPrompt(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
): { body: string; hash: string } {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (body.length === 0 || body.length > MAX_REPORT_PROMPT_CHARS || !promptPinsSimplifiedChinese(body)) {
    reject(
      session,
      actor,
      context,
      'REPORT_TEMPLATE_PROMPT_NOT_SIMPLIFIED_CHINESE',
      'A Report Template grounded-answer prompt must instruct the model to answer in Simplified Chinese.',
    );
  }
  return { body, hash: groundedPromptHash(body) };
}

/**
 * Reads the query semantics a Template pins: the exact request in the published
 * query vocabulary, with every governed default fixed so a later Release can
 * never change what the Template means. A release pin is refused because the
 * Template pins a Contract line and each Report pins the Releases it read.
 */
function readTemplateRequest(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  raw: unknown,
  serving: ServingContract,
): Record<string, unknown> {
  if (!isRecord(raw)) {
    reject(session, actor, context, 'REPORT_TEMPLATE_QUERY_INVALID', 'A Report Template must pin one normalized Data Product Query.');
  }
  const fail: Fail = (code, message, nextStep) => reject(session, actor, context, code, message, nextStep);
  const target = readQueryTarget(raw, fail);
  if (target.release !== undefined || target.major !== undefined || target.cursor !== undefined) {
    reject(
      session,
      actor,
      context,
      'REPORT_TEMPLATE_RELEASE_PIN_REFUSED',
      'A Report Template pins its Contract line and semantics, not a Release; each Report pins the Releases it read.',
    );
  }
  const request: Record<string, unknown> = { ...raw };
  request['major'] = serving.major;
  if (request['limit'] === undefined) request['limit'] = serving.contract.default_limit;
  if (request['kind'] === 'aggregate') {
    if (request['metrics'] === undefined) {
      request['metrics'] = serving.contract.metrics.map((metric) => metric.name);
    }
    if (request['include_totals'] === undefined) request['include_totals'] = true;
  }
  // The same deterministic reader the engine uses proves the pinned request is
  // expressible against the exact Contract line before the Template exists.
  readQuery(request, serving.contract, serving.schema, fail);
  return request;
}

const OPERATOR_COPY: Record<string, string> = {
  equals: '等于',
  not_equals: '不等于',
  less_than: '小于',
  less_or_equal: '小于等于',
  greater_than: '大于',
  greater_or_equal: '大于等于',
  is_null: '为空',
  is_not_null: '不为空',
};

function windowCopy(window: Record<string, unknown> | null): string | null {
  if (window === null) return null;
  return `${String(window['start'])} 至 ${String(window['end'])}`;
}

/** The deterministic Chinese description of one pinned query's semantics. */
function interpretationOf(request: Record<string, unknown>, contract: DataProductContract): string {
  const kind = request['kind'];
  if (kind === 'records') {
    const filters = Array.isArray(request['filters']) ? request['filters'].filter(isRecord) : [];
    const parts = ['按已发布的受治理契约读取所选范围内的受治理记录'];
    if (filters.length > 0) {
      parts.push(`筛选 ${filters.map((filter) => `${String(filter['field'])} ${OPERATOR_COPY[String(filter['op'])] ?? '符合'} ${filter['value'] === null ? '空值' : String(filter['value'])}`).join('，')}`);
    }
    const window = isRecord(request['window']) ? windowCopy(request['window']) : null;
    if (window !== null) parts.push(`时间范围为 ${window}`);
    return `${parts.join('；')}。`;
  }
  if (kind === 'search') {
    const q = typeof request['q'] === 'string' ? request['q'] : '';
    return `按已发布的受治理契约检索与“${q}”匹配的文档。`;
  }
  if (kind === 'suggest') {
    const q = typeof request['q'] === 'string' ? request['q'] : '';
    return `按已发布的受治理契约提供与“${q}”相关的建议值。`;
  }
  const metrics = Array.isArray(request['metrics'])
    ? request['metrics'].filter((metric): metric is string => typeof metric === 'string')
    : contract.metrics.map((metric) => metric.name);
  const groups = Array.isArray(request['group_by'])
    ? request['group_by'].filter((dimension): dimension is string => typeof dimension === 'string')
    : [];
  const filters = Array.isArray(request['filters']) ? request['filters'].filter(isRecord) : [];
  const parts = [`按已发布的受治理契约统计指标 ${metrics.length === 0 ? '全部已发布指标' : metrics.join('、')}`];
  if (groups.length > 0) parts.push(`按 ${groups.join('、')} 分组`);
  if (filters.length > 0) {
    parts.push(`筛选 ${filters.map((filter) => `${String(filter['field'])} ${OPERATOR_COPY[String(filter['op'])] ?? '符合'} ${filter['value'] === null ? '空值' : String(filter['value'])}`).join('，')}`);
  }
  const window = isRecord(request['window']) ? windowCopy(request['window']) : null;
  if (window !== null) parts.push(`时间范围为 ${window}`);
  const comparison = isRecord(request['comparison']) ? windowCopy(request['comparison']) : null;
  if (comparison !== null) parts.push(`对比时间范围为 ${comparison}`);
  parts.push('并返回确定性的结构化结果');
  return `${parts.join('；')}。`;
}

export function templateVersionView(
  session: PlatformSession,
  template: ReportTemplateArtifact,
  version: ReportTemplateVersion,
): Record<string, unknown> {
  return {
    report_template_id: template.report_template_id,
    workspace_id: template.workspace_id,
    name: template.name,
    owner: {
      user_id: template.owner_user_id,
      username: userNameOf(session, template.owner_user_id),
    },
    published_version: template.published_version,
    template_version: version.version,
    content_hash: version.content_hash,
    question: version.question,
    normalized_question: version.normalized_question,
    interpretation: version.interpretation,
    parameters: copyParameters(version.parameters),
    data_product_id: version.data_product_id,
    contract_major: version.contract_major,
    query: { ...version.request },
    grounded_prompt: { ...version.grounded_prompt },
    freshness_policy: { ...version.freshness_policy },
    published_at: version.published_at,
    published_by: version.published_by,
    withdrawn_at: version.withdrawn_at,
  };
}

/**
 * Publishes one Report Template Version. A Workspace Administrator pins the
 * question, its normalized semantics, the typed parameters, the exact query,
 * the grounded-answer prompt, the freshness policy, and the accountable Owner
 * before any Report can be generated from it.
 */
export function publishReportTemplate(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  productId: string;
  name: string;
  configPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_template_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.productId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const actorName = actorLabel(actor.user);
  const product = findDataProduct(session.state.data_products, options.productId);
  if (!product || product.workspace_id !== options.workspaceId) {
    deny(session, actorName, context, 'DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this actor.');
  }
  const name = options.name.trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    reject(session, actorName, context, 'REPORT_TEMPLATE_NAME_INVALID', 'A Report Template name must contain 2 to 128 characters.');
  }
  const serving = servingContract(session, product);
  if (serving === null) {
    reject(
      session,
      actorName,
      context,
      'DATA_PRODUCT_NOT_PUBLISHED',
      'The Data Product has no current Publication to define a Report Template over.',
      'Publish the Data Product before defining a Report Template for it.',
    );
  }
  const fail: Fail = (code, message, nextStep) => reject(session, actorName, context, code, message, nextStep);
  const config = readJsonDocument(
    options.configPath,
    fail,
    'REPORT_TEMPLATE_CONFIGURATION_UNREADABLE',
    'The Report Template configuration file must contain valid JSON.',
  );
  if (!isRecord(config)) {
    reject(session, actorName, context, 'REPORT_TEMPLATE_CONFIGURATION_INVALID', 'A Report Template configuration must be a JSON object.');
  }
  const question = readQuestion(session, actorName, context, config['question']);
  const parameters = readParameters(session, actorName, context, config['parameters']);
  const request = readTemplateRequest(session, actorName, context, config['query'], serving);
  requireParameterConsistency(session, actorName, context, parameters, request);
  const grounded = readGroundedPrompt(session, actorName, context, config['grounded_prompt']);
  const freshness = readFreshness(session, actorName, context, config['freshness']);
  const interpretation = interpretationOf(request, serving.contract);
  const normalizedQuestion = normalizeReportQuestion(question);

  let template = session.state.report_templates.find(
    (candidate) => candidate.workspace_id === options.workspaceId
      && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (template === undefined) {
    template = {
      report_template_id: randomUUID(),
      workspace_id: options.workspaceId,
      name,
      owner_user_id: actor.user.user_id,
      created_at: new Date().toISOString(),
      published_version: null,
      versions: [],
    };
    session.state.report_templates.push(template);
  }
  const volume: ReportTemplateVersion = {
    version: (template.versions[template.versions.length - 1]?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    question,
    normalized_question: normalizedQuestion,
    interpretation,
    parameters: copyParameters(parameters),
    data_product_id: product.data_product_id,
    contract_major: serving.major,
    request: { ...request },
    grounded_prompt: { id: 'grounded_answer', body: grounded.body, hash: grounded.hash },
    freshness_policy: { ...freshness },
    content_hash: '',
    withdrawn_at: null,
    withdrawn_by: null,
  };
  volume.content_hash = canonicalDigest({
    question: volume.question,
    normalized_question: volume.normalized_question,
    interpretation: volume.interpretation,
    parameters: volume.parameters,
    data_product_id: volume.data_product_id,
    contract_major: volume.contract_major,
    request: volume.request,
    grounded_prompt: volume.grounded_prompt,
    freshness_policy: volume.freshness_policy,
    owner_user_id: template.owner_user_id,
  });
  template.versions.push(volume);
  template.published_version = volume.version;
  session.audit({
    ...context,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      report_template_id: template.report_template_id,
      template_version: volume.version,
      content_hash: volume.content_hash,
      parameter_count: volume.parameters.length,
      contract_major: volume.contract_major,
      max_age_minutes: volume.freshness_policy.max_age_minutes,
    },
  });
  session.save();
  return templateVersionView(session, template, volume);
}

/** Reads one Report Template Version for its Workspace Administrator. */
export function showReportTemplate(options: {
  root: string;
  masterKey: string;
  token: string;
  reportTemplateId: string;
  version?: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_template_read',
    scope: 'workspace',
    target: options.reportTemplateId,
  };
  const actor = resolveActor(session, options.token, context);
  const template = findReportTemplate(session.state.report_templates, options.reportTemplateId);
  if (!template) {
    deny(session, actorLabel(actor.user), context, 'REPORT_TEMPLATE_NOT_AVAILABLE', 'The Report Template is not available to this actor.');
  }
  if (workspaceRoleOf(session.state, actor.user.user_id, template.workspace_id) !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'REPORT_TEMPLATE_NOT_AVAILABLE', 'The Report Template is not available to this actor.');
  }
  const version = options.version === undefined
    ? (template.published_version === null
      ? undefined
      : findReportTemplateVersion(template, template.published_version))
    : findReportTemplateVersion(template, options.version);
  if (!version) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'REPORT_TEMPLATE_VERSION_NOT_FOUND',
      'The requested Report Template Version does not exist.',
    );
  }
  session.audit({
    ...context,
    workspace_id: template.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { template_version: version.version },
  });
  return templateVersionView(session, template, version);
}

/** Lists the Report Templates one Workspace Administrator governs. */
export function listReportTemplates(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_template_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const templates = session.state.report_templates
    .filter((template) => template.workspace_id === options.workspaceId)
    .map((template) => {
      const version = template.published_version === null
        ? undefined
        : findReportTemplateVersion(template, template.published_version);
      return {
        report_template_id: template.report_template_id,
        name: template.name,
        owner: { user_id: template.owner_user_id, username: userNameOf(session, template.owner_user_id) },
        published_version: template.published_version,
        ...(version === undefined
          ? {}
          : {
            question: version.question,
            data_product_id: version.data_product_id,
            freshness_policy: { ...version.freshness_policy },
            content_hash: version.content_hash,
          }),
      };
    });
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { templates_returned: templates.length },
  });
  return { workspace_id: options.workspaceId, report_templates: templates };
}

/** The exact Model Binding and Version a Report's optional narrative runs under. */
function narrationModel(session: PlatformSession, workspaceId: string): NarrationModel | null {
  for (const binding of session.state.model_bindings) {
    if (binding.workspace_id !== workspaceId
      || binding.revoked_at !== null
      || !binding.purposes.includes('grounded_narration')) {
      continue;
    }
    const profile = findModelProfile(session.state.model_profiles, binding.model_profile_id);
    const version = findModelProfileVersion(profile, binding.model_profile_version);
    if (!profile
      || !version
      || version.content_hash !== binding.model_profile_content_hash
      || profile.activated_version !== version.version
      || !version.purposes.includes('grounded_narration')) {
      continue;
    }
    const prompt = version.prompts.find((candidate) => candidate.id === 'grounded_narration');
    if (prompt === undefined) continue;
    return {
      binding,
      profile,
      version,
      pin: pinnedForBinding(session, profile, version, binding),
      promptHash: prompt.hash,
    };
  }
  return null;
}

/** The Chinese limitation one dropped or unavailable narrative states. */
function narrationLimitation(error: unknown): string {
  const code = error instanceof ReportGenerationFailure ? error.code : 'REPORT_NARRATION_UNAVAILABLE';
  if (code === 'MODEL_ENDPOINT_UNREACHABLE') return '模型端点当前不可用，报告仅包含结构化结果。';
  if (code === 'NARRATION_NOT_GROUNDED') return '模型叙述未能引用受治理结果，已丢弃叙述。';
  if (code === 'NARRATION_NOT_SIMPLIFIED_CHINESE') return '模型叙述不是简体中文，已丢弃叙述。';
  if (code === 'NARRATIVE_CAUSAL_CLAIM') return '模型叙述包含证据不支持的因果表述，已丢弃叙述。';
  if (code === 'NARRATIVE_INVENTED_RELATIONSHIP') return '模型叙述包含证据不支持的关联表述，已丢弃叙述。';
  if (code === 'NARRATIVE_NUMBER_NOT_GOVERNED') return '模型叙述包含证据之外的数值，已丢弃叙述。';
  if (code === 'MODEL_DATA_CATEGORY_NOT_PERMITTED' || code === 'MODEL_PURPOSE_UNSUPPORTED') {
    return '当前模型绑定未启用中文叙述，报告仅包含结构化结果。';
  }
  return '模型生成当前不可用，报告仅包含结构化结果。';
}

/**
 * Generates the optional grounded narrative under the exact Binding and prompt
 * the Workspace permits, and the grounded-answer prompt the Template pins. A
 * narrative is optional: a refused or unavailable one leaves the structured
 * Report intact and states, in Chinese, why the narrative is absent.
 */
async function narrate(
  session: PlatformSession,
  workspaceId: string,
  version: ReportTemplateVersion,
  product: DataProductArtifact,
  result: Record<string, unknown>,
  reference: ReportRecord['data_product'],
): Promise<{ narrative: ReportRecord['narrative']; limitation: string | null }> {
  const facts = narrationFacts([{ name: product.name, result, release: reference as unknown as Record<string, unknown> }], version.question);
  if (facts.records.length === 0) return { narrative: null, limitation: null };
  let model: NarrationModel | null;
  try {
    model = narrationModel(session, workspaceId);
  } catch (error) {
    return { narrative: null, limitation: narrationLimitation(error) };
  }
  if (model === null) {
    return { narrative: null, limitation: '当前没有可用于生成中文叙述的模型绑定，报告仅包含结构化结果。' };
  }
  const fail: Fail = (code, message, nextStep) => {
    throw new ReportGenerationFailure(code, message, nextStep);
  };
  try {
    const answer = await generateGroundedNarration(model.pin, {
      ...facts,
      grounded_answer_prompt: {
        id: version.grounded_prompt.id,
        body: version.grounded_prompt.body,
        hash: version.grounded_prompt.hash,
      },
    }, fail);
    const narrative = String(answer['narrative'] ?? '');
    const violation = narrativeViolation(narrative, facts);
    if (violation !== null) {
      return { narrative: null, limitation: narrationLimitation(new ReportGenerationFailure(violation, 'The narrative is not grounded.')) };
    }
    return {
      narrative: {
        narrative,
        evidence_refs: Array.isArray(answer['evidence_refs'])
          ? answer['evidence_refs'].filter(isRecord).map((reference_) => ({ ...reference_ }))
          : [],
        grounded_answer_prompt_hash: version.grounded_prompt.hash,
        prompt_hash: model.promptHash,
        model: {
          binding_id: model.binding.binding_id,
          model_profile_id: model.profile.model_profile_id,
          model_profile_version: model.version.version,
          model_profile_content_hash: model.version.content_hash,
          adapter: model.version.adapter,
          model_id: model.version.model_id,
          prompt_id: 'grounded_narration',
          prompt_hash: model.promptHash,
        },
      },
      limitation: null,
    };
  } catch (error) {
    return { narrative: null, limitation: narrationLimitation(error) };
  }
}

/** The Chinese limitation lines one Report's completeness states. */
export function completionOf(result: Record<string, unknown>): ReportRecord['completion'] {
  const outcome = classifyResult(result);
  const window = isRecord(result['window']) ? result['window'] : null;
  const partial = window !== null && window['partial'] === true;
  const truncated = result['truncated'] === true;
  const limitations: string[] = [];
  if (outcome === 'empty') limitations.push('查询已执行，但所选业务范围内没有记录。');
  if (outcome === 'no_evidence') limitations.push('查询已执行，但所选范围内没有可引用的数值。');
  if (partial) limitations.push('查询窗口超出现有数据覆盖范围，结果为部分期间数据。');
  if (truncated) limitations.push('报告结果超过模板固定的返回条数，结果为不完整结果。');
  return {
    status: partial || truncated ? 'incomplete' : 'complete',
    outcome,
    partial_period: partial,
    truncated,
    limitations,
  };
}

export interface GenerateReportOptions {
  session: PlatformSession;
  actor: { user: UserRecord };
  reader: GrantReader;
  template: ReportTemplateArtifact;
  version: ReportTemplateVersion;
  now: Date;
  trigger: 'explicit' | 'stock_refresh' | 'scheduled';
}

/**
 * Generates one immutable Report from an exact Template Version under the
 * current reader's complete security context. The deterministic engine answers
 * the pinned query against the Contract line's current Release, so every number,
 * Release, and Provenance reference is the engine's own; only the optional
 * narrative is generated, and only after the engine has answered.
 */
export async function generateReport(options: GenerateReportOptions): Promise<ReportRecord> {
  const { session, reader, template, version } = options;
  if (version.withdrawn_at !== null) {
    throw new ReportGenerationFailure(
      'REPORT_TEMPLATE_WITHDRAWN',
      'The Report Template Version this generation would read has been withdrawn.',
    );
  }
  const product = findDataProduct(session.state.data_products, version.data_product_id);
  if (!product || product.workspace_id !== template.workspace_id) {
    throw new ReportGenerationFailure('DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product this Template pins is not available.');
  }
  const serving = servingContract(session, product, version.contract_major);
  if (serving === null) {
    throw new ReportGenerationFailure(
      'DATA_PRODUCT_NOT_PUBLISHED',
      'The Data Product has no current Release on the Contract line this Template pins.',
    );
  }
  const fail: Fail = (code, message, nextStep) => {
    throw new ReportGenerationFailure(code, message, nextStep);
  };
  const scope = reader.requireScope(product, serving.contract, fail);
  const context: ActionContext = {
    action: 'report_generation',
    scope: 'workspace',
    workspace_id: template.workspace_id,
    target: template.report_template_id,
  };
  const result = executeDataProductQuery({
    session,
    reader,
    product,
    // The deterministic read is audited as the Data Product Query it is, so a
    // stock refresh can never look like a read that did not execute.
    context: { action: 'data_product_query', scope: 'workspace', workspace_id: template.workspace_id, target: product.data_product_id },
    request: version.request,
    fail,
  });
  const provenance = isRecord(result['provenance']) ? { ...result['provenance'] } : {};
  const window = isRecord(result['window']) ? result['window'] : null;
  const reference = productReference(product, serving.version, serving.release);
  const completion = completionOf(result);
  const narrated = await narrate(session, template.workspace_id, version, product, result, reference);
  if (narrated.limitation !== null) completion.limitations.push(narrated.limitation);
  const report: ReportRecord = {
    report_id: randomUUID(),
    workspace_id: template.workspace_id,
    template: templateReference(template, version),
    data_product: reference,
    question: version.question,
    normalized_question: version.normalized_question,
    parameters: copyParameters(version.parameters),
    interpretation: version.interpretation,
    query: { ...version.request },
    result,
    narrative: narrated.narrative,
    provenance,
    freshness: freshnessOf(provenance, window),
    completion,
    security: {
      scope_fingerprint: scope.fingerprint,
      restricted: scope.restricted,
      columns: [...scope.columns],
      row_filter_count: scope.rowFilters.length,
    },
    freshness_policy: { ...version.freshness_policy },
    generated_at: options.now.toISOString(),
    generated_by: options.actor.user.user_id,
    withdrawn_at: null,
    withdrawn_by: null,
  };
  session.state.reports.push(report);
  session.audit({
    ...context,
    actor: reader.label,
    outcome: 'succeeded',
    detail: {
      report_id: report.report_id,
      template_version: version.version,
      data_product_id: product.data_product_id,
      data_product_release: reference.data_product_release,
      dataset_release: reference.dataset_release,
      completion_status: completion.status,
      report_outcome: completion.outcome,
      narrative: report.narrative !== null,
      trigger: options.trigger,
    },
  });
  session.save();
  return report;
}

/** The mutable view one response discloses of an immutable Report. */
export function reportView(report: ReportRecord): Record<string, unknown> {
  return {
    report_id: report.report_id,
    workspace_id: report.workspace_id,
    template: { ...report.template },
    data_product: { ...report.data_product, contract_version: { ...report.data_product.contract_version } },
    question: report.question,
    normalized_question: report.normalized_question,
    parameters: copyParameters(report.parameters),
    interpretation: report.interpretation,
    query: { ...report.query },
    result: report.result,
    narrative: report.narrative === null
      ? null
      : { ...report.narrative, evidence_refs: report.narrative.evidence_refs.map((entry) => ({ ...entry })), model: { ...report.narrative.model } },
    provenance: { ...report.provenance },
    freshness: report.freshness === null ? null : { ...report.freshness },
    completion: { ...report.completion, limitations: [...report.completion.limitations] },
    security: { ...report.security, columns: [...report.security.columns] },
    freshness_policy: { ...report.freshness_policy },
    generated_at: report.generated_at,
    generated_by: report.generated_by,
    withdrawn_at: report.withdrawn_at,
    withdrawn_by: report.withdrawn_by,
  };
}

/** How old a stocked Report is at the instant the caller asks. */
export function reportAgeMinutes(report: ReportRecord, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(report.generated_at)) / 60_000);
}

/**
 * The exact stock a Template Version may reuse for one reader right now, under
 * the complete current security context. Scheduled runs use the same rule as
 * interactive reuse, so an unchanged input never executes a second query.
 */
export function freshStockReport(options: {
  session: PlatformSession;
  reader: GrantReader;
  template: ReportTemplateArtifact;
  version: ReportTemplateVersion;
  now: Date;
}): { report: ReportRecord; scope: GrantScope; serving: ServingContract } | null {
  const { session, reader, template, version, now } = options;
  const product = findDataProduct(session.state.data_products, version.data_product_id);
  if (!product || product.workspace_id !== template.workspace_id) return null;
  const serving = servingContract(session, product, version.contract_major);
  if (serving === null) return null;
  const scope = reader.scopeOf(product, serving.contract);
  if (scope === null) return null;
  const candidates = session.state.reports.filter(
    (report) => report.workspace_id === template.workspace_id
      && report.template.report_template_id === template.report_template_id
      && report.template.version === version.version
      && report.data_product.data_product_id === product.data_product_id
      && report.withdrawn_at === null
      && !purgeRevoked(session.state, 'report', report.report_id)
      && !isPastRetention(session.state, report.workspace_id, 'report', report.generated_at, now),
  );
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const report = candidates[index]!;
    if (report.data_product.data_product_release !== serving.release.release) continue;
    if (report.template.content_hash !== version.content_hash) continue;
    if (report.normalized_question !== version.normalized_question) continue;
    if (canonicalDigest(report.parameters) !== canonicalDigest(version.parameters)) continue;
    if (report.security.scope_fingerprint !== scope.fingerprint) continue;
    if (reportAgeMinutes(report, now) > version.freshness_policy.max_age_minutes) continue;
    return { report, scope, serving };
  }
  return null;
}

/** One part of the effective authorization a response discloses. */
export interface AuthorizationPart {
  data_product_id: string;
  restricted: boolean;
  columns: string[];
  row_filter_count: number;
  scope_fingerprint: string;
}

export function scopeAuthorization(dataProductId: string, scope: GrantScope): AuthorizationPart {
  return {
    data_product_id: dataProductId,
    restricted: scope.restricted,
    columns: [...scope.columns],
    row_filter_count: scope.rowFilters.length,
    scope_fingerprint: scope.fingerprint,
  };
}

/** The exact authorization one response is answered under, disclosed in full. */
export function authorizationView(
  workspaceId: string,
  role: string,
  parts: AuthorizationPart[],
): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    role,
    parts: parts.map((part) => ({ ...part, columns: [...part.columns] })),
  };
}

/** What exact normalized matching found, or the Report the attempt generated. */
export type ReportReuse =
  | { kind: 'none' }
  | {
    kind: 'stock';
    template: ReportTemplateArtifact;
    version: ReportTemplateVersion;
    report: ReportRecord;
    ageMinutes: number;
    authorization: AuthorizationPart;
  }
  | {
    kind: 'generated';
    template: ReportTemplateArtifact;
    version: ReportTemplateVersion;
    report: ReportRecord;
    superseded: ReportRecord | null;
    ageMinutes: number | null;
    authorization: AuthorizationPart;
  };

interface ReuseRequest {
  session: PlatformSession;
  actor: Actor;
  reader: GrantReader;
  workspaceId: string;
  role: WorkspaceRole;
  question: string;
  dataProductId?: string;
  now: Date;
}

/**
 * Attempts stock reuse before any Natural-Language Query work. An exact
 * normalized question that names a published Template Version and has a fresh
 * Report generated under this actor's current authorization is returned
 * untouched. Otherwise a matching Template generates a fresh Report under the
 * current authorization; a Template that cannot produce one falls through to
 * the settled Natural-Language Query path. Similarity never nominates here:
 * only the exact normalized question can match.
 */
export async function reuseReport(options: ReuseRequest): Promise<ReportReuse> {
  const normalized = normalizeReportQuestion(options.question);
  const templates = options.session.state.report_templates
    .filter((template) => template.workspace_id === options.workspaceId && template.published_version !== null)
    .filter((template) => {
      const version = findReportTemplateVersion(template, template.published_version ?? 0);
      return version !== undefined && version.normalized_question === normalized;
    })
    .sort((left, right) => {
      if (left.name === right.name) return left.report_template_id < right.report_template_id ? -1 : 1;
      return left.name < right.name ? -1 : 1;
    });
  for (const template of templates) {
    const version = findReportTemplateVersion(template, template.published_version ?? 0);
    if (version === undefined) continue;
    if (version.withdrawn_at !== null) continue;
    if (options.dataProductId !== undefined && version.data_product_id !== options.dataProductId) continue;
    const product = findDataProduct(options.session.state.data_products, version.data_product_id);
    if (!product || product.workspace_id !== options.workspaceId) continue;
    const serving = servingContract(options.session, product, version.contract_major);
    if (serving === null) continue;
    const scope = options.reader.scopeOf(product, serving.contract);
    if (scope === null) continue;
    const candidates = options.session.state.reports.filter(
      (report) => report.workspace_id === options.workspaceId
        && report.template.report_template_id === template.report_template_id
        && report.template.version === version.version
        && report.data_product.data_product_id === product.data_product_id
        && report.withdrawn_at === null
        && !purgeRevoked(options.session.state, 'report', report.report_id)
        && !isPastRetention(options.session.state, report.workspace_id, 'report', report.generated_at, options.now),
    );
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const report = candidates[index]!;
      const ageMinutes = reportAgeMinutes(report, options.now);
      if (report.data_product.data_product_release === serving.release.release
        && report.template.content_hash === version.content_hash
        && report.normalized_question === normalized
        && canonicalDigest(report.parameters) === canonicalDigest(version.parameters)
        && report.security.scope_fingerprint === scope.fingerprint
        && ageMinutes <= version.freshness_policy.max_age_minutes) {
        return {
          kind: 'stock',
          template,
          version,
          report,
          ageMinutes,
          authorization: scopeAuthorization(product.data_product_id, scope),
        };
      }
    }
    // A matching Template whose stock is stale, pinned to an older Release, or
    // generated under another authorization produces a new Report for exactly
    // this reader; nothing reuses another actor's stored rows. Only a Report of
    // this actor's own scope is ever named as the one being superseded.
    const previous = candidates[candidates.length - 1];
    const superseded = previous !== undefined && previous.security.scope_fingerprint === scope.fingerprint
      ? previous
      : null;
    try {
      const report = await generateReport({
        session: options.session,
        actor: options.actor,
        reader: options.reader,
        template,
        version,
        now: options.now,
        trigger: 'stock_refresh',
      });
      return {
        kind: 'generated',
        template,
        version,
        report,
        superseded,
        ageMinutes: superseded === null ? null : reportAgeMinutes(superseded, options.now),
        authorization: scopeAuthorization(product.data_product_id, scope),
      };
    } catch (error) {
      const code = error instanceof ReportGenerationFailure
        ? error.code
        : 'REPORT_GENERATION_FAILED';
      options.session.audit({
        action: 'report_generation',
        scope: 'workspace',
        workspace_id: options.workspaceId,
        target: template.report_template_id,
        actor: options.reader.label,
        outcome: 'failed',
        detail: {
          template_version: version.version,
          data_product_id: version.data_product_id,
          trigger: 'stock_refresh',
          error_code: code,
        },
      });
    }
  }
  return { kind: 'none' };
}

/** Generates and stores one Report from the published Template Version. */
export async function generateTemplateReport(options: {
  root: string;
  masterKey: string;
  token: string;
  reportTemplateId: string;
  now?: Date;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_generation',
    scope: 'workspace',
    target: options.reportTemplateId,
  };
  const actor = resolveActor(session, options.token, context);
  const template = findReportTemplate(session.state.report_templates, options.reportTemplateId);
  if (!template) {
    deny(session, actorLabel(actor.user), context, 'REPORT_TEMPLATE_NOT_AVAILABLE', 'The Report Template is not available to this actor.');
  }
  if (workspaceRoleOf(session.state, actor.user.user_id, template.workspace_id) !== 'Workspace Administrator') {
    deny(session, actorLabel(actor.user), context, 'REPORT_TEMPLATE_NOT_AVAILABLE', 'The Report Template is not available to this actor.');
  }
  const version = template.published_version === null
    ? undefined
    : findReportTemplateVersion(template, template.published_version);
  if (!version) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'REPORT_TEMPLATE_NOT_PUBLISHED',
      'The Report Template has no published Version to generate from.',
    );
  }
  if (version.withdrawn_at !== null) {
    reject(
      session,
      actorLabel(actor.user),
      { ...context, workspace_id: template.workspace_id },
      'REPORT_TEMPLATE_WITHDRAWN',
      'The Report Template Version has been withdrawn and generates no new Reports.',
    );
  }
  const role = workspaceRoleOf(session.state, actor.user.user_id, template.workspace_id);
  const reader = memberReader(session, actor.user, role);
  const now = options.now ?? new Date();
  let report: ReportRecord;
  try {
    report = await generateReport({
      session,
      actor,
      reader,
      template,
      version,
      now,
      trigger: 'explicit',
    });
  } catch (error) {
    if (error instanceof ReportGenerationFailure) {
      reject(session, actorLabel(actor.user), { ...context, workspace_id: template.workspace_id }, error.code, error.message, error.nextStep);
    }
    reject(
      session,
      actorLabel(actor.user),
      { ...context, workspace_id: template.workspace_id },
      'REPORT_GENERATION_FAILED',
      error instanceof Error ? error.message : 'The Report could not be generated.',
    );
  }
  return {
    origin: 'generated',
    summary: `已按模板第 ${version.version} 版生成新的报告。`,
    report: reportView(report),
    authorization: authorizationView(
      template.workspace_id,
      role ?? '',
      [{
        data_product_id: report.data_product.data_product_id,
        restricted: report.security.restricted,
        columns: report.security.columns,
        row_filter_count: report.security.row_filter_count,
        scope_fingerprint: report.security.scope_fingerprint,
      }],
    ),
  };
}

/** The current authorization one reader holds on one Report's Product, or nothing. */
function currentReportScope(
  session: PlatformSession,
  user: UserRecord,
  role: WorkspaceRole,
  report: ReportRecord,
): GrantScope | null {
  const product = findDataProduct(session.state.data_products, report.data_product.data_product_id);
  if (!product) return null;
  const serving = servingContract(session, product);
  if (serving === null) return null;
  const reader = memberReader(session, user, role);
  return reader.scopeOf(product, serving.contract);
}

/**
 * Reads one immutable Report back, reauthorizing the complete current security
 * context. It never regenerates content: a Consumer may only read a Report
 * generated under exactly the scope they hold now, while a Workspace
 * Administrator already reads the whole Product.
 */
export function showReport(options: {
  root: string;
  masterKey: string;
  token: string;
  reportId: string;
  now?: Date;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_retrieval',
    scope: 'workspace',
    target: options.reportId,
  };
  const actor = resolveActor(session, options.token, context);
  const report = findReport(session.state.reports, options.reportId);
  if (!report) {
    // A purged Report stays explicitly retention-expired instead of silently absent.
    const ledger = session.state.purge_ledger.find((entry) => entry.purged.some(
      (record) => record.record_kind === 'report' && record.record_id === options.reportId,
    ));
    if (purgeRevoked(session.state, 'report', options.reportId)) {
      reject(
        session,
        actorLabel(actor.user),
        ledger?.scope.workspace_id == null ? context : { ...context, workspace_id: ledger.scope.workspace_id },
        'RETENTION_EXPIRED',
        'This Report has expired under the retention policy and was purged.',
        'Ask the question again to generate a current Report.',
      );
    }
    deny(session, actorLabel(actor.user), context, 'REPORT_NOT_AVAILABLE', 'The Report is not available to this actor.');
  }
  const role = workspaceRoleOf(session.state, actor.user.user_id, report.workspace_id);
  if (role === null) {
    deny(session, actorLabel(actor.user), context, 'REPORT_NOT_AVAILABLE', 'The Report is not available to this actor.');
  }
  // Stock ages out under the settled Report clock; a Purge Ledger entry keeps a
  // deleted Report explicitly expired rather than silently absent.
  const now = options.now ?? new Date();
  if (purgeRevoked(session.state, 'report', report.report_id)
    || isPastRetention(session.state, report.workspace_id, 'report', report.generated_at, now)) {
    reject(
      session,
      actorLabel(actor.user),
      { ...context, workspace_id: report.workspace_id },
      'RETENTION_EXPIRED',
      retentionExpiredMessage(
        session.state,
        report.workspace_id,
        'report',
        report.generated_at,
        now,
        `Report ${report.report_id}`,
      ),
      'Ask the question again to generate a current Report.',
    );
  }
  // A candidate Report is review evidence until an administrator approves its
  // Template and Report together; ordinary retrieval never exposes it early.
  const ownerTemplate = findReportTemplate(session.state.report_templates, report.template.report_template_id);
  if (ownerTemplate === undefined || ownerTemplate.published_version !== report.template.version) {
    deny(session, actorLabel(actor.user), context, 'REPORT_NOT_AVAILABLE', 'The Report is not available to this actor.');
  }
  // A withdrawn Report leaves ordinary retrieval; only an administrator keeps
  // reading it as governed history, and nothing about it is erased.
  if (report.withdrawn_at !== null && role !== 'Workspace Administrator') {
    deny(
      session,
      actorLabel(actor.user),
      context,
      'REPORT_WITHDRAWN',
      'The Report has been withdrawn from ordinary retrieval and is preserved as governed history.',
    );
  }
  const scope = currentReportScope(session, actor.user, role, report);
  if (scope === null) {
    deny(session, actorLabel(actor.user), context, 'REPORT_NOT_AVAILABLE', 'The Report is not available to this actor.');
  }
  if (role !== 'Workspace Administrator' && scope.fingerprint !== report.security.scope_fingerprint) {
    deny(session, actorLabel(actor.user), context, 'REPORT_NOT_AVAILABLE', 'The Report is not available to this actor.');
  }
  const ageMinutes = reportAgeMinutes(report, now);
  const product = findDataProduct(session.state.data_products, report.data_product.data_product_id);
  const serving = product === undefined ? null : servingContract(session, product);
  const fresh = report.withdrawn_at === null
    && serving !== null
    && report.data_product.data_product_release === serving.release.release
    && ageMinutes <= report.freshness_policy.max_age_minutes
    && scope.fingerprint === report.security.scope_fingerprint;
  session.audit({
    ...context,
    workspace_id: report.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      report_template_id: report.template.report_template_id,
      template_version: report.template.version,
      fresh,
      regenerated: false,
      withdrawn: report.withdrawn_at !== null,
    },
  });
  return {
    origin: 'stock',
    summary: report.withdrawn_at === null
      ? '本次读取直接返回已入库的不可变报告，未重新执行查询，也未调用模型。'
      : '该报告已撤回，不再参与普通复用与检索，仅按治理历史保留；本次读取未重新执行查询，也未调用模型。',
    report: reportView(report),
    withdrawn: report.withdrawn_at !== null,
    stock: {
      report_id: report.report_id,
      reused: false,
      generated_at: report.generated_at,
      age_minutes: Math.round(ageMinutes * 1000) / 1000,
      max_age_minutes: report.freshness_policy.max_age_minutes,
      fresh,
    },
    authorization: authorizationView(
      report.workspace_id,
      role,
      [scopeAuthorization(report.data_product.data_product_id, scope)],
    ),
  };
}

/** Lists the stocked Reports one actor's current authorization may retrieve. */
export function listReports(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  /** Administrators may list withdrawn Reports as governed history. */
  includeWithdrawn?: boolean;
  now?: Date;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  const role = memberRole(session, actor, options.workspaceId, context);
  const includeWithdrawn = options.includeWithdrawn === true && role === 'Workspace Administrator';
  const now = options.now ?? new Date();
  const parts: AuthorizationPart[] = [];
  const reports = session.state.reports
    .filter((report) => report.workspace_id === options.workspaceId)
    .flatMap((report) => {
      // Only an approved (published) Template exposes its Report as stock; a
      // candidate Report stays review evidence until Approval publishes both.
      const ownerTemplate = findReportTemplate(session.state.report_templates, report.template.report_template_id);
      if (ownerTemplate === undefined || ownerTemplate.published_version !== report.template.version) return [];
      if (report.withdrawn_at !== null && !includeWithdrawn) return [];
      if (purgeRevoked(session.state, 'report', report.report_id)
        || isPastRetention(session.state, report.workspace_id, 'report', report.generated_at, now)) return [];
      const scope = currentReportScope(session, actor.user, role, report);
      if (scope === null) return [];
      if (role !== 'Workspace Administrator' && scope.fingerprint !== report.security.scope_fingerprint) return [];
      const authorization = scopeAuthorization(report.data_product.data_product_id, scope);
      if (!parts.some((part) => part.data_product_id === authorization.data_product_id
        && part.scope_fingerprint === authorization.scope_fingerprint)) {
        parts.push(authorization);
      }
      const ageMinutes = reportAgeMinutes(report, now);
      const product = findDataProduct(session.state.data_products, report.data_product.data_product_id);
      const serving = product === undefined ? null : servingContract(session, product);
      return [{
        report_id: report.report_id,
        template: { ...report.template },
        data_product: { ...report.data_product },
        question: report.question,
        generated_at: report.generated_at,
        completion: { ...report.completion, limitations: [...report.completion.limitations] },
        withdrawn_at: report.withdrawn_at,
        age_minutes: Math.round(ageMinutes * 1000) / 1000,
        max_age_minutes: report.freshness_policy.max_age_minutes,
        fresh: report.withdrawn_at === null
          && serving !== null
          && report.data_product.data_product_release === serving.release.release
          && ageMinutes <= report.freshness_policy.max_age_minutes
          && scope.fingerprint === report.security.scope_fingerprint,
      }];
    });
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { reports_returned: reports.length },
  });
  return {
    origin: 'stock',
    workspace_id: options.workspaceId,
    reports,
    authorization: authorizationView(options.workspaceId, role, parts),
  };
}

/**
 * Withdraws one exact Report. Withdrawal is a lifecycle fact, not a deletion:
 * the Report leaves stock reuse and ordinary retrieval, while its content,
 * Provenance, and Approval history remain readable by administrators.
 */
export function withdrawReport(options: {
  root: string;
  masterKey: string;
  token: string;
  reportId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_withdrawal',
    scope: 'workspace',
    target: options.reportId,
  };
  const actor = resolveActor(session, options.token, context);
  const report = findReport(session.state.reports, options.reportId);
  if (!report) {
    deny(session, actorLabel(actor.user), context, 'REPORT_NOT_AVAILABLE', 'The Report is not available to this actor.');
  }
  requireWorkspaceAdministrator(session, actor, { ...context, workspace_id: report.workspace_id }, report.workspace_id);
  if (report.withdrawn_at !== null) {
    return {
      summary: '该报告此前已撤回，治理历史保持不变。',
      report_id: report.report_id,
      withdrawn_at: report.withdrawn_at,
      already_withdrawn: true,
    };
  }
  report.withdrawn_at = new Date().toISOString();
  report.withdrawn_by = actor.user.user_id;
  session.audit({
    ...context,
    workspace_id: report.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      report_template_id: report.template.report_template_id,
      template_version: report.template.version,
      withdrawn_at: report.withdrawn_at,
    },
  });
  session.save();
  return {
    summary: '已撤回该报告：它不再参与库存复用和普通检索，治理历史与来源信息完整保留。',
    report_id: report.report_id,
    withdrawn_at: report.withdrawn_at,
    already_withdrawn: false,
  };
}

/**
 * Withdraws one exact Report Template Version. Withdrawal stops future matching
 * and generation from that Version; Reports already generated from it stay
 * readable, so governed history is preserved rather than erased.
 */
export function withdrawReportTemplate(options: {
  root: string;
  masterKey: string;
  token: string;
  reportTemplateId: string;
  version: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_template_withdrawal',
    scope: 'workspace',
    target: options.reportTemplateId,
  };
  const actor = resolveActor(session, options.token, context);
  const template = findReportTemplate(session.state.report_templates, options.reportTemplateId);
  if (!template) {
    deny(session, actorLabel(actor.user), context, 'REPORT_TEMPLATE_NOT_AVAILABLE', 'The Report Template is not available to this actor.');
  }
  requireWorkspaceAdministrator(session, actor, { ...context, workspace_id: template.workspace_id }, template.workspace_id);
  const version = findReportTemplateVersion(template, options.version);
  if (!version) {
    reject(
      session,
      actorLabel(actor.user),
      { ...context, workspace_id: template.workspace_id },
      'REPORT_TEMPLATE_VERSION_NOT_FOUND',
      'The requested Report Template Version does not exist.',
    );
  }
  if (version.withdrawn_at !== null) {
    return {
      summary: '该模板版本此前已撤回，治理历史保持不变。',
      report_template_id: template.report_template_id,
      template_version: version.version,
      withdrawn_at: version.withdrawn_at,
      already_withdrawn: true,
    };
  }
  version.withdrawn_at = new Date().toISOString();
  version.withdrawn_by = actor.user.user_id;
  session.audit({
    ...context,
    workspace_id: template.workspace_id,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      template_version: version.version,
      withdrawn_at: version.withdrawn_at,
    },
  });
  session.save();
  return {
    summary: '已撤回该模板版本：它不再匹配库存或生成新报告，已生成的报告仍按治理历史保留。',
    report_template_id: template.report_template_id,
    template_version: version.version,
    withdrawn_at: version.withdrawn_at,
    already_withdrawn: false,
  };
}
