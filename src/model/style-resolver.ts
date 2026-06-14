import { Block, BlockAlign, Mark, getMark, hasMarkType } from './schema';
import { FONT_UI, FONT_MONO } from './palette';
import { Style } from '../types';
import { C, RGBA, parseHex } from './palette';
import { meta } from './block-specs';

// 样式解析：块主题查注册表（blockSpecs），行内 marks 叠加。
// 分层位置：model 层，把块规格 + 行内 marks 解析为渲染层可直接消费的样式。

/**
 * 一段连续 run 解析后的最终样式：基础 style 叠加下划线/删除线/高亮。
 * baselineShift：上/下标的基线偏移（em 比例，正=上移即上标、负=下移即下标、0=无），
 * 由布局层乘以行内字号施加到 baselineY。
 * @public
 */
export interface ResolvedRun { style: Style; underline: RGBA | null; strike: RGBA | null; highlight: RGBA | null; baselineShift: number }

/** 上/下标的字号缩放系数（相对所在 run 的字号）。 @public */
export const SUBSUP_SCALE = 0.8;
/** 上/下标基线偏移（占当前字号的比例，上标上移、下标下移约 0.35em）。 @public */
export const SUPERSCRIPT_SHIFT = 0.35;
/** 下标基线下移比例（与上标对称）。 @public */
export const SUBSCRIPT_SHIFT = -0.35;
/**
 * fontSize mark 的字号上限（逻辑 px）：防粘贴/JSON 导入注入天文字号。
 * 配合字形图集的巨字形夹紧光栅，正常文档触不到该上限。
 * @public
 */
export const MAX_FONT_SIZE = 400;
/**
 * 块级解析结果：基础样式 + 对齐/缩进/间距/标记/背景 + 段落排版。
 * lineHeight：行距倍数（≥0，默认 1）；letterSpacing：字间距（逻辑 px，默认 0）。
 * indent/spaceBefore/spaceAfter 用 attrs ?? theme 覆盖优先级解析。
 * @public
 */
export interface ResolvedBlock {
  base: Style;
  align: BlockAlign;
  indent: number; spaceBefore: number; spaceAfter: number;
  marker: string | null; ordered: boolean; background: RGBA | null;
  lineHeight: number; letterSpacing: number;
}

/**
 * 字体族 mark 的命名值 → 实际 CSS 字体栈。
 * 工具栏下拉给出命名值（default/serif/monospace/heiti/kaiti）；未知值原样透传，
 * 允许直接传入完整字体栈。
 * @public
 */
export const FONT_FAMILY_STACKS: Record<string, string> = {
  default: FONT_UI,
  serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
  monospace: FONT_MONO,
  heiti: '"PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif',
  kaiti: '"Kaiti SC", "KaiTi", "STKaiti", serif',
};

/** 把字体族 mark 的命名值解析为 CSS 字体栈（未知值原样返回）。 @public */
export function resolveFontFamily(name: string): string {
  return FONT_FAMILY_STACKS[name] ?? name;
}

/** 样式解析器：把块规格与行内 marks 解析为渲染层样式。 @public */
export class StyleResolver {
  /**
   * 解析块级主题为对齐/缩进/间距/标记/背景 + 段落排版的 ResolvedBlock。
   * 覆盖优先级：indent/spaceBefore/spaceAfter 用 `attrs ?? theme`（attrs 显式设置则覆盖主题默认）；
   * lineHeight 默认 1、letterSpacing 默认 0，非法/负值夹回默认。
   * @public
   */
  resolveBlock(b: Block): ResolvedBlock {
    const a = b.attrs;
    const t = meta(b.type).theme(a);
    // typeof 收窄替代 as 断言：attrs 可能来自导入/持久化，运行时不保证是 number。
    const lh = a.lineHeight;
    const lineHeight = typeof lh === 'number' && Number.isFinite(lh) && lh > 0 ? lh : 1;
    const ls = a.letterSpacing;
    const letterSpacing = typeof ls === 'number' && Number.isFinite(ls) ? ls : 0;
    // indent/spaceBefore/spaceAfter 同源同款收窄（非有限数/负值/非 number 回退主题值）：
    // RichDoc setter 已 clamp ≥0，但 attrs 可经草稿/模板等持久化通道注入——负间距会破坏
    // lines top/bottom 随文档序单调的布局不变量（visibleLineRange 二分剔除的前提），
    // 字符串则 NaN 传染到 contentHeight/clampScroll 致整屏渲染崩坏。
    const nonNegNum = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
    return {
      base: t.base,
      align: a.align ?? 'left',
      indent: nonNegNum(a.indent, t.indent),
      spaceBefore: nonNegNum(a.spaceBefore, t.spaceBefore),
      spaceAfter: nonNegNum(a.spaceAfter, t.spaceAfter),
      marker: t.marker, ordered: t.ordered, background: t.background,
      lineHeight, letterSpacing,
    };
  }

  /**
   * 在块基础样式上按固定顺序叠加行内 marks，得到 run 最终样式。
   * 不变量：link 最后叠加，故覆盖 color 并强制下划线；code 决定等宽字体与默认色。
   * @public
   */
  resolveRun(b: Block, marks: Mark[]): ResolvedRun {
    const base = meta(b.type).theme(b.attrs).base;
    const style: Style = { ...base, color: [...base.color] as RGBA };
    let underline: RGBA | null = null;
    let strike: RGBA | null = null;
    let highlight: RGBA | null = null;
    let baselineShift = 0;

    if (hasMarkType(marks, 'bold')) style.bold = true;
    if (hasMarkType(marks, 'italic')) style.italic = true;
    if (hasMarkType(marks, 'code')) { style.fontFamily = 'ui-monospace, monospace'; style.color = [...C.code] as RGBA; }
    // 字体族/字号行内 mark：优先级 mark > block > default（覆盖块主题，含 code 的等宽默认）。
    const ff = getMark(marks, 'fontFamily');
    if (ff?.attrs?.fontFamily) style.fontFamily = resolveFontFamily(ff.attrs.fontFamily);
    const fs = getMark(marks, 'fontSize');
    if (fs?.attrs?.size) { const n = parseFloat(fs.attrs.size); if (Number.isFinite(n) && n > 0) style.fontSize = Math.min(n, MAX_FONT_SIZE); }
    const hl = getMark(marks, 'highlight');
    if (hl) { const c = hl.attrs?.color ? parseHex(hl.attrs.color, [1, 0.85, 0.25, 1]) : [1, 0.85, 0.25, 1]; highlight = [c[0], c[1], c[2], 0.4]; }
    const color = getMark(marks, 'color');
    if (color?.attrs?.color) style.color = parseHex(color.attrs.color, style.color);
    if (hasMarkType(marks, 'underline')) underline = style.color as RGBA;
    if (hasMarkType(marks, 'strikethrough')) strike = style.color as RGBA;
    // 上/下标（互斥）：字号×0.8，并记录基线偏移比例供布局层施加（上标上移、下标下移）。
    if (hasMarkType(marks, 'superscript')) { style.fontSize *= SUBSUP_SCALE; baselineShift = SUPERSCRIPT_SHIFT; }
    else if (hasMarkType(marks, 'subscript')) { style.fontSize *= SUBSUP_SCALE; baselineShift = SUBSCRIPT_SHIFT; }
    if (hasMarkType(marks, 'link')) { style.color = [...C.link] as RGBA; underline = C.link; }

    return { style, underline, strike, highlight, baselineShift };
  }
}
