import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { enrolMfa, recoveryCodeHash, type Enrollment } from './enrollment.js';
import { assertCondition, OperatorError } from './errors.js';
import {
  findOperator,
  findOperatorById,
  pendingEnrollments,
  readOperatorConsole,
  writeOperatorConsole,
  type OperatorConsoleState,
  type OperatorEnrollment,
  type OperatorRecord,
  type OperatorSessionRecord,
  type OperatorStepUpRecord,
} from './console.js';
import { decrypt } from './keys.js';
import { hashPassword, verifyPassword, verifyUnusablePassword } from './password.js';
import { isUsernameValid } from './platform.js';
import { openPlatform, type PlatformSession } from './session.js';
import { recordEvidence } from './state.js';
import { constantTimeEquals, hashToken } from './tokens.js';
import { verifyTotp } from './totp.js';

export const DEFAULT_ENROLLMENT_TTL_MINUTES = 15;
export const MAX_ENROLLMENT_TTL_MINUTES = 720;
export const OPERATOR_SESSION_LIFETIME_MS = 30 * 60 * 1000;
/**
 * How long one verified step-up challenge stays usable. It is short so the
 * browser must re-prove the Operator's password and MFA factor immediately
 * before the consequential action, not at sign-in time.
 */
export const OPERATOR_STEP_UP_LIFETIME_MS = 5 * 60 * 1000;

const MAX_CONSECUTIVE_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_FAILURE = 'Authentication failed.';

/** Keyed like a recovery code, so a leaked state file yields no usable secret. */
export function enrollmentSecretHash(dataKey: Buffer, secret: string): string {
  return createHmac('sha256', dataKey).update(secret.trim()).digest('hex');
}

/** The audit label keeps host-level Operator activity distinct from platform Users. */
export function operatorActor(username: string): string {
  return `operator:${username}`;
}

function assertOperatorUsername(username: string): string {
  const trimmed = username.trim();
  assertCondition(
    isUsernameValid(trimmed),
    'OPERATOR_NAME_INVALID',
    'The Operator identity must be an account identifier of the form name@domain.',
  );
  return trimmed;
}

export interface IssuedEnrollment {
  operator: string;
  enrollment_id: string;
  enrollment_secret: string;
  enrollment_path: string;
  enrollment_expires_at: string;
  evidence_id: string;
}

/**
 * Issues a one-time secret that only establishes new Operator Console
 * credentials. It is never a credential itself: enrollment additionally
 * requires a password and mandatory MFA.
 */
export function issueOperatorEnrollment(options: {
  root: string;
  masterKey: string;
  operator: string;
  ttlMinutes?: number;
  actor?: string;
}): IssuedEnrollment {
  const username = assertOperatorUsername(options.operator);
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_ENROLLMENT_TTL_MINUTES;
  assertCondition(
    Number.isFinite(ttlMinutes) && ttlMinutes > 0 && ttlMinutes <= MAX_ENROLLMENT_TTL_MINUTES,
    'OPERATOR_ENROLLMENT_TTL_INVALID',
    `The enrollment lifetime must run from 0 to ${MAX_ENROLLMENT_TTL_MINUTES} minutes.`,
  );
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const existing = findOperator(console, username);
  assertCondition(
    existing?.status !== 'active',
    'OPERATOR_ALREADY_ENROLLED',
    'An active Operator Console account already exists for this Operator.',
    'Revoke the existing Operator account before enrolling it again.',
  );

  const secret = randomBytes(32).toString('base64url');
  const now = Date.now();
  const enrollment: OperatorEnrollment = {
    enrollment_id: randomUUID(),
    username,
    secret_hash: enrollmentSecretHash(session.dataKey, secret),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMinutes * 60_000).toISOString(),
    consumed_at: null,
    revoked_at: null,
  };
  console.enrollments.push(enrollment);
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(username),
    action: 'operator_enrollment',
    scope: 'deployment',
    target: username,
    outcome: 'succeeded',
    detail: { enrollment_id: enrollment.enrollment_id, enrollment_expires_at: enrollment.expires_at },
  });
  const evidenceId = recordEvidence(options.root, 'operator-enroll', 'issued', options.actor ?? username, {
    enrollment_id: enrollment.enrollment_id,
    enrollment_expires_at: enrollment.expires_at,
  });
  return {
    operator: username,
    enrollment_id: enrollment.enrollment_id,
    enrollment_secret: secret,
    enrollment_path: `/enroll#${secret}`,
    enrollment_expires_at: enrollment.expires_at,
    evidence_id: evidenceId,
  };
}

