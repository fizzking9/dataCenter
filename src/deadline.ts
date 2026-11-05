/**
 * Hard wall-clock deadlines for the two LLM-backed Consumer operations.
 *
 * Spec section 15 states a 60-second hard timeout for Natural-Language Query
 * and a 90-second hard timeout for Report generation. The deadline is enforced
 * at the operation boundary: once it expires the caller stops waiting and
 * answers with an explicit timeout, whatever the endpoint is still doing.
 *
 * The timer is a seam so certification can drive a whole timeout deterministically
 * without waiting a real minute, while production always uses the real clock.
 * A test override may only shorten the settled ceiling, never lengthen it.
 */

export const NLQ_TIMEOUT_MS = 60_000;
export const REPORT_TIMEOUT_MS = 90_000;

export class DeadlineExceeded extends Error {
  readonly milliseconds: number;

  constructor(milliseconds: number) {
    super(`The operation exceeded its ${String(milliseconds)}ms deadline.`);
    this.milliseconds = milliseconds;
    this.name = 'DeadlineExceeded';
  }
}

export interface DeadlineTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimer: DeadlineTimer = {
  set(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    // A pending deadline never keeps the process alive on its own.
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * The budget one operation gets. An environment override exists only so tests
 * can shorten the settled ceiling; a longer value is clamped to the ceiling and
 * an unusable value falls back to it.
 */
export function timeoutBudgetFromEnv(name: string, ceiling: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return ceiling;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return ceiling;
  return Math.min(parsed, ceiling);
}

/**
 * The budget one operation actually runs under, handed to the work so it can
 * stop before committing anything once its deadline has passed.
 */
export interface Deadline {
  readonly milliseconds: number;
  readonly expired: boolean;
  /** Throws DeadlineExceeded once the deadline has passed; never before. */
  ensure(): void;
}

/** Resolves with the work, or rejects with DeadlineExceeded at the deadline. */
export async function withDeadline<T>(
  work: (deadline: Deadline) => Promise<T>,
  milliseconds: number,
  timer: DeadlineTimer = systemTimer,
): Promise<T> {
  let handle: unknown;
  let expired = false;
  const deadline: Deadline = {
    milliseconds,
    get expired() {
      return expired;
    },
    ensure() {
      if (expired) throw new DeadlineExceeded(milliseconds);
    },
  };
  const expiry = new Promise<never>((_, reject) => {
    handle = timer.set(() => {
      expired = true;
      reject(new DeadlineExceeded(milliseconds));
    }, milliseconds);
  });
  try {
    return await Promise.race([work(deadline), expiry]);
  } finally {
    timer.clear(handle);
  }
}
