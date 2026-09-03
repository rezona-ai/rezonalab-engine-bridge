import { posix } from 'node:path';
import { BridgeError, type EngineAdapter, type ImportMeta, type ImportOutcome } from '@rezonalab/engine-bridge-core';

/** `Editor.Message` 的最小子集，注入以便单测。 */
export interface EditorMessageBus {
  request(pkg: string, message: string, ...args: unknown[]): Promise<unknown>;
}

export interface CocosAdapterDeps {
  message: EditorMessageBus;
  /** 可注入的等待与时钟，测试用虚拟时间。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

/** asset-db 返回的资产信息里我们关心的字段。 */
interface AssetInfoLike {
  uuid?: string;
  url?: string;
  importer?: string;
  type?: string;
  isDirectory?: boolean;
  subAssets?: Record<string, AssetInfoLike>;
}

const POLL_INTERVAL_MS = 500;
const IMPORT_TIMEOUT_MS = 15_000;
const ASSETS_DB_ROOT = 'db://assets';
const REZONA_DIR_URL = `${ASSETS_DB_ROOT}/RezonaAssets`;

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Cocos Creator 适配层：文件已由内核落到 `<assets>/RezonaAssets/` 下，这里只做
 * 「刷新资产库 → 轮询确认导入 → （模型）实例化到场景」。全部通过 `Editor.Message.request` 走 IPC。
 */
export class CocosAdapter implements EngineAdapter {
  private readonly message: EditorMessageBus;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly assetsRoot: string,
    deps: CocosAdapterDeps,
  ) {
    this.message = deps.message;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** 扩展在工程内运行，工程必然是打开的。 */
  isProjectOpen(): boolean {
    return true;
  }

  /** 绝对路径 → `db://assets/...`；统一用 `/`，兼容 Windows 分隔符。 */
  toDbUrl(absPath: string): string {
    // 先把两边的分隔符统一成 `/`，再用 posix 语义算相对路径，Windows 路径在任何平台上都能得到同样结果。
    const rel = posix.relative(toPosix(this.assetsRoot), toPosix(absPath));
    return `${ASSETS_DB_ROOT}/${rel}`;
  }

  async importFile(absPath: string, meta: ImportMeta): Promise<ImportOutcome> {
    const dbUrl = this.toDbUrl(absPath);
    // zip 类资产（sprite）内核已解压成目录，刷新该目录；其余刷新 RezonaAssets 根即可。
    const refreshTarget = meta.kind === 'sprite' ? dbUrl : REZONA_DIR_URL;
    await this.message.request('asset-db', 'refresh-asset', refreshTarget);

    const info = await this.waitForImported(dbUrl);

    if (meta.kind === 'sprite') {
      await this.assertPngInside(dbUrl);
      return { savedPath: dbUrl };
    }
    if (meta.kind === 'model3d') {
      const sceneNode = await this.instantiateModel(dbUrl, info, meta);
      return sceneNode ? { savedPath: dbUrl, sceneNode } : { savedPath: dbUrl };
    }
    return { savedPath: dbUrl };
  }

  /** 每 500 ms 查一次 asset info，拿到 uuid 且 importer 非空即视为导入完成；15 秒超时。 */
  private async waitForImported(dbUrl: string): Promise<AssetInfoLike> {
    const startedAt = this.now();
    for (;;) {
      const info = await this.queryAssetInfo(dbUrl);
      if (info?.uuid && info.importer) return info;
      if (this.now() - startedAt >= IMPORT_TIMEOUT_MS) {
        throw new BridgeError('IMPORT_TIMEOUT', `资产库 ${IMPORT_TIMEOUT_MS / 1000} 秒内未完成导入：${dbUrl}`);
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  private async queryAssetInfo(dbUrl: string): Promise<AssetInfoLike | null> {
    try {
      const r = await this.message.request('asset-db', 'query-asset-info', dbUrl);
      return (r as AssetInfoLike | null) ?? null;
    } catch {
      // 资产尚未入库时 asset-db 可能直接抛错，等同于未就绪。
      return null;
    }
  }

  private async queryAssets(pattern: string): Promise<AssetInfoLike[]> {
    try {
      const r = await this.message.request('asset-db', 'query-assets', { pattern });
      return Array.isArray(r) ? (r as AssetInfoLike[]) : [];
    } catch {
      return [];
    }
  }

  /** sprite 解压目录里至少要有一张 png，否则视为导入失败。 */
  private async assertPngInside(dirUrl: string): Promise<void> {
    const assets = await this.queryAssets(`${dirUrl}/**`);
    const hasPng = assets.some((a) => typeof a.url === 'string' && /\.png$/i.test(a.url));
    if (!hasPng) throw new BridgeError('IMPORT_FAILED', `精灵目录内未找到 png：${dirUrl}`);
  }

  /** 在 glb 的子资产里找 gltf 场景 prefab；先看 asset info 自带的 subAssets，再退到 query-assets。 */
  private async findPrefabUuid(dbUrl: string, info: AssetInfoLike): Promise<string | null> {
    const isPrefab = (a: AssetInfoLike) => a.importer === 'gltf-scene' || a.type === 'cc.Prefab';
    const fromInfo = Object.values(info.subAssets ?? {}).find(isPrefab);
    if (fromInfo?.uuid) return fromInfo.uuid;
    const scanned = await this.queryAssets(`${dbUrl}/**`);
    return scanned.find(isPrefab)?.uuid ?? null;
  }

  /** 把 prefab 挂到当前场景根节点并尽力选中；场景未打开或找不到 prefab 时跳过，返回 null。 */
  private async instantiateModel(dbUrl: string, info: AssetInfoLike, meta: ImportMeta): Promise<string | null> {
    const prefabUuid = await this.findPrefabUuid(dbUrl, info);
    if (!prefabUuid) {
      this.log(`未在 ${dbUrl} 的子资产里找到 prefab，跳过实例化`);
      return null;
    }
    const tree = (await this.message.request('scene', 'query-node-tree')) as { uuid?: string } | null;
    const rootUuid = tree?.uuid;
    if (!rootUuid) {
      this.log('当前没有打开的场景，跳过实例化');
      return null;
    }
    const name = meta.displayName?.trim() || meta.fileName.replace(/\.[^.]+$/, '');
    const created = await this.message.request('scene', 'create-node', {
      parent: rootUuid,
      assetUuid: prefabUuid,
      name,
      position: { x: 0, y: 0, z: 0 },
      snapshot: true,
      unlinkPrefab: false,
    });
    await this.trySelect(created);
    return name;
  }

  /**
   * 尽力选中新节点。3.8 系列里选中消息名不同版本有出入（set-selection / select-node），
   * 实现时以 Developer → Message Manager 里 scene 的实际消息名为准；失败不影响导入结果。
   */
  private async trySelect(created: unknown): Promise<void> {
    const uuid = typeof created === 'string' ? created : Array.isArray(created) ? created[0] : null;
    if (typeof uuid !== 'string') return;
    for (const msg of ['set-selection', 'select-node'] as const) {
      try {
        await this.message.request('scene', msg, uuid);
        return;
      } catch {
        /* 换下一个消息名 */
      }
    }
  }
}

/** 把 `\` 统一成 `/` 并去掉尾部斜杠。 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
