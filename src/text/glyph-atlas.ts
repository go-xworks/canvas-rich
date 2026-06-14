import { GlyphInfo, Style, styleKey, cssFont } from '../types';
import { AtlasRect } from '../render/renderer';
import { ShelfPacker, unionRect } from './shelf-packer';

// 字形图集：按需把「字符 + 样式」用 Canvas2D 光栅成位图，打包进多张大纹理画布（页）。
// 渲染层把每页画布上传为一张 GPU 纹理，再用贴图四边形按页分批合成。打包算术抽在
// shelf-packer（纯模块，node 可测），本类退化为「packer + Canvas2D 光栅」薄壳。
// 多页化后：架满开新页（已放字形 UV 全部有效），仅 8 页全满才整体复位（罕见兜底）；
// 巨字形夹紧降采样光栅 → 尺寸性 alloc 失败不复存在 → 「满载每帧全清重栅」死循环解除。

/** 某样式的字体度量（设备像素）：上升/下降高度与建议行高，与具体字形无关。 @public */
export interface FontMetrics {
  ascent: number;
  descent: number;
  lineHeight: number;
}

const PAGE_SIZE = 2048;
const MAX_PAGES = 8; // 8 页 × ~2000 字形 ≈ 1.6 万槽位：覆盖常用 CJK + 多字号/粗体变体
const PAD = 2; // 字形之间留边，避免采样串色

// 一张图集页：自己的画布/上下文 + 自上次上传以来的脏矩形并集（货架游标在 packer 内）。
interface AtlasPage {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dirty: AtlasRect | null;
}

/** 单页脏区上传单元：页号 + 该页画布 + 自上次上传以来的脏矩形并集。 @public */
export interface DirtyPage {
  page: number;
  canvas: HTMLCanvasElement;
  rect: AtlasRect;
}

/** 字形图集：按需把字符+样式光栅成位图并打包进多页纹理画布，供渲染层按页上传 GPU 纹理。 @public */
export class GlyphAtlas {
  /** 单页边长（设备 px），渲染层建纹理与 UV 归一的基准。 @public */
  readonly pageSize: number;
  /** 整体复位代数：resetAll/setDpr 时自增。上层缓存（如块布局缓存 epoch）据此整体失效——缓存的 GlyphInfo UV 在复位后指向已清画布。 @public */
  generation = 0;
  // 预留一个不透明白色像素，给光标/选区这类纯色矩形复用同一套贴图管线（恒在 page 0，
  // 复位后重画：复位态下首次 alloc 的槽位确定，whiteUV 保持有效）
  readonly whiteUV: { u: number; v: number };

  private packer: ShelfPacker;
  private pages: AtlasPage[];
  private glyphs = new Map<string, GlyphInfo>();
  private metrics = new Map<string, FontMetrics>();
  private _resetting = false;
  private _reset = false;

  // 画布工厂由装配层（main.ts）注入，core 不直接依赖 `document`（框架无关，便于测试/换宿主）。
  // opts 仅供测试缩小页尺寸/页数，生产走默认 2048×8。
  constructor(
    private createCanvas: () => HTMLCanvasElement,
    private dpr: number,
    opts?: { pageSize?: number; maxPages?: number },
  ) {
    this.pageSize = opts?.pageSize ?? PAGE_SIZE;
    this.packer = new ShelfPacker(this.pageSize, opts?.maxPages ?? MAX_PAGES, PAD);
    this.pages = [this.newPage()];
    const wb = this.drawWhiteBlock();
    this.whiteUV = { u: (wb.ox + 1) / this.pageSize, v: (wb.oy + 1) / this.pageSize };
  }

  /** 当前已开页数（≤ maxPages）。 @public */
  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * 更新渲染比例（有效 dpr = 设备 dpr × 功能性缩放）：清空字形与度量缓存并整体复位，
   * 页数收缩回 1（zoom 会话峰值不常驻；GPU 侧由渲染器 dropAtlasPages 配套回收），
   * 旧字形按新比例重新光栅。复位走 {@link GlyphAtlas.consumeReset} 流程——上层下一帧重排即重栅。
   * 比例未变时零开销。 @public
   */
  setDpr(scale: number): void {
    if (scale === this.dpr) return;
    this.dpr = scale;
    this.metrics.clear();
    this.resetAll(true);
  }

