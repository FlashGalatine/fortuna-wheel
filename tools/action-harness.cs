// Test harness for actions/fortuna-command.cs. verify.mjs compiles the two files
// together with the .NET Framework's csc (C# 5), so the action must stay C# 5.
//
// Reads a JSON array of argument objects on stdin, runs Execute() once per row, and
// prints [{ "returned": bool, "broadcasts": [string] }]. CPH below stubs only the
// members the action calls, so this proves the action's logic and syntax, NOT how
// real Streamer.bot behaves.

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

public static class CPH
{
    public static Dictionary<string, object> Args;
    public static List<string> Broadcasts;

    public static bool TryGetArg(string name, out object value) { return Args.TryGetValue(name, out value); }

    public static bool TryGetArg<T>(string name, out T value)
    {
        object o;
        if (!Args.TryGetValue(name, out o)) { value = default(T); return false; }
        value = (T)Convert.ChangeType(o, typeof(T));
        return true;
    }

    public static void LogInfo(string s) { }
    public static void LogWarn(string s) { }
    public static void WebsocketBroadcastJson(string s) { Broadcasts.Add(s); }
}

public static class Harness
{
    public static void Main()
    {
        var utf8 = new UTF8Encoding(false);
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        var rows = json.Deserialize<List<Dictionary<string, object>>>(
            new StreamReader(Console.OpenStandardInput(), utf8).ReadToEnd());

        var results = new List<object>();
        foreach (var args in rows)
        {
            CPH.Args = args;
            CPH.Broadcasts = new List<string>();
            bool returned = new CPHInline().Execute();
            results.Add(new { returned = returned, broadcasts = CPH.Broadcasts });
        }

        byte[] output = utf8.GetBytes(json.Serialize(results));
        Console.OpenStandardOutput().Write(output, 0, output.Length);
    }
}
