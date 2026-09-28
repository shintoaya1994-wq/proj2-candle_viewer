import { useEffect, useRef, useState } from 'react';

import { INDICATORS } from '../chart/indicators';
import type { IndicatorState } from '../types';

interface Props {
  value: IndicatorState[];
  onChange(value: IndicatorState[]): void;
}

const parse = (text: string): number[] | null => {
  const numbers = text
    .split(/[,，\s]+/)
    .filter((part) => part !== '')
    .map(Number);
  return numbers.length > 0 && numbers.every((number) => Number.isFinite(number) && number > 0) ? numbers : null;
};

/** Chooses the indicators and their parameters. */
export function IndicatorMenu({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const chosen = (name: string) => value.find((item) => item.name === name);

  const toggle = (name: string, on: boolean) => {
    const info = INDICATORS.find((item) => item.name === name);
    if (!info) return;
    if (!on) {
      onChange(value.filter((item) => item.name !== name));
      return;
    }
    const params = parse(drafts[name] ?? '') ?? info.params;
    onChange([...value, { name, pane: info.pane, params, visible: true }]);
  };

  const retune = (name: string, text: string) => {
    setDrafts({ ...drafts, [name]: text });
    const params = parse(text);
    if (params && chosen(name)) onChange(value.map((item) => (item.name === name ? { ...item, params } : item)));
  };

  return (
    <div className="menu" ref={root}>
      <button type="button" onClick={() => setOpen(!open)} data-testid="indicators">
        指标{value.length > 0 ? `（${value.length}）` : ''}
      </button>
      {open && (
        <div className="popover" data-testid="indicator-list">
          {INDICATORS.map((info) => {
            const item = chosen(info.name);
            return (
              <label key={info.name} className="indicator">
                <input type="checkbox" checked={!!item} data-testid={`indicator-${info.name}`} onChange={(event) => toggle(info.name, event.target.checked)} />
                <span>{info.label}</span>
                <input
                  className="params"
                  value={drafts[info.name] ?? (item ?? info).params.join(', ')}
                  title="参数，用逗号分隔"
                  data-testid={`params-${info.name}`}
                  onChange={(event) => retune(info.name, event.target.value)}
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