  /** 取并清各页脏矩形（自上次上传以来的并集），供渲染层做 per-page 子区上传。 @public */
  takeDirtyPages(): DirtyPage[] {
    const out: DirtyPage[] = [];
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.dirty) {
        out.push({ page: i, canvas: p.canvas, rect: p.dirty });
        p.dirty = null;
      }
    }
    return out;
  }

  // 图集刚发生过整体复位（全页满载逐出 / setDpr）→ 上层应触发一次重排，让已放置字形重新光栅
  /** 取并清除「整体复位」标记；为 true 时上层须重排，让已放置字形重新光栅。 @public */
  consumeReset(): boolean {
    const r = this._reset;
    this._reset = false;
    return r;
  }

  /**
   * 全部页的整页上传单元（rect=整页），不动各页脏矩形。
   * GPU 上下文丢失恢复后重建渲染器时调用：CPU 侧画布数据无损，整页重传即可恢复字形纹理。
   * @public
   */
  fullPages(): DirtyPage[] {
    return this.pages.map((p, i) => ({
      page: i,
      canvas: p.canvas,
      rect: { x: 0, y: 0, w: this.pageSize, h: this.pageSize },
    }));
  }

  // 整体复位：清空所有字形与各页画布，重置打包游标并重画白块（最简「全量逐出」兜底，
  // 多页化后仅在 8 页全满或 setDpr 时发生）。shrink=true 时页数收缩回 1 释放画布内存。
  private resetAll(shrink = false): void {
    this.glyphs.clear();
    this.packer.reset();
    if (shrink) this.pages.length = 1;
    for (const p of this.pages) {
      p.ctx.clearRect(0, 0, this.pageSize, this.pageSize);
      p.dirty = null;
    }
    this.generation++;
    this._reset = true;
    this.drawWhiteBlock();
  }

  // 按 key 取已缓存字形（HarfBuzz 路径用，避免重复算 extents/path）
  /** 按 key 取已缓存字形，未命中返回 undefined（HarfBuzz 路径复用，避免重复算 extents/path）。 @public */
  getById(key: string): GlyphInfo | undefined {
    return this.glyphs.get(key);
  }

  // 取某样式的字体度量（行高用，与具体字形无关；度量固定用 page0 上下文）
  /** 取并缓存某样式的字体度量（行高用，与具体字形无关）。 @public */
  fontMetrics(style: Style): FontMetrics {
    const key = styleKey(style, this.dpr);
    let m = this.metrics.get(key);
    if (m) return m;
    const ctx = this.pages[0].ctx;
    ctx.font = cssFont(style, this.dpr);
    ctx.textBaseline = 'alphabetic';
    const tm = ctx.measureText('Mg');
    const ascent = Math.ceil(tm.fontBoundingBoxAscent || tm.actualBoundingBoxAscent || style.fontSize * this.dpr * 0.8);
    const descent = Math.ceil(
      tm.fontBoundingBoxDescent || tm.actualBoundingBoxDescent || style.fontSize * this.dpr * 0.2,
    );
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
    const mctx = this.pages[0].ctx; // 度量固定用 page0 上下文
    const font = cssFont(style, this.dpr);
    mctx.font = font;
    mctx.textBaseline = 'alphabetic';
    mctx.textAlign = 'left';
    const tm = mctx.measureText(ch);
    const advance = tm.width;

    const left = Math.ceil(tm.actualBoundingBoxLeft || 0);
    const right = Math.ceil(tm.actualBoundingBoxRight || advance);
    const asc = Math.ceil(tm.actualBoundingBoxAscent || 0);
    const desc = Math.ceil(tm.actualBoundingBoxDescent || 0);
    const w = left + right;
    const h = asc + desc;

    // 不可见字形（空格、换行等）：只占前进量
    if (w <= 0 || h <= 0 || ch === ' ' || ch === '\n' || ch === '\t') {
      return { u0: 0, v0: 0, u1: 0, v1: 0, page: 0, w: 0, h: 0, bearingX: 0, bearingY: 0, advance, empty: true };
    }

    // 巨字形夹紧：k<1 时降采样光栅进单页槽位；GlyphInfo 度量存「全尺寸」设备 px，
    // 渲染 quad 取全尺寸、UV 覆盖缩小位图 → GPU 双线性放大（轻微发糊可接受）。
    // 任何字号都能放进单页 → 尺寸原因的 alloc 失败不复存在，不会触发整体复位。
    const k = Math.min(1, this.packer.maxContent / Math.max(w, h));
    const sw = Math.min(this.packer.maxContent, Math.max(1, Math.ceil(w * k)));
    const sh = Math.min(this.packer.maxContent, Math.max(1, Math.ceil(h * k)));
    const slot = this.alloc(sw, sh);
    if (!slot) {
      return {
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
        page: 0,
        w: 0,
        h: 0,
        bearingX: 0,
        bearingY: 0,
        advance,
        empty: true,
        exhausted: true,
      };
    }
    const { page, ox, oy } = slot;
    const ctx = this.pages[page].ctx;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff'; // 以白色 + alpha 存覆盖率，颜色由顶点色决定
    if (k < 1) {
      // 把笔位放在缩放系内的 (left, asc)，使全尺寸字形正好缩进 (ox,oy,sw,sh)
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(k, k);
      ctx.fillText(ch, left, asc);
      ctx.restore();
    } else {
      // 把笔位放在 (ox+left, oy+asc)，使字形正好落进 (ox,oy,w,h)
      ctx.fillText(ch, ox + left, oy + asc);
    }

    return {
      u0: ox / this.pageSize,
      v0: oy / this.pageSize,
      u1: (ox + sw) / this.pageSize,
      v1: (oy + sh) / this.pageSize,
      page,
      w,
      h,
      bearingX: -(tm.actualBoundingBoxLeft || 0),
      bearingY: asc,
      advance,
      empty: false,
    };
  }

  // —— 按 key（如 hb:r:gid:px）光栅化一个「以字形索引标识」的字形。 ——
  // info 提供 w/h/bearing/advance（设备像素）；draw 在槽内绘制（ctx 是所在页的 2D 上下文）。
  // 用于 HarfBuzz 路径：调用方拿到 glyphId + extents + SVG path 后，自己负责变换与填充。
  /** 按 key 光栅化一个以字形索引标识的字形（HarfBuzz 路径），调用方经 draw 自绘填充；巨字形同样夹紧降采样。 @public */
  addGlyphById(
    key: string,
    info: { w: number; h: number; bearingX: number; bearingY: number; advance: number; empty: boolean },
    draw: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void,
  ): GlyphInfo {
    const cached = this.glyphs.get(key);
    if (cached) return cached;

    let g: GlyphInfo;
    if (info.empty || info.w <= 0 || info.h <= 0) {
      g = {
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
        page: 0,
        w: 0,
        h: 0,
        bearingX: info.bearingX,
        bearingY: info.bearingY,
        advance: info.advance,
        empty: true,
      };
    } else {
      const k = Math.min(1, this.packer.maxContent / Math.max(info.w, info.h));
      const sw = Math.min(this.packer.maxContent, Math.max(1, Math.ceil(info.w * k)));
      const sh = Math.min(this.packer.maxContent, Math.max(1, Math.ceil(info.h * k)));
      const slot = this.alloc(sw, sh);
      if (!slot) {
        g = {
          u0: 0,
          v0: 0,
          u1: 0,
          v1: 0,
          page: 0,
          w: 0,
          h: 0,
          bearingX: info.bearingX,
          bearingY: info.bearingY,
          advance: info.advance,
          empty: true,
          exhausted: true,
        };
      } else {
        const ctx = this.pages[slot.page].ctx;
        if (k < 1) {
          // 围绕槽位左上角缩放：draw 以全尺寸绘制，落点被映射进 (ox,oy,sw,sh)
          ctx.save();
          ctx.translate(slot.ox, slot.oy);
          ctx.scale(k, k);
          ctx.translate(-slot.ox, -slot.oy);
          draw(ctx, slot.ox, slot.oy);
          ctx.restore();
        } else {
          draw(ctx, slot.ox, slot.oy);
        }
        g = {
          u0: slot.ox / this.pageSize,
          v0: slot.oy / this.pageSize,
          u1: (slot.ox + sw) / this.pageSize,
          v1: (slot.oy + sh) / this.pageSize,
          page: slot.page,
          w: info.w,
          h: info.h,
          bearingX: info.bearingX,
          bearingY: info.bearingY,
          advance: info.advance,
          empty: false,
        };
      }
    }
    if (!g.exhausted) this.glyphs.set(key, g); // 满载失败不缓存
    return g;
  }

  // —— 槽位分配：packer 算坐标；全部页满时整体复位重试一次（兜底，复位后必成功）；
  //    架满开的新页在此补画布；成功分配累计该页脏区（含 PAD 边距）。 ——
  private alloc(w: number, h: number): { page: number; ox: number; oy: number } | null {
    let slot = this.packer.alloc(w, h);
    if (!slot && !this._resetting) {
      this._resetting = true; // 防重入：每次布局至多整体复位一次
      this.resetAll();
      slot = this.packer.alloc(w, h); // 复位后重试一次
      this._resetting = false;
    }
    if (!slot) return null;
    while (this.pages.length < this.packer.pageCount) this.pages.push(this.newPage());
    const p = this.pages[slot.page];
    p.dirty = unionRect(p.dirty, { x: slot.ox - PAD, y: slot.oy - PAD, w: w + PAD * 2, h: h + PAD * 2 });
    return slot;
  }

  private newPage(): AtlasPage {
    const canvas = this.createCanvas();
    canvas.width = this.pageSize;
    canvas.height = this.pageSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.clearRect(0, 0, this.pageSize, this.pageSize);
    return { canvas, ctx, dirty: null };
  }

  // 写入 2×2 白块（复位态下首次分配，槽位确定且恒在 page 0）
  private drawWhiteBlock(): { ox: number; oy: number } {
    const slot = this.alloc(2, 2);
    if (!slot || slot.page !== 0) throw new Error('white block alloc failed'); // 复位态必成功
    const ctx = this.pages[0].ctx;
    ctx.fillStyle = '#fff';
    ctx.fillRect(slot.ox, slot.oy, 2, 2);
    return { ox: slot.ox, oy: slot.oy };
  }
}
