import { resolveActor } from './auth.js';
import { actorLabel, deny, reject, type ActionContext } from './authz.js';
import {
  findModelBinding,
  findModelProfile,
  findModelProfileVersion,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductArtifact,
  type DataProductContract,
  type DataProductRelease,
  type DataProductVersion,
  type ModelProfileArtifact,
  type ModelProfileVersion,
  type ReportRecord,
  type WorkspaceModelBindingRecord,
} from './catalog.js';
import { isRecord } from './documents.js';
import { OperatorError } from './errors.js';
import {
  classifyResult,
  freshnessOf,
  groupLabel,
  narrationFacts,
  narrativeViolation,
  type NarratablePart,
} from './governed-result.js';
import { memberReader, type GrantReader, type GrantScope } from './grants.js';
import { pinnedForBinding } from './model-profile.js';
import {
  generateClarification,
  generateForPurpose,
  generateGroundedNarration,
  isSimplifiedChinese,
  queryPlanFailure,
} from './model-generation.js';
import {
  decodeConversation,
  encodeConversation,
  encodeProductHandle,
  normalizeQuestion,
  type ConversationPayload,
} from './nlq-handles.js';
import { workspaceRoleOf } from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { contractView, productIdentity, requireReadableProduct } from './products.js';
import {
  authorizationView,
  reportView,
  reuseReport,
  scopeAuthorization,
  type ReportReuse,
} from './reports.js';
import { openPlatform, type PlatformSession } from './session.js';

/** The distinct structured outcomes one Natural-Language Query turn may report. */
export type NaturalLanguageOutcome =
  | 'answered'
  | 'clarification'
  | 'empty'
  | 'no_evidence'
  | 'unavailable'
  | 'refused'
  | 'partial';

/** One governed default the platform applied and therefore has to disclose. */
interface AppliedDefault {
  name: string;
  value: string | number | boolean | string[];
}

/** A refusal this module decides before or around the deterministic engine. */
class NaturalLanguageFailure extends Error {
  readonly code: string;
  readonly nextStep: string | undefined;

  constructor(code: string, message: string, nextStep?: string) {
    super(message);
    this.code = code;
    this.nextStep = nextStep;
  }
}

/** The exact binding, profile version, and pin one turn runs under. */
interface ResolvedModel {
  binding: WorkspaceModelBindingRecord;
  profile: ModelProfileArtifact;
  version: ModelProfileVersion;
  pin: ReturnType<typeof pinnedForBinding>;
  narration: boolean;
  clarification: boolean;
}

/**
 * One Data Product this turn may query, resolved from the current membership,
 * Grants, Contract line, and Release. A target exists only while the actor may
 * read it, so a plan can never name a Product the platform did not authorize.
 */
interface PartTarget {
  /** The opaque handle this turn's plan input names the Product by. */
  handle: string;
  product: DataProductArtifact;
  version: DataProductVersion;
  release: DataProductRelease;
  /** The exact authorization this part reads under, disclosed with the answer. */
  scope: GrantScope;
  /** The Contract exactly as this reader may see it. */
  authorized: Record<string, unknown>;
  identity: Record<string, unknown>;
}

/** One independent part of the plan, from its raw request to its compiled request. */
interface PlannedPart {
  /** Nothing when the plan named a Product handle this turn never authorized. */
  target: PartTarget | null;
  /** The raw request the model stated, before compilation. */
  raw: Record<string, unknown> | null;
  /** The compiled request in the Contract's published vocabulary. */
  request: Record<string, unknown> | null;
  defaults: AppliedDefault[];
  interpretation: string;
  failure: { code: string; limitation: string } | null;
}

const ALL_TIME = /全部|所有|累计|历史|至今|总体|不限时间/u;
const ALL_METRICS = /全部指标|所有指标|各指标|各项指标/u;
const GROUPING = /各|按|每个|分别|分组/u;
const PLAN_QUERY_KEYS = [
  'kind', 'filters', 'metric_filters', 'group_by', 'metrics', 'sort',
  'window', 'comparison', 'include_totals', 'limit', 'q',
];
const RELEASE_PIN_KEYS = ['release', 'major', 'cursor'];

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The Contract exactly as one reader may see it: the Grant's columns already
 * narrowed the fields, dimensions, metrics, and filters, the Dataset grain is
 * removed because it is not a query surface, and a time field the Grant hides
 * makes the Contract carry no time at all rather than disclose that it exists.
 */
function authorizedContract(contract: DataProductContract, scope: GrantScope): Record<string, unknown> {
  const view = contractView(contract, scope);
  const time = objectOrNull(view['time']);
  const visibleTime = time !== null
    && typeof time['field'] === 'string'
    && scope.columns.includes(time['field'])
    ? { ...time }
    : null;
  return {
    title: view['title'],
    fields: arrayOf(view['fields']).map((field) => (isRecord(field) ? { ...field } : field)),
    dimensions: stringsOf(view['dimensions']),
    metrics: arrayOf(view['metrics']).map((metric) => (isRecord(metric) ? { ...metric } : metric)),
    time: visibleTime,
    filters: stringsOf(view['filters']),
    limits: objectOrNull(view['limits']) ?? {},
  };
}

function metricNamesOf(contract: Record<string, unknown>): string[] {
  return arrayOf(contract['metrics'])
    .filter(isRecord)
    .map((metric) => metric['name'])
    .filter((name): name is string => typeof name === 'string');
}

function dimensionNamesOf(contract: Record<string, unknown>): string[] {
  return stringsOf(contract['dimensions']);
}

function filterNamesOf(contract: Record<string, unknown>): string[] {
  return stringsOf(contract['filters']);
}

/** The Contract a whole-question clarification is asked against, across parts. */
function unionAuthorized(targets: PartTarget[]): Record<string, unknown> {
  return {
    metrics: targets.flatMap((target) => arrayOf(target.authorized['metrics'])),
    dimensions: targets.flatMap((target) => dimensionNamesOf(target.authorized))
      .filter((name, index, all) => all.indexOf(name) === index),
    time: targets.some((target) => target.authorized['time'] !== null) ? {} : null,
  };
}

/**
 * The one Workspace Model Binding this turn runs under. A named Binding must
 * belong to the Workspace and permit query planning; without one, the first
 * active Binding that permits planning is used.
 */
function resolveModel(
  session: PlatformSession,
  workspaceId: string,
  bindingId: string | undefined,
): ResolvedModel | null {
  const candidates = session.state.model_bindings.filter(
    (candidate) => candidate.workspace_id === workspaceId
      && candidate.revoked_at === null
      && candidate.purposes.includes('query_plan'),
  );
  const binding = bindingId === undefined
    ? candidates[0]
    : findModelBinding(session.state.model_bindings, bindingId);
  if (!binding
    || binding.workspace_id !== workspaceId
    || binding.revoked_at !== null
    || !binding.purposes.includes('query_plan')) {
    return null;
  }
  const profile = findModelProfile(session.state.model_profiles, binding.model_profile_id);
  const version = findModelProfileVersion(profile, binding.model_profile_version);
  if (!profile
    || !version
    || version.content_hash !== binding.model_profile_content_hash
    || profile.activated_version !== version.version
    || !version.purposes.includes('query_plan')
    || !version.prompts.some((prompt) => prompt.id === 'query_plan')) {
    return null;
  }
  return {
    binding,
    profile,
    version,
    pin: pinnedForBinding(session, profile, version, binding),
    narration: binding.purposes.includes('grounded_narration')
      && version.purposes.includes('grounded_narration')
      && version.prompts.some((prompt) => prompt.id === 'grounded_narration'),
    clarification: binding.purposes.includes('clarification')
      && version.purposes.includes('clarification')
      && version.prompts.some((prompt) => prompt.id === 'clarification'),
  };
}

