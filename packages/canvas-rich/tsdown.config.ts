import { defineConfig } from 'tsdown';
import { tailwindCss } from './build/tailwind-plugin.ts';

/**
 * 库构建（产物 = 唯一发布物 dist/）：单条 `tsdown` 命令同时产出 JS + d.ts + CSS。
 *
 * - JS / d.ts：tsdown（Rolldown 驱动）把 src/index.ts 打成单一 ESM bundle 并生成 .d.ts。
 * - CSS：经 {@link tailwindCss} 插件在 buildEnd 编译 tailwind v4（@tailwindcss/node）+ 内容扫描
 *   （@tailwindcss/oxide）+ 作用域化到 `.canvas-rich`（lightningcss，零全局污染）+ 压缩，
 *   再 emitFile 出 dist/style.css（取代原先的 `@tailwindcss/cli` build:css 步骤）。
 *
 * 重依赖（katex / harfbuzzjs / bidi-js）由 tsdown 按 package.json 的 dependencies 自动外部化，不打进库。
 * 注：tsdown 加载本 TS 配置在 Node 20 无原生 TS 剥离时需可选 peer 依赖 `unrun`（已在 devDependencies）。
 */
export default defineConfig({
  entry: 'src/index.ts',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  // JS 压缩：保持开（库面小，external 重依赖后 treeshake 主要裁本库未用导出）。
  minify: true,
  // 显式声明 treeshake 意图（tsdown 默认开）。
  treeshake: true,
  // 库产物默认不发 sourcemap：dist 是唯一发布物，体积优先；重依赖已 external，栈可读性损失小。
  // 需调试时临时改 true（.js.map 不入 files 白名单即不发布）。
  sourcemap: false,
  // 构建前清 outDir（在 buildStart；CSS 的 emitFile 在 buildEnd，于 clean 之后，不被清）。
  clean: true,
  outDir: 'dist',
  // 产物体积报告（JS bundle + emit 的 style.css，gzip/raw），CI 可见体积回归。
  report: true,
  // CSS 经此插件 emitFile dist/style.css，JS/d.ts 由 tsdown 主流程打。
  plugins: [tailwindCss()],
});
