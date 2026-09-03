#!/usr/bin/env node
// 假引擎：用 core-ts 内核在本机起一个不依赖任何引擎的桥服务端，供 game-web 本地联调与协议层验收。
// 用法：npm run dev:fake-engine -- [--engine cocos|unity|fake] [--project-dir ./tmp-project] [--name MyGame]
//       [--origin http://localhost:3000]... [--max-file-bytes N] [--protocol N] [--port-range a-b]
// 内核已经把文件落在 <project-dir>/assets/RezonaAssets/ 下；这里的适配层只打日志、不再写任何东西。

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { createBridgeServer, DEFAULT_ORIGIN_ALLOWLIST, PORT_RANGES, PROTOCOL_VERSION, listenOnFirstFreePort } from '@rezonalab/engine-bridge-core';

const HELP = `fake-engine — Rezona Engine Bridge 假引擎

  --engine <cocos|unity|fake>   上报的引擎名并决定端口段（默认 cocos；cocos/fake 41700–41719，unity 41720–41739）
  --project-dir <dir>           假工程目录，资产落在 <dir>/assets/RezonaAssets/（默认 ./tmp-project）
  --name <name>                 工程名（默认目录名）；工程 id = sha1(目录绝对路径) 前 8 位
  --origin <url>                追加允许来源，可重复（如 http://localhost:3000）
  --max-file-bytes <n>          覆盖 limits.maxFileBytes（验收「文件超过插件限额」用）
  --protocol <n>                声明的协议版本；≠ 1 时对每个 hello 回 PROTOCOL_MISMATCH 并 4426 关闭
  --port-range <a-b>            覆盖端口段
  -h, --help
`;

function parseArgs(argv) {
  const opts = { engine: 'cocos', projectDir: './tmp-project', name: null, origins: [], maxFileBytes: null, protocol: PROTOCOL_VERSION, portRange: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} 需要一个值`);
      return v;
    };
    switch (arg) {
      case '--engine':
        opts.engine = next();
        break;
      case '--project-dir':
        opts.projectDir = next();
        break;
      case '--name':
        opts.name = next();
        break;
      case '--origin':
        opts.origins.push(next());
        break;
      case '--max-file-bytes':
        opts.maxFileBytes = Number(next());
        if (!Number.isInteger(opts.maxFileBytes) || opts.maxFileBytes <= 0) throw new Error('--max-file-bytes 必须是正整数');
        break;
      case '--protocol':
        opts.protocol = Number(next());
        if (!Number.isInteger(opts.protocol) || opts.protocol <= 0) throw new Error('--protocol 必须是正整数');
        break;
      case '--port-range': {
        const m = /^(\d+)-(\d+)$/.exec(next());
        if (!m) throw new Error('--port-range 形如 41700-41719');
        opts.portRange = [Number(m[1]), Number(m[2])];
        if (opts.portRange[0] > opts.portRange[1]) throw new Error('--port-range 起点不能大于终点');
        break;
      }
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough -- exit 不返回
      default:
        throw new Error(`未知参数 ${arg}\n\n${HELP}`);
    }
  }
  if (!(opts.engine in PORT_RANGES)) throw new Error(`--engine 只接受 ${Object.keys(PORT_RANGES).join(' | ')}`);
  return opts;
}

/** 假适配层：内核已落盘，这里只记日志并返回 fake:// 路径；model3d 假装实例化到场景。 */
function createFakeAdapter(assetsRoot) {
  return {
    isProjectOpen: () => true,
    async importFile(absPath, meta) {
      const rel = relative(assetsRoot, absPath).split('\\').join('/');
      console.log(`[import] kind=${meta.kind} file=${meta.fileName} → ${rel}${meta.displayName ? ` (displayName=${meta.displayName})` : ''}`);
      return { savedPath: `fake://${rel}`, ...(meta.kind === 'model3d' ? { sceneNode: meta.displayName ?? meta.fileName } : {}) };
    },
  };
}

