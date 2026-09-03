# game-web 接入 Engine Bridge

给 `rezonalab-game-web` 的接入说明：怎么依赖 `@rezonalab/engine-bridge-web`，一次连接与一次发送的完整代码，错误码到文案的映射，本地怎么用假引擎联调，以及顶栏与卡片必须遵守的交互规则。视觉与文案以会话产出的可点击原型为准（链接在 game-web PR 描述里）。

## 1. 依赖

game-web 用 pnpm。两种拿包方式，选其一：

**A. 发布到 npm 后按版本依赖**（正式方式）

```jsonc
// package.json
"dependencies": {
  "@rezonalab/engine-bridge-web": "^0.1.0"
}
```

**B. 直接依赖 git 子目录**（发包前的过渡方式）

```jsonc
"dependencies": {
  "@rezonalab/engine-bridge-web": "github:rezona-ai/rezonalab-engine-bridge#path:/packages/web-client"
}
```

git 依赖拿到的是源码目录，而包的 `main` 指向 `dist/index.js`，所以还要满足其一：

- 本仓在 tag 上把 `packages/web-client/dist/` 一起提交（发 tag 前跑 `npm run build`），或
- `packages/web-client/package.json` 加 `"prepare": "tsc -p tsconfig.json"`，让 pnpm 装完自动构建（要求 game-web 的安装环境有 TypeScript；pnpm 默认会跑 git 依赖的 `prepare`）。

无论哪种，锁定到 tag（`#v0.1.0&path:/packages/web-client`）而不是分支，升级插件版本时一起动。

包是纯 ESM、`sideEffects: false`，只用浏览器原生 `WebSocket` 与 `crypto.subtle`，没有 Node 依赖。

## 2. 功能开关

按钮与顶栏面板受**构建期**环境变量控制：`NEXT_PUBLIC_ENGINE_BRIDGE=1` 时渲染，否则整条功能不出现在页面上（不是运行时 kill switch）。回退方式是关掉该变量重新构建部署；插件是用户本机安装物，网页不渲染入口它就只是在 localhost 空转，无害。

## 3. 一次连接与一次发送

```ts
import {
  connectEngine,
  switchInstance,
  send,
  supportsBridge,
  hasSeenLnaExplainer,
  markLnaExplained,
  isChromium142Plus,
  BridgeClientError,
  type BridgeConnection,
  type EngineInstance,
  type EngineKey,
  type SendProgress,
} from '@rezonalab/engine-bridge-web';

// ── 顶栏：连接状态放在一个全局 store 里，整页只有一条连接 ──
type BridgeState =
  | { status: 'idle' }
  | { status: 'connecting'; engine: EngineKey }
  | { status: 'connected'; engine: EngineKey; connection: BridgeConnection; instances: EngineInstance[] }
  | { status: 'error'; engine: EngineKey; code: string };

let state: BridgeState = { status: 'idle' };
const setState = (next: BridgeState) => { state = next; /* 通知 UI */ };

/** 拨开某个引擎的开关。互斥：先断掉当前连接再连新的。 */
export async function toggleEngine(engine: EngineKey): Promise<void> {
  if (supportsBridge() === 'UNSUPPORTED_BROWSER') return setState({ status: 'error', engine, code: 'UNSUPPORTED_BROWSER' });
  if (state.status === 'connected') {
    if (state.connection.busy) return; // 传输中不许切换，UI 层应把开关禁掉
    state.connection.close();
  }
  // Chrome 142+ 首次会弹「连接本地网络设备」权限；先给一层说明再真的去连
  if (isChromium142Plus(navigator.userAgent) && !hasSeenLnaExplainer()) {
    await showLnaExplainerDialog(); // game-web 自己的弹层
    markLnaExplained();
  }
  setState({ status: 'connecting', engine });
  try {
    const { connection, instances } = await connectEngine(engine);
    connection.onClose(() => setState({ status: 'idle' })); // 掉线只回到未连接，不自动重连
    setState({ status: 'connected', engine, connection, instances });
  } catch (err) {
    const code = err instanceof BridgeClientError ? err.code : 'INTERNAL';
    setState({ status: 'error', engine, code });
  }
}

/** 开关下多工程选择：切到另一个端口。 */
export async function pickInstance(port: number): Promise<void> {
  if (state.status !== 'connected' || state.connection.busy) return;
  const connection = await switchInstance(state.connection, port);
  connection.onClose(() => setState({ status: 'idle' }));
  setState({ ...state, connection });
}

// ── 卡片：「发送至 → 引擎」 ──
type CapsuleState =
  | { kind: 'sending'; percent: number }
  | { kind: 'importing' }
  | { kind: 'done'; savedPath: string; sceneNode?: string }
  | { kind: 'error'; code: string };

export async function sendToEngine(
  engine: EngineKey,
  asset: { id: string; displayName: string; fileName: string; kind: 'model3d' | 'image' | 'audio' | 'other'; url: string },
  setCapsule: (s: CapsuleState) => void,
): Promise<void> {
  if (state.status !== 'connected' || state.engine !== engine) {
    showToast('先在顶栏 Engine Bridge 里连接该引擎'); // 未连接：只提示，不自动去连
    return;
  }
  const bytes = await (await fetch(asset.url)).arrayBuffer(); // 网页已登录，直接拿字节
  const onProgress = (p: SendProgress) => {
    switch (p.type) {
      case 'sending': return setCapsule({ kind: 'sending', percent: p.percent });
      case 'importing': return setCapsule({ kind: 'importing' });
      case 'done': return setCapsule({ kind: 'done', savedPath: p.savedPath, sceneNode: p.sceneNode });
      case 'error': return setCapsule({ kind: 'error', code: p.code });
    }
  };
  try {
    await send(state.connection, { name: asset.fileName, bytes, kind: asset.kind, itemId: asset.id, displayName: asset.displayName }, onProgress);
  } catch (err) {
    // send 内部已经通过 onProgress 报过 error；这里兜底未分类的异常
    if (!(err instanceof BridgeClientError)) setCapsule({ kind: 'error', code: 'INTERNAL' });
  }
}
```

