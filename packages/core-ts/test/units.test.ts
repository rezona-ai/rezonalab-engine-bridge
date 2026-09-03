import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { encodeBinary, parseBinary, parseText } from '../src/framing.js';
import { Heartbeat } from '../src/heartbeat.js';
import { isAllowedOrigin, normalizeOrigin } from '../src/origin.js';
import { PortsExhaustedError, listenOnFirstFreePort } from '../src/ports.js';
import { TransferReceiver, uniquePath, validateBegin } from '../src/receiver.js';
import { createBridgeServer, type BridgeServer } from '../src/server.js';
import { DEFAULT_FORMATS, type TransferBeginMessage } from '../src/types.js';
import { sanitizeZipEntryName, isSymlinkEntry } from '../src/zipsafe.js';

const LIMITS = { chunkBytes: 16, maxFileBytes: 4096, maxChunks: 256 };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('origin', () => {
  it('matches scheme+host+port exactly and rejects missing header', () => {
    const list = ['https://lab.rezona.ai', 'http://localhost:3000'];
    expect(isAllowedOrigin('https://lab.rezona.ai', list)).toBe(true);
    expect(isAllowedOrigin('HTTPS://LAB.REZONA.AI', list)).toBe(true);
    expect(isAllowedOrigin('https://lab.rezona.ai:443', list)).toBe(true);
    expect(isAllowedOrigin('http://lab.rezona.ai', list)).toBe(false);
    expect(isAllowedOrigin('https://lab.rezona.ai.evil.com', list)).toBe(false);
    expect(isAllowedOrigin('http://localhost:3001', list)).toBe(false);
    expect(isAllowedOrigin(undefined, list)).toBe(false);
    expect(isAllowedOrigin('null', list)).toBe(false);
    expect(normalizeOrigin('https://a.b/path')).toBeNull();
  });
});

describe('framing', () => {
  it('rejects headerLen out of range as bad frame', () => {
    const tooBig = Buffer.alloc(8);
    tooBig.writeUInt32BE(5000, 0);
    expect(parseBinary(tooBig).ok).toBe(false);
    const overflow = Buffer.alloc(8);
    overflow.writeUInt32BE(100, 0);
    expect(parseBinary(overflow).ok).toBe(false);
  });
  it('round-trips a binary chunk', () => {
    const data = Buffer.from('hello');
    const r = parseBinary(encodeBinary({ transferId: 't', index: 3 }, data));
    expect(r.ok && r.value.header).toEqual({ transferId: 't', index: 3 });
    expect(r.ok && r.value.data.toString()).toBe('hello');
  });
  it('rejects non-JSON, oversized and schema-violating text', () => {
    expect(parseText('{').ok).toBe(false);
    expect(parseText('x'.repeat(70 * 1024)).ok).toBe(false);
    expect(parseText('{"type":"hello"}').ok).toBe(false);
    expect(parseText('{"type":"chunk_ack","transferId":"t","index":-1}').ok).toBe(false);
  });
});

describe('heartbeat', () => {
  it('pings every 15 s and times out at 60 s of silence, timeout wins a tie', () => {
    const hb = new Heartbeat();
    expect(hb.advance(61_000)).toEqual(['ping', 'ping', 'ping', 'timeout']);
  });
  it('inbound frames reset the deadline but not the ping cadence', () => {
    const hb = new Heartbeat();
    expect(hb.advance(50_000)).toEqual(['ping', 'ping', 'ping']);
    hb.onInboundFrame();
    expect(hb.advance(50_000)).toEqual(['ping', 'ping', 'ping']);
    expect(hb.advance(20_000)).toEqual(['ping', 'timeout']);
  });
});