function save(session: PlatformSession, console: OperatorConsoleState): void {
  writeOperatorConsole(session.root, console);
}

/** Withdraws one unconsumed secret so it can no longer establish credentials. */
export function revokeOperatorEnrollment(options: {
  root: string;
  masterKey: string;
  enrollmentId: string;
  actor?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const enrollment = console.enrollments.find((record) => record.enrollment_id === options.enrollmentId);
  assertCondition(enrollment !== undefined, 'OPERATOR_ENROLLMENT_NOT_FOUND', 'The Operator enrollment does not exist.');
  assertCondition(
    enrollment.consumed_at === null && enrollment.revoked_at === null,
    'OPERATOR_ENROLLMENT_INACTIVE',
    'The Operator enrollment is already consumed or revoked.',
  );
  enrollment.revoked_at = new Date().toISOString();
  save(session, console);
  session.audit({
    actor: operatorActor(enrollment.username),
    action: 'operator_enrollment_revocation',
    scope: 'deployment',
    target: enrollment.username,
    outcome: 'succeeded',
    detail: { enrollment_id: enrollment.enrollment_id },
  });
  const evidenceId = recordEvidence(options.root, 'operator-revoke-enrollment', 'revoked', options.actor ?? enrollment.username, {
    enrollment_id: enrollment.enrollment_id,
  });
  return { enrollment_id: enrollment.enrollment_id, revoked: true, evidence_id: evidenceId };
}

/**
 * Revokes the Operator account and every session and pending secret it holds,
 * which is the supported recovery path before re-enrolling from the CLI.
 */
export function revokeOperator(options: {
  root: string;
  masterKey: string;
  operator: string;
  actor?: string;
}): Record<string, unknown> {
  const username = assertOperatorUsername(options.operator);
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const account = findOperator(console, username);
  assertCondition(account !== undefined, 'OPERATOR_NOT_FOUND', 'The Operator Console account does not exist.');
  const revokedAt = new Date().toISOString();
  account.status = 'revoked';
  account.revoked_at = revokedAt;
  const revokedSessions = console.sessions.filter(
    (record) => record.operator_id === account.operator_id && record.revoked_at === null,
  );
  for (const record of revokedSessions) record.revoked_at = revokedAt;
  const revokedEnrollments = pendingEnrollments(console, username);
  for (const enrollment of revokedEnrollments) enrollment.revoked_at = revokedAt;
  // A revoked Operator holds no step-up proof either: the identities a grant
  // was issued to must never outlive the identity itself.
  console.step_ups = console.step_ups.filter((record) => record.operator_id !== account.operator_id);
  save(session, console);
  session.audit({
    actor: operatorActor(account.username),
    action: 'operator_revocation',
    scope: 'deployment',
    target: account.username,
    outcome: 'succeeded',
    detail: { sessions_revoked: revokedSessions.length, enrollments_revoked: revokedEnrollments.length },
  });
  const evidenceId = recordEvidence(options.root, 'operator-revoke', 'revoked', options.actor ?? username, {
    operator_id: account.operator_id,
    sessions_revoked: revokedSessions.length,
  });
  return {
    operator: account.username,
    operator_id: account.operator_id,
    status: account.status,
    sessions_revoked: revokedSessions.length,
    evidence_id: evidenceId,
  };
}

export type OperatorCredentials = Enrollment['secrets'] & {
  operator_id: string;
  username: string;
  mfa_enrolled: true;
};

/**
 * Every reason a secret may not be exchanged, checked against one state read so
 * the answer is the same before and after the password hash suspension point.
 */
function assertEnrollmentUsable(
  console: OperatorConsoleState,
  secretHash: string,
  password: string,
): OperatorEnrollment {
  const enrollment = console.enrollments.find((record) => constantTimeEquals(record.secret_hash, secretHash));
  assertCondition(
    enrollment !== undefined,
    'OPERATOR_ENROLLMENT_INVALID',
    'The enrollment secret is not valid.',
    'Generate a new enrollment secret from the Operator lifecycle commands.',
  );
  assertCondition(enrollment.revoked_at === null, 'OPERATOR_ENROLLMENT_REVOKED', 'The enrollment secret has been revoked.', 'Generate a new enrollment secret from the Operator lifecycle commands.');
  assertCondition(enrollment.consumed_at === null, 'OPERATOR_ENROLLMENT_CONSUMED', 'The enrollment secret has already been used.');
  assertCondition(Date.parse(enrollment.expires_at) > Date.now(), 'OPERATOR_ENROLLMENT_EXPIRED', 'The enrollment secret has expired.', 'Generate a new enrollment secret from the Operator lifecycle commands.');
  assertCondition(
    password.length >= 12 && password.length <= 1024,
    'OPERATOR_PASSWORD_INVALID',
    'The Operator Console password must contain 12 to 1024 characters.',
  );
  assertCondition(
    findOperator(console, enrollment.username)?.status !== 'active',
    'OPERATOR_ALREADY_ENROLLED',
    'An active Operator Console account already exists for this Operator.',
  );
  return enrollment;
}

/**
 * The one-time secret only establishes new credentials. It is never accepted as
 * a session, and it cannot be replayed once it has been exchanged.
 */
export async function exchangeOperatorEnrollment(options: {
  root: string;
  masterKey: string;
  secret: string;
  password: string;
}): Promise<OperatorCredentials> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const secretHash = enrollmentSecretHash(session.dataKey, options.secret);
  assertEnrollmentUsable(readOperatorConsole(options.root), secretHash, options.password);

  // Hashing is the only suspension point. Both the check and the consumption
  // below happen against a fresh read without yielding, so one secret can never
  // establish two Operators.
  const passwordHash = await hashPassword(options.password);
  const console = readOperatorConsole(options.root);
  const enrollment = assertEnrollmentUsable(console, secretHash, options.password);

  const mfa = enrolMfa(enrollment.username, session.dataKey);
  const existing = findOperator(console, enrollment.username);
  // A revoked identity reactivates in place, so it keeps one Operator lineage.
  const operator: OperatorRecord = existing ?? {
    operator_id: randomUUID(),
    username: enrollment.username,
    password_hash: passwordHash,
    status: 'active',
    mfa: mfa.mfa,
    failure_count: 0,
    locked_until: null,
    enrolled_at: new Date().toISOString(),
    revoked_at: null,
  };
  operator.password_hash = passwordHash;
  operator.mfa = mfa.mfa;
  operator.status = 'active';
  operator.revoked_at = null;
  operator.failure_count = 0;
  operator.locked_until = null;
  enrollment.consumed_at = new Date().toISOString();
  if (!existing) console.accounts.push(operator);
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(operator.username),
    action: 'operator_enrollment_exchange',
    scope: 'deployment',
    target: operator.username,
    outcome: 'succeeded',
    detail: { operator_id: operator.operator_id },
  });
  return {
    operator_id: operator.operator_id,
    username: operator.username,
    mfa_enrolled: true,
    ...mfa.secrets,
  };
}

