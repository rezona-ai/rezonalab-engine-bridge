/**
 * 极简 semver 比较：只看 `major.minor.patch` 三段数字，忽略预发布与构建后缀。
 * 用途只有一个——判断插件版本是否低于网页要求的最低版本，不值得引依赖。
 */
function parse(v: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?\s*$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** 返回负数 / 0 / 正数；任一侧不可解析时视为相等以外的「更小」，由调用方决定语义。 */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** `actual` 无法解析时返回 false：宁可让用户升级插件，也不要放一个看不懂版本号的插件进来。 */
export function isVersionAtLeast(actual: string, min: string): boolean {
  if (!parse(actual)) return false;
  return compareSemver(actual, min) >= 0;
}
