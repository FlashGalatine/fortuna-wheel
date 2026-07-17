// Fortuna verify suite — no network, no Streamer.bot install, no browser.
//   1. Spin math (the REAL overlay/spin-math.js): determinism, landing on the
//      selected segment, jitter staying inside the winning slice.
//   2. Mock-SB E2E: the REAL panel-core.js runs in a browser shim against the
//      mock server — Subscribe (lowercase), sync-on-connect replay, live push,
//      serialized command queue.
//   3. Mock HTTP maps.
//   4. Sidecar E2E: the REAL fortuna-sidecar.mjs runs against the mock —
//      entry CRUD, chat !entry dedupe + limits + auto-close, spin lifecycle
//      (spinning → revealed), removeOnDraw / removeDrawn, restart persistence.
//
// Uses off-default ports (HTTP 7478 / WS 8084 / guard 7494) so it can run next
// to a live Streamer.bot or sidecar. Run: npm run verify

import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 7478;
const WS_PORT = 8084;
const GUARD_PORT = 7494;
const HTTP = `http://127.0.0.1:${HTTP_PORT}`;
const WS_URL = `ws://127.0.0.1:${WS_PORT}/`;
const SPIN_MS = 500; // fast spins for the suite (FORTUNA_SPIN_MS)

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Spin math ──────────────────────────────────────────────────────────────

async function testSpinMath() {
  console.log('\n[1] spin math (real overlay/spin-math.js)');
  // The overlay file is a plain script that attaches to globalThis in Node.
  const src = await readFile(resolve(__dirname, 'overlay', 'spin-math.js'), 'utf-8');
  (0, eval)(src);
  const M = globalThis.FortunaSpinMath;
  check('module attaches FortunaSpinMath', !!M && typeof M.targetRotation === 'function');

  check('ease boundaries', M.ease(0) === 0 && M.ease(1) === 1, `${M.ease(0)}, ${M.ease(1)}`);
  check('ease monotonic', M.ease(0.2) < M.ease(0.5) && M.ease(0.5) < M.ease(0.9));
  check('progress clamps', M.progress(-50, 100) === 0 && M.progress(150, 100) === 1 && M.progress(0, 0) === 1);

  // Determinism: identical inputs → identical rotation at any time.
  const spin = { selectedIndex: 3, seed: 987654321, extraSpins: 5, durationMs: 6000 };
  check('deterministic rotation', M.rotationAt(2500, spin, 8) === M.rotationAt(2500, spin, 8));

  // The wheel must LAND on the sidecar's pick for every N/index/seed combo.
  let landOk = true, jitterOk = true, sample = '';
  for (const n of [1, 2, 3, 5, 8, 13, 50, 200]) {
    for (let t = 0; t < 40; t++) {
      const seed = (t * 2654435761 + n * 97) % 2147483647;
      const idx = seed % n;
      const extraSpins = 4 + (seed % 4);
      const theta = M.targetRotation(idx, n, seed, extraSpins);
      if (M.segmentAt(theta, n) !== idx) { landOk = false; sample = `n=${n} idx=${idx} seed=${seed} → seg ${M.segmentAt(theta, n)}`; }
      if (Math.abs(M.jitter(seed, n)) >= 0.5 * (M.TAU / n)) { jitterOk = false; sample = `jitter escapes slice at n=${n} seed=${seed}`; }
      if (theta < extraSpins * M.TAU) { landOk = false; sample = `theta lost its extra spins (n=${n} seed=${seed})`; }
    }
  }
  check('lands on the selected segment (320 combos)', landOk, sample);
  check('jitter stays inside the winning slice', jitterOk, sample);

  // Full animation end state equals the target.
  const end = M.rotationAt(spin.durationMs, spin, 8);
  check('animation ends at the target angle',
    Math.abs(end - M.targetRotation(3, 8, spin.seed, 5)) < 1e-9, String(end));
}

// ── Mock server helpers ───────────────────────────────────────────────────────

