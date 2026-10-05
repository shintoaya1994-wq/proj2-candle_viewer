// Signals and touches on a chart. Unlike drawings they are records of their own; a chart only shows them.

import { registerOverlay, utils, type Coordinate, type OverlayCreate, type OverlayFigure } from 'klinecharts';

import type { Anchor, Shape, Status } from '../types';
import { hex, label } from './drawings';
import { displayPoints, type Bars } from './placement';

export const MARK_GROUP = 'mark';
export const SIGNAL_COLOR = '#7c3aed';
export const TOUCH_COLOR = '#0891b2';
const REJECTED_COLOR = '#94a3b8';

/** A touch as a dot below its signal. */
export interface TouchDot {
  id: string;
  studied: boolean;
  selected: boolean;
}

export interface SignalMark {
  kind: 'signal';
  id: string;
  shape: Shape;
  anchors: Anchor[];
  /** The timeframe the anchors were set on. */
  madeOn: string;
  tag: string;
  studied: boolean;
  status: Status;
  selected: boolean;
  /** Whether the shape can be moved on the chart. */
  editable: boolean;
  /** Whether a line at the price of the signal runs on to the right edge. */
  guide: boolean;
  /** Whether the chart has to hold bars back to the anchors. */
  reach: boolean;
  touches: TouchDot[];
}

export interface TouchMark {
  kind: 'touch';
  id: string;
  timestamp: number;
  value: number;
  madeOn: string;
  tag: string;
  selected: boolean;
}

export type Mark = SignalMark | TouchMark;

/** What of a mark the mouse is on. */
export interface MarkHit {
  mark: Mark;
  /** The touch, where the mouse is on one of the dots below a signal. */
  touch: string | null;
}

export const overlayId = (mark: Pick<Mark, 'kind' | 'id'>) => `${mark.kind}:${mark.id}`;

/** A mark travels with its overlay as a function: the chart library would merge an object into the one before. */
const carried = <M extends Mark>(data: unknown): M => (data as () => M)();

const FIXED = ['onPressedMoveStart', 'onPressedMoving', 'onPressedMoveEnd'] as const;
type Ignored = OverlayFigure['ignoreEvent'];

const DOT_RADIUS = 4;
const DOT_STEP = 11;
const Z_LEVEL: Record<Shape, number> = { box: 11, segment: 12, level: 13, point: 14 };

const colorOf = (mark: SignalMark) => (mark.status === 'rejected' ? REJECTED_COLOR : SIGNAL_COLOR);

export const textOf = (mark: Pick<SignalMark, 'tag' | 'studied'>) => mark.tag || (mark.studied ? '已评' : '未评');

interface Drawn {
  figures: OverlayFigure[];
  /** Where the label goes. */
  labelAt: Coordinate;
  /** Where the dots of the touches hang: the bar where the shape begins, and the lowest point of the shape there. */
  below: Coordinate;
}

function line(from: Coordinate, to: Coordinate, color: string, mark: SignalMark, ignoreEvent: Ignored, dashed = false): OverlayFigure {
  return {
    key: 'shape',
    type: 'line',
    attrs: { coordinates: [from, to] },
    styles: { color, size: mark.selected ? 2.5 : 1.5, style: dashed || mark.status === 'candidate' ? 'dashed' : 'solid', dashedValue: [6, 4] },
    ignoreEvent,
  };
}

function knob(at: Coordinate, color: string, mark: SignalMark, ignoreEvent: Ignored): OverlayFigure {
  return {
    key: 'shape',
    type: 'circle',
    attrs: { x: at.x, y: at.y, r: mark.selected ? 6.5 : 5 },
    styles: { style: 'stroke_fill', color: mark.studied ? color : '#ffffff', borderColor: color, borderSize: 2 },
    ignoreEvent,
  };
}

