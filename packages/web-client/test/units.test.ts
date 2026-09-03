import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ENGINES, getEngine } from '../src/engines.js';
import { compareSemver, isVersionAtLeast } from '../src/semver.js';
import { sha256Hex } from '../src/sha256.js';
import { LNA_EXPLAINED_KEY, explainLnaDenied, hasSeenLnaExplainer, isChromium142Plus, isSafari, markLnaExplained, supportsBridge } from '../src/lna.js';

const CHROME_141 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHROME_142 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36';
const EDGE_143 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0';

describe('engines registry', () => {
  it('lists five engines with the fixed port ranges; only cocos and unity are supported', () => {
    expect(ENGINES.map((e) => e.key)).toEqual(['cocos', 'unity', 'godot', 'unreal', 'blender']);
    expect(getEngine('cocos')).toMatchObject({ portRange: [41700, 41719], supported: true, pluginVersion: '0.1.0', minPluginVersion: '0.1.0' });
    expect(getEngine('unity')).toMatchObject({ portRange: [41720, 41739], supported: true });
    expect(getEngine('godot')).toMatchObject({ portRange: [41740, 41759], supported: false });
    expect(getEngine('unreal')).toMatchObject({ portRange: [41760, 41779], supported: false });
    expect(getEngine('blender')).toMatchObject({ portRange: [41780, 41799], supported: false });
    expect(getEngine('cocos').installDocUrl).toBe('https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs/install-cocos.md');
    expect(getEngine('unity').installDocUrl).toBe('https://github.com/rezona-ai/rezonalab-engine-bridge/blob/main/docs/install-unity.md');
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
