import { AtlasRect } from '../render/renderer';

// text 层 · 多页货架打包的纯算术：行满换架、架满开新页、达页上限返回 null（由调用方整体复位兜底）。
// 不触碰 canvas/GPU —— GlyphAtlas 持有它做槽位分配，使打包不变量可以在 node 环境直接单测。

/** 一次槽位分配结果：页号 + 内容左上角（页内坐标，已含内边距）。 @public */
export interface PackSlot { page: number; ox: number; oy: number }

// 单页货架游标：penX/penY 为当前架行的写入点（含边距），shelfH 为当前架行高（含边距）。
interface PageCursor { penX: number; penY: number; shelfH: number }

/** 并集两个矩形（a 可为 null 表示空），用于累积每页脏区。 @public */
export function unionRect(a: AtlasRect | null, b: AtlasRect): AtlasRect {
  if (!a) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 多页货架打包器：只在末页（当前开放页）分配，行满换架、架满开新页（已放槽位全部保持有效），
 * 达到页数上限后返回 null —— 整体复位与否由调用方（GlyphAtlas）决策。
 * 不变量：返回的槽位（含四周 pad 边距）互不重叠且不越页界。 @public
 */
export class ShelfPacker {
  private cursors: PageCursor[];

  constructor(
    /** 单页边长（设备 px）。 @public */
    readonly pageSize: number,
    /** 页数上限，满后 alloc 返回 null。 @public */
    readonly maxPages: number,
    /** 槽位四周留边（防 LINEAR 采样串色）。 @public */
    readonly pad: number,
  ) {
    this.cursors = [this.newCursor()];
  }

  /** 当前已开页数。 @public */
  get pageCount(): number { return this.cursors.length; }

  /**
   * 单个槽允许的最大内容边长：双侧 pad + 行首/架顶 pad 各留一份。
   * 不变量：w,h ≤ maxContent 的分配在空页上必然成功（巨字形夹紧到该值即不再有尺寸性失败）。 @public
   */
  get maxContent(): number { return this.pageSize - this.pad * 3; }

  /**
   * 为 w×h 的内容分配一个槽，返回内容左上角与页号；尺寸超限（应先夹紧）或全部页满返回 null。
   * 只在末页分配：行满换架、架满开新页（不触碰已放槽位）。 @public
   */
  alloc(w: number, h: number): PackSlot | null {
    if (w <= 0 || h <= 0 || w > this.maxContent || h > this.maxContent) return null;
    const bw = w + this.pad * 2;
    const bh = h + this.pad * 2;
    for (;;) {
      const page = this.cursors.length - 1;
      const c = this.cursors[page];
      if (c.penX + bw > this.pageSize) { c.penX = this.pad; c.penY += c.shelfH; c.shelfH = 0; } // 行满换架
      if (c.penY + bh <= this.pageSize) {
        const ox = c.penX + this.pad;
        const oy = c.penY + this.pad;
        c.penX += bw;
        c.shelfH = Math.max(c.shelfH, bh);
        return { page, ox, oy };
      }
      if (this.cursors.length >= this.maxPages) return null; // 全部页满：调用方整体复位兜底
      this.cursors.push(this.newCursor()); // 架满开新页：已放槽位 UV 全部有效
    }
  }

  /** 复位为单页空状态（整体逐出后由调用方重画/重栅）。 @public */
  reset(): void {
    this.cursors = [this.newCursor()];
  }

  private newCursor(): PageCursor {
    return { penX: this.pad, penY: this.pad, shelfH: 0 };
  }
}
