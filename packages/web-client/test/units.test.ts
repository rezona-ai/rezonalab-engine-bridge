import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLIENT_VERSION, ENGINES, getEngine } from '../src/engines.js';
import { compareSemver, isVersionAtLeast } from '../src/semver.js';
import { sha256Hex } from '../src/sha256.js';
import { LNA_EXPLAINED_KEY, LNA_PERMISSION_NAME, explainLnaDenied, hasSeenLnaExplainer, isChromium142Plus, isSafari, markLnaExplained, queryLnaPermission, supportsBridge } from '../src/lna.js';

const HEADLESS_147 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36';
const CHROME_141 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHROME_142 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36';
const EDGE_143 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0';

describe('engines registry', () => {
  it('lists five engines with the fixed port ranges; only cocos and unity are supported', () => {
    expect(ENGINES.map((e) => e.key)).toEqual(['cocos', 'unity', 'godot', 'unreal', 'blender']);
    expect(getEngine('cocos')).toMatchObject({ portRange: [41700, 41719], supported: true, pluginVersion: CLIENT_VERSION, minPluginVersion: '0.1.0' });
    expect(getEngine('unity')).toMatchObject({ portRange: [41720, 41739], supported: true });
    expect(getEngine('godot')).toMatchObject({ portRange: [41740, 41759], supported: false });
    expect(getEngine('unreal')).toMatchObject({ portRange: [41760, 41779], supported: false });
    expect(getEngine('blender')).toMatchObject({ portRange: [41780, 41799], supported: false });
    expect(getEngine('cocos').installDocUrl).toBe('https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs/install-cocos.md');
    expect(getEngine('unity').installDocUrl).toBe('https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs/install-unity.md');
  });

  it('every supported engine installs from a downloadable release asset named for the current version', () => {
    // 两个引擎都必须是可下载物。Unity 曾经给的是 UPM git 地址,面板上那颗「安装」按钮点下去
    // 只是复制一段文本,与字面承诺不符;而且 UPM 解析 git 依赖要求本机装了 git。
    // 这条同时钉住文件名:名字对不上就下到一个 404,而 404 在按钮上是看不出来的。
    const base = `https://github.com/rezona-ai/rezonalab-engine-bridge/releases/download/v${CLIENT_VERSION}`;
    expect(getEngine('cocos').install).toEqual({ kind: 'download', fileName: `rezona-bridge-cocos-${CLIENT_VERSION}.zip`, url: `${base}/rezona-bridge-cocos-${CLIENT_VERSION}.zip` });
    expect(getEngine('unity').install).toEqual({ kind: 'download', fileName: `rezona-bridge-unity-${CLIENT_VERSION}.tgz`, url: `${base}/rezona-bridge-unity-${CLIENT_VERSION}.tgz` });
    // UPM 的文件选择框只认 .tgz 后缀,换成 .tar.gz 会在对话框里根本选不中
    expect(getEngine('unity').install?.fileName.endsWith('.tgz')).toBe(true);
    for (const e of ENGINES.filter((x) => !x.supported)) expect(e.install).toBeUndefined();
  });
});

describe('semver compare', () => {
  it('orders numerically per segment and ignores prerelease / build suffixes', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.1.0', '0.1.1')).toBeLessThan(0);
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.3-beta.1+build', '1.2.3')).toBe(0);
    expect(isVersionAtLeast('0.1.0', '0.1.0')).toBe(true);
    expect(isVersionAtLeast('0.0.9', '0.1.0')).toBe(false);
    expect(isVersionAtLeast('garbage', '0.1.0')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches node createHash for empty and non-empty buffers', async () => {
    const empty = new ArrayBuffer(0);
    expect(await sha256Hex(empty)).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
    const data = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
    expect(await sha256Hex(data.buffer)).toBe(createHash('sha256').update(data).digest('hex'));
  });
});

describe('lna helpers', () => {
  it('detects Chromium 142+ (including Edge) and Safari', () => {
    expect(isChromium142Plus(CHROME_141)).toBe(false);
    expect(isChromium142Plus(CHROME_142)).toBe(true);
    expect(isChromium142Plus(EDGE_143)).toBe(true);
    expect(isChromium142Plus(SAFARI)).toBe(false);
    expect(isChromium142Plus(FIREFOX)).toBe(false);
    expect(isSafari(SAFARI)).toBe(true);
    expect(isSafari(CHROME_142)).toBe(false);
    expect(isSafari(EDGE_143)).toBe(false);
    expect(isSafari(FIREFOX)).toBe(false);
    // 无头 Chrome（自动化 / 端到端）不是 Safari，也算 142+
    expect(isSafari(HEADLESS_147)).toBe(false);
    expect(isChromium142Plus(HEADLESS_147)).toBe(true);
  });

  it('supportsBridge rejects Safari and a missing WebSocket global', () => {
    expect(supportsBridge({ userAgent: CHROME_142, hasWebSocket: true })).toBe('ok');
    expect(supportsBridge({ userAgent: FIREFOX, hasWebSocket: true })).toBe('ok');
    expect(supportsBridge({ userAgent: SAFARI, hasWebSocket: true })).toBe('UNSUPPORTED_BROWSER');
    expect(supportsBridge({ userAgent: CHROME_142, hasWebSocket: false })).toBe('UNSUPPORTED_BROWSER');
  });

  it('explainer flag survives a missing localStorage and round-trips through a fake one', () => {
    expect(explainLnaDenied()).toBe('LNA_DENIED');
    expect(LNA_EXPLAINED_KEY).toBe('rezona-bridge:lna-explained');
    // Node 没有 localStorage：两个函数都不许抛。
    expect(hasSeenLnaExplainer()).toBe(false);
    expect(() => markLnaExplained()).not.toThrow();
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(hasSeenLnaExplainer(fake)).toBe(false);
    markLnaExplained(fake);
    expect(hasSeenLnaExplainer(fake)).toBe(true);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(hasSeenLnaExplainer(throwing)).toBe(false);
    expect(() => markLnaExplained(throwing)).not.toThrow();
  });
});

describe('queryLnaPermission', () => {
  const withNavigator = async (permissions: unknown) => {
    const g = globalThis as { navigator?: unknown };
    const had = 'navigator' in g; const prev = g.navigator;
    Object.defineProperty(g, 'navigator', { value: { permissions }, configurable: true, writable: true });
    try { return await queryLnaPermission(); } finally {
      if (had) Object.defineProperty(g, 'navigator', { value: prev, configurable: true, writable: true });
      else delete (g as Record<string, unknown>).navigator;
    }
  };

  it('reports the browser state and degrades to unknown when it cannot ask', async () => {
    expect(await withNavigator({ query: async ({ name }: { name: string }) => { expect(name).toBe(LNA_PERMISSION_NAME); return { state: 'denied' }; } })).toBe('denied');
    expect(await withNavigator({ query: async () => ({ state: 'prompt' }) })).toBe('prompt');
    expect(await withNavigator({ query: async () => ({ state: 'granted' }) })).toBe('granted');
    // 不认这个权限名的浏览器会抛；没有 permissions 的更早一步就没法问 —— 都算 unknown，交给时序启发式
    expect(await withNavigator({ query: async () => { throw new TypeError('unknown permission'); } })).toBe('unknown');
    expect(await withNavigator(undefined)).toBe('unknown');
    // 认得 API 但回了个没见过的状态，同样不敢当结论用
    expect(await withNavigator({ query: async () => ({ state: 'weird' }) })).toBe('unknown');
  });
});

