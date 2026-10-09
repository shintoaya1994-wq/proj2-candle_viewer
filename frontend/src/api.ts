import type {
  AiSettings,
  Availability,
  BarsResponse,
  ChatEvent,
  ChatRequest,
  Meta,
  NewSignal,
  NewTouch,
  NewVersion,
  ScreenInfo,
  ScreenOutcome,
  ScreenReport,
  Signal,
  SignalChanges,
  Strategy,
  StrategyText,
  Study,
  StudyContent,
  StudySummary,
  SubjectKind,
  Touch,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      detail = typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail);
    } catch {
      // not JSON; the text itself is the message
    }
    throw new ApiError(response.status, detail || response.statusText);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export interface BarsQuery {
  symbol: string;
  timeframe: string;
  before?: number;
  after?: number;
  around?: number;
  since?: number;
  count?: number;
}

/** Where the records of a signal or a touch are found. */
const home = (kind: SubjectKind, id: string) => `/api/${kind === 'signal' ? 'signals' : 'touches'}/${id}`;

/** What this interface asks of the program; see API in src/candle_viewer/app/main.py. */
export const API = 2;

export const api = {
  meta: () => request<Meta>('/api/meta'),
  bars(query: BarsQuery) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return request<BarsResponse>(`/api/bars?${params}`);
  },

  // studies that stand on their own
  studies: () => request<StudySummary[]>('/api/studies'),
  study: (id: string) => request<Study>(`/api/studies/${id}`),
  create: (content: StudyContent) => request<Study>('/api/studies', json('POST', content)),
  update: (id: string, content: StudyContent) => request<Study>(`/api/studies/${id}`, json('PUT', content)),
  remove: (id: string) => request<void>(`/api/studies/${id}`, { method: 'DELETE' }),

  signals: (symbol: string) => request<Signal[]>(`/api/signals?symbol=${encodeURIComponent(symbol)}`),
  signal: (id: string) => request<Signal>(`/api/signals/${id}`),
  createSignal: (signal: NewSignal) => request<Signal>('/api/signals', json('POST', signal)),
  changeSignal: (id: string, changes: SignalChanges) => request<Signal>(`/api/signals/${id}`, json('PATCH', changes)),
  addVersion: (id: string, version: NewVersion) => request<Signal>(`/api/signals/${id}/versions`, json('POST', version)),
  removeSignal: (id: string) => request<void>(`/api/signals/${id}`, { method: 'DELETE' }),

  touch: (id: string) => request<Touch>(`/api/touches/${id}`),
  addTouch: (signal: string, touch: NewTouch) => request<Touch>(`/api/signals/${signal}/touches`, json('POST', touch)),
  removeTouch: (id: string) => request<void>(`/api/touches/${id}`, { method: 'DELETE' }),
  strategies: (touch: string) => request<Strategy[]>(`/api/touches/${touch}/strategies`),
  saveStrategies: (touch: string, strategies: StrategyText[]) => request<Strategy[]>(`/api/touches/${touch}/strategies`, json('PUT', strategies)),

  screens: () => request<ScreenInfo[]>('/api/screens'),
  runScreen: (name: string, symbol: string, params: Record<string, unknown> = {}) => request<ScreenOutcome>(`/api/screens/${name}/run`, json('POST', { symbol, params })),
  checkScreen: (name: string, symbol: string, params: Record<string, unknown> = {}) => request<ScreenReport>(`/api/screens/${name}/check`, json('POST', { symbol, params })),

  aiSettings: () => request<AiSettings>('/api/ai/settings'),
  saveAiSettings: (settings: AiSettings) => request<AiSettings>('/api/ai/settings', json('PUT', settings)),
  aiStatus: () => request<Availability[]>('/api/ai/status'),

  /** Asks the assistant; each event arrives as it is streamed. Stops when `stop` is aborted. */
  async chat(body: ChatRequest, onEvent: (event: ChatEvent) => void, stop: AbortSignal): Promise<void> {
    const response = await fetch('/api/chat', { ...json('POST', body), signal: stop });
    if (!response.ok || !response.body) throw new ApiError(response.status, await response.text());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const parts = buffered.split('\n\n');
      buffered = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split('\n').find((item) => item.startsWith('data:'));
        if (line) onEvent(JSON.parse(line.slice(5)) as ChatEvent);
      }
    }
  },

  // the study of a signal or a touch; null while nothing has been saved
  studyOf: (kind: SubjectKind, id: string) => request<Study | null>(`${home(kind, id)}/study`),
  saveStudyOf: (kind: SubjectKind, id: string, content: StudyContent) => request<Study>(`${home(kind, id)}/study`, json('PUT', content)),
};