function bindingView(binding: WorkspaceModelBindingRecord): Record<string, unknown> {
  return {
    binding_id: binding.binding_id,
    model_profile_id: binding.model_profile_id,
    model_profile_version: binding.model_profile_version,
    model_profile_content_hash: binding.model_profile_content_hash,
  };
}

function modelView(model: ResolvedModel): Record<string, unknown> {
  const prompt = model.version.prompts.find((candidate) => candidate.id === 'query_plan');
  return {
    model_profile_id: model.profile.model_profile_id,
    model_profile_version: model.version.version,
    model_profile_content_hash: model.version.content_hash,
    adapter: model.version.adapter,
    model_id: model.version.model_id,
    prompt_id: 'query_plan',
    prompt_hash: prompt?.hash ?? '',
  };
}

/** The published identifiers one missing kind may offer as candidates. */
function candidatesFor(missing: string[], authorized: Record<string, unknown>): string[] {
  return missing.flatMap((kind) => {
    if (kind === 'metric') return metricNamesOf(authorized);
    if (kind === 'dimension') return dimensionNamesOf(authorized);
    return [];
  }).filter((candidate, index, all) => all.indexOf(candidate) === index);
}

interface Ambiguity {
  missing: string[];
  candidates: string[];
}

/**
 * Material ambiguity is decided deterministically, never by the model's prose:
 * a missing period, an unresolved metric, or a grouping the question asks for
 * but the plan does not state all block execution. The model's own `clarify`
 * action is honoured on top of these checks.
 */
function materialAmbiguity(
  plan: Record<string, unknown>,
  question: string,
  authorized: Record<string, unknown>,
): Ambiguity | null {
  const declared = stringsOf(plan['missing']);
  if (plan['action'] === 'clarify') {
    const candidates = stringsOf(plan['candidates']);
    const derived = candidatesFor(declared, authorized);
    return {
      missing: declared,
      candidates: candidates.length > 0 ? candidates : derived,
    };
  }
  const query = objectOrNull(plan['query']);
  if (query === null) return null;
  const kind = query['kind'];
  const missing: string[] = [];
  const hasWindow = query['window'] !== undefined;
  if ((kind === 'records' || kind === 'aggregate')
    && authorized['time'] !== null
    && !hasWindow
    && !ALL_TIME.test(question)) {
    missing.push('period');
  }
  if (kind === 'aggregate') {
    const metrics = stringsOf(query['metrics']);
    const published = metricNamesOf(authorized);
    if (metrics.length === 0 && published.length > 1 && !ALL_METRICS.test(question)) {
      missing.push('metric');
    }
    const groupBy = stringsOf(query['group_by']);
    if (groupBy.length === 0 && GROUPING.test(question) && dimensionNamesOf(authorized).length > 0) {
      missing.push('dimension');
    }
  }
  if (missing.length === 0) return null;
  const unique = missing.filter((entry, index, all) => all.indexOf(entry) === index);
  return { missing: unique, candidates: candidatesFor(unique, authorized) };
}

/** The first part of a compound question whose own request is materially ambiguous. */
function partAmbiguity(
  parts: PlannedPart[],
  question: string,
): { ambiguity: Ambiguity; part: PartTarget } | null {
  for (const part of parts) {
    if (part.target === null || part.failure !== null || part.raw === null) continue;
    const ambiguity = materialAmbiguity(
      { action: 'query', query: part.raw },
      question,
      part.target.authorized,
    );
    if (ambiguity !== null) return { ambiguity, part: part.target };
  }
  return null;
}

function fallbackClarification(missing: string[]): string {
  if (missing.includes('metric')) return '请确认要统计哪个已发布的指标。';
  if (missing.includes('dimension')) return '请确认要按哪个已发布的维度分组。';
  if (missing.includes('filter_value')) return '请确认筛选条件具体对应哪个取值。';
  return '请确认要统计的时间范围（起止日期）。';
}

function clarificationLimitation(missing: string[]): string {
  if (missing.includes('period')) return '缺少明确的时间范围，平台未执行查询。';
  if (missing.includes('metric')) return '缺少明确的已发布指标，平台未执行查询。';
  if (missing.includes('dimension')) return '缺少明确的已发布分组维度，平台未执行查询。';
  if (missing.includes('filter_value')) return '筛选条件的取值不明确，平台未执行查询。';
  return '业务范围不明确，平台未执行查询。';
}

/**
 * Compiles a validated part into the published query vocabulary. Release
 * pinning is refused rather than honoured: a Natural-Language Query always
 * reads the Data Product's current Release. Metrics, dimensions, and filters
 * are checked against the authorized Contract before the engine sees them, so
 * a refused plan never confirms whether a hidden name exists.
 */
function compileQuery(
  plan: Record<string, unknown>,
  authorized: Record<string, unknown>,
  defaultLimit: number,
): { request: Record<string, unknown>; defaults: AppliedDefault[] } {
  const planQuery = objectOrNull(plan['query']);
  if (planQuery === null) {
    throw new NaturalLanguageFailure('QUERY_PLAN_QUERY_MISSING', 'The plan states no query.');
  }
  const pinned = RELEASE_PIN_KEYS.find((key) => planQuery[key] !== undefined);
  if (pinned !== undefined) {
    throw new NaturalLanguageFailure(
      'NLQ_RELEASE_PIN_REFUSED',
      'A Natural-Language Query reads the Data Product\'s current Release, so a plan cannot pin one.',
    );
  }
  const publishedMetrics = metricNamesOf(authorized);
  const unpublishedMetric = stringsOf(planQuery['metrics']).find((name) => !publishedMetrics.includes(name));
  if (unpublishedMetric !== undefined) {
    throw new NaturalLanguageFailure(
      'NLQ_METRIC_NOT_PUBLISHED',
      'The plan requests a metric this Consumer is not authorized to read.',
    );
  }
  const publishedDimensions = dimensionNamesOf(authorized);
  const unpublishedDimension = stringsOf(planQuery['group_by']).find((name) => !publishedDimensions.includes(name));
  if (unpublishedDimension !== undefined) {
    throw new NaturalLanguageFailure(
      'NLQ_DIMENSION_NOT_PUBLISHED',
      'The plan groups by a dimension this Consumer is not authorized to read.',
    );
  }
  const publishedFilters = filterNamesOf(authorized);
  const unpublishedFilter = arrayOf(planQuery['filters'])
    .filter(isRecord)
    .map((filter) => filter['field'])
    .find((field) => typeof field !== 'string' || !publishedFilters.includes(field));
  if (unpublishedFilter !== undefined) {
    throw new NaturalLanguageFailure(
      'NLQ_FILTER_NOT_PUBLISHED',
      'The plan filters on a field this Consumer is not authorized to read.',
    );
  }

  const request: Record<string, unknown> = {};
  for (const key of PLAN_QUERY_KEYS) {
    if (planQuery[key] !== undefined) request[key] = planQuery[key];
  }
  const defaults: AppliedDefault[] = [];
  if (request['limit'] === undefined) {
    request['limit'] = defaultLimit;
    defaults.push({ name: 'limit', value: defaultLimit });
  }
  if (request['kind'] === 'aggregate') {
    if (request['metrics'] === undefined) {
      defaults.push({ name: 'metrics', value: publishedMetrics });
    }
    if (request['include_totals'] === undefined) {
      request['include_totals'] = true;
      defaults.push({ name: 'include_totals', value: true });
    }
  }
  if ((request['kind'] === 'records' || request['kind'] === 'aggregate')
    && request['window'] === undefined
    && authorized['time'] !== null) {
    defaults.push({ name: 'window', value: '全部已发布记录' });
  }
  return { request, defaults };
}

