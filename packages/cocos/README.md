# Rezona Bridge for Cocos Creator

Cocos Creator 3.8.5+ 扩展：在编辑器里起一个只监听 `127.0.0.1` 的 WebSocket 服务端，接收 Rezona Lab 网页画布直接推来的资产（glb / 图片 / 音频 / 精灵 zip），落到 `assets/RezonaAssets/`，导入资产库，模型自动挂进当前场景。

## 安装

1. 从 release 下载 `rezona-bridge-cocos-<version>.zip`（或在仓库根 `npm run build:cocos` 自己打）。
2. Cocos Creator → 扩展 → 扩展管理器 → 右上角「导入扩展文件」→ 选 zip → 启用。
3. 顶部菜单 扩展 → Rezona Bridge 打开面板。默认编辑器一启动就自动监听（面板「停止」会记住偏好）。

## 面板

- 顶部：状态徽标（已停止 / 监听中 / 已连接 / 传输中 / 出错）、端口、启动 / 停止按钮。
- 工程名、保存目录（固定 `assets/RezonaAssets`，只读）、当前文件与进度。
- 日志（最近 200 行，可清空）。
- 「高级」：追加允许连接的网页来源（一行一个，如 `http://localhost:5173`），保存后服务端自动重启生效。默认白名单为 `https://lab.rezona.ai`、`https://stalab.rezona.ai`、`https://devlab.rezona.ai`。

## 端口

Cocos 段 `41700` 到 `41719`，启动时从段首顺延取第一个空闲端口；同机多个 Cocos 工程各占一个。全部被占时面板红字提示「41700 到 41719 全部被占用」。

## 开发

```bash
# 仓库根
npm run build -w @rezonalab/engine-bridge-core
npx vitest run packages/cocos              # 单测（不依赖 Cocos）
npx tsc -p packages/cocos/tsconfig.json    # 编译到 packages/cocos/dist
npm run build:cocos                        # 打 zip 到 <repo>/dist/
```

- `source/main.ts` 只做 `Editor` 全局的接线；可测逻辑在 `source/extension.ts`（消息方法与生命周期）、`source/assemble.ts`（装配配置）、`source/adapter.ts`（asset-db / scene 胶水）。
- `source/editor.d.ts` 只声明用到的 `Editor` 表面。想要完整类型可自行 `npm i -D @cocos/creator-types`，并把 `tsconfig.json` 的 `types` 改成 `["node", "@cocos/creator-types/editor"]`；构建不依赖它。
- 内核是 ESM-only 而 Cocos 用 `require` 加载扩展，`scripts/build-zip.mjs` 用 esbuild 把内核打成 CJS 放进 zip 的 `node_modules/`，`ws` / `yauzl` / `ajv` 及其传递依赖原样随包。
- 场景选中消息名（`set-selection` / `select-node`）在不同 3.8 小版本有出入，实现里两个都试、失败不影响导入；真机上以 Developer → Message Manager 里的实际消息名为准。

## 真机验收

见仓库 `docs/`「真机（Cocos）」清单：拨开开关 → 允许浏览器本地网络权限 → 徽标「已连接」→ 卡片「发送至 → Cocos」→ 8 秒内资产出现在 `assets/RezonaAssets/` 且模型在场景里被选中。
