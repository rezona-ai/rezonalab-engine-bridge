import type { AssetKind, ErrorCode, ImportResultMessage } from './protocol-types.js';
import { LiveConnection, type BridgeConnection } from './connect.js';
import { BridgeClientError, type BridgeClientErrorCode } from './errors.js';
import { sha256Hex } from './sha256.js';
import type { Inbound } from './socket.js';

export const DEFAULT_SEND_TIMEOUT_MS = 120_000;
export const DEFAULT_IMPORT_TIMEOUT_MS = 30_000;

export interface SendFile {
  name: string;
  bytes: ArrayBuffer;
  kind: AssetKind;
  itemId?: string;
  displayName?: string;
}

export type SendProgress =
  | { type: 'sending'; percent: number }
  | { type: 'importing' }
  | { type: 'done'; savedPath: string; sceneNode?: string }
  | { type: 'error'; code: BridgeClientErrorCode; message: string };

export interface SendOptions {
  /** 整体超时（取字节后从 transfer_begin 起算）。 */
  timeoutMs?: number;
  /** `importing` 阶段单独超时；引擎导入卡死时不必等满整体超时。 */
  importTimeoutMs?: number;
  /** 覆盖计算出的 sha256（仅测试用：故意报错的哈希以触发 CHECKSUM_MISMATCH）。 */
  sha256?: string;
}

export interface SendResult {
  savedPath: string;
  sceneNode?: string;
}

/** 二进制帧：`uint32 大端 headerLen | JSON 头 | 数据`，与 core-ts `parseBinary` 对偶。 */
export function encodeChunk(transferId: string, index: number, data: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ transferId, index }));
  const out = new Uint8Array(4 + head.byteLength + data.byteLength);
  new DataView(out.buffer).setUint32(0, head.byteLength, false);
  out.set(head, 4);
  out.set(data, 4 + head.byteLength);
  return out;
}

/** ≤ 40 字符；UUID 36 位加前缀刚好。没有 randomUUID 的环境退回随机十六进制。 */
export function newTransferId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return `t_${c.randomUUID()}`.slice(0, 40);
  const buf = new Uint8Array(16);
  c.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return `t_${hex}`;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/**
 * 把入向帧变成「等某一条消息」的 promise：sender 每一步都是 waitFor(predicate)。
 * 帧先进队列再匹配——ws 会把同一个 TCP 段里的多帧在同一个 tick 里连续 emit（received / importing / import_result 常常一起到），
 * 若只在有人等待时才接帧，中间的帧会在 await 续体还没跑到时被丢掉，传输就悬住。
 * 服务端 error 帧 / 连接关闭 / 超时 都会让当前与后续等待失败，避免半路悬挂。
 */
class FrameWaiter {
  private pending: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; reject: (e: BridgeClientError) => void } | null = null;
  private failure: BridgeClientError | null = null;
  private readonly queue: Array<Record<string, unknown>> = [];
  private readonly unsubscribe: () => void;
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(conn: LiveConnection, private readonly transferId: string) {
    this.unsubscribe = conn.subscribe((msg) => this.onFrame(msg));
  }

  private onFrame(msg: Inbound): void {
    if (msg.kind !== 'text' || !msg.message) return;
    const m = msg.message;
    if (m['type'] === '__closed') return this.fail(new BridgeClientError('DISCONNECTED', `connection closed (${String(m['code'])}) during transfer`));
    if (m['type'] === 'error') {
      // 带 transferId 的错误只认自己那笔；不带的（关闭前的协议错）也算在头上。
      if (m['transferId'] !== undefined && m['transferId'] !== this.transferId) return;
      return this.fail(new BridgeClientError(m['code'] as ErrorCode, String(m['message'] ?? 'server error')));
    }
    if (m['transferId'] !== undefined && m['transferId'] !== this.transferId) return;
    this.queue.push(m);
    this.drain();
  }

  private drain(): void {
    if (!this.pending) return;
    const i = this.queue.findIndex((m) => (this.pending as NonNullable<typeof this.pending>).match(m));
    if (i < 0) return;
    const [m] = this.queue.splice(i, 1);
    const p = this.pending;
    this.pending = null;
    p.resolve(m as Record<string, unknown>);
  }

  fail(err: BridgeClientError): void {
    if (this.failure) return;
    this.failure = err;
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
  }

  /** 到点即失败，直到 dispose 才解除。 */
  deadline(ms: number, code: BridgeClientErrorCode, message: string): void {
    this.timers.push(setTimeout(() => this.fail(new BridgeClientError(code, message)), ms));
  }

  waitFor(match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new BridgeClientError('INTERNAL', 'waitFor called while another wait is pending'));
    return new Promise((resolve, reject) => {
      this.pending = { match, resolve, reject };
      this.drain();
    });
  }

  dispose(): void {
    this.unsubscribe();
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
  }
}

