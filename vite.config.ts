import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// harfbuzzjs 内部使用 top-level await 初始化 wasm，需要 es2022+ 目标。
export default defineConfig({
  plugins: [tailwindcss()],
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  // 排除预打包：让 harfbuzzjs 原样从 node_modules 加载，其 wasm 的相对路径(import.meta.url)才能正确解析
  optimizeDeps: { exclude: ['harfbuzzjs'], esbuildOptions: { target: 'es2022' } },
});
