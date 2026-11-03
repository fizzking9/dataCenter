import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MfaRecord } from './enrollment.js';
import { readJsonFile, writeJsonFile } from './state.js';

/**
 * The Operator Console is separately authenticated: these records belong to the
 * host-level Operator and are never platform Users, Roles, or sessions.
 */
export interface OperatorRecord {
  operator_id: string;
  username: string;
  password_hash: string;
  status: 'active' | 'revoked';
  mfa: MfaRecord | null;
  failure_count: number;
  locked_until: string | null;
  enrolled_at: string;
  revoked_at: string | null;
}

/** A single-use, expiring, revocable secret that only establishes new credentials. */
export interface OperatorEnrollment {
  enrollment_id: string;
  username: string;
  secret_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export interface OperatorSessionRecord {
  token_hash: string;
  operator_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface OperatorConsoleState {
  schema_version: number;
  accounts: OperatorRecord[];
  enrollments: OperatorEnrollment[];
  sessions: OperatorSessionRecord[];
}

export const CONSOLE_SCHEMA_VERSION = 1;

function consolePath(root: string): string {
  return join(root, 'state', 'operator-console.json');
}

export function readOperatorConsole(root: string): OperatorConsoleState {
  const path = consolePath(root);
  return existsSync(path)
    ? readJsonFile<OperatorConsoleState>(path)
    : { schema_version: CONSOLE_SCHEMA_VERSION, accounts: [], enrollments: [], sessions: [] };
}

export function writeOperatorConsole(root: string, state: OperatorConsoleState): void {
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 });
  writeJsonFile(consolePath(root), state);
}

function normalize(username: string): string {
  return username.trim().toLowerCase();
}

export function findOperator(
  state: OperatorConsoleState,
  username: string,
): OperatorRecord | undefined {
  const wanted = normalize(username);
  const found = state.accounts.filter((record) => normalize(record.username) === wanted);
  return found.find((record) => record.status === 'active') ?? found[found.length - 1];
}

export function findOperatorById(
  state: OperatorConsoleState,
  operatorId: string,
): OperatorRecord | undefined {
  return state.accounts.find((record) => record.operator_id === operatorId);
}

/** Pending enrollments for one Operator, which a revocation takes with it. */
export function pendingEnrollments(state: OperatorConsoleState, username: string): OperatorEnrollment[] {
  const wanted = normalize(username);
  return state.enrollments.filter(
    (enrollment) => normalize(enrollment.username) === wanted
      && enrollment.consumed_at === null
      && enrollment.revoked_at === null,
  );
}
