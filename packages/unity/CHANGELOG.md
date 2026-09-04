# Changelog

## [0.1.4] - 2026-09-04

- 新增 `video` 类型（mp4 / webm）：只导入不实例化；`formats` 加 `fbx`（走 Unity 自带 ModelImporter，不需要 glTFast）。glTFast 缺包检查只对 glb / gltf 生效。

## [0.1.3] - 2026-09-04

- 窗口重做：品牌区（R 标 + 名称 + 版本 + 状态胶囊 + 启停）、连接卡片、级别着色日志、页脚文档链接；文案跟随编辑器语言（zh/en）。
- 修复窗口刚启动时显示「已停止」（StateChanged 早于 Server 赋值）。
- displayName 改为 Rezona Bridge for Unity。

## [0.1.2] - 2026-09-03

- 修复：git URL 安装后包内一行代码都没编译——UPM 把包当只读目录，缺 `.meta` 的资产被整体忽略（`has no meta file, but it's in an immutable folder`）。现在 Unity 生成的 `.meta` 随包提交。v0.1.1 因此不可用，请装 v0.1.2。
- `Bootstrap.PluginVersion` 跟 monorepo 版本对齐（握手里的 `pluginVersion` 之前一直报 0.1.0）。

## [0.1.0] - 2026-09-03

- 首版：协议 v1 的 C# 内核移植（帧编解码、流式分块接收、心跳、Origin 白名单、端口段顺延、zip 安全解压、单客户端会话状态机）。
- Unity 适配层：落盘到 `Assets/RezonaAssets/`，glb 经 glTFast 导入并实例化到当前场景；缺 glTFast 时面板一键添加。
- `Tools → Rezona Bridge` 面板：三态、端口、进度、日志、启停、额外允许来源。
- EditMode 测试跑 `protocol/fixtures` 全部 11 个夹具。
