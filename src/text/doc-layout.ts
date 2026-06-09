// 文档布局引擎（text 分层）：把 model 文档整形、断行、BiDi 重排后产出
// 几何化布局（字形/背景/装饰/选区/光标），供 render 层绘制、editor 层命中与光标定位。
import { Doc, isAtomBlock } from '../model/schema';
import { Pos, comparePos } from '../model/rich-document';
import { StyleResolver } from '../model/style-resolver';
import { C } from '../model/palette';
import { splitGraphemes } from '../model/grapheme';
import { Shaper } from './shaper';
import { breakLines, BreakItem } from './line-break';
import { embeddingLevels, visualOrder, mayBeBidi } from './bidi';
import { PositionedGlyph, Style } from '../types';

/** 带 RGBA 颜色的实心矩形（背景/高亮/装饰/选区的统一几何）。@public */
export interface SolidRect { x: number; y: number; w: number; h: number; color: [number, number, number, number] }

/** 单视觉行的几何与光标列表（含偏移→x 映射，支持 RTL）。@public */
export interface LineBox {
  block: number;
  top: number; bottom: number; baseline: number;
  startOffset: number; endOffset: number;
  offsets: number[]; // 升序的块内偏移（含行末）
  xs: number[];      // 对应每个偏移的光标 x（设备 px；RTL 时随 offset 递减）
  rtl: boolean;
}

/** 原子块的覆盖层类型（图片/公式/表格）。@public */
export type OverlayKind = 'image' | 'formula' | 'table';
/** 原子块占位框，交由 DOM 覆盖层渲染。@public */
export interface OverlayBox { block: number; kind: OverlayKind; x: number; y: number; w: number; h: number }

/** 一次布局的完整几何产物（背景/高亮/字形/装饰/覆盖层/行/尺寸）。@public */
export interface DocLayout {
  backgrounds: SolidRect[]; // 块背景（代码块等），最底层
  highlights: SolidRect[];  // 文字背景高亮
  glyphs: PositionedGlyph[];
  decorations: SolidRect[]; // 下划线 + 删除线
  overlays: OverlayBox[];   // 原子块（图片/公式/表格）→ DOM 覆盖层渲染
  lines: LineBox[];
  contentHeight: number;
  contentRight: number;
  dpr: number;
}

/** 布局入参：内容宽度、左/上内边距、设备像素比。@public */
export interface DocLayoutOpts { width: number; padL: number; padT: number; dpr: number }

type RGBA = [number, number, number, number];
interface El { ch: string; style: Style; underline: RGBA | null; strike: RGBA | null; highlight: RGBA | null; baselineShift: number; uStart: number }

