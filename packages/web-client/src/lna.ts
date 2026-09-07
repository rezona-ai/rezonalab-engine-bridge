/**
 * 浏览器能力与 Local Network Access（LNA）相关的小工具。
 * Chrome 142 起访问 127.0.0.1 会弹「连接本地网络设备」权限；被拒后 WebSocket 只会瞬间 error，网页拿不到原因，
 * 所以这里只能做「疑似」判断与首次说明的记忆。
 */

export const LNA_EXPLAINED_KEY = 'rezona-bridge:lna-explained';

/** Chrome 142+ 把本地网络访问做成了正式权限，可以直接问，不必靠时序猜。拿不到就是 `unknown`。 */
export type LnaPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Permissions API 的权限名（Chrome 142+）。 */
export const LNA_PERMISSION_NAME = 'local-network-access';

/**
 * 查当前站点的「本地网络访问」权限。
 *
 * 为什么需要它：被拒和「引擎没开」在回环上的时序**完全一样**（都是几毫秒内 error），
 * 靠「全部快速失败」区分不开，只会给用户错误的排查方向（2026-09-07 实发：明明插件在监听，
 * 却被告知「未找到编辑器」）。这个 API 能直接给出 denied，所以有它就不猜。
 */
export async function queryLnaPermission(): Promise<LnaPermission> {
  const nav = (globalThis as { navigator?: { permissions?: { query(d: { name: string }): Promise<{ state: string }> } } }).navigator;
  const permissions = nav?.permissions;
  if (!permissions?.query) return 'unknown';
  try {
    const status = await permissions.query({ name: LNA_PERMISSION_NAME });
    return status.state === 'granted' || status.state === 'prompt' || status.state === 'denied' ? status.state : 'unknown';
  } catch {
    // 不认这个权限名的浏览器会抛 TypeError —— 说明它根本没有 LNA 这套机制，等同于「无从判断」。
    return 'unknown';
  }
}

/**
 * Chrome / Edge / 其它 Chromium 皮肤都带 `Chrome/<major>`；Chromium 原生构建带 `Chromium/`。
 * 前面不加 \b：无头 Chrome 的 UA 是 `HeadlessChrome/<major>`，加了词边界就认不出来（Playwright 端到端里实测把它判成了 Safari）。
 */
export function isChromium142Plus(userAgent: string): boolean {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(userAgent);
  return m !== null && Number(m[1]) >= 142;
}

/** 真 Safari：有 `Safari/` 又不是任何 Chromium 皮肤 / Android WebView / iOS 上的 Chrome、Firefox。 */
export function isSafari(userAgent: string): boolean {
  return /\bSafari\//.test(userAgent) && !/(?:Chrom(?:e|ium)|Edg|OPR|CriOS|FxiOS|Android)\b/.test(userAgent);
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
