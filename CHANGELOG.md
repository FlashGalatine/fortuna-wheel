# Changelog

All notable changes to **Fortuna** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number
tracks the repository's commit count at release time.

Nothing was tagged between the initial release and 1.0.6, so that release
collects every change in between. Commit hashes and landing dates are noted there for
traceability.

## [Unreleased]

**To upgrade,** follow "Updating an existing install" in the README. The action's code
didn't change since 1.0.12, so from 1.0.12 there's nothing to paste; from an older version,
paste it as the steps say. Either way, refresh the wheel's browser source as well: the wheel
fix is partly in the overlay.

### Changed

- **The result card goes at the next change to the wheel.** It used to stay for up
  to 5 minutes, naming a winner the pointer had moved off. A viewer's `!entry` or a
  drawing closing itself doesn't count, so chat can't wipe the result. A spin's update
  carries `segments` and `revealRevision` for this (docs/PROTOCOL.md), until the reveal
  is over. A theme that draws its own slices should paint `segments` during a spin
  (docs/THEMING.md).
- **The overlay ignores an update older than the one on screen.** Updates can arrive
  out of order, which could bring back a result the wheel had moved past.
- **The control page's error note says when it happened.** Status has a new
  `lastErrorAt`.

### Fixed

- **The wheel could stop on a slice other than the winner.** This closes the known
  issue in 1.0.12. The overlay laid out slices from the live list but worked out the
  rotation for the list at spin time, so any edit during a spin could leave the pointer
  on a different entry from the one the card named. `removeOnDraw`, `removeAfter` and
  `removeDrawn` did the same when they took the winner off with the card up. A spin now
  carries the slices it froze, and the overlay paints those until the reveal is over. No
  command is refused to do this: an edit during a spin goes on the next wheel, and a
  drawing opened during a spin takes `!entry` straight away.
- **"Drawing ready" could outlast the wheel.** `setEntries []` or removing the last
  entry left the banner and pulse over a disabled Spin button. An empty wheel now clears
  it, however it emptied. A drawing closed during a spin now waits for the reveal to
  show it, instead of pulsing a Spin button that's disabled.
- **An error note stayed until the next spin, however many commands worked after it.**
  It now clears on the next command that works with no chat user behind it, such as a
  control page click, including a spin. Chat commands, redeems and the page's status
  probes no longer clear it, not even a spin from chat, and a refusal from chat can't
  replace a thrown error, which may be the only record on a launch with no log to read
  (docs/PROTOCOL.md).
- **A burst of commands or a stop during a save could wipe the wheel.** Every change
  started its own write to `config.json`, with nothing waiting for the one before. Two
  close together could leave a corrupt file, and stopping the sidecar during a stalled
  write left an empty one. The next start logged `Bad config JSON` and brought up a blank
  wheel, and the next change overwrote what was left. Saves now run one at a time, a
  burst shares one write, and each goes through `config.json.tmp` and a rename, so a stop
  at any moment leaves the last whole save. Ctrl+C or closing the console window waits up
  to 2 seconds for a running save. Windows refuses the rename while another program has
  the file open, even just to read it, so a refused save keeps its temp file and retries
  by itself, rewriting it only if the config changed. If that lasts, a note on the
  control page stays for as long as saves are failing, through a spin or a failed
  command.
- **A `config.json` the sidecar couldn't use could be lost.** One that won't parse, from
  a hand edit or an older version, or that parses but isn't a config (anything but an
  object, `entries` that isn't a list, or an `entries` list with nothing usable in it),
  is now copied first, with a note on the control page naming the copy. The copy goes to
  `config.json.bad`, then `config.json.bad.1` and so on, so it never replaces an earlier
  one. `"entries": []` is still an empty wheel, with no copy and no note. A file with no
  `entries` key, which is also what a misspelled key looks like, keeps its settings and
  starts an empty wheel, with the same copy and a note that no entries list was found. A
  file another program holds at startup is waited for: the sidecar used to start blank,
  and its next change overwrote the file. Any other read error, or a file that needs a
  copy and can't get one, starts an empty wheel with a note, and nothing is saved over
  the file until the sidecar restarts. These notes stay on the control page for the whole
  run, through a spin, a failed command or a save, and a restart on a good file clears
  them.
- **A `config.json` saved with a byte order mark read as damaged.** Editors on Windows
  often add one, and the wheel started empty with every entry intact. It's now ignored.
- **A first run that couldn't write `config.json` started empty.** It logged that
  `config.example.json` was missing. It now starts on the example's entries and logs the
  real error.

### Documentation

- Setup and update steps said to click Compile, which only tests the code. A reader
  who stopped there kept the old action. They now say Save and Compile, including in
  the 1.0.12 notes below.

Verified offline: `verify` 284/284, with its ten held-file checks on Windows only
(reported as skipped elsewhere), and `verify:render` 30/30. Closing the console
window is tested by delivering its signal inside the process, not by closing a real
window. Not run on a live Streamer.bot.

Not yet verified live: the wheel, Drawing ready and error note fixes. They ran in a
browser against the real sidecar and the mock. The error note relies on commands
arriving with no `user`. A control page spin did on real Streamer.bot 1.0.7, but a
Stream Deck action hasn't been checked.

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
