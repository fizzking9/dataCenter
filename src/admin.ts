import { randomUUID } from 'node:crypto';
import { enrolMfa, type Enrollment } from './enrollment.js';
import { assertCondition } from './errors.js';
import { hashPassword } from './password.js';
import { isUsernameValid, type UserRecord } from './platform.js';

export interface BootstrapAdministrator {
  user: UserRecord;
  secrets: Enrollment['secrets'];
}

export async function bootstrapAdministrator(
  username: string,
  password: string,
  dataKey: Buffer,
): Promise<BootstrapAdministrator> {
  assertCondition(isUsernameValid(username), 'ADMIN_USERNAME_INVALID', 'The initial administrator username must be an account identifier of the form name@domain.');
  assertCondition(password.length >= 12 && password.length <= 1024, 'ADMIN_PASSWORD_INVALID', 'The initial administrator password must contain 12 to 1024 characters.');
  const enrollment = enrolMfa(username, dataKey);
  const user: UserRecord = {
    user_id: randomUUID(),
    username,
    password_hash: await hashPassword(password),
    status: 'active',
    deployment_role: 'Deployment Administrator',
    mfa: enrollment.mfa,
    failure_count: 0,
    locked_until: null,
    created_at: new Date().toISOString(),
  };
  return { user, secrets: enrollment.secrets };
}
