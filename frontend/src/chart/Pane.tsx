import { dispose, init, utils, type Chart, type Crosshair, type Overlay, type OverlayCreate, type OverlayEvent } from 'klinecharts';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { barStart, timeframe as timeframeInfo } from '../timeframes';
import type { Anchor, DrawingData, DrawingState, IndicatorState, SymbolInfo, ViewState } from '../types';
import type { DrawingBoard } from './board';
import { DRAWING_GROUP, WITH_TEXT, magnetMode, newDrawing, overlayOf, registerDrawings, stateOf } from './drawings';
import { applyIndicators, CANDLE_PANE } from './indicators';
import { createLoader } from './loader';
import { MARK_GROUP, anchorsOf, earliestMark, hitOf, markOf, overlayId, overlayOfMark, registerMarks, type Mark, type MarkHit, type SignalMark } from './marks';
import { NO_BARS, barsOf, displayPoints, displayTime, earliest, floorIndex, type Bars } from './placement';

/** What a chart starts from. */
export interface PaneStart {
  view: ViewState;
  /** The moment to put in the middle where the view does not say where to look. */
  focus: number | null;
  /**
   * The mark to put in the middle instead, by the id of its overlay. A mark
   * has its place on every timeframe: the high of a day is at the start of
   * the day on daily bars, and hours later on hourly ones.
   */
  mark?: string | null;
}

export interface PaneSnapshot {
  view: ViewState;
  /** Time in the middle of the view. */
  center: number | null;
  /** Times at the left and the right edge of the view. */
  range: [number, number] | null;
}

/** What the next clicks on the chart draw. */
export interface Armed {
  tool: string;
  color: string;
}

export interface Selection {
  id: string;
  /** Tells a drawing the user clicked from one that is selected because it was just drawn. */
  picked: boolean;
  pane: string;
}

export interface Place {
  x: number;
  y: number;
}

export interface PaneHandle {
  snapshot(): PaneSnapshot;
  screenshot(): string;
  /** Puts a moment in the middle of the view, loading other bars where needed. */
  lookAt(time: number): void;
  /** Shows the moment another chart points at; null takes the line away. */
  pointAt(time: number | null): void;
  bars(): number;
  /** Width of the part of the chart that shows the bars, without the price axis. */
  width(): number;
  /** Pixel positions of the anchors of a drawing or a mark; for tests. */
  pixelsOf(id: string): Place[];
  /** The figures of a mark by their keys, as pixel positions of their middles; for tests. */
  figuresOf(id: string): Record<string, Place>;
  /** The bar at a horizontal position, and where its high and its low are drawn; for tests. */
  barAt(x: number): (Place & { timestamp: number; high: number; low: number; highY: number; lowY: number }) | null;
}

interface Props {
  /** Names the chart among the charts of a window. */
  paneKey: string;
  symbol: SymbolInfo;
  timeframe: string;
  timezone: string;
  indicators: IndicatorState[];
  board: DrawingBoard;
  start: PaneStart;
  /** Changes when the chart has to start anew. */
  startKey: string;
  marks: Mark[];
  armed: Armed | null;
  magnet: boolean;
  onDirty?(): void;
  onSelect?(selection: Selection | null, pane: string): void;
  /** A drawing was finished. Returning false takes it off the chart again: it was a gesture, not a drawing. */
  onDrawn?(drawing: DrawingState, pane: string): boolean | void;
  onTextRequest?(id: string, text: string): void;
  onLoaded?(bars: number, pane: string): void;
  onLoadError?(message: string): void;
  onMarkClick?(hit: MarkHit): void;
  onMarkMenu?(hit: MarkHit, at: Place): void;
  onMarkHover?(hit: MarkHit | null, at: Place | null): void;
  /** The user moved a shape; the anchors are on the timeframe of this chart. */
  onMarkMoved?(mark: SignalMark, anchors: Anchor[], timeframe: string): void;
  /** The moment below the mouse; null when the mouse has left. */
  onPoint?(time: number | null, pane: string): void;
}

