// Fortuna sidecar — the one Node process. Owns the wheel: the entry list, the
// viewer-entry window, and — critically — the spin decision. The winner and the
// spin parameters are picked HERE, once, and broadcast; every overlay derives the
// identical animation from them, so all OBS sources agree.
//
//   outbound  on every state change → DoAction "Fortuna Push" with the
//             pre-serialized `fortunaPayload` (docs/PROTOCOL.md); the C# action
//             persists it to the `fortuna.payload` global and broadcasts it.
//             After a state change or a failed command → a fortuna:status
//             snapshot for the control page. An unknown command and an ignored
//             "entry" send none. Status is ephemeral and must not clobber the
//             persisted update payload, so it rides the "Fortuna Command" relay
//             as the reserved command "__status" (value = status JSON); the
//             control page unwraps it and the sidecar ignores its own echo. No
//             third SB action needed.
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
// first run) — a restart restores the entries and the last revealed spin. Saves
// go through config.json.tmp one at a time, so stopping the process at any moment
// leaves the last whole save.
//
// Run:  start-fortuna.bat  ·  npm run sidecar
// Env:  SB_WS_URL (default ws://127.0.0.1:8080/) · FORTUNA_GUARD_PORT (7493)
//       FORTUNA_CONFIG (config file path override)

import { constants } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.FORTUNA_CONFIG || resolve(__dirname, 'config.json');
const TEMP_PATH = `${CONFIG_PATH}.tmp`;
const BAD_PATH = `${CONFIG_PATH}.bad`;
const EXAMPLE_PATH = resolve(__dirname, 'config.example.json');
const SB_WS_URL = process.env.SB_WS_URL || `ws://127.0.0.1:${process.env.SB_WS_PORT || 8080}/`;
// Single-instance guard: a second launch (double-click + SB action) exits
// cleanly instead of double-spinning. Greenroom holds 7495, Zipper 7496;
// Fortuna takes 7493.
const GUARD_PORT = Number(process.env.FORTUNA_GUARD_PORT) || 7493;

const MAX_ENTRIES = 200;
const LABEL_MAX_CHARS = 80;
const TAGS = ['good', 'bad', 'neutral'];
// What newId('e') makes. A saved id has to look like this to be kept: findEntry trims its
// key, so a blank or padded id could never match, and it tries ids first, so an id like
// "Alpha" would catch removal by another entry's label.
const ENTRY_ID = /^e_[\w-]{1,40}$/;
const REVEAL_GRACE_MS = 300; // reveal broadcast lands after every client's animation finished
const FILE_RETRY_MIN_MS = 50;
const FILE_RETRY_MAX_MS = 5000;
const FILE_RETRY_WARN_MS = 1000; // a wait this long is more than a scanner passing by, so say so
const SHUTDOWN_SAVE_WAIT_MS = 2000;

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
let entriesReady = false; // viewer drawing closed with entries on the wheel — control page highlights Spin
let lastError = ''; // the latest failure, kept until an operator command comes in (dispatch)
let lastErrorAt = null;
let lastErrorThrew = false; // a thrown error may be the only record of it, so a refusal can't replace it

let saveDirty = false; // the config changed since the last save started
let saveLoop = null; // the running save loop, if any; there is only ever one
let saveNote = ''; // what the control page also shows while saves keep failing
let loadNote = ''; // what it also shows about how config.json loaded; only a restart ends this one
let savesHeld = false; // config.json couldn't be read or copied, so nothing may replace it this run
let tempText = null; // what config.json.tmp holds after a refused rename, so a retry can reuse it

