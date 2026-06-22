import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // src 运行时单测 + build 构建期工具（作用域插件纯逻辑）单测。
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
  },
});
