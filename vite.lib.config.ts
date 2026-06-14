import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

/**
 * 库模式构建（产物 = 唯一发布物 dist/）：把 src/index.ts 打成单一 ESM bundle + 单一 style.css。
 *
 * 决策（见 spec buildConfig）：
 * - lib.entry = src/index.ts（公共入口 barrel），formats = ['es']（纯 ESM 库，与 package.json type:module 对齐）。
 * - external 重依赖：katex / harfbuzzjs / bidi-js 不打进库——运行时重、harfbuzzjs 的 wasm 走 import.meta.url
 *   相对路径（bundle 会破其解析），消费者从自己 node_modules 取。
 * - tailwind 插件保留：create-editor.ts `import '../styles/lib.css'` 带出 chrome 用到的 tailwind utility，
 *   插件按 src/** 实际用到的 class 编译进 style.css，使库样式自洽（消费者只需 import 'canvas-rich/style.css'）。
 * - cssCodeSplit:false + assetFileNames 固定 style.css：把 shell+utility 合并为单一 dist/style.css，对齐 exports './style.css'。
 * - es2022 目标：harfbuzzjs 内部 top-level await 需 es2022+。
 *
 * 产物：dist/index.js（bundle）、dist/style.css（外壳+chrome 样式）。d.ts 由 tsconfig.build.json 经 tsc --emitDeclarationOnly
 * 后补（npm run build 中 vite 先建并清 dist，tsc 后补 index.d.ts，tsc 默认不删非 ts 产物）。
 */
export default defineConfig({
  plugins: [tailwindcss()],
  // 库产物不含 public/fonts：HarfBuzz 的 Roboto/Noto 字体走运行时 /fonts/*.ttf（绝对路径，从消费者服务根取），
  // 提供责任在消费者（见 README「作为库使用」）；不进 dist 以免发布物臃肿 ~1.2MB。
  publicDir: false,
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['katex', 'harfbuzzjs', 'bidi-js'],
      output: { assetFileNames: 'style.css' },
    },
    cssCodeSplit: false,
    emptyOutDir: true,
  },
  esbuild: { target: 'es2022' },
  // harfbuzzjs 原样从 node_modules 加载，其 wasm 的相对路径(import.meta.url)才能正确解析。
  optimizeDeps: { exclude: ['harfbuzzjs'], esbuildOptions: { target: 'es2022' } },
});
