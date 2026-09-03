import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import type { BridgeServerConfig, EngineAdapter, PortRange } from '@rezonalab/engine-bridge-core';

/** Cocos 引擎固定端口段（与内核 PORT_RANGES.cocos 一致，这里写死避免装配依赖内核常量形状）。 */
export const COCOS_PORT_RANGE: PortRange = [41700, 41719];

/** 扩展在编辑器内的包名，也是 Profile 与消息的命名空间。 */
export const PACKAGE_NAME = 'rezona-bridge';

/** 装配所需的全部输入；由 main.ts 从 `Editor` 全局读出后注入，本模块不碰 Editor。 */
export interface AssembleInput {
  projectPath: string;
  appVersion: string;
  pluginVersion: string;
  extraOrigins?: readonly string[];
}

/** 工程 id：路径 sha1 前 8 位，网页端用它区分同机多个工程。 */
export function deriveProjectId(projectPath: string): string {
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 8);
}

/** 把注入的输入装配成内核 createBridgeServer 的配置。纯函数，便于单测。 */
export function buildServerConfig(input: AssembleInput, adapter: EngineAdapter): BridgeServerConfig {
  return {
    engine: 'cocos',
    engineVersion: input.appVersion,
    pluginVersion: input.pluginVersion,
    project: { name: basename(input.projectPath), id: deriveProjectId(input.projectPath) },
    assetsRoot: join(input.projectPath, 'assets'),
    portRange: COCOS_PORT_RANGE,
    extraOrigins: [...(input.extraOrigins ?? [])],
    adapter,
  };
}

/** Profile 里的 autoStart：缺省 / 非布尔一律视为开（KTD-12：编辑器启动即监听）。 */
export function resolveAutoStart(raw: unknown): boolean {
  return raw !== false;
}

/** Profile 里的 extraOrigins：只保留去掉首尾空白后非空的字符串。 */
export function normalizeExtraOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v.length > 0);
}

/** 端口段耗尽时面板红字文案。 */
export function portsExhaustedMessage(range: PortRange): string {
  return `${range[0]} 到 ${range[1]} 全部被占用`;
}
