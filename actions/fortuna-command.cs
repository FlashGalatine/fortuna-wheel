// Streamer.bot "Fortuna Command" action — the relay from control surfaces and
// chat to the sidecar. SB WebSocket *clients* (the control page, Stream Deck
// plugins) cannot broadcast to other clients directly, so they DoAction this and
// the C# side re-broadcasts { type:"fortuna:command", command, value, user?,
// userId? }, which the sidecar consumes off General.Custom.
//
// Call styles:
//   • control.html — DoAction args { command:"spin", value:"{\"removeAfter\":true}" }
//   • Stream Deck  — a SEPARATE action: Set Argument `command` (and `value`), then
//     Core -> Actions -> Run Action -> this one
//   • Chat Command triggers — attach them directly, NO Set Argument needed.
//     SB command triggers set their own `command` (the matched chat command,
//     e.g. "!entry") + `commandId`; this action detects that and maps:
//       "!entry"                → command "entry" (user/userId relayed for dedupe)
//       "!wheel <cmd> [value…]" → first word of rawInput = command, rest = value
//     Any other chat command "!foo" relays as command "foo" with rawInput as value.
//   • Twitch Reward Redemption triggers — attach them directly too. SB sets
//     `redemptionId` and no `command`; this action detects that and relays "spin".
//     For a reward that should do something else, use a separate action as above.
//
// NEVER add a Set Argument for `command` inside THIS action. The sidecar's status
// relay and the control page's status probes run through here too, so a fixed
// `command` rewrites every one of them: "spin" makes the wheel spin on its own,
// forever.
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

            string c, v, raw, cid, rid;
            CPH.TryGetArg("rawInput", out raw);
            raw = raw == null ? "" : raw.Trim();

            // A chat Command trigger sets ITS OWN `command` argument (the matched
            // chat command, e.g. "!entry") plus a `commandId` — which a control-page
            // DoAction never carries. Without this branch the trigger's command
            // shadows ours and the sidecar sees unknown "!entry"/"!wheel".
            if (CPH.TryGetArg("commandId", out cid) && !string.IsNullOrWhiteSpace(cid))
            {
                CPH.TryGetArg("command", out c);
                string chatCmd = (c ?? "").Trim().TrimStart('!').ToLowerInvariant();
                if (chatCmd == "wheel")
                {
                    // "!wheel addEntry No jumping | bad" → command=addEntry, value=the rest
                    int sp = raw.IndexOf(' ');
                    command = sp < 0 ? raw : raw.Substring(0, sp);
                    value = sp < 0 ? "" : raw.Substring(sp + 1).Trim();
                }
                else
                {
                    // "!entry" (or any future "!spin"-style trigger): the chat command
                    // IS the sidecar command; anything typed after it rides as value.
                    command = chatCmd;
                    value = raw;
                }
            }
            else if (CPH.TryGetArg("command", out c) && !string.IsNullOrWhiteSpace(c))
            {
                // Control page / Stream Deck: explicit { command, value } args.
                command = c.Trim();
                if (CPH.TryGetArg("value", out v) && v != null) value = v;
            }
            else if (CPH.TryGetArg("redemptionId", out rid) && !string.IsNullOrWhiteSpace(rid))
            {
                // A Reward Redemption trigger attached directly: a redeem spins.
                // rawInput is whatever the viewer typed, so it must never reach the
                // fallback below, where "clearEntries" would run as a command.
                command = "spin";
            }
            else if (raw.Length > 0)
            {
                // Bare rawInput fallback (manual Set Argument setups).
                int sp = raw.IndexOf(' ');
                command = sp < 0 ? raw : raw.Substring(0, sp);
                value = sp < 0 ? "" : raw.Substring(sp + 1).Trim();
            }

            if (string.IsNullOrWhiteSpace(command))
            {
                CPH.LogWarn("[Fortuna Command] no command argument — nothing to relay");
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
