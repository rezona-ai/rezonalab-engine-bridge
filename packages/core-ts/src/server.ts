import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EngineAdapter } from './adapter.js';
import { DEFAULT_ORIGIN_ALLOWLIST, isAllowedOrigin } from './origin.js';
import { listenOnFirstFreePort, type PortRange } from './ports.js';
import { Session, ensureTmpDir } from './session.js';
import { MAX_LOG_LINES, type LogEntry, type LogLevel, type ProgressInfo, type ServerEvents, type ServerSnapshot, type ServerState } from './state.js';
import { CloseCode, DEFAULT_FORMATS, DEFAULT_LIMITS, type Limits } from './types.js';

export const WS_PATH = '/rezona-bridge';
const HEARTBEAT_TICK_MS = 1000;

export interface BridgeServerConfig {
  engine: string;
  engineVersion: string;
  pluginVersion: string;
  project: { name: string; id: string };
  assetsRoot: string;
  portRange: PortRange;
  adapter: EngineAdapter;
  /** 追加到默认白名单之后的额外来源（开发者在面板「高级」里填）。 */
  extraOrigins?: readonly string[];
  /** 完全替换默认白名单（测试用）；一般用 extraOrigins。 */
  originAllowlist?: readonly string[];
  limits?: Partial<Limits>;
  formats?: readonly string[];
  tmpDir?: string;
  importTimeoutMs?: number;
}

export interface BridgeServer {
  start(): Promise<number>;
  stop(): Promise<void>;
  readonly port: number | null;
  readonly state: ServerState;
  snapshot(): ServerSnapshot;
  clearLogs(): void;
  on<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): void;
  off<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): void;
}

/**
 * 把内核装配成一个只监听 127.0.0.1 的 ws 服务端。单客户端策略：
 * 已有连接忙（receiving / importing）→ 新连接 4409；否则新连接替换旧连接（旧的 1000）。
 */
