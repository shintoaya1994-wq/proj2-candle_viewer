import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute, type Route } from './route';

describe('routes', () => {
  it.each<[string, Route]>([
    ['', { window: 'main', project: null }],
    ['#/', { window: 'main', project: null }],
    ['#/nothing/here', { window: 'main', project: null }],
    ['#/study/signal/s202401100000-0a1b', { window: 'study', kind: 'signal', id: 's202401100000-0a1b', project: null }],
    ['#/study/touch/t202401201000-ffff', { window: 'study', kind: 'touch', id: 't202401201000-ffff', project: null }],
    ['#/study/free/20260928-224423-b226', { window: 'study', kind: 'free', id: '20260928-224423-b226', symbol: null, timeframe: null, focus: null, project: null }],
    ['#/study/free/new?symbol=audusd&timeframe=d1&focus=1700000000000', { window: 'study', kind: 'free', id: null, symbol: 'audusd', timeframe: 'd1', focus: 1700000000000, project: null }],
    ['#/study/signal', { window: 'main', project: null }],
    ['#/chat?symbol=audusd&timeframe=d1&signal=s202401100000-0a1b', { window: 'chat', symbol: 'audusd', timeframe: 'd1', signal: 's202401100000-0a1b', project: null }],
    ['#/chat', { window: 'chat', symbol: null, timeframe: null, signal: null, project: null }],
    ['#/study/signal/s202401100000-0a1b?project=%E8%AF%95%E9%AA%8C', { window: 'study', kind: 'signal', id: 's202401100000-0a1b', project: '试验' }],
    ['#/?project=p1', { window: 'main', project: 'p1' }],
  ])('reads %s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it.each<Route>([
    { window: 'main', project: null },
    { window: 'study', kind: 'signal', id: 's202401100000-0a1b', project: null },
    { window: 'study', kind: 'touch', id: 't202401201000-ffff', project: null },
    { window: 'study', kind: 'free', id: '20260928-224423-b226', symbol: null, timeframe: null, focus: null, project: null },
    { window: 'study', kind: 'free', id: null, symbol: 'audusd', timeframe: 'h4', focus: 0, project: null },
    { window: 'chat', symbol: 'eurusd', timeframe: 'h1', signal: null, project: null },
    { window: 'chat', symbol: 'eurusd', timeframe: 'h1', signal: 's1', project: '新想法 1' },
    { window: 'study', kind: 'free', id: null, symbol: 'audusd', timeframe: 'h4', focus: 0, project: 'p' },
  ])('writes what it reads', (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });
});
