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