`kind` 取自 game-web 的资产类型：3D 模型 → `model3d`，图片 → `image`，音频 → `audio`，其余 → `other`。game-web 目前没有 sprite 资产类型，协议里的 `sprite`（png + json 打成 zip）留给以后接。发送前按 `connection.instance.formats` 与 `connection.instance.limits.maxFileBytes` 灰掉不可发的卡片，比等插件回错更友好。

## 4. 错误码 → 文案

`BridgeClientError.code` 与 `SendProgress` 的 `error.code` 用同一套码。`message` 只进控制台，不给用户看。

| code | 出现在 | 建议文案 | 建议动作 |
|---|---|---|---|
| `NO_ENGINE` | 连接 | 未找到运行中的 <引擎> 插件 | 「重新扫描」+「安装」链接 |
| `ORIGIN_REJECTED` | 连接 | 插件拒绝了本站来源 | 提示在插件「高级」里加本站地址（只在非正式环境会出现） |
| `BUSY` | 连接 / 发送 | 插件正忙，稍后再试 | 传输中禁用开关与再次发送 |
| `TOO_LARGE` | 发送 | 文件超过插件限额（<maxFileBytes>） | 灰掉按钮 |
| `UNSUPPORTED_FORMAT` | 发送 | 该引擎不接受此格式 | 灰掉按钮 |
| `CHECKSUM_MISMATCH` | 发送 | 传输校验失败，请重试 | 允许重发 |
| `IMPORT_FAILED` | 发送 | 引擎导入失败，看插件面板日志 | Unity 常见于缺 glTFast |
| `IMPORT_TIMEOUT` | 发送 | 引擎导入超时 | 让用户到引擎里刷新资产库 |
| `TIMEOUT` | 发送 | 传输超时 | 允许重发 |
| `LNA_DENIED_SUSPECTED` / `LNA_DENIED` | 连接 | 浏览器拒绝了连接本地设备的权限 | 给「如何在站点设置里重置」说明 |
| `UNSUPPORTED_BROWSER` | 连接 | 当前浏览器不支持（请用 Chrome / Edge） | 面板整体置灰 |
| `PLUGIN_OUTDATED` / `PROTOCOL_MISMATCH` | 连接 | 插件需升级 | 「安装」链接（指向新版本） |
| `DISCONNECTED` | 发送 | 插件掉线，传输中断 | 顶栏回到未连接，不自动重连 |
| `PROJECT_NOT_OPEN` | 发送 | 引擎里没有打开工程 | 让用户打开工程 |

## 5. 本地联调

不需要装引擎。在本仓：

```bash
npm ci
npm run dev:fake-engine -- --origin http://localhost:3000
```

假引擎在 41700 监听，默认上报 `engine: cocos`，把收到的文件放到 `./tmp-project/assets/RezonaAssets/`。常用变体：

```bash
npm run dev:fake-engine -- --engine unity --origin http://localhost:3000                 # 走 Unity 端口段 41720
npm run dev:fake-engine -- --project-dir ./tmp-project-2 --name SecondGame --origin http://localhost:3000   # 再起一个 → 自动落 41701，顶栏应出现两个工程
npm run dev:fake-engine -- --max-file-bytes 1048576 --origin http://localhost:3000      # 发 2 MB 文件 → 胶囊「文件超过插件限额」
npm run dev:fake-engine -- --protocol 2 --origin http://localhost:3000                  # 拨开开关 → 该行「插件需升级」并自动断开
```

game-web 本地跑在别的端口就把 `--origin` 换掉；不带 `--origin` 时假引擎只认三个 lab 域名，本地页面会得到 `ORIGIN_REJECTED`。

## 6. 交互规则（必须遵守）

- **开关互斥**：同一时刻只连一个引擎；拨开 B 时先断 A。
- **传输中不许切换**：`connection.busy` 为真时开关与多工程选择禁用；同一连接上第二个 `send` 会直接抛 `BUSY`，UI 不该让它发生。
- **不自动重连**：`onClose` 触发后只把顶栏回到未连接并给一条提示；由用户再拨开关。
- **未连接时点卡片只提示**：不代替用户去连，提示指向顶栏。
- **状态不跨刷新保留**：连接对象活在内存里，刷新页面回到未连接；`localStorage` 里只存「权限说明已看过」这一个标记。
- **拒绝的权限弹窗要可恢复**：`LNA_*` 错误框里给出到站点设置重置权限的步骤，文案见 [install-cocos.md](install-cocos.md) 故障 1。
