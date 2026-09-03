# Rezona Engine Bridge 协议规格 v1

网页（Rezona Lab 工作台）是 WebSocket **客户端**，引擎插件是只监听 `127.0.0.1` 的 WebSocket **服务端**。
网页把资产字节直接推给插件，插件落盘、导入资产库、实例化到场景。服务端零参与。

字段名以 `schema/messages.schema.json` 与 `schema/chunk-header.schema.json` 为准；本文冲突时以 Schema 为准。
`fixtures/` 目录里的录制夹具是两种语言实现（TypeScript 内核、C# 移植）的唯一一致性保障。

## 1. 传输层

- WebSocket（RFC 6455），地址 `ws://127.0.0.1:<port>/rezona-bridge`。只绑 `127.0.0.1`，绝不绑 `0.0.0.0`。
- 端口段按引擎固定，启动时从段首顺延找第一个空闲端口（同引擎多实例各占一个）：

| 引擎 | 端口段 |
|---|---|
| Cocos Creator | 41700 – 41719 |
| Unity | 41720 – 41739 |
| （预留）Godot | 41740 – 41759 |
| （预留）Unreal | 41760 – 41779 |
| （预留）Blender | 41780 – 41799 |

- 网页探测时对该引擎的整个端口段并行发起连接（每个 800 ms 超时），收集所有 `hello_ack`，即得全部实例。

## 2. Origin 校验（握手前）

插件在 WebSocket 升级握手阶段读取 `Origin` 头，精确匹配（scheme + host + port）白名单；缺失或不匹配 → 直接以关闭码 **4403** 拒绝，
**不发** `hello_ack`。默认白名单：

```
https://lab.rezona.ai
https://lab-stage.rezona.ai
https://lab-dev.rezona.ai
```

开发者可在插件面板「高级」追加（如 `http://localhost:3000`）。

## 3. 文本消息

全部为 UTF-8 JSON，带 `type` 字段，单条上限 64 KiB。

| type | 方向 | 说明 |
|---|---|---|
| `hello` | 网页 → 插件 | 连接建立后立即发送；声明 `protocol`、`client`、`clientVersion` |
| `hello_ack` | 插件 → 网页 | 引擎、版本、工程、限额、支持格式 |
| `transfer_begin` | 网页 → 插件 | 文件元数据与分块计划 |
| `chunk_ack` | 插件 → 网页 | 每块落盘后确认 |
| `transfer_end` | 网页 → 插件 | 最后一块之后 |
| `import_progress` | 插件 → 网页 | `stage`: `received` → `importing` |
| `import_result` | 插件 → 网页 | `ok` + `savedPath`/`sceneNode` 或 `error{code,message}` |
| `ping` / `pong` | 双向 | 心跳 |
| `error` | 插件 → 网页 | 应用层错误（可选跟随关闭） |

### hello / hello_ack

```json
{ "type": "hello", "protocol": 1, "client": "rezona-web", "clientVersion": "1.0.0" }
```

```json
{ "type": "hello_ack", "protocol": 1,
  "engine": "cocos", "engineVersion": "3.8.6", "pluginVersion": "0.1.0",
  "project": { "name": "MyGame", "id": "b3f1a2c4" },
  "limits": { "chunkBytes": 4194304, "maxFileBytes": 536870912, "maxChunks": 128 },
  "formats": ["glb", "png", "jpg", "jpeg", "webp", "mp3", "wav", "ogg", "zip"] }
```

`protocol` 不等于 1 → 插件回 `error{code:"PROTOCOL_MISMATCH"}` 后以 **4426** 关闭。
`hello` 之前收到任何其它文本消息 → **4400**。

### transfer_begin

```json
{ "type": "transfer_begin", "transferId": "t_01J…",
  "fileName": "hero.glb", "byteSize": 4812331, "sha256": "9f…",
  "kind": "model3d", "chunkBytes": 4194304, "chunkCount": 2,
  "meta": { "itemId": "m3d-xxxx", "displayName": "Hero" } }
```

