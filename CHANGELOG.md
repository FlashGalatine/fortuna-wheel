# Changelog

All notable changes to **Fortuna** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number
tracks the repository's commit count at release time.

Nothing was tagged between the initial release and 1.0.6, so that release
collects every change in between. Commit hashes and landing dates are noted there for
traceability.

## [Unreleased]

**To upgrade,** get the new files and restart the sidecar.

### Changed

- **A script's own ids and loose `removeOnDraw` values no longer carry over.** An `id` in
  `setEntries` or `config.json` is kept only if it looks like one the sidecar made
  (`e_…`), so a script that goes by its own ids has to read the new ones from the update.
  In `config.json`, only `true` or `"true"` turn `removeOnDraw` on, so a value like `1`
  now reads as off.

### Fixed

- **A throw in a timer could stop the sidecar.** 1.0.12 logged and dropped a throw while a
  command was being handled, but not one in the part that runs later on a timer: a spin's
  reveal or a timed entry window's close. Those are now logged and dropped too, with the
  error on the control page, though it may leave that work half applied. A spin that hits
  one still reveals, and the next spin isn't refused. No known input causes one.
- **A failure nothing else caught could stop the sidecar.** A throw or rejected promise
  outside a command or timer, like one as the Streamer.bot connection opens, ended the
  process. Once the sidecar is running, it's now logged and dropped the same way. A failed
  startup still ends the process. No known input causes one.
- **A stray connection could stop the sidecar.** Any program on the PC that connected
  to the single-instance guard port (7493) and reset the connection ended the process,
  and the wheel stayed down until restarted. The port now hangs up on whatever connects.
- **A closed log pipe could stop the sidecar.** Started with something like
  `npm run sidecar | tee fortuna.log`, the process ended once the reader had exited and
  it next logged. It now keeps running without its log. A closed stderr is treated the
  same way.
- **Removing a drawn entry could remove a different one.** Rows sharing an id, from
  `setEntries` or a hand-edited `config.json`, all answered to the first of them, so
  drawing the second removed the first. A blank or padded id couldn't be removed or
  tagged from the control page, and an id equal to another row's label caught
  `!wheel removeEntry <label>`. An id in a list is now kept only if it looks like one the
  sidecar made (`e_…`) and no earlier row holds it. Any other row gets a new one, and at
  startup a saved winner follows its row to the new id. After a restart, "Remove it from the
  wheel" takes the right row or refuses. It refuses when no row has the winner's saved id
  and label, which includes a row renamed by hand.
- **`"removeOnDraw": "false"` in `config.json` turned it on,** as did any other value
  that wasn't empty, so every spin removed its winner. As in `setSettings`, only `true`
  or `"true"` turn it on now.
- **A damaged last draw in `config.json` reached the overlay.** A saved `lastSpin` with
  a bad field was replayed as it stood, and could break the wheel's drawing until the
  next spin. It is now dropped, with a log line and a control page note naming the field.
  A block that passes comes back whole, including any field the sidecar doesn't check. A
  `lastSpin` with a hand-edited or missing `state`, or one that isn't an object, was
  already dropped, but with no word of it. It now gets the same line and note, naming
  `state` or `lastSpin`. Only `null` or no `lastSpin` at all stays quiet.
- **Viewer text could forge lines in the sidecar's log.** A newline or terminal escape
  in a label, typed as `\n` or `\u001b` in `!wheel` JSON, reached the log as the real
  character. Control characters and Unicode direction controls now print escaped, and a
  logged error keeps its name, its escaped message and its stack frames, so a log call
  can't start a line of its own.
- **A settings change didn't reach `fortuna:update`.** `setSettings` only sent a status,
  so a custom overlay reading `settings` from the update, or connecting later and getting
  the replay, saw the old values until the next change. A change now pushes an update too,
  at the same `revision`, because the wheel itself hasn't changed. A `setSettings` that
  changes nothing still sends only a status.

### Documentation

- Setup and update steps said to click Compile, which only tests the code. A reader
  who stopped there kept the old action. They now say Save and Compile, including in
  the 1.0.12 notes below.
- Corrected what the docs say about the code: the control page shows the draw as text and
  has no wheel of its own, it never sends `setEntries`, `spin` stays non-null after the
  first draw, and an unknown command or an ignored `entry` gets no status back.

Verified offline: `verify` 266/266, `verify:render` 15/15. None of these fixes has run on a
live Streamer.bot.

