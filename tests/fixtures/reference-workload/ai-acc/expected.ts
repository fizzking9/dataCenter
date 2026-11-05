/**
 * The manually validated expected results for the ai-acc reference workload.
 *
 * Every figure below was totalled by hand from the frozen snapshots in
 * `windows.ts` and is recorded with its arithmetic, so it is an independent
 * source of truth: a run that agrees with these numbers agrees with the
 * business, and a run that does not cannot make itself right by computing the
 * same way the platform does.
 *
 * Derivation, window by window (处理量 of each 工单号):
 *   window 1  0001..0006 = 12+5+3+7+9+4            = 40
 *   window 2  0007..0011 = 2+15+6+1+11             = 35
 *   window 3  0012..0014 = 8+6+2                   = 16
 *   all       40+35+16                             = 91 across 14 工单
 */

export interface ExpectedGroup {
  /** The dimension values this group holds, by Contract dimension name. */
  group: Record<string, string>;
  record_count: number;
  handled_total: number;
}

export const AI_ACC_EXPECTED = {
  /** 处理量 per seven-day window, in window order. */
  window_handled: [40, 35, 16],

  /** 处理量 per 时段: 00-08 = 3+4+2+8, 08-16 = 12+7+15+1+2, 16-24 = 5+9+6+11+6. */
  by_time_band: [
    { group: { time_band: '00-08' }, record_count: 4, handled_total: 17 },
    { group: { time_band: '08-16' }, record_count: 5, handled_total: 37 },
    { group: { time_band: '16-24' }, record_count: 5, handled_total: 37 },
  ] satisfies ExpectedGroup[],

  /** 处理量 per 接管状态: 已接管 = 12+9+4+15+11+8+2, 未接管 = 5+3+7+2+6+1+6. */
  by_takeover: [
    { group: { takeover_state: '已接管' }, record_count: 7, handled_total: 61 },
    { group: { takeover_state: '未接管' }, record_count: 7, handled_total: 30 },
  ] satisfies ExpectedGroup[],

  /**
   * 处理量 per 时段 and 接管状态:
   *   00-08 已接管 = 0006+0012 = 4+8;   00-08 未接管 = 0003+0007 = 3+2
   *   08-16 已接管 = 0001+0008+0014;    08-16 未接管 = 0004+0010 = 7+1
   *   16-24 已接管 = 0005+0011 = 9+11;  16-24 未接管 = 0002+0009+0013
   */
  by_time_band_and_takeover: [
    { group: { time_band: '00-08', takeover_state: '已接管' }, record_count: 2, handled_total: 12 },
    { group: { time_band: '00-08', takeover_state: '未接管' }, record_count: 2, handled_total: 5 },
    { group: { time_band: '08-16', takeover_state: '已接管' }, record_count: 3, handled_total: 29 },
    { group: { time_band: '08-16', takeover_state: '未接管' }, record_count: 2, handled_total: 8 },
    { group: { time_band: '16-24', takeover_state: '已接管' }, record_count: 2, handled_total: 20 },
    { group: { time_band: '16-24', takeover_state: '未接管' }, record_count: 3, handled_total: 17 },
  ] satisfies ExpectedGroup[],

  /** 全部 14 条工单的合计. */
  totals: { record_count: 14, handled_total: 91 },
};
