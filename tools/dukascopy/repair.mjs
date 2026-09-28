#!/usr/bin/env node
// Fills holes of the 1-minute candles from tick data.
//
// Where the server's minute files lack a period although the market was open,
// its tick files often still have it. Candles built from ticks are identical
// to the server's own. The holes are read from the gaps.csv files that
// `candle-data rebuild` writes; the result goes to
//   <out>/patches/<symbol>-m1-bid_full.csv
// which the next rebuild picks up. Minutes recovered by an earlier run stay in
// that file.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { formatOutput, instrumentMetaData, processData, URL_ROOT } from 'dukascopy-node';

import { clientOptions, createClient, log } from './client.mjs';

const HEADER = 'timestamp,open,high,low,close,volume';
const HOUR = 3_600_000;
const workspace = path.join(os.homedir(), 'candle_workspace');

const { values: args } = parseArgs({
  options: {
    symbols: { type: 'string' },
    dataset: { type: 'string', default: path.join(workspace, 'market', 'utc') },
    out: { type: 'string', default: path.join(workspace, 'raw', 'dukascopy') },
    'min-minutes': { type: 'string', default: '60' },   // holes that lost fewer minutes are left alone
    ...clientOptions,
  },
});

if (!args.symbols) {
  console.error('usage: repair.mjs --symbols eurusd,audusd [--dataset DIR] [--out DIR]');
  process.exit(2);
}

const { obtainAll, count } = createClient(args.out, args);
let refusedHours = 0;

async function holes(symbol) {
  const text = await fs.readFile(path.join(args.dataset, symbol, 'gaps.csv'), 'utf8');
  const [header, ...lines] = text.trim().split('\n');
  const column = Object.fromEntries(header.split(',').map((name, index) => [name, index]));
  return lines
    .map((line) => line.split(','))
    .filter((cells) => cells[column.kind] === 'hole' && Number(cells[column.lost_minutes]) >= Number(args['min-minutes']))
    .map((cells) => ({ start: Number(cells[column.start]), end: Number(cells[column.end]) }));
}

// The weekend never trades: Friday from 22:00, Saturday, Sunday before 21:00 (UTC).
function canTrade(hour) {
  const date = new Date(hour);
  const weekday = date.getUTCDay();
  if (weekday === 6) return false;
  if (weekday === 5) return date.getUTCHours() < 22;
  if (weekday === 0) return date.getUTCHours() >= 21;
  return true;
}

function tickUrl(code, hour) {
  const date = new Date(hour);
  return `${URL_ROOT}/ticks/${code}/${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCHours()}`;
}

async function repair(symbol) {
  const meta = instrumentMetaData[symbol];
  if (!meta) throw new Error(`unknown instrument ${symbol}`);
  const wanted = await holes(symbol);
  const hours = new Set();
  for (const { start, end } of wanted) {
    for (let hour = start - (start % HOUR); hour < end; hour += HOUR) {
      if (canTrade(hour)) hours.add(hour);
    }
  }
  const urls = [...hours].sort((a, b) => a - b).map((hour) => tickUrl(meta.code, hour));
  log(`${symbol}: ${wanted.length} holes, ${urls.length} hours of ticks to look at`);

  const responses = await obtainAll(urls);
  const refused = responses.filter(({ buffer }) => buffer === null).length;
  refusedHours += refused;
  const bufferObjects = responses.filter(({ buffer }) => buffer !== null && JSON.parse(buffer.toString('utf8')).times.length > 0);
  const inHole = (timestamp) => wanted.some(({ start, end }) => timestamp >= start && timestamp < end);
  const rows = processData({ instrument: symbol, requestedTimeframe: 'm1', bufferObjects, priceType: 'bid', volumes: true, volumeUnits: 'millions', ignoreFlats: true })
    .filter(([timestamp, , , , , volume]) => inHole(timestamp) && volume > 0)
    .sort((a, b) => a[0] - b[0]);

  const folder = path.join(args.out, 'patches');
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, `${symbol}-m1-bid_full.csv`);
  const csv = rows.length ? formatOutput({ processedData: rows, format: 'csv', timeframe: 'm1' }) : HEADER;
  if (csv.split('\n', 1)[0] !== HEADER) throw new Error(`unexpected columns: ${csv.slice(0, 80)}`);

  const lines = new Map();
  const earlier = await fs.readFile(target, 'utf8').catch(() => HEADER);
  for (const text of [earlier, csv]) {
    for (const line of text.trim().split('\n').slice(1)) lines.set(Number(line.slice(0, line.indexOf(','))), line);
  }
  const merged = [...lines.keys()].sort((a, b) => a - b).map((timestamp) => lines.get(timestamp));
  await fs.writeFile(`${target}.part`, `${[HEADER, ...merged].join('\n')}\n`);
  await fs.rename(`${target}.part`, target);
  log(`${symbol}: ${rows.length} minutes recovered from ${bufferObjects.length} hours with ticks${refused ? `, ${refused} hours REFUSED` : ''}; the patch now holds ${merged.length} minutes`);
}

try {
  for (const symbol of args.symbols.toLowerCase().split(',')) await repair(symbol);
  log(`finished; ${count.network} files from the network, ${count.server} from the server, ${refusedHours} refused`);
  if (refusedHours) process.exit(3);
} catch (error) {
  log(`stopped: ${error.message}`);
  process.exit(1);
}
