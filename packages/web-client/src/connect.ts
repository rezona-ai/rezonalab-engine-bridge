import { isChromium142Plus } from './lna.js';
import type { HelloAckMessage, Limits, PortRange } from './protocol-types.js';
import { CLIENT_NAME, CLIENT_VERSION, getEngine, type EngineKey } from './engines.js';
import { BridgeClientError } from './errors.js';
import { isVersionAtLeast } from './semver.js';
import { SocketChannel, bridgeUrl, defaultSocketFactory, type Inbound, type SocketFactory } from './socket.js';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PROBE_TIMEOUT_MS = 800;
export const DEFAULT_PING_INTERVAL_MS = 5_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;
/** 全部端口在这么短的时间内一起 error 且无一 open，才怀疑是浏览器层（LNA）拒绝而非「没有引擎在听」。 */
export const DEFAULT_LNA_SUSPECT_MS = 50;
const CLOSE_PROTOCOL_MISMATCH = 4426;
const CLOSE_HEARTBEAT = 4408;

/** 探测到的一个引擎实例（一个正在运行的工程）。 */
export interface EngineInstance {
  port: number;
  engine: string;
  engineVersion: string;
  pluginVersion: string;
  project: { name: string; id: string };
  limits: Limits;
  formats: string[];
}

export interface ConnectOptions {
  /** 覆盖引擎默认端口段（测试用，避免撞真实引擎）。 */
  portRange?: PortRange;
  probeTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  lnaSuspectMs?: number;
  /** 浏览器 UA；LNA 拒绝的判定只对 Chromium 142+ 生效，其它浏览器瞬间 error 就是普通的 ECONNREFUSED。默认取 navigator.userAgent。 */
  userAgent?: string;
  clientVersion?: string;
  minPluginVersion?: string;
  /** 注入 socket 构造（测试用 `ws`，生产用原生 WebSocket）。 */
  createSocket?: SocketFactory;
}

export interface CloseInfo {
  code: number;
  /** 心跳超时判掉线时固定为 'HEARTBEAT'，其余为对端 / 本地给的关闭原因。 */
  reason: string;
}

export interface BridgeConnection {
  readonly instance: EngineInstance;
  readonly state: 'open' | 'closed';
  /** 有传输在飞；此时不许切换开关、第二个 send 直接 BUSY。 */
  readonly busy: boolean;
  onClose(cb: (info: CloseInfo) => void): void;
  onError(cb: (err: BridgeClientError) => void): void;
  close(): void;
}

interface ResolvedOptions {
  userAgent: string;
  probeTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  lnaSuspectMs: number;
  clientVersion: string;
  minPluginVersion: string;
  createSocket: SocketFactory;
}

