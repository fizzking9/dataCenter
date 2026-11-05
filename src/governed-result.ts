import { isRecord } from './documents.js';

/**
 * The deterministic reading of one Data Product Query result, shared by every
 * governed answer so a Natural-Language Query and a stocked Report can never
 * classify, label, or narrate the same result differently.
 */

/** The distinct structured outcome one executed result may report. */
export type ResultOutcome = 'answered' | 'empty' | 'no_evidence';

const CAUSAL = /因为|由于|导致|造成|引发|因此|所以|从而|使得|because|due to|caused|led to|therefore|as a result/iu;
/** A narrative may not assert a relationship between governed facts, or across products. */
const RELATIONAL = /关联|相关|成正比|反比|同步|联动|互为|彼此影响|互相影响|互相带动|存在关系|存在关联|correlat|relationship/iu;
const NUMBERS = /\d+(?:\.\d+)?/gu;

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizedNumbers(text: string): string[] {
  return [...text.matchAll(NUMBERS)].map((match) => String(Number(match[0])));
}

/** Classifies one executed result into a distinct structured outcome. */
export function classifyResult(result: Record<string, unknown>): ResultOutcome {
  const kind = result['kind'];
  if (kind === 'aggregate') {
    const groups = arrayOf(result['groups']).filter(isRecord);
    const groupTotal = Number(result['groups_total'] ?? groups.length);
    if (groupTotal === 0) return 'empty';
    const hasGroupValue = groups.some((group) => {
      const metrics = objectOrNull(group['metrics']);
      return metrics !== null && Object.values(metrics).some((value) => value !== null && value !== undefined);
    });
    if (hasGroupValue) return 'answered';
    const totals = objectOrNull(result['totals']);
    const totalsMetrics = totals === null ? null : objectOrNull(totals['metrics']);
    const hasTotalValue = totalsMetrics !== null
      && Object.values(totalsMetrics).some((value) => value !== null && value !== undefined);
    return hasTotalValue ? 'answered' : 'no_evidence';
  }
  if (kind === 'search') {
    return Number(result['matched_count'] ?? 0) === 0 ? 'empty' : 'answered';
  }
  if (kind === 'suggest') {
    return arrayOf(result['suggestions']).length === 0 ? 'empty' : 'answered';
  }
  return Number(result['returned'] ?? 0) === 0 ? 'empty' : 'answered';
}

export function groupLabel(group: Record<string, unknown>): string {
  const dimensions = objectOrNull(group['group']);
  if (dimensions === null) return '所选分组';
  const values = Object.values(dimensions).map((value) => (value === null ? '未分类' : String(value)));
  return values.length === 0 ? '所选分组' : values.join(' / ');
}

/** One part whose result the narrative may cite, and the Product it is cited under. */
export interface NarratablePart {
  name: string;
  result: Record<string, unknown>;
  release: Record<string, unknown>;
}

/** Reads one governed metric value as a number the narrative may cite, if it is numeric. */
export function numericFact(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // A monetary or decimal metric is a JSON string, so its arithmetic value is
  // what the narrative may restate; the governed rendering stays in the result.
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The evidence the narrative is allowed to state: only numbers the deterministic
 * engine computed for the parts that actually answered, laid out as records so
 * the shared grounding check applies. No cross-product number is computed here.
 */
export function narrationFacts(
  parts: NarratablePart[],
  question: string,
): {
  question: string;
  records: Array<Record<string, unknown>>;
  filters: unknown[];
  windows: unknown[];
  comparison_windows: unknown[];
  partial_period: boolean;
  parts: Array<Record<string, unknown>>;
} {
  const records: Array<Record<string, unknown>> = [];
  const filters: unknown[] = [];
  const windows: unknown[] = [];
  const comparisonWindows: unknown[] = [];
  let partial = false;
  const named = parts.length > 1;
  for (const part of parts) {
    const result = part.result;
    const metrics = arrayOf(result['metrics']).filter(isRecord);
    const groups = arrayOf(result['groups']).filter(isRecord);
    for (const group of groups) {
      const values = objectOrNull(group['metrics']) ?? {};
      const groupName = groupLabel(group);
      for (const metric of metrics) {
        const name = metric['name'];
        const value = typeof name === 'string' ? numericFact(values[name]) : null;
        if (value !== null) {
          records.push({
            label: named ? `${part.name} ${groupName}` : groupName,
            value,
            metric: name,
            group: groupName,
            ...(named ? { product: part.name } : {}),
          });
        }
      }
    }
    if (groups.length === 0) {
      const totals = objectOrNull(result['totals']);
      const totalsMetrics = totals === null ? null : objectOrNull(totals['metrics']);
      for (const metric of metrics) {
        const name = metric['name'];
        const value = typeof name === 'string' && totalsMetrics !== null ? numericFact(totalsMetrics[name]) : null;
        if (value !== null) {
          records.push({
            label: named ? `${part.name} 合计 ${String(name)}` : `合计 ${String(name)}`,
            value,
            metric: name,
            group: '合计',
            ...(named ? { product: part.name } : {}),
          });
        }
      }
    }
    filters.push(...arrayOf(result['query']));
    windows.push(result['window'] ?? null);
    comparisonWindows.push(result['comparison_window'] ?? null);
    if (objectOrNull(result['window'])?.['partial'] === true) partial = true;
  }
  return {
    question,
    records,
    filters,
    windows,
    comparison_windows: comparisonWindows,
    partial_period: partial,
    parts: parts.map((part) => ({ ...part.release })),
  };
}

/** A narrative may state no cause, no invented relationship, and no ungoverned number. */
export function narrativeViolation(narrative: string, facts: unknown): string | null {
  if (CAUSAL.test(narrative)) return 'NARRATIVE_CAUSAL_CLAIM';
  if (RELATIONAL.test(narrative)) return 'NARRATIVE_INVENTED_RELATIONSHIP';
  const governed = new Set(normalizedNumbers(JSON.stringify(facts)));
  for (const token of normalizedNumbers(narrative)) {
    if (!governed.has(token)) return 'NARRATIVE_NUMBER_NOT_GOVERNED';
  }
  return null;
}

/** The as-of story one executed read discloses beside its own Provenance. */
export function freshnessOf(
  provenance: Record<string, unknown> | null,
  window: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (provenance === null) return null;
  const coverage = window === null ? null : objectOrNull(window['coverage']);
  return {
    acquired_at: provenance['acquired_at'] ?? null,
    integrated_at: provenance['integrated_at'] ?? null,
    released_at: provenance['released_at'] ?? null,
    data_through: coverage === null ? null : coverage['end'] ?? null,
  };
}
