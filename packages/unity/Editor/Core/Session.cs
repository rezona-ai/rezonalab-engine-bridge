using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace RezonaLab.EngineBridge.Editor
{
    /// <summary>连接另一端的抽象：生产是 websocket-sharp 会话，夹具测试是收集器。</summary>
    public interface ISessionSink
    {
        void Send(string text);
        void Close(int code, string reason);
    }

    public sealed class SessionConfig
    {
        public string Engine;
        public string EngineVersion;
        public string PluginVersion;
        public ProjectInfo Project;
        /// <summary>工程资产根（Unity 为 &lt;project&gt;/Assets）。</summary>
        public string AssetsRoot;
        /// <summary>临时目录，.part 文件放这里。</summary>
        public string TmpDir;
        public IList<string> OriginAllowlist;
        public Limits Limits;
        public string[] Formats;
        public IEngineAdapter Adapter;
        public int ImportTimeoutMs = Protocol.ImportTimeoutMs;
        public long? PingIntervalMs;
        public long? IdleTimeoutMs;
    }

    public sealed class SessionHooks
    {
        public Action<SessionState> OnStateChange;
        public Action<ProgressInfo> OnProgress;
        public Action<LogLevel, string> OnLog;
    }

    /// <summary>
    /// 一条 WebSocket 连接的完整协议状态机：idle → ready → receiving → importing → ready。
    /// 与传输层无关（通过 ISessionSink 出帧），与时钟无关（通过 Advance 推进），因此夹具能完整驱动它。
    /// 所有入向处理串行化：即便对端不等 ack 连发，也按到达顺序逐帧处理。
    /// 内部所有 await 都 ConfigureAwait(false)：测试可能在主线程上阻塞等待，不能让续体回流到主线程同步上下文。
    /// </summary>
    public sealed class Session
    {
        public string OriginHeader { get; }
        public SessionState State { get; private set; } = SessionState.Idle;

        private readonly SessionConfig _config;
        private readonly ISessionSink _sink;
        private readonly SessionHooks _hooks;
        private readonly Heartbeat _heartbeat;
        private readonly object _lock = new object();
        private Task _queue = Task.CompletedTask;
        private volatile bool _closed;
        private TransferReceiver _receiver;
        private string _currentKind;
        private string _currentItemId;
        private string _currentDisplayName;

        public Session(string originHeader, SessionConfig config, ISessionSink sink, SessionHooks hooks = null)
        {
            OriginHeader = originHeader;
            _config = config;
            _sink = sink;
            _hooks = hooks ?? new SessionHooks();
            _heartbeat = new Heartbeat(config.PingIntervalMs, config.IdleTimeoutMs);
        }

        public bool IsBusy => State == SessionState.Receiving || State == SessionState.Importing;
        public bool IsClosed => _closed;

        /// <summary>连接建立后第一步：Origin 白名单。不通过直接 4403，不发任何帧。</summary>
        public bool Open()
        {
            if (!Origin.IsAllowed(OriginHeader, _config.OriginAllowlist))
            {
                Log(LogLevel.Warn, "拒绝来源 " + (OriginHeader ?? "(缺 Origin 头)"));
                Close(CloseCode.OriginRejected, "origin not allowed");
                return false;
            }
            return true;
        }

        public Task HandleText(string raw) => Enqueue(() => ProcessText(raw));

        public Task HandleBinary(byte[] buf) => Enqueue(() => ProcessBinary(buf));

        /// <summary>推进虚拟时钟；生产由定时器喂真实流逝毫秒。</summary>
        public void Advance(long deltaMs)
        {
            if (_closed) return;
            foreach (var ev in _heartbeat.Advance(deltaMs))
            {
                if (ev == HeartbeatEvent.Ping) Send(new JsonObject().Set("type", "ping"));
                else
                {
                    Log(LogLevel.Warn, "心跳超时，关闭连接");
                    Close(CloseCode.HeartbeatTimeout, "heartbeat timeout");
                    return;
                }
            }
        }

        /// <summary>连接已由对端关闭：清临时文件、回到 idle。</summary>
        public void Dispose()
        {
            _closed = true;
            CleanupTransfer();
            SetState(SessionState.Idle);
        }

        private Task Enqueue(Func<Task> task)
        {
            lock (_lock)
            {
                var run = _queue.ContinueWith(_ => task(), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default).Unwrap();
                _queue = run.ContinueWith(_ => { }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
                return run;
            }
        }

        private async Task ProcessText(string raw)
        {
            if (_closed) return;
            _heartbeat.OnInboundFrame();
            ParsedMessage msg;
            string error;
            if (!Framing.TryParseText(raw, out msg, out error)) { Fail(CloseCode.BadFrame, error); return; }

            if (State == SessionState.Idle)
            {
                if (msg.Type != "hello") { Fail(CloseCode.BadFrame, "expected hello, got " + msg.Type); return; }
                var protocol = (long)(double)msg.Raw["protocol"];
                if (protocol != Protocol.Version)
                {
                    SendError("PROTOCOL_MISMATCH", "unsupported protocol " + protocol + ", plugin speaks " + Protocol.Version);
                    Fail(CloseCode.ProtocolMismatch, "protocol mismatch");
                    return;
                }
                Send(BuildHelloAck());
                SetState(SessionState.Ready);
                Log(LogLevel.Info, "客户端已连接：" + msg.Raw["client"] + " " + msg.Raw["clientVersion"]);
                return;
            }

            switch (msg.Type)
            {
                case "ping":
                    Send(new JsonObject().Set("type", "pong"));
                    return;
                case "pong":
                    return;
                case "hello":
                    Fail(CloseCode.BadFrame, "duplicate hello");
                    return;
                case "transfer_begin":
                    OnBegin(Framing.ToTransferBegin(msg.Raw));
                    return;
                case "transfer_end":
                    await OnEnd((string)msg.Raw["transferId"]).ConfigureAwait(false);
                    return;
                default:
                    Fail(CloseCode.BadFrame, "unexpected message " + msg.Type + " from client");
                    return;
            }
        }

        private Task ProcessBinary(byte[] buf)
        {
            if (_closed) return Task.CompletedTask;
            _heartbeat.OnInboundFrame();
            if (State != SessionState.Receiving || _receiver == null) { Fail(CloseCode.BadFrame, "binary frame outside of a transfer"); return Task.CompletedTask; }
            ParsedBinary parsed;
            string error;
            if (!Framing.TryParseBinary(buf, out parsed, out error)) { Fail(CloseCode.BadFrame, error); return Task.CompletedTask; }
            if (parsed.Header.TransferId != _receiver.TransferId) { Fail(CloseCode.BadFrame, "chunk for unknown transferId"); return Task.CompletedTask; }
            try
            {
                _receiver.WriteChunk(parsed.Header.Index, parsed.Data, parsed.DataOffset, parsed.DataLength);
            }
            catch (FrameOrderException ex) { Fail(CloseCode.BadFrame, ex.Message); return Task.CompletedTask; }
            catch (LimitException ex) { Fail(CloseCode.LimitExceeded, ex.Message); return Task.CompletedTask; }
            catch (Exception ex)
            {
                Log(LogLevel.Error, "写入分块失败：" + ex.Message);
                Fail(CloseCode.BadFrame, "chunk write failed");
                return Task.CompletedTask;
            }
            Send(new JsonObject().Set("type", "chunk_ack").Set("transferId", parsed.Header.TransferId).Set("index", (double)parsed.Header.Index));
            Progress(_receiver.TransferId, _receiver.FileName, _receiver.Percent, "receiving");
            return Task.CompletedTask;
        }

        private void OnBegin(TransferBegin msg)
        {
            if (IsBusy) { Fail(CloseCode.Busy, "transfer already in progress"); return; }
            if (State != SessionState.Ready) { Fail(CloseCode.BadFrame, "transfer_begin before hello"); return; }
            if (!_config.Adapter.IsProjectOpen())
            {
                SendError("PROJECT_NOT_OPEN", "no project is open in the editor", msg.TransferId);
                Fail(CloseCode.Busy, "project not open");
                return;
            }
            var rejection = TransferReceiver.ValidateBegin(msg, _config.Limits, _config.Formats);
            if (rejection != null)
            {
                if (rejection.Kind == BeginRejection.RejectionKind.Limit)
                {
                    SendError(rejection.Code, rejection.Message, msg.TransferId);
                    Fail(CloseCode.LimitExceeded, rejection.Message);
                    return;
                }
                if (rejection.Kind == BeginRejection.RejectionKind.BadFrame) { Fail(CloseCode.BadFrame, rejection.Message); return; }
                SendError(rejection.Code, rejection.Message, msg.TransferId);
                Log(LogLevel.Warn, "拒绝传输 " + msg.FileName + "：" + rejection.Message);
                return;
            }
            var receiver = new TransferReceiver(msg, _config.TmpDir);
            try
            {
                receiver.Open();
            }
            catch (Exception ex)
            {
                receiver.Dispose();
                Log(LogLevel.Error, "无法创建临时文件：" + ex.Message);
                SendError("INTERNAL", "cannot open temp file", msg.TransferId);
                return;
            }
            _receiver = receiver;
            _currentKind = msg.Kind;
            _currentItemId = msg.ItemId;
            _currentDisplayName = msg.DisplayName;
            SetState(SessionState.Receiving);
            Log(LogLevel.Info, "开始接收 " + msg.FileName + "（" + msg.ByteSize + " 字节，" + msg.ChunkCount + " 块）");
            Progress(msg.TransferId, msg.FileName, 0, "receiving");
        }

        private async Task OnEnd(string transferId)
        {
            if (State != SessionState.Receiving || _receiver == null || _receiver.TransferId != transferId)
            {
                Fail(CloseCode.BadFrame, "transfer_end without matching transfer");
                return;
            }
            var receiver = _receiver;
            var reason = receiver.Finish();
            if (reason != null)
            {
                Log(LogLevel.Warn, receiver.FileName + " 校验失败：" + reason);
                FinishTransfer(ImportResultError(transferId, "CHECKSUM_MISMATCH", reason), "failed");
                return;
            }
            Send(new JsonObject().Set("type", "import_progress").Set("transferId", transferId).Set("stage", "received"));
            var destDir = Path.Combine(_config.AssetsRoot, Protocol.AssetsSubdir);
            string importPath;
            try
            {
                if (TransferReceiver.ExtensionOf(receiver.FileName) == "zip")
                {
                    var stem = receiver.FileName.Substring(0, receiver.FileName.Length - Path.GetExtension(receiver.FileName).Length);
                    var zipDir = TransferReceiver.UniquePath(destDir, stem);
                    try { ZipSafe.Extract(receiver.PartPath, zipDir); }
                    finally { receiver.Abort(); }
                    importPath = zipDir;
                }
                else
                {
                    importPath = receiver.MoveTo(destDir);
                }
            }
            catch (Exception ex)
            {
                receiver.Abort();
                var e = ex as BridgeException ?? new BridgeException("INTERNAL", ex.Message);
                Log(LogLevel.Warn, receiver.FileName + " 落盘失败：" + e.Message);
                FinishTransfer(ImportResultError(transferId, e.Code, e.Message), "failed");
                return;
            }

            SetState(SessionState.Importing);
            Send(new JsonObject().Set("type", "import_progress").Set("transferId", transferId).Set("stage", "importing"));
            Progress(transferId, receiver.FileName, 100, "importing");
            ImportOutcome outcome;
            try
            {
                var meta = new ImportMeta
                {
                    Kind = _currentKind ?? "other",
                    FileName = Path.GetFileName(importPath),
                    ItemId = _currentItemId,
                    DisplayName = _currentDisplayName,
                    TransferId = transferId,
                };
                outcome = await WithTimeout(_config.Adapter.ImportFile(importPath, meta), _config.ImportTimeoutMs).ConfigureAwait(false);
                if (outcome == null) throw new BridgeException("IMPORT_FAILED", "adapter returned no outcome");
            }
            catch (Exception ex)
            {
                var e = ex as BridgeException ?? new BridgeException("IMPORT_FAILED", ex.Message);
                Log(LogLevel.Error, receiver.FileName + " 导入失败：" + e.Code + " " + e.Message);
                FinishTransfer(ImportResultError(transferId, e.Code, e.Message), "failed");
                return;
            }
            Log(LogLevel.Info, receiver.FileName + " 已导入：" + outcome.SavedPath);
            var result = new JsonObject().Set("type", "import_result").Set("transferId", transferId).Set("ok", true).Set("savedPath", outcome.SavedPath);
            if (!string.IsNullOrEmpty(outcome.SceneNode)) result.Set("sceneNode", outcome.SceneNode);
            FinishTransfer(result, "done");
        }

        private static JsonObject ImportResultError(string transferId, string code, string message)
        {
            return new JsonObject().Set("type", "import_result").Set("transferId", transferId).Set("ok", false)
                .Set("error", new JsonObject().Set("code", code).Set("message", message));
        }

        private JsonObject BuildHelloAck()
        {
            var formats = new List<object>();
            foreach (var f in _config.Formats) formats.Add(f);
            return new JsonObject()
                .Set("type", "hello_ack")
                .Set("protocol", (double)Protocol.Version)
                .Set("engine", _config.Engine)
                .Set("engineVersion", _config.EngineVersion)
                .Set("pluginVersion", _config.PluginVersion)
                .Set("project", new JsonObject().Set("name", _config.Project.Name).Set("id", _config.Project.Id))
                .Set("limits", new JsonObject()
                    .Set("chunkBytes", (double)_config.Limits.ChunkBytes)
                    .Set("maxFileBytes", (double)_config.Limits.MaxFileBytes)
                    .Set("maxChunks", (double)_config.Limits.MaxChunks))
                .Set("formats", formats);
        }

        private void FinishTransfer(JsonObject result, string stage)
        {
            var receiver = _receiver;
            _receiver = null;
            _currentKind = null;
            _currentItemId = null;
            _currentDisplayName = null;
            SetState(SessionState.Ready);
            Send(result);
            if (receiver != null)
            {
                receiver.Dispose();
                Progress(receiver.TransferId, receiver.FileName, 100, stage);
            }
        }

        private void CleanupTransfer()
        {
            var r = _receiver;
            _receiver = null;
            _currentKind = null;
            _currentItemId = null;
            _currentDisplayName = null;
            if (r != null)
            {
                r.Abort();
                r.Dispose();
                _hooks.OnProgress?.Invoke(null);
            }
        }

        private void Fail(int code, string reason)
        {
            Log(LogLevel.Warn, "关闭连接（" + code + "）：" + reason);
            CleanupTransfer();
            Close(code, reason);
        }

        private void Close(int code, string reason)
        {
            lock (_lock)
            {
                if (_closed) return;
                _closed = true;
            }
            SetState(SessionState.Idle);
            _sink.Close(code, reason);
        }

        private void Send(JsonObject msg)
        {
            if (_closed) return;
            _sink.Send(Framing.EncodeText(msg));
        }

        private void SendError(string code, string message, string transferId = null)
        {
            var msg = new JsonObject().Set("type", "error").Set("code", code).Set("message", message);
            if (transferId != null) msg.Set("transferId", transferId);
            Send(msg);
        }

        private void SetState(SessionState state)
        {
            if (State == state) return;
            State = state;
            _hooks.OnStateChange?.Invoke(state);
        }

        private void Progress(string transferId, string fileName, int percent, string stage)
        {
            _hooks.OnProgress?.Invoke(new ProgressInfo { TransferId = transferId, FileName = fileName, Percent = percent, Stage = stage });
        }

        private void Log(LogLevel level, string msg) => _hooks.OnLog?.Invoke(level, msg);

        private static async Task<T> WithTimeout<T>(Task<T> task, int ms)
        {
            using (var cts = new CancellationTokenSource())
            {
                var delay = Task.Delay(ms, cts.Token);
                var winner = await Task.WhenAny(task, delay).ConfigureAwait(false);
                if (winner != task) throw new BridgeException("IMPORT_TIMEOUT", "import did not finish within " + ms + " ms");
                cts.Cancel();
                return await task.ConfigureAwait(false);
            }
        }
    }
}
