import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  findArtifactProposal,
  findDataset,
  findModelBinding,
  findModelProfile,
  findModelProfileVersion,
  latestDataProductVersion,
  latestDatasetRelease,
  type ArtifactProposalRecord,
  type DataProductArtifact,
  type DataProductContract,
  type DataProductProposalBase,
  type DataProductProposalCandidates,
  type DataProductProposalEvidence,
  type DataProductProposalPreviewRecord,
  type DataProductProposalProvenance,
  type DataProductProposalRecord,
  type DataProductProposalValidationRecord,
  type DataProductRequirement,
  type DataProductVersion,
  type DatasetArtifact,
  type DatasetReleaseRecord,
  type DatasetSchemaField,
  type ModelProfileVersion,
  type ProposalModelPin,
  type WorkspaceModelBindingRecord,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { memberReader } from './grants.js';
import {
  generateClarification,
  generateGroundedNarration,
  generateProductCandidate,
} from './model-generation.js';
import { pinnedForBinding } from './model-profile.js';
import {
  DEPLOYMENT_CONTEXT_ARTIFACT,
  findContextArtifact,
  latestVersion,
  workspaceContextArtifact,
  workspaceRoleOf,
  type ContextEntry,
} from './platform.js';
import { parseContract } from './product-contract.js';
import { executeDataProductQuery } from './product-query.js';
import { apiPath, publishContractVersion, schemaOf } from './products.js';
import { openPlatform, type PlatformSession } from './session.js';
import { requireAdministeredSource } from './sources.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;
const REQUIREMENT_MAXIMUM = 4000;
const REASON_MAXIMUM = 1000;
/** The question asked when a Model Profile Version declares no clarification prompt. */
const FALLBACK_CLARIFICATION = '请补充要统计的业务范围与时间范围。';
/** The one generic route the Data Product API serves; no endpoint is generated per Product. */
const PRODUCT_QUERY_ROUTE = '/api/workspaces/{workspace_id}/data-products/{data_product_id}/query';

function digest(value: unknown): string {
  return canonicalDigest(value);
}

/**
 * Resolves the Data Product Proposal kind from the one Proposal collection. An
 * integration Proposal is a different review unit, so this lifecycle never
 * governs it by mistake.
 */
function findProductProposal(
  proposals: ArtifactProposalRecord[],
  proposalId: string,
): DataProductProposalRecord | undefined {
  const proposal = findArtifactProposal(proposals, proposalId);
  return proposal !== undefined && proposal.kind === 'data_product' ? proposal : undefined;
}

/** The content address of every Data Product Proposal fact; a mismatch means tampering. */
function hashOf(proposal: {
  workspace_id: string;
  source_id: string;
  dataset_id: string;
  binding_id: string;
  requirement: DataProductRequirement;
  base: DataProductProposalBase;
  model: ProposalModelPin;
  evidence: DataProductProposalEvidence;
  candidates: DataProductProposalCandidates;
}): string {
  return digest({
    kind: 'data_product',
    workspace_id: proposal.workspace_id,
    source_id: proposal.source_id,
    dataset_id: proposal.dataset_id,
    binding_id: proposal.binding_id,
    requirement: proposal.requirement,
    base: proposal.base,
    model: proposal.model,
    evidence: proposal.evidence,
    candidates: proposal.candidates,
  });
}

/** One authorised Metric Definition the candidate may draw on. */
interface MetricDefinition {
  key: string;
  value: string;
  unit?: string;
  description?: string;
  aggregation?: ContextEntry['aggregation'];
  value_type?: ContextEntry['value_type'];
  favorable_direction?: ContextEntry['favorable_direction'];
}

/** One authorised semantic entry the generator may read, beyond the Dataset Schema. */
interface SemanticEntry {
  key: string;
  value: string;
  unit?: string;
  description?: string;
}

/**
 * The Business Context the acting Workspace Administrator may read: the latest
 * common version and the latest Workspace extension, together with their exact
 * content addresses. Nothing from another Workspace can appear here.
 */
interface AuthorizedContext {
  commonVersion: number;
  commonHash: string;
  workspaceVersion: number;
  workspaceHash: string;
  entries: ContextEntry[];
  metricDefinitions: MetricDefinition[];
  dimensions: SemanticEntry[];
  definitions: SemanticEntry[];
  contentHash: string;
}

