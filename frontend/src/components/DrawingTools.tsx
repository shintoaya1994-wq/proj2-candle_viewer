import { COLORS, TOOLS } from '../chart/drawings';

interface Props {
  tool: string | null;
  color: string;
  magnet: boolean;
  /** Whether a drawing is selected, so that it can be removed or take a color. */
  selected: boolean;
  onTool(name: string | null): void;
  onColor(color: string): void;
  onMagnet(on: boolean): void;
  onRemoveSelected(): void;
}

/** The tools that draw on the charts of a study. */
export function DrawingTools(props: Props) {
  return (
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
      <Magnet on={props.magnet} onChange={props.onMagnet} />
      <button type="button" disabled={!props.selected} data-testid="remove-selected" onClick={props.onRemoveSelected} title="也可以按 Delete 键，或在标注上点右键">
        删除所选
      </button>
    </div>
  );
}

export function Magnet({ on, onChange }: { on: boolean; onChange(on: boolean): void }) {
  return (
    <button
      type="button"
      className={on ? 'toggle on' : 'toggle'}
      aria-pressed={on}
      data-testid="magnet"
      title="打开时，点在 K 线最高价或最低价附近会自动落到该价位上"
      onClick={() => onChange(!on)}
    >
      吸附高低点
    </button>
  );
}
