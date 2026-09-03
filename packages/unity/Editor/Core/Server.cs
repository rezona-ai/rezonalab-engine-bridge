using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using WebSocketSharp;
using WebSocketSharp.Server;

namespace RezonaLab.EngineBridge.Editor
{
    public sealed class BridgeServerConfig
    {
        public string Engine = "unity";
        public string EngineVersion = "";
        public string PluginVersion = "0.1.0";
        public ProjectInfo Project;
        public string AssetsRoot;
        public int PortStart = Protocol.UnityPortStart;
        public int PortEnd = Protocol.UnityPortEnd;
        public IEngineAdapter Adapter;
        /// <summary>追加到默认白名单之后的额外来源（开发者在面板「高级」里填）。</summary>
        public IList<string> ExtraOrigins;
        /// <summary>完全替换默认白名单（测试用）；一般用 ExtraOrigins。</summary>
        public IList<string> OriginAllowlist;
        public Limits Limits = new Limits();
        public string[] Formats = Protocol.DefaultFormats;
        public string TmpDir;
        public int ImportTimeoutMs = Protocol.ImportTimeoutMs;
    }

    /// <summary>
    /// 把内核装配成一个只监听 127.0.0.1 的 websocket-sharp 服务端。单客户端策略：
    /// 已有连接忙（receiving / importing）→ 新连接 4409；否则新连接替换旧连接（旧的 1000）。
    /// websocket-sharp 的回调都在后台线程；对外事件一律经 MainThread.Enqueue 投递，面板订阅时不用再自己切线程。
    /// </summary>
    public sealed class BridgeServer : IDisposable
    {
        public const int MaxLogLines = 200;
        private const int HeartbeatTickMs = 1000;

        public event Action<ServerState> StateChanged;
        public event Action<ProgressInfo> ProgressChanged;
        public event Action<LogEntry> Logged;
        public event Action<bool, string> ConnectionChanged;

        private readonly BridgeServerConfig _config;
        private readonly List<string> _originAllowlist;
        private readonly string _tmpDir;
        private readonly object _lock = new object();
        private readonly List<LogEntry> _logs = new List<LogEntry>();
        private WebSocketServer _wss;
        private int? _port;
        private ConnectionHandle _current;
        private ProgressInfo _progress;
        private string _lastError;
        private ServerState _state = ServerState.Stopped;

        internal sealed class ConnectionHandle
        {
            public BridgeBehavior Behavior;
            public Session Session;
            public Timer Timer;
            public string Origin;
            public long LastTick;
        }

        public BridgeServer(BridgeServerConfig config)
        {
            _config = config;
            _originAllowlist = new List<string>(config.OriginAllowlist ?? (IList<string>)Origin.DefaultAllowlist);
            if (config.ExtraOrigins != null) _originAllowlist.AddRange(config.ExtraOrigins);
            _tmpDir = config.TmpDir ?? Path.Combine(Path.GetTempPath(), "rezona-bridge");
        }

        public int? Port => _port;
        public ServerState State => _state;
        public bool IsRunning => _wss != null;

        /// <summary>从段首顺延找空闲端口并监听；全占抛 PortsExhaustedException。</summary>
        public int Start()
        {
            lock (_lock)
            {
                if (_wss != null) return _port.Value;
                Directory.CreateDirectory(_tmpDir);
                var from = _config.PortStart;
                for (;;)
                {
                    // 先探测再真正 bind；探测到 bind 之间的竞争窗口由「Start 失败就继续下一个」兜住
                    var port = Ports.FindFirstFree(_config.PortStart, _config.PortEnd, from);
                    var wss = new WebSocketServer(IPAddress.Loopback, port);
                    wss.ReuseAddress = false;
                    wss.Log.Level = WebSocketSharp.LogLevel.Fatal;
                    BridgeBehavior.Owner = this;
                    // Origin 在握手阶段（OnOpen 之前）就拒绝：非法来源连 WebSocket 都建不起来。OnOpen 里再挡一道兜底。
                    var allowlist = _originAllowlist;
                    // 1.0.3-rc11 只有 Func<T> creator 重载（没有 Action<T> initializer），所以在构造时就挂上 OriginValidator。
                    wss.AddWebSocketService<BridgeBehavior>(Protocol.WsPath, () => new BridgeBehavior { OriginValidator = o => Origin.IsAllowed(o, allowlist) });
                    try
                    {
                        wss.Start();
                    }
                    catch (Exception)
                    {
                        // 落到下面的 IsListening 判断
                    }
                    if (wss.IsListening)
                    {
                        _wss = wss;
                        _port = port;
                        break;
                    }
                    try { wss.Stop(); } catch (Exception) { /* 未起 */ }
                    if (port >= _config.PortEnd) throw new PortsExhaustedException(_config.PortStart, _config.PortEnd);
                    from = port + 1;
                }
                _lastError = null;
            }
            Log(LogLevel.Info, "监听中 127.0.0.1:" + _port + Protocol.WsPath);
            RecomputeState();
            return _port.Value;
        }

