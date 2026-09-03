#!/usr/bin/env node
// 版本号单一来源是根 package.json；本脚本把它同步到各子包清单与 web-client 内置的 pluginVersion 常量。幂等。
// 用法：npm run sync:version

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] 根 package.json 的 version 非法：${JSON.stringify(version)}`);
  process.exit(1);
}

const manifests = ['packages/core-ts/package.json', 'packages/web-client/package.json', 'packages/cocos/package.json', 'packages/unity/package.json'];

let changed = 0;
for (const rel of manifests) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    console.log(`[sync-version] skip ${rel}（不存在）`);
    continue;
  }
  const raw = readFileSync(file, 'utf8');
  // 只替换顶层 "version" 字段的字面量，不重新序列化整个文件，保住各清单自己的缩进与键序。
  const re = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
  const m = re.exec(raw);
  if (!m) {
    console.log(`[sync-version] skip ${rel}（没有顶层 version 字段）`);
    continue;
  }
  if (m[2] === version) {
    console.log(`[sync-version] ok   ${rel} 已是 ${version}`);
    continue;
  }
  writeFileSync(file, raw.replace(re, `$1${version}$3`));
  console.log(`[sync-version] set  ${rel}: ${m[2]} → ${version}`);
  changed += 1;
}

// web-client 把插件版本内置在 engines.ts 里（pluginVersion 字面量）；minPluginVersion 是兼容下限，不跟随发布号。
const enginesFile = join(root, 'packages/web-client/src/engines.ts');
if (existsSync(enginesFile)) {
  const raw = readFileSync(enginesFile, 'utf8');
  // pluginVersion 是我们发布的插件版本；CLIENT_VERSION 是网页客户端自身版本，两者都跟仓库版本走。
  const re = /(\bpluginVersion\s*:\s*'|\bCLIENT_VERSION\s*=\s*')([^']*)(')/g;
  let hits = 0;
  let edits = 0;
  const next = raw.replace(re, (_all, pre, old, post) => {
    hits += 1;
    if (old !== version) edits += 1;
    return `${pre}${version}${post}`;
  });
  if (hits === 0) console.log('[sync-version] skip packages/web-client/src/engines.ts（没有 pluginVersion / CLIENT_VERSION 字面量）');
  else if (edits === 0) console.log(`[sync-version] ok   packages/web-client/src/engines.ts pluginVersion / CLIENT_VERSION 已是 ${version}（${hits} 处）`);
  else {
    writeFileSync(enginesFile, next);
    console.log(`[sync-version] set  packages/web-client/src/engines.ts pluginVersion / CLIENT_VERSION → ${version}（改 ${edits}/${hits} 处）`);
    changed += 1;
  }
} else {
  console.log('[sync-version] skip packages/web-client/src/engines.ts（不存在）');
}

console.log(`[sync-version] 完成，版本 ${version}，改动 ${changed} 个文件`);
