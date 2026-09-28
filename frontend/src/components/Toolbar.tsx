import { COLORS, TOOLS } from '../chart/drawings';
import { TIMEFRAMES } from '../timeframes';
import type { DrawingState, IndicatorState, SymbolInfo } from '../types';
import { IndicatorMenu } from './IndicatorMenu';

export const TIMEZONES = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Asia/Shanghai', label: '北京时间' },
];

interface Props {
  symbols: SymbolInfo[];
  symbol: string;
  timeframe: string;
  timezone: string;
  indicators: IndicatorState[];
  tool: string | null;
  color: string;
  selected: DrawingState | null;
  dirty: boolean;
  saving: boolean;
  onSymbol(name: string): void;
  onTimeframe(name: string): void;
  onTimezone(name: string): void;
  onIndicators(value: IndicatorState[]): void;
  onTool(name: string | null): void;
  onColor(color: string): void;
  onRemoveSelected(): void;
  onNew(): void;
  onSave(): void;
}

export function Toolbar(props: Props) {
  const available = new Set(props.symbols.find((item) => item.name === props.symbol)?.timeframes.map((item) => item.name));
  return (
    <header className="toolbar">
      <div className="group">
        <select value={props.symbol} data-testid="symbol" onChange={(event) => props.onSymbol(event.target.value)}>
          {props.symbols.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name.toUpperCase()}
            </option>
          ))}
        </select>
        <div className="segmented" data-testid="timeframes">
          {TIMEFRAMES.filter((item) => available.has(item.name)).map((item) => (
            <button
              key={item.name}
              type="button"
              className={item.name === props.timeframe ? 'on' : ''}
              data-testid={`timeframe-${item.name}`}
              onClick={() => props.onTimeframe(item.name)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="group">
        <div className="segmented" data-testid="tools">
          {TOOLS.map((tool) => (
            <button
              key={tool.name}
              type="button"
              className={tool.name === props.tool ? 'on' : ''}
              title={tool.hint}
              data-testid={`tool-${tool.name}`}
              onClick={() => props.onTool(tool.name === props.tool ? null : tool.name)}
            >
              {tool.label}
            </button>
          ))}
        </div>
        <div className="colors" title={props.selected ? '所选标注的颜色' : '下一个标注的颜色'}>
          {COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              className={color.value === props.color ? 'swatch on' : 'swatch'}
              style={{ background: color.value }}
              aria-label={color.label}
              data-testid={`color-${color.value.slice(1)}`}
              onClick={() => props.onColor(color.value)}
            />
          ))}
        </div>
        <button type="button" disabled={!props.selected} data-testid="remove-selected" onClick={props.onRemoveSelected} title="也可以按 Delete 键，或在标注上点右键">
          删除所选
        </button>
      </div>

      <div className="group">
        <IndicatorMenu value={props.indicators} onChange={props.onIndicators} />
        <select value={props.timezone} data-testid="timezone" onChange={(event) => props.onTimezone(event.target.value)} title="图上显示的时间">
          {TIMEZONES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <div className="group end">
        <button type="button" data-testid="new" onClick={props.onNew}>
          新建
        </button>
        <button type="button" className="primary" data-testid="save" disabled={props.saving} onClick={props.onSave}>
          {props.saving ? '保存中…' : props.dirty ? '保存 *' : '保存'}
        </button>
      </div>
    </header>
  );
}