function semanticOf(entry: ContextEntry): SemanticEntry {
  return {
    key: entry.key,
    value: entry.value,
    ...(entry.unit === undefined ? {} : { unit: entry.unit }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
  };
}

/** A Metric Definition also carries the formula and favourable direction it was approved with. */
function metricDefinitionOf(entry: ContextEntry): MetricDefinition {
  return {
    ...semanticOf(entry),
    ...(entry.aggregation === undefined ? {} : { aggregation: entry.aggregation }),
    ...(entry.value_type === undefined ? {} : { value_type: entry.value_type }),
    ...(entry.favorable_direction === undefined ? {} : { favorable_direction: entry.favorable_direction }),
  };
}

function contextOf(session: PlatformSession, workspaceId: string): AuthorizedContext {
  const common = latestVersion(findContextArtifact(session.state, DEPLOYMENT_CONTEXT_ARTIFACT));
  const workspace = latestVersion(findContextArtifact(session.state, workspaceContextArtifact(workspaceId)));
  const entries = [...(common?.entries ?? []), ...(workspace?.entries ?? [])];
  return {
    commonVersion: common?.version ?? 0,
    commonHash: common?.content_hash ?? '',
    workspaceVersion: workspace?.version ?? 0,
    workspaceHash: workspace?.content_hash ?? '',
    entries,
    metricDefinitions: entries.filter((entry) => entry.kind === 'metric').map(metricDefinitionOf),
    dimensions: entries.filter((entry) => entry.kind === 'dimension').map(semanticOf),
    definitions: entries.filter((entry) => entry.kind === 'definition').map(semanticOf),
    contentHash: digest({ common: common?.content_hash ?? '', workspace: workspace?.content_hash ?? '' }),
  };
}

/** The binding, its exact Model Profile Version, and that Version's activation. */
interface BoundModel {
  binding: WorkspaceModelBindingRecord;
  version: ModelProfileVersion;
  pin: ProposalModelPin;
}

function requireBinding(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  bindingId: string,
  workspaceId: string,
): BoundModel {
  const binding = findModelBinding(session.state.model_bindings, bindingId);
  if (!binding || binding.workspace_id !== workspaceId) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_BINDING_NOT_FOUND', 'The Workspace Model Binding is not available for this Source.');
  }
  if (binding.revoked_at !== null) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_BINDING_REVOKED', 'The Workspace Model Binding has been revoked.');
  }
  if (!binding.purposes.includes('data_product_proposal')) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_PURPOSE_NOT_BOUND', 'The Workspace Model Binding does not permit Data Product Proposal generation.');
  }
  const profile = findModelProfile(session.state.model_profiles, binding.model_profile_id);
  const version = findModelProfileVersion(profile, binding.model_profile_version);
  if (!profile || !version || version.content_hash !== binding.model_profile_content_hash) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_MODEL_STALE', 'The Bound Model Profile Version is no longer the one the Binding pinned.');
  }
  if (profile.activated_version !== version.version) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_MODEL_NOT_ACTIVATED', 'The Bound Model Profile Version is no longer activated.');
  }
  const prompt = version.prompts.find((candidate) => candidate.id === 'data_product_proposal');
  if (!prompt) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_PURPOSE_NOT_BOUND', 'The Model Profile Version pins no Data Product Proposal prompt.');
  }
  return {
    binding,
    version,
    pin: {
      model_profile_id: profile.model_profile_id,
      model_profile_version: version.version,
      model_profile_content_hash: version.content_hash,
      adapter: version.adapter,
      model_id: version.model_id,
      prompt_id: 'data_product_proposal',
      prompt_hash: prompt.hash,
    },
  };
}

/** The Dataset, its current Release, and the exact Schema that Release was integrated under. */
interface DatasetSurface {
  dataset: DatasetArtifact;
  release: DatasetReleaseRecord;
  schema: DatasetSchemaField[];
  identity: string[];
}

function requireDataset(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  sourceId: string,
): DatasetSurface {
  const dataset = findDataset(session.state.datasets, sourceId);
  const release = latestDatasetRelease(dataset);
  if (!dataset || !release) {
    reject(
      session,
      actorName,
      context,
      'DATASET_RELEASE_NOT_FOUND',
      'The Source has no Dataset Release a Data Product could be proposed over.',
      'Release the Dataset before generating a Data Product Proposal.',
    );
  }
  const schema = schemaOf(session, actorName, context, sourceId, release);
  const version = session.state.integration_configurations
    .find((artifact) => artifact.source_id === sourceId)
    ?.versions.find((candidate) => candidate.version === release.integration_configuration_version);
  return { dataset, release, schema, identity: version?.identity_fields ?? [] };
}

/** The exact inputs a Data Product Proposal was generated against. */
function baseOf(
  surface: DatasetSurface,
  context: AuthorizedContext,
  product: DataProductArtifact | undefined,
): DataProductProposalBase {
  const version = product === undefined ? undefined : latestDataProductVersion(product);
  return {
    dataset_id: surface.dataset.dataset_id,
    dataset_release: surface.release.release,
    dataset_records_hash: surface.release.records_hash,
    dataset_schema_hash: surface.release.schema_hash,
    common_business_context_version: context.commonVersion,
    common_business_context_content_hash: context.commonHash,
    workspace_business_context_version: context.workspaceVersion,
    workspace_business_context_content_hash: context.workspaceHash,
    data_product_id: product?.data_product_id ?? null,
    data_product_version: version?.version ?? null,
    data_product_contract_hash: version?.contract_hash ?? null,
  };
}

function sameBase(left: DataProductProposalBase, right: DataProductProposalBase): boolean {
  return left.dataset_release === right.dataset_release
    && left.dataset_records_hash === right.dataset_records_hash
    && left.dataset_schema_hash === right.dataset_schema_hash
    && left.common_business_context_version === right.common_business_context_version
    && left.common_business_context_content_hash === right.common_business_context_content_hash
    && left.workspace_business_context_version === right.workspace_business_context_version
    && left.workspace_business_context_content_hash === right.workspace_business_context_content_hash
    && left.data_product_version === right.data_product_version
    && left.data_product_contract_hash === right.data_product_contract_hash;
}

/**
 * Proves the Dataset Release, the Business Context, and the Data Product Version
 * the Proposal named are still current. Any of them moving makes the Proposal
 * stale: it can no longer be validated, approved, or published.
 */
function assertFresh(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  proposal: DataProductProposalRecord,
): void {
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  const dataset = findDataset(session.state.datasets, proposal.source_id);
  const release = latestDatasetRelease(dataset);
  if (!dataset || !release) {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_BASE_STALE', 'The Dataset Release this Proposal was generated against no longer exists.');
  }
  const surface: DatasetSurface = {
    dataset,
    release,
    schema: [],
    identity: [],
  };
  const product = proposal.base.data_product_id === null
    ? undefined
    : session.state.data_products.find((candidate) => candidate.data_product_id === proposal.base.data_product_id);
  const current = baseOf(surface, contextOf(session, proposal.workspace_id), product);
  if (!sameBase(current, proposal.base)) {
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_BASE_STALE',
      'The Dataset Release, Business Context, or Data Product Version moved after this Proposal was generated.',
      'Generate a new Proposal against the current inputs; a stale Proposal cannot be validated, approved, or published.',
    );
  }
}

/** Refuses a record whose content no longer matches its own content addresses. */
function assertIntact(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  proposal: DataProductProposalRecord,
): void {
  if (proposal.proposal_hash !== hashOf(proposal)) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_TAMPERED', 'The Proposal record does not match its content address.');
  }
  if (proposal.candidates.contract_hash !== digest(proposal.candidates.contract)) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_TAMPERED', 'The candidate Contract does not match its content address.');
  }
  if (proposal.candidates.content_hash !== digest({
    name: proposal.candidates.name,
    contract: proposal.candidates.contract,
  })) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_TAMPERED', 'The candidate does not match its content address.');
  }
}

