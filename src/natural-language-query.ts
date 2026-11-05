import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import {
  findModelBinding,
  findModelProfile,
  findModelProfileVersion,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductArtifact,
  type DataProductContract,
  type ModelProfileArtifact,
  type ModelProfileVersion,
  type WorkspaceModelBindingRecord,
} from './catalog.js';
import { isRecord } from './documents.js';
import { OperatorError } from './errors.js';
import { memberReader, type GrantReader, type GrantScope } from './grants.js';
import { pinnedFor } from './model-profile.js';
import {
  generateClarification,
  generateForPurpose,
  generateGroundedNarration,
  isSimplifiedChinese,
  queryPlanFailure,
} from './model-generation.js';
import { workspaceRoleOf } from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { contractView, productIdentity, requireReadableProduct } from './products.js';
import { openPlatform, type PlatformSession } from './session.js';

/** The distinct structured outcomes one Natural-Language Query turn may report. */
export type NaturalLanguageOutcome =
  | 'answered'
  | 'clarification'
  | 'empty'
  | 'no_evidence'
  | 'unavailable'
  | 'refused';

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
  pin: ReturnType<typeof pinnedFor>;
  narration: boolean;
  clarification: boolean;
}

const ALL_TIME = /全部|所有|累计|历史|至今|总体|不限时间/u;
const ALL_METRICS = /全部指标|所有指标|各指标|各项指标/u;
const GROUPING = /各|按|每个|分别|分组/u;
const CAUSAL = /因为|由于|导致|造成|引发|因此|所以|从而|使得|because|due to|caused|led to|therefore|as a result/iu;
const NUMBERS = /\d+(?:\.\d+)?/gu;
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

