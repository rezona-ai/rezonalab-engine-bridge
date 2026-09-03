import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { EngineAdapter, ImportOutcome } from './adapter.js';
import { encodeText, parseBinary, parseText } from './framing.js';
import { Heartbeat } from './heartbeat.js';
import { isAllowedOrigin } from './origin.js';
import { FrameOrderError, LimitError, TransferReceiver, uniquePath, validateBegin } from './receiver.js';
import type { LogLevel, ProgressInfo, SessionState } from './state.js';
import {
  BridgeError,
  CloseCode,
  PROTOCOL_VERSION,
  type ErrorCode,
  type HelloAckMessage,
  type Limits,
  type Message,
  type TransferBeginMessage,
} from './types.js';
import { extractZipSafe } from './zipsafe.js';

export const ASSETS_SUBDIR = 'RezonaAssets';
export const IMPORT_TIMEOUT_MS = 30_000;

/** 连接另一端的抽象：生产是 ws 连接，夹具测试是收集器。 */
export interface SessionSink {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface SessionConfig {
  engine: string;
  engineVersion: string;
  pluginVersion: string;
  project: { name: string; id: string };
  /** 工程资产根（Cocos 为 `<project>/assets`，Unity 为 `<project>/Assets`）。 */
  assetsRoot: string;
  /** 临时目录，`.part` 文件放这里。 */
  tmpDir: string;
  originAllowlist: readonly string[];
  limits: Limits;
  formats: readonly string[];
  adapter: EngineAdapter;
  importTimeoutMs?: number;
  heartbeat?: { pingIntervalMs?: number; idleTimeoutMs?: number };
}

export interface SessionHooks {
  onStateChange?: (state: SessionState) => void;
  onProgress?: (info: ProgressInfo | null) => void;
  onLog?: (level: LogLevel, msg: string) => void;
}

/**
 * 一条 WebSocket 连接的完整协议状态机：idle → ready → receiving → importing → ready。
 * 与传输层无关（通过 SessionSink 出帧），与时钟无关（通过 advance 推进），因此夹具能完整驱动它。
 * 所有入向处理串行化：即便对端不等 ack 连发，也按到达顺序逐帧处理。
 */
export class Session {
  state: SessionState = 'idle';
  private closed = false;
  private receiver: TransferReceiver | null = null;
  private currentKind: TransferBeginMessage['kind'] | null = null;
  private currentMeta: TransferBeginMessage['meta'] | undefined;
  private readonly heartbeat: Heartbeat;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly origin: string | undefined,
    private readonly config: SessionConfig,
    private readonly sink: SessionSink,
    private readonly hooks: SessionHooks = {},
  ) {
    this.heartbeat = new Heartbeat(config.heartbeat);
  }

  get isBusy(): boolean {
    return this.state === 'receiving' || this.state === 'importing';
  }
  get isClosed(): boolean {
    return this.closed;
  }

  /** 连接建立后第一步：Origin 白名单。不通过直接 4403，不发任何帧。 */
  open(): boolean {
    if (!isAllowedOrigin(this.origin, this.config.originAllowlist)) {
      this.log('warn', `拒绝来源 ${this.origin ?? '(缺 Origin 头)'}`);
      this.close(CloseCode.ORIGIN_REJECTED, 'origin not allowed');
      return false;
    }
    return true;
  }

  handleText(raw: string | Buffer): Promise<void> {
    return this.enqueue(() => this.processText(raw));
  }

  handleBinary(buf: Buffer): Promise<void> {
    return this.enqueue(() => this.processBinary(buf));
  }

  /** 推进虚拟时钟；生产由 setInterval 喂真实流逝毫秒。 */
  advance(deltaMs: number): void {
    if (this.closed) return;
    for (const ev of this.heartbeat.advance(deltaMs)) {
      if (ev === 'ping') this.send({ type: 'ping' });
      else {
        this.log('warn', '心跳超时，关闭连接');
        this.close(CloseCode.HEARTBEAT_TIMEOUT, 'heartbeat timeout');
        return;
      }
    }
  }

