import { useEffect, useRef, useState } from 'react';

import type { ScreenInfo } from '../types';

interface Props {
  screens: ScreenInfo[];
  /** The screen that is running, by name. */
  busy: string | null;
  onRun(screen: ScreenInfo): void;
  onCheck(screen: ScreenInfo): void;
}

/** The scripts that look for signals: run one on the symbol, or check it for looking ahead. */
export function ScreenMenu({ screens, busy, onRun, onCheck }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button type="button" onClick={() => setOpen(!open)} data-testid="screens" disabled={busy !== null}>
        {busy ? '筛选中…' : '筛选'}
      </button>
      {open && (
        <div className="popover wide" data-testid="screen-list">
          {screens.length === 0 && <p className="dim">没有筛选脚本。把脚本放到工作区的 screens 文件夹里。</p>}
          {screens.map((screen) => (
            <div key={screen.name} className="screen" data-testid={`screen-${screen.name}`}>
              <div className="screen-text">
                <strong>{screen.name}</strong>
                <span className="dim">{screen.title}</span>
                <span className="dim">
                  参数：{Object.entries(screen.params).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('，') || '无'}
                  {screen.shipped ? '　（自带）' : ''}
                </span>
              </div>
              <div className="screen-actions">
                <button type="button" className="primary" data-testid={`run-${screen.name}`} onClick={() => { setOpen(false); onRun(screen); }}>
                  运行
                </button>
                <button type="button" data-testid={`check-${screen.name}`} title="用截断的数据重跑，看它有没有偷看未来" onClick={() => { setOpen(false); onCheck(screen); }}>
                  检查
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
