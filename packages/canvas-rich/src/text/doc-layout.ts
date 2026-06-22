// 文档布局引擎（text 分层）：把 model 文档整形、断行、BiDi 重排后产出
// 几何化布局（字形/背景/装饰/选区/光标），供 render 层绘制、editor 层命中与光标定位。
// 增量化：文本块主体几何下沉 buildTextBlockGeom（y 以块顶为原点），装配循环经
// BlockLayoutCache 按 (blockVersion, orderedNum) 命中复用，物化时整体平移并重盖块号；
// 原子块 O(1) 不缓存，toc 依赖全文 heading 每遍重排（标题量级小）。
import { Doc, Block, isAtomBlock, isInlineAtom } from '../model/schema';
import { overlaySpecOf } from '../model/block-specs';
import { Pos, comparePos } from '../model/rich-document';
import { StyleResolver, ResolvedBlock } from '../model/style-resolver';
import { blockVersion } from '../model/block-version';
import { C } from '../model/palette';
import { splitGraphemes } from '../model/grapheme';
import { scanToc } from '../model/toc';
import { Shaper } from './shaper';
import { breakLines, BreakItem } from './line-break';
import { embeddingLevels, visualOrder, mayBeBidi } from './bidi';
import { BlockLayoutCache, BlockGeom, RelLineBox, RelInlineOverlay } from './block-layout-cache';
import { lowerBoundIndex } from '../shared/util';
import { PositionedGlyph, Style } from '../types';

/** 带 RGBA 颜色的实心矩形（背景/高亮/装饰/选区的统一几何）。@public */
export interface SolidRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: [number, number, number, number];
}

/** 单视觉行的几何与光标列表（含偏移→x 映射，支持 RTL）。@public */
export interface LineBox {
  block: number;
  top: number;
  bottom: number;
  baseline: number;
  startOffset: number;
  endOffset: number;
  offsets: number[]; // 块内偏移（按 offset 升序，含行末），与 xs 一一对应
  xs: number[]; // 对应每个偏移的光标 x（设备 px；RTL 时随 offset 递减）
  // 视觉行左/右边界（设备 px）。布局时按排字 pen 的起止精确记录，与排字顺序无关；
  // 选区在 RTL 下取行边界用此字段，避免 Math.min/max(...xs) 依赖 xs 已排序的隐含前提。
  minX: number;
  maxX: number;
  rtl: boolean;
  tocTarget?: number; // 目录(toc)块生成的标题行：点击跳转到的 heading 块号
  // —— 视口剔除支持：本行在 DocLayout.glyphs/decorations/highlights 中的 [start,end) 绝对区间 ——
  // layoutDoc 恒回填；paginateLayout 对行与几何做 1:1 平移映射，区间下标保持有效（契约见 paginate.ts）。
  // 手工构造的最小 LineBox（测试/命中辅助）可省略——消费方（装配层剔除）只读 layoutDoc 产物。
  glyphStart?: number;
  glyphEnd?: number;
  decoStart?: number;
  decoEnd?: number;
  hlStart?: number;
  hlEnd?: number;
}

/** 原子块的覆盖层类型（图片/公式/表格/形状/音频/视频/内嵌网页/附件/电子签名/印章/文本框）。@public */
export type OverlayKind =
  | 'image'
  | 'formula'
  | 'table'
  | 'shape'
  | 'audio'
  | 'video'
  | 'iframe'
  | 'attachment'
  | 'signature'
  | 'seal'
  | 'textbox';