function resolve(opts: ConnectOptions, minPluginVersion: string): ResolvedOptions {
  return {
    probeTimeoutMs: opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    pingIntervalMs: opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
    pongTimeoutMs: opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
    lnaSuspectMs: opts.lnaSuspectMs ?? DEFAULT_LNA_SUSPECT_MS,
    userAgent: opts.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
    clientVersion: opts.clientVersion ?? CLIENT_VERSION,
    minPluginVersion: opts.minPluginVersion ?? minPluginVersion,
    createSocket: opts.createSocket ?? defaultSocketFactory,
  };
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * 握手成功后的活连接：心跳、入向帧分发、关闭通知。
 * 「每 5 秒 ping、10 秒没 pong 判掉线、绝不自动重连」都在这里。
 * 帧订阅（`subscribe`）给 sender 用，属于包内约定，不进公开接口。
 */
export class LiveConnection implements BridgeConnection {
  private _state: 'open' | 'closed' = 'open';
  private _busy = false;
  private readonly closeCbs: Array<(info: CloseInfo) => void> = [];
  private readonly errorCbs: Array<(err: BridgeClientError) => void> = [];
  private readonly subscribers = new Set<(msg: Inbound) => void>();
  private pingTimer: Timer | null = null;
  private pongTimer: Timer | null = null;

  constructor(
    readonly instance: EngineInstance,
    private readonly channel: SocketChannel,
    readonly options: ResolvedOptions,
  ) {
    channel.handler = {
      onMessage: (msg) => this.handleMessage(msg),
      onClose: (code, reason) => this.finish(code, reason),
      // socket error 后必定跟一个 close 事件，掉线语义交给 finish；这里只通知。
      onError: () => {
        const err = new BridgeClientError('DISCONNECTED', 'socket error');
        for (const fn of this.errorCbs) fn(err);
      },
    };
    this.pingTimer = setInterval(() => this.ping(), options.pingIntervalMs);
  }

  get state(): 'open' | 'closed' {
    return this._state;
  }
  get busy(): boolean {
    return this._busy;
  }
  onClose(cb: (info: CloseInfo) => void): void {
    this.closeCbs.push(cb);
  }
  onError(cb: (err: BridgeClientError) => void): void {
    this.errorCbs.push(cb);
  }
  close(): void {
    if (this._state === 'closed') return;
    this.channel.close(1000, 'client closing');
    this.finish(1000, 'client closing');
  }

  /** @internal sender 用。 */
  setBusy(v: boolean): void {
    this._busy = v;
  }
  /** @internal sender 用。 */
  sendText(obj: unknown): void {
    this.channel.sendText(obj);
  }
  /** @internal sender 用。 */
  sendBinary(bytes: Uint8Array): void {
    this.channel.sendBinary(bytes);
  }
  /** @internal 订阅入向帧，返回退订函数。 */
  subscribe(cb: (msg: Inbound) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private handleMessage(msg: Inbound): void {
    if (this._state === 'closed') return;
    if (msg.kind === 'text' && msg.message) {
      const type = msg.message['type'];
      if (type === 'pong') {
        this.clearPongTimer();
        return;
      }
      if (type === 'ping') {
        this.channel.sendText({ type: 'pong' });
        return;
      }
    }
    for (const cb of [...this.subscribers]) cb(msg);
  }
  private ping(): void {
    if (this._state === 'closed') return;
    this.channel.sendText({ type: 'ping' });
    // 只对最早未应答的 ping 计时：多次 ping 在飞也只有一个 deadline。
    if (this.pongTimer === null) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.channel.close(CLOSE_HEARTBEAT, 'heartbeat timeout');
        this.finish(CLOSE_HEARTBEAT, 'HEARTBEAT');
      }, this.options.pongTimeoutMs);
    }
  }
  private clearPongTimer(): void {
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
  private finish(code: number, reason: string): void {
    if (this._state === 'closed') return;
    this._state = 'closed';
    this._busy = false;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
    this.channel.handler = null;
    const info: CloseInfo = { code, reason };
    // 先让 sender 的订阅者看到掉线（它们据此拒绝在飞的 promise），再通知外层。
    for (const cb of [...this.subscribers]) cb({ kind: 'text', message: { type: '__closed', code, reason } });
    this.subscribers.clear();
    for (const cb of this.closeCbs) cb(info);
  }
}

type ProbeResult =
  | { kind: 'instance'; instance: EngineInstance; channel: SocketChannel }
  | { kind: 'outdated'; detail: string }
  | { kind: 'none'; opened: boolean; erroredAt: number | null };

/**
 * 探一个端口：连上就发 hello，拿到 hello_ack 视为一个实例并把 socket 留下（不关）。
 * 超时 / 拒绝 / 协议不合 都把 socket 关掉。
 */
function probePort(port: number, opts: ResolvedOptions): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let opened = false;
    let channel: SocketChannel;
    const done = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const drop = (r: ProbeResult, code = 1000) => {
      if (!settled) channel.close(code, 'probe finished');
      done(r);
    };
    const timer = setTimeout(() => drop({ kind: 'none', opened, erroredAt: null }), opts.probeTimeoutMs);

    let socket;
    try {
      socket = opts.createSocket(bridgeUrl(port));
    } catch {
      clearTimeout(timer);
      resolve({ kind: 'none', opened: false, erroredAt: Date.now() });
      return;
    }
    channel = new SocketChannel(socket);
    socket.addEventListener('open', () => {
      opened = true;
      channel.sendText({ type: 'hello', protocol: PROTOCOL_VERSION, client: CLIENT_NAME, clientVersion: opts.clientVersion });
    });
    channel.handler = {
      onMessage: (msg) => {
        if (msg.kind !== 'text' || !msg.message) return drop({ kind: 'none', opened, erroredAt: null });
        const m = msg.message;
        if (m['type'] === 'error') {
          if (m['code'] === 'PROTOCOL_MISMATCH') return drop({ kind: 'outdated', detail: 'plugin rejected protocol 1' });
          return drop({ kind: 'none', opened, erroredAt: null });
        }
        if (m['type'] !== 'hello_ack') return drop({ kind: 'none', opened, erroredAt: null });
        const ack = m as unknown as HelloAckMessage;
        if (ack.protocol !== PROTOCOL_VERSION) return drop({ kind: 'outdated', detail: `plugin speaks protocol ${ack.protocol}` });
        if (!isVersionAtLeast(ack.pluginVersion, opts.minPluginVersion)) {
          return drop({ kind: 'outdated', detail: `plugin ${ack.pluginVersion} < required ${opts.minPluginVersion}` });
        }
        const instance: EngineInstance = {
          port,
          engine: ack.engine,
          engineVersion: ack.engineVersion,
          pluginVersion: ack.pluginVersion,
          project: ack.project,
          limits: ack.limits,
          formats: [...ack.formats],
        };
        // 移交：探测 handler 卸下，socket 留给 LiveConnection。
        channel.handler = null;
        done({ kind: 'instance', instance, channel });
      },
      onClose: (code) => {
        if (code === CLOSE_PROTOCOL_MISMATCH) return done({ kind: 'outdated', detail: 'closed with 4426' });
        done({ kind: 'none', opened, erroredAt: opened ? null : Date.now() });
      },
      onError: () => {
        if (!opened) done({ kind: 'none', opened, erroredAt: Date.now() });
      },
    };
  });
}