/** 将文档整形、断行、BiDi 重排并对齐，产出可绘制的几何布局。@public */
export function layoutDoc(doc: Doc, shaper: Shaper, resolver: StyleResolver, opt: DocLayoutOpts): DocLayout {
  const backgrounds: SolidRect[] = [];
  const highlights: SolidRect[] = [];
  const glyphs: PositionedGlyph[] = [];
  const decorations: SolidRect[] = [];
  const overlays: OverlayBox[] = [];
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

    // 原子块（图片/公式/表格）：保留高度，记录位置给 DOM 覆盖层；光标只落 {block,0}
    if (isAtomBlock(blk.type)) {
      const sb = 8 * opt.dpr;
      y += sb;
      const contentW = contentRight - contentLeft;
      let w: number, h: number, x = contentLeft;
      if (blk.type === 'image') {
        // 图片：显示宽度取 attrs.width（夹到内容宽），高度取 attrs.height；按 align 水平定位
        const wCss = Math.min(blk.attrs.width ?? (contentW / opt.dpr), contentW / opt.dpr);
        w = Math.max(40 * opt.dpr, wCss * opt.dpr);
        h = (blk.attrs.height ?? 200) * opt.dpr;
        const al = blk.attrs.align ?? 'left';
        x = al === 'center' ? contentLeft + (contentW - w) / 2 : al === 'right' ? contentRight - w : contentLeft;
      } else {
        // 公式/表格：满内容宽，高度用实测回填
        h = (blk.attrs.measuredH ?? (blk.type === 'formula' ? 52 : 120)) * opt.dpr;
        w = contentW;
      }
      lines.push({ block: bi, top: y, bottom: y + h, baseline: y + h, startOffset: 0, endOffset: 0, offsets: [0], xs: [contentLeft], rtl: false });
      overlays.push({ block: bi, kind: blk.type as OverlayKind, x, y, w, h });
      y += h + sb;
      continue;
    }

    const x0 = contentLeft + rb.indent * opt.dpr;
    const wrapW = Math.max(20, contentRight - x0);
    const rtl = blk.attrs.dir === 'rtl';
    const align: 'left' | 'center' | 'right' = blk.attrs.align ?? (rtl ? 'right' : 'left');

    // —— 展开成元素（grapheme 粒度，带块内 UTF-16 偏移）——
    const els: El[] = [];
    let uOff = 0;
    for (const run of blk.inlines) {
      const rr = resolver.resolveRun(blk, run.marks);
      for (const g of splitGraphemes(run.text)) {
        els.push({ ch: g, style: rr.style, underline: rr.underline, strike: rr.strike, highlight: rr.highlight, baselineShift: rr.baselineShift, uStart: uOff });
        uOff += g.length;
      }
    }

    const shaped = shaper.shapeChars(els.map((e) => ({ ch: e.ch, style: e.style })));
    const items: BreakItem[] = els.map((e, i) => ({ advance: shaped[i].advance, isSpace: e.ch === ' ', isNewline: false }));
    const lineRuns = els.length ? breakLines(items, wrapW) : [[]];
    const baseM = shaper.fontMetrics(rb.base);
    // BiDi：仅在含 RTL 或 base 为 rtl 时计算 embedding levels（纯 LTR 跳过开销）
    const blockStr = els.map((e) => e.ch).join('');
    const charLevels = mayBeBidi(blockStr, rtl) ? embeddingLevels(blockStr, rtl ? 'rtl' : 'ltr') : null;

    const sBefore = (blk.type === 'code_block' && prevType === 'code_block') ? 0 : rb.spaceBefore;
    y += sBefore * opt.dpr;
    const blockTop = y;

    for (let li = 0; li < lineRuns.length; li++) {
      const le = lineRuns[li];
      // 行度量
      let ascent = baseM.ascent, descent = baseM.descent, lineH = baseM.lineHeight;
      for (const ei of le) {
        const m = shaper.fontMetrics(els[ei].style);
        ascent = Math.max(ascent, m.ascent); descent = Math.max(descent, m.descent); lineH = Math.max(lineH, m.lineHeight);
      }
      void descent;
      const top = y, bottom = y + lineH, baseline = y + ascent;

      // 对齐：行视觉宽度 → 起始左锚（align 已含 RTL 默认右对齐）
      let lineW = 0; for (const ei of le) lineW += shaped[ei].advance;
      const slack = Math.max(0, wrapW - lineW);
      const startX = x0 + (align === 'left' ? 0 : align === 'center' ? slack / 2 : slack);

      // 项目符号 / 有序编号（仅首行；RTL 放右侧）
      const markerText = li === 0 ? (rb.marker ?? (rb.ordered ? `${orderedNum}.` : null)) : null;
      if (markerText) {
        const mshaped = shaper.shapeChars(splitGraphemes(markerText).map((ch) => ({ ch, style: rb.base })));
        let mw = 0; for (const s of mshaped) mw += s.advance;
        let mxp = rtl ? (x0 + wrapW + 8 * opt.dpr) : (x0 - mw - 8 * opt.dpr);
        for (const s of mshaped) {
          if (!s.glyph.empty) glyphs.push({ info: s.glyph, penX: mxp + s.glyph.bearingX, baselineY: baseline, color: rb.base.color });
          mxp += s.advance;
        }
      }

      // BiDi 视觉序（L2）：纯 LTR 时为恒等序；混排时按 embedding level 重排
      const elemLevels = charLevels ? le.map((ei) => charLevels[els[ei].uStart] ?? (rtl ? 1 : 0)) : le.map(() => 0);
      const vorder = charLevels ? visualOrder(elemLevels) : le.map((_, i) => i);

      // 按视觉序左→右排字；光标列按 level 取前/后缘（BiDi 光标规则）
      let penX = startX;
      const caretMap = new Map<number, number>();
      const decoH = Math.max(1, Math.round(1.5 * opt.dpr));
      for (let v = 0; v < vorder.length; v++) {
        const lj = vorder[v]; const e = els[le[lj]]; const sh = shaped[le[lj]];
        const left = penX, right = penX + sh.advance;
        const rtlEl = (elemLevels[lj] % 2) === 1;
        caretMap.set(e.uStart, rtlEl ? right : left);
        caretMap.set(e.uStart + e.ch.length, rtlEl ? left : right);
        // 上/下标：基线按 baselineShift × 当前字号偏移（正=上移即更小的 y）
        const elBaseline = baseline - e.baselineShift * e.style.fontSize * opt.dpr;
        if (e.highlight) highlights.push({ x: left, y: top, w: sh.advance, h: bottom - top, color: e.highlight });
        if (!sh.glyph.empty) glyphs.push({ info: sh.glyph, penX: left + sh.glyph.bearingX, baselineY: elBaseline, color: e.style.color });
        if (e.underline) decorations.push({ x: left, y: elBaseline + Math.round(2 * opt.dpr), w: sh.advance, h: decoH, color: e.underline });
        if (e.strike) decorations.push({ x: left, y: elBaseline - Math.round(shaper.fontMetrics(e.style).ascent * 0.32), w: sh.advance, h: decoH, color: e.strike });
        penX = right;
      }
      if (le.length === 0) caretMap.set(0, startX);

      const offsets = [...caretMap.keys()];
      const xs = offsets.map((o) => caretMap.get(o)!);
      const endOff = le.length ? els[le[le.length - 1]].uStart + els[le[le.length - 1]].ch.length : 0;
      lines.push({ block: bi, top, bottom, baseline, startOffset: le.length ? els[le[0]].uStart : 0, endOffset: endOff, offsets, xs, rtl });
      y = bottom;
    }

    // 块背景（代码块）：连续代码块合并为一个连续背景，避免条纹空隙
    if (rb.background) {
      const padV = Math.round(4 * opt.dpr);
      if (codeBg && prevType === 'code_block') codeBg.h = (y + padV) - codeBg.y;
      else { codeBg = { x: contentLeft, y: blockTop - padV, w: contentRight - contentLeft, h: (y - blockTop) + padV * 2, color: rb.background }; backgrounds.push(codeBg); }
    }

    const nextType = bi + 1 < doc.blocks.length ? doc.blocks[bi + 1].type : null;
    const sAfter = (blk.type === 'code_block' && nextType === 'code_block') ? 0 : rb.spaceAfter;
    y += sAfter * opt.dpr;
  }

  return { backgrounds, highlights, glyphs, decorations, overlays, lines, contentHeight: y - opt.padT, contentRight, dpr: opt.dpr };
}

