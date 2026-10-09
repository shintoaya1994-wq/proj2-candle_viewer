import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api';
import { describe } from '../format';
import type { ChatRoute } from '../route';
import type { AiSettings, Availability, ChatMessage, Provider, Signal } from '../types';

/** One turn of the conversation as shown: the text, and what the assistant did on the way. */
interface Turn extends ChatMessage {
  thinking?: string;
  tools?: string[];
  error?: string;
  /** Still arriving. */
  open?: boolean;
}

const PROVIDERS: Provider[] = ['local', 'claude', 'codex'];
const newChatId = () => `chat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export function ChatWindow({ route }: { route: ChatRoute }) {
  const [status, setStatus] = useState<Availability[]>([]);
  const [provider, setProvider] = useState<Provider>(() => (window.localStorage.getItem('candle-viewer.chat.provider') as Provider | null) ?? 'local');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatId, setChatId] = useState(newChatId);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const stop = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.aiStatus().then(setStatus).catch((error: unknown) => setMessage(`读取 AI 状态失败：${error instanceof Error ? error.message : String(error)}`));
  }, []);

  useEffect(() => {
    refresh();
    document.title = 'AI 对话 · K 线研究';
  }, [refresh]);

  useEffect(() => {
    if (!route.signal) {
      setSignal(null);
      return;
    }
    api.signal(route.signal).then(setSignal).catch(() => setSignal(null));
  }, [route.signal]);

  useEffect(() => {
    window.localStorage.setItem('candle-viewer.chat.provider', provider);
  }, [provider]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  const ask = async () => {
    const question = draft.trim();
    if (question === '' || busy) return;
    const history: ChatMessage[] = [...turns.filter((turn) => !turn.error).map(({ role, content }) => ({ role, content })), { role: 'user', content: question }];
    setDraft('');
    setTurns((before) => [...before, { role: 'user', content: question }, { role: 'assistant', content: '', open: true }]);
    setBusy(true);
    setMessage('');
    const controller = new AbortController();
    stop.current = controller;
    const patch = (changes: (turn: Turn) => Turn) => setTurns((before) => before.map((turn, index) => (index === before.length - 1 ? changes(turn) : turn)));
    try {
      await api.chat(
        { provider, chat: chatId, messages: history, context: { symbol: route.symbol, timeframe: route.timeframe, signal: route.signal } },
        (event) => {
          if (event.type === 'text') patch((turn) => ({ ...turn, content: turn.content + event.text }));
          else if (event.type === 'thinking') patch((turn) => ({ ...turn, thinking: (turn.thinking ?? '') + event.text }));
          else if (event.type === 'tool') patch((turn) => ({ ...turn, tools: [...(turn.tools ?? []), event.name] }));
          else if (event.type === 'error') patch((turn) => ({ ...turn, error: event.message }));
        },
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted) patch((turn) => ({ ...turn, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      patch((turn) => ({ ...turn, open: false }));
      setBusy(false);
      stop.current = null;
    }
  };

  const chosen = status.find((item) => item.provider === provider);
  const context = [route.symbol ? route.symbol.toUpperCase() : null, route.timeframe, signal ? `信号 ${signal.note.tag || describe(signal.versions[signal.versions.length - 1] ?? { shape: 'point', anchors: [], timeframe: 'd1' })}` : null].filter(Boolean).join(' · ');

  return (
    <div className="app chat-window" data-testid="chat-window">
      <header className="toolbar">
        <div className="group">
          <strong className="title">AI 对话</strong>
          <select value={provider} data-testid="provider" onChange={(event) => setProvider(event.target.value as Provider)}>
            {PROVIDERS.map((name) => {
              const item = status.find((entry) => entry.provider === name);
              return (
                <option key={name} value={name} disabled={item ? !item.enabled : false}>
                  {item?.label ?? name}
                  {item && !item.enabled ? '（已关闭）' : item && !item.available ? '（不可用）' : ''}
                </option>
              );
            })}
          </select>
          <span className="dim" data-testid="availability">{chosen?.detail ?? ''}</span>
        </div>
        <div className="group end">
          <button type="button" data-testid="new-chat" onClick={() => { setTurns([]); setChatId(newChatId()); }}>
            新对话
          </button>
          <button type="button" data-testid="ai-settings" onClick={() => api.aiSettings().then((loaded) => { setSettings(loaded); setEditing(true); })}>
            设置
          </button>
        </div>
      </header>

      <div className="backdrop dim" data-testid="context">
        {context ? `对话背景：${context}` : '没有选中品种或信号。从主窗口打开时会带上正在看的东西。'}
        {provider !== 'local' && '　这个助手能通过接口读行情、标记候选信号、写筛选脚本。'}
      </div>

      <main className="turns" data-testid="turns">
        {turns.length === 0 && <p className="dim">问点什么，例如“这个信号的后续触及有什么共同点？”或“写一个在日线上找 20 日新高的筛选脚本”。</p>}
        {turns.map((turn, index) => (
          <article key={index} className={`turn ${turn.role}`} data-testid={`turn-${index}`}>
            {turn.thinking && <details className="thinking"><summary>思考过程</summary><pre>{turn.thinking}</pre></details>}
            {turn.tools && turn.tools.length > 0 && <div className="tools dim">{turn.tools.map((name, position) => <span key={position}>调用 {name}</span>)}</div>}
            <pre className="said">{turn.content || (turn.open ? '…' : '')}</pre>
            {turn.error && <div className="error" data-testid="chat-error">{turn.error}</div>}
          </article>
        ))}
        <div ref={bottom} />
      </main>

      <footer className="ask">
        <textarea
          value={draft}
          placeholder="输入问题，Enter 发送，Shift+Enter 换行"
          data-testid="draft"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask();
            }
          }}
        />
        {busy ? (
          <button type="button" data-testid="stop" onClick={() => stop.current?.abort()}>
            停止
          </button>
        ) : (
          <button type="button" className="primary" data-testid="send" disabled={draft.trim() === '' || !chosen?.available} onClick={() => void ask()}>
            发送
          </button>
        )}
      </footer>
      {message && <div className="status"><span data-testid="message">{message}</span></div>}

      {editing && settings && (
        <div className="veil" onMouseDown={(event) => event.target === event.currentTarget && setEditing(false)}>
          <form
            className="dialog settings"
            data-testid="settings-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              api
                .saveAiSettings(settings)
                .then(() => { setEditing(false); refresh(); })
                .catch((error: unknown) => setMessage(`保存设置失败：${error instanceof Error ? error.message : String(error)}`));
            }}
          >
            <h2>AI 设置</h2>
            <label className="choice"><input type="checkbox" checked={settings.local.enabled} onChange={(event) => setSettings({ ...settings, local: { ...settings.local, enabled: event.target.checked } })} /><span>本地模型（OpenAI 兼容接口）</span></label>
            <label className="field"><span>地址</span><input value={settings.local.baseUrl} data-testid="local-url" onChange={(event) => setSettings({ ...settings, local: { ...settings.local, baseUrl: event.target.value } })} /></label>
            <label className="field"><span>模型名（留空用服务列出的第一个）</span><input value={settings.local.model} onChange={(event) => setSettings({ ...settings, local: { ...settings.local, model: event.target.value } })} /></label>
            <label className="field"><span>密钥（没有就留空）</span><input value={settings.local.apiKey} onChange={(event) => setSettings({ ...settings, local: { ...settings.local, apiKey: event.target.value } })} /></label>
            <label className="choice"><input type="checkbox" checked={settings.claude.enabled} onChange={(event) => setSettings({ ...settings, claude: { ...settings.claude, enabled: event.target.checked } })} /><span>Claude Code</span></label>
            <label className="field"><span>命令（留空则在 PATH 里找 claude）</span><input value={settings.claude.command} onChange={(event) => setSettings({ ...settings, claude: { ...settings.claude, command: event.target.value } })} /></label>
            <label className="choice"><input type="checkbox" checked={settings.codex.enabled} onChange={(event) => setSettings({ ...settings, codex: { ...settings.codex, enabled: event.target.checked } })} /><span>Codex</span></label>
            <label className="field"><span>命令（留空则在 PATH 里找 codex）</span><input value={settings.codex.command} onChange={(event) => setSettings({ ...settings, codex: { ...settings.codex, command: event.target.value } })} /></label>
            <div className="actions">
              <button type="button" onClick={() => setEditing(false)}>取消</button>
              <button type="submit" className="primary" data-testid="settings-ok">保存</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
