import type { AccessTokenGrant } from './agents.js';
import type { ActionContext } from './authz.js';
import {
  findDataProduct,
  latestDataProductRelease,
  latestDataProductVersion,
  type DataProductArtifact,
} from './catalog.js';
import type { Fail } from './errors.js';
import { agentReader, type GrantReader } from './grants.js';
import { executeDataProductQuery } from './product-query.js';
import { contractView, describeDataProduct, productIdentity } from './products.js';
import type { PlatformSession } from './session.js';

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
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'discover_data_products',
    title: 'Discover Data Products',
    description: 'Lists the published Data Products in one Workspace that this Agent Identity may read, with the fields, metrics, and filters its Grants permit.',
    scopes: ['mcp:read'],
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
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

/** The tools one Agent Identity may see: a scope it does not hold hides the tool entirely. */
export function listTools(scopes: Set<string>): Record<string, unknown>[] {
  return MCP_TOOLS
    .filter((tool) => tool.scopes.every((scope) => scopes.has(scope)))
    .map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema }));
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
const DENIED_CODES = new Set(['WORKSPACE_ACCESS_DENIED', 'DATA_PRODUCT_NOT_AVAILABLE']);

/**
 * Invokes one tool for one authenticated Agent Identity. Every outcome is a tool
 * result the caller can read, and every invocation appends one Audit Event naming
 * the Agent, the OAuth client, the target, and the outcome.
 */
export function callTool(
  session: PlatformSession,
  grant: AccessTokenGrant,
  tool: McpTool,
  rawArguments: unknown,
): Record<string, unknown> {
  const actor = `agent:${grant.agent.name}`;
  const context: ActionContext = { action: 'mcp_tool_call', scope: 'workspace' };
  const target = declaredTarget(tool, rawArguments);
  if (target !== undefined) context.target = target;
  const detail = {
    tool: tool.name,
    agent_identity_id: grant.agent.agent_identity_id,
    oauth_client_id: grant.client.client_id,
  };
  try {
    const args = readArguments(tool, rawArguments);
    const reader = agentReader(session, grant.agent.agent_identity_id, actor);
    const payload = invoke(session, grant, reader, tool, args, context);
    session.audit({ ...context, actor, outcome: 'succeeded', detail });
    return toolResult(session, payload);
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

/** The identifier an invocation names before any lookup, so a refused call is still audited. */
function declaredTarget(tool: McpTool, rawArguments: unknown): string | undefined {
  if (rawArguments === null || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) return undefined;
  const name = tool.name === 'discover_data_products' ? 'workspace_id' : 'data_product_id';
  const value = (rawArguments as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function invoke(
  session: PlatformSession,
  grant: AccessTokenGrant,
  reader: GrantReader,
  tool: McpTool,
  args: Record<string, unknown>,
  context: ActionContext,
): Record<string, unknown> {
  if (tool.name === 'discover_data_products') return discover(session, grant, reader, args, context);
  if (tool.name === 'read_data_product_contract') return readContract(session, grant, reader, args, context);
  return query(session, grant, reader, args, context);
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
  if (!grant.agent.workspace_ids.includes(workspaceId)) {
    throw new ToolError('WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this Agent Identity.');
  }
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
  if (!grant.agent.workspace_ids.includes(workspaceId)) {
    throw new ToolError('WORKSPACE_ACCESS_DENIED', 'The Workspace is not available to this Agent Identity.');
  }
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
