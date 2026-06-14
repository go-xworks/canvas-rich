// text 层 · HarfBuzz 整形器实现（Shaper 接口）：用真实字体二进制做 HarfBuzz 整形（连字/字距/复杂文字），
// 输出 glyphId + advance/offset，再经 glyphToPath/glyphExtents 把字形轮廓光栅进字形图集。
// 字体回退：Latin→Roboto，希伯来→Noto Hebrew，阿拉伯→Noto Arabic（见 fallbacks）；CJK/emoji 待扩展。
import type * as HB from 'harfbuzzjs';
import { StyledChar, Style, GlyphInfo } from '../types';
import { GlyphAtlas, FontMetrics } from './glyph-atlas';
import { Shaper, ShapedChar } from './shaper';

interface FontEntry { tag: string; font: HB.Font; upem: number }

const EMPTY = (advance: number): GlyphInfo =>
  ({ u0: 0, v0: 0, u1: 0, v1: 0, page: 0, w: 0, h: 0, bearingX: 0, bearingY: 0, advance, empty: true });

// 脚本范围判定（用于字体回退选择）
function isArabicCp(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
    (cp >= 0x08A0 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF);
}
function isHebrewCp(cp: number): boolean { return (cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0xFB1D && cp <= 0xFB4F); }

/** 基于 HarfBuzz 的多语言整形器，输出字形度量并将轮廓光栅进图集。 @public */
export class HarfBuzzShaper implements Shaper {
  readonly name = 'HarfBuzz (多语言 · 真整形)';
  private metricsCache = new Map<string, FontMetrics>();
  private buf: HB.Buffer | null = null;
  // 脚本 → 字体 回退表（可继续扩展 CJK 等）
  private fallbacks: { test: (cp: number) => boolean; font: FontEntry }[];

  private constructor(
    private hb: typeof HB,
    private atlas: GlyphAtlas,
    private dpr: number,
    private regular: FontEntry,
    private bold: FontEntry,
    arabic: FontEntry,
    hebrew: FontEntry,
  ) {
    this.fallbacks = [
      { test: isArabicCp, font: arabic },
      { test: isHebrewCp, font: hebrew },
    ];
  }