function shapeOf(mark: SignalMark, coordinates: Coordinate[], held: boolean[], width: number): Drawn | null {
  const [a, b] = coordinates;
  if (!a) return null;
  const color = colorOf(mark);
  const ignore: Ignored = mark.editable ? false : [...FIXED];
  const figures: OverlayFigure[] = [];
  const edge = { x: Math.max(width, a.x), y: a.y };

  if (mark.shape === 'point' || mark.shape === 'level') {
    // A point far back in time shows where it is asked for: as a line at its price.
    if (mark.shape === 'point' && !held[0] && !mark.guide) return null;
    if (mark.shape === 'level') figures.push(line(a, edge, color, mark, ignore));
    else if (mark.guide) figures.push({ ...line(held[0] ? a : { x: 0, y: a.y }, edge, hex(color, 0.7), mark, true, true), key: 'guide' });
    if (held[0]) figures.push(knob(a, color, mark, ignore));
    const x = held[0] ? a.x : 0;
    return { figures, labelAt: { x: Math.max(x, 0) + 9, y: a.y - 9 }, below: { x, y: a.y } };
  }
  if (!b) return null;
  if (mark.shape === 'segment') {
    // A line can only be drawn between bars the chart holds; a level line needs no more than its price.
    if (held[0] && held[1]) figures.push(line(a, b, color, mark, ignore));
    else if (a.y === b.y && (held[0] || held[1])) figures.push(line({ x: Math.min(a.x, b.x), y: a.y }, { x: Math.max(a.x, b.x), y: a.y }, color, mark, ignore));
    else return null;
    const left = a.x <= b.x ? a : b;
    return { figures, labelAt: { x: Math.max(left.x, 0) + 4, y: left.y - 6 }, below: { x: left.x, y: left.y } };
  }
  if (!held[0] && !held[1]) return null;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x, b.x);
  const bottom = Math.max(a.y, b.y);
  figures.push({
    key: 'fill',
    type: 'rect',
    attrs: { x, y, width: right - x, height: bottom - y },
    styles: { style: 'fill', color: hex(color, mark.selected ? 0.14 : 0.07) },
    ignoreEvent: true,
  });
  figures.push({
    key: 'shape',
    type: 'line',
    attrs: { coordinates: [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }, { x, y }] },
    styles: { color, size: mark.selected ? 2.5 : 1.5, style: mark.status === 'candidate' ? 'dashed' : 'solid', dashedValue: [6, 4] },
    ignoreEvent: ignore,
  });
  return { figures, labelAt: { x: Math.max(x, 0) + 3, y: y - 5 }, below: { x, y: bottom } };
}

/** Where a label begins so that all of it is on the chart. */
function inside(text: string, x: number, width: number): number {
  const needed = Math.ceil(utils.calcTextWidth(text, 12)) + 12;
  return Math.max(2, Math.min(x, width - needed));
}

let registered = false;

