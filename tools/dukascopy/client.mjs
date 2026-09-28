// Paced, cached access to the Dukascopy data server.
//
// The files sit behind a content delivery network. Whatever anybody fetched
// during the last week is answered by the network itself, quickly and without
// limit. Everything else is passed on to Dukascopy's own server, which refuses
// clients that ask too much (HTTP 429) and keeps refusing for hours.
//
// The network stores a separate copy for each encoding a client accepts, and
// the uncompressed copies are by far the most complete. Every file is therefore
// asked for uncompressed first and compressed second. A file that is refused
// both ways is left out for now and reported, so that one missing file does not
// hold up the rest; a later run asks for it again.

import path from 'node:path';

import { CacheManager } from 'dukascopy-node';

export const log = (...parts) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...parts);
export const day = (date) => date.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const ENCODINGS = [{ 'accept-encoding': 'identity' }, {}];
const REFUSALS_BEFORE_PAUSE = 20;   // files refused one after another

export const clientOptions = {
  rate: { type: 'string', default: '4' },          // files per second
  connections: { type: 'string', default: '8' },   // requests under way at the same time
  attempts: { type: 'string', default: '6' },      // per file, for failures other than a refusal
  'refusal-pause': { type: 'string', default: '15' },   // minutes of rest after many refusals in a row
  'cache-only': { type: 'boolean', default: false },    // work with what is on disk, ask for nothing
};

export function createClient(out, args) {
  const cache = new CacheManager({ cacheFolderPath: path.join(out, 'cache') });
  const pace = { interval: 1000 / Number(args.rate), next: 0, blockedUntil: 0, refusedInARow: 0 };
  const count = { network: 0, server: 0, refused: 0 };

  // The period in progress changes with every request and is never cached.
  const isMutable = (url) => new URL(url).searchParams.has('from');

  // Waits for the next free sending slot.
  async function slot() {
    for (;;) {
      const now = Date.now();
      if (now < pace.blockedUntil) {
        await sleep(pace.blockedUntil - now);
        continue;
      }
      const at = Math.max(now, pace.next);
      pace.next = at + pace.interval;
      await sleep(at - now);
      if (Date.now() >= pace.blockedUntil) return;
    }
  }

  // Asks for one file in each encoding; null when the server refuses both.
  async function request(url) {
    await slot();
    for (const headers of ENCODINGS) {
      const response = await fetch(url, { headers });
      if (response.status === 429) {
        await response.arrayBuffer();
        continue;
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      JSON.parse(buffer.toString('utf8'));   // a truncated response must not reach the cache
      const fromNetwork = (response.headers.get('x-cache') ?? '').startsWith('Hit');
      count[fromNetwork ? 'network' : 'server']++;
      return buffer;
    }
    return null;
  }

  // One response from the cache or from outside; null when it cannot be had for now.
  async function obtain(url) {
    if (!isMutable(url)) {
      const cached = await cache.readItemFromCache(url);
      if (cached) return cached;
    }
    if (args['cache-only']) return null;
    for (let attempt = 1; ; attempt++) {
      try {
        const buffer = await request(url);
        if (buffer === null) {
          count.refused++;
          if (++pace.refusedInARow >= REFUSALS_BEFORE_PAUSE && Date.now() >= pace.blockedUntil) {
            const minutes = Number(args['refusal-pause']);
            log(`${pace.refusedInARow} files refused in a row; pausing ${minutes} minutes`);
            pace.blockedUntil = Date.now() + minutes * 60_000;
            pace.refusedInARow = 0;
          }
          return null;
        }
        pace.refusedInARow = 0;
        if (!isMutable(url)) await cache.writeItemsToCache([{ url, buffer }]);
        return buffer;
      } catch (error) {
        if (attempt >= Number(args.attempts)) throw new Error(`${url}: ${error.message} after ${attempt} attempts`);
        const pause = Math.min(10 * attempt, 120);
        log(`${error.message} for ${url.split('/v1/')[1]}; trying again in ${pause}s`);
        await sleep(pause * 1000);
      }
    }
  }

  // Responses for all urls, in order; `buffer` is null for files that could not be had.
  async function obtainAll(urls) {
    const buffers = new Array(urls.length);
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const index = next++;
        buffers[index] = await obtain(urls[index]);
      }
    };
    await Promise.all(Array.from({ length: Number(args.connections) }, worker));
    return urls.map((url, index) => ({ url, buffer: buffers[index] }));
  }

  return { obtainAll, count };
}
