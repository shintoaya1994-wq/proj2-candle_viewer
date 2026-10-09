import { BASES, STATUSES, describe, moment, stamped } from '../format';
import type { Signal, Status, StudySummary } from '../types';

interface Props {
  signals: Signal[];
  /** How many signals the symbol has before the filter. */
  total: number;
  chosen: string | null;
  filter: string;
  hideRejected: boolean;
  /** How many signals of the symbol are rejected. */
  rejected: number;
  studies: StudySummary[];
  onFilter(text: string): void;
  onHideRejected(hide: boolean): void;
  onStatus(id: string, status: Status): void;
  onChoose(id: string): void;
  onOpen(id: string): void;
  onAddTouch(id: string): void;
  onRemove(id: string): void;
  onOpenTouch(id: string): void;
  onRemoveTouch(id: string): void;
  onOpenStudy(id: string): void;
  onRemoveStudy(id: string): void;
  onNewStudy(): void;
}

/** Whether a signal is one the user looks for: the words may be in its tag, its models or its comment. */
export function matches(signal: Signal, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const version = signal.versions[signal.versions.length - 1];
  const text = [signal.note.tag, signal.note.comment, ...signal.models, BASES[signal.basis], STATUSES[signal.status], version ? describe(version) : '', ...signal.touches.map((touch) => `${touch.note.tag} ${touch.note.comment}`)]
    .join(' ')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The signals of the symbol, what the chosen one is about, and the studies that stand on their own. */
export function SignalPanel(props: Props) {
  const { signals, chosen, studies } = props;
  const signal = signals.find((item) => item.id === chosen);
  const version = signal?.versions[signal.versions.length - 1];

  return (
    <aside className="side">
      <section className="signals">
        <h2>
          信号（{props.filter.trim() === '' ? props.total : `${signals.length} / ${props.total}`}）
        </h2>
        <input className="filter" value={props.filter} placeholder="筛选：快评、模型、评论里的字" data-testid="filter" onChange={(event) => props.onFilter(event.target.value)} />
        <label className="choice small">
          <input type="checkbox" checked={props.hideRejected} data-testid="hide-rejected" onChange={(event) => props.onHideRejected(event.target.checked)} />
          <span>不显示已否定的（{props.rejected}）</span>
        </label>
        <ul data-testid="signals">
          {[...signals].reverse().map((item) => {
            const latest = item.versions[item.versions.length - 1];
            return (
              <li key={item.id} className={item.id === chosen ? 'row current' : 'row'} data-testid={`signal-${item.id}`}>
                <button type="button" className="open" title="在图上找到它" onClick={() => props.onChoose(item.id)}>
                  <strong>
                    {item.note.tag || (item.note.studied ? '（无快评）' : '未评')}
                    {item.status !== 'confirmed' && <em className={`badge ${item.status}`}>{STATUSES[item.status]}</em>}
                  </strong>
                  <span>{latest ? describe(latest) : ''}</span>
                  <span className="dim">
                    {item.models.length > 0 ? `${item.models.join('、')}　` : ''}
                    {item.touches.length > 0 ? `触及 ${item.touches.length} 次` : ''}
                  </span>
                </button>
              </li>
            );
          })}
          {props.total === 0 && <li className="dim">这个品种还没有信号。用上方“标记信号”的工具在图上标出来。</li>}
          {props.total > 0 && signals.length === 0 && <li className="dim">没有符合筛选的信号。</li>}
        </ul>
      </section>

      {signal && version && (
        <section className="chosen" data-testid="chosen">
          <h2>{signal.note.tag || '未评的信号'}</h2>
          <span className="dim">
            {describe(version)}　{STATUSES[signal.status]}
            {signal.versions.length > 1 ? `　第 ${version.version} 版` : ''}
          </span>
          {signal.models.length > 0 && <span>模型：{signal.models.join('、')}</span>}
          {signal.basis !== 'unset' && <span>{BASES[signal.basis]}</span>}
          {signal.origin !== 'manual' && <span className="dim">来自筛选 {signal.origin}</span>}
          {version.note && <p className="comment" data-testid="signal-note">{version.note}</p>}
          {signal.note.comment && <p className="comment">{signal.note.comment}</p>}
          {signal.status !== 'confirmed' && (
            <div className="actions start" data-testid="decide">
              <button type="button" className="primary" data-testid="confirm-signal" onClick={() => props.onStatus(signal.id, 'confirmed')}>
                确认是信号
              </button>
              {signal.status !== 'rejected' && (
                <button type="button" data-testid="reject-signal" onClick={() => props.onStatus(signal.id, 'rejected')}>
                  否定
                </button>
              )}
            </div>
          )}
          <div className="actions start">
            <button type="button" className={signal.status === 'confirmed' ? 'primary' : ''} data-testid="open-signal" onClick={() => props.onOpen(signal.id)}>
              打开研究窗口
            </button>
            <button type="button" data-testid="add-touch" onClick={() => props.onAddTouch(signal.id)}>
              添加触及
            </button>
            <button type="button" className="danger" data-testid="remove-signal" onClick={() => props.onRemove(signal.id)}>
              删除
            </button>
          </div>
          {signal.touches.length > 0 && (
            <ul className="touches" data-testid="touches">
              {signal.touches.map((touch, index) => (
                <li key={touch.id} className="row" data-testid={`touch-${touch.id}`}>
                  <button type="button" className="open" title="打开这次触及的研究窗口" onClick={() => props.onOpenTouch(touch.id)}>
                    <strong>
                      第 {index + 1} 次触及　{touch.note.tag}
                    </strong>
                    <span className="dim">
                      {moment(touch.timestamp)} UTC　{touch.value}
                      {touch.strategies > 0 ? `　策略 ${touch.strategies} 条` : ''}
                    </span>
                  </button>
                  <button type="button" className="remove" title="删除这次触及" data-testid={`remove-touch-${touch.id}`} onClick={() => props.onRemoveTouch(touch.id)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="studies">
        <h2>
          自由研究（{studies.length}）
          <button type="button" className="plain" data-testid="new-study" title="不针对某个信号，打开一个六联窗口自由画线、写评论" onClick={props.onNewStudy}>
            新建
          </button>
        </h2>
        <ul data-testid="studies">
          {studies.map((study) => (
            <li key={study.id} className="row" data-testid={`study-${study.id}`}>
              <button type="button" className="open" onClick={() => props.onOpenStudy(study.id)} title={study.excerpt}>
                <strong>{study.tag || '（无快评）'}</strong>
                <span>
                  {study.symbol.toUpperCase()} · {study.timeframes.join(' ')} · {study.drawings} 个标注
                </span>
                <span className="dim">保存于 {stamped(study.updated)} UTC</span>
              </button>
              <button type="button" className="remove" title="删除这条记录" data-testid={`remove-study-${study.id}`} onClick={() => props.onRemoveStudy(study.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
