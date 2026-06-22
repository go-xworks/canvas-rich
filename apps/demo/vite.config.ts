import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const libraryRoot = fileURLToPath(new URL('../../packages/canvas-rich/', import.meta.url));

export default defineConfig({
  base: process.env.DEMO_BASE_PATH ?? './',
  plugins: [tailwindcss()],
  publicDir: fileURLToPath(new URL('../../packages/canvas-rich/public', import.meta.url)),
  resolve: {
    alias: {
      'canvas-rich/style.css': fileURLToPath(new URL('../../packages/canvas-rich/src/styles/lib.css', import.meta.url)),
      'canvas-rich': fileURLToPath(new URL('../../packages/canvas-rich/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../../dist-pages/demo', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  esbuild: { target: 'es2022' },
  optimizeDeps: { exclude: ['harfbuzzjs'], esbuildOptions: { target: 'es2022' } },
  server: { fs: { allow: [libraryRoot] } },
});
