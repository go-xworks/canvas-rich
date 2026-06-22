import { describe, it, expect } from 'vitest';
import { paginateLayout, PaginateOpts } from '../paginate';
import { DocLayout, LineBox } from '../doc-layout';
import { PositionedGlyph, GlyphInfo } from '../../types';

// paginate 纯函数测试：直接手工构造 DocLayout 几何（不经 shaper/layoutDoc），
// 精确断言断点平移（lines/glyphs/背景/装饰/覆盖层）、页数与页位置、contentHeight 与不死循环。

// 页几何：页高 100、上下边距 10（内容区高 80）、页缝 20 → 首页页顶 20、stride=120。
// contentTop(p) = 30 + 120p；contentBottom(p) = 110 + 120p。
const OPT: PaginateOpts = {
  pageX: 5,
  pageW: 200,
  pageH: 100,
  marginTop: 10,
  marginBottom: 10,
  gap: 20,
  padT: 30, // = gap + marginTop
};
const STRIDE = 120; // pageH + gap
const PAGE0_TOP = 20; // padT - marginTop

const EMPTY_GLYPH: GlyphInfo = {
  u0: 0,
  v0: 0,
  u1: 0,
  v1: 0,
  page: 0,
  w: 4,
  h: 8,
  bearingX: 0,
  bearingY: 6,
  advance: 10,
  empty: false,
};

const line = (top: number, h: number, block = 0): LineBox => ({
  block,
  top,
  bottom: top + h,
  baseline: top + h * 0.75,
  startOffset: 0,
  endOffset: 1,
  offsets: [0, 1],
  xs: [0, 10],
  minX: 0,
  maxX: 10,
  rtl: false,
});
const glyph = (baselineY: number): PositionedGlyph => ({ info: EMPTY_GLYPH, penX: 0, baselineY, color: [0, 0, 0, 1] });
const layoutOf = (over: Partial<DocLayout>): DocLayout => ({
  backgrounds: [],
  highlights: [],
  glyphs: [],
  decorations: [],
  overlays: [],
  inlineOverlays: [],
  lines: [],
  contentHeight: 0,
  contentRight: 195,
  dpr: 1,
  ...over,
});

describe('paginateLayout: 单页不分', () => {
  it('全部行落在首页内容区 → 行几何不变、1 页、contentHeight = 页底 + gap', () => {
    const L = layoutOf({ lines: [line(30, 20), line(50, 20), line(70, 40)] }); // 末行底 110 = contentBottom(0)
    const { layout, pages } = paginateLayout(L, OPT);
    expect(pages).toEqual([{ x: 5, y: PAGE0_TOP, w: 200, h: 100 }]);
    expect(layout.lines.map((l) => l.top)).toEqual([30, 50, 70]);
    expect(layout.lines.map((l) => l.bottom)).toEqual([50, 70, 110]);
    expect(layout.contentHeight).toBe(PAGE0_TOP + 100 + 20); // 末页底 + gap = 140
  });

  it('不修改入参布局（纯函数）', () => {
    const L = layoutOf({ lines: [line(30, 20), line(100, 20)], glyphs: [glyph(45)] });
    paginateLayout(L, OPT);
    expect(L.lines[1].top).toBe(100); // 入参未被原地平移
    expect(L.glyphs[0].baselineY).toBe(45);
  });
});

describe('paginateLayout: 恰好跨页', () => {
  it('行底越过内容底 → 整行移到次页内容顶；前一行不动', () => {
    // 行 A: 90..110（恰好贴 contentBottom(0)，不越界）；行 B: 110..130（越界 → 移到 contentTop(1)=150）
    const L = layoutOf({ lines: [line(90, 20), line(110, 20)] });
    const { layout, pages } = paginateLayout(L, OPT);
    expect(pages.length).toBe(2);
    expect(layout.lines[0].top).toBe(90);
    expect(layout.lines[0].bottom).toBe(110);
    expect(layout.lines[1].top).toBe(150); // contentTop(1)
    expect(layout.lines[1].bottom).toBe(170);
    expect(layout.lines[1].baseline).toBe(110 + 20 * 0.75 + 40); // 刚体平移：baseline 同 shift=40
  });
});

describe('paginateLayout: 多页', () => {
  it('每行都落在某页内容区内；页数与末页覆盖匹配', () => {
    // 7 行 × 高 30，从 30 起连排：自然占用远超一页内容区（80）
    const lines = Array.from({ length: 7 }, (_, i) => line(30 + i * 30, 30));
    const { layout, pages } = paginateLayout(layoutOf({ lines }), OPT);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const ln of layout.lines) {
      // 找到所属页：行须整体处于该页内容区 [contentTop, contentBottom]
      const p = Math.round((ln.top - 30) / STRIDE);
      const cTop = 30 + p * STRIDE,
        cBottom = 110 + p * STRIDE;
      expect(ln.top).toBeGreaterThanOrEqual(cTop - 0.5);
      expect(ln.bottom).toBeLessThanOrEqual(cBottom + 0.5);
    }
    // 末行落在末页（页数收口到实际内容）
    const last = layout.lines[layout.lines.length - 1];
    const lastPage = pages[pages.length - 1];
    expect(last.bottom).toBeLessThanOrEqual(lastPage.y + OPT.pageH - OPT.marginBottom + 0.5);
  });
});