function summaryOf(
  outcome: NaturalLanguageOutcome,
  result: Record<string, unknown> | null,
): string {
  if (outcome === 'clarification') return '需要补充业务范围后才能执行查询。';
  if (outcome === 'refused') return '该请求未通过已发布契约的校验，平台未执行查询。';
  if (outcome === 'unavailable') return '当前无法完成该自然语言查询，平台未执行查询。';
  if (outcome === 'empty') return '查询已执行，但所选业务范围内没有记录。';
  if (outcome === 'no_evidence') return '查询已执行，但所选业务范围内没有可引用的数值证据。';
  if (result === null) return '查询已执行。';
  const kind = result['kind'];
  if (kind === 'aggregate') {
    const metrics = arrayOf(result['metrics']).filter(isRecord);
    const groups = arrayOf(result['groups']).filter(isRecord);
    const totals = objectOrNull(result['totals']);
    const totalsMetrics = totals === null ? null : objectOrNull(totals['metrics']);
    const parts = [`已按已发布的受治理契约完成查询：共 ${String(result['groups_total'] ?? groups.length)} 组，返回 ${String(result['returned'] ?? groups.length)} 组。`];
    const first = groups[0];
    const firstMetric = metrics[0];
    const firstName = firstMetric === undefined ? undefined : firstMetric['name'];
    if (first !== undefined && typeof firstName === 'string') {
      const values = objectOrNull(first['metrics']) ?? {};
      const value = values[firstName];
      if (value !== null && value !== undefined) parts.push(`第一组${groupLabel(first)}的 ${firstName} 为 ${String(value)}。`);
    }
    if (totalsMetrics !== null) {
      const entries = Object.entries(totalsMetrics).filter(([, value]) => value !== null && value !== undefined);
      if (entries.length === 1) {
        const entry = entries[0]!;
        parts.push(`合计 ${entry[0]} 为 ${String(entry[1])}。`);
      }
    }
    return parts.join('');
  }
  if (kind === 'records') return `已按已发布的受治理契约返回 ${String(result['returned'] ?? 0)} 条记录。`;
  if (kind === 'search') return `已按已发布的受治理契约匹配 ${String(result['matched_count'] ?? 0)} 条记录。`;
  if (kind === 'suggest') return `已按已发布的受治理契约返回 ${String(result['returned'] ?? 0)} 个建议值。`;
  return '查询已执行。';
}

function multiSummary(
  outcome: NaturalLanguageOutcome,
  executed: number,
  failed: number,
): string {
  if (outcome === 'answered') return `本次自然语言查询已分别完成 ${executed} 个独立数据产品查询，结果按各部分分别披露。`;
  if (outcome === 'partial') return `本次自然语言查询有 ${failed} 个独立部分未能完成，结果不完整，已披露各部分状态。`;
  if (outcome === 'unavailable') return '本次自然语言查询的各独立部分均未能完成，平台未返回任何数据。';
  if (outcome === 'refused') return '本次自然语言查询的各独立部分均未通过已发布契约的校验，平台未执行查询。';
  if (outcome === 'empty') return '查询已执行，但所选业务范围内没有记录。';
  if (outcome === 'no_evidence') return '查询已执行，但所选业务范围内没有可引用的数值证据。';
  return '查询已执行。';
}

function engineLimitation(code: string): string {
  if (code === 'DATA_PRODUCT_NOT_PUBLISHED' || code === 'DATASET_RELEASE_NOT_FOUND') {
    return '数据产品当前不可用，平台未执行查询。';
  }
  if (code === 'DATA_PRODUCT_VERSION_WITHDRAWN'
    || code === 'DATA_PRODUCT_MAJOR_WITHDRAWN'
    || code === 'DATA_PRODUCT_RELEASE_NOT_FOUND'
    || code === 'DATA_PRODUCT_VERSION_NOT_FOUND') {
    return '数据产品当前没有可查询的发布版本，平台未执行查询。';
  }
  if (code === 'DATA_PRODUCT_QUERY_LIMIT_EXCEEDED') return '查询条数超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_TOO_COMPLEX') return '查询扫描的数据量超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_RESULT_TOO_LARGE') return '查询形成的分组数量超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_TIMEOUT') return '查询执行时间超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_INVALID') return '查询请求不是契约可以表达的请求，平台已拒绝执行。';
  return '查询请求超出了已发布契约或授权范围，平台已拒绝执行。';
}

function partCompileLimitation(code: string): string {
  if (code === 'NLQ_RELEASE_PIN_REFUSED') {
    return '自然语言查询始终读取当前数据产品发布，不接受模型指定发布版本，平台已拒绝执行。';
  }
  return '该部分查询请求超出当前消费者可见的已发布契约，平台已拒绝执行。';
}

function planLimitation(code: string): string {
  if (code === 'QUERY_PLAN_CODE_REFUSED') {
    return '模型给出的请求包含可执行数据库代码（SQL、公式、连接或跨产品关联），平台已拒绝执行。';
  }
  if (code === 'QUERY_PLAN_KEY_UNSUPPORTED') {
    return '模型给出的请求包含契约未发布的请求键，平台已拒绝执行。';
  }
  if (code === 'QUERY_PLAN_NOT_SIMPLIFIED_CHINESE') {
    return '模型未用简体中文说明查询意图，平台已拒绝执行。';
  }
  if (code === 'QUERY_PLAN_PARTS_REQUIRED' || code === 'QUERY_PLAN_PARTS_INVALID') {
    return '模型未按各数据产品拆分为独立查询，平台已拒绝执行。';
  }
  if (code === 'QUERY_PLAN_PARTS_UNSUPPORTED') {
    return '该查询只针对一个数据产品，模型却请求拆分多个部分，平台已拒绝执行。';
  }
  return '模型给出的查询计划不符合已发布契约，平台已拒绝执行。';
}

function errorCodeOf(error: unknown): string {
  if (error instanceof NaturalLanguageFailure) return error.code;
  if (error instanceof OperatorError) return error.code;
  return 'MODEL_GENERATION_UNAVAILABLE';
}

function generationLimitation(error: unknown): string {
  if (error instanceof OperatorError) {
    if (error.code === 'MODEL_ENDPOINT_UNREACHABLE') return '模型端点当前不可用，平台未执行查询。';
    if (error.code === 'NARRATION_NOT_GROUNDED') return '模型叙述未能引用受治理结果，已丢弃叙述。';
    if (error.code === 'NARRATION_NOT_SIMPLIFIED_CHINESE') return '模型叙述不是简体中文，已丢弃叙述。';
    if (error.code === 'CLARIFICATION_NOT_SIMPLIFIED_CHINESE') return '模型澄清问题不是简体中文，已改用平台固定问题。';
  }
  return '模型生成当前不可用，平台未执行查询。';
}

