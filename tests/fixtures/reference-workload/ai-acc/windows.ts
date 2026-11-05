/**
 * Frozen adjacent-period snapshots of the ai-acc handling export.
 *
 * Each window is the exact body the source system returned for one half-open
 * seven-day interval, kept verbatim so a certification run compares the bytes a
 * Raw Acquisition holds against the snapshot it was supposed to read. The rows
 * are the real export's shape: the source's own column names and its own labels,
 * never a canonical field name.
 */

type Row = Record<string, string>;

/** One frozen export response, and the interval it answers. */
export interface FrozenWindow {
  /** The half-open interval this snapshot answers. */
  window: { start: string; end: string };
  /** The exact response body the endpoint returns for that interval. */
  page: string;
  /** The rows the body carries, so an expectation can name them. */
  rows: Row[];
}

function row(
  recordId: string,
  deviceSn: string,
  handledOn: string,
  timeBand: string,
  takeoverState: string,
  handledCount: number,
): Row {
  return {
    工单号: recordId,
    设备编号: deviceSn,
    日期: handledOn,
    时段: timeBand,
    接管状态: takeoverState,
    处理量: String(handledCount),
  };
}

const FIRST: Row[] = [
  row('ACC-0001', 'DEV-101', '2026-02-24', '08-16', '已接管', 12),
  row('ACC-0002', 'DEV-102', '2026-02-24', '16-24', '未接管', 5),
  row('ACC-0003', 'DEV-101', '2026-02-25', '00-08', '未接管', 3),
  row('ACC-0004', 'DEV-103', '2026-02-27', '08-16', '未接管', 7),
  row('ACC-0005', 'DEV-102', '2026-02-28', '16-24', '已接管', 9),
  row('ACC-0006', 'DEV-104', '2026-03-01', '00-08', '已接管', 4),
];

const SECOND: Row[] = [
  row('ACC-0007', 'DEV-101', '2026-03-02', '00-08', '未接管', 2),
  row('ACC-0008', 'DEV-103', '2026-03-03', '08-16', '已接管', 15),
  row('ACC-0009', 'DEV-102', '2026-03-05', '16-24', '未接管', 6),
  row('ACC-0010', 'DEV-104', '2026-03-06', '08-16', '未接管', 1),
  row('ACC-0011', 'DEV-101', '2026-03-08', '16-24', '已接管', 11),
];

const THIRD: Row[] = [
  row('ACC-0012', 'DEV-102', '2026-03-10', '00-08', '已接管', 8),
  row('ACC-0013', 'DEV-103', '2026-03-12', '16-24', '未接管', 6),
  row('ACC-0014', 'DEV-104', '2026-03-13', '08-16', '已接管', 2),
];

/** The response body a window of rows is answered with, exactly as recorded. */
function frozen(rows: Row[]): string {
  return JSON.stringify({ data: { records: rows } });
}

/**
 * Three consecutive seven-day intervals with no gap and no overlap between
 * them, which is what a catch-up read of adjacent periods must produce.
 */
export const AI_ACC_WINDOWS: FrozenWindow[] = [
  { window: { start: '2026-02-23T00:00:00.000Z', end: '2026-03-02T00:00:00.000Z' }, page: frozen(FIRST), rows: FIRST },
  { window: { start: '2026-03-02T00:00:00.000Z', end: '2026-03-09T00:00:00.000Z' }, page: frozen(SECOND), rows: SECOND },
  { window: { start: '2026-03-09T00:00:00.000Z', end: '2026-03-16T00:00:00.000Z' }, page: frozen(THIRD), rows: THIRD },
];

/** The interval a fourth read would ask for, and the failure the source answers it with. */
export const AI_ACC_FAILED_WINDOW = {
  window: { start: '2026-03-16T00:00:00.000Z', end: '2026-03-23T00:00:00.000Z' },
  page: JSON.stringify({ error: '导出服务维护中' }),
};
