import type { Chart } from 'klinecharts';

import type { IndicatorState } from '../types';

export interface IndicatorInfo {
  name: string;
  label: string;
  /** "candle": drawn over the prices. "own": gets a pane below them. */
  pane: 'candle' | 'own';
  params: number[];
}

export const INDICATORS: IndicatorInfo[] = [
  { name: 'MA', label: 'MA 简单均线', pane: 'candle', params: [20, 60] },
  { name: 'EMA', label: 'EMA 指数均线', pane: 'candle', params: [12, 26] },
  { name: 'BOLL', label: 'BOLL 布林带', pane: 'candle', params: [20, 2] },
  { name: 'SAR', label: 'SAR 抛物线', pane: 'candle', params: [2, 2, 20] },
  { name: 'VOL', label: 'VOL 成交量', pane: 'own', params: [5, 10, 20] },
  { name: 'MACD', label: 'MACD', pane: 'own', params: [12, 26, 9] },
  { name: 'RSI', label: 'RSI', pane: 'own', params: [6, 12, 24] },
  { name: 'KDJ', label: 'KDJ', pane: 'own', params: [9, 3, 3] },
  { name: 'CCI', label: 'CCI', pane: 'own', params: [20] },
  { name: 'DMI', label: 'DMI', pane: 'own', params: [14, 6] },
  { name: 'WR', label: 'WR 威廉指标', pane: 'own', params: [6, 10, 14] },
  { name: 'ROC', label: 'ROC', pane: 'own', params: [12, 6] },
];

export const CANDLE_PANE = 'candle_pane';

export function paneOf(indicator: IndicatorState): string {
  return indicator.pane === 'candle' ? CANDLE_PANE : `pane_${indicator.name}`;
}

/** Makes the chart show exactly the wanted indicators. */
export function applyIndicators(chart: Chart, wanted: IndicatorState[]): void {
  const key = (name: string, pane: string, params: unknown) => `${name}@${pane}:${JSON.stringify(params)}`;
  const keep = new Set(wanted.filter((item) => item.visible).map((item) => key(item.name, paneOf(item), item.params)));
  const shown = new Set<string>();
  for (const indicator of chart.getIndicators()) {
    const own = key(indicator.name, indicator.paneId, indicator.calcParams);
    if (keep.has(own)) shown.add(own);
    else chart.removeIndicator({ name: indicator.name, paneId: indicator.paneId });
  }
  for (const item of wanted) {
    if (!item.visible || shown.has(key(item.name, paneOf(item), item.params))) continue;
    chart.createIndicator({ name: item.name, calcParams: item.params, paneId: paneOf(item) }, item.pane === 'candle');
  }
}
