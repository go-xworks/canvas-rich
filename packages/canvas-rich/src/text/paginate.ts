// 分页器（text 分层）：把 layoutDoc 产出的连续布局按「页」切分，供 word(分页) 视图使用。
// 核心策略：只做**整段垂直平移**——单遍扫描行序列产出断点表 (origTop, 累计 shift)，
// 再把平移应用到所有几何（行/字形/背景/高亮/装饰/覆盖层）。不改 doc-layout 核心；
// 光标 / 命中测试 / 选区因 lines 几何已被平移而自然正确。
//
// 【契约（视口剔除依赖，勿破坏）】lines 与 glyphs/decorations/highlights 均为 1:1 平移映射
// （不增删、不重排、下标不变），故 LineBox 上的每行区间（glyphStart/End、decoStart/End、
// hlStart/End）在分页布局中保持有效；且平移量随断点单调不减 → lines 的 top/bottom 单调性
// 保持，装配层的可见行二分（visibleLineRange）对 word 视图直接可用。若未来引入行级裁剪/
// 重排，必须同步重建这些区间（有测试守护：paginate.test / incremental-layout.test）。
import { DocLayout, LineBox, SolidRect, OverlayBox, InlineOverlayBox } from './doc-layout';
import { PositionedGlyph } from '../types';
import { lowerBoundIndex } from '../shared/util';

/** 单页纸面矩形（设备 px），供渲染层画纸面/投影与页缝底色。 @public */
export interface PageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 分页参数（全部设备 px）。
 * 约定：传给 layoutDoc 的 `padT` 应等于 `gap + marginTop`，分页器据此反推首页页顶
 * `page0Top = padT - marginTop`（即首页上方留一条 gap 页缝）。
 * @public
 */
export interface PaginateOpts {
  /** 页面左缘 x */ pageX: number;
  /** 页宽 */ pageW: number;
  /** 页高 */ pageH: number;
  /** 页内上边距（内容区距页顶） */ marginTop: number;
  /** 页内下边距（内容区距页底） */ marginBottom: number;
  /** 页间缝隙（首页上方与末页下方同宽） */ gap: number;
  /** layoutDoc 所用的 padT（= gap + marginTop） */ padT: number;
}

// 跨页判定的亚像素容差（设备 px）：行底恰好贴内容底（浮点误差内）不视为越界。
const EPS = 0.5;

/**
 * 把连续布局按页切分：行底越过当前页内容底的行**整行**移到下一页内容顶，
 * 产生断点（origTop, 累计 shift）；随后用断点表（按 origY 二分）平移所有几何。
 *
 * 已知边界（按设计取舍，非缺陷）：
 * - 高于单页内容区的超高行（大原子块如长表格/大图）放到某页内容顶后**不再切割**，
 *   视觉上跨页缝绘制；后续行从其底部所在页继续（单遍推进页号，不会死循环）。
 * - 跨多行的大背景矩形（连续代码块共用背景）按其 y 所在段整体平移，**不按页切割**：
 *   若其行被断点拆到两页，背景仍是一整块（留在前段），存在跨页缝的视觉残留。
 * - 行内贴底装饰（下划线/波浪线）在极小字号（descent < ~4 设备 px）下可能微越行底，
 *   若恰逢断点会归入下一段；常规字号不会触发。
 *
 * @param L - layoutDoc 的连续布局（lines 已按 y 升序）
 * @param o - 分页几何参数（设备 px）
 * @returns layout：几何已平移的新 DocLayout（不修改入参 L；其 `contentHeight` 语义变为
 *   「从 y=0 起的文档总像素高 = 末页底 + gap」，装配层滚动范围直接取用）；pages：每页纸面矩形。
 * @public
 */
export function paginateLayout(L: DocLayout, o: PaginateOpts): { layout: DocLayout; pages: PageRect[] } {
  const page0Top = o.padT - o.marginTop;
  const stride = o.pageH + o.gap;
  const pageTop = (p: number): number => page0Top + p * stride;
  const contentTop = (p: number): number => pageTop(p) + o.marginTop;
  const contentBottom = (p: number): number => pageTop(p) + o.pageH - o.marginBottom;

  // —— 单遍扫描产出断点表：breakYs[i]（原始 y，升序）之后的几何统一加 breakShifts[i] ——
  const breakYs: number[] = [-Infinity];
  const breakShifts: number[] = [0];
  let p = 0; // 当前页号
  let shift = 0; // 累计平移量（随断点单调不减）
  for (const ln of L.lines) {
    if (ln.bottom + shift <= contentBottom(p) + EPS) continue; // 本行装得下当前页
    // 行底越过当前页内容底：整行移到下一页内容顶（已在内容顶的行不再移——只能是超高行，防死循环）
    const atContentTop = ln.top + shift <= contentTop(p) + EPS;
    if (!atContentTop) {
      p += 1;
      shift = contentTop(p) - ln.top;
      breakYs.push(ln.top);
      breakShifts.push(shift);
    }
    // 超高行（高于单页内容区）：放页顶后立即向后翻页，直至其底被某页覆盖；
    // 后续行的越界判定基于新页号继续，单遍前进、不会回退 → 不死循环。
    while (ln.bottom + shift > contentBottom(p) + EPS) p += 1;
  }
  const pageCount = p + 1;

  /** 原始 y → 该段的平移量（断点表二分；breakYs[0] = -Infinity 兜底首段）。 */
  const shiftAt = (y: number): number => breakShifts[lowerBoundIndex(breakYs, y)];
  const shiftRects = (rs: SolidRect[]): SolidRect[] =>
    rs.map((r) => {
      const s = shiftAt(r.y);
      return s === 0 ? r : { ...r, y: r.y + s };
    });

  const lines: LineBox[] = L.lines.map((ln) => {
    const s = shiftAt(ln.top); // 行作刚体平移：top/bottom/baseline 同 shift
    return s === 0 ? ln : { ...ln, top: ln.top + s, bottom: ln.bottom + s, baseline: ln.baseline + s };
  });
  const glyphs: PositionedGlyph[] = L.glyphs.map((g) => {
    const s = shiftAt(g.baselineY); // baselineY ∈ (行top, 行bottom) → 与所属行取到同一断点
    return s === 0 ? g : { ...g, baselineY: g.baselineY + s };
  });
  const overlays: OverlayBox[] = L.overlays.map((b) => {
    const s = shiftAt(b.y); // 原子块行 top == overlay.y == 断点 origY → 同步平移
    return s === 0 ? b : { ...b, y: b.y + s };
  });
  const inlineOverlays: InlineOverlayBox[] = L.inlineOverlays.map((b) => {
    const s = shiftAt(b.y);
    return s === 0 ? b : { ...b, y: b.y + s };
  });

  const pages: PageRect[] = [];
  for (let i = 0; i < pageCount; i++) pages.push({ x: o.pageX, y: pageTop(i), w: o.pageW, h: o.pageH });

  const layout: DocLayout = {
    backgrounds: shiftRects(L.backgrounds), // 已知边界：跨页大背景按其 y 所在段整体平移，不切割
    highlights: shiftRects(L.highlights),
    glyphs,
    decorations: shiftRects(L.decorations),
    overlays,
    inlineOverlays,
    lines,
    // 分页布局的 contentHeight = 文档总像素高（从 y=0 起）：末页底 + gap。
    contentHeight: pageTop(pageCount - 1) + o.pageH + o.gap,
    contentRight: L.contentRight,
    dpr: L.dpr,
  };
  return { layout, pages };
}
