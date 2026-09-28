import type { StudySummary } from '../types';

interface Props {
  tag: string;
  comment: string;
  studies: StudySummary[];
  current: string | null;
  onTag(value: string): void;
  onComment(value: string): void;
  onOpen(id: string): void;
  onRemove(id: string): void;
}

const when = (stamp: string) => stamp.replace('T', ' ').replace('Z', '').slice(0, 16);

/** Quick tag, comment, and the studies saved so far. */
export function SidePanel({ tag, comment, studies, current, onTag, onComment, onOpen, onRemove }: Props) {
  return (
    <aside className="side">
      <label className="field">
        <span>快评（显示在图上的标签）</span>
        <input value={tag} maxLength={40} data-testid="tag" placeholder="例如：箱体·待突破" onChange={(event) => onTag(event.target.value)} />
      </label>
      <label className="field grow">
        <span>评论（用到的模型、当时的想法）</span>
        <textarea value={comment} data-testid="comment" placeholder="说不清楚的地方照实写，例如“感觉如此”。" onChange={(event) => onComment(event.target.value)} />
      </label>
      <section className="studies">
        <h2>已保存的记录（{studies.length}）</h2>
        <ul data-testid="studies">
          {studies.map((study) => (
            <li key={study.id} className={study.id === current ? 'study current' : 'study'} data-testid={`study-${study.id}`}>
              <button type="button" className="open" onClick={() => onOpen(study.id)} title={study.excerpt}>
                <strong>{study.tag || '（无快评）'}</strong>
                <span>
                  {study.symbol.toUpperCase()} · {study.timeframe} · {study.drawings} 个标注
                </span>
                <span className="dim">保存于 {when(study.updated)} UTC</span>
                {study.excerpt && <span className="excerpt">{study.excerpt}</span>}
              </button>
              <button type="button" className="remove" title="删除这条记录" data-testid={`remove-${study.id}`} onClick={() => onRemove(study.id)}>
                ×
              </button>
            </li>
          ))}
          {studies.length === 0 && <li className="dim">还没有保存过记录。</li>}
        </ul>
      </section>
    </aside>
  );
}
