import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * 示例站点配置（dev / preview / build:demo）：Vite root 指向 examples/——
 * 示例只是库的「调用方」，`examples/index.html` 是 dev 入口（仅 #app + 引 main.ts），
 * `examples/main.ts` `import { createEditor } from '../src'` 直接吃库源码（热更）。
 *
 * 库构建走另一份 vite.lib.config.ts（build.lib，external 重依赖）。
 * harfbuzzjs 内部使用 top-level await 初始化 wasm，需要 es2022+ 目标。
 */
export default defineConfig({
  root: 'examples',
  // HarfBuzz 字体走 /fonts/*.ttf（绝对路径）；root=examples 后默认 publicDir 会指向 examples/public，
  // 故显式指回仓库根 public/（Roboto/Noto 字体所在），保证 dev 与 build:demo 都能取到字体。
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  plugins: [tailwindcss()],
  build: {
    // 示例站点产物（build:demo）：相对 root=examples 解析，落到仓库根的 dist-demo/。
    outDir: fileURLToPath(new URL('./dist-demo', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  esbuild: { target: 'es2022' },
  // 排除预打包：让 harfbuzzjs 原样从 node_modules 加载，其 wasm 的相对路径(import.meta.url)才能正确解析
  optimizeDeps: { exclude: ['harfbuzzjs'], esbuildOptions: { target: 'es2022' } },
});
