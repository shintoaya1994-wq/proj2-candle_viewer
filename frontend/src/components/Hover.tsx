import type { MarkHit } from '../chart/marks';
import type { Place } from '../chart/Pane';
import { BASES, STATUSES, describe, moment } from '../format';
import type { Signal } from '../types';

interface Props {
  hit: MarkHit;
  at: Place;
  signals: Signal[];
}

const WIDTH = 340;

/** What a signal or a touch is about, shown next to the mouse while it rests on the mark. */
export function Hover({ hit, at, signals }: Props) {
  const touchId = hit.mark.kind === 'touch' ? hit.mark.id : hit.touch;
  const signal = signals.find((item) => (touchId === null ? item.id === hit.mark.id : item.touches.some((touch) => touch.id === touchId)));
  if (!signal) return null;
  const touch = touchId === null ? undefined : signal.touches.find((item) => item.id === touchId);
  const version = signal.versions[signal.versions.length - 1];
  const left = at.x + 16 + WIDTH > window.innerWidth ? Math.max(4, at.x - 16 - WIDTH) : at.x + 16;
  const top = Math.min(at.y + 16, Math.max(4, window.innerHeight - 260));

  return (
    <div className="hover" data-testid="hover" style={{ left, top, width: WIDTH }}>
      {touch ? (
        <>
          <strong>{touch.note.tag || '触及（还没有快评）'}</strong>
          <span className="dim">
            {moment(touch.timestamp)} UTC　价格 {touch.value}　信号第 {touch.signalVersion} 版
          </span>
          {touch.note.comment && <p>{touch.note.comment}</p>}
          <span className="dim">
            {touch.strategies > 0 ? `策略 ${touch.strategies} 条　` : ''}点击打开触及的研究窗口
          </span>
        </>
      ) : (
        <>
          <strong>{signal.note.tag || '信号（还没有快评）'}</strong>
          <span className="dim">
            {version ? describe(version) : ''}　{STATUSES[signal.status]}
          </span>
          {signal.models.length > 0 && <span>模型：{signal.models.join('、')}</span>}
          {signal.basis !== 'unset' && <span>{BASES[signal.basis]}</span>}
          {version?.note && <p>{version.note}</p>}
          {signal.note.comment && <p>{signal.note.comment}</p>}
          <span className="dim">
            {signal.touches.length > 0 ? `触及 ${signal.touches.length} 次　` : ''}点击打开研究窗口，右键有更多操作
          </span>
        </>
      )}
    </div>
  );
}
