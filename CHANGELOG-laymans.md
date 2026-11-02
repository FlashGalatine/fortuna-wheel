# What's New in 1.0.12

*Released: November 1, 2026*

---

## ✨ New Features

- **Spin the wheel with channel points:** You can now attach a Twitch reward straight to the `Fortuna Command` action, and a redeem spins the wheel. Anything the viewer types when redeeming is ignored.
  - Set a cooldown of at least 10 seconds on the reward. A redeem is refused while the wheel is spinning or empty, and the viewer still loses the points.
  - A redeem also closes an open viewer drawing.
  - Approving or rejecting a redeem doesn't spin the wheel when the trigger is attached directly. A separate action that sets `command` still runs each time.
  - Use the Reward Redemption trigger, and test with a real redeem rather than Streamer.bot's Test Trigger. The README has the setup.

## 🐛 Bug Fixes

- **The wheel could spin on its own and never stop:** The old instructions made it easy to add a Set Argument for `command` inside `Fortuna Command`, which caused this. Once the action, sidecar, and control page are all updated, that setup no longer spins the wheel by itself. It's still wrong, though: with `spin`, any viewer's `!entry` spins the wheel, so remove it (see How to Update).
- **A command on cooldown could still run:** It's now ignored.
- **Viewer text could run as a command:** A viewer typing into a reward could clear the wheel, for example. Now only `!wheel` passes text on as a command.
- **Viewers could change how a spin worked:** Text typed after a command like `!spin` is now dropped.

## 🔒 Security Fixes

These fixes matter most if your `!wheel` command isn't restricted to moderators.

- **One chat message could stop the wheel's helper program:** The wheel then stayed down until someone restarted it. A bad message is now refused or logged instead. One kind of error could still stop the program, during a spin's reveal or when a timed drawing closes, but no known message causes it.
- **Chat could fake what the control page showed:** A message could make it look as if the helper program was running when it wasn't, or run script on the page. Fake status messages are now refused, and the page shows chat text, including wheel entries, as plain text.

Even with these fixes, anyone who can use `!wheel` can still clear the wheel, so **keep `!wheel` restricted to moderators**.

## ⚠️ Things That Changed

- Any Twitch reward already attached directly to `Fortuna Command` now spins the wheel when redeemed. Before, it did nothing or ran the viewer's text. That includes a reward that sets `rawInput` to a command: it now spins instead of running that command, so give that reward a separate action that sets `command`.
- Chat commands other than `!wheel` now ignore any text typed after them.
- If you set `rawInput` to a command with Set Argument, that no longer works. Set `command` from a separate action instead.
- A list of wheel entries with nothing usable in it is now refused instead of emptying the wheel. A completely empty list still clears the wheel on purpose.

## 🚧 Known Issue

- **The pointer can end up on a slice other than the winner the card names:** This can happen if the list changes during a spin or while the card is showing. It happens every time the winner is removed while the card is showing and other entries remain, whether at the reveal or with "Remove it from the wheel". The card's winner is the real result. A fix is in progress.

## How to Update

1. Get the new files (`git pull`, or extract the new ZIP over your folder).
2. Stop the helper program (the sidecar) by closing its window. If the `Fortuna Sidecar Start` action launched it, it has no window, so end its `node.exe` in Task Manager. Otherwise the old copy keeps running and the new one exits, so the fixes in it don't take effect.
3. Paste the new `fortuna-command.cs` into the `Fortuna Command` action and click Compile.
4. If you added a Set Argument for `command` or `value` inside `Fortuna Command`, delete it and use a separate action that runs `Fortuna Command`. Updating doesn't remove it.
5. Start the sidecar again, then reload the control page and any OBS docks.

## What Hasn't Been Tested Live

Redeems, approvals, rejections, and a redeem with Skip Queue turned on all worked in testing on a real Twitch channel. All of them came from the broadcaster's account with no typed text, and not during a live broadcast.

Only `addEntry` was tried live with a message that used to stop the helper program. `setEntries`, `setTag`, and `openEntries` were tested offline only. The control page's plain-text fix was checked in a browser against a test server, not on Streamer.bot. Kick hasn't been tested live: Kick rewards aren't detected yet, so they need a separate action.

---

*For technical details, see [CHANGELOG.md](./CHANGELOG.md)*
