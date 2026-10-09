import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute, type Route } from './route';

describe('routes', () => {
  it.each<[string, Route]>([
    ['', { window: 'main' }],
    ['#/', { window: 'main' }],
    ['#/nothing/here', { window: 'main' }],
    ['#/study/signal/s202401100000-0a1b', { window: 'study', kind: 'signal', id: 's202401100000-0a1b' }],
    ['#/study/touch/t202401201000-ffff', { window: 'study', kind: 'touch', id: 't202401201000-ffff' }],
    ['#/study/free/20260928-224423-b226', { window: 'study', kind: 'free', id: '20260928-224423-b226', symbol: null, timeframe: null, focus: null }],
    ['#/study/free/new?symbol=audusd&timeframe=d1&focus=1700000000000', { window: 'study', kind: 'free', id: null, symbol: 'audusd', timeframe: 'd1', focus: 1700000000000 }],
    ['#/study/signal', { window: 'main' }],
    ['#/chat?symbol=audusd&timeframe=d1&signal=s202401100000-0a1b', { window: 'chat', symbol: 'audusd', timeframe: 'd1', signal: 's202401100000-0a1b' }],
    ['#/chat', { window: 'chat', symbol: null, timeframe: null, signal: null }],
  ])('reads %s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each<Route>([
    { window: 'main' },
    { window: 'study', kind: 'signal', id: 's202401100000-0a1b' },
    { window: 'study', kind: 'touch', id: 't202401201000-ffff' },
    { window: 'study', kind: 'free', id: '20260928-224423-b226', symbol: null, timeframe: null, focus: null },
    { window: 'study', kind: 'free', id: null, symbol: 'audusd', timeframe: 'h4', focus: 0 },
    { window: 'chat', symbol: 'eurusd', timeframe: 'h1', signal: null },
  ])('writes what it reads', (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });
});
