import type { LogArgs, LogCode } from './log-codes.js';
/** 面板可见的服务端三态。 */
export type ServerState = 'stopped' | 'listening' | 'busy';

/** 每连接的传输子状态机。 */
export type SessionState = 'idle' | 'ready' | 'receiving' | 'importing';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  /** 事件码；面板据此按自己的语言渲染文案（见 log-codes.ts）。 */
  code: LogCode;
  /** 文案插值参数。 */
  args?: LogArgs;
  /** 英文渲染结果，给不做本地化的消费方（控制台、假引擎 stdout）用。面板不该读它。 */
  msg: string;
}

export interface ProgressInfo {
  transferId: string;
  fileName: string;
  percent: number;
  stage: 'receiving' | 'importing' | 'done' | 'failed';
}

/** 面板一次拉取的完整快照。 */
export interface ServerSnapshot {
  state: ServerState;
  port: number | null;
  engine: string;
  project: { name: string; id: string };
  connected: boolean;
  clientOrigin: string | null;
  progress: ProgressInfo | null;
  logs: LogEntry[];
  originAllowlist: string[];
  lastError: string | null;
}

export interface ServerEvents {
  state: (state: ServerState) => void;
  progress: (info: ProgressInfo | null) => void;
  log: (entry: LogEntry) => void;
  connection: (connected: boolean, origin: string | null) => void;
}

export const MAX_LOG_LINES = 200;
