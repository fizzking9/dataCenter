/**
 * The manually validated expected results for the BMS business Data Products.
 *
 * Every figure below was totalled by hand from the frozen exports in
 * `exports.ts` and is recorded with its arithmetic, so it is an independent
 * source of truth: a run that agrees with these numbers agrees with the
 * business, and a run that does not cannot make itself right by computing the
 * same way the platform does.
 *
 * 经营总览 — 处理量 per day (已受理 + 已完工):
 *   10-26 .. 11-01 = (5+1=6), (2+4=6), (4+2=6), (3+5=8), (7+3=10), (2+1=3),
 *   and 11-01 = 5+4+4+2 = 15. Receptions are two per day, except 11-01, which
 *   carries two further morning 工单: week two has 16 笔 and 54 次.
 *   Week one: 7 已受理 (27 次) + 7 已完工 (20 次) = 14 笔 / 47 次.
 *   The current partial day 11-02 00:00–12:26 = 2 笔 / 5 次; the previous day
 *   at the same elapsed interval = 3 笔 / 11 次.
 *
 * 四路退款 — 金额 and 笔数 for week two, by route:
 *   A 60+130.4+95+70+55.5+110+65 = 585.90
 *   B 20+35+25.5+40+30+15+25   = 190.50
 *   C 0+0+0+0+0+8+0            =   8.00
 *   D 25+10+15+20+30+15+10     = 125.00
 *   total 909.40 across 28 笔; week one is 1451.75 across 28 笔, so the amount
 *   falls 542.35 (-37.36%). The current elapsed day is 57.50 across 4 笔; the
 *   previous day at the same elapsed interval is 90.00 across 2 笔.
 *
 * 三源投诉 — week two registrations / handling:
 *   内部 23/20, 商户号 5/4, 外部 3/2 = 31/26; week one is 41/33.
 *   The current partial day is 3/2 with 17 件 结存积压; the previous day at the
 *   same elapsed interval is 5/4 with 16 件.
 */

/** The comparison outcome of one bound metric, labelled from the approved direction. */
export interface ExpectedComparison {
  value: number | string;
  change: number | string;
  change_percent: string | null;
  direction: 'up' | 'down' | 'flat';
  judgment: 'favorable' | 'adverse' | 'neutral';
}

export interface OperatingGroup {
  service_status: string;
  reception_count: number;
  handled_total: number;
}

export interface RefundGroup {
  refund_route: string;
  refund_count: number;
  refund_amount_total: string;
}

export interface ComplaintGroup {
  complaint_source: string;
  complaint_registered: number;
  complaint_handled: number;
  complaint_backlog?: number;
}

export const BMS_OPERATING_EXPECTED = {
  week_previous: {
    groups: [
      { service_status: '已受理', reception_count: 7, handled_total: 27 },
      { service_status: '已完工', reception_count: 7, handled_total: 20 },
    ] satisfies OperatingGroup[],
    totals: { reception_count: 14, handled_total: 47 },
  },
  week_current: {
    groups: [
      { service_status: '已受理', reception_count: 8, handled_total: 32 },
      { service_status: '已完工', reception_count: 8, handled_total: 22 },
    ] satisfies OperatingGroup[],
    totals: { reception_count: 16, handled_total: 54 },
  },
  /** 接待量与处理量 per business day across the current complete week. */
  trend_current: [
    { day: '2026-10-26', reception_count: 2, handled_total: 6 },
    { day: '2026-10-27', reception_count: 2, handled_total: 6 },
    { day: '2026-10-28', reception_count: 2, handled_total: 6 },
    { day: '2026-10-29', reception_count: 2, handled_total: 8 },
    { day: '2026-10-30', reception_count: 2, handled_total: 10 },
    { day: '2026-10-31', reception_count: 2, handled_total: 3 },
    { day: '2026-11-01', reception_count: 4, handled_total: 15 },
  ],
  /** 11-02 00:00–12:26, compared with 11-01 00:00–12:26. */
  daily: {
    totals: { reception_count: 2, handled_total: 5 },
    comparison: {
      reception_count: { value: 3, change: -1, change_percent: '-33.33', direction: 'down', judgment: 'adverse' },
      handled_total: { value: 11, change: -6, change_percent: '-54.55', direction: 'down', judgment: 'adverse' },
    } satisfies Record<string, ExpectedComparison>,
  },
  /** The current complete week, compared with the previous complete week. */
  weekly: {
    comparison: {
      reception_count: { value: 14, change: 2, change_percent: '14.29', direction: 'up', judgment: 'favorable' },
      handled_total: { value: 47, change: 7, change_percent: '14.89', direction: 'up', judgment: 'favorable' },
    } satisfies Record<string, ExpectedComparison>,
  },
};

