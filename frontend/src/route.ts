// Which window a page is: the main window with the signals, or a window that studies one of them.

export type StudyKind = 'signal' | 'touch' | 'free';

export type Route =
  | { window: 'main' }
  | { window: 'study'; kind: 'signal' | 'touch'; id: string }
  /** A study that stands on its own; without an id it is a new one. */
  | { window: 'study'; kind: 'free'; id: string | null; symbol: string | null; timeframe: string | null; focus: number | null }
  /** The chat with an assistant, told what the user is looking at. */
  | { window: 'chat'; symbol: string | null; timeframe: string | null; signal: string | null };

export type StudyRoute = Extract<Route, { window: 'study' }>;
export type ChatRoute = Extract<Route, { window: 'chat' }>;

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [first, kind, id] = path.split('/');
  if (first === 'chat') {
    const params = new URLSearchParams(query);
    return { window: 'chat', symbol: params.get('symbol'), timeframe: params.get('timeframe'), signal: params.get('signal') };
  }
  if (first !== 'study') return { window: 'main' };
  if ((kind === 'signal' || kind === 'touch') && id) return { window: 'study', kind, id };
  if (kind === 'free') {
    const params = new URLSearchParams(query);
    const focus = Number(params.get('focus'));
    return {
      window: 'study',
      kind,
      id: id && id !== 'new' ? id : null,
      symbol: params.get('symbol'),
      timeframe: params.get('timeframe'),
      focus: params.has('focus') && Number.isFinite(focus) ? focus : null,
    };
  }
  return { window: 'main' };
}

export function formatRoute(route: Route): string {
  if (route.window === 'main') return '#/';
  if (route.window === 'chat') {
    const params = new URLSearchParams();
    if (route.symbol) params.set('symbol', route.symbol);
    if (route.timeframe) params.set('timeframe', route.timeframe);
    if (route.signal) params.set('signal', route.signal);
    return `#/chat?${params}`;
  }
  if (route.kind !== 'free') return `#/study/${route.kind}/${route.id}`;
  if (route.id !== null) return `#/study/free/${route.id}`;
  const params = new URLSearchParams();
  if (route.symbol) params.set('symbol', route.symbol);
  if (route.timeframe) params.set('timeframe', route.timeframe);
  if (route.focus !== null) params.set('focus', String(route.focus));
  return `#/study/free/new?${params}`;
}

const opened = new Map<string, Window>();
let fresh = 0;

/**
 * Opens a study in a window of its own; a study that is open already comes to the front.
 * Returns false where the browser did not allow the window.
 */
export function openStudy(route: StudyRoute | ChatRoute): boolean {
  const name = route.window === 'chat' ? 'candle-chat' : route.id === null ? `candle-study-new-${++fresh}` : `candle-study-${route.kind}-${route.id}`;
  const known = opened.get(name);
  if (known && !known.closed) {
    known.focus();
    return true;
  }
  // Six charts need room: the window takes most of the screen, and the user can change its size.
  const { availWidth, availHeight } = window.screen;
  const width = Math.round(availWidth * (route.window === 'chat' ? 0.4 : 0.94));
  const height = Math.round(availHeight * 0.9);
  const left = Math.round((availWidth - width) / 2);
  const child = window.open(`${window.location.pathname}${formatRoute(route)}`, name, `popup=yes,width=${width},height=${height},left=${left},top=0`);
  if (!child) return false;
  opened.set(name, child);
  return true;
}
