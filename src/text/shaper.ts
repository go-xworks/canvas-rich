// text 层 · 整形器抽象：把「带样式的字符序列」转成「逐字符前进量 + 字形位图信息」，是排版的可替换缝
// （canvas-shaper=浏览器 measureText 逐字符；harfbuzz-shaper=真 HarfBuzz 整形），由 doc-layout 消费。
import { StyledChar, GlyphInfo, Style } from '../types';
import { FontMetrics } from './glyph-atlas';

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
  /**
   * 可选：更新渲染比例（有效 dpr = 设备 dpr × 功能性缩放），实现方应失效自身度量缓存。
   * 经图集取度量的实现（如 CanvasShaper）无自身状态，可不实现——比例由图集 setDpr 统一驱动。
   */
  setDpr?(scale: number): void;
}