export const BMS_REFUND_EXPECTED = {
  week_previous: {
    groups: [
      { refund_route: 'A 线上直退', refund_count: 7, refund_amount_total: '926.25' },
      { refund_route: 'B 线下', refund_count: 7, refund_amount_total: '350.50' },
      { refund_route: 'C 闪猫退款', refund_count: 7, refund_amount_total: '15.00' },
      { refund_route: 'D 手动退款', refund_count: 7, refund_amount_total: '160.00' },
    ] satisfies RefundGroup[],
    totals: { refund_count: 28, refund_amount_total: '1451.75' },
  },
  week_current: {
    groups: [
      { refund_route: 'A 线上直退', refund_count: 7, refund_amount_total: '585.90' },
      { refund_route: 'B 线下', refund_count: 7, refund_amount_total: '190.50' },
      { refund_route: 'C 闪猫退款', refund_count: 7, refund_amount_total: '8.00' },
      { refund_route: 'D 手动退款', refund_count: 7, refund_amount_total: '125.00' },
    ] satisfies RefundGroup[],
    totals: { refund_count: 28, refund_amount_total: '909.40' },
  },
  /** 退款金额 per business day across the current complete week. */
  trend_current: [
    { day: '2026-10-26', refund_amount_total: '105.00' },
    { day: '2026-10-27', refund_amount_total: '175.40' },
    { day: '2026-10-28', refund_amount_total: '135.50' },
    { day: '2026-10-29', refund_amount_total: '130.00' },
    { day: '2026-10-30', refund_amount_total: '115.50' },
    { day: '2026-10-31', refund_amount_total: '148.00' },
    { day: '2026-11-01', refund_amount_total: '100.00' },
  ],
  /** 11-02 00:00–12:26, compared with 11-01 00:00–12:26. */
  daily: {
    totals: { refund_count: 4, refund_amount_total: '57.50' },
    comparison: {
      refund_count: { value: 2, change: 2, change_percent: '100.00', direction: 'up', judgment: 'adverse' },
      refund_amount_total: {
        value: '90.00',
        change: '-32.50',
        change_percent: '-36.11',
        direction: 'down',
        judgment: 'favorable',
      },
    } satisfies Record<string, ExpectedComparison>,
  },
  /** The current complete week, compared with the previous complete week, per route. */
  route_comparison: {
    'A 线上直退': {
      refund_count: { value: 7, change: 0, change_percent: '0.00', direction: 'flat', judgment: 'neutral' },
      refund_amount_total: {
        value: '926.25',
        change: '-340.35',
        change_percent: '-36.74',
        direction: 'down',
        judgment: 'favorable',
      },
    },
    'B 线下': {
      refund_count: { value: 7, change: 0, change_percent: '0.00', direction: 'flat', judgment: 'neutral' },
      refund_amount_total: {
        value: '350.50',
        change: '-160.00',
        change_percent: '-45.65',
        direction: 'down',
        judgment: 'favorable',
      },
    },
    'C 闪猫退款': {
      refund_count: { value: 7, change: 0, change_percent: '0.00', direction: 'flat', judgment: 'neutral' },
      refund_amount_total: {
        value: '15.00',
        change: '-7.00',
        change_percent: '-46.67',
        direction: 'down',
        judgment: 'favorable',
      },
    },
    'D 手动退款': {
      refund_count: { value: 7, change: 0, change_percent: '0.00', direction: 'flat', judgment: 'neutral' },
      refund_amount_total: {
        value: '160.00',
        change: '-35.00',
        change_percent: '-21.88',
        direction: 'down',
        judgment: 'favorable',
      },
    },
  } satisfies Record<string, Record<string, ExpectedComparison>>,
  /** The current complete week, compared with the previous complete week. */
  weekly: {
    comparison: {
      refund_count: { value: 28, change: 0, change_percent: '0.00', direction: 'flat', judgment: 'neutral' },
      refund_amount_total: {
        value: '1451.75',
        change: '-542.35',
        change_percent: '-37.36',
        direction: 'down',
        judgment: 'favorable',
      },
    } satisfies Record<string, ExpectedComparison>,
  },
};

