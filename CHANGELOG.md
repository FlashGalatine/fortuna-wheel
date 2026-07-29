# Changelog

All notable changes to **Fortuna** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been tagged since the initial release, so every change that landed
afterwards sits under **Unreleased**. Commit hashes and landing dates are noted
for traceability.

## [Unreleased]

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

[Unreleased]: https://github.com/FlashGalatine/fortuna-wheel/compare/7b030f7...main
