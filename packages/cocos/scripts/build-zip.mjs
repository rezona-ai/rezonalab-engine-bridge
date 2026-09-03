#!/usr/bin/env node
// 把 Cocos 扩展打成可经 Extension Manager 导入的 zip：
//   tsc 编译 → 复制面板模板/样式 → 暂存 package.json / dist / i18n / README / 生产 node_modules → zip -r。
// 内核 @rezonalab/engine-bridge-core 是 ESM-only，而 Cocos 用 require 加载扩展，
// 所以这里用 esbuild 把内核打成一份 CJS（ws / yauzl / ajv 保持外部依赖，随 node_modules 一起带上）。
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const repoRoot = resolve(pkgDir, '..', '..');
const coreDir = join(repoRoot, 'packages', 'core-ts');
const require = createRequire(join(repoRoot, 'package.json'));
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const corePkg = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

/** 递归复制目录，按谓词过滤文件。 */
function copyTree(src, dst, keep) {
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) {
      copyTree(s, d, keep);
    } else if (keep(s)) {
      mkdirSync(dirname(d), { recursive: true });
      cpSync(s, d);
    }
  }
}

/** 在 root/node_modules 里定位一个包目录（不走 exports，直接按目录找，避免 ajv 一类包封住 package.json）。 */
function locatePackage(name, fromDirs) {
  for (const base of fromDirs) {
    const dir = join(base, 'node_modules', name);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  throw new Error(`找不到依赖 ${name}，请在仓库根 npm install`);
}

/** 从若干顶层依赖出发，沿 package.json dependencies 走一遍，收集全部生产依赖目录。 */
function collectProdDeps(topLevel) {
  const seen = new Map();
  const queue = topLevel.map((n) => ({ name: n, from: [repoRoot] }));
  while (queue.length) {
    const { name, from } = queue.shift();
    if (seen.has(name)) continue;
    const dir = locatePackage(name, [...from, repoRoot]);
    seen.set(name, dir);
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pj.dependencies ?? {})) queue.push({ name: dep, from: [dir, ...from] });
  }
  return seen;
}

// 1. 编译扩展源码。
const tsc = require.resolve('typescript/bin/tsc');
rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });
run(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.json')]);
// 面板模板与样式 tsc 不会带过去，手工镜像到 dist。
copyTree(join(pkgDir, 'source'), join(pkgDir, 'dist'), (f) => /\.(html|css)$/.test(f));

// 2. 暂存目录。
const stage = mkdtempSync(join(tmpdir(), 'rezona-bridge-cocos-'));
const stagedManifest = { ...manifest };
delete stagedManifest.scripts;
delete stagedManifest.devDependencies;
writeFileSync(join(stage, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');
copyTree(join(pkgDir, 'dist'), join(stage, 'dist'), (f) => !/\.(map|d\.ts)$/.test(f) && !/\.test\./.test(f));
copyTree(join(pkgDir, 'i18n'), join(stage, 'i18n'), () => true);
cpSync(join(pkgDir, 'README.md'), join(stage, 'README.md'));

// 3. 内核打成 CJS 放进 node_modules/@rezonalab/engine-bridge-core。
if (!existsSync(join(coreDir, 'dist', 'index.js'))) throw new Error('内核未构建，请先 npm run build -w @rezonalab/engine-bridge-core');
let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  throw new Error('需要 esbuild（当前经 vite 间接安装）；请在仓库根把 esbuild 加进 devDependencies');
}
const externals = Object.keys(corePkg.dependencies ?? {});
const coreStage = join(stage, 'node_modules', '@rezonalab', 'engine-bridge-core');
mkdirSync(join(coreStage, 'dist'), { recursive: true });
await esbuild.build({
  entryPoints: [join(coreDir, 'dist', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  external: externals,
  outfile: join(coreStage, 'dist', 'index.cjs'),
  logLevel: 'warning',
});
writeFileSync(
  join(coreStage, 'package.json'),
  JSON.stringify({ name: corePkg.name, version: corePkg.version, license: corePkg.license, main: './dist/index.cjs', dependencies: corePkg.dependencies }, null, 2) + '\n',
);

// 4. 内核的生产依赖及其传递依赖。
for (const [name, dir] of collectProdDeps(externals)) {
  copyTree(dir, join(stage, 'node_modules', name), (f) => !/[\\/]node_modules[\\/]/.test(relative(dir, f)) && !/\.(md|map|ts)$/.test(f));
}

// 5. zip。
const outDir = join(repoRoot, 'dist');
mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `rezona-bridge-cocos-${manifest.version}.zip`);
rmSync(zipPath, { force: true });
run('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: stage });
rmSync(stage, { recursive: true, force: true });

// 6. 断言。
const size = statSync(zipPath).size;
if (size >= MAX_ZIP_BYTES) throw new Error(`zip 过大：${size} 字节`);
const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
for (const must of ['package.json', 'dist/main.js', 'dist/panels/default/index.js', 'node_modules/']) {
  if (!listing.split('\n').some((l) => l === must || l.startsWith(must))) throw new Error(`zip 缺少 ${must}`);
}
console.log(`${zipPath}  (${(size / 1024 / 1024).toFixed(2)} MB, ${listing.trim().split('\n').length} entries)`);
