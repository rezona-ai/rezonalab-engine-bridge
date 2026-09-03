import { describe, expect, it, vi } from 'vitest';
import { BridgeError } from '@rezonalab/engine-bridge-core';
import { CocosAdapter, type EditorMessageBus } from '../source/adapter';

const ASSETS_ROOT = '/proj/assets';

/** 虚拟时钟：sleep 只推进 now，不真等。 */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

type Call = { pkg: string; msg: string; args: unknown[] };

/** 可编程的假 Editor.Message：按 (pkg, msg) 派发到 handler，并记录调用。 */
function makeBus(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Call[] = [];
  const bus: EditorMessageBus = {
    async request(pkg: string, msg: string, ...args: unknown[]) {
      calls.push({ pkg, msg, args });
      const h = handlers[`${pkg}/${msg}`];
      if (!h) throw new Error(`unhandled ${pkg}/${msg}`);
      return h(...args);
    },
  };
  return { bus, calls };
}

const readyInfo = (uuid: string, extra: Record<string, unknown> = {}) => ({ uuid, importer: 'image', ...extra });

describe('CocosAdapter.dbUrl', () => {
  it('普通文件：db://assets/ + 相对 assetsRoot 的路径', () => {
    const a = new CocosAdapter(ASSETS_ROOT, { message: makeBus({}).bus, ...makeClock() });
    expect(a.toDbUrl('/proj/assets/RezonaAssets/hero.glb')).toBe('db://assets/RezonaAssets/hero.glb');
  });

  it('嵌套 sprite 目录也能算出 db 地址', () => {
    const a = new CocosAdapter(ASSETS_ROOT, { message: makeBus({}).bus, ...makeClock() });
    expect(a.toDbUrl('/proj/assets/RezonaAssets/walk-cycle')).toBe('db://assets/RezonaAssets/walk-cycle');
  });

  it('Windows 风格分隔符归一为 /', () => {
    const a = new CocosAdapter('C:\\proj\\assets', { message: makeBus({}).bus, ...makeClock() });
    expect(a.toDbUrl('C:\\proj\\assets\\RezonaAssets\\hero.glb')).toBe('db://assets/RezonaAssets/hero.glb');
  });
});

describe('CocosAdapter.importFile 轮询', () => {
  it('先 refresh RezonaAssets，再轮询 query-asset-info 直到 uuid + importer 就绪', async () => {
    let tick = 0;
    const { bus, calls } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => (++tick >= 3 ? readyInfo('u-1') : null),
    });
    const clock = makeClock();
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...clock });
    const out = await a.importFile('/proj/assets/RezonaAssets/hero.png', { kind: 'image', fileName: 'hero.png', transferId: 't1' });
    expect(out).toEqual({ savedPath: 'db://assets/RezonaAssets/hero.png' });
    expect(calls[0]).toMatchObject({ pkg: 'asset-db', msg: 'refresh-asset', args: ['db://assets/RezonaAssets'] });
    expect(calls.filter((c) => c.msg === 'query-asset-info')).toHaveLength(3);
    expect(clock.now()).toBe(1000); // 两次 500 ms 等待
  });

  it('importer 为空视为未就绪', async () => {
    let tick = 0;
    const { bus } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => (++tick >= 2 ? readyInfo('u-1') : { uuid: 'u-1', importer: '' }),
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    await expect(a.importFile('/proj/assets/RezonaAssets/a.mp3', { kind: 'audio', fileName: 'a.mp3', transferId: 't' })).resolves.toBeTruthy();
    expect(tick).toBe(2);
  });

  it('15 秒内未就绪抛 IMPORT_TIMEOUT', async () => {
    const { bus, calls } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => null,
    });
    const clock = makeClock();
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...clock });
    const p = a.importFile('/proj/assets/RezonaAssets/hero.png', { kind: 'image', fileName: 'hero.png', transferId: 't' });
    await expect(p).rejects.toBeInstanceOf(BridgeError);
    await expect(p).rejects.toMatchObject({ code: 'IMPORT_TIMEOUT' });
    expect(clock.now()).toBeGreaterThanOrEqual(15000);
    expect(calls.filter((c) => c.msg === 'query-asset-info').length).toBeGreaterThanOrEqual(30);
  });

  it('sprite：刷新解压目录并确认目录内有 png', async () => {
    const { bus, calls } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({ uuid: 'dir-1', importer: 'directory', isDirectory: true }),
      'asset-db/query-assets': () => [{ uuid: 'p1', url: 'db://assets/RezonaAssets/walk/0.png', importer: 'image' }],
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    const out = await a.importFile('/proj/assets/RezonaAssets/walk', { kind: 'sprite', fileName: 'walk', transferId: 't' });
    expect(out.savedPath).toBe('db://assets/RezonaAssets/walk');
    expect(calls.some((c) => c.msg === 'refresh-asset' && c.args[0] === 'db://assets/RezonaAssets/walk')).toBe(true);
  });

  it('sprite 目录内没有 png 抛 IMPORT_FAILED', async () => {
    const { bus } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({ uuid: 'dir-1', importer: 'directory' }),
      'asset-db/query-assets': () => [],
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    await expect(a.importFile('/proj/assets/RezonaAssets/walk', { kind: 'sprite', fileName: 'walk', transferId: 't' })).rejects.toMatchObject({ code: 'IMPORT_FAILED' });
  });
});

