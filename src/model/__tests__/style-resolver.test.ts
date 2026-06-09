import { describe, it, expect } from 'vitest';
import {
  StyleResolver, resolveFontFamily, FONT_FAMILY_STACKS,
  SUBSUP_SCALE, SUPERSCRIPT_SHIFT, SUBSCRIPT_SHIFT,
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
