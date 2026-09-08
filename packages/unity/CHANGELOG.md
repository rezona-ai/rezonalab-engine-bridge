# Changelog

## [0.1.8] - 2026-09-08

- 安装方式改为 **UPM tarball 下载**：Release 里多一个 `rezona-bridge-unity-<版本>.tgz`，
  在 Package Manager 的「＋ → Install package from tarball」里选中即可。
  此前只给 UPM git 地址，网页上那颗「安装」按钮点下去只是复制一段文本；
  而且 UPM 解析 git 依赖要求本机装了 git 并在 PATH 里，没装的人只会拿到一句与 git 无关的报错。
  git 地址仍在安装文档里作为备选。

## [0.1.7] - 2026-09-07

- Origin 拒绝改为**升级握手之后**关 4403，不再在 HTTP 101 之前拒绝：浏览器读不到握手状态码，
  之前「来源不在白名单」与「端口没人监听」在网页侧完全同形，用户只看到「未找到编辑器」。
- 窗口日志改为按语言渲染：内核只发事件码与参数，文案在面板侧取表（与 Cocos 扩展同一张表，码集一致由测试保证）。
  英文编辑器里不再出现「标签英文、日志中文」。
- 窗口语言改读**编辑器**的语言偏好，不再读操作系统语言。

## [0.1.6] - 2026-09-07

- 仅版本对齐（本次改动在网页客户端：面板里 Cocos 的显示名简化为 Cocos）。

## [0.1.5] - 2026-09-07

- 仅版本对齐（本次改动在网页客户端：本地网络权限判定与安装入口）。

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
