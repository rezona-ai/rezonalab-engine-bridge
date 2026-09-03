using System;
using System.Collections.Generic;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>协议 v1 的常量与数据形状。字段与 protocol/schema/messages.schema.json 一一对应。</summary>
    public static class Protocol
    {
        public const int Version = 1;
        public const string WsPath = "/rezona-bridge";
        public const string AssetsSubdir = "RezonaAssets";
        public const int MaxTextBytes = 64 * 1024;
        public const int MaxHeaderBytes = 1024;
        public const int ImportTimeoutMs = 30_000;

        public static readonly string[] DefaultFormats = { "glb", "png", "jpg", "jpeg", "webp", "mp3", "wav", "ogg", "zip" };

        public static readonly string[] AssetKinds = { "model3d", "image", "audio", "sprite", "other" };

        public static readonly string[] ErrorCodes =
        {
            "CHECKSUM_MISMATCH", "ZIP_UNSAFE_ENTRY", "ZIP_TOO_MANY_ENTRIES", "ZIP_TOO_LARGE",
            "UNSUPPORTED_FORMAT", "TOO_LARGE", "TOO_MANY_CHUNKS",
            "IMPORT_FAILED", "IMPORT_TIMEOUT", "PROJECT_NOT_OPEN", "PROTOCOL_MISMATCH", "INTERNAL",
        };

        /// <summary>Unity 固定端口段（spec 第 1 节）。</summary>
        public const int UnityPortStart = 41720;
        public const int UnityPortEnd = 41739;
    }

    /// <summary>WebSocket 关闭码（spec 第 5 节）。</summary>
    public static class CloseCode
    {
        public const ushort Normal = 1000;
        public const ushort BadFrame = 4400;
        public const ushort OriginRejected = 4403;
        public const ushort HeartbeatTimeout = 4408;
        public const ushort Busy = 4409;
        public const ushort LimitExceeded = 4413;
        public const ushort ProtocolMismatch = 4426;
    }

    /// <summary>hello_ack 里公布的限额。</summary>
    public sealed class Limits
    {
        public long ChunkBytes = 4L * 1024 * 1024;
        public long MaxFileBytes = 512L * 1024 * 1024;
        public long MaxChunks = 128;

        public Limits Clone()
        {
            return new Limits { ChunkBytes = ChunkBytes, MaxFileBytes = MaxFileBytes, MaxChunks = MaxChunks };
        }
    }

    public sealed class ProjectInfo
    {
        public string Name;
        public string Id;

        public ProjectInfo(string name, string id)
        {
            Name = name;
            Id = id;
        }
    }

    /// <summary>transfer_begin 的已校验字段（Schema 层面）。业务层校验在 Receiver.ValidateBegin。</summary>
    public sealed class TransferBegin
    {
        public string TransferId;
        public string FileName;
        public long ByteSize;
        public string Sha256;
        public string Kind;
        public long ChunkBytes;
        public long ChunkCount;
        public string ItemId;      // meta.itemId，可为 null
        public string DisplayName; // meta.displayName，可为 null
    }

    /// <summary>每连接的传输子状态机。字符串值与夹具 finalState 一致。</summary>
    public enum SessionState
    {
        Idle,
        Ready,
        Receiving,
        Importing,
    }

    /// <summary>面板可见的服务端三态。</summary>
    public enum ServerState
    {
        Stopped,
        Listening,
        Busy,
    }

    public enum LogLevel
    {
        Info,
        Warn,
        Error,
    }

    public sealed class LogEntry
    {
        public DateTime At;
        public LogLevel Level;
        public string Message;
    }

    public sealed class ProgressInfo
    {
        public string TransferId;
        public string FileName;
        public int Percent;
        /// <summary>receiving / importing / done / failed</summary>
        public string Stage;
    }

    /// <summary>面板一次拉取的完整快照。</summary>
    public sealed class ServerSnapshot
    {
        public ServerState State;
        public int? Port;
        public string Engine;
        public ProjectInfo Project;
        public bool Connected;
        public string ClientOrigin;
        public ProgressInfo Progress;
        public List<LogEntry> Logs;
        public List<string> OriginAllowlist;
        public string LastError;
    }

    public static class SessionStateNames
    {
        public static string ToWire(SessionState s)
        {
            switch (s)
            {
                case SessionState.Idle: return "idle";
                case SessionState.Ready: return "ready";
                case SessionState.Receiving: return "receiving";
                default: return "importing";
            }
        }
    }

    /// <summary>带协议错误码的异常；内核内部统一抛这个，边界处转成 error 帧 / import_result。</summary>
    public sealed class BridgeException : Exception
    {
        public string Code { get; }

        public BridgeException(string code, string message) : base(message)
        {
            Code = code;
        }
    }
}
