// Screenshot generator for the README/docs — same plumbing as verify-render.mjs
// but writes pretty framing shots into docs/. Run: npm run shots
// First time: npm i --no-save playwright-core

import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = 7478;
const WS_PORT = 8084;
const HTTP = `http://127.0.0.1:${HTTP_PORT}`;
const OUT = resolve(__dirname, 'docs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run:  npm i --no-save playwright-core');
  process.exit(1);
}

const mock = spawn(process.execPath, [resolve(__dirname, 'mock-sb-server.mjs')], {
  env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${HTTP}/mock/stats`)).ok) break; } catch {}
  await sleep(100);
}

const sample = JSON.parse(await readFile(resolve(__dirname, 'fixtures', 'sample-update.json'), 'utf-8'));
await mkdir(OUT, { recursive: true });

let browser = null;
try {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* next */ }
  }
  if (!browser) throw new Error('no system Edge/Chrome — run: npx playwright-core install chromium');

  // Idle wheel with the entries banner up.
  await fetch(`${HTTP}/mock/push`, {
    method: 'POST',
    body: JSON.stringify({ ...sample, entryMode: { ...sample.entryMode, open: true } }),
  });
  let page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${HTTP}/fortuna-overlay/wheel.html?sbport=${WS_PORT}`);
  await page.waitForSelector('#entries-banner:not([hidden])', { timeout: 8000 });
  await sleep(500);
  await page.screenshot({ path: resolve(OUT, 'shot-wheel.png') });
  await page.close();

  // Revealed good draw with confetti mid-air.
  const spin = {
    spinId: 's_shot', entryCount: 8, selectedIndex: 2, selectedEntry: sample.entries[2],
    seed: 424242, startedAt: new Date(Date.now() - 6500).toISOString(),
    durationMs: 6000, extraSpins: 5, state: 'revealed',
  };
  await fetch(`${HTTP}/mock/push`, { method: 'POST', body: JSON.stringify({ ...sample, spin }) });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${HTTP}/fortuna-overlay/wheel.html?sbport=${WS_PORT}`);
  await page.waitForSelector('#reveal:not([hidden])', { timeout: 8000 });
  await sleep(700);
  await page.screenshot({ path: resolve(OUT, 'shot-reveal.png') });
  await page.close();

  // Control page.
  await fetch(`${HTTP}/mock/push`, { method: 'POST', body: JSON.stringify(sample) });
  page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
  await page.goto(`${HTTP}/fortuna-shared/control.html?sbport=${WS_PORT}`);
  await page.waitForSelector('#entries .entry', { timeout: 8000 });
  await sleep(500);
  await page.screenshot({ path: resolve(OUT, 'shot-control.png') });
  await page.close();

  console.log(`shots written to ${OUT}: shot-wheel.png, shot-reveal.png, shot-control.png`);
} finally {
  try { await browser?.close(); } catch {}
  try { mock.kill(); } catch {}
}
