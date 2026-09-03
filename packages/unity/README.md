# Rezona Bridge（Unity）

Rezona Lab 工作台 → 本机 Unity 工程的直推通道。网页是 WebSocket 客户端，本包在编辑器里开一个只监听
`127.0.0.1` 的 WebSocket 服务端（端口段 41720–41739，`/rezona-bridge`），接收资产字节后落盘到
`Assets/RezonaAssets/`，导入资产库；glb 经 glTFast 实例化到当前场景并选中。协议见仓库 `protocol/spec.md`。

## 安装

Package Manager → Add package from git URL：

```
https://github.com/rezonalab/rezonalab-engine-bridge.git?path=packages/unity
```

要求 Unity 2021.3+。导入 glb 需要 [glTFast](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@latest)
（`com.unity.cloud.gltfast`）；缺包时面板会出黄条，点「添加 glTFast」即可。

## 使用

- 编辑器启动即自动监听；`Tools → Rezona Bridge` 打开面板可停止（偏好会记住）。
- 在 Rezona Lab 工作台顶栏拨开 Unity 开关，卡片「发送至 → Unity」即可。
- 「高级」里可追加允许的网页来源（如 `http://localhost:5173`），默认只接受 `https://lab.rezona.ai`、
  `https://stalab.rezona.ai`、`https://devlab.rezona.ai`。

## 结构

- `Editor/Core/`：与引擎无关的内核（零 Unity 依赖，可在纯 .NET 下编译），逐模块对应 `packages/core-ts/src/`。
- `Editor/UnityAdapter.cs`、`Bootstrap.cs`、`BridgeWindow.cs`：Unity 侧胶水（主线程泵、导入、面板）。
- `Editor/Plugins/websocket-sharp.dll`：vendored websocket-sharp（MIT，见同目录 LICENSE.txt）。
- `Tests/Editor/`：EditMode 测试；夹具由仓库根 `npm run test:unity` 复制进 `Tests/Fixtures/`（gitignored）。

## 测试

```
npm run test:unity          # 需要本机装有 Unity（UNITY_PATH 或 Unity Hub 默认路径）
```
