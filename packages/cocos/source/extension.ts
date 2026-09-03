import { join } from 'node:path';
import { createBridgeServer, PortsExhaustedError, type BridgeServer, type BridgeServerConfig, type LogEntry, type ServerSnapshot } from '@rezonalab/engine-bridge-core';
import { CocosAdapter } from './adapter';
import { COCOS_PORT_RANGE, PACKAGE_NAME, buildServerConfig, normalizeExtraOrigins, portsExhaustedMessage, resolveAutoStart } from './assemble';

/** 扩展用到的 `Editor` 子集，注入以便脱离 Cocos 单测。 */
export interface EditorLike {
  App: { readonly version: string };
  Project: { readonly path: string };
  Message: {
    request(pkg: string, message: string, ...args: unknown[]): Promise<unknown>;
    broadcast(message: string, ...args: unknown[]): void;
  };
  Panel: { open(name: string): void };
  Profile: {
    getConfig(pkg: string, key: string): Promise<unknown>;
    setConfig(pkg: string, key: string, value: unknown): Promise<void>;
  };
}

export interface ExtensionDeps {
  editor: EditorLike;
  pluginVersion: string;
  createServer?: (config: BridgeServerConfig) => BridgeServer;
}

/** 广播给面板的消息名。 */
export const STATE_MESSAGE = `${PACKAGE_NAME}:state`;

export interface ExtensionMethods {
  openPanel(): void;
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
  queryState(): ServerSnapshot;
  clearLogs(): void;
  setExtraOrigins(origins: unknown): Promise<void>;
}

export interface Extension {
  methods: ExtensionMethods;
  load(): Promise<void>;
  unload(): Promise<void>;
}

/**
 * 扩展主进程逻辑。持有一个内核服务端实例，把消息方法与生命周期钩子接到它上面，
 * 并把内核事件合并成一次快照广播给面板。
 */
export function createExtension(deps: ExtensionDeps): Extension {
  const { editor } = deps;
  const createServer = deps.createServer ?? createBridgeServer;
  let server: BridgeServer | null = null;
  /** 服务端启动失败等内核之外的错误，随快照一并给面板。 */
  let extError: string | null = null;
  const extLogs: LogEntry[] = [];
  let broadcastPending = false;

  const logError = (msg: string) => {
    extError = msg;
    extLogs.push({ at: Date.now(), level: 'error', msg });
    if (extLogs.length > 50) extLogs.splice(0, extLogs.length - 50);
  };

  const emptySnapshot = (): ServerSnapshot => ({
    state: 'stopped',
    port: null,
    engine: 'cocos',
    project: { name: '', id: '' },
    connected: false,
    clientOrigin: null,
    progress: null,
    logs: [],
    originAllowlist: [],
    lastError: null,
  });

  const snapshot = (): ServerSnapshot => {
    const base = server ? server.snapshot() : emptySnapshot();
    return {
      ...base,
      logs: [...base.logs, ...extLogs].sort((a, b) => a.at - b.at),
      lastError: extError ?? base.lastError,
    };
  };

  /** 同一轮事件循环里的多次事件只广播一次。 */
  const scheduleBroadcast = () => {
    if (broadcastPending) return;
    broadcastPending = true;
    queueMicrotask(() => {
      broadcastPending = false;
      try {
        editor.Message.broadcast(STATE_MESSAGE, snapshot());
      } catch {
        /* 面板未开时广播可能失败，忽略 */
      }
    });
  };

  const readExtraOrigins = async () => normalizeExtraOrigins(await editor.Profile.getConfig(PACKAGE_NAME, 'extraOrigins'));

  const start = async () => {
    if (server) return;
    // 与 buildServerConfig 同一算法（path.join），避免两处各拼一份路径
    const assetsRoot = join(editor.Project.path, 'assets');
    const adapter = new CocosAdapter(assetsRoot, { message: editor.Message, log: (m) => console.log(`[${PACKAGE_NAME}] ${m}`) });
    const config = buildServerConfig(
      { projectPath: editor.Project.path, appVersion: editor.App.version, pluginVersion: deps.pluginVersion, extraOrigins: await readExtraOrigins() },
      adapter,
    );
    const s = createServer(config);
    s.on('state', scheduleBroadcast);
    s.on('progress', scheduleBroadcast);
    s.on('log', scheduleBroadcast);
    s.on('connection', scheduleBroadcast);
    try {
      await s.start();
      server = s;
      extError = null;
    } catch (err) {
      logError(err instanceof PortsExhaustedError ? portsExhaustedMessage(COCOS_PORT_RANGE) : `启动失败：${(err as Error).message}`);
    }
    scheduleBroadcast();
  };

  const stop = async () => {
    const s = server;
    server = null;
    if (s) await s.stop();
    scheduleBroadcast();
  };

  const methods: ExtensionMethods = {
    openPanel() {
      editor.Panel.open(PACKAGE_NAME);
    },
    async startServer() {
      await editor.Profile.setConfig(PACKAGE_NAME, 'autoStart', true);
      await start();
    },
    async stopServer() {
      await editor.Profile.setConfig(PACKAGE_NAME, 'autoStart', false);
      await stop();
    },
    queryState() {
      return snapshot();
    },
    clearLogs() {
      extLogs.length = 0;
      extError = null;
      server?.clearLogs();
      scheduleBroadcast();
    },
    async setExtraOrigins(origins) {
      await editor.Profile.setConfig(PACKAGE_NAME, 'extraOrigins', normalizeExtraOrigins(origins));
      // 白名单在装配时固定，运行中改动需重启服务端才生效。
      if (server) {
        await stop();
        await start();
      } else {
        scheduleBroadcast();
      }
    },
  };

  return {
    methods,
    async load() {
      if (resolveAutoStart(await editor.Profile.getConfig(PACKAGE_NAME, 'autoStart'))) await start();
    },
    async unload() {
      await stop();
    },
  };
}