describe('validateBegin', () => {
  const base: TransferBeginMessage = { type: 'transfer_begin', transferId: 't', fileName: 'a.glb', byteSize: 40, sha256: '0'.repeat(64), kind: 'model3d', chunkBytes: 16, chunkCount: 3 };
  it('rejects path separators, dot-dot and control chars in fileName', () => {
    for (const fileName of ['a/b.glb', 'a\\b.glb', '..glb', 'a\x00.glb', '.hidden.glb', ' a.glb']) {
      expect(validateBegin({ ...base, fileName }, LIMITS, DEFAULT_FORMATS)?.kind, fileName).toBe('bad_frame');
    }
  });
  it('rejects unknown formats as app error and sprite must be zip', () => {
    expect(validateBegin({ ...base, fileName: 'a.exe' }, LIMITS, DEFAULT_FORMATS)).toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    expect(validateBegin({ ...base, fileName: 'a.png', kind: 'sprite' }, LIMITS, DEFAULT_FORMATS)).toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
  it('checks limits before consistency', () => {
    expect(validateBegin({ ...base, byteSize: 9999, chunkCount: 625 }, LIMITS, DEFAULT_FORMATS)).toMatchObject({ code: 'TOO_LARGE' });
    expect(validateBegin({ ...base, chunkCount: 4 }, LIMITS, DEFAULT_FORMATS)).toMatchObject({ kind: 'bad_frame' });
    expect(validateBegin(base, LIMITS, DEFAULT_FORMATS)).toBeNull();
  });
});

describe('TransferReceiver', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rezona-recv-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const begin = (data: Buffer, fileName = 'a.glb'): TransferBeginMessage => ({
    type: 'transfer_begin', transferId: 'tx', fileName, byteSize: data.length, sha256: sha(data), kind: 'model3d', chunkBytes: 16, chunkCount: Math.ceil(data.length / 16),
  });

  it('incremental sha256 equals one-shot sha256 and file lands with suffix on collision', async () => {
    const data = Buffer.from('0123456789abcdefXYZ');
    const dest = join(root, 'assets', 'RezonaAssets');
    for (const expected of ['a.glb', 'a-2.glb', 'a-3.glb']) {
      const r = new TransferReceiver(begin(data), join(root, 'tmp'));
      await r.open();
      await r.writeChunk(0, data.subarray(0, 16));
      await r.writeChunk(1, data.subarray(16));
      expect(await r.finish()).toEqual({ ok: true });
      const target = await r.moveTo(dest);
      expect(target).toBe(join(dest, expected));
      expect(sha(await fs.readFile(target))).toBe(sha(data));
    }
    expect(await fs.readdir(join(root, 'tmp'))).toEqual([]);
  });

  it('rejects out-of-order and wrong-size chunks, and abort removes the .part', async () => {
    const data = Buffer.alloc(40, 1);
    const r = new TransferReceiver(begin(data), join(root, 'tmp'));
    await r.open();
    await expect(r.writeChunk(1, data.subarray(16, 32))).rejects.toThrow(/expected chunk 0/);
    await expect(r.writeChunk(0, data.subarray(0, 8))).rejects.toThrow(/expected 16/);
    await r.writeChunk(0, data.subarray(0, 16));
    expect(await fs.readdir(join(root, 'tmp'))).toHaveLength(1);
    await r.abort();
    expect(await fs.readdir(join(root, 'tmp'))).toEqual([]);
  });

  it('uniquePath works for directories too', async () => {
    await fs.mkdir(join(root, 'hero'));
    expect(await uniquePath(root, 'hero')).toBe(join(root, 'hero-2'));
  });
});

describe('zipsafe helpers', () => {
  it('sanitizes entry names', () => {
    expect(sanitizeZipEntryName('a/b.png')).toBe('a/b.png');
    expect(sanitizeZipEntryName('./a//b.png')).toBe('a/b.png');
    expect(sanitizeZipEntryName('a\\b.png')).toBe('a/b.png');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '\\\\server\\share', 'C:\\x', 'a\x00b', '', '.']) {
      expect(sanitizeZipEntryName(bad), bad).toBeNull();
    }
  });
  it('detects symlink attributes', () => {
    expect(isSymlinkEntry((0o120777 << 16) >>> 0)).toBe(true);
    expect(isSymlinkEntry((0o100644 << 16) >>> 0)).toBe(false);
  });
});

describe('ports', () => {
  it('skips busy ports and throws when the range is exhausted', async () => {
    const a = await listenOnFirstFreePort([47100, 47101]);
    const b = await listenOnFirstFreePort([47100, 47101]);
    expect(a.port).toBe(47100);
    expect(b.port).toBe(47101);
    await expect(listenOnFirstFreePort([47100, 47101])).rejects.toBeInstanceOf(PortsExhaustedError);
    await new Promise((r) => a.server.close(r));
    await new Promise((r) => b.server.close(r));
  });
});