function statusOf(proposal: DataProductProposalRecord): string {
  if (proposal.publications.length > 0) return 'published';
  const decision = proposal.decisions[proposal.decisions.length - 1];
  if (decision?.outcome === 'rejected') return 'rejected';
  if (decision?.outcome === 'approved') return 'approved';
  return 'pending';
}

/** One administrator-supplied requirement document. */
interface RequirementDocument {
  name: string | null;
  text: string;
  clarifications: Array<{ question: string; answer: string }>;
  datasetId: string | null;
}

function readRequirement(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  path: string,
): RequirementDocument {
  const fail: Fail = (code, message, nextStep) => reject(session, actorName, context, code, message, nextStep);
  return readRequirementDocument(
    session,
    actorName,
    context,
    readJsonDocument(
      path,
      fail,
      'PRODUCT_PROPOSAL_REQUIREMENT_UNREADABLE',
      'The Data Product requirement must be a readable JSON document.',
    ),
  );
}

/**
 * Reads one requirement document the CLI loaded or the browser already stated.
 * Both surfaces are validated here, so the browser never decides what a
 * requirement means or whether it is complete.
 */
function readRequirementDocument(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  parsed: unknown,
): RequirementDocument {
  const fail: Fail = (code, message, nextStep) => reject(session, actorName, context, code, message, nextStep);
  if (!isRecord(parsed)) {
    fail('PRODUCT_PROPOSAL_REQUIREMENT_INVALID', 'A Data Product requirement must be a JSON object.');
  }
  const text = typeof parsed['requirement'] === 'string' ? parsed['requirement'].trim() : '';
  if (text.length === 0 || text.length > REQUIREMENT_MAXIMUM) {
    fail(
      'PRODUCT_PROPOSAL_REQUIREMENT_INVALID',
      `A Data Product requirement must contain 1 to ${REQUIREMENT_MAXIMUM} characters of natural language.`,
    );
  }
  const rawName = parsed['name'];
  let name: string | null = null;
  if (rawName !== undefined) {
    if (typeof rawName !== 'string' || rawName.trim().length < NAME_MINIMUM || rawName.trim().length > NAME_MAXIMUM) {
      fail('PRODUCT_PROPOSAL_NAME_INVALID', `A Data Product name must contain ${NAME_MINIMUM} to ${NAME_MAXIMUM} characters.`);
    }
    name = rawName.trim();
  }
  const rawDataset = parsed['dataset_id'];
  if (rawDataset !== undefined && typeof rawDataset !== 'string') {
    fail('PRODUCT_PROPOSAL_REQUIREMENT_INVALID', 'A requirement may name at most one Dataset by its identifier.');
  }
  const rawClarifications = parsed['clarifications'] ?? [];
  if (!Array.isArray(rawClarifications)) {
    fail('PRODUCT_PROPOSAL_REQUIREMENT_INVALID', 'Requirement clarifications must be an array of question and answer pairs.');
  }
  const clarifications = rawClarifications.map((candidate: unknown) => {
    if (
      !isRecord(candidate)
      || typeof candidate['question'] !== 'string'
      || candidate['question'].trim().length === 0
      || typeof candidate['answer'] !== 'string'
      || candidate['answer'].trim().length === 0
    ) {
      fail('PRODUCT_PROPOSAL_REQUIREMENT_INVALID', 'Each clarification must state a non-empty question and answer.');
    }
    return { question: candidate['question'].trim(), answer: candidate['answer'].trim() };
  });
  return {
    name,
    text,
    clarifications,
    datasetId: typeof rawDataset === 'string' ? rawDataset : null,
  };
}

/** Every two-character Chinese term a label carries, so a requirement can share one. */
function chineseBigrams(text: string): Set<string> {
  const terms = new Set<string>();
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return terms;
}

function sharesTerm(left: Set<string>, text: string): boolean {
  for (const term of chineseBigrams(text)) {
    if (left.has(term)) return true;
  }
  return false;
}

/**
 * Whether a requirement already names something the acting Workspace
 * Administrator may govern. A requirement that names nothing would let a model
 * invent the scope, so the platform asks for one clarification instead.
 */
function mentionsGoverned(
  text: string,
  context: AuthorizedContext,
  surface: DatasetSurface,
): boolean {
  const haystack = text.toLowerCase();
  const identifiers = [
    ...surface.schema.map((field) => field.name),
    ...surface.identity,
    ...context.entries.map((entry) => entry.key),
  ];
  if (identifiers.some((identifier) => identifier.length >= 2 && haystack.includes(identifier.toLowerCase()))) {
    return true;
  }
  const labels = [
    ...context.entries.map((entry) => entry.value),
    ...context.entries.flatMap((entry) => (entry.unit === undefined ? [] : [entry.unit])),
  ];
  return labels.some((label) => sharesTerm(chineseBigrams(label), text));
}

/** Asks the Bound Model Profile Version for one Chinese clarification, or states a default one. */
async function clarificationQuestion(
  session: PlatformSession,
  bound: BoundModel,
  requirement: DataProductRequirement,
  fail: Fail,
): Promise<string> {
  if (!bound.version.purposes.includes('clarification')) return FALLBACK_CLARIFICATION;
  const profile = findModelProfile(session.state.model_profiles, bound.pin.model_profile_id)!;
  const answer = await generateClarification(
    pinnedForBinding(session, profile, bound.version, bound.binding),
    { question: requirement.text, clarifications: requirement.clarifications, missing: ['metric_scope', 'time_range'] },
    fail,
  );
  return String(answer['question']);
}

/**
 * Proves every metric the candidate publishes is a Metric Definition of the
 * pinned Business Context. A record count reads no field and asserts nothing
 * about meaning, so it needs no definition; every other metric does.
 */
