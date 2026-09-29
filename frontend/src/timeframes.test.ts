import { describe, expect, it } from 'vitest';

import { barEnd, barStart, rank } from './timeframes';

const ms = (text: string) => Date.parse(`${text.replace(' ', 'T')}${text.length > 10 ? ':00' : 'T00:00:00'}Z`);

// The same cases as tests/test_sessions.py, so that the chart and the data pipeline agree.
describe('barStart', () => {
  it.each([
    ['m1', '2024-01-10 13:47'],
    ['m15', '2024-01-10 13:45'],
    ['h1', '2024-01-10 13:00'],
    ['h4', '2024-01-10 12:00'],
    ['d1', '2024-01-10'],
    ['w1', '2024-01-08'],
    ['1mo', '2024-01-01'],
    ['3mo', '2024-01-01'],
  ])('places a weekday instant on %s', (name, expected) => {
    expect(barStart(ms('2024-01-10 13:47'), name)).toBe(ms(expected));
  });

  it('gives the Sunday evening session to Monday', () => {
    expect(barStart(ms('2024-01-07 22:30'), 'd1')).toBe(ms('2024-01-08'));
    expect(barStart(ms('2024-01-07 22:30'), 'w1')).toBe(ms('2024-01-08'));
  });

  it('keeps the intraday bars of the Sunday evening session', () => {
    expect(barStart(ms('2024-01-07 22:30'), 'h1')).toBe(ms('2024-01-07 22:00'));
    expect(barStart(ms('2024-01-07 22:30'), 'h4')).toBe(ms('2024-01-07 20:00'));
  });

  it('lets the Sunday session before a new year open the new periods', () => {
    expect(barStart(ms('2023-12-31 22:30'), 'd1')).toBe(ms('2024-01-01'));
    expect(barStart(ms('2023-12-31 22:30'), '1mo')).toBe(ms('2024-01-01'));
    expect(barStart(ms('2023-12-31 22:30'), '3mo')).toBe(ms('2024-01-01'));
  });

  it('starts quarters in January, April, July and October', () => {
    expect(barStart(ms('2024-06-28 10:00'), '3mo')).toBe(ms('2024-04-01'));
    expect(barStart(ms('2024-09-30 10:00'), '3mo')).toBe(ms('2024-07-01'));
    expect(barStart(ms('1993-11-15 10:00'), '3mo')).toBe(ms('1993-10-01'));
  });

  it('handles instants before 1970', () => {
    expect(barStart(ms('1969-12-28 22:30'), 'd1')).toBe(ms('1969-12-29'));
  });
});

describe('barEnd', () => {
  it.each([
    ['m15', '2024-01-10 13:45', '2024-01-10 14:00'],
    ['h4', '2024-01-10 20:00', '2024-01-11 00:00'],
    ['d1', '2024-01-10', '2024-01-11'],
    ['w1', '2024-01-08', '2024-01-15'],
    ['1mo', '2024-12-01', '2025-01-01'],
    ['3mo', '2024-10-01', '2025-01-01'],
  ])('of a bar of %s', (name, start, expected) => {
    expect(barEnd(ms(start), name)).toBe(ms(expected));
  });
});

describe('rank', () => {
  it('orders the timeframes from fine to coarse', () => {
    expect(rank('h1')).toBeLessThan(rank('d1'));
    expect(rank('1mo')).toBeLessThan(rank('3mo'));
    expect(rank('m7')).toBe(-1);
  });
});