function failOperatorAuthentication(
  session: PlatformSession,
  console: OperatorConsoleState,
  username: string,
  reason: string,
): never {
  writeOperatorConsole(session.root, console);
  session.audit({
    actor: 'unauthenticated',
    action: 'operator_authentication',
    scope: 'deployment',
    target: username,
    outcome: 'failed',
    detail: { reason },
  });
  throw new OperatorError('OPERATOR_AUTHENTICATION_FAILED', GENERIC_FAILURE);
}

function registerOperatorFailure(account: OperatorRecord): void {
  account.failure_count += 1;
  if (account.failure_count >= MAX_CONSECUTIVE_FAILURES) {
    account.locked_until = new Date(Date.now() + LOCKOUT_MS).toISOString();
    account.failure_count = 0;
  }
}

function satisfiesOperatorMfa(
  dataKey: Buffer,
  account: OperatorRecord,
  totp: string | undefined,
  recoveryCode: string | undefined,
): boolean {
  if (account.mfa === null) return false;
  if (totp !== undefined) {
    return verifyTotp(decrypt(dataKey, account.mfa.secret).toString('utf8'), totp);
  }
  if (recoveryCode === undefined) return false;
  const candidate = recoveryCodeHash(dataKey, recoveryCode);
  const index = account.mfa.recovery_codes.findIndex((stored) => constantTimeEquals(stored, candidate));
  if (index === -1) return false;
  account.mfa.recovery_codes.splice(index, 1);
  return true;
}

