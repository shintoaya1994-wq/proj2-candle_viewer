import { dispose, init, type Chart, type Overlay, type OverlayCreate, type OverlayEvent } from 'klinecharts';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { barStart, timeframe as timeframeInfo } from '../timeframes';
import type { DrawingData, DrawingState, IndicatorState, SymbolInfo, ViewState } from '../types';
import { DRAWING_GROUP, WITH_TEXT, newDrawing, overlayOf, registerDrawings, stateOf, stylesFor } from './drawings';
import { applyIndicators, CANDLE_PANE } from './indicators';
import { createLoader } from './loader';
import { earliest, floorIndex } from './placement';

/** What a chart starts from when a study is opened. */
export interface ChartSetup {
  drawings: DrawingState[];
  view: ViewState;
  focus: number | null;
}

export interface ChartSnapshot {
  drawings: DrawingState[];
  view: ViewState;
  /** Time in the middle of the view. */
  center: number | null;
  /** Times at the left and the right edge of the view. */
  range: [number, number] | null;
}

export interface ChartHandle {
  snapshot(): ChartSnapshot;
  screenshot(): string;
  startDrawing(tool: string, color: string): void;
  cancelDrawing(): void;
  removeSelected(): void;
  recolor(color: string): void;
  setText(id: string, text: string | null): void;
  /** Pixel positions of the anchors of a drawing; for tests of save and reopen. */
  pixelsOf(id: string): Array<{ x: number; y: number }>;
}

interface Props {
  symbol: SymbolInfo;
  timeframe: string;
  timezone: string;
  indicators: IndicatorState[];
  setup: ChartSetup;
  /** Changes when the chart has to start anew: another study or another symbol. */
  setupKey: string;
  onDirty(): void;
  /** `picked` tells a drawing the user clicked from one that is selected because it was just drawn. */
  onSelect(drawing: DrawingState | null, picked: boolean): void;
  onDrawn(): void;
  onTextRequest(id: string, text: string): void;
  onLoaded(bars: number): void;
  onLoadError(message: string): void;
}

/** What to do with the view once the first bars of a series have arrived. */
type Pending = { kind: 'restore'; view: ViewState; focus: number | null } | { kind: 'center'; time: number } | null;

/** Empty space kept to the right of the last bar when the view is placed at the end of the data, in bars. */
const ROOM_AFTER_LAST_BAR = 6;

