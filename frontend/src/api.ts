import type { BarsResponse, Meta, Study, StudyContent, StudySummary } from './types';

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

export const api = {
  meta: () => request<Meta>('/api/meta'),
  bars(query: BarsQuery) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return request<BarsResponse>(`/api/bars?${params}`);
  },
  studies: () => request<StudySummary[]>('/api/studies'),
  study: (id: string) => request<Study>(`/api/studies/${id}`),
  create: (content: StudyContent) => request<Study>('/api/studies', json('POST', content)),
  update: (id: string, content: StudyContent) => request<Study>(`/api/studies/${id}`, json('PUT', content)),
  remove: (id: string) => request<void>(`/api/studies/${id}`, { method: 'DELETE' }),
};