describe('paginateLayout: 超高行（大原子块）不死循环', () => {
  it('首行高于单页内容区：留在首页内容顶，向后翻页，后续行落到其后', () => {
    // 首行 30..330（高 300 > 内容区 80）；次行 330..350
    const L = layoutOf({ lines: [line(30, 300), line(330, 20)] });
    const { layout, pages } = paginateLayout(L, OPT); // 终止本身即「不死循环」的验证
    expect(layout.lines[0].top).toBe(30); // 已在内容顶，不再移动
    expect(layout.lines[0].bottom).toBe(330);
    // 其底 330 落入第 3 页（contentBottom(2)=350）→ 至少 3 页
    expect(pages.length).toBe(3);
    // 次行底 350 = contentBottom(2)，装得下 → 不产生新断点
    expect(layout.lines[1].top).toBe(330);
  });

  it('中途遇到超高行：先整行移到次页内容顶，再翻页覆盖其底', () => {
    // 行 A: 30..60；超高行 B: 60..260（高 200）→ 移到 contentTop(1)=150，底 350 落入 page2
    const L = layoutOf({ lines: [line(30, 30), line(60, 200), line(260, 20)] });
    const { layout, pages } = paginateLayout(L, OPT);
    expect(layout.lines[1].top).toBe(150);
    expect(layout.lines[1].bottom).toBe(350); // 跨页缝绘制（已知边界），底恰贴 contentBottom(2)
    // 行 C 暂随 B 段 shift=90 → 350..370，越过 contentBottom(2)=350 → 再断到 contentTop(3)=390
    expect(layout.lines[2].top).toBe(390);
    expect(layout.lines[2].bottom).toBe(410);
    expect(pages.length).toBe(4);
  });
});

describe('paginateLayout: glyph 与 line 同步平移', () => {
  it('字形 baselineY 与所属行获得相同 shift；前段字形不动', () => {
    const L = layoutOf({
      lines: [line(90, 20), line(110, 20)],
      glyphs: [glyph(105), glyph(125)], // 分属行 A（90..110）与行 B（110..130）
    });
    const { layout } = paginateLayout(L, OPT);
    expect(layout.glyphs[0].baselineY).toBe(105); // 行 A 未移
    expect(layout.glyphs[1].baselineY).toBe(125 + 40); // 行 B shift=40
  });
});

describe('paginateLayout: 覆盖层 / 背景 / 高亮 / 装饰平移', () => {
  it('原子块 overlay 随其行平移（overlay.y == 行 top == 断点 origY）', () => {
    const L = layoutOf({
      lines: [line(90, 20), line(110, 50)],
      overlays: [{ block: 1, kind: 'image', x: 0, y: 110, w: 100, h: 50 }],
    });
    const { layout } = paginateLayout(L, OPT);
    expect(layout.overlays[0].y).toBe(150); // 行 B 移到 contentTop(1)，overlay 同步
  });

  it('行内 overlay 与背景/高亮/装饰按其 y 所在段平移', () => {
    const L = layoutOf({
      lines: [line(90, 20), line(110, 20)],
      inlineOverlays: [{ block: 0, offset: 1, kind: 'image', x: 4, y: 115, w: 10, h: 10 }],
      backgrounds: [{ x: 0, y: 92, w: 50, h: 10, color: [0, 0, 0, 1] }], // 行 A 段
      highlights: [{ x: 0, y: 110, w: 50, h: 20, color: [0, 0, 0, 1] }], // 行 B 段
      decorations: [{ x: 0, y: 127, w: 50, h: 2, color: [0, 0, 0, 1] }], // 行 B 段
    });
    const { layout } = paginateLayout(L, OPT);
    expect(layout.inlineOverlays[0].y).toBe(115 + 40);
    expect(layout.backgrounds[0].y).toBe(92); // 前段不动
    expect(layout.highlights[0].y).toBe(110 + 40);
    expect(layout.decorations[0].y).toBe(127 + 40);
  });
});

describe('paginateLayout: pages 数组与 contentHeight', () => {
  it('每页矩形 x/w/h 固定、y 按 stride 递推', () => {
    const lines = Array.from({ length: 5 }, (_, i) => line(30 + i * 40, 40));
    const { pages } = paginateLayout(layoutOf({ lines }), OPT);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    pages.forEach((pg, i) => {
      expect(pg).toEqual({ x: 5, y: PAGE0_TOP + i * STRIDE, w: 200, h: 100 });
    });
  });

  it('contentHeight = 末页底 + gap（与 pages 几何收口一致）', () => {
    const lines = Array.from({ length: 5 }, (_, i) => line(30 + i * 40, 40));
    const { layout, pages } = paginateLayout(layoutOf({ lines }), OPT);
    const last = pages[pages.length - 1];
    expect(layout.contentHeight).toBe(last.y + last.h + OPT.gap);
  });

  it('空布局（无行）仍产出 1 页', () => {
    const { layout, pages } = paginateLayout(layoutOf({}), OPT);
    expect(pages.length).toBe(1);
    expect(layout.contentHeight).toBe(PAGE0_TOP + 100 + 20);
  });
});
