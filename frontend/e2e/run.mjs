#!/usr/bin/env node
// Acceptance test: signals on the main chart, their studies in windows of six charts, touches and strategies.
//
// Runs the real application (backend and built frontend) on an invented market
// in a temporary workspace and drives it with a headless browser.
//
//   npm run build && npm run e2e
//
// CHROME names the browser to use (default /usr/bin/google-chrome).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(what, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// ---------------------------------------------------------------- setting up

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-e2e-'));
run('uv', ['run', 'python', path.join(here, 'make_data.py'), path.join(workspace, 'raw')]);
run('uv', ['run', 'candle-data', 'rebuild', '--source', path.join(workspace, 'raw'), '--workspace', workspace]);

// A study as the first version of the application wrote it: one chart, described by the study itself.
const OLD_STUDY = '20240301-101500-0abc';
const oldFolder = path.join(workspace, 'studies', OLD_STUDY);
const oldStudy = {
  symbol: 'testfx',
  timeframe: 'd1',
  focus: Date.parse('2024-02-14T00:00:00Z'),
  tag: '旧记录',
  drawings: [
    { id: 'old1', name: 'segment', points: [{ timestamp: Date.parse('2024-02-05T00:00:00Z'), value: 1.26 }, { timestamp: Date.parse('2024-02-20T00:00:00Z'), value: 1.27 }], timeframe: 'd1', styles: { line: { color: '#e11d48', size: 1.5 } }, extendData: { color: '#e11d48' }, lock: false, visible: true, zLevel: 0 },
  ],
  indicators: [{ name: 'MA', pane: 'candle', params: [20], visible: true }],
  view: { barSpace: 9, offsetRight: 0, rightTimestamp: Date.parse('2024-03-01T00:00:00Z') },
  timezone: 'UTC',
  id: OLD_STUDY,
  created: '2024-03-01T10:15:00Z',
  updated: '2024-03-01T10:15:00Z',
  schemaVersion: 1,
};
// A screen of the user's own: the shipped one with a smaller window, under another name.
fs.mkdirSync(path.join(workspace, 'screens'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'screens', 'example.py'), "from candle_viewer.screens.local_extremes import run\nNAME = 'example'\nTITLE = '例子'\nPARAMS = {'timeframe': 'd1', 'window': 6}\n");
fs.mkdirSync(oldFolder, { recursive: true });
fs.writeFileSync(path.join(oldFolder, 'study.json'), `${JSON.stringify(oldStudy, null, 1)}\n`);
fs.writeFileSync(path.join(oldFolder, 'notes.md'), '第一版写下的评论');

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn('uv', ['run', 'candle-viewer', '--workspace', workspace, '--port', String(port)], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1500, height: 860 },
});

let failure = null;
const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