/**
 * 在已握手的连接上推一个文件：本地校验 → sha256 → transfer_begin → 逐块（等 chunk_ack 再发下一块）→ transfer_end →
 * import_progress / import_result。连接不关，成败都回到就绪。同一连接同时只允许一个 send。
 */
export async function send(connection: BridgeConnection, file: SendFile, onProgress: (p: SendProgress) => void = () => undefined, options: SendOptions = {}): Promise<SendResult> {
  if (!(connection instanceof LiveConnection)) throw new BridgeClientError('INTERNAL', 'connection was not created by connectEngine');
  if (connection.state !== 'open') throw new BridgeClientError('DISCONNECTED', 'connection is closed');
  if (connection.busy) throw new BridgeClientError('BUSY', 'another transfer is in progress on this connection');
  connection.setBusy(true);
  const transferId = newTransferId();
  const waiter = new FrameWaiter(connection, transferId);
  try {
    const result = await run(connection, waiter, transferId, file, options, onProgress);
    onProgress({ type: 'done', savedPath: result.savedPath, ...(result.sceneNode !== undefined ? { sceneNode: result.sceneNode } : {}) });
    return result;
  } catch (err) {
    const e = err instanceof BridgeClientError ? err : new BridgeClientError('INTERNAL', (err as Error).message);
    onProgress({ type: 'error', code: e.code, message: e.message });
    throw e;
  } finally {
    waiter.dispose();
    connection.setBusy(false);
  }
}

async function run(
  conn: LiveConnection,
  waiter: FrameWaiter,
  transferId: string,
  file: SendFile,
  options: SendOptions,
  onProgress: (p: SendProgress) => void,
): Promise<SendResult> {
  const { limits, formats } = conn.instance;
  const ext = extensionOf(file.name);
  if (!formats.includes(ext)) throw new BridgeClientError('UNSUPPORTED_FORMAT', `.${ext} is not accepted by this plugin (formats: ${formats.join(', ')})`);
  const size = file.bytes.byteLength;
  if (size > limits.maxFileBytes) throw new BridgeClientError('TOO_LARGE', `${size} bytes exceeds plugin limit ${limits.maxFileBytes}`);
  const chunkBytes = limits.chunkBytes;
  const chunkCount = size === 0 ? 0 : Math.ceil(size / chunkBytes);
  if (chunkCount > limits.maxChunks) throw new BridgeClientError('TOO_MANY_CHUNKS', `${chunkCount} chunks exceeds plugin limit ${limits.maxChunks}`);
  const sha256 = options.sha256 ?? (await sha256Hex(file.bytes));
  if (conn.state !== 'open') throw new BridgeClientError('DISCONNECTED', 'connection closed before transfer_begin');

  waiter.deadline(options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS, 'TIMEOUT', 'transfer did not finish in time');
  const meta = file.itemId !== undefined || file.displayName !== undefined ? { ...(file.itemId !== undefined ? { itemId: file.itemId } : {}), ...(file.displayName !== undefined ? { displayName: file.displayName } : {}) } : undefined;
  conn.sendText({ type: 'transfer_begin', transferId, fileName: file.name, byteSize: size, sha256, kind: file.kind, chunkBytes, chunkCount, ...(meta ? { meta } : {}) });
  onProgress({ type: 'sending', percent: 0 });

  const all = new Uint8Array(file.bytes);
  for (let i = 0; i < chunkCount; i++) {
    const data = all.subarray(i * chunkBytes, Math.min(size, (i + 1) * chunkBytes));
    conn.sendBinary(encodeChunk(transferId, i, data));
    // 简单背压：上一块落盘确认前不发下一块。
    await waiter.waitFor((m) => m['type'] === 'chunk_ack' && m['index'] === i);
    onProgress({ type: 'sending', percent: Math.round(((i + 1) / chunkCount) * 100) });
  }
  conn.sendText({ type: 'transfer_end', transferId });

  // received → importing → import_result；校验失败时服务端跳过 progress 直接给 import_result。
  let importingReported = false;
  for (;;) {
    const m = await waiter.waitFor((x) => x['type'] === 'import_progress' || x['type'] === 'import_result');
    if (m['type'] === 'import_progress') {
      if (m['stage'] === 'importing' && !importingReported) {
        importingReported = true;
        onProgress({ type: 'importing' });
        waiter.deadline(options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS, 'IMPORT_TIMEOUT', 'engine import did not finish in time');
      }
      continue;
    }
    const result = m as unknown as ImportResultMessage;
    if (!result.ok) throw new BridgeClientError(result.error?.code ?? 'IMPORT_FAILED', result.error?.message ?? 'import failed');
    return { savedPath: result.savedPath ?? '', ...(result.sceneNode !== undefined ? { sceneNode: result.sceneNode } : {}) };
  }
}
