using System.Collections.Generic;
using System.Text;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>
    /// 面板日志的事件码与文案表，镜像 core-ts 的 `packages/core-ts/src/log-codes.ts`。
    ///
    /// 内核只发码 + 参数，永远不拼人类语言；文案在这里按语言渲染，所以英文编辑器里
    /// 不会出现「标签英文、日志中文」的混排。两边码集一致由 TypeScript 侧的解析测试保证。
    /// </summary>
    public static class LogCodes
    {
        public const string Listening = "listening";
        public const string Stopped = "stopped";
        public const string OriginRejected = "origin_rejected";
        public const string BusyRejected = "busy_rejected";
        public const string ClientConnected = "client_connected";
        public const string ConnectionClosed = "connection_closed";
        public const string HeartbeatTimeout = "heartbeat_timeout";
        public const string ReceiveStart = "receive_start";
        public const string TransferRejected = "transfer_rejected";
        public const string ChecksumFailed = "checksum_failed";
        public const string SaveFailed = "save_failed";
        public const string Imported = "imported";
        public const string ImportFailed = "import_failed";
        public const string ChunkWriteFailed = "chunk_write_failed";
        public const string TmpCreateFailed = "tmp_create_failed";
        public const string FrameError = "frame_error";
        public const string ConnectionError = "connection_error";
        public const string ServerError = "server_error";

        /// <summary>缺 Origin 头时 origin 参数用的占位文案（英文兜底，面板会按语言换）。</summary>
        public const string MissingOriginEn = "(no Origin header)";
        public const string MissingOriginZh = "(缺 Origin 头)";

        private static readonly Dictionary<string, string> Zh = new Dictionary<string, string>
        {
            ["listening"] = "监听中 127.0.0.1:{port}{path}",
            ["stopped"] = "已停止",
            ["origin_rejected"] = "拒绝来源 {origin}",
            ["busy_rejected"] = "已有传输进行中，拒绝新连接",
            ["client_connected"] = "客户端已连接：{client} {clientVersion}",
            ["connection_closed"] = "关闭连接（{code}）：{reason}",
            ["heartbeat_timeout"] = "心跳超时，关闭连接",
            ["receive_start"] = "开始接收 {file}（{bytes} 字节，{chunks} 块）",
            ["transfer_rejected"] = "拒绝传输 {file}：{reason}",
            ["checksum_failed"] = "{file} 校验失败：{reason}",
            ["save_failed"] = "{file} 落盘失败：{reason}",
            ["imported"] = "{file} 已导入：{path}",
            ["import_failed"] = "{file} 导入失败：{code} {reason}",
            ["chunk_write_failed"] = "写入分块失败：{reason}",
            ["tmp_create_failed"] = "无法创建临时文件：{reason}",
            ["frame_error"] = "处理帧时异常：{reason}",
            ["connection_error"] = "连接错误：{reason}",
            ["server_error"] = "服务端错误：{reason}",
        };

        private static readonly Dictionary<string, string> En = new Dictionary<string, string>
        {
            ["listening"] = "Listening on 127.0.0.1:{port}{path}",
            ["stopped"] = "Stopped",
            ["origin_rejected"] = "Rejected origin {origin}",
            ["busy_rejected"] = "A transfer is in progress; new connection refused",
            ["client_connected"] = "Client connected: {client} {clientVersion}",
            ["connection_closed"] = "Connection closed ({code}): {reason}",
            ["heartbeat_timeout"] = "Heartbeat timed out; closing the connection",
            ["receive_start"] = "Receiving {file} ({bytes} bytes, {chunks} chunks)",
            ["transfer_rejected"] = "Rejected {file}: {reason}",
            ["checksum_failed"] = "{file} failed verification: {reason}",
            ["save_failed"] = "Could not save {file}: {reason}",
            ["imported"] = "{file} imported: {path}",
            ["import_failed"] = "Import of {file} failed: {code} {reason}",
            ["chunk_write_failed"] = "Writing a chunk failed: {reason}",
            ["tmp_create_failed"] = "Could not create the temp file: {reason}",
            ["frame_error"] = "Error while handling a frame: {reason}",
            ["connection_error"] = "Connection error: {reason}",
            ["server_error"] = "Server error: {reason}",
        };

        /// <summary>全部事件码，供测试遍历。</summary>
        public static IEnumerable<string> All => En.Keys;

        public static string Template(string code, bool zh)
        {
            var table = zh ? Zh : En;
            string s;
            return table.TryGetValue(code, out s) ? s : (En.TryGetValue(code, out s) ? s : code);
        }

        /// <summary>把参数填进模板。未知插值位原样留下，方便一眼看出漏传了参数。</summary>
        public static string Interpolate(string template, IDictionary<string, string> args)
        {
            if (string.IsNullOrEmpty(template) || template.IndexOf('{') < 0) return template;
            var sb = new StringBuilder(template.Length);
            for (var i = 0; i < template.Length; i++)
            {
                if (template[i] != '{') { sb.Append(template[i]); continue; }
                var close = template.IndexOf('}', i + 1);
                if (close < 0) { sb.Append(template, i, template.Length - i); break; }
                var name = template.Substring(i + 1, close - i - 1);
                string v;
                if (args != null && args.TryGetValue(name, out v)) sb.Append(v);
                else sb.Append(template, i, close - i + 1);
                i = close;
            }
            return sb.ToString();
        }

        public static string Render(string code, IDictionary<string, string> args, bool zh)
        {
            return Interpolate(Template(code, zh), args);
        }
    }
}
