import { GlyphInfo, Style, styleKey, cssFont } from '../types';

// 字形图集：按需把「字符 + 样式」用 Canvas2D 光栅成位图，打包进一张大纹理画布。
// 渲染层只需把这张画布上传为 GPU 纹理，再用贴图四边形合成 —— 这就是 glengine
// 里「字形 → atlas → mesh」那条精华路线的最小实现（整形先用浏览器，后续可换 HarfBuzz）。
/** 某样式的字体度量（设备像素）：上升/下降高度与建议行高，与具体字形无关。 @public */
export interface FontMetrics { ascent: number; descent: number; lineHeight: number; }

const ATLAS_SIZE = 2048;
const PAD = 2; // 字形之间留边，避免采样串色

/** 字形图集：按需把字符+样式光栅成位图并打包进一张大纹理画布，供渲染层上传为 GPU 纹理。 @public */
export class GlyphAtlas {
  readonly size = ATLAS_SIZE;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private glyphs = new Map<string, GlyphInfo>();
  private metrics = new Map<string, FontMetrics>();
  private penX = PAD;
  private penY = PAD;
  private shelfH = 0;
  private _dirty = true;
  private _resetting = false;
  private _reset = false;
  // 预留一个不透明白色像素，给光标/选区这类纯色矩形复用同一套贴图管线
  readonly whiteUV: { u: number; v: number };

  // 画布由装配层（main.ts）创建并注入，core 不直接依赖 `document`（框架无关，便于测试/换宿主）。
  constructor(canvas: HTMLCanvasElement, private dpr: number) {
    this.canvas = canvas;
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    // 写入 2x2 白块
    this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(0, 0, 2, 2);
    this.whiteUV = { u: 1 / ATLAS_SIZE, v: 1 / ATLAS_SIZE };
    this.penX = 4;
    this.shelfH = 4;
  }

  /** 自上次清理以来画布是否有新字形写入，渲染层据此决定是否重新上传纹理。 @public */
  get dirty(): boolean { return this._dirty; }
  /** 清除脏标记，应在纹理上传完成后调用。 @public */
  clearDirty(): void { this._dirty = false; }
  // 图集刚发生过整体复位（满载逐出）→ 上层应触发一次重排，让本帧之前已放置的字形重新光栅
  /** 取并清除「整体复位」标记；为 true 时上层须重排，让已放置字形重新光栅。 @public */
  consumeReset(): boolean { const r = this._reset; this._reset = false; return r; }

  // 整体复位：清空所有字形与画布，重置打包游标（最简「全量逐出」，比永久失败健壮）
  private resetAtlas() {
    this.glyphs.clear();
    this.ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.ctx.fillStyle = '#fff'; this.ctx.fillRect(0, 0, 2, 2); // 重画白块
    this.penX = 4; this.penY = PAD; this.shelfH = 4;
    this._dirty = true; this._reset = true;
  }

  // 按 key 取已缓存字形（HarfBuzz 路径用，避免重复算 extents/path）
  /** 按 key 取已缓存字形，未命中返回 undefined（HarfBuzz 路径复用，避免重复算 extents/path）。 @public */
  getById(key: string): GlyphInfo | undefined { return this.glyphs.get(key); }

  // 取某样式的字体度量（行高用，与具体字形无关）
  /** 取并缓存某样式的字体度量（行高用，与具体字形无关）。 @public */
  fontMetrics(style: Style): FontMetrics {
    const key = styleKey(style, this.dpr);
    let m = this.metrics.get(key);
    if (m) return m;
    this.ctx.font = cssFont(style, this.dpr);
    this.ctx.textBaseline = 'alphabetic';
    const tm = this.ctx.measureText('Mg');
    const ascent = Math.ceil(tm.fontBoundingBoxAscent || tm.actualBoundingBoxAscent || style.fontSize * this.dpr * 0.8);
    const descent = Math.ceil(tm.fontBoundingBoxDescent || tm.actualBoundingBoxDescent || style.fontSize * this.dpr * 0.2);
    m = { ascent, descent, lineHeight: Math.ceil((ascent + descent) * 1.25) };
    this.metrics.set(key, m);
    return m;
  }

  // 取（并在缺失时光栅化）一个字形
  /** 取（并在缺失时光栅化）一个字形；图集满载的失败结果不缓存，避免字形永久隐身。 @public */
  getGlyph(ch: string, style: Style): GlyphInfo {
    const key = styleKey(style, this.dpr) + '|' + ch;
    let g = this.glyphs.get(key);
    if (g) return g;
    g = this.rasterize(ch, style);
    if (!g.exhausted) this.glyphs.set(key, g); // 图集满载的失败结果不缓存，避免永久隐身
    return g;
  }