let mockProc = null;
async function startMock() {
  mockProc = spawn(process.execPath, [resolve(__dirname, 'mock-sb-server.mjs')], {
    env: { ...process.env, SB_HTTP_PORT: String(HTTP_PORT), SB_WS_PORT: String(WS_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mockProc.stderr.on('data', (d) => process.stderr.write(`[mock-err] ${d}`));
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${HTTP}/mock/stats`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('mock server did not come up');
}

function wsClient() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL);
    const events = [];
    const waiters = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ request: 'Subscribe', id: 'sub', events: { general: ['Custom'] } }));
      setTimeout(() => res({ ws, events, next }), 100);
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.event?.source === 'General' && m.event.type === 'Custom') {
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
        events.push(d);
        for (const w of waiters.splice(0)) w();
      }
    });
    ws.on('error', rej);
    function next(pred, timeoutMs = 5000) {
      return new Promise((resolve2, reject2) => {
        const scan = () => {
          const hit = events.find(pred);
          if (hit) { resolve2(hit); return true; }
          return false;
        };
        if (scan()) return;
        const t = setTimeout(() => reject2(new Error('timeout waiting for event')), timeoutMs);
        const w = () => { if (scan()) clearTimeout(t); else waiters.push(w); };
        waiters.push(w);
      });
    }
  });
}

// ── 2. panel-core in a browser shim ──────────────────────────────────────────

async function testPanelCore() {
  console.log('\n[2] panel-core (real file, browser shim, mock SB)');

  const winListeners = new Map();
  const received = [];
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  globalThis.window = {
    __SB_WS_URL: WS_URL,
    addEventListener: (t, fn) => { (winListeners.get(t) || winListeners.set(t, []).get(t)).push(fn); },
    dispatchEvent: (ev) => { received.push(ev); (winListeners.get(ev.type) || []).forEach((fn) => fn(ev)); },
  };
  globalThis.document = {
    readyState: 'complete',
    addEventListener: () => {},
    body: { classList: { toggle: () => {} } },
  };
  globalThis.location = { search: '' };
  globalThis.WebSocket = WebSocket;

  await import('./fortuna-shared/panel-core.js');

  // Sync-on-connect: panel-core Subscribes then DoActions "Fortuna Push" (no
  // payload) → mock replays the stored payload (none yet → empty update).
  await sleep(800);
  const sync = received.find((e) => e.type === 'fortuna:update');
  check('panel-core: sync-on-connect replay received', !!sync, JSON.stringify(received.map((e) => e.type)));
  check('panel-core: empty update shape', sync && Array.isArray(sync.detail.entries) && sync.detail.entries.length === 0 && sync.detail.spin === null);

  // Live push through the mock's HTTP surface (what the sidecar's DoAction becomes).
  const sample = await readFile(resolve(__dirname, 'fixtures', 'sample-update.json'), 'utf-8');
  await fetch(`${HTTP}/mock/push`, { method: 'POST', body: sample });
  await sleep(300);
  const live = received.filter((e) => e.type === 'fortuna:update').pop();
  check('panel-core: live fortuna:update dispatched', live && live.detail.entries.length === 8,
    live ? String(live.detail.entries.length) : 'none');
  check('panel-core: tags travel in payload', live && live.detail.entries[0].tag === 'bad');

  // Serialized command queue: two rapid sends must BOTH arrive (the second waits
  // for the first's ack instead of overlapping on the wire).
  const before = (await (await fetch(`${HTTP}/mock/stats`)).json()).commandCount;
  globalThis.window.__FORTUNA_SEND_COMMAND('status');
  globalThis.window.__FORTUNA_SEND_COMMAND('status');
  await sleep(600);
  const after = (await (await fetch(`${HTTP}/mock/stats`)).json()).commandCount;
  check('panel-core: serialized queue delivers both commands', after - before === 2, `${before} → ${after}`);
  const echo = received.find((e) => e.type === 'fortuna:command' && e.detail.command === 'status');
  check('panel-core: command relay echoes back as fortuna:command', !!echo);
}

// ── 3. HTTP serving ───────────────────────────────────────────────────────────

async function testHttp() {
  console.log('\n[3] mock HTTP maps');
  const overlay = await fetch(`${HTTP}/fortuna-overlay/wheel.html`);
  const overlayBody = await overlay.text();
  check('overlay served', overlay.status === 200);
  check('overlay references /fortuna-shared/panel-core.js', overlayBody.includes('/fortuna-shared/panel-core.js'));
  check('spin-math served', (await fetch(`${HTTP}/fortuna-overlay/spin-math.js`)).status === 200);
  check('effects served', (await fetch(`${HTTP}/fortuna-overlay/effects.js`)).status === 200);
  check('panel-core served', (await fetch(`${HTTP}/fortuna-shared/panel-core.js`)).status === 200);
  check('control page served', (await fetch(`${HTTP}/fortuna-shared/control.html`)).status === 200);
  check('traversal guarded', (await fetch(`${HTTP}/fortuna-shared/..%2Fconfig.example.json`)).status === 404);
}

// ── 4. Sidecar E2E ────────────────────────────────────────────────────────────

let sidecarProc = null;

function spawnSidecar(cfgPath) {
  const proc = spawn(process.execPath, [resolve(__dirname, 'fortuna-sidecar.mjs')], {
    env: {
      ...process.env,
      SB_WS_URL: WS_URL,
      FORTUNA_CONFIG: cfgPath,
      FORTUNA_GUARD_PORT: String(GUARD_PORT),
      FORTUNA_SPIN_MS: String(SPIN_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[sidecar-err] ${d}`));
  return proc;
}

async function testSidecar() {
  console.log('\n[4] sidecar (real process, mock SB)');

  const cfgPath = resolve(tmpdir(), `fortuna-verify-config-${process.pid}.json`);
  await writeFile(cfgPath, JSON.stringify({
    entries: [], entryMode: { open: false, maxEntries: 25, windowSec: 0 },
    settings: { removeOnDraw: false, defaultChatTag: 'good' }, lastSpin: null, revision: 0,
  }), 'utf-8');

  const client = await wsClient();
  sidecarProc = spawnSidecar(cfgPath);

  const isStatus = (d) => d.type === 'fortuna:command' && d.command === '__status';
  const parseStatus = (d) => JSON.parse(d.value);
  const isUpdate = (d) => d.type === 'fortuna:update';

  // client.next() scans the WHOLE event log; predicates that could also match an
  // earlier event need a scan of only the events after a recorded mark.
  const mark = () => client.events.length;
  const since = async (at, pred, timeoutMs = 4000) => {
    for (let i = 0; i * 100 < timeoutMs; i++) {
      const hit = client.events.slice(at).filter(pred).pop();
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };

  const cmd = (command, value, extra) => client.ws.send(JSON.stringify({
    request: 'DoAction', id: 'c', action: { name: 'Fortuna Command' },
    args: { command, value: value ?? '', ...(extra || {}) },
  }));

  // Startup: the sidecar re-seeds the persisted payload and announces itself.
  const s0 = await client.next(isStatus).then(parseStatus);
  check('sidecar: startup status broadcast', s0.connected === true && s0.entryCount === 0, JSON.stringify(s0));
  const u0 = await client.next(isUpdate);
  check('sidecar: startup update re-seeds SB global', u0.entries.length === 0 && u0.spin === null);

  // addEntry (JSON form) → update carries it, normalized.
  cmd('addEntry', JSON.stringify({ label: 'No jumping', tag: 'bad' }));
  const u1 = await client.next((d) => isUpdate(d) && d.entries.length === 1);
  check('sidecar: addEntry JSON', u1.entries[0].label === 'No jumping' && u1.entries[0].tag === 'bad' && u1.entries[0].source === 'streamer',
    JSON.stringify(u1.entries[0]));
  check('sidecar: entries get ids', typeof u1.entries[0].id === 'string' && u1.entries[0].id.startsWith('e_'));

  // addEntry (chat text form with trailing "| tag").
  cmd('addEntry', 'Winner picks the game | good');
  const u2 = await client.next((d) => isUpdate(d) && d.entries.length === 2);
  check('sidecar: addEntry text form parses tag', u2.entries[1].label === 'Winner picks the game' && u2.entries[1].tag === 'good',
    JSON.stringify(u2.entries[1]));

  // Untagged addEntry defaults to neutral.
  cmd('addEntry', 'Wildcard round');
  const u3 = await client.next((d) => isUpdate(d) && d.entries.length === 3);
  check('sidecar: untagged entry defaults neutral', u3.entries[2].tag === 'neutral', u3.entries[2].tag);

  // setTag by id.
  cmd('setTag', JSON.stringify({ id: u3.entries[2].id, tag: 'good' }));
  const u4 = await client.next((d) => isUpdate(d) && d.entries[2]?.tag === 'good');
  check('sidecar: setTag by id', u4.entries[2].tag === 'good');

  // removeEntry by label (case-insensitive).
  cmd('removeEntry', 'wildcard round');
  const u5 = await client.next((d) => isUpdate(d) && d.entries.length === 2);
  check('sidecar: removeEntry by label', !u5.entries.some((e) => e.label === 'Wildcard round'));

  // setEntries batch replace.
  cmd('setEntries', JSON.stringify([
    { label: 'Alpha', tag: 'good' }, { label: 'Bravo', tag: 'bad' }, { label: 'Charlie' },
  ]));
  const u6 = await client.next((d) => isUpdate(d) && d.entries.length === 3 && d.entries[0].label === 'Alpha');
  check('sidecar: setEntries batch replace', u6.entries.map((e) => e.tag).join(',') === 'good,bad,neutral',
    JSON.stringify(u6.entries.map((e) => e.tag)));

  // ── Viewer drawing ──
  cmd('openEntries', JSON.stringify({ maxEntries: 2, windowSec: 0 }));
  const sOpen = await client.next((d) => isStatus(d) && parseStatus(d).entryMode.open).then(parseStatus);
  check('sidecar: openEntries', sOpen.entryMode.open && sOpen.entryMode.maxEntries === 2, JSON.stringify(sOpen.entryMode));

  // Chat !entry exactly as a real SB Command trigger fires it: SB's OWN
  // command arg ("!entry") + commandId + rawInput — the action must map it to
  // the sidecar's "entry" command instead of relaying "!entry" verbatim.
  cmd('!entry', '', { commandId: 'trig-1', rawInput: '', user: 'chatter_99', userId: 'u99' });
  const u7 = await client.next((d) => isUpdate(d) && d.entries.some((e) => e.user === 'chatter_99'));
  const chatE = u7.entries.find((e) => e.user === 'chatter_99');
  check('sidecar: chat entry lands with default tag', chatE.source === 'chat' && chatE.tag === 'good', JSON.stringify(chatE));

  // Duplicate userId ignored.
  const atDupe = mark();
  cmd('entry', '', { user: 'CHATTER_99_renamed', userId: 'u99' });
  cmd('!entry', '', { commandId: 'trig-1', rawInput: '', user: 'CHATTER_99_renamed', userId: 'u99' });
  cmd('status');
  const sDupe = await since(atDupe, isStatus).then((d) => parseStatus(d));
  check('sidecar: duplicate userId deduped', sDupe.chatEntryCount === 1, String(sDupe.chatEntryCount));

  // Second distinct viewer hits maxEntries → auto-close + ready.
  cmd('entry', '', { user: 'pixel_pal', userId: 'u42' });
  const sFull = await client.next((d) => isStatus(d) && parseStatus(d).ready).then(parseStatus);
  check('sidecar: max entries auto-closes and flags ready', !sFull.entryMode.open && sFull.ready && sFull.chatEntryCount === 2,
    JSON.stringify({ open: sFull.entryMode.open, ready: sFull.ready, chat: sFull.chatEntryCount }));

  // Entries while closed are ignored.
  const atClosed = mark();
  cmd('entry', '', { user: 'latecomer', userId: 'u77' });
  cmd('status');
  const sClosed = await since(atClosed, isStatus).then((d) => parseStatus(d));
  check('sidecar: entry while closed ignored', sClosed.chatEntryCount === 2, String(sClosed.chatEntryCount));

  // Timed window: open for 1s with no takers → auto-close, ready (entries remain).
  cmd('openEntries', JSON.stringify({ maxEntries: 10, windowSec: 1 }));
  await client.next((d) => isStatus(d) && parseStatus(d).entryMode.open && parseStatus(d).entryMode.windowSec === 1);
  const sTimed = await client.next((d) => isStatus(d) && !parseStatus(d).entryMode.open && parseStatus(d).ready, 4000).then(parseStatus);
  check('sidecar: entry window auto-closes on the timer', sTimed.ready === true);

  // ── Spin lifecycle ──
  const atSpin = mark();
  cmd('spin');
  const uSpin = await since(atSpin, (d) => isUpdate(d) && d.spin?.state === 'spinning');
  check('sidecar: spin broadcasts spinning state', !!uSpin, 'no spinning update');
  const spin = uSpin.spin;
  check('sidecar: spin block is well-formed',
    spin.entryCount === 5 && spin.selectedIndex >= 0 && spin.selectedIndex < 5
      && Number.isInteger(spin.seed) && spin.durationMs === SPIN_MS && spin.extraSpins >= 4
      && spin.selectedEntry?.id === uSpin.entries[spin.selectedIndex].id,
    JSON.stringify(spin));
  check('sidecar: ready cleared by spin', (await since(atSpin, isStatus).then(parseStatus)).ready === false);

  // Reveal lands after durationMs; the entry stays (removeOnDraw off).
  const uReveal = await since(atSpin, (d) => isUpdate(d) && d.spin?.state === 'revealed');
  check('sidecar: reveal broadcast', uReveal && uReveal.spin.spinId === spin.spinId && uReveal.entries.length === 5,
    JSON.stringify(uReveal?.spin ?? null));

  // Spinning guard: a second spin while one runs is refused.
  const atDouble = mark();
  cmd('spin');
  const uSpin2 = await since(atDouble, (d) => isUpdate(d) && d.spin?.state === 'spinning');
  await since(atDouble, (d) => isUpdate(d) && d.spin?.state === 'revealed');
  const atGuard = mark();
  cmd('spin');
  cmd('spin'); // second lands while first is mid-air
  const uGuard = await since(atGuard, (d) => isUpdate(d) && d.spin?.state === 'revealed');
  const spinningBetween = client.events.slice(atGuard).filter((d) => isUpdate(d) && d.spin?.state === 'spinning');
  check('sidecar: concurrent spin refused', spinningBetween.length === 1 && !!uGuard && !!uSpin2,
    `${spinningBetween.length} spinning broadcasts`);

  // removeDrawn removes exactly the drawn entry.
  const drawnId = uGuard.spin.selectedEntry.id;
  const atRemove = mark();
  cmd('removeDrawn');
  const uRemoved = await since(atRemove, (d) => isUpdate(d) && d.entries.length === 4);
  check('sidecar: removeDrawn removes exactly the drawn entry',
    uRemoved && !uRemoved.entries.some((e) => e.id === drawnId), JSON.stringify(uRemoved?.entries.map((e) => e.label)));

  // spin {removeAfter:true} removes the winner at reveal. Scope the reveal wait
  // to THIS spin's id — every update re-carries the previous revealed spin.
  const atRm = mark();
  cmd('spin', JSON.stringify({ removeAfter: true }));
  const uRmSpin = await since(atRm, (d) => isUpdate(d) && d.spin?.state === 'spinning');
  const uRmReveal = await since(atRm, (d) => isUpdate(d) && d.spin?.state === 'revealed' && d.spin.spinId === uRmSpin?.spin.spinId);
  check('sidecar: removeAfter removes winner at reveal',
    uRmSpin?.entries.length === 4 && uRmReveal?.entries.length === 3
      && !uRmReveal.entries.some((e) => e.id === uRmReveal.spin.selectedEntry.id),
    `${uRmSpin?.entries.length} → ${uRmReveal?.entries.length}`);

  // clearEntries chat.
  const atClear = mark();
  cmd('clearEntries', 'chat');
  const uNoChat = await since(atClear, (d) => isUpdate(d) && !d.entries.some((e) => e.source === 'chat'));
  check('sidecar: clearEntries chat keeps streamer entries', uNoChat && uNoChat.entries.length > 0 && uNoChat.entries.every((e) => e.source === 'streamer'),
    JSON.stringify(uNoChat?.entries.map((e) => e.source)));

  // Chat "!wheel addEntry …" as a real Command trigger fires it (command arg is
  // "!wheel", the sidecar command lives in rawInput).
  const atWheelChat = mark();
  cmd('!wheel', '', { commandId: 'trig-2', rawInput: 'addEntry Run it back | bad', user: 'modfriend', userId: 'u5' });
  const uWheelChat = await since(atWheelChat, (d) => isUpdate(d) && d.entries.some((e) => e.label === 'Run it back'));
  check('sidecar: chat !wheel addEntry maps through the trigger shape',
    uWheelChat && uWheelChat.entries.find((e) => e.label === 'Run it back').tag === 'bad',
    JSON.stringify(uWheelChat?.entries.map((e) => e.label)));
  cmd('removeEntry', 'Run it back');
  await since(mark() - 1, (d) => isUpdate(d) && !d.entries.some((e) => e.label === 'Run it back'));

  // setSettings batch.
  cmd('setSettings', JSON.stringify({ removeOnDraw: true, defaultChatTag: 'neutral' }));
  const sSet = await client.next((d) => isStatus(d) && parseStatus(d).settings.removeOnDraw).then(parseStatus);
  check('sidecar: setSettings batch', sSet.settings.removeOnDraw === true && sSet.settings.defaultChatTag === 'neutral',
    JSON.stringify(sSet.settings));

  // Unknown command is ignored without a crash.
  const atUnknown = mark();
  cmd('doABarrelRoll', '42');
  cmd('status');
  const sAlive = await since(atUnknown, isStatus);
  check('sidecar: unknown command ignored', !!sAlive);

  // ── Restart persistence ──
  const lastUpdate = client.events.filter(isUpdate).pop();
  const entriesBefore = lastUpdate.entries;
  const lastSpinBefore = lastUpdate.spin;
  sidecarProc.kill();
  await sleep(400);
  const atRestart = mark();
  sidecarProc = spawnSidecar(cfgPath);
  const uRestart = await since(atRestart, isUpdate, 5000);
  check('sidecar: restart restores entries', uRestart && uRestart.entries.length === entriesBefore.length
    && uRestart.entries.every((e, i) => e.id === entriesBefore[i].id), JSON.stringify(uRestart?.entries.map((e) => e.label)));
  check('sidecar: restart restores last revealed spin',
    uRestart?.spin?.state === 'revealed' && uRestart.spin.spinId === lastSpinBefore.spinId, JSON.stringify(uRestart?.spin ?? null));
  check('sidecar: entry window never restarts open', uRestart?.entryMode.open === false);

  client.ws.close();
  await rm(cfgPath, { force: true });
}

// ── Run ───────────────────────────────────────────────────────────────────────

try {
  await testSpinMath();
  await startMock();
  await testPanelCore();
  await testHttp();
  await testSidecar();
} catch (err) {
  fail++;
  console.error(`\nFATAL: ${err.stack || err}`);
} finally {
  try { sidecarProc?.kill(); } catch {}
  try { mockProc?.kill(); } catch {}
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
