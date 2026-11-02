// Real-pixel render verification — drives the untouched overlay + control page
// in a real Chromium (system Edge/Chrome via playwright-core; nothing bundled)
// against the mock SB server, injects the sample fixture, and asserts the DOM +
// canvas. The last scene runs the real sidecar, to see where the pointer stops. Writes
// test-render-wheel.png / test-render-reveal.png / test-render-landing.png /
// control-render.png (gitignored). Run: npm run verify:render
// First time: npm i --no-save playwright-core

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 7478;
const WS_PORT = 8084;
const GUARD_PORT = 7494;
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
let sidecar = null;
const cfgDir = mkdtempSync(resolve(tmpdir(), 'fortuna-render-'));
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

    // Status fields are text, whatever reaches the page. Relayed for real, on the
    // reserved args the sidecar's own status uses.
    const forged = {
      entryCount: '<img src=x onerror="window.__forged=1">',
      chatEntryCount: '<b id="forged-chat">9</b>',
      entryMode: { open: true, secondsLeft: '<i id="forged-left">1</i>' },
    };
    await page.evaluate((v) => window.__FORTUNA_SEND_COMMAND('__status', v), JSON.stringify(forged));
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Entries:'), null, { timeout: 5000 });
    await sleep(500); // a failed image load reports asynchronously
    const rendered = await page.locator('#status img, #status b#forged-chat, #status i#forged-left').count();
    const statusText = await page.locator('#status').textContent();
    check('control: HTML in a status stays text', rendered === 0 && statusText.includes(forged.entryCount), statusText);
    check('control: a status can\'t run script', (await page.evaluate(() => window.__forged ?? null)) === null);

    // A standing note about config.json has no time of its own, so it mustn't show one.
    await page.evaluate((v) => window.__FORTUNA_SEND_COMMAND('__status', v), JSON.stringify({ lastError: 'A standing note', lastErrorAt: null }));
    await page.waitForFunction(() => document.querySelector('#status .err')?.textContent.includes('A standing note'), null, { timeout: 5000 });
    const standing = await page.locator('#status .err').textContent();
    check('control: a note with no time shows none', !standing.includes('(at '), standing);

    // A label stays inside its quoted attributes, and reads back unchanged.
    const quoted = 'Don\'t " onmouseover="window.__label=1';
    await fetch(`${HTTP}/mock/push`, {
      method: 'POST',
      body: JSON.stringify({ ...sample, revision: (sample.revision ?? 0) + 1, entries: [{ id: quoted, label: quoted, tag: 'good', source: 'streamer' }] }),
    });
    await page.waitForFunction(() => document.querySelectorAll('#entries .entry').length === 1, null, { timeout: 5000 });
    const attrs = await page.locator('#entries .entry').evaluate((row) => {
      const lbl = row.querySelector('.lbl');
      return {
        id: row.dataset.id, title: lbl.title, text: lbl.textContent,
        handlers: [row, ...row.querySelectorAll('*')].flatMap((el) => el.getAttributeNames()).filter((n) => n.startsWith('on')),
      };
    });
    check('control: a quote in a label can\'t add a handler', attrs.handlers.length === 0, JSON.stringify(attrs.handlers));
    check('control: a quoted label reads back unchanged', attrs.id === quoted && attrs.title === quoted && attrs.text === quoted, JSON.stringify(attrs));
    await page.close();
  }

  // ── Scene 4: the real sidecar — where the pointer stops, and the control page's notices ──
  {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    // Records what the real draw() puts on the canvas, so the label under the pointer is
    // read from the paint calls and not worked out from the payload.
    await page.addInitScript(() => {
      const proto = CanvasRenderingContext2D.prototype;
      const onWheel = (name, fn) => {
        const orig = proto[name];
        proto[name] = function (...args) { if (this.canvas.id === 'wheel') fn(...args); return orig.apply(this, args); };
      };
      onWheel('clearRect', () => { window.__frame = { rotation: null, labels: [] }; });
      onWheel('rotate', (r) => { if (window.__frame.rotation === null) window.__frame.rotation = r + Math.PI / 2; });
      onWheel('fillText', (text) => { window.__frame.labels.push(text); });
    });
    await page.goto(`${HTTP}/fortuna-overlay/wheel.html?sbport=${WS_PORT}`);
    await page.waitForFunction(() => !document.body.classList.contains('offline'), null, { timeout: 8000 });
    await sleep(600); // the replay from connecting lands first, so the next update is the sidecar's

    // Resolves on the next update whose spin is in this state, or on any update if none is given.
    const nextUpdate = (state) => page.evaluate((want) => new Promise((res) => {
      const timer = setTimeout(() => res(false), 8000);
      const on = (e) => {
        if (want && e.detail.spin?.state !== want) return;
        clearTimeout(timer);
        window.removeEventListener('fortuna:update', on);
        res(true);
      };
      window.addEventListener('fortuna:update', on);
    }), state);
    const send = (command, value) => page.evaluate(([c, v]) => window.__FORTUNA_SEND_COMMAND(c, v), [command, value ?? '']);
    const resting = () => page.evaluate(() => {
      const f = window.__frame;
      return {
        slices: f.labels.length,
        under: f.labels[window.FortunaSpinMath.segmentAt(f.rotation, f.labels.length)],
        card: document.getElementById('reveal').hidden ? null : document.getElementById('reveal-label').textContent,
      };
    });
    // One whole spin of a fresh 8-slice wheel, with an optional command while it's in the air.
    const spinThrough = async (spinValue, during) => {
      const listed = nextUpdate();
      await send('setEntries', JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ label: `S${i + 1}` }))));
      await listed;
      const spinning = nextUpdate('spinning');
      await send('spin', spinValue);
      await spinning;
      const revealed = nextUpdate('revealed');
      if (during) await during();
      await revealed;
      return resting();
    };

    const seeded = nextUpdate();
    const cfgPath = resolve(cfgDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ entries: [], settings: { removeOnDraw: false, defaultChatTag: 'good' }, revision: 0 }));
    sidecar = spawn(process.execPath, [resolve(__dirname, 'fortuna-sidecar.mjs')], {
      env: { ...process.env, SB_WS_URL: `ws://127.0.0.1:${WS_PORT}/`, FORTUNA_CONFIG: cfgPath, FORTUNA_GUARD_PORT: String(GUARD_PORT), FORTUNA_SPIN_MS: '700' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await seeded;

    const onWinner = (r, slices) => r.card !== null && r.under === r.card && r.slices === slices;
    for (const [name, during] of [
      ['addEntry', () => send('addEntry', 'Late')],
      ['removeEntry', () => send('removeEntry', 'S8')],
      ['setEntries', () => send('setEntries', '[{"label":"A"},{"label":"B"},{"label":"C"}]')],
      ['clearEntries', () => send('clearEntries', 'all')],
    ]) {
      const r = await spinThrough('', during);
      check(`wheel: ${name} during a spin leaves the pointer on the winner`, onWinner(r, 8), JSON.stringify(r));
    }

    // Removing the winner at the reveal mustn't move the wheel under the card that names it.
    const rRemoved = await spinThrough('{"removeAfter":true}');
    check('wheel: removeAfter leaves the pointer on the winner', onWinner(rRemoved, 8), JSON.stringify(rRemoved));
    await page.screenshot({ path: resolve(__dirname, 'test-render-landing.png') });

    // A setSettings change sends an update at the same revision, so nothing moves.
    const settled = nextUpdate();
    await send('setSettings', '{"defaultChatTag":"bad"}');
    await settled;
    const rSettings = await resting();
    check('wheel: a setSettings change leaves the card up and the pointer on the winner', onWinner(rSettings, 8) && rSettings.card === rRemoved.card, JSON.stringify(rSettings));

    // The next change ends the reveal: the card goes, and the wheel shows the live list.
    const moved = nextUpdate();
    await send('addEntry', 'Next round');
    await moved;
    const rMoved = await resting();
    check('wheel: the next change ends the reveal and paints the live list', rMoved.card === null && rMoved.slices === 8, JSON.stringify(rMoved));
    const painted = await page.evaluate(() => window.__frame.labels);
    check('wheel: the live list has the winner gone and the new entry on', painted.includes('Next round') && !painted.includes(rRemoved.card), JSON.stringify(painted));

    const control = await browser.newPage({ viewport: { width: 700, height: 1000 } });
    await control.goto(`${HTTP}/fortuna-shared/control.html?sbport=${WS_PORT}`);
    await control.waitForFunction(() => document.getElementById('status').textContent.includes('Entries:'), null, { timeout: 8000 });

    // 'Drawing ready' belongs to a wheel with something on it.
    await send('openEntries', '{"maxEntries":5,"windowSec":0}');
    await send('closeEntries');
    await control.waitForSelector('body.ready .ready-banner', { timeout: 5000 });
    check('control: Drawing ready shows after a close with entries', await control.locator('.ready-banner').isVisible());
    await send('setEntries', '[]');
    await control.waitForFunction(() => !document.body.classList.contains('ready'), null, { timeout: 5000 }).catch(() => {});
    check('control: Drawing ready goes when the wheel empties', !(await control.locator('.ready-banner').isVisible()));

    // The error note says when it happened, and clears once someone at the page has acted.
    const note = () => control.locator('#status .err').allTextContents();
    await send('removeEntry', 'no such entry');
    await control.waitForSelector('#status .err', { timeout: 5000 });
    const shown = (await note()).join('');
    check('control: a failure shows a note and when it happened', shown.includes('no such entry') && /\(at .+\)/.test(shown), shown);
    check('control: the note\'s time includes the date', shown.includes(String(new Date().getFullYear())), shown);
    await control.fill('#new-label', 'Back to work');
    await control.click('#btn-add');
    await control.waitForFunction(() => !document.querySelector('#status .err'), null, { timeout: 5000 }).catch(() => {});
    check('control: a click that works clears the note', (await note()).length === 0, JSON.stringify(await note()));
    await control.close();

    // Hand-delivered updates, for the two cases the sidecar can't produce on demand.
    const deliver = (labelText, generatedAt) => page.evaluate(([label, at]) => {
      window.dispatchEvent(new CustomEvent('fortuna:update', { detail: { type: 'fortuna:update', revision: 1, generatedAt: at, entries: [{ label, tag: 'good' }], entryMode: { open: false }, spin: null } }));
      return window.__frame.labels;
    }, [labelText, generatedAt]);
    const afterStale = await deliver('Stale', '2000-01-01T00:00:00.000Z');
    check('wheel: an older update doesn\'t replace a newer one', !afterStale.includes('Stale'), JSON.stringify(afterStale));
    // A new wheel.js beside an old spin-math.js, cached or vendored by a theme, still paints.
    await page.evaluate(() => { delete window.FortunaSpinMath.paintedEntries; delete window.FortunaSpinMath.revealOnShow; });
    const afterOldMath = await deliver('Old math', new Date().toISOString());
    check('wheel: an old spin-math.js still paints the live list', afterOldMath.includes('Old math'), JSON.stringify(afterOldMath));
    await page.close();
  }
} catch (err) {
  fail++;
  console.error(`\nFATAL: ${err.stack || err}`);
} finally {
  try { await browser?.close(); } catch {}
  try { sidecar?.kill(); } catch {}
  try { mock.kill(); } catch {}
  await sleep(200); // the sidecar lets go of its config before the folder goes
  try { rmSync(cfgDir, { recursive: true, force: true }); } catch { /* it's in the temp folder */ }
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed (screenshots: test-render-wheel.png, test-render-reveal.png, test-render-landing.png, control-render.png)`);
process.exit(fail === 0 ? 0 : 1);
