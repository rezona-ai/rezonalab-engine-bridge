/**
 * 插件默认放行的网页来源，**与 `packages/core-ts/src/origin.ts` 同源**。
 *
 * 这里为什么要抄一份：本包刻意零运行时依赖、只跑在浏览器里，不引 core-ts（那边带 ws / yauzl 等 node 依赖）。
 * 抄一份的代价是会漂，所以 core-ts 的测试同时校验这份与 Unity 那份，三处必须逐字一致。
 *
 * 网页需要知道这份名单，是为了在插件回 `ORIGIN_REJECTED` 时能说清「你当前这个站点不在里面」，
 * 也为了让部署侧能断言「开了开关的环境，其域名确实在名单里」——2026-09-09 生产域从
 * lab.rezona.ai 迁到 rezona.ai 后差点因为漏了这条而让功能对所有人静默失效。
 */
export const DEFAULT_ORIGIN_ALLOWLIST: readonly string[] = [
  'https://rezona.ai',
  'https://lab.rezona.ai',
  'https://stalab.rezona.ai',
  'https://devlab.rezona.ai',
];
