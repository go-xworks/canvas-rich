import { describe, it, expect } from 'vitest';
import {
  StyleResolver,
  resolveFontFamily,
  FONT_FAMILY_STACKS,
  SUBSUP_SCALE,
  SUPERSCRIPT_SHIFT,
  SUBSCRIPT_SHIFT,
} from '../style-resolver';
import { block, para, Mark } from '../schema';
import { FONT_UI } from '../palette';

// 样式解析：验证行内 mark 在块基样式之上的叠加，重点是
// fontFamily/fontSize 的「mark > block > default」优先级与上/下标字号缩放。
const R = new StyleResolver();

describe('resolveRun: fontSize/fontFamily mark > block > default', () => {
  it('无 mark 时落在块默认字号（段落=19）', () => {
    const b = para([]);
    expect(R.resolveRun(b, []).style.fontSize).toBe(19);
  });

  it('fontSize 行内 mark 覆盖块默认字号', () => {
    const b = para([]);
    const marks: Mark[] = [{ type: 'fontSize', attrs: { size: '28' } }];
    expect(R.resolveRun(b, marks).style.fontSize).toBe(28);
  });

  it('fontSize mark 覆盖标题块的默认字号（H1 默认 32 → 14）', () => {
    const h1 = block('heading', [], { level: 1 });
    expect(R.resolveRun(h1, []).style.fontSize).toBe(32); // 块默认
    const marks: Mark[] = [{ type: 'fontSize', attrs: { size: '14' } }];
    expect(R.resolveRun(h1, marks).style.fontSize).toBe(14); // mark 覆盖
  });

  it('非法/非正字号被忽略，回退块默认', () => {
    const b = para([]);
    expect(R.resolveRun(b, [{ type: 'fontSize', attrs: { size: 'abc' } }]).style.fontSize).toBe(19);
    expect(R.resolveRun(b, [{ type: 'fontSize', attrs: { size: '0' } }]).style.fontSize).toBe(19);
    expect(R.resolveRun(b, [{ type: 'fontSize', attrs: { size: '-5' } }]).style.fontSize).toBe(19);
  });

  it('fontFamily 行内 mark 覆盖块默认字体族（段落默认 = FONT_UI）', () => {
    const b = para([]);
    expect(R.resolveRun(b, []).style.fontFamily).toBe(FONT_UI);
    const marks: Mark[] = [{ type: 'fontFamily', attrs: { fontFamily: 'serif' } }];
    expect(R.resolveRun(b, marks).style.fontFamily).toBe(FONT_FAMILY_STACKS.serif);
  });

  it('fontFamily mark 覆盖 code mark 的等宽默认（mark 优先级最高）', () => {
    const b = para([]);
    const marks: Mark[] = [{ type: 'code' }, { type: 'fontFamily', attrs: { fontFamily: 'serif' } }];
    expect(R.resolveRun(b, marks).style.fontFamily).toBe(FONT_FAMILY_STACKS.serif);
  });

  it('未知字体族命名值原样透传（允许直接传字体栈）', () => {
    const b = para([]);
    const stack = '"My Custom Font", sans-serif';
    const marks: Mark[] = [{ type: 'fontFamily', attrs: { fontFamily: stack } }];
    expect(R.resolveRun(b, marks).style.fontFamily).toBe(stack);
  });
});

describe('resolveRun: 上标/下标', () => {
  it('上标：字号 × 0.8、baselineShift 为正（上移）', () => {
    const b = para([]);
    const rr = R.resolveRun(b, [{ type: 'superscript' }]);
    expect(rr.style.fontSize).toBeCloseTo(19 * SUBSUP_SCALE);
    expect(rr.baselineShift).toBe(SUPERSCRIPT_SHIFT);
    expect(rr.baselineShift).toBeGreaterThan(0);
  });

  it('下标：字号 × 0.8、baselineShift 为负（下移）', () => {
    const b = para([]);
    const rr = R.resolveRun(b, [{ type: 'subscript' }]);
    expect(rr.style.fontSize).toBeCloseTo(19 * SUBSUP_SCALE);
    expect(rr.baselineShift).toBe(SUBSCRIPT_SHIFT);
    expect(rr.baselineShift).toBeLessThan(0);
  });

  it('无上/下标时 baselineShift 为 0', () => {
    expect(R.resolveRun(para([]), []).baselineShift).toBe(0);
  });

  it('上/下标缩放叠加在 fontSize mark 之上（24 × 0.8）', () => {
    const b = para([]);
    const marks: Mark[] = [{ type: 'fontSize', attrs: { size: '24' } }, { type: 'superscript' }];
    expect(R.resolveRun(b, marks).style.fontSize).toBeCloseTo(24 * SUBSUP_SCALE);
  });

  it('上标缩放后绝对偏移 = baselineShift × 缩放后字号（与布局层一致的几何）', () => {
    const b = para([]);
    const rr = R.resolveRun(b, [{ type: 'superscript' }]);
    const shiftPx = rr.baselineShift * rr.style.fontSize; // dpr=1
    expect(shiftPx).toBeCloseTo(SUPERSCRIPT_SHIFT * 19 * SUBSUP_SCALE);
  });
});

describe('resolveFontFamily', () => {
  it('命名值映射到字体栈', () => {
    expect(resolveFontFamily('default')).toBe(FONT_UI);
    expect(resolveFontFamily('serif')).toBe(FONT_FAMILY_STACKS.serif);
    expect(resolveFontFamily('monospace')).toBe(FONT_FAMILY_STACKS.monospace);
  });
  it('未知值原样返回', () => {
    expect(resolveFontFamily('Comic Sans MS')).toBe('Comic Sans MS');
  });
});