export const BMS_COMPLAINT_EXPECTED = {
  week_previous: {
    groups: [
      { complaint_source: '内部', complaint_registered: 33, complaint_handled: 28 },
      { complaint_source: '商户号', complaint_registered: 6, complaint_handled: 4 },
      { complaint_source: '外部', complaint_registered: 2, complaint_handled: 1 },
    ] satisfies ComplaintGroup[],
    totals: { complaint_registered: 41, complaint_handled: 33 },
  },
  week_current: {
    groups: [
      { complaint_source: '内部', complaint_registered: 23, complaint_handled: 20 },
      { complaint_source: '商户号', complaint_registered: 5, complaint_handled: 4 },
      { complaint_source: '外部', complaint_registered: 3, complaint_handled: 2 },
    ] satisfies ComplaintGroup[],
    totals: { complaint_registered: 31, complaint_handled: 26 },
  },
  /** 投诉登记件数 per business day across the current complete week. */
  trend_current: [
    { day: '2026-10-26', complaint_registered: 4, complaint_handled: 4 },
    { day: '2026-10-27', complaint_registered: 5, complaint_handled: 4 },
    { day: '2026-10-28', complaint_registered: 2, complaint_handled: 2 },
    { day: '2026-10-29', complaint_registered: 8, complaint_handled: 5 },
    { day: '2026-10-30', complaint_registered: 4, complaint_handled: 4 },
    { day: '2026-10-31', complaint_registered: 3, complaint_handled: 3 },
    { day: '2026-11-01', complaint_registered: 5, complaint_handled: 4 },
  ],
  /** 11-02 00:00–12:26, compared with 11-01 00:00–12:26. */
  daily: {
    groups: [
      { complaint_source: '内部', complaint_registered: 2, complaint_handled: 2, complaint_backlog: 10 },
      { complaint_source: '商户号', complaint_registered: 1, complaint_handled: 0, complaint_backlog: 5 },
      { complaint_source: '外部', complaint_registered: 0, complaint_handled: 0, complaint_backlog: 2 },
    ] satisfies ComplaintGroup[],
    totals: { complaint_registered: 3, complaint_handled: 2, complaint_backlog: 17 },
    comparison: {
      complaint_registered: {
        value: 5,
        change: -2,
        change_percent: '-40.00',
        direction: 'down',
        judgment: 'favorable',
      },
      complaint_handled: {
        value: 4,
        change: -2,
        change_percent: '-50.00',
        direction: 'down',
        judgment: 'adverse',
      },
      complaint_backlog: {
        value: 16,
        change: 1,
        change_percent: '6.25',
        direction: 'up',
        judgment: 'adverse',
      },
    } satisfies Record<string, ExpectedComparison>,
  },
  /** The current complete week, compared with the previous complete week. */
  weekly: {
    comparison: {
      complaint_registered: {
        value: 41,
        change: -10,
        change_percent: '-24.39',
        direction: 'down',
        judgment: 'favorable',
      },
      complaint_handled: {
        value: 33,
        change: -7,
        change_percent: '-21.21',
        direction: 'down',
        judgment: 'adverse',
      },
    } satisfies Record<string, ExpectedComparison>,
  },
};
