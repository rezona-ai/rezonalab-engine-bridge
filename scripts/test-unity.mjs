#!/usr/bin/env node
// 在本机 Unity 里跑 packages/unity 的 EditMode 测试：
// 1) 把 protocol/fixtures 复制进包内 Tests/Fixtures/（gitignored）；
// 2) 用 .unity-test-project/ 这个临时工程（manifest 以 file: 引用本包，并列入 testables）；
// 3) -runTests -testPlatform EditMode -batchmode，解析 results.xml 汇总。找不到 Unity 时退出码 2。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages', 'unity');
const fixturesSrc = join(root, 'protocol', 'fixtures');
const fixturesDst = join(pkgDir, 'Tests', 'Fixtures');
const projectDir = join(root, '.unity-test-project');
const resultsPath = join(projectDir, 'results.xml');

function findUnity() {
  if (process.env.UNITY_PATH && existsSync(process.env.UNITY_PATH)) return process.env.UNITY_PATH;
  const candidates = [];
  const hubMac = '/Applications/Unity/Hub/Editor';
  if (existsSync(hubMac)) {
    for (const v of readdirSync(hubMac)) {
      const bin = join(hubMac, v, 'Unity.app', 'Contents', 'MacOS', 'Unity');
      if (existsSync(bin)) candidates.push({ v, bin });
    }
  }
  const hubWin = 'C:\\Program Files\\Unity\\Hub\\Editor';
  if (existsSync(hubWin)) {
    for (const v of readdirSync(hubWin)) {
      const bin = join(hubWin, v, 'Editor', 'Unity.exe');
      if (existsSync(bin)) candidates.push({ v, bin });
    }
  }
  const hubLinux = join(process.env.HOME ?? '', 'Unity', 'Hub', 'Editor');
  if (existsSync(hubLinux)) {
    for (const v of readdirSync(hubLinux)) {
      const bin = join(hubLinux, v, 'Editor', 'Unity');
      if (existsSync(bin)) candidates.push({ v, bin });
    }
  }
  // 版本号按数值降序，取最新
  candidates.sort((a, b) => cmpVersion(b.v, a.v));
  return candidates[0]?.bin ?? null;
}

function cmpVersion(a, b) {
  const pa = a.split(/[.a-z]/i).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.a-z]/i).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const unity = findUnity();
if (!unity) {
  console.error('未找到 Unity：设置 UNITY_PATH 指向 Unity 可执行文件，或经 Unity Hub 安装到默认目录。');
  process.exit(2);
}
const unityMajor = parseInt(/(\d{4})\.\d+\.\d+[a-z]\d+/.exec(process.env.UNITY_VERSION ?? unity)?.[1] ?? '6000', 10);
console.log(`Unity: ${unity}`);

mkdirSync(fixturesDst, { recursive: true });
for (const f of readdirSync(fixturesDst)) if (f.endsWith('.json')) rmSync(join(fixturesDst, f));
let n = 0;
for (const f of readdirSync(fixturesSrc)) {
  if (!f.endsWith('.json')) continue;
  copyFileSync(join(fixturesSrc, f), join(fixturesDst, f));
  n++;
}
console.log(`已复制 ${n} 个夹具到 ${fixturesDst}`);

// 临时工程：Unity 拒绝 -createProject 到点号开头的目录，所以按 CI 惯例手写 ProjectVersion.txt（版本与编辑器一致就不会弹升级对话）
const editorVersion = process.env.UNITY_VERSION ?? /(\d{4}\.\d+\.\d+[a-z]\d+)/.exec(unity)?.[1];
if (!editorVersion) {
  console.error('无法从 Unity 路径推断版本号，请设置 UNITY_VERSION（如 2021.3.45f1）。');
  process.exit(2);
}
mkdirSync(join(projectDir, 'ProjectSettings'), { recursive: true });
mkdirSync(join(projectDir, 'Assets'), { recursive: true });
writeFileSync(join(projectDir, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${editorVersion}\n`);
const manifest = {
  dependencies: {
    'com.rezonalab.engine-bridge': 'file:../../packages/unity',
    'com.unity.test-framework': unityMajor >= 2022 ? '1.4.5' : '1.1.33',
    'com.unity.modules.jsonserialize': '1.0.0',
    'com.unity.modules.imgui': '1.0.0',
  },
  testables: ['com.rezonalab.engine-bridge'],
};
mkdirSync(join(projectDir, 'Packages'), { recursive: true });
writeFileSync(join(projectDir, 'Packages', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (existsSync(resultsPath)) rmSync(resultsPath);

console.log('运行 EditMode 测试 …');
const run = spawnSync(
  unity,
  ['-runTests', '-testPlatform', 'EditMode', '-batchmode', '-nographics', '-projectPath', projectDir, '-testResults', resultsPath, '-logFile', '-'],
  { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const log = (run.stdout ?? '') + (run.stderr ?? '');
if (!existsSync(resultsPath)) {
  const lines = log.split('\n');
  const interesting = lines.filter((l) => /error CS|exception|Aborting|licens|Scripts have compiler errors/i.test(l));
  console.error([...interesting.slice(-40), '--- log tail ---', ...lines.slice(-30)].join('\n'));
  if (/No valid Unity Editor license/i.test(log)) console.error('Unity 没有可用许可证（batchmode 需要已激活的 Editor 许可证；先在 Unity Hub 登录并激活，或用 -serial / -username / -password 激活）。');
  console.error(`未产生 results.xml（Unity exit ${run.status}）：编译错误或许可证不可用，见上方日志。`);
  process.exit(1);
}
const xml = readFileSync(resultsPath, 'utf8');
const head = /<test-run[^>]*\btotal="(\d+)"[^>]*\bpassed="(\d+)"[^>]*\bfailed="(\d+)"[^>]*\bskipped="(\d+)"/.exec(xml);
const total = head ? +head[1] : 0;
const passed = head ? +head[2] : 0;
const failed = head ? +head[3] : 0;
const skipped = head ? +head[4] : 0;
for (const m of xml.matchAll(/<test-case[^>]*\bfullname="([^"]+)"[^>]*\bresult="([^"]+)"/g)) {
  console.log(`${m[2] === 'Passed' ? 'PASS' : m[2] === 'Failed' ? 'FAIL' : 'SKIP'} ${m[1]}`);
}
for (const m of xml.matchAll(/<test-case[^>]*\bfullname="([^"]+)"[^>]*\bresult="Failed"[\s\S]*?<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/g)) {
  console.log(`\n--- ${m[1]}\n${m[2].trim()}`);
}
console.log(`\n${passed}/${total} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 && total > 0 && run.status === 0 ? 0 : 1);