## [1.0.12] — 2026-11-01

**To upgrade,** follow "Updating an existing install" in the README: get the new
files, stop the sidecar, paste the new `fortuna-command.cs` into the action, click
Save and Compile, then start the sidecar and reload the control page and any OBS
docks. The self-spin fix needs all of them current. On the old action, a directly attached
reward does nothing or runs the viewer's text as a command. Updating doesn't remove a
Set Argument for `command` or `value` you added inside `Fortuna Command`, which the
old header suggested for Stream Deck. Delete it and use a separate action: a fixed
`command` of `spin` still spins the wheel on any viewer's `!entry`.

### Added

- **Channel point redeems.** A Twitch Reward Redemption trigger can attach
  straight onto `Fortuna Command`: the action detects `redemptionId` and relays
  `spin`, with no Set Argument needed. A separate action that sets its own
  `command` still wins, so a reward can mean something else (`entry`, say).
- **`verify` runs the real C# action.** It compiles `fortuna-command.cs` with the
  .NET Framework's `csc` against a stub `CPH` (`tools/action-harness.cs`) and
  reports those checks as skipped when `csc` is missing. The same rows also run
  through the mock's copy of the mapping, so drift on any row fails — 167/167. This
  proves the action's logic, not real Streamer.bot behavior.

### Changed

- **Chat commands other than `!wheel` drop the text typed after them.**

### Removed

- **The bare `rawInput` fallback.** A `Fortuna Command` run with no `command` no
  longer treats `rawInput` as one. A setup that used Set Argument `rawInput` =
  `<command>` must set `command` from a separate action instead.

### Fixed

- **Viewer text could run as a command.** A reward that asks for text, or any other
  trigger carrying `rawInput`, attached directly to `Fortuna Command` reached the
  fallback, so a viewer typing `clearEntries` wiped the wheel. Now only `!wheel`
  passes text on as a command, so restrict that trigger to moderators. Kick rewards
  aren't detected yet: attached directly they do nothing, so they need a separate
  action.
- **Viewers could pass spin options.** A `!spin` trigger forwarded the text after
  it, so `!spin {"removeAfter":true}` removed the winner.
- **Self-spinning wheel.** The `fortuna-command.cs` header told Stream Deck setups
  to add Set Argument "before this one", which reads as inside the action. A fixed
  `command` there rewrote Fortuna's own status messages, so the wheel spun on its
  own and never stopped. The sidecar and control page now repeat their command in
  reserved `fortunaCommand` + `fortunaValue` arguments that the action reads first.
  A Set Argument for `command` there still rewrites every trigger and Stream Deck
  call, so the header and README point to a separate action and warn against it.
- **Approving or rejecting a redeem could spin the wheel.** Reward Redemption
  Updated also sets `redemptionId`. Attached directly, it is now ignored, identified
  by `__source`, with a `rewardStatus` of `fulfilled` or `canceled` as the fallback
  for any source other than the plain Reward Redemption trigger. A separate action
  that sets its own `command` still runs.
- **A command on cooldown still ran.** A Command Cooldown trigger also sets
  `commandId`, so it was treated as the command itself. It is now ignored.
- **Chat could forge the sidecar's status.** On an unrestricted `!wheel`, a viewer's
  `!wheel __status {...}` relayed as the sidecar's reserved status message. The
  control page then showed a dead sidecar as alive and ran any script in the
  message. `Fortuna Command` now refuses every chat command starting with `__`, and
  the control page shows status fields as text.
- **A wheel entry could add script to the control page.** A quote in a label ended
  its `title` attribute on the control page, so on an unrestricted `!wheel`,
  `!wheel addEntry " onmouseover="...` ran script when the label was hovered. The
  page now escapes quotes too.
- **One chat message could crash the sidecar.** On an unrestricted `!wheel`,
  `!wheel addEntry {"label":{"toString":1}}` ended the process, because `String()` and
  `Number()` throw on that object, and the wheel stayed down until restarted.
  `setEntries`, `setTag` and `openEntries` could do the same. Now only text, numbers
  and booleans convert. An object or array `label` counts as empty, so `{}` no longer
  makes an entry named `[object Object]`. A bad `user` or `userId` is dropped, and an
  object, array or null `maxEntries` or `windowSec` keeps its old value. A `setEntries`
  list with nothing usable in it is refused instead of emptying the wheel, including a
  list of blank labels; `[]` still clears. A throw while a command is being handled is
  logged and dropped, with the error on the control page, though it may leave that
  command half applied. That doesn't cover the part of a command that runs later on a
  timer, a spin's reveal or a timed entry window's close: a throw there still stops the
  sidecar, though no known input causes one. Viewers can still run any valid command on
  an unrestricted `!wheel`, so keep it restricted to moderators.