        public void Stop()
        {
            DropCurrent(CloseCode.Normal, "server stopping");
            WebSocketServer w;
            lock (_lock)
            {
                w = _wss;
                _wss = null;
                _port = null;
                _progress = null;
            }
            if (w != null)
            {
                try { w.Stop(CloseCode.Normal, "server stopping"); } catch (Exception) { /* 已停 */ }
                Log(LogLevel.Info, "已停止");
            }
            RecomputeState();
        }

        public void Dispose() => Stop();

        public ServerSnapshot Snapshot()
        {
            lock (_lock)
            {
                return new ServerSnapshot
                {
                    State = _state,
                    Port = _port,
                    Engine = _config.Engine,
                    Project = _config.Project,
                    Connected = _current != null,
                    ClientOrigin = _current?.Origin,
                    Progress = _progress,
                    Logs = new List<LogEntry>(_logs),
                    OriginAllowlist = new List<string>(_originAllowlist),
                    LastError = _lastError,
                };
            }
        }

        public void ClearLogs()
        {
            lock (_lock) _logs.Clear();
        }

        // ---------- websocket-sharp 回调（后台线程） ----------

        internal void OnOpen(BridgeBehavior behavior, string origin)
        {
            // 先验 Origin 再碰 _current：非法来源绝不能把现有合法连接踢掉（否则任意网页可反复打断桥接）。
            if (!Origin.IsAllowed(origin, _originAllowlist))
            {
                Log(LogLevel.Warn, "拒绝来源 " + (origin ?? "(缺 Origin 头)"));
                behavior.CloseWith(CloseCode.OriginRejected, "origin not allowed");
                return;
            }
            ConnectionHandle old = null;
            lock (_lock)
            {
                if (_current != null && _current.Session.IsBusy)
                {
                    behavior.CloseWith(CloseCode.Busy, "busy");
                    Log(LogLevel.Warn, "已有传输进行中，拒绝新连接");
                    return;
                }
                old = _current;
                _current = null;
            }
            if (old != null) Drop(old, CloseCode.Normal, "replaced by new connection");

            var session = new Session(origin, new SessionConfig
            {
                Engine = _config.Engine,
                EngineVersion = _config.EngineVersion,
                PluginVersion = _config.PluginVersion,
                Project = _config.Project,
                AssetsRoot = _config.AssetsRoot,
                TmpDir = _tmpDir,
                OriginAllowlist = _originAllowlist,
                Limits = _config.Limits,
                Formats = _config.Formats,
                Adapter = _config.Adapter,
                ImportTimeoutMs = _config.ImportTimeoutMs,
            }, behavior, new SessionHooks
            {
                OnLog = Log,
                OnStateChange = _ => RecomputeState(),
                OnProgress = info =>
                {
                    lock (_lock) _progress = info;
                    Emit(() => ProgressChanged?.Invoke(info));
                },
            });
            if (!session.Open()) return;

            var conn = new ConnectionHandle { Behavior = behavior, Session = session, Origin = origin, LastTick = Environment.TickCount };
            conn.Timer = new Timer(_ =>
            {
                var now = (long)Environment.TickCount;
                var delta = now - conn.LastTick;
                conn.LastTick = now;
                if (delta > 0) session.Advance(delta);
            }, null, HeartbeatTickMs, HeartbeatTickMs);
            behavior.Connection = conn;
            lock (_lock) _current = conn;
            Emit(() => ConnectionChanged?.Invoke(true, origin));
            RecomputeState();
        }

