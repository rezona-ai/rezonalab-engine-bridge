using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// 保序的 JSON 对象。用 List 保留键顺序是为了出帧与 TypeScript 内核逐字节一致（JSON.stringify 按插入序输出）。
    /// </summary>
    public sealed class JsonObject : IEnumerable<KeyValuePair<string, object>>
    {
        private readonly List<KeyValuePair<string, object>> _items = new List<KeyValuePair<string, object>>();
        private readonly Dictionary<string, int> _index = new Dictionary<string, int>(StringComparer.Ordinal);

        public int Count => _items.Count;

        public object this[string key]
        {
            get { return _index.TryGetValue(key, out var i) ? _items[i].Value : null; }
            set { Set(key, value); }
        }

        public JsonObject Set(string key, object value)
        {
            if (_index.TryGetValue(key, out var i)) _items[i] = new KeyValuePair<string, object>(key, value);
            else
            {
                _index[key] = _items.Count;
                _items.Add(new KeyValuePair<string, object>(key, value));
            }
            return this;
        }

        public bool ContainsKey(string key) => _index.ContainsKey(key);
        public bool TryGetValue(string key, out object value)
        {
            if (_index.TryGetValue(key, out var i)) { value = _items[i].Value; return true; }
            value = null;
            return false;
        }

        public IEnumerable<string> Keys
        {
            get { foreach (var kv in _items) yield return kv.Key; }
        }

        public IEnumerator<KeyValuePair<string, object>> GetEnumerator() => _items.GetEnumerator();
        IEnumerator IEnumerable.GetEnumerator() => _items.GetEnumerator();
    }

    /// <summary>
    /// 极简 JSON 读写器：object → JsonObject、array → List&lt;object&gt;、string、number → double、bool、null。
    /// 自己写而不用 JsonUtility，是因为后者处理不了以 type 分派的多态消息与可选嵌套对象，且不保序。
    /// </summary>
    public static class MiniJson
    {
        public static object Parse(string text)
        {
            if (text == null) throw new FormatException("json text is null");
            var p = new Parser(text);
            p.SkipWs();
            var v = p.ReadValue();
            p.SkipWs();
            if (!p.AtEnd) throw new FormatException("trailing characters after JSON value");
            return v;
        }

        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }

        /// <summary>键按序号排序后的规范化序列化，只用于测试里的结构比较。</summary>
        public static string Canonical(object value)
        {
            var sb = new StringBuilder();
            WriteCanonical(sb, value);
            return sb.ToString();
        }

        public static bool IsInteger(object v)
        {
            return v is double d && !double.IsInfinity(d) && Math.Floor(d) == d;
        }

        private static void Write(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case string s: WriteString(sb, s); break;
                case double d: WriteNumber(sb, d); break;
                case float f: WriteNumber(sb, f); break;
                case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); break;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); break;
                case JsonObject o:
                    sb.Append('{');
                    var first = true;
                    foreach (var kv in o)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, kv.Key);
                        sb.Append(':');
                        Write(sb, kv.Value);
                    }
                    sb.Append('}');
                    break;
                case IEnumerable list:
                    sb.Append('[');
                    var firstItem = true;
                    foreach (var item in list)
                    {
                        if (!firstItem) sb.Append(',');
                        firstItem = false;
                        Write(sb, item);
                    }
                    sb.Append(']');
                    break;
                default:
                    throw new ArgumentException("unsupported JSON value type " + v.GetType().Name);
            }
        }

        private static void WriteCanonical(StringBuilder sb, object v)
        {
            if (v is JsonObject o)
            {
                var keys = new List<string>(o.Keys);
                keys.Sort(StringComparer.Ordinal);
                sb.Append('{');
                for (var i = 0; i < keys.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    WriteString(sb, keys[i]);
                    sb.Append(':');
                    WriteCanonical(sb, o[keys[i]]);
                }
                sb.Append('}');
            }
            else if (v is string || v == null || v is bool || v is double || v is int || v is long || v is float) Write(sb, v);
            else if (v is IEnumerable list)
            {
                sb.Append('[');
                var first = true;
                foreach (var item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteCanonical(sb, item);
                }
                sb.Append(']');
            }
            else Write(sb, v);
        }

        private static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            // 整数不带小数点，与 JS 的 JSON.stringify 一致
            if (Math.Floor(d) == d && Math.Abs(d) < 9007199254740992.0) sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
            else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        private sealed class Parser
        {
            private readonly string _s;
            private int _i;

            public Parser(string s) { _s = s; }
            public bool AtEnd => _i >= _s.Length;

            public void SkipWs()
            {
                while (_i < _s.Length && (_s[_i] == ' ' || _s[_i] == '\t' || _s[_i] == '\n' || _s[_i] == '\r')) _i++;
            }

            private char Peek() => _i < _s.Length ? _s[_i] : '\0';

            private void Expect(char c)
            {
                if (Peek() != c) throw new FormatException("expected '" + c + "' at " + _i);
                _i++;
            }

            public object ReadValue()
            {
                SkipWs();
                var c = Peek();
                switch (c)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': ReadLiteral("true"); return true;
                    case 'f': ReadLiteral("false"); return false;
                    case 'n': ReadLiteral("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                        throw new FormatException("unexpected character at " + _i);
                }
            }

            private void ReadLiteral(string lit)
            {
                if (string.CompareOrdinal(_s, _i, lit, 0, lit.Length) != 0) throw new FormatException("bad literal at " + _i);
                _i += lit.Length;
            }

            private JsonObject ReadObject()
            {
                Expect('{');
                var o = new JsonObject();
                SkipWs();
                if (Peek() == '}') { _i++; return o; }
                for (;;)
                {
                    SkipWs();
                    var key = ReadString();
                    SkipWs();
                    Expect(':');
                    var v = ReadValue();
                    o.Set(key, v);
                    SkipWs();
                    var c = Peek();
                    if (c == ',') { _i++; continue; }
                    if (c == '}') { _i++; return o; }
                    throw new FormatException("expected ',' or '}' at " + _i);
                }
            }

            private List<object> ReadArray()
            {
                Expect('[');
                var list = new List<object>();
                SkipWs();
                if (Peek() == ']') { _i++; return list; }
                for (;;)
                {
                    list.Add(ReadValue());
                    SkipWs();
                    var c = Peek();
                    if (c == ',') { _i++; continue; }
                    if (c == ']') { _i++; return list; }
                    throw new FormatException("expected ',' or ']' at " + _i);
                }
            }

            private string ReadString()
            {
                Expect('"');
                var sb = new StringBuilder();
                for (;;)
                {
                    if (_i >= _s.Length) throw new FormatException("unterminated string");
                    var c = _s[_i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (_i >= _s.Length) throw new FormatException("bad escape");
                    var e = _s[_i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (_i + 4 > _s.Length) throw new FormatException("bad \\u escape");
                            sb.Append((char)int.Parse(_s.Substring(_i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            _i += 4;
                            break;
                        default: throw new FormatException("bad escape \\" + e);
                    }
                }
            }

            private double ReadNumber()
            {
                var start = _i;
                if (Peek() == '-') _i++;
                if (!(Peek() >= '0' && Peek() <= '9')) throw new FormatException("bad number at " + start);
                while (Peek() >= '0' && Peek() <= '9') _i++;
                if (Peek() == '.')
                {
                    _i++;
                    if (!(Peek() >= '0' && Peek() <= '9')) throw new FormatException("bad number at " + start);
                    while (Peek() >= '0' && Peek() <= '9') _i++;
                }
                if (Peek() == 'e' || Peek() == 'E')
                {
                    _i++;
                    if (Peek() == '+' || Peek() == '-') _i++;
                    if (!(Peek() >= '0' && Peek() <= '9')) throw new FormatException("bad number at " + start);
                    while (Peek() >= '0' && Peek() <= '9') _i++;
                }
                return double.Parse(_s.Substring(start, _i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }
    }
}
