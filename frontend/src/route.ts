// Which window a page is: the main window with the signals, or a window that studies one of them.

export type StudyKind = 'signal' | 'touch' | 'free';

export type Route =
  | { window: 'main'; project: string | null }
  | { window: 'study'; kind: 'signal' | 'touch'; id: string; project: string | null }
  /** A study that stands on its own; without an id it is a new one. */
  | { window: 'study'; kind: 'free'; id: string | null; symbol: string | null; timeframe: string | null; focus: number | null; project: string | null }
  /** The chat with an assistant, told what the user is looking at. */
  | { window: 'chat'; symbol: string | null; timeframe: string | null; signal: string | null; project: string | null };

export type StudyRoute = Extract<Route, { window: 'study' }>;
export type ChatRoute = Extract<Route, { window: 'chat' }>;

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [first, kind, id] = path.split('/');
  const params = new URLSearchParams(query);
  const project = params.get('project');
  if (first === 'chat') return { window: 'chat', symbol: params.get('symbol'), timeframe: params.get('timeframe'), signal: params.get('signal'), project };
  if (first !== 'study') return { window: 'main', project };
  if ((kind === 'signal' || kind === 'touch') && id) return { window: 'study', kind, id, project };
  if (kind === 'free') {
    const focus = Number(params.get('focus'));
    return {
      window: 'study',
      kind,
      id: id && id !== 'new' ? id : null,
      symbol: params.get('symbol'),
      timeframe: params.get('timeframe'),
      focus: params.has('focus') && Number.isFinite(focus) ? focus : null,
      project,
    };
  }
  return { window: 'main', project };
}

/** The address with the project added, so that the window it opens works on the same records. */
function withProject(hash: string, project: string | null): string {
  if (!project) return hash;
  return `${hash}${hash.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}`;
}

export function formatRoute(route: Route): string {
  if (route.window === 'main') return withProject('#/', route.project);
  if (route.window === 'chat') {
    const params = new URLSearchParams();
    if (route.symbol) params.set('symbol', route.symbol);
    if (route.timeframe) params.set('timeframe', route.timeframe);
    if (route.signal) params.set('signal', route.signal);
    return withProject(`#/chat?${params}`, route.project);
  }
  if (route.kind !== 'free') return withProject(`#/study/${route.kind}/${route.id}`, route.project);
  if (route.id !== null) return withProject(`#/study/free/${route.id}`, route.project);
  const params = new URLSearchParams();
  if (route.symbol) params.set('symbol', route.symbol);
  if (route.timeframe) params.set('timeframe', route.timeframe);
  if (route.focus !== null) params.set('focus', String(route.focus));
  return withProject(`#/study/free/new?${params}`, route.project);
}

const opened = new Map<string, Window>();
let fresh = 0;

/**
 * Opens a study in a window of its own; a study that is open already comes to the front.
 * Returns false where the browser did not allow the window.
 */
export function openStudy(route: StudyRoute | ChatRoute): boolean {
  const name = `${route.project ? `${route.project}-` : ''}${route.window === 'chat' ? 'candle-chat' : route.id === null ? `candle-study-new-${++fresh}` : `candle-study-${route.kind}-${route.id}`}`;
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
