import type { PortRange } from './protocol-types.js';

export type EngineKey = 'cocos' | 'unity' | 'godot' | 'unreal' | 'blender';

/**
 * 两个引擎的安装物都是一个可下载的文件，网页因此只需要一种入口：
 * - Cocos：Release 里的 zip，解压进工程的 `extensions/`。
 * - Unity：Release 里的 UPM tarball，在 Package Manager 的「＋ → Install package from tarball」里选中。
 *
 * Unity 早先给的是 UPM git 地址（网页只能帮忙复制）。换成 tarball 有两个理由：
 * UPM 解析 git 依赖要求用户机器装了 git 并在 PATH 里，没装的人只会拿到一句看不懂的报错；
 * 而「安装」按钮点了却只是复制一段文本，与它的字面承诺不符。git 地址仍在安装文档里作为备选。
 */
export interface EngineInstall {
  kind: 'download';
  url: string;
  fileName: string;
}

export interface EngineInfo {
  key: EngineKey;
  displayName: string;
  /** 探测时并行打整个端口段；与 core-ts `PORT_RANGES` 一致，这里重复声明是为了不让浏览器包依赖 node 侧代码。 */
  portRange: PortRange;
  /** false 的引擎尚未实现；前端不渲染它们（端口段留在这里作为已预留的记录）。 */
  supported: boolean;
  /** 我们当前发布的插件版本（顶栏行内展示）。 */
  pluginVersion: string;
  /** 握手应答低于此版本 → 断开并报 PLUGIN_OUTDATED。 */
  minPluginVersion: string;
  installDocUrl: string;
  /** 未支持的引擎没有安装物。 */
  install?: EngineInstall;
}

const REPO = 'https://github.com/rezona-ai/rezonalab-engine-bridge';
const DOCS = `${REPO}/blob/main/docs`;
/** 网页客户端自身版本，握手 `clientVersion` 用；与 package.json 同步（scripts/sync-version.mjs）。 */
export const CLIENT_VERSION = '0.1.10';
export const CLIENT_NAME = 'rezona-web';

/**
 * 安装地址由每条的 `pluginVersion` 派生。**唯一的版本字面量必须写在 pluginVersion 字段上**，
 * 因为 `scripts/sync-version.mjs` 只重写这个模式；另起一个常量存版本号，发版后会静默指向旧 tag。
 */
const INSTALL_FILE: Partial<Record<EngineKey, (version: string) => string>> = {
  cocos: (v) => `rezona-bridge-cocos-${v}.zip`,
  unity: (v) => `rezona-bridge-unity-${v}.tgz`,
};

function installFor(e: Omit<EngineInfo, 'install'>): EngineInstall | undefined {
  if (!e.supported) return undefined;
  const name = INSTALL_FILE[e.key];
  if (!name) return undefined;
  const fileName = name(e.pluginVersion);
  return { kind: 'download', url: `${REPO}/releases/download/v${e.pluginVersion}/${fileName}`, fileName };
}

const BASE: readonly Omit<EngineInfo, 'install'>[] = [
  { key: 'cocos', displayName: 'Cocos', portRange: [41700, 41719], supported: true, pluginVersion: '0.1.10', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-cocos.md` },
  { key: 'unity', displayName: 'Unity', portRange: [41720, 41739], supported: true, pluginVersion: '0.1.10', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-unity.md` },
  { key: 'godot', displayName: 'Godot', portRange: [41740, 41759], supported: false, pluginVersion: '0.1.10', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-godot.md` },
  { key: 'unreal', displayName: 'Unreal Engine', portRange: [41760, 41779], supported: false, pluginVersion: '0.1.10', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-unreal.md` },
  { key: 'blender', displayName: 'Blender', portRange: [41780, 41799], supported: false, pluginVersion: '0.1.10', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-blender.md` },
];

export const ENGINES: readonly EngineInfo[] = BASE.map((e) => {
  const install = installFor(e);
  return install ? { ...e, install } : { ...e };
});

/** 前端应当渲染的引擎：已实现的那些。未实现的留在 ENGINES 里只为记录已预留的端口段。 */
export const SUPPORTED_ENGINES: readonly EngineInfo[] = ENGINES.filter((e) => e.supported);

export function getEngine(key: EngineKey): EngineInfo {
  const found = ENGINES.find((e) => e.key === key);
  if (!found) throw new Error(`unknown engine ${key}`);
  return found;
}