export function createBridgeServer(config: BridgeServerConfig): BridgeServer {
  const emitter = new EventEmitter();
  const logs: LogEntry[] = [];
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const originAllowlist = [...(config.originAllowlist ?? DEFAULT_ORIGIN_ALLOWLIST), ...(config.extraOrigins ?? [])];
  const tmpDir = config.tmpDir ?? join(tmpdir(), 'rezona-bridge');

  let http: HttpServer | null = null;
  let wss: WebSocketServer | null = null;
  let port: number | null = null;
  let current: { ws: WebSocket; session: Session; timer: NodeJS.Timeout; origin: string | null } | null = null;
  let progress: ProgressInfo | null = null;
  let lastError: string | null = null;
  let state: ServerState = 'stopped';

  const log = (level: LogLevel, msg: string) => {
    const entry: LogEntry = { at: Date.now(), level, msg };
    logs.push(entry);
    if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    if (level === 'error') lastError = msg;
    emitter.emit('log', entry);
  };
  const setState = (next: ServerState) => {
    if (state === next) return;
    state = next;
    emitter.emit('state', state);
  };
  const recomputeState = () => {
    if (!wss) return setState('stopped');
    setState(current?.session.isBusy ? 'busy' : 'listening');
  };

  const dropCurrent = async (code: number, reason: string) => {
    const c = current;
    if (!c) return;
    current = null;
    clearInterval(c.timer);
    try {
      c.ws.close(code, reason);
    } catch {
      /* 已关 */
    }
    await c.session.dispose();
    emitter.emit('connection', false, null);
    recomputeState();
  };

  const onConnection = (ws: WebSocket, origin: string | undefined) => {
    // verifyClient 已在握手阶段拒绝过一次；这里再挡一道，保证任何路径下都不会为了一个非法来源踢掉现有合法连接。
    if (!isAllowedOrigin(origin, originAllowlist)) {
      log('warn', `拒绝来源 ${origin ?? '(缺 Origin 头)'}`);
      ws.close(CloseCode.ORIGIN_REJECTED, 'origin not allowed');
      return;
    }
    if (current?.session.isBusy) {
      log('warn', '已有传输进行中，拒绝新连接');
      ws.close(CloseCode.BUSY, 'busy');
      return;
    }
    if (current) void dropCurrent(CloseCode.NORMAL, 'replaced by new connection');

    const session = new Session(
      origin,
      {
        engine: config.engine,
        engineVersion: config.engineVersion,
        pluginVersion: config.pluginVersion,
        project: config.project,
        assetsRoot: config.assetsRoot,
        tmpDir,
        originAllowlist,
        limits,
        formats: config.formats ?? DEFAULT_FORMATS,
        adapter: config.adapter,
        importTimeoutMs: config.importTimeoutMs,
      },
      {
        send: (text) => {
          if (ws.readyState === ws.OPEN) ws.send(text);
        },
        close: (code, reason) => ws.close(code, reason),
      },
      {
        onLog: log,
        onStateChange: () => recomputeState(),
        onProgress: (info) => {
          progress = info;
          emitter.emit('progress', info);
        },
      },
    );
    if (!session.open()) return;

    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      session.advance(now - last);
      last = now;
    }, HEARTBEAT_TICK_MS);
    const entry = { ws, session, timer, origin: origin ?? null };
    current = entry;
    emitter.emit('connection', true, entry.origin);
    recomputeState();

    ws.on('message', (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const p = isBinary ? session.handleBinary(buf) : session.handleText(buf);
      p.catch((err: unknown) => log('error', `处理帧时异常：${(err as Error).message}`));
    });
    ws.on('close', () => {
      if (current !== entry) return;
      current = null;
      clearInterval(timer);
      void session.dispose().then(() => {
        emitter.emit('connection', false, null);
        recomputeState();
      });
    });
    ws.on('error', (err) => log('warn', `连接错误：${err.message}`));
  };

  return {
    get port() {
      return port;
    },
    get state() {
      return state;
    },
    async start() {
      if (wss) return port as number;
      await ensureTmpDir(tmpDir);
      const listened = await listenOnFirstFreePort(config.portRange);
      http = listened.server;
      port = listened.port;
      // Origin 白名单必须在握手阶段（HTTP 101 之前）拒绝：非法来源连 WebSocket 都建不起来，更不可能影响现有连接。
      wss = new WebSocketServer({
        server: http,
        path: WS_PATH,
        maxPayload: limits.chunkBytes + 4 + 1024 + 16,
        verifyClient: (info: { origin: string }) => {
          const ok = isAllowedOrigin(info.origin || undefined, originAllowlist);
          if (!ok) log('warn', `拒绝来源 ${info.origin || '(缺 Origin 头)'}`);
          return ok;
        },
      });
      wss.on('connection', (ws, req) => onConnection(ws, req.headers.origin));
      wss.on('error', (err) => log('error', `服务端错误：${err.message}`));
      lastError = null;
      log('info', `监听中 127.0.0.1:${port}${WS_PATH}`);
      recomputeState();
      return port;
    },
    async stop() {
      await dropCurrent(CloseCode.NORMAL, 'server stopping');
      const w = wss;
      const h = http;
      wss = null;
      http = null;
      port = null;
      if (w) await new Promise<void>((res) => w.close(() => res()));
      if (h) await new Promise<void>((res) => h.close(() => res()));
      progress = null;
      log('info', '已停止');
      recomputeState();
    },
    snapshot(): ServerSnapshot {
      return {
        state,
        port,
        engine: config.engine,
        project: config.project,
        connected: current !== null,
        clientOrigin: current?.origin ?? null,
        progress,
        logs: [...logs],
        originAllowlist: [...originAllowlist],
        lastError,
      };
    },
    clearLogs() {
      logs.length = 0;
    },
    on(event, listener) {
      emitter.on(event, listener as (...args: unknown[]) => void);
    },
    off(event, listener) {
      emitter.off(event, listener as (...args: unknown[]) => void);
    },
  };
}
