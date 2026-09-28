import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api';
import { ChartView, type ChartHandle, type ChartSetup } from './chart/ChartView';
import { DEFAULT_COLOR, TOOLS } from './chart/drawings';
import { SidePanel } from './components/SidePanel';
import { TextDialog } from './components/TextDialog';
import { Toolbar } from './components/Toolbar';
import type { DrawingState, IndicatorState, Meta, Study, StudyContent, StudySummary } from './types';

/** The study on screen. */
interface Current {
  id: string | null;
  symbol: string;
  timeframe: string;
  timezone: string;
  tag: string;
  comment: string;
  focus: number | null;
  indicators: IndicatorState[];
  setup: ChartSetup;
  setupKey: string;
}

const EMPTY_SETUP: ChartSetup = { drawings: [], view: { barSpace: null, offsetRight: null, rightTimestamp: null }, focus: null };
const DEFAULT_TIMEFRAME = 'h1';

let opened = 0;
const nextKey = () => `chart-${++opened}`;

function blank(symbol: string, timeframe: string, timezone: string): Current {
  return { id: null, symbol, timeframe, timezone, tag: '', comment: '', focus: null, indicators: [], setup: EMPTY_SETUP, setupKey: nextKey() };
}

function fromStudy(study: Study): Current {
  return {
    id: study.id,
    symbol: study.symbol,
    timeframe: study.timeframe,
    timezone: study.timezone,
    tag: study.tag,
    comment: study.comment,
    focus: study.focus,
    indicators: study.indicators,
    setup: { drawings: study.drawings, view: study.view, focus: study.focus },
    setupKey: nextKey(),
  };
}