function requireDefinedMetrics(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  contract: DataProductContract,
  metricDefinitions: MetricDefinition[],
): void {
  const defined = new Set(metricDefinitions.map((definition) => definition.key));
  for (const metric of contract.metrics) {
    if (metric.aggregation === 'count' && metric.field === undefined) continue;
    if (defined.has(metric.name)) continue;
    reject(
      session,
      actorName,
      context,
      'PRODUCT_PROPOSAL_METRIC_UNDEFINED',
      `The ${metric.name} metric is not a Metric Definition of this Workspace's Business Context, so the Proposal would invent unsupported semantics.`,
      'Publish the Metric Definition in the Workspace Business Context, or propose only metrics it defines.',
    );
  }
}

/**
 * Generates one Data Product Proposal from a natural-language requirement under
 * one Bound Model Profile Version. The generated Contract is validated by the
 * same parser publication uses, and nothing is published.
 */
export async function generateProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
  bindingId: string;
  /** A requirement document on disk, which the CLI reads. */
  requirementPath?: string;
  /** A requirement the browser states; validated identically. */
  requirement?: unknown;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_proposal_generation', scope: 'workspace', target: options.sourceId };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const actorName = actorLabel(actor.user);
  const fail: Fail = (code, message, nextStep) => reject(session, actorName, scoped, code, message, nextStep);

  const bound = requireBinding(session, actorName, scoped, options.bindingId, source.workspace_id);
  const profile = findModelProfile(session.state.model_profiles, bound.pin.model_profile_id)!;
  const pinned = pinnedForBinding(session, profile, bound.version, bound.binding);
  const document = options.requirement !== undefined
    ? readRequirementDocument(session, actorName, scoped, options.requirement)
    : readRequirement(session, actorName, scoped, options.requirementPath ?? '');
  const surface = requireDataset(session, actorName, scoped, source.source_id);
  if (document.datasetId !== null && document.datasetId !== surface.dataset.dataset_id) {
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_DATASET_UNAVAILABLE',
      'The requirement names a Dataset this Workspace Administrator cannot publish.',
      'Name the Dataset of this Source, or administer the Workspace that owns it.',
    );
  }
  const authorized = contextOf(session, source.workspace_id);

  const requirement: DataProductRequirement = {
    text: document.text,
    clarifications: document.clarifications,
    hash: digest({ text: document.text, clarifications: document.clarifications }),
  };
  if (document.clarifications.length === 0 && !mentionsGoverned(document.text, authorized, surface)) {
    const question = await clarificationQuestion(session, bound, requirement, fail);
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_CLARIFICATION_REQUIRED',
      question,
      '在需求中补齐中文澄清问答后重新生成；未经澄清的宽泛需求不能生成受治理的数据产品提案。',
    );
  }

  const input = {
    name: document.name,
    requirement: requirement.text,
    clarifications: requirement.clarifications,
    dataset: {
      dataset_id: surface.dataset.dataset_id,
      release: surface.release.release,
      identity_fields: surface.identity,
      fields: surface.schema.map((field) => ({ name: field.name, type: field.type })),
    },
    metric_definitions: authorized.metricDefinitions,
    dimensions: authorized.dimensions,
    definitions: authorized.definitions,
    business_context: {
      common_version: authorized.commonVersion,
      common_content_hash: authorized.commonHash,
      workspace_version: authorized.workspaceVersion,
      workspace_content_hash: authorized.workspaceHash,
    },
  };
  const candidateDocument = await generateProductCandidate(pinned, input, fail);
  const contract = parseContract(
    (code, message) => fail('PRODUCT_PROPOSAL_CANDIDATE_INVALID', `${code}: ${message}`),
    candidateDocument,
    surface.schema,
  );
  const name = (document.name ?? contract.title).trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    fail('PRODUCT_PROPOSAL_NAME_INVALID', `A Data Product name must contain ${NAME_MINIMUM} to ${NAME_MAXIMUM} characters.`);
  }
  requireDefinedMetrics(session, actorName, scoped, contract, authorized.metricDefinitions);

  const product = session.state.data_products.find(
    (candidate) => candidate.workspace_id === source.workspace_id && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  const base = baseOf(surface, authorized, product);
  const candidates: DataProductProposalCandidates = {
    name,
    contract,
    contract_hash: digest(contract),
    content_hash: digest({ name, contract }),
  };
  const evidence: DataProductProposalEvidence = {
    requirement_hash: requirement.hash,
    dataset_release_hash: surface.release.records_hash,
    schema_fields: surface.schema.map((field) => field.name),
    field_count: surface.schema.length,
    metric_definition_keys: authorized.metricDefinitions.map((definition) => definition.key),
    business_context_hash: authorized.contentHash,
  };
  const header = {
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    dataset_id: surface.dataset.dataset_id,
    binding_id: bound.binding.binding_id,
    requirement,
    base,
    model: bound.pin,
    evidence,
    candidates,
  };
  const proposal: DataProductProposalRecord = {
    kind: 'data_product',
    proposal_id: randomUUID(),
    workspace_id: source.workspace_id,
    source_id: source.source_id,
    dataset_id: surface.dataset.dataset_id,
    created_at: new Date().toISOString(),
    created_by: actorName,
    created_by_user_id: actor.user.user_id,
    binding_id: bound.binding.binding_id,
    requirement,
    base,
    model: bound.pin,
    evidence,
    candidates,
    proposal_hash: hashOf(header),
    validations: [],
    previews: [],
    decisions: [],
    publications: [],
  };
  session.state.artifact_proposals.push(proposal);

  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      proposal_hash: proposal.proposal_hash,
      model_profile_id: bound.pin.model_profile_id,
      model_profile_version: bound.pin.model_profile_version,
      prompt_hash: bound.pin.prompt_hash,
      requirement_hash: requirement.hash,
      contract_hash: candidates.contract_hash,
      dataset_release: base.dataset_release,
    },
  });
  session.save();
  return viewProductProposal(proposal);
}

