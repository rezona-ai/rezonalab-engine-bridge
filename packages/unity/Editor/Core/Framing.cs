using System;
using System.Text;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>解析成功后的文本帧：Type 已确认，Raw 供各消息取字段。</summary>
    public sealed class ParsedMessage
    {
        public string Type;
        public JsonObject Raw;
    }

    public sealed class ChunkHeader
    {
        public string TransferId;
        public long Index;
    }

    public sealed class ParsedBinary
    {
        public ChunkHeader Header;
        public byte[] Data;
        public int DataOffset;
        public int DataLength;
    }

    /// <summary>
    /// 帧编解码。文本帧按 messages.schema.json 手工校验（字段存在性、类型、长度、枚举、additionalProperties），
    /// 与 TypeScript 内核的 Ajv 校验等价：任何不合 Schema 的帧都是 4400。
    /// </summary>
    public static class Framing
    {
        public static bool TryParseText(string text, out ParsedMessage msg, out string error)
        {
            msg = null;
            error = null;
            if (text == null) { error = "text frame is null"; return false; }
            if (Encoding.UTF8.GetByteCount(text) > Protocol.MaxTextBytes) { error = "text frame exceeds " + Protocol.MaxTextBytes + " bytes"; return false; }
            object parsed;
            try { parsed = MiniJson.Parse(text); }
            catch (Exception) { error = "text frame is not JSON"; return false; }
            var o = parsed as JsonObject;
            if (o == null) { error = "text frame fails schema: not an object"; return false; }
            var type = o["type"] as string;
            if (type == null) { error = "text frame fails schema: missing type"; return false; }
            string why;
            if (!ValidateShape(type, o, out why)) { error = "text frame fails schema: " + why; return false; }
            msg = new ParsedMessage { Type = type, Raw = o };
            return true;
        }

        /// <summary>二进制帧：uint32 大端 headerLen | headerLen 字节 JSON 头 | 数据。长度前缀不可能被构造的 JSON 迷惑。</summary>
        public static bool TryParseBinary(byte[] buf, out ParsedBinary result, out string error)
        {
            result = null;
            error = null;
            if (buf == null || buf.Length < 4) { error = "binary frame shorter than 4 bytes"; return false; }
            var headerLen = ((long)buf[0] << 24) | ((long)buf[1] << 16) | ((long)buf[2] << 8) | buf[3];
            if (headerLen == 0 || headerLen > Protocol.MaxHeaderBytes) { error = "headerLen " + headerLen + " out of range"; return false; }
            if (4 + headerLen > buf.Length) { error = "headerLen exceeds frame length"; return false; }
            object parsed;
            try { parsed = MiniJson.Parse(Encoding.UTF8.GetString(buf, 4, (int)headerLen)); }
            catch (Exception) { error = "chunk header is not JSON"; return false; }
            var o = parsed as JsonObject;
            if (o == null) { error = "chunk header fails schema: not an object"; return false; }
            foreach (var key in o.Keys)
            {
                if (key != "transferId" && key != "index") { error = "chunk header fails schema: unexpected " + key; return false; }
            }
            string tid;
            long index;
            if (!TryTransferId(o, out tid)) { error = "chunk header fails schema: transferId"; return false; }
            if (!TryInteger(o, "index", 0, out index)) { error = "chunk header fails schema: index"; return false; }
            result = new ParsedBinary
            {
                Header = new ChunkHeader { TransferId = tid, Index = index },
                Data = buf,
                DataOffset = 4 + (int)headerLen,
                DataLength = buf.Length - 4 - (int)headerLen,
            };
            return true;
        }

        /// <summary>编码一帧二进制分块（测试用）。</summary>
        public static byte[] EncodeBinary(string transferId, long index, byte[] data)
        {
            var head = Encoding.UTF8.GetBytes(MiniJson.Serialize(new JsonObject().Set("transferId", transferId).Set("index", (double)index)));
            var out_ = new byte[4 + head.Length + data.Length];
            out_[0] = (byte)(head.Length >> 24);
            out_[1] = (byte)(head.Length >> 16);
            out_[2] = (byte)(head.Length >> 8);
            out_[3] = (byte)head.Length;
            Buffer.BlockCopy(head, 0, out_, 4, head.Length);
            Buffer.BlockCopy(data, 0, out_, 4 + head.Length, data.Length);
            return out_;
        }

        public static string EncodeText(JsonObject msg) => MiniJson.Serialize(msg);

        /// <summary>把 Schema 校验过的 transfer_begin 取成强类型。</summary>
        public static TransferBegin ToTransferBegin(JsonObject o)
        {
            var meta = o["meta"] as JsonObject;
            return new TransferBegin
            {
                TransferId = (string)o["transferId"],
                FileName = (string)o["fileName"],
                ByteSize = (long)(double)o["byteSize"],
                Sha256 = (string)o["sha256"],
                Kind = (string)o["kind"],
                ChunkBytes = (long)(double)o["chunkBytes"],
                ChunkCount = (long)(double)o["chunkCount"],
                ItemId = meta == null ? null : meta["itemId"] as string,
                DisplayName = meta == null ? null : meta["displayName"] as string,
            };
        }

        // ---------- Schema 手工校验 ----------

        private static bool ValidateShape(string type, JsonObject o, out string why)
        {
            why = null;
            switch (type)
            {
                case "hello":
                    // hello 是唯一 additionalProperties: true 的消息，为将来客户端扩展留口
                    if (!TryInteger(o, "protocol", 1, out _)) return Fail("protocol", ref why);
                    return StringLen(o, "client", 1, 64, ref why) && StringLen(o, "clientVersion", 1, 32, ref why);
                case "transfer_begin":
                    if (!OnlyKeys(o, ref why, "type", "transferId", "fileName", "byteSize", "sha256", "kind", "chunkBytes", "chunkCount", "meta")) return false;
                    if (!TryTransferId(o, out _)) return Fail("transferId", ref why);
                    if (!StringLen(o, "fileName", 1, 200, ref why)) return false;
                    if (!TryInteger(o, "byteSize", 0, out _)) return Fail("byteSize", ref why);
                    var sha = o["sha256"] as string;
                    if (sha == null || !IsLowerHex64(sha)) return Fail("sha256", ref why);
                    var kind = o["kind"] as string;
                    if (kind == null || Array.IndexOf(Protocol.AssetKinds, kind) < 0) return Fail("kind", ref why);
                    if (!TryInteger(o, "chunkBytes", 1, out _)) return Fail("chunkBytes", ref why);
                    if (!TryInteger(o, "chunkCount", 0, out _)) return Fail("chunkCount", ref why);
                    if (o.ContainsKey("meta"))
                    {
                        var meta = o["meta"] as JsonObject;
                        if (meta == null) return Fail("meta", ref why);
                        if (meta.ContainsKey("itemId") && !(meta["itemId"] is string s1 && s1.Length <= 128)) return Fail("meta.itemId", ref why);
                        if (meta.ContainsKey("displayName") && !(meta["displayName"] is string s2 && s2.Length <= 200)) return Fail("meta.displayName", ref why);
                    }
                    return true;
                case "transfer_end":
                    return OnlyKeys(o, ref why, "type", "transferId") && (TryTransferId(o, out _) || Fail("transferId", ref why));
                case "ping":
                case "pong":
                    return OnlyKeys(o, ref why, "type");
                case "chunk_ack":
                    return OnlyKeys(o, ref why, "type", "transferId", "index") && (TryTransferId(o, out _) || Fail("transferId", ref why)) && (TryInteger(o, "index", 0, out _) || Fail("index", ref why));
                case "import_progress":
                    if (!OnlyKeys(o, ref why, "type", "transferId", "stage")) return false;
                    if (!TryTransferId(o, out _)) return Fail("transferId", ref why);
                    var stage = o["stage"] as string;
                    return stage == "received" || stage == "importing" || Fail("stage", ref why);
                case "error":
                    if (!OnlyKeys(o, ref why, "type", "code", "message", "transferId")) return false;
                    if (!IsErrorCode(o["code"])) return Fail("code", ref why);
                    if (!StringLen(o, "message", 0, 2000, ref why)) return false;
                    return !o.ContainsKey("transferId") || TryTransferId(o, out _) || Fail("transferId", ref why);
                case "import_result":
                    if (!OnlyKeys(o, ref why, "type", "transferId", "ok", "savedPath", "sceneNode", "error")) return false;
                    if (!TryTransferId(o, out _)) return Fail("transferId", ref why);
                    if (!(o["ok"] is bool)) return Fail("ok", ref why);
                    if (o.ContainsKey("savedPath") && !(o["savedPath"] is string sp && sp.Length <= 1000)) return Fail("savedPath", ref why);
                    if (o.ContainsKey("sceneNode") && !(o["sceneNode"] is string sn && sn.Length <= 200)) return Fail("sceneNode", ref why);
                    if (o.ContainsKey("error"))
                    {
                        var e = o["error"] as JsonObject;
                        if (e == null || !OnlyKeys(e, ref why, "code", "message") || !IsErrorCode(e["code"]) || !StringLen(e, "message", 0, 2000, ref why)) return Fail("error", ref why);
                    }
                    return true;
                case "hello_ack":
                    if (!OnlyKeys(o, ref why, "type", "protocol", "engine", "engineVersion", "pluginVersion", "project", "limits", "formats")) return false;
                    if (!TryInteger(o, "protocol", 1, out _)) return Fail("protocol", ref why);
                    if (!StringLen(o, "engine", 1, 32, ref why) || !StringLen(o, "engineVersion", 0, 64, ref why) || !StringLen(o, "pluginVersion", 1, 32, ref why)) return false;
                    var project = o["project"] as JsonObject;
                    if (project == null || !OnlyKeys(project, ref why, "name", "id") || !StringLen(project, "name", 0, 200, ref why) || !StringLen(project, "id", 1, 64, ref why)) return Fail("project", ref why);
                    var limits = o["limits"] as JsonObject;
                    if (limits == null || !OnlyKeys(limits, ref why, "chunkBytes", "maxFileBytes", "maxChunks") || !TryInteger(limits, "chunkBytes", 1, out _) || !TryInteger(limits, "maxFileBytes", 1, out _) || !TryInteger(limits, "maxChunks", 1, out _)) return Fail("limits", ref why);
                    var formats = o["formats"] as System.Collections.Generic.List<object>;
                    if (formats == null) return Fail("formats", ref why);
                    foreach (var f in formats)
                    {
                        if (!(f is string fs) || !IsFormatToken(fs)) return Fail("formats", ref why);
                    }
                    return true;
                default:
                    why = "unknown type " + type;
                    return false;
            }
        }

        private static bool Fail(string field, ref string why)
        {
            why = "invalid " + field;
            return false;
        }


        private static bool OnlyKeys(JsonObject o, ref string why, params string[] allowed)
        {
            foreach (var key in o.Keys)
            {
                if (Array.IndexOf(allowed, key) < 0)
                {
                    why = "unexpected property " + key;
                    return false;
                }
            }
            return true;
        }

        private static bool StringLen(JsonObject o, string key, int min, int max, ref string why)
        {
            var s = o[key] as string;
            if (s == null || s.Length < min || s.Length > max) return Fail(key, ref why);
            return true;
        }

        /// <summary>JSON Schema 的 integer：数值且无小数部分（5.0 也算），并满足 minimum。</summary>
        private static bool TryInteger(JsonObject o, string key, long minimum, out long value)
        {
            value = 0;
            var v = o[key];
            if (!MiniJson.IsInteger(v)) return false;
            var d = (double)v;
            if (d < minimum || d > 9007199254740992.0) return false;
            value = (long)d;
            return true;
        }

        private static bool TryTransferId(JsonObject o, out string id)
        {
            id = o["transferId"] as string;
            return id != null && id.Length >= 1 && id.Length <= 40;
        }

        private static bool IsErrorCode(object v) => v is string s && Array.IndexOf(Protocol.ErrorCodes, s) >= 0;

        private static bool IsLowerHex64(string s)
        {
            if (s.Length != 64) return false;
            foreach (var c in s)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }
            return true;
        }

        private static bool IsFormatToken(string s)
        {
            if (s.Length < 1 || s.Length > 8) return false;
            foreach (var c in s)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z'))) return false;
            }
            return true;
        }
    }
}
