import { StyledChar, GlyphInfo, Style } from '../types';
import { FontMetrics } from './glyph-atlas';

// 整形器抽象：把「带样式的字符序列」转成「每字符的前进量 + 字形位图信息」。
// 这是排版的可替换缝：CanvasShaper 用浏览器 measureText（逐字符、无连字/字距），
// HarfBuzzShaper 用真正的 HarfBuzz 整形（连字、字距、复杂文字），并按 glyph-id 光栅化。
//
// 为了不动既有「逐字符」的光标/选区模型，整形结果对齐到字符下标：
// - 1:1 常见情形：每个字符一个字形 + 自己的前进量。
// - 连字（多字符→单字形）：字形与合计前进量记在簇首字符上，后续字符 advance=0、glyph=empty。
/** 单个字符整形后的结果：前进量 + 字形位图信息，下标对齐到原字符序列。 @public */
export interface ShapedChar {
  advance: number;   // 设备 px
  glyph: GlyphInfo;  // 可能 empty=true（空格/换行/连字续字）
}

/** 整形器接口：把带样式字符序列转成逐字符前进量与字形，是排版的可替换缝。 @public */
export interface Shaper {
  readonly name: string;
  fontMetrics(style: Style): FontMetrics;
  shapeChars(chars: StyledChar[]): ShapedChar[];
}
