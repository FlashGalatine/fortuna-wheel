# Changelog

All notable changes to **Fortuna** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number
tracks the repository's commit count at release time.

Nothing was tagged between the initial release and 1.0.6, so that release
collects every change in between. Commit hashes and landing dates are noted for
traceability.

## [Unreleased]

**To upgrade,** follow "Updating an existing install" in the README: get the new
files, stop the sidecar, paste the new `fortuna-command.cs` into the action, click
Compile, then start the sidecar and reload the control page and any OBS docks. The
self-spin fix needs all of them current. On the old action, a directly attached
reward does nothing or runs the viewer's text as a command.

### Added

- **Channel point redeems.** A Twitch Reward Redemption trigger can attach
  straight onto `Fortuna Command`: the action detects `redemptionId` and relays
  `spin`, with no Set Argument needed. A separate action that sets its own
  `command` still wins, so a reward can mean something else (`entry`, say).
- **`verify` runs the real C# action.** It compiles `fortuna-command.cs` with the
  .NET Framework's `csc` against a stub `CPH` (`tools/action-harness.cs`) and
  reports those checks as skipped when `csc` is missing. The same rows also run
  through the mock's copy of the mapping, so drift on any row fails — 143/143. This
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
- **One chat message could crash the sidecar.** On an unrestricted `!wheel`,
  `!wheel addEntry {"label":{"toString":1}}` ended the process, because `String()` and
  `Number()` throw on that object, and the wheel stayed down until restarted.
  `setEntries`, `setTag` and `openEntries` could do the same. Now only text, numbers
  and booleans convert. An object or array `label` counts as empty, so `{}` no longer
  makes an entry named `[object Object]`. A bad `user` or `userId` is dropped, and a
  bad `maxEntries` or `windowSec` keeps its old value. A `setEntries` list with nothing
  usable in it is refused instead of emptying the wheel, including a list of blank
  labels; `[]` still clears. Anything that still throws is logged and dropped, with a
  note on the control page, though it may leave that command half applied. Viewers can
  still run any valid command on an unrestricted `!wheel`, so keep it restricted to
  moderators.

### Documentation

- README: channel point setup, and the `verify` check count brought up to date.

Verified offline: `verify` 143/143. Verified live on Streamer.bot 1.0.7, on pastes
of the action from before the Command Cooldown check: it compiles; simulated redeem,
chat and control page shapes behave as designed over DoAction; a real chat trigger
relays correctly and its `__source` reads as the event type's name; and a real Set
Argument `command` = `spin` left the wheel idle with no loop. Not yet verified live:
the Command Cooldown check, a real channel point redeem, approval or rejection, the
`__source` values they carry, and the sidecar crash fix.

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

[Unreleased]: https://github.com/FlashGalatine/fortuna-wheel/compare/bd40cf7...main
[1.0.6]: https://github.com/FlashGalatine/fortuna-wheel/compare/7b030f7...bd40cf7