export interface OperatorSignIn {
  token: string;
  operator_id: string;
  username: string;
  session_expires_at: string;
}

/**
 * Operator sessions are minted here and nowhere else: they are never accepted
 * as platform User sessions, and platform User tokens never open the console.
 */
export async function signInOperator(options: {
  root: string;
  masterKey: string;
  username: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
}): Promise<OperatorSignIn> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const account = findOperator(console, options.username);
  if (!account) {
    await verifyUnusablePassword(options.password);
    failOperatorAuthentication(session, console, options.username, 'unknown_operator');
  }
  if (account.locked_until && Date.parse(account.locked_until) > Date.now()) {
    await verifyUnusablePassword(options.password);
    failOperatorAuthentication(session, console, options.username, 'throttled');
  }
  if (account.status !== 'active') {
    await verifyUnusablePassword(options.password);
    failOperatorAuthentication(session, console, options.username, 'revoked');
  }
  if (!(await verifyPassword(options.password, account.password_hash))) {
    registerOperatorFailure(account);
    failOperatorAuthentication(session, console, options.username, 'password');
  }
  if (!satisfiesOperatorMfa(session.dataKey, account, options.totp, options.recoveryCode)) {
    registerOperatorFailure(account);
    failOperatorAuthentication(session, console, options.username, 'mfa');
  }

  account.failure_count = 0;
  account.locked_until = null;
  const now = Date.now();
  console.sessions = console.sessions.filter((record) => Date.parse(record.expires_at) > now);
  const token = randomBytes(32).toString('base64url');
  const record: OperatorSessionRecord = {
    token_hash: hashToken(token),
    operator_id: account.operator_id,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + OPERATOR_SESSION_LIFETIME_MS).toISOString(),
    revoked_at: null,
  };
  console.sessions.push(record);
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(account.username),
    action: 'operator_authentication',
    scope: 'deployment',
    target: account.username,
    outcome: 'succeeded',
    detail: { mfa: options.totp === undefined ? 'recovery_code' : 'totp' },
  });
  return {
    token,
    operator_id: account.operator_id,
    username: account.username,
    session_expires_at: record.expires_at,
  };
}

/** Resolves the Operator behind a console cookie on every request. */
export function resolveOperatorSession(
  root: string,
  token: string,
): { operator: OperatorRecord; session: OperatorSessionRecord } | undefined {
  const console = readOperatorConsole(root);
  const tokenHash = hashToken(token);
  const record = console.sessions.find((candidate) => constantTimeEquals(candidate.token_hash, tokenHash));
  if (!record || record.revoked_at !== null) return undefined;
  if (Date.parse(record.expires_at) <= Date.now()) return undefined;
  const operator = findOperatorById(console, record.operator_id);
  if (!operator || operator.status !== 'active') return undefined;
  return { operator, session: record };
}

/** Signing out is idempotent: an unusable cookie is cleared, not an error. */
export function signOutOperator(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const resolved = resolveOperatorSession(options.root, options.token);
  if (!resolved) return { revoked: false };
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const record = console.sessions.find((candidate) => candidate.token_hash === resolved.session.token_hash);
  if (record) record.revoked_at = new Date().toISOString();
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(resolved.operator.username),
    action: 'operator_session_revocation',
    scope: 'deployment',
    target: resolved.operator.username,
    outcome: 'succeeded',
  });
  return { revoked: true, operator: resolved.operator.username };
}

/** One live console session, stated without the token or its hash. */
export interface OperatorSessionSummary {
  current: boolean;
  issued_at: string;
  expires_at: string;
}

function requireOperatorSession(
  root: string,
  token: string,
): { operator: OperatorRecord; session: OperatorSessionRecord } {
  const resolved = resolveOperatorSession(root, token);
  if (resolved === undefined) {
    throw new OperatorError('OPERATOR_SESSION_INVALID', 'The Operator Console session is not valid.', undefined, 401);
  }
  return resolved;
}