  static async create(atlas: GlyphAtlas, dpr: number): Promise<HarfBuzzShaper> {
    const hb = await import('harfbuzzjs');
    // 字体根：随构建 base 解析（Vite 注入 import.meta.env.BASE_URL，默认 '/'），
    // 使站点部署在子路径（如 GitHub Pages /canvas-rich/）时字体 URL 仍正确；
    // 非 Vite 宿主取不到时回退 '/'（消费者需把字体放在服务根 /fonts/）。
    const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
    const fontBase = env?.BASE_URL ?? '/';
    const load = async (name: string, tag: string): Promise<FontEntry> => {
      const url = `${fontBase}fonts/${name}`;
      const ab = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`字体加载失败 ${url}: ${r.status}`);
        return r.arrayBuffer();
      });
      const blob = new hb.Blob(ab);
      const face = new hb.Face(blob, 0);
      const upem = face.upem;
      const font = new hb.Font(face);
      font.setScale(upem, upem); // 输出单位 = 设计单位，后续乘 px/upem
      return { tag, font, upem };
    };
    const [regular, bold, arabic, hebrew] = await Promise.all([
      load('Roboto-Regular.ttf', 'r'),
      load('Roboto-Bold.ttf', 'b'),
      load('NotoSansArabic-Regular.ttf', 'ar'),
      load('NotoSansHebrew-Regular.ttf', 'he'),
    ]);
    return new HarfBuzzShaper(hb, atlas, dpr, regular, bold, arabic, hebrew);
  }

  /**
   * 更新渲染比例（有效 dpr = 设备 dpr × 功能性缩放）：清字体度量缓存。
   * 字形图集键含 px（`hb:tag:gid:px`），随比例变化自然失效；旧位图由图集 setDpr 复位清除。 @public
   */
  setDpr(scale: number): void {
    if (scale === this.dpr) return;
    this.dpr = scale;
    this.metricsCache.clear();
  }

  private pick(style: Style): FontEntry { return style.bold ? this.bold : this.regular; }
  // 字体回退：按脚本范围选字体，其余按字重用 Roboto
  private fontFor(c: StyledChar): FontEntry {
    const cp = c.ch.codePointAt(0) ?? 0;
    for (const fb of this.fallbacks) if (fb.test(cp)) return fb.font;
    return c.style.bold ? this.bold : this.regular;
  }
  private px(style: Style): number { return Math.max(1, Math.round(style.fontSize * this.dpr)); }

  fontMetrics(style: Style): FontMetrics {
    const f = this.pick(style);
    const px = this.px(style);
    const key = `${f.tag}:${px}`;
    const hit = this.metricsCache.get(key);
    if (hit) return hit;
    const s = px / f.upem;
    const ext = f.font.hExtents(); // 设计单位：ascender>0, descender<0
    const ascent = Math.ceil(ext.ascender * s);
    const descent = Math.ceil(-ext.descender * s);
    const lineHeight = Math.ceil((ext.ascender - ext.descender + ext.lineGap) * s * 1.1);
    const m: FontMetrics = { ascent, descent, lineHeight };
    this.metricsCache.set(key, m);
    return m;
  }

  shapeChars(chars: StyledChar[]): ShapedChar[] {
    const n = chars.length;
    const out: ShapedChar[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { advance: 0, glyph: EMPTY(0) };

    let i = 0;
    while (i < n) {
      // 换行符：layout 自己处理，整形器跳过
      if (chars[i].ch === '\n') { i++; continue; }
      // 取一段同字重(font)的 run（直到样式的 bold 改变或遇到 \n）
      const runStart = i;
      const boldFlag = chars[i].style.bold;
      while (i < n && chars[i].ch !== '\n' && chars[i].style.bold === boldFlag) i++;
      this.shapeRun(chars, runStart, i, out);
    }
    return out;
  }

  // 在同字重 run 内再按「字体覆盖」切子段（Latin→Roboto，阿拉伯→阿拉伯字体），各自整形
  private shapeRun(chars: StyledChar[], start: number, end: number, out: ShapedChar[]) {
    let i = start;
    while (i < end) {
      const f0 = this.fontFor(chars[i]);
      let j = i + 1;
      while (j < end && this.fontFor(chars[j]) === f0) j++;
      this.shapeSegment(chars, i, j, f0, out);
      i = j;
    }
  }

  private shapeSegment(chars: StyledChar[], start: number, end: number, f: FontEntry, out: ShapedChar[]) {
    const px = this.px(chars[start].style);
    const s = px / f.upem;

    // run 文本 + 「UTF-16 偏移 → 本地字符下标」映射
    let text = '';
    const starts: number[] = []; // 第 k 个字符在 run 文本中的 UTF-16 起始偏移
    for (let k = start; k < end; k++) { starts.push(text.length); text += chars[k].ch; }
    const offsetToLocal = (off: number): number => {
      // 找最大的 starts[k] <= off
      let lo = 0, hi = starts.length - 1, ans = 0;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    };

    const buf = this.buf ?? (this.buf = new this.hb.Buffer()); // 复用，避免每段重新分配
    buf.reset();
    buf.addText(text);
    buf.guessSegmentProperties();
    this.hb.shape(f.font, buf);
    const glyphs = buf.getGlyphInfosAndPositions();

    for (const g of glyphs) {
      const gid = g.codepoint;
      const local = offsetToLocal(g.cluster | 0);
      const ci = start + local;
      const advPx = (g.xAdvance ?? 0) * s;
      const xOff = (g.xOffset ?? 0) * s;
      const yOff = (g.yOffset ?? 0) * s;
      const gi = this.rasterizeGlyph(f, gid, px, s);
      out[ci].advance += advPx;
      // 簇首字符承载字形（含偏移）；同簇后续字形只累加 advance（连字续字保持 empty）
      if (out[ci].glyph.empty && !gi.empty) {
        out[ci].glyph = { ...gi, bearingX: gi.bearingX + xOff, bearingY: gi.bearingY + yOff };
      }
    }
  }

  private rasterizeGlyph(f: FontEntry, gid: number, px: number, s: number): GlyphInfo {
    const key = `hb:${f.tag}:${gid}:${px}`;
    const cached = this.atlas.getById(key);
    if (cached) return cached;

    const ext = f.font.glyphExtents(gid);
    if (!ext) return this.atlas.addGlyphById(key, { w: 0, h: 0, bearingX: 0, bearingY: 0, advance: 0, empty: true }, () => {});

    const left = ext.xBearing;          // 设计单位：左边承
    const top = ext.yBearing;           // 设计单位：基线到顶（y 朝上为正）
    const w = Math.abs(ext.width);
    const h = Math.abs(ext.height);
    if (w === 0 || h === 0) {
      return this.atlas.addGlyphById(key, { w: 0, h: 0, bearingX: 0, bearingY: 0, advance: 0, empty: true }, () => {});
    }

    const bw = Math.ceil(w * s);
    const bh = Math.ceil(h * s);
    const bearingX = left * s;
    const bearingY = top * s;
    const pathD = f.font.glyphToPath(gid); // 设计单位、y 朝上的 SVG path

    return this.atlas.addGlyphById(
      key,
      { w: bw, h: bh, bearingX, bearingY, advance: 0, empty: false },
      (ctx, ox, oy) => {
        ctx.save();
        ctx.fillStyle = '#fff'; // 覆盖率存 alpha，颜色由顶点色决定
        ctx.translate(ox, oy);
        ctx.scale(s, -s);        // 设计单位→px，并翻转 y（设计 y朝上 → 画布 y朝下）
        ctx.translate(-left, -top);
        ctx.fill(new Path2D(pathD));
        ctx.restore();
      },
    );
  }
}
