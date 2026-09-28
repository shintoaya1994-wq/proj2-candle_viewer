import { registerOverlay, type Overlay, type OverlayCreate, type OverlayFigure } from 'klinecharts';

import type { DrawingData, DrawingState } from '../types';
import { displayPoints } from './placement';

export const DRAWING_GROUP = 'drawing';

export const COLORS = [
  { value: '#e11d48', label: '红' },
  { value: '#16a34a', label: '绿' },
  { value: '#2563eb', label: '蓝' },
  { value: '#f59e0b', label: '橙' },
  { value: '#9333ea', label: '紫' },
  { value: '#111827', label: '黑' },
];
export const DEFAULT_COLOR = '#2563eb';

export interface Tool {
  name: string;
  label: string;
  /** What the user has to do, shown while the tool is active. */
  hint: string;
}

export const TOOLS: Tool[] = [
  { name: 'segment', label: '线段', hint: '点击两次：起点、终点' },
  { name: 'rayLine', label: '射线', hint: '点击两次：起点、方向' },
  { name: 'straightLine', label: '直线', hint: '点击两次确定直线' },
  { name: 'horizontalStraightLine', label: '水平线', hint: '点击一次确定价格' },
  { name: 'verticalStraightLine', label: '垂直线', hint: '点击一次确定时间' },
  { name: 'box', label: '方框', hint: '点击两次：对角的两个角' },
  { name: 'note', label: '文字', hint: '点击一次确定位置，然后输入文字' },
];

/** Drawings that carry a text. */
export const WITH_TEXT = new Set(['note', 'box']);

const hex = (color: string, alpha: number) => {
  const value = parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

const dataOf = (overlay: Overlay<unknown>): DrawingData => (overlay.extendData ?? {}) as DrawingData;

function label(text: string, x: number, y: number, color: string, baseline: 'top' | 'bottom'): OverlayFigure {
  return {
    type: 'text',
    ignoreEvent: baseline === 'top',
    attrs: { x, y, text, align: 'left', baseline },
    styles: { color: '#ffffff', backgroundColor: color, size: 12, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3, borderRadius: 3 },
  };
}

let registered = false;

/** Adds the drawings the chart library lacks: a box in time and price, and a note. */
export function registerDrawings(): void {
  if (registered) return;
  registered = true;

  registerOverlay({
    name: 'box',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay }) => {
      const [a, b] = coordinates;
      if (!a || !b) return [];
      const { color = DEFAULT_COLOR, text } = dataOf(overlay);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const figures: OverlayFigure[] = [
        {
          type: 'rect',
          attrs: { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) },
          styles: { style: 'stroke_fill', color: hex(color, 0.1), borderColor: color, borderSize: 1 },
        },
      ];
      if (text) figures.push(label(text, x + 3, y + 3, color, 'top'));
      return figures;
    },
  });

  registerOverlay({
    name: 'note',
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay }) => {
      const [at] = coordinates;
      if (!at) return [];
      const { color = DEFAULT_COLOR, text } = dataOf(overlay);
      return [label(text || '…', at.x + 6, at.y - 6, color, 'bottom')];
    },
  });
}

/** Styles of the library's own line drawings; the drawings above take their color from their data. */
export function stylesFor(name: string, color: string): Record<string, unknown> | null {
  if (name === 'box' || name === 'note') return null;
  return { line: { color, size: 1.5 }, point: { color, borderColor: hex(color, 0.35), activeColor: color, activeBorderColor: hex(color, 0.35) } };
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `d${Date.now().toString(36)}${counter.toString(36)}`;
}

export function newDrawing(name: string, color: string): DrawingState {
  return { id: newId(), name, points: [], timeframe: null, styles: stylesFor(name, color), extendData: { color }, lock: false, visible: true, zLevel: 0 };
}

/** The state of a drawing as the chart holds it now. */
export function stateOf(overlay: Overlay<unknown>, timeframe: string): DrawingState {
  return {
    id: overlay.id,
    name: overlay.name,
    points: overlay.points.map((point) => ({ timestamp: point.timestamp ?? null, value: point.value ?? null })),
    timeframe,
    styles: (overlay.styles as Record<string, unknown> | null) ?? null,
    extendData: dataOf(overlay),
    lock: overlay.lock,
    visible: overlay.visible,
    zLevel: overlay.zLevel,
  };
}

/** What to hand to the chart to show a stored drawing. */
export function overlayOf(state: DrawingState, timeframe: string, bars: number[]): OverlayCreate {
  const create: OverlayCreate = {
    id: state.id,
    name: state.name,
    groupId: DRAWING_GROUP,
    lock: state.lock,
    visible: state.visible,
    zLevel: state.zLevel,
    extendData: state.extendData ?? {},
  };
  if (state.points.length > 0) create.points = displayPoints(state.points, timeframe, bars);
  if (state.styles) create.styles = state.styles;
  return create;
}