function normalizedNumbers(text: string): string[] {
  return [...text.matchAll(NUMBERS)].map((match) => String(Number(match[0])));
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

/**
 * The one Workspace Model Binding this turn runs under. A named Binding must
 * belong to the Data Product's Workspace and permit query planning; without
 * one, the first active Binding that permits planning is used.
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
    pin: pinnedFor(session, profile, version),
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
 * Compiles a validated plan into the published query vocabulary. Release
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

/** Classifies one executed result into a distinct structured outcome. */
function classify(result: Record<string, unknown>): NaturalLanguageOutcome {
  const kind = result['kind'];
  if (kind === 'aggregate') {
    const groups = arrayOf(result['groups']).filter(isRecord);
    const groupTotal = Number(result['groups_total'] ?? groups.length);
    if (groupTotal === 0) return 'empty';
    const hasGroupValue = groups.some((group) => {
      const metrics = objectOrNull(group['metrics']);
      return metrics !== null && Object.values(metrics).some((value) => value !== null && value !== undefined);
    });
    if (hasGroupValue) return 'answered';
    const totals = objectOrNull(result['totals']);
    const totalsMetrics = totals === null ? null : objectOrNull(totals['metrics']);
    const hasTotalValue = totalsMetrics !== null
      && Object.values(totalsMetrics).some((value) => value !== null && value !== undefined);
    return hasTotalValue ? 'answered' : 'no_evidence';
  }
  if (kind === 'search') {
    return Number(result['matched_count'] ?? 0) === 0 ? 'empty' : 'answered';
  }
  if (kind === 'suggest') {
    return arrayOf(result['suggestions']).length === 0 ? 'empty' : 'answered';
  }
  return Number(result['returned'] ?? 0) === 0 ? 'empty' : 'answered';
}

function groupLabel(group: Record<string, unknown>): string {
  const dimensions = objectOrNull(group['group']);
  if (dimensions === null) return '所选分组';
  const values = Object.values(dimensions).map((value) => (value === null ? '未分类' : String(value)));
  return values.length === 0 ? '所选分组' : values.join(' / ');
}

/**
 * The evidence the narrative is allowed to state: only numbers the deterministic
 * engine computed, laid out as records so the shared grounding check applies.
 */
function narrationFacts(
  result: Record<string, unknown>,
  question: string,
): { question: string; records: Array<Record<string, unknown>>; filters: unknown[]; window: unknown; comparison_window: unknown; partial_period: boolean } {
  const records: Array<Record<string, unknown>> = [];
  const metrics = arrayOf(result['metrics']).filter(isRecord);
  for (const group of arrayOf(result['groups']).filter(isRecord)) {
    const values = objectOrNull(group['metrics']) ?? {};
    const label = groupLabel(group);
    for (const metric of metrics) {
      const name = metric['name'];
      const value = typeof name === 'string' ? values[name] : undefined;
      if (typeof value === 'number') {
        records.push({ label, value, metric: name, group: label });
      }
    }
  }
  if (records.length === 0) {
    const totals = objectOrNull(result['totals']);
    const totalsMetrics = totals === null ? null : objectOrNull(totals['metrics']);
    for (const metric of metrics) {
      const name = metric['name'];
      const value = typeof name === 'string' && totalsMetrics !== null ? totalsMetrics[name] : undefined;
      if (typeof value === 'number') {
        records.push({ label: `合计 ${String(name)}`, value, metric: name, group: '合计' });
      }
    }
  }
  return {
    question,
    records,
    filters: arrayOf(result['query']),
    window: result['window'] ?? null,
    comparison_window: result['comparison_window'] ?? null,
    partial_period: objectOrNull(result['window'])?.['partial'] === true,
  };
}

/** A narrative may state no cause and no number the governed evidence lacks. */
function narrativeViolation(narrative: string, facts: unknown): string | null {
  if (CAUSAL.test(narrative)) return 'NARRATIVE_CAUSAL_CLAIM';
  const governed = new Set(normalizedNumbers(JSON.stringify(facts)));
  for (const token of normalizedNumbers(narrative)) {
    if (!governed.has(token)) return 'NARRATIVE_NUMBER_NOT_GOVERNED';
  }
  return null;
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

function freshnessOf(provenance: Record<string, unknown> | null, window: Record<string, unknown> | null): Record<string, unknown> | null {
  if (provenance === null) return null;
  const coverage = window === null ? null : objectOrNull(window['coverage']);
  return {
    acquired_at: provenance['acquired_at'] ?? null,
    integrated_at: provenance['integrated_at'] ?? null,
    released_at: provenance['released_at'] ?? null,
    data_through: coverage === null ? null : coverage['end'] ?? null,
  };
}

function engineLimitation(code: string): string {
  if (code === 'DATA_PRODUCT_NOT_PUBLISHED' || code === 'DATASET_RELEASE_NOT_FOUND') {
    return '数据产品当前不可用，平台未执行查询。';
  }
  if (code === 'DATA_PRODUCT_QUERY_LIMIT_EXCEEDED') return '查询条数超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_TOO_COMPLEX') return '查询扫描的数据量超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_RESULT_TOO_LARGE') return '查询形成的分组数量超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_TIMEOUT') return '查询执行时间超过契约允许的上限，平台已拒绝执行。';
  if (code === 'DATA_PRODUCT_QUERY_INVALID') return '查询请求不是契约可以表达的请求，平台已拒绝执行。';
  return '查询请求超出了已发布契约或授权范围，平台已拒绝执行。';
}

function planLimitation(code: string): string {
  if (code === 'QUERY_PLAN_CODE_REFUSED') {
    return '模型给出的请求包含可执行数据库代码（SQL、公式或连接），平台已拒绝执行。';
  }
  if (code === 'QUERY_PLAN_KEY_UNSUPPORTED') {
    return '模型给出的请求包含契约未发布的请求键，平台已拒绝执行。';
  }
  if (code === 'QUERY_PLAN_NOT_SIMPLIFIED_CHINESE') {
    return '模型未用简体中文说明查询意图，平台已拒绝执行。';
  }
  return '模型给出的查询计划不符合已发布契约，平台已拒绝执行。';
}