try {
  await waitFor('the server', () => fetch(`${origin}/api/meta`).then((response) => response.ok, () => false), 30000);

  const problems = [];
  const dialogs = [];

  function watch(page) {
    page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
  }

  // -------------------------------------------------------------- helpers

  const test = (name) => `[data-testid="${name}"]`;
  const get = (what) => fetch(`${origin}${what}`).then((response) => response.json());
  const message = (page) => page.$eval(test('message'), (element) => element.textContent);
  const value = (page, name) => page.$eval(test(name), (element) => element.value);
  const text = (page, name) => page.$eval(test(name), (element) => element.textContent);
  const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);
  const step = (name) => steps.push(name);
  const picture = async (page, name) => shots && page.screenshot({ path: path.join(shots, `${String(steps.length).padStart(2, '0')}-${name}.png`) });

  /** What a chart of a window answers: the main chart, or one of the charts of a study by its key. */
  const ask = (page, pane, method, ...args) =>
    page.evaluate(
      (key, name, given) => {
        const viewer = window.candleViewer;
        const handle = key === 'main' ? viewer.chart() : viewer.panes()[key];
        return handle[name](...given);
      },
      pane,
      method,
      args,
    );
  const mainLoaded = (page) => page.waitForFunction(() => window.candleViewer?.window === 'main' && (window.candleViewer.chart()?.bars() ?? 0) > 0, { timeout: 20000 }).then(() => sleep(400));
  const studyLoaded = (page) => page.waitForFunction(() => window.candleViewer?.window === 'study' && window.candleViewer.loaded(), { timeout: 20000 }).then(() => sleep(500));
  const signals = (page) => page.evaluate(() => window.candleViewer.signals());
  const drawings = (page) => page.evaluate(() => window.candleViewer.drawings());
  const paneKeys = (page) => page.evaluate(() => Object.keys(window.candleViewer.panes()).sort());

  async function chartBox(page, pane) {
    const box = await (await page.$(test(`chart-${pane}`))).boundingBox();
    return { at: (x, y) => ({ x: box.x + x, y: box.y + y }), ...box };
  }

  async function hover(page, pane, x, y) {
    const to = (await chartBox(page, pane)).at(x, y);
    await page.mouse.move(to.x - 30, to.y - 30, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await sleep(250);
  }

  // A click the chart accepts: it tells clicks from drags and double clicks by their timing.
  async function click(page, pane, x, y) {
    const to = (await chartBox(page, pane)).at(x, y);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await sleep(120);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.up();
    await sleep(450);
  }

  async function rightClick(page, pane, x, y) {
    const to = (await chartBox(page, pane)).at(x, y);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await sleep(120);
    await page.mouse.down({ button: 'right' });
    await sleep(60);
    await page.mouse.up({ button: 'right' });
    await sleep(300);
  }

  async function drag(page, pane, from, to) {
    const box = await chartBox(page, pane);
    const a = box.at(...from);
    const b = box.at(...to);
    await page.mouse.move(a.x, a.y, { steps: 6 });
    await sleep(150);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await sleep(80);
    await page.mouse.up();
    await sleep(450);
  }

  async function type(page, name, written) {
    await page.click(test(name), { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(test(name), written);
  }

  /** Sets a date and time; the input takes keys in the order of the language of the browser, so it is set as a whole. */
  async function pick(page, name, moment) {
    await page.$eval(
      test(name),
      (element, chosen) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, chosen);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      },
      moment,
    );
  }

  /** Does what opens a window, and gives the window once its charts have their bars. */
  async function opening(page, action) {
    const opened = new Promise((resolve) => page.once('popup', resolve));
    await action();
    const popup = await Promise.race([opened, sleep(8000).then(() => null)]);
    assert.ok(popup, 'a window opens');
    watch(popup);
    // The window gets its size after it has begun to load. The price axis of a chart keeps the greatest width it
    // ever had, so the charts are made anew in a window of the final size: their widths are then the same every time.
    await popup.setViewport({ width: 1720, height: 980 });
    await popup.reload({ waitUntil: 'networkidle0' });
    await studyLoaded(popup);
    return popup;
  }

  async function saved(page) {
    await waitFor('the save to finish', async () => {
      const said = await message(page);
      if (said.includes('失败')) throw new Error(said);
      return said.startsWith('已保存');
    });
    await sleep(200);
  }

  async function finish(popup) {
    await popup.click(test('done'));
    await waitFor('the window to close', () => popup.isClosed(), 20000);
  }

  async function draw(page, pane, tool, ...points) {
    const before = (await drawings(page)).length;
    await page.click(test(`tool-${tool}`));
    await sleep(200);
    for (const [x, y] of points) await click(page, pane, x, y);
    await waitFor(`the ${tool} to be drawn`, async () => (await drawings(page)).length === before + 1);
    return (await drawings(page)).at(-1);
  }

  const markOf = (signal) => `signal:${signal.id}`;
  const anchors = (drawing) => drawing.points.map((point) => [point.timestamp, point.value]);
  const signalsFolder = path.join(workspace, 'signals', 'testfx');
  const isPng = (file) => assert.deepEqual([...fs.readFileSync(file).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const DAY = 86_400_000;
  const HOUR = 3_600_000;

  // ------------------------------------------------------------- the test

  const page = await browser.newPage();
  watch(page);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await mainLoaded(page);

  step('the main window opens on the first symbol, on daily bars, without signals');
  assert.equal(await value(page, 'symbol'), 'testfx');
  assert.equal(await page.$eval(test('timeframe-d1'), (element) => element.className), 'on');
  assert.deepEqual(await signals(page), []);
  assert.equal((await page.$$(`${test('studies')} .row`)).length, 1, 'the study of the first version is listed');

  step('a point on a high is marked as a signal; the click lands on the high');
  const peakBar = await ask(page, 'main', 'barAt', 700);
  await page.click(test('mark-point'));
  assert.ok((await text(page, 'hint')).includes('标记信号'));
  await click(page, 'main', peakBar.x, peakBar.highY - 6);
  const [peak] = await waitFor('the signal', async () => ((await signals(page)).length === 1 ? signals(page) : null));
  assert.equal(peak.versions.length, 1);
  assert.deepEqual(peak.versions[0].anchors, [{ timestamp: peakBar.timestamp, value: peakBar.high }]);
  assert.equal(peak.versions[0].shape, 'point');
  assert.equal(peak.versions[0].timeframe, 'd1');
  assert.equal(peak.note.studied, false);
  assert.ok(!(await text(page, 'hint')).includes('标记信号'), 'the tool is laid down after one signal');
  await picture(page, 'point-marked');

  step('a box is marked as a signal');
  await page.click(test('mark-box'));
  await click(page, 'main', 380, 200);
  await click(page, 'main', 560, 330);
  const range = (await waitFor('the box', async () => ((await signals(page)).length === 2 ? signals(page) : null))).find((signal) => signal.versions[0].shape === 'box');
  assert.equal(range.versions[0].anchors.length, 2);

  step('signals are folders of plain files in the workspace');
  assert.deepEqual(fs.readdirSync(signalsFolder).sort(), [peak.id, range.id].sort());
  assert.deepEqual(fs.readdirSync(path.join(signalsFolder, peak.id)), ['signal.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(signalsFolder, peak.id, 'signal.json'), 'utf8')).versions[0].anchors[0].value, peakBar.high);

  step('a click on the signal opens a window of six charts around it');
  const peakAt = (await ask(page, 'main', 'figuresOf', markOf(peak))).shape;
  near(peakAt.x, peakBar.x, 1, 'the signal is drawn on its bar');
  near(peakAt.y, peakBar.highY, 1, 'the signal is drawn at its price');
  let study = await opening(page, () => click(page, 'main', peakAt.x, peakAt.y));
  assert.equal(await study.$eval(test('study-window'), (element) => element.dataset.kind), 'signal');
  assert.deepEqual(await paneKeys(study), ['pane-0', 'pane-1', 'pane-2', 'pane-3', 'pane-4', 'pane-5']);
  const timeframes = ['h1', 'h4', 'd1', 'w1', '1mo', '3mo'];
  for (const [index, timeframe] of timeframes.entries()) assert.equal(await value(study, `timeframe-pane-${index}`), timeframe);
  await picture(study, 'six-charts');

  const hours = (await get(`/api/bars?symbol=testfx&timeframe=h1&around=${peakBar.timestamp}&count=200`)).bars;
  const made = hours.filter((bar) => bar[0] >= peakBar.timestamp - 3 * HOUR && bar[0] < peakBar.timestamp + DAY && bar[2] === peakBar.high);
  assert.equal(made.length, 1, 'one hour made the high of the day');
  for (const [index, timeframe] of timeframes.entries()) {
    const pane = `pane-${index}`;
    const box = await chartBox(study, pane);
    const [at] = await ask(study, pane, 'pixelsOf', markOf(peak));
    assert.ok(at.x > 0 && at.x < box.width && at.y > 0 && at.y < box.height, `the signal is in view on ${timeframe}: ${JSON.stringify(at)}`);
    const bar = await ask(study, pane, 'barAt', at.x);
    assert.equal(bar.high, index <= 2 ? peakBar.high : bar.high);
    if (timeframe === 'h1') assert.equal(bar.timestamp, made[0][0], 'on hourly bars the signal is on the hour that made the high');
    // Weeks and longer bars are few after the signal: the view is not moved past the end of the data.
    if (index <= 2) near(at.x, box.width / 2, box.width * 0.1, `the signal is in the middle on ${timeframe}`);
  }

  step('a line drawn on one chart shows on all of them');
  const line = await draw(study, 'pane-2', 'segment', [120, 120], [300, 200]);
  assert.equal(line.timeframe, 'd1');
  assert.equal(line.symbol, 'testfx');
  for (const pane of await paneKeys(study)) {
    const shown = await ask(study, pane, 'pixelsOf', line.id);
    assert.ok(shown.length === 2 && shown.every((pixel) => Number.isFinite(pixel.x) && Number.isFinite(pixel.y)), `the line shows on ${pane}`);
  }
  assert.equal(await study.$eval(test('tool-segment'), (element) => element.className), '', 'the tool is laid down after one drawing');

  step('a level segment takes its price from the first click');
  const low = await ask(study, 'pane-0', 'barAt', 150);
  const level = await draw(study, 'pane-0', 'levelSegment', [low.x, low.lowY + 5], [340, 90]);
  assert.equal(level.timeframe, 'h1');
  assert.deepEqual(level.points.map((point) => point.value), [low.low, low.low]);
  assert.equal(level.points[0].timestamp, low.timestamp);
  assert.equal(level.points[1].timestamp, (await ask(study, 'pane-0', 'barAt', 340)).timestamp);

  step('a drawing that is moved on one chart moves on the others');
  const [from, to] = await ask(study, 'pane-2', 'pixelsOf', line.id);
  const before = await ask(study, 'pane-1', 'pixelsOf', line.id);
  await click(study, 'pane-2', (from.x + to.x) / 2, (from.y + to.y) / 2);
  await drag(study, 'pane-2', [to.x, to.y], [to.x + 40, to.y - 50]);
  const moved = (await drawings(study)).find((drawing) => drawing.id === line.id);
  assert.deepEqual(anchors(moved)[0], anchors(line)[0]);
  assert.notDeepEqual(anchors(moved)[1], anchors(line)[1]);
  const after = await ask(study, 'pane-1', 'pixelsOf', line.id);
  near(after[0].y, before[0].y, 1, 'the end that stayed');
  assert.ok(after[1].y < before[1].y - 20, 'the end that moved is higher on the other chart too');
  await click(study, 'pane-2', 360, 390);

  step('tag, comment, models and basis are written, and the study is finished');
  await type(study, 'tag', '日线高点');
  await type(study, 'comment', '用模型甲能解释一半。\n其余感觉如此。');
  await type(study, 'models', '模型甲，模型乙');
  await study.click(test('basis-partial'));
  await pick(study, 'known-at', '2024-02-20T08:00');
  await study.click(test('indicators-pane-0'));
  await study.click(test('indicators-pane-0-MA'));
  await study.click(test('indicators-pane-0'));
  const left = {};
  for (const pane of await paneKeys(study)) left[pane] = { view: (await ask(study, pane, 'snapshot')).view, line: await ask(study, pane, 'pixelsOf', line.id), level: await ask(study, pane, 'pixelsOf', level.id) };
  const drawn = await drawings(study);
  await picture(study, 'before-finishing');
  await finish(study);

  const peakFolder = path.join(signalsFolder, peak.id);
  assert.deepEqual(fs.readdirSync(peakFolder).sort(), ['notes.md', 'screenshot.png', 'signal.json', 'study.json']);
  assert.equal(fs.readFileSync(path.join(peakFolder, 'notes.md'), 'utf8'), '用模型甲能解释一半。\n其余感觉如此。');
  const stored = JSON.parse(fs.readFileSync(path.join(peakFolder, 'study.json'), 'utf8'));
  assert.equal(stored.tag, '日线高点');
  assert.deepEqual(stored.subject, { kind: 'signal', id: peak.id });
  assert.deepEqual(stored.layout, { columns: 3, rows: 2 });
  assert.deepEqual(stored.panes.map((pane) => pane.timeframe), timeframes);
  assert.ok(stored.panes.every((pane) => pane.symbol === 'testfx' && Number.isInteger(pane.view.rightTimestamp)));
  assert.deepEqual(stored.panes[0].indicators.map((indicator) => indicator.name), ['MA']);
  assert.deepEqual(stored.drawings.map(anchors), drawn.map(anchors));
  assert.equal(stored.focus, peakBar.timestamp);
  isPng(path.join(peakFolder, 'screenshot.png'));
  assert.ok(fs.statSync(path.join(peakFolder, 'screenshot.png')).size > 60_000, 'the screenshot shows six charts');
  if (shots) fs.copyFileSync(path.join(peakFolder, 'screenshot.png'), path.join(shots, 'saved-screenshot.png'));
  const facts = JSON.parse(fs.readFileSync(path.join(peakFolder, 'signal.json'), 'utf8'));
  assert.deepEqual(facts.models, ['模型甲', '模型乙']);
  assert.equal(facts.basis, 'partial');
  assert.equal(facts.versions.length, 1);
  assert.equal(facts.versions[0].knownAt, Date.parse('2024-02-20T08:00:00Z'));

  step('the main window shows the tag, and the comment while the mouse is on the signal');
  await waitFor('the tag to arrive', async () => (await signals(page)).find((signal) => signal.id === peak.id)?.note.tag === '日线高点');
  assert.ok((await text(page, `signal-${peak.id}`)).includes('日线高点'));
  await hover(page, 'main', peakAt.x, peakAt.y);
  await page.waitForSelector(test('hover'), { timeout: 5000 });
  const shownOnHover = await text(page, 'hover');
  assert.ok(shownOnHover.includes('日线高点') && shownOnHover.includes('用模型甲能解释一半。') && shownOnHover.includes('模型甲、模型乙') && shownOnHover.includes('部分能说清'), shownOnHover);
  await picture(page, 'hover');
  await hover(page, 'main', 1000, 500);
  await waitFor('the comment to go', async () => (await page.$(test('hover'))) === null);

  step('a touch is added from the menu of the signal; it shows as a dot below the signal');
  await rightClick(page, 'main', peakAt.x, peakAt.y);
  await page.waitForSelector(test('menu'));
  await page.click(test('menu-touch'));
  assert.ok((await text(page, 'hint')).includes('添加触及'));
  const touchBar = await ask(page, 'main', 'barAt', 960);
  await click(page, 'main', touchBar.x, touchBar.highY - 4);
  const touch = (await waitFor('the touch', async () => (await signals(page)).find((signal) => signal.id === peak.id)?.touches[0]));
  assert.equal(touch.timestamp, touchBar.timestamp);
  assert.equal(touch.value, touchBar.high);
  assert.equal(touch.signalVersion, 1);
  assert.equal(touch.timeframe, 'd1');
  await sleep(400);
  const dot = (await ask(page, 'main', 'figuresOf', markOf(peak)))[`touch:${touch.id}`];
  near(dot.x, peakBar.x, 1.5, 'the dot is below the bar of the signal');
  assert.ok(dot.y > peakBar.lowY, 'the dot is below the low of that bar');
  assert.ok(fs.existsSync(path.join(peakFolder, 'touches', touch.id, 'touch.json')));
  await picture(page, 'touch-added');

  step('the dots of a box hang below the bar where the box begins');
  const boxTouch = await fetch(`${origin}/api/signals/${range.id}/touches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timestamp: touchBar.timestamp, value: touchBar.low, timeframe: 'd1' }) }).then((response) => response.json());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor('the touch of the box', async () => (await signals(page)).find((signal) => signal.id === range.id)?.touches.length === 1);
  await sleep(400);
  const edges = await ask(page, 'main', 'pixelsOf', markOf(range));
  const boxDot = (await ask(page, 'main', 'figuresOf', markOf(range)))[`touch:${boxTouch.id}`];
  near(boxDot.x, Math.min(edges[0].x, edges[1].x), 1.5, 'the dot is below the left edge of the box');
  assert.ok(boxDot.y > Math.max(edges[0].y, edges[1].y), 'the dot is below the box');

  step('a click on the dot opens the touch in a window centred on it');
  study = await opening(page, () => click(page, 'main', dot.x, dot.y));
  assert.equal(await study.$eval(test('study-window'), (element) => element.dataset.kind), 'touch');
  for (const [index, timeframe] of timeframes.entries()) {
    const pane = `pane-${index}`;
    const box = await chartBox(study, pane);
    const [at] = await ask(study, pane, 'pixelsOf', `touch:${touch.id}`);
    assert.ok(at.x > 0 && at.x < box.width, `the touch is in view on ${timeframe}`);
    if (index <= 1) near(at.x, box.width / 2, box.width * 0.2, `the touch is near the middle on ${timeframe}`);
    // The price of the signal has its place on the chart, in view or not: the touch of the test is not at that price.
    const [signalAt] = await ask(study, pane, 'pixelsOf', markOf(peak));
    assert.ok(Number.isFinite(signalAt.x) && Number.isFinite(signalAt.y), `the signal has a place on ${timeframe}`);
  }
  await picture(study, 'touch-window');

  step('the window of a touch shows the drawings of the study of its signal, and starts with its indicators');
  assert.deepEqual(await drawings(study), [], 'the drawings of the signal are not drawings of the touch');
  for (const pane of await paneKeys(study)) {
    for (const id of [line.id, level.id]) {
      const shown = await ask(study, pane, 'pixelsOf', `reference:${id}`);
      assert.ok(shown.length === 2 && shown.every((pixel) => Number.isFinite(pixel.x) && Number.isFinite(pixel.y)), `the drawing ${id} of the signal shows on ${pane}`);
    }
  }
  assert.equal(await text(study, 'indicators-pane-0'), '指标（1）');
  assert.ok((await text(study, 'signal-comment')).includes('用模型甲能解释一半。'));

  step('strategies are written side by side and saved with the touch');
  await study.click(test('strategy-add'));
  await type(study, 'strategy-label-0', '当时的做法');
  await type(study, 'strategy-text-0', '回到这个价位后入场，止损放在高点上方。');
  await study.click(test('strategy-add'));
  await type(study, 'strategy-label-1', '现在的想法');
  await type(study, 'strategy-text-1', '等 4 小时收盘确认。');
  await type(study, 'tag', '第一次触及');
  await type(study, 'comment', '影线刺穿后收回。');
  await finish(study);
  const touchFolder = path.join(peakFolder, 'touches', touch.id);
  assert.deepEqual(fs.readdirSync(touchFolder).sort(), ['notes.md', 'screenshot.png', 'strategies.json', 'study.json', 'touch.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(touchFolder, 'strategies.json'), 'utf8')).map((item) => [item.label, item.text]), [['当时的做法', '回到这个价位后入场，止损放在高点上方。'], ['现在的想法', '等 4 小时收盘确认。']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(touchFolder, 'study.json'), 'utf8')).subject, { kind: 'touch', id: touch.id });
  assert.equal(JSON.parse(fs.readFileSync(path.join(touchFolder, 'study.json'), 'utf8')).focus, touch.timestamp);
  await waitFor('the touch to be known as studied', async () => (await signals(page)).find((signal) => signal.id === peak.id)?.touches[0]?.note.tag === '第一次触及');
  assert.equal((await signals(page)).find((signal) => signal.id === peak.id).touches[0].strategies, 2);
  await hover(page, 'main', dot.x, dot.y);
  await page.waitForSelector(test('hover'), { timeout: 5000 });
  assert.ok((await text(page, 'hover')).includes('影线刺穿后收回。'));
  await hover(page, 'main', 1000, 500);

  step('the study of the signal opens again as it was left');
  study = await opening(page, () => page.click(test('open-signal')));
  assert.deepEqual(await drawings(study), drawn);
  assert.equal(await value(study, 'tag'), '日线高点');
  assert.equal(await value(study, 'comment'), '用模型甲能解释一半。\n其余感觉如此。');
  assert.equal(await value(study, 'models'), '模型甲，模型乙');
  assert.equal(await value(study, 'known-at'), '2024-02-20T08:00');
  assert.ok(await study.$eval(test('basis-partial'), (element) => element.checked));
  for (const pane of await paneKeys(study)) {
    const now = (await ask(study, pane, 'snapshot')).view;
    near(now.barSpace, left[pane].view.barSpace, 0.01, `bar space of ${pane}`);
    assert.equal(now.rightTimestamp, left[pane].view.rightTimestamp, `right edge of ${pane}`);
    for (const [name, id] of [['line', line.id], ['level', level.id]]) {
      const pixels = await ask(study, pane, 'pixelsOf', id);
      pixels.forEach((pixel, index) => {
        near(pixel.x, left[pane][name][index].x, 1.5, `${name} anchor ${index} x on ${pane}`);
        near(pixel.y, left[pane][name][index].y, 1.5, `${name} anchor ${index} y on ${pane}`);
      });
    }
  }
  assert.equal(await text(study, 'save'), '保存', 'opening a study changes nothing');
  await study.close();

  step('a chart of a study can show another timeframe and be enlarged');
  await page.click(`${test(`signal-${range.id}`)} .open`);
  study = await opening(page, () => page.click(test('open-signal')));
  await study.select(test('timeframe-pane-0'), 'm15');
  await waitFor('the quarter hours', async () => (await ask(study, 'pane-0', 'bars')) > 0);
  await sleep(600);
  const [corner] = await ask(study, 'pane-0', 'pixelsOf', markOf(range));
  assert.ok(Number.isFinite(corner.x) && Number.isFinite(corner.y));
  const small = await chartBox(study, 'pane-2');
  await study.click(test('maximize-pane-2'));
  await sleep(500);
  const large = await chartBox(study, 'pane-2');
  assert.ok(large.width > small.width * 2.5 && large.height > small.height * 1.7, 'the chart takes the place of all charts');
  await picture(study, 'enlarged');

  step('the box is extended on a chart; saving keeps the earlier shape as a version');
  const corners = await ask(study, 'pane-2', 'pixelsOf', markOf(range));
  const right = corners[0].x > corners[1].x ? corners[0] : corners[1];
  await hover(study, 'pane-2', right.x, right.y);
  await drag(study, 'pane-2', [right.x, right.y], [right.x + 160, right.y]);
  await study.waitForSelector(test('moved'));
  await study.click(test('save'));
  await study.waitForSelector(test('reason-dialog'));
  await study.click(test('reason-market'));
  await study.type(test('reason-note'), '箱体延长');
  await study.click(test('reason-ok'));
  await saved(study);
  const extended = await get(`/api/signals/${range.id}`);
  assert.equal(extended.versions.length, 2);
  assert.deepEqual(extended.versions[0], range.versions[0], 'the first version is as it was');
  assert.equal(extended.versions[1].reason, 'market');
  assert.equal(extended.versions[1].note, '箱体延长');
  const span = (version) => Math.max(...version.anchors.map((anchor) => anchor.timestamp)) - Math.min(...version.anchors.map((anchor) => anchor.timestamp));
  assert.ok(span(extended.versions[1]) > span(extended.versions[0]) + 5 * DAY, 'the box spans more time');
  assert.ok((await text(study, 'versions')).includes('箱体延长'));
  assert.equal(await study.$(test('moved')), null);
  await picture(study, 'extended');
  await study.click(test('maximize-pane-2'));
  await study.close();
  await waitFor('the main window to follow', async () => (await signals(page)).find((signal) => signal.id === range.id)?.versions.length === 2);

  step('a study of the first version opens as one chart, and its file is left alone');
  const oldFile = fs.readFileSync(path.join(oldFolder, 'study.json'));
  study = await opening(page, () => page.click(`${test(`study-${OLD_STUDY}`)} .open`));
  assert.equal(await study.$eval(test('study-window'), (element) => element.dataset.kind), 'free');
  assert.deepEqual(await paneKeys(study), ['pane-0']);
  assert.equal(await value(study, 'timeframe-pane-0'), 'd1');
  assert.equal(await value(study, 'tag'), '旧记录');
  assert.equal(await value(study, 'comment'), '第一版写下的评论');
  assert.deepEqual((await drawings(study)).map(anchors), oldStudy.drawings.map(anchors));
  assert.equal((await ask(study, 'pane-0', 'snapshot')).view.rightTimestamp, oldStudy.view.rightTimestamp);
  assert.ok(fs.readFileSync(path.join(oldFolder, 'study.json')).equals(oldFile), 'opening does not write');
  await picture(study, 'old-study');

  step('it can be given more charts and saved; what was there before is kept');
  await study.select(test('layout'), '3x2');
  await waitFor('six charts', async () => (await paneKeys(study)).length === 6);
  await studyLoaded(study);
  for (const pane of await paneKeys(study)) assert.equal((await ask(study, pane, 'pixelsOf', 'old1')).length, 2, `the old line shows on ${pane}`);
  await study.click(test('save'));
  await saved(study);
  const upgraded = JSON.parse(fs.readFileSync(path.join(oldFolder, 'study.json'), 'utf8'));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.panes.length, 6);
  assert.equal(upgraded.created, oldStudy.created);
  const [kept] = fs.readdirSync(path.join(oldFolder, 'history'));
  assert.ok(fs.readFileSync(path.join(oldFolder, 'history', kept, 'study.json')).equals(oldFile));
  await study.close();

  step('signals stay on their bars when the main chart shows other timeframes');
  for (const timeframe of ['h4', 'h1', 'w1', 'd1']) {
    await page.click(test(`timeframe-${timeframe}`));
    await waitFor(`the ${timeframe} bars`, async () => (await page.$eval(test(`timeframe-${timeframe}`), (element) => element.className)) === 'on');
    await sleep(300);
    await mainLoaded(page);
    await page.click(`${test(`signal-${peak.id}`)} .open`);
    await sleep(900);
    await mainLoaded(page);
    const [at] = await ask(page, 'main', 'pixelsOf', markOf(peak));
    const box = await chartBox(page, 'main');
    assert.ok(at.x > 0 && at.x < box.width, `the signal is in view on ${timeframe}`);
    const bar = await ask(page, 'main', 'barAt', at.x);
    if (timeframe === 'h1') assert.equal(bar.timestamp, made[0][0]);
    if (timeframe !== 'w1') assert.equal(bar.high, peakBar.high, `the signal is on the bar of its high on ${timeframe}`);
    assert.ok(bar.timestamp <= peakBar.timestamp + DAY && bar.timestamp >= peakBar.timestamp - 7 * DAY, `bar of the signal on ${timeframe}`);
  }
  await picture(page, 'main-with-signals');

  step('the filter narrows the signals in the list and on the chart');
  await type(page, 'filter', '模型乙');
  await waitFor('one signal', async () => (await page.$$(`${test('signals')} .row`)).length === 1);
  assert.deepEqual(await ask(page, 'main', 'pixelsOf', markOf(range)), []);
  assert.equal((await ask(page, 'main', 'pixelsOf', markOf(peak))).length, 1);
  await type(page, 'filter', '');
  await page.keyboard.press('Backspace');
  await waitFor('both signals', async () => (await page.$$(`${test('signals')} .row`)).length === 2);

  step('the window remembers symbol and timeframe');
  await page.click(test('timeframe-h4'));
  await sleep(300);
  await page.reload({ waitUntil: 'networkidle0' });
  await mainLoaded(page);
  assert.equal(await page.$eval(test('timeframe-h4'), (element) => element.className), 'on');
  await waitFor('the signals', async () => (await signals(page)).length === 2);

  step('a screen is run; what it finds are candidate signals to confirm or reject');
  await page.click(test('screens'));
  await page.waitForSelector(test('screen-example'));
  assert.ok((await text(page, 'screen-example')).includes('例子'));
  await page.click(test('run-example'));
  await waitFor('the screen to finish', async () => (await message(page)).includes('新增'));
  const candidates = (await signals(page)).filter((signal) => signal.status === 'candidate');
  assert.ok(candidates.length >= 2, `candidates: ${candidates.length}`);
  assert.ok(candidates.every((signal) => signal.origin === 'example' && signal.key && signal.versions[0].note.includes('收盘价')));
  assert.ok((await text(page, `signal-${candidates[0].id}`)).includes('候选'));
  await page.click(`${test(`signal-${candidates[0].id}`)} .open`);
  await page.waitForSelector(test('confirm-signal'));
  assert.ok((await text(page, 'signal-note')).includes('收盘价'));
  await page.click(test('confirm-signal'));
  await waitFor('the signal to be confirmed', async () => (await signals(page)).find((signal) => signal.id === candidates[0].id)?.status === 'confirmed');
  await page.click(`${test(`signal-${candidates[1].id}`)} .open`);
  await page.waitForSelector(test('reject-signal'));
  await page.click(test('reject-signal'));
  await waitFor('the signal to be rejected', async () => (await signals(page)).find((signal) => signal.id === candidates[1].id)?.status === 'rejected');
  assert.equal(await page.$(test(`signal-${candidates[1].id}`)), null, 'rejected signals are out of the list');
  await page.click(test('hide-rejected'));
  await page.waitForSelector(test(`signal-${candidates[1].id}`));
  assert.ok((await text(page, `signal-${candidates[1].id}`)).includes('已否定'));
  await page.click(test('hide-rejected'));

  step('running the screen again adds nothing; the check finds no looking ahead');
  await page.click(test('screens'));
  await page.click(test('run-example'));
  await waitFor('the second run', async () => (await message(page)).includes('新增 0 个'));
  await page.click(test('screens'));
  await page.click(test('check-example'));
  await waitFor('the check', async () => (await message(page)).includes('通过'), 60000);
  assert.ok(!(await message(page)).includes('没有通过'));
  for (const candidate of candidates) await fetch(`${origin}/api/signals/${candidate.id}`, { method: 'DELETE' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor('the candidates to go', async () => (await signals(page)).length === 2);

  step('a deleted touch and a deleted signal go to trash folders');
  dialogs.length = 0;
  await page.click(`${test(`signal-${peak.id}`)} .open`);
  await page.click(test(`remove-touch-${touch.id}`));
  await waitFor('the touch to go', async () => (await signals(page)).find((signal) => signal.id === peak.id)?.touches.length === 0);
  assert.ok(fs.readdirSync(path.join(peakFolder, 'touches', '.trash'))[0].startsWith(touch.id));
  await page.click(test('remove-signal'));
  await waitFor('the signal to go', async () => (await signals(page)).length === 1);
  assert.equal(dialogs.length, 2);
  assert.deepEqual(fs.readdirSync(signalsFolder), [range.id]);
  assert.ok(fs.readdirSync(path.join(workspace, 'signals', '.trash')).some((name) => name.startsWith(peak.id)));

  assert.deepEqual(problems, [], 'the browser reported errors');
} catch (error) {
  failure = error;
  if (shots) {
    for (const [index, open] of (await browser.pages()).entries()) {
      await open.screenshot({ path: path.join(shots, `failure-${index}.png`) }).catch(() => undefined);
    }
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
  if (failure === null) fs.rmSync(workspace, { recursive: true, force: true });
}

for (const [index, name] of steps.entries()) {
  const failedHere = failure !== null && index === steps.length - 1;
  console.log(`${failedHere ? 'FAIL' : 'ok  '} ${name}`);
}
if (failure !== null) {
  console.error(`\n${failure.stack ?? failure}`);
  console.error(`\nworkspace kept for inspection: ${workspace}`);
  if (serverLog.includes('Traceback') || serverLog.includes('ERROR')) console.error(`\nserver log:\n${serverLog}`);
  process.exit(1);
}
console.log(`\n${steps.length} steps passed`);