### Documentation

- README: channel point setup, the `verify` check count brought up to date, and an
  update step for removing a Set Argument from inside `Fortuna Command`.

### Known issues

- **The pointer can end up on a slice other than the winner the card names.** This
  can happen if the list changes during a spin or while the card is showing. It
  happens every time `removeOnDraw`, `removeAfter` or `removeDrawn` takes the winner
  off while the card is showing and other entries remain. The card's winner is the
  real result. This predates this release, and a fix is in progress.

Verified offline: `verify` 167/167, `verify:render` 15/15.

Verified live on Streamer.bot 1.0.7 and a Twitch Affiliate channel, with the action
and sidecar at `bf7b5de`:

- A real redeem spins once, and so does a redeem with Skip Queue turned on. Approving
  or rejecting a redeem is ignored, and the log shows `__source` as
  `TwitchRewardRedemptionUpdated` with `fulfilled` or `canceled`.
- A command on cooldown is ignored. This ran from a second account, because
  Streamer.bot's docs say the broadcaster account is always exempt from cooldowns.
- `!wheel __status {}` from chat is refused.
- The `addEntry` crash message from chat leaves the sidecar running with no entry
  added.
- `!entry` joins an open drawing.

Verified live on earlier pastes of the action: it compiles; simulated redeem, chat
and control page shapes behave as designed over DoAction; a real chat trigger's
`__source` reads as the event type's name; and a real Set Argument `command` = `spin`
left the wheel idle with no loop.

Not yet verified live: a redeem during a broadcast, from a viewer's account or with
typed text; the other crash paths (`setEntries`, `setTag`, `openEntries`); and Kick.
The control page escaping was checked in a browser against the mock, not on
Streamer.bot. No chat message carrying a real U+FEFF before `__status` reached
Streamer.bot, so it only ran through DoAction in the chat trigger's shape, where it
stayed an unknown command.

## [1.0.6] — 2026-07-29

### Fixed

- **Chat commands silently dropped.** A Streamer.bot Command trigger sets its
  own `command` argument (the matched chat command, `!entry` / `!wheel`) plus a
  `commandId`, shadowing the relayed one — so the action forwarded `!entry`
  verbatim and the sidecar discarded it as unknown. `Fortuna Command` now
  detects the `commandId` argument and maps chat calls itself: `!entry` →
  `entry` (with `rawInput` as the value), `!wheel <cmd> [value…]` parsed out of
  `rawInput`. The Set Argument sub-action is no longer needed. The mock
  reproduces the trigger shape and `verify` covers both chat paths — 50/50.
  (`0f8707b`, 2026-07-16)

### Documentation

- README: clone / Download-ZIP as the first setup step. (`50b7fba`, 2026-07-21)
- README: Author & support block, engine-agnostic wording (the overlay is a
  plain local web page, not OBS-specific), and an MIT credits section.
  (`8a97635` / `25259f2`, 2026-07-16)

## [0.1.0] — 2026-07-16

Initial release — Wheel of Fate randomizer overlay for Streamer.bot.
(`7b030f7`)

### Added

- **Canvas wheel** with good / bad / neutral outcome tags, each with its own
  reveal effect (confetti / rain / glow), re-skinnable through CSS custom
  properties and the `FORTUNA_EFFECTS` registry.
- **Chat `!entry` drawings** with per-user dedupe, max-entry and timer
  auto-close, and optional remove-on-draw.
- **Deterministic spins** decided by the sidecar (`fortuna-sidecar.mjs`, guard
  port `:7493`), with the entry count frozen for the duration of the spin so
  the overlay animation and the result can't disagree.
- **Operator control page** plus a mock Streamer.bot harness for offline
  development.
- Magic 8-ball theming tutorial in the docs.

Verified offline: `verify` 49/49, `verify:render` 11/11.

[Unreleased]: https://github.com/FlashGalatine/fortuna-wheel/compare/c0ff3a2...main
[1.0.12]: https://github.com/FlashGalatine/fortuna-wheel/compare/bd40cf7...c0ff3a2
[1.0.6]: https://github.com/FlashGalatine/fortuna-wheel/compare/7b030f7...bd40cf7
