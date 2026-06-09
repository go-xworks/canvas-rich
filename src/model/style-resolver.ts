import { Block, Mark, getMark, hasMarkType } from './schema';
import { FONT_UI, FONT_MONO } from './palette';
import { Style } from '../types';
import { C, RGBA, parseHex } from './palette';
import { meta } from './block-specs';

// 样式解析：块主题查注册表（blockSpecs），行内 marks 叠加。
// 分层位置：model 层，把块规格 + 行内 marks 解析为渲染层可直接消费的样式。

/**
 * 一段连续 run 解析后的最终样式：基础 style 叠加下划线/删除线/高亮颜色。
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
/** 块级解析结果：基础样式 + 对齐/缩进/间距/标记/背景。 @public */
export interface ResolvedBlock {
  base: Style;
  align: 'left' | 'center' | 'right';
  indent: number; spaceBefore: number; spaceAfter: number;
  marker: string | null; ordered: boolean; background: RGBA | null;
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
  /** 解析块级主题为对齐/缩进/间距/标记/背景的 ResolvedBlock。 @public */
  resolveBlock(b: Block): ResolvedBlock {
    const t = meta(b.type).theme(b.attrs);
    return { base: t.base, align: b.attrs.align ?? 'left', indent: t.indent, spaceBefore: t.spaceBefore, spaceAfter: t.spaceAfter, marker: t.marker, ordered: t.ordered, background: t.background };
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
    if (fs?.attrs?.size) { const n = parseFloat(fs.attrs.size); if (Number.isFinite(n) && n > 0) style.fontSize = n; }
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
