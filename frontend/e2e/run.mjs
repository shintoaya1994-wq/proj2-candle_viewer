#!/usr/bin/env node
// Acceptance test of the first stage: draw, comment, save, close, reopen.
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
try {
  await waitFor('the server', () => fetch(`${origin}/api/meta`).then((response) => response.ok, () => false), 30000);

  const problems = [];
  const dialogs = [];
  async function openApp() {
    const page = await browser.newPage();
    page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
    page.on('pageerror', (error) => problems.push(error.message));
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await loaded(page);
    return page;
  }

  // -------------------------------------------------------------- helpers

  const test = (name) => `[data-testid="${name}"]`;
  const loaded = (page) => page.waitForFunction(() => (window.candleViewer?.bars() ?? 0) > 0, { timeout: 20000 }).then(() => sleep(400));
  const snapshot = (page) => page.evaluate(() => window.candleViewer.chart().snapshot());
  const pixels = (page, id) => page.evaluate((drawing) => window.candleViewer.chart().pixelsOf(drawing), id);
  const message = (page) => page.$eval(test('message'), (element) => element.textContent);
  const value = (page, name) => page.$eval(test(name), (element) => element.value);

  async function chartBox(page) {
    const box = await (await page.$(test('chart'))).boundingBox();
    return { at: (x, y) => ({ x: box.x + x, y: box.y + y }), ...box };
  }

  // A click the chart accepts: it tells clicks from drags and double clicks by their timing.
  async function click(page, x, y) {
    const box = await chartBox(page);
    const to = box.at(x, y);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await sleep(120);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.up();
    await sleep(450);
  }

  // Two clicks in quick succession on one spot; the chart counts them itself.
  async function doubleClick(page, x, y) {
    const box = await chartBox(page);
    const to = box.at(x, y);
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await sleep(120);
    for (let i = 0; i < 2; i++) {
      await page.mouse.down();
      await sleep(40);
      await page.mouse.up();
      await sleep(110);
    }
    await sleep(350);
  }

  async function drag(page, from, to) {
    const box = await chartBox(page);
    const a = box.at(...from);
    const b = box.at(...to);
    await page.mouse.move(a.x, a.y, { steps: 6 });
    await sleep(120);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await sleep(80);
    await page.mouse.up();
    await sleep(450);
  }

  async function draw(page, tool, ...points) {
    const before = (await snapshot(page)).drawings.length;
    await page.click(test(`tool-${tool}`));
    await sleep(150);
    for (const [x, y] of points) await click(page, x, y);
    if (tool === 'note') return null;
    await waitFor(`the ${tool} to be drawn`, async () => (await snapshot(page)).drawings.length === before + 1);
    return (await snapshot(page)).drawings.at(-1);
  }

  async function type(page, name, text) {
    await page.click(test(name), { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(test(name), text);
  }

  async function save(page) {
    await page.click(test('save'));
    await waitFor('the save to finish', async () => (await message(page)).startsWith('已保存') || ((await message(page)).includes('失败') && Promise.reject(new Error(await message(page)))));
    await sleep(200);
  }

  const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);
  const anchors = (drawing) => drawing.points.map((point) => [point.timestamp, point.value]);
  const studiesFolder = path.join(workspace, 'studies');
  const step = (name) => steps.push(name);

  // ------------------------------------------------------------- the test

  let page = await openApp();

  step('the application opens on the first symbol at one hour');
  assert.equal(await value(page, 'symbol'), 'testfx');
  assert.equal(await page.$eval(test('timeframe-h1'), (element) => element.className), 'on');
  assert.deepEqual((await snapshot(page)).drawings, []);

  step('the view is moved away from where it starts');
  await drag(page, [500, 300], [900, 300]);
  const box = await chartBox(page);
  await page.mouse.move(box.x + 600, box.y + 300);
  await page.mouse.wheel({ deltaY: -240 });
  await sleep(500);

  step('a segment, a box, a horizontal line and a note are drawn');
  const segment = await draw(page, 'segment', [300, 380], [620, 250]);
  assert.equal(segment.name, 'segment');
  assert.equal(segment.points.length, 2);
  assert.ok(segment.points.every((point) => Number.isInteger(point.timestamp) && Number.isFinite(point.value)));
  assert.equal(segment.timeframe, 'h1');

  await page.click(test('color-e11d48'));
  const drawnBox = await draw(page, 'box', [680, 200], [900, 420]);
  assert.equal(drawnBox.name, 'box');
  assert.equal(drawnBox.extendData.color, '#e11d48');
  assert.equal((await snapshot(page)).drawings[0].extendData.color, '#2563eb', 'choosing a color for the next drawing leaves the last one alone');

  const level = await draw(page, 'horizontalStraightLine', [400, 500]);
  assert.equal(level.name, 'horizontalStraightLine');

  await draw(page, 'note', [450, 150]);
  await page.waitForSelector(test('text-dialog'));
  await page.type(test('text-input'), '突破前高');
  await page.click(test('text-ok'));
  await waitFor('the note to get its text', async () => (await snapshot(page)).drawings.at(-1)?.extendData?.text === '突破前高');

  step('a text is put on the box by a double click');
  await doubleClick(page, 790, 310);
  await page.waitForSelector(test('text-dialog'));
  await page.type(test('text-input'), '箱体');
  await page.click(test('text-ok'));
  await waitFor('the box to get its text', async () => (await snapshot(page)).drawings.find((drawing) => drawing.name === 'box')?.extendData?.text === '箱体');
  await click(page, 1050, 600);   // away from every drawing: nothing stays selected

  step('a drawing that is clicked takes the color chosen next');
  await click(page, 460, 315);    // on the segment
  await page.click(test('color-16a34a'));
  await waitFor('the segment to turn green', async () => (await snapshot(page)).drawings[0].extendData.color === '#16a34a');
  assert.equal((await snapshot(page)).drawings[0].styles.line.color, '#16a34a');
  assert.equal((await snapshot(page)).drawings[1].extendData.color, '#e11d48');
  await click(page, 1050, 600);

  step('indicators are chosen, one with parameters of its own');
  await page.click(test('indicators'));
  await page.click(test('indicator-MA'));
  await type(page, 'params-MA', '20');
  await page.click(test('indicator-MACD'));
  await page.click(test('indicators'));

  step('tag and comment are written');
  await type(page, 'tag', '箱体·待突破');
  await type(page, 'comment', '感觉这次上涨没有结束。\n第二行。');
  await page.select(test('timezone'), 'Asia/Shanghai');
  await sleep(300);

  step('the study is saved');
  const before = await snapshot(page);
  const beforePixels = {};
  for (const drawing of before.drawings) beforePixels[drawing.id] = await pixels(page, drawing.id);
  assert.equal(before.drawings.length, 4);
  await save(page);

  const [folder] = fs.readdirSync(studiesFolder);
  assert.match(folder, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
  const onDisk = (name) => path.join(studiesFolder, folder, name);
  assert.deepEqual(fs.readdirSync(path.join(studiesFolder, folder)).sort(), ['notes.md', 'screenshot.png', 'study.json']);
  assert.equal(fs.readFileSync(onDisk('notes.md'), 'utf8'), '感觉这次上涨没有结束。\n第二行。');
  const stored = JSON.parse(fs.readFileSync(onDisk('study.json'), 'utf8'));
  assert.equal(stored.tag, '箱体·待突破');
  assert.equal(stored.symbol, 'testfx');
  assert.equal(stored.timezone, 'Asia/Shanghai');
  assert.deepEqual(stored.indicators, [{ name: 'MA', pane: 'candle', params: [20], visible: true }, { name: 'MACD', pane: 'own', params: [12, 26, 9], visible: true }]);
  assert.deepEqual(stored.drawings.map(anchors), before.drawings.map(anchors));
  const image = fs.readFileSync(onDisk('screenshot.png'));
  assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(image.length > 20_000, `the screenshot has only ${image.length} bytes`);
  assert.ok((await page.$eval(test(`study-${folder}`), (element) => element.textContent)).includes('箱体·待突破'));

  step('the application is closed and opened again');
  await page.close();
  page = await openApp();
  assert.deepEqual((await snapshot(page)).drawings, [], 'a fresh start shows an empty chart');
  await page.click(`${test(`study-${folder}`)} .open`);
  await waitFor('the study to open', async () => (await snapshot(page)).drawings.length === 4);
  await loaded(page);

  step('everything is back where it was');
  const after = await snapshot(page);
  assert.deepEqual(after.drawings, before.drawings);
  assert.equal(await value(page, 'tag'), '箱体·待突破');
  assert.equal(await value(page, 'comment'), '感觉这次上涨没有结束。\n第二行。');
  assert.equal(await value(page, 'timezone'), 'Asia/Shanghai');
  assert.equal(await page.$eval(test('indicators'), (element) => element.textContent), '指标（2）');
  near(after.view.barSpace, before.view.barSpace, 0.01, 'bar space');
  assert.equal(after.view.rightTimestamp, before.view.rightTimestamp);
  for (const drawing of before.drawings) {
    const now = await pixels(page, drawing.id);
    assert.equal(now.length, beforePixels[drawing.id].length);
    now.forEach((pixel, index) => {
      const was = beforePixels[drawing.id][index];
      if (Number.isFinite(was.x)) near(pixel.x, was.x, 1.5, `${drawing.name} anchor ${index} x`);
      if (Number.isFinite(was.y)) near(pixel.y, was.y, 1.5, `${drawing.name} anchor ${index} y`);
    });
  }

  step('on other timeframes the drawings stay anchored to the same times and prices');
  for (const timeframe of ['h4', 'd1', 'w1', 'm15', 'm1', 'h1']) {
    await page.click(test(`timeframe-${timeframe}`));
    await waitFor(`the ${timeframe} bars`, async () => (await page.$eval(test(`timeframe-${timeframe}`), (element) => element.className)) === 'on');
    await loaded(page);
    const shown = await snapshot(page);
    assert.deepEqual(shown.drawings.map(anchors), before.drawings.map(anchors), `anchors on ${timeframe}`);
    for (const drawing of shown.drawings) {
      const now = await pixels(page, drawing.id);
      assert.ok(now.length === drawing.points.length && now.every((pixel) => Number.isFinite(pixel.x) || Number.isFinite(pixel.y)), `${drawing.name} is shown on ${timeframe}`);
    }
    assert.ok(shown.range[0] <= after.center && after.center <= shown.range[1], `the moment looked at is in view on ${timeframe}`);
  }
  near((await snapshot(page)).center, after.center, 2 * 3_600_000, 'the middle of the view after the round through the timeframes');

  step('a drawing is moved and the study saved again; the earlier state is kept');
  const [first, second] = await pixels(page, segment.id);
  await click(page, (first.x + second.x) / 2, (first.y + second.y) / 2);
  await drag(page, [first.x, first.y], [first.x - 40, first.y + 60]);
  const moved = (await snapshot(page)).drawings.find((drawing) => drawing.id === segment.id);
  assert.notDeepEqual(anchors(moved)[0], anchors(segment)[0]);
  assert.deepEqual(anchors(moved)[1], anchors(segment)[1]);
  assert.equal(await page.$eval(test('save'), (element) => element.textContent), '保存 *');
  await save(page);
  const [kept] = fs.readdirSync(onDisk('history'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(onDisk('history'), kept, 'study.json'), 'utf8')).drawings.map(anchors), before.drawings.map(anchors));
  assert.deepEqual(JSON.parse(fs.readFileSync(onDisk('study.json'), 'utf8')).drawings.find((drawing) => drawing.id === segment.id).points, moved.points);

  step('a selected drawing is removed with the Delete key');
  await click(page, 1050, 600);
  const [levelPixel] = await pixels(page, level.id);
  await click(page, 1000, levelPixel.y);
  await page.keyboard.press('Delete');
  await waitFor('the line to go', async () => (await snapshot(page)).drawings.length === 3);
  assert.ok(!(await snapshot(page)).drawings.some((drawing) => drawing.id === level.id));

  step('leaving unsaved work asks first');
  dialogs.length = 0;
  await page.click(test('new'));
  await waitFor('an empty chart', async () => (await snapshot(page)).drawings.length === 0);
  assert.equal(dialogs.length, 1);
  assert.ok(dialogs[0].includes('未保存'));
  assert.equal(await value(page, 'tag'), '');

  step('a deleted study goes to the trash folder');
  await page.click(test(`remove-${folder}`));
  await waitFor('the list to empty', async () => (await page.$$(`${test('studies')} .study`)).length === 0);
  assert.deepEqual(fs.readdirSync(studiesFolder), ['.trash']);
  assert.ok(fs.readdirSync(path.join(studiesFolder, '.trash'))[0].startsWith(folder));

  assert.deepEqual(problems, [], 'the browser reported errors');
} catch (error) {
  failure = error;
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
