# Fortuna — a Wheel of Fate for OBS, driven by Streamer.bot

Fortuna is a randomizer-wheel overlay: load it with names, objectives, or
stipulations, hit **SPIN**, and the wheel decelerates onto a result. Entries
carry a *good / bad / neutral* tag — a good draw pops confetti, a bad draw
pours rain, neutral gets a subtle glow (all re-skinnable). Viewers can enter
drawings from chat with `!entry`. Theme designers can restyle the wheel with
CSS variables or replace the whole presentation (Magic 8-ball, crystal ball…)
— see [docs/THEMING.md](docs/THEMING.md).

![The wheel](docs/shot-wheel.png)
![A revealed draw](docs/shot-reveal.png)

- **No cloud, no accounts** — everything runs on your machine over
  Streamer.bot's WebSocket.
- **Deterministic spins** — the sidecar picks the winner once; every OBS
  source and the control page derive the identical animation and land on the
  same slice at the same moment ([docs/PROTOCOL.md](docs/PROTOCOL.md)).
- **State survives restarts** — entries, settings, and the last draw persist
  in `config.json`; overlays repaint on reconnect via a sync-on-connect replay.

## Pieces

| Piece | What it is |
|---|---|
| `overlay/wheel.html` | The OBS browser source (canvas wheel + effects) |
| `fortuna-shared/control.html` | Streamer control page (browser tab or OBS custom dock) |
| `fortuna-sidecar.mjs` | The one Node process — owns entries, timers, and the spin decision |
| `actions/*.cs` | Two tiny Streamer.bot C# actions (+ optional auto-start launcher) |
| `mock-sb-server.mjs` | A fake Streamer.bot for styling/dev with no SB install (`npm start`) |

## Setup

Requirements: [Streamer.bot](https://streamer.bot) 1.0.4+, Node ≥ 18, OBS.

### 1. Streamer.bot servers

- **WebSocket Server** (Servers/Clients → WebSocket Server): Start it on
  `127.0.0.1:8080` with **Authentication OFF**.
- **HTTP Server** (Servers/Clients → HTTP Server): Start it on `7474` and add
  two Path → Folder maps pointing into this repo:

| Path | Folder |
|---|---|
| `fortuna-overlay` | `<repo>\overlay` |
| `fortuna-shared` | `<repo>\fortuna-shared` |

### 2. The two actions

Create two actions, each with a single **Core → C# → Execute C# Code**
sub-action, named **exactly**:

- `Fortuna Push` — paste [actions/fortuna-push.cs](actions/fortuna-push.cs), Compile.
- `Fortuna Command` — paste [actions/fortuna-command.cs](actions/fortuna-command.cs), Compile.

Optional: `Fortuna Sidecar Start`
([actions/fortuna-sidecar-start.cs](actions/fortuna-sidecar-start.cs), needs a
System.dll reference — instructions in the file header) so SB launches the
sidecar automatically.

### 3. Chat triggers (optional, for viewer drawings)

Add **Command** triggers straight onto the `Fortuna Command` action — no
Set Argument sub-actions needed (the action detects chat triggers itself):

- `!entry` — viewers join an open drawing; `user`/`userId` are relayed
  automatically (one entry per viewer).
- `!wheel <cmd> [value…]` — mod controls: `!wheel openEntries`,
  `!wheel closeEntries`, `!wheel addEntry Run it back | bad`, `!wheel spin`.
  Consider restricting this trigger's permissions to moderators in SB.

### 4. Run the sidecar

Double-click `start-fortuna.bat` (installs deps on first run), or
`npm install && npm run sidecar`. A single-instance guard on :7493 makes double
launches harmless.

### 5. OBS sources

- **Wheel overlay**: Browser source → `http://127.0.0.1:7474/fortuna-overlay/wheel.html`
  (1920×1080 recommended).
- **Control page**: open `http://127.0.0.1:7474/fortuna-shared/control.html` in
  a browser, or dock it: OBS → Docks → Custom Browser Docks.

## Using it

1. Add entries on the control page (or `setEntries` your own list) and tag them.
2. **SPIN.** The result card pops with the tag's effect. “Remove it from the
   wheel” appears under the last draw; or tick *remove the drawn entry
   afterwards* / the always-on setting for elimination-style wheels.
3. **Viewer drawings**: set max entries and/or a time window, click *Open
   entries*, and chat joins with `!entry`. When it fills up or times out the
   Spin button pulses — the spin itself stays in your hands.

## Dev / verification

- `npm start` — mock Streamer.bot (HTTP :7474 + WS :8080) with a landing page;
  `/mock/fixture` broadcasts a sample wheel, POST `/mock/push` any payload.
- `npm run verify` — 49 offline checks: spin math determinism, the real
  panel-core against the mock (subscribe case, sync replay, serialized queue),
  HTTP maps, and a real sidecar E2E (entry CRUD, `!entry` dedupe/limits, spin
  lifecycle, restart persistence). Uses off-default ports (7478/8084/7494) so
  it runs beside a live SB.
- `npm run verify:render` — real-pixel checks in a system Edge/Chrome
  (`npm i --no-save playwright-core` first): painted wheel, revealed draw with
  confetti on the fx layer, control page. Writes gitignored PNGs.
- `npm run shots` — regenerates the docs screenshots.

## Ports

| Port | What |
|---|---|
| 8080 / 7474 | Streamer.bot WebSocket / HTTP (or the mock's mimics) |
| 7493 | Sidecar single-instance guard (`FORTUNA_GUARD_PORT`) |
| 7478 / 8084 / 7494 | verify-suite off-default ports |

## License

MIT — see [LICENSE](LICENSE). Third-party notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
