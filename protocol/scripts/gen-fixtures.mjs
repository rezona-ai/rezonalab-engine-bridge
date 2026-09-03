// 生成 protocol/fixtures/*.json。确定性：字节来自固定种子的 LCG，zip 用 stored 方式手写，
// 因此任何人重跑输出完全一致。改协议后改这里再 `npm run gen:fixtures`，不要手改夹具。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures');
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.json')) unlinkSync(join(outDir, f));

const ORIGIN = 'https://lab.rezona.ai';
const LIMITS = { chunkBytes: 16, maxFileBytes: 4096, maxChunks: 256 };
const HELLO = { type: 'hello', protocol: 1, client: 'rezona-web', clientVersion: '1.0.0' };
const HELLO_ACK = {
  type: 'hello_ack', protocol: 1, engine: 'fake', engineVersion: '0.0.0', pluginVersion: '0.1.0',
  project: { name: 'Fixture', id: 'fixture1' }, limits: LIMITS,
  formats: ['glb', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav', 'ogg', 'zip'],
};

function bytes(n, seed) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (x * 1664525 + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

// 最小 stored zip 写法（无压缩），够夹具用。
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const data = e.data ?? Buffer.alloc(0); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(e.extAttr ?? ((0o100644 << 16) >>> 0), 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name); offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const inText = (text) => ({ dir: 'in', text });
const inBin = (transferId, index, data) => ({ dir: 'in', binary: { header: { transferId, index }, bytesBase64: data.toString('base64') } });
const tick = (ms) => ({ dir: 'tick', ms });

function begin(transferId, fileName, data, kind, extra = {}) {
  return {
    type: 'transfer_begin', transferId, fileName, byteSize: data.length, sha256: sha(data), kind,
    chunkBytes: LIMITS.chunkBytes, chunkCount: Math.ceil(data.length / LIMITS.chunkBytes),
    meta: { itemId: 'item-1', displayName: 'Hero' }, ...extra,
  };
}
function chunks(transferId, data) {
  const out = []; for (let i = 0, idx = 0; i < data.length; i += LIMITS.chunkBytes, idx++) out.push(inBin(transferId, idx, data.subarray(i, i + LIMITS.chunkBytes)));
  return out;
}
const acks = (transferId, n) => Array.from({ length: n }, (_, i) => ({ type: 'chunk_ack', transferId, index: i }));
const progress = (transferId) => [{ type: 'import_progress', transferId, stage: 'received' }, { type: 'import_progress', transferId, stage: 'importing' }];

const fixtures = [];
function add(name, body) { fixtures.push({ name, origin: ORIGIN, server: { limits: LIMITS }, ...body }); }

// 1. 单块成功
{
  const d = bytes(10, 1); const t = 't1';
  add('happy-single-chunk', {
    frames: [inText(HELLO), inText(begin(t, 'hero.glb', d, 'model3d')), ...chunks(t, d), inText({ type: 'transfer_end', transferId: t })],
    expect: {
      outFrames: [HELLO_ACK, ...acks(t, 1), ...progress(t), { type: 'import_result', transferId: t, ok: true, savedPath: '<root>/RezonaAssets/hero.glb', sceneNode: 'Hero' }],
      closeCode: null, finalState: 'ready', savedFileSha256: sha(d), files: ['RezonaAssets/hero.glb'], adapterCalls: [{ fileName: 'hero.glb', kind: 'model3d' }],
    },
  });
}
// 2. 三块成功（16+16+8）
{
  const d = bytes(40, 2); const t = 't2';
  add('happy-multi-chunk', {
    frames: [inText(HELLO), inText(begin(t, 'theme.mp3', d, 'audio')), ...chunks(t, d), inText({ type: 'transfer_end', transferId: t })],
    expect: {
      outFrames: [HELLO_ACK, ...acks(t, 3), ...progress(t), { type: 'import_result', transferId: t, ok: true, savedPath: '<root>/RezonaAssets/theme.mp3' }],
      closeCode: null, finalState: 'ready', savedFileSha256: sha(d), files: ['RezonaAssets/theme.mp3'], adapterCalls: [{ fileName: 'theme.mp3', kind: 'audio' }],
    },
  });
}
// 3. Origin 拒绝：握手阶段关 4403，无任何出帧
fixtures.push({
  name: 'origin-rejected', origin: 'https://evil.example', server: { limits: LIMITS },
  frames: [inText(HELLO)],
  expect: { outFrames: [], closeCode: 4403, finalState: 'idle', savedFileSha256: null, files: [], adapterCalls: [] },
});
// 4. 校验失败：末块翻一个字节
{
  const d = bytes(40, 4); const t = 't4'; const bad = Buffer.from(d); bad[39] ^= 0xff;
  add('checksum-mismatch', {
    frames: [inText(HELLO), inText(begin(t, 'hero.glb', d, 'model3d')), ...chunks(t, bad), inText({ type: 'transfer_end', transferId: t })],
    expect: {
      outFrames: [HELLO_ACK, ...acks(t, 3), { type: 'import_result', transferId: t, ok: false, error: { code: 'CHECKSUM_MISMATCH', message: 'sha256 mismatch' } }],
      closeCode: null, finalState: 'ready', savedFileSha256: null, files: [], adapterCalls: [],
    },
  });
}
// 5. begin 阶段超大小限额
{
  const t = 't5';
  add('too-large-begin', {
    frames: [inText(HELLO), inText({ type: 'transfer_begin', transferId: t, fileName: 'huge.glb', byteSize: 5000, sha256: '0'.repeat(64), kind: 'model3d', chunkBytes: 16, chunkCount: 313 })],
    expect: {
      outFrames: [HELLO_ACK, { type: 'error', code: 'TOO_LARGE', message: 'byteSize 5000 exceeds maxFileBytes 4096', transferId: t }],
      closeCode: 4413, finalState: 'idle', savedFileSha256: null, files: [], adapterCalls: [],
    },
  });
}
// 6. begin 阶段分块数超限
{
  const t = 't6';
  add('too-many-chunks', {
    frames: [inText(HELLO), inText({ type: 'transfer_begin', transferId: t, fileName: 'many.glb', byteSize: 4000, sha256: '0'.repeat(64), kind: 'model3d', chunkBytes: 16, chunkCount: 300 })],
    expect: {
      outFrames: [HELLO_ACK, { type: 'error', code: 'TOO_MANY_CHUNKS', message: 'chunkCount 300 exceeds maxChunks 256', transferId: t }],
      closeCode: 4413, finalState: 'idle', savedFileSha256: null, files: [], adapterCalls: [],
    },
  });
}
// 7. receiving 中再来一个 begin → 4409
{
  const d = bytes(40, 7); const t = 't7';
  add('busy-second-transfer', {
    frames: [inText(HELLO), inText(begin(t, 'a.glb', d, 'model3d')), chunks(t, d)[0], inText(begin('t7b', 'b.glb', d, 'model3d'))],
    expect: { outFrames: [HELLO_ACK, ...acks(t, 1)], closeCode: 4409, finalState: 'idle', savedFileSha256: null, files: [], adapterCalls: [] },
  });
}
// 8. 心跳超时：60 秒无帧 → 4408；此前每 15 秒一个 ping（15/30/45），60 秒整点先判超时不再发 ping
add('heartbeat-timeout', {
  frames: [inText(HELLO), tick(61000)],
  expect: { outFrames: [HELLO_ACK, { type: 'ping' }, { type: 'ping' }, { type: 'ping' }], closeCode: 4408, finalState: 'idle', savedFileSha256: null, files: [], adapterCalls: [] },
});
// 9. zip 路径穿越
{
  const z = zip([{ name: '../evil.txt', data: Buffer.from('evil') }]); const t = 't9';
  add('zip-traversal', {
    frames: [inText(HELLO), inText(begin(t, 'hero.zip', z, 'sprite')), ...chunks(t, z), inText({ type: 'transfer_end', transferId: t })],
    expect: {
      outFrames: [HELLO_ACK, ...acks(t, Math.ceil(z.length / 16)), { type: 'import_progress', transferId: t, stage: 'received' },
        { type: 'import_result', transferId: t, ok: false, error: { code: 'ZIP_UNSAFE_ENTRY', message: 'unsafe zip entry: ../evil.txt' } }],
      closeCode: null, finalState: 'ready', savedFileSha256: null, files: [], adapterCalls: [],
    },
  });
}
// 10. sprite zip 正常解压到 RezonaAssets/hero/
{
  const png = bytes(24, 10); const json = Buffer.from('{"frames":[]}');
  const z = zip([{ name: 'hero.png', data: png }, { name: 'hero.json', data: json }]); const t = 't10';
  add('zip-ok-sprite', {
    frames: [inText(HELLO), inText(begin(t, 'hero.zip', z, 'sprite')), ...chunks(t, z), inText({ type: 'transfer_end', transferId: t })],
    expect: {
      outFrames: [HELLO_ACK, ...acks(t, Math.ceil(z.length / 16)), ...progress(t), { type: 'import_result', transferId: t, ok: true, savedPath: '<root>/RezonaAssets/hero' }],
      closeCode: null, finalState: 'ready', savedFileSha256: null, files: ['RezonaAssets/hero/hero.json', 'RezonaAssets/hero/hero.png'], adapterCalls: [{ fileName: 'hero', kind: 'sprite' }],
    },
  });
}
// 11. 协议版本不兼容
add('protocol-mismatch', {
  frames: [inText({ ...HELLO, protocol: 2 })],
  expect: {
    outFrames: [{ type: 'error', code: 'PROTOCOL_MISMATCH', message: 'unsupported protocol 2, plugin speaks 1' }],
    closeCode: 4426, finalState: 'idle', savedFileSha256: null, files: [], adapterCalls: [],
  },
});

for (const f of fixtures) writeFileSync(join(outDir, `${f.name}.json`), JSON.stringify(f, null, 2) + '\n');
console.log(`wrote ${fixtures.length} fixtures to ${outDir}`);
