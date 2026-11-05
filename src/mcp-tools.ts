import { acquireOperation, releaseOperation } from './admission.js';
import type { AccessTokenGrant } from './agents.js';
import type { ActionContext } from './authz.js';
import {
  findDataProduct,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductArtifact,
} from './catalog.js';
import { OperatorError, type Fail } from './errors.js';
import { agentReader, delegatedReader, type GrantReader } from './grants.js';
import { askNaturalLanguageQueryForAgent } from './natural-language-query.js';
import { workspaceRoleOf } from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { contractView, describeDataProduct, productIdentity } from './products.js';
import {
  listReportsForReader,
  readReportForReader,
  ReportAccessFailure,
} from './reports.js';
import type { PlatformSession } from './session.js';

/** The version of every tool's input and output contract this Deployment serves. */
export const TOOL_CONTRACT_VERSION = '1.0.0';

/**
 * The generic read-only tools this Deployment publishes. They are driven by the
 * Contract, so no Data Product ever gets a bespoke tool, and every tool names the
 * scope an Agent Identity must hold before it may even see the tool.
 */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  scopes: string[];
  contractVersion: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'discover_data_products',
    title: 'Discover Data Products',
    description: 'Lists the published Data Products in one Workspace that this Agent Identity may read, with the fields, metrics, and filters its Grants permit.',
    scopes: ['mcp:read'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', description: 'The Workspace whose Data Products to discover.' } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_data_product_contract',
    title: 'Read Data Product Contract',
    description: 'Reads the Contract of one published Data Product in one Workspace: its fields, dimensions, metrics, grain, time, filters, and limits, narrowed to what this Agent Identity may read.',
    scopes: ['mcp:read'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'The Workspace the Data Product belongs to.' },
        data_product_id: { type: 'string', description: 'The Data Product whose Contract to read.' },
      },
      required: ['workspace_id', 'data_product_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_data_product',
    title: 'Query Data Product',
    description: 'Answers one Data Product Query against the pinned Release, with the same records, cursors, Provenance, and errors the Data Product API answers.',
    scopes: ['mcp:read'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'The Workspace the Data Product belongs to.' },
        data_product_id: { type: 'string', description: 'The Data Product to query.' },
        query: { type: 'object', description: 'The Data Product Query document, exactly as the Data Product API accepts it.' },
      },
      required: ['workspace_id', 'data_product_id', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'discover_reports',
    title: 'Discover Published Reports',
    description: 'Lists the published Reports in one Workspace that this Agent Identity may read, without generating a Report or calling a model.',
    scopes: ['mcp:read'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: { workspace_id: { type: 'string', description: 'The Workspace whose Reports to discover.' } },
      required: ['workspace_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_report',
    title: 'Read Published Report',
    description: 'Reads one immutable published Report in one Workspace exactly as stored, without generating a Report or calling a model.',
    scopes: ['mcp:read'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'The Workspace the Report belongs to.' },
        report_id: { type: 'string', description: 'The Report to read.' },
      },
      required: ['workspace_id', 'report_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_natural_language_query',
    title: 'Ask Natural-Language Query',
    description: 'Answers one Chinese Natural-Language Query in one Workspace, with structured clarification, governed numbers, Provenance, freshness, and a follow-up conversation handle, exactly as the Natural-Language Query surface answers.',
    scopes: ['mcp:nlq'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'The Workspace the question runs in.' },
        data_product_id: { type: 'string', description: 'The one Data Product to ask about; omitted asks across the Workspace.' },
        question: { type: 'string', description: 'The business question, written in Chinese.' },
        clarification: { type: 'string', description: 'The answer to a previous structured clarification.' },
        binding_id: { type: 'string', description: 'The Workspace Model Binding to plan and narrate with; omitted uses the first permitted one.' },
      },
      required: ['workspace_id', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'continue_natural_language_query',
    title: 'Continue Natural-Language Query',
    description: 'Continues a Chinese Natural-Language Query conversation with the security-bound handle the previous turn returned. The handle is never authority: the turn is normalized and reauthorized from current state.',
    scopes: ['mcp:nlq'],
    contractVersion: TOOL_CONTRACT_VERSION,
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'The Workspace the conversation belongs to.' },
        conversation: { type: 'string', description: 'The opaque handle the previous turn returned.' },
        question: { type: 'string', description: 'The follow-up question, written in Chinese.' },
        clarification: { type: 'string', description: 'The answer to a previous structured clarification.' },
        binding_id: { type: 'string', description: 'The Workspace Model Binding to plan and narrate with; omitted uses the first permitted one.' },
      },
      required: ['workspace_id', 'conversation', 'question'],
      additionalProperties: false,
    },
  },
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** The tools one Agent Identity may see: a scope it does not hold hides the tool entirely. */
export function listTools(scopes: Set<string>): Record<string, unknown>[] {
  return MCP_TOOLS
    .filter((tool) => tool.scopes.every((scope) => scopes.has(scope)))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      contractVersion: tool.contractVersion,
      inputSchema: tool.inputSchema,
    }));
}

