import { describe, expect, it } from 'vitest';

import type { DrawingState } from '../types';
import { displayPoints, displayTime, earliest, floorIndex } from './placement';

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
    const shown = displayPoints([{ timestamp: ms('2024-01-09 13:00'), value: 1.25 }, { timestamp: null, value: 1.3 }, { timestamp: ms('2024-01-09 02:00'), value: null }], 'd1', [ms('2024-01-09')]);
    expect(shown).toEqual([{ timestamp: ms('2024-01-09'), value: 1.25 }, { value: 1.3 }, { timestamp: ms('2024-01-09') }]);
  });
});

describe('earliest', () => {
  const drawing = (...times: Array<number | null>): DrawingState => ({
    id: 'x', name: 'segment', timeframe: 'h1', styles: null, extendData: null, lock: false, visible: true, zLevel: 0,
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
