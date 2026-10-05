import { BASES, REASONS, STATUSES, describe, moment, stamped } from '../format';
import type { StudyKind } from '../route';
import type { Basis, Signal, Status, StrategyText, Study, Touch } from '../types';

/** What is said about a signal apart from its shape, as the user edits it. */
export interface Facts {
  /** Names of models, separated by commas. */
  models: string;
  basis: Basis;
  status: Status;
  /** Value of the input for the time the signal could first be known; empty for none. */
  knownAt: string;
}

interface Props {
  kind: StudyKind;
  tag: string;
  comment: string;
  signal: Signal | null;
  /** The study of the signal, in the window of a touch. */
  signalStudy: Study | null;
  touch: Touch | null;
  facts: Facts | null;
  /** Whether the shape of the signal on the charts differs from the one that is stored. */
  moved: boolean;
  strategies: StrategyText[];
  onTag(value: string): void;
  onComment(value: string): void;
  onFacts(facts: Facts): void;
  onRestoreShape(): void;
  onOpenSignal(): void;
  onStrategies(strategies: StrategyText[]): void;
}

const BASIS_ORDER: Basis[] = ['model', 'partial', 'feeling', 'unset'];
const STATUS_ORDER: Status[] = ['confirmed', 'candidate', 'rejected'];

/** Quick tag and comment of a study, and what belongs to the signal or the touch it is about. */
export function StudyPanel(props: Props) {
  const { kind, signal, signalStudy, touch, facts, strategies } = props;
  const change = (index: number, changes: Partial<StrategyText>) => props.onStrategies(strategies.map((item, position) => (position === index ? { ...item, ...changes } : item)));

  return (
    <aside className="side">
      {kind !== 'free' && signal && (
        <section className="about" data-testid="about">
          <strong>{kind === 'signal' ? '信号' : '触及'}</strong>
          {kind === 'touch' && touch && (
            <span>
              {moment(touch.timestamp)} UTC　价格 {touch.value}
            </span>
          )}
          <span className="dim">
            {kind === 'touch' ? `触及的信号：${signal.note.tag || '（无快评）'}　` : ''}
            {describe(signal.versions[signal.versions.length - 1] ?? { shape: 'point', anchors: [], timeframe: 'd1' })}
          </span>
          {kind === 'touch' && (
            <>
              {signal.models.length > 0 && <span>模型：{signal.models.join('、')}</span>}
              {signalStudy?.comment && <p className="comment" data-testid="signal-comment">{signalStudy.comment}</p>}
              <span className="dim">{signalStudy ? `信号研究里的 ${signalStudy.drawings.length} 个标注以虚线显示在各窗格里。` : '信号还没有研究记录。'}</span>
              <div className="actions start">
                <button type="button" className="plain" data-testid="open-signal" onClick={props.onOpenSignal}>
                  打开信号的研究窗口
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <label className="field">
        <span>快评（显示在主窗口{kind === 'touch' ? '触及' : '信号'}旁的标签）</span>
        <input value={props.tag} maxLength={40} data-testid="tag" placeholder="例如：箱体·待突破" onChange={(event) => props.onTag(event.target.value)} />
      </label>
      <label className="field grow">
        <span>评论（用到的模型、当时的想法）</span>
        <textarea value={props.comment} data-testid="comment" placeholder="说不清楚的地方照实写，例如“感觉如此”。" onChange={(event) => props.onComment(event.target.value)} />
      </label>

      {kind === 'signal' && signal && facts && (
        <>
          <label className="field">
            <span>用到的模型（用逗号分隔，可不填）</span>
            <input value={facts.models} data-testid="models" placeholder="例如：箱体突破，趋势回踩" onChange={(event) => props.onFacts({ ...facts, models: event.target.value })} />
          </label>
          <div className="field">
            <span>这个信号能用模型说清楚吗</span>
            <div className="choices" data-testid="basis">
              {BASIS_ORDER.map((basis) => (
                <label key={basis} className="choice">
                  <input type="radio" name="basis" checked={facts.basis === basis} data-testid={`basis-${basis}`} onChange={() => props.onFacts({ ...facts, basis })} />
                  <span>{BASES[basis]}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="pair">
            <label className="field">
              <span>状态</span>
              <select value={facts.status} data-testid="status" onChange={(event) => props.onFacts({ ...facts, status: event.target.value as Status })}>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {STATUSES[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" title="信号最早在什么时候能被认出来。例如一个高点要等价格回落之后才能确认。以后检查筛选脚本有没有“偷看未来”时会用到。">
              <span>何时可知（UTC，可不填）</span>
              <input type="datetime-local" value={facts.knownAt} data-testid="known-at" onChange={(event) => props.onFacts({ ...facts, knownAt: event.target.value })} />
            </label>
          </div>
          <section className="versions" data-testid="versions">
            <h2>形状的版本（{signal.versions.length}）</h2>
            {props.moved && (
              <p className="notice-line" data-testid="moved">
                图上的形状已修改，保存时会成为新版本。
                <button type="button" className="plain" data-testid="restore-shape" onClick={props.onRestoreShape}>
                  恢复原形状
                </button>
              </p>
            )}
            <ol>
              {[...signal.versions].reverse().map((version) => (
                <li key={version.version}>
                  <span>
                    第 {version.version} 版　{REASONS[version.reason]}
                  </span>
                  <span className="dim">{describe(version)}</span>
                  {version.note && <span>{version.note}</span>}
                  <span className="dim">记录于 {stamped(version.created)} UTC</span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      {kind === 'touch' && (
        <section className="strategies" data-testid="strategies">
          <h2>触及后的策略（{strategies.length}）</h2>
          <p className="dim">同一次触及可以并排写几种：当时的做法、现在的想法、另一个模型的看法。</p>
          {strategies.map((strategy, index) => (
            <div key={strategy.id ?? `new-${index}`} className="strategy" data-testid={`strategy-${index}`}>
              <div className="strategy-head">
                <input value={strategy.label} maxLength={40} placeholder="名称，例如：当时的做法" data-testid={`strategy-label-${index}`} onChange={(event) => change(index, { label: event.target.value })} />
                <button type="button" className="plain" title="删除这条策略" data-testid={`strategy-remove-${index}`} onClick={() => props.onStrategies(strategies.filter((_, position) => position !== index))}>
                  ×
                </button>
              </div>
              <textarea value={strategy.text} placeholder="入场、止损、止盈、加仓……" data-testid={`strategy-text-${index}`} onChange={(event) => change(index, { text: event.target.value })} />
            </div>
          ))}
          <button type="button" data-testid="strategy-add" onClick={() => props.onStrategies([...strategies, { label: '', text: '' }])}>
            添加一条策略
          </button>
        </section>
      )}
    </aside>
  );
}
