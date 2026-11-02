// Fortuna verify suite — no network, no Streamer.bot install, no browser.
//   1. Spin math (the REAL overlay/spin-math.js): determinism, landing on the
//      selected segment, jitter staying inside the winning slice.
//   2. Mock-SB E2E: the REAL panel-core.js runs in a browser shim against the
//      mock server — Subscribe (lowercase), sync-on-connect replay, live push,
//      serialized command queue.
//   3. Mock HTTP maps, and the mock's copy of the action's mapping (same rows as 5).
//   4. Sidecar E2E: the REAL fortuna-sidecar.mjs runs against the mock —
//      entry CRUD, chat !entry dedupe + limits + auto-close, spin lifecycle
//      (spinning → revealed), channel point redeems, removeOnDraw / removeDrawn,
//      hostile chat JSON, restart persistence, a bad saved config, and the crashes
//      chat can't reach: a reset guard socket, a closed stdout or stderr, a throw in a
//      timer, and whatever else nothing catches.
//   5. The REAL actions/fortuna-command.cs, compiled with the .NET Framework's csc
//      against a stub CPH (tools/action-harness.cs). Proves its logic and C# 5
//      syntax, not real Streamer.bot behavior. Skipped when csc isn't installed.
//
// Uses off-default ports (HTTP 7478 / WS 8084 / guard 7494) so it can run next
// to a live Streamer.bot or sidecar. Run: npm run verify

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
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

let pass = 0, fail = 0, skipped = 0;
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
  const wire = []; // every frame panel-core puts on its socket
  globalThis.WebSocket = class extends WebSocket {
    send(data) { wire.push(data); super.send(data); }
  };

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

  // Serialized command queue: two rapid sends must BOTH arrive, and the second waits
  // for the first's ack instead of overlapping on the wire. No ack can land in this tick.
  const before = (await (await fetch(`${HTTP}/mock/stats`)).json()).commandCount;
  const framesBefore = wire.length;
  globalThis.window.__FORTUNA_SEND_COMMAND('status');
  globalThis.window.__FORTUNA_SEND_COMMAND('status');
  check('panel-core: a second command waits for the first\'s ack', wire.length - framesBefore === 1, `${wire.length - framesBefore} frames at once`);
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
  check('malformed URL refused', (await fetch(`${HTTP}/%E0%A4%A`)).status === 400);
  check('mock outlives a malformed URL', (await fetch(`${HTTP}/mock/stats`)).ok);
}

// ── 4. Sidecar E2E ────────────────────────────────────────────────────────────

let sidecarProc = null;
let sidecarOut = '';