/**
 * The exact inputs a Proposal named, and whether they are still current. A
 * Proposal whose Dataset Release, Business Context, or Data Product Version
 * moved can no longer be validated, approved, or published.
 */
function freshnessOfProduct(
  session: PlatformSession,
  proposal: DataProductProposalRecord,
): { fresh: boolean; current: DataProductProposalBase | null } {
  const dataset = findDataset(session.state.datasets, proposal.source_id);
  const release = latestDatasetRelease(dataset);
  if (!dataset || !release) return { fresh: false, current: null };
  const product = proposal.base.data_product_id === null
    ? undefined
    : session.state.data_products.find((candidate) => candidate.data_product_id === proposal.base.data_product_id);
  const current = baseOf(
    { dataset, release, schema: [], identity: [] },
    contextOf(session, proposal.workspace_id),
    product,
  );
  return { fresh: sameBase(current, proposal.base), current };
}

/**
 * Lists the Data Product Proposals of one administered Source together with
 * whether each still names the current inputs. The browser renders this answer;
 * it makes no freshness or authorization decision of its own.
 */
export function listProductProposals(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'data_product_proposal_listing', scope: 'workspace', target: options.sourceId };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const actorName = actorLabel(actor.user);
  const proposals = session.state.artifact_proposals
    .filter(
      (proposal): proposal is DataProductProposalRecord =>
        proposal.kind === 'data_product'
        && proposal.source_id === source.source_id
        && proposal.workspace_id === source.workspace_id,
    )
    .map((proposal) => {
      assertIntact(session, actorName, scoped, proposal);
      return {
        created_at: proposal.created_at,
        view: { ...viewProductProposal(proposal), freshness: freshnessOfProduct(session, proposal) },
      };
    })
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((entry) => entry.view);
  session.audit({ ...scoped, actor: actorName, outcome: 'succeeded', detail: { proposals: proposals.length } });
  return { source_id: source.source_id, proposals };
}

/**
 * Validates the candidate against the real Dataset Release and the pinned
 * Business Context. Every failure is hard: a Contract that references anything
 * unresolvable can never be approved.
 */
export function validateProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_proposal_validation', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_ALREADY_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  assertFresh(session, actorName, scoped, proposal);
  const source = requireAdministeredSource(session, actor, scoped, proposal.source_id);
  const surface = requireDataset(session, actorName, scoped, source.source_id);
  const authorized = contextOf(session, proposal.workspace_id);
  const contract = proposal.candidates.contract;

  const schemaFields = new Set(surface.schema.map((field) => field.name));
  const exposed = new Set(contract.fields.map((field) => field.name));
  const problems: string[] = [];
  for (const field of contract.fields) if (!schemaFields.has(field.name)) problems.push(`field:${field.name}`);
  for (const dimension of contract.dimensions) if (!exposed.has(dimension)) problems.push(`dimension:${dimension}`);
  for (const filter of contract.filters) if (!exposed.has(filter)) problems.push(`filter:${filter}`);
  for (const grain of contract.grain) if (!schemaFields.has(grain)) problems.push(`grain:${grain}`);
  for (const metric of contract.metrics) {
    if (metric.field !== undefined && !schemaFields.has(metric.field)) problems.push(`metric:${metric.name}`);
  }
  if (contract.time !== undefined && !schemaFields.has(contract.time.field)) problems.push(`time:${contract.time.field}`);
  if (problems.length > 0) {
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_CANDIDATE_INVALID',
      `The candidate Contract references names this Dataset Release does not resolve: ${problems.join(', ')}.`,
      'Generate a new Proposal from the current Dataset Schema.',
    );
  }
  requireDefinedMetrics(session, actorName, scoped, contract, authorized.metricDefinitions);
  requireServeableGrainOf(session, actorName, scoped, contract, surface.release);

  const checks = [
    'contract:valid',
    'fields:resolved',
    'dimensions:resolved',
    'metrics:defined',
    'grain:unique',
    'dataset_release:current',
  ];
  const record: DataProductProposalValidationRecord = {
    validated_at: new Date().toISOString(),
    validated_by: actorName,
    dataset_release: surface.release.release,
    contract_hash: proposal.candidates.contract_hash,
    metric_definition_keys: authorized.metricDefinitions.map((definition) => definition.key),
    checks,
    evidence_hash: digest({
      proposal_hash: proposal.proposal_hash,
      dataset_release: surface.release.release,
      contract_hash: proposal.candidates.contract_hash,
      metric_definition_keys: authorized.metricDefinitions.map((definition) => definition.key),
      checks,
    }),
  };
  proposal.validations.push(record);
  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      checks: checks.join(','),
      dataset_release: record.dataset_release,
      evidence_hash: record.evidence_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    validation: { ...record, checks: [...record.checks] },
  };
}

/** The one example aggregate query a preview runs when the Contract publishes metrics. */
function exampleQueries(contract: DataProductContract): Array<Record<string, unknown>> {
  const queries: Array<Record<string, unknown>> = [];
  if (contract.metrics.length > 0) {
    const dimension = contract.dimensions[0];
    queries.push({
      kind: 'aggregate',
      ...(dimension === undefined ? {} : { group_by: [dimension] }),
      metrics: contract.metrics.map((metric) => metric.name),
      include_totals: true,
      limit: Math.min(contract.default_limit, 10),
    });
  }
  queries.push({ kind: 'records', include_totals: true, limit: Math.min(contract.default_limit, 10) });
  return queries;
}

/** A representative result without the cursor, which moves with the page. */
function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    kind: result['kind'],
    returned: result['returned'],
  };
  // A capped sample still states how many rows the query matched, so a reviewer
  // can tell a complete answer from a representative one.
  if (result['matched_count'] !== undefined) summary['matched_count'] = result['matched_count'];
  if (result['columns'] !== undefined) summary['columns'] = result['columns'];
  if (result['groups_total'] !== undefined) summary['groups_total'] = result['groups_total'];
  if (Array.isArray(result['groups'])) summary['groups'] = result['groups'].slice(0, 3);
  if (Array.isArray(result['records'])) summary['records'] = result['records'].slice(0, 3);
  if (result['totals'] !== undefined) summary['totals'] = result['totals'];
  if (result['window'] !== undefined) summary['window'] = result['window'];
  return summary;
}