declare global {
  interface Window {
    /** A look inside for automated tests. */
    candleViewer?: { chart: () => ChartHandle | null; bars: () => number };
  }
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tool, setTool] = useState<string | null>(null);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [selected, setSelected] = useState<DrawingState | null>(null);
  const [picked, setPicked] = useState(false);
  const [asking, setAsking] = useState<{ id: string; text: string } | null>(null);
  const [status, setStatus] = useState('正在读取数据…');
  const [bars, setBars] = useState(0);
  const chart = useRef<ChartHandle>(null);
  const barCount = useRef(0);

  const fail = (what: string) => (error: unknown) => setStatus(`${what}失败：${error instanceof Error ? error.message : String(error)}`);

  useEffect(() => {
    api
      .meta()
      .then((loaded) => {
        setMeta(loaded);
        const first = loaded.symbols[0];
        if (!first) {
          setStatus('工作区里还没有行情数据。请先运行 candle-data rebuild。');
          return;
        }
        const timeframe = first.timeframes.some((item) => item.name === DEFAULT_TIMEFRAME) ? DEFAULT_TIMEFRAME : (first.timeframes[0]?.name ?? DEFAULT_TIMEFRAME);
        setCurrent(blank(first.name, timeframe, 'UTC'));
        setStatus('');
      })
      .catch(fail('读取数据'));
    api.studies().then(setStudies).catch(fail('读取记录'));
  }, []);

  useEffect(() => {
    window.candleViewer = { chart: () => chart.current, bars: () => barCount.current };
    return () => {
      delete window.candleViewer;
    };
  }, []);

  // Leaving the page with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const mayLeave = useCallback(() => !dirty || window.confirm('当前记录有未保存的修改，确定放弃吗？'), [dirty]);

  const start = useCallback((next: Current) => {
    setCurrent(next);
    setDirty(false);
    setTool(null);
    setSelected(null);
    setAsking(null);
  }, []);

  const change = (changes: Partial<Current>) => {
    setCurrent((before) => (before ? { ...before, ...changes } : before));
    setDirty(true);
  };

  const pickTool = useCallback(
    (name: string | null) => {
      setTool(name);
      if (name === null) chart.current?.cancelDrawing();
      else chart.current?.startDrawing(name, color);
    },
    [color],
  );

  // A color goes to the drawing the user clicked; otherwise it is the color of what is drawn next.
  const pickColor = (value: string) => {
    if (selected && picked && !tool) {
      chart.current?.recolor(value);
      return;
    }
    setColor(value);
    if (tool) chart.current?.startDrawing(tool, value);
  };

  const save = useCallback(async () => {
    if (!current || !chart.current || saving) return;
    setSaving(true);
    setStatus('');
    try {
      const { drawings, view, center } = chart.current.snapshot();
      const content: StudyContent = {
        symbol: current.symbol,
        timeframe: current.timeframe,
        timezone: current.timezone,
        focus: current.focus ?? center,
        tag: current.tag.trim(),
        comment: current.comment,
        indicators: current.indicators,
        drawings,
        view,
        screenshot: chart.current.screenshot() || null,
      };
      const saved = current.id === null ? await api.create(content) : await api.update(current.id, content);
      setCurrent((before) => (before ? { ...before, id: saved.id, focus: saved.focus, tag: saved.tag } : before));
      setDirty(false);
      setStudies(await api.studies());
      setStatus(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    } catch (error) {
      fail('保存')(error);
    } finally {
      setSaving(false);
    }
  }, [current, saving]);

  const open = async (id: string) => {
    if (id === current?.id && !dirty) return;
    if (!mayLeave()) return;
    try {
      start(fromStudy(await api.study(id)));
      setStatus('');
    } catch (error) {
      fail('打开记录')(error);
    }
  };

  const remove = async (id: string) => {
    const study = studies.find((item) => item.id === id);
    if (!window.confirm(`删除记录“${study?.tag || id}”？它会被移到回收文件夹，不会被销毁。`)) return;
    try {
      await api.remove(id);
      setStudies(await api.studies());
      if (current && current.id === id) start(blank(current.symbol, current.timeframe, current.timezone));
    } catch (error) {
      fail('删除')(error);
    }
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
        chart.current?.removeSelected();
      } else if (event.key === 'Escape') {
        pickTool(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, pickTool]);

  if (!meta || !current) return <div className="notice">{status}</div>;
  const symbol = meta.symbols.find((item) => item.name === current.symbol);
  if (!symbol) return <div className="notice">数据集中没有品种 {current.symbol}。</div>;
  const hint = TOOLS.find((item) => item.name === tool)?.hint;

  return (
    <div className="app">
      <Toolbar
        symbols={meta.symbols}
        symbol={current.symbol}
        timeframe={current.timeframe}
        timezone={current.timezone}
        indicators={current.indicators}
        tool={tool}
        color={color}
        selected={selected}
        dirty={dirty}
        saving={saving}
        onSymbol={(name) => name !== current.symbol && mayLeave() && start(blank(name, current.timeframe, current.timezone))}
        onTimeframe={(name) => name !== current.timeframe && change({ timeframe: name })}
        onTimezone={(name) => change({ timezone: name })}
        onIndicators={(indicators) => change({ indicators })}
        onTool={pickTool}
        onColor={pickColor}
        onRemoveSelected={() => chart.current?.removeSelected()}
        onNew={() => mayLeave() && start(blank(current.symbol, current.timeframe, current.timezone))}
        onSave={() => void save()}
      />
      <main className="work">
        <div className="stage">
          <ChartView
            ref={chart}
            symbol={symbol}
            timeframe={current.timeframe}
            timezone={current.timezone}
            indicators={current.indicators}
            setup={current.setup}
            setupKey={current.setupKey}
            onDirty={() => setDirty(true)}
            onSelect={(drawing, byClick) => {
              setSelected(drawing);
              setPicked(byClick);
            }}
            onDrawn={() => setTool(null)}
            onTextRequest={(id, text) => setAsking({ id, text })}
            onLoaded={(count) => {
              barCount.current = count;
              setBars(count);
            }}
            onLoadError={(message) => setStatus(`读取行情失败：${message}`)}
          />
          <footer className="status" data-testid="status">
            <span>{hint ? `${hint}　按 Esc 取消` : selected ? '已选中一个标注：可拖动、改颜色、按 Delete 删除；双击方框或文字可改字' : (current.id ?? '未保存的新记录')}</span>
            <span className="dim">已载入 {bars.toLocaleString()} 根 K 线</span>
            <span data-testid="message">{status}</span>
          </footer>
        </div>
        <SidePanel
          tag={current.tag}
          comment={current.comment}
          studies={studies}
          current={current.id}
          onTag={(tag) => change({ tag })}
          onComment={(comment) => change({ comment })}
          onOpen={(id) => void open(id)}
          onRemove={(id) => void remove(id)}
        />
      </main>
      {asking && (
        <TextDialog
          title="标注上的文字"
          text={asking.text}
          onDone={(text) => {
            chart.current?.setText(asking.id, text);
            setAsking(null);
          }}
        />
      )}
    </div>
  );
}
