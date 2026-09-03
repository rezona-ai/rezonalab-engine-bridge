import { createHash, type Hash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { BridgeError, type Limits, type TransferBeginMessage } from './types.js';

// 文件名里不允许出现路径分隔符、NUL 与其它控制字符、`..`
// eslint-disable-next-line no-control-regex -- 就是要拒绝控制字符
const FILENAME_FORBIDDEN = /[\\/\x00-\x1f\x7f]|\.\./;

/** transfer_begin 阶段的校验结果：先限额（4413 类）再一致性（4400 类）再文件名 / 格式（应用层错误，连接保持）。 */
export type BeginRejection =
  | { kind: 'limit'; code: 'TOO_LARGE' | 'TOO_MANY_CHUNKS'; message: string }
  | { kind: 'bad_frame'; message: string }
  | { kind: 'app_error'; code: 'UNSUPPORTED_FORMAT'; message: string };

export function validateBegin(msg: TransferBeginMessage, limits: Limits, formats: readonly string[]): BeginRejection | null {
  if (msg.byteSize > limits.maxFileBytes) {
    return { kind: 'limit', code: 'TOO_LARGE', message: `byteSize ${msg.byteSize} exceeds maxFileBytes ${limits.maxFileBytes}` };
  }
  if (msg.chunkCount > limits.maxChunks) {
    return { kind: 'limit', code: 'TOO_MANY_CHUNKS', message: `chunkCount ${msg.chunkCount} exceeds maxChunks ${limits.maxChunks}` };
  }
  if (msg.chunkBytes !== limits.chunkBytes) return { kind: 'bad_frame', message: `chunkBytes must equal ${limits.chunkBytes}` };
  if (msg.chunkCount !== Math.ceil(msg.byteSize / msg.chunkBytes)) return { kind: 'bad_frame', message: 'chunkCount inconsistent with byteSize' };
  if (FILENAME_FORBIDDEN.test(msg.fileName) || msg.fileName.trim() !== msg.fileName || msg.fileName.startsWith('.')) {
    return { kind: 'bad_frame', message: 'fileName contains path separators or control characters' };
  }
  const ext = extname(msg.fileName).slice(1).toLowerCase();
  if (!ext || !formats.includes(ext)) return { kind: 'app_error', code: 'UNSUPPORTED_FORMAT', message: `format .${ext || '?'} not accepted` };
  if (msg.kind === 'sprite' && ext !== 'zip') return { kind: 'app_error', code: 'UNSUPPORTED_FORMAT', message: 'sprite must be a zip' };
  return null;
}

export class FrameOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameOrderError';
  }
}
export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

/**
 * 单次传输的接收器：分块追加写入 `<tmpDir>/<transferId>.part`，边写边算 sha256，
 * 内存占用与文件大小无关；全部到齐并校验后原子搬进工程目录。任何失败路径都删 .part。
 */
export class TransferReceiver {
  readonly transferId: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly chunkCount: number;
  readonly partPath: string;
  private readonly expectedSha: string;
  private readonly chunkBytes: number;
  private readonly hash: Hash = createHash('sha256');
  private handle: fs.FileHandle | null = null;
  private received = 0;
  private nextIndex = 0;
  private finalized = false;

  constructor(begin: TransferBeginMessage, tmpDir: string) {
    this.transferId = begin.transferId;
    this.fileName = begin.fileName;
    this.byteSize = begin.byteSize;
    this.chunkCount = begin.chunkCount;
    this.chunkBytes = begin.chunkBytes;
    this.expectedSha = begin.sha256.toLowerCase();
    // transferId 已由 Schema 限制长度；这里再剥掉一切非安全字符，临时文件名不信任任何外部输入
    this.partPath = join(tmpDir, `${begin.transferId.replace(/[^A-Za-z0-9._-]/g, '_')}.part`);
  }

  get bytesReceived(): number {
    return this.received;
  }
  get expectedIndex(): number {
    return this.nextIndex;
  }
  get percent(): number {
    return this.byteSize === 0 ? 100 : Math.floor((this.received / this.byteSize) * 100);
  }

  async open(): Promise<void> {
    await fs.mkdir(join(this.partPath, '..'), { recursive: true });
    this.handle = await fs.open(this.partPath, 'w');
  }

  /** 严格顺序：index 必须等于期待的下一块；块大小必须符合计划。违反即抛 FrameOrderError（调用方关 4400）/ LimitError（4413）。 */
  async writeChunk(index: number, data: Buffer): Promise<void> {
    if (!this.handle) throw new Error('receiver not open');
    if (index !== this.nextIndex) throw new FrameOrderError(`expected chunk ${this.nextIndex}, got ${index}`);
    if (index >= this.chunkCount) throw new FrameOrderError(`chunk ${index} beyond chunkCount ${this.chunkCount}`);
    const isLast = index === this.chunkCount - 1;
    const expectedLen = isLast ? this.byteSize - this.chunkBytes * index : this.chunkBytes;
    if (data.length !== expectedLen) throw new FrameOrderError(`chunk ${index} has ${data.length} bytes, expected ${expectedLen}`);
    if (this.received + data.length > this.byteSize) throw new LimitError('received bytes exceed byteSize');
    await this.handle.write(data, 0, data.length);
    this.hash.update(data);
    this.received += data.length;
    this.nextIndex += 1;
  }

  /** 关闭写流并校验字节数与 sha256。不通过时删 .part 并返回失败原因。 */
  async finish(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.finalized) return { ok: false, reason: 'already finalized' };
    this.finalized = true;
    await this.closeHandle();
    if (this.received !== this.byteSize || this.nextIndex !== this.chunkCount) {
      await this.abort();
      return { ok: false, reason: 'byte count mismatch' };
    }
    if (this.hash.digest('hex') !== this.expectedSha) {
      await this.abort();
      return { ok: false, reason: 'sha256 mismatch' };
    }
    return { ok: true };
  }

  /**
   * 把校验过的 .part 搬到 `<destDir>/<fileName>`；同名存在则加 `-2`、`-3` 后缀。
   * 临时目录与工程目录可能不同卷（EXDEV），此时退化为 copy + unlink。返回最终绝对路径。
   */
  async moveTo(destDir: string): Promise<string> {
    await fs.mkdir(destDir, { recursive: true });
    const target = await uniquePath(destDir, this.fileName);
    try {
      await fs.rename(this.partPath, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.copyFile(this.partPath, target);
      await fs.unlink(this.partPath);
    }
    return target;
  }

  /** 删除临时文件（幂等）。连接断开 / 任何失败都要调。 */
  async abort(): Promise<void> {
    await this.closeHandle();
    await fs.rm(this.partPath, { force: true });
  }

  private async closeHandle(): Promise<void> {
    if (this.handle) {
      const h = this.handle;
      this.handle = null;
      await h.close();
    }
  }
}

/** `<dir>/<name>` 不存在则原样返回；否则依次试 `<stem>-2<ext>`、`<stem>-3<ext>`…（目录名也适用）。 */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let n = 1; n < 10_000; n++) {
    const candidate = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new BridgeError('INTERNAL', `cannot find a free name for ${name}`);
}
