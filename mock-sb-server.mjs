// Throwaway mock of Streamer.bot — lets the whole wheel run with NO Streamer.bot
// install, for local styling and the verify suites. It faithfully mimics the two
// SB surfaces Fortuna depends on:
//
//   • HTTP Server on :7474 — SB Path->Folder file serving. Maps:
//       /fortuna-overlay/*    -> overlay/        (wheel.html + css + js + effects)
//       /fortuna-shared/*     -> fortuna-shared/ (panel-core.js + control.html)
//       /mock/push  (POST)    -> body = a full fortuna:update payload; stored and
//                                broadcast (what the sidecar's DoAction becomes)
//       /mock/fixture         -> loads fixtures/sample-update.json, stores +
//                                broadcasts it (quick styling data)
//       /mock/stats           -> { pushCount, commandCount, clients } for verify
//       /mock/set-args (POST) -> body = arguments forced onto every "Fortuna
//                                Command" run, like a Set Argument inside it
//       /                     -> a landing index for quick manual testing
//   • WebSocket Server on :8080 — speaks SB's envelope. On `Subscribe` it acks
//     (enforcing the lowercase `general` key exactly like real SB); on
//     `DoAction "Fortuna Push"` WITH a fortunaPayload arg it persists + broadcasts
//     (the C# action's sidecar path); WITHOUT one it replays the persisted
//     payload to that client (the sync-on-connect path). `DoAction "Fortuna
//     Command"` re-broadcasts { type:'fortuna:command', command, value, user?,
//     userId? } to every subscribed client (the C# relay the sidecar + control
//     page ride; user/userId mimic the chat-trigger args the real action relays).
//
// This is a REFERENCE/TEST harness. The real thing uses Streamer.bot itself (see
// README.md) with the same wire shapes.

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = resolve(__dirname, 'overlay');
const SHARED_DIR = resolve(__dirname, 'fortuna-shared');
const SAMPLE_FIXTURE = resolve(__dirname, 'fixtures', 'sample-update.json');

const HTTP_PORT = Number(process.env.SB_HTTP_PORT) || 7474; // SB HTTP Server default
const WS_PORT = Number(process.env.SB_WS_PORT) || 8080; // SB WebSocket Server default

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// The C# action's persisted global, mirrored: the last fortunaPayload string.
let storedPayload = null;
const stats = { pushCount: 0, commandCount: 0 };

const EMPTY_UPDATE = JSON.stringify({
  type: 'fortuna:update', revision: 0, entries: [],
  entryMode: { open: false, maxEntries: 25 },
  settings: { removeOnDraw: false, defaultChatTag: 'good' },
  spin: null,
});

// SB's General.Custom envelope for a WebsocketBroadcastJson payload. Real SB
// delivers `data` as the parsed object; panel-core also handles strings.
function customEvent(jsonString) {
  let data;
  try { data = JSON.parse(jsonString); } catch { data = jsonString; }
  return JSON.stringify({
    timeStamp: '1970-01-01T00:00:00.0000000',
    event: { source: 'General', type: 'Custom' },
    data,
  });
}

function safeResolve(base, rel) {
  const file = resolve(base, '.' + rel);
  return file === base || file.startsWith(base + '\\') || file.startsWith(base + '/') ? file : null;
}

async function serveFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

function landingHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Fortuna — mock Streamer.bot</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#e6e6e6;background:#141414}
  h1{font-size:1.3rem} a{color:#9ad} .dim{color:#888;font-size:.85em} ul{margin:.2rem 0;padding-left:1.2rem}
  code{background:#222;padding:.1em .4em;border-radius:4px}
</style>
<h1>Fortuna &mdash; mock Streamer.bot</h1>
<p>Open a page below as an OBS Browser Source (or in a tab), then hit
<a href="/mock/fixture">/mock/fixture</a> to broadcast the sample wheel payload.
Feed live data by running the sidecar against this mock:
<code>set SB_WS_PORT=${WS_PORT}&amp;&amp; npm run sidecar</code></p>
<ul>
  <li><a href="/fortuna-overlay/wheel.html?sbport=${WS_PORT}" target="_blank">wheel.html</a></li>
  <li><a href="/fortuna-shared/control.html?sbport=${WS_PORT}" target="_blank">control.html</a></li>
</ul>
<p class="dim">Stored payload: ${storedPayload ? storedPayload.length + ' bytes' : '(none — sync replays an empty update)'}</p>`;
}

// Simulates Set Argument sub-actions inside "Fortuna Command" (/mock/set-args):
// these overwrite the matching arguments on every run of the action.
let setArgs = {};

// ── HTTP server (SB HTTP Server mimic) ───────────────────────────────────────
const http = createServer(async (req, res) => {
  const url = req.url || '/';
  const path = decodeURIComponent(url.split('?')[0]);

  if (path === '/mock/set-args' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { setArgs = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"body is not JSON"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (path === '/mock/push' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { JSON.parse(body); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"body is not JSON"}');
        return;
      }
      storedPayload = body;
      stats.pushCount++;
      broadcast(customEvent(storedPayload));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (path === '/mock/fixture') {
    try {
      storedPayload = await readFile(SAMPLE_FIXTURE, 'utf-8');
      stats.pushCount++;
      broadcast(customEvent(storedPayload));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (path === '/mock/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...stats, clients: clients.size, hasPayload: !!storedPayload }));
    return;
  }
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(landingHtml());
    return;
  }
  // Two SB HTTP maps, identical to the real-SB config: `fortuna-overlay` →
  // overlay/ and `fortuna-shared` → fortuna-shared/. The overlay loads
  // "/fortuna-shared/panel-core.js" by absolute path.
  let file = null;
  if (path.startsWith('/fortuna-overlay/')) file = safeResolve(OVERLAY_DIR, path.slice('/fortuna-overlay'.length));
  else if (path.startsWith('/fortuna-shared/')) file = safeResolve(SHARED_DIR, path.slice('/fortuna-shared'.length));
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Map /fortuna-overlay/ (overlay/) or /fortuna-shared/ (fortuna-shared/).');
    return;
  }
  return serveFile(res, file);
});

http.on('error', (err) => { console.error('[mock] HTTP error:', err.message); process.exit(1); });
http.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[mock] HTTP  http://127.0.0.1:${HTTP_PORT}/  (landing page + overlay + control)`);
});

