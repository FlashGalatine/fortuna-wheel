// Fortuna sidecar — the one Node process. Owns the wheel: the entry list, the
// viewer-entry window, and — critically — the spin decision. The winner and the
// spin parameters are picked HERE, once, and broadcast; every overlay and the
// control page derive the identical animation from them, so all surfaces agree.
//
//   outbound  on every state change → DoAction "Fortuna Push" with the
//             pre-serialized `fortunaPayload` (docs/PROTOCOL.md); the C# action
//             persists it to the `fortuna.payload` global and broadcasts it.
//             After every command → a fortuna:status snapshot for the control
//             page. Status is ephemeral and must not clobber the persisted
//             update payload, so it rides the "Fortuna Command" relay as the
//             reserved command "__status" (value = status JSON); the control
//             page unwraps it and the sidecar ignores its own echo. No third SB
//             action needed.
//   inbound   subscribes to General.Custom and consumes
//             { type:'fortuna:command', command, value, user?, userId? }
//             broadcasts emitted by the control page, chat triggers and reward
//             redemptions via the "Fortuna Command" action.
//
// Commands: addEntry, removeEntry, setTag, clearEntries, setEntries,
//           openEntries, closeEntries, entry, spin, removeDrawn, setSettings,
//           status. (docs/PROTOCOL.md has the full table.)
//
// State lives in ./config.json (gitignored; seeded from config.example.json on
// first run) — a restart restores the entries and the last revealed spin.
//
// Run:  start-fortuna.bat  ·  npm run sidecar
// Env:  SB_WS_URL (default ws://127.0.0.1:8080/) · FORTUNA_GUARD_PORT (7493)
//       FORTUNA_CONFIG (config file path override)