function liveOperatorSessions(
  console: OperatorConsoleState,
  operatorId: string,
  now: number,
): OperatorSessionRecord[] {
  return console.sessions.filter(
    (record) => record.operator_id === operatorId
      && record.revoked_at === null
      && Date.parse(record.expires_at) > now,
  );
}

/**
 * The sessions one Operator currently holds. It states instants only: a session
 * token or its hash never leaves the module that minted it.
 */
export function listOperatorSessions(options: {
  root: string;
  token: string;
}): { operator: string; sessions: OperatorSessionSummary[] } {
  const resolved = requireOperatorSession(options.root, options.token);
  const console = readOperatorConsole(options.root);
  const sessions = liveOperatorSessions(console, resolved.operator.operator_id, Date.now())
    .map((record) => ({
      current: constantTimeEquals(record.token_hash, resolved.session.token_hash),
      issued_at: record.issued_at,
      expires_at: record.expires_at,
    }))
    .sort((left, right) => Date.parse(left.issued_at) - Date.parse(right.issued_at));
  return { operator: resolved.operator.username, sessions };
}

/**
 * Ends every other live session of the Operator who asked, which is how a
 * console user withdraws a session left open elsewhere. The asking session keeps
 * working, and each ended session is refused on its very next request.
 */
export function revokeOtherOperatorSessions(options: {
  root: string;
  masterKey: string;
  token: string;
}): Record<string, unknown> {
  const resolved = requireOperatorSession(options.root, options.token);
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const revokedAt = new Date().toISOString();
  const others = liveOperatorSessions(console, resolved.operator.operator_id, Date.now())
    .filter((record) => !constantTimeEquals(record.token_hash, resolved.session.token_hash));
  for (const record of others) record.revoked_at = revokedAt;
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(resolved.operator.username),
    action: 'operator_session_revocation',
    scope: 'deployment',
    target: resolved.operator.username,
    outcome: 'succeeded',
    detail: { sessions_revoked: others.length, sessions: 'other' },
  });
  const evidenceId = recordEvidence(options.root, 'operator-session-revoke', 'revoked', resolved.operator.username, {
    sessions_revoked: others.length,
  });
  return {
    operator: resolved.operator.username,
    sessions_revoked: others.length,
    evidence_id: evidenceId,
  };
}

export interface OperatorStepUp {
  step_up_grant: string;
  purpose: string;
  target: string;
  method: 'totp' | 'recovery_code';
  verified_at: string;
  expires_at: string;
}

const STEP_UP_FAILED = 'Step-up authentication failed.';
const STEP_UP_NEXT = 'Re-enter the current password and a current dynamic code immediately before the consequential action.';

function failOperatorStepUp(
  session: PlatformSession,
  console: OperatorConsoleState,
  account: OperatorRecord,
  reason: string,
  purpose: string,
  target: string,
): never {
  writeOperatorConsole(session.root, console);
  session.audit({
    actor: operatorActor(account.username),
    action: 'operator_step_up_authentication',
    scope: 'deployment',
    target,
    outcome: 'failed',
    detail: { reason, purpose },
  });
  throw new OperatorError('OPERATOR_STEP_UP_FAILED', STEP_UP_FAILED, STEP_UP_NEXT, 403);
}

function pruneStepUps(console: OperatorConsoleState, now: number): void {
  console.step_ups = console.step_ups.filter((record) => Date.parse(record.expires_at) > now);
}

/**
 * A fresh challenge beside the standing Operator session. The password and a
 * current MFA factor are re-proved, and a single-use grant bound to exactly one
 * purpose and target is minted. A failure is audited and changes nothing.
 */
