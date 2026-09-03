import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer, type BridgeServer, type BridgeServerConfig } from '@rezonalab/engine-bridge-core';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClientError, connectEngine, send, switchInstance, type BridgeConnection, type ConnectOptions, type SendProgress, type WebSocketLike } from '../src/index.js';

const ORIGIN = 'https://lab.rezona.ai';
const RANGE: readonly [number, number] = [41900, 41903];
const LIMITS = { chunkBytes: 16, maxFileBytes: 4096, maxChunks: 512 };

// 测试里的「浏览器 WebSocket」用 ws 客户端顶替：服务端要看到 Origin 头，Node 内建 WebSocket 不带，ws 可以带。
const createSocket = (url: string): WebSocketLike => new WebSocket(url, { origin: ORIGIN });
const baseOpts = (extra: Partial<ConnectOptions> = {}): ConnectOptions => ({ createSocket, portRange: RANGE, probeTimeoutMs: 800, lnaSuspectMs: 0, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytesOf = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * seed + 3) & 0xff);
const asError = async (p: Promise<unknown>): Promise<BridgeClientError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof BridgeClientError) return err;
    throw err;
  }
  throw new Error('expected rejection');
};

/** 一台假引擎：真实 core-ts 服务端 + 记录 importFile 调用的适配层。 */
async function startEngine(overrides: Partial<BridgeServerConfig> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rezona-web-'));
  const calls: string[] = [];
  const server = createBridgeServer({
    engine: 'cocos',
    engineVersion: '3.8.6',
    pluginVersion: '0.1.0',
    project: { name: 'P', id: 'p1' },
    assetsRoot: join(root, 'assets'),
    tmpDir: join(root, 'tmp'),
    portRange: RANGE,
    adapter: { async importFile(p: string) { calls.push(p); return { savedPath: p, sceneNode: 'Node' }; }, isProjectOpen: () => true },
    limits: LIMITS,
    originAllowlist: [ORIGIN],
    ...overrides,
  });
  await server.start();
  return { server, root, calls };
}

type Engine = Awaited<ReturnType<typeof startEngine>>;