/**
 * 协议版本 ≠ 1 的模式。内核永远只说 protocol 1、且会把对方 protocol≠1 的 hello 拒掉——它没法「假装自己是版本 2 的插件」。
 * 所以这一支不用内核：在端口段第一个空闲口上起一个裸 ws 服务端，对每个 hello 都回 error{PROTOCOL_MISMATCH} + 4426，
 * 让网页端走「插件需升级」的分支。
 */
async function startProtocolMismatchServer(opts, portRange) {
  const { WebSocketServer } = await import('ws');
  const { server: http, port } = await listenOnFirstFreePort(portRange);
  const wss = new WebSocketServer({ server: http, path: '/rezona-bridge' });
  wss.on('connection', (ws, req) => {
    console.log(`[connection] origin=${req.headers.origin ?? '(none)'}`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400, 'bad frame');
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.close(4400, 'bad frame');
      }
      if (msg?.type === 'hello') {
        ws.send(JSON.stringify({ type: 'error', code: 'PROTOCOL_MISMATCH', message: `unsupported protocol ${msg.protocol}, plugin speaks ${opts.protocol}` }));
        ws.close(4426, 'protocol mismatch');
      }
    });
    ws.on('close', (code) => console.log(`[connection] closed code=${code}`));
  });
  console.log(`[fake-engine] engine=${opts.engine} port=${port} protocol=${opts.protocol} (mismatch mode: every hello → PROTOCOL_MISMATCH / 4426)`);
  return async () => {
    await new Promise((res) => wss.close(() => res()));
    await new Promise((res) => http.close(() => res()));
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projectDir = resolve(opts.projectDir);
  const assetsRoot = join(projectDir, 'assets');
  mkdirSync(join(assetsRoot, 'RezonaAssets'), { recursive: true });
  const portRange = opts.portRange ?? PORT_RANGES[opts.engine];
  const project = { name: opts.name ?? basename(projectDir), id: createHash('sha1').update(projectDir).digest('hex').slice(0, 8) };

  let stop;
  if (opts.protocol !== PROTOCOL_VERSION) {
    stop = await startProtocolMismatchServer(opts, portRange);
  } else {
    const server = createBridgeServer({
      engine: opts.engine,
      engineVersion: '0.0.0-fake',
      pluginVersion: process.env.npm_package_version ?? '0.0.0',
      project,
      assetsRoot,
      portRange,
      extraOrigins: opts.origins,
      limits: opts.maxFileBytes ? { maxFileBytes: opts.maxFileBytes } : undefined,
      adapter: createFakeAdapter(assetsRoot),
    });
    server.on('state', (s) => console.log(`[state] ${s}`));
    server.on('connection', (connected, origin) => console.log(`[connection] ${connected ? `connected origin=${origin}` : 'disconnected'}`));
    server.on('progress', (p) => p && console.log(`[progress] ${p.fileName} ${p.stage} ${p.percent}%`));
    server.on('log', (e) => console.log(`[log:${e.level}] ${e.msg}`));
    const port = await server.start();
    const snap = server.snapshot();
    console.log(`[fake-engine] engine=${opts.engine} port=${port} ws://127.0.0.1:${port}/rezona-bridge`);
    console.log(`[fake-engine] project=${project.name} (id ${project.id}) assetsRoot=${assetsRoot}`);
    console.log(`[fake-engine] allowlist=${snap.originAllowlist.join(', ')}${opts.origins.length ? '' : ` (默认 ${DEFAULT_ORIGIN_ALLOWLIST.length} 项；本地 game-web 加 --origin http://localhost:3000)`}`);
    if (opts.maxFileBytes) console.log(`[fake-engine] maxFileBytes=${opts.maxFileBytes}`);
    stop = () => server.stop();
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[fake-engine] ${signal} → stopping`);
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[fake-engine] ${err.message}`);
  process.exit(1);
});