/** 原子块占位框，交由 DOM 覆盖层渲染。@public */
export interface OverlayBox {
  block: number;
  kind: OverlayKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 行内原子（如行内图片）的覆盖层盒：定位到所在视觉行的行内 x/baseline，
 * 由 DOM 覆盖层渲染、随重排/滚动同步。x/y/w/h 为设备 px（已乘 dpr）。
 * block + offset 唯一标识该原子在文档中的位置（缓存键）。@public
 */
export interface InlineOverlayBox {
  block: number;
  offset: number;
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一次布局的完整几何产物（背景/高亮/字形/装饰/覆盖层/行/尺寸）。@public */
export interface DocLayout {
  backgrounds: SolidRect[]; // 块背景（代码块等），最底层
  highlights: SolidRect[]; // 文字背景高亮
  glyphs: PositionedGlyph[];
  decorations: SolidRect[]; // 下划线 + 删除线
  overlays: OverlayBox[]; // 原子块（图片/公式/表格）→ DOM 覆盖层渲染
  inlineOverlays: InlineOverlayBox[]; // 行内原子（行内图片）→ DOM 覆盖层渲染
  lines: LineBox[];
  contentHeight: number;
  contentRight: number;
  dpr: number;
}

/** 布局入参：内容宽度、左/上内边距、设备像素比。 @public */
export interface DocLayoutOpts {
  width: number;
  padL: number;
  padT: number;
  dpr: number;
}

type RGBA = [number, number, number, number];
// atomW/atomH（设备 px）非空表示该 El 是行内原子：advance=显示宽、无 glyph，产出行内覆盖盒。
interface El {
  ch: string;
  style: Style;
  underline: RGBA | null;
  strike: RGBA | null;
  highlight: RGBA | null;
  baselineShift: number;
  uStart: number;
  atomW?: number;
  atomH?: number;
}

/**
 * 构建单个文本块的相对几何（y 以块顶为原点；x 绝对，由 epoch 担保）：
 * 展开 El（grapheme 粒度）→ 整形 → 断行 → BiDi → 逐行排字/marker/caretMap，
 * 并记录每行 glyph/装饰/高亮的 [start,end) 区间。块号不烤入（装配层物化时重盖）。
 * @internal
 */
function buildTextBlockGeom(
  blk: Block,
  rb: ResolvedBlock,
  orderedNum: number,
  version: number,
  shaper: Shaper,
  resolver: StyleResolver,
  opt: DocLayoutOpts,
  contentLeft: number,
  contentRight: number,
): BlockGeom {
  const lines: RelLineBox[] = [];
  const glyphs: PositionedGlyph[] = [];
  const decorations: SolidRect[] = [];
  const highlights: SolidRect[] = [];
  const inlineOverlays: RelInlineOverlay[] = [];
  const glyphRange: [number, number][] = [];
  const decoRange: [number, number][] = [];
  const hlRange: [number, number][] = [];

  const x0 = contentLeft + rb.indent * opt.dpr;
  const wrapW = Math.max(20, contentRight - x0);
  const rtl = blk.attrs.dir === 'rtl';
  // align：'justify'/'distribute' 把行内空隙(slack)分摊（末行不拉伸）；其余按左/中/右锚定
  const align = blk.attrs.align ?? (rtl ? 'right' : 'left');
  const letterSpacingDev = rb.letterSpacing * opt.dpr;

  // —— 展开成元素（grapheme 粒度，带块内 UTF-16 偏移）——
  const els: El[] = [];
  let uOff = 0;
  for (const run of blk.inlines) {
    // 行内原子：占 1 offset，产 1 个 El（无 glyph，advance=显示宽，记录 atomW/atomH 给覆盖层）。
    // 最小可用版本：显示高度固定 ~1.2em（base 字号），宽度取 attrs.width（无则方形=高度）。
    if (isInlineAtom(run)) {
      const emH = rb.base.fontSize * 1.2 * opt.dpr; // ~1.2em 高
      const atomH = run.attrs.height ? run.attrs.height * opt.dpr : emH;
      const atomW = run.attrs.width ? run.attrs.width * opt.dpr : atomH; // 无宽则方形
      // 占位字符用原子占位符（非空格）：参与断行/BiDi 但不被当作空格（不触发 justify 拉伸、
      // 不作软换行点）；其 advance 后续被 atomW 覆盖，glyph 在排字阶段跳过
      els.push({
        ch: run.text,
        style: rb.base,
        underline: null,
        strike: null,
        highlight: null,
        baselineShift: 0,
        uStart: uOff,
        atomW,
        atomH,
      });
      uOff += run.text.length; // 原子占 1 个 UTF-16 offset
      continue;
    }
    const rr = resolver.resolveRun(blk, run.marks);
    for (const g of splitGraphemes(run.text)) {
      els.push({
        ch: g,
        style: rr.style,
        underline: rr.underline,
        strike: rr.strike,
        highlight: rr.highlight,
        baselineShift: rr.baselineShift,
        uStart: uOff,
      });
      uOff += g.length;
    }
  }

  const shaped = shaper.shapeChars(els.map((e) => ({ ch: e.ch, style: e.style })));
  // 行内原子：用 atomW 覆盖 shaper 的占位字 advance（显示宽 = atomW）
  for (let i = 0; i < els.length; i++)
    if (els[i].atomW !== undefined) shaped[i] = { ...shaped[i], advance: els[i].atomW! };
  const items: BreakItem[] = els.map((e, i) => ({
    advance: shaped[i].advance,
    isSpace: e.ch === ' ',
    isNewline: false,
  }));
  const lineRuns = els.length ? breakLines(items, wrapW) : [[]];
  const baseM = shaper.fontMetrics(rb.base);
  // BiDi：仅在含 RTL 或 base 为 rtl 时计算 embedding levels（纯 LTR 跳过开销）
  const blockStr = els.map((e) => e.ch).join('');
  const charLevels = mayBeBidi(blockStr, rtl) ? embeddingLevels(blockStr, rtl ? 'rtl' : 'ltr') : null;

  let y = 0; // 相对块顶

  for (let li = 0; li < lineRuns.length; li++) {
    const le = lineRuns[li];
    const gStart = glyphs.length,
      dStart = decorations.length,
      hStart = highlights.length;
    // 行度量
    let ascent = baseM.ascent,
      descent = baseM.descent,
      lineH = baseM.lineHeight;
    for (const ei of le) {
      const m = shaper.fontMetrics(els[ei].style);
      ascent = Math.max(ascent, m.ascent);
      descent = Math.max(descent, m.descent);
      lineH = Math.max(lineH, m.lineHeight);
      // 行内原子：高度坐落于基线之上，撑高 ascent 与行高，使图片完整落在行盒内
      const aH = els[ei].atomH;
      if (aH !== undefined) {
        ascent = Math.max(ascent, aH);
        lineH = Math.max(lineH, aH + descent);
      }
    }
    void descent;
    // 行距：自然行高 × lineHeight 倍数；多余行距等分到上下，使文字垂直居中于行盒
    lineH *= rb.lineHeight;
    const lead = lineH - (ascent + descent); // 自然行高之外的多余行距（含 lineHeight 放大量）
    const top = y,
      bottom = y + lineH,
      baseline = y + ascent + Math.max(0, lead) / 2;

    // 每元素有效 advance = 基础 advance + 字间距（letterSpacing），caret/选区随之同步
    const adv = le.map((ei) => shaped[ei].advance + letterSpacingDev);
    // 对齐：行视觉宽度（含字间距）→ 起始左锚 + 行内 slack 分摊策略
    let lineW = 0;
    for (const a of adv) lineW += a;
    const slack = Math.max(0, wrapW - lineW);
    const isLastLine = li === lineRuns.length - 1;
    // justify：slack 分摊给空格元素；distribute：slack 分摊给所有「字间」（元素间隙）；末行不拉伸
    let startX = x0;
    if (align === 'center') startX = x0 + slack / 2;
    else if (align === 'right') startX = x0 + slack;
    else if ((align === 'justify' || align === 'distribute') && !isLastLine && le.length > 0) {
      if (align === 'justify') {
        // 末尾空格不参与拉伸（视觉序无关，按逻辑元素判定）
        const spaceIdx: number[] = [];
        for (let k = 0; k < le.length; k++) if (els[le[k]].ch === ' ') spaceIdx.push(k);
        while (spaceIdx.length && spaceIdx[spaceIdx.length - 1] === le.length - 1) spaceIdx.pop();
        if (spaceIdx.length > 0) {
          const add = slack / spaceIdx.length;
          for (const k of spaceIdx) adv[k] += add;
        }
      } else {
        // distribute：n 元素有 n-1 个字间，slack 均分到每个间隙（加到除末元素外的每个 advance）
        if (le.length > 1) {
          const add = slack / (le.length - 1);
          for (let k = 0; k < le.length - 1; k++) adv[k] += add;
        }
      }
    }

    // 项目符号 / 有序编号（仅首行；RTL 放右侧）
    const markerText = li === 0 ? (rb.marker ?? (rb.ordered ? `${orderedNum}.` : null)) : null;
    if (markerText) {
      const mshaped = shaper.shapeChars(splitGraphemes(markerText).map((ch) => ({ ch, style: rb.base })));
      let mw = 0;
      for (const s of mshaped) mw += s.advance;
      let mxp = rtl ? x0 + wrapW + 8 * opt.dpr : x0 - mw - 8 * opt.dpr;
      for (const s of mshaped) {
        if (!s.glyph.empty)
          glyphs.push({ info: s.glyph, penX: mxp + s.glyph.bearingX, baselineY: baseline, color: rb.base.color });
        mxp += s.advance;
      }
    }

    // BiDi 视觉序（L2）：纯 LTR 时为恒等序；混排时按 embedding level 重排
    const elemLevels = charLevels ? le.map((ei) => charLevels[els[ei].uStart] ?? (rtl ? 1 : 0)) : le.map(() => 0);
    const vorder = charLevels ? visualOrder(elemLevels) : le.map((_, i) => i);

    // 按视觉序左→右排字；光标列按 level 取前/后缘（BiDi 光标规则）。
    // 注：相邻元素 A.end 与 B.start 同 offset 会写同一 caretMap 键。LTR 下 penX 连续，
    //   两值恒相等，覆盖无害（含 letterSpacing：cell 已含字间距，penX 仍连续）。
    //   BiDi/RTL 下 A、B 视觉不相邻时两值可不同，按视觉序后写者胜——这是 BiDi 分裂光标
    //   的固有歧义（split caret），无法在不改 caret 语义/不破坏现有 RTL 行为下消除，故保留现状。
    let penX = startX;
    const caretMap = new Map<number, number>();
    const decoH = Math.max(1, Math.round(1.5 * opt.dpr));
    for (let v = 0; v < vorder.length; v++) {
      const lj = vorder[v];
      const e = els[le[lj]];
      const sh = shaped[le[lj]];
      const cell = adv[lj]; // 有效 advance（含字间距 / justify·distribute 分摊）
      const left = penX,
        right = penX + cell;
      const rtlEl = elemLevels[lj] % 2 === 1;
      caretMap.set(e.uStart, rtlEl ? right : left);
      caretMap.set(e.uStart + e.ch.length, rtlEl ? left : right);
      // 行内原子（行内图片）：不画字形，产出行内覆盖盒（坐落基线之上，宽=atomW、高=atomH）。
      // x 取视觉左缘 left（BiDi 下也成立）；y 让图片底边贴基线，随重排/滚动由 overlays 同步。
      if (e.atomW !== undefined && e.atomH !== undefined) {
        inlineOverlays.push({
          offset: e.uStart,
          kind: 'image',
          x: left,
          y: baseline - e.atomH,
          w: e.atomW,
          h: e.atomH,
        });
        penX = right;
        continue;
      }
      // 上/下标：基线按 baselineShift × 当前字号偏移（正=上移即更小的 y）
      const elBaseline = baseline - e.baselineShift * e.style.fontSize * opt.dpr;
      if (e.highlight) highlights.push({ x: left, y: top, w: cell, h: bottom - top, color: e.highlight });
      if (!sh.glyph.empty)
        glyphs.push({ info: sh.glyph, penX: left + sh.glyph.bearingX, baselineY: elBaseline, color: e.style.color });
      if (e.underline)
        decorations.push({ x: left, y: elBaseline + Math.round(2 * opt.dpr), w: cell, h: decoH, color: e.underline });
      if (e.strike)
        decorations.push({
          x: left,
          y: elBaseline - Math.round(shaper.fontMetrics(e.style).ascent * 0.32),
          w: cell,
          h: decoH,
          color: e.strike,
        });
      penX = right;
    }
    if (le.length === 0) caretMap.set(0, startX);

    // 视觉行边界 = 排字 pen 的起止（startX..penX），与排字/视觉顺序无关，精确且不依赖 xs 排序。
    const minX = Math.min(startX, penX),
      maxX = Math.max(startX, penX);
    // offsets 按块内 offset 升序排列、xs 同步重排：保证 nearestIndex 的 tie-break 稳定
    // （等距时取 offset 较小者），且下游遍历不再依赖 Map 插入序（BiDi/RTL 下插入序非单调）。
    const offsets = [...caretMap.keys()].sort((a, b) => a - b);
    const xs = offsets.map((o) => caretMap.get(o)!);
    const endOff = le.length ? els[le[le.length - 1]].uStart + els[le[le.length - 1]].ch.length : 0;
    lines.push({
      top,
      bottom,
      baseline,
      startOffset: le.length ? els[le[0]].uStart : 0,
      endOffset: endOff,
      offsets,
      xs,
      minX,
      maxX,
      rtl,
    });
    glyphRange.push([gStart, glyphs.length]);
    decoRange.push([dStart, decorations.length]);
    hlRange.push([hStart, highlights.length]);
    y = bottom;
  }

  return {
    version,
    orderedNum,
    linesH: y,
    lines,
    glyphs,
    decorations,
    highlights,
    inlineOverlays,
    glyphRange,
    decoRange,
    hlRange,
  };
}

/**
 * 将文档整形、断行、BiDi 重排并对齐，产出可绘制的几何布局。
 * @param cache - 可选块级布局缓存：传入时文本块几何按 (blockVersion, orderedNum) 命中复用；
 *   省略时每块全量构建（行为与产物完全一致——两路径共用同一构建/物化代码）。
 *   调用方负责在每遍布局前 {@link BlockLayoutCache.beginPass}（epoch 失效）。
 * @public
 */
export function layoutDoc(
  doc: Doc,
  shaper: Shaper,
  resolver: StyleResolver,
  opt: DocLayoutOpts,
  cache?: BlockLayoutCache,
): DocLayout {
  const backgrounds: SolidRect[] = [];
  const highlights: SolidRect[] = [];
  const glyphs: PositionedGlyph[] = [];
  const decorations: SolidRect[] = [];
  const overlays: OverlayBox[] = [];
  const inlineOverlays: InlineOverlayBox[] = [];
  const lines: LineBox[] = [];
  const contentLeft = opt.padL;
  const contentRight = opt.width - opt.padL;
  let y = opt.padT;
  let orderedNum = 0; // 连续 ordered_item 的编号
  let codeBg: SolidRect | null = null; // 连续代码块共用背景

  for (let bi = 0; bi < doc.blocks.length; bi++) {
    const blk = doc.blocks[bi];
    const rb = resolver.resolveBlock(blk);
    orderedNum = blk.type === 'ordered_item' ? orderedNum + 1 : 0;
    const prevType = bi > 0 ? doc.blocks[bi - 1].type : null;
    if (blk.type !== 'code_block') codeBg = null;

    // 原子块（图片/公式/表格）：保留高度，记录位置给 DOM 覆盖层；光标只落 {block,0}。
    // 尺寸策略/默认值查覆盖层规格 SSOT（blockSpecs.overlaySpecOf），不再逐 kind 写三元链。
    // 几何 O(1) 无整形 → 不进块缓存。
    if (isAtomBlock(blk.type)) {
      const sb = 8 * opt.dpr;
      y += sb;
      const contentW = contentRight - contentLeft;
      const spec = overlaySpecOf(blk.type);
      let w: number,
        h: number,
        x = contentLeft;
      if (spec.sizing === 'explicit') {
        // 显式尺寸：显示宽取 attrs.width（缺省查表 defaultW，image 无默认 → 满内容宽；夹到内容宽），
        // 高取 attrs.height（缺省查表 defaultH）；按 align 水平定位
        const wCss = Math.min(blk.attrs.width ?? spec.defaultW ?? contentW / opt.dpr, contentW / opt.dpr);
        w = Math.max(40 * opt.dpr, wCss * opt.dpr);
        h = (blk.attrs.height ?? spec.defaultH ?? 0) * opt.dpr;
        const al = blk.attrs.align ?? 'left';
        x = al === 'center' ? contentLeft + (contentW - w) / 2 : al === 'right' ? contentRight - w : contentLeft;
      } else if (spec.sizing === 'fullWidth') {
        // 满内容宽，固定高度（音频=播放控件条；附件=文件卡片）
        h = (spec.fixedHeight ?? 0) * opt.dpr;
        w = contentW;
      } else {
        // measured（公式/表格）：满内容宽，高度用实测回填（缺省占位高查表，兜底 120）
        h = (blk.attrs.measuredH ?? spec.defaultH ?? 120) * opt.dpr;
        w = contentW;
      }
      // 原子块行：caret 仅落 {block,0}。baseline 取 top+h（盒底）——与文本行的
      // top+ascent+lead/2 语义不同（原子块无字形/无文本度量），caret 走「节点选中外框」
      // 而非等高文本光标（见 main.ts focusAtom 分支），故此差异不影响 caret/选中。
      lines.push({
        block: bi,
        top: y,
        bottom: y + h,
        baseline: y + h,
        startOffset: 0,
        endOffset: 0,
        offsets: [0],
        xs: [contentLeft],
        minX: contentLeft,
        maxX: contentLeft,
        rtl: false,
        glyphStart: glyphs.length,
        glyphEnd: glyphs.length,
        decoStart: decorations.length,
        decoEnd: decorations.length,
        hlStart: highlights.length,
        hlEnd: highlights.length,
      });
      overlays.push({ block: bi, kind: blk.type as OverlayKind, x, y, w, h });
      y += h + sb;
      continue;
    }

    // 目录块：扫描全文 heading，每个标题生成一行（按级缩进 + 携带 tocTarget=heading 块号）。
    // 行的 caret 恒定落在 {block:bi, offset:0}；空文档/无标题时留一行占位提示。
    // toc 依赖全文 heading（文本/级别/方向/块号），永不缓存——每遍重排即天然正确（标题量级小，
    // 整形成本可忽略；块号随 splice 漂移亦无陈旧问题），同时保留 scanToc 的 ensureHeadingId 副作用。
    if (blk.type === 'toc') {
      y += rb.spaceBefore * opt.dpr;
      const entries = scanToc(doc, true);
      const m = shaper.fontMetrics(rb.base);
      const lineH = m.lineHeight;
      const tocRows: { text: string; level: number; target: number }[] = entries.length
        ? entries.map((e) => ({ text: e.text || '（无标题）', level: e.level, target: e.block }))
        : [{ text: '（暂无标题）', level: 1, target: -1 }];
      for (const row of tocRows) {
        const gStart = glyphs.length;
        const top = y,
          bottom = y + lineH,
          baseline = y + m.ascent;
        const rowIndent = (row.level - 1) * 18 * opt.dpr;
        const startX = contentLeft + rowIndent;
        let penX = startX;
        const shapedRow = shaper.shapeChars(splitGraphemes(row.text).map((ch) => ({ ch, style: rb.base })));
        for (const s of shapedRow) {
          if (!s.glyph.empty)
            glyphs.push({ info: s.glyph, penX: penX + s.glyph.bearingX, baselineY: baseline, color: rb.base.color });
          penX += s.advance;
        }
        // 目录项方向跟随目标 heading 的书写方向（dir=rtl 的标题 → 目录项也 rtl），
        // 使 RTL 标题在目录中的选区/方向语义正确；无目标（占位行）时按 LTR。
        const rowRtl = row.target >= 0 && doc.blocks[row.target]?.attrs.dir === 'rtl';
        const ln: LineBox = {
          block: bi,
          top,
          bottom,
          baseline,
          startOffset: 0,
          endOffset: 0,
          offsets: [0],
          xs: [contentLeft],
          minX: contentLeft,
          maxX: contentLeft,
          rtl: rowRtl,
          glyphStart: gStart,
          glyphEnd: glyphs.length,
          decoStart: decorations.length,
          decoEnd: decorations.length,
          hlStart: highlights.length,
          hlEnd: highlights.length,
        };
        if (row.target >= 0) ln.tocTarget = row.target;
        lines.push(ln);
        y = bottom;
      }
      y += rb.spaceAfter * opt.dpr;
      continue;
    }

    // —— 文本块：缓存命中（版本 + 有序编号匹配）或构建相对几何，再整体平移物化 ——
    const version = blockVersion(blk);
    let g = cache?.get(blk, version, orderedNum) ?? null;
    if (!g) {
      g = buildTextBlockGeom(blk, rb, orderedNum, version, shaper, resolver, opt, contentLeft, contentRight);
      cache?.set(blk, g);
    }

    const sBefore = blk.type === 'code_block' && prevType === 'code_block' ? 0 : rb.spaceBefore;
    y += sBefore * opt.dpr;
    const blockTop = y;

    // 物化：逐项拷贝并加 blockTop 偏移；块号在此重盖（缓存不得烤进 bi，splice 后下标漂移）。
    const gBase = glyphs.length,
      dBase = decorations.length,
      hBase = highlights.length;
    for (const pg of g.glyphs)
      glyphs.push({ info: pg.info, penX: pg.penX, baselineY: pg.baselineY + blockTop, color: pg.color });
    for (const r of g.decorations) decorations.push({ x: r.x, y: r.y + blockTop, w: r.w, h: r.h, color: r.color });
    for (const r of g.highlights) highlights.push({ x: r.x, y: r.y + blockTop, w: r.w, h: r.h, color: r.color });
    for (const ov of g.inlineOverlays)
      inlineOverlays.push({
        block: bi,
        offset: ov.offset,
        kind: ov.kind,
        x: ov.x,
        y: ov.y + blockTop,
        w: ov.w,
        h: ov.h,
      });
    for (let li = 0; li < g.lines.length; li++) {
      const rl = g.lines[li];
      lines.push({
        block: bi,
        top: rl.top + blockTop,
        bottom: rl.bottom + blockTop,
        baseline: rl.baseline + blockTop,
        startOffset: rl.startOffset,
        endOffset: rl.endOffset,
        offsets: rl.offsets,
        xs: rl.xs,
        minX: rl.minX,
        maxX: rl.maxX,
        rtl: rl.rtl,
        glyphStart: gBase + g.glyphRange[li][0],
        glyphEnd: gBase + g.glyphRange[li][1],
        decoStart: dBase + g.decoRange[li][0],
        decoEnd: dBase + g.decoRange[li][1],
        hlStart: hBase + g.hlRange[li][0],
        hlEnd: hBase + g.hlRange[li][1],
      });
    }
    y += g.linesH;

    // 块背景（代码块）：连续代码块合并为一个连续背景，避免条纹空隙。
    // 背景只需 blockTop/块高/内容左右缘（装配层全知道），从块内几何剥离——不进缓存。
    if (rb.background) {
      const padV = Math.round(4 * opt.dpr);
      if (codeBg && prevType === 'code_block') codeBg.h = y + padV - codeBg.y;
      else {
        codeBg = {
          x: contentLeft,
          y: blockTop - padV,
          w: contentRight - contentLeft,
          h: y - blockTop + padV * 2,
          color: rb.background,
        };
        backgrounds.push(codeBg);
      }
    }

    const nextType = bi + 1 < doc.blocks.length ? doc.blocks[bi + 1].type : null;
    const sAfter = blk.type === 'code_block' && nextType === 'code_block' ? 0 : rb.spaceAfter;
    y += sAfter * opt.dpr;
  }

  return {
    backgrounds,
    highlights,
    glyphs,
    decorations,
    overlays,
    inlineOverlays,
    lines,
    contentHeight: y - opt.padT,
    contentRight,
    dpr: opt.dpr,
  };
}

// 软换行点 affinity：同一 offset 既是上一视觉行尾(before)又是下一视觉行首(after)。
/** 软换行边界的归属偏好：行尾(before)或行首(after)。@public */
export type Affinity = 'before' | 'after';

/** 选出 pos 所属的视觉行，用 affinity 消歧软换行边界。@public */
export function caretLine(L: DocLayout, pos: Pos, affinity: Affinity = 'after'): LineBox | null {
  const cands = L.lines.filter(
    (ln) => ln.block === pos.block && pos.offset >= ln.startOffset && pos.offset <= ln.endOffset,
  );
  if (cands.length === 0) return null;
  if (affinity === 'before')
    return (
      cands.find((ln) => ln.endOffset === pos.offset && ln.startOffset !== pos.offset) ??
      cands.find((ln) => ln.endOffset === pos.offset) ??
      cands[0]
    );
  return cands.find((ln) => ln.startOffset === pos.offset) ?? cands[cands.length - 1];
}

// —— 光标盒 ——
/** 计算 pos 处的光标盒（x 与上下边），无对应行时返回 null。@public */
export function caretAt(
  L: DocLayout,
  pos: Pos,
  affinity: Affinity = 'after',
): { x: number; top: number; bottom: number } | null {
  const line = caretLine(L, pos, affinity);
  if (!line) return null;
  const i = nearestIndex(line.offsets, pos.offset);
  return { x: line.xs[i], top: line.top, bottom: line.bottom };
}

/** 返回垂直方向上离 py 最近的视觉行，空布局时返回 null。@public */
export function nearestLine(L: DocLayout, py: number): LineBox | null {
  if (L.lines.length === 0) return null;
  let line = L.lines[0],
    best = Infinity;
  for (const ln of L.lines) {
    const d = py < ln.top ? ln.top - py : py > ln.bottom ? py - ln.bottom : 0;
    if (d < best) {
      best = d;
      line = ln;
    }
  }
  return line;
}

// —— 命中测试：屏幕坐标 → Pos ——
/** 命中测试：把设备坐标 (px,py) 映射为最近的文档位置 Pos。@public */
export function hitTestDoc(L: DocLayout, px: number, py: number): Pos {
  const line = nearestLine(L, py);
  if (!line) return { block: 0, offset: 0 };
  let bi = 0,
    bdx = Infinity;
  for (let i = 0; i < line.xs.length; i++) {
    const dx = Math.abs(px - line.xs[i]);
    if (dx < bdx) {
      bdx = dx;
      bi = i;
    }
  }
  return { block: line.block, offset: line.offsets[bi] };
}

/**
 * 二分可见行窗口 `[i0, i1)`：lines 的 top/bottom 随文档序单调升序（块间距经 setter clamp ≥0、
 * 主题值非负，当前不变量成立；paginateLayout 的平移单调不减，word 视图同样适用）。
 * 含 ±1 行缓冲（装饰可微越行界）。`lineTops/lineBottoms` 为 lines 对应字段的预提数组
 * （重排帧构建一次，滚动帧零分配二分）。
 * @param viewTop - 视口顶（内容坐标，= scrollY）
 * @param viewBottom - 视口底（内容坐标，= scrollY + 视口高）
 * @public
 */
export function visibleLineRange(
  lineTops: ArrayLike<number>,
  lineBottoms: ArrayLike<number>,
  viewTop: number,
  viewBottom: number,
): [number, number] {
  const n = lineTops.length;
  if (n === 0) return [0, 0];
  // i0 = 首个 bottom > viewTop 的行（lowerBoundIndex 返回最大的 k 使 arr[k] <= target；
  // arr[0] > target 时同样返回 0，需先行甄别）。
  const i0 = lineBottoms[0] > viewTop ? 0 : lowerBoundIndex(lineBottoms, viewTop) + 1;
  // i1 = 末个 top <= viewBottom 的行 + 1（top 恰等于视口底的行多含一行，缓冲内无害）。
  const i1 = lineTops[0] > viewBottom ? 0 : lowerBoundIndex(lineTops, viewBottom) + 1;
  return [Math.max(0, i0 - 1), Math.min(n, i1 + 1)];
}

// —— 跨块选区矩形（from<=to）——
/**
 * 生成 [from,to] 选区的逐行高亮矩形（含空行换行带、RTL 方向）。
 * @param i0 - 可选行窗起（含）：拖选/渲染时传可见行窗口，扫描从 O(全文行) 降到 O(可见行)
 * @param i1 - 可选行窗止（不含）；缺省全量，旧调用兼容
 * @public
 */
export function selectionRects(L: DocLayout, from: Pos, to: Pos, i0 = 0, i1: number = L.lines.length): SolidRect[] {
  const rects: SolidRect[] = [];
  const sel: [number, number, number, number] = C.selection;
  for (let i = i0; i < i1; i++) {
    const ln = L.lines[i];
    const lineStart: Pos = { block: ln.block, offset: ln.startOffset };
    const lineEnd: Pos = { block: ln.block, offset: ln.endOffset };
    // 整行在选区前则跳过；但「空行且正好是选区起点、且选区跨过它」要保留（画换行高亮带）
    const emptyLine = ln.startOffset === ln.endOffset;
    if (
      comparePos(lineEnd, from) <= 0 &&
      !(emptyLine && comparePos(lineStart, from) === 0 && comparePos(lineEnd, to) < 0)
    )
      continue;
    if (comparePos(lineStart, to) >= 0) continue; // 整行在选区后
    const sOff = ln.block === from.block ? Math.max(ln.startOffset, from.offset) : ln.startOffset;
    const eOff = ln.block === to.block ? Math.min(ln.endOffset, to.offset) : ln.endOffset;
    const xa = xAt(ln, sOff);
    const extendBeyond = comparePos(lineEnd, to) < 0; // 选区延续到本行之后 → 画到行尾边（LTR 右 / RTL 左）
    // 延续到行尾：LTR 画到内容右边界，RTL 画到本视觉行的左缘（minX，由布局精确记录，
    // 不再用 Math.min(...xs) —— xs 在 RTL/BiDi 下非单调，依赖其排序不可靠）。
    const xb = extendBeyond ? (ln.rtl ? ln.minX : L.contentRight) : xAt(ln, eOff);
    const left = Math.min(xa, xb),
      right = Math.max(xa, xb);
    if (right - left <= 0 && !extendBeyond) continue;
    const top = Math.round(ln.top),
      bottom = Math.round(ln.bottom);
    rects.push({ x: left, y: top, w: right - left, h: bottom - top, color: sel });
  }
  return rects;
}

function xAt(ln: LineBox, off: number): number {
  return ln.xs[nearestIndex(ln.offsets, off)];
}
// 取 arr 中离 v 最近的下标。tie-break 稳定：严格 `<` 使等距时保留先遇到的下标；
// 配合 offsets 已按 offset 升序，等距时确定性地取 offset 较小者（不受 BiDi 插入序影响）。
function nearestIndex(arr: number[], v: number): number {
  let bi = 0,
    bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
}
