import { defineConfig } from 'vitest/config';

// 根级统一跑 core-ts 与 web-client 的测试；夹具一致性测试在 core-ts 内。
export default defineConfig({
  test: {
    include: ['packages/core-ts/test/**/*.test.ts', 'packages/web-client/test/**/*.test.ts', 'packages/cocos/test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