插件按顺序校验：

1. 状态必须为 `ready`；`receiving` / `importing` 中再收 → **4409**（插件忙）。
2. `byteSize ≤ limits.maxFileBytes`，否则 `error{TOO_LARGE}` + **4413**。
3. `chunkCount ≤ limits.maxChunks`，否则 `error{TOO_MANY_CHUNKS}` + **4413**。
4. `chunkBytes == limits.chunkBytes` 且 `chunkCount == ceil(byteSize / chunkBytes)`（`byteSize` 为 0 时 `chunkCount` 为 0），否则 **4400**。
5. `fileName` 不含 `/`、`\`、`..`、`\0`、控制字符，长度 ≤ 200；扩展名在 `formats` 内，否则 `error{UNSUPPORTED_FORMAT}`（连接保持 `ready`）。
6. `kind` 为 `sprite` 时扩展名必须是 `zip`。

通过后打开 `<系统临时目录>/rezona-bridge/<transferId>.part` 写流，状态进入 `receiving`。

### 二进制帧（分块）

```
uint32 大端 headerLen | headerLen 字节 JSON 头 | 原始数据
```

JSON 头只有 `{ "transferId": "t_01J…", "index": 0 }`，`headerLen ≤ 1024`。
`index` 必须严格等于期待的下一块（从 0 递增），乱序 / 重复 / 未知 `transferId` / 越界 → **4400**。
最后一块可以短于 `chunkBytes`，其余块必须恰好 `chunkBytes`；累计字节超过 `byteSize` → **4413**。
每块追加写盘并增量计算 sha256 后回：

```json
{ "type": "chunk_ack", "transferId": "t_01J…", "index": 0 }
```

网页收到上一块的 `chunk_ack` 后才发下一块（简单背压）。

### transfer_end

```json
{ "type": "transfer_end", "transferId": "t_01J…" }
```

插件校验累计字节 == `byteSize` 且 sha256 匹配：

- 不匹配 → 删临时文件，回 `import_result{ok:false, error.code:"CHECKSUM_MISMATCH"}`，回到 `ready`。
- 匹配 → 回 `import_progress{stage:"received"}`；
  - 普通文件：原子改名到 `<assetsRoot>/RezonaAssets/<fileName>`（同名存在则加 `-2`、`-3` 后缀）；
  - `.zip`：安全解压到 `<assetsRoot>/RezonaAssets/<fileNameWithoutExt>/`（同名目录存在则加后缀）；任一条目不安全 → 删已解压目录，回 `import_result{ok:false, error.code:"ZIP_UNSAFE_ENTRY" | "ZIP_TOO_MANY_ENTRIES" | "ZIP_TOO_LARGE"}`；
  - 然后回 `import_progress{stage:"importing"}`，调用引擎适配层 `importFile(path, meta)`；
  - 适配层成功 → `import_result{ok:true, savedPath, sceneNode?}`；抛错 → `import_result{ok:false, error}`；超过 30 秒 → `IMPORT_TIMEOUT`。
- 无论成败，连接保持并回到 `ready`，可继续下一次传输。

```json
{ "type": "import_progress", "transferId": "t_01J…", "stage": "received" }
{ "type": "import_progress", "transferId": "t_01J…", "stage": "importing" }
{ "type": "import_result", "transferId": "t_01J…", "ok": true,
  "savedPath": "db://assets/RezonaAssets/hero.glb", "sceneNode": "Hero" }
{ "type": "import_result", "transferId": "t_01J…", "ok": false,
  "error": { "code": "CHECKSUM_MISMATCH", "message": "sha256 mismatch" } }
