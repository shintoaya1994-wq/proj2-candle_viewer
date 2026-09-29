import type { DataLoader, KLineData } from 'klinecharts';

import { api, type BarsQuery } from '../api';
import type { BarsResponse } from '../types';

export interface Series {
  symbol: string;
  timeframe: string;
}

/** Where the first window of bars should lie. */
export interface Anchor {
  around: number | null;
  /** The window must begin no later than this time. */
  since: number | null;
}

export interface LoaderOptions {
  series(): Series;
  anchor(): Anchor;
  /** Bars have arrived. `latest` tells whether the chart now holds the bars up to the end of the data. */
  onLoaded(first: boolean, latest: boolean): void;
  onError(error: unknown): void;
}

export const FIRST_WINDOW = 1500;
export const NEXT_WINDOW = 3000;

function toBars(response: BarsResponse): KLineData[] {
  return response.bars.map(([timestamp, open, high, low, close, volume, minutes, flags]) => ({
    timestamp,
    open,
    high,
    low,
    close,
    volume: volume ?? undefined,
    minutes,
    flags,
  }));
}

/**
 * Feeds the chart from the backend, window by window.
 *
 * The chart library names the directions by the way the chart moves, not by
 * time: it asks "forward" for bars before the first one it holds and
 * "backward" for bars after the last one.
 */
export function createLoader(options: LoaderOptions): DataLoader {
  let generation = 0;
  let latest = false;
  return {
    getBars: async ({ type, timestamp, callback }) => {
      if (type === 'update') return;
      const first = type === 'init';
      const mine = first ? ++generation : generation;
      const series = options.series();
      const query: BarsQuery = { ...series, count: first ? FIRST_WINDOW : NEXT_WINDOW };
      if (first) {
        const { around, since } = options.anchor();
        if (around !== null) query.around = around;
        if (since !== null) query.since = since;
      } else if (timestamp === null) {
        callback([], false);
        return;
      } else if (type === 'forward') {
        query.before = timestamp;
      } else {
        query.after = timestamp;
      }
      try {
        const response = await api.bars(query);
        if (mine !== generation) return; // another series was chosen while this one travelled
        const bars = toBars(response);
        if (type !== 'forward') latest = !response.newer;
        if (first) callback(bars, { forward: response.older, backward: response.newer });
        else if (type === 'forward') callback(bars, { forward: response.older });
        else callback(bars, { backward: response.newer });
        options.onLoaded(first, latest);
      } catch (error) {
        if (mine !== generation) return;
        callback([], false);
        options.onError(error);
      }
    },
  };
}
