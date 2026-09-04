import type { PortRange } from './protocol-types.js';

export type EngineKey = 'cocos' | 'unity' | 'godot' | 'unreal' | 'blender';

export interface EngineInfo {
  key: EngineKey;
  displayName: string;
  /** 探测时并行打整个端口段；与 core-ts `PORT_RANGES` 一致，这里重复声明是为了不让浏览器包依赖 node 侧代码。 */
  portRange: PortRange;
  /** false 的引擎在顶栏灰显「即将支持」。 */
  supported: boolean;
  /** 我们当前发布的插件版本（顶栏行内展示）。 */
  pluginVersion: string;
  /** 握手应答低于此版本 → 断开并报 PLUGIN_OUTDATED。 */
  minPluginVersion: string;
  installDocUrl: string;
}

const DOCS = 'https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs';
/** 网页客户端自身版本，握手 `clientVersion` 用；与 package.json 同步（scripts/sync-version.mjs）。 */
export const CLIENT_VERSION = '0.1.4';
export const CLIENT_NAME = 'rezona-web';

export const ENGINES: readonly EngineInfo[] = [
  { key: 'cocos', displayName: 'Cocos Creator', portRange: [41700, 41719], supported: true, pluginVersion: '0.1.4', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-cocos.md` },
  { key: 'unity', displayName: 'Unity', portRange: [41720, 41739], supported: true, pluginVersion: '0.1.4', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-unity.md` },
  { key: 'godot', displayName: 'Godot', portRange: [41740, 41759], supported: false, pluginVersion: '0.1.4', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-godot.md` },
  { key: 'unreal', displayName: 'Unreal Engine', portRange: [41760, 41779], supported: false, pluginVersion: '0.1.4', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-unreal.md` },
  { key: 'blender', displayName: 'Blender', portRange: [41780, 41799], supported: false, pluginVersion: '0.1.4', minPluginVersion: '0.1.0', installDocUrl: `${DOCS}/install-blender.md` },
];

export function getEngine(key: EngineKey): EngineInfo {
  const found = ENGINES.find((e) => e.key === key);
  if (!found) throw new Error(`unknown engine ${key}`);
  return found;
}
