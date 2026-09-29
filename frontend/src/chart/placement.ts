// Where drawings and signals go on a chart. Free of the chart library, so that it can be tested without a browser.

import type { Point } from 'klinecharts';

import { barEnd, barStart, rank } from '../timeframes';
import type { DrawingState, PointState } from '../types';

/** The bars a chart holds, as far as placing needs them. */
export interface Bars {
  stamps: number[];
  highs: number[];
  lows: number[];
}

export const NO_BARS: Bars = { stamps: [], highs: [], lows: [] };

export function barsOf(list: ReadonlyArray<{ timestamp: number; high: number; low: number }>): Bars {
  const bars: Bars = { stamps: new Array<number>(list.length), highs: new Array<number>(list.length), lows: new Array<number>(list.length) };
  list.forEach((bar, index) => {
    bars.stamps[index] = bar.timestamp;
    bars.highs[index] = bar.high;
    bars.lows[index] = bar.low;
  });
  return bars;
}

/** Index of the last timestamp that is not after the target; -1 if all are after it. */
export function floorIndex(sorted: number[], target: number): number {
  let low = 0;
  let high = sorted.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] as number) <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The time at which an anchor appears on a chart of the given timeframe.
 *
 * An anchor set on one timeframe names an instant. On another timeframe it
 * belongs to the bar that contains the instant; where the data has no such
 * bar, to the bar before it. Instants after the last bar stay as they are:
 * the chart continues its time axis beyond the data.
 */
export function displayTime(timestamp: number, timeframe: string, bars: number[]): number {
  const last = bars[bars.length - 1];
  const start = barStart(timestamp, timeframe);
  if (last === undefined || start > last) return timestamp;
  const index = floorIndex(bars, start);
  if (index >= 0 && bars[index] === start) return start;
  const before = floorIndex(bars, timestamp);
  return before >= 0 ? (bars[before] as number) : timestamp;
}

/** Weekend trading belongs to the following Monday, so a bar can begin this long before its nominal start. */
const BEFORE_START = 3 * 86_400_000;

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * The bar of a finer timeframe on which a bar of a coarser one made its high or its low.
 *
 * An anchor set on a daily high names the day. On the hourly chart the high
 * belongs to the hour in which it was made, not to the first hour of the day.
 * Returns null where the price is not the high or the low of any of the bars.
 */
export function extremeWithin(timestamp: number, value: number, madeOn: string, bars: Bars): number | null {
  const start = barStart(timestamp, madeOn);
  const end = barEnd(start, madeOn);
  for (let index = floorIndex(bars.stamps, start - BEFORE_START) + 1; index < bars.stamps.length; index += 1) {
    const stamp = bars.stamps[index] as number;
    if (stamp >= end) break;
    if (barStart(stamp, madeOn) !== start) continue;
    if (same(bars.highs[index] as number, value) || same(bars.lows[index] as number, value)) return stamp;
  }
  return null;
}

/** Where an anchor goes on a chart of `timeframe`, given the timeframe it was set on. */
export function placeTime(point: PointState, madeOn: string | null, timeframe: string, bars: Bars): number | null {
  if (point.timestamp === null) return null;
  if (point.value !== null && madeOn !== null && rank(madeOn) > rank(timeframe) && rank(timeframe) >= 0) {
    const found = extremeWithin(point.timestamp, point.value, madeOn, bars);
    if (found !== null) return found;
  }
  return displayTime(point.timestamp, timeframe, bars.stamps);
}

export function displayPoints(points: PointState[], madeOn: string | null, timeframe: string, bars: Bars): Array<Partial<Point>> {
  return points.map((point) => {
    const shown: Partial<Point> = {};
    const time = placeTime(point, madeOn, timeframe, bars);
    if (time !== null) shown.timestamp = time;
    if (point.value !== null) shown.value = point.value;
    return shown;
  });
}

/** Earliest time any of the drawings is anchored at. */
export function earliest(drawings: Iterable<Pick<DrawingState, 'points'>>): number | null {
  let found: number | null = null;
  for (const drawing of drawings) {
    for (const point of drawing.points) {
      if (point.timestamp !== null && (found === null || point.timestamp < found)) found = point.timestamp;
    }
  }
  return found;
}

/** The moment in the middle of the time a shape spans. */
export function middleOf(anchors: ReadonlyArray<{ timestamp: number }>): number | null {
  if (anchors.length === 0) return null;
  const times = anchors.map((anchor) => anchor.timestamp);
  return Math.round((Math.min(...times) + Math.max(...times)) / 2);
}