function failureOf(error: unknown): NaturalLanguageFailure | null {
  return error instanceof NaturalLanguageFailure ? error : null;
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

/**
 * Answers one Natural-Language Query against one published Data Product.
 *
 * The model only ever compiles the question into a *request* in the Contract's
 * own published vocabulary; it never sees the pre-Grant Contract and never
 * produces database code. Every number comes from `executeDataProductQuery`,
 * and the narrative is accepted only when it cites the governed evidence and
 * adds no cause and no number of its own.
 */
export async function askDataProduct(options: {
  root: string;
  masterKey: string;
  token: string;
  dataProductId: string;
  question: string;
  clarification?: string;
  bindingId?: string;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'natural_language_query',
    scope: 'workspace',
    target: options.dataProductId,
  };
  const actor = resolveActor(session, options.token, context);
  const question = options.question.trim();
  if (question.length === 0) {
    reject(session, actorLabel(actor.user), context, 'NLQ_QUESTION_REQUIRED', 'A Natural-Language Query must state a question.');
  }
  const product: DataProductArtifact = requireReadableProduct(session, actor, context, options.dataProductId);
  const role = workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  const reader: GrantReader = memberReader(session, actor.user, role);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };

  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  const identity = version !== undefined && release !== undefined
    ? productIdentity(product, version, release)
    : null;

  const response: Record<string, unknown> = {
    outcome: 'unavailable' as NaturalLanguageOutcome,
    question,
    reason_code: 'DATA_PRODUCT_NOT_PUBLISHED',
    executed: false,
    summary: '当前无法完成该自然语言查询，平台未执行查询。',
    limitations: ['数据产品当前没有可查询的发布版本，平台未执行查询。'],
    data_product: identity,
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
  };
  const finish = (): Record<string, unknown> => {
    const outcome = response['outcome'] as NaturalLanguageOutcome;
    session.audit({
      ...scoped,
      actor: reader.label,
      outcome: outcome === 'refused' ? 'denied' : outcome === 'unavailable' ? 'failed' : 'succeeded',
      detail: {
        nlq_outcome: outcome,
        executed: response['executed'] === true,
        reason_code: String(response['reason_code'] ?? 'none'),
        ...(release === undefined ? {} : { data_product_release: release.release }),
        ...(isRecord(response['binding']) && typeof response['binding']['binding_id'] === 'string'
          ? { binding_id: response['binding']['binding_id'] }
          : {}),
        ...(isRecord(response['model']) && typeof response['model']['model_profile_version'] === 'number'
          ? { model_profile_version: response['model']['model_profile_version'] }
          : {}),
      },
    });
    return response;
  };
  if (version === undefined || release === undefined) {
    return finish();
  }

  const contract = version.contract;
  const scope = reader.scopeOf(product, contract);
  if (scope === null) {
    response['outcome'] = 'refused';
    response['reason_code'] = 'NLQ_SCOPE_UNAVAILABLE';
    response['limitations'] = ['当前授权范围无法应用于该数据产品契约，平台未执行查询。'];
    return finish();
  }
  const authorized = authorizedContract(contract, scope);
  const model = resolveModel(session, product.workspace_id, options.bindingId);
  if (model === null) {
    response['outcome'] = 'unavailable';
    response['reason_code'] = 'NLQ_BINDING_UNAVAILABLE';
    response['limitations'] = ['该工作空间没有可用于自然语言查询的模型绑定，平台未执行查询。'];
    return finish();
  }
  response['binding'] = bindingView(model.binding);
  response['model'] = modelView(model);

  const adapterFail = (code: string, message: string): never => {
    throw new NaturalLanguageFailure(code, message);
  };
  const planInput = {
    question,
    clarification: options.clarification === undefined ? null : options.clarification,
    today: new Date().toISOString().slice(0, 10),
    contract: authorized,
    defaults: { limit: contract.default_limit },
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
    return finish();
  }

  const planFailure = queryPlanFailure(plan);
  const interpretation = typeof plan['interpretation'] === 'string' ? plan['interpretation'].trim() : '';
  if (planFailure !== null || !isSimplifiedChinese(interpretation)) {
    const code = planFailure ?? 'QUERY_PLAN_NOT_SIMPLIFIED_CHINESE';
    response['outcome'] = 'refused';
    response['reason_code'] = code;
    // A refused plan's prose is never published: it failed the language gate.
    response['interpretation'] = null;
    response['limitations'] = [planLimitation(code)];
    return finish();
  }
  response['interpretation'] = interpretation;

  const ambiguity = materialAmbiguity(plan, question, authorized);
  if (ambiguity !== null) {
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
          },
          adapterFail,
        );
        asked = String(answer['question']);
      } catch {
        asked = fallbackClarification(ambiguity.missing);
      }
    }
    response['outcome'] = 'clarification';
    response['reason_code'] = 'NLQ_CLARIFICATION_REQUIRED';
    response['summary'] = summaryOf('clarification', null);
    response['limitations'] = [clarificationLimitation(ambiguity.missing)];
    response['resolved'] = {
      interpretation,
      metrics: [],
      dimensions: [],
      filters: [],
      window: null,
      comparison_window: null,
      partial_period: false,
      defaults_applied: [],
    };
    response['clarification'] = {
      question: asked,
      missing: [...ambiguity.missing],
      candidates: [...ambiguity.candidates],
    };
    return finish();
  }

  let compiled: { request: Record<string, unknown>; defaults: AppliedDefault[] };
  try {
    compiled = compileQuery(plan, authorized, contract.default_limit);
  } catch (error) {
    const failure = failureOf(error);
    response['outcome'] = 'refused';
    response['reason_code'] = failure?.code ?? 'NLQ_QUERY_REFUSED';
    response['limitations'] = [failure?.code === 'NLQ_RELEASE_PIN_REFUSED'
      ? '自然语言查询始终读取当前数据产品发布，不接受模型指定发布版本，平台已拒绝执行。'
      : '模型给出的查询请求超出当前消费者可见的已发布契约，平台已拒绝执行。'];
    return finish();
  }
  response['query'] = compiled.request;
  response['defaults_applied'] = compiled.defaults;

  const engineFail = (code: string, message: string): never => {
    throw new NaturalLanguageFailure(code, message);
  };
  let result: Record<string, unknown>;
  try {
    result = executeDataProductQuery({
      session,
      reader,
      product,
      context: {
        action: 'data_product_query',
        scope: 'workspace',
        workspace_id: product.workspace_id,
        target: product.data_product_id,
      },
      request: compiled.request,
      fail: engineFail,
    });
  } catch (error) {
    const code = errorCodeOf(error);
    const unavailable = code === 'DATA_PRODUCT_NOT_PUBLISHED' || code === 'DATASET_RELEASE_NOT_FOUND';
    response['outcome'] = unavailable ? 'unavailable' : 'refused';
    response['reason_code'] = code;
    response['limitations'] = [engineLimitation(code)];
    return finish();
  }
  response['executed'] = true;
  response['result'] = result;

  const outcome = classify(result);
  response['outcome'] = outcome;
  response['reason_code'] = outcome === 'answered'
    ? null
    : outcome === 'empty'
      ? 'NLQ_EMPTY_RESULT'
      : 'NLQ_NO_EVIDENCE';

  const window = objectOrNull(result['window']);
  const comparisonWindow = objectOrNull(result['comparison_window']);
  const partial = window?.['partial'] === true;
  response['window'] = window;
  response['comparison_window'] = comparisonWindow;
  response['partial_period'] = partial;
  const provenance = objectOrNull(result['provenance']);
  response['provenance'] = provenance;
  response['freshness'] = freshnessOf(provenance, window);

  const limitations: string[] = [];
  if (outcome === 'empty') limitations.push('查询已执行，但所选业务范围内没有记录。');
  if (outcome === 'no_evidence') limitations.push('查询已执行，但所选范围内没有可引用的数值。');
  if (partial) limitations.push('查询窗口超出现有数据覆盖范围，结果为部分期间数据。');
  if (compiled.defaults.length > 0) {
    const names = compiled.defaults.map((entry) => entry.name).join(', ');
    limitations.push(`已应用受治理默认值：${names}。`);
  }

  response['resolved'] = {
    interpretation,
    metrics: arrayOf(result['metrics'])
      .filter(isRecord)
      .map((metric) => metric['name'])
      .filter((name): name is string => typeof name === 'string'),
    dimensions: stringsOf(result['grouped_by']),
    filters: arrayOf(compiled.request['filters']).map((filter) => (isRecord(filter) ? { ...filter } : filter)),
    window,
    comparison_window: comparisonWindow,
    partial_period: partial,
    defaults_applied: compiled.defaults.map((entry) => ({ ...entry })),
  };
  response['summary'] = summaryOf(outcome, result);

  if (outcome === 'answered' && result['kind'] === 'aggregate' && model.narration) {
    const facts = narrationFacts(result, question);
    if (facts.records.length > 0) {
      try {
        const narrativeAnswer = await generateGroundedNarration(model.pin, facts, adapterFail);
        const narrative = String(narrativeAnswer['narrative'] ?? '');
        const violation = narrativeViolation(narrative, facts);
        if (violation !== null) {
          limitations.push(violation === 'NARRATIVE_CAUSAL_CLAIM'
            ? '模型叙述包含证据不支持的因果表述，已丢弃叙述。'
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
  response['limitations'] = limitations;
  return finish();
}
