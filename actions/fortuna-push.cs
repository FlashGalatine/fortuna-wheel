// Streamer.bot "Fortuna Push" action — the single broadcast surface for Fortuna.
//
// Dual mode:
//   • Sidecar path — fortuna-sidecar.mjs calls DoAction "Fortuna Push" with a
//     `fortunaPayload` argument holding the full, pre-serialized fortuna:update
//     JSON. The action persists it to the global `fortuna.payload` and broadcasts
//     it verbatim.
//   • Sync-on-connect path — panel-core.js calls DoAction "Fortuna Push" with NO
//     fortunaPayload when an overlay (re)connects. The action re-broadcasts the
//     persisted global (or an empty fortuna:update if nothing was ever pushed),
//     recreating the state-on-connect replay Streamer.bot doesn't have.
//
// HOW TO USE (see README.md for the full walkthrough):
//   1. Streamer.bot -> Actions -> add an action named EXACTLY "Fortuna Push"
//      (the name matters: both the sidecar and panel-core call it by name).
//   2. Add a sub-action: Core -> C# -> Execute C# Code. Paste EVERYTHING below and
//      click Save and Compile — it must report success. A compile error means the
//      action runs but broadcasts nothing, which shows up as a blank/stale wheel.
//
// NOTE: uses ONLY types in Streamer.bot's default C# reference set — JSON is
// hand-written (no Newtonsoft). Verified pattern from Tally/Zipper on SB 1.0.4.
// Any exception is logged AND broadcast as { type:"fortuna:error", message } so
// failures are visible, not silent.

using System;
using System.Text;

public class CPHInline
{
    const string EMPTY_UPDATE = "{\"type\":\"fortuna:update\",\"revision\":0,\"entries\":[],\"entryMode\":{\"open\":false,\"maxEntries\":25},\"settings\":{\"removeOnDraw\":false,\"defaultChatTag\":\"good\"},\"spin\":null}";

    public bool Execute()
    {
        try
        {
            string payload;
            if (CPH.TryGetArg("fortunaPayload", out payload) && !string.IsNullOrWhiteSpace(payload))
            {
                // Sidecar push: cheap sanity check only — the sidecar owns the shape.
                payload = payload.Trim();
                if (!payload.StartsWith("{") || !payload.EndsWith("}"))
                    throw new Exception("fortunaPayload is not a JSON object");
                CPH.SetGlobalVar("fortuna.payload", payload, true);
            }
            else
            {
                // Overlay connect-sync: replay the persisted payload.
                payload = CPH.GetGlobalVar<string>("fortuna.payload", true);
                if (string.IsNullOrWhiteSpace(payload)) payload = EMPTY_UPDATE;
            }

            CPH.LogInfo("[Fortuna Push] broadcasting " + payload.Length + " bytes");
            CPH.WebsocketBroadcastJson(payload);
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogWarn("[Fortuna Push] ERROR: " + ex);
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
