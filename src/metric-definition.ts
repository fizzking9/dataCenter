import type { DataProductContract } from './catalog.js';
import { reject, type ActionContext } from './authz.js';
import {
  DEPLOYMENT_CONTEXT_ARTIFACT,
  findContextArtifact,
  workspaceContextArtifact,
  type ContextEntry,
} from './platform.js';
import type { PlatformSession } from './session.js';

/** The Business Context versions one Dataset Release pinned when it was integrated. */
export interface ContextPins {
  common_business_context_version: number;
  workspace_business_context_version: number;
}

/**
 * The entries the pinned Business Context versions approved, in key order.
 * A version that no longer resolves contributes nothing rather than falling
 * back to a newer one: a governed result is interpreted by exactly what it
 * pinned, never by an ambient latest definition.
 */
export function pinnedContextEntries(
  session: PlatformSession,
  workspaceId: string,
  pins: ContextPins,
): ContextEntry[] {
  const common = findContextArtifact(session.state, DEPLOYMENT_CONTEXT_ARTIFACT)
    ?.versions.find((version) => version.version === pins.common_business_context_version)
    ?.entries ?? [];
  const workspace = findContextArtifact(session.state, workspaceContextArtifact(workspaceId))
    ?.versions.find((version) => version.version === pins.workspace_business_context_version)
    ?.entries ?? [];
  return [...common, ...workspace];
}

/** One entry of a pinned Business Context version, by its exact key. */
export function pinnedEntry(
  session: PlatformSession,
  workspaceId: string,
  pins: ContextPins,
  key: string,
): ContextEntry | undefined {
  return pinnedContextEntries(session, workspaceId, pins).find((entry) => entry.key === key);
}

/** The Metric Definitions the pinned Business Context approved, by key. */
export function pinnedMetricDefinitions(
  session: PlatformSession,
  workspaceId: string,
  pins: ContextPins,
): Map<string, ContextEntry> {
  return new Map(
    pinnedContextEntries(session, workspaceId, pins)
      .filter((entry) => entry.kind === 'metric')
      .map((entry) => [entry.key, entry]),
  );
}

/**
 * Proves every binding a Contract states resolves to the approved Business
 * Context the Dataset Release pinned, and that the definition really governs the
 * formula, unit, value type, and business time zone the Contract declares. A
 * Contract that binds nothing keeps the behaviour it always had.
 */
export function requireGovernedContract(
  session: PlatformSession,
  actor: string,
  context: ActionContext,
  contract: DataProductContract,
  workspaceId: string,
  pins: ContextPins,
): void {
  const definitions = pinnedMetricDefinitions(session, workspaceId, pins);
  for (const metric of contract.metrics) {
    if (metric.definition === undefined) continue;
    const definition = definitions.get(metric.definition);
    if (definition === undefined) {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_METRIC_DEFINITION_UNRESOLVED',
        `The ${metric.name} metric binds the ${metric.definition} Metric Definition, which this Release's Business Context does not approve.`,
        'Bind a Metric Definition the pinned Business Context version publishes, or publish the definition first.',
      );
    }
    const differences: string[] = [];
    if ((definition.unit ?? null) !== (metric.unit ?? null)) differences.push('unit');
    if (definition.aggregation !== undefined && definition.aggregation !== metric.aggregation) differences.push('aggregation');
    if (definition.value_type !== undefined && definition.value_type !== metric.value_type) differences.push('value type');
    if (differences.length > 0) {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_METRIC_DEFINITION_MISMATCH',
        `The ${metric.name} metric disagrees with the ${metric.definition} Metric Definition on ${differences.join(', ')}.`,
        'Declare the formula, unit, and value type exactly as the approved Metric Definition states them.',
      );
    }
  }

  const time = contract.time;
  if (time?.definition !== undefined) {
    const definition = pinnedContextEntries(session, workspaceId, pins)
      .find((entry) => entry.key === time.definition);
    if (definition === undefined || definition.kind !== 'definition') {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_TIME_ZONE_UNRESOLVED',
        `The Contract binds the ${time.definition} definition for its business time zone, and the pinned Business Context does not publish it.`,
        'Bind a definition entry the pinned Business Context version publishes, or state the time zone directly.',
      );
    }
    if (definition.value !== time.time_zone) {
      reject(
        session,
        actor,
        context,
        'DATA_PRODUCT_TIME_ZONE_MISMATCH',
        `The Contract states the ${time.time_zone} time zone while the ${time.definition} definition approves ${definition.value}.`,
        'State exactly the business time zone the approved definition carries.',
      );
    }
  }
}