  private rasterize(ch: string, style: Style): GlyphInfo {
    const ctx = this.ctx;
    ctx.font = cssFont(style, this.dpr);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const tm = ctx.measureText(ch);
    const advance = tm.width;

    const left = Math.ceil(tm.actualBoundingBoxLeft || 0);
    const right = Math.ceil(tm.actualBoundingBoxRight || advance);
    const asc = Math.ceil(tm.actualBoundingBoxAscent || 0);
    const desc = Math.ceil(tm.actualBoundingBoxDescent || 0);
    const w = left + right;
    const h = asc + desc;

    // 不可见字形（空格、换行等）：只占前进量
    if (w <= 0 || h <= 0 || ch === ' ' || ch === '\n' || ch === '\t') {
      return { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0, bearingX: 0, bearingY: 0, advance, empty: true };
    }

    const slot = this.alloc(w, h);
    if (!slot) {
      return { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0, bearingX: 0, bearingY: 0, advance, empty: true, exhausted: true };
    }
    const { ox, oy } = slot;
    // 把笔位放在 (ox+left, oy+asc)，使字形正好落进 (ox,oy,w,h)
    ctx.fillStyle = '#fff'; // 以白色 + alpha 存覆盖率，颜色由顶点色决定
    ctx.fillText(ch, ox + left, oy + asc);

    return {
      u0: ox / ATLAS_SIZE,
      v0: oy / ATLAS_SIZE,
      u1: (ox + w) / ATLAS_SIZE,
      v1: (oy + h) / ATLAS_SIZE,
      w, h,
      bearingX: -(tm.actualBoundingBoxLeft || 0),
      bearingY: asc,
      advance,
      empty: false,
    };
  }

  // —— 货架打包：为 w×h 的位图分配一个槽，返回内容左上角；满了返回 null ——
  private alloc(w: number, h: number): { ox: number; oy: number } | null {
    const bw = w + PAD * 2;
    const bh = h + PAD * 2;
    if (this.penX + bw > ATLAS_SIZE) {
      this.penX = PAD;
      this.penY += this.shelfH;
      this.shelfH = 0;
    }
    if (this.penY + bh > ATLAS_SIZE) {
      if (!this._resetting) {
        this._resetting = true;
        this.resetAtlas();
        const slot = this.alloc(w, h); // 复位后重试一次
        this._resetting = false;
        return slot;
      }
      return null; // 复位后仍放不下（单字形比整张图集还大，极罕见）
    }
    const ox = this.penX + PAD;
    const oy = this.penY + PAD;
    this.penX += bw;
    this.shelfH = Math.max(this.shelfH, bh);
    this._dirty = true;
    return { ox, oy };
  }

  // —— 按 key（如 hb:r:gid:px）光栅化一个「以字形索引标识」的字形。 ——
  // info 提供 w/h/bearing/advance（设备像素）；draw 在槽内绘制（ctx 已是图集的 2D 上下文）。
  // 用于 HarfBuzz 路径：调用方拿到 glyphId + extents + SVG path 后，自己负责变换与填充。
  /** 按 key 光栅化一个以字形索引标识的字形（HarfBuzz 路径），调用方经 draw 自绘填充。 @public */
  addGlyphById(
    key: string,
    info: { w: number; h: number; bearingX: number; bearingY: number; advance: number; empty: boolean },
    draw: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void,
  ): GlyphInfo {
    const cached = this.glyphs.get(key);
    if (cached) return cached;

    let g: GlyphInfo;
    if (info.empty || info.w <= 0 || info.h <= 0) {
      g = { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0, bearingX: info.bearingX, bearingY: info.bearingY, advance: info.advance, empty: true };
    } else {
      const slot = this.alloc(info.w, info.h);
      if (!slot) {
        g = { u0: 0, v0: 0, u1: 0, v1: 0, w: 0, h: 0, bearingX: info.bearingX, bearingY: info.bearingY, advance: info.advance, empty: true, exhausted: true };
      } else {
        draw(this.ctx, slot.ox, slot.oy);
        this._dirty = true;
        g = {
          u0: slot.ox / ATLAS_SIZE, v0: slot.oy / ATLAS_SIZE,
          u1: (slot.ox + info.w) / ATLAS_SIZE, v1: (slot.oy + info.h) / ATLAS_SIZE,
          w: info.w, h: info.h, bearingX: info.bearingX, bearingY: info.bearingY, advance: info.advance, empty: false,
        };
      }
    }
    if (!g.exhausted) this.glyphs.set(key, g); // 满载失败不缓存
    return g;
  }
}