// 软换行点 affinity：同一 offset 既是上一视觉行尾(before)又是下一视觉行首(after)。
/** 软换行边界的归属偏好：行尾(before)或行首(after)。@public */
export type Affinity = 'before' | 'after';

/** 选出 pos 所属的视觉行，用 affinity 消歧软换行边界。@public */
export function caretLine(L: DocLayout, pos: Pos, affinity: Affinity = 'after'): LineBox | null {
  const cands = L.lines.filter((ln) => ln.block === pos.block && pos.offset >= ln.startOffset && pos.offset <= ln.endOffset);
  if (cands.length === 0) return null;
  if (affinity === 'before')
    return cands.find((ln) => ln.endOffset === pos.offset && ln.startOffset !== pos.offset) ?? cands.find((ln) => ln.endOffset === pos.offset) ?? cands[0];
  return cands.find((ln) => ln.startOffset === pos.offset) ?? cands[cands.length - 1];
}

// —— 光标盒 ——
/** 计算 pos 处的光标盒（x 与上下边），无对应行时返回 null。@public */
export function caretAt(L: DocLayout, pos: Pos, affinity: Affinity = 'after'): { x: number; top: number; bottom: number } | null {
  const line = caretLine(L, pos, affinity);
  if (!line) return null;
  const i = nearestIndex(line.offsets, pos.offset);
  return { x: line.xs[i], top: line.top, bottom: line.bottom };
}

