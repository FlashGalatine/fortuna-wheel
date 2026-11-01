# Changelog

All notable changes to **Fortuna** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the patch number
tracks the repository's commit count at release time.

Nothing was tagged between the initial release and 1.0.6, so that release
collects every change in between. Commit hashes and landing dates are noted for
traceability.

## [Unreleased]

### Added

- **Channel point redeems.** A Twitch Reward Redemption trigger can attach
  straight onto `Fortuna Command`: the action detects `redemptionId` and relays
  `spin`, with no Set Argument needed. A separate action that sets its own
  `command` still wins, so a reward can mean something else (`entry`, say). The
  mock reproduces the trigger shape and `verify` covers it — 53/53. **To upgrade,**
  paste the new `fortuna-command.cs` into the action and click Compile; on the old
  code this trigger does nothing, or runs the viewer's text as a command.

### Fixed

- **Viewer text could run as a command.** A reward that asks for text, attached
  directly to `Fortuna Command`, fell through to the bare `rawInput` fallback, so
  a viewer typing `clearEntries` wiped the wheel. Redeems now ignore that text.

### Documentation

- **Self-spinning wheel.** The `fortuna-command.cs` header told Stream Deck setups
  to add Set Argument "before this one", which reads as inside the action. A
  fixed `command` there also rewrites Fortuna's own status messages, so the wheel
  spins on its own and never stops. The header and README now point to a separate
  action and warn against this.
- README: channel point setup, and the `verify` check count brought up to date.

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
