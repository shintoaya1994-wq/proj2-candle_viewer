// What the main window remembers from one visit to the next. It is kept by the browser, on this computer.

import type { IndicatorState } from './types';

export interface Settings {
  symbol: string | null;
  timeframe: string;
  timezone: string;
  indicators: IndicatorState[];
  magnet: boolean;
}

const KEY = 'candle-viewer.main';

export function remembered(defaults: Settings): Settings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...defaults, ...stored, indicators: Array.isArray(stored.indicators) ? stored.indicators : [] };
  } catch {
    return defaults;
  }
}

export function remember(settings: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Without a place to remember, the window starts from its defaults next time.
  }
}
