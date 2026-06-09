import { StyledChar, Style } from '../types';
import { GlyphAtlas, FontMetrics } from './glyph-atlas';
import { Shaper, ShapedChar } from './shaper';

// 基线整形器：逐字符用浏览器 measureText/fillText（即原有行为）。
// 优点：覆盖系统所有字体（含 CJK/emoji）；缺点：无字距(kerning)、无连字、无复杂文字整形。
/** 基线整形器：逐字符用浏览器 measureText/fillText，无字距/连字，覆盖系统所有字体。 @public */
export class CanvasShaper implements Shaper {
  readonly name = 'Canvas (system font · 逐字符)';
  constructor(private atlas: GlyphAtlas) {}

  fontMetrics(style: Style): FontMetrics {
    return this.atlas.fontMetrics(style);
  }

  shapeChars(chars: StyledChar[]): ShapedChar[] {
    const out: ShapedChar[] = new Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const g = this.atlas.getGlyph(chars[i].ch, chars[i].style);
      out[i] = { advance: g.advance, glyph: g };
    }
    return out;
  }
}