/** A part that could not run still reports what it was and why it stopped. */
function failedPart(
  target: PartTarget | null,
  outcome: 'refused' | 'unavailable',
  code: string,
  limitation: string,
  interpretation: string,
): Record<string, unknown> {
  return {
    name: target === null ? null : target.product.name,
    data_product: target === null ? null : target.identity,
    status: outcome,
    outcome,
    executed: false,
    reason_code: code,
    interpretation,
    query: null,
    resolved: null,
    result: null,
    window: null,
    comparison_window: null,
    partial_period: false,
    defaults_applied: [] as AppliedDefault[],
    provenance: null,
    freshness: null,
    evidence: null,
    limitations: [limitation],
  };
}

/** One executed part, disclosing its own Release, freshness, and evidence. */
function executedPart(options: {
  target: PartTarget;
  interpretation: string;
  request: Record<string, unknown>;
  defaults: AppliedDefault[];
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const { target, result } = options;
  const outcome = classifyResult(result);
  const window = objectOrNull(result['window']);
  const comparisonWindow = objectOrNull(result['comparison_window']);
  const partial = window?.['partial'] === true;
  const provenance = objectOrNull(result['provenance']);
  const metricsUsed = new Set(
    arrayOf(result['metrics'])
      .filter(isRecord)
      .map((metric) => metric['name'])
      .filter((name): name is string => typeof name === 'string'),
  );
  const definitions = arrayOf(target.authorized['metrics'])
    .filter(isRecord)
    .filter((metric) => typeof metric['name'] === 'string' && metricsUsed.has(metric['name']))
    .map((metric) => ({ ...metric }));
  const limitations: string[] = [];
  if (outcome === 'empty') limitations.push('查询已执行，但所选业务范围内没有记录。');
  if (outcome === 'no_evidence') limitations.push('查询已执行，但所选范围内没有可引用的数值。');
  if (partial) limitations.push('查询窗口超出现有数据覆盖范围，结果为部分期间数据。');
  if (options.defaults.length > 0) {
    limitations.push(`已应用受治理默认值：${options.defaults.map((entry) => entry.name).join(', ')}。`);
  }
  return {
    name: target.product.name,
    data_product: target.identity,
    status: outcome,
    outcome,
    executed: true,
    reason_code: outcome === 'answered' ? null : outcome === 'empty' ? 'NLQ_EMPTY_RESULT' : 'NLQ_NO_EVIDENCE',
    interpretation: options.interpretation,
    query: options.request,
    resolved: {
      interpretation: options.interpretation,
      metrics: [...metricsUsed],
      dimensions: stringsOf(result['grouped_by']),
      filters: arrayOf(options.request['filters']).map((filter) => (isRecord(filter) ? { ...filter } : filter)),
      window,
      comparison_window: comparisonWindow,
      partial_period: partial,
      defaults_applied: options.defaults.map((entry) => ({ ...entry })),
    },
    result,
    window,
    comparison_window: comparisonWindow,
    partial_period: partial,
    defaults_applied: options.defaults.map((entry) => ({ ...entry })),
    provenance,
    freshness: freshnessOf(provenance, window),
    evidence: {
      query: options.request,
      metrics: definitions,
      provenance,
      release: { ...target.identity },
    },
    limitations,
  };
}

/** The overall status of a turn: one part keeps the single-product outcome. */
function overallOutcome(parts: Array<Record<string, unknown>>): NaturalLanguageOutcome {
  if (parts.length === 1) return (parts[0]!['outcome'] as NaturalLanguageOutcome);
  const executed = parts.filter((part) => part['executed'] === true);
  if (executed.length === 0) {
    return parts.every((part) => part['outcome'] === 'refused') ? 'refused' : 'unavailable';
  }
  if (executed.length < parts.length) return 'partial';
  if (parts.some((part) => part['outcome'] === 'answered')) return 'answered';
  if (parts.some((part) => part['outcome'] === 'no_evidence')) return 'no_evidence';
  return 'empty';
}

function overallReasonCode(outcome: NaturalLanguageOutcome, parts: Array<Record<string, unknown>>): string | null {
  if (parts.length === 1) return parts[0]!['reason_code'] as string | null;
  if (outcome === 'answered') return null;
  if (outcome === 'empty') return 'NLQ_EMPTY_RESULT';
  if (outcome === 'no_evidence') return 'NLQ_NO_EVIDENCE';
  if (outcome === 'partial') return 'NLQ_INCOMPLETE_PARTS';
  if (outcome === 'refused') return 'NLQ_PARTS_REFUSED';
  return 'NLQ_PARTS_UNAVAILABLE';
}

/** The distinct as-of times a compound answer has to disclose per part. */
function asOf(parts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return parts.map((part) => {
    const freshness = objectOrNull(part['freshness']);
    const identity = objectOrNull(part['data_product']);
    return {
      name: part['name'] ?? null,
      data_product_id: identity?.['data_product_id'] ?? null,
      data_product_release: identity?.['data_product_release'] ?? null,
      executed: part['executed'] === true,
      released_at: freshness?.['released_at'] ?? null,
      data_through: freshness?.['data_through'] ?? null,
    };
  });
}

function distinctAsOf(asOfTimes: Array<Record<string, unknown>>): boolean {
  const executed = asOfTimes.filter((entry) => entry['executed'] === true);
  if (executed.length < 2) return false;
  const stamps = new Set(executed.map((entry) => `${String(entry['released_at'])}|${String(entry['data_through'])}`));
  return stamps.size > 1;
}

/** Base response every turn fills in, so a refusal never answers half a shape. */
function baseResponse(question: string, workspaceId: string): Record<string, unknown> {
  return {
    outcome: 'unavailable' as NaturalLanguageOutcome,
    status: 'incomplete' as 'complete' | 'incomplete',
    workspace_id: workspaceId,
    question,
    normalized_question: question,
    follow_up: false,
    /** Whether this turn generated its answer or reused a stocked Report. */
    origin: 'generated' as 'stock' | 'generated',
    stock: null as Record<string, unknown> | null,
    refresh: null as Record<string, unknown> | null,
    report: null as Record<string, unknown> | null,
    template: null as Record<string, unknown> | null,
    authorization: null as Record<string, unknown> | null,
    reason_code: null,
    executed: false,
    summary: '当前无法完成该自然语言查询，平台未执行查询。',
    limitations: [] as string[],
    data_product: null,
    parts: [] as Array<Record<string, unknown>>,
    as_of: [] as Array<Record<string, unknown>>,
    binding: null,
    model: null,
    interpretation: null,
    resolved: null,
    clarification: null,
    query: null,
    result: null,
    answer: null,
    window: null,
    comparison_window: null,
    partial_period: false,
    defaults_applied: [] as AppliedDefault[],
    provenance: null,
    freshness: null,
    conversation: null as string | null,
  };
}

/** The structured reason code one stocked or freshly generated Report reports. */
function reportReasonCode(report: ReportRecord): string | null {
  if (report.completion.status === 'incomplete') return 'REPORT_INCOMPLETE';
  if (report.completion.outcome === 'empty') return 'REPORT_EMPTY_RESULT';
  if (report.completion.outcome === 'no_evidence') return 'REPORT_NO_EVIDENCE';
  return null;
}

/**
 * Shapes one turn answered from a Template. A stock answer discloses that no
 * query ran and no model was called; a generated answer discloses that a new
 * Report was stored. Both disclose the exact Template, Releases, Provenance,
 * freshness, completion status, and current effective authorization.
 */
function reportTurnResponse(
  response: Record<string, unknown>,
  reuse: Exclude<ReportReuse, { kind: 'none' }>,
  authorization: Record<string, unknown>,
  conversation: string,
): Record<string, unknown> {
  const report = reuse.report;
  const result = report.result;
  const window = objectOrNull(result['window']);
  const comparisonWindow = objectOrNull(result['comparison_window']);
  const partial = report.completion.partial_period;
  const executed = reuse.kind === 'generated';
  const metrics = arrayOf(result['metrics'])
    .filter(isRecord)
    .map((metric) => metric['name'])
    .filter((name): name is string => typeof name === 'string');
  const reasonCode = reportReasonCode(report);
  const dataProduct = { ...report.data_product, contract_version: { ...report.data_product.contract_version } };
  const part = {
    name: report.data_product.name,
    data_product: dataProduct,
    status: report.completion.outcome,
    outcome: report.completion.outcome,
    executed,
    reason_code: reasonCode,
    interpretation: report.interpretation,
    query: { ...report.query },
    resolved: {
      interpretation: report.interpretation,
      metrics,
      dimensions: stringsOf(result['grouped_by']),
      filters: arrayOf(report.query['filters']).map((filter) => (isRecord(filter) ? { ...filter } : filter)),
      window,
      comparison_window: comparisonWindow,
      partial_period: partial,
      defaults_applied: [] as AppliedDefault[],
    },
    result,
    window,
    comparison_window: comparisonWindow,
    partial_period: partial,
    defaults_applied: [] as AppliedDefault[],
    provenance: report.provenance,
    freshness: report.freshness,
    evidence: {
      query: { ...report.query },
      provenance: report.provenance,
      release: dataProduct,
      template: { ...report.template },
    },
    limitations: [...report.completion.limitations],
  };
  const limitations = [...report.completion.limitations];
  if (report.completion.status === 'incomplete') {
    limitations.push('报告为不完整结果，请结合限制说明阅读。');
  }
  const summary = reuse.kind === 'stock'
    ? `本次回答直接复用已入库的报告（模板第 ${report.template.version} 版），未重新执行查询，也未调用模型。`
    : reuse.superseded === null
      ? `平台已按模板第 ${report.template.version} 版生成新的报告。`
      : `原报告已过期或不再满足当前发布与授权，平台已按模板第 ${report.template.version} 版生成新的报告。`;
  if (reuse.kind === 'stock') {
    limitations.push('该报告仍处于模板允许的有效期内，已直接复用。');
  }
  Object.assign(response, {
    outcome: report.completion.outcome,
    status: report.completion.status,
    origin: reuse.kind,
    stock: reuse.kind === 'stock'
      ? {
        report_id: report.report_id,
        reused: true,
        generated_at: report.generated_at,
        age_minutes: Math.round(reuse.ageMinutes * 1000) / 1000,
        max_age_minutes: report.freshness_policy.max_age_minutes,
      }
      : null,
    refresh: reuse.kind === 'generated'
      ? {
        reason: reuse.superseded === null ? 'initial' : 'stale',
        superseded_report_id: reuse.superseded === null ? null : reuse.superseded.report_id,
      }
      : null,
    executed,
    reason_code: reasonCode,
    summary,
    limitations,
    data_product: dataProduct,
    interpretation: report.interpretation,
    resolved: part.resolved,
    query: { ...report.query },
    result,
    answer: report.narrative === null
      ? null
      : {
        narrative: report.narrative.narrative,
        evidence_refs: report.narrative.evidence_refs.map((entry) => ({ ...entry })),
        model: { ...report.narrative.model },
      },
    window,
    comparison_window: comparisonWindow,
    partial_period: partial,
    defaults_applied: [] as AppliedDefault[],
    provenance: report.provenance,
    freshness: report.freshness,
    parts: [part],
    as_of: [{
      name: report.data_product.name,
      data_product_id: report.data_product.data_product_id,
      data_product_release: report.data_product.data_product_release,
      executed,
      released_at: report.freshness === null ? null : report.freshness['released_at'] ?? null,
      data_through: report.freshness === null ? null : report.freshness['data_through'] ?? null,
    }],
    report: reportView(report),
    template: { ...report.template },
    authorization,
    binding: null,
    model: null,
    conversation,
  });
  return response;
}

/** The Data Products one Workspace turn may query, in a stable order. */
function visibleTargets(
  session: PlatformSession,
  reader: GrantReader,
  userId: string,
  workspaceId: string,
): PartTarget[] {
  return session.state.data_products
    .filter((product) => product.workspace_id === workspaceId && product.releases.length > 0)
    .sort((left, right) => {
      if (left.name === right.name) return left.data_product_id < right.data_product_id ? -1 : 1;
      return left.name < right.name ? -1 : 1;
    })
    .flatMap((product) => {
      const target = targetFor(session, reader, userId, workspaceId, product);
      return target === null ? [] : [target];
    });
}

/** One Product as this turn may read it, or nothing when no scope applies. */
function targetFor(
  session: PlatformSession,
  reader: GrantReader,
  userId: string,
  workspaceId: string,
  product: DataProductArtifact,
): PartTarget | null {
  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  if (!version || !release) return null;
  const scope = reader.scopeOf(product, version.contract);
  if (scope === null) return null;
  return {
    handle: encodeProductHandle(session.dataKey, {
      userId,
      workspaceId,
      dataProductId: product.data_product_id,
    }),
    product,
    version,
    release,
    scope,
    authorized: authorizedContract(version.contract, scope),
    identity: productIdentity(product, version, release),
  };
}

/** What one turn was asked, whichever surface reached it. */
interface TurnOptions {
  root: string;
  masterKey: string;
  token: string;
  question: string;
  clarification?: string;
  bindingId?: string;
  conversation?: string;
  /** The instant freshness is evaluated at; absent reads the current clock. */
  now?: string;
  /** The one Product a single-product turn reads, or nothing for a Workspace turn. */
  dataProductId?: string;
  workspaceId?: string;
}

/**
 * Answers one Natural-Language Query turn.
 *
 * The model only ever compiles the question into independent *requests* in each
 * Contract's own published vocabulary; it never sees a pre-Grant Contract, never
 * produces database code, and never composes products into one request. Every
 * number comes from `executeDataProductQuery` within one Product's own Release,
 * and a narrative is accepted only when it cites the governed evidence, adds no
 * cause, invents no relationship, and states no number of its own.
 *
 * A follow-up is normalized and reauthorized from the current state: the
 * conversation handle only records what the previous turn said, so a revoked
 * membership, changed Grant, or advanced Release takes effect on the next turn.
 */
async function askNaturalLanguageQuery(options: TurnOptions): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const entry: ActionContext = {
    action: 'natural_language_query',
    scope: 'workspace',
    ...(options.dataProductId === undefined ? {} : { target: options.dataProductId }),
  };
  const actor = resolveActor(session, options.token, entry);
  const question = normalizeQuestion(options.question);
  if (question.length === 0) {
    reject(session, actorLabel(actor.user), entry, 'NLQ_QUESTION_REQUIRED', 'A Natural-Language Query must state a question.');
  }
  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(now.getTime())) {
    reject(session, actorLabel(actor.user), entry, 'NLQ_AT_INVALID', 'A Natural-Language Query freshness instant must be an ISO 8601 instant.');
  }

  const requestedProduct = options.dataProductId === undefined
    ? null
    : requireReadableProduct(session, actor, entry, options.dataProductId);
  const workspaceId = requestedProduct?.workspace_id ?? options.workspaceId ?? '';
  const role = workspaceRoleOf(session.state, actor.user.user_id, workspaceId);
  if (role === null) {
    deny(
      session,
      actorLabel(actor.user),
      { ...entry, workspace_id: workspaceId },
      'WORKSPACE_ACCESS_DENIED',
      'The Workspace is not available to this actor.',
    );
  }
  const reader = memberReader(session, actor.user, role);
  const scoped: ActionContext = {
    ...entry,
    workspace_id: workspaceId,
    ...(requestedProduct === null ? {} : { target: requestedProduct.data_product_id }),
  };
  const response = baseResponse(question, workspaceId);
  response['authorization'] = authorizationView(workspaceId, role, []);

  let prior: ConversationPayload = { workspaceId, userId: actor.user.user_id, questions: [], productIds: [] };
  if (options.conversation !== undefined) {
    try {
      prior = decodeConversation(
        session.dataKey,
        { userId: actor.user.user_id, workspaceId },
        options.conversation,
        (code, message) => {
          throw new NaturalLanguageFailure(code, message);
        },
      );
    } catch (error) {
      response['outcome'] = 'refused';
      response['reason_code'] = errorCodeOf(error);
      response['limitations'] = ['会话句柄不是本部署为该用户在此工作空间签发的，平台未执行查询。'];
      response['summary'] = summaryOf('refused', null);
      return finishTurn(session, scoped, reader, response, question, prior);
    }
  }
  response['follow_up'] = prior.questions.length > 0;

  let identity: Record<string, unknown> | null = null;
  if (requestedProduct !== null) {
    const version = latestDataProductVersion(requestedProduct);
    const release = latestDataProductRelease(requestedProduct);
    identity = version !== undefined && release !== undefined
      ? productIdentity(requestedProduct, version, release)
      : null;
  }
  response['data_product'] = identity;

  // Stock reuse is attempted before any Data Product Query or model call. Only
  // an exact normalized question that names a published Template Version can
  // match; a matched Template whose Report is absent, stale, pinned to an older
  // Release, or generated under another authorization produces a fresh Report
  // under exactly this reader. A Template that cannot produce one falls through
  // to the settled Natural-Language Query path below.
  if (options.clarification === undefined) {
    const reuse = await reuseReport({
      session,
      actor,
      reader,
      workspaceId,
      role,
      question,
      now,
      ...(requestedProduct === null ? {} : { dataProductId: requestedProduct.data_product_id }),
    });
    if (reuse.kind !== 'none') {
      const conversation = encodeConversation(session.dataKey, {
        workspaceId,
        userId: actor.user.user_id,
        questions: [...prior.questions, question],
        productIds: [reuse.report.data_product.data_product_id],
      });
      return finishTurn(
        session,
        scoped,
        reader,
        reportTurnResponse(
          response,
          reuse,
          authorizationView(workspaceId, role, [reuse.authorization]),
          conversation,
        ),
        question,
        prior,
      );
    }
  }

  let targets: PartTarget[];
  if (requestedProduct !== null) {
    const version = latestDataProductVersion(requestedProduct);
    const release = latestDataProductRelease(requestedProduct);
    if (!version || !release) {
      response['outcome'] = 'unavailable';
      response['reason_code'] = 'DATA_PRODUCT_NOT_PUBLISHED';
      response['limitations'] = ['数据产品当前没有可查询的发布版本，平台未执行查询。'];
      return finishTurn(session, scoped, reader, response, question, prior);
    }
    const scope = reader.scopeOf(requestedProduct, version.contract);
    if (scope === null) {
      response['outcome'] = 'refused';
      response['reason_code'] = 'NLQ_SCOPE_UNAVAILABLE';
      response['limitations'] = ['当前授权范围无法应用于该数据产品契约，平台未执行查询。'];
      return finishTurn(session, scoped, reader, response, question, prior);
    }
    targets = [{
      handle: encodeProductHandle(session.dataKey, {
        userId: actor.user.user_id,
        workspaceId,
        dataProductId: requestedProduct.data_product_id,
      }),
      product: requestedProduct,
      version,
      release,
      scope,
      authorized: authorizedContract(version.contract, scope),
      identity: productIdentity(requestedProduct, version, release),
    }];
  } else {
    targets = visibleTargets(session, reader, actor.user.user_id, workspaceId);
    if (targets.length === 0) {
      response['outcome'] = 'unavailable';
      response['reason_code'] = 'NLQ_NO_VISIBLE_PRODUCT';
      response['limitations'] = ['该工作空间没有当前消费者可查询的已发布数据产品，平台未执行查询。'];
      return finishTurn(session, scoped, reader, response, question, prior);
    }
  }
  const byHandle = new Map(targets.map((target) => [target.handle, target]));
  response['authorization'] = authorizationView(
    workspaceId,
    role,
    targets.map((target) => scopeAuthorization(target.product.data_product_id, target.scope)),
  );

  const model = resolveModel(session, workspaceId, options.bindingId);
  if (model === null) {
    response['outcome'] = 'unavailable';
    response['reason_code'] = 'NLQ_BINDING_UNAVAILABLE';
    response['limitations'] = ['该工作空间没有可用于自然语言查询的模型绑定，平台未执行查询。'];
    return finishTurn(session, scoped, reader, response, question, prior);
  }
  response['binding'] = bindingView(model.binding);
  response['model'] = modelView(model);

  const adapterFail = (code: string, message: string): never => {
    throw new NaturalLanguageFailure(code, message);
  };
  const planInput = requestedProduct === null
    ? {
      question,
      clarification: options.clarification === undefined ? null : options.clarification,
      today: new Date().toISOString().slice(0, 10),
      follow_up: prior.questions.length > 0,
      prior_questions: [...prior.questions],
      products: targets.map((target) => ({
        ref: target.handle,
        name: target.product.name,
        defaults: { limit: target.version.contract.default_limit },
        ...target.authorized,
      })),
    }
    : {
      question,
      clarification: options.clarification === undefined ? null : options.clarification,
      today: new Date().toISOString().slice(0, 10),
      follow_up: prior.questions.length > 0,
      prior_questions: [...prior.questions],
      contract: targets[0]!.authorized,
      defaults: { limit: targets[0]!.version.contract.default_limit },
    };

  let plan: Record<string, unknown>;
  try {
    const answer = await generateForPurpose(model.pin, 'query_plan', planInput, adapterFail);
    plan = answer.output;
    if (answer.tool_calls.length > 0) {
      throw new NaturalLanguageFailure('QUERY_PLAN_TOOL_NOT_PERMITTED', 'The plan used a tool the purpose does not expose.');
    }
  } catch (error) {
    const code = errorCodeOf(error);
    response['outcome'] = code.startsWith('QUERY_PLAN_') ? 'refused' : 'unavailable';
    response['reason_code'] = code;
    response['limitations'] = [generationLimitation(error)];
    return finishTurn(session, scoped, reader, response, question, prior);
  }

  const planFailure = queryPlanFailure(plan, requestedProduct === null ? 'parts' : 'query');
  const interpretation = typeof plan['interpretation'] === 'string' ? plan['interpretation'].trim() : '';
  if (planFailure !== null || !isSimplifiedChinese(interpretation)) {
    const code = planFailure ?? 'QUERY_PLAN_NOT_SIMPLIFIED_CHINESE';
    response['outcome'] = 'refused';
    response['reason_code'] = code;
    // A refused plan's prose is never published: it failed the language gate.
    response['interpretation'] = null;
    response['limitations'] = [planLimitation(code)];
    return finishTurn(session, scoped, reader, response, question, prior);
  }
  response['interpretation'] = interpretation;

  // A whole-question clarification executes nothing and asks, in Chinese, for
  // the business scope the plan cannot resolve on its own.
  if (plan['action'] === 'clarify') {
    const ambiguity = materialAmbiguity(
      plan,
      question,
      requestedProduct === null ? unionAuthorized(targets) : targets[0]!.authorized,
    );
    if (ambiguity === null) {
      response['outcome'] = 'refused';
      response['reason_code'] = 'QUERY_PLAN_MISSING_UNDECLARED';
      response['limitations'] = [planLimitation('QUERY_PLAN_MISSING_UNDECLARED')];
      return finishTurn(session, scoped, reader, response, question, prior);
    }
    response['clarification'] = await askClarification(
      model,
      question,
      interpretation,
      ambiguity,
      null,
      targets.length,
      adapterFail,
    );
    response['outcome'] = 'clarification';
    response['reason_code'] = 'NLQ_CLARIFICATION_REQUIRED';
    response['summary'] = summaryOf('clarification', null);
    response['limitations'] = [clarificationLimitation(ambiguity.missing)];
    response['resolved'] = emptyResolved(interpretation);
    return finishTurn(session, scoped, reader, response, question, prior);
  }

  // Assemble the independent parts: a single-product turn plans one query, a
  // Workspace turn plans one part per Product handle this turn authorized.
  const planned: PlannedPart[] = [];
  if (requestedProduct !== null) {
    planned.push({
      target: targets[0]!,
      raw: objectOrNull(plan['query']),
      request: null,
      defaults: [],
      interpretation,
      failure: null,
    });
  } else {
    const seen = new Set<string>();
    for (const raw of arrayOf(plan['parts'])) {
      const record = isRecord(raw) ? raw : {};
      const handle = typeof record['product'] === 'string' ? record['product'] : '';
      const target = byHandle.get(handle) ?? null;
      const duplicate = target !== null && seen.has(target.product.data_product_id);
      if (target !== null) seen.add(target.product.data_product_id);
      if (target === null || duplicate) {
        // No part is answered from a Product this turn did not authorize, and
        // one Product is never counted twice inside the same answer.
        planned.push({
          target,
          raw: null,
          request: null,
          defaults: [],
          interpretation,
          failure: {
            code: target === null ? 'NLQ_PART_NOT_AUTHORIZED' : 'NLQ_PART_DUPLICATED',
            limitation: target === null
              ? '该部分请求的数据产品不在当前可访问范围内，平台未执行该部分查询。'
              : '同一数据产品被重复拆分为多个部分，平台已拒绝该重复部分。',
          },
        });
        continue;
      }
      planned.push({
        target,
        raw: objectOrNull(record['query']),
        request: null,
        defaults: [],
        interpretation,
        failure: null,
      });
    }
  }

  const ambiguity = partAmbiguity(planned, question);
  if (ambiguity !== null) {
    response['clarification'] = await askClarification(
      model,
      question,
      interpretation,
      ambiguity.ambiguity,
      ambiguity.part,
      targets.length,
      adapterFail,
    );
    response['outcome'] = 'clarification';
    response['reason_code'] = 'NLQ_CLARIFICATION_REQUIRED';
    response['summary'] = summaryOf('clarification', null);
    response['limitations'] = [clarificationLimitation(ambiguity.ambiguity.missing)];
    response['resolved'] = emptyResolved(interpretation);
    return finishTurn(session, scoped, reader, response, question, prior);
  }

  for (const part of planned) {
    if (part.target === null || part.failure !== null || part.raw === null) continue;
    try {
      const compiled = compileQuery(
        { action: 'query', query: part.raw },
        part.target.authorized,
        part.target.version.contract.default_limit,
      );
      part.request = compiled.request;
      part.defaults = compiled.defaults;
    } catch (error) {
      const code = errorCodeOf(error);
      part.failure = { code, limitation: partCompileLimitation(code) };
    }
  }

  const engineFail = (code: string, message: string): never => {
    throw new NaturalLanguageFailure(code, message);
  };
  const parts: Array<Record<string, unknown>> = [];
  for (const part of planned) {
    if (part.target === null || part.failure !== null || part.request === null) {
      parts.push(failedPart(
        part.target,
        'refused',
        part.failure?.code ?? 'NLQ_QUERY_REFUSED',
        part.failure?.limitation ?? '该部分查询未能执行，平台未返回任何数据。',
        part.interpretation,
      ));
      continue;
    }
    try {
      const result = executeDataProductQuery({
        session,
        reader,
        product: part.target.product,
        context: {
          action: 'data_product_query',
          scope: 'workspace',
          workspace_id: workspaceId,
          target: part.target.product.data_product_id,
        },
        request: part.request,
        fail: engineFail,
      });
      parts.push(executedPart({
        target: part.target,
        interpretation: part.interpretation,
        request: part.request,
        defaults: part.defaults,
        result,
      }));
    } catch (error) {
      const code = errorCodeOf(error);
      const unavailable = code === 'DATA_PRODUCT_NOT_PUBLISHED'
        || code === 'DATASET_RELEASE_NOT_FOUND'
        || code === 'DATA_PRODUCT_VERSION_WITHDRAWN'
        || code === 'DATA_PRODUCT_MAJOR_WITHDRAWN'
        || code === 'DATA_PRODUCT_RELEASE_NOT_FOUND'
        || code === 'DATA_PRODUCT_VERSION_NOT_FOUND';
      parts.push(failedPart(
        part.target,
        unavailable ? 'unavailable' : 'refused',
        code,
        engineLimitation(code),
        part.interpretation,
      ));
    }
  }

  response['parts'] = parts;
  response['executed'] = parts.some((part) => part['executed'] === true);
  const outcome = overallOutcome(parts);
  response['outcome'] = outcome;
  response['reason_code'] = overallReasonCode(outcome, parts);
  response['status'] = parts.length > 0 && parts.every((part) => part['executed'] === true)
    ? 'complete'
    : 'incomplete';
  const asOfTimes = asOf(parts);
  response['as_of'] = asOfTimes;

  const executedCount = parts.filter((part) => part['executed'] === true).length;
  const failedCount = parts.length - executedCount;
  response['summary'] = parts.length === 1
    ? summaryOf(outcome, objectOrNull(parts[0]!['result']))
    : multiSummary(outcome, executedCount, failedCount);

  // A compound answer discloses every part's own limitation, named by its Product.
  const limitations: string[] = [];
  const named = parts.length > 1;
  for (const part of parts) {
    const name = typeof part['name'] === 'string' ? part['name'] : null;
    for (const line of stringsOf(part['limitations'])) {
      limitations.push(named && name !== null ? `${name}部分：${line}` : line);
    }
  }
  if (named && distinctAsOf(asOfTimes)) {
    limitations.push('各部分的数据截止时间不同，已按各自的发布版本分别披露。');
  }
  if (options.conversation !== undefined && requestedProduct === null) {
    const visibleIds = new Set(targets.map((target) => target.product.data_product_id));
    const dropped = prior.productIds.filter((id) => !visibleIds.has(id));
    if (dropped.length > 0) {
      limitations.push('会话中引用的上一轮数据产品当前不可访问，平台未将其纳入本次查询。');
    }
  }

  // Project the single part onto the legacy top-level shape, so a one-product
  // question keeps exactly the answer shape it always had.
  if (parts.length === 1) {
    const part = parts[0]!;
    response['data_product'] = part['data_product'];
    response['interpretation'] = part['interpretation'];
    response['query'] = part['query'];
    response['resolved'] = part['resolved'];
    response['result'] = part['result'];
    response['window'] = part['window'];
    response['comparison_window'] = part['comparison_window'];
    response['partial_period'] = part['partial_period'];
    response['defaults_applied'] = part['defaults_applied'];
    response['provenance'] = part['provenance'];
    response['freshness'] = part['freshness'];
  }

  if (outcome === 'answered' && model.narration) {
    const narratable: NarratablePart[] = [];
    for (const part of parts) {
      if (part['outcome'] !== 'answered' || part['executed'] !== true) continue;
      const result = objectOrNull(part['result']);
      const release = objectOrNull(part['data_product']);
      if (result === null || release === null) continue;
      narratable.push({ name: String(part['name'] ?? '数据产品'), result, release });
    }
    if (narratable.length > 0) {
      const facts = narrationFacts(narratable, question);
      if (facts.records.length > 0) {
        try {
          const narrativeAnswer = await generateGroundedNarration(model.pin, facts, adapterFail);
          const narrative = String(narrativeAnswer['narrative'] ?? '');
          const violation = narrativeViolation(narrative, facts);
          if (violation !== null) {
            limitations.push(violation === 'NARRATIVE_CAUSAL_CLAIM'
              ? '模型叙述包含证据不支持的因果表述，已丢弃叙述。'
              : violation === 'NARRATIVE_INVENTED_RELATIONSHIP'
                ? '模型叙述包含证据不支持的跨产品关联表述，已丢弃叙述。'
                : '模型叙述包含证据之外的数值，已丢弃叙述。');
            response['reason_code'] = violation;
          } else {
            response['answer'] = {
              narrative,
              evidence_refs: arrayOf(narrativeAnswer['evidence_refs']).map((reference) => (isRecord(reference) ? { ...reference } : reference)),
              model: modelView(model),
            };
          }
        } catch (error) {
          limitations.push(generationLimitation(error));
          response['reason_code'] = errorCodeOf(error);
        }
      }
    }
  }
  response['limitations'] = limitations;

  response['conversation'] = encodeConversation(session.dataKey, {
    workspaceId,
    userId: actor.user.user_id,
    questions: [...prior.questions, question],
    productIds: planned.flatMap((part) => (part.target === null ? [] : [part.target.product.data_product_id])),
  });
  return finishTurn(session, scoped, reader, response, question, prior);
}

