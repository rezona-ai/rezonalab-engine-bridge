// 协议 v1 里网页侧需要的类型，与 packages/core-ts/src/types.ts 保持一致。
// 刻意手抄而不 import 内核：本包发给 game-web 时不能拖上 ws / yauzl 这些 Node 依赖，也不能让 d.ts 指向一个未安装的包。

export type AssetKind = 'model3d' | 'image' | 'audio' | 'sprite' | 'other';

export type PortRange = readonly [number, number];

export interface Limits {
  chunkBytes: number;
  maxFileBytes: number;
  maxChunks: number;
}

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

export interface ImportResultMessage {
  type: 'import_result';
  transferId: string;
  ok: boolean;
  savedPath?: string;
  sceneNode?: string;
  error?: { code: ErrorCode; message: string };
}