describe('web-client against real core-ts servers', () => {
  const engines: Engine[] = [];
  const connections: BridgeConnection[] = [];
  const stubs: WebSocketServer[] = [];
  const up = async (overrides?: Partial<BridgeServerConfig>) => {
    const e = await startEngine(overrides);
    engines.push(e);
    return e;
  };
  const track = <T extends { connection: BridgeConnection }>(r: T): T => {
    connections.push(r.connection);
    return r;
  };
  afterEach(async () => {
    for (const c of connections.splice(0)) c.close();
    for (const s of stubs.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    for (const e of engines.splice(0)) {
      await e.server.stop();
      await fs.rm(e.root, { recursive: true, force: true });
    }
  });

  it('connects, exposes the instance and keeps pinging while idle', async () => {
    const e = await up();
    const { connection, instances } = track(await connectEngine('cocos', baseOpts({ pingIntervalMs: 40, pongTimeoutMs: 1000 })));
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ port: e.server.port, engine: 'cocos', engineVersion: '3.8.6', pluginVersion: '0.1.0', project: { name: 'P', id: 'p1' }, limits: LIMITS });
    expect(instances[0]?.formats).toContain('glb');
    expect(connection.state).toBe('open');
    expect(connection.busy).toBe(false);
    await sleep(250);
    // 心跳在飞：连接仍开着，且服务端仍认为有客户端。
    expect(connection.state).toBe('open');
    expect(e.server.snapshot().connected).toBe(true);
  });

  it('sends two files sequentially over one connection and the bytes on disk match', async () => {
    const e = await up();
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    const a = bytesOf(40, 7); // 3 块：16 + 16 + 8
    const b = bytesOf(0, 1); // 0 字节：chunkCount 0
    const events: SendProgress[] = [];
    const r1 = await send(connection, { name: 'hero.glb', bytes: a.buffer, kind: 'model3d', itemId: 'm1', displayName: 'Hero' }, (p) => events.push(p));
    expect(r1.savedPath).toMatch(/RezonaAssets[\\/]hero\.glb$/);
    expect(r1.sceneNode).toBe('Node');
    // 0% 起步 + 每块一次 ack：0, 33, 67, 100。
    expect(events.filter((x) => x.type === 'sending').map((x) => (x as { percent: number }).percent)).toEqual([0, 33, 67, 100]);
    expect(events.some((x) => x.type === 'importing')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', savedPath: r1.savedPath });
    expect(connection.busy).toBe(false);
    const r2 = await send(connection, { name: 'empty.png', bytes: b.buffer, kind: 'image' }, () => undefined);
    expect(r2.savedPath).toMatch(/empty\.png$/);
    const onDisk = await fs.readFile(join(e.root, 'assets', 'RezonaAssets', 'hero.glb'));
    expect(sha(new Uint8Array(onDisk))).toBe(sha(a));
    expect((await fs.stat(join(e.root, 'assets', 'RezonaAssets', 'empty.png'))).size).toBe(0);
    expect(e.calls).toHaveLength(2);
    expect(connection.state).toBe('open');
  });

  it('rejects a concurrent second send with BUSY and finishes the first one', async () => {
    await up();
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    const first = send(connection, { name: 'a.glb', bytes: bytesOf(64, 3).buffer, kind: 'model3d' }, () => undefined);
    expect(connection.busy).toBe(true);
    const err = await asError(send(connection, { name: 'b.glb', bytes: bytesOf(8, 5).buffer, kind: 'model3d' }, () => undefined));
    expect(err.code).toBe('BUSY');
    await expect(first).resolves.toMatchObject({ savedPath: expect.stringMatching(/a\.glb$/) });
  });

  it('validates format and size locally before touching the wire', async () => {
    await up();
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    expect((await asError(send(connection, { name: 'x.exe', bytes: bytesOf(8, 1).buffer, kind: 'other' }, () => undefined))).code).toBe('UNSUPPORTED_FORMAT');
    expect((await asError(send(connection, { name: 'x.png', bytes: bytesOf(5000, 1).buffer, kind: 'image' }, () => undefined))).code).toBe('TOO_LARGE');
    expect(connection.state).toBe('open');
  });

  it('surfaces CHECKSUM_MISMATCH when the announced sha256 does not match the bytes sent', async () => {
    await up();
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    const events: SendProgress[] = [];
    const err = await asError(
      send(connection, { name: 'bad.glb', bytes: bytesOf(40, 9).buffer, kind: 'model3d' }, (p) => events.push(p), { sha256: sha(bytesOf(40, 11)) }),
    );
    expect(err.code).toBe('CHECKSUM_MISMATCH');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'CHECKSUM_MISMATCH' });
    // 服务端回到 ready，连接保持，还能继续传。
    expect(connection.state).toBe('open');
    await expect(send(connection, { name: 'ok.glb', bytes: bytesOf(8, 2).buffer, kind: 'model3d' }, () => undefined)).resolves.toBeTruthy();
  });

  it('finds two instances on two ports but keeps only one live connection; switchInstance moves it', async () => {
    const e1 = await up();
    const e2 = await up({ project: { name: 'Q', id: 'q2' } });
    const { connection, instances } = track(await connectEngine('cocos', baseOpts()));
    expect(instances.map((i) => i.port).sort()).toEqual([e1.server.port, e2.server.port].sort());
    expect(connection.instance.port).toBe(e1.server.port);
    await sleep(50);
    expect(e1.server.snapshot().connected).toBe(true);
    expect(e2.server.snapshot().connected).toBe(false);

    const next = await switchInstance(connection, e2.server.port as number);
    connections.push(next);
    expect(connection.state).toBe('closed');
    expect(next.state).toBe('open');
    expect(next.instance.project.name).toBe('Q');
    await sleep(50);
    expect(e1.server.snapshot().connected).toBe(false);
    expect(e2.server.snapshot().connected).toBe(true);
    await expect(send(next, { name: 'z.png', bytes: bytesOf(20, 4).buffer, kind: 'image' }, () => undefined)).resolves.toBeTruthy();
    expect(e2.calls).toHaveLength(1);
  });

  it('fires onClose when the server stops and never reconnects on its own', async () => {
    const e = await up();
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    const closed = new Promise<{ code: number }>((r) => connection.onClose(r));
    await e.server.stop();
    expect((await closed).code).toBe(1000);
    expect(connection.state).toBe('closed');
    // 同端口把服务端拉起来，观察一段时间：客户端不得自己摸回来。
    await e.server.start();
    await sleep(300);
    expect(e.server.snapshot().connected).toBe(false);
  });

  it('a send in flight when the connection drops rejects with DISCONNECTED', async () => {
    const e = await up({ adapter: { importFile: () => new Promise(() => undefined), isProjectOpen: () => true } });
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    const pending = send(connection, { name: 'slow.glb', bytes: bytesOf(8, 1).buffer, kind: 'model3d' }, () => undefined);
    await sleep(100);
    await e.server.stop();
    expect((await asError(pending)).code).toBe('DISCONNECTED');
    expect(connection.busy).toBe(false);
  });

  it('throws NO_ENGINE when nothing listens on the range', async () => {
    expect((await asError(connectEngine('cocos', baseOpts()))).code).toBe('NO_ENGINE');
  });

  it('suspects an LNA denial when every socket errors instantly and none opens', async () => {
    const instantFail = (): WebSocketLike => {
      const listeners: Record<string, Array<(ev: unknown) => void>> = {};
      const sock: WebSocketLike = {
        binaryType: 'arraybuffer',
        readyState: 3,
        send: () => undefined,
        close: () => undefined,
        addEventListener: (type: string, cb: (ev: unknown) => void) => void (listeners[type] ??= []).push(cb),
      };
      queueMicrotask(() => {
        for (const cb of listeners['error'] ?? []) cb({});
        for (const cb of listeners['close'] ?? []) cb({ code: 1006, reason: '' });
      });
      return sock;
    };
    const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    expect((await asError(connectEngine('cocos', { createSocket: instantFail, portRange: RANGE, userAgent: chrome }))).code).toBe('LNA_DENIED_SUSPECTED');
    // 非 Chromium（或无 UA）下同样的瞬间失败只是没引擎在跑
    expect((await asError(connectEngine('cocos', { createSocket: instantFail, portRange: RANGE, userAgent: '' }))).code).toBe('NO_ENGINE');
    // 默认选项（不覆盖 lnaSuspectMs）对着空端口段：真实 ECONNREFUSED 也必须是 NO_ENGINE
    expect((await asError(connectEngine('cocos', { createSocket, portRange: RANGE }))).code).toBe('NO_ENGINE');
  });

  /** 裸 ws 服务端 stub：二进制帧一律回 chunk_ack，文本帧按 hello / 其它分发。用于 core-ts 不会产生的对端行为。 */
  const stubServer = (port: number, onHello: (ws: WebSocket, hello: Record<string, unknown>) => void, onOther?: (ws: WebSocket, msg: Record<string, unknown>) => void) =>
    new Promise<WebSocketServer>((resolve) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/rezona-bridge' });
      wss.on('connection', (ws) => {
        ws.on('message', (raw, isBinary) => {
          if (isBinary) {
            const buf = raw as Buffer;
            const header = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()) as { transferId: string; index: number };
            ws.send(JSON.stringify({ type: 'chunk_ack', transferId: header.transferId, index: header.index }));
            return;
          }
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg['type'] === 'hello') onHello(ws, msg);
          else onOther?.(ws, msg);
        });
      });
      wss.on('listening', () => {
        stubs.push(wss);
        resolve(wss);
      });
    });
  const ack = (over: Record<string, unknown> = {}) => JSON.stringify({
    type: 'hello_ack', protocol: 1, engine: 'cocos', engineVersion: '3.8.6', pluginVersion: '0.1.0', project: { name: 'S', id: 's' }, limits: LIMITS, formats: ['glb'], ...over,
  });

  it('maps protocol 2 / PROTOCOL_MISMATCH / low pluginVersion to PLUGIN_OUTDATED', async () => {
    await stubServer(RANGE[0], (ws) => ws.send(ack({ protocol: 2 })));
    expect((await asError(connectEngine('cocos', baseOpts()))).code).toBe('PLUGIN_OUTDATED');
    await new Promise<void>((r) => stubs.pop()?.close(() => r()));

    await stubServer(RANGE[0], (ws) => {
      ws.send(JSON.stringify({ type: 'error', code: 'PROTOCOL_MISMATCH', message: 'nope' }));
      ws.close(4426, 'protocol mismatch');
    });
    expect((await asError(connectEngine('cocos', baseOpts()))).code).toBe('PLUGIN_OUTDATED');
    await new Promise<void>((r) => stubs.pop()?.close(() => r()));

    let closeCode = 0;
    await stubServer(RANGE[0], (ws) => {
      ws.on('close', (c) => (closeCode = c));
      ws.send(ack({ pluginVersion: '0.0.9' }));
    });
    expect((await asError(connectEngine('cocos', baseOpts()))).code).toBe('PLUGIN_OUTDATED');
    await sleep(50);
    expect(closeCode).toBe(1000);
  });

  it('marks the connection closed with reason HEARTBEAT when pongs stop coming', async () => {
    const pings: number[] = [];
    await stubServer(RANGE[0], (ws) => ws.send(ack()), (_ws, msg) => {
      if (msg['type'] === 'ping') pings.push(Date.now());
    });
    const { connection } = track(await connectEngine('cocos', baseOpts({ pingIntervalMs: 30, pongTimeoutMs: 120 })));
    const closed = await new Promise<{ code: number; reason: string }>((r) => connection.onClose(r));
    expect(closed.reason).toBe('HEARTBEAT');
    expect(connection.state).toBe('closed');
    expect(pings.length).toBeGreaterThanOrEqual(2);
  });

  it('replies pong to a server ping', async () => {
    let gotPong = false;
    await stubServer(RANGE[0], (ws) => {
      ws.send(ack());
      ws.send(JSON.stringify({ type: 'ping' }));
    }, (_ws, msg) => {
      if (msg['type'] === 'pong') gotPong = true;
    });
    track(await connectEngine('cocos', baseOpts({ pingIntervalMs: 10_000 })));
    await sleep(80);
    expect(gotPong).toBe(true);
  });

  it('does not lose frames that a server emits back-to-back in one tick (received + importing + import_result)', async () => {
    // 真 ws 服务端会把同一 TCP 段里的多帧同步连发；这里用 stub 强制三帧同 tick 出去，复现曾经悬住传输的竞态。
    await stubServer(RANGE[0], (ws) => ws.send(ack()), (ws, msg) => {
      if (msg['type'] !== 'transfer_end') return;
      const t = msg['transferId'];
      ws.send(JSON.stringify({ type: 'import_progress', transferId: t, stage: 'received' }));
      ws.send(JSON.stringify({ type: 'import_progress', transferId: t, stage: 'importing' }));
      ws.send(JSON.stringify({ type: 'import_result', transferId: t, ok: true, savedPath: 'db://x.glb' }));
    });
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    for (let i = 0; i < 5; i++) {
      const r = await send(connection, { name: 'x.glb', bytes: bytesOf(20, i + 1).buffer, kind: 'model3d' }, () => undefined, { timeoutMs: 2000 });
      expect(r.savedPath).toBe('db://x.glb');
    }
  });

  it('propagates a server-side import failure code and an importing-stage timeout', async () => {
    const e = await up({ adapter: { importFile: async () => { throw new Error('boom'); }, isProjectOpen: () => true } });
    const { connection } = track(await connectEngine('cocos', baseOpts()));
    expect((await asError(send(connection, { name: 'f.glb', bytes: bytesOf(8, 1).buffer, kind: 'model3d' }, () => undefined))).code).toBe('IMPORT_FAILED');
    await e.server.stop();
    engines.splice(engines.indexOf(e), 1);
    await fs.rm(e.root, { recursive: true, force: true });

    await up({ adapter: { importFile: () => new Promise(() => undefined), isProjectOpen: () => true }, importTimeoutMs: 60_000 });
    const { connection: c2 } = track(await connectEngine('cocos', baseOpts()));
    const err = await asError(send(c2, { name: 'g.glb', bytes: bytesOf(8, 1).buffer, kind: 'model3d' }, () => undefined, { importTimeoutMs: 100 }));
    expect(err.code).toBe('IMPORT_TIMEOUT');
  });
});
