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
}

export interface DrawingState {
  id: string;
  name: string;
  points: PointState[];
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

export interface StudyContent {
  symbol: string;
  timeframe: string;
  focus: number | null;
  tag: string;
  comment: string;
  drawings: DrawingState[];
  indicators: IndicatorState[];
  view: ViewState;
  timezone: string;
  screenshot?: string | null;
}

export interface Study extends StudyContent {
  id: string;
  created: string;
  updated: string;
  hasScreenshot: boolean;
  schemaVersion: number;
}

export interface StudySummary {
  id: string;
  symbol: string;
  timeframe: string;
  focus: number | null;
  tag: string;
  excerpt: string;
  drawings: number;
  created: string;
  updated: string;
  hasScreenshot: boolean;
}
