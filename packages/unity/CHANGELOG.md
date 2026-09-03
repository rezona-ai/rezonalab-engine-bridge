# Changelog

## [0.1.0] - 2026-09-03

- 首版：协议 v1 的 C# 内核移植（帧编解码、流式分块接收、心跳、Origin 白名单、端口段顺延、zip 安全解压、单客户端会话状态机）。
- Unity 适配层：落盘到 `Assets/RezonaAssets/`，glb 经 glTFast 导入并实例化到当前场景；缺 glTFast 时面板一键添加。
- `Tools → Rezona Bridge` 面板：三态、端口、进度、日志、启停、额外允许来源。
- EditMode 测试跑 `protocol/fixtures` 全部 11 个夹具。