/** Builds the isolated Data Product a preview reads, bound to the real Release. */
function previewProduct(
  proposal: DataProductProposalRecord,
  dataset: DatasetArtifact,
  release: DatasetReleaseRecord,
  actorUserId: string,
  at: string,
): { product: DataProductArtifact; version: DataProductVersion } {
  const dataProductId = proposal.base.data_product_id ?? `preview-${proposal.proposal_id}`;
  const version: DataProductVersion = {
    version: 1,
    contract_version: { major: 1, minor: 0 },
    published_at: at,
    published_by: actorUserId,
    contract: proposal.candidates.contract,
    contract_hash: proposal.candidates.contract_hash,
    withdrawn_at: null,
  };
  return {
    version,
    product: {
      data_product_id: dataProductId,
      workspace_id: proposal.workspace_id,
      name: proposal.candidates.name,
      owner_user_id: dataset.owner_user_id,
      api_path: apiPath(proposal.workspace_id, dataProductId),
      created_at: at,
      versions: [version],
      releases: [{
        release: 1,
        data_product_version: 1,
        dataset_id: dataset.dataset_id,
        dataset_release: release.release,
        created_at: at,
        created_by: actorUserId,
      }],
      lines: [{
        major: 1,
        current_version: 1,
        current_release: 1,
        opened_at: at,
        withdrawn_at: null,
      }],
    },
  };
}

/**
 * Previews the candidate against the real Dataset Release through the one query
 * engine, into an isolated session that saves nothing. It exposes the API shape,
 * example queries, representative results, freshness, and Provenance, and it
 * never mutates a Data Product, a Release, or a cache page.
 */
export async function previewProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_proposal_preview', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_ALREADY_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  assertFresh(session, actorName, scoped, proposal);
  const source = requireAdministeredSource(session, actor, scoped, proposal.source_id);
  const surface = requireDataset(session, actorName, scoped, source.source_id);
  const contract = proposal.candidates.contract;
  const at = new Date().toISOString();
  const { product } = previewProduct(proposal, surface.dataset, surface.release, actor.user.user_id, at);

  // The isolated session keeps the preview out of the audit trail and the cache,
  // so a preview persists nothing at all.
  const isolated: PlatformSession = { ...session, audit() {} };
  const role = workspaceRoleOf(session.state, actor.user.user_id, proposal.workspace_id);
  const reader = memberReader(isolated, actor.user, role);
  const fail: Fail = (code, message, nextStep) => reject(session, actorName, scoped, code, message, nextStep);
  const queries = exampleQueries(contract);
  const results = queries.map((request) => executeDataProductQuery({
    session: isolated,
    reader,
    product,
    context: scoped,
    request,
    fail,
    persistCache: false,
  }));
  const representative = results.map(summarizeResult);
  const first = results[0] ?? {};
  const provenance = isRecord(first['provenance']) ? { ...first['provenance'] } : {};
  const freshness = {
    dataset_release: surface.release.release,
    dataset_record_count: surface.release.record_count,
    released_at: surface.release.created_at,
    acquired_at: surface.release.provenance.acquired_at,
    integrated_at: surface.release.provenance.integrated_at,
    time: contract.time === undefined ? null : { ...contract.time },
    window: first['window'] ?? null,
  };
  const apiShape = {
    method: 'POST',
    route: PRODUCT_QUERY_ROUTE,
    api_path: proposal.base.data_product_id === null
      ? null
      : apiPath(proposal.workspace_id, proposal.base.data_product_id),
    contract_version: { major: 1, minor: 0 },
    request: {
      kinds: ['records', 'aggregate'],
      filters: [...contract.filters],
      dimensions: [...contract.dimensions],
      metrics: contract.metrics.map((metric) => ({
        name: metric.name,
        aggregation: metric.aggregation,
        value_type: metric.value_type,
        unit: metric.unit ?? null,
      })),
      grain: [...contract.grain],
      time: contract.time === undefined ? null : { ...contract.time },
      limit: { default: contract.default_limit, max: contract.max_limit },
    },
  };
  const recordResult = results.find((result) => result['kind'] === 'records');
  const recordRows = Array.isArray(recordResult?.['records']) ? recordResult['records'] as Array<Record<string, unknown>> : [];
  const narrative = await narrativeOf(session, boundFor(session, proposal, actorName), proposal, recordRows, fail);

  const record: DataProductProposalPreviewRecord = {
    previewed_at: at,
    previewed_by: actorName,
    dataset_release: surface.release.release,
    contract_hash: proposal.candidates.contract_hash,
    api_shape: apiShape,
    example_queries: queries,
    representative_results: representative,
    freshness,
    provenance,
    narrative,
    evidence_hash: digest({
      contract_hash: proposal.candidates.contract_hash,
      api_shape: apiShape,
      example_queries: queries,
      representative_results: representative,
      freshness,
      provenance,
      narrative,
    }),
  };
  proposal.previews.push(record);
  session.audit({
    ...scoped,
    target: proposal.proposal_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      dataset_release: record.dataset_release,
      contract_hash: record.contract_hash,
      evidence_hash: record.evidence_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    preview: {
      previewed_at: record.previewed_at,
      dataset_release: record.dataset_release,
      api_shape: record.api_shape,
      example_queries: record.example_queries,
      representative_results: record.representative_results,
      freshness: record.freshness,
      provenance: record.provenance,
      narrative: record.narrative,
      evidence_hash: record.evidence_hash,
    },
  };
}

/** Re-resolves the Bound Model the Proposal was generated under. */
function boundFor(
  session: PlatformSession,
  proposal: DataProductProposalRecord,
  actorName: string,
): BoundModel {
  return requireBinding(session, actorName, { action: 'data_product_proposal_preview', scope: 'workspace' }, proposal.binding_id, proposal.workspace_id);
}

