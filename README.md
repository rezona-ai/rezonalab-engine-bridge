# Rezona Lab Engine Bridge

[English](README_EN.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Language: TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6.svg)
![Language: C#](https://img.shields.io/badge/Language-C%23-512bd4.svg)
[![CI](https://github.com/rezona-ai/rezonalab-engine-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/rezona-ai/rezonalab-engine-bridge/actions/workflows/ci.yml)

把 Rezona Lab 工作台画布上生成的资产（glb、图片、音频、sprite）直接推进本机正在运行的 Cocos Creator 或 Unity 工程。链路只有两方：网页是客户端，引擎里的插件是只监听 `127.0.0.1` 的 WebSocket 服务端。没有账号、没有配对、没有服务端任务流。

## 它是怎么工作的

1. 用户在工作台顶栏「Engine Bridge」拨开某个引擎的开关，网页并行探测该引擎的端口段（Cocos `41700–41719`、Unity `41720–41739`），与第一个应答的插件握手并保持连接。
2. 在画布卡片上点「发送至 → 该引擎」，网页算好 sha256，按 4 MB 分块推字节，插件边收边写临时文件、校验、原子搬进 `assets/RezonaAssets/`，再导入资产库并实例化到场景。
3. 五条加固：Origin 白名单、端口顺延支持同引擎多实例、权限弹窗前置提示、zip 路径穿越校验、流式落盘加分块与体积限额。

协议规格见 [`protocol/spec.md`](protocol/spec.md)，录制夹具在 [`protocol/fixtures/`](protocol/fixtures/)，TypeScript 与 C# 两个实现都必须过同一组夹具。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `protocol/` | 协议 v1 规格、JSON Schema、11 个录制夹具 |
| `packages/core-ts/` | 引擎无关的 TypeScript 内核（帧编解码、分块接收、心跳、状态机、端口分配、Origin 校验、安全解压、ws 服务端装配） |
| `packages/web-client/` | 浏览器侧 npm 包 `@rezonalab/engine-bridge-web` |
| `packages/cocos/` | Cocos Creator 3.8.5+ 扩展，产物 `dist/rezona-bridge-cocos-<ver>.zip` |
| `packages/unity/` | Unity 2021.3+ UPM 包 `com.rezonalab.engine-bridge`（C# 内核移植） |
| `docs/` | [Cocos 安装](docs/install-cocos.md)、[Unity 安装](docs/install-unity.md)、[game-web 接入](docs/game-web-integration.md) |
| `scripts/` | 假引擎、版本同步、故意破坏验证、Unity 测试驱动 |

## 开发者命令

```bash
npm ci
npm test                 # 内核 + 网页客户端全部测试（含 11 个夹具，断言数量防漏跑）
npm run typecheck
npm run build:cocos      # 产出 dist/rezona-bridge-cocos-<ver>.zip（< 100 MB）
npm run test:unity       # 本机有 Unity 时跑 C# 夹具测试（EditMode）
npm run break:verify     # 故意破坏验证：注掉 sha256 / Origin / zip 校验各一次，对应夹具必须变红，然后自动还原
npm run sync:version     # 把根 package.json 的版本同步到各子包与 web-client 的 pluginVersion
npm run dev:fake-engine -- --origin http://localhost:3000   # 起假引擎在 41700，供本地 game-web 联调
```

假引擎的全部参数见 `node scripts/fake-engine.mjs --help`：`--engine`、`--project-dir`、`--name`、`--origin`（可重复）、`--max-file-bytes`、`--protocol`（≠ 1 时对每个 hello 回 `PROTOCOL_MISMATCH`）、`--port-range`。再起一个实例会自动落到 41701。

## 安装插件

- Cocos Creator：[docs/install-cocos.md](docs/install-cocos.md)
- Unity：[docs/install-unity.md](docs/install-unity.md)

## 边界

- 网页与引擎必须在同一台机器。
- Chrome 142+ 首次连接会弹「连接本地网络设备」权限询问；不支持 Safari。
- 服务端看不见导出发生；导出事件上报、一次性 nonce、推地址而非推字节，均为二期。

## 发布

版本号单一来源是根 `package.json`。发版流程：改版本 → `npm run sync:version` → 提交 → 打 tag `v<ver>` → CI 产出 Cocos zip；Unity 用户改 git URL 的 tag 升级。

## License

MIT
