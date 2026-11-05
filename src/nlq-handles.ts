import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Fail } from './errors.js';

/**
 * The opaque values a Natural-Language Query hands back to a caller.
 *
 * Both are signed with the Deployment's own data key and bound to the exact
 * User and Workspace that received them, so neither can be transplanted to
 * another principal, another Workspace, or another Deployment. Neither carries
 * authority: a handle only lets the platform recognise a conversation, and the
 * next turn re-resolves the actor, membership, Grants, and Releases from the
 * current state before anything executes.
 */

/** How many normalized questions a conversation keeps for follow-up context. */
export const MAX_CONVERSATION_QUESTIONS = 3;
/** The longest normalized question one conversation records. */
export const MAX_QUESTION_LENGTH = 400;
/** How many Data Products one conversation remembers it referred to. */
export const MAX_CONVERSATION_PRODUCTS = 16;

const HANDLE_VERSION = 1;
const PRODUCT_KIND = 'product';
const CONVERSATION_KIND = 'conversation';
const INVALID = 'NLQ_CONVERSATION_INVALID';

/** The normalized shape a follow-up turn inherits from the turn before it. */
export interface ConversationPayload {
  workspaceId: string;
  userId: string;
  /** The normalized questions this conversation already answered. */
  questions: string[];
  /** The Data Products the previous turn planned over, never an authority. */
  productIds: string[];
}

/**
 * Collapses the whitespace a question may carry so two turns that mean the same
 * thing normalize to the same text, without rewriting the business wording. A
 * question is never truncated: only what one conversation remembers is bounded.
 */
export function normalizeQuestion(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function sign(dataKey: Buffer, body: string): string {
  return createHmac('sha256', dataKey).update(body).digest('base64url');
}

function sealed(dataKey: Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(dataKey, body)}`;
}

/** Verifies the signature and the version, then returns the payload or null. */
function opened(dataKey: Buffer, raw: string): Record<string, unknown> | null {
  const [body, signature, ...rest] = raw.split('.');
  if (body === undefined || signature === undefined || rest.length > 0) return null;
  const expected = Buffer.from(sign(dataKey, body));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return record['v'] === HANDLE_VERSION ? record : null;
}

function stringList(value: unknown, limit: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0 || entry.length > maxLength)) return null;
  return value as string[];
}

/**
 * Names one Data Product inside one turn's plan input. The model is given only
 * these handles, never a raw identifier, and a handle it was not given in this
 * turn resolves to nothing.
 */
export function encodeProductHandle(
  dataKey: Buffer,
  binding: { userId: string; workspaceId: string; dataProductId: string },
): string {
  return sealed(dataKey, {
    v: HANDLE_VERSION,
    k: PRODUCT_KIND,
    u: binding.userId,
    w: binding.workspaceId,
    p: binding.dataProductId,
  });
}

/** Seals one conversation so the next turn can normalize it against the same actor. */
export function encodeConversation(
  dataKey: Buffer,
  payload: ConversationPayload,
): string {
  return sealed(dataKey, {
    v: HANDLE_VERSION,
    k: CONVERSATION_KIND,
    u: payload.userId,
    w: payload.workspaceId,
    q: payload.questions.slice(-MAX_CONVERSATION_QUESTIONS)
      .map((question) => question.slice(0, MAX_QUESTION_LENGTH)),
    p: payload.productIds.slice(0, MAX_CONVERSATION_PRODUCTS),
  });
}

/**
 * Opens a conversation bound to this exact User and Workspace. A handle from
 * another principal, Workspace, or Deployment fails closed before any governed
 * work happens, so it can never be used to reach another actor's context.
 */
export function decodeConversation(
  dataKey: Buffer,
  binding: { userId: string; workspaceId: string },
  raw: string,
  fail: Fail,
): ConversationPayload {
  const payload = opened(dataKey, raw);
  if (payload === null
    || payload['k'] !== CONVERSATION_KIND
    || payload['u'] !== binding.userId
    || payload['w'] !== binding.workspaceId) {
    fail(INVALID, 'A conversation handle must be one this Deployment issued to this actor in this Workspace.');
  }
  const questions = stringList(payload['q'], MAX_CONVERSATION_QUESTIONS, MAX_QUESTION_LENGTH);
  const productIds = stringList(payload['p'], MAX_CONVERSATION_PRODUCTS, 128);
  if (questions === null || productIds === null) {
    fail(INVALID, 'This conversation handle does not state the questions it continues.');
  }
  return {
    workspaceId: payload['w'] as string,
    userId: payload['u'] as string,
    questions,
    productIds,
  };
}