/**
 * 顶栏拨开开关时调用：并行探测该引擎整个端口段，保留第一个实例的连接，其余关闭（1000）。
 * 多实例时 `instances` 全部返回，供开关下方列表切换（`switchInstance`）。
 */
export async function connectEngine(key: EngineKey, opts: ConnectOptions = {}): Promise<{ connection: BridgeConnection; instances: EngineInstance[] }> {
  const engine = getEngine(key);
  if (!engine.supported && !opts.portRange) throw new BridgeClientError('UNSUPPORTED_ENGINE', `${engine.displayName} is not supported yet`);
  const resolved = resolve(opts, engine.minPluginVersion);
  const [from, to] = opts.portRange ?? engine.portRange;
  const startedAt = Date.now();
  const ports: number[] = [];
  for (let p = from; p <= to; p++) ports.push(p);
  const results = await Promise.all(ports.map((p) => probePort(p, resolved)));

  const found = results.filter((r): r is Extract<ProbeResult, { kind: 'instance' }> => r.kind === 'instance');
  if (found.length === 0) {
    const outdated = results.find((r): r is Extract<ProbeResult, { kind: 'outdated' }> => r.kind === 'outdated');
    if (outdated) throw new BridgeClientError('PLUGIN_OUTDATED', outdated.detail);
    const nones = results.filter((r): r is Extract<ProbeResult, { kind: 'none' }> => r.kind === 'none');
    const allErroredFast =
      nones.length === results.length && nones.every((r) => !r.opened && r.erroredAt !== null && r.erroredAt - startedAt < resolved.lnaSuspectMs);
    // 回环上被拒绝的连接本来就 ~1 ms 出错，「全部瞬间失败」在非 Chromium 142+ 上只说明没引擎在跑，不能报成权限被拒。
    if (allErroredFast && resolved.lnaSuspectMs > 0 && isChromium142Plus(resolved.userAgent)) {
      throw new BridgeClientError('LNA_DENIED_SUSPECTED', `all ${ports.length} ports errored within ${resolved.lnaSuspectMs} ms; browser may have blocked local network access`);
    }
    throw new BridgeClientError('NO_ENGINE', `no ${engine.displayName} plugin listening on ${from}-${to}`);
  }
  const [first, ...rest] = found;
  for (const r of rest) r.channel.close(1000, 'not selected');
  const connection = new LiveConnection((first as (typeof found)[number]).instance, (first as (typeof found)[number]).channel, resolved);
  return { connection, instances: found.map((r) => r.instance) };
}

/** 开关下方点选另一个工程：关掉当前连接（1000），对指定端口重新握手。 */
export async function switchInstance(connection: BridgeConnection, port: number, opts: ConnectOptions = {}): Promise<BridgeConnection> {
  if (connection.busy) throw new BridgeClientError('BUSY', 'a transfer is in progress; switch after it finishes');
  const inherited = connection instanceof LiveConnection ? connection.options : resolve({}, '0.0.0');
  const resolved: ResolvedOptions = { ...inherited, ...resolve({ ...inherited, ...opts }, inherited.minPluginVersion) };
  connection.close();
  const result = await probePort(port, resolved);
  if (result.kind === 'outdated') throw new BridgeClientError('PLUGIN_OUTDATED', result.detail);
  if (result.kind === 'none') throw new BridgeClientError('NO_ENGINE', `no plugin answered on port ${port}`);
  return new LiveConnection(result.instance, result.channel, resolved);
}
