import { useEffect, useRef } from 'react';

import type { Place } from '../chart/Pane';

export interface MenuItem {
  name: string;
  label: string;
  danger?: boolean;
  run(): void;
}

interface Props {
  at: Place;
  items: MenuItem[];
  onClose(): void;
}

/** A short list of things to do with what was clicked with the right button. */
export function Menu({ at, items, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The press of the button that opened the menu is still on its way through the page; it must not close the menu.
    const since = performance.now();
    const away = (event: MouseEvent) => {
      if (event.timeStamp > since && root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const left = Math.min(at.x, window.innerWidth - 190);
  const top = Math.min(at.y, window.innerHeight - 34 * items.length - 16);
  return (
    <div ref={root} className="context" data-testid="menu" style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item) => (
        <button
          key={item.name}
          type="button"
          className={item.danger ? 'danger' : ''}
          data-testid={`menu-${item.name}`}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
