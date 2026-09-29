import { describe, expect, it } from 'vitest';

import type { DrawingState } from '../types';
import { barsOf, displayPoints, displayTime, earliest, extremeWithin, floorIndex, middleOf, placeTime } from './placement';

const ms = (text: string) => Date.parse(`${text.replace(' ', 'T')}${text.length > 10 ? ':00' : 'T00:00:00'}Z`);

describe('floorIndex', () => {
  const list = [10, 20, 30, 40];
  it.each([
    [5, -1],
    [10, 0],
    [19, 0],
    [20, 1],
    [39, 2],
    [40, 3],
    [99, 3],
  ])('of %i is %i', (target, expected) => {
    expect(floorIndex(list, target)).toBe(expected);
  });
  it('of an empty list is -1', () => {
    expect(floorIndex([], 5)).toBe(-1);
  });
});

describe('displayTime', () => {
  // Daily bars of two weeks; Wednesday 2024-01-10 is missing.
  const days = ['2024-01-08', '2024-01-09', '2024-01-11', '2024-01-12', '2024-01-15', '2024-01-16'].map(ms);

  it('puts an hour on the day that contains it', () => {
    expect(displayTime(ms('2024-01-09 13:00'), 'd1', days)).toBe(ms('2024-01-09'));
  });

  it('puts the Sunday evening session on Monday', () => {
    expect(displayTime(ms('2024-01-14 22:30'), 'd1', days)).toBe(ms('2024-01-15'));
  });

  it('falls back to the bar before where the data has a hole', () => {
    expect(displayTime(ms('2024-01-10 13:00'), 'd1', days)).toBe(ms('2024-01-09'));
  });

  it('leaves times after the last bar alone', () => {
    expect(displayTime(ms('2024-02-01 07:00'), 'd1', days)).toBe(ms('2024-02-01 07:00'));
  });

  it('puts a time inside the last bar on that bar', () => {
    expect(displayTime(ms('2024-01-16 21:30'), 'd1', days)).toBe(ms('2024-01-16'));
  });

  it('leaves times before the first bar alone', () => {
    expect(displayTime(ms('2023-12-01 07:00'), 'd1', days)).toBe(ms('2023-12-01 07:00'));
  });

  it('keeps a time that is a bar of the timeframe', () => {
    expect(displayTime(ms('2024-01-12'), 'd1', days)).toBe(ms('2024-01-12'));
  });
});

describe('displayPoints', () => {
  it('keeps prices and leaves out what an anchor does not have', () => {
    const bars = barsOf([{ timestamp: ms('2024-01-09'), high: 1.3, low: 1.2 }]);
    const shown = displayPoints([{ timestamp: ms('2024-01-09 13:00'), value: 1.25 }, { timestamp: null, value: 1.3 }, { timestamp: ms('2024-01-09 02:00'), value: null }], 'h1', 'd1', bars);
    expect(shown).toEqual([{ timestamp: ms('2024-01-09'), value: 1.25 }, { value: 1.3 }, { timestamp: ms('2024-01-09') }]);
  });
});

describe('earliest', () => {
  const drawing = (...times: Array<number | null>): DrawingState => ({
    id: 'x', name: 'segment', symbol: 'testfx', timeframe: 'h1', styles: null, extendData: null, lock: false, visible: true, zLevel: 0,
    points: times.map((timestamp) => ({ timestamp, value: 1 })),
  });
  it('finds the earliest anchor', () => {
    expect(earliest([drawing(30, 20), drawing(null), drawing(25)])).toBe(20);
  });
  it('is null without anchors in time', () => {
    expect(earliest([drawing(null)])).toBeNull();
    expect(earliest([])).toBeNull();
  });
});

describe('an anchor set on a coarser timeframe', () => {
  // Hours of Tuesday 2024-01-09 and of the Sunday evening before Monday 2024-01-15.
  const hours = barsOf([
    { timestamp: ms('2024-01-08 23:00'), high: 1.2710, low: 1.2690 },
    { timestamp: ms('2024-01-09 00:00'), high: 1.2705, low: 1.2695 },
    { timestamp: ms('2024-01-09 09:00'), high: 1.2760, low: 1.2700 },
    { timestamp: ms('2024-01-09 14:00'), high: 1.2740, low: 1.2650 },
    { timestamp: ms('2024-01-09 23:00'), high: 1.2700, low: 1.2680 },
    { timestamp: ms('2024-01-10 00:00'), high: 1.2760, low: 1.2650 },
    { timestamp: ms('2024-01-14 22:00'), high: 1.2790, low: 1.2720 },
    { timestamp: ms('2024-01-15 00:00'), high: 1.2780, low: 1.2730 },
  ]);

  it('goes to the hour that made the high of the day', () => {
    expect(extremeWithin(ms('2024-01-09'), 1.276, 'd1', hours)).toBe(ms('2024-01-09 09:00'));
  });

  it('goes to the hour that made the low of the day', () => {
    expect(extremeWithin(ms('2024-01-09'), 1.265, 'd1', hours)).toBe(ms('2024-01-09 14:00'));
  });

  it('does not look at the days around it', () => {
    expect(extremeWithin(ms('2024-01-09'), 1.271, 'd1', hours)).toBeNull();
    expect(extremeWithin(ms('2024-01-10'), 1.276, 'd1', hours)).toBe(ms('2024-01-10 00:00'));
  });

  it('finds a high made on the Sunday evening of a Monday', () => {
    expect(extremeWithin(ms('2024-01-15'), 1.279, 'd1', hours)).toBe(ms('2024-01-14 22:00'));
    expect(extremeWithin(ms('2024-01-15'), 1.279, 'w1', hours)).toBe(ms('2024-01-14 22:00'));
  });

  it('stays on the first bar where the price is not a high or a low', () => {
    expect(placeTime({ timestamp: ms('2024-01-09'), value: 1.2701 }, 'd1', 'h1', hours)).toBe(ms('2024-01-09 00:00'));
  });

  it('is placed by its price only on finer charts', () => {
    const days = barsOf([{ timestamp: ms('2024-01-09'), high: 1.276, low: 1.265 }, { timestamp: ms('2024-01-10'), high: 1.276, low: 1.265 }]);
    expect(placeTime({ timestamp: ms('2024-01-10 00:00'), value: 1.276 }, 'h1', 'd1', days)).toBe(ms('2024-01-10'));
    expect(placeTime({ timestamp: ms('2024-01-10'), value: 1.276 }, 'd1', 'd1', days)).toBe(ms('2024-01-10'));
    expect(placeTime({ timestamp: ms('2024-01-10'), value: 1.276 }, null, 'd1', days)).toBe(ms('2024-01-10'));
  });

  it('has no place in time without a time', () => {
    expect(placeTime({ timestamp: null, value: 1.276 }, 'd1', 'h1', hours)).toBeNull();
  });
});

describe('middleOf', () => {
  it('is the anchor of a point', () => {
    expect(middleOf([{ timestamp: 40 }])).toBe(40);
  });
  it('is the middle of the span of a line or a box', () => {
    expect(middleOf([{ timestamp: 100 }, { timestamp: 40 }])).toBe(70);
  });
  it('is null without anchors', () => {
    expect(middleOf([])).toBeNull();
  });
});
