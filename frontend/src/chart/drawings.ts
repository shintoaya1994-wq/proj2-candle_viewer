import { registerOverlay, type Overlay, type OverlayCreate, type OverlayFigure, type OverlayMode } from 'klinecharts';

import type { DrawingData, DrawingState } from '../types';
import { displayPoints, type Bars } from './placement';

export const DRAWING_GROUP = 'drawing';
/** Drawings of another study, shown for reference; they cannot be changed here. */
export const REFERENCE_GROUP = 'reference';

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
  { name: 'levelSegment', label: '水平线段', hint: '点击两次：第一次定价格和起点，第二次定终点' },
  { name: 'levelRay', label: '水平射线', hint: '点击一次：从这里向右的水平线' },
  { name: 'rayLine', label: '射线', hint: '点击两次：起点、方向' },
  { name: 'straightLine', label: '直线', hint: '点击两次确定直线' },
  { name: 'horizontalStraightLine', label: '水平线', hint: '点击一次确定价格' },
  { name: 'verticalStraightLine', label: '垂直线', hint: '点击一次确定时间' },
  { name: 'box', label: '方框', hint: '点击两次：对角的两个角' },
  { name: 'note', label: '文字', hint: '点击一次确定位置，然后输入文字' },
];

/** Drawings that carry a text. */
export const WITH_TEXT = new Set(['note', 'box']);

/** How close to a high or a low a click has to be to land on it, in pixels. */
const MAGNET_REACH = 12;

export const hex = (color: string, alpha: number) => {
  const value = parseInt(color.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

const dataOf = (overlay: Overlay<unknown>): DrawingData => (overlay.extendData ?? {}) as DrawingData;

export function label(text: string, x: number, y: number, color: string, baseline: 'top' | 'bottom', hollow = false): OverlayFigure {
  const styles = hollow
    ? { style: 'stroke_fill', color, backgroundColor: '#ffffff', borderColor: color, borderSize: 1 }
    : { style: 'fill', color: '#ffffff', backgroundColor: color };
  return {
    type: 'text',
    attrs: { x, y, text, align: 'left', baseline },
    styles: { ...styles, size: 12, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3, borderRadius: 3 },
  };
}

let registered = false;

/** Adds the drawings the chart library lacks. */
export function registerDrawings(): void {
  if (registered) return;
  registered = true;

  // A box in time and price.
  registerOverlay({
    name: 'box',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay }) => {
      const [a, b] = coordinates;
      if (!a || !b) return [];
      const { color = DEFAULT_COLOR, text, reference = false } = dataOf(overlay);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const figures: OverlayFigure[] = [
        {
          type: 'rect',
          attrs: { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) },
          styles: { style: 'stroke_fill', color: hex(color, reference ? 0.06 : 0.1), borderColor: color, borderSize: 1, borderStyle: reference ? 'dashed' : 'solid', borderDashedValue: [6, 4] },
        },
      ];
      if (text) figures.push({ ...label(text, x + 3, y + 3, color, 'top'), ignoreEvent: true });
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

  // A horizontal line between two times. The first click sets the price, the second only the end.
  registerOverlay({
    name: 'levelSegment',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }) => (coordinates.length === 2 ? [{ type: 'line', attrs: { coordinates } }] : []),
    performEventMoveForDrawing: ({ currentStep, points, performPoint }) => {
      const first = points[0]?.value;
      if (currentStep === 2 && first !== undefined) performPoint.value = first;
    },
    performEventPressedMove: ({ points, performPoint }) => {
      for (const point of points) if (performPoint.value !== undefined) point.value = performPoint.value;
    },
  });

  // One click that picks a bar and a price: where a signal or a touch is.
  registerOverlay({
    name: 'spot',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay }) => {
      const [at] = coordinates;
      if (!at) return [];
      const { color = DEFAULT_COLOR } = dataOf(overlay);
      return [{ type: 'circle', attrs: { x: at.x, y: at.y, r: 5 }, styles: { style: 'stroke_fill', color: hex(color, 0.25), borderColor: color, borderSize: 2 } }];
    },
  });

  // A horizontal line from a point to the right edge of the chart.
  registerOverlay({
    name: 'levelRay',
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, bounding }) => {
      const [at] = coordinates;
      if (!at) return [];
      return [{ type: 'line', attrs: { coordinates: [at, { x: Math.max(bounding.width, at.x), y: at.y }] } }];
    },
  });
}

/** Styles of line drawings; boxes and notes take their color from their data. */
export function stylesFor(name: string, color: string): Record<string, unknown> | null {
  if (name === 'box' || name === 'note') return null;
  return { line: { color, size: 1.5 }, point: { color, borderColor: hex(color, 0.35), activeColor: color, activeBorderColor: hex(color, 0.35) } };
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `d${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function newDrawing(name: string, color: string, symbol: string): DrawingState {
  return { id: newId(), name, points: [], symbol, timeframe: null, styles: stylesFor(name, color), extendData: { color }, lock: false, visible: true, zLevel: 0 };
}

/** The state of a drawing as the chart holds it now. */
export function stateOf(overlay: Overlay<unknown>, timeframe: string, symbol: string): DrawingState {
  const { reference: _reference, ...data } = dataOf(overlay);
  return {
    id: overlay.id,
    name: overlay.name,
    points: overlay.points.map((point) => ({ timestamp: point.timestamp ?? null, value: point.value ?? null })),
    symbol,
    timeframe,
    styles: (overlay.styles as Record<string, unknown> | null) ?? null,
    extendData: data,
    lock: overlay.lock,
    visible: overlay.visible,
    zLevel: overlay.zLevel,
  };
}

export const magnetMode = (magnet: boolean): OverlayMode => (magnet ? 'weak_magnet' : 'normal');

/** What to hand to the chart to show a stored drawing. */
export function overlayOf(state: DrawingState, timeframe: string, bars: Bars, magnet: boolean): OverlayCreate {
  const create: OverlayCreate = {
    id: state.id,
    name: state.name,
    groupId: DRAWING_GROUP,
    lock: state.lock,
    visible: state.visible,
    zLevel: state.zLevel,
    mode: magnetMode(magnet),
    modeSensitivity: MAGNET_REACH,
    extendData: { text: '', ...state.extendData },
  };
  if (state.points.length > 0) create.points = displayPoints(state.points, state.timeframe, timeframe, bars);
  if (state.styles) create.styles = state.styles;
  return create;
}

/** What to hand to the chart to show a drawing of another study: it cannot be moved, and its lines are dashed. */
export function referenceOf(state: DrawingState, timeframe: string, bars: Bars): OverlayCreate {
  const create = overlayOf(state, timeframe, bars, false);
  create.id = `reference:${state.id}`;
  create.groupId = REFERENCE_GROUP;
  create.lock = true;
  create.extendData = { ...(create.extendData as DrawingData), reference: true };
  if (state.styles) create.styles = { ...state.styles, line: { ...(state.styles.line as object), style: 'dashed', dashedValue: [6, 4] } };
  return create;
}
