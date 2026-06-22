import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildScopedCss } from '../tailwind-plugin.ts';

// buildScopedCss 端到端单测（node 环境，兑现 TSDoc「便于复用/测试」承诺）：给一个 tmp 入口 CSS，
// 跑完整链路（@tailwindcss/node compile → @tailwindcss/oxide scan → build → scopeCss 作用域化 + 压缩），
// 断言产物作用域化到 .canvas-rich 且已压缩。用自洽内联规则（不依赖 tailwind @import / 内容扫描结果），
// 故无网络、无项目 cwd 耦合，稳定可测。

/** 在 tmp 目录写一个入口 CSS，跑 buildScopedCss，跑完即清理。 */
async function build(css: string, minify: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'build-scoped-css-'));
  try {
    const entry = join(dir, 'lib.css');
    writeFileSync(entry, css);
    return await buildScopedCss(entry, dir, 'canvas-rich', minify);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('buildScopedCss（端到端）', () => {
  it('产物作用域化到 .canvas-rich（普通规则前置后代组合，:root 映射为 .canvas-rich）', async () => {
    const out = await build('.rte-shell{display:flex;gap:4px}:root{--rte-x:1}', true);
    expect(out).toContain('.canvas-rich .rte-shell{');
    expect(out).toContain('.canvas-rich{--rte-x:1}');
    // 不应残留裸 :root 或裸 .rte-shell{（前面不是 .canvas-rich 空格）
    expect(out).not.toContain(':root');
    expect(out).not.toMatch(/[^ ]\.rte-shell\{/);
  });

  it('minify:true 压缩产物（去注释/多余空白）', async () => {
    const out = await build('/* c */\n.rte-shell {\n  display : flex ;\n}\n', true);
    expect(out).toContain('.canvas-rich .rte-shell{display:flex}');
    expect(out).not.toContain('/* c */');
    expect(out).not.toContain('\n');
  });

  it('minify:false 保留可读格式但仍作用域化', async () => {
    const out = await build('.rte-shell{display:flex}', false);
    expect(out).toContain('.canvas-rich .rte-shell');
    expect(out).toContain('\n');
  });
});
