import { describe, it, expect } from 'vitest';
import { isSafeCssColor, isSafeFontFamily, isSafeSpanStyleValue } from '../mark-html';
import { toHtml, toMarkdown, inlinesToCellHtml } from '../export';
import { Doc, para, text } from '../schema';

// style 类 mark 值白名单：escAttr 只挡标签/属性逃逸，不中和 CSS 元字符（; : ( )）。
// 程序化注入的裸值（'x;position:fixed' 等）在导出端必须整体跳过该层 span style。

describe('isSafeCssColor 白名单', () => {
  it('接受 #hex（3/4/6/8 位）/ rgb()/rgba() / 具名色', () => {
    for (const v of [
      '#f00',
      '#f00a',
      '#ff0000',
      '#ff000080',
      'rgb(31, 36, 48)',
      'rgba(1,2,3,.5)',
      'rgb(1 2 3)',
      'rgb(1 2 3 / 50%)',
      'red',
      'transparent',
      'currentcolor',
    ]) {
      expect(isSafeCssColor(v), v).toBe(true);
    }
  });
  it('拒绝 CSS 注入与畸形值', () => {
    for (const v of [
      'x;position:fixed',
      '#ff0000;inset:0',
      'rgb(1,2,3);background:url(http://evil)',
      'url(http://evil/leak)',
      'expression(alert(1))',
      'var(--x)',
      'javascript:alert(1)',
      '#ff00zz',
      '',
      'rgb(',
      'red green blue extra words here exceed',
    ]) {
      expect(isSafeCssColor(v), v).toBe(false);
    }
  });
});

describe('isSafeFontFamily 安全字符集', () => {
  it('接受常规族名（含引号串/逗号回退链/CJK 字体名）', () => {
    for (const v of [
      'Georgia',
      'serif',
      'monospace',
      '"Microsoft YaHei", sans-serif',
      "'PingFang SC', sans-serif",
      '微软雅黑',
      'Noto Sans CJK SC',
      'Segoe UI-Variable',
    ]) {
      expect(isSafeFontFamily(v), v).toBe(true);
    }
  });
  it('拒绝含 CSS 元字符（; : ( )）的注入值与空串', () => {
    for (const v of [
      'Arial;position:fixed;inset:0;background:url(http://evil/leak)',
      'x;color:red',
      'a:b',
      'fn(1)',
      'url(http://e)',
      '',
    ]) {
      expect(isSafeFontFamily(v), v).toBe(false);
    }
  });
});

describe('isSafeSpanStyleValue 按 mark 分流', () => {
  it('fontSize 限裸数值；highlight 同 color；非 style 类 mark 恒 false', () => {
    expect(isSafeSpanStyleValue('fontSize', '24')).toBe(true);
    expect(isSafeSpanStyleValue('fontSize', '13.5')).toBe(true);
    expect(isSafeSpanStyleValue('fontSize', '12px')).toBe(false);
    expect(isSafeSpanStyleValue('fontSize', '12;position:fixed')).toBe(false);
    expect(isSafeSpanStyleValue('highlight', '#ffff00')).toBe(true);
    expect(isSafeSpanStyleValue('highlight', 'x;y:z')).toBe(false);
    expect(isSafeSpanStyleValue('bold', 'whatever')).toBe(false);
  });
});

describe('导出端：非法值跳过该层 span style（不产输出）', () => {
  const docWith = (mark: 'color' | 'fontFamily' | 'fontSize', attrs: Record<string, string>): Doc => ({
    blocks: [para([text('x', [{ type: mark, attrs }])])],
  });

  it('toHtml：注入 color "x;position:fixed" 不产 style；合法值照常输出', () => {
    const bad = toHtml(docWith('color', { color: 'x;position:fixed;inset:0' }));
    expect(bad).not.toContain('style=');
    expect(bad).not.toContain('position:fixed');
    expect(bad).toContain('x'); // 文本本体保留
    const good = toHtml(docWith('color', { color: '#ff0000' }));
    expect(good).toContain('<span style="color:#ff0000">x</span>');
  });

  it('toHtml：注入 fontFamily / fontSize 同样跳过', () => {
    const f = toHtml(docWith('fontFamily', { fontFamily: 'Arial;position:fixed' }));
    expect(f).not.toContain('style=');
    const s = toHtml(docWith('fontSize', { size: '12px;position:fixed' }));
    expect(s).not.toContain('style=');
    expect(toHtml(docWith('fontFamily', { fontFamily: 'Georgia' }))).toContain('font-family:Georgia');
    expect(toHtml(docWith('fontSize', { size: '24' }))).toContain('font-size:24px');
  });

  it('toMarkdown：span style 回退层同样过滤（MD 端拼接未经 escAttr，必须白名单）', () => {
    const bad = toMarkdown(docWith('color', { color: 'red;background:url(http://evil)' }));
    expect(bad).not.toContain('<span');
    expect(toMarkdown(docWith('color', { color: 'red' }))).toContain('<span style="color:red">');
    const badF = toMarkdown(docWith('fontFamily', { fontFamily: 'a;b:c' }));
    expect(badF).not.toContain('<span');
  });

  it('inlinesToCellHtml（单元格 innerHTML 注入面）：非法值不产 style', () => {
    const bad = inlinesToCellHtml([text('x', [{ type: 'fontFamily', attrs: { fontFamily: 'Arial;position:fixed' } }])]);
    expect(bad).toBe('x');
    const good = inlinesToCellHtml([text('x', [{ type: 'color', attrs: { color: '#ff0000' } }])]);
    expect(good).toBe('<span style="color:#ff0000">x</span>');
  });
});
