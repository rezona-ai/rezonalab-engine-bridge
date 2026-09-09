# 安装 Rezona Bridge · Unity

适用：Unity **2021.3 LTS 及以上**（推荐 2022.3 LTS），URP 与内置渲染管线均可。包只含 Editor 程序集，不会进打包产物；只监听 `127.0.0.1`、只接受白名单来源。

## 安装步骤

推荐用 tarball：这是 Unity 自带的、基于文件的安装入口，保留完整的包语义（版本、清单、干净卸载），
也不要求你的机器装了 git。

1. 下载 **rezona-bridge-unity-<版本>.tgz**（Rezona Lab 工作台的 Rezona Bridge 面板里，Unity 那行点「下载」；
   或从 [Releases](https://github.com/rezona-ai/rezonalab-engine-bridge/releases) 取）。
2. **把 tgz 放进你工程的 `Packages/` 目录**。见下面「为什么要放进工程里」。
3. 打开 Unity 工程，菜单 **Window → Package Manager**。
4. 左上角 **＋ → Install package from tarball…**，选中刚放好的 tgz。

   文件选择框只认 `.tgz` 后缀，别改名。

5. 装好后列表里出现 **Rezona Bridge for Unity**（`com.rezonalab.engine-bridge`）。
6. 菜单 **Tools → Rezona Bridge** 打开窗口，看到「监听中 · 端口 41720」即安装完成。

   ![Rezona Bridge for Unity 窗口：监听中 · 端口 41720](images/unity-window-listening.png)

7. 要导入 glb 需要 **glTFast**。窗口检测到缺包时会出黄条「需要 glTFast」并给一个「添加 glTFast」按钮，
   点它相当于在 Package Manager 里添加 `com.unity.cloud.gltfast`。

   黄条只在第一次收到 glb 且检测不到 glTFast 时出现，之后自动消失。

8. 回到 Rezona Lab 工作台，画布左上角「Rezona Bridge」拨开 **Unity** 开关；Chrome 会弹一次「连接本地网络设备」询问，点允许。徽标「已连接 · <工程名>」后即可在卡片上「导出至 → Unity」。

### 为什么要放进工程里

Unity 不会把 tarball 的内容复制进工程，它在 `Packages/manifest.json` 里记下这个文件的路径，
解压产物放在 `Library/PackageCache/`。实测（Unity 6000.0.80f1）：

| 情况 | 结果 |
|---|---|
| 装完删掉 tgz，重开编辑器 | 正常，走 `Library` 缓存 |
| 删掉 tgz 且 `Library` 被清（换机器、同事新克隆、Reimport All） | 失败，报「Tarball package … cannot be found at path」 |
| tgz 放在工程 `Packages/` 内、清单里是相对路径，`Library` 被清 | 正常 |

放进 `Packages/` 之后清单里记的是相对路径，工程带着 tgz 一起走，谁克隆都能解析。

### 备选：UPM git 地址

如果你的机器装了 git 并在 PATH 里，也可以在 **＋ → Add package from git URL…** 里粘：

```
https://github.com/rezona-ai/rezonalab-engine-bridge.git?path=packages/unity#v0.1.10
```

升级时把末尾 tag 换成新版本再添加一次即可。**没装 git 的机器用不了这条路**，UPM 会报一句与 git 无关的错。

升级 tarball 装法：下载新版 tgz 放进 `Packages/`，在 Package Manager 里重新 Install package from tarball 选新文件，
然后删掉旧的 tgz。改脚本触发域重载时服务端会自动重建，端口不变。

## 窗口字段

| 字段 | 含义 |
|---|---|
| 状态 | `已停止` / `监听中` / `传输中` |
| 端口 | 当前占用端口；同机第二个 Unity 工程自动落到 41721 |
| 工程 | 工程目录名与 8 位工程 id |
| 当前文件 / 进度 | 正在接收或导入的文件与进度条 |
| 日志 | 最近 200 行 |
| 停止 / 启动 | 手动释放或重新占用端口；记在 `EditorPrefs["RezonaBridge.AutoStart"]` |
| 高级 → 额外允许来源 | 见下文 |

资产落在 `Assets/RezonaAssets/`：glb 经 glTFast 导入并实例化到当前场景、原点位置、被选中；图片 / 音频只导入；sprite 解压到 `Assets/RezonaAssets/<名字>/`。

## 「高级」：Origin 允许列表

默认只接受这三个网页来源：

```
https://rezona.ai
https://lab.rezona.ai
https://stalab.rezona.ai
https://devlab.rezona.ai
```

本机调试 game-web 时，在「高级 → 额外允许来源」加一行 `http://localhost:3000`。立即生效。

## 常见故障

### 1. 浏览器权限弹窗被拒绝了 / 网页一直「未找到引擎」

Chrome 142 及以上首次连 `ws://127.0.0.1` 会弹「<站点> 想要连接本地网络上的设备」；拒绝后不再弹，网页显示「未能连接本地插件，可能是权限被拒绝」。

恢复：地址栏站点信息图标 →「网站设置」→「本地网络访问」改「允许」或「重置权限」→ 刷新后重新拨开开关；也可到 `chrome://settings/content/localNetworkAccess`。Edge 同理；**Safari 不支持**。

### 2. 端口全占（41720–41739）

窗口显示「端口 41720–41739 均被占用」：20 个端口全被别的进程拿着，多半是没退干净的 Unity 进程或别的本地服务。

排查：macOS `lsof -nP -iTCP:41720-41739 -sTCP:LISTEN`，Windows `netstat -ano | findstr 417`。结束占用进程后点「启动」。

### 3. glTFast 缺失

发送 glb 时胶囊「导入失败」，窗口黄条「需要 glTFast」：包里不带 glTFast，需要你的工程自己装。

- 点黄条上的「添加 glTFast」，等 Package Manager 装完 `com.unity.cloud.gltfast`（会触发一次域重载），再重发。
- 也可手动 Package Manager → 按名称添加 `com.unity.cloud.gltfast`。
- 装完材质是粉色：URP 工程需要 glTFast 的 URP shader 变体，在 Package Manager 里 glTFast 的 Samples 或 Project Settings → Graphics 里把对应 shader 加进 Always Included Shaders。

## 卸载

Package Manager 里选中 Rezona Bridge → Remove。已导入资产是普通工程文件；没有任何服务端状态需要清理。