  /** 连接已由对端关闭：清临时文件、回到 idle。 */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.cleanupTransfer();
    this.setState('idle');
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async processText(raw: string | Buffer): Promise<void> {
    if (this.closed) return;
    this.heartbeat.onInboundFrame();
    const parsed = parseText(raw);
    if (!parsed.ok) return this.fail(CloseCode.BAD_FRAME, parsed.error);
    const msg = parsed.value;

    if (this.state === 'idle') {
      if (msg.type !== 'hello') return this.fail(CloseCode.BAD_FRAME, `expected hello, got ${msg.type}`);
      if (msg.protocol !== PROTOCOL_VERSION) {
        this.sendError('PROTOCOL_MISMATCH', `unsupported protocol ${msg.protocol}, plugin speaks ${PROTOCOL_VERSION}`);
        return this.fail(CloseCode.PROTOCOL_MISMATCH, 'protocol mismatch');
      }
      const ack: HelloAckMessage = {
        type: 'hello_ack',
        protocol: PROTOCOL_VERSION,
        engine: this.config.engine,
        engineVersion: this.config.engineVersion,
        pluginVersion: this.config.pluginVersion,
        project: this.config.project,
        limits: this.config.limits,
        formats: [...this.config.formats],
      };
      this.send(ack);
      this.setState('ready');
      this.log('info', `客户端已连接：${msg.client} ${msg.clientVersion}`);
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'pong':
        return;
      case 'hello':
        return this.fail(CloseCode.BAD_FRAME, 'duplicate hello');
      case 'transfer_begin':
        return this.onBegin(msg);
      case 'transfer_end':
        return this.onEnd(msg.transferId);
      default:
        return this.fail(CloseCode.BAD_FRAME, `unexpected message ${msg.type} from client`);
    }
  }

  private async processBinary(buf: Buffer): Promise<void> {
    if (this.closed) return;
    this.heartbeat.onInboundFrame();
    if (this.state !== 'receiving' || !this.receiver) return this.fail(CloseCode.BAD_FRAME, 'binary frame outside of a transfer');
    const parsed = parseBinary(buf);
    if (!parsed.ok) return this.fail(CloseCode.BAD_FRAME, parsed.error);
    const { header, data } = parsed.value;
    if (header.transferId !== this.receiver.transferId) return this.fail(CloseCode.BAD_FRAME, 'chunk for unknown transferId');
    try {
      await this.receiver.writeChunk(header.index, data);
    } catch (err) {
      if (err instanceof FrameOrderError) return this.fail(CloseCode.BAD_FRAME, err.message);
      if (err instanceof LimitError) return this.fail(CloseCode.LIMIT_EXCEEDED, err.message);
      this.log('error', `写入分块失败：${(err as Error).message}`);
      return this.fail(CloseCode.BAD_FRAME, 'chunk write failed');
    }
    this.send({ type: 'chunk_ack', transferId: header.transferId, index: header.index });
    this.hooks.onProgress?.({ transferId: this.receiver.transferId, fileName: this.receiver.fileName, percent: this.receiver.percent, stage: 'receiving' });
  }

  private async onBegin(msg: TransferBeginMessage): Promise<void> {
    if (this.isBusy) return this.fail(CloseCode.BUSY, 'transfer already in progress');
    if (this.state !== 'ready') return this.fail(CloseCode.BAD_FRAME, 'transfer_begin before hello');
    if (!this.config.adapter.isProjectOpen()) {
      this.sendError('PROJECT_NOT_OPEN', 'no project is open in the editor', msg.transferId);
      return this.fail(CloseCode.BUSY, 'project not open');
    }
    const rejection = validateBegin(msg, this.config.limits, this.config.formats);
    if (rejection) {
      if (rejection.kind === 'limit') {
        this.sendError(rejection.code, rejection.message, msg.transferId);
        return this.fail(CloseCode.LIMIT_EXCEEDED, rejection.message);
      }
      if (rejection.kind === 'bad_frame') return this.fail(CloseCode.BAD_FRAME, rejection.message);
      this.sendError(rejection.code, rejection.message, msg.transferId);
      this.log('warn', `拒绝传输 ${msg.fileName}：${rejection.message}`);
      return;
    }
    const receiver = new TransferReceiver(msg, this.config.tmpDir);
    try {
      await receiver.open();
    } catch (err) {
      this.log('error', `无法创建临时文件：${(err as Error).message}`);
      this.sendError('INTERNAL', 'cannot open temp file', msg.transferId);
      return;
    }
    this.receiver = receiver;
    this.currentKind = msg.kind;
    this.currentMeta = msg.meta;
    this.setState('receiving');
    this.log('info', `开始接收 ${msg.fileName}（${msg.byteSize} 字节，${msg.chunkCount} 块）`);
    this.hooks.onProgress?.({ transferId: msg.transferId, fileName: msg.fileName, percent: 0, stage: 'receiving' });
  }

