// The drawings of a study, shared by all its charts.

import type { DrawingState } from '../types';

export type BoardEvent =
  | { kind: 'put'; drawing: DrawingState; source: string | null }
  | { kind: 'remove'; id: string; source: string | null }
  | { kind: 'reset' };

export type BoardListener = (event: BoardEvent) => void;

/**
 * Holds every drawing once. A chart that changes a drawing tells the board,
 * and the board tells the other charts. `source` names the chart a change
 * comes from, so that it does not apply its own change a second time.
 */
export class DrawingBoard {
  private readonly drawings = new Map<string, DrawingState>();
  private readonly listeners = new Set<BoardListener>();

  constructor(drawings: Iterable<DrawingState> = []) {
    for (const drawing of drawings) this.drawings.set(drawing.id, drawing);
  }

  all(): DrawingState[] {
    return [...this.drawings.values()];
  }

  /** The drawings that show on charts of a symbol. */
  of(symbol: string): DrawingState[] {
    return this.all().filter((drawing) => drawing.symbol === null || drawing.symbol === symbol);
  }

  get(id: string): DrawingState | undefined {
    return this.drawings.get(id);
  }

  put(drawing: DrawingState, source: string | null = null): void {
    this.drawings.set(drawing.id, drawing);
    this.tell({ kind: 'put', drawing, source });
  }

  remove(id: string, source: string | null = null): boolean {
    if (!this.drawings.delete(id)) return false;
    this.tell({ kind: 'remove', id, source });
    return true;
  }

  reset(drawings: Iterable<DrawingState>): void {
    this.drawings.clear();
    for (const drawing of drawings) this.drawings.set(drawing.id, drawing);
    this.tell({ kind: 'reset' });
  }

  subscribe(listener: BoardListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private tell(event: BoardEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
