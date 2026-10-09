import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api';
import { listen } from '../channel';
import { DrawingBoard } from '../chart/board';
import { SIGNAL_COLOR, TOUCH_COLOR, type Mark, type MarkHit } from '../chart/marks';
import { Pane, type Armed, type PaneHandle, type PaneStart, type Place } from '../chart/Pane';
import { middleOf } from '../chart/placement';
import { Magnet } from '../components/DrawingTools';
import { Hover } from '../components/Hover';
import { IndicatorMenu } from '../components/IndicatorMenu';
import { Menu, type MenuItem } from '../components/Menu';
import { ScreenMenu } from '../components/ScreenMenu';
import { SignalPanel, matches } from '../components/SignalPanel';
import { describe, moment } from '../format';
import { moment as when } from '../format';
import { openStudy, type StudyRoute } from '../route';
import { remember, remembered, type Settings } from '../settings';
import { TIMEFRAMES } from '../timeframes';
import type { DrawingState, Meta, ScreenInfo, Shape, Signal, Status, StudySummary } from '../types';
import { TIMEZONES } from './timezones';

/** A way to mark a signal on the chart by hand. */
interface SignalTool {
  name: string;
  label: string;
  /** The drawing the clicks make; the signal takes its anchors. */
  drawing: string;
  shape: Shape;
  hint: string;
}

const SIGNAL_TOOLS: SignalTool[] = [
  { name: 'point', label: '点', drawing: 'spot', shape: 'point', hint: '点击一次：信号所在的 K 线和价位' },
  { name: 'levelSegment', label: '水平线段', drawing: 'levelSegment', shape: 'segment', hint: '点击两次：第一次定价位和起点，第二次定终点' },
  { name: 'level', label: '水平位', drawing: 'levelRay', shape: 'level', hint: '点击一次：从这里一直向右延伸的价位' },
  { name: 'segment', label: '线段', drawing: 'segment', shape: 'segment', hint: '点击两次：起点、终点' },
  { name: 'box', label: '方框', drawing: 'box', shape: 'box', hint: '点击两次：对角的两个角' },
];

/** What the next clicks on the chart are for. */
type Task = { kind: 'signal'; tool: SignalTool } | { kind: 'touch'; signal: string };

const DEFAULTS: Settings = { symbol: null, timeframe: 'd1', timezone: 'UTC', indicators: [], magnet: true };
const START: PaneStart = { view: { barSpace: null, offsetRight: null, rightTimestamp: null }, focus: null };
const BLOCKED = '浏览器拦截了新窗口。请在地址栏右侧允许本页面弹出窗口，然后再点一次。';