export const ChartView = forwardRef<ChartHandle, Props>(function ChartView(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const states = useRef(new Map<string, DrawingState>());
  const pending = useRef<Pending>(null);
  const selected = useRef<string | null>(null);
  const picked = useRef(false);
  const drawnAt = useRef(0);
  const drawing = useRef<string | null>(null);
  /**
   * The moment the user is looking at, where the view itself does not tell:
   * after the view was placed by the program, the middle of it may be a bar
   * off, or far off where the view was held back at the end of the data.
   * Null after the user has moved the view; then the middle of the view counts.
   */
  const focus = useRef<number | null>(null);
  const placing = useRef(false);
  const rebuilding = useRef(false);
  const loaded = useRef(false);
  const latest = useRef(props);
  latest.current = props;

  const stamps = (chart: Chart) => chart.getDataList().map((bar) => bar.timestamp);

  function select(id: string | null) {
    selected.current = id;
    if (id === null) picked.current = false;
    latest.current.onSelect(id === null ? null : (states.current.get(id) ?? null), picked.current);
  }

  function commit(overlay: Overlay<unknown>) {
    states.current.set(overlay.id, stateOf(overlay, latest.current.timeframe));
    latest.current.onDirty();
    if (selected.current === overlay.id) select(overlay.id);
  }

  const handlers: Partial<OverlayCreate> = {
    onDrawEnd: (event: OverlayEvent<unknown>) => {
      drawing.current = null;
      picked.current = false;
      drawnAt.current = performance.now();
      commit(event.overlay);
      latest.current.onDrawn();
      if (event.overlay.name === 'note') latest.current.onTextRequest(event.overlay.id, '');
    },
    onPressedMoveEnd: (event: OverlayEvent<unknown>) => commit(event.overlay),
    onRemoved: (event: OverlayEvent<unknown>) => {
      if (rebuilding.current) return;
      const known = states.current.delete(event.overlay.id);
      if (drawing.current === event.overlay.id) drawing.current = null;
      if (selected.current === event.overlay.id) select(null);
      if (known) latest.current.onDirty();
    },
    onSelected: (event: OverlayEvent<unknown>) => select(event.overlay.id),
    onClick: (event: OverlayEvent<unknown>) => {
      // The click that finishes a drawing lands on the drawing; it is not a choice of the user.
      if (performance.now() - drawnAt.current < 400) return;
      if (drawing.current === event.overlay.id || !states.current.has(event.overlay.id)) return;
      picked.current = true;
      select(event.overlay.id);
    },
    onDeselected: (event: OverlayEvent<unknown>) => {
      if (selected.current === event.overlay.id) select(null);
    },
    onDoubleClick: (event: OverlayEvent<unknown>) => {
      if (!WITH_TEXT.has(event.overlay.name)) return;
      const data = (event.overlay.extendData ?? {}) as DrawingData;
      latest.current.onTextRequest(event.overlay.id, data.text ?? '');
    },
  };

  function show(chart: Chart, state: DrawingState, bars: number[]) {
    chart.createOverlay({ ...overlayOf(state, latest.current.timeframe, bars), ...handlers });
  }

  function width(chart: Chart): number {
    return chart.getSize(CANDLE_PANE, 'main')?.width ?? 0;
  }

  /** Puts a moment in the middle of the view, but does not push the last bar away from the right edge. */
  function centerOn(chart: Chart, bars: number[], time: number) {
    const middle = Math.max(0, floorIndex(bars, barStart(time, latest.current.timeframe)));
    const half = Math.floor(width(chart) / chart.getBarSpace().bar / 2);
    chart.scrollToDataIndex(Math.min(middle + half, bars.length - 1 + ROOM_AFTER_LAST_BAR));
  }

  function placeView(chart: Chart, bars: number[]) {
    const plan = pending.current;
    pending.current = null;
    if (plan === null || bars.length === 0) return;
    placing.current = true;
    if (plan.kind === 'center') {
      centerOn(chart, bars, plan.time);
    } else if (plan.view.rightTimestamp !== null) {
      chart.scrollToDataIndex(Math.max(0, floorIndex(bars, plan.view.rightTimestamp)));
      if (plan.view.offsetRight) chart.scrollByDistance(-plan.view.offsetRight);
    } else if (plan.focus !== null) {
      centerOn(chart, bars, plan.focus);
    }
    placing.current = false;
    focus.current = plan.kind === 'center' ? plan.time : null;
  }

  function currentView(chart: Chart): ViewState & Pick<ChartSnapshot, 'center' | 'range'> {
    const bars = chart.getDataList();
    const space = chart.getBarSpace().bar;
    const total = width(chart);
    const nothing = { barSpace: space, offsetRight: null, rightTimestamp: null, center: null, range: null };
    if (bars.length === 0 || total === 0) return nothing;
    const at = (x: number) => {
      const [point] = chart.convertFromPixel([{ x, y: 0 }], { paneId: CANDLE_PANE }) as Array<{ dataIndex?: number; timestamp?: number }>;
      return point;
    };
    const edge = Math.min(bars.length - 1, Math.max(0, at(total - 1)?.dataIndex ?? bars.length - 1));
    const bar = bars[edge];
    if (!bar) return nothing;
    const [pixel] = chart.convertToPixel([{ timestamp: bar.timestamp, value: bar.close }], { paneId: CANDLE_PANE }) as Array<{ x?: number }>;
    const offset = total - (pixel?.x ?? total) - space / 2;
    const left = at(0)?.timestamp;
    const right = at(total - 1)?.timestamp;
    return {
      barSpace: space,
      offsetRight: Math.round(offset * 100) / 100,
      rightTimestamp: bar.timestamp,
      center: at(total / 2)?.timestamp ?? null,
      range: left === undefined || right === undefined ? null : [left, right],
    };
  }

  function rebuild(chart: Chart) {
    const bars = stamps(chart);
    rebuilding.current = true;
    chart.removeOverlay({ groupId: DRAWING_GROUP });
    rebuilding.current = false;
    drawing.current = null;
    for (const state of states.current.values()) show(chart, state, bars);
    placeView(chart, bars);
    applyIndicators(chart, latest.current.indicators);
    if (selected.current !== null) select(null);
  }

  // A chart for every study: created when the study is opened, disposed when it is left.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    registerDrawings();
    const { setup, symbol, timeframe, timezone } = latest.current;
    const chart = init(element, { timezone, locale: 'zh-CN' });
    if (!chart) return;
    chartRef.current = chart;
    loaded.current = false;
    states.current = new Map(setup.drawings.map((state) => [state.id, state]));
    pending.current = { kind: 'restore', view: setup.view, focus: setup.focus };
    selected.current = null;
    drawing.current = null;

    focus.current = null;
    const title = (name: string) => `{ticker} · ${timeframeInfo(name).title}`;
    chart.setStyles({ candle: { tooltip: { showRule: 'always', title: { template: title(timeframe) } } } });
    // What the user scrolls or zooms to is what they are looking at.
    const looked = () => {
      if (!placing.current) focus.current = null;
    };
    chart.subscribeAction('onScroll', looked);
    chart.subscribeAction('onZoom', looked);
    if (setup.view.barSpace) chart.setBarSpace(setup.view.barSpace);
    chart.setSymbol({ ticker: symbol.name.toUpperCase(), pricePrecision: symbol.digits, volumePrecision: 2 });
    chart.setPeriod(timeframeInfo(timeframe).period);
    chart.setDataLoader(
      createLoader({
        series: () => ({ symbol: latest.current.symbol.name, timeframe: latest.current.timeframe }),
        anchor: () => {
          const plan = pending.current;
          const around = plan === null ? null : plan.kind === 'center' ? plan.time : (plan.view.rightTimestamp ?? plan.focus);
          return { around, since: earliest(states.current.values()) };
        },
        onLoaded: (first) => {
          if (chartRef.current !== chart) return;
          if (first) {
            rebuild(chart);
            loaded.current = true;
          }
          latest.current.onLoaded(chart.getDataList().length);
        },
        onError: (error) => latest.current.onLoadError(error instanceof Error ? error.message : String(error)),
      }),
    );

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      chartRef.current = null;
      dispose(element);
    };
    // The chart is rebuilt only when another study is opened; the other props have effects of their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.setupKey]);

  // Another timeframe: the same drawings and the same moment in time on other bars.
  const shownTimeframe = useRef(props.timeframe);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || shownTimeframe.current === props.timeframe) {
      shownTimeframe.current = props.timeframe;
      return;
    }
    shownTimeframe.current = props.timeframe;
    const time = focus.current ?? currentView(chart).center;
    if (loaded.current && time !== null) pending.current = { kind: 'center', time };
    chart.setStyles({ candle: { tooltip: { title: { template: `{ticker} · ${timeframeInfo(props.timeframe).title}` } } } });
    chart.setPeriod(timeframeInfo(props.timeframe).period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.timeframe, props.setupKey]);

  useEffect(() => {
    chartRef.current?.setTimezone(props.timezone);
  }, [props.timezone, props.setupKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart && loaded.current) applyIndicators(chart, props.indicators);
  }, [props.indicators, props.setupKey]);

  useImperativeHandle(ref, () => ({
    snapshot() {
      const chart = chartRef.current;
      const drawings = [...states.current.values()];
      if (!chart) return { drawings, view: { barSpace: null, offsetRight: null, rightTimestamp: null }, center: null, range: null };
      const { center, range, ...view } = currentView(chart);
      return { drawings, view, center, range };
    },
    screenshot() {
      return chartRef.current?.getConvertPictureUrl(true, 'png', '#ffffff') ?? '';
    },
    startDrawing(tool, color) {
      const chart = chartRef.current;
      if (!chart) return;
      this.cancelDrawing();
      const state = newDrawing(tool, color);
      drawing.current = state.id;
      show(chart, state, []);
    },
    cancelDrawing() {
      const chart = chartRef.current;
      if (!chart || drawing.current === null) return;
      rebuilding.current = true;
      chart.removeOverlay({ id: drawing.current });
      rebuilding.current = false;
      drawing.current = null;
    },
    removeSelected() {
      if (selected.current !== null) chartRef.current?.removeOverlay({ id: selected.current });
    },
    recolor(color) {
      const chart = chartRef.current;
      const state = selected.current === null || !picked.current ? undefined : states.current.get(selected.current);
      if (!chart || !state) return;
      const changed: DrawingState = { ...state, styles: stylesFor(state.name, color), extendData: { ...state.extendData, color } };
      const override: Partial<OverlayCreate> = { id: state.id, extendData: changed.extendData };
      if (changed.styles) override.styles = changed.styles;
      chart.overrideOverlay(override);
      states.current.set(state.id, changed);
      latest.current.onDirty();
      select(state.id);
    },
    setText(id, text) {
      const chart = chartRef.current;
      const state = states.current.get(id);
      if (!chart || !state) return;
      if (text === null) {
        // Cancelled. A note that never had a text is of no use.
        if (state.name === 'note' && !state.extendData?.text) chart.removeOverlay({ id });
        return;
      }
      if (state.name === 'note' && text.trim() === '') {
        chart.removeOverlay({ id });
        return;
      }
      const changed: DrawingState = { ...state, extendData: { ...state.extendData, text: text.trim() } };
      chart.overrideOverlay({ id, extendData: changed.extendData });
      states.current.set(id, changed);
      latest.current.onDirty();
      if (selected.current === id) select(id);
    },
    pixelsOf(id) {
      const chart = chartRef.current;
      const [overlay] = chart?.getOverlays({ id }) ?? [];
      if (!chart || !overlay) return [];
      const pixels = chart.convertToPixel(overlay.points, { paneId: CANDLE_PANE }) as Array<{ x?: number; y?: number }>;
      return pixels.map((pixel) => ({ x: pixel.x ?? NaN, y: pixel.y ?? NaN }));
    },
  }));

  return <div ref={container} className="chart" data-testid="chart" />;
});
