import type { AssetKind } from './types.js';

/** 内核交给适配层的元数据：文件已在工程目录内落好，适配层只负责「导入资产库 + 实例化到场景」。 */
export interface ImportMeta {
  kind: AssetKind;
  /** 落盘后的文件名（zip 解压时为目录名）。 */
  fileName: string;
  itemId?: string;
  displayName?: string;
  transferId: string;
}

export interface ImportOutcome {
  /** 工程内路径（Cocos 为 db:// 地址，Unity 为 Assets/ 相对路径）。 */
  savedPath: string;
  /** 实例化到场景的节点名；未实例化则省略。 */
  sceneNode?: string;
}

/**
 * 引擎适配层接口。接第 N 个引擎只需实现这一层：
 * - `importFile(absPath, meta)`：给你的是已校验、已落在 `<assetsRoot>/RezonaAssets/` 下的绝对路径（zip 时为解压目录），
 *   返回工程内路径或抛出带 `code` 的 `BridgeError`。
 * - `isProjectOpen()`：为假时握手后收到 transfer_begin 回 PROJECT_NOT_OPEN。
 * 适配层不碰网络与文件接收；内核不 import 任何引擎 API。
 */
export interface EngineAdapter {
  importFile(absPath: string, meta: ImportMeta): Promise<ImportOutcome>;
  isProjectOpen(): boolean;
}