// ── WebSocket server (SB WebSocket Server mimic) ─────────────────────────────
const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
const clients = new Set();

wss.on('error', (err) => { console.error('[mock] WS error:', err.message); process.exit(1); });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.subscribedCustom = false; // only a correctly-subscribed client receives broadcasts
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.request === 'Subscribe') {
      // Real Streamer.bot uses a LOWERCASE source key ('general') in Subscribe,
      // while delivered events carry a capitalized source ('General'). Enforce
      // that here so a wrong-case subscribe gets nothing — exactly like real SB.
      const gen = m.events && m.events.general;
      ws.subscribedCustom = Array.isArray(gen) && gen.includes('Custom');
      console.log('[mock] Subscribe', ws.subscribedCustom ? 'OK (general.Custom)' : 'IGNORED (expected lowercase events.general:["Custom"])');
      ws.send(JSON.stringify({ id: m.id, status: 'ok', result: { events: m.events } }));
    } else if (m.request === 'DoAction') {
      ws.send(JSON.stringify({ id: m.id, status: 'ok' }));
      const name = m.action && m.action.name;
      if (name === 'Fortuna Push') {
        const payload = m.args && m.args.fortunaPayload;
        if (typeof payload === 'string' && payload.trim().startsWith('{')) {
          // Sidecar path: persist + broadcast (mirrors fortuna-push.cs).
          storedPayload = payload;
          stats.pushCount++;
          broadcast(customEvent(storedPayload));
          console.log(`[mock] Fortuna Push (sidecar) — ${payload.length} bytes`);
        } else if (ws.subscribedCustom) {
          // Sync-on-connect path: replay to the requesting client only.
          ws.send(customEvent(storedPayload || EMPTY_UPDATE));
          console.log('[mock] Fortuna Push (sync replay)');
        }
      } else if (name === 'Fortuna Command') {
        const args = { ...m.args, ...setArgs };
        let command = String(args.command ?? '').trim();
        let value = args.value == null ? '' : String(args.value);
        // Mirror fortuna-command.cs's mapping so verify covers these paths. Fortuna's
        // own traffic repeats its command in reserved args a Set Argument can't touch.
        if (String(args.fortunaCommand ?? '').trim()) {
          command = String(args.fortunaCommand).trim();
          value = args.fortunaValue == null ? '' : String(args.fortunaValue);
        } else if (String(args.commandId ?? '').trim()) {
          // Chat Command triggers set their own `command` ("!entry") + commandId.
          // Command Cooldown sets the same two, but a cooldown must not run the command.
          const chatCmd = String(args.__source ?? '') === 'CommandCooldown' ? '' : command.replace(/^!+/, '').toLowerCase();
          if (chatCmd === 'wheel') {
            const raw = String(args.rawInput ?? '').trim();
            const sp = raw.indexOf(' ');
            command = sp < 0 ? raw : raw.slice(0, sp);
            value = sp < 0 ? '' : raw.slice(sp + 1).trim();
          } else {
            command = chatCmd;
            value = '';
          }
          // "__" commands are Fortuna's own: chat can't send them.
          if (command.startsWith('__')) command = '';
        } else if (!command && String(args.redemptionId ?? '').trim()) {
          // A Reward Redemption trigger attached directly: a redeem spins, unless
          // Reward Redemption Updated is reporting an approval or rejection.
          const source = String(args.__source ?? '');
          const status = String(args.rewardStatus ?? '').trim().toLowerCase();
          const updated = source === 'TwitchRewardRedemptionUpdated'
            || (source !== 'TwitchRewardRedemption' && (status === 'fulfilled' || status === 'canceled'));
          command = updated ? '' : 'spin';
          value = '';
        }
        if (command) {
          stats.commandCount++;
          const out = { type: 'fortuna:command', command, value };
          // The real action relays the chat trigger's user args when present.
          if (String(args.user ?? '').trim()) out.user = String(args.user);
          if (String(args.userId ?? '').trim()) out.userId = String(args.userId);
          broadcast(customEvent(JSON.stringify(out)));
          console.log(`[mock] Fortuna Command → ${command}`);
        }
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});
wss.on('listening', () => console.log(`[mock] WS    ws://127.0.0.1:${WS_PORT}  (Streamer.bot mock)`));

function broadcast(msg) {
  for (const ws of clients) { if (ws.subscribedCustom) { try { ws.send(msg); } catch {} } }
}
