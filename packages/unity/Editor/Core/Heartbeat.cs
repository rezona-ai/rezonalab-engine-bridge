using System.Collections.Generic;

namespace RezonaLab.EngineBridge.Editor
{
    public enum HeartbeatEvent
    {
        Ping,
        Timeout,
    }

    /// <summary>
    /// 心跳用虚拟时钟：所有时间都由调用方通过 Advance 推进，生产用定时器喂真实流逝毫秒，夹具用 tick 帧喂假时间，同一份逻辑。
    /// 规则：每 15 秒发一次 ping；60 秒没收到任何入向帧则超时。整点相撞时先判超时。
    /// 网络线程与定时器线程都会碰它，所以内部加锁。
    /// </summary>
    public sealed class Heartbeat
    {
        public const long PingIntervalMs = 15_000;
        public const long IdleTimeoutMs = 60_000;

        private readonly object _lock = new object();
        private long _now;
        private long _lastInboundAt;
        private long _nextPingAt;
        private readonly long _pingInterval;
        private readonly long _idleTimeout;

        public Heartbeat(long? pingIntervalMs = null, long? idleTimeoutMs = null)
        {
            _pingInterval = pingIntervalMs ?? PingIntervalMs;
            _idleTimeout = idleTimeoutMs ?? IdleTimeoutMs;
            _nextPingAt = _pingInterval;
        }

        /// <summary>任何入向帧（文本或二进制）都算活着。</summary>
        public void OnInboundFrame()
        {
            lock (_lock) _lastInboundAt = _now;
        }

        /// <summary>推进 delta 毫秒，按时间顺序返回期间应发生的事件；一旦 Timeout 就停止。</summary>
        public List<HeartbeatEvent> Advance(long deltaMs)
        {
            var events = new List<HeartbeatEvent>();
            lock (_lock)
            {
                var target = _now + deltaMs;
                for (;;)
                {
                    var deadline = _lastInboundAt + _idleTimeout;
                    var next = deadline < _nextPingAt ? deadline : _nextPingAt;
                    if (next > target) break;
                    _now = next;
                    if (deadline <= _nextPingAt)
                    {
                        events.Add(HeartbeatEvent.Timeout);
                        return events;
                    }
                    events.Add(HeartbeatEvent.Ping);
                    _nextPingAt += _pingInterval;
                }
                _now = target;
            }
            return events;
        }
    }
}
