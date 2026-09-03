import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import { BridgeError } from './types.js';

export const ZIP_MAX_ENTRIES = 500;
export const ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/**
 * 条目名安全性：拒绝绝对路径、反斜杠开头、盘符、`..` 段、NUL、空名；反斜杠统一视为分隔符（Windows 打的包）。
 * 返回规范化后的相对路径（正斜杠），不安全返回 null。
 */
export function sanitizeZipEntryName(name: string): string | null {
  if (!name || name.includes('\x00')) return null;
  if (name.startsWith('/') || name.startsWith('\\')) return null;
  if (/^[A-Za-z]:/.test(name)) return null;
  const segments = name.replace(/\\/g, '/').split('/');
  for (const seg of segments) {
    if (seg === '..') return null;
  }
  const cleaned = segments.filter((s) => s !== '' && s !== '.').join('/');
  return cleaned || null;
}

/** ZIP 外部属性高 16 位是 Unix mode；S_IFLNK 表示符号链接，整包拒绝。 */
export function isSymlinkEntry(externalFileAttributes: number): boolean {
  return ((externalFileAttributes >>> 16) & 0xf000) === 0xa000;
}

/**
 * 流式安全解压到 destDir：条目名校验 + realpath 前缀断言 + 条目数 / 总量限额；解压时按实际字节计数（不信头里的 uncompressedSize）。
 * 任一失败会删掉整个 destDir 后抛 BridgeError。
 */
export async function extractZipSafe(
  zipPath: string,
  destDir: string,
  opts: { maxEntries?: number; maxTotalBytes?: number } = {},
): Promise<void> {
  const maxEntries = opts.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxTotal = opts.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  await fs.mkdir(destDir, { recursive: true });
  const destReal = await fs.realpath(destDir);
  const prefix = destReal.endsWith(sep) ? destReal : destReal + sep;
  try {
    await new Promise<void>((resolveDone, reject) => {
      // decodeStrings:false 让 yauzl 不做自己的路径校验，把原始名交给我们统一判定（这样 sanitize 被注掉时夹具才会变红）
      yauzl.open(zipPath, { lazyEntries: true, decodeStrings: false, autoClose: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error('yauzl open failed'));
        let count = 0;
        let total = 0;
        const fail = (e: unknown) => {
          zipfile.close();
          reject(e);
        };
        zipfile.on('error', fail);
        zipfile.on('end', () => resolveDone());
        zipfile.on('entry', (entry: yauzl.Entry) => {
          void (async () => {
            count += 1;
            if (count > maxEntries) throw new BridgeError('ZIP_TOO_MANY_ENTRIES', `zip has more than ${maxEntries} entries`);
            const rawName = Buffer.isBuffer(entry.fileName) ? (entry.fileName as unknown as Buffer).toString('utf8') : String(entry.fileName);
            const rel = sanitizeZipEntryName(rawName);
            if (rel === null) throw new BridgeError('ZIP_UNSAFE_ENTRY', `unsafe zip entry: ${rawName}`);
            if (isSymlinkEntry(entry.externalFileAttributes)) throw new BridgeError('ZIP_UNSAFE_ENTRY', `symlink zip entry: ${rawName}`);
            const target = resolve(destReal, rel);
            if (!target.startsWith(prefix)) throw new BridgeError('ZIP_UNSAFE_ENTRY', `zip entry escapes target dir: ${rawName}`);
            const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
            if (isDir) {
              await fs.mkdir(target, { recursive: true });
              zipfile.readEntry();
              return;
            }
            if (total + entry.uncompressedSize > maxTotal) throw new BridgeError('ZIP_TOO_LARGE', `zip expands beyond ${maxTotal} bytes`);
            await fs.mkdir(dirname(target), { recursive: true });
            // 写之前再确认父目录 realpath 仍在 dest 内（符号链接已整包拒绝，这是双保险）
            const parentReal = await fs.realpath(dirname(target));
            if (parentReal !== destReal && !parentReal.startsWith(prefix)) {
              throw new BridgeError('ZIP_UNSAFE_ENTRY', `zip entry parent escapes target dir: ${rawName}`);
            }
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zipfile.openReadStream(entry, (e, s) => (e || !s ? rej(e ?? new Error('openReadStream failed')) : res(s))),
            );
            const counter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                total += chunk.length;
                if (total > maxTotal) return cb(new BridgeError('ZIP_TOO_LARGE', `zip expands beyond ${maxTotal} bytes`));
                cb(null, chunk);
              },
            });
            await pipeline(stream, counter, createWriteStream(target));
            zipfile.readEntry();
          })().catch(fail);
        });
        zipfile.readEntry();
      });
    });
  } catch (err) {
    await fs.rm(destDir, { recursive: true, force: true });
    if (err instanceof BridgeError) throw err;
    throw new BridgeError('ZIP_UNSAFE_ENTRY', `zip could not be read: ${(err as Error).message}`);
  }
}
