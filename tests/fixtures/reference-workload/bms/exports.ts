/**
 * Frozen adjacent-period snapshots of the three BMS operational exports.
 *
 * The source system is read through hourly overlapping sweeps, so every export
 * below is the exact body one sweep returned. The first export carries the two
 * representative complete weeks plus one earlier row that proves the Releases
 * cover the period before the first compared week; the second export is the
 * overlapping sweep that re-reads the same snapshot, corrects one row, and adds
 * the current partial day; the third is the same export repeated, so repetition
 * reconciles to the same governed identities.
 *
 * The rows are the real export's shape: the source's own column names and its
 * own Chinese labels, never a canonical field name. Every figure is frozen, so
 * a fixture that quietly changed would fail the oracle instead of agreeing with
 * itself.
 */

/** One row of a frozen export fragment, keyed by source column. */
export type BusinessRow = Record<string, string | number>;

const ZONE = '+08:00';

/** The business instant of a row, in the approved business time zone. */
function at(day: string, time: string): string {
  return `${day}T${time}:00${ZONE}`;
}

/** The two representative complete weeks and the current partial day. */
export const BMS_WEEK_PREVIOUS = { start: '2026-10-19', end: '2026-10-25' } as const;
export const BMS_WEEK_CURRENT = { start: '2026-10-26', end: '2026-11-01' } as const;
export const BMS_TODAY = { start: '2026-11-02', elapsed_through: '12:26' } as const;
export const BMS_TODAY_ELAPSED = { start: '2026-11-02T00:00:00+08:00', end: '2026-11-02T12:26:00+08:00' } as const;
export const BMS_YESTERDAY_ELAPSED = { start: '2026-11-01T00:00:00+08:00', end: '2026-11-01T12:26:00+08:00' } as const;
export const BMS_WEEK_PREVIOUS_WINDOW = {
  start: '2026-10-19T00:00:00.000+08:00',
  end: '2026-10-25T23:59:59.999+08:00',
} as const;
export const BMS_WEEK_CURRENT_WINDOW = {
  start: '2026-10-26T00:00:00.000+08:00',
  end: '2026-11-01T23:59:59.999+08:00',
} as const;

/** The fourteen business days of the two complete weeks, in order. */
const DAYS = [
  '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
  '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
] as const;

/** 已受理 工单的处理量 per business day: week one then week two. */
const RECEPTION_ACTIVE = [4, 3, 5, 2, 6, 3, 4, 5, 2, 4, 3, 7, 2, 5] as const;
/** 已完工 工单的处理量 per business day: week one then week two. */
const RECEPTION_DONE = [2, 3, 1, 4, 2, 5, 3, 1, 4, 2, 5, 3, 1, 4] as const;

const HISTORY_UPDATED_AT = '2026-10-31T23:30:00.000Z';
const OVERLAP_UPDATED_AT = '2026-11-01T00:30:00.000Z';
const EDITED_UPDATED_AT = '2026-11-01T00:40:00.000Z';

function serviceOrder(
  orderNo: string,
  registeredOn: string,
  registeredAt: string,
  status: string,
  handledCount: number,
  updatedAt = HISTORY_UPDATED_AT,
): BusinessRow {
  return {
    order_no: orderNo,
    updated_at: updatedAt,
    registered_at: at(registeredOn, registeredAt),
    registered_on: registeredOn,
    status_text: status,
    handled_count: handledCount,
  };
}

function refund(
  refundNo: string,
  refundedOn: string,
  refundedAt: string,
  route: string,
  amount: number,
  updatedAt = HISTORY_UPDATED_AT,
): BusinessRow {
  return {
    refund_no: refundNo,
    updated_at: updatedAt,
    refunded_at: at(refundedOn, refundedAt),
    refunded_on: refundedOn,
    refund_status: '已退款',
    refund_route: route,
    refund_amount: amount,
  };
}