/**
 * Runs the grounded-narration purpose over the representative records, so the
 * narrative a reviewer reads is Simplified Chinese and every number in it comes
 * from a governed row. A Profile that declares no narration yields none.
 */
async function narrativeOf(
  session: PlatformSession,
  bound: BoundModel,
  proposal: DataProductProposalRecord,
  records: Array<Record<string, unknown>>,
  fail: Fail,
): Promise<Record<string, unknown>> {
  if (!bound.version.purposes.includes('grounded_narration')) return {};
  const profile = findModelProfile(session.state.model_profiles, bound.pin.model_profile_id)!;
  const output = await generateGroundedNarration(
    pinnedForBinding(session, profile, bound.version, bound.binding),
    { question: proposal.requirement.text, records },
    fail,
  );
  return {
    text: String(output['narrative'] ?? ''),
    evidence_refs: output['evidence_refs'],
  };
}

/** Records one Workspace Administrator rejection of one exact Proposal. */
export function rejectProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
  reason: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_proposal_rejection', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  const reason = options.reason.trim();
  if (reason.length === 0 || reason.length > REASON_MAXIMUM) {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_REASON_INVALID', `A rejection reason must contain 1 to ${REASON_MAXIMUM} characters.`);
  }
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_ALREADY_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  proposal.decisions.push({
    decided_at: new Date().toISOString(),
    decided_by: actor.user.user_id,
    actor: actorName,
    outcome: 'rejected',
    reason,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: { decision: 'rejected', proposal_hash: proposal.proposal_hash },
  });
  session.save();
  return { proposal_id: proposal.proposal_id, status: statusOf(proposal), reason };
}

