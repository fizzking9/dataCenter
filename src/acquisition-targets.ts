import { resolveActor } from './auth.js';
import { actorLabel, type ActionContext } from './authz.js';
import type {
  AcquisitionConnectionVersion,
  AcquisitionRunRecord,
} from './catalog.js';
import { openPlatform } from './session.js';
import { requireAdministeredSource } from './sources.js';
import type { PlatformState } from './platform.js';

/**
 * How many decimal places a measured latency keeps. A latency is reported in
 * seconds, so a sub-second start reads as a fraction rather than as zero.
 */
const LATENCY_DECIMALS = 3;

/** Reads one elapsed interval as seconds, or null when either instant is absent. */
function secondsBetween(from: string, to: string | null): number | null {
  if (to === null) return null;
  const elapsed = (Date.parse(to) - Date.parse(from)) / 1_000;
  if (!Number.isFinite(elapsed)) return null;
  return Number(elapsed.toFixed(LATENCY_DECIMALS));
}

/**
 * The value at one percentile of an ascending sample, by the nearest-rank
 * method: the smallest sample at or above the requested proportion. A single
 * sample is both its own p95 and its own p99, so a short history is reported
 * honestly rather than rounded into a promise nobody measured.
 */
export function percentile(samples: number[], proportion: number): number | null {
  if (samples.length === 0) return null;
  const ascending = [...samples].sort((left, right) => left - right);
  const rank = Math.min(ascending.length, Math.max(1, Math.ceil(proportion * ascending.length)));
  return ascending[rank - 1] ?? null;
}

/** The Connection Version a Source's adopted acquisition configuration pins. */
function pinnedConnectionVersion(
  state: PlatformState,
  sourceId: string,
): AcquisitionConnectionVersion | undefined {
  const artifact = state.source_acquisitions.find((candidate) => candidate.source_id === sourceId);
  const version = artifact?.versions.find((candidate) => candidate.version === artifact.adopted_version);
  if (artifact === undefined || version === undefined) return undefined;
  return state.acquisition_connections
    .find((candidate) => candidate.connection_id === version.connection_id)
    ?.versions.find((candidate) => candidate.version === version.connection_version);
}

/** One scheduled Run and the two latencies its ledger already states. */
function measureRun(run: AcquisitionRunRecord): Record<string, unknown> {
  // A Run recorded before the schedule stated its due instant holds none, so it
  // measures nothing rather than being credited with a latency it never had.
  const due = run.scheduled_for ?? null;
  const startLatency = due === null ? null : secondsBetween(due, run.started_at);
  const publicationLatency = due === null || run.status !== 'complete'
    ? null
    : secondsBetween(due, run.completed_at);
  return {
    acquisition_run_id: run.acquisition_run_id,
    status: run.status,
    scheduled_for: due,
    started_at: run.started_at,
    completed_at: run.completed_at,
    start_latency_seconds: startLatency,
    publication_latency_seconds: publicationLatency,
  };
}

/**
 * Measures one Source's schedule against the promise its Connection declared.
 *
 * Only Runs the schedule created are evidence, because a manual Run says
 * nothing about a cadence. Start tolerance and publication targets are separate
 * promises measured from the same due instant: a Run may start late and still
 * publish inside its target, and a Run that failed has nothing to publish at
 * all, which is a miss rather than an absent sample.
 */
export function acquisitionTargets(options: {
  root: string;
  masterKey: string;
  token: string;
  sourceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey, 'allow');
  const context: ActionContext = { action: 'acquisition_targets_read', scope: 'workspace' };
  const actor = resolveActor(session, options.token, context);
  const source = requireAdministeredSource(session, actor, context, options.sourceId);
  const scoped: ActionContext = { ...context, workspace_id: source.workspace_id, target: source.source_id };
  const connectionVersion = pinnedConnectionVersion(session.state, source.source_id);
  const schedule = connectionVersion?.schedule ?? null;
  const publicationTargets = connectionVersion?.publication_targets ?? null;

  const scheduled = session.state.acquisition_runs
    .filter((run) => run.source_id === source.source_id && typeof run.scheduled_for === 'string')
    .map(measureRun);

  const startLatencies = scheduled
    .map((run) => run['start_latency_seconds'])
    .filter((value): value is number => typeof value === 'number');
  const tolerance = schedule?.start_tolerance_seconds ?? 0;
  const late = startLatencies.filter((latency) => latency > tolerance).length;
  const start = schedule === null
    ? null
    : {
      samples: startLatencies.length,
      within_tolerance: startLatencies.length - late,
      late,
      tolerance_seconds: tolerance,
      maximum_latency_seconds: percentile(startLatencies, 1),
      met: startLatencies.length > 0 && late === 0,
    };

  const publicationLatencies = scheduled
    .map((run) => run['publication_latency_seconds'])
    .filter((value): value is number => typeof value === 'number');
  const failures = scheduled.filter((run) => run['status'] !== 'complete').length;
  const p95 = percentile(publicationLatencies, 0.95);
  const p99 = percentile(publicationLatencies, 0.99);
  const publication = publicationTargets === null
    ? null
    : {
      samples: publicationLatencies.length,
      failed: failures,
      p95_seconds: p95,
      p99_seconds: p99,
      p95_target_seconds: publicationTargets.p95_seconds,
      p99_target_seconds: publicationTargets.p99_seconds,
      met: p95 !== null
        && p99 !== null
        && failures === 0
        && p95 <= publicationTargets.p95_seconds
        && p99 <= publicationTargets.p99_seconds,
    };

  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      scheduled_runs: scheduled.length,
      late_starts: late,
      publication_samples: publicationLatencies.length,
    },
  });
  return {
    source_id: source.source_id,
    schedule: schedule === null ? null : { ...schedule },
    publication_targets: publicationTargets === null ? null : { ...publicationTargets },
    runs: scheduled,
    start,
    publication,
  };
}
