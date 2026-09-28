// Where drawings go on a chart. Free of the chart library, so that it can be tested without a browser.

import type { Point } from 'klinecharts';

import { barStart } from '../timeframes';
import type { DrawingState, PointState } from '../types';

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

export function displayPoints(points: PointState[], timeframe: string, bars: number[]): Array<Partial<Point>> {
  return points.map((point) => {
    const shown: Partial<Point> = {};
    if (point.timestamp !== null) shown.timestamp = displayTime(point.timestamp, timeframe, bars);
    if (point.value !== null) shown.value = point.value;
    return shown;
  });
}

/** Earliest time any of the drawings is anchored at. */
export function earliest(drawings: Iterable<DrawingState>): number | null {
  let found: number | null = null;
  for (const drawing of drawings) {
    for (const point of drawing.points) {
      if (point.timestamp !== null && (found === null || point.timestamp < found)) found = point.timestamp;
    }
  }
  return found;
}
