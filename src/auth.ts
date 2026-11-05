import { randomBytes } from 'node:crypto';
import { actorLabel, deny, type ActionContext, type Actor } from './authz.js';
import { recoveryCodeHash } from './enrollment.js';
import { OperatorError } from './errors.js';
import { decrypt } from './keys.js';
import { verifyPassword, verifyUnusablePassword } from './password.js';
import {
  findUser,
  findUserById,
  type SessionRecord,
  type UserRecord,
} from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { constantTimeEquals, hashToken } from './tokens.js';
import { verifyTotp } from './totp.js';

const SESSION_LIFETIME_MS = 15 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_FAILURE = 'Authentication failed.';

/**
 * The platform User session cookie. It is `SameSite=Lax` so a top-level
 * navigation into the OAuth authorization endpoint carries the session, while
 * a cross-site POST still does not.
 */
export const USER_SESSION_COOKIE = 'dc_user_session';

function auditFailed(session: PlatformSession, context: ActionContext, reason: string): never {
  session.save();
  session.audit({ ...context, actor: 'unauthenticated', outcome: 'failed', detail: { reason } });
  throw new OperatorError('AUTHENTICATION_FAILED', GENERIC_FAILURE);
}

function registerFailure(session: PlatformSession, user: UserRecord): void {
  user.failure_count += 1;
  if (user.failure_count >= MAX_CONSECUTIVE_FAILURES) {
    user.locked_until = new Date(Date.now() + LOCKOUT_MS).toISOString();
    user.failure_count = 0;
  }
}

function consumeRecoveryCode(session: PlatformSession, user: UserRecord, code: string): boolean {
  const mfa = user.mfa;
  if (!mfa) return false;
  const candidate = recoveryCodeHash(session.dataKey, code);
  const index = mfa.recovery_codes.findIndex((stored) => constantTimeEquals(stored, candidate));
  if (index === -1) return false;
  mfa.recovery_codes.splice(index, 1);
  return true;
}

function satisfiesMfa(session: PlatformSession, user: UserRecord, totp: string | undefined, recoveryCode: string | undefined): boolean {
  if (user.mfa === null) return true;
  if (totp !== undefined) {
    return verifyTotp(decrypt(session.dataKey, user.mfa.secret).toString('utf8'), totp);
  }
  return recoveryCode !== undefined && consumeRecoveryCode(session, user, recoveryCode);
}

function pruneSessions(session: PlatformSession): void {
  const expiredBefore = Date.now() - SESSION_LIFETIME_MS;
  session.state.sessions = session.state.sessions.filter((record) => Date.parse(record.issued_at) > expiredBefore);
}

function issueToken(session: PlatformSession, user: UserRecord): { token: string; record: SessionRecord } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const record: SessionRecord = {
    token_hash: hashToken(token),
    user_id: user.user_id,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_LIFETIME_MS).toISOString(),
    revoked_at: null,
  };
  session.state.sessions.push(record);
  return { token, record };
}

export interface LoginOptions {
  root: string;
  masterKey: string;
  username: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
}

export async function login(options: LoginOptions): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'authentication',
    scope: 'deployment',
    target: options.username,
  };
  const user = findUser(session.state, options.username);

  if (!user) {
    await verifyUnusablePassword(options.password);
    auditFailed(session, context, 'unknown_username');
  }
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    await verifyUnusablePassword(options.password);
    auditFailed(session, context, 'throttled');
  }
  if (user.status !== 'active') {
    await verifyUnusablePassword(options.password);
    auditFailed(session, context, 'deactivated');
  }
  if (!(await verifyPassword(options.password, user.password_hash))) {
    registerFailure(session, user);
    auditFailed(session, context, 'password');
  }
  if (!satisfiesMfa(session, user, options.totp, options.recoveryCode)) {
    registerFailure(session, user);
    auditFailed(session, context, 'mfa');
  }

  user.failure_count = 0;
  user.locked_until = null;
  pruneSessions(session);
  const { token, record } = issueToken(session, user);
  session.audit({ ...context, actor: actorLabel(user), outcome: 'succeeded' });
  session.save();
  return {
    user_id: user.user_id,
    username: user.username,
    deployment_role: user.deployment_role,
    mfa_enrolled: user.mfa !== null,
    session_token: token,
    session_expires_at: record.expires_at,
    workspace_roles: session.state.memberships
      .filter((membership) => membership.user_id === user.user_id)
      .map((membership) => ({ workspace_id: membership.workspace_id, role: membership.role })),
  };
}