/** A clarification names the part it is about when a question spans several. */
async function askClarification(
  model: ResolvedModel,
  question: string,
  interpretation: string,
  ambiguity: Ambiguity,
  part: PartTarget | null,
  targetCount: number,
  adapterFail: (code: string, message: string) => never,
): Promise<Record<string, unknown>> {
  let asked = fallbackClarification(ambiguity.missing);
  if (model.clarification) {
    try {
      const answer = await generateClarification(
        model.pin,
        {
          question,
          interpretation,
          missing: ambiguity.missing,
          candidates: ambiguity.candidates,
          product: part === null ? null : { name: part.product.name, title: part.authorized['title'] ?? null },
        },
        adapterFail,
      );
      asked = String(answer['question']);
    } catch {
      asked = fallbackClarification(ambiguity.missing);
    }
  }
  return {
    question: part !== null && targetCount > 1 ? `${part.product.name}部分：${asked}` : asked,
    missing: [...ambiguity.missing],
    candidates: [...ambiguity.candidates],
    part: part === null ? null : { name: part.product.name, data_product_id: part.product.data_product_id },
  };
}

function emptyResolved(interpretation: string): Record<string, unknown> {
  return {
    interpretation,
    metrics: [],
    dimensions: [],
    filters: [],
    window: null,
    comparison_window: null,
    partial_period: false,
    defaults_applied: [],
  };
}

