#!/usr/bin/env node
// Downloads bid candles from Dukascopy, decoding them with dukascopy-node.
//
// Requests are paced and every response is stored on disk at once (see
// client.mjs), so a run that is interrupted continues where it stopped. Files
// the server refuses are listed next to the chunk they belong to; the chunk is
// written without them and completed by a later run. The exit code is 3 while
// files are missing.
//
// Output, below --out:
//   cache/                                 raw server responses
//   chunks/<symbol>/<timeframe>/<from>_<to>.csv            and .missing.json while incomplete
//   <symbol>-<timeframe>-bid_full.csv      all chunks of one series joined
//
// Only candles with trades are written (volume > 0); minutes without a trade
// and closed-market periods do not appear.

import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { formatOutput, generateUrls, instrumentMetaData, normaliseDates, processData } from 'dukascopy-node';

import { clientOptions, createClient, day, log } from './client.mjs';

const HEADER = 'timestamp,open,high,low,close,volume';
const START_FIELD = { m1: 'startDayForMinuteCandles', h1: 'startMonthForHourlyCandles', d1: 'startYearForDailyCandles' };
const SATURDAY = 6;

const { values: args } = parseArgs({
  options: {
    symbols: { type: 'string' },
    timeframes: { type: 'string', default: 'd1,h1,m1' },
    to: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    out: { type: 'string', default: path.join(os.homedir(), 'candle_workspace', 'raw', 'dukascopy') },
    'with-saturdays': { type: 'boolean', default: false }, // spot FX never trades on a Saturday (UTC)
    ...clientOptions,
  },
});

if (!args.symbols) {
  console.error('usage: fetch.mjs --symbols gbpusd,eurusd [--timeframes d1,h1,m1] [--to YYYY-MM-DD] [--out DIR] [--rate 4]');
  process.exit(2);
}

const { obtainAll, count } = createClient(args.out, args);
let missingFiles = 0;

function chunks(symbol, timeframe, end) {
  const field = START_FIELD[timeframe];
  if (!field) throw new Error(`timeframe ${timeframe} is not supported; use m1, h1 or d1`);
  const meta = instrumentMetaData[symbol];
  if (!meta) throw new Error(`unknown instrument ${symbol}`);
  const first = new Date(`${meta[field].slice(0, 10)}T00:00:00Z`);
  if (timeframe !== 'm1') return [[first, end]];
  const list = [];
  for (let from = first; from < end; ) {
    const newYear = new Date(Date.UTC(from.getUTCFullYear() + 1, 0, 1));
    const to = newYear < end ? newYear : end;
    list.push([from, to]);
    from = to;
  }
  return list;
}

function urlsFor(symbol, timeframe, from, to) {
  const [startDate, endDate] = normaliseDates({ instrument: symbol, startDate: new Date(from), endDate: new Date(to), timeframe, utcOffset: 0 });
  const urls = generateUrls({ instrument: symbol, timeframe, priceType: 'bid', startDate, endDate });
  if (timeframe !== 'm1' || args['with-saturdays']) return urls;
  return urls.filter((url) => {
    const [year, month, date] = url.split('/').slice(-3).map(Number);
    return new Date(Date.UTC(year, month - 1, date)).getUTCDay() !== SATURDAY;
  });
}

async function fetchChunk(symbol, timeframe, from, to, target) {
  const began = Date.now();
  const before = { ...count };
  const urls = urlsFor(symbol, timeframe, from, to);
  const responses = await obtainAll(urls);
  const bufferObjects = responses.filter(({ buffer }) => buffer !== null);
  const missing = responses.filter(({ buffer }) => buffer === null).map(({ url }) => url);

  const rows = processData({ instrument: symbol, requestedTimeframe: timeframe, bufferObjects, priceType: 'bid', volumes: true, volumeUnits: 'millions', ignoreFlats: true })
    .filter(([timestamp]) => timestamp >= +from && timestamp < +to);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] <= rows[i - 1][0]) throw new Error(`${symbol} ${timeframe}: timestamps out of order at ${rows[i][0]}`);
  }
  const csv = rows.length ? formatOutput({ processedData: rows, format: 'csv', timeframe }) : HEADER;
  if (csv.split('\n', 1)[0] !== HEADER) throw new Error(`unexpected columns: ${csv.slice(0, 80)}`);
  await fs.writeFile(`${target}.part`, `${csv}\n`);
  await fs.rename(`${target}.part`, target);
  if (missing.length) await fs.writeFile(missingList(target), `${JSON.stringify(missing, null, 1)}\n`);
  else await fs.rm(missingList(target), { force: true });
  missingFiles += missing.length;

  const got = `${count.network - before.network} from the network, ${count.server - before.server} from the server`;
  const lacking = missing.length ? `, ${missing.length} REFUSED` : '';
  log(`${symbol} ${timeframe} ${day(from)}..${day(to)}: ${rows.length} rows from ${urls.length} files (${got}${lacking}), ${((Date.now() - began) / 1000).toFixed(0)}s`);
}

const missingList = (chunkFile) => chunkFile.replace(/\.csv$/, '.missing.json');

async function join(files, target) {
  const output = createWriteStream(`${target}.part`);
  output.setMaxListeners(0);   // every chunk piped in adds its listeners
  output.write(`${HEADER}\n`);
  for (const file of files) {
    await pipeline(createReadStream(file, { start: HEADER.length + 1 }), output, { end: false });
  }
  await new Promise((resolve, reject) => output.end((error) => (error ? reject(error) : resolve())));
  await fs.rename(`${target}.part`, target);
}

async function fetchSeries(symbol, timeframe, end) {
  const folder = path.join(args.out, 'chunks', symbol, timeframe);
  await fs.mkdir(folder, { recursive: true });
  const wanted = chunks(symbol, timeframe, end).map(([from, to]) => ({ from, to, file: path.join(folder, `${day(from)}_${day(to)}.csv`) }));
  const keep = new Set(wanted.flatMap((chunk) => [chunk.file, missingList(chunk.file)]).map((file) => path.basename(file)));
  for (const name of await fs.readdir(folder)) {
    if (!keep.has(name)) await fs.rm(path.join(folder, name));
  }
  const exists = (file) => fs.stat(file).then(() => true, () => false);
  for (const chunk of wanted) {
    const complete = (await exists(chunk.file)) && !(await exists(missingList(chunk.file)));
    if (!complete) await fetchChunk(symbol, timeframe, chunk.from, chunk.to, chunk.file);
  }
  const target = path.join(args.out, `${symbol}-${timeframe}-bid_full.csv`);
  await join(wanted.map((chunk) => chunk.file), target);
  log(`${symbol} ${timeframe}: ${wanted.length} chunks joined into ${path.basename(target)}`);
}

const end = new Date(`${args.to}T00:00:00Z`);
if (Number.isNaN(+end)) {
  console.error(`--to must be a date like 2026-09-26, got ${args.to}`);
  process.exit(2);
}
try {
  for (const timeframe of args.timeframes.toLowerCase().split(',')) {
    for (const symbol of args.symbols.toLowerCase().split(',')) {
      await fetchSeries(symbol, timeframe, end);
    }
  }
  log(`finished; ${count.network} files from the network, ${count.server} from the server, ${missingFiles} still missing`);
  if (missingFiles) process.exit(3);
} catch (error) {
  log(`stopped: ${error.message}`);
  process.exit(1);
}