function spawnSidecar(cfgPath, { execArgv = [], env = {} } = {}) {
  const proc = spawn(process.execPath, [...execArgv, resolve(__dirname, 'fortuna-sidecar.mjs')], {
    env: {
      ...process.env,
      SB_WS_URL: WS_URL,
      FORTUNA_CONFIG: cfgPath,
      FORTUNA_GUARD_PORT: String(GUARD_PORT),
      FORTUNA_SPIN_MS: String(SPIN_MS),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { sidecarOut += d; });
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

  // One spin, start to reveal. Every update re-carries the last revealed spin, so the
  // reveal wait is scoped to this spin's id.
  const drawSpin = async (value) => {
    const at = mark();
    cmd('spin', value);
    const spinning = await since(at, (d) => isUpdate(d) && d.spin?.state === 'spinning');
    const revealed = spinning && await since(at, (d) => isUpdate(d) && d.spin?.state === 'revealed' && d.spin.spinId === spinning.spin.spinId);
    return { spinning, revealed };
  };

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

  // setTag by label (case-insensitive).
  const atTagLabel = mark();
  cmd('setTag', JSON.stringify({ label: 'wildcard ROUND', tag: 'bad' }));
  const u4Label = await since(atTagLabel, isUpdate);
  check('sidecar: setTag by label', u4Label?.entries[2].tag === 'bad', JSON.stringify(u4Label?.entries[2] ?? null));

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

  // ── Channel point redeems ──
  // A Reward Redemption trigger attached straight onto the action, as SB fires
  // it: the reward args and NO `command`. rawInput is whatever the viewer typed.
  const redeem = (rawInput, extra) => client.ws.send(JSON.stringify({
    request: 'DoAction', id: 'r', action: { name: 'Fortuna Command' },
    args: { ...REDEEM, rawInput, ...(extra || {}) },
  }));
  const entriesBeforeRedeem = client.events.filter(isUpdate).pop().entries.length;

  const atRedeem = mark();
  redeem('');
  const uRedeem = await since(atRedeem, (d) => isUpdate(d) && d.spin?.state === 'spinning');
  check('sidecar: reward redemption spins the wheel', !!uRedeem, 'no spinning update');
  await since(atRedeem, (d) => isUpdate(d) && d.spin?.state === 'revealed' && d.spin.spinId === uRedeem?.spin.spinId);

  // A reward that asks for text: what the viewer typed must not run as a command.
  const atTyped = mark();
  redeem('clearEntries');
  const uTyped = await since(atTyped, (d) => isUpdate(d) && d.spin?.state === 'spinning');
  check('sidecar: redeem text never runs as a command',
    uTyped?.entries.length === entriesBeforeRedeem, `${uTyped?.entries.length} of ${entriesBeforeRedeem} entries`);
  await since(atTyped, (d) => isUpdate(d) && d.spin?.state === 'revealed' && d.spin.spinId === uTyped?.spin.spinId);

  // A separate action sets its own `command` before Run Action; it beats the
  // redeem default, so a reward can mean something other than spin.
  const atRedeemOpen = mark();
  cmd('openEntries', JSON.stringify({ maxEntries: 10, windowSec: 0 }));
  await since(atRedeemOpen, (d) => isUpdate(d) && d.entryMode.open);
  const atWrapper = mark();
  redeem('', { command: 'entry' });
  const uWrapper = await since(atWrapper, (d) => isUpdate(d) && d.entries.some((e) => e.userId === 'u200'));
  check('sidecar: a separate action\'s command beats the redeem default', !!uWrapper, 'redeemer never entered');
  const atRedeemCleanup = mark();
  cmd('closeEntries');
  cmd('clearEntries', 'chat');
  await since(atRedeemCleanup, (d) => isUpdate(d) && !d.entryMode.open && !d.entries.some((e) => e.userId === 'u200'));

  // A Set Argument for `command` inside the action must not turn Fortuna's own
  // traffic into spins: the real panel-core asks for status and the real sidecar
  // answers, both under the hijack. Cleared before checking, to end a regression's
  // flood. waitForProof waits on the round trip itself, up to a bound, so a slow
  // machine can't fail these.
  const setArgs = (args) => fetch(`${HTTP}/mock/set-args`, { method: 'POST', body: JSON.stringify(args) });
  const waitForProof = async (at, label) => {
    await since(at, (d) => isUpdate(d) && d.entries.some((e) => e.label === label), 1500);
    await since(at, (d) => isStatus(d) && d.value.startsWith('{'), 1500);
  };
  const atHijack = mark();
  await setArgs({ command: 'spin', value: 'x' });
  globalThis.window.__FORTUNA_SEND_COMMAND('addEntry', JSON.stringify({ label: 'Hijack proof', tag: 'good' }));
  await waitForProof(atHijack, 'Hijack proof');
  await setArgs({});
  const hijacked = client.events.slice(atHijack);
  check('sidecar: Set Argument command=spin can\'t rewrite Fortuna\'s own traffic',
    hijacked.some((d) => isUpdate(d) && d.entries.some((e) => e.label === 'Hijack proof'))
      && hijacked.some((d) => isStatus(d) && d.value.startsWith('{'))
      && !hijacked.some((d) => d.type === 'fortuna:command' && d.command === 'spin'),
    `${hijacked.filter((d) => d.command === 'spin').length} spin commands, ${hijacked.filter(isStatus).length} status replies`);
  const atHijackCleanup = mark();
  cmd('removeEntry', 'Hijack proof');
  await since(atHijackCleanup, (d) => isUpdate(d) && d.spin?.state !== 'spinning' && !d.entries.some((e) => e.label === 'Hijack proof'));

  // An action pasted before the reserved args existed ignores them, so the real
  // panel-core and sidecar must keep sending plain command + value as well.
  const atOldAction = mark();
  await setArgs({ fortunaCommand: '', fortunaValue: '' });
  globalThis.window.__FORTUNA_SEND_COMMAND('addEntry', JSON.stringify({ label: 'Old action proof', tag: 'good' }));
  await waitForProof(atOldAction, 'Old action proof');
  await setArgs({});
  const onOldAction = client.events.slice(atOldAction);
  check('sidecar: page and sidecar still work with an older action',
    onOldAction.some((d) => isUpdate(d) && d.entries.some((e) => e.label === 'Old action proof'))
      && onOldAction.some((d) => isStatus(d) && d.value.startsWith('{')),
    `${onOldAction.filter(isStatus).length} status replies`);
  const atOldActionCleanup = mark();
  cmd('removeEntry', 'Old action proof');
  await since(atOldActionCleanup, (d) => isUpdate(d) && !d.entries.some((e) => e.label === 'Old action proof'));

  // setSettings batch.
  const atSettings = mark();
  const revisionBeforeSettings = client.events.filter(isUpdate).pop().revision;
  cmd('setSettings', JSON.stringify({ removeOnDraw: true, defaultChatTag: 'neutral' }));
  const sSet = await client.next((d) => isStatus(d) && parseStatus(d).settings.removeOnDraw).then(parseStatus);
  check('sidecar: setSettings batch', sSet.settings.removeOnDraw === true && sSet.settings.defaultChatTag === 'neutral',
    JSON.stringify(sSet.settings));
  const uSet = await since(atSettings, isUpdate, 1000);
  check('sidecar: setSettings reaches fortuna:update, which is what gets replayed',
    uSet?.settings.removeOnDraw === true && uSet.settings.defaultChatTag === 'neutral', JSON.stringify(uSet?.settings ?? null));
  check('sidecar: a settings change keeps the revision', uSet?.revision === revisionBeforeSettings, `${revisionBeforeSettings} -> ${uSet?.revision}`);
  const settingsSaved = () => readFile(cfgPath, 'utf-8').then(JSON.parse).then((saved) => saved.settings.defaultChatTag === 'neutral').catch(() => false);
  for (let i = 0; i < 15 && !(await settingsSaved()); i++) await sleep(100);
  check('sidecar: a settings change is saved', await settingsSaved());

  // The new default tag reaches a viewer's entry.
  const atTagged = mark();
  cmd('openEntries', '{"maxEntries":10,"windowSec":0}');
  cmd('entry', '', { user: 'tagged_viewer', userId: 'u321' });
  const uTagged = await since(atTagged, (d) => isUpdate(d) && d.entries.some((e) => e.userId === 'u321'));
  check('sidecar: a chat entry takes the default tag setSettings chose', uTagged?.entries.find((e) => e.userId === 'u321').tag === 'neutral', JSON.stringify(uTagged?.entries ?? null));
  const atTaggedCleanup = mark();
  cmd('closeEntries');
  cmd('removeEntry', 'tagged_viewer');
  await since(atTaggedCleanup, (d) => isUpdate(d) && !d.entryMode.open && !d.entries.some((e) => e.userId === 'u321'));

  // The elimination setting: no per-spin option, and the winner still leaves the wheel. The
  // earlier draws can leave one entry here, so add one: the checks below need a wheel left.
  const atFodder = mark();
  cmd('addEntry', 'Elimination fodder');
  const uFodder = await since(atFodder, (d) => isUpdate(d) && d.entries.some((e) => e.label === 'Elimination fodder'));
  const { revealed: uOnDraw } = await drawSpin();
  check('sidecar: removeOnDraw removes the winner with no per-spin option',
    !!uOnDraw && uOnDraw.entries.length === uFodder.entries.length - 1 && !uOnDraw.entries.some((e) => e.id === uOnDraw.spin.selectedEntry.id),
    `${uFodder?.entries.length} -> ${uOnDraw?.entries.length}`);

  // Unknown command is ignored without a crash.
  const atUnknown = mark();
  cmd('doABarrelRoll', '42');
  cmd('status');
  const sAlive = await since(atUnknown, isStatus);
  check('sidecar: unknown command ignored', !!sAlive);

  // ── Hostile JSON from chat ──
  // Anyone allowed to run !wheel can send any JSON, and String() and Number() throw on
  // {"toString":1} or an array holding one. That used to end the process, and the wheel
  // stayed down until someone restarted it. After each input, a removeEntry that can't
  // match sets a unique lastError: its status proves the sidecar outlived the input, and
  // what came before it is the input's own outcome. A row that kills the sidecar restarts
  // it, so every other row still reports for itself.
  let probes = 0;
  const hostile = async (send) => {
    const at = mark();
    await send();
    const probe = `__probe_${++probes}`;
    cmd('removeEntry', probe);
    const proof = await since(at, (d) => isStatus(d) && parseStatus(d).lastError.includes(probe), 1500);
    if (proof && sidecarProc.exitCode === null) {
      const outcome = client.events.slice(at, client.events.indexOf(proof, at));
      return {
        alive: true,
        after: parseStatus(proof),
        lastError: outcome.filter(isStatus).map(parseStatus).pop()?.lastError,
        updates: outcome.filter(isUpdate),
      };
    }
    if (sidecarProc.exitCode !== null) {
      const atRespawn = mark();
      sidecarProc = spawnSidecar(cfgPath);
      await since(atRespawn, isStatus, 5000);
    }
    return { alive: false, updates: [] };
  };
  const BAD = '{"toString":1}';
  const viewerSays = (rawInput) => () => cmd('!wheel', '', { commandId: 'trig-3', rawInput, user: 'viewer', userId: 'u666' });
  const wheelBefore = client.events.filter(isUpdate).pop().entries;
  const wheelJson = JSON.stringify(wheelBefore);
  const refused = (r, lastError) => r.alive && r.lastError === lastError && r.updates.length === 0 && r.after.entryCount === wheelBefore.length;

  const SET_TAG_ERROR = 'setTag: expected {id, tag} with tag good|bad|neutral';
  for (const [input, lastError] of [
    [`addEntry {"label":${BAD}}`, 'addEntry: empty label'],
    [`addEntry {"label":[${BAD}]}`, 'addEntry: empty label'],
    ['addEntry {"label":{}}', 'addEntry: empty label'],
    ['addEntry {"label":["a"]}', 'addEntry: empty label'],
    [`setEntries [{"label":${BAD}}]`, 'setEntries: no usable entries'],
    ['setEntries [{"label":"  "}]', 'setEntries: no usable entries'],
    ['setEntries [1,"x",null]', 'setEntries: no usable entries'],
    [`setTag {"id":${BAD},"tag":"good"}`, SET_TAG_ERROR],
    [`setTag {"label":${BAD},"tag":"good"}`, SET_TAG_ERROR],
  ]) {
    const r = await hostile(viewerSays(input));
    check(`sidecar: refuses !wheel ${input}`, refused(r, lastError), JSON.stringify(r));
  }

  // The action only relays strings, so chat can't send these, but another broadcaster
  // could. The whole relay is dropped, even clearEntries with only a bad `user`, and
  // only the try/catch around dispatch keeps the sidecar up. A field that doesn't throw,
  // like {} or [], still converts and runs, as it always has.
  const relay = (body) => () => fetch(`${HTTP}/mock/push`, { method: 'POST', body: JSON.stringify({ type: 'fortuna:command', ...body }) });
  const atRelayLog = sidecarOut.length;
  let relayNote;
  for (const body of [
    { command: { toString: 1 } },
    { command: 'clearEntries', value: { toString: 1 } },
    { command: 'clearEntries', value: 'all', user: { toString: 1 } },
    { command: 'clearEntries', value: 'all', userId: { toString: 1 } },
  ]) {
    const r = await hostile(relay(body));
    relayNote = r.lastError;
    check(`sidecar: drops a relay with a field that throws ${JSON.stringify(body)}`,
      /^a command failed: \S/.test(relayNote ?? '') && refused(r, relayNote), JSON.stringify(r));
  }
  // The log is the only record of the stack, and it arrives on another stream from the status.
  // It gets the error's name and frames: the stack's first line repeats the message, unescaped.
  const loggedStack = () => /a command failed: (.*) \(TypeError\)\n\s+at /.exec(sidecarOut.slice(atRelayLog));
  for (let i = 0; i < 15 && !loggedStack(); i++) await sleep(100);
  const relayStack = loggedStack();
  check('sidecar: a dropped relay shows its error and logs its stack',
    !!relayStack && relayNote === `a command failed: ${relayStack[1]}` && !sidecarOut.slice(atRelayLog).includes('\nTypeError:'), `${relayNote} | ${sidecarOut.slice(-300)}`);

  // A setSettings with nothing valid or nothing new sends only its status. The status is
  // what hostile() sees as this input's lastError, so undefined would mean it never came.
  const settingsNow = JSON.stringify((await hostile(() => {})).after?.settings);
  for (const input of ['setSettings junk', 'setSettings {}', 'setSettings {"defaultChatTag":"purple"}', `setSettings {"defaultChatTag":${BAD}}`, `setSettings ${settingsNow}`]) {
    const r = await hostile(viewerSays(input));
    check(`sidecar: !wheel ${input} sends only a status`,
      r.alive && r.updates.length === 0 && r.lastError !== undefined && JSON.stringify(r.after.settings) === settingsNow, JSON.stringify(r));
  }

  // A bad option keeps its old value and the window still opens. These updates come from
  // the live state, so they also prove the rows above left the entries alone. The options
  // start non-zero, so one that reads as 0 shows up.
  const closeWindow = async () => {
    const atClose = mark();
    cmd('closeEntries');
    return since(atClose, (d) => isUpdate(d) && !d.entryMode.open);
  };
  const atOptions = mark();
  cmd('openEntries', '{"maxEntries":9,"windowSec":600}');
  await since(atOptions, (d) => isUpdate(d) && d.entryMode.windowSec === 600);
  check('sidecar: closeEntries closes the window', !!(await closeWindow()));
  for (const opts of [`{"maxEntries":${BAD}}`, `{"windowSec":${BAD}}`, `{"maxEntries":[${BAD}]}`, '{"maxEntries":[5]}', '{"windowSec":[]}', '{"maxEntries":null}', '{"windowSec":null}']) {
    const r = await hostile(viewerSays(`openEntries ${opts}`));
    const em = r.after?.entryMode;
    const closed = await closeWindow();
    check(`sidecar: !wheel openEntries ignores a bad option ${opts}`,
      r.alive && em.open && em.maxEntries === 9 && em.windowSec === 600 && !!closed
        && JSON.stringify(r.updates.at(-1)?.entries) === wheelJson, JSON.stringify({ ...r, closed: !!closed }));
  }

  // Options that do apply: text converts, text that isn't a number keeps the old value, 0 is
  // a value and not "absent", and the rest rounds into range. Each row starts from the last
  // row's values, and the table ends back on 9 and 600.
  for (const [opts, maxEntries, windowSec] of [
    ['{"maxEntries":"5"}', 5, 600],
    ['{"windowSec":"300"}', 5, 300],
    ['{"maxEntries":"abc"}', 5, 300],
    ['{"windowSec":"abc"}', 5, 300],
    ['{"windowSec":0}', 5, 0],
    ['{"maxEntries":99999}', 200, 0],
    ['{"windowSec":1e12}', 200, 3600],
    ['{"maxEntries":-5}', 1, 3600],
    ['{"windowSec":-5}', 1, 0],
    ['{"maxEntries":2.6,"windowSec":0.4}', 3, 0],
    ['{"maxEntries":9,"windowSec":600}', 9, 600],
  ]) {
    const r = await hostile(viewerSays(`openEntries ${opts}`));
    const em = r.after?.entryMode;
    const closed = await closeWindow();
    check(`sidecar: !wheel openEntries applies ${opts}`,
      r.alive && em.open && em.maxEntries === maxEntries && em.windowSec === windowSec && !!closed, JSON.stringify({ ...r, closed: !!closed }));
  }

  // setEntries replaces the list: a bad field costs only that field, a bad row only that
  // row. Numbers and booleans still convert, as they always have.
  for (const [input, want] of [
    [`setEntries [{"label":"Keeper","user":${BAD}}]`, [{ label: 'Keeper' }]],
    [`setEntries [{"label":"Keeper","userId":${BAD}}]`, [{ label: 'Keeper' }]],
    [`setEntries [{"label":${BAD}},{"label":"Keeper"}]`, [{ label: 'Keeper' }]],
    ['setEntries [{"label":42,"user":7,"userId":8}]', [{ label: '42', user: '7', userId: '8' }]],
    ['setEntries [{"label":true,"user":false,"userId":true}]', [{ label: 'true', user: 'false', userId: 'true' }]],
  ]) {
    const r = await hostile(viewerSays(input));
    const got = r.updates.at(-1)?.entries.map(({ label, user, userId }) => ({ label, user, userId }));
    check(`sidecar: !wheel ${input} keeps what's usable`, r.alive && JSON.stringify(got) === JSON.stringify(want), JSON.stringify(r));
  }

  // A bad id, tag or source would reach the overlay and control page, whose drawing and
  // escaping throw on an object.
  const rGuard = await hostile(viewerSays(`setEntries [{"label":"Keeper","id":${BAD},"tag":${BAD},"source":${BAD}}]`));
  const kept = rGuard.updates.at(-1)?.entries[0];
  check('sidecar: !wheel setEntries replaces a bad id, tag or source',
    rGuard.alive && typeof kept?.id === 'string' && kept.tag === 'neutral' && kept.source === 'streamer', JSON.stringify(rGuard));

  // The caps: what a list can hold, and how long its text can be.
  const LONG = 'x'.repeat(100);
  const rLong = await hostile(viewerSays(`setEntries [{"label":"${LONG}","user":"${LONG}","userId":"${LONG}"}]`));
  const capped = rLong.updates.at(-1)?.entries[0];
  check('sidecar: setEntries caps label, user and userId', capped?.label.length === 80 && capped.user?.length === 60 && capped.userId?.length === 60, JSON.stringify(capped ?? null));
  const rMany = await hostile(() => cmd('setEntries', JSON.stringify(Array.from({ length: 205 }, (_, i) => ({ label: `Row ${i}` })))));
  const many = rMany.updates.at(-1)?.entries ?? [];
  check('sidecar: setEntries keeps the first 200 rows, each with its own id',
    many.length === 200 && many[199].label === 'Row 199' && new Set(many.map((e) => e.id)).size === 200, `${many.length} rows`);
  const rFull = await hostile(viewerSays('addEntry One too many'));
  check('sidecar: addEntry refuses a full wheel', rFull.alive && rFull.lastError === 'addEntry: wheel is full (200)' && rFull.updates.length === 0, JSON.stringify(rFull.lastError));

  const rStreamer = await hostile(viewerSays('setEntries [{"label":"Mine"},{"label":"Theirs","source":"chat"}]'));
  const rClearStreamer = await hostile(viewerSays('clearEntries streamer'));
  check('sidecar: clearEntries streamer keeps chat entries', rStreamer.alive
    && JSON.stringify(rClearStreamer.updates.at(-1)?.entries.map((e) => e.label)) === '["Theirs"]', JSON.stringify(rClearStreamer));

  // Removal and setTag go by id. findEntry trims its key, so a blank or padded id could never
  // match, and it tries ids first, so an id like "Alpha" would catch another row's label.
  for (const [kind, id] of [['blank', '   '], ['padded', ' e_p1 '], ['label-shaped', 'Alpha']]) {
    const r = await hostile(viewerSays(`setEntries [{"label":"Stuck","id":${JSON.stringify(id)}},{"label":"Other"}]`));
    const stuckId = r.updates.at(-1)?.entries[0].id;
    const rTag = await hostile(() => cmd('setTag', JSON.stringify({ id: stuckId, tag: 'bad' })));
    const rGone = await hostile(() => cmd('removeEntry', stuckId ?? ''));
    check(`sidecar: a row sent with a ${kind} id can be tagged and removed`,
      r.alive && stuckId !== id && rTag.updates.at(-1)?.entries[0].tag === 'bad'
        && JSON.stringify(rGone.updates.at(-1)?.entries.map((e) => e.label)) === '["Other"]',
      JSON.stringify({ stuckId, rTag: rTag.lastError, rGone: rGone.lastError }));
  }
  await hostile(viewerSays('setEntries [{"label":"Alpha"},{"label":"Bravo","id":"Alpha"}]'));
  const rByLabel = await hostile(viewerSays('removeEntry Alpha'));
  check('sidecar: an id can\'t catch removal by another row\'s label',
    JSON.stringify(rByLabel.updates.at(-1)?.entries.map((e) => e.label)) === '["Bravo"]', JSON.stringify(rByLabel));

  // A repeated id: the first holder keeps it, and a draw removes the row it drew.
  const rRepeat = await hostile(viewerSays('setEntries [{"id":"e_x","label":"A"},{"id":"e_x","label":"B"},{"id":"e_x","label":"C"},{"id":"e_x","label":"D"}]'));
  const repeated = rRepeat.updates.at(-1)?.entries ?? [];
  check('sidecar: setEntries keeps the first holder of a repeated id and renames the rest',
    repeated[0]?.id === 'e_x' && new Set(repeated.map((e) => e.id)).size === 4, JSON.stringify(repeated));
  const { revealed: uRepeat } = await drawSpin('{"removeAfter":true}');
  check('sidecar: a draw from that list removes the row it drew',
    uRepeat?.entries.length === 3 && !uRepeat.entries.some((e) => e.label === uRepeat.spin.selectedEntry.label), JSON.stringify(uRepeat));

  // Viewer and relay text can carry newlines and terminal escapes: JSON decodes them into
  // a label, and a relay can send them raw. One log call must stay one physical line.
  const FORGED = '\n[2026-01-01T00:00:00.000Z] [fortuna] shutting down\u001b[2J\u009b1m\u2028\u202e\u2067\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u2066\u2068\u2069';
  const atLog = sidecarOut.length;
  await hostile(viewerSays(`setEntries [{"label":${JSON.stringify(`x${FORGED}`)}}]`));
  await drawSpin();
  for (const body of [
    { command: `noSuchCommand${FORGED}` },
    { command: 'status', value: `v${FORGED}`, user: `u${FORGED}` },
    { command: 'removeEntry', value: `nobody${FORGED}` },
    { command: 'L'.repeat(300), user: 'L'.repeat(300) },
  ]) await hostile(relay(body));
  await hostile(() => cmd('openEntries', '{"maxEntries":5,"windowSec":0}'));
  await hostile(relay({ command: 'entry', user: `chatter${FORGED}` }));
  await hostile(relay({ command: 'entry', user: 'L'.repeat(300) }));
  await hostile(() => cmd('closeEntries'));
  await hostile(viewerSays('setEntries [{"label":"Plain — Привет"}]'));
  await drawSpin();
  const logWritten = () => /REVEALED "Plain — Привет"/.test(sidecarOut.slice(atLog));
  for (let i = 0; i < 15 && !logWritten(); i++) await sleep(100);
  const logged = sidecarOut.slice(atLog);
  const badLines = logged.split('\n').filter((l) => l && !l.startsWith('['));
  check('sidecar: viewer and relay text can\'t start a new log line',
    logWritten() && !/^\[2026-01-01/m.test(logged) && badLines.length === 0, JSON.stringify(badLines));
  check('sidecar: control and direction characters print escaped in the log',
    logWritten() && !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(logged) && logged.includes('\\u001b[2J') && logged.includes('\\u202e\\u2067\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u2066\\u2068\\u2069'), logged.slice(0, 400));
  check('sidecar: long text is capped in the log', logWritten() && !logged.includes('L'.repeat(121)), logged.slice(0, 400));
  check('sidecar: plain text prints unchanged in the log', logWritten() && logged.includes('SPIN → [0] "Plain — Привет"'), logged.slice(-300));

  // Nothing talks to the guard port, so a client that connects and resets must not matter.
  const guardReset = () => new Promise((res) => {
    const s = connect(GUARD_PORT, '127.0.0.1', () => { s.resetAndDestroy(); setTimeout(res, 300); });
    s.on('error', res);
  });
  const rReset = await hostile(guardReset);
  check('sidecar: a reset on the guard port doesn\'t end the process', rReset.alive && sidecarProc.exitCode === null, JSON.stringify(rReset));
  const guardHeld = await new Promise((res) => {
    const s = connect(GUARD_PORT, '127.0.0.1', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
  check('sidecar: the guard port stays bound after a reset', guardHeld);

  // An empty list still clears on purpose. Then the wheel goes back for the restart checks.
  const rEmpty = await hostile(viewerSays('setEntries []'));
  check('sidecar: !wheel setEntries [] still clears the wheel', rEmpty.alive && rEmpty.after.entryCount === 0, JSON.stringify(rEmpty));
  const savedRows = [...wheelBefore, { id: 'e_saved_chat', label: 'saved_viewer', tag: 'good', source: 'chat', user: 'saved_viewer', userId: 'u777' }];
  const savedJson = JSON.stringify(savedRows);
  const atRestore = mark();
  cmd('setEntries', savedJson);
  const uRestored = await since(atRestore, (d) => isUpdate(d) && d.entries.length === savedRows.length);
  check('sidecar: setEntries takes back a saved list, ids and chat rows included',
    wheelBefore.length > 0 && JSON.stringify(uRestored?.entries) === savedJson, JSON.stringify(uRestored?.entries ?? null));

  // ── Restart persistence ──
  const lastUpdate = client.events.filter(isUpdate).pop();
  const entriesBefore = lastUpdate.entries;
  const lastSpinBefore = lastUpdate.spin;
  // The kill is abrupt and nothing waits for the sidecar's write, so wait for it here. A
  // write caught part way would fail the checks below on correct code.
  const isSaved = () => readFile(cfgPath, 'utf-8').then(JSON.parse)
    .then((saved) => saved.revision === lastUpdate.revision).catch(() => false);
  for (let i = 0; i < 50 && !(await isSaved()); i++) await sleep(100);
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

  // ── Booting from a saved config ──
  // config.json can hold anything: a hand edit, or a value that was never valid.
  const reboot = async (config, options, waitMs = 5000) => {
    if (sidecarProc.exitCode === null) {
      const exited = new Promise((res) => sidecarProc.once('exit', res));
      sidecarProc.kill();
      await exited;
    }
    if (config) await writeFile(cfgPath, JSON.stringify(config), 'utf-8');
    const at = mark();
    sidecarProc = spawnSidecar(cfgPath, options);
    const update = await since(at, isUpdate, waitMs);
    const status = await since(at, isStatus, waitMs);
    return { update, status: status && parseStatus(status) };
  };
  const THROWS = { toString: 1 };
  const savedEntries = [
    { id: 'e_a', label: 'A', tag: 'good', source: 'streamer' },
    { id: 'e_b', label: 'B', tag: 'bad', source: 'streamer' },
    { id: 'e_c', label: 'C', tag: 'neutral', source: 'streamer' },
  ];
  const savedConfig = {
    entries: savedEntries, entryMode: { open: false, maxEntries: 25, windowSec: 0, openedAt: null },
    settings: { removeOnDraw: false, defaultChatTag: 'good' }, lastSpin: null, revision: 7,
  };

  // Same rule as the live setSettings: only true or "true" turn it on.
  for (const [saved, want] of [['false', false], [THROWS, false], [1, false], ['true', true], [true, true]]) {
    const { status } = await reboot({ ...savedConfig, settings: { removeOnDraw: saved, defaultChatTag: 'good' } });
    check(`sidecar: a saved removeOnDraw of ${JSON.stringify(saved)} loads as ${want}`, status?.settings.removeOnDraw === want, JSON.stringify(status?.settings));
  }

  const { update: uSavedIds } = await reboot({ ...savedConfig, entries: [
    { id: 'e_keep', label: 'Keep' }, { id: 'e_keep', label: 'Repeat' }, { id: '   ', label: 'Blank' }, { id: ' e_p ', label: 'Padded' }, { id: 'Keep', label: 'Named' },
  ] });
  const savedIds = uSavedIds?.entries.map((e) => e.id) ?? [];
  check('sidecar: a saved list loads with usable, distinct ids', savedIds.length === 5 && savedIds[0] === 'e_keep'
    && new Set(savedIds).size === 5 && savedIds.every((id) => id.startsWith('e_') && id === id.trim()), JSON.stringify(savedIds));

  // A saved spin is replayed to every overlay, which does arithmetic on its fields.
  const savedSpin = {
    spinId: 's_saved', entryCount: 3, selectedIndex: 1, selectedEntry: savedEntries[1], seed: 12345,
    startedAt: '2026-01-01T00:00:00.000Z', durationMs: 6000, extraSpins: 5, state: 'revealed',
  };
  // A field added later has to survive a restart without anyone listing it here.
  const savedExtras = { spinId: savedSpin.spinId, segments: [{ label: 'A', tag: 'good' }], ...savedSpin, revealRevision: 9, junk: THROWS };
  const { update: uSavedSpin, status: sSavedSpin } = await reboot({ ...savedConfig, lastSpin: savedExtras });
  check('sidecar: a saved spin comes back whole, with fields it doesn\'t know, in the same order',
    JSON.stringify(uSavedSpin?.spin) === JSON.stringify(savedExtras) && sSavedSpin?.lastSpin?.label === 'B', JSON.stringify(uSavedSpin?.spin));
  const { update: uFixedTag, status: sFixedTag } = await reboot({ ...savedConfig, lastSpin: { ...savedSpin, selectedEntry: { id: 'e_b', label: 'B', tag: THROWS } } });
  check('sidecar: a saved spin\'s bad tag reads as neutral', uFixedTag?.spin?.selectedEntry.tag === 'neutral' && sFixedTag?.lastSpin?.tag === 'neutral', JSON.stringify(uFixedTag?.spin));
  // The next save overwrites a dropped block, so the note has to say which field cost it.
  for (const [name, bad, field] of [
    ['a spinId that throws', { spinId: THROWS }, 'spinId'],
    ['a label that throws', { selectedEntry: { id: 'e_b', label: THROWS } }, 'selectedEntry'],
    ['a selectedEntry that isn\'t an entry', { selectedEntry: 'B' }, 'selectedEntry'],
    ['an entryCount that throws', { entryCount: THROWS }, 'entryCount'],
    ['an entryCount over the wheel\'s limit', { entryCount: 201 }, 'entryCount'],
    ['a selectedIndex off the wheel', { selectedIndex: 3 }, 'selectedIndex'],
    ['a seed that isn\'t a number', { seed: '12345' }, 'seed'],
    ['a durationMs that isn\'t a number', { durationMs: THROWS }, 'durationMs'],
    ['a durationMs of 0', { durationMs: 0 }, 'durationMs'],
    ['extraSpins that aren\'t a number', { extraSpins: null }, 'extraSpins'],
    ['a startedAt that isn\'t a date', { startedAt: 'soon' }, 'startedAt'],
  ]) {
    const { update, status } = await reboot({ ...savedConfig, lastSpin: { ...savedSpin, ...bad } });
    check(`sidecar: a saved spin with ${name} is dropped, and the note names ${field}`,
      !!update && update.spin === null && status?.lastSpin === null && status.lastError.includes(`bad ${field}`), JSON.stringify({ spin: update?.spin, lastError: status?.lastError }));
  }
  const atDropLog = sidecarOut.length;
  const { status: sTwoBad } = await reboot({ ...savedConfig, lastSpin: { ...savedSpin, seed: '12345', durationMs: 0 } });
  const dropLogged = () => !!sTwoBad?.lastError && sidecarOut.slice(atDropLog).includes(sTwoBad.lastError);
  for (let i = 0; i < 15 && !dropLogged(); i++) await sleep(100);
  check('sidecar: a dropped spin names its first bad field, in the note and the log',
    sTwoBad?.lastError.includes('bad seed') && dropLogged(), `${sTwoBad?.lastError} | ${sidecarOut.slice(atDropLog, atDropLog + 300)}`);
  // A save only ever writes null or a revealed spin, so anything else is a hand edit that the
  // next save overwrites, and the note has to say so.
  for (const [name, lastSpin, field] of [
    ['a spin that wasn\'t revealed', { ...savedSpin, state: 'spinning' }, 'state'],
    ['a saved spin with no state', { ...savedSpin, state: undefined }, 'state'],
    ['an empty last draw', {}, 'state'],
    ['a last draw that\'s text', 'B', 'lastSpin'],
    ['a last draw of 0', 0, 'lastSpin'],
    ['a last draw of false', false, 'lastSpin'],
    ['a last draw that\'s empty text', '', 'lastSpin'],
    ['a last draw that\'s a list', [savedSpin], 'lastSpin'],
    ['a last draw that\'s an empty list', [], 'lastSpin'],
  ]) {
    const atNoteLog = sidecarOut.length;
    const { update, status } = await reboot({ ...savedConfig, lastSpin });
    const noteLogged = () => !!status?.lastError && sidecarOut.slice(atNoteLog).includes(status.lastError);
    for (let i = 0; i < 15 && !noteLogged(); i++) await sleep(100);
    check(`sidecar: a config with ${name} starts with no spin, and the note and the log name ${field}`,
      !!update && update.spin === null && status?.lastSpin === null && status.lastError.includes(`bad ${field}`) && noteLogged(), JSON.stringify({ spin: update?.spin, lastError: status?.lastError, log: sidecarOut.slice(atNoteLog, atNoteLog + 300) }));
  }
  // These two mean no draw yet, so there's nothing to report. The config loads before the
  // connection opens, so by the connect line a note would have reached the log.
  for (const [name, lastSpin] of [['a last draw of null', null], ['no last draw block', undefined]]) {
    const atQuietLog = sidecarOut.length;
    const { update, status } = await reboot({ ...savedConfig, lastSpin });
    const connected = () => sidecarOut.slice(atQuietLog).includes('Connected to Streamer.bot');
    for (let i = 0; i < 15 && !connected(); i++) await sleep(100);
    check(`sidecar: a config with ${name} starts with no spin, no note and no log line, its entries kept`,
      !!update && update.spin === null && status?.lastError === '' && update.entries.length === savedEntries.length
      && connected() && !sidecarOut.slice(atQuietLog).includes('saved last draw'), JSON.stringify({ lastError: status?.lastError, entries: update?.entries.length, log: sidecarOut.slice(atQuietLog, atQuietLog + 300) }));
  }

  // removeDrawn after a restart: the id rules can give a saved row a new id, and the saved
  // winner has to end up on its row, or the wrong row goes, or none does.
  const drawnBeforeRestart = async (entries, selectedIndex, selectedEntry) => {
    const { update } = await reboot({ ...savedConfig, entries, lastSpin: { ...savedSpin, entryCount: entries.length, selectedIndex, selectedEntry } });
    return { update, removed: await hostile(() => cmd('removeDrawn')) };
  };
  const tagsLeft = ({ removed }) => JSON.stringify(removed.updates.at(-1)?.entries.map((e) => `${e.label}:${e.tag}`));
  const rRepeatedId = await drawnBeforeRestart([{ id: 'e_x', label: 'A', tag: 'good' }, { id: 'e_x', label: 'B', tag: 'good' }], 1, { id: 'e_x', label: 'B' });
  check('sidecar: after a restart, removeDrawn removes the drawn row of a repeated id', tagsLeft(rRepeatedId) === '["A:good"]', JSON.stringify(rRepeatedId.removed));
  const rCustomId = await drawnBeforeRestart([{ id: 'boss_1', label: 'Boss', tag: 'good' }, { id: 'boss_2', label: 'Minion', tag: 'good' }], 0, { id: 'boss_1', label: 'Boss' });
  check('sidecar: after a restart, removeDrawn removes a row saved with a custom id', tagsLeft(rCustomId) === '["Minion:good"]', JSON.stringify(rCustomId.removed));
  const rTwins = await drawnBeforeRestart([{ id: 'e_x', label: 'Twin', tag: 'good' }, { id: 'e_x', label: 'Twin', tag: 'bad' }], 1, { id: 'e_x', label: 'Twin', tag: 'bad' });
  check('sidecar: after a restart, selectedIndex settles which of two matching rows was drawn', tagsLeft(rTwins) === '["Twin:good"]', JSON.stringify(rTwins.removed));
  const rSavedId = await drawnBeforeRestart([{ id: 'e_1', label: 'Twin', tag: 'good' }, { id: 'e_2', label: 'Twin', tag: 'bad' }], 0, { id: 'e_2', label: 'Twin', tag: 'bad' });
  check('sidecar: after a restart, the saved id picks between two rows with one label, ahead of selectedIndex', tagsLeft(rSavedId) === '["Twin:good"]', JSON.stringify(rSavedId.removed));
  const rNoRow = await drawnBeforeRestart([{ id: 'e_a', label: 'A', tag: 'good' }], 0, { id: 'e_gone', label: 'Gone' });
  check('sidecar: a saved winner with no row keeps its id, and removeDrawn says it\'s gone',
    rNoRow.update?.spin.selectedEntry.id === 'e_gone' && rNoRow.removed.lastError === 'removeDrawn: drawn entry is already gone' && rNoRow.removed.updates.length === 0, JSON.stringify(rNoRow));
  const rOtherLabel = await drawnBeforeRestart([{ id: 'boss_1', label: 'Other', tag: 'good' }], 0, { id: 'boss_1', label: 'Gone' });
  check('sidecar: a saved winner doesn\'t take the id of a row with another label', rOtherLabel.removed.updates.length === 0 && rOtherLabel.removed.lastError === 'removeDrawn: drawn entry is already gone', JSON.stringify(rOtherLabel.removed));
  // Here a row still holds the winner's id: the first of a repeated id was drawn and removed,
  // or the row was renamed by hand. The sidecar can't tell which, so it removes nothing.
  for (const [where, entries] of [
    ['selectedIndex', [{ id: 'e_x', label: 'B', tag: 'good' }, { id: 'e_c', label: 'C', tag: 'good' }]],
    ['another index', [{ id: 'e_c', label: 'C', tag: 'good' }, { id: 'e_x', label: 'B', tag: 'good' }]],
  ]) {
    const rSharedId = await drawnBeforeRestart(entries, 0, { id: 'e_x', label: 'A' });
    check(`sidecar: a saved winner with no row doesn't share the id of one at ${where}, and removeDrawn says it's gone`,
      rSharedId.update?.spin.selectedEntry.id !== 'e_x' && rSharedId.removed.updates.length === 0 && rSharedId.removed.lastError === 'removeDrawn: drawn entry is already gone', JSON.stringify(rSharedId));
  }

  // ── Crashes chat can't reach ──
  // Launched with a pipe whose reader goes away, the next log lines fail on a later tick,
  // outside any try/catch. hostile() sends a command, which logs. Commands and a spin both.
  await reboot(savedConfig);
  const piped = sidecarProc; // hostile() replaces a sidecar that died
  const atStdout = mark();
  piped.stdout.destroy();
  const { revealed: uPiped } = await drawSpin();
  for (let i = 0; i < 3; i++) { await hostile(viewerSays('addEntry Still here')); await sleep(100); }
  check('sidecar: a closed stdout doesn\'t end the process or raise a note', !!uPiped && piped.exitCode === null && sidecarProc === piped
    && !client.events.slice(atStdout).some((d) => isStatus(d) && parseStatus(d).lastError.includes('failed:')), `exit code ${piped.exitCode}`);

  // A throw in a timer, where dispatch's try/catch can't see it. No known input causes one,
  // so tools/throw-on-log.cjs throws from a chosen log line, with no hook in the sidecar.
  const preload = resolve(__dirname, 'tools', 'throw-on-log.cjs');
  const noPattern = spawnSync(process.execPath, ['--require', preload, '-e', ''], { env: { ...process.env, FORTUNA_THROW_ON: undefined }, encoding: 'utf-8' });
  check('throw-on-log: says what it needs when FORTUNA_THROW_ON is missing', noPattern.status !== 0 && noPattern.stderr.includes('FORTUNA_THROW_ON is required'), noPattern.stderr.slice(0, 300));
  const withFaults = {
    execArgv: ['--require', preload],
    env: { FORTUNA_THROW_ON: 'SPIN .*"BoomSpin"|REVEALED "BoomReveal"|entries CLOSED \\(time\\)' },
  };
  const faultsOn = (env) => ({ ...withFaults, env: { ...withFaults.env, ...env } });
  const noted = (at, text) => since(at, (d) => isStatus(d) && parseStatus(d).lastError.includes(text), 1500).then((d) => d && parseStatus(d));
  const nextSpinWorks = async () => {
    const at = mark();
    cmd('setEntries', '[{"label":"Next"}]');
    await since(at, (d) => isUpdate(d) && d.entries[0]?.label === 'Next');
    return !!(await drawSpin()).revealed;
  };

  // The reveal throws after the winner is removed: the surfaces still hear where it got to.
  await reboot({ ...savedConfig, entries: [{ id: 'e_boom', label: 'BoomReveal' }] }, withFaults);
  const atBoom = mark();
  const { spinning: uRevealSpin, revealed: uBoom } = await drawSpin('{"removeAfter":true}');
  const sBoom = await noted(atBoom, 'reveal failed: injected fault');
  check('sidecar: a throw in a spin\'s reveal doesn\'t end the process', sidecarProc.exitCode === null && sBoom?.spinning === false, JSON.stringify(sBoom));
  check('sidecar: that spin still reaches the overlay as revealed', uBoom?.entries.length === 0, JSON.stringify(uBoom ?? null));
  check('sidecar: a throw before the revision was raised still raises it, once',
    !!uBoom && uBoom.revision === uRevealSpin.revision + 1, JSON.stringify({ spinning: uRevealSpin?.revision, revealed: uBoom?.revision }));
  check('sidecar: the next spin isn\'t refused after a throw in a reveal', await nextSpinWorks(), JSON.stringify(client.events.filter(isStatus).pop()?.value));

  // spin() itself throws, inside dispatch's catch: the spin must not be left with no timer.
  await reboot({ ...savedConfig, entries: [{ id: 'e_boom', label: 'BoomSpin' }] }, withFaults);
  const atBoomSpin = mark();
  cmd('spin');
  const sBoomSpin = await noted(atBoomSpin, 'a command failed: injected fault');
  const uBoomSpin = await since(atBoomSpin, (d) => isUpdate(d) && d.spin?.state === 'revealed' && d.spin.selectedEntry.label === 'BoomSpin');
  check('sidecar: a throw while a spin starts still ends in its reveal', sBoomSpin?.spinning === true && !!uBoomSpin, JSON.stringify({ sBoomSpin, uBoomSpin }));
  check('sidecar: the next spin isn\'t refused after a throw while a spin starts', await nextSpinWorks(), JSON.stringify(client.events.filter(isStatus).pop()?.value));

  // An entry window's close timer throws after the window shut.
  await reboot(savedConfig, withFaults);
  const atBoomClose = mark();
  cmd('openEntries', '{"maxEntries":5,"windowSec":1}');
  await since(atBoomClose, (d) => isUpdate(d) && d.entryMode.open);
  const atBoomClosed = mark();
  const sBoomClose = await since(atBoomClosed, (d) => isStatus(d) && parseStatus(d).lastError.includes('close failed: injected fault'), 3000).then((d) => d && parseStatus(d));
  const uBoomClose = await since(atBoomClosed, (d) => isUpdate(d) && !d.entryMode.open, 1000);
  check('sidecar: a throw in an entry window\'s close doesn\'t end the process', sidecarProc.exitCode === null && sBoomClose?.entryMode.open === false, JSON.stringify(sBoomClose));
  check('sidecar: that window still reaches the overlay as closed', !!uBoomClose, 'no closed update');

  // A reveal throws inside applyChange, after it raised the revision. That one change still
  // counts once, and the surfaces still hear it.
  await reboot({ ...savedConfig, entries: [{ id: 'e_boom', label: 'BoomPush' }] }, faultsOn({ FORTUNA_THROW_ON_UPDATE: '"BoomPush".*"state":"revealed"' }));
  const atBoomPush = mark();
  const { spinning: uPushSpin, revealed: uBoomPush } = await drawSpin();
  const sBoomPush = await noted(atBoomPush, 'reveal failed: injected fault');
  check('sidecar: a throw after the revision was raised doesn\'t raise it again',
    !!sBoomPush && !!uBoomPush && uBoomPush.revision === uPushSpin.revision + 1, JSON.stringify({ spinning: uPushSpin?.revision, revealed: uBoomPush?.revision, note: sBoomPush?.lastError }));

  // The catch's own log call throws too. The note is all that's left, and the wheel stays up.
  await reboot({ ...savedConfig, entries: [{ id: 'e_boom', label: 'BoomNote' }] }, faultsOn({ FORTUNA_THROW_ON: 'REVEALED "BoomNote"|reveal failed' }));
  const atBoomNote = mark();
  await drawSpin();
  const sBoomNote = await noted(atBoomNote, 'reveal failed: injected fault');
  check('sidecar: a throw from the log call in a timer\'s catch doesn\'t end the process', sidecarProc.exitCode === null && sBoomNote?.spinning === false, JSON.stringify(sBoomNote));

  // A V8 message can quote a value, so an error's message and a stack's first line can hold
  // viewer text. Only escaped text and frame lines may reach the log, the error's name kept.
  await reboot({ ...savedConfig, entries: [{ id: 'e_boom', label: 'BoomForge' }] }, faultsOn({ FORTUNA_THROW_ON: 'REVEALED "BoomForge"', FORTUNA_THROW_MESSAGE: `injected fault${FORGED}\n    at forged\u001b[2J` }));
  const atForge = mark();
  const atForgeLog = sidecarOut.length;
  await drawSpin();
  await noted(atForge, 'reveal failed: injected fault');
  const forgeLogged = () => /\(Error\)\n\s+at /.test(sidecarOut.slice(atForgeLog));
  for (let i = 0; i < 15 && !forgeLogged(); i++) await sleep(100);
  const forgeLog = sidecarOut.slice(atForgeLog);
  const forgeBadLines = forgeLog.split('\n').filter((l) => l && !/^(\[|\s+at )/.test(l));
  check('sidecar: viewer text in an error\'s message can\'t start a log line', forgeLogged() && !/^\[2026-01-01/m.test(forgeLog) && forgeBadLines.length === 0
    && !/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(forgeLog), JSON.stringify(forgeLog.slice(0, 500)));

  // Nothing guards the path where the connection opens, so only the backstop catches this.
  const { status: sOpenFault } = await reboot(savedConfig, faultsOn({ FORTUNA_THROW_ON: 'Connected to Streamer.bot' }), 1500);
  const rAfterOpenFault = await hostile(viewerSays('addEntry After the open'));
  check('sidecar: a throw as the connection opens doesn\'t end the process, and the note says so',
    sOpenFault?.lastError.includes('injected fault') && rAfterOpenFault.alive && rAfterOpenFault.updates.at(-1)?.entries.some((e) => e.label === 'After the open'), JSON.stringify({ sOpenFault, rAfterOpenFault }));

  // The same for a rejected promise nobody holds.
  await reboot(savedConfig, faultsOn({ FORTUNA_REJECT_ON: 'command: addEntry BoomReject' }));
  const atReject = mark();
  const rReject = await hostile(() => cmd('addEntry', 'BoomReject'));
  const sReject = await noted(atReject, 'injected fault');
  check('sidecar: a rejected promise nobody holds doesn\'t end the process, and the note says so', rReject.alive && !!sReject, JSON.stringify({ rReject, sReject }));

  // A closed stderr goes the way of a closed stdout: quietly, with no note for the backstop.
  await reboot(savedConfig, faultsOn({ FORTUNA_STDERR_ON: 'command: addEntry BoomStderr' }));
  const pipedErr = sidecarProc;
  pipedErr.stderr.destroy();
  const atStderr = mark();
  for (let i = 0; i < 3; i++) { await hostile(() => cmd('addEntry', 'BoomStderr')); await sleep(100); }
  check('sidecar: a closed stderr doesn\'t end the process or raise a note', pipedErr.exitCode === null && sidecarProc === pipedErr
    && !client.events.slice(atStderr).some((d) => isStatus(d) && parseStatus(d).lastError.includes('failed:')), `exit code ${pipedErr.exitCode}`);

  // With no wheel up yet there's nothing to keep running, so a failed startup still ends it.
  const badStart = spawnSync(process.execPath, [resolve(__dirname, 'fortuna-sidecar.mjs')], {
    env: { ...process.env, SB_WS_URL: WS_URL, FORTUNA_CONFIG: cfgPath, FORTUNA_GUARD_PORT: '70000' }, encoding: 'utf-8', timeout: 5000,
  });
  check('sidecar: a failed startup still ends the process with an error', badStart.status === 1, `exit code ${badStart.status}`);

  client.ws.close();
  await rm(cfgPath, { force: true });
}

// ── 5. The real C# action ─────────────────────────────────────────────────────

// Hand-written call shapes. want = the one command relayed; null = nothing relayed.
// ignored = dropped on purpose, so Execute still returns true. Any other null row
// found no command, and returns false.
const REDEEM = { redemptionId: 'rd-1', rewardId: 'rw-1', rewardName: 'Spin the wheel', user: 'redeemer', userId: 'u200' };
const ACTION_ROWS = [
  { name: 'control page command', args: { command: 'status', value: '', fortunaCommand: 'status', fortunaValue: '' }, want: { command: 'status' } },
  { name: 'older sidecar still relays', args: { command: '__status', value: '{}' }, want: { command: '__status', value: '{}' } },
  { name: 'Set Argument can\'t rewrite the status relay', args: { command: 'spin', value: 'x', fortunaCommand: '__status', fortunaValue: '{"a":1}' }, want: { command: '__status', value: '{"a":1}' } },
  { name: 'reserved command ignores a fixed value', args: { fortunaCommand: 'status', value: 'x' }, want: { command: 'status' } },
  { name: 'chat !entry relays the viewer', args: { command: '!entry', commandId: 'c1', rawInput: 'hi', user: 'chatter', userId: 'u1' }, want: { command: 'entry', user: 'chatter', userId: 'u1' } },
  { name: 'chat !wheel splits command and value', args: { command: '!wheel', commandId: 'c2', rawInput: 'addEntry Run it back | bad' }, want: { command: 'addEntry', value: 'Run it back | bad' } },
  { name: 'chat !wheel keeps non-ASCII text', args: { command: '!wheel', commandId: 'c2', rawInput: 'addEntry Привет | good' }, want: { command: 'addEntry', value: 'Привет | good' } },
  { name: 'chat !wheel spin keeps its options', args: { command: '!wheel', commandId: 'c2', rawInput: 'spin {"removeAfter":true}' }, want: { command: 'spin', value: '{"removeAfter":true}' } },
  { name: 'chat !spin drops viewer text', args: { command: '!spin', commandId: 'c3', rawInput: '{"removeAfter":true}' }, want: { command: 'spin' } },
  { name: 'chat !wheel can\'t forge the status relay', args: { __source: 'CommandTriggered', command: '!wheel', commandId: '11111111-2222-3333-4444-555555555555', rawInput: '__status {"entryCount":"<img src=x onerror=alert(1)>"}', user: 'chatter', userId: 'u1' }, want: null, ignored: true },
  { name: 'chat !wheel can\'t send a bare __status', args: { command: '!wheel', commandId: 'c2', rawInput: '__status' }, want: null, ignored: true },
  { name: 'leading spaces don\'t slip a reserved command past chat', args: { command: '!wheel', commandId: 'c2', rawInput: '   __status {}' }, want: null, ignored: true },
  { name: 'chat !wheel refuses any __ command', args: { command: '!wheel', commandId: 'c2', rawInput: '__other x' }, want: null, ignored: true },
  { name: 'a chat command named __status is refused', args: { command: '!__status', commandId: 'c3' }, want: null, ignored: true },
  { name: 'one leading underscore isn\'t reserved', args: { command: '!wheel', commandId: 'c2', rawInput: '_status x' }, want: { command: '_status', value: 'x' } },
  { name: 'reserved args beat a chat trigger\'s commandId', args: { command: '!wheel', commandId: 'c2', rawInput: 'spin', fortunaCommand: '__status', fortunaValue: '{"a":1}' }, want: { command: '__status', value: '{"a":1}' } },
  { name: 'redeem spins', args: { ...REDEEM, rawInput: '' }, want: { command: 'spin', user: 'redeemer' } },
  { name: 'redeem with no rawInput spins', args: REDEEM, want: { command: 'spin' } },
  { name: 'redeem text never runs as a command', args: { ...REDEEM, rawInput: 'clearEntries' }, want: { command: 'spin' } },
  { name: 'redeem with another status still spins', args: { ...REDEEM, rewardStatus: 'unfulfilled' }, want: { command: 'spin' } },
  { name: 'a separate action\'s command beats the redeem default', args: { ...REDEEM, command: 'entry' }, want: { command: 'entry', user: 'redeemer' } },
  { name: 'approving a redeem doesn\'t spin', args: { ...REDEEM, rewardStatus: ' fulfilled ' }, want: null, ignored: true },
  { name: 'rejecting a redeem doesn\'t spin', args: { ...REDEEM, rewardStatus: 'Canceled' }, want: null, ignored: true },
  { name: 'a Skip Queue redeem marked fulfilled still spins', args: { ...REDEEM, __source: 'TwitchRewardRedemption', rewardStatus: 'fulfilled' }, want: { command: 'spin' } },
  { name: 'Reward Redemption Updated is ignored', args: { ...REDEEM, __source: 'TwitchRewardRedemptionUpdated' }, want: null, ignored: true },
  { name: 'Reward Redemption Updated is ignored with any status', args: { ...REDEEM, __source: 'TwitchRewardRedemptionUpdated', rewardStatus: 'unfulfilled' }, want: null, ignored: true },
  { name: 'a final status is ignored under another source', args: { ...REDEEM, __source: 'SomethingElse', rewardStatus: 'canceled' }, want: null, ignored: true },
  { name: 'a blank command relays nothing', args: { command: '   ' }, want: null },
  { name: 'a blank redemptionId relays nothing', args: { redemptionId: '  ', rawInput: 'spin' }, want: null },
  { name: 'a redeem with a null __source spins', args: { ...REDEEM, __source: null }, want: { command: 'spin' } },
  { name: 'a blank commandId isn\'t a chat trigger', args: { command: 'addEntry', value: 'Thing', commandId: '  ' }, want: { command: 'addEntry', value: 'Thing' } },
  { name: 'every leading ! is stripped from a chat command', args: { command: '!!entry', commandId: 'c1' }, want: { command: 'entry' } },
  { name: 'a blank reserved command falls through', args: { fortunaCommand: '  ', command: 'status' }, want: { command: 'status' } },
  { name: 'a blank user isn\'t relayed', args: { command: 'status', user: ' ', userId: '' }, want: { command: 'status', user: null, userId: null } },
  { name: 'a real Guid commandId reads as a chat trigger', args: { command: '!entry', commandId: '11111111-2222-3333-4444-555555555555', user: 'chatter' }, want: { command: 'entry', user: 'chatter' } },
  { name: 'a real Command Triggered run isn\'t taken for a cooldown', args: { __source: 'CommandTriggered', command: '!entry', commandId: '11111111-2222-3333-4444-555555555555', user: 'chatter' }, want: { command: 'entry', user: 'chatter' } },
  { name: 'Command Cooldown doesn\'t run the command', args: { __source: 'CommandCooldown', command: '!spin', commandId: 'c3', rawInput: '' }, want: null, ignored: true },
  { name: 'a separate action on Reward Redemption Updated keeps its command', args: { ...REDEEM, __source: 'TwitchRewardRedemptionUpdated', command: 'entry' }, want: { command: 'entry', user: 'redeemer' } },
  { name: 'Kick reward text never runs as a command', args: { rawInput: 'clearEntries', 'reward.id': 'k1' }, want: null },
  { name: 'other trigger text never runs as a command', args: { rawInput: 'clearEntries', message: 'clearEntries' }, want: null },
  { name: 'no arguments relays nothing', args: {}, want: null },
];

const rowMatches = (row, relayed) => (row.want === null
  ? relayed.length === 0
  : relayed.length === 1 && relayed[0].type === 'fortuna:command' && relayed[0].command === row.want.command
    && relayed[0].value === (row.want.value ?? '') && (row.want.user === undefined || (relayed[0].user ?? null) === row.want.user)
    && (row.want.userId === undefined || (relayed[0].userId ?? null) === row.want.userId));

// The mock keeps its own copy of the action's mapping, so the same rows must pass
// there too: drift on any row fails. Runs before the sidecar starts, because rows
// include spins. A marker after each row shows when all it relayed has arrived.
async function testMockMapping() {
  const client = await wsClient();
  const doAction = (args) => client.ws.send(JSON.stringify({ request: 'DoAction', id: 'm', action: { name: 'Fortuna Command' }, args }));
  for (const [i, row] of ACTION_ROWS.entries()) {
    const at = client.events.length;
    doAction(row.args);
    doAction({ command: '__row_end', value: String(i) });
    await client.next((d) => d.command === '__row_end' && d.value === String(i));
    const relayed = client.events.slice(at).filter((d) => d.command !== '__row_end');
    check(`mock mapping: ${row.name}`, rowMatches(row, relayed), JSON.stringify(relayed));
  }
  client.ws.close();
}

function testAction() {
  console.log('\n[5] Fortuna Command (real C#, stub CPH)');
  const csc = process.env.WINDIR ? resolve(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : '';
  if (!csc || !existsSync(csc)) {
    skipped += ACTION_ROWS.length + 2; // the rows plus the compile and harness checks
    console.log('  - skipped: the .NET Framework compiler (csc.exe) isn\'t installed');
    return;
  }
  const dir = mkdtempSync(resolve(tmpdir(), 'fortuna-verify-cs-'));
  try {
    const exe = resolve(dir, 'harness.exe');
    const build = spawnSync(csc, ['-nologo', '-r:System.Web.Extensions.dll', `-out:${exe}`,
      resolve(__dirname, 'tools', 'action-harness.cs'), resolve(__dirname, 'actions', 'fortuna-command.cs')], { encoding: 'utf-8', timeout: 60000 });
    check('action: compiles as C# 5', build.status === 0, build.stdout || build.error?.message);
    if (build.status !== 0) return;

    const run = spawnSync(exe, [], { input: JSON.stringify(ACTION_ROWS.map((r) => r.args)), encoding: 'utf-8', timeout: 20000 });
    // Blocked from starting (antivirus, say) is a skip. A timeout means the action hung.
    if (run.error && run.error.code !== 'ETIMEDOUT') {
      skipped += ACTION_ROWS.length + 1; // the rows plus the harness check
      console.log(`  - skipped: couldn't run the compiled harness (${run.error.message})`);
      return;
    }
    let results = null;
    try { results = run.status === 0 ? JSON.parse(run.stdout) : null; } catch { /* reported below */ }
    check('action: harness ran every row', results?.length === ACTION_ROWS.length, run.error?.message || run.stderr || run.stdout);
    if (results?.length !== ACTION_ROWS.length) return;

    ACTION_ROWS.forEach((row, i) => {
      const relayed = results[i].broadcasts.map((b) => JSON.parse(b));
      const wantReturned = row.want !== null || row.ignored === true;
      check(`action: ${row.name}`, rowMatches(row, relayed) && results[i].returned === wantReturned,
        `returned ${results[i].returned}: ${results[i].broadcasts.join(' | ') || '(nothing relayed)'}`);
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* AV can hold the exe briefly */ }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

try {
  await testSpinMath();
  await startMock();
  await testPanelCore();
  await testHttp();
  await testMockMapping();
  await testSidecar();
} catch (err) {
  fail++;
  console.error(`\nFATAL: ${err.stack || err}`);
} finally {
  try { sidecarProc?.kill(); } catch {}
  try { mockProc?.kill(); } catch {}
}

// Runs even if a section above died: it needs neither the mock nor the sidecar.
try {
  testAction();
} catch (err) {
  fail++;
  console.error(`\nFATAL: ${err.stack || err}`);
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail === 0 ? 0 : 1);
