// 协议 v1 的 TypeScript 类型。字段与 protocol/schema/messages.schema.json 一一对应。

export const PROTOCOL_VERSION = 1;

export type AssetKind = 'model3d' | 'image' | 'audio' | 'video' | 'sprite' | 'other';

export interface Limits {
  chunkBytes: number;
  maxFileBytes: number;
  maxChunks: number;
}

export const DEFAULT_LIMITS: Limits = {
  chunkBytes: 4 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxChunks: 128,
};

// fbx 今天没人会发（生成端只出 glb），但两端引擎都原生导入；先放进白名单，生成端切格式时插件不必再发版。
export const DEFAULT_FORMATS: readonly string[] = ['glb', 'fbx', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'zip'];

export type ErrorCode =
  | 'CHECKSUM_MISMATCH'
  | 'ZIP_UNSAFE_ENTRY'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'TOO_LARGE'
  | 'TOO_MANY_CHUNKS'
  | 'IMPORT_FAILED'
  | 'IMPORT_TIMEOUT'
  | 'PROJECT_NOT_OPEN'
  | 'PROTOCOL_MISMATCH'
  | 'INTERNAL';

export const CloseCode = {
  NORMAL: 1000,
  BAD_FRAME: 4400,
  ORIGIN_REJECTED: 4403,
  HEARTBEAT_TIMEOUT: 4408,
  BUSY: 4409,
  LIMIT_EXCEEDED: 4413,
  PROTOCOL_MISMATCH: 4426,
} as const;
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

export interface HelloMessage { type: 'hello'; protocol: number; client: string; clientVersion: string; [k: string]: unknown }
export interface HelloAckMessage {
  type: 'hello_ack';
  protocol: number;
  engine: string;
  engineVersion: string;
  pluginVersion: string;
  project: { name: string; id: string };
  limits: Limits;
  formats: string[];
}
export interface TransferBeginMessage {
  type: 'transfer_begin';
  transferId: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  kind: AssetKind;
  chunkBytes: number;
  chunkCount: number;
  meta?: { itemId?: string; displayName?: string; [k: string]: unknown };
}
export interface ChunkAckMessage { type: 'chunk_ack'; transferId: string; index: number }
export interface TransferEndMessage { type: 'transfer_end'; transferId: string }
export interface ImportProgressMessage { type: 'import_progress'; transferId: string; stage: 'received' | 'importing' }
export interface ImportResultMessage {
  type: 'import_result';
  transferId: string;
  ok: boolean;
  savedPath?: string;
  sceneNode?: string;
  error?: { code: ErrorCode; message: string };
}
export interface PingMessage { type: 'ping' }
export interface PongMessage { type: 'pong' }
export interface ErrorMessage { type: 'error'; code: ErrorCode; message: string; transferId?: string }

export type Message =
  | HelloMessage
  | HelloAckMessage
  | TransferBeginMessage
  | ChunkAckMessage
  | TransferEndMessage
  | ImportProgressMessage
  | ImportResultMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

export interface ChunkHeader { transferId: string; index: number }

/** 带协议错误码的异常；内核内部统一抛这个，边界处转成 error 帧 / import_result。 */
export class BridgeError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}
