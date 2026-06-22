// 块级布局缓存（text 分层）：以 Block 引用为键（WeakMap）缓存单块的「相对几何」
// （行盒/字形/装饰/高亮 y 以块顶为原点；x 由布局 epoch 担保），layoutDoc 装配循环按
// (blockVersion, orderedNum) 命中后整体平移物化，免去 grapheme 切分/整形/caretMap 构建三大头。
// 失效模型：块内变更走 model/block-version 的显式版本；全局条件（宽度/比例/整形器/主题/图集代）
// 收敛进 LayoutEpoch，beginPass 比对任一字段变化即整体清空。
import type { Block } from '../model/schema';
import type { PositionedGlyph } from '../types';
import type { Shaper } from './shaper';
import type { SolidRect } from './doc-layout';

/**
 * 去掉块号、y 以块顶为原点的视觉行盒（缓存形态）。
 * 物化时由装配层补 `block`（块号随 splice 漂移，不得烤进缓存）并加 blockTop 平移。
 * @public
 */
export interface RelLineBox {
  top: number;
  bottom: number;
  baseline: number;
  startOffset: number;
  endOffset: number;
  offsets: number[];
  xs: number[];
  minX: number;
  maxX: number;
  rtl: boolean;
}

/** 行内原子覆盖盒的缓存形态（y 相对块顶；block 由装配层重盖）。 @public */
export interface RelInlineOverlay {
  offset: number;
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 单个文本块的完整相对几何（构建一次、跨帧复用）。
 * glyphs 的 baselineY、decorations/highlights/inlineOverlays 的 y 均相对块顶；
 * penX/x 为绝对设备 px（其有效性由 epoch 的 width/padL/scale 担保）。
 * glyphRange/decoRange/hlRange 与 lines 一一对应，记录每行在本块各几何数组中的
 * `[start, end)` 区间，供装配层换算为全文绝对下标（视口剔除消费）。
 * @public
 */
export interface BlockGeom {
  /** 构建时的 blockVersion(blk)，不匹配即陈旧。 */ version: number;
  /** ordered_item 编号指纹（非有序项恒 0）：编号链重算后自动失配重建。 */ orderedNum: number;
  /** 首行 top(=0) 到末行 bottom 的内容高（不含 sBefore/sAfter）。 */ linesH: number;
  lines: RelLineBox[];
  glyphs: PositionedGlyph[];
  decorations: SolidRect[];
  highlights: SolidRect[];
  inlineOverlays: RelInlineOverlay[];
  glyphRange: [number, number][];
  decoRange: [number, number][];
  hlRange: [number, number][];
}

/**
 * 一遍布局的全局条件指纹：任一字段变化 → 缓存整体失效。
 * - width/padL/padT/scale：DocLayoutOpts 四元组（缩放/视图模式/画布宽变化全清）；
 * - shaper：引用相等（canvas/harfbuzz 切换全清）；
 * - theme：activeTheme() 名（palette C 被原地改写、颜色烤进缓存，主题切换全清）；
 * - atlasGen：GlyphAtlas.generation（复位/setDpr 后缓存的 GlyphInfo UV 指向已清画布，
 *   漏带此项会整屏花字——最隐蔽的正确性点）。
 * @public
 */
export interface LayoutEpoch {
  width: number;
  padL: number;
  padT: number;
  scale: number;
  shaper: Shaper;
  theme: string;
  atlasGen: number;
}

/** 块级布局缓存：WeakMap<Block, BlockGeom> + epoch 整体失效。 @public */
export class BlockLayoutCache {
  private geo = new WeakMap<Block, BlockGeom>();
  private epoch: LayoutEpoch | null = null;

  /** 开始一遍布局：与上一遍的 epoch 任一字段不等 → 整体清空缓存。 @public */
  beginPass(e: LayoutEpoch): void {
    const p = this.epoch;
    if (
      !p ||
      p.width !== e.width ||
      p.padL !== e.padL ||
      p.padT !== e.padT ||
      p.scale !== e.scale ||
      p.shaper !== e.shaper ||
      p.theme !== e.theme ||
      p.atlasGen !== e.atlasGen
    ) {
      this.geo = new WeakMap();
      this.epoch = e;
    }
  }

  /** 按 (块引用, 版本, 有序编号) 取缓存；版本或编号不匹配返回 null（陈旧）。 @public */
  get(blk: Block, version: number, orderedNum: number): BlockGeom | null {
    const g = this.geo.get(blk);
    return g && g.version === version && g.orderedNum === orderedNum ? g : null;
  }

  /** 写入某块的相对几何。 @public */
  set(blk: Block, g: BlockGeom): void {
    this.geo.set(blk, g);
  }
}