import { readFile, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FORTUNA_CONFIG || resolve(__dirname, 'config.json');
const EXAMPLE_PATH = resolve(__dirname, 'config.example.json');
const SB_WS_URL = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
// Single-instance guard: a second launch (double-click + SB action) exits
// cleanly instead of double-spinning. Greenroom holds 7495, Zipper 7496;
// Fortuna takes 7493.
const GUARD_PORT = Number(process.env.FORTUNA_GUARD_PORT) || 7493;

const MAX_ENTRIES = 200;
const LABEL_MAX_CHARS = 80;
const TAGS = ['good', 'bad', 'neutral'];
const REVEAL_GRACE_MS = 300; // reveal broadcast lands after every client's animation finished

let config = {
  entries: [], // { id, label, tag, source: 'streamer'|'chat', user? , userId? }
  entryMode: { open: false, maxEntries: 25, windowSec: 0, openedAt: null },
  settings: { removeOnDraw: false, defaultChatTag: 'good' },
  lastSpin: null, // the last spin block, persisted at state:"revealed"
  revision: 0,
};

let activeSpin = null; // in-flight spin block (state:"spinning") + its timers
let revealTimer = null;
let windowTimer = null;
let entriesReady = false; // viewer drawing filled up / timed out — control page highlights Spin
let lastError = '';

let sbWs = null;
let sbReconnectTimer = null;
let sbMsgId = 0;

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
  let raw = null;
  try {
    raw = await readFile(CONFIG_PATH, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') log(`Could not read config: ${err.message}`);
  }
  if (raw == null) {
    try {
      raw = await readFile(EXAMPLE_PATH, 'utf-8');
      await writeFile(CONFIG_PATH, raw, 'utf-8');
      log('Seeded config.json from config.example.json');
    } catch {
      log('No config.example.json — using built-in defaults');
      return;
    }
  }
  try { adoptConfig(JSON.parse(raw)); } catch (err) { log(`Bad config JSON: ${err.message}`); }
}

function adoptConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  config = {
    entries: (Array.isArray(parsed.entries) ? parsed.entries : [])
      .map(normalizeEntry)
      .filter(Boolean)
      .slice(0, MAX_ENTRIES),
    entryMode: {
      // The entry window never survives a restart open — its timer died with the
      // old process, and silently collecting entries forever would be worse.
      open: false,
      maxEntries: clampInt(parsed.entryMode?.maxEntries, 1, MAX_ENTRIES, 25),
      windowSec: clampInt(parsed.entryMode?.windowSec, 0, 3600, 0),
      openedAt: null,
    },
    settings: {
      removeOnDraw: !!parsed.settings?.removeOnDraw,
      defaultChatTag: TAGS.includes(parsed.settings?.defaultChatTag) ? parsed.settings.defaultChatTag : 'good',
    },
    lastSpin: normalizeSpin(parsed.lastSpin),
    revision: clampInt(parsed.revision, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const label = (textOf(e.label) ?? '').trim().slice(0, LABEL_MAX_CHARS);
  if (!label) return null;
  const out = {
    id: typeof e.id === 'string' && e.id ? e.id : newId('e'),
    label,
    tag: TAGS.includes(e.tag) ? e.tag : 'neutral',
    source: e.source === 'chat' ? 'chat' : 'streamer',
  };
  const user = textOf(e.user);
  const userId = textOf(e.userId);
  if (user != null) out.user = user.slice(0, 60);
  if (userId != null) out.userId = userId.slice(0, 60);
  return out;
}

// Only a completed spin is worth restoring; a half-finished one is meaningless
// after a restart (its reveal timer is gone).
function normalizeSpin(s) {
  if (!s || typeof s !== 'object' || s.state !== 'revealed' || !s.selectedEntry) return null;
  return s;
}

async function persist() {
  try { await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8'); }
  catch (err) { log(`Could not persist config: ${err.message}`); }
}

// Chat can send any JSON through "!wheel <command> <JSON>", and String() and Number()
// throw on an object like {"toString":1} or an array holding one. So only a primitive
// converts, and anything else reads as absent.
function textOf(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
}

function clampInt(v, min, max, fallback) {
  if (typeof v === 'object') return fallback; // Number() can throw (see textOf) and reads null as 0
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseJson(v) {
  try { return JSON.parse(String(v ?? '')); } catch { return null; }
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomInt(1679616).toString(36).padStart(4, '0')}`;
}

// ── Payload / broadcast ───────────────────────────────────────────────────────

function buildPayload() {
  const em = config.entryMode;
  const closesAt = em.open && em.windowSec > 0 && em.openedAt
    ? new Date(Date.parse(em.openedAt) + em.windowSec * 1000).toISOString()
    : null;
  return {
    type: 'fortuna:update',
    revision: config.revision,
    generatedAt: new Date().toISOString(),
    entries: config.entries,
    entryMode: { open: em.open, maxEntries: em.maxEntries, windowSec: em.windowSec, closesAt },
    settings: { ...config.settings },
    spin: activeSpin || config.lastSpin,
  };
}

// fortuna:update rides the "Fortuna Push" action so the C# side persists it for
// the sync-on-connect replay.
function pushUpdate() {
  doAction('Fortuna Push', { fortunaPayload: JSON.stringify(buildPayload()) });
}

// fortuna:status is ephemeral (never persisted) — it rides the "Fortuna Command"
// relay with the reserved command "__status"; the C# action broadcasts
// { type:'fortuna:command', command:'__status', value:'<status JSON>' } and the
// control page unwraps it. dispatch() below ignores it (echo guard).
function pushStatus() {
  const em = config.entryMode;
  const status = {
    type: 'fortuna:status',
    connected: true,
    entryCount: config.entries.length,
    chatEntryCount: config.entries.filter((e) => e.source === 'chat').length,
    entryMode: {
      open: em.open,
      maxEntries: em.maxEntries,
      windowSec: em.windowSec,
      secondsLeft: em.open && em.windowSec > 0 && em.openedAt
        ? Math.max(0, Math.round((Date.parse(em.openedAt) + em.windowSec * 1000 - Date.now()) / 1000))
        : null,
    },
    ready: entriesReady,
    spinning: !!activeSpin,
    lastSpin: config.lastSpin ? { label: config.lastSpin.selectedEntry.label, tag: config.lastSpin.selectedEntry.tag } : null,
    settings: { ...config.settings },
    lastError,
  };
  // The reserved pair wins in the C# action, so a Set Argument for `command` inside
  // it can't turn this into a spin. `command`/`value` keep older actions working, at
  // the cost of sending the JSON twice: drop them once those actions are unsupported.
  const json = JSON.stringify(status);
  doAction('Fortuna Command', { command: '__status', value: json, fortunaCommand: '__status', fortunaValue: json });
}

function applyChange() {
  config.revision++;
  persist();
  pushUpdate();
  pushStatus();
}

function fail(msg) {
  lastError = msg;
  log(msg);
  pushStatus();
}

// ── Entry management ──────────────────────────────────────────────────────────

function addEntry({ label, tag, source, user, userId }) {
  const entry = normalizeEntry({ label, tag, source, user, userId });
  if (!entry) { fail('addEntry: empty label'); return null; }
  if (config.entries.length >= MAX_ENTRIES) { fail(`addEntry: wheel is full (${MAX_ENTRIES})`); return null; }
  config.entries.push(entry);
  return entry;
}

function findEntry(idOrLabel) {
  const key = (textOf(idOrLabel) ?? '').trim();
  if (!key) return null;
  return config.entries.find((e) => e.id === key)
    || config.entries.find((e) => e.label.toLowerCase() === key.toLowerCase())
    || null;
}

// Viewer "!entry" — dedupe by userId (fallback: lowercase display name).
function chatEntry(user, userId) {
  if (!config.entryMode.open) return; // silently ignore when entries are closed
  const name = String(user ?? '').trim();
  if (!name) return;
  const dupe = config.entries.some((e) => e.source === 'chat' && (
    (userId && e.userId === userId) || (!userId && e.user && e.user.toLowerCase() === name.toLowerCase())
  ));
  if (dupe) return;
  const chatCount = config.entries.filter((e) => e.source === 'chat').length;
  if (chatCount >= config.entryMode.maxEntries) { closeEntryWindow('full'); return; }
  const entry = addEntry({ label: name, tag: config.settings.defaultChatTag, source: 'chat', user: name, userId });
  if (!entry) return;
  log(`chat entry: ${name} (${config.entries.filter((e) => e.source === 'chat').length}/${config.entryMode.maxEntries})`);
  if (config.entries.filter((e) => e.source === 'chat').length >= config.entryMode.maxEntries) {
    closeEntryWindow('full');
  } else {
    applyChange();
  }
}

function openEntryWindow(opts) {
  config.entryMode.open = true;
  config.entryMode.openedAt = new Date().toISOString();
  if (opts && typeof opts === 'object') {
    if (opts.maxEntries !== undefined) config.entryMode.maxEntries = clampInt(opts.maxEntries, 1, MAX_ENTRIES, config.entryMode.maxEntries);
    if (opts.windowSec !== undefined) config.entryMode.windowSec = clampInt(opts.windowSec, 0, 3600, config.entryMode.windowSec);
  }
  entriesReady = false;
  if (windowTimer) { clearTimeout(windowTimer); windowTimer = null; }
  if (config.entryMode.windowSec > 0) {
    windowTimer = setTimeout(() => { windowTimer = null; closeEntryWindow('time'); }, config.entryMode.windowSec * 1000);
  }
  log(`entries OPEN (max ${config.entryMode.maxEntries}${config.entryMode.windowSec ? `, ${config.entryMode.windowSec}s window` : ''})`);
  applyChange();
}

function closeEntryWindow(reason) {
  if (windowTimer) { clearTimeout(windowTimer); windowTimer = null; }
  const wasOpen = config.entryMode.open;
  config.entryMode.open = false;
  config.entryMode.openedAt = null;
  // READY: the drawing filled up or timed out (or was closed manually with
  // entries collected) — the control page lights the Spin button.
  if (wasOpen && config.entries.length > 0) entriesReady = true;
  log(`entries CLOSED (${reason}) — ${config.entries.length} on the wheel${entriesReady ? ', READY' : ''}`);
  applyChange();
}

// ── Spin engine ───────────────────────────────────────────────────────────────

function spin(opts) {
  if (activeSpin) { fail('spin: already spinning'); return; }
  if (config.entries.length < 1) { fail('spin: the wheel is empty'); return; }
  if (config.entryMode.open) closeEntryWindow('spin'); // no late entries mid-spin

  const n = config.entries.length;
  const selectedIndex = randomInt(n);
  const seed = randomInt(2 ** 31);
  const removeAfter = !!(opts && opts.removeAfter) || config.settings.removeOnDraw;

  activeSpin = {
    spinId: newId('s'),
    entryCount: n, // segment count frozen at spin time — removeOnDraw mutates the list after
    selectedIndex,
    selectedEntry: { ...config.entries[selectedIndex] },
    seed,
    startedAt: new Date().toISOString(),
    // FORTUNA_SPIN_MS overrides the seed-derived duration — the verify suite
    // can't wait 5-8s per spin.
    durationMs: Number(process.env.FORTUNA_SPIN_MS) > 0
      ? Number(process.env.FORTUNA_SPIN_MS)
      : 5000 + ((seed >> 8) % 3000),
    extraSpins: 4 + (seed % 4),
    state: 'spinning',
  };
  entriesReady = false;
  lastError = '';
  log(`SPIN → [${selectedIndex}] "${activeSpin.selectedEntry.label}" (${activeSpin.selectedEntry.tag}), ${activeSpin.durationMs}ms, ${activeSpin.extraSpins} turns${removeAfter ? ', remove after' : ''}`);
  applyChange();

  revealTimer = setTimeout(() => {
    revealTimer = null;
    reveal(removeAfter);
  }, activeSpin.durationMs + REVEAL_GRACE_MS);
}

function reveal(removeAfter) {
  if (!activeSpin) return;
  config.lastSpin = { ...activeSpin, state: 'revealed' };
  activeSpin = null;
  if (removeAfter) removeEntryById(config.lastSpin.selectedEntry.id);
  log(`REVEALED "${config.lastSpin.selectedEntry.label}"${removeAfter ? ' (removed from wheel)' : ''}`);
  applyChange();
}

function removeEntryById(id) {
  const i = config.entries.findIndex((e) => e.id === id);
  if (i >= 0) config.entries.splice(i, 1);
  return i >= 0;
}

// ── Command dispatch (inbound half of the bus) ────────────────────────────────

function dispatch(command, value, user, userId) {
  if (command === '__status') return; // our own status relay echoing back
  log(`command: ${command}${value ? ' ' + value.slice(0, 120) : ''}${user ? ` (from ${user})` : ''}`);
  switch (command) {
    case 'addEntry': {
      // JSON {label, tag} from the control page, or plain chat text
      // ("!wheel add Run it back | bad" — an optional trailing "| tag").
      const o = parseJson(value);
      let label, tag;
      if (o && typeof o === 'object') { label = o.label; tag = o.tag; }
      else {
        const parts = String(value ?? '').split('|');
        if (parts.length > 1 && TAGS.includes(parts[parts.length - 1].trim().toLowerCase())) {
          tag = parts.pop().trim().toLowerCase();
        }
        label = parts.join('|');
      }
      if (addEntry({ label, tag, source: 'streamer' })) applyChange();
      return;
    }
    case 'removeEntry': {
      const entry = findEntry(value);
      if (!entry) { fail(`removeEntry: no entry "${String(value).slice(0, 40)}"`); return; }
      removeEntryById(entry.id);
      applyChange();
      return;
    }
    case 'setTag': {
      const o = parseJson(value);
      const entry = o && findEntry(o.id ?? o.label);
      if (!entry || !TAGS.includes(o.tag)) { fail('setTag: expected {id, tag} with tag good|bad|neutral'); return; }
      entry.tag = o.tag;
      applyChange();
      return;
    }
    case 'clearEntries': {
      const scope = String(value ?? 'all').trim().toLowerCase() || 'all';
      if (scope === 'all') config.entries = [];
      else if (scope === 'chat' || scope === 'streamer') config.entries = config.entries.filter((e) => e.source !== scope);
      else { fail('clearEntries: expected all|chat|streamer'); return; }
      entriesReady = false;
      applyChange();
      return;
    }
    // Batched full-list replace — the control page sends ONE of these per save so
    // it never fires a burst of DoActions (Streamer.bot bleeds arguments between
    // action invocations that arrive within a few ms).
    case 'setEntries': {
      const arr = parseJson(value);
      if (!Array.isArray(arr)) { fail('setEntries: expected a JSON array'); return; }
      const entries = arr.map(normalizeEntry).filter(Boolean).slice(0, MAX_ENTRIES);
      // [] clears the wheel on purpose. A list with nothing usable in it must not.
      if (arr.length && !entries.length) { fail('setEntries: no usable entries'); return; }
      config.entries = entries;
      applyChange();
      return;
    }
    case 'openEntries': openEntryWindow(parseJson(value)); return;
    case 'closeEntries': closeEntryWindow('manual'); return;
    case 'entry': chatEntry(user, userId); return;
    case 'spin': spin(parseJson(value)); return;
    case 'removeDrawn': {
      if (!config.lastSpin) { fail('removeDrawn: nothing has been drawn'); return; }
      if (!removeEntryById(config.lastSpin.selectedEntry.id)) { fail('removeDrawn: drawn entry is already gone'); return; }
      applyChange();
      return;
    }
    case 'setSettings': {
      const o = parseJson(value);
      if (o && typeof o === 'object') {
        if (o.removeOnDraw !== undefined) config.settings.removeOnDraw = o.removeOnDraw === true || o.removeOnDraw === 'true';
        if (o.defaultChatTag !== undefined && TAGS.includes(o.defaultChatTag)) config.settings.defaultChatTag = o.defaultChatTag;
      }
      persist();
      pushStatus();
      return;
    }
    case 'status': pushStatus(); return;
    default:
      log(`unknown command "${command}" — ignored`);
  }
}

// ── Streamer.bot WS client ────────────────────────────────────────────────────

function connectSb() {
  if (sbWs && sbWs.readyState === WebSocket.OPEN) return;
  try {
    sbWs = new WebSocket(SB_WS_URL);
    sbWs.on('open', () => {
      if (sbReconnectTimer) { clearTimeout(sbReconnectTimer); sbReconnectTimer = null; }
      // Lowercase `general` — the SB Subscribe case gotcha (delivered events carry
      // capitalized 'General'; a capitalized Subscribe silently receives nothing).
      sbWs.send(JSON.stringify({ request: 'Subscribe', id: String(++sbMsgId), events: { general: ['Custom'] } }));
      log(`Connected to Streamer.bot at ${SB_WS_URL}`);
      // Re-seed the persisted SB global so a restarted SB (or first install)
      // replays real state, and the control page hears we're alive.
      pushUpdate();
      pushStatus();
    });
    sbWs.on('close', () => { sbWs = null; scheduleSbReconnect(); });
    sbWs.on('error', (e) => { log(`SB WS error: ${e.message} — is SB's WebSocket Server on ${SB_WS_URL} with auth OFF?`); });
    sbWs.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m && m.id && !m.event) return; // request acks
      if (!(m && m.event && m.event.source === 'General' && m.event.type === 'Custom')) return;
      let d = m.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
      // Echo-loop guard: this client also hears its own fortuna:update /
      // fortuna:status broadcasts. Consume ONLY the command channel.
      if (!d || typeof d !== 'object' || d.type !== 'fortuna:command') return;
      // The backstop: a throw while handling a command is logged and dropped, though it may
      // leave that command half applied. The timers a command arms (a spin's reveal, an entry
      // window's close) run outside it, so a throw there still ends the process, though no
      // known input causes one. The note carries the error because a hidden launch has no
      // log to read. The String() calls belong inside it. The action only relays strings, so
      // a field that throws here marks a bad relay, and running it with that field blank could
      // do harm: clearEntries reads a blank value as "all". A field that doesn't throw, like
      // {} or [], still converts and runs, as it always has.
      try {
        dispatch(String(d.command ?? ''), String(d.value ?? ''), d.user == null ? '' : String(d.user), d.userId == null ? '' : String(d.userId));
      } catch (err) {
        lastError = `a command failed: ${err?.message ?? err}`;
        log(`${lastError}\n${err?.stack ?? err}`);
        try { pushStatus(); } catch { /* the log line is the record */ }
      }
    });
  } catch {
    scheduleSbReconnect();
  }
}

function scheduleSbReconnect() {
  if (sbReconnectTimer) return;
  sbReconnectTimer = setTimeout(() => { sbReconnectTimer = null; connectSb(); }, 3000);
}

function doAction(name, args) {
  if (!sbWs || sbWs.readyState !== WebSocket.OPEN) return false;
  try {
    sbWs.send(JSON.stringify({ request: 'DoAction', id: String(++sbMsgId), action: { name }, args }));
    return true;
  } catch { return false; }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] [fortuna] ${msg}`);
}

function acquireGuard() {
  return new Promise((res) => {
    const guard = createServer();
    guard.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log(`Another Fortuna sidecar is already running (guard port :${GUARD_PORT}) — exiting.`);
        process.exit(0);
      }
      log(`guard port error: ${err.message} — continuing without the single-instance guard`);
      res();
    });
    guard.listen(GUARD_PORT, '127.0.0.1', () => res());
  });
}

async function main() {
  log(`Fortuna sidecar starting (config: ${CONFIG_PATH})`);
  await acquireGuard();
  await loadConfig();
  connectSb();
  const shutdown = () => {
    log('shutting down');
    if (revealTimer) clearTimeout(revealTimer);
    if (windowTimer) clearTimeout(windowTimer);
    try { sbWs?.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