/** 返回垂直方向上离 py 最近的视觉行，空布局时返回 null。@public */
export function nearestLine(L: DocLayout, py: number): LineBox | null {
  if (L.lines.length === 0) return null;
  let line = L.lines[0], best = Infinity;
  for (const ln of L.lines) {
    const d = py < ln.top ? ln.top - py : py > ln.bottom ? py - ln.bottom : 0;
    if (d < best) { best = d; line = ln; }
  }
  return line;
}

// —— 命中测试：屏幕坐标 → Pos ——
/** 命中测试：把设备坐标 (px,py) 映射为最近的文档位置 Pos。@public */
export function hitTestDoc(L: DocLayout, px: number, py: number): Pos {
  const line = nearestLine(L, py);
  if (!line) return { block: 0, offset: 0 };
  let bi = 0, bdx = Infinity;
  for (let i = 0; i < line.xs.length; i++) { const dx = Math.abs(px - line.xs[i]); if (dx < bdx) { bdx = dx; bi = i; } }
  return { block: line.block, offset: line.offsets[bi] };
}

// —— 跨块选区矩形（from<=to）——
/** 生成 [from,to] 选区的逐行高亮矩形（含空行换行带、RTL 方向）。@public */
export function selectionRects(L: DocLayout, from: Pos, to: Pos): SolidRect[] {
  const rects: SolidRect[] = [];
  const sel: [number, number, number, number] = C.selection;
  for (const ln of L.lines) {
    const lineStart: Pos = { block: ln.block, offset: ln.startOffset };
    const lineEnd: Pos = { block: ln.block, offset: ln.endOffset };
    // 整行在选区前则跳过；但「空行且正好是选区起点、且选区跨过它」要保留（画换行高亮带）
    const emptyLine = ln.startOffset === ln.endOffset;
    if (comparePos(lineEnd, from) <= 0 && !(emptyLine && comparePos(lineStart, from) === 0 && comparePos(lineEnd, to) < 0)) continue;
    if (comparePos(lineStart, to) >= 0) continue;      // 整行在选区后
    const sOff = ln.block === from.block ? Math.max(ln.startOffset, from.offset) : ln.startOffset;
    const eOff = ln.block === to.block ? Math.min(ln.endOffset, to.offset) : ln.endOffset;
    const xa = xAt(ln, sOff);
    const extendBeyond = comparePos(lineEnd, to) < 0; // 选区延续到本行之后 → 画到行尾边（LTR 右 / RTL 左）
    // RTL 时 x 随 offset 递减，需取 min/max；延续方向也相反
    const xb = extendBeyond ? (ln.rtl ? Math.min(...ln.xs) : L.contentRight) : xAt(ln, eOff);
    const left = Math.min(xa, xb), right = Math.max(xa, xb);
    if (right - left <= 0 && !extendBeyond) continue;
    const top = Math.round(ln.top), bottom = Math.round(ln.bottom);
    rects.push({ x: left, y: top, w: right - left, h: bottom - top, color: sel });
  }
  return rects;
}

function xAt(ln: LineBox, off: number): number { return ln.xs[nearestIndex(ln.offsets, off)]; }
function nearestIndex(arr: number[], v: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; bi = i; } }
  return bi;
}
