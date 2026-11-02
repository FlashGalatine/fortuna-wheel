# Fortuna wire protocol

Everything rides Streamer.bot's `General.Custom` channel as JSON broadcast with
`CPH.WebsocketBroadcastJson`, keyed by a `type` field. panel-core.js re-dispatches
each payload as a same-named window `CustomEvent` (detail = the payload object).

## The two Streamer.bot actions

| Action (exact name) | Role |
|---|---|
| `Fortuna Push` | Called by the sidecar with a `fortunaPayload` arg → persists it to the SB global `fortuna.payload` and broadcasts it. Called by panel-core with **no** arg on connect → re-broadcasts the persisted payload (the sync-on-connect replay SB doesn't have natively). |
| `Fortuna Command` | Relay: DoAction args `{command, value}` → re-broadcasts `{type:"fortuna:command", command, value, user?, userId?}`. WS clients can't broadcast to each other, so every control surface rides this. Chat Command triggers attach directly: SB sets its own `command` (`!entry`) + `commandId`, which the action detects and maps — `!entry` → `entry`, `!wheel <cmd> [value…]` → first word of `rawInput` = command, rest = value. `user`/`userId` are relayed automatically. Any other chat command relays lowercased with the text after it dropped, so only `entry`, `spin` and `status` work as direct triggers. A Command Cooldown trigger relays nothing. A chat command starting with `__` is refused, because those are Fortuna's own. A Twitch Reward Redemption trigger attaches directly too: `redemptionId` with no `command` → `spin`, and the viewer's `rawInput` is never relayed. Reward Redemption Updated attached directly relays nothing: `__source` identifies it, and for any source other than the plain trigger's, a `rewardStatus` of `fulfilled` or `canceled` does too. A `command` set by a separate action (Set Argument, then Run Action) wins over that default. Kick rewards aren't detected, so they need a separate action. The sidecar and control page also send `fortunaCommand` + `fortunaValue`, reserved args the action reads first, so a Set Argument for `command` or `value` inside it can't rewrite Fortuna's own traffic. It still rewrites other calls, so never add one. |

## `fortuna:update` — the persisted wheel state

Broadcast on every state change; replayed on connect. **Nothing in it is
wheel-specific** — a Magic 8-ball theme is a valid consumer (docs/THEMING.md).

```json
{
  "type": "fortuna:update",
  "revision": 42,
  "generatedAt": "2026-07-16T20:04:00.000Z",
  "entries": [
    { "id": "e_a1b2", "label": "Win with no jumping", "tag": "bad", "source": "streamer" },
    { "id": "e_c3d4", "label": "chatter_99", "tag": "good", "source": "chat",
      "user": "chatter_99", "userId": "u99" }
  ],
  "entryMode": { "open": true, "maxEntries": 25, "windowSec": 120,
                 "closesAt": "2026-07-16T20:06:00.000Z" },
  "settings": { "removeOnDraw": false, "defaultChatTag": "good" },
  "spin": {
    "spinId": "s_mrn41x2a",
    "entryCount": 8,
    "segments": [
      { "label": "Win with no jumping", "tag": "bad" },
      { "label": "chatter_99", "tag": "good" }
    ],
    "selectedIndex": 3,
    "selectedEntry": { "id": "e_c3d4", "label": "chatter_99", "tag": "good", "source": "chat" },
    "seed": 987654321,
    "startedAt": "2026-07-16T20:04:00.000Z",
    "durationMs": 6000,
    "extraSpins": 5,
    "state": "spinning"
  }
}
```

- `tag` is `good | bad | neutral` — it selects the reveal effect (confetti /
  rain / glow).
- `spin` is `null` when idle. The sidecar broadcasts once with
  `state:"spinning"` at spin start and again with `state:"revealed"` after
  `durationMs` (plus a 300 ms grace so every client's animation has finished).
  If `removeOnDraw` / per-spin `removeAfter` is set, the drawn entry is removed
  in the same revealed broadcast.
- `entryCount` and `segments` freeze the wheel at spin time: the slice count, and
  each slice's `label` and `tag` in order. `selectedEntry` is embedded so the reveal
  survives entry mutations. `entries` stays live, because commands still work during
  a spin and removeOnDraw takes the winner off at the reveal. **A surface that draws
  the slices paints `segments`, not `entries`, until the reveal is over:** the
  rotation only lands on the winner on that list. `paintedEntries()` in
  overlay/spin-math.js makes the choice.
- A reveal is over once something changes after it. The revealed block carries
  `revealRevision`, the update `revision` it was revealed at, so a higher `revision`
  means the wheel has moved on: the overlay hides the result card and paints
  `entries` again (`revealOnShow()` in overlay/spin-math.js), and the sidecar drops
  `segments` from the block. A viewer's `!entry` and a drawing closing itself don't
  count, because nobody has moved on from the result: those updates carry
  `revealRevision` forward. `setSettings` sends no update, so it doesn't end a reveal
  either. The card also stops replaying on a reconnect 5 minutes after the spin. A block without these fields, from an older sidecar, paints
  `entries`.

### Spin determinism

The winner and every animation parameter are decided ONCE, in the sidecar.
Every surface derives the identical animation (overlay/spin-math.js):

```
seg           = 2π / entryCount
center(i)     = (i + 0.5) · seg
jitter        = ((seed mod 1000)/1000 − 0.5) · 0.8 · seg     // stays inside the slice
θ (target)    = extraSpins·2π + (2π − center(selectedIndex) + jitter) mod 2π
progress p    = clamp((now − startedAt) / durationMs, 0, 1)
rotation(p)   = θ · (1 − (1−p)^5)                            // ease-out quintic
```

A client connecting mid-spin computes elapsed time from `startedAt` and joins
the animation in progress (or jumps straight to the rest position). Multiple
OBS sources therefore always land on the same slice at the same moment.

## `fortuna:command` — the control channel

```json
{ "type": "fortuna:command", "command": "spin", "value": "{\"removeAfter\":true}",
  "user": "flash", "userId": "u1" }
```

Commands the sidecar understands (`value` is a string; JSON where noted):

| Command | value | Typical source |
|---|---|---|
| `addEntry` | JSON `{label, tag?}` or plain text with optional trailing `\| good\|bad\|neutral` | control page / `!wheel addEntry …` |
| `removeEntry` | entry id or exact label (case-insensitive) | control page |
| `setTag` | JSON `{id, tag}` | control page |
| `clearEntries` | `all` \| `chat` \| `streamer` | control page |
| `setEntries` | JSON array of `{label, tag?, source?}` — batched full replace; `[]` clears, and a list with nothing usable in it is refused | control page |
| `openEntries` | JSON `{maxEntries?, windowSec?}` | control page / `!wheel openEntries` |
| `closeEntries` | — | control page / `!wheel closeEntries` |
| `entry` | — (label = the chatter's name; deduped by `userId`) | chat `!entry` |
| `spin` | optional JSON `{removeAfter?: bool}` | control page / `!wheel spin` / Reward Redemption trigger |
| `removeDrawn` | — removes the last revealed spin's entry | control page |
| `setSettings` | JSON `{removeOnDraw?, defaultChatTag?}` — batched | control page |
| `status` | — request a `fortuna:status` snapshot | any |
| `__status` | reserved — the sidecar's own status relay (see below) | sidecar only |

Only `spin` is refused during a spin. The list commands, `openEntries` and `entry`
run as usual and change `entries`, so they show on the next wheel, not this one. A
spin closes an open drawing when it starts, and `entry` is ignored until one is open
again.

**Burst warning (SB 1.0.4):** never fire several DoActions to the same action
within a few milliseconds — Streamer.bot bleeds arguments between them.
panel-core serializes its queue; the control page sends one batched command per
click. Follow the same rule from Stream Deck and chat macros.

## `fortuna:status` — ephemeral sidecar status

Status must never clobber the persisted update payload, so it rides the
`Fortuna Command` relay as reserved command `__status` with the JSON in `value`
(no third SB action). Sent after every command and periodically probed by the
control page.

```json
{ "type": "fortuna:status", "connected": true,
  "entryCount": 7, "chatEntryCount": 4,
  "entryMode": { "open": true, "maxEntries": 25, "windowSec": 120, "secondsLeft": 63 },
  "ready": false, "spinning": false,
  "lastSpin": { "label": "chatter_99", "tag": "good" },
  "settings": { "removeOnDraw": false, "defaultChatTag": "good" },
  "lastError": "", "lastErrorAt": null }
```

`ready:true` = a viewer drawing closed with entries on the wheel: it filled up
(max reached), timed out, or was closed by hand. The control page pulses the Spin
button. It clears when a spin starts, a drawing opens, `clearEntries` runs, or the
wheel empties any other way. It stays off during a spin, so a drawing closed mid-spin
shows as ready after the reveal.

`lastError` is the latest failure: a refused command, or one that threw. A launch
with no window has no log to read, so this note can be the only record. A later
refusal can replace a refusal's note, but not a thrown error's.

- **What clears it:** the next `addEntry`, `removeEntry`, `setTag`, `clearEntries`,
  `setEntries`, `openEntries`, `closeEntries`, `spin`, `removeDrawn` or `setSettings`
  with no `user`. That only means it didn't come from chat: a control page click, but
  also a timed action nobody may be watching. A Stream Deck action counts if it sets no
  `user`, which hasn't been checked. If that command fails too, its own failure becomes
  the note. A sidecar restart also clears
  it, because it isn't saved.
- **What doesn't:** chat commands, `!entry` and redeems, which can land while nobody
  is looking; the page's own `status` probes, which run every 10 seconds regardless;
  an unknown command; and the timers behind a reveal or a timed drawing.

`lastErrorAt` is when it happened (an ISO time, `null` with no note). The control
page shows it, so an old note reads as a past event and not a current fault.

## `fortuna:error`

`{ "type": "fortuna:error", "message": "…" }` — broadcast by the C# actions'
catch blocks so action-side failures are visible, not silent.