function activeActor(session: PlatformSession, token: string): Actor | undefined {
  const tokenHash = hashToken(token);
  const record = session.state.sessions.find((candidate) => constantTimeEquals(candidate.token_hash, tokenHash));
  if (!record || record.revoked_at !== null) return undefined;
  if (Date.parse(record.expires_at) <= Date.now()) return undefined;
  const user = findUserById(session.state, record.user_id);
  if (!user || user.status !== 'active') return undefined;
  return { user, session: record };
}

/**
 * Resolves the caller on every request, so deactivation, logout, and expiry
 * take effect immediately rather than at token lifetime.
 */
export function resolveActor(session: PlatformSession, token: string, context: ActionContext): Actor {
  const actor = activeActor(session, token);
  if (!actor) {
    deny(session, 'unauthenticated', context, 'SESSION_INVALID', 'The session is not valid.');
  }
  return actor;
}

export function logout(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'session_revocation', scope: 'deployment' };
  const actor = resolveActor(session, options.token, context);
  actor.session.revoked_at = new Date().toISOString();
  session.audit({ ...context, actor: actorLabel(actor.user), outcome: 'succeeded', target: actor.user.username });
  session.save();
  return { revoked: true, user_id: actor.user.user_id };
}

export interface StepUpOptions {
  root: string;
  masterKey: string;
  token: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
  /** The consequential operation this challenge unlocks, recorded when it is verified. */
  purpose: string;
  workspaceId?: string;
  target?: string;
}

/**
 * A fresh authentication challenge beside an existing session, required before
 * an irreversible operation. The session itself stays valid, but the
 * consequential action only proceeds when the actor re-proves the current
 * password and a current MFA factor; a failure is audited and changes nothing.
 */
export async function verifyStepUpAuthentication(options: StepUpOptions): Promise<{
  verified_at: string;
  method: 'totp' | 'recovery_code';
  username: string;
}> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = {
    action: 'step_up_authentication',
    scope: options.workspaceId === undefined ? 'deployment' : 'workspace',
    ...(options.workspaceId === undefined ? {} : { workspace_id: options.workspaceId }),
    target: options.target ?? options.purpose,
  };
  const actor = resolveActor(session, options.token, context);
  if (!(await verifyPassword(options.password, actor.user.password_hash))) {
    registerFailure(session, actor.user);
    session.audit({
      ...context,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: { reason: 'password', purpose: options.purpose },
    });
    session.save();
    throw new OperatorError(
      'STEP_UP_AUTHENTICATION_FAILED',
      'Step-up authentication failed.',
      'Re-enter the current password and a current dynamic code before the consequential action.',
    );
  }
  if (!satisfiesMfa(session, actor.user, options.totp, options.recoveryCode)) {
    registerFailure(session, actor.user);
    session.audit({
      ...context,
      actor: actorLabel(actor.user),
      outcome: 'failed',
      detail: { reason: 'mfa', purpose: options.purpose },
    });
    session.save();
    throw new OperatorError(
      'STEP_UP_AUTHENTICATION_FAILED',
      'Step-up authentication failed.',
      'Re-enter the current password and a current dynamic code before the consequential action.',
    );
  }
  actor.user.failure_count = 0;
  actor.user.locked_until = null;
  const method: 'totp' | 'recovery_code' = options.totp !== undefined ? 'totp' : 'recovery_code';
  const verifiedAt = new Date().toISOString();
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { method, purpose: options.purpose, verified_at: verifiedAt },
  });
  session.save();
  return { verified_at: verifiedAt, method, username: actor.user.username };
}