        internal void OnMessage(BridgeBehavior behavior, MessageEventArgs e)
        {
            var conn = behavior.Connection;
            if (conn == null) return;
            var task = e.IsBinary ? conn.Session.HandleBinary(e.RawData) : conn.Session.HandleText(e.Data);
            task.ContinueWith(t => Log(LogLevel.Error, "处理帧时异常：" + t.Exception?.GetBaseException().Message), TaskContinuationOptions.OnlyOnFaulted);
        }

        internal void OnClose(BridgeBehavior behavior)
        {
            var conn = behavior.Connection;
            if (conn == null) return;
            lock (_lock)
            {
                if (_current != conn) return;
                _current = null;
            }
            conn.Timer.Dispose();
            conn.Session.Dispose();
            Emit(() => ConnectionChanged?.Invoke(false, null));
            RecomputeState();
        }

        // ---------- 内部 ----------

        private void DropCurrent(ushort code, string reason)
        {
            ConnectionHandle c;
            lock (_lock)
            {
                c = _current;
                _current = null;
            }
            if (c != null) Drop(c, code, reason);
        }

        private void Drop(ConnectionHandle c, ushort code, string reason)
        {
            c.Timer.Dispose();
            c.Behavior.CloseWith(code, reason);
            c.Session.Dispose();
            Emit(() => ConnectionChanged?.Invoke(false, null));
            RecomputeState();
        }

        private void Log(LogLevel level, string msg)
        {
            var entry = new LogEntry { At = DateTime.Now, Level = level, Message = msg };
            lock (_lock)
            {
                _logs.Add(entry);
                if (_logs.Count > MaxLogLines) _logs.RemoveRange(0, _logs.Count - MaxLogLines);
                if (level == LogLevel.Error) _lastError = msg;
            }
            Emit(() => Logged?.Invoke(entry));
        }

        private void RecomputeState()
        {
            ServerState next;
            lock (_lock)
            {
                if (_wss == null) next = ServerState.Stopped;
                else next = _current != null && _current.Session.IsBusy ? ServerState.Busy : ServerState.Listening;
                if (_state == next) return;
                _state = next;
            }
            Emit(() => StateChanged?.Invoke(next));
        }

        private static void Emit(Action a) => MainThread.Enqueue(a);
    }

    /// <summary>
    /// 每连接一个实例，由 websocket-sharp 构造（无参构造），所以用静态 Owner 找回服务端。
    /// Origin 校验先在握手阶段的 OriginValidator 拒绝；OnOpen 一进来（碰任何状态之前）再由 BridgeServer 复核一次，不通过 4403。
    /// </summary>
    public sealed class BridgeBehavior : WebSocketBehavior, ISessionSink
    {
        internal static BridgeServer Owner;
        internal BridgeServer.ConnectionHandle Connection;

        protected override void OnOpen()
        {
            var owner = Owner;
            if (owner == null)
            {
                CloseWith(CloseCode.Normal, "server gone");
                return;
            }
            string origin = null;
            try { origin = Context.Origin; } catch (Exception) { /* 无 Origin */ }
            if (string.IsNullOrEmpty(origin))
            {
                try { origin = Context.Headers["Origin"]; } catch (Exception) { /* 无 Origin */ }
            }
            owner.OnOpen(this, string.IsNullOrEmpty(origin) ? null : origin);
        }

        protected override void OnMessage(MessageEventArgs e) => Owner?.OnMessage(this, e);

        protected override void OnClose(CloseEventArgs e) => Owner?.OnClose(this);

        protected override void OnError(WebSocketSharp.ErrorEventArgs e)
        {
            // 连接级错误随后必有 OnClose；这里不做状态变更
        }

        void ISessionSink.Send(string text)
        {
            try { Send(text); }
            catch (Exception) { /* 对端已断，随后 OnClose 收尾 */ }
        }

        void ISessionSink.Close(int code, string reason) => CloseWith((ushort)code, reason);

        internal void CloseWith(ushort code, string reason)
        {
            try { Sessions.CloseSession(ID, code, reason); }
            catch (Exception) { /* 已关 */ }
        }
    }
}