/** The tools that run a whole Natural-Language Query turn and admit it themselves. */
const NLQ_TOOL_NAMES = new Set(['ask_natural_language_query', 'continue_natural_language_query']);

/** The operation name a direct MCP tool stands for in the admission ledger. */
function toolOperationName(tool: McpTool): string {
  return tool.name === 'read_report' ? 'report_read' : 'mcp_query';
}

/** One structured tool failure: either an argument the tool could not act on, or a refused read. */
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: { nextStep?: string | undefined; field?: string | undefined } = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Codes that answer "you may not see this" rather than "this request was malformed". */
const DENIED_CODES = new Set([
  'WORKSPACE_ACCESS_DENIED',
  'DATA_PRODUCT_NOT_AVAILABLE',
  'REPORT_NOT_AVAILABLE',
  'REPORT_WITHDRAWN',
]);

/** Everything about who a tool call reads for, resolved on every invocation. */
interface ToolPrincipal {
  reader: GrantReader;
  role: string;
  subject: string;
  attributedUserId: string | null;
  generatedBy: string;
}

/**
 * Invokes one tool for one authenticated Agent Identity. Every outcome is a tool
 * result the caller can read, and every invocation appends one Audit Event naming
 * the Agent, the delegated User where present, the OAuth client, the target, and
 * the outcome.
 */
export async function callTool(
  session: PlatformSession,
  grant: AccessTokenGrant,
  tool: McpTool,
  rawArguments: unknown,
  /** The instant admission runs at, so the serving surface can inject its clock. */
  options: { at?: string } = {},
): Promise<Record<string, unknown>> {
  const actor = `agent:${grant.agent.name}`;
  const context: ActionContext = { action: 'mcp_tool_call', scope: 'workspace' };
  const target = declaredTarget(tool, rawArguments);
  if (target !== undefined) context.target = target;
  const detail = {
    tool: tool.name,
    tool_contract_version: tool.contractVersion,
    agent_identity_id: grant.agent.agent_identity_id,
    oauth_client_id: grant.client.client_id,
    ...(grant.delegation === null
      ? {}
      : {
        delegated_user_id: grant.delegation.user.user_id,
        delegated_username: grant.delegation.user.username,
      }),
  };
  try {
    const args = readArguments(tool, rawArguments);
    const principal = principalFor(session, grant);
    // A direct tool holds one Consumer slot for exactly the governed read it
    // performs. Natural-Language Query admits its whole turn at the engine, so
    // one MCP request is never counted twice.
    const workspaceId = typeof args['workspace_id'] === 'string' && args['workspace_id'].trim() !== ''
      ? args['workspace_id']
      : null;
    let leaseId: string | null = null;
    if (workspaceId !== null && !NLQ_TOOL_NAMES.has(tool.name)) {
      try {
        leaseId = acquireOperation({
          root: session.root,
          operation: toolOperationName(tool),
          class: 'direct',
          workspace_id: workspaceId,
          agent_identity_id: grant.agent.agent_identity_id,
          user_id: grant.delegation?.user.user_id ?? null,
          ...(options.at === undefined ? {} : { at: options.at }),
        });
      } catch (error) {
        if (error instanceof OperatorError) {
          throw new ToolError(error.code, error.message, { nextStep: error.nextStep });
        }
        throw error;
      }
    }
    try {
      const payload = await invoke(session, grant, principal, tool, args, context, options);
      session.audit({ ...context, actor, outcome: 'succeeded', detail });
      return toolResult(session, payload);
    } finally {
      releaseOperation({
        root: session.root,
        leaseId,
        ...(options.at === undefined ? {} : { at: options.at }),
      });
    }
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    session.audit({
      ...context,
      actor,
      outcome: DENIED_CODES.has(error.code) ? 'denied' : 'failed',
      detail: { ...detail, error_code: error.code },
    });
    return toolFailure(session, error);
  }
}

