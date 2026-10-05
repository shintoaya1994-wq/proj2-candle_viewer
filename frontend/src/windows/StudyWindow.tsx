import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api';
import { announce, listen } from '../channel';
import { DrawingBoard } from '../chart/board';
import { DEFAULT_COLOR, TOOLS, stylesFor } from '../chart/drawings';
import { overlayId, type Mark, type MarkHit } from '../chart/marks';
import { Pane, type Armed, type PaneHandle, type PaneStart, type Selection } from '../chart/Pane';
import { compose } from '../chart/picture';
import { middleOf } from '../chart/placement';
import { DrawingTools } from '../components/DrawingTools';
import { PaneFrame } from '../components/PaneFrame';
import { ReasonDialog, type Reason } from '../components/ReasonDialog';
import { StudyPanel, type Facts } from '../components/StudyPanel';
import { TextDialog } from '../components/TextDialog';
import { fromInput, modelsOf, toInput } from '../format';
import { formatRoute, openStudy, type StudyRoute } from '../route';
import { remembered } from '../settings';
import { STUDY_TIMEFRAMES, TIMEFRAMES, timeframe as timeframeInfo } from '../timeframes';
import type { Anchor, DrawingState, IndicatorState, LayoutState, Meta, Signal, SignalChanges, SignalVersion, StrategyText, Study, StudyContent, Touch } from '../types';
import { TIMEZONES } from './timezones';

/** One chart of the window. */
interface PaneSetup {
  key: string;
  symbol: string;
  timeframe: string;
  indicators: IndicatorState[];
  start: PaneStart;
}

/** The shape of the signal as the charts show it. */
interface Shape {
  anchors: Anchor[];
  timeframe: string;
  /** Whether the user has moved it since it was read or saved. */
  moved: boolean;
}

/** What the window is about, as it was read. */
interface Subject {
  meta: Meta;
  symbol: string;
  signal: Signal | null;
  touch: Touch | null;
  /** The study of the signal, in a window about one of its touches: what was found out about the signal applies to every touch. */
  signalStudy: Study | null;
  /** Id of a study that stands on its own; null while it has not been saved. */
  study: string | null;
  /** Changes whenever the subject is read anew, so that the charts start anew. */
  key: string;
}

const LAYOUTS: Array<LayoutState & { label: string }> = [
  { columns: 1, rows: 1, label: '1 个窗格' },
  { columns: 2, rows: 1, label: '2 个并排' },
  { columns: 3, rows: 1, label: '3 个并排' },
  { columns: 2, rows: 2, label: '4 个（2×2）' },
  { columns: 3, rows: 2, label: '6 个（3×2）' },
];
const DEFAULT_LAYOUT: LayoutState = { columns: 3, rows: 2 };
const DEFAULT_BAR_SPACE = 6;
const KINDS = { signal: '信号研究', touch: '触及研究', free: '自由研究' };
/** A chart of another symbol than the one the study is about shows no signal. */
const NO_MARKS: Mark[] = [];

declare global {
  interface Window {
    /** A look inside for automated tests. */
    candleViewer?: Record<string, unknown>;
  }
}

let reads = 0;

const freshStart = (focus: number | null, mark: string | null = null): PaneStart => ({ view: { barSpace: DEFAULT_BAR_SPACE, offsetRight: null, rightTimestamp: null }, focus, mark });

function versionOf(signal: Signal, version: number | null): SignalVersion | null {
  const wanted = version === null ? signal.versions[signal.versions.length - 1] : signal.versions.find((item) => item.version === version);
  return wanted ?? signal.versions[signal.versions.length - 1] ?? null;
}

const factsOf = (signal: Signal): Facts => ({
  models: signal.models.join('，'),
  basis: signal.basis,
  status: signal.status,
  knownAt: toInput(versionOf(signal, null)?.knownAt ?? null),
});