export function registerMarks(): void {
  if (registered) return;
  registered = true;

  registerOverlay({
    name: 'signalMark',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ chart, overlay, coordinates, bounding, xAxis, yAxis }) => {
      const mark = carried<SignalMark>(overlay.extendData);
      const bars = chart.getDataList();
      const first = bars[0]?.timestamp;
      const held = overlay.points.map((point) => first !== undefined && point.timestamp !== undefined && point.timestamp >= first);
      const drawn = shapeOf(mark, coordinates, held, bounding.width);
      if (!drawn) return [];
      const color = colorOf(mark);
      const ignore: Ignored = mark.editable ? false : [...FIXED];
      const figures = drawn.figures;
      const text = textOf(mark);
      figures.push({ ...label(text, inside(text, drawn.labelAt.x, bounding.width), drawn.labelAt.y, color, 'bottom', !mark.studied), key: 'label', ignoreEvent: ignore });

      if (mark.touches.length > 0 && xAxis && yAxis) {
        // The dots hang below the bar of the signal, clear of both the bar and the shape.
        const index = Math.round(xAxis.convertFromPixel(drawn.below.x));
        const bar = bars[index];
        const x = bar ? xAxis.convertToPixel(index) : drawn.below.x;
        const top = Math.max(drawn.below.y, bar ? yAxis.convertToPixel(bar.low) : drawn.below.y) + DOT_STEP;
        mark.touches.forEach((touch, position) => {
          figures.push({
            key: `touch:${touch.id}`,
            type: 'circle',
            attrs: { x, y: top + position * DOT_STEP, r: touch.selected ? DOT_RADIUS + 1.5 : DOT_RADIUS },
            styles: { style: 'stroke_fill', color: touch.studied ? TOUCH_COLOR : '#ffffff', borderColor: TOUCH_COLOR, borderSize: touch.selected ? 2.5 : 1.5 },
            ignoreEvent: [...FIXED],
          });
        });
      }
      return figures;
    },
  });

  registerOverlay({
    name: 'touchMark',
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates, bounding }) => {
      const [at] = coordinates;
      if (!at) return [];
      const mark = carried<TouchMark>(overlay.extendData);
      const size = mark.selected ? 8 : 6.5;
      const diamond = [{ x: at.x, y: at.y - size }, { x: at.x + size, y: at.y }, { x: at.x, y: at.y + size }, { x: at.x - size, y: at.y }];
      const text = mark.tag || '触及';
      return [
        { key: 'shape', type: 'polygon', attrs: { coordinates: diamond }, styles: { style: 'stroke_fill', color: hex(TOUCH_COLOR, 0.25), borderColor: TOUCH_COLOR, borderSize: 2 }, ignoreEvent: [...FIXED] },
        { ...label(text, inside(text, at.x + 10, bounding.width), at.y + 10, TOUCH_COLOR, 'top'), key: 'label', ignoreEvent: [...FIXED] },
      ];
    },
  });
}

/** What to hand to the chart to show a mark. */
export function overlayOfMark(mark: Mark, timeframe: string, bars: Bars): OverlayCreate {
  const anchors = mark.kind === 'signal' ? mark.anchors : [{ timestamp: mark.timestamp, value: mark.value }];
  return {
    id: overlayId(mark),
    name: mark.kind === 'signal' ? 'signalMark' : 'touchMark',
    groupId: MARK_GROUP,
    points: displayPoints(anchors, mark.madeOn, timeframe, bars),
    needDefaultPointFigure: mark.kind === 'signal' && mark.editable,
    zLevel: mark.kind === 'signal' ? Z_LEVEL[mark.shape] : 15,
    fixedZLevel: true,
    mode: 'weak_magnet',
    modeSensitivity: 12,
    styles: { point: { color: SIGNAL_COLOR, borderColor: hex(SIGNAL_COLOR, 0.35), activeColor: SIGNAL_COLOR, activeBorderColor: hex(SIGNAL_COLOR, 0.35) } },
    extendData: () => mark,
  };
}

/** The mark an overlay shows; null for an overlay that is a drawing. */
export function markOf(overlay: { groupId: string; extendData: unknown }): Mark | null {
  return overlay.groupId === MARK_GROUP ? carried<Mark>(overlay.extendData) : null;
}

/** What the mouse is on, from the figure the chart library names. */
export function hitOf(mark: Mark, figure: string | undefined): MarkHit {
  return { mark, touch: figure?.startsWith('touch:') ? figure.slice('touch:'.length) : null };
}

/** The anchors of a shape as the chart holds them after the user moved it. */
export function anchorsOf(points: Array<{ timestamp?: number; value?: number }>): Anchor[] | null {
  const anchors: Anchor[] = [];
  for (const point of points) {
    if (point.timestamp === undefined || point.value === undefined) return null;
    anchors.push({ timestamp: point.timestamp, value: point.value });
  }
  return anchors;
}

/** Earliest anchor of the marks the chart has to hold bars for. */
export function earliestMark(marks: Mark[]): number | null {
  let found: number | null = null;
  for (const mark of marks) {
    if (mark.kind !== 'signal' || !mark.reach) continue;
    for (const anchor of mark.anchors) if (found === null || anchor.timestamp < found) found = anchor.timestamp;
  }
  return found;
}