describe('CocosAdapter.importFile model3d 实例化', () => {
  const glb = '/proj/assets/RezonaAssets/hero.glb';
  const meta = { kind: 'model3d' as const, fileName: 'hero.glb', displayName: 'Hero', transferId: 't' };

  it('找到 gltf prefab 子资产，挂到场景根节点并尝试选中', async () => {
    const createNode = vi.fn(() => 'node-1');
    const select = vi.fn(() => null);
    const { bus, calls } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({
        uuid: 'glb-1',
        importer: 'gltf',
        subAssets: {
          'hero.prefab': { uuid: 'prefab-1', importer: 'gltf-scene', type: 'cc.Prefab' },
          'mesh-0': { uuid: 'mesh-1', importer: 'gltf-mesh', type: 'cc.Mesh' },
        },
      }),
      'scene/query-node-tree': () => ({ uuid: 'root-1', children: [] }),
      'scene/create-node': createNode,
      'scene/set-selection': select,
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    const out = await a.importFile(glb, meta);
    expect(out).toEqual({ savedPath: 'db://assets/RezonaAssets/hero.glb', sceneNode: 'Hero' });
    expect(createNode).toHaveBeenCalledWith(expect.objectContaining({ parent: 'root-1', assetUuid: 'prefab-1', name: 'Hero', unlinkPrefab: false }));
    expect(calls.some((c) => c.pkg === 'scene' && c.msg === 'set-selection')).toBe(true);
  });

  it('subAssets 里没有 prefab 时退到 query-assets 扫子资产', async () => {
    const createNode = vi.fn(() => 'node-1');
    const { bus } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({ uuid: 'glb-1', importer: 'gltf' }),
      'asset-db/query-assets': () => [{ uuid: 'prefab-9', type: 'cc.Prefab', importer: 'gltf-scene' }],
      'scene/query-node-tree': () => ({ uuid: 'root-1' }),
      'scene/create-node': createNode,
      'scene/set-selection': () => null,
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    await a.importFile(glb, meta);
    expect(createNode).toHaveBeenCalledWith(expect.objectContaining({ assetUuid: 'prefab-9' }));
  });

  it('场景未打开（query-node-tree 为 null）跳过实例化，sceneNode 为空', async () => {
    const createNode = vi.fn();
    const { bus } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({ uuid: 'glb-1', importer: 'gltf', subAssets: { p: { uuid: 'prefab-1', importer: 'gltf-scene' } } }),
      'scene/query-node-tree': () => null,
      'scene/create-node': createNode,
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    const out = await a.importFile(glb, meta);
    expect(out.sceneNode).toBeUndefined();
    expect(createNode).not.toHaveBeenCalled();
  });

  it('set-selection 失败被吞掉，导入仍算成功', async () => {
    const { bus } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({ uuid: 'glb-1', importer: 'gltf', subAssets: { p: { uuid: 'prefab-1', importer: 'gltf-scene' } } }),
      'scene/query-node-tree': () => ({ uuid: 'root-1' }),
      'scene/create-node': () => 'node-1',
      'scene/set-selection': () => {
        throw new Error('no such message');
      },
      'scene/select-node': () => {
        throw new Error('no such message');
      },
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    await expect(a.importFile(glb, meta)).resolves.toMatchObject({ sceneNode: 'Hero' });
  });

  it('没有 displayName 时节点名取文件名（去扩展名）', async () => {
    const createNode = vi.fn(() => 'n');
    const { bus } = makeBus({
      'asset-db/refresh-asset': () => null,
      'asset-db/query-asset-info': () => ({ uuid: 'glb-1', importer: 'gltf', subAssets: { p: { uuid: 'prefab-1', importer: 'gltf-scene' } } }),
      'scene/query-node-tree': () => ({ uuid: 'root-1' }),
      'scene/create-node': createNode,
      'scene/set-selection': () => null,
    });
    const a = new CocosAdapter(ASSETS_ROOT, { message: bus, ...makeClock() });
    const out = await a.importFile(glb, { kind: 'model3d', fileName: 'hero.glb', transferId: 't' });
    expect(out.sceneNode).toBe('hero');
    expect(createNode).toHaveBeenCalledWith(expect.objectContaining({ name: 'hero' }));
  });
});