export function StudyWindow({ route }: { route: StudyRoute }) {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [panes, setPanes] = useState<PaneSetup[]>([]);
  const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('UTC');
  const [focus, setFocus] = useState<number | null>(null);
  const [tag, setTag] = useState('');
  const [comment, setComment] = useState('');
  const [facts, setFacts] = useState<Facts | null>(null);
  const [shape, setShape] = useState<Shape | null>(null);
  const [strategies, setStrategies] = useState<StrategyText[]>([]);
  const [tool, setTool] = useState<string | null>(null);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [magnet, setMagnet] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [asking, setAsking] = useState<{ id: string; text: string } | null>(null);
  const [reasoning, setReasoning] = useState<{ close: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('正在读取…');
  const [bars, setBars] = useState<Record<string, number>>({});
  const board = useMemo(() => new DrawingBoard(), []);
  const handles = useRef(new Map<string, PaneHandle>());

  const fail = (what: string) => (error: unknown) => setStatus(`${what}失败：${error instanceof Error ? error.message : String(error)}`);
  const routeKey = formatRoute(route);

  // Reads what the window is about.
  useEffect(() => {
    let stale = false;
    const read = async () => {
      const meta = await api.meta();
      let signal: Signal | null = null;
      let touch: Touch | null = null;
      let study: Study | null = null;
      let signalStudy: Study | null = null;
      let plans: StrategyText[] = [];
      if (route.kind === 'signal') {
        [signal, study] = await Promise.all([api.signal(route.id), api.studyOf('signal', route.id)]);
      } else if (route.kind === 'touch') {
        touch = await api.touch(route.id);
        [signal, study, signalStudy, plans] = await Promise.all([api.signal(touch.signalId), api.studyOf('touch', route.id), api.studyOf('signal', touch.signalId), api.strategies(route.id)]);
      } else if (route.id !== null) {
        study = await api.study(route.id);
      }
      if (stale) return;

      const symbol = signal?.symbol ?? study?.symbol ?? (route.kind === 'free' ? route.symbol : null) ?? meta.symbols[0]?.name;
      const known = meta.symbols.find((item) => item.name === symbol);
      if (!symbol || !known) {
        setStatus(symbol ? `数据集中没有品种 ${symbol.toUpperCase()}。` : '工作区里还没有行情数据。请先运行 candle-data rebuild。');
        return;
      }
      const version = signal ? versionOf(signal, touch ? touch.signalVersion : null) : null;
      const about = touch ? touch.timestamp : (study?.focus ?? (version ? middleOf(version.anchors) : null) ?? (route.kind === 'free' ? route.focus : null));
      const available = new Set(known.timeframes.map((item) => item.name));
      const key = `read-${++reads}`;
      // A window opens around what it is about: the touch, or else the signal.
      const around = touch ? overlayId({ kind: 'touch', id: touch.id }) : signal ? overlayId({ kind: 'signal', id: signal.id }) : null;
      // The study of a touch that is new starts with the charts and indicators of the study of its signal.
      const pattern = study ?? signalStudy;
      const setups: PaneSetup[] = study
        ? study.panes.map((pane, index) => ({ key: `pane-${index}`, symbol: pane.symbol, timeframe: pane.timeframe, indicators: pane.indicators, start: { view: pane.view, focus: about, mark: around } }))
        : signalStudy
          ? signalStudy.panes.map((pane, index) => ({ key: `pane-${index}`, symbol: pane.symbol, timeframe: pane.timeframe, indicators: pane.indicators, start: freshStart(about, around) }))
          : STUDY_TIMEFRAMES.filter((name) => available.has(name)).map((name, index) => ({ key: `pane-${index}`, symbol, timeframe: name, indicators: [], start: freshStart(about, around) }));

      // A study that is new shows times and takes clicks the way the main window does.
      const usual = remembered({ symbol: null, timeframe: 'd1', timezone: 'UTC', indicators: [], magnet: true });
      board.reset(study?.drawings ?? []);
      handles.current.clear();
      setPanes(setups);
      setLayout(pattern?.layout ?? DEFAULT_LAYOUT);
      setMaximized(null);
      setTimezone(pattern?.timezone ?? usual.timezone);
      setMagnet(usual.magnet);
      setFocus(about);
      setTag(study?.tag ?? '');
      setComment(study?.comment ?? '');
      setFacts(signal && route.kind === 'signal' ? factsOf(signal) : null);
      setShape(version ? { anchors: version.anchors, timeframe: version.timeframe, moved: false } : null);
      setStrategies(plans.map(({ id, label, text }) => ({ id, label, text })));
      setSelection(null);
      setTool(null);
      setDirty(false);
      setBars({});
      setSubject({ meta, symbol, signal, touch, signalStudy, study: study && route.kind === 'free' ? study.id : null, key });
      setStatus('');
    };
    read().catch(fail('打开'));
    return () => {
      stale = true;
    };
    // The route is named by its text; the object is made anew with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, board]);

  useEffect(() => {
    if (!subject) return;
    document.title = `${subject.symbol.toUpperCase()} · ${tag.trim() || KINDS[route.kind]} · K 线研究`;
  }, [subject, tag, route.kind]);

  // What is saved about the signal in another window shows here at once.
  useEffect(() => {
    const signalId = subject?.touch?.signalId;
    if (route.kind !== 'touch' || !signalId) return;
    return listen((notice) => {
      if (notice.kind !== 'signal' || notice.id !== signalId) return;
      Promise.all([api.signal(signalId), api.studyOf('signal', signalId)])
        .then(([signal, signalStudy]) => setSubject((before) => (before ? { ...before, signal, signalStudy } : before)))
        .catch(() => undefined);
    });
  }, [route.kind, subject?.touch?.signalId]);

  useEffect(() => {
    window.candleViewer = {
      window: 'study',
      panes: () => Object.fromEntries(handles.current),
      drawings: () => board.all(),
      loaded: () => panes.length > 0 && panes.every((pane) => (handles.current.get(pane.key)?.bars() ?? 0) > 0),
    };
    return () => {
      delete window.candleViewer;
    };
  }, [board, panes]);

  // Leaving the window with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const touched = useCallback(() => setDirty(true), []);
  const armed = useMemo<Armed | null>(() => (tool ? { tool, color } : null), [tool, color]);

  const marks = useMemo<Mark[]>(() => {
    if (!subject) return [];
    const { signal, touch } = subject;
    const shown: Mark[] = [];
    if (signal && shape) {
      const version = versionOf(signal, touch ? touch.signalVersion : null);
      shown.push({
        kind: 'signal',
        id: signal.id,
        shape: version?.shape ?? 'point',
        anchors: shape.anchors,
        madeOn: shape.timeframe,
        tag: (route.kind === 'signal' ? tag.trim() : signal.note.tag) || '信号',
        studied: true,
        status: facts?.status ?? signal.status,
        selected: false,
        editable: route.kind === 'signal',
        guide: route.kind === 'touch',
        reach: route.kind === 'signal',
        touches: route.kind === 'signal' ? signal.touches.map((item) => ({ id: item.id, studied: item.note.studied, selected: false })) : [],
      });
    }
    if (touch) shown.push({ kind: 'touch', id: touch.id, timestamp: touch.timestamp, value: touch.value, madeOn: touch.timeframe, tag: tag.trim(), selected: false });
    return shown;
  }, [subject, shape, tag, facts?.status, route.kind]);

  /** The drawings of the study of the signal, shown for reference in the window of a touch. */
  const reference = useMemo<DrawingState[]>(() => (route.kind === 'touch' ? (subject?.signalStudy?.drawings ?? []) : []), [route.kind, subject?.signalStudy]);

  const collect = useCallback(async (): Promise<StudyContent | null> => {
    if (!subject) return null;
    const states = panes.map((pane) => ({
      symbol: pane.symbol,
      timeframe: pane.timeframe,
      indicators: pane.indicators,
      view: handles.current.get(pane.key)?.snapshot().view ?? pane.start.view,
    }));
    const tiles = panes.map((pane) => ({
      title: `${pane.symbol.toUpperCase()} · ${timeframeInfo(pane.timeframe).title}`,
      picture: handles.current.get(pane.key)?.screenshot() ?? '',
    }));
    const first = panes[0] ? handles.current.get(panes[0].key)?.snapshot().center : null;
    return {
      symbol: subject.symbol,
      focus: focus ?? first ?? null,
      tag: tag.trim(),
      comment,
      drawings: board.all(),
      panes: states,
      layout,
      timezone,
      screenshot: await compose(tiles, layout.columns),
    };
  }, [subject, panes, focus, tag, comment, board, layout, timezone]);

  const save = useCallback(
    async (options: { reason?: Reason; close?: boolean } = {}): Promise<void> => {
      if (!subject || saving) return;
      if (route.kind === 'signal' && shape?.moved && !options.reason) {
        setReasoning({ close: options.close ?? false });
        return;
      }
      setSaving(true);
      setStatus('');
      try {
        let signal = subject.signal;
        if (route.kind === 'signal' && signal && facts && shape) {
          const current = versionOf(signal, null);
          const knownAt = fromInput(facts.knownAt);
          if (shape.moved && options.reason && current) {
            signal = await api.addVersion(signal.id, { shape: current.shape, anchors: shape.anchors, timeframe: shape.timeframe, knownAt, ...options.reason });
            setShape({ ...shape, moved: false });
          }
          const changes: SignalChanges = {};
          const models = modelsOf(facts.models);
          if (JSON.stringify(models) !== JSON.stringify(signal.models)) changes.models = models;
          if (facts.basis !== signal.basis) changes.basis = facts.basis;
          if (facts.status !== signal.status) changes.status = facts.status;
          if (knownAt !== (versionOf(signal, null)?.knownAt ?? null)) {
            if (knownAt === null) changes.clearKnownAt = true;
            else changes.knownAt = knownAt;
          }
          if (Object.keys(changes).length > 0) signal = await api.changeSignal(signal.id, changes);
        }
        if (route.kind === 'touch' && subject.touch) {
          const kept = await api.saveStrategies(subject.touch.id, strategies.filter((item) => item.label.trim() !== '' || item.text.trim() !== ''));
          setStrategies(kept.map(({ id, label, text }) => ({ id, label, text })));
        }

        const content = await collect();
        if (!content) return;
        let saved: Study;
        if (route.kind === 'free') saved = subject.study === null ? await api.create(content) : await api.update(subject.study, content);
        else saved = await api.saveStudyOf(route.kind, route.id, content);

        if (route.kind === 'signal') signal = await api.signal(route.id);
        setSubject({ ...subject, signal, study: route.kind === 'free' ? saved.id : null });
        if (signal && route.kind === 'signal') setFacts(factsOf(signal));
        setFocus(saved.focus);
        setTag(saved.tag);
        setDirty(false);
        announce({ type: 'saved', kind: route.kind, id: saved.id, symbol: subject.symbol });
        setStatus(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
        if (options.close) {
          window.close();
          // A window the user opened themselves cannot be closed by the page; it goes to the main window instead.
          window.setTimeout(() => {
            window.location.hash = formatRoute({ window: 'main' });
          }, 300);
        }
      } catch (error) {
        fail('保存')(error);
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subject, saving, route.kind, routeKey, shape, facts, strategies, collect],
  );

  const removeSelected = useCallback(() => {
    if (!selection) return;
    if (board.remove(selection.id)) setDirty(true);
    setSelection(null);
  }, [board, selection]);

  const change = (drawing: DrawingState) => {
    board.put(drawing);
    setDirty(true);
  };

  // A color goes to the drawing the user clicked; otherwise it is the color of what is drawn next.
  const pickColor = (value: string) => {
    const drawing = selection?.picked && !tool ? board.get(selection.id) : undefined;
    if (drawing) change({ ...drawing, styles: stylesFor(drawing.name, value), extendData: { ...drawing.extendData, color: value } });
    else setColor(value);
  };

  const setText = (id: string, text: string | null) => {
    const drawing = board.get(id);
    if (!drawing) return;
    const written = (text ?? drawing.extendData?.text ?? '').trim();
    // A note without a text is of no use.
    if (drawing.name === 'note' && written === '') {
      if (board.remove(id)) setDirty(true);
      if (selection?.id === id) setSelection(null);
    } else if (text !== null) {
      change({ ...drawing, extendData: { ...drawing.extendData, text: written } });
    }
  };

  const relayout = (next: LayoutState) => {
    if (!subject) return;
    const count = next.columns * next.rows;
    const available = new Set(subject.meta.symbols.find((item) => item.name === subject.symbol)?.timeframes.map((item) => item.name));
    const used = new Set(panes.map((pane) => pane.timeframe));
    const spare = [...STUDY_TIMEFRAMES, ...TIMEFRAMES.map((item) => item.name)].filter((name, index, all) => available.has(name) && !used.has(name) && all.indexOf(name) === index);
    const about = focus ?? (panes[0] ? (handles.current.get(panes[0].key)?.snapshot().center ?? null) : null);
    const arranged = panes.slice(0, count);
    while (arranged.length < count) {
      arranged.push({ key: `pane-${arranged.length}`, symbol: subject.symbol, timeframe: spare.shift() ?? 'd1', indicators: [], start: freshStart(about) });
    }
    setPanes(arranged);
    setLayout(next);
    setMaximized(null);
    setDirty(true);
  };

  const alter = (key: string, changes: Partial<PaneSetup>) => {
    setPanes((before) => before.map((pane) => (pane.key === key ? { ...pane, ...changes } : pane)));
    setDirty(true);
  };

  const restoreShape = () => {
    const version = subject?.signal ? versionOf(subject.signal, null) : null;
    if (version) setShape({ anchors: version.anchors, timeframe: version.timeframe, moved: false });
  };

  const openTouch = (hit: MarkHit) => {
    if (hit.touch === null) return;
    if (!openStudy({ window: 'study', kind: 'touch', id: hit.touch })) setStatus('浏览器拦截了新窗口。请允许本页面弹出窗口。');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      } else if (typing) {
        return;
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        removeSelected();
      } else if (event.key === 'Escape') {
        setTool(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, removeSelected]);

  if (!subject) return <div className="notice" data-testid="message">{status}</div>;
  const hint = TOOLS.find((item) => item.name === tool)?.hint;
  const total = Object.values(bars).reduce((sum, count) => sum + count, 0);
  const current = LAYOUTS.find((item) => item.columns === layout.columns && item.rows === layout.rows);

  return (
    <div className="app study-window" data-testid="study-window" data-kind={route.kind}>
      <header className="toolbar">
        <div className="group">
          <strong className="title" data-testid="title">
            {subject.symbol.toUpperCase()} · {KINDS[route.kind]}
          </strong>
        </div>
        <DrawingTools tool={tool} color={color} magnet={magnet} selected={selection !== null} onTool={setTool} onColor={pickColor} onMagnet={setMagnet} onRemoveSelected={removeSelected} />
        <div className="group">
          <select value={current ? `${current.columns}x${current.rows}` : ''} data-testid="layout" title="窗格的排列" onChange={(event) => {
            const chosen = LAYOUTS.find((item) => `${item.columns}x${item.rows}` === event.target.value);
            if (chosen) relayout({ columns: chosen.columns, rows: chosen.rows });
          }}>
            {!current && <option value="">{layout.columns}×{layout.rows}</option>}
            {LAYOUTS.map((item) => (
              <option key={item.label} value={`${item.columns}x${item.rows}`}>
                {item.label}
              </option>
            ))}
          </select>
          <select value={timezone} data-testid="timezone" title="图上显示的时间" onChange={(event) => {
            setTimezone(event.target.value);
            setDirty(true);
          }}>
            {TIMEZONES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="group end">
          <button type="button" data-testid="save" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : dirty ? '保存 *' : '保存'}
          </button>
          <button type="button" className="primary" data-testid="done" disabled={saving} title="保存并关闭这个窗口" onClick={() => void save({ close: true })}>
            编辑完成
          </button>
        </div>
      </header>

      <main className="work">
        <div className="stage">
          <div className="panes" data-testid="panes" style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }}>
            {panes.map((pane) => {
              const symbol = subject.meta.symbols.find((item) => item.name === pane.symbol);
              if (!symbol) return null;
              return (
                <PaneFrame
                  key={pane.key}
                  paneKey={pane.key}
                  symbols={subject.meta.symbols}
                  symbol={pane.symbol}
                  timeframe={pane.timeframe}
                  indicators={pane.indicators}
                  maximized={maximized === pane.key}
                  alone={panes.length === 1}
                  onSymbol={(name) => alter(pane.key, { symbol: name })}
                  onTimeframe={(name) => alter(pane.key, { timeframe: name })}
                  onIndicators={(indicators) => alter(pane.key, { indicators })}
                  onMaximize={(on) => setMaximized(on ? pane.key : null)}
                >
                  <Pane
                    ref={(handle) => {
                      if (handle) handles.current.set(pane.key, handle);
                      else handles.current.delete(pane.key);
                    }}
                    paneKey={pane.key}
                    symbol={symbol}
                    timeframe={pane.timeframe}
                    timezone={timezone}
                    indicators={pane.indicators}
                    board={board}
                    reference={reference}
                    start={pane.start}
                    startKey={`${subject.key}-${pane.key}`}
                    marks={pane.symbol === subject.symbol ? marks : NO_MARKS}
                    armed={armed}
                    magnet={magnet}
                    onDirty={touched}
                    onSelect={(chosen, from) => setSelection((before) => chosen ?? (before?.pane === from ? null : before))}
                    onDrawn={() => setTool(null)}
                    onTextRequest={(id, text) => setAsking({ id, text })}
                    onLoaded={(count, from) => setBars((before) => (before[from] === count ? before : { ...before, [from]: count }))}
                    onLoadError={(message) => setStatus(`读取行情失败：${message}`)}
                    onMarkClick={openTouch}
                    onMarkMoved={(_, anchors, timeframe) => {
                      setShape({ anchors, timeframe, moved: true });
                      setDirty(true);
                    }}
                    onPoint={(time, from) => {
                      for (const [key, handle] of handles.current) if (key !== from) handle.pointAt(time);
                    }}
                  />
                </PaneFrame>
              );
            })}
          </div>
          <footer className="status" data-testid="status">
            <span>
              {hint
                ? `${hint}　在任意一个窗格里画，其余窗格同步显示　按 Esc 取消`
                : selection
                  ? '已选中一个标注：可拖动、改颜色、按 Delete 删除；双击方框或文字可改字'
                  : route.kind === 'signal'
                    ? '紫色的是信号本身：拖动它或它的端点可以修改形状'
                    : reference.length > 0
                      ? '虚线的标注来自信号的研究，每次触及都能看到；要改它们请打开信号的研究窗口'
                      : ''}
            </span>
            <span className="dim">已载入 {total.toLocaleString()} 根 K 线</span>
            <span data-testid="message">{status}</span>
          </footer>
        </div>
        <StudyPanel
          kind={route.kind}
          tag={tag}
          comment={comment}
          signal={subject.signal}
          signalStudy={subject.signalStudy}
          touch={subject.touch}
          facts={facts}
          moved={shape?.moved ?? false}
          strategies={strategies}
          onTag={(value) => {
            setTag(value);
            setDirty(true);
          }}
          onComment={(value) => {
            setComment(value);
            setDirty(true);
          }}
          onFacts={(value) => {
            setFacts(value);
            setDirty(true);
          }}
          onRestoreShape={restoreShape}
          onOpenSignal={() => {
            if (subject.signal && !openStudy({ window: 'study', kind: 'signal', id: subject.signal.id })) setStatus('浏览器拦截了新窗口。请允许本页面弹出窗口。');
          }}
          onStrategies={(value) => {
            setStrategies(value);
            setDirty(true);
          }}
        />
      </main>

      {asking && (
        <TextDialog
          title="标注上的文字"
          text={asking.text}
          onDone={(text) => {
            setText(asking.id, text);
            setAsking(null);
          }}
        />
      )}
      {reasoning && (
        <ReasonDialog
          onDone={(reason) => {
            const { close } = reasoning;
            setReasoning(null);
            if (reason) void save({ reason, close });
          }}
        />
      )}
    </div>
  );
}
