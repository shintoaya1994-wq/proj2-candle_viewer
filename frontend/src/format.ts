// How times, prices and the kinds of records are written for the user.

import { timeframe } from './timeframes';
import type { Basis, Definition, Reason, Shape, Status } from './types';

const two = (value: number) => String(value).padStart(2, '0');

/** A moment as UTC date and time: 2024-01-10 13:00. */
export function moment(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

/** A moment as it suits bars of a timeframe: days and longer have no time of day. */
export function barTime(timestamp: number, name: string): string {
  const text = moment(timestamp);
  return timeframe(name).kind === 'intraday' ? text : text.slice(0, 10);
}

/** A time the backend stamped, 2026-09-28T23:01:41Z, without the seconds. */
export const stamped = (stamp: string) => stamp.replace('T', ' ').replace('Z', '').slice(0, 16);

/** A moment as the value of a date and time input, in UTC; empty for none. */
export const toInput = (timestamp: number | null) => (timestamp === null ? '' : moment(timestamp).replace(' ', 'T'));

/** The moment a date and time input holds, read as UTC; null where it is empty or not a time. */
export function fromInput(text: string): number | null {
  const found = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(text.trim());
  if (!found) return null;
  const parsed = Date.parse(`${found[1]}T${found[2] ?? '00:00'}:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export const SHAPES: Record<Shape, string> = { point: '点', level: '水平位', segment: '线', box: '框' };
export const BASES: Record<Basis, string> = { model: '能用模型说清', partial: '部分能说清', feeling: '感觉如此', unset: '未填' };
export const STATUSES: Record<Status, string> = { confirmed: '已确认', candidate: '候选', rejected: '已否定' };
export const REASONS: Record<Reason, string> = { initial: '最初标记', market: '行情变化', review: '复盘修正' };

/** Where and when a signal is, in a few words: 日线 框 2024-01-02 ~ 2024-01-20. */
export function describe(definition: Pick<Definition, 'shape' | 'anchors' | 'timeframe'>): string {
  const times = definition.anchors.map((anchor) => anchor.timestamp).sort((a, b) => a - b);
  const first = times[0];
  const last = times[times.length - 1];
  const span = first === undefined || last === undefined ? '' : first === last ? barTime(first, definition.timeframe) : `${barTime(first, definition.timeframe)} ~ ${barTime(last, definition.timeframe)}`;
  return `${timeframe(definition.timeframe).title} ${SHAPES[definition.shape]} ${span}`.trim();
}

/** Names of models from what the user typed: separated by commas, no empty ones, none twice. */
export function modelsOf(text: string): string[] {
  const names = text
    .split(/[,，、;；\n]+/)
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return [...new Set(names)];
}