/** What to do with the view once the first bars of a series have arrived. */
type Pending = { kind: 'restore'; view: ViewState; focus: number | null; mark: string | null } | { kind: 'center'; time: number } | null;

/** Empty space kept to the right of the last bar when the view is placed at the end of the data, in bars. */
const ROOM_AFTER_LAST_BAR = 6;
/** A crosshair that belongs to no part of the chart shows its vertical line only. */
const POINTED = 'pointed';
/**
 * Width of the price axis. Left to itself the chart library fits the axis to
 * the prices in view and never lets it shrink again, so that the width of a
 * chart depends on where it has been. With a width of its own the charts of
 * a window line up, and a view that is saved comes back as it was.
 */
const AXIS_WIDTH = 70;
const AXIS_ROOM = 26;

export const Pane = forwardRef<PaneHandle, Props>(function Pane(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const bars = useRef<Bars>(NO_BARS);
  const pending = useRef<Pending>(null);
  const selected = useRef<string | null>(null);
  const picked = useRef(false);
  const drawnAt = useRef(0);
  const drawing = useRef<string | null>(null);
  const shown = useRef(new Set<string>());
  /**
   * The moment the user is looking at, where the view itself does not tell:
   * after the view was placed by the program, the middle of it may be a bar
   * off, or far off where the view was held back at the end of the data.
   * Null after the user has moved the view; then the middle of the view counts.
   */
  const focus = useRef<number | null>(null);
  const placing = useRef(false);
  const quiet = useRef(false);
  const loaded = useRef(false);
  /** Whether the chart holds the bars up to the end of the data, and whether it shows the line of the last price. */
  const atEnd = useRef(false);
  const lastPrice = useRef<boolean | null>(null);
  const latest = useRef(props);
  latest.current = props;

  /** Changes the chart without the chart reporting the change as one the user made. */
  function quietly(action: () => void) {
    quiet.current = true;
    try {
      action();
    } finally {
      quiet.current = false;
    }
  }

  function select(id: string | null) {
    selected.current = id;
    if (id === null) picked.current = false;
    const { paneKey } = latest.current;
    latest.current.onSelect?.(id === null ? null : { id, picked: picked.current, pane: paneKey }, paneKey);
  }

  function commit(overlay: Overlay<unknown>) {
    const { board, timeframe, symbol, paneKey } = latest.current;
    board.put(stateOf(overlay, timeframe, symbol.name), paneKey);
    latest.current.onDirty?.();
    if (selected.current === overlay.id) select(overlay.id);
  }

  const drawingHandlers: Partial<OverlayCreate> = {
    onDrawEnd: (event: OverlayEvent<unknown>) => {
      const { board, timeframe, symbol, paneKey } = latest.current;
      drawing.current = null;
      picked.current = false;
      drawnAt.current = performance.now();
      const state = stateOf(event.overlay, timeframe, symbol.name);
      if (latest.current.onDrawn?.(state, paneKey) === false) {
        quietly(() => event.chart.removeOverlay({ id: state.id }));
        return;
      }
      board.put(state, paneKey);
      latest.current.onDirty?.();
      if (state.name === 'note') latest.current.onTextRequest?.(state.id, '');
    },
    onPressedMoveEnd: (event: OverlayEvent<unknown>) => commit(event.overlay),
    onRemoved: (event: OverlayEvent<unknown>) => {
      if (quiet.current) return;
      const { board, paneKey } = latest.current;
      if (drawing.current === event.overlay.id) drawing.current = null;
      if (selected.current === event.overlay.id) select(null);
      if (board.remove(event.overlay.id, paneKey)) latest.current.onDirty?.();
    },
    onSelected: (event: OverlayEvent<unknown>) => {
      if (latest.current.board.get(event.overlay.id)) select(event.overlay.id);
    },
    onClick: (event: OverlayEvent<unknown>) => {
      // The click that finishes a drawing lands on the drawing; it is not a choice of the user.
      if (performance.now() - drawnAt.current < 400) return;
      if (drawing.current === event.overlay.id || !latest.current.board.get(event.overlay.id)) return;
      picked.current = true;
      select(event.overlay.id);
    },
    onDeselected: (event: OverlayEvent<unknown>) => {
      if (selected.current === event.overlay.id) select(null);
    },
    onDoubleClick: (event: OverlayEvent<unknown>) => {
      if (!WITH_TEXT.has(event.overlay.name)) return;
      const data = (event.overlay.extendData ?? {}) as DrawingData;
      latest.current.onTextRequest?.(event.overlay.id, data.text ?? '');
    },
  };

  const at = (event: OverlayEvent<unknown>): Place => ({ x: event.pageX ?? 0, y: event.pageY ?? 0 });

  const markHandlers: Partial<OverlayCreate> = {
    onClick: (event: OverlayEvent<unknown>) => {
      const mark = markOf(event.overlay);
      if (mark) latest.current.onMarkClick?.(hitOf(mark, event.figure?.key));
    },
    onRightClick: (event: OverlayEvent<unknown>) => {
      // Without this the chart library removes what is clicked with the right button.
      event.preventDefault?.();
      const mark = markOf(event.overlay);
      if (mark) latest.current.onMarkMenu?.(hitOf(mark, event.figure?.key), at(event));
    },
    onMouseMove: (event: OverlayEvent<unknown>) => {
      const mark = markOf(event.overlay);
      if (mark) latest.current.onMarkHover?.(hitOf(mark, event.figure?.key), at(event));
    },
    onMouseLeave: () => latest.current.onMarkHover?.(null, null),
    onPressedMoveEnd: (event: OverlayEvent<unknown>) => {
      const mark = markOf(event.overlay);
      const anchors = anchorsOf(event.overlay.points);
      if (mark?.kind === 'signal' && mark.editable && anchors) latest.current.onMarkMoved?.(mark, anchors, latest.current.timeframe);
    },
  };

  function show(chart: Chart, state: DrawingState) {
    const { timeframe, magnet } = latest.current;
    chart.createOverlay({ ...overlayOf(state, timeframe, bars.current, magnet), ...drawingHandlers });
  }

  /** Makes the chart show the marks it is given, and no others. */
  function showMarks(chart: Chart) {
    const { marks, timeframe } = latest.current;
    const wanted = new Map(marks.map((mark) => [overlayId(mark), mark]));
    quietly(() => {
      for (const id of shown.current) if (!wanted.has(id)) chart.removeOverlay({ id });
    });
    for (const [id, mark] of wanted) {
      const create = { ...overlayOfMark(mark, timeframe, bars.current), ...markHandlers };
      if (shown.current.has(id)) chart.overrideOverlay(create);
      else chart.createOverlay(create);
    }
    shown.current = new Set(wanted.keys());
  }

  function startDrawing(chart: Chart, armed: Armed) {
    const state = newDrawing(armed.tool, armed.color, latest.current.symbol.name);
    drawing.current = state.id;
    show(chart, state);
  }

  function cancelDrawing(chart: Chart) {
    if (drawing.current === null) return;
    const id = drawing.current;
    drawing.current = null;
    quietly(() => chart.removeOverlay({ id }));
  }

  function width(chart: Chart): number {
    return chart.getSize(CANDLE_PANE, 'main')?.width ?? 0;
  }

  /** Puts a moment in the middle of the view, but does not push the last bar away from the right edge. */
  function centerOn(chart: Chart, time: number) {
    const stamps = bars.current.stamps;
    const middle = Math.max(0, floorIndex(stamps, barStart(time, latest.current.timeframe)));
    const half = Math.floor(width(chart) / chart.getBarSpace().bar / 2);
    chart.scrollToDataIndex(Math.min(middle + half, stamps.length - 1 + ROOM_AFTER_LAST_BAR));
  }

  /** The bar in the middle of a mark as the chart shows it; null for a mark the chart does not hold. */
  function middleOfMark(chart: Chart, id: string | null): number | null {
    const [overlay] = id === null ? [] : chart.getOverlays({ id });
    const stamps = bars.current.stamps;
    const places = (overlay?.points ?? []).flatMap((point) => (point.timestamp === undefined ? [] : [floorIndex(stamps, point.timestamp)]));
    if (places.length === 0 || places.some((place) => place < 0)) return null;
    return stamps[Math.round((Math.min(...places) + Math.max(...places)) / 2)] ?? null;
  }

  function placeView(chart: Chart) {
    const plan = pending.current;
    const stamps = bars.current.stamps;
    pending.current = null;
    if (plan === null || stamps.length === 0) return;
    let looked: number | null = null;
    placing.current = true;
    if (plan.kind === 'center') {
      looked = plan.time;
      centerOn(chart, plan.time);
    } else if (plan.view.rightTimestamp !== null) {
      chart.scrollToDataIndex(Math.max(0, floorIndex(stamps, plan.view.rightTimestamp)));
      if (plan.view.offsetRight) chart.scrollByDistance(-plan.view.offsetRight);
    } else {
      looked = middleOfMark(chart, plan.mark) ?? plan.focus;
      if (looked !== null) centerOn(chart, looked);
    }
    placing.current = false;
    focus.current = looked;
  }

  function timeAt(chart: Chart, x: number): number | undefined {
    const [point] = chart.convertFromPixel([{ x, y: 0 }], { paneId: CANDLE_PANE }) as Array<{ timestamp?: number }>;
    return point?.timestamp;
  }

  function currentView(chart: Chart): PaneSnapshot {
    const list = chart.getDataList();
    const space = chart.getBarSpace().bar;
    const total = width(chart);
    const nothing: PaneSnapshot = { view: { barSpace: space, offsetRight: null, rightTimestamp: null }, center: null, range: null };
    if (list.length === 0 || total === 0) return nothing;
    const [edge] = chart.convertFromPixel([{ x: total - 1, y: 0 }], { paneId: CANDLE_PANE }) as Array<{ dataIndex?: number }>;
    const bar = list[Math.min(list.length - 1, Math.max(0, edge?.dataIndex ?? list.length - 1))];
    if (!bar) return nothing;
    const [pixel] = chart.convertToPixel([{ timestamp: bar.timestamp, value: bar.close }], { paneId: CANDLE_PANE }) as Array<{ x?: number }>;
    const offset = total - (pixel?.x ?? total) - space / 2;
    const left = timeAt(chart, 0);
    const right = timeAt(chart, total - 1);
    return {
      view: { barSpace: space, offsetRight: Math.round(offset * 100) / 100, rightTimestamp: bar.timestamp },
      center: timeAt(chart, total / 2) ?? null,
      range: left === undefined || right === undefined ? null : [left, right],
    };
  }

  /**
   * The line of the last price is drawn at the close of the last bar the
   * chart holds. It says where the market is only if that bar is the last of
   * the data, and it belongs to the view only while that bar is in view.
   */
  function showLastPrice(chart: Chart) {
    const wanted = atEnd.current && chart.getVisibleRange().to >= chart.getDataList().length;
    if (wanted === lastPrice.current) return;
    lastPrice.current = wanted;
    chart.setStyles({ candle: { priceMark: { last: { show: wanted } } } });
  }

  /** Makes the price axis wide enough for the prices of the symbol. */
  function fitAxis(chart: Chart) {
    const highest = bars.current.highs.reduce((most, high) => Math.max(most, high), 0);
    const written = utils.formatPrecision(highest, latest.current.symbol.digits);
    chart.setStyles({ yAxis: { size: Math.max(AXIS_WIDTH, Math.ceil(utils.calcTextWidth(written, 12)) + AXIS_ROOM) } });
  }

  /** Everything anew on the bars of a series that has just arrived. */
  function rebuild(chart: Chart) {
    const { board, symbol, indicators, armed } = latest.current;
    fitAxis(chart);
    quietly(() => {
      chart.removeOverlay({ groupId: DRAWING_GROUP });
      chart.removeOverlay({ groupId: MARK_GROUP });
    });
    shown.current = new Set();
    drawing.current = null;
    for (const state of board.of(symbol.name)) show(chart, state);
    showMarks(chart);
    placeView(chart);
    applyIndicators(chart, indicators);
    if (selected.current !== null) select(null);
    if (armed) startDrawing(chart, armed);
  }

  /** More bars have arrived: what was anchored outside the bars held before can now be placed. */
  function replace(chart: Chart) {
    const { board, symbol, timeframe } = latest.current;
    for (const state of board.of(symbol.name)) {
      if (state.id !== drawing.current) chart.overrideOverlay({ id: state.id, points: displayPoints(state.points, state.timeframe, timeframe, bars.current) });
    }
    showMarks(chart);
  }

  const title = (name: string) => `{ticker} · ${timeframeInfo(name).title}`;

  // A chart for every start: created when a study is opened, disposed when it is left.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    registerDrawings();
    registerMarks();
    const { start, symbol, timeframe, timezone, paneKey } = latest.current;
    const chart = init(element, { timezone, locale: 'zh-CN' });
    if (!chart) return;
    chartRef.current = chart;
    loaded.current = false;
    atEnd.current = false;
    lastPrice.current = null;
    bars.current = NO_BARS;
    shown.current = new Set();
    pending.current = { kind: 'restore', view: start.view, focus: start.focus, mark: start.mark ?? null };
    selected.current = null;
    drawing.current = null;
    focus.current = null;

    // The prices of a bar show while the mouse points at one; without the mouse they would be those of the last bar held.
    chart.setStyles({ yAxis: { size: AXIS_WIDTH }, candle: { tooltip: { showRule: 'follow_cross', title: { template: title(timeframe) } } } });
    // What the user scrolls or zooms to is what they are looking at.
    const looked = () => {
      if (!placing.current) focus.current = null;
    };
    chart.subscribeAction('onScroll', looked);
    chart.subscribeAction('onZoom', looked);
    chart.subscribeAction('onVisibleRangeChange', () => showLastPrice(chart));
    chart.subscribeAction('onCrosshairChange', (data) => {
      const crosshair = (data ?? {}) as Crosshair;
      if (crosshair.paneId === POINTED || crosshair.x === undefined) return;
      const time = timeAt(chart, crosshair.x);
      if (time !== undefined) latest.current.onPoint?.(time, paneKey);
    });
    const left = () => {
      latest.current.onPoint?.(null, paneKey);
      latest.current.onMarkHover?.(null, null);
    };
    element.addEventListener('mouseleave', left);

    if (start.view.barSpace) chart.setBarSpace(start.view.barSpace);
    chart.setSymbol({ ticker: symbol.name.toUpperCase(), pricePrecision: symbol.digits, volumePrecision: 2 });
    chart.setPeriod(timeframeInfo(timeframe).period);
    chart.setDataLoader(
      createLoader({
        series: () => ({ symbol: latest.current.symbol.name, timeframe: latest.current.timeframe }),
        anchor: () => {
          const plan = pending.current;
          const around = plan === null ? null : plan.kind === 'center' ? plan.time : (plan.view.rightTimestamp ?? plan.focus);
          const drawn = earliest(latest.current.board.of(latest.current.symbol.name));
          const marked = earliestMark(latest.current.marks);
          return { around, since: drawn === null ? marked : marked === null ? drawn : Math.min(drawn, marked) };
        },
        onLoaded: (first, latestHeld) => {
          if (chartRef.current !== chart) return;
          atEnd.current = latestHeld;
          bars.current = barsOf(chart.getDataList());
          if (first) {
            rebuild(chart);
            loaded.current = true;
          } else {
            replace(chart);
          }
          showLastPrice(chart);
          latest.current.onLoaded?.(bars.current.stamps.length, paneKey);
        },
        onError: (error) => latest.current.onLoadError?.(error instanceof Error ? error.message : String(error)),
      }),
    );

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.removeEventListener('mouseleave', left);
      chartRef.current = null;
      dispose(element);
    };
    // The chart is made anew only for another start; the other props have effects of their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.startKey]);

  // Another series: the same drawings and the same moment in time on other bars.
  const series = useRef({ symbol: props.symbol.name, timeframe: props.timeframe });
  useEffect(() => {
    const chart = chartRef.current;
    const before = series.current;
    series.current = { symbol: props.symbol.name, timeframe: props.timeframe };
    if (!chart || (before.symbol === props.symbol.name && before.timeframe === props.timeframe)) return;
    const time = focus.current ?? currentView(chart).center;
    if (loaded.current && time !== null) pending.current = { kind: 'center', time };
    loaded.current = false;
    chart.setStyles({ candle: { tooltip: { title: { template: title(props.timeframe) } } } });
    if (before.symbol !== props.symbol.name) chart.setSymbol({ ticker: props.symbol.name.toUpperCase(), pricePrecision: props.symbol.digits, volumePrecision: 2 });
    if (before.timeframe !== props.timeframe) chart.setPeriod(timeframeInfo(props.timeframe).period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.symbol.name, props.timeframe, props.startKey]);

  useEffect(() => {
    chartRef.current?.setTimezone(props.timezone);
  }, [props.timezone, props.startKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart && loaded.current) applyIndicators(chart, props.indicators);
  }, [props.indicators, props.startKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart && loaded.current) showMarks(chart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.marks, props.startKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !loaded.current) return;
    chart.overrideOverlay({ groupId: DRAWING_GROUP, mode: magnetMode(props.magnet) });
    cancelDrawing(chart);
    if (props.armed) startDrawing(chart, props.armed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.armed, props.magnet, props.startKey]);

  // What another chart of the window changes shows here too.
  useEffect(() => {
    const { board, paneKey } = props;
    return board.subscribe((event) => {
      const chart = chartRef.current;
      if (!chart || !loaded.current) return;
      if (event.kind === 'reset') {
        rebuild(chart);
        return;
      }
      if (event.source === paneKey) return;
      if (event.kind === 'remove') {
        quietly(() => chart.removeOverlay({ id: event.id }));
        if (selected.current === event.id) select(null);
        return;
      }
      const state = event.drawing;
      const here = chart.getOverlays({ id: state.id }).length > 0;
      if (state.symbol !== null && state.symbol !== latest.current.symbol.name) {
        if (here) quietly(() => chart.removeOverlay({ id: state.id }));
      } else if (here) {
        const { id, points, styles, extendData, lock, visible } = overlayOf(state, latest.current.timeframe, bars.current, latest.current.magnet);
        const override: Partial<OverlayCreate> = { id, lock, visible, extendData };
        if (points) override.points = points;
        if (styles) override.styles = styles;
        chart.overrideOverlay(override);
      } else {
        show(chart, state);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.board, props.paneKey]);

  useImperativeHandle(ref, () => ({
    snapshot() {
      const chart = chartRef.current;
      return chart ? currentView(chart) : { view: { barSpace: null, offsetRight: null, rightTimestamp: null }, center: null, range: null };
    },
    screenshot() {
      return chartRef.current?.getConvertPictureUrl(true, 'png', '#ffffff') ?? '';
    },
    lookAt(time) {
      const chart = chartRef.current;
      if (!chart) return;
      const stamps = bars.current.stamps;
      const first = stamps[0];
      const last = stamps[stamps.length - 1];
      if (loaded.current && first !== undefined && last !== undefined && time >= first && time <= last) {
        // Bars on both sides are needed to put the moment in the middle; near the ends of what is held, others are fetched.
        const index = floorIndex(stamps, time);
        const half = Math.ceil(width(chart) / chart.getBarSpace().bar / 2);
        if (index - half >= 0 || stamps.length < half) {
          placing.current = true;
          centerOn(chart, time);
          placing.current = false;
          focus.current = time;
          return;
        }
      }
      pending.current = { kind: 'center', time };
      loaded.current = false;
      chart.resetData();
    },
    pointAt(time) {
      const chart = chartRef.current;
      if (!chart || !loaded.current) return;
      if (time === null) {
        chart.executeAction('onCrosshairChange', undefined as unknown as Crosshair);
        return;
      }
      const shownAt = displayTime(time, latest.current.timeframe, bars.current.stamps);
      const [pixel] = chart.convertToPixel([{ timestamp: shownAt }], { paneId: CANDLE_PANE }) as Array<{ x?: number }>;
      // A moment outside the view has no place on the chart; a line at the edge would point at another moment.
      if (pixel?.x === undefined || pixel.x < 0 || pixel.x > width(chart)) chart.executeAction('onCrosshairChange', undefined as unknown as Crosshair);
      else chart.executeAction('onCrosshairChange', { x: pixel.x, y: 0, paneId: POINTED });
    },
    bars() {
      return loaded.current ? bars.current.stamps.length : 0;
    },
    width() {
      return chartRef.current ? width(chartRef.current) : 0;
    },
    pixelsOf(id) {
      const chart = chartRef.current;
      const [overlay] = chart?.getOverlays({ id }) ?? [];
      if (!chart || !overlay) return [];
      const pixels = chart.convertToPixel(overlay.points, { paneId: CANDLE_PANE }) as Array<{ x?: number; y?: number }>;
      return pixels.map((pixel) => ({ x: pixel.x ?? NaN, y: pixel.y ?? NaN }));
    },
    figuresOf(id) {
      const chart = chartRef.current;
      const [overlay] = chart?.getOverlays({ id }) ?? [];
      const bounding = chart?.getSize(CANDLE_PANE, 'main');
      if (!chart || !overlay || !overlay.createPointFigures || !bounding) return {};
      const coordinates = (chart.convertToPixel(overlay.points, { paneId: CANDLE_PANE }) as Array<{ x?: number; y?: number }>).map((pixel) => ({ x: pixel.x ?? 0, y: pixel.y ?? 0 }));
      // The axes are not part of what the chart library promises; without them a mark is drawn without its dots.
      const inner = chart as unknown as { getXAxisPane?(): { getXAxisComponent(): unknown }; getDrawPaneById?(id: string): { getYAxisComponentById(): unknown } | null };
      const made = overlay.createPointFigures({
        chart,
        overlay,
        coordinates,
        bounding,
        xAxis: (inner.getXAxisPane?.().getXAxisComponent() ?? null) as never,
        yAxis: (inner.getDrawPaneById?.(CANDLE_PANE)?.getYAxisComponentById() ?? null) as never,
      });
      const places: Record<string, Place> = {};
      for (const figure of Array.isArray(made) ? made : [made]) {
        if (!figure.key) continue;
        const attrs = figure.attrs as { x?: number; y?: number; coordinates?: Place[] };
        if (attrs.coordinates && attrs.coordinates.length > 0) {
          const [first, second] = attrs.coordinates;
          if (first) places[figure.key] = second && figure.type === 'line' ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first;
        } else if (attrs.x !== undefined && attrs.y !== undefined) {
          places[figure.key] = { x: attrs.x, y: attrs.y };
        }
      }
      return places;
    },
    barAt(x) {
      const chart = chartRef.current;
      if (!chart) return null;
      const [point] = chart.convertFromPixel([{ x, y: 0 }], { paneId: CANDLE_PANE }) as Array<{ dataIndex?: number }>;
      const bar = point?.dataIndex === undefined ? undefined : chart.getDataList()[point.dataIndex];
      if (!bar) return null;
      const [high, low] = chart.convertToPixel([{ timestamp: bar.timestamp, value: bar.high }, { timestamp: bar.timestamp, value: bar.low }], { paneId: CANDLE_PANE }) as Array<{ x?: number; y?: number }>;
      return { timestamp: bar.timestamp, high: bar.high, low: bar.low, x: high?.x ?? NaN, y: high?.y ?? NaN, highY: high?.y ?? NaN, lowY: low?.y ?? NaN };
    },
  }));

  return <div ref={container} className="chart" data-testid={`chart-${props.paneKey}`} />;
});
