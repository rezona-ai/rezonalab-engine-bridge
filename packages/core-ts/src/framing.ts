import { Ajv, type ValidateFunction } from 'ajv';
import { messagesSchema, chunkHeaderSchema } from './generated/schemas.js';
import type { ChunkHeader, Message } from './types.js';

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_HEADER_BYTES = 1024;

export type FrameResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ajv = new Ajv({ allErrors: false, strict: false });
const validateMessage: ValidateFunction = ajv.compile(messagesSchema as unknown as object);
const validateHeader: ValidateFunction = ajv.compile(chunkHeaderSchema as unknown as object);

/** 解析并用 Schema 校验一条文本帧。 */
export function parseText(raw: string | Buffer): FrameResult<Message> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return { ok: false, error: `text frame exceeds ${MAX_TEXT_BYTES} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'text frame is not JSON' };
  }
  if (!validateMessage(parsed)) return { ok: false, error: `text frame fails schema: ${ajv.errorsText(validateMessage.errors)}` };
  return { ok: true, value: parsed as Message };
}

/**
 * 二进制帧：`uint32 大端 headerLen | headerLen 字节 JSON 头 | 数据`。
 * 长度前缀而非括号扫描：不可能被构造的 JSON 迷惑，越界即错。
 */
export function parseBinary(buf: Buffer): FrameResult<{ header: ChunkHeader; data: Buffer }> {
  if (buf.length < 4) return { ok: false, error: 'binary frame shorter than 4 bytes' };
  const headerLen = buf.readUInt32BE(0);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) return { ok: false, error: `headerLen ${headerLen} out of range` };
  if (4 + headerLen > buf.length) return { ok: false, error: 'headerLen exceeds frame length' };
  let header: unknown;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
  } catch {
    return { ok: false, error: 'chunk header is not JSON' };
  }
  if (!validateHeader(header)) return { ok: false, error: `chunk header fails schema: ${ajv.errorsText(validateHeader.errors)}` };
  return { ok: true, value: { header: header as ChunkHeader, data: buf.subarray(4 + headerLen) } };
}

/** 编码一帧二进制分块（测试与假客户端用；浏览器侧 web-client 有自己的 Uint8Array 版本）。 */
export function encodeBinary(header: ChunkHeader, data: Buffer | Uint8Array): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.alloc(4 + head.length + data.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 4 + head.length);
  return out;
}

export function encodeText(msg: Message): string {
  return JSON.stringify(msg);
}
