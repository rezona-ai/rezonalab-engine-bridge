# @rezonalab/engine-bridge-web

Rezona Engine Bridge 的浏览器端客户端：探测本机引擎插件、保持一条活连接、把资产字节分块直推给插件。零运行时依赖，ESM。

- 网页是 WebSocket 客户端，插件是只听 `127.0.0.1` 的服务端（协议见仓库 `protocol/spec.md`）。
- 一次只保持一个引擎的连接；掉线不自动重连，由用户重新拨开开关。
- 同一连接上同一时刻只允许一个 `send`，第二个立即抛 `BUSY`。
- 插件只放行白名单 Origin（`https://lab.rezona.ai`、`https://stalab.rezona.ai`、`https://devlab.rezona.ai`，开发者可在插件面板追加 `http://localhost:*`）；不在白名单的页面探测结果就是 `NO_ENGINE`。

## 用法

```ts
import { connectEngine, send, supportsBridge, hasSeenLnaExplainer, markLnaExplained, BridgeClientError, ENGINES } from '@rezonalab/engine-bridge-web';

if (supportsBridge() !== 'ok') throw new Error('Safari / 无 WebSocket 不支持');
if (!hasSeenLnaExplainer()) {
  // 首次先解释 Chrome 会弹「连接本地网络设备」权限，再连
  markLnaExplained();
}

// 顶栏拨开 Cocos 开关：探测 41700–41719，保留第一个实例，其余关闭
const { connection, instances } = await connectEngine('cocos');
connection.onClose(({ reason }) => console.log('bridge closed', reason)); // 'HEARTBEAT' = 10 秒没 pong

// 多工程时可切换：const next = await switchInstance(connection, instances[1].port);

// 卡片「发送至 → Cocos」：复用已有连接，不再握手
const bytes = await (await fetch(downloadUrl, { credentials: 'include' })).arrayBuffer();
try {
  const { savedPath, sceneNode } = await send(
    connection,
    { name: 'hero.glb', bytes, kind: 'model3d', itemId: 'm3d-xxxx', displayName: 'Hero' },
    (p) => {
      if (p.type === 'sending') console.log(`传输 ${p.percent}%`);
      else if (p.type === 'importing') console.log('导入中');
    },
  );
  console.log('已导入', savedPath, sceneNode);
} catch (err) {
  if (err instanceof BridgeClientError) console.error(err.code, err.message); // BUSY / TOO_LARGE / CHECKSUM_MISMATCH / DISCONNECTED …
}
```

## 错误码

`connectEngine`：`NO_ENGINE`（端口段无人应答）、`LNA_DENIED_SUSPECTED`（全部端口瞬间 error 且无一打开，疑似浏览器拒绝本地网络访问）、`PLUGIN_OUTDATED`（协议版本不合或插件版本低于 `minPluginVersion`）、`UNSUPPORTED_ENGINE`。

`send`：`BUSY`、`UNSUPPORTED_FORMAT`、`TOO_LARGE`、`TOO_MANY_CHUNKS`、`CHECKSUM_MISMATCH`、`IMPORT_FAILED`、`IMPORT_TIMEOUT`（`importing` 阶段 30 秒）、`TIMEOUT`（整体 120 秒）、`DISCONNECTED`，以及服务端 `error` 帧 / `import_result.error` 里的任何协议错误码原样透传。

## 可注入项（测试 / 特殊环境）

`connectEngine(key, { createSocket, portRange, probeTimeoutMs, pingIntervalMs, pongTimeoutMs, lnaSuspectMs, minPluginVersion })`。
测试里用 `ws` 客户端做 `createSocket`（可带 Origin 头），对着 `@rezonalab/engine-bridge-core` 的 `createBridgeServer` 跑真实链路。
