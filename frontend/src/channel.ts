// Windows of the application tell each other what they have saved.

import type { StudyKind } from './route';

export interface Notice {
  type: 'saved' | 'removed';
  kind: StudyKind;
  id: string;
  symbol: string;
}

const NAME = 'candle-viewer';

export function announce(notice: Notice): void {
  if (!('BroadcastChannel' in window)) return;
  const channel = new BroadcastChannel(NAME);
  channel.postMessage(notice);
  channel.close();
}

/** Hears what other windows announce. Returns the function that stops listening. */
export function listen(handler: (notice: Notice) => void): () => void {
  if (!('BroadcastChannel' in window)) return () => undefined;
  const channel = new BroadcastChannel(NAME);
  channel.onmessage = (event: MessageEvent<Notice>) => handler(event.data);
  return () => channel.close();
}
