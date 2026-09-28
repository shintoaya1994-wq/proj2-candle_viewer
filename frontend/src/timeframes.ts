import type { Period } from 'klinecharts';

export interface TimeframeInfo {
  name: string;
  /** Short name for buttons. */
  label: string;
  /** Full name for the title of the chart. */
  title: string;
  period: Period;
  /** How bars are aligned; mirrors src/candle_viewer/market/timeframes.py. */
  kind: 'intraday' | 'day' | 'week' | 'month';
  span: number;
}

export const TIMEFRAMES: TimeframeInfo[] = [
  { name: 'm1', label: '1分', title: '1 分钟', period: { type: 'minute', span: 1 }, kind: 'intraday', span: 1 },
  { name: 'm15', label: '15分', title: '15 分钟', period: { type: 'minute', span: 15 }, kind: 'intraday', span: 15 },
  { name: 'h1', label: '1时', title: '1 小时', period: { type: 'hour', span: 1 }, kind: 'intraday', span: 60 },
  { name: 'h4', label: '4时', title: '4 小时', period: { type: 'hour', span: 4 }, kind: 'intraday', span: 240 },
  { name: 'd1', label: '日', title: '日线', period: { type: 'day', span: 1 }, kind: 'day', span: 1 },
  { name: 'w1', label: '周', title: '周线', period: { type: 'week', span: 1 }, kind: 'week', span: 1 },
  { name: '1mo', label: '月', title: '月线', period: { type: 'month', span: 1 }, kind: 'month', span: 1 },
  { name: '3mo', label: '季', title: '季线', period: { type: 'month', span: 3 }, kind: 'month', span: 3 },
];

export function timeframe(name: string): TimeframeInfo {
  const found = TIMEFRAMES.find((item) => item.name === name);
  if (!found) throw new Error(`unknown timeframe ${name}`);
  return found;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * Start of the bar that contains an instant, as UTC milliseconds.
 *
 * Mirrors SessionCalendar.bar_start for the "utc" convention: intraday bars
 * sit on a fixed grid, and anything on a Saturday or Sunday belongs to the
 * trading day of the following Monday.
 */
export function barStart(timestamp: number, name: string): number {
  const tf = timeframe(name);
  if (tf.kind === 'intraday') {
    const step = tf.span * MINUTE;
    return Math.floor(timestamp / step) * step;
  }
  let day = Math.floor(timestamp / DAY);
  const weekday = (((day + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday; Monday = 0
  if (weekday >= 5) day += 7 - weekday;
  if (tf.kind === 'day') return day * DAY;
  if (tf.kind === 'week') return (day - ((((day + 3) % 7) + 7) % 7)) * DAY;
  const date = new Date(day * DAY);
  const month = date.getUTCMonth() - (date.getUTCMonth() % tf.span);
  return Date.UTC(date.getUTCFullYear(), month, 1);
}