/** Records the turn durably and returns it, so no answer is audited late. */
function finishTurn(
  session: PlatformSession,
  scoped: ActionContext,
  reader: GrantReader,
  response: Record<string, unknown>,
  question: string,
  prior: ConversationPayload,
): Record<string, unknown> {
  const outcome = response['outcome'] as NaturalLanguageOutcome;
  const binding = objectOrNull(response['binding']);
  const model = objectOrNull(response['model']);
  const template = objectOrNull(response['template']);
  const report = objectOrNull(response['report']);
  session.audit({
    ...scoped,
    actor: reader.label,
    outcome: outcome === 'refused' ? 'denied' : outcome === 'unavailable' ? 'failed' : 'succeeded',
    detail: {
      nlq_outcome: outcome,
      nlq_status: String(response['status'] ?? 'incomplete'),
      nlq_origin: String(response['origin'] ?? 'generated'),
      executed: response['executed'] === true,
      parts: arrayOf(response['parts']).length,
      parts_executed: arrayOf(response['parts']).filter((part) => isRecord(part) && part['executed'] === true).length,
      follow_up: prior.questions.length > 0,
      normalized_question: question,
      reason_code: String(response['reason_code'] ?? 'none'),
      ...(report === null || typeof report['report_id'] !== 'string'
        ? {}
        : { report_id: report['report_id'] }),
      ...(template === null || typeof template['report_template_id'] !== 'string'
        ? {}
        : { report_template_id: template['report_template_id'] }),
      ...(template === null || typeof template['version'] !== 'number'
        ? {}
        : { report_template_version: template['version'] }),
      ...(binding === null || typeof binding['binding_id'] !== 'string'
        ? {}
        : { binding_id: binding['binding_id'] }),
      ...(model === null || typeof model['model_profile_version'] !== 'number'
        ? {}
        : { model_profile_version: model['model_profile_version'] }),
    },
  });
  return response;
}

