// Opens the application on a workspace that a failed test left behind, for a look inside.
//   node e2e/debug.mjs <workspace> <hash> [script.js]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const [workspace, hash = '#/', script] = process.argv.slice(2);
const port = 18765 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = spawn('uv', ['run', 'candle-viewer', '--workspace', workspace, '--port', String(port)], { cwd: path.resolve(here, '..', '..'), stdio: 'ignore' });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1720, height: 980 } });
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/api/meta`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  const page = await browser.newPage();
  page.on('console', (message) => console.log('console:', message.text()));
  page.on('pageerror', (error) => console.log('pageerror:', error.message));
  await page.goto(`http://127.0.0.1:${port}/${hash}`, { waitUntil: 'networkidle0' });
  await sleep(1500);
  if (script) {
    const run = (await import(path.resolve(script))).default;
    await run(page, { sleep, port });
  }
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
