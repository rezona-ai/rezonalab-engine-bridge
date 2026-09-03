#!/usr/bin/env node
// 故意破坏验证（Verification Contract「故意破坏验证」一行的自动化）：
// 依次把内核的三道闸各注掉一次——sha256 比对、Origin 校验、zip 条目名校验——跑夹具测试，期望**变红**；
// 然后无论结果如何都从备份还原源文件。绿灯只证明夹具在跑，变红才证明夹具真的咬得住这道闸。
// 用法：npm run break:verify   退出码：全部 PASS 为 0，任何 FAIL 为 1（SKIP 不算失败但会打印原因）。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(root, 'packages/core-ts/src');
const FIXTURE_TEST = 'packages/core-ts/test/fixtures.test.ts';

/**
 * 每条突变：文件 + 精确锚点（必须在当前源码里恰好出现一次）+ 替换文本 + 应该变红的夹具名。
 * 锚点找不到就 SKIP 并说明，绝不猜着改。
 */
const MUTATIONS = [
  {
    name: 'sha256 比对失效',
    fixture: 'checksum-mismatch',
    file: join(core, 'receiver.ts'),
    anchor: "if (this.hash.digest('hex') !== this.expectedSha) {",
    replacement: "if (this.hash.digest('hex') !== this.expectedSha && false) { // BREAK-VERIFY",
  },
  {
    name: 'Origin 校验放行一切',
    fixture: 'origin-rejected',
    file: join(core, 'origin.ts'),
    anchor: 'export function isAllowedOrigin(originHeader: string | undefined | null, allowlist: readonly string[]): boolean {\n',
    replacement:
      'export function isAllowedOrigin(originHeader: string | undefined | null, allowlist: readonly string[]): boolean {\n  return true; // BREAK-VERIFY\n',
  },
  {
    name: 'zip 条目名校验跳过',
    fixture: 'zip-traversal',
    file: join(core, 'zipsafe.ts'),
    anchor: 'export function sanitizeZipEntryName(name: string): string | null {\n',
    replacement:
      "export function sanitizeZipEntryName(name: string): string | null {\n  return name.replace(/\\\\/g, '/').split('/').filter((s) => s !== '' && s !== '.').join('/') || null; // BREAK-VERIFY\n",
  },
];

function runFixtures() {
  // vitest 直接读 src/*.ts，不经过 dist，所以改源文件即可生效；stdio 收起来只在失败时摘要。
  const res = spawnSync('npx', ['vitest', 'run', FIXTURE_TEST], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' } });
  // eslint-disable-next-line no-control-regex -- 剥掉 vitest 可能残留的 ANSI 色码
  const strip = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
  return { status: res.status, out: strip(`${res.stdout ?? ''}${res.stderr ?? ''}`) };
}

function summarize(out, fixture) {
  const lines = out.split('\n').filter((l) => /✓|×|✗|FAIL|Tests|failed|passed/.test(l) && (l.includes(fixture) || /Tests|Test Files/.test(l)));
  return lines.slice(0, 6).map((l) => `      ${l.trim()}`).join('\n');
}

let failed = 0;
console.log('[break-verify] 基线：未破坏时夹具测试应当全绿');
const baseline = runFixtures();
if (baseline.status !== 0) {
  console.log('[break-verify] FAIL 基线就是红的，先修好再做破坏验证\n' + summarize(baseline.out, ''));
  process.exit(1);
}
console.log('[break-verify] 基线 PASS（绿）\n');

for (const m of MUTATIONS) {
  const rel = m.file.slice(root.length + 1);
  const original = readFileSync(m.file);
  const source = original.toString('utf8');
  const occurrences = source.split(m.anchor).length - 1;
  if (occurrences !== 1) {
    console.log(`[break-verify] SKIP ${m.name}：锚点在 ${rel} 出现 ${occurrences} 次（需要恰好 1 次）——源码已变，请更新 scripts/break-verify.mjs 的锚点`);
    continue;
  }
  try {
    writeFileSync(m.file, source.replace(m.anchor, m.replacement));
    const res = runFixtures();
    const red = res.status !== 0;
    const fixtureRed = red && new RegExp(`(×|✗|FAIL|failed).*${m.fixture}|${m.fixture}.*(×|✗|FAIL|failed)`).test(res.out);
    if (red) {
      console.log(`[break-verify] PASS ${m.name}（${rel}）→ 夹具变红${fixtureRed ? `，且 ${m.fixture} 在失败列表里` : `；注意：输出里没定位到 ${m.fixture} 这一条，请人工核对`}`);
      console.log(summarize(res.out, m.fixture));
    } else {
      failed += 1;
      console.log(`[break-verify] FAIL ${m.name}（${rel}）→ 破坏后夹具仍然全绿，${m.fixture} 夹具没有咬住这道闸`);
    }
  } finally {
    writeFileSync(m.file, original);
    if (!readFileSync(m.file).equals(original)) {
      console.log(`[break-verify] FAIL 还原 ${rel} 后字节不一致`);
      failed += 1;
    }
  }
}

console.log(`\n[break-verify] ${failed === 0 ? '全部 PASS' : `${failed} 条 FAIL`}；源码已还原（可用 git status --short packages/core-ts 核对）`);
process.exit(failed === 0 ? 0 : 1);
