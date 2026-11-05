import type { DataProductPeriod, DataProductTime } from './catalog.js';
import type { Fail } from './errors.js';
import type { Window } from './product-query-document.js';

/**
 * The generic natural-period vocabulary a compared window may declare. A period
 * says what the window is a slice of, so a same-elapsed-interval comparison and
 * an equivalent complete-period comparison can both be labelled exactly.
 */

/** One civil date, as a business time zone sees it. */
interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface CivilInstant extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;

function civilDateOf(value: string): CivilDate {
  const match = DATE_PARTS.exec(value)!;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function dateText(date: CivilDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const parts = civilDateOf(date);
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return dateText({ year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() });
}

/** The Monday that opens the Monday-based business week a date belongs to. */
function mondayOf(date: string): string {
  const parts = civilDateOf(date);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function daysBetween(start: string, end: string): number {
  const left = civilDateOf(start);
  const right = civilDateOf(end);
  return Math.round(
    (Date.UTC(right.year, right.month - 1, right.day) - Date.UTC(left.year, left.month - 1, left.day)) / DAY_MS,
  );
}

/** The civil instant one instant holds in a business time zone. */
function zonedParts(instant: number, zone: string): CivilInstant {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = new Map(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
    second: Number(parts.get('second')),
  };
}

/** The date a business time zone sees one instant on. */
function zonedDate(instant: number, zone: string): string {
  return dateText(zonedParts(instant, zone));
}

/** The exact instant a civil time in a business time zone names. */
function instantInZone(
  zone: string,
  date: CivilDate,
  hour: number,
  minute: number,
  second: number,
  milli: number,
): number {
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second, milli);
  let instant = target;
  // Two passes settle the offset even across a daylight-saving transition; the
  // approved business zones are then read back exactly as written.
  for (let pass = 0; pass < 2; pass += 1) {
    const observed = zonedParts(instant, zone);
    const seen = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second, milli);
    instant += target - seen;
  }
  return instant;
}

/** The instant the period opens, and the inclusive instant it closes. */
function periodBounds(time: DataProductTime, window: Window): { start: number; end: number } | null {
  if (time.precision === 'date') return null;
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (window.period === 'day') {
    const date = civilDateOf(zonedDate(start, time.time_zone));
    return {
      start: instantInZone(time.time_zone, date, 0, 0, 0, 0),
      end: instantInZone(time.time_zone, date, 23, 59, 59, 999),
    };
  }
  const monday = civilDateOf(mondayOf(zonedDate(start, time.time_zone)));
  const sunday = civilDateOf(addDays(dateText(monday), 6));
  return {
    start: instantInZone(time.time_zone, monday, 0, 0, 0, 0),
    end: instantInZone(time.time_zone, sunday, 23, 59, 59, 999),
  };
}

/**
 * Refuses a period declaration the window cannot honestly name: a day window
 * that crosses a business-zone date, or a week window that crosses a
 * Monday-based business week. A partial interval inside one period is allowed,
 * because it is exactly what an elapsed-interval comparison reads.
 */
export function validatePeriodWindow(
  fail: Fail,
  period: DataProductPeriod,
  time: DataProductTime,
  start: string,
  end: string,
): void {
  if (time.precision === 'date') {
    if (period === 'day' && start !== end) {
      fail('DATA_PRODUCT_QUERY_REFUSED', 'A day window at date precision covers exactly one business date.');
    }
    if (period === 'week' && mondayOf(start) !== mondayOf(end)) {
      fail('DATA_PRODUCT_QUERY_REFUSED', 'A week window must start and end inside the same Monday-based business week.');
    }
    return;
  }
  const startDate = zonedDate(Date.parse(start), time.time_zone);
  const endDate = zonedDate(Date.parse(end), time.time_zone);
  if (period === 'day' && startDate !== endDate) {
    fail('DATA_PRODUCT_QUERY_REFUSED', 'A day window must start and end on the same business-zone date.');
  }
  if (period === 'week' && mondayOf(startDate) !== mondayOf(endDate)) {
    fail('DATA_PRODUCT_QUERY_REFUSED', 'A week window must start and end inside the same Monday-based business week.');
  }
}

/** Whether the window covers its whole natural period, not merely a slice of it. */
export function periodComplete(time: DataProductTime, window: Window): boolean {
  if (window.period === undefined) return true;
  if (time.precision === 'date') {
    if (window.period === 'day') return window.start === window.end;
    return mondayOf(window.start) === window.start && daysBetween(window.start, window.end) === 6;
  }
  const bounds = periodBounds(time, window);
  if (bounds === null) return true;
  return Date.parse(window.start) === bounds.start && Date.parse(window.end) >= bounds.end;
}

/** How far into its period a window starts, and how long it runs. */
function elapsedOf(
  time: DataProductTime,
  window: Window,
): { offset: number; duration: number } | null {
  if (window.period === undefined) return null;
  if (time.precision === 'date') {
    if (window.period === 'day') return { offset: 0, duration: daysBetween(window.start, window.end) };
    return {
      offset: daysBetween(mondayOf(window.start), window.start),
      duration: daysBetween(window.start, window.end),
    };
  }
  const bounds = periodBounds(time, window);
  if (bounds === null) return null;
  const start = Date.parse(window.start);
  return { offset: start - bounds.start, duration: Date.parse(window.end) - start };
}

/**
 * Whether two declared windows are the same elapsed interval of their period:
 * the same offset from the period opens and the same duration. A daily partial
 * comparison and an equivalent complete-week comparison both answer true; a
 * day that is not the same elapsed interval another day is reading does not.
 */
export function sameElapsedInterval(
  time: DataProductTime,
  base: Window,
  comparison: Window,
): boolean | undefined {
  if (base.period === undefined || comparison.period === undefined) return undefined;
  if (base.period !== comparison.period) return undefined;
  const left = elapsedOf(time, base);
  const right = elapsedOf(time, comparison);
  if (left === null || right === null) return undefined;
  return left.offset === right.offset && left.duration === right.duration;
}
