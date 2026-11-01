// Streamer.bot "Fortuna Command" action — the relay from control surfaces and
// chat to the sidecar. SB WebSocket *clients* (the control page, Stream Deck
// plugins) cannot broadcast to other clients directly, so they DoAction this and
// the C# side re-broadcasts { type:"fortuna:command", command, value, user?,
// userId? }, which the sidecar consumes off General.Custom.
//
// Call styles:
//   • control.html — DoAction args { command:"spin", value:"{\"removeAfter\":true}" },
//     repeated as `fortunaCommand` + `fortunaValue` (the sidecar's status relay too).
//     The reserved pair wins, so nothing else should set those two names.
//   • Stream Deck  — a SEPARATE action: Set Argument `command` (and `value`), then
//     Core -> Actions -> Run Action -> this one
//   • Chat Command triggers — attach them directly, NO Set Argument needed.
//     SB command triggers set their own `command` (the matched chat command,
//     e.g. "!entry") + `commandId`; this action detects that and maps:
//       "!entry"                → command "entry" (user/userId relayed for dedupe)
//       "!wheel <cmd> [value…]" → first word of rawInput = command, rest = value
//     Any other chat command "!foo" relays as lowercase "foo" with the text after it
//     dropped, so only entry, spin and status work this way: use !wheel for the rest.
//     A Command Cooldown trigger is ignored: a command on cooldown doesn't run.
//   • Twitch Reward Redemption triggers — attach them directly too. SB sets
//     `redemptionId` and no `command`; this action detects that and relays "spin".
//     For a reward that should do something else, use a separate action as above.
//     Kick rewards aren't detected, so they need a separate action too: attached
//     directly, they do nothing.
//
// NEVER add a Set Argument for `command` or `value` inside THIS action. A fixed
// `command` rewrites every trigger and Stream Deck call: with "spin", any viewer's
// !entry spins the wheel. A fixed `value` replaces every Stream Deck call's value. If
// the sidecar or this action is out of date, it also rewrites Fortuna's own status
// messages and the wheel spins on its own, forever. An out-of-date control page spins
// it at every status check until reloaded.
//
// Commands the sidecar understands (docs/PROTOCOL.md): addEntry, removeEntry,
// setTag, clearEntries, setEntries, openEntries, closeEntries, entry, spin,
// removeDrawn, setSettings, status.
//
// Setup: add an action named EXACTLY "Fortuna Command" with a single
// Core -> C# -> Execute C# Code sub-action holding everything below (COMPILE must
// report success). Default reference set only — JSON is hand-written.

using System;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        try
        {
            string command = "";
            string value = "";

            string c, v, cid, rid, status;

            // Which trigger fired. Absent on a DoAction.
            object src;
            string source = CPH.TryGetArg("__source", out src) && src != null ? src.ToString() : "";

            // Fortuna's own traffic (sidecar status relay, control page) repeats its
            // command in reserved args, so a Set Argument for `command` or `value` in
            // this action can't rewrite it. Never fall back to `value` here.
            if (CPH.TryGetArg("fortunaCommand", out c) && !string.IsNullOrWhiteSpace(c))
            {
                command = c.Trim();
                if (CPH.TryGetArg("fortunaValue", out v) && v != null) value = v;
            }
            else if (CPH.TryGetArg("commandId", out cid) && !string.IsNullOrWhiteSpace(cid))
            {
                // A chat Command trigger sets ITS OWN `command` argument (the matched
                // chat command, e.g. "!entry") plus a `commandId` — which a control-page
                // DoAction never carries. Without this branch the trigger's command
                // shadows ours and the sidecar sees unknown "!entry"/"!wheel". Command
                // Cooldown sets the same two, but a cooldown must not run the command.
                if (source == "CommandCooldown")
                {
                    CPH.LogInfo("[Fortuna Command] command on cooldown, ignored");
                    return true;
                }
                CPH.TryGetArg("command", out c);
                string chatCmd = (c ?? "").Trim().TrimStart('!').ToLowerInvariant();
                if (chatCmd == "wheel")
                {
                    // "!wheel addEntry No jumping | bad" → command=addEntry, value=the rest
                    string raw;
                    CPH.TryGetArg("rawInput", out raw);
                    raw = raw == null ? "" : raw.Trim();
                    int sp = raw.IndexOf(' ');
                    command = sp < 0 ? raw : raw.Substring(0, sp);
                    value = sp < 0 ? "" : raw.Substring(sp + 1).Trim();
                }
                else
                {
                    // "!entry" (or any future "!spin"-style trigger): the chat command
                    // IS the sidecar command. Text typed after it is dropped, so a
                    // viewer can't pass options such as {"removeAfter":true}.
                    command = chatCmd;
                }
            }
            else if (CPH.TryGetArg("command", out c) && !string.IsNullOrWhiteSpace(c))
            {
                // Stream Deck / a separate action: explicit { command, value } args.
                command = c.Trim();
                if (CPH.TryGetArg("value", out v) && v != null) value = v;
            }
            else if (CPH.TryGetArg("redemptionId", out rid) && !string.IsNullOrWhiteSpace(rid))
            {
                // A Reward Redemption trigger attached directly: a redeem spins, and
                // rawInput (whatever the viewer typed) is never relayed. Reward
                // Redemption Updated also sets redemptionId when a redeem is approved
                // or rejected, and that must not spin the wheel again. `__source` names
                // the trigger; a final rewardStatus is the fallback for any other source.
                CPH.TryGetArg("rewardStatus", out status);
                status = (status ?? "").Trim().ToLowerInvariant();
                if (source == "TwitchRewardRedemptionUpdated"
                    || (source != "TwitchRewardRedemption" && (status == "fulfilled" || status == "canceled")))
                {
                    CPH.LogInfo("[Fortuna Command] redeem update ignored (" + source + " " + status + ")");
                    return true;
                }
                command = "spin";
            }

            if (string.IsNullOrWhiteSpace(command))
            {
                CPH.LogWarn("[Fortuna Command] no command to relay. Likely causes: a bare !wheel; a reward's Test Trigger, which may not set redemptionId (test with a real redeem); a Kick reward, which needs a separate action.");
                return false;
            }

            var json = new StringBuilder();
            json.Append("{\"type\":\"fortuna:command\",\"command\":").Append(JsonStr(command))
                .Append(",\"value\":").Append(JsonStr(value));

            // Chat triggers carry the sender — relay it so the sidecar can dedupe
            // "!entry" to one entry per viewer. Absent on control-page calls.
            string user, userId;
            if (CPH.TryGetArg("user", out user) && !string.IsNullOrWhiteSpace(user))
                json.Append(",\"user\":").Append(JsonStr(user));
            if (CPH.TryGetArg("userId", out userId) && !string.IsNullOrWhiteSpace(userId))
                json.Append(",\"userId\":").Append(JsonStr(userId));

            json.Append('}');
            CPH.LogInfo("[Fortuna Command] " + json);
            CPH.WebsocketBroadcastJson(json.ToString());
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Fortuna Command] ERROR: " + ex);
            CPH.WebsocketBroadcastJson("{\"type\":\"fortuna:error\",\"message\":" + JsonStr(ex.Message) + "}");
            return false;
        }
    }

    // Minimal, correct JSON string encoder (escapes quotes, backslashes, controls).
    static string JsonStr(string s)
    {
        if (s == null) return "\"\"";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"':  sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