function complaint(
  source: string,
  snapshotOn: string,
  registered: number,
  handled: number,
  pending: number,
  updatedAt = HISTORY_UPDATED_AT,
): BusinessRow {
  return {
    report_no: `CR-${snapshotOn}-${source}`,
    updated_at: updatedAt,
    snapshot_at: at(snapshotOn, '12:26'),
    snapshot_on: snapshotOn,
    source_name: source,
    registered_count: registered,
    handled_count: handled,
    pending_count: pending,
  };
}

/** The four refund routes, in the order the business report prints them. */
export const REFUND_ROUTES = ['A 线上直退', 'B 线下', 'C 闪猫退款', 'D 手动退款'] as const;

/** 退款金额 per route per business day: week one then week two. */
export const REFUND_AMOUNTS: Record<(typeof REFUND_ROUTES)[number], readonly number[]> = {
  'A 线上直退': [100, 120.5, 80, 210.25, 150, 90, 175.5, 60, 130.4, 95, 70, 55.5, 110, 65],
  'B 线下': [50, 60, 40, 30.5, 70, 55, 45, 20, 35, 25.5, 40, 30, 15, 25],
  'C 闪猫退款': [0, 0, 10, 0, 5, 0, 0, 0, 0, 0, 0, 0, 8, 0],
  'D 手动退款': [20, 25, 15, 30, 10, 35, 25, 25, 10, 15, 20, 30, 15, 10],
};

/** 投诉登记件数 per source per business day: week one then week two. */
export const COMPLAINT_REGISTERED = {
  内部: [6, 5, 4, 6, 3, 5, 4, 3, 4, 2, 5, 3, 2, 4],
  商户号: [1, 0, 2, 1, 0, 1, 1, 0, 1, 0, 2, 1, 0, 1],
  外部: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0],
} as const;

