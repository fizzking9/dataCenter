/** The structured error every application API answers with. */
export interface ApiError {
  code: string;
  message?: string;
  next_step?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

export interface SessionView {
  operator_id: string;
  username: string;
  session_expires_at: string;
}

export interface Credentials {
  operator_id: string;
  username: string;
  mfa_enrolled: boolean;
  totp_secret: string;
  recovery_codes: string[];
  enrollment_uri: string;
}

export interface HealthView {
  state: string;
  health: string;
  service_open: boolean;
  runtime_services?: string[];
  mfa_enrolled?: boolean;
  default_credentials?: boolean;
  master_key_external?: boolean;
  evidence_id?: string;
  checked_at?: string;
}

export interface LicenseView {
  license_id: string;
  not_before: string;
  expires_at: string;
  highest_eligible_release: string;
  release: string;
  deployment_id: string;
  state: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...init,
    });
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK_UNAVAILABLE' } };
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: {
        code: typeof payload.code === 'string' ? payload.code : 'UNKNOWN',
        ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
        ...(typeof payload.next_step === 'string' ? { next_step: payload.next_step } : {}),
      },
    };
  }
  return { ok: true, data: payload as T };
}

/**
 * The browser holds no governed rules: it only calls the authenticated HTTP
 * application APIs that back the same modules the lifecycle CLI uses.
 */
export const consoleApi = {
  session: () => request<SessionView>('/api/operator/session'),
  signIn: (body: { username: string; password: string; totp?: string; recovery_code?: string }) =>
    request<SessionView>('/api/operator/session', { method: 'POST', body: JSON.stringify(body) }),
  signOut: () => request<{ revoked: boolean }>('/api/operator/session', { method: 'DELETE' }),
  enroll: (body: { enrollment_secret: string; password: string }) =>
    request<Credentials>('/api/operator/enrollment', { method: 'POST', body: JSON.stringify(body) }),
  health: () => request<HealthView>('/api/operator/health'),
  license: () => request<LicenseView>('/api/operator/license'),
};