/** Records the mandatory human Approval of one exact Data Product Proposal. */
export function approveProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_proposal_approval', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (statusOf(proposal) !== 'pending') {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_ALREADY_DECIDED', 'This Proposal already carries an Approval decision.');
  }
  if (proposal.validations.length === 0) {
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_VALIDATION_REQUIRED',
      'A Data Product Proposal cannot be approved without validation evidence.',
      'Validate the Proposal against the real Dataset Release first.',
    );
  }
  if (proposal.previews.length === 0) {
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_PREVIEW_REQUIRED',
      'A Data Product Proposal cannot be approved without a preview of the real Dataset Release.',
      'Preview the Proposal against the real Dataset Release first.',
    );
  }
  assertFresh(session, actorName, scoped, proposal);
  const bound = requireBinding(session, actorName, scoped, proposal.binding_id, proposal.workspace_id);
  if (
    bound.pin.model_profile_version !== proposal.model.model_profile_version
    || bound.pin.model_profile_content_hash !== proposal.model.model_profile_content_hash
  ) {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_MODEL_STALE', 'The Bound Model Profile Version moved after this Proposal was generated.');
  }
  proposal.decisions.push({
    decided_at: new Date().toISOString(),
    decided_by: actor.user.user_id,
    actor: actorName,
    outcome: 'approved',
    reason: null,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  const decision = proposal.decisions[proposal.decisions.length - 1]!;
  session.audit({
    ...scoped,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      decision: 'approved',
      proposal_hash: proposal.proposal_hash,
      validation_hash: decision.provenance.validation_hash,
      preview_hash: decision.provenance.preview_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    decided_at: decision.decided_at,
    provenance: decision.provenance,
  };
}

/**
 * Publishes the approved candidate as the next Data Product Version and Release.
 * Publication is the one act that exposes the existing Data Product API, and it
 * lands together with the Proposal fact or not at all.
 */
export function publishProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'data_product_proposal_publication', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const actorName = actorLabel(actor.user);
  const proposal = requireWritableProposal(session, actor, context, options.proposalId);
  const scoped: ActionContext = { ...context, workspace_id: proposal.workspace_id };
  if (proposal.publications.length > 0) {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_ALREADY_PUBLISHED', 'This Proposal has already been published.');
  }
  if (statusOf(proposal) !== 'approved') {
    reject(
      session,
      actorName,
      scoped,
      'PRODUCT_PROPOSAL_NOT_APPROVED',
      'Only an approved Data Product Proposal can be published.',
      'A Workspace Administrator must approve the Proposal first.',
    );
  }
  assertFresh(session, actorName, scoped, proposal);
  const source = requireAdministeredSource(session, actor, scoped, proposal.source_id);
  const surface = requireDataset(session, actorName, scoped, source.source_id);
  const publication = publishContractVersion({
    session,
    actor,
    context: scoped,
    source,
    dataset: surface.dataset,
    datasetRelease: surface.release,
    name: proposal.candidates.name,
    contract: proposal.candidates.contract,
  });
  if (publication.version.contract_hash !== proposal.candidates.contract_hash) {
    reject(session, actorName, scoped, 'PRODUCT_PROPOSAL_TAMPERED', 'The published Version does not match the approved candidate.');
  }
  proposal.publications.push({
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    actor: actorName,
    data_product_id: publication.product.data_product_id,
    data_product_version: publication.version.version,
    data_product_release: publication.release.release,
    dataset_release: publication.release.dataset_release,
    contract_hash: publication.version.contract_hash,
    model: proposal.model,
    evidence_hash: proposal.proposal_hash,
    provenance: provenanceOf(proposal),
  });
  session.audit({
    ...scoped,
    target: publication.product.data_product_id,
    actor: actorName,
    outcome: 'succeeded',
    detail: {
      data_product_version: publication.version.version,
      data_product_release: publication.release.release,
      contract_hash: publication.version.contract_hash,
      proposal_hash: proposal.proposal_hash,
    },
  });
  session.save();
  return {
    proposal_id: proposal.proposal_id,
    status: statusOf(proposal),
    data_product_id: publication.product.data_product_id,
    api_path: publication.product.api_path,
    data_product_version: publication.version.version,
    data_product_release: publication.release.release,
    dataset_release: publication.release.dataset_release,
    contract_version: { ...publication.version.contract_version },
    contract_hash: publication.version.contract_hash,
  };
}

/** Reads one Data Product Proposal and its evidence without disclosing any provider setting. */
export function showProductProposal(options: {
  root: string;
  masterKey: string;
  token: string;
  proposalId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'data_product_proposal_read', scope: 'workspace', target: options.proposalId };
  const actor = resolveActor(session, options.token, context);
  const proposal = findProductProposal(session.state.artifact_proposals, options.proposalId);
  if (!proposal) {
    reject(session, actorLabel(actor.user), context, 'PRODUCT_PROPOSAL_NOT_FOUND', 'The requested Data Product Proposal does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, proposal.workspace_id);
  assertIntact(session, actorLabel(actor.user), { ...context, workspace_id: proposal.workspace_id }, proposal);
  session.audit({ ...context, workspace_id: proposal.workspace_id, actor: actorLabel(actor.user), outcome: 'succeeded' });
  return viewProductProposal(proposal);
}

/** Resolves a pending Proposal the actor may change, refusing a tampered record. */
function requireWritableProposal(
  session: PlatformSession,
  actor: ReturnType<typeof resolveActor>,
  context: ActionContext,
  proposalId: string,
): DataProductProposalRecord {
  const actorName = actorLabel(actor.user);
  const proposal = findProductProposal(session.state.artifact_proposals, proposalId);
  if (!proposal) {
    reject(session, actorName, context, 'PRODUCT_PROPOSAL_NOT_FOUND', 'The requested Data Product Proposal does not exist.');
  }
  requireWorkspaceAdministrator(session, actor, context, proposal.workspace_id);
  assertIntact(session, actorName, { ...context, workspace_id: proposal.workspace_id }, proposal);
  return proposal;
}

/** Proves the Contract's grain identifies each record of the real Release. */
function requireServeableGrainOf(
  session: PlatformSession,
  actorName: string,
  context: ActionContext,
  contract: DataProductContract,
  release: DatasetReleaseRecord,
): void {
  if (contract.grain.length === 0) return;
  const seen = new Set<string>();
  for (const record of release.records) {
    const key = JSON.stringify(contract.grain.map((field) => record.values[field] ?? null));
    if (seen.has(key)) {
      reject(
        session,
        actorName,
        context,
        'PRODUCT_PROPOSAL_GRAIN_NOT_UNIQUE',
        `The ${contract.grain.join(', ')} grain does not identify each record of this Dataset Release, so its metrics would double count.`,
        'Propose a grain the Dataset holds one record at.',
      );
    }
    seen.add(key);
  }
}

/** The lineage every decision and publication restates. */
function provenanceOf(proposal: DataProductProposalRecord): DataProductProposalProvenance {
  const validation = proposal.validations[proposal.validations.length - 1];
  const preview = proposal.previews[proposal.previews.length - 1];
  return {
    model_profile_id: proposal.model.model_profile_id,
    model_profile_version: proposal.model.model_profile_version,
    model_profile_content_hash: proposal.model.model_profile_content_hash,
    adapter: proposal.model.adapter,
    model_id: proposal.model.model_id,
    binding_id: proposal.binding_id,
    prompt_id: proposal.model.prompt_id,
    prompt_hash: proposal.model.prompt_hash,
    requirement_hash: proposal.requirement.hash,
    validation_hash: validation?.evidence_hash ?? '',
    preview_hash: preview?.evidence_hash ?? '',
    candidate_content_hash: proposal.candidates.content_hash,
    proposal_hash: proposal.proposal_hash,
  };
}

function viewProductProposal(proposal: DataProductProposalRecord): Record<string, unknown> {
  return {
    proposal_id: proposal.proposal_id,
    kind: proposal.kind,
    status: statusOf(proposal),
    workspace_id: proposal.workspace_id,
    source_id: proposal.source_id,
    dataset_id: proposal.dataset_id,
    binding_id: proposal.binding_id,
    created_at: proposal.created_at,
    created_by: proposal.created_by,
    requirement: {
      text: proposal.requirement.text,
      clarifications: proposal.requirement.clarifications.map((clarification) => ({ ...clarification })),
      hash: proposal.requirement.hash,
    },
    base: { ...proposal.base },
    model: { ...proposal.model },
    evidence: { ...proposal.evidence, schema_fields: [...proposal.evidence.schema_fields], metric_definition_keys: [...proposal.evidence.metric_definition_keys] },
    candidates: {
      name: proposal.candidates.name,
      contract: proposal.candidates.contract,
      contract_hash: proposal.candidates.contract_hash,
      content_hash: proposal.candidates.content_hash,
    },
    proposal_hash: proposal.proposal_hash,
    validations: proposal.validations.map((validation) => ({
      ...validation,
      checks: [...validation.checks],
      metric_definition_keys: [...validation.metric_definition_keys],
    })),
    previews: proposal.previews.map((preview) => ({
      previewed_at: preview.previewed_at,
      previewed_by: preview.previewed_by,
      dataset_release: preview.dataset_release,
      contract_hash: preview.contract_hash,
      api_shape: preview.api_shape,
      example_queries: preview.example_queries,
      representative_results: preview.representative_results,
      freshness: preview.freshness,
      provenance: preview.provenance,
      narrative: preview.narrative,
      evidence_hash: preview.evidence_hash,
    })),
    decisions: proposal.decisions.map((decision) => ({
      decided_at: decision.decided_at,
      decided_by: decision.decided_by,
      outcome: decision.outcome,
      reason: decision.reason,
      evidence_hash: decision.evidence_hash,
      provenance: { ...decision.provenance },
    })),
    publications: proposal.publications.map((publication) => ({
      published_at: publication.published_at,
      published_by: publication.published_by,
      data_product_id: publication.data_product_id,
      api_path: apiPath(proposal.workspace_id, publication.data_product_id),
      data_product_version: publication.data_product_version,
      data_product_release: publication.data_product_release,
      dataset_release: publication.dataset_release,
      contract_hash: publication.contract_hash,
      evidence_hash: publication.evidence_hash,
      provenance: { ...publication.provenance },
    })),
  };
}