```

### 心跳

插件每 **15 秒**发 `{"type":"ping"}`，网页回 `pong`；插件 **60 秒**未收到任何帧（任何文本或二进制帧都算）→ 以 **4408** 关闭。
网页每 5 秒发 `ping`，插件回 `pong`；网页 10 秒收不到 `pong` 判掉线。**双方都不自动重连**。

## 4. zip 安全规则

- 条目名以 `/` 或 `\` 开头、含 `..` 段、含 `\0`、或 `externalFileAttributes` 表示符号链接 → 整包拒绝 `ZIP_UNSAFE_ENTRY`。
- 条目数 > 500 → `ZIP_TOO_MANY_ENTRIES`；累计解压字节 > 1 GiB → `ZIP_TOO_LARGE`。
- 写每个文件前 `resolve` 目标路径并断言以目标目录为前缀（realpath）。

## 5. 关闭码

| 码 | 含义 |
|---|---|
| 1000 | 正常关闭（网页切换实例 / 拨回开关 / 插件被新连接替换） |
| 4400 | 帧格式错误 / 协议顺序错误 |
| 4403 | Origin 拒绝 |
| 4408 | 心跳超时 |
| 4409 | 插件忙（已有传输进行中） |
| 4413 | 超过限额 |
| 4426 | 协议版本不兼容 |

## 6. 应用层错误码

`CHECKSUM_MISMATCH`、`ZIP_UNSAFE_ENTRY`、`ZIP_TOO_MANY_ENTRIES`、`ZIP_TOO_LARGE`、`UNSUPPORTED_FORMAT`、`TOO_LARGE`、`TOO_MANY_CHUNKS`、
`IMPORT_FAILED`、`IMPORT_TIMEOUT`、`PROJECT_NOT_OPEN`、`PROTOCOL_MISMATCH`、`INTERNAL`。

## 7. 插件侧状态机（每连接）

```
idle ──hello ok──▶ ready ──transfer_begin──▶ receiving ──end + checksum ok──▶ importing ──▶ ready
                    ▲                            │                                 │
                    └──── import_result{ok:false} ┴─────────────────────────────────┘
```

面板可见的服务端三态：`stopped` / `listening` / `busy`（有传输在飞）。

## 8. 单客户端策略

已有连接处于 `busy`（receiving / importing）时，新连接以 **4409** 关闭；处于 `ready` / `idle` 时新连接替换旧连接（旧的以 1000 关闭）。
网页探测端口段时会对每个实例建立一条短连接，拿到 `hello_ack` 后只保留一条。

## 9. 夹具格式

```json
{
  "name": "happy-single-chunk",
  "origin": "https://lab.rezona.ai",
  "server": { "limits": { "chunkBytes": 16, "maxFileBytes": 4096, "maxChunks": 256 } },
  "frames": [
    { "dir": "in", "text": { "type": "hello", "protocol": 1, "client": "rezona-web", "clientVersion": "1.0.0" } },
    { "dir": "in", "binary": { "header": { "transferId": "t1", "index": 0 }, "bytesBase64": "…" } },
    { "dir": "tick", "ms": 61000 }
  ],
  "expect": {
    "outFrames": [ { "type": "hello_ack", "…": "…" } ],
    "closeCode": null,
    "finalState": "ready",
    "savedFileSha256": "…",
    "files": [ "RezonaAssets/hero.glb" ],
    "adapterCalls": [ { "fileName": "hero.glb", "kind": "model3d" } ]
  }
}
```

夹具里的服务端固定为 `engine: "fake"`、`engineVersion: "0.0.0"`、`pluginVersion: "0.1.0"`、`project: { name: "Fixture", id: "fixture1" }`，
默认白名单；`server.limits` / `server.formats` 可覆盖。假适配层总是成功返回 `savedPath = "<root>/RezonaAssets/<basename>"`，
`kind` 为 `model3d` 时 `sceneNode = meta.displayName`。`files` 是运行结束后 `assetsRoot` 下的全部相对路径（排序后）。
`tick` 帧推进虚拟时钟（毫秒）。运行结束后临时目录必须为空。
