#!/usr/bin/env node
// 把 Unity 包打成 UPM tarball（.tgz），供用户在 Package Manager 的
// 「＋ → Install package from tarball」里选中安装。
//
// 为什么要有它：网页无法触发 UPM 安装，而 git 地址那条路要求用户机器装了 git
// 并在 PATH 里，没装的人只会拿到一句看不懂的报错。tarball 是 Unity 自带的、
// 基于文件的安装入口，保留完整包语义（版本 / 清单 / 干净卸载），
// 不像 .unitypackage 那样把源码铺进用户的 Assets/。
//
// 不打包 Tests/：它的 asmdef 依赖测试框架，只有在工程把本包列进 manifest 的
// testables 时才该参与编译；随发行包一起塞给用户没有意义。
//
// 结构必须是单一 `package/` 根目录（UPM 与 npm 同约定），清单在 package/package.json。
import { createGzip } from 'node:zlib';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkgDir = join(repoRoot, 'packages', 'unity');
const outDir = join(repoRoot, 'dist');
/** 随包发行时必须排除的目录（见文件头）。 */
const EXCLUDE_DIRS = new Set(['Tests']);
const MAX_BYTES = 50 * 1024 * 1024;

const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const outName = `rezona-bridge-unity-${manifest.version}.tgz`;
const outPath = join(outDir, outName);

/** 收集要进包的文件，路径按 tar 约定用正斜杠。 */
function collect(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (prefix === '' && EXCLUDE_DIRS.has(name)) continue;
    // Tests 目录本身排除了，它的 .meta 也不该留下（留着会让 Unity 报孤儿 meta 告警）
    if (prefix === '' && name.endsWith('.meta') && EXCLUDE_DIRS.has(name.slice(0, -5))) continue;
    const full = join(dir, name);
    const rel = prefix ? posix.join(prefix, name) : name;
    if (statSync(full).isDirectory()) out.push(...collect(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

/** 最小 ustar 写入器：内容全是短路径的文本与小二进制，不需要 pax 扩展。 */
function tarEntry(name, body) {
  const path = `package/${name}`;
  if (Buffer.byteLength(path) > 100) throw new Error(`路径超出 ustar 的 100 字节上限：${path}`);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');   // mode
  header.write('0000000\0', 108, 8, 'ascii');   // uid
  header.write('0000000\0', 116, 8, 'ascii');   // gid
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); // mtime 固定为 0：同一份源码必须打出同一个包
  header.write('        ', 148, 8, 'ascii');    // checksum 占位
  header.write('0', 156, 1, 'ascii');           // 普通文件
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

const files = collect(pkgDir);
if (!files.some((f) => f.rel === 'package.json')) throw new Error('包清单缺失：package/package.json');
if (files.some((f) => f.rel.startsWith('Tests/'))) throw new Error('Tests 不该进发行包');

const chunks = files.map((f) => tarEntry(f.rel, readFileSync(f.full)));
chunks.push(Buffer.alloc(1024)); // 两个空块收尾
mkdirSync(outDir, { recursive: true });
await pipeline(Readable.from(chunks), createGzip({ level: 9 }), createWriteStream(outPath));

const bytes = statSync(outPath).size;
if (bytes > MAX_BYTES) throw new Error(`产物 ${(bytes / 1024 / 1024).toFixed(1)} MB 超过上限`);
console.log(`${outPath}  (${(bytes / 1024).toFixed(0)} KB, ${files.length} 个文件)`);
