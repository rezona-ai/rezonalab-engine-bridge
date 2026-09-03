using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>protocol/fixtures/*.json 的形状（见 protocol/spec.md 第 9 节）。</summary>
    public sealed class Fixture
    {
        public string Name;
        public string OriginHeader;
        public Limits Limits;
        public string[] Formats;
        public List<JsonObject> Frames;
        public FixtureExpect Expect;
        public string SourcePath;
    }

    public sealed class FixtureExpect
    {
        public List<object> OutFrames;
        public int? CloseCode;
        public string FinalState;
        public string SavedFileSha256;
        public List<string> Files;
        /// <summary>每项 {fileName, kind}</summary>
        public List<JsonObject> AdapterCalls;
    }

    /// <summary>跑完一个夹具后的实际观测，形状与 expect 一致。</summary>
    public sealed class FixtureActual
    {
        public List<object> OutFrames = new List<object>();
        public int? CloseCode;
        public string FinalState;
        public string SavedFileSha256;
        public List<string> Files = new List<string>();
        public List<JsonObject> AdapterCalls = new List<JsonObject>();
        public List<string> TmpLeftovers = new List<string>();
    }

    /// <summary>
    /// 与 core-ts 的 fixtures-runner.ts 同语义：假适配层总是成功，savedPath = "&lt;root&gt;/RezonaAssets/&lt;basename&gt;"，
    /// model3d 时 sceneNode = meta.displayName。两种语言各跑一遍同一批夹具，就是移植正确性的唯一保障。
    /// </summary>
    public static class FixtureRunner
    {
        public const string FixtureEngine = "fake";
        public const string FixtureEngineVersion = "0.0.0";
        public const string FixturePluginVersion = "0.1.0";
        public static readonly ProjectInfo FixtureProject = new ProjectInfo("Fixture", "fixture1");

        private sealed class FakeAdapter : IEngineAdapter
        {
            public readonly List<JsonObject> Calls = new List<JsonObject>();

            public Task<ImportOutcome> ImportFile(string absPath, ImportMeta meta)
            {
                Calls.Add(new JsonObject().Set("fileName", meta.FileName).Set("kind", meta.Kind));
                var outcome = new ImportOutcome { SavedPath = "<root>/RezonaAssets/" + meta.FileName };
                if (meta.Kind == "model3d" && !string.IsNullOrEmpty(meta.DisplayName)) outcome.SceneNode = meta.DisplayName;
                return Task.FromResult(outcome);
            }

            public bool IsProjectOpen() => true;
        }

        private sealed class CollectingSink : ISessionSink
        {
            public readonly List<object> Out = new List<object>();
            public int? CloseCode;

            public void Send(string text) => Out.Add(MiniJson.Parse(text));

            public void Close(int code, string reason)
            {
                if (CloseCode == null) CloseCode = code;
            }
        }

        public static List<Fixture> LoadAll(string dir)
        {
            var files = Directory.GetFiles(dir, "*.json");
            Array.Sort(files, StringComparer.Ordinal);
            var list = new List<Fixture>();
            foreach (var f in files) list.Add(Load(f));
            return list;
        }

        public static Fixture Load(string path)
        {
            var o = (JsonObject)MiniJson.Parse(File.ReadAllText(path, Encoding.UTF8));
            var fx = new Fixture
            {
                Name = (string)o["name"],
                OriginHeader = o["origin"] as string,
                Limits = new Limits(),
                Formats = Protocol.DefaultFormats,
                Frames = new List<JsonObject>(),
                SourcePath = path,
            };
            var server = o["server"] as JsonObject;
            if (server != null)
            {
                var limits = server["limits"] as JsonObject;
                if (limits != null)
                {
                    if (limits["chunkBytes"] is double cb) fx.Limits.ChunkBytes = (long)cb;
                    if (limits["maxFileBytes"] is double mf) fx.Limits.MaxFileBytes = (long)mf;
                    if (limits["maxChunks"] is double mc) fx.Limits.MaxChunks = (long)mc;
                }
                if (server["formats"] is List<object> formats)
                {
                    fx.Formats = formats.ConvertAll(x => (string)x).ToArray();
                }
            }
            foreach (var frame in (List<object>)o["frames"]) fx.Frames.Add((JsonObject)frame);
            var expect = (JsonObject)o["expect"];
            fx.Expect = new FixtureExpect
            {
                OutFrames = (List<object>)expect["outFrames"],
                CloseCode = expect["closeCode"] is double cc ? (int?)(int)cc : null,
                FinalState = (string)expect["finalState"],
                SavedFileSha256 = expect["savedFileSha256"] as string,
                Files = ((List<object>)expect["files"]).ConvertAll(x => (string)x),
                AdapterCalls = ((List<object>)expect["adapterCalls"]).ConvertAll(x => (JsonObject)x),
            };
            return fx;
        }

        /// <summary>同步阻塞地跑完一个夹具；Session 内部全是 ConfigureAwait(false)，从主线程阻塞不会死锁。</summary>
        public static FixtureActual Run(Fixture fixture)
        {
            var root = Path.Combine(Path.GetTempPath(), "rezona-fixture-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            var assetsRoot = Path.Combine(root, "assets");
            var tmp = Path.Combine(root, "tmp");
            Directory.CreateDirectory(assetsRoot);
            Directory.CreateDirectory(tmp);
            var adapter = new FakeAdapter();
            var sink = new CollectingSink();
            var session = new Session(fixture.OriginHeader, new SessionConfig
            {
                Engine = FixtureEngine,
                EngineVersion = FixtureEngineVersion,
                PluginVersion = FixturePluginVersion,
                Project = FixtureProject,
                AssetsRoot = assetsRoot,
                TmpDir = tmp,
                OriginAllowlist = Origin.DefaultAllowlist,
                Limits = fixture.Limits,
                Formats = fixture.Formats,
                Adapter = adapter,
            }, sink);
            try
            {
                if (session.Open())
                {
                    foreach (var frame in fixture.Frames)
                    {
                        var dir = (string)frame["dir"];
                        if (dir == "tick")
                        {
                            session.Advance((long)(double)frame["ms"]);
                        }
                        else if (frame["text"] is JsonObject text)
                        {
                            session.HandleText(MiniJson.Serialize(text)).GetAwaiter().GetResult();
                        }
                        else
                        {
                            var binary = (JsonObject)frame["binary"];
                            var header = (JsonObject)binary["header"];
                            var data = Convert.FromBase64String((string)binary["bytesBase64"]);
                            var buf = Framing.EncodeBinary((string)header["transferId"], (long)(double)header["index"], data);
                            session.HandleBinary(buf).GetAwaiter().GetResult();
                        }
                    }
                }
                var actual = new FixtureActual
                {
                    OutFrames = sink.Out,
                    CloseCode = sink.CloseCode,
                    FinalState = SessionStateNames.ToWire(session.State),
                    AdapterCalls = adapter.Calls,
                };
                var files = Walk(assetsRoot);
                foreach (var p in files) actual.Files.Add(Relative(assetsRoot, p));
                actual.Files.Sort(StringComparer.Ordinal);
                if (actual.Files.Count == 1)
                {
                    using (var sha = SHA256.Create())
                    {
                        var digest = sha.ComputeHash(File.ReadAllBytes(Path.Combine(assetsRoot, actual.Files[0])));
                        var sb = new StringBuilder();
                        foreach (var b in digest) sb.Append(b.ToString("x2"));
                        actual.SavedFileSha256 = sb.ToString();
                    }
                }
                foreach (var p in Walk(tmp)) actual.TmpLeftovers.Add(Relative(tmp, p));
                return actual;
            }
            finally
            {
                try { Directory.Delete(root, true); } catch (Exception) { /* 尽力而为 */ }
            }
        }

        /// <summary>逐字段比对，返回差异描述；null 表示完全一致。</summary>
        public static string Diff(Fixture fixture, FixtureActual actual)
        {
            var sb = new StringBuilder();
            var expectFrames = MiniJson.Canonical(fixture.Expect.OutFrames);
            var actualFrames = MiniJson.Canonical(actual.OutFrames);
            if (expectFrames != actualFrames) sb.Append("outFrames\n  expect: ").Append(expectFrames).Append("\n  actual: ").Append(actualFrames).Append('\n');
            if (fixture.Expect.CloseCode != actual.CloseCode) sb.Append("closeCode expect ").Append(fixture.Expect.CloseCode?.ToString() ?? "null").Append(" actual ").Append(actual.CloseCode?.ToString() ?? "null").Append('\n');
            if (fixture.Expect.FinalState != actual.FinalState) sb.Append("finalState expect ").Append(fixture.Expect.FinalState).Append(" actual ").Append(actual.FinalState).Append('\n');
            if (fixture.Expect.SavedFileSha256 != actual.SavedFileSha256) sb.Append("savedFileSha256 expect ").Append(fixture.Expect.SavedFileSha256 ?? "null").Append(" actual ").Append(actual.SavedFileSha256 ?? "null").Append('\n');
            var expectFiles = string.Join(",", fixture.Expect.Files);
            var actualFiles = string.Join(",", actual.Files);
            if (expectFiles != actualFiles) sb.Append("files expect [").Append(expectFiles).Append("] actual [").Append(actualFiles).Append("]\n");
            var expectCalls = MiniJson.Canonical(fixture.Expect.AdapterCalls);
            var actualCalls = MiniJson.Canonical(actual.AdapterCalls);
            if (expectCalls != actualCalls) sb.Append("adapterCalls expect ").Append(expectCalls).Append(" actual ").Append(actualCalls).Append('\n');
            if (actual.TmpLeftovers.Count > 0) sb.Append("tmp dir not empty: ").Append(string.Join(",", actual.TmpLeftovers)).Append('\n');
            return sb.Length == 0 ? null : sb.ToString();
        }

        private static List<string> Walk(string dir)
        {
            var out_ = new List<string>();
            if (!Directory.Exists(dir)) return out_;
            foreach (var f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) out_.Add(f);
            return out_;
        }

        private static string Relative(string root, string path)
        {
            var rel = path.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return rel.Replace('\\', '/');
        }
    }
}
