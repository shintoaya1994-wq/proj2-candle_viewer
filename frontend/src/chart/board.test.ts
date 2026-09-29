import { describe, expect, it } from 'vitest';

import type { DrawingState } from '../types';
import { DrawingBoard, type BoardEvent } from './board';

const drawing = (id: string, symbol: string | null = 'testfx'): DrawingState => ({
  id, name: 'segment', symbol, timeframe: 'h1', styles: null, extendData: null, lock: false, visible: true, zLevel: 0,
  points: [{ timestamp: 1, value: 1 }],
});

describe('DrawingBoard', () => {
  it('tells every chart what one of them changed, and who changed it', () => {
    const board = new DrawingBoard();
    const heard: BoardEvent[] = [];
    board.subscribe((event) => heard.push(event));
    board.put(drawing('a'), 'pane-1');
    board.remove('a', 'pane-2');
    expect(heard).toEqual([
      { kind: 'put', drawing: drawing('a'), source: 'pane-1' },
      { kind: 'remove', id: 'a', source: 'pane-2' },
    ]);
  });

  it('holds a drawing once, in its latest state', () => {
    const board = new DrawingBoard([drawing('a')]);
    board.put({ ...drawing('a'), timeframe: 'd1' });
    expect(board.all()).toHaveLength(1);
    expect(board.get('a')?.timeframe).toBe('d1');
  });

  it('says nothing about a drawing it does not hold', () => {
    const board = new DrawingBoard();
    const heard: BoardEvent[] = [];
    board.subscribe((event) => heard.push(event));
    expect(board.remove('a')).toBe(false);
    expect(heard).toEqual([]);
  });

  it('shows a drawing on the charts of its symbol', () => {
    const board = new DrawingBoard([drawing('a', 'testfx'), drawing('b', 'otherfx'), drawing('c', null)]);
    expect(board.of('testfx').map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('stops telling a chart that has left', () => {
    const board = new DrawingBoard();
    const heard: BoardEvent[] = [];
    const leave = board.subscribe((event) => heard.push(event));
    leave();
    board.reset([drawing('a')]);
    expect(heard).toEqual([]);
    expect(board.all()).toHaveLength(1);
  });
});
