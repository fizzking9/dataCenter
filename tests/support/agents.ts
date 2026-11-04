import assert from 'node:assert/strict';
import type { OperatorResult } from './operator.js';
import { command, jsonFile, type PlatformFixture } from './platform.js';

/**
 * One Client ID Metadata Document a pre-registered OAuth client is created
 * from: the document's own URL is the Client Identifier, and the redirect URI
 * is the only one the client may name.
 */
export const CLIENT_METADATA = {
  client_id: 'https://agent.example.invalid/oauth/client.json',
  client_name: 'Certification Agent',
  redirect_uris: ['https://agent.example.invalid/callback'],
};

/** Creates one Agent Identity bound to the Workspace that owns the Data Products. */
export function createAgent(
  fixture: PlatformFixture,
  administratorToken: string,
  workspaceId: string,
  scopes = 'mcp:read',
  name = 'certification-agent',
): string {
  const created = command(
    fixture,
    ['agent', 'create', '--name', name, '--workspaces', workspaceId, '--scopes', scopes],
    { token: administratorToken },
  );
  assert.equal(created.status, 0, created.stderr);
  return String(created.output.agent_identity_id);
}

/** Registers one pre-registered OAuth client from a Client ID Metadata Document. */
export function registerAgentClient(
  fixture: PlatformFixture,
  administratorToken: string,
  agentIdentityId: string,
  metadata: unknown = CLIENT_METADATA,
  name = 'agent-client',
): { client_id: string; client_secret: string } {
  const registered = command(
    fixture,
    ['agent', 'client-register', '--agent', agentIdentityId, '--metadata', jsonFile(fixture, name, metadata)],
    { token: administratorToken },
  );
  assert.equal(registered.status, 0, registered.stderr);
  return registered.output as unknown as { client_id: string; client_secret: string };
}

/** Narrows what one Agent Identity may read of one Data Product. */
export function grantAgent(
  fixture: PlatformFixture,
  workspaceAdministratorToken: string,
  dataProductId: string,
  agentIdentityId: string,
  request: Record<string, unknown>,
  name = 'agent-grant',
): OperatorResult {
  return command(
    fixture,
    ['grant', 'publish', '--product', dataProductId, '--agent', agentIdentityId, '--request', jsonFile(fixture, name, request)],
    { token: workspaceAdministratorToken },
  );
}
