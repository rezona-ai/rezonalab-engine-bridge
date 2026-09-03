import type { ErrorCode } from './protocol-types.js';

/**
 * 客户端侧错误码：一部分是浏览器/连接层自己判出来的（NO_ENGINE、LNA_*、BUSY…），
 * 其余原样透传服务端协议 ErrorCode，让 game-web 只认一套码做文案映射。
 */
export type BridgeClientErrorCode =
  | 'NO_ENGINE'
  | 'UNSUPPORTED_ENGINE'
  | 'ORIGIN_REJECTED'
  | 'BUSY'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'CHECKSUM_MISMATCH'
  | 'IMPORT_FAILED'
  | 'IMPORT_TIMEOUT'
  | 'TIMEOUT'
  | 'LNA_DENIED_SUSPECTED'
  | 'LNA_DENIED'
  | 'UNSUPPORTED_BROWSER'
  | 'PLUGIN_OUTDATED'
  | 'DISCONNECTED'
  | ErrorCode;

/** 带 `code` 的异常；game-web 按 code 选文案，message 只进日志。 */
export class BridgeClientError extends Error {
  readonly code: BridgeClientErrorCode;
  constructor(code: BridgeClientErrorCode, message: string) {
    super(message);
    this.name = 'BridgeClientError';
    this.code = code;
  }
}
