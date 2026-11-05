import { optional, t, type MessageKey } from './i18n/zh-CN.js';

/** Locale-correct rendering of the instants the deployment reports. */
export function formatInstant(value: string | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
}

export function daysUntil(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, Math.floor((parsed - Date.now()) / 86_400_000));
}

/**
 * One governed number exactly as the Contract states it. Presentation never
 * rounds, rescales, or regroups a governed value.
 */
export function formatNumber(value: number): string {
  return String(value);
}

/**
 * Governed Role values stay ASCII at the boundary; only the label the User reads
 * is Chinese, and it comes from the one catalog.
 */
const ROLE_KEYS: Record<string, MessageKey> = {
  'Deployment Administrator': 'value.role.deploymentAdministrator',
  'Workspace Administrator': 'value.role.workspaceAdministrator',
  Consumer: 'value.role.consumer',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  const key = ROLE_KEYS[role];
  return key === undefined ? role : t(key);
}

/**
 * One Chinese sentence for a governed API failure. The ASCII code stays beside
 * it, so an administrator can quote the code without reading English prose.
 */
export function apiFailureText(code: string): string {
  return optional(`error.api.${code}`) ?? t('error.unknown');
}
