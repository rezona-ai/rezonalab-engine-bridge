export const PING_INTERVAL_MS = 15_000;
export const IDLE_TIMEOUT_MS = 60_000;

export type HeartbeatEvent = 'ping' | 'timeout';

/**
 * 心跳用虚拟时钟：所有时间都由调用方通过 `advance()` 推进，
 * 生产环境用 setInterval 喂真实流逝时间，夹具测试用 tick 帧喂假时间，同一份逻辑。
 * 规则：每 15 秒发一次 ping；60 秒没收到任何入向帧则超时。整点相撞时先判超时。
 */
export class Heartbeat {
  private now = 0;
  private lastInboundAt = 0;
  private nextPingAt: number;
  private readonly pingInterval: number;
  private readonly idleTimeout: number;

  constructor(opts: { pingIntervalMs?: number; idleTimeoutMs?: number } = {}) {
    this.pingInterval = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.idleTimeout = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.nextPingAt = this.pingInterval;
  }

  /** 任何入向帧（文本或二进制）都算活着。 */
  onInboundFrame(): void {
    this.lastInboundAt = this.now;
  }

  /** 推进 delta 毫秒，按时间顺序返回期间应发生的事件；一旦 timeout 就停止。 */
  advance(deltaMs: number): HeartbeatEvent[] {
    const target = this.now + deltaMs;
    const events: HeartbeatEvent[] = [];
    for (;;) {
      const deadline = this.lastInboundAt + this.idleTimeout;
      const next = Math.min(deadline, this.nextPingAt);
      if (next > target) break;
      this.now = next;
      if (deadline <= this.nextPingAt) {
        events.push('timeout');
        return events;
      }
      events.push('ping');
      this.nextPingAt += this.pingInterval;
    }
    this.now = target;
    return events;
  }
}