/** Resolves the exact reading authority a token acts under on this invocation. */
function principalFor(session: PlatformSession, grant: AccessTokenGrant): ToolPrincipal {
  const label = `agent:${grant.agent.name}`;
  if (grant.delegation === null) {
    return {
      reader: agentReader(session, grant.agent.agent_identity_id, label),
      role: 'Agent Identity',
      subject: grant.agent.agent_identity_id,
      attributedUserId: null,
      generatedBy: label,
    };
  }
  const user = grant.delegation.user;
  const role = workspaceRoleOf(session.state, user.user_id, grant.delegation.delegation.workspace_id);
  if (role === null) {
    // Membership is rechecked on every call, so a change fails closed now.
    throw new ToolError('WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this Agent Identity.');
  }
  return {
    reader: delegatedReader(session, grant.agent.agent_identity_id, user, role, label),
    role,
    subject: `${grant.agent.agent_identity_id}|${user.user_id}`,
    attributedUserId: user.user_id,
    generatedBy: user.user_id,
  };
}

/** The identifier an invocation names before any lookup, so a refused call is still audited. */
function declaredTarget(tool: McpTool, rawArguments: unknown): string | undefined {
  if (rawArguments === null || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return undefined;
  const args = rawArguments as Record<string, unknown>;
  const name = tool.name === 'discover_data_products' || tool.name === 'discover_reports'
    ? 'workspace_id'
    : tool.name === 'read_report'
      ? 'report_id'
      : tool.name === 'ask_natural_language_query' || tool.name === 'continue_natural_language_query'
        ? (typeof args['data_product_id'] === 'string' ? 'data_product_id' : 'workspace_id')
        : 'data_product_id';
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function invoke(
  session: PlatformSession,
  grant: AccessTokenGrant,
  principal: ToolPrincipal,
  tool: McpTool,
  args: Record<string, unknown>,
  context: ActionContext,
  options: { at?: string },
): Promise<Record<string, unknown>> {
  if (tool.name === 'discover_data_products') return discover(session, grant, principal.reader, args, context);
  if (tool.name === 'read_data_product_contract') return readContract(session, grant, principal.reader, args, context);
  if (tool.name === 'query_data_product') return query(session, grant, principal.reader, args, context);
  if (tool.name === 'discover_reports') return discoverReports(session, grant, principal, args, context);
  if (tool.name === 'read_report') return readReport(session, grant, principal, args, context);
  return ask(session, grant, principal, tool, args, context, options);
}

/** Discovery is the Workspace listing, narrowed exactly the way a read is. */
function discover(
  session: PlatformSession,
  grant: AccessTokenGrant,
  reader: GrantReader,
  args: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  const workspaceId = requireText(args, 'workspace_id');
  context.workspace_id = workspaceId;
  context.target = workspaceId;
  requireWorkspace(grant, workspaceId);
  const dataProducts = session.state.data_products
    .filter((product) => product.workspace_id === workspaceId && product.releases.length > 0)
    .flatMap((product) => {
      const view = describeDataProduct(product, reader);
      return view === null ? [] : [view];
    });
  return { workspace_id: workspaceId, data_products: dataProducts };
}

/** The Contract of one Data Product, narrowed to the columns this Agent Identity's Grants permit. */
function readContract(
  session: PlatformSession,
  grant: AccessTokenGrant,
  reader: GrantReader,
  args: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  const product = requireAgentProduct(
    session,
    grant,
    requireText(args, 'workspace_id'),
    requireText(args, 'data_product_id'),
    context,
  );
  const version = latestDataProductVersion(product);
  const release = latestDataProductRelease(product);
  if (!version || !release) {
    throw new ToolError('DATA_PRODUCT_NOT_PUBLISHED', 'The Data Product has no Publication to read.', {
      nextStep: 'Publish the Data Product before reading its Contract.',
    });
  }
  const scope = reader.scopeOf(product, version.contract);
  if (scope === null) throw new ToolError('DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this Agent Identity.');
  return {
    ...productIdentity(product, version, release),
    ...contractView(version.contract, scope),
  };
}

/** The direct-query tool: the very same engine the Data Product API answers with. */
function query(
  session: PlatformSession,
  grant: AccessTokenGrant,
  reader: GrantReader,
  args: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  const product = requireAgentProduct(
    session,
    grant,
    requireText(args, 'workspace_id'),
    requireText(args, 'data_product_id'),
    context,
  );
  const request = args['query'];
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new ToolError('MCP_ARGUMENT_INVALID', 'The query argument must be a Data Product Query document.', { field: 'query' });
  }
  const fail: Fail = (code, message, nextStep) => {
    throw new ToolError(code, message, { nextStep });
  };
  // The governed read records itself under its own action, beside the surface
  // event that names the tool and the OAuth client that invoked it.
  return executeDataProductQuery({
    session,
    reader,
    product,
    context: { ...context, action: 'data_product_query' },
    request,
    fail,
  });
}

/** Published-Report discovery: stored facts only, never a generation. */
function discoverReports(
  session: PlatformSession,
  grant: AccessTokenGrant,
  principal: ToolPrincipal,
  args: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  const workspaceId = requireText(args, 'workspace_id');
  context.workspace_id = workspaceId;
  context.target = workspaceId;
  requireWorkspace(grant, workspaceId);
  return listReportsForReader({
    session,
    reader: principal.reader,
    role: principal.role,
    workspaceId,
  });
}

/** Published-Report retrieval: the exact stored Report, never a regenerated one. */
function readReport(
  session: PlatformSession,
  grant: AccessTokenGrant,
  principal: ToolPrincipal,
  args: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  const workspaceId = requireText(args, 'workspace_id');
  const reportId = requireText(args, 'report_id');
  context.workspace_id = workspaceId;
  context.target = reportId;
  requireWorkspace(grant, workspaceId);
  try {
    return readReportForReader({
      session,
      reader: principal.reader,
      role: principal.role,
      reportId,
      workspaceId,
    });
  } catch (error) {
    if (error instanceof ReportAccessFailure) throw new ToolError(error.code, error.message);
    throw error;
  }
}

/**
 * Natural-Language Query over MCP: the same turn engine the CLI answers with,
 * under this Agent Identity's own or delegated authority. Clarification is a
 * structured response and a follow-up presents a security-bound handle that is
 * never authority in itself.
 */
async function ask(
  session: PlatformSession,
  grant: AccessTokenGrant,
  principal: ToolPrincipal,
  tool: McpTool,
  args: Record<string, unknown>,
  context: ActionContext,
  options: { at?: string },
): Promise<Record<string, unknown>> {
  const workspaceId = requireText(args, 'workspace_id');
  context.workspace_id = workspaceId;
  requireWorkspace(grant, workspaceId);
  const dataProductId = optionalText(args, 'data_product_id');
  context.target = dataProductId ?? workspaceId;
  const conversation = tool.name === 'continue_natural_language_query'
    ? requireText(args, 'conversation')
    : optionalText(args, 'conversation');
  const clarification = optionalText(args, 'clarification');
  const bindingId = optionalText(args, 'binding_id');
  try {
    return await askNaturalLanguageQueryForAgent({
      session,
      reader: principal.reader,
      role: principal.role,
      subject: principal.subject,
      attributedUserId: principal.attributedUserId,
      generatedBy: principal.generatedBy,
      workspaceId,
      agentIdentityId: grant.agent.agent_identity_id,
      ...(dataProductId === undefined ? {} : { dataProductId }),
      question: requireText(args, 'question'),
      ...(clarification === undefined ? {} : { clarification }),
      ...(conversation === undefined ? {} : { conversation }),
      ...(bindingId === undefined ? {} : { bindingId }),
      ...(options.at === undefined ? {} : { admissionAt: options.at }),
    });
  } catch (error) {
    // The engine publishes its own refusal codes through OperatorError; the MCP
    // surface answers the same code as a structured tool failure.
    if (error instanceof OperatorError) throw new ToolError(error.code, error.message, { nextStep: error.nextStep });
    throw error;
  }
}

/**
 * A delegated token acts only inside the consenting Workspace; an autonomous
 * token acts inside any Workspace its Agent Identity is bound to.
 */
function requireWorkspace(grant: AccessTokenGrant, workspaceId: string): void {
  if (grant.delegation !== null) {
    if (workspaceId !== grant.delegation.delegation.workspace_id) {
      throw new ToolError('WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this Agent Identity.');
    }
    return;
  }
  if (!grant.agent.workspace_ids.includes(workspaceId)) {
    throw new ToolError('WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this Agent Identity.');
  }
}

/**
 * Resolves a Data Product this Agent Identity may read in the Workspace the call
 * names. An Agent Identity is not a Workspace member, so a Workspace it is not
 * bound to answers exactly like one that does not exist, and a Data Product
 * reached through another Workspace's identifier is refused outright.
 */
function requireAgentProduct(
  session: PlatformSession,
  grant: AccessTokenGrant,
  workspaceId: string,
  dataProductId: string,
  context: ActionContext,
): DataProductArtifact {
  context.workspace_id = workspaceId;
  requireWorkspace(grant, workspaceId);
  const product = findDataProduct(session.state.data_products, dataProductId);
  if (!product || product.workspace_id !== workspaceId) {
    throw new ToolError('DATA_PRODUCT_NOT_AVAILABLE', 'The Data Product is not available to this Agent Identity.');
  }
  context.target = product.data_product_id;
  return product;
}

/** Reads one argument as the single identifier it must be. */
function requireText(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('MCP_ARGUMENT_INVALID', `The ${name} argument must name one identifier.`, { field: name });
  }
  return value;
}

