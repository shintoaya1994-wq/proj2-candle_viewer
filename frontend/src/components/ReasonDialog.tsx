import { useState, type FormEvent } from 'react';

export interface Reason {
  reason: 'market' | 'review';
  note: string;
}

interface Props {
  onDone(reason: Reason | null): void;
}

/** Asks why the shape of a signal was changed. The earlier shape is kept either way. */
export function ReasonDialog({ onDone }: Props) {
  const [reason, setReason] = useState<Reason['reason']>('market');
  const [note, setNote] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onDone({ reason, note: note.trim() });
  };

  return (
    <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && onDone(null)}>
      <form className="dialog" onSubmit={submit} data-testid="reason-dialog">
        <h2>信号的形状改了</h2>
        <p className="dim">原来的形状不会丢，会作为较早的版本保留。已有的触及仍然指向它们当时对应的版本。</p>
        <label className="choice">
          <input type="radio" name="reason" checked={reason === 'market'} data-testid="reason-market" onChange={() => setReason('market')} />
          <span>
            <strong>行情变化</strong>　信号本身随行情更新了，例如箱体延长
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="reason" checked={reason === 'review'} data-testid="reason-review" onChange={() => setReason('review')} />
          <span>
            <strong>复盘修正</strong>　当初标得不准，现在改正
          </span>
        </label>
        <input value={note} maxLength={200} placeholder="说明（可不填）" data-testid="reason-note" onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && onDone(null)} />
        <div className="actions">
          <button type="button" onClick={() => onDone(null)}>
            取消
          </button>
          <button type="submit" className="primary" data-testid="reason-ok">
            保存为新版本
          </button>
        </div>
      </form>
    </div>
  );
}