describe('createBridgeServer over real ws', () => {
  let root: string;
  let server: BridgeServer;
  const adapter = { calls: [] as string[], async importFile(p: string) { adapter.calls.push(p); return { savedPath: p }; }, isProjectOpen: () => true };
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rezona-srv-'));
    server = createBridgeServer({
      engine: 'fake', engineVersion: '0', pluginVersion: '0.1.0', project: { name: 'P', id: 'p1' }, assetsRoot: join(root, 'assets'), tmpDir: join(root, 'tmp'),
      portRange: [47200, 47203], adapter, limits: LIMITS, extraOrigins: ['http://localhost:3000'],
    });
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  // 每条连接挂一个常驻监听 + 队列：ws 在高负载下会把 received / importing / import_result 合并在同一 tick 内连续 emit，
  // 按需挂 once 监听会漏掉后续帧而挂死；服务端心跳 ping 一律跳过。
  const queues = new WeakMap<WebSocket, { items: Record<string, unknown>[]; waiters: ((m: Record<string, unknown>) => void)[] }>();
  const connect = (origin?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/rezona-bridge`, origin ? { origin } : {});
    const q = { items: [] as Record<string, unknown>[], waiters: [] as ((m: Record<string, unknown>) => void)[] };
    queues.set(ws, q);
    ws.on('message', (d, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(d.toString()) as Record<string, unknown>;
      if (msg.type === 'ping') return;
      const w = q.waiters.shift();
      if (w) w(msg);
      else q.items.push(msg);
    });
    return ws;
  };
  const waitClose = (ws: WebSocket) => new Promise<number>((r) => ws.on('close', (code) => r(code)));
  const nextText = (ws: WebSocket) =>
    new Promise<Record<string, unknown>>((r) => {
      const q = queues.get(ws)!;
      const head = q.items.shift();
      if (head) r(head);
      else q.waiters.push(r);
    });

  it('closes 4403 for a foreign origin and 4400 for a client that skips hello', async () => {
    const evil = connect('https://evil.example');
    expect(await waitClose(evil)).toBe(4403);
    const rude = connect('https://lab.rezona.ai');
    await new Promise((r) => rude.on('open', r));
    rude.send(JSON.stringify({ type: 'ping' }));
    expect(await waitClose(rude)).toBe(4400);
  });

  it('transfers a file end to end and disconnect mid-transfer cleans the .part', async () => {
    const ws = connect('http://localhost:3000');
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, client: 'test', clientVersion: '0' }));
    const ack = await nextText(ws);
    expect(ack.type).toBe('hello_ack');
    const data = Buffer.alloc(40, 7);
    ws.send(JSON.stringify({ type: 'transfer_begin', transferId: 't1', fileName: 'x.png', byteSize: 40, sha256: sha(data), kind: 'image', chunkBytes: 16, chunkCount: 3 }));
    for (let i = 0; i < 3; i++) {
      ws.send(encodeBinary({ transferId: 't1', index: i }, data.subarray(i * 16, i * 16 + 16)));
      expect((await nextText(ws)).type).toBe('chunk_ack');
    }
    ws.send(JSON.stringify({ type: 'transfer_end', transferId: 't1' }));
    expect(await nextText(ws)).toMatchObject({ type: 'import_progress', stage: 'received' });
    expect(await nextText(ws)).toMatchObject({ type: 'import_progress', stage: 'importing' });
    expect(await nextText(ws)).toMatchObject({ type: 'import_result', ok: true, savedPath: join(root, 'assets', 'RezonaAssets', 'x.png') });
    expect(server.state).toBe('listening');

    // 第二次传输中途断开：临时文件必须被清掉，服务端回到 listening
    ws.send(JSON.stringify({ type: 'transfer_begin', transferId: 't2', fileName: 'y.png', byteSize: 40, sha256: sha(data), kind: 'image', chunkBytes: 16, chunkCount: 3 }));
    ws.send(encodeBinary({ transferId: 't2', index: 0 }, data.subarray(0, 16)));
    expect((await nextText(ws)).type).toBe('chunk_ack');
    expect(server.state).toBe('busy');
    ws.close(1000);
    await new Promise((r) => setTimeout(r, 100));
    expect(await fs.readdir(join(root, 'tmp'))).toEqual([]);
    expect(server.state).toBe('listening');
  });

  it('a second connection while idle replaces the first with 1000', async () => {
    const a = connect('https://lab.rezona.ai');
    await new Promise((r) => a.on('open', r));
    const b = connect('https://lab.rezona.ai');
    await new Promise((r) => b.on('open', r));
    expect(await waitClose(a)).toBe(1000);
    b.close();
  });
});