/** Reads one optional argument as the single value it must be. */
function optionalText(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError('MCP_ARGUMENT_INVALID', `The ${name} argument must name one value.`, { field: name });
  }
  return value;
}

/** Refuses an argument the tool cannot act on by name, rather than guessing at it. */
function readArguments(tool: McpTool, raw: unknown): Record<string, unknown> {
  const candidate = raw ?? {};
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new ToolError('MCP_ARGUMENT_INVALID', 'Tool arguments must be a JSON object.', { field: 'arguments' });
  }
  const args = candidate as Record<string, unknown>;
  const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(args)) {
    if (!(name in properties)) {
      throw new ToolError('MCP_ARGUMENT_INVALID', `${tool.name} has no argument named ${name}.`, { field: name });
    }
  }
  for (const name of (tool.inputSchema['required'] ?? []) as string[]) {
    if (args[name] === undefined) {
      throw new ToolError('MCP_ARGUMENT_INVALID', `${tool.name} requires the ${name} argument.`, {
        field: name,
        nextStep: 'State every argument the tool declares.',
      });
    }
  }
  return args;
}

function toolResult(session: PlatformSession, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    _meta: { correlation_id: session.correlationId },
  };
}

function toolFailure(session: PlatformSession, error: ToolError): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: error.message }],
    structuredContent: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail.nextStep === undefined ? {} : { next_step: error.detail.nextStep }),
        ...(error.detail.field === undefined ? {} : { field: error.detail.field }),
        retryable: error.code === 'DATA_PRODUCT_QUERY_TIMEOUT',
      },
    },
    _meta: { correlation_id: session.correlationId },
  };
}
