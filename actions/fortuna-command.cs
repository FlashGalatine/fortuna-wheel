// Streamer.bot "Fortuna Command" action — the relay from control surfaces and
// chat to the sidecar. SB WebSocket *clients* (the control page, Stream Deck
// plugins) cannot broadcast to other clients directly, so they DoAction this and
// the C# side re-broadcasts { type:"fortuna:command", command, value, user?,
// userId? }, which the sidecar consumes off General.Custom.
//
// Call styles:
//   • control.html — DoAction args { command:"spin", value:"{\"removeAfter\":true}" }
//   • Stream Deck  — Set Argument sub-actions before this one, same two args
//   • Chat "!entry" trigger — NO command arg; add a Set Argument sub-action
//     command = entry BEFORE this sub-action. The trigger's own user/userId args
//     are relayed automatically so the sidecar can dedupe one entry per viewer.
//   • Chat "!wheel <cmd> [value...]" trigger — the trigger's rawInput arg: the
//     first word becomes command, the rest value (e.g. "!wheel open").
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

            string c, v, raw;
            if (CPH.TryGetArg("command", out c) && !string.IsNullOrWhiteSpace(c))
            {
                command = c.Trim();
                if (CPH.TryGetArg("value", out v) && v != null) value = v;
            }
            else if (CPH.TryGetArg("rawInput", out raw) && !string.IsNullOrWhiteSpace(raw))
            {
                // Chat style: "!wheel addEntry No jumping | bad" → rawInput = "addEntry No jumping | bad"
                raw = raw.Trim();
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
