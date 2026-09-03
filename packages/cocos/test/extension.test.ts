import { describe, expect, it, vi } from 'vitest';
import type { BridgeServer, BridgeServerConfig, ServerEvents, ServerSnapshot } from '@rezonalab/engine-bridge-core';
import { PortsExhaustedError } from '@rezonalab/engine-bridge-core';
import { createExtension, type EditorLike } from '../source/extension';

/** 假内核服务端：记录 start/stop，可手动触发事件。 */
function fakeServer(opts: { failStart?: Error } = {}) {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  let state: ServerSnapshot['state'] = 'stopped';
  let port: number | null = null;
  const server: BridgeServer & { emit: <K extends keyof ServerEvents>(e: K, ...a: Parameters<ServerEvents[K]>) => void } = {
    get port() {
      return port;
    },
    get state() {
      return state;
    },
    start: vi.fn(async () => {
      if (opts.failStart) throw opts.failStart;
      state = 'listening';
      port = 41700;
      return 41700;
    }),
    stop: vi.fn(async () => {
      state = 'stopped';
      port = null;
    }),
    snapshot: () => ({
      state,
      port,
      engine: 'cocos',
      project: { name: 'MyGame', id: 'abcd1234' },
      connected: false,
      clientOrigin: null,
      progress: null,
      logs: [],
      originAllowlist: ['https://lab.rezona.ai'],
      lastError: null,
    }),
    clearLogs: vi.fn(),
    on: (e, l) => {
      const arr = listeners.get(e) ?? [];
      arr.push(l as (...a: unknown[]) => void);
      listeners.set(e, arr);
    },
    off: () => {},
    emit: (e, ...a) => (listeners.get(e) ?? []).forEach((l) => l(...a)),
  };
  return server;
}

function fakeEditor(profile: Record<string, unknown> = {}) {
  const broadcasts: Array<{ msg: string; payload: unknown }> = [];
  const editor: EditorLike = {
    App: { version: '3.8.6' },
    Project: { path: '/Users/me/Games/MyGame' },
    Message: {
      request: vi.fn(async () => null),
      broadcast: (msg: string, payload: unknown) => {
        broadcasts.push({ msg, payload });
      },
    },
    Panel: { open: vi.fn() },
    Profile: {
      getConfig: async (_pkg: string, key: string) => profile[key],
      setConfig: async (_pkg: string, key: string, value: unknown) => {
        profile[key] = value;
      },
    },
  };
  return { editor, broadcasts, profile };
}

function setup(opts: { profile?: Record<string, unknown>; failStart?: Error } = {}) {
  const server = fakeServer({ failStart: opts.failStart });
  const configs: BridgeServerConfig[] = [];
  const { editor, broadcasts, profile } = fakeEditor(opts.profile);
  const ext = createExtension({
    editor,
    pluginVersion: '0.1.0',
    createServer: (cfg) => {
      configs.push(cfg);
      return server;
    },
  });
  return { ext, server, configs, editor, broadcasts, profile };
}

describe('extension 生命周期', () => {
  it('load 时 autoStart 默认开 → 启动服务并用工程路径装配', async () => {
    const { ext, server, configs } = setup();
    await ext.load();
    expect(server.start).toHaveBeenCalledTimes(1);
    expect(configs[0]).toMatchObject({ engine: 'cocos', engineVersion: '3.8.6', pluginVersion: '0.1.0', project: { name: 'MyGame' } });
    expect(configs[0]?.assetsRoot).toBe('/Users/me/Games/MyGame/assets');
  });

  it('profile autoStart=false 时 load 不启动', async () => {
    const { ext, server } = setup({ profile: { autoStart: false } });
    await ext.load();
    expect(server.start).not.toHaveBeenCalled();
    expect(ext.methods.queryState().state).toBe('stopped');
  });

  it('unload 停服务但不改 autoStart 偏好', async () => {
    const { ext, server, profile } = setup();
    await ext.load();
    await ext.unload();
    expect(server.stop).toHaveBeenCalled();
    expect(profile.autoStart).toBeUndefined();
  });
});

describe('extension 消息方法', () => {
  it('queryState 返回内核快照形状', async () => {
    const { ext } = setup();
    await ext.methods.startServer();
    const s = ext.methods.queryState();
    expect(s).toMatchObject({ state: 'listening', port: 41700, engine: 'cocos', project: { name: 'MyGame', id: 'abcd1234' } });
    expect(Array.isArray(s.logs)).toBe(true);
    expect(s).toHaveProperty('lastError');
    expect(s).toHaveProperty('originAllowlist');
    expect(s).toHaveProperty('progress');
  });

  it('面板 stopServer 记住 autoStart=false，startServer 记回 true', async () => {
    const { ext, profile } = setup();
    await ext.methods.startServer();
    expect(profile.autoStart).toBe(true);
    await ext.methods.stopServer();
    expect(profile.autoStart).toBe(false);
    expect(ext.methods.queryState().state).toBe('stopped');
  });

  it('内核事件转成 rezona-bridge:state 广播', async () => {
    const { ext, server, broadcasts } = setup();
    await ext.methods.startServer();
    broadcasts.length = 0;
    server.emit('log', { at: 1, level: 'info', msg: 'x' });
    await Promise.resolve();
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(broadcasts[0]?.msg).toBe('rezona-bridge:state');
    expect(broadcasts[0]?.payload).toMatchObject({ state: 'listening', port: 41700 });
  });

  it('端口段耗尽：不抛出，lastError 与日志给出面板文案', async () => {
    const { ext } = setup({ failStart: new PortsExhaustedError([41700, 41719]) });
    await expect(ext.methods.startServer()).resolves.toBeUndefined();
    const s = ext.methods.queryState();
    expect(s.state).toBe('stopped');
    expect(s.lastError).toBe('41700 到 41719 全部被占用');
    expect(s.logs.some((l) => l.level === 'error' && l.msg.includes('41700 到 41719 全部被占用'))).toBe(true);
  });

  it('setExtraOrigins 写回 profile，运行中则重启使其生效', async () => {
    const { ext, server, configs, profile } = setup();
    await ext.methods.startServer();
    await ext.methods.setExtraOrigins(['http://localhost:5173', '']);
    expect(profile.extraOrigins).toEqual(['http://localhost:5173']);
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(server.start).toHaveBeenCalledTimes(2);
    expect(configs[1]?.extraOrigins).toEqual(['http://localhost:5173']);
  });

  it('clearLogs 透传，openPanel 打开本扩展面板', async () => {
    const { ext, server, editor } = setup();
    await ext.methods.startServer();
    ext.methods.clearLogs();
    expect(server.clearLogs).toHaveBeenCalled();
    ext.methods.openPanel();
    expect(editor.Panel.open).toHaveBeenCalledWith('rezona-bridge');
  });
});
