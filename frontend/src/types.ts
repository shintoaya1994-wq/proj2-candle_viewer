// Shapes shared with the backend (src/candle_viewer/app).

export interface SeriesInfo {
  name: string;
  rows: number;
  first: number;
  last: number;
}

export interface SymbolInfo {
  name: string;
  pip: number;
  digits: number;
  timeframes: SeriesInfo[];
}

export interface Meta {
  /** What the program answers to; missing in the program of the first stage. */
  api?: number;
  convention: string;
  generated: string | null;
  symbols: SymbolInfo[];
}

export interface BarsResponse {
  columns: string[];
  bars: Array<[number, number, number, number, number, number | null, number, number]>;
  older: boolean;
  newer: boolean;
}

/** An anchor of a drawing in chart coordinates: time, price, or both. */
export interface PointState {
  timestamp: number | null;
  value: number | null;
}

export interface DrawingData {
  text?: string;
  color?: string;
  /** Set on a drawing shown for reference, so that it looks the part. Not stored. */
  reference?: boolean;
}

export interface DrawingState {
  id: string;
  name: string;
  points: PointState[];
  /** The symbol the drawing belongs to; it shows on every pane of that symbol. */
  symbol: string | null;
  /** The timeframe the drawing was made or last changed on. */
  timeframe: string | null;
  styles: Record<string, unknown> | null;
  extendData: DrawingData | null;
  lock: boolean;
  visible: boolean;
  zLevel: number;
}

export interface IndicatorState {
  name: string;
  /** "candle" for the price pane, otherwise the indicator has a pane of its own. */
  pane: string;
  params: number[];
  visible: boolean;
}

export interface ViewState {
  barSpace: number | null;
  offsetRight: number | null;
  /** Time of the last bar in view. */
  rightTimestamp: number | null;
}

/** One chart of a study. */
export interface PaneState {
  symbol: string;
  timeframe: string;
  indicators: IndicatorState[];
  view: ViewState;
}

export interface LayoutState {
  columns: number;
  rows: number;
}

export type SubjectKind = 'signal' | 'touch';

export interface Subject {
  kind: SubjectKind;
  id: string;
}

export interface StudyContent {
  symbol: string;
  /** The moment the study is about. */
  focus: number | null;
  tag: string;
  comment: string;
  drawings: DrawingState[];
  panes: PaneState[];
  layout: LayoutState;
  timezone: string;
  screenshot?: string | null;
}

export interface Study extends StudyContent {
  id: string;
  subject: Subject | null;
  created: string;
  updated: string;
  hasScreenshot: boolean;
  schemaVersion: number;
}

export interface StudySummary {
  id: string;
  symbol: string;
  timeframes: string[];
  focus: number | null;
  tag: string;
  excerpt: string;
  drawings: number;
  created: string;
  updated: string;
  hasScreenshot: boolean;
}

// -- signals, touches, strategies ------------------------------------------------

export type Shape = 'point' | 'level' | 'segment' | 'box';
export type Basis = 'model' | 'partial' | 'feeling' | 'unset';
export type Status = 'confirmed' | 'candidate' | 'rejected';
export type Reason = 'initial' | 'market' | 'review';

export interface Anchor {
  timestamp: number;
  value: number;
}

/** What a signal looks like on the chart. */
export interface Definition {
  shape: Shape;
  anchors: Anchor[];
  /** The timeframe the shape was set on. */
  timeframe: string;
  /** When the signal could first be known; often later than its anchors. */
  knownAt: number | null;
}

export interface SignalVersion extends Definition {
  version: number;
  reason: Reason;
  note: string;
  created: string;
}

export interface Relation {
  kind: 'continues' | 'replaces' | 'related';
  target: string;
}

/** What the study of a signal or a touch says, for lists and markers. */
export interface Noted {
  tag: string;
  comment: string;
  studied: boolean;
  updated: string | null;
}

export interface Touch {
  id: string;
  signalId: string;
  /** The version of the signal that was valid at the touch. */
  signalVersion: number;
  symbol: string;
  timestamp: number;
  value: number;
  timeframe: string;
  rule: string;
  origin: string;
  created: string;
  updated: string;
  note: Noted;
  /** How many strategies are written down for the touch. */
  strategies: number;
}

export interface Signal {
  id: string;
  symbol: string;
  status: Status;
  origin: string;
  models: string[];
  /** How well the user can say why this is a signal. */
  basis: Basis;
  versions: SignalVersion[];
  relations: Relation[];
  /** Names the finding among those of the screen that found it. */
  key: string | null;
  created: string;
  updated: string;
  note: Noted;
  touches: Touch[];
}

/** A script that looks for signals. */
export interface ScreenInfo {
  name: string;
  title: string;
  params: Record<string, unknown>;
  shipped: boolean;
  source: string;
}

export interface ScreenOutcome {
  found: number;
  created: string[];
  known: number;
}

// -- AI -------------------------------------------------------------------------

export type Provider = 'local' | 'claude' | 'codex';

export interface AiSettings {
  local: { enabled: boolean; baseUrl: string; model: string; apiKey: string; label: string };
  claude: { enabled: boolean; command: string; label: string };
  codex: { enabled: boolean; command: string; label: string };
}

export interface Availability {
  provider: Provider;
  label: string;
  enabled: boolean;
  available: boolean;
  detail: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  provider: Provider;
  chat: string;
  messages: ChatMessage[];
  context: { symbol: string | null; timeframe: string | null; signal: string | null };
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'error'; message: string }
  | { type: 'done'; session: string | null };

export interface ScreenReport {
  screen: string;
  symbol: string;
  found: number;
  cutoffs: number;
  passed: boolean;
  differences: Array<{ cutoff: number; kind: string; key: string; detail: string }>;
}

export interface NewSignal extends Omit<Definition, 'knownAt'> {
  symbol: string;
  knownAt?: number | null;
  models?: string[];
  basis?: Basis;
  origin?: string;
  status?: Status;
}

export interface NewVersion extends Definition {
  reason: 'market' | 'review';
  note: string;
}

export interface SignalChanges {
  models?: string[];
  basis?: Basis;
  status?: Status;
  relations?: Relation[];
  knownAt?: number | null;
  clearKnownAt?: boolean;
}

export interface NewTouch {
  timestamp: number;
  value: number;
  timeframe: string;
  rule?: string;
  origin?: string;
  signalVersion?: number | null;
}

/** What to do at a touch. A touch can hold several, side by side. */
export interface Strategy {
  id: string;
  label: string;
  text: string;
  created: string;
  updated: string;
}

export interface StrategyText {
  id?: string | null;
  label: string;
  text: string;
}
