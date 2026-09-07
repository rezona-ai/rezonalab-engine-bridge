// 对着真编辑器的插件推一个文件，走完整协议（hello → transfer_begin → chunk → transfer_end）。
// 用途：验 sprite（zip 解压落盘）与 fbx（Unity 走自带 ModelImporter）这两条从没用真样本跑过的路。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import WebSocket from 'ws';

const [port, file, kind] = process.argv.slice(2);
const bytes = readFileSync(file);
const sha = createHash('sha256').update(bytes).digest('hex');
const name = basename(file);
const ext = extname(name).slice(1).toLowerCase();
const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;

const ws = new WebSocket(`ws://127.0.0.1:${port}/rezona-bridge`, { origin: 'http://localhost:3000' });
const q = [];
let waiter = null;
const next = () => new Promise((r) => (q.length ? r(q.shift()) : (waiter = r)));
ws.on('message', (raw) => {
  const text = raw.toString();
  console.log(`  ${stamp()} << ${text.slice(0, 240)}`);
  const m = JSON.parse(text);
  if (waiter) { const w = waiter; waiter = null; w(m); } else q.push(m);
});
ws.on('close', (c, r) => console.log(`  ${stamp()} [close] ${c} ${String(r)}`));
ws.on('error', (e) => { console.log(`  ${stamp()} [error] ${e.message}`); process.exit(1); });
setTimeout(() => { console.log(`${stamp()} TIMEOUT — 插件在这一步没有回帧`); process.exit(1); }, 120000);

await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'hello', protocol: 1, client: 'rezona-web', clientVersion: '0.1.7' }));
const ack = await next();
if (ack.type !== 'hello_ack') { console.log('握手失败'); process.exit(1); }
console.log(`engine=${ack.engine} project=${ack.project?.name} plugin=${ack.pluginVersion}`);
console.log(`formats 收 ${ext}? ${ack.formats.includes(ext)}   limits=${JSON.stringify(ack.limits)}`);

// 协议要求 transfer_begin 声明的 chunkBytes **恰好等于** hello_ack 里的值（否则 4400），
// 不是「不超过」。最后一块可以短，但声明值必须照抄。
const CHUNK = ack.limits.chunkBytes;
const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
console.log(`chunkBytes=${CHUNK} chunkCount=${chunks} byteSize=${bytes.length}`);

ws.send(JSON.stringify({ type: 'transfer_begin', transferId: 't1', fileName: name, byteSize: bytes.length, sha256: sha, kind, chunkBytes: CHUNK, chunkCount: chunks }));
for (let i = 0; i < chunks; i++) {
  const body = bytes.subarray(i * CHUNK, Math.min(bytes.length, (i + 1) * CHUNK));
  const header = Buffer.from(JSON.stringify({ transferId: 't1', index: i }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  ws.send(Buffer.concat([len, header, body]));
  const a = await next();
  if (a.type !== 'chunk_ack') { console.log('分块被拒'); process.exit(1); }
}
console.log(`  ${stamp()} >> transfer_end`);
ws.send(JSON.stringify({ type: 'transfer_end', transferId: 't1' }));
for (;;) {
  const m = await next();
  if (m.type === 'import_progress') continue;
  if (m.type === 'import_result') { console.log(m.ok ? `OK savedPath=${m.savedPath} sceneNode=${m.sceneNode ?? '-'}` : `FAIL ${m.error?.code} ${m.error?.message}`); break; }
  if (m.type === 'error') { console.log(`FAIL ${m.code} ${m.message}`); break; }
}
ws.close();
process.exit(0);