/** 投诉处理件数 per source per business day: week one then week two. */
export const COMPLAINT_HANDLED = {
  内部: [5, 4, 4, 5, 3, 4, 3, 3, 3, 2, 4, 3, 2, 3],
  商户号: [1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1],
  外部: [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
} as const;

/** The three complaint sources, in the order the business report prints them. */
export const COMPLAINT_SOURCES = ['内部', '商户号', '外部'] as const;

/** The 结存积压 carried into the first compared day, per source. */
const COMPLAINT_OPENING_BACKLOG: Record<(typeof COMPLAINT_SOURCES)[number], number> = {
  内部: 2,
  商户号: 1,
  外部: 0,
};

/** The daily 结存积压 each source's registrations and handling leave behind. */
function pendingCounts(source: (typeof COMPLAINT_SOURCES)[number]): number[] {
  let pending = COMPLAINT_OPENING_BACKLOG[source];
  return COMPLAINT_REGISTERED[source].map((registered, index) => {
    pending = pending + registered - COMPLAINT_HANDLED[source][index]!;
    return pending;
  });
}

function serviceOrdersHistory(): BusinessRow[] {
  const rows: BusinessRow[] = [
    serviceOrder('SO-2026-1000', '2026-10-18', '09:10', '已受理', 2),
  ];
  DAYS.forEach((day, index) => {
    rows.push(serviceOrder(`SO-2026-${1001 + index * 2}`, day, '09:15', '已受理', RECEPTION_ACTIVE[index]!));
    rows.push(serviceOrder(`SO-2026-${1002 + index * 2}`, day, '15:40', '已完工', RECEPTION_DONE[index]!));
  });
  // The last compared day carries two further morning 工单, so the current week
  // is not simply the previous week repeated and the elapsed daily window sees
  // a smaller population than the whole day.
  rows.push(serviceOrder('SO-2026-1029', '2026-11-01', '10:05', '已受理', 4));
  rows.push(serviceOrder('SO-2026-1030', '2026-11-01', '11:10', '已完工', 2));
  return rows;
}

function serviceOrdersOverlap(): BusinessRow[] {
  const history = serviceOrdersHistory();
  const edited = { ...history[0]!, handled_count: 5, updated_at: EDITED_UPDATED_AT };
  return [
    edited,
    ...history.slice(1),
    serviceOrder('SO-2026-1031', '2026-11-02', '09:15', '已受理', 3, OVERLAP_UPDATED_AT),
    serviceOrder('SO-2026-1032', '2026-11-02', '12:26', '已完工', 2, OVERLAP_UPDATED_AT),
  ];
}

function refundsHistory(): BusinessRow[] {
  const rows: BusinessRow[] = [refund('RF-2026-0000', '2026-10-18', '12:00', REFUND_ROUTES[0], 10)];
  const times = ['09:00', '11:30', '14:00', '16:45'];
  DAYS.forEach((day, index) => {
    REFUND_ROUTES.forEach((route, routeIndex) => {
      rows.push(refund(
        `RF-2026-${String(1 + index * 4 + routeIndex).padStart(4, '0')}`,
        day,
        times[routeIndex]!,
        route,
        REFUND_AMOUNTS[route][index]!,
      ));
    });
  });
  return rows;
}

function refundsOverlap(): BusinessRow[] {
  const history = refundsHistory();
  const edited = { ...history[0]!, refund_amount: 40, updated_at: EDITED_UPDATED_AT };
  const times = ['08:00', '09:30', '10:15', '12:00'];
  return [
    edited,
    ...history.slice(1),
    ...REFUND_ROUTES.map((route, index) => refund(
      `RF-2026-${String(57 + index).padStart(4, '0')}`,
      '2026-11-02',
      times[index]!,
      route,
      [40, 12.5, 0, 5][index]!,
      OVERLAP_UPDATED_AT,
    )),
  ];
}

function complaintsHistory(): BusinessRow[] {
  const rows: BusinessRow[] = [
    complaint('内部', '2026-10-18', 1, 1, 2),
    complaint('商户号', '2026-10-18', 0, 0, 1),
    complaint('外部', '2026-10-18', 0, 0, 0),
  ];
  const pending = Object.fromEntries(
    COMPLAINT_SOURCES.map((source) => [source, pendingCounts(source)]),
  ) as Record<(typeof COMPLAINT_SOURCES)[number], number[]>;
  DAYS.forEach((day, index) => {
    for (const source of COMPLAINT_SOURCES) {
      rows.push(complaint(
        source,
        day,
        COMPLAINT_REGISTERED[source][index]!,
        COMPLAINT_HANDLED[source][index]!,
        pending[source][index]!,
      ));
    }
  });
  return rows;
}

function complaintsOverlap(): BusinessRow[] {
  const history = complaintsHistory();
  const edited = { ...history[0]!, registered_count: 2, updated_at: EDITED_UPDATED_AT };
  const pending = Object.fromEntries(
    COMPLAINT_SOURCES.map((source) => [source, pendingCounts(source)]),
  ) as Record<(typeof COMPLAINT_SOURCES)[number], number[]>;
  const today = {
    内部: { registered: 2, handled: 2, pending: pending['内部'].at(-1)! + 2 - 2 },
    商户号: { registered: 1, handled: 0, pending: pending['商户号'].at(-1)! + 1 },
    外部: { registered: 0, handled: 0, pending: pending['外部'].at(-1)! },
  };
  return [
    edited,
    ...history.slice(1),
    ...COMPLAINT_SOURCES.map((source) => complaint(
      source,
      '2026-11-02',
      today[source].registered,
      today[source].handled,
      today[source].pending,
      OVERLAP_UPDATED_AT,
    )),
  ];
}

/** The three exports one Source produced: history, overlap, and a repeat. */
function frozenExports(history: BusinessRow[], overlap: BusinessRow[]): BusinessRow[][] {
  return [history, overlap, overlap];
}

export const SERVICE_ORDER_EXPORTS: BusinessRow[][] = frozenExports(serviceOrdersHistory(), serviceOrdersOverlap());
export const REFUND_EXPORTS: BusinessRow[][] = frozenExports(refundsHistory(), refundsOverlap());
export const COMPLAINT_EXPORTS: BusinessRow[][] = frozenExports(complaintsHistory(), complaintsOverlap());
