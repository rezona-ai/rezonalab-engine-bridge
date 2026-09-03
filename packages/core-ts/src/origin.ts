/** 默认允许的网页来源：三套 lab 环境。开发者可在插件面板追加 localhost 一类地址。 */
export const DEFAULT_ORIGIN_ALLOWLIST: readonly string[] = [
  'https://lab.rezona.ai',
  'https://lab-stage.rezona.ai',
  'https://lab-dev.rezona.ai',
];

/** 把 origin 规范化成 `scheme://host[:port]`（去掉默认端口与尾部斜杠，小写）；非法返回 null。 */
export function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin.toLowerCase();
}

/**
 * Origin 白名单校验：精确匹配 scheme + host + port。缺 Origin 头视为拒绝。
 * 浏览器保证页面脚本改不了 Origin 头，因此这是「恶意网页写用户工程」的唯一也是足够的闸。
 */
export function isAllowedOrigin(originHeader: string | undefined | null, allowlist: readonly string[]): boolean {
  if (!originHeader) return false;
  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;
  for (const allowed of allowlist) {
    const n = normalizeOrigin(allowed);
    if (n && n === origin) return true;
  }
  return false;
}