// 段落排版：attrs 覆盖块主题默认（indent/spaceBefore/spaceAfter 用 attrs ?? theme），
// 以及 lineHeight/letterSpacing 的默认与夹值。
describe('resolveBlock: attrs 覆盖块主题默认（indent/spaceBefore/spaceAfter）', () => {
  it('未设置 attrs 时回退块主题默认（段落 indent=0, spaceBefore/After=4）', () => {
    const rb = R.resolveBlock(para([]));
    expect(rb.indent).toBe(0);
    expect(rb.spaceBefore).toBe(4);
    expect(rb.spaceAfter).toBe(4);
  });

  it('attrs.indent/spaceBefore/spaceAfter 覆盖主题默认', () => {
    const rb = R.resolveBlock(para([], { indent: 48, spaceBefore: 12, spaceAfter: 20 }));
    expect(rb.indent).toBe(48);
    expect(rb.spaceBefore).toBe(12);
    expect(rb.spaceAfter).toBe(20);
  });

  it('attrs 覆盖列表项主题缩进（bullet 默认 indent=30 → 0）', () => {
    const def = R.resolveBlock(block('bullet_item', []));
    expect(def.indent).toBe(30); // 主题默认
    const overridden = R.resolveBlock(block('bullet_item', [], { indent: 0 }));
    expect(overridden.indent).toBe(0); // attrs 覆盖
  });

  it('attrs=0 是显式覆盖（?? 不会被当作未设置）', () => {
    const rb = R.resolveBlock(block('bullet_item', [], { spaceBefore: 0 }));
    expect(rb.spaceBefore).toBe(0); // 0 ?? theme = 0，覆盖生效
  });

  // 注入防线：attrs 可来自草稿/模板持久化通道，负数/非有限数/非 number 一律回退主题值——
  // 负间距破坏 lines top 单调（visibleLineRange 二分前提），字符串/NaN 会传染 contentHeight。
  it('负值回退主题默认（守住块间距 ≥0 的布局单调不变量）', () => {
    const rb = R.resolveBlock(para([], { indent: -50, spaceBefore: -200, spaceAfter: -1 }));
    expect(rb.indent).toBe(0);
    expect(rb.spaceBefore).toBe(4);
    expect(rb.spaceAfter).toBe(4);
  });

  it('非 number（字符串注入）回退主题默认，不产 NaN', () => {
    const rb = R.resolveBlock(
      para([], {
        spaceBefore: '10px' as unknown as number,
        spaceAfter: '8' as unknown as number,
        indent: '12' as unknown as number,
      }),
    );
    expect(rb.spaceBefore).toBe(4);
    expect(rb.spaceAfter).toBe(4);
    expect(rb.indent).toBe(0);
    expect(Number.isFinite(rb.spaceBefore + rb.spaceAfter + rb.indent)).toBe(true);
  });

  it('NaN/Infinity 回退主题默认', () => {
    expect(R.resolveBlock(para([], { spaceBefore: NaN })).spaceBefore).toBe(4);
    expect(R.resolveBlock(para([], { spaceAfter: Infinity })).spaceAfter).toBe(4);
    expect(R.resolveBlock(para([], { indent: -Infinity })).indent).toBe(0);
  });
});

describe('resolveBlock: lineHeight / letterSpacing', () => {
  it('默认 lineHeight=1, letterSpacing=0', () => {
    const rb = R.resolveBlock(para([]));
    expect(rb.lineHeight).toBe(1);
    expect(rb.letterSpacing).toBe(0);
  });

  it('attrs.lineHeight 透传（1.5 / 2）', () => {
    expect(R.resolveBlock(para([], { lineHeight: 1.5 })).lineHeight).toBe(1.5);
    expect(R.resolveBlock(para([], { lineHeight: 2 })).lineHeight).toBe(2);
  });

  it('非法/非正 lineHeight 夹回 1', () => {
    expect(R.resolveBlock(para([], { lineHeight: 0 })).lineHeight).toBe(1);
    expect(R.resolveBlock(para([], { lineHeight: -1 })).lineHeight).toBe(1);
    expect(R.resolveBlock(para([], { lineHeight: NaN })).lineHeight).toBe(1);
  });

  it('非有限 lineHeight/letterSpacing（Infinity）夹回默认（typeof 收窄回归）', () => {
    expect(R.resolveBlock(para([], { lineHeight: Infinity })).lineHeight).toBe(1);
    expect(R.resolveBlock(para([], { letterSpacing: Infinity })).letterSpacing).toBe(0);
    expect(R.resolveBlock(para([], { letterSpacing: -Infinity })).letterSpacing).toBe(0);
  });

  it('attrs.letterSpacing 透传（含 0）', () => {
    expect(R.resolveBlock(para([], { letterSpacing: 2 })).letterSpacing).toBe(2);
    expect(R.resolveBlock(para([], { letterSpacing: 0 })).letterSpacing).toBe(0);
  });

  it('非有限 letterSpacing 夹回 0', () => {
    expect(R.resolveBlock(para([], { letterSpacing: NaN })).letterSpacing).toBe(0);
  });
});

describe('resolveBlock: align 透传（含 justify/distribute）', () => {
  it('默认 left；attrs 透传 justify/distribute', () => {
    expect(R.resolveBlock(para([])).align).toBe('left');
    expect(R.resolveBlock(para([], { align: 'justify' })).align).toBe('justify');
    expect(R.resolveBlock(para([], { align: 'distribute' })).align).toBe('distribute');
  });
});
