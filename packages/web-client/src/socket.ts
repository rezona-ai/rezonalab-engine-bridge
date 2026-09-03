/**
 * 对 WebSocket 的最小依赖面：浏览器原生 WebSocket 与 Node 的 `ws` 客户端都满足它，
 * 所以同一份连接/发送代码能在测试里对着真实 core-ts 服务端跑。
 */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: (ev: unknown) => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

export const WS_PATH = '/rezona-bridge';
export const WS_OPEN = 1;

export function bridgeUrl(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

export const defaultSocketFactory: SocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('WebSocket is not available in this environment');
  return new Ctor(url);
};

/** 入向帧统一成两种：文本已解析成对象（解析失败为 null），二进制为 ArrayBuffer。 */
export type Inbound = { kind: 'text'; message: Record<string, unknown> | null } | { kind: 'binary'; data: ArrayBuffer };

export interface SocketHandler {
  onMessage(msg: Inbound): void;
  onClose(code: number, reason: string): void;
  onError(): void;
}

/**
 * 一条 socket 只挂一次监听，由可替换的 handler 分发：探测阶段由 probe 处理，握手成功后整只交给 LiveConnection。
 * 这样不需要 removeEventListener（最小接口里没有它），也不会在移交后留下两份监听。
 */
export class SocketChannel {
  private current: SocketHandler | null = null;
  /** 没有 handler 的窗口期（探测移交 → LiveConnection 接手之间）到达的事件先攒着，接手时按序回放，不丢帧。 */
  private backlog: Array<(h: SocketHandler) => void> = [];

  constructor(readonly socket: WebSocketLike) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (ev) => this.dispatch((h) => h.onMessage(decode(ev.data))));
    socket.addEventListener('close', (ev) => this.dispatch((h) => h.onClose(ev.code, ev.reason)));
    socket.addEventListener('error', () => this.dispatch((h) => h.onError()));
  }

  get handler(): SocketHandler | null {
    return this.current;
  }
  set handler(h: SocketHandler | null) {
    this.current = h;
    if (!h) return;
    const queued = this.backlog;
    this.backlog = [];
    for (const fn of queued) fn(h);
  }

  private dispatch(fn: (h: SocketHandler) => void): void {
    if (this.current) fn(this.current);
    else this.backlog.push(fn);
  }
  sendText(obj: unknown): void {
    if (this.socket.readyState === WS_OPEN) this.socket.send(JSON.stringify(obj));
  }
  sendBinary(bytes: Uint8Array): void {
    if (this.socket.readyState === WS_OPEN) this.socket.send(bytes);
  }
  close(code = 1000, reason = ''): void {
    try {
      this.socket.close(code, reason);
    } catch {
      /* 已关 */
    }
  }
}

function decode(data: unknown): Inbound {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return { kind: 'text', message: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null };
    } catch {
      return { kind: 'text', message: null };
    }
  }
  if (data instanceof ArrayBuffer) return { kind: 'binary', data };
  if (ArrayBuffer.isView(data)) return { kind: 'binary', data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer };
  return { kind: 'text', message: null };
}