  private async onEnd(transferId: string): Promise<void> {
    if (this.state !== 'receiving' || !this.receiver || this.receiver.transferId !== transferId) {
      return this.fail(CloseCode.BAD_FRAME, 'transfer_end without matching transfer');
    }
    const receiver = this.receiver;
    const finished = await receiver.finish();
    if (!finished.ok) {
      this.log('warn', `${receiver.fileName} 校验失败：${finished.reason}`);
      this.finishTransfer({ type: 'import_result', transferId, ok: false, error: { code: 'CHECKSUM_MISMATCH', message: finished.reason } }, 'failed');
      return;
    }
    this.send({ type: 'import_progress', transferId, stage: 'received' });
    const destDir = join(this.config.assetsRoot, ASSETS_SUBDIR);
    let importPath: string;
    try {
      if (extname(receiver.fileName).toLowerCase() === '.zip') {
        const stem = basename(receiver.fileName, extname(receiver.fileName));
        const zipDir = await uniquePath(destDir, stem);
        try {
          await extractZipSafe(receiver.partPath, zipDir);
        } finally {
          await receiver.abort();
        }
        importPath = zipDir;
      } else {
        importPath = await receiver.moveTo(destDir);
      }
    } catch (err) {
      await receiver.abort();
      const e = err instanceof BridgeError ? err : new BridgeError('INTERNAL', (err as Error).message);
      this.log('warn', `${receiver.fileName} 落盘失败：${e.message}`);
      this.finishTransfer({ type: 'import_result', transferId, ok: false, error: { code: e.code, message: e.message } }, 'failed');
      return;
    }

    this.setState('importing');
    this.send({ type: 'import_progress', transferId, stage: 'importing' });
    this.hooks.onProgress?.({ transferId, fileName: receiver.fileName, percent: 100, stage: 'importing' });
    let outcome: ImportOutcome;
    try {
      outcome = await withTimeout(
        this.config.adapter.importFile(importPath, {
          kind: this.currentKind ?? 'other',
          fileName: basename(importPath),
          itemId: this.currentMeta?.itemId,
          displayName: this.currentMeta?.displayName,
          transferId,
        }),
        this.config.importTimeoutMs ?? IMPORT_TIMEOUT_MS,
      );
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError('IMPORT_FAILED', (err as Error).message);
      this.log('error', `${receiver.fileName} 导入失败：${e.code} ${e.message}`);
      this.finishTransfer({ type: 'import_result', transferId, ok: false, error: { code: e.code, message: e.message } }, 'failed');
      return;
    }
    this.log('info', `${receiver.fileName} 已导入：${outcome.savedPath}`);
    const result: Message = { type: 'import_result', transferId, ok: true, savedPath: outcome.savedPath };
    if (outcome.sceneNode) (result as { sceneNode?: string }).sceneNode = outcome.sceneNode;
    this.finishTransfer(result, 'done');
  }

  private finishTransfer(result: Message, stage: 'done' | 'failed'): void {
    const receiver = this.receiver;
    this.receiver = null;
    this.currentKind = null;
    this.currentMeta = undefined;
    this.setState('ready');
    this.send(result);
    if (receiver) this.hooks.onProgress?.({ transferId: receiver.transferId, fileName: receiver.fileName, percent: 100, stage });
  }

  private async cleanupTransfer(): Promise<void> {
    const r = this.receiver;
    this.receiver = null;
    this.currentKind = null;
    this.currentMeta = undefined;
    if (r) {
      await r.abort();
      this.hooks.onProgress?.(null);
    }
  }

  private async fail(code: number, reason: string): Promise<void> {
    this.log('warn', `关闭连接（${code}）：${reason}`);
    await this.cleanupTransfer();
    this.close(code, reason);
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.setState('idle');
    this.sink.close(code, reason);
  }

  private send(msg: Message): void {
    if (this.closed) return;
    this.sink.send(encodeText(msg));
  }

  private sendError(code: ErrorCode, message: string, transferId?: string): void {
    const msg: Message = transferId ? { type: 'error', code, message, transferId } : { type: 'error', code, message };
    this.send(msg);
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onStateChange?.(state);
  }

  private log(level: LogLevel, msg: string): void {
    this.hooks.onLog?.(level, msg);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError('IMPORT_TIMEOUT', `import did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 确保临时目录存在（server 与夹具共用）。 */
export async function ensureTmpDir(tmpDir: string): Promise<void> {
  await fs.mkdir(tmpDir, { recursive: true });
}
