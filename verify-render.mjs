// Real-pixel render verification — drives the untouched overlay + control page
// in a real Chromium (system Edge/Chrome via playwright-core; nothing bundled)
// against the mock SB server, injects the sample fixture, and asserts the DOM +
// canvas. Writes test-render-wheel.png / test-render-reveal.png /
// control-render.png (gitignored). Run: npm run verify:render
// First time: npm i --no-save playwright-core

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 7478;
const WS_PORT = 8084;
const HTTP = `http://127.0.0.1:${HTTP_PORT}`;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run:  npm i --no-save playwright-core');
  process.exit(1);
}

// Mock server
const mock = spawn(process.execPath, [resolve(__dirname, 'mock-sb-server.mjs')], {
  env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${HTTP}/mock/stats`)).ok) break; } catch {}
  await sleep(100);
}

const sample = JSON.parse(await readFile(resolve(__dirname, 'fixtures', 'sample-update.json'), 'utf-8'));

// Fraction of non-transparent pixels on a canvas — proves real paint, not a
// blank element.
const canvasCoverage = (page, sel) => page.locator(sel).evaluate((el) => {
  const ctx = el.getContext('2d');
  const { data } = ctx.getImageData(0, 0, el.width, el.height);
  let filled = 0;
  for (let i = 3; i < data.length; i += 40) { if (data[i] > 10) filled++; }
  return filled / (data.length / 40);
});

// Preload the idle fixture so sync-on-connect paints the wheel immediately.
await fetch(`${HTTP}/mock/push`, { method: 'POST', body: JSON.stringify(sample) });

let browser = null;
try {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* next */ }
  }
  if (!browser) throw new Error('no system Edge/Chrome and no bundled Chromium — run: npx playwright-core install chromium');

  // ── Scene 1: idle wheel with 8 fixture entries ──
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${HTTP}/fortuna-overlay/wheel.html?sbport=${WS_PORT}`);
    await page.waitForFunction(() => !document.body.classList.contains('offline'), null, { timeout: 8000 });
    await sleep(600);

    const coverage = await canvasCoverage(page, '#wheel');
    check('wheel: canvas painted', coverage > 0.4, `coverage ${coverage.toFixed(2)}`);
    check('wheel: reveal card hidden while idle', await page.locator('#reveal').isHidden());
    check('wheel: entries banner hidden while closed', await page.locator('#entries-banner').isHidden());
    await page.screenshot({ path: resolve(__dirname, 'test-render-wheel.png') });

    // Entries open → banner with the live count.
    await fetch(`${HTTP}/mock/push`, {
      method: 'POST',
      body: JSON.stringify({ ...sample, entryMode: { ...sample.entryMode, open: true } }),
    });
    await page.waitForSelector('#entries-banner:not([hidden])', { timeout: 5000 });
    const count = await page.locator('#entries-count').textContent();
    check('wheel: entries banner counts viewers', count === '2 / 25 entered', String(count));
    await page.close();
  }

  // ── Scene 2: revealed spin (startedAt in the past) → result card + effect ──
  {
    const spin = {
      spinId: 's_render', entryCount: 8, selectedIndex: 2,
      selectedEntry: sample.entries[2], // "Free choice", tag good → confetti
      seed: 123456789,
      startedAt: new Date(Date.now() - 7000).toISOString(),
      durationMs: 6000, extraSpins: 5, state: 'revealed',
    };
    await fetch(`${HTTP}/mock/push`, { method: 'POST', body: JSON.stringify({ ...sample, spin }) });

    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${HTTP}/fortuna-overlay/wheel.html?sbport=${WS_PORT}`);
    await page.waitForSelector('#reveal:not([hidden])', { timeout: 8000 });
    await sleep(500); // let the confetti get airborne before the pixel grab

    const label = await page.locator('#reveal-label').textContent();
    check('reveal: card shows the drawn label', label === 'Free choice', String(label));
    const tagged = await page.locator('#reveal.tag-good').count();
    check('reveal: card tinted by tag', tagged === 1, String(tagged));
    const fxCoverage = await canvasCoverage(page, '#fx');
    check('reveal: good-tag confetti painting on the fx layer', fxCoverage > 0.001, `coverage ${fxCoverage.toFixed(4)}`);
    // The wheel must REST on the winning segment: rotation at t≥duration equals
    // the target — assert via the exported math inside the page itself.
    const landed = await page.evaluate(([s]) => {
      const M = window.FortunaSpinMath;
      return M.segmentAt(M.rotationAt(s.durationMs, s, s.entryCount), s.entryCount) === s.selectedIndex;
    }, [spin]);
    check('reveal: wheel rests on the selected segment', landed);
    await page.screenshot({ path: resolve(__dirname, 'test-render-reveal.png') });
    await page.close();
  }

  // ── Scene 3: control page ──
  {
    // Restore the idle fixture so the entry list mirrors it.
    await fetch(`${HTTP}/mock/push`, { method: 'POST', body: JSON.stringify(sample) });
    const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
    await page.goto(`${HTTP}/fortuna-shared/control.html?sbport=${WS_PORT}`);
    await page.waitForSelector('#entries .entry', { timeout: 8000 });
    const rows = await page.locator('#entries .entry').count();
    check('control: entry list mirrors the payload', rows === 8, String(rows));
    const viewerTags = await page.locator('#entries .entry .src').allTextContents();
    check('control: viewer entries flagged', viewerTags.filter((t) => t === 'viewer').length === 2,
      JSON.stringify(viewerTags));
    // The mock has no sidecar consuming fortuna:command, so no __status ever
    // comes back → the liveness heartbeat should surface the "sidecar down" banner.
    await page.waitForSelector('body.no-sidecar', { timeout: 6000 }).catch(() => {});
    const warnShown = await page.locator('#sidecar-note').isVisible();
    check('control: warns when sidecar is absent', warnShown, String(warnShown));
    await page.screenshot({ path: resolve(__dirname, 'control-render.png') });
    await page.close();
  }
} catch (err) {
  fail++;
  console.error(`\nFATAL: ${err.stack || err}`);
} finally {
  try { await browser?.close(); } catch {}
  try { mock.kill(); } catch {}
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed (screenshots: test-render-wheel.png, test-render-reveal.png, control-render.png)`);
process.exit(fail === 0 ? 0 : 1);
