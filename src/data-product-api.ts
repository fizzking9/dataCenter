import { resolveActor } from './auth.js';
import { actorLabel, reject, type ActionContext } from './authz.js';
import type { Fail } from './errors.js';
import { memberReader } from './grants.js';
import { workspaceRoleOf } from './platform.js';
import { executeDataProductQuery } from './product-query.js';
import { requireReadableProduct } from './products.js';
import { openPlatform } from './session.js';

export interface DataProductApiRequest {
  root: string;
  masterKey: string;
  /** The Bearer credential the Consumer presented on the published API path. */
  token: string;
  /** The Workspace the path names, which must be the Data Product's own. */
  workspaceId: string;
  dataProductId: string;
  /** The Data Product Query document, already parsed out of its HTTP body. */
  request: unknown;
}

/**
 * Serves one Data Product Query on the path a Publication advertises. It is the
 * same governed read the lifecycle CLI and MCP answer, reached over HTTP, so the
 * published API never becomes a second implementation with its own answers.
 */
export function queryDataProductApi(options: DataProductApiRequest): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'data_product_query',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  const product = requireReadableProduct(session, actor, context, options.dataProductId);
  // The path names the Workspace, so a Data Product reached through another
  // Workspace's advertised path is never served, even to a member of both.
  if (product.workspace_id !== options.workspaceId) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'DATA_PRODUCT_NOT_AVAILABLE',
      'The Data Product is not available to this actor.',
    );
  }
  const role = workspaceRoleOf(session.state, actor.user.user_id, product.workspace_id);
  const reader = memberReader(session, actor.user, role);
  const scoped: ActionContext = { ...context, workspace_id: product.workspace_id, target: product.data_product_id };
  const fail: Fail = (code, message, nextStep) => reject(session, reader.label, scoped, code, message, nextStep);
  return executeDataProductQuery({ session, reader, product, context: scoped, request: options.request, fail });
}
