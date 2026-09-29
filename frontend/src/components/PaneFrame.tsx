import type { ReactNode } from 'react';

import { TIMEFRAMES } from '../timeframes';
import type { IndicatorState, SymbolInfo } from '../types';
import { IndicatorMenu } from './IndicatorMenu';

interface Props {
  paneKey: string;
  symbols: SymbolInfo[];
  symbol: string;
  timeframe: string;
  indicators: IndicatorState[];
  maximized: boolean;
  /** Whether there are other charts next to this one. */
  alone: boolean;
  onSymbol(name: string): void;
  onTimeframe(name: string): void;
  onIndicators(value: IndicatorState[]): void;
  onMaximize(on: boolean): void;
  children: ReactNode;
}

/** A chart of a study with the controls that choose what it shows. */
export function PaneFrame(props: Props) {
  const available = new Set(props.symbols.find((item) => item.name === props.symbol)?.timeframes.map((item) => item.name));
  return (
    <section className={props.maximized ? 'frame max' : 'frame'} data-testid={`frame-${props.paneKey}`}>
      <header className="frame-head">
        <select value={props.symbol} data-testid={`symbol-${props.paneKey}`} title="这个窗格的品种" onChange={(event) => props.onSymbol(event.target.value)}>
          {props.symbols.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name.toUpperCase()}
            </option>
          ))}
        </select>
        <select value={props.timeframe} data-testid={`timeframe-${props.paneKey}`} title="这个窗格的周期" onChange={(event) => props.onTimeframe(event.target.value)}>
          {TIMEFRAMES.filter((item) => available.has(item.name)).map((item) => (
            <option key={item.name} value={item.name}>
              {item.title}
            </option>
          ))}
        </select>
        <IndicatorMenu value={props.indicators} onChange={props.onIndicators} testid={`indicators-${props.paneKey}`} />
        {!props.alone && (
          <button type="button" className="plain end" data-testid={`maximize-${props.paneKey}`} title={props.maximized ? '回到并排显示' : '放大这个窗格'} onClick={() => props.onMaximize(!props.maximized)}>
            {props.maximized ? '还原' : '放大'}
          </button>
        )}
      </header>
      {props.children}
    </section>
  );
}
