/**
 * 浏览器能力与 Local Network Access（LNA）相关的小工具。
 * Chrome 142 起访问 127.0.0.1 会弹「连接本地网络设备」权限；被拒后 WebSocket 只会瞬间 error，网页拿不到原因，
 * 所以这里只能做「疑似」判断与首次说明的记忆。
 */

export const LNA_EXPLAINED_KEY = 'rezona-bridge:lna-explained';

/** Chrome / Edge / 其它 Chromium 皮肤都带 `Chrome/<major>`；Chromium 原生构建带 `Chromium/`。 */
export function isChromium142Plus(userAgent: string): boolean {
  const m = /\bChrom(?:e|ium)\/(\d+)/.exec(userAgent);
  return m !== null && Number(m[1]) >= 142;
}

/** 真 Safari：有 `Safari/` 又不是任何 Chromium 皮肤 / Android WebView / iOS 上的 Chrome、Firefox。 */
export function isSafari(userAgent: string): boolean {
  return /\bSafari\//.test(userAgent) && !/\b(?:Chrom(?:e|ium)|Edg|OPR|CriOS|FxiOS|Android)\b/.test(userAgent);
}

export interface BrowserEnv {
  userAgent: string;
  hasWebSocket: boolean;
}

function currentEnv(): BrowserEnv {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return { userAgent: nav?.userAgent ?? '', hasWebSocket: typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined' };
}

/** 没有 WebSocket 或是 Safari（不支持 LNA 且回环连接策略不同）→ 顶栏整块禁用。 */
export function supportsBridge(env: BrowserEnv = currentEnv()): 'ok' | 'UNSUPPORTED_BROWSER' {
  if (!env.hasWebSocket) return 'UNSUPPORTED_BROWSER';
  if (isSafari(env.userAgent)) return 'UNSUPPORTED_BROWSER';
  return 'ok';
}

/** 只需要 localStorage 的两个方法，便于测试注入。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | undefined {
  return (globalThis as { localStorage?: StorageLike }).localStorage;
}

/** 隐私模式 / 禁用站点数据时 localStorage 访问会抛：一律吞掉，当作没看过。 */
export function hasSeenLnaExplainer(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(LNA_EXPLAINED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markLnaExplained(storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(LNA_EXPLAINED_KEY, '1');
  } catch {
    /* 存不了就下次再说明一遍，无害 */
  }
}

/** 疑似被拒时给 game-web 的文案键；文案本体在 game-web 的 i18n 里。 */
export function explainLnaDenied(): 'LNA_DENIED' {
  return 'LNA_DENIED';
}