export function MainWindow() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [settings, setSettings] = useState<Settings>(() => remembered(DEFAULTS));
  const [signals, setSignals] = useState<Signal[]>([]);
  const [studies, setStudies] = useState<StudySummary[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [hover, setHover] = useState<{ hit: MarkHit; at: Place } | null>(null);
  const [menu, setMenu] = useState<{ hit: MarkHit; at: Place } | null>(null);
  const [filter, setFilter] = useState('');
  const [hideRejected, setHideRejected] = useState(true);
  const [screens, setScreens] = useState<ScreenInfo[]>([]);
  const [screening, setScreening] = useState<string | null>(null);
  const [status, setStatus] = useState('正在读取数据…');
  const [bars, setBars] = useState(0);
  const board = useMemo(() => new DrawingBoard(), []);
  const chart = useRef<PaneHandle>(null);
  const symbolName = useRef<string | null>(null);

  const fail = (what: string) => (error: unknown) => setStatus(`${what}失败：${error instanceof Error ? error.message : String(error)}`);
  const symbol = meta?.symbols.find((item) => item.name === settings.symbol) ?? meta?.symbols[0];
  symbolName.current = symbol?.name ?? null;

  const alter = (changes: Partial<Settings>) => setSettings((before) => ({ ...before, ...changes }));

  useEffect(() => remember(settings), [settings]);

  const reload = useCallback(async (name: string) => {
    const [found, free] = await Promise.all([api.signals(name), api.studies()]);
    if (symbolName.current !== name) return;
    setSignals(found);
    setStudies(free);
  }, []);

  useEffect(() => {
    api
      .meta()
      .then((loaded) => {
        setMeta(loaded);
        setStatus(loaded.symbols.length === 0 ? '工作区里还没有行情数据。请先运行 candle-data rebuild。' : '');
      })
      .catch(fail('读取数据'));
  }, []);

  useEffect(() => {
    document.title = 'K 线研究工作台';
    api.screens().then(setScreens).catch(fail('读取筛选脚本'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The signals of the symbol; read again whenever another window has saved something.
  useEffect(() => {
    if (!symbol) return;
    const name = symbol.name;
    setSignals([]);
    setChosen(null);
    setTask(null);
    reload(name).catch(fail('读取信号'));
    const again = () => void reload(name).catch(fail('读取信号'));
    const stop = listen(again);
    window.addEventListener('focus', again);
    return () => {
      stop();
      window.removeEventListener('focus', again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol?.name, reload]);

  useEffect(() => {
    window.candleViewer = { window: 'main', chart: () => chart.current, signals: () => signals };
    return () => {
      delete window.candleViewer;
    };
  }, [signals]);

  const shown = useMemo(() => signals.filter((signal) => matches(signal, filter) && !(hideRejected && signal.status === 'rejected')), [signals, filter, hideRejected]);

  const marks = useMemo<Mark[]>(() => {
    const made: Mark[] = [];
    for (const signal of shown) {
      const version = signal.versions[signal.versions.length - 1];
      if (!version) continue;
      const selected = signal.id === chosen;
      made.push({
        kind: 'signal',
        id: signal.id,
        shape: version.shape,
        anchors: version.anchors,
        madeOn: version.timeframe,
        tag: signal.note.tag,
        studied: signal.note.studied,
        status: signal.status,
        selected,
        editable: false,
        guide: selected,
        reach: false,
        touches: signal.touches.map((touch) => ({ id: touch.id, studied: touch.note.studied, selected: false })),
      });
      // The touches of the chosen signal also show where they happened.
      if (selected) {
        signal.touches.forEach((touch, index) => {
          made.push({ kind: 'touch', id: touch.id, timestamp: touch.timestamp, value: touch.value, madeOn: touch.timeframe, tag: touch.note.tag || `触及 ${index + 1}`, selected: false });
        });
      }
    }
    return made;
  }, [shown, chosen]);

  const armed = useMemo<Armed | null>(() => {
    if (!task) return null;
    return task.kind === 'signal' ? { tool: task.tool.drawing, color: SIGNAL_COLOR } : { tool: 'spot', color: TOUCH_COLOR };
  }, [task]);

  const open = useCallback((route: StudyRoute) => {
    setStatus(openStudy(route) ? '' : BLOCKED);
  }, []);

  /** The clicks of a task have been made: they become a signal or a touch, not a drawing. */
  const drawn = (drawing: DrawingState): boolean => {
    const doing = task;
    setTask(null);
    if (!doing || !symbol) return false;
    const anchors = drawing.points.flatMap((point) => (point.timestamp === null || point.value === null ? [] : [{ timestamp: point.timestamp, value: point.value }]));
    const [first] = anchors;
    if (anchors.length !== drawing.points.length || !first) {
      setStatus('没有取到位置，请再试一次。');
      return false;
    }
    const name = symbol.name;
    if (doing.kind === 'signal') {
      api
        .createSignal({ symbol: name, shape: doing.tool.shape, anchors, timeframe: settings.timeframe })
        .then(async (signal) => {
          await reload(name);
          setChosen(signal.id);
          setStatus('已标记信号。点击它打开研究窗口，在里面画线、写快评和评论。');
        })
        .catch(fail('标记信号'));
    } else {
      api
        .addTouch(doing.signal, { timestamp: first.timestamp, value: first.value, timeframe: settings.timeframe })
        .then(async (touch) => {
          await reload(name);
          setChosen(doing.signal);
          setStatus(`已添加触及 ${moment(touch.timestamp)} UTC。它显示为信号下方的一个圆点，点击圆点打开它的研究窗口。`);
        })
        .catch(fail('添加触及'));
    }
    return false;
  };

  const choose = (id: string) => {
    setChosen(id);
    const version = signals.find((item) => item.id === id)?.versions.at(-1);
    const middle = version ? middleOf(version.anchors) : null;
    if (middle !== null) chart.current?.lookAt(middle);
  };

  const removeSignal = (id: string) => {
    const signal = signals.find((item) => item.id === id);
    if (!signal || !symbol) return;
    const touches = signal.touches.length > 0 ? `连同它的 ${signal.touches.length} 次触及` : '';
    if (!window.confirm(`删除信号“${signal.note.tag || describe(signal.versions.at(-1) ?? { shape: 'point', anchors: [], timeframe: 'd1' })}”${touches}？它会被移到回收文件夹，不会被销毁。`)) return;
    api
      .removeSignal(id)
      .then(() => reload(symbol.name))
      .then(() => setChosen((before) => (before === id ? null : before)))
      .catch(fail('删除'));
  };

  const removeTouch = (id: string) => {
    if (!symbol || !window.confirm('删除这次触及？它会被移到回收文件夹，不会被销毁。')) return;
    api
      .removeTouch(id)
      .then(() => reload(symbol.name))
      .catch(fail('删除'));
  };

  const setStatus_ = (id: string, status: Status) => {
    if (!symbol) return;
    api
      .changeSignal(id, { status })
      .then(() => reload(symbol.name))
      .catch(fail('修改状态'));
  };

  const runScreen = (screen: ScreenInfo) => {
    if (!symbol) return;
    setScreening(screen.name);
    setStatus(`正在运行 ${screen.name}…`);
    api
      .runScreen(screen.name, symbol.name)
      .then(async (outcome) => {
        await reload(symbol.name);
        setStatus(`${screen.name}：找到 ${outcome.found} 个，新增 ${outcome.created.length} 个候选信号，${outcome.known} 个已有。候选信号画成虚线；在右侧确认或否定。`);
      })
      .catch(fail('运行筛选'))
      .finally(() => setScreening(null));
  };

  const checkScreen = (screen: ScreenInfo) => {
    if (!symbol) return;
    setScreening(screen.name);
    setStatus(`正在检查 ${screen.name} 有没有偷看未来…`);
    api
      .checkScreen(screen.name, symbol.name)
      .then((report) => {
        const early = report.differences.filter((item) => item.kind === 'early' || item.kind === 'moved');
        const first = early[0];
        setStatus(
          report.passed
            ? `${screen.name}：通过。找到 ${report.found} 个，在 ${report.cutoffs} 个截断点上重跑，结果一致。`
            : `${screen.name}：没有通过，它偷看了未来。例如 ${first?.key ?? ''}：${first?.detail ?? ''}（共 ${early.length} 处，截断到 ${first ? when(first.cutoff) : ''}）`,
        );
      })
      .catch(fail('检查筛选'))
      .finally(() => setScreening(null));
  };

  const removeStudy = (id: string) => {
    const study = studies.find((item) => item.id === id);
    if (!symbol || !window.confirm(`删除记录“${study?.tag || id}”？它会被移到回收文件夹，不会被销毁。`)) return;
    api
      .remove(id)
      .then(() => reload(symbol.name))
      .catch(fail('删除'));
  };

  const signalOf = (hit: MarkHit): Signal | undefined => {
    const touch = hit.mark.kind === 'touch' ? hit.mark.id : hit.touch;
    return signals.find((item) => (touch === null ? item.id === hit.mark.id : item.touches.some((one) => one.id === touch)));
  };

  const clicked = (hit: MarkHit) => {
    const signal = signalOf(hit);
    if (!signal) return;
    setChosen(signal.id);
    setHover(null);
    const touch = hit.mark.kind === 'touch' ? hit.mark.id : hit.touch;
    open(touch === null ? { window: 'study', kind: 'signal', id: signal.id } : { window: 'study', kind: 'touch', id: touch });
  };

  const menuItems = (hit: MarkHit): MenuItem[] => {
    const signal = signalOf(hit);
    if (!signal) return [];
    const touch = hit.mark.kind === 'touch' ? hit.mark.id : hit.touch;
    if (touch !== null) {
      return [
        { name: 'open', label: '打开触及的研究窗口', run: () => open({ window: 'study', kind: 'touch', id: touch }) },
        { name: 'remove', label: '删除这次触及', danger: true, run: () => removeTouch(touch) },
      ];
    }
    return [
      { name: 'open', label: '打开研究窗口', run: () => open({ window: 'study', kind: 'signal', id: signal.id }) },
      { name: 'touch', label: '添加触及', run: () => setTask({ kind: 'touch', signal: signal.id }) },
      { name: 'remove', label: '删除信号', danger: true, run: () => removeSignal(signal.id) },
    ];
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTask(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!meta || !symbol) return <div className="notice" data-testid="message">{status}</div>;
  const available = new Set(symbol.timeframes.map((item) => item.name));
  const timeframe = available.has(settings.timeframe) ? settings.timeframe : (symbol.timeframes[0]?.name ?? 'd1');
  const chosenSignal = signals.find((item) => item.id === chosen);
  const hint = !task ? null : task.kind === 'signal' ? `标记信号（${task.tool.label}）：${task.tool.hint}` : '添加触及：点击价格触及信号的那根 K 线';

  return (
    <div className="app main-window" data-testid="main-window">
      <header className="toolbar">
        <div className="group">
          <select value={symbol.name} data-testid="symbol" onChange={(event) => alter({ symbol: event.target.value })}>
            {meta.symbols.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name.toUpperCase()}
              </option>
            ))}
          </select>
          <div className="segmented" data-testid="timeframes">
            {TIMEFRAMES.filter((item) => available.has(item.name)).map((item) => (
              <button key={item.name} type="button" className={item.name === timeframe ? 'on' : ''} data-testid={`timeframe-${item.name}`} onClick={() => alter({ timeframe: item.name })}>
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="group">
          <span className="dim">标记信号</span>
          <div className="segmented" data-testid="signal-tools">
            {SIGNAL_TOOLS.map((tool) => {
              const on = task?.kind === 'signal' && task.tool.name === tool.name;
              return (
                <button key={tool.name} type="button" className={on ? 'on' : ''} title={tool.hint} data-testid={`mark-${tool.name}`} onClick={() => setTask(on ? null : { kind: 'signal', tool })}>
                  {tool.label}
                </button>
              );
            })}
          </div>
          <Magnet on={settings.magnet} onChange={(magnet) => alter({ magnet })} />
        </div>

        <div className="group">
          <ScreenMenu screens={screens} busy={screening} onRun={runScreen} onCheck={checkScreen} />
          <IndicatorMenu value={settings.indicators} onChange={(indicators) => alter({ indicators })} />
          <select value={settings.timezone} data-testid="timezone" title="图上显示的时间" onChange={(event) => alter({ timezone: event.target.value })}>
            {TIMEZONES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="work">
        <div className="stage">
          <Pane
            ref={chart}
            paneKey="main"
            symbol={symbol}
            timeframe={timeframe}
            timezone={settings.timezone}
            indicators={settings.indicators}
            board={board}
            start={START}
            startKey="main"
            marks={marks}
            armed={armed}
            magnet={settings.magnet}
            onDrawn={drawn}
            onLoaded={setBars}
            onLoadError={(message) => setStatus(`读取行情失败：${message}`)}
            onMarkClick={clicked}
            onMarkMenu={(hit, at) => {
              setHover(null);
              setMenu({ hit, at });
            }}
            onMarkHover={(hit, at) =>
              setHover((before) => {
                if (hit === null || at === null) return null;
                const same = before !== null && before.hit.mark.kind === hit.mark.kind && before.hit.mark.id === hit.mark.id && before.hit.touch === hit.touch;
                return same ? before : { hit, at };
              })
            }
          />
          <footer className="status" data-testid="status">
            <span data-testid="hint">{hint ? `${hint}　按 Esc 取消` : chosenSignal ? `已选中：${chosenSignal.note.tag || '未评的信号'}` : '鼠标停在信号上看评论，点击打开研究窗口'}</span>
            <span className="dim">已载入 {bars.toLocaleString()} 根 K 线</span>
            <span data-testid="message">{status}</span>
          </footer>
        </div>
        <SignalPanel
          signals={shown}
          total={signals.length}
          chosen={chosen}
          filter={filter}
          hideRejected={hideRejected}
          rejected={signals.filter((signal) => signal.status === 'rejected').length}
          studies={studies}
          onFilter={setFilter}
          onHideRejected={setHideRejected}
          onStatus={setStatus_}
          onChoose={choose}
          onOpen={(id) => open({ window: 'study', kind: 'signal', id })}
          onAddTouch={(id) => setTask({ kind: 'touch', signal: id })}
          onRemove={removeSignal}
          onOpenTouch={(id) => open({ window: 'study', kind: 'touch', id })}
          onRemoveTouch={removeTouch}
          onOpenStudy={(id) => open({ window: 'study', kind: 'free', id, symbol: null, timeframe: null, focus: null })}
          onRemoveStudy={removeStudy}
          onNewStudy={() => open({ window: 'study', kind: 'free', id: null, symbol: symbol.name, timeframe, focus: chart.current?.snapshot().center ?? null })}
        />
      </main>

      {hover && !menu && !task && <Hover hit={hover.hit} at={hover.at} signals={signals} />}
      {menu && <Menu at={menu.at} items={menuItems(menu.hit)} onClose={() => setMenu(null)} />}
    </div>
  );
}
