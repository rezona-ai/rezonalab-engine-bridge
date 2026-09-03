/** 面板可见的服务端三态。 */
export type ServerState = 'stopped' | 'listening' | 'busy';

/** 每连接的传输子状态机。 */
export type SessionState = 'idle' | 'ready' | 'receiving' | 'importing';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
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