let sbWs = null;
let sbReconnectTimer = null;
let sbMsgId = 0;

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
  // A temp file here is a save that a stopped process never finished. It never became the
  // config, so it's only in the way.
  await rm(TEMP_PATH, { force: true }).catch(() => {});
  let raw;
  try {
    raw = await readConfigFile();
  } catch (err) {
    log(`Could not read config: ${err.message}`);
    holdSaves(`could not read config.json (${err.code ?? 'error'}), so the wheel started empty and nothing will be saved over it. Fix the file and restart the sidecar.`);
    return;
  }
  const seeding = raw == null; // the example holds no wheel of the streamer's to protect
  if (seeding) {
    try {
      raw = await readFile(EXAMPLE_PATH, 'utf-8');
    } catch {
      log('No config.example.json — using built-in defaults');
      return;
    }
    try {
      await writeConfigFile(raw);
      log('Seeded config.json from config.example.json');
    } catch (err) {
      log(`Could not seed config.json from config.example.json: ${err.message}`);
    }
  }
  try {
    // An editor's byte order mark is harmless, but JSON.parse refuses it.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    // Valid JSON that isn't a wheel would read as an empty one, and the next save would replace it.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.entries !== undefined && !Array.isArray(parsed.entries))) {
      throw new Error('not a config object with a list of entries');
    }
    // [] is an empty wheel on purpose. A list with nothing usable in it isn't, as in setEntries.
    if (!seeding && parsed.entries?.length && !parsed.entries.some(normalizeEntry)) {
      throw new Error('an entries list with nothing usable in it');
    }
    adoptConfig(parsed);
    // A settings-only file is allowed, but a misspelled key reads the same.
    if (!seeding && parsed.entries === undefined) await keepConfigCopy('no entries list was found in config.json');
  } catch (err) {
    log(`Bad config JSON: ${err.message}`);
    await keepConfigCopy('config.json was damaged');
  }
}

// The next save replaces this file, and it may be the only copy of the streamer's wheel.
async function keepConfigCopy(problem) {
  try {
    const copyPath = await copyConfigAside();
    addLoadNote(`${problem}, so the wheel started empty. A copy is kept as ${basename(copyPath)}.`);
  } catch (copyErr) {
    log(`Could not copy config: ${copyErr.message}`);
    holdSaves(`${problem} and no copy could be made (${copyErr.code ?? 'error'}), so the wheel started empty and nothing will be saved over it. Fix the file and restart the sidecar.`);
  }
}