/**
 * Answers one Natural-Language Query against one published Data Product. A
 * follow-up may present the conversation handle the previous turn returned, and
 * is normalized and reauthorized against the current state before it executes.
 */
export async function askDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  question: string;
  clarification?: string;
  bindingId?: string;
  conversation?: string;
  now?: string;
}): Promise<Record<string, unknown>> {
  return askNaturalLanguageQuery({
    root: options.root,
    masterKey: options.masterKey,
    token: options.token,
    question: options.question,
    dataProductId: options.dataProductId,
    ...(options.clarification === undefined ? {} : { clarification: options.clarification }),
    ...(options.bindingId === undefined ? {} : { bindingId: options.bindingId }),
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * Answers one Natural-Language Query across the Data Products one Workspace
 * visibly publishes. Each part runs against its own Product's current Release,
 * so a compound answer never shares a snapshot and never joins products.
 */
export async function askWorkspaceQuery(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  question: string;
  clarification?: string;
  bindingId?: string;
  conversation?: string;
  now?: string;
}): Promise<Record<string, unknown>> {
  return askNaturalLanguageQuery({
    root: options.root,
    masterKey: options.masterKey,
    token: options.token,
    question: options.question,
    workspaceId: options.workspaceId,
    ...(options.clarification === undefined ? {} : { clarification: options.clarification }),
    ...(options.bindingId === undefined ? {} : { bindingId: options.bindingId }),
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
