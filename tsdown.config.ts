import { defineConfig } from 'tsdown';

/**
 * 库构建（产物 = 唯一发布物 dist/）：tsdown（Rolldown 驱动）把 src/index.ts 打成单一 ESM bundle
 * 并生成 .d.ts。CSS 不经此处——tailwind 样式由 @tailwindcss/cli 单独编出 dist/style.css（见 package.json build）。
 *
 * 重依赖（katex / harfbuzzjs / bidi-js）由 tsdown 按 package.json 的 dependencies 自动外部化，不打进库。
 * 注：tsdown 加载本 TS 配置需可选 peer 依赖 `unrun`（Node 20 无原生 TS 剥离时的转译器），已加入 devDependencies。
 */
export default defineConfig({
  entry: 'src/index.ts',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  minify: true,
  outDir: 'dist',
  clean: true,
});