// Null only when the file isn't there. Any other failure means the wheel may still be in it, so
// starting blank or seeding would overwrite it with the next save.
async function readConfigFile() {
  try {
    return await waitWhileBusy(() => readFile(CONFIG_PATH, 'utf-8'), 'Could not read config');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The first free name, so a copy that may hold the only good wheel never gets replaced.
async function copyConfigAside() {
  for (let n = 0; ; n++) {
    const copyPath = n ? `${BAD_PATH}.${n}` : BAD_PATH;
    try {
      await waitWhileBusy(() => copyFile(CONFIG_PATH, copyPath, constants.COPYFILE_EXCL), 'Could not copy config');
      return copyPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

// EBUSY is what a Windows sharing violation maps to: another program has the file for now, so
// wait for it. Any other error won't pass by itself, so it goes back to the caller.
async function waitWhileBusy(attempt, what) {
  for (let retryMs = FILE_RETRY_MIN_MS; ; retryMs = Math.min(retryMs * 2, FILE_RETRY_MAX_MS)) {
    try {
      return await attempt();
    } catch (err) {
      if (err.code !== 'EBUSY') throw err;
      if (retryMs >= FILE_RETRY_WARN_MS) log(`${what}, waiting for it: ${err.message}`);
      await sleep(retryMs);
    }
  }
}

// For the rest of this run, the file on disk may be the only copy of the wheel.
function holdSaves(note) {
  savesHeld = true;
  addLoadNote(note);
}

// A file can have more than one thing wrong with it: a bad saved draw is noted while the config
// is adopted, and a missing entries list after that. Each note may be the only word of it.
function addLoadNote(note) {
  loadNote = loadNote ? `${loadNote} · ${note}` : note;
  log(note);
}

function adoptConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const rows = (Array.isArray(parsed.entries) ? parsed.entries : [])
    .map((raw) => ({ savedId: raw?.id, entry: normalizeEntry(raw) }))
    .filter((row) => row.entry)
    .slice(0, MAX_ENTRIES);
  const entries = uniqueIds(rows.map((row) => row.entry));
  const lastSpin = normalizeSpin(parsed.lastSpin);
  if (lastSpin) pointWinnerAtRow(lastSpin, parsed.lastSpin.selectedEntry.id, rows);
  config = {
    entries,
    entryMode: {
      // The entry window never survives a restart open — its timer died with the
      // old process, and silently collecting entries forever would be worse.
      open: false,
      maxEntries: clampInt(parsed.entryMode?.maxEntries, 1, MAX_ENTRIES, 25),
      windowSec: clampInt(parsed.entryMode?.windowSec, 0, 3600, 0),
      openedAt: null,
    },
    settings: {
      removeOnDraw: parsed.settings?.removeOnDraw === true || parsed.settings?.removeOnDraw === 'true',
      defaultChatTag: TAGS.includes(parsed.settings?.defaultChatTag) ? parsed.settings.defaultChatTag : 'good',
    },
    lastSpin,
    revision: clampInt(parsed.revision, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

// normalizeEntry and uniqueIds can give a saved row a new id, and the saved winner has to
// follow it or removeDrawn takes the wrong row or none. A row matches on the id and label
// both were saved with, and selectedIndex settles a tie. A winner with no match can't hold a
// row's id, or removeDrawn takes that row, so it gets a new one and removeDrawn refuses. A row
// renamed by hand refuses too, which is the safe way to fail.
function pointWinnerAtRow(spin, savedId, rows) {
  const matches = rows.filter((row) => row.savedId === savedId && row.entry.label === spin.selectedEntry.label);
  const row = matches.find((match) => match === rows[spin.selectedIndex]) ?? matches[0];
  if (row) { spin.selectedEntry.id = row.entry.id; return; }
  while (rows.some((other) => other.entry.id === spin.selectedEntry.id)) spin.selectedEntry.id = newId('e');
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const label = (textOf(e.label) ?? '').trim().slice(0, LABEL_MAX_CHARS);
  if (!label) return null;
  const out = {
    id: typeof e.id === 'string' && ENTRY_ID.test(e.id) ? e.id : newId('e'),
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

// Removal goes by id, so a list needs each id once: the first holder keeps it. A list of
// generated ids needs this too. Rows normalized in the same millisecond differ only by
// newId's random part, which a 200-row list repeats about 1 time in 85.
function uniqueIds(entries) {
  const seen = new Set();
  for (const e of entries) {
    while (seen.has(e.id)) e.id = newId('e');
    seen.add(e.id);
  }
  return entries;
}

// Only a completed spin is worth restoring; a half-finished one is meaningless
// after a restart (its reveal timer is gone). It gets replayed to every overlay, whose
// arithmetic on these fields throws on an object, so one bad field drops the whole block.
// A save only ever writes null or a revealed spin, so null or no block means no draw yet, and
// anything else is a hand edit. The next save overwrites it, so the log and the note say which
// field, or lastSpin for a block that isn't one. A field this doesn't check goes back out as
// it came.
function normalizeSpin(s) {
  if (s == null) return null;
  const selectedEntry = normalizeEntry(s.selectedEntry);
  const { state, spinId, entryCount, selectedIndex, seed, startedAt, durationMs, extraSpins } = s;
  const bad = typeof s !== 'object' || Array.isArray(s) ? 'lastSpin'
    : state !== 'revealed' ? 'state'
    : !spinId || typeof spinId !== 'string' ? 'spinId'
    : !(Number.isInteger(entryCount) && entryCount >= 1 && entryCount <= MAX_ENTRIES) ? 'entryCount'
    : !(Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < entryCount) ? 'selectedIndex'
    : !selectedEntry ? 'selectedEntry'
    : !Number.isFinite(seed) ? 'seed'
    : typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt)) ? 'startedAt'
    : !(Number.isFinite(durationMs) && durationMs > 0) ? 'durationMs'
    : !Number.isFinite(extraSpins) ? 'extraSpins'
    : null;
  if (!bad) return { ...s, selectedEntry };
  addLoadNote(`config.json: the saved last draw has a bad ${bad}, so it was dropped`);
  return null;
}

// One save runs at a time. A change during a save only marks the config dirty, and the loop then
// writes the newest state once, so a burst of commands can't overlap its writes or queue them up.
// A failed save stays dirty and retries by itself, because its change may be the last for a while:
// Windows refuses the rename while anything has config.json open, even a scanner only reading it.
function persist() {
  if (savesHeld) return;
  saveDirty = true;
  saveLoop ??= runSaves();
}

async function runSaves() {
  let retryMs = FILE_RETRY_MIN_MS;
  while (saveDirty) {
    saveDirty = false;
    try {
      await writeConfigFile(JSON.stringify(config, null, 2));
      retryMs = FILE_RETRY_MIN_MS;
      if (saveNote) {
        log('config.json is saving again');
        saveNote = '';
        pushStatus();
      }
    } catch (err) {
      saveDirty = true;
      if (retryMs >= FILE_RETRY_WARN_MS && !saveNote) {
        saveNote = `could not save config.json (${err.code ?? 'error'}), still trying: is another program holding it?`;
        log(`Could not persist config, still trying: ${err.message}`);
        try { pushStatus(); } catch { /* the log line is the record */ }
      }
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, FILE_RETRY_MAX_MS);
    }
  }
  saveLoop = null;
}

// config.json only ever goes from one whole save to the next, because the temp file takes the
// truncating and the partial writes. The flush covers a power cut or a PC crash, which could
// otherwise leave the renamed file empty (Node before 20.10 ignores it). A refused rename keeps the
// temp file, so a retry with nothing new only has to rename it again.
async function writeConfigFile(text) {
  if (text !== tempText) {
    tempText = null;
    try {
      await writeFile(TEMP_PATH, text, { encoding: 'utf-8', flush: true });
    } catch (err) {
      await rm(TEMP_PATH, { force: true }).catch(() => {});
      throw err;
    }
    tempText = text;
  }
  try {
    await rename(TEMP_PATH, CONFIG_PATH);
    tempText = null;
  } catch (err) {
    if (err.code === 'ENOENT') tempText = null; // the temp file went away, so the retry rewrites it
    throw err;
  }
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

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
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
    ready: entriesReady && !activeSpin, // a drawing closed mid-spin is ready once the spin is over
    spinning: !!activeSpin,
    lastSpin: config.lastSpin ? { label: config.lastSpin.selectedEntry.label, tag: config.lastSpin.selectedEntry.tag } : null,
    settings: { ...config.settings },
    // The standing notes first and the latest failure last, so a time printed after the text sits next
    // to that failure. A failed command or a spin changes lastError and ends neither standing note.
    lastError: [loadNote, saveNote, lastError].filter(Boolean).join(' · '),
    lastErrorAt,
  };
  // The reserved pair wins in the C# action, so a Set Argument for `command` inside
  // it can't turn this into a spin. `command`/`value` keep older actions working, at
  // the cost of sending the JSON twice: drop them once those actions are unsupported.
  const json = JSON.stringify(status);
  doAction('Fortuna Command', { command: '__status', value: json, fortunaCommand: '__status', fortunaValue: json });
}

// What every new revision brings, for applyChange and for later()'s catch, which can't call it.
// keepReveal: a viewer joining or a drawing closing itself isn't anyone moving on from the
// result, so a reveal on show stays on show.
function raiseRevision(keepReveal = false) {
  if (!config.entries.length) entriesReady = false; // nothing left to spin, however it emptied
  if (keepReveal && config.lastSpin?.revealRevision === config.revision) config.lastSpin.revealRevision = config.revision + 1;
  config.revision++;
  // Only a reveal on show paints its frozen slices. After that they'd just ride along in every update.
  if (config.lastSpin?.segments && config.lastSpin.revealRevision !== config.revision) delete config.lastSpin.segments;
}

function applyChange(keepReveal = false) {
  raiseRevision(keepReveal);
  persist();
  pushUpdate();
  pushStatus();
}

function noteError(msg, threw = false) {
  if (lastErrorThrew && !threw) return; // an operator command clears it first (dispatch)
  lastError = msg;
  lastErrorAt = new Date().toISOString();
  lastErrorThrew = threw;
}

function fail(msg) {
  noteError(msg);
  log(msg);
  pushStatus();
}

// The backstop: a throw is logged and dropped, though it may leave its work half applied.
// The note carries the error because a hidden launch has no log to read.
function noteThrow(what, err) {
  noteError(`${what} failed: ${err?.message ?? err}`, true);
  // Only the stack's frame lines: its first line repeats the message, which can quote a value.
  try {
    log(`${lastError}${err?.name ? ` (${err.name})` : ''}`, String(err?.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line)));
  } catch { /* the note is the record */ }
  try { pushStatus(); } catch { /* the log line is the record */ }
}

// setTimeout for the part of a command that runs later, where the try/catch around
// dispatch can't see it. A throw here got part way, so the surfaces still hear the state
// it reached, which the process-level backstop wouldn't tell them.
function later(what, ms, fn) {
  return setTimeout(() => {
    const revision = config.revision;
    try { fn(); } catch (err) {
      // fn may have raised the revision before it threw, and one change counts once. With no
      // keepReveal here, a throw in a timed close ends a reveal on show. No known input reaches that.
      try {
        if (config.revision === revision) raiseRevision();
        persist();
        pushUpdate();
      } catch { /* noteThrow still reports it */ }
      noteThrow(what, err);
    }
  }, ms);
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
  log(`chat entry: ${entry.label} (${config.entries.filter((e) => e.source === 'chat').length}/${config.entryMode.maxEntries})`);
  if (config.entries.filter((e) => e.source === 'chat').length >= config.entryMode.maxEntries) {
    closeEntryWindow('full');
  } else {
    applyChange(true);
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
    windowTimer = later("an entry window's close", config.entryMode.windowSec * 1000, () => { windowTimer = null; closeEntryWindow('time'); });
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
  applyChange(reason === 'time' || reason === 'full');
}

// ── Spin engine ───────────────────────────────────────────────────────────────

function spin(opts) {
  if (activeSpin) { fail('spin: already spinning'); return; }
  if (config.entries.length < 1) { fail('spin: the wheel is empty'); return; }
  if (config.entryMode.open) closeEntryWindow('spin'); // this wheel is set; one opened mid-spin feeds the next

  const n = config.entries.length;
  const selectedIndex = randomInt(n);
  const seed = randomInt(2 ** 31);
  const removeAfter = !!(opts && opts.removeAfter) || config.settings.removeOnDraw;

  activeSpin = {
    spinId: newId('s'),
    entryCount: n, // segment count frozen at spin time — removeOnDraw mutates the list after
    // What the wheel shows until the reveal is over. Commands stay open during a spin, so
    // the live list can change under it, and removeOnDraw changes it at the reveal.
    segments: config.entries.map(({ label, tag }) => ({ label, tag })),
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
  // Armed before anything that can throw. Only reveal() clears activeSpin, and a spin
  // that never reveals would refuse every later spin.
  revealTimer = later("a spin's reveal", activeSpin.durationMs + REVEAL_GRACE_MS, () => {
    revealTimer = null;
    reveal(removeAfter);
  });
  entriesReady = false;
  log(`SPIN → [${selectedIndex}] "${activeSpin.selectedEntry.label}" (${activeSpin.selectedEntry.tag}), ${activeSpin.durationMs}ms, ${activeSpin.extraSpins} turns${removeAfter ? ', remove after' : ''}`);
  applyChange();
}

function reveal(removeAfter) {
  if (!activeSpin) return;
  // The revision applyChange() below gives this reveal. Once the wheel's revision passes it,
  // the wheel has moved on and the overlay stops showing it. If something below throws first,
  // later()'s catch raises the revision to the same number, so the reveal still stays on show.
  config.lastSpin = { ...activeSpin, state: 'revealed', revealRevision: config.revision + 1 };
  activeSpin = null; // before anything that can throw, so the next spin isn't refused
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

// Every other command an operator can send clears the error note, so a new one counts by default.
const NOT_OPERATOR_COMMANDS = ['entry', 'status'];

function dispatch(command, value, user, userId) {
  if (command === '__status') return; // our own status relay echoing back
  log(`command: ${command.slice(0, 120)}${value ? ' ' + value.slice(0, 120) : ''}${user ? ` (from ${user.slice(0, 60)})` : ''}`);
  // The note is the only record on a hidden launch, so chat can't clear it, only the next
  // operator command with no user behind it. No user just means it didn't come from chat: a
  // control page click, but also a timed action, which nobody may be watching. If the command
  // fails, it sets a new note. Chat, redeems and the page's own status probes don't count
  // (docs/PROTOCOL.md).
  const noteBefore = [lastError, lastErrorAt, lastErrorThrew];
  if (!user && !NOT_OPERATOR_COMMANDS.includes(command)) { lastError = ''; lastErrorAt = null; lastErrorThrew = false; }
  switch (command) {
    case 'addEntry': {
      // JSON {label, tag} from the control page, or plain chat text
      // ("!wheel addEntry Run it back | bad" — an optional trailing "| tag").
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
    // Batched full-list replace — a caller sends ONE of these instead of a burst of
    // DoActions (Streamer.bot bleeds arguments between action invocations that arrive
    // within a few ms).
    case 'setEntries': {
      const arr = parseJson(value);
      if (!Array.isArray(arr)) { fail('setEntries: expected a JSON array'); return; }
      const entries = uniqueIds(arr.map(normalizeEntry).filter(Boolean).slice(0, MAX_ENTRIES));
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
      const before = JSON.stringify(config.settings);
      if (o && typeof o === 'object') {
        if (o.removeOnDraw !== undefined) config.settings.removeOnDraw = o.removeOnDraw === true || o.removeOnDraw === 'true';
        if (o.defaultChatTag !== undefined && TAGS.includes(o.defaultChatTag)) config.settings.defaultChatTag = o.defaultChatTag;
      }
      // Not applyChange: the wheel itself hasn't changed, so the revision stays and a reveal on
      // show stays with it. A new value still has to reach the replay.
      if (JSON.stringify(config.settings) !== before) {
        persist();
        pushUpdate();
      }
      pushStatus();
      return;
    }
    case 'status': pushStatus(); return;
    default:
      [lastError, lastErrorAt, lastErrorThrew] = noteBefore; // an unknown command doesn't count
      log(`unknown command "${command.slice(0, 120)}" — ignored`);
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
      // Echo-loop guard: this client also hears its own fortuna:update broadcasts.
      // Consume ONLY the command channel. Its own status arrives there too, as
      // "__status", and dispatch() drops it.
      if (!d || typeof d !== 'object' || d.type !== 'fortuna:command') return;
      // The String() calls belong inside the try. The action only relays strings, so a field
      // that throws here marks a bad relay, and running it with that field blank could do
      // harm: clearEntries reads a blank value as "all". A field that doesn't throw, like {}
      // or [], still converts and runs, as it always has.
      try {
        dispatch(String(d.command ?? ''), String(d.value ?? ''), d.user == null ? '' : String(d.user), d.userId == null ? '' : String(d.userId));
      } catch (err) {
        noteThrow('a command', err);
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

// One call is one physical line, plus a stack's frame lines. Viewer text can hold newlines and
// terminal escapes (JSON "\n" and "\u001b" decode into a label), and a forged line would look
// genuine, so control characters print escaped everywhere, frame lines included. So do Unicode
// direction controls, which can reorder how a line displays.
function log(msg, frames = []) {
  const printable = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  console.log(`[${new Date().toISOString()}] [fortuna] ${printable(msg)}${frames.map((frame) => `\n${printable(frame)}`).join('')}`);
}

// A closed stdout or stderr (the reader of a "| tee" exited, or a launcher left node running)
// fails the write on a later tick, past any try/catch. Unhandled, the error loops through the
// backstop, whose own log line fails the same way, and floods statuses, thousands in 2 s. The
// wheel matters more than the log.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

function acquireGuard() {
  return new Promise((res) => {
    // Nothing talks to this port, it only has to stay bound. So hang up on whatever connects
    // and ignore how that goes: a reset on the socket isn't a failure worth a note.
    const guard = createServer((socket) => socket.on('error', () => {}).destroy());
    guard.on('error', (err) => {
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
  // The last stop for whatever nothing above catches, now that there's a wheel to keep up. A
  // throw before this point still ends the process: it can't do its job anyway.
  const backstop = (err) => {
    try { noteThrow('a background task', err); } catch { /* a throw from here would end the process */ }
  };
  process.on('uncaughtException', backstop);
  process.on('unhandledRejection', backstop);
  connectSb();
  const shutdown = async () => {
    log('shutting down');
    if (revealTimer) clearTimeout(revealTimer);
    if (windowTimer) clearTimeout(windowTimer);
    try { sbWs?.close(); } catch {}
    // Let a running save finish, but a stalled one can't hold up the exit: config.json keeps the
    // last whole save, and the next start removes the temp file.
    setTimeout(() => { log('stopping with the last change unsaved'); process.exit(0); }, SHUTDOWN_SAVE_WAIT_MS);
    await saveLoop;
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown); // closing the console window, which Windows allows about 10 seconds
}

main();