export async function verifyOperatorStepUp(options: {
  root: string;
  masterKey: string;
  token: string;
  password: string;
  totp?: string;
  recoveryCode?: string;
  purpose: string;
  target: string;
}): Promise<OperatorStepUp> {
  assertCondition(
    options.purpose.trim().length > 0 && options.target.trim().length > 0,
    'OPERATOR_STEP_UP_PURPOSE_INVALID',
    'A step-up challenge must name the exact purpose and target it unlocks.',
  );
  const resolved = resolveOperatorSession(options.root, options.token);
  if (resolved === undefined) {
    throw new OperatorError('OPERATOR_SESSION_INVALID', 'The Operator Console session is not valid.', undefined, 401);
  }
  // Operator authentication and step-up stay available under an expired
  // license so recovery and other lifecycle commands remain reachable.
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const account = findOperatorById(console, resolved.operator.operator_id);
  assertCondition(account !== undefined, 'OPERATOR_NOT_FOUND', 'The Operator Console account does not exist.');
  if (account.locked_until !== null && Date.parse(account.locked_until) > Date.now()) {
    await verifyUnusablePassword(options.password);
    failOperatorStepUp(session, console, account, 'throttled', options.purpose, options.target);
  }
  if (!(await verifyPassword(options.password, account.password_hash))) {
    registerOperatorFailure(account);
    failOperatorStepUp(session, console, account, 'password', options.purpose, options.target);
  }
  if (!satisfiesOperatorMfa(session.dataKey, account, options.totp, options.recoveryCode)) {
    registerOperatorFailure(account);
    failOperatorStepUp(session, console, account, 'mfa', options.purpose, options.target);
  }

  const now = Date.now();
  account.failure_count = 0;
  account.locked_until = null;
  const grant = randomBytes(32).toString('base64url');
  const method: OperatorStepUp['method'] = options.totp !== undefined ? 'totp' : 'recovery_code';
  const record: OperatorStepUpRecord = {
    grant_hash: hashToken(grant),
    operator_id: account.operator_id,
    purpose: options.purpose,
    target: options.target,
    verified_at: new Date(now).toISOString(),
    expires_at: new Date(now + OPERATOR_STEP_UP_LIFETIME_MS).toISOString(),
    method,
  };
  pruneStepUps(console, now);
  console.step_ups.push(record);
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(account.username),
    action: 'operator_step_up_authentication',
    scope: 'deployment',
    target: options.target,
    outcome: 'succeeded',
    detail: { method, purpose: options.purpose, expires_at: record.expires_at },
  });
  return {
    step_up_grant: grant,
    purpose: record.purpose,
    target: record.target,
    method,
    verified_at: record.verified_at,
    expires_at: record.expires_at,
  };
}

/**
 * Spends the grant a consequence requires. The grant must belong to the same
 * Operator, the same purpose, and the same target, and it is consumed here, so
 * the consequential route cannot proceed on a stale or borrowed proof.
 */
export function consumeOperatorStepUp(options: {
  root: string;
  masterKey: string;
  token: string;
  grant: string;
  purpose: string;
  target: string;
}): { verified_at: string; username: string; method: 'totp' | 'recovery_code' } {
  const resolved = resolveOperatorSession(options.root, options.token);
  if (resolved === undefined) {
    throw new OperatorError('OPERATOR_SESSION_INVALID', 'The Operator Console session is not valid.', undefined, 401);
  }
  // Spending a step-up grant stays available under an expired license for the
  // same reason it is issued: the consequential lifecycle command still runs.
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const console = readOperatorConsole(options.root);
  const wanted = hashToken(options.grant.trim());
  const now = Date.now();
  const record = console.step_ups.find(
    (candidate) => constantTimeEquals(candidate.grant_hash, wanted)
      && candidate.operator_id === resolved.operator.operator_id
      && candidate.purpose === options.purpose
      && candidate.target === options.target
      && Date.parse(candidate.expires_at) > now,
  );
  if (record === undefined) {
    session.audit({
      actor: operatorActor(resolved.operator.username),
      action: 'operator_step_up_consumption',
      scope: 'deployment',
      target: options.target,
      outcome: 'denied',
      detail: { purpose: options.purpose, error_code: 'OPERATOR_STEP_UP_REQUIRED' },
    });
    throw new OperatorError(
      'OPERATOR_STEP_UP_REQUIRED',
      'A fresh step-up authentication is required before this action.',
      'Verify the Operator password and a current dynamic code again, then retry the action.',
      403,
    );
  }
  console.step_ups = console.step_ups.filter((candidate) => candidate !== record);
  pruneStepUps(console, now);
  writeOperatorConsole(options.root, console);
  session.audit({
    actor: operatorActor(resolved.operator.username),
    action: 'operator_step_up_consumption',
    scope: 'deployment',
    target: options.target,
    outcome: 'succeeded',
    detail: { method: record.method, purpose: options.purpose, verified_at: record.verified_at },
  });
  return { verified_at: record.verified_at, username: resolved.operator.username, method: record.method };
}
