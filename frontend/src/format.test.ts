import { describe as group, expect, it } from 'vitest';

import { barTime, describe, fromInput, modelsOf, moment, stamped, toInput } from './format';

const ms = (text: string) => Date.parse(`${text.replace(' ', 'T')}${text.length > 10 ? ':00' : 'T00:00:00'}Z`);

group('times', () => {
  it('are written in UTC', () => {
    expect(moment(ms('2024-01-10 13:05'))).toBe('2024-01-10 13:05');
    expect(moment(ms('1993-11-15'))).toBe('1993-11-15 00:00');
  });
  it('of days and longer bars have no time of day', () => {
    expect(barTime(ms('2024-01-10'), 'd1')).toBe('2024-01-10');
    expect(barTime(ms('2024-01-10 12:00'), 'h4')).toBe('2024-01-10 12:00');
  });
  it('from the backend lose their seconds', () => {
    expect(stamped('2026-09-28T23:01:41Z')).toBe('2026-09-28 23:01');
  });
  it('go into an input and come back', () => {
    expect(toInput(ms('2024-01-10 13:05'))).toBe('2024-01-10T13:05');
    expect(fromInput('2024-01-10T13:05')).toBe(ms('2024-01-10 13:05'));
    expect(fromInput('2024-01-10')).toBe(ms('2024-01-10'));
    expect(toInput(null)).toBe('');
    expect(fromInput('')).toBeNull();
    expect(fromInput('soon')).toBeNull();
  });
});

group('describe', () => {
  it('names the timeframe, the shape and the time of a signal', () => {
    expect(describe({ shape: 'point', timeframe: 'd1', anchors: [{ timestamp: ms('2024-01-10'), value: 1 }] })).toBe('日线 点 2024-01-10');
    expect(describe({ shape: 'box', timeframe: 'h4', anchors: [{ timestamp: ms('2024-01-20 08:00'), value: 1 }, { timestamp: ms('2024-01-02 12:00'), value: 2 }] })).toBe('4 小时 框 2024-01-02 12:00 ~ 2024-01-20 08:00');
  });
});

group('modelsOf', () => {
  it('reads names separated in the ways people separate them', () => {
    expect(modelsOf('模型甲，模型乙、 箱体突破 ; 模型甲,')).toEqual(['模型甲', '模型乙', '箱体突破']);
    expect(modelsOf('  ')).toEqual([]);
  });
});
