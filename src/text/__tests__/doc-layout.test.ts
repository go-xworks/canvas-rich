import { describe, it, expect } from 'vitest';
import { layoutDoc, caretAt, selectionRects, hitTestDoc, DocLayoutOpts } from '../doc-layout';
import { Shaper, ShapedChar } from '../shaper';
import { FontMetrics } from '../glyph-atlas';
import { StyledChar, Style, GlyphInfo } from '../../types';
import { StyleResolver } from '../../model/style-resolver';
import { Doc, block, para, text, inlineAtom } from '../../model/schema';
import { Pos } from '../../model/rich-document';

// 确定性 Shaper：每个字符 advance = ADV（设备 px），度量为常量，便于精确断言几何。
// 不依赖 canvas，纯算术，验证 lineHeight / letterSpacing / justify·distribute 的 slack 分配
// 与 caret/选区一致性。
const ADV = 10;
const ASCENT = 12, DESCENT = 4, LINEH = 16;

const EMPTY_GLYPH: GlyphInfo = {
  u0: 0, v0: 0, u1: 0, v1: 0, page: 0, w: 0, h: 0, bearingX: 0, bearingY: 0, advance: ADV, empty: true,
};

class FakeShaper implements Shaper {
  readonly name = 'fake';
  fontMetrics(_style: Style): FontMetrics { void _style; return { ascent: ASCENT, descent: DESCENT, lineHeight: LINEH }; }
  shapeChars(chars: StyledChar[]): ShapedChar[] {
    return chars.map(() => ({ advance: ADV, glyph: EMPTY_GLYPH }));
  }
}

const resolver = new StyleResolver();
const shaper = new FakeShaper();
const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });
// 内容宽度足够放下整行（不触发自动换行），padL=0、padT=0、dpr=1，使坐标即逻辑值。
const opt = (width: number): DocLayoutOpts => ({ width, padL: 0, padT: 0, dpr: 1 });

describe('doc-layout: lineHeight 行距倍数', () => {
  it('lineHeight=2 时行盒高度 = 自然行高 × 2', () => {
    const base = layoutDoc(docOf(para([text('ab')])), shaper, resolver, opt(1000));
    const tall = layoutDoc(docOf(para([text('ab')], { lineHeight: 2 })), shaper, resolver, opt(1000));
    const baseH = base.lines[0].bottom - base.lines[0].top;
    const tallH = tall.lines[0].bottom - tall.lines[0].top;
    expect(baseH).toBe(LINEH);
    expect(tallH).toBe(LINEH * 2);
  });

  it('lineHeight 放大行盒后，文字基线垂直居中（多余行距上下均分）', () => {
    const L = layoutDoc(docOf(para([text('ab')], { lineHeight: 2 })), shaper, resolver, opt(1000));
    const ln = L.lines[0];
    const lead = (LINEH * 2) - (ASCENT + DESCENT);
    expect(ln.baseline).toBe(ln.top + ASCENT + lead / 2);
  });
});

describe('doc-layout: letterSpacing 字间距', () => {
  it('每元素 advance 追加 letterSpacing，caret xs 同步', () => {
    const L = layoutDoc(docOf(para([text('abc')], { letterSpacing: 4 })), shaper, resolver, opt(1000));
    const c0 = caretAt(L, { block: 0, offset: 0 })!;
    const c1 = caretAt(L, { block: 0, offset: 1 })!;
    const c3 = caretAt(L, { block: 0, offset: 3 })!;
    expect(c0.x).toBe(0);
    expect(c1.x).toBe(ADV + 4);          // 第一个字宽 = 基础 advance + letterSpacing
    expect(c3.x).toBe((ADV + 4) * 3);    // 行末 caret 含每元素的字间距
  });

  it('letterSpacing=0 时与无字间距等价', () => {
    const a = layoutDoc(docOf(para([text('abc')])), shaper, resolver, opt(1000));
    const b = layoutDoc(docOf(para([text('abc')], { letterSpacing: 0 })), shaper, resolver, opt(1000));
    expect(caretAt(b, { block: 0, offset: 3 })!.x).toBe(caretAt(a, { block: 0, offset: 3 })!.x);
  });
});

describe('doc-layout: justify slack 分摊到空格', () => {
  // 'a b c'：5 元素，自然宽 5×ADV=50；wrapW=80 → slack=30。
  // 但 'a b c' 只有 1 行（=末行），justify 不拉伸末行 → 行为同左对齐。
  // 用两行构造非末行：宽度刚好让 'a b' 与 'c' 不同行较繁琐，改用显式宽度让单段不换行 +
  // 直接验证「单行=末行不拉伸」与「多行时非末行拉伸」两个性质。
  it('单行（即末行）不拉伸：caret 同左对齐', () => {
    const L = layoutDoc(docOf(para([text('a b c')], { align: 'justify' })), shaper, resolver, opt(80));
    // 末行不拉伸 → 末尾 caret = 自然宽 5×ADV
    expect(caretAt(L, { block: 0, offset: 5 })!.x).toBe(5 * ADV);
  });

  it('非末行：slack 均分到非末尾空格，行被拉满到 wrapW', () => {
    // 构造换行：'aa bb cc dd' 宽 11×ADV=110；wrapW=70 → 第一行放 'aa bb ' 等。
    // 直接用窄宽强制多行，断言第一行末 caret 拉到接近 wrapW（>自然宽）。
    const wrapW = 70;
    const L = layoutDoc(docOf(para([text('aa bb cc dd')], { align: 'justify' })), shaper, resolver, opt(wrapW));
    expect(L.lines.length).toBeGreaterThan(1);
    const first = L.lines[0];
    const firstNaturalW = (first.endOffset - first.startOffset) * ADV;
    const firstEndX = first.xs[first.offsets.indexOf(first.endOffset)];
    // 第一行被拉伸：行末 x 超过自然宽（slack 加到了空格上）
    expect(firstEndX).toBeGreaterThan(firstNaturalW);
    // 且拉伸量 = slack（行被填满到 wrapW，忽略末尾空格的细节，断言 ≤ wrapW 且接近）
    expect(firstEndX).toBeLessThanOrEqual(wrapW + 1e-6);
  });

  it('justify 拉伸后 caret 与选区矩形一致（选区右边界 = caret x）', () => {
    const wrapW = 70;
    const L = layoutDoc(docOf(para([text('aa bb cc dd')], { align: 'justify' })), shaper, resolver, opt(wrapW));
    const first = L.lines[0];
    const from: Pos = { block: 0, offset: first.startOffset };
    const to: Pos = { block: 0, offset: first.endOffset };
    const rects = selectionRects(L, from, to);
    const firstRect = rects.find((r) => Math.round(r.y) === Math.round(first.top));
    expect(firstRect).toBeTruthy();
    // 行末 caret 用 'before' affinity 贴本行行尾（'after' 会跳到下一软换行行首）
    const caretEnd = caretAt(L, to, 'before')!;
    // 选区右沿应与行末 caret x 对齐（slack 分配后 caret/选区同源）
    expect(firstRect!.x + firstRect!.w).toBeCloseTo(caretEnd.x, 6);
    // 且该行被拉满到 wrapW
    expect(caretEnd.x).toBeCloseTo(wrapW, 6);
  });
});

describe('doc-layout: distribute slack 分摊到所有字间', () => {
  it('非末行：slack 均分到每个相邻元素间隙（n-1 个）', () => {
    // 'aaaa bbbb'（含空格 9 元素）窄宽强制多行，第一行每相邻 caret 间距相等（均分）。
    const wrapW = 55;
    const L = layoutDoc(docOf(para([text('aaaaa bbbbb')], { align: 'distribute' })), shaper, resolver, opt(wrapW));
    expect(L.lines.length).toBeGreaterThan(1);
    const first = L.lines[0];
    const n = first.endOffset - first.startOffset; // 第一行元素数（无尾随空格时即字符数）
    expect(n).toBeGreaterThanOrEqual(2);
    // 按 offset 升序取每个 caret 的 x（LTR 单调递增）
    const sortedXs = [...first.offsets].sort((a, b) => a - b).map((o) => first.xs[first.offsets.indexOf(o)]);
    const steps: number[] = [];
    for (let i = 1; i < sortedXs.length; i++) steps.push(sortedXs[i] - sortedXs[i - 1]);
    // distribute：n 元素有 n-1 个「字间」均分 slack，最后一个元素本身 advance 不参与拉伸。
    // 故前 n-1 个 step 相等且 > 自然 ADV；最后一个 step = 自然 ADV。
    const stretched = steps.slice(0, steps.length - 1);
    for (const s of stretched) expect(s).toBeCloseTo(stretched[0], 6);
    expect(stretched[0]).toBeGreaterThan(ADV);
    expect(steps[steps.length - 1]).toBeCloseTo(ADV, 6);
    // 整行被拉满到 wrapW
    expect(sortedXs[sortedXs.length - 1]).toBeCloseTo(wrapW, 6);
  });

  it('distribute 末行不拉伸：caret 同自然宽', () => {
    const L = layoutDoc(docOf(para([text('a b c')], { align: 'distribute' })), shaper, resolver, opt(200));
    expect(caretAt(L, { block: 0, offset: 5 })!.x).toBe(5 * ADV);
  });
});

describe('doc-layout: spaceBefore/spaceAfter attrs 覆盖', () => {
  it('attrs.spaceBefore 推高后续块起点', () => {
    const a = layoutDoc(docOf(para([text('x')]), para([text('y')])), shaper, resolver, opt(1000));
    const b = layoutDoc(docOf(para([text('x')]), para([text('y')], { spaceBefore: 40 })), shaper, resolver, opt(1000));
    // 第二块第一行的 top：b 比 a 高出 (40 - 默认4) = 36
    const aTop = a.lines.find((l) => l.block === 1)!.top;
    const bTop = b.lines.find((l) => l.block === 1)!.top;
    expect(bTop - aTop).toBe(40 - 4);
  });
});

describe('doc-layout: indent attrs 覆盖块主题', () => {
  it('attrs.indent 平移行起点（startX 右移 indent）', () => {
    const L = layoutDoc(docOf(para([text('ab')], { indent: 50 })), shaper, resolver, opt(1000));
    // 左对齐时行首 caret = padL + indent = 0 + 50
    expect(caretAt(L, { block: 0, offset: 0 })!.x).toBe(50);
  });

  it('bullet 主题缩进被 attrs.indent 覆盖', () => {
    const def = layoutDoc(docOf(block('bullet_item', [text('ab')])), shaper, resolver, opt(1000));
    const over = layoutDoc(docOf(block('bullet_item', [text('ab')], { indent: 0 })), shaper, resolver, opt(1000));
    expect(caretAt(def, { block: 0, offset: 0 })!.x).toBe(30);  // 主题默认
    expect(caretAt(over, { block: 0, offset: 0 })!.x).toBe(0);  // attrs 覆盖
  });
});

describe('doc-layout: toc 块生成标题行', () => {
  it('为每个 heading 生成一行，携带 tocTarget=heading 块号', () => {
    const L = layoutDoc(docOf(
      block('heading', [text('A')], { level: 1 }),
      { type: 'toc', attrs: {}, inlines: [text('')] },
      block('heading', [text('B')], { level: 2 }),
    ), shaper, resolver, opt(1000));
    const tocLines = L.lines.filter((l) => l.block === 1);
    expect(tocLines.length).toBe(2);
    expect(tocLines.map((l) => l.tocTarget)).toEqual([0, 2]);
  });

  it('toc 行 caret 恒落在 {block,0}', () => {
    const L = layoutDoc(docOf(
      block('heading', [text('A')], { level: 1 }),
      { type: 'toc', attrs: {}, inlines: [text('')] },
    ), shaper, resolver, opt(1000));
    const tocLine = L.lines.find((l) => l.block === 1)!;
    expect(tocLine.offsets).toEqual([0]);
    expect(tocLine.startOffset).toBe(0);
    expect(tocLine.endOffset).toBe(0);
  });

  it('无标题时仍占一行占位（tocTarget 未设）', () => {
    const L = layoutDoc(docOf(
      para([text('body')]),
      { type: 'toc', attrs: {}, inlines: [text('')] },
    ), shaper, resolver, opt(1000));
    const tocLines = L.lines.filter((l) => l.block === 1);
    expect(tocLines.length).toBe(1);
    expect(tocLines[0].tocTarget).toBeUndefined();
  });

  it('布局扫描为缺 id 的 heading 就地补 attrs.id', () => {
    const doc = docOf(
      block('heading', [text('A')], { level: 1 }),
      { type: 'toc', attrs: {}, inlines: [text('')] },
    );
    expect(doc.blocks[0].attrs.id).toBeUndefined();
    layoutDoc(doc, shaper, resolver, opt(1000));
    expect(doc.blocks[0].attrs.id).toBeTruthy();
  });
});

describe('doc-layout: shape 原子块覆盖框', () => {
  it('shape 产出一个 overlay box（kind=shape），按 attrs.width/height 定尺寸', () => {
    const doc = docOf({ type: 'shape', attrs: { shape: 'rect', width: 200, height: 120 }, inlines: [text('')] });
    const L = layoutDoc(doc, shaper, resolver, opt(1000));
    expect(L.overlays).toHaveLength(1);
    const box = L.overlays[0];
    expect(box.kind).toBe('shape');
    expect(box.w).toBe(200); // dpr=1
    expect(box.h).toBe(120);
    // caret 行落在 {block,0}
    const ln = L.lines.find((l) => l.block === 0)!;
    expect(ln.offsets).toEqual([0]);
  });

  it('align=center / right 水平定位 shape（与 image 一致）', () => {
    const contentW = 600;
    const center = layoutDoc(docOf({ type: 'shape', attrs: { shape: 'ellipse', width: 200, height: 120, align: 'center' }, inlines: [text('')] }), shaper, resolver, opt(contentW));
    const right = layoutDoc(docOf({ type: 'shape', attrs: { shape: 'ellipse', width: 200, height: 120, align: 'right' }, inlines: [text('')] }), shaper, resolver, opt(contentW));
    expect(center.overlays[0].x).toBe((contentW - 200) / 2);
    expect(right.overlays[0].x).toBe(contentW - 200);
  });

  it('未给尺寸时用默认（width=200, height=120）', () => {
    const L = layoutDoc(docOf({ type: 'shape', attrs: { shape: 'star' }, inlines: [text('')] }), shaper, resolver, opt(1000));
    expect(L.overlays[0].w).toBe(200);
    expect(L.overlays[0].h).toBe(120);
  });
});

describe('doc-layout: 行内图片（行内原子）', () => {
  const atom = (w?: number, h?: number) => inlineAtom('image', { src: 'x.png', width: w, height: h });

  it('行内原子产出一个 inlineOverlay 盒（kind=image），不产 glyph', () => {
    const L = layoutDoc(docOf(para([text('ab'), atom(20, 30), text('cd')])), shaper, resolver, opt(1000));
    expect(L.inlineOverlays).toHaveLength(1);
    const box = L.inlineOverlays[0];
    expect(box.kind).toBe('image');
    expect(box.block).toBe(0);
    expect(box.offset).toBe(2);  // 'ab' 之后
    expect(box.w).toBe(20);      // dpr=1，显式 width
    expect(box.h).toBe(30);      // 显式 height
    // 文本字符产 caret 偏移；原子占 1 offset 但不产字形（仅产 inlineOverlay）
    const ln = L.lines[0];
    expect(ln.endOffset).toBe(5); // ab(2) + atom(1) + cd(2)
  });

  it('行内原子 advance = 显示宽，caret 在其两侧 x 间隔 = 宽度', () => {
    // 'a' + atom(width=25) + 'b'：caret offset 0/1/2/3
    const L = layoutDoc(docOf(para([text('a'), atom(25, 20), text('b')])), shaper, resolver, opt(1000));
    const c0 = caretAt(L, { block: 0, offset: 0 })!.x;
    const c1 = caretAt(L, { block: 0, offset: 1 })!.x; // 原子左缘
    const c2 = caretAt(L, { block: 0, offset: 2 })!.x; // 原子右缘
    const c3 = caretAt(L, { block: 0, offset: 3 })!.x;
    expect(c1 - c0).toBe(ADV);       // 'a' 宽
    expect(c2 - c1).toBe(25);        // 原子显示宽
    expect(c3 - c2).toBe(ADV);       // 'b' 宽
    // 原子盒左缘 = caret offset 1 处 x
    expect(L.inlineOverlays[0].x).toBe(c1);
  });

  it('行内原子占 1 offset：选区跨原子的右沿 = 原子右缘 caret', () => {
    const L = layoutDoc(docOf(para([text('a'), atom(25, 20), text('b')])), shaper, resolver, opt(1000));
    const from: Pos = { block: 0, offset: 0 };
    const to: Pos = { block: 0, offset: 2 }; // 选中 'a' + 原子
    const rects = selectionRects(L, from, to);
    expect(rects.length).toBeGreaterThan(0);
    const r = rects[0];
    const caretTo = caretAt(L, to)!.x;
    expect(r.x + r.w).toBeCloseTo(caretTo, 6); // 选区右沿与 caret 一致
  });

  it('未给尺寸时用固定 ~1.2em 方形（宽=高，>0）', () => {
    const L = layoutDoc(docOf(para([inlineAtom('image', { src: 'x' })])), shaper, resolver, opt(1000));
    const box = L.inlineOverlays[0];
    expect(box.w).toBeGreaterThan(0);
    expect(box.w).toBe(box.h); // 缺省方形
  });

  it('行内原子撑高行盒：行高 ≥ 原子高度', () => {
    const tall = layoutDoc(docOf(para([text('a'), atom(20, 100), text('b')])), shaper, resolver, opt(1000));
    const ln = tall.lines[0];
    expect(ln.bottom - ln.top).toBeGreaterThanOrEqual(100);
  });
});

// —— 集群4 回归测试：doc-layout 正确性（RTL/BiDi 选区、tie-break、TOC 方向）——

// 4 个希伯来字母（RTL 码位），触发 BiDi 重排路径（mayBeBidi 命中）。
const HE = 'אבגד';

describe('doc-layout 回归: LineBox minX/maxX 精确记录视觉行边界 (item 1)', () => {
  it('RTL 多行：minX/maxX 恰好包住该行所有 caret xs（不依赖 xs 已排序）', () => {
    // 'אבגד אבגד' 在窄宽下换成两行；RTL 时 xs 随 offset 递减（非升序）。
    const L = layoutDoc(docOf(para([text(HE + ' ' + HE)], { dir: 'rtl' })), shaper, resolver, opt(60));
    expect(L.lines.length).toBeGreaterThan(1);
    for (const ln of L.lines) {
      expect(ln.rtl).toBe(true);
      // minX/maxX 是该行真实左右边界：所有 caret x 都落在 [minX, maxX] 内，
      // 且二者分别等于 xs 的最小/最大（此处简单 RTL 串中 caret 触达两端）。
      const lo = Math.min(...ln.xs), hi = Math.max(...ln.xs);
      expect(ln.minX).toBeLessThanOrEqual(lo);
      expect(ln.maxX).toBeGreaterThanOrEqual(hi);
      for (const x of ln.xs) { expect(x).toBeGreaterThanOrEqual(ln.minX); expect(x).toBeLessThanOrEqual(ln.maxX); }
    }
  });

  it('RTL 多行选区：非末行延续到行尾时右沿用 minX（行左缘），不靠 Math.min(...xs)', () => {
    const L = layoutDoc(docOf(para([text(HE + ' ' + HE)], { dir: 'rtl' })), shaper, resolver, opt(60));
    const lines = L.lines.filter((l) => l.block === 0);
    const first = lines[0];
    // 选区从首行行首跨到下一行内部 → 首行 extendBeyond，RTL 下应画到首行左缘 minX。
    const from: Pos = { block: 0, offset: first.startOffset };
    const to: Pos = { block: 0, offset: lines[1].endOffset };
    const rects = selectionRects(L, from, to);
    const firstRect = rects.find((r) => Math.round(r.y) === Math.round(first.top))!;
    expect(firstRect).toBeTruthy();
    // 首行选区左边界 = 行视觉左缘 = ln.minX（RTL 延续方向）
    expect(firstRect.x).toBeCloseTo(first.minX, 6);
    // 右边界 = 行首 caret（RTL 行首在右）= 行最大 x
    expect(firstRect.x + firstRect.w).toBeCloseTo(Math.max(...first.xs), 6);
  });

  it('LTR 行 minX=startX、maxX=行末 caret（与 contentRight 选区延续不冲突）', () => {
    const L = layoutDoc(docOf(para([text('abcd')])), shaper, resolver, opt(1000));
    const ln = L.lines[0];
    expect(ln.minX).toBe(0);                 // padL=0，左对齐
    expect(ln.maxX).toBe(4 * ADV);           // 4 字宽
    expect(ln.minX).toBe(Math.min(...ln.xs));
    expect(ln.maxX).toBe(Math.max(...ln.xs));
  });
});

describe('doc-layout 回归: offsets 升序 + nearestIndex 稳定 tie-break (item 2)', () => {
  it('RTL 行 offsets 升序、xs 同步重排（caret 仍取对应 x）', () => {
    const L = layoutDoc(docOf(para([text(HE)], { dir: 'rtl' })), shaper, resolver, opt(1000));
    const ln = L.lines[0];
    // offsets 严格升序
    for (let i = 1; i < ln.offsets.length; i++) expect(ln.offsets[i]).toBeGreaterThan(ln.offsets[i - 1]);
    // xs 与 offsets 仍一一对应：caretAt 每个 offset 命中其原始 x（RTL 下 x 随 offset 递减）
    for (let i = 0; i < ln.offsets.length; i++) {
      const c = caretAt(L, { block: 0, offset: ln.offsets[i] }, 'before')!;
      expect(c.x).toBe(ln.xs[i]);
    }
    // RTL：offset 越大 x 越小（升序 offsets 对应递减 xs）
    for (let i = 1; i < ln.xs.length; i++) expect(ln.xs[i]).toBeLessThan(ln.xs[i - 1]);
  });

  it('hitTestDoc 在 RTL 行上等距命中确定性取较小 offset（稳定 tie-break）', () => {
    const L = layoutDoc(docOf(para([text(HE)], { dir: 'rtl' })), shaper, resolver, opt(1000));
    const ln = L.lines[0];
    // 取相邻两 caret 的正中点 px：到两侧等距 → 稳定取 offset 较小者（offsets 升序 + 严格 <）
    const px = (ln.xs[0] + ln.xs[1]) / 2;
    const hit = hitTestDoc(L, px, ln.baseline);
    expect(hit.offset).toBe(ln.offsets[0]);
    // 多次调用结果一致（确定性）
    expect(hitTestDoc(L, px, ln.baseline).offset).toBe(hit.offset);
  });
});

describe('doc-layout 回归: TOC 行方向跟随目标 heading dir (item 5)', () => {
  it('RTL 标题 → 目录项 rtl=true；LTR 标题 → rtl=false', () => {
    const L = layoutDoc(docOf(
      block('heading', [text(HE)], { level: 1, dir: 'rtl' }),
      block('heading', [text('B')], { level: 1 }),
      { type: 'toc', attrs: {}, inlines: [text('')] },
    ), shaper, resolver, opt(1000));
    const tocLines = L.lines.filter((l) => l.block === 2);
    expect(tocLines.length).toBe(2);
    // 第 1 个目录项指向 RTL 标题 → rtl=true；第 2 个指向 LTR 标题 → rtl=false
    expect(tocLines[0].tocTarget).toBe(0);
    expect(tocLines[0].rtl).toBe(true);
    expect(tocLines[1].tocTarget).toBe(1);
    expect(tocLines[1].rtl).toBe(false);
  });

  it('无标题占位目录行保持 rtl=false', () => {
    const L = layoutDoc(docOf(
      para([text('body')]),
      { type: 'toc', attrs: {}, inlines: [text('')] },
    ), shaper, resolver, opt(1000));
    const tocLine = L.lines.find((l) => l.block === 1)!;
    expect(tocLine.rtl).toBe(false);
    expect(tocLine.tocTarget).toBeUndefined();
  });
});

describe('doc-layout: 媒体原子块（集群A）覆盖盒', () => {
  it('audio/attachment：满内容宽 + 固定高度，产出对应 kind 覆盖盒', () => {
    const L = layoutDoc(docOf(
      { type: 'audio', attrs: { src: 'a.mp3' }, inlines: [text('')] },
      { type: 'attachment', attrs: { src: 'f.pdf', name: 'f.pdf' }, inlines: [text('')] },
    ), shaper, resolver, opt(600));
    const audio = L.overlays.find((o) => o.block === 0)!;
    const attach = L.overlays.find((o) => o.block === 1)!;
    expect(audio.kind).toBe('audio');
    expect(attach.kind).toBe('attachment');
    // 满内容宽（dpr=1、padL=0 → 内容宽 = width）
    expect(audio.w).toBe(600);
    expect(attach.w).toBe(600);
    // 固定高度（音频 54 / 附件 64 逻辑 px）
    expect(audio.h).toBe(54);
    expect(attach.h).toBe(64);
  });

  it('video/iframe：用 attrs.width/height 定尺寸，按 align 水平定位', () => {
    const L = layoutDoc(docOf(
      { type: 'video', attrs: { src: 'v.mp4', width: 200, height: 100 }, inlines: [text('')] },
      { type: 'iframe', attrs: { src: 'e.com', width: 200, height: 100, align: 'right' }, inlines: [text('')] },
    ), shaper, resolver, opt(600));
    const video = L.overlays.find((o) => o.block === 0)!;
    const iframe = L.overlays.find((o) => o.block === 1)!;
    expect(video.kind).toBe('video');
    expect(iframe.kind).toBe('iframe');
    expect(video.w).toBe(200);
    expect(video.h).toBe(100);
    // 默认左对齐 → x = contentLeft = 0
    expect(video.x).toBe(0);
    // 右对齐 → x = contentRight - w = 600 - 200
    expect(iframe.x).toBe(400);
  });

  it('video/iframe 缺省尺寸时回退默认宽高（非 0）', () => {
    const L = layoutDoc(docOf(
      { type: 'video', attrs: { src: 'v.mp4' }, inlines: [text('')] },
    ), shaper, resolver, opt(1000));
    const video = L.overlays.find((o) => o.block === 0)!;
    expect(video.w).toBeGreaterThan(0);
    expect(video.h).toBeGreaterThan(0);
  });
});



// —— 集群1 回归测试：功能性缩放（scale = deviceDpr × zoom）下坐标自洽 ——
// 契约：布局以 dpr=scale 产坐标，布局 px 与 canvas 物理 px 同一坐标系（zoom 含在坐标值内）。
// 故 屏幕 CSS ↔ 布局 = ×/÷ deviceDpr；逻辑 px ↔ 布局 = ×/÷ scale。
// main.ts 的 eventXY/IME 用前者，indent/attrs 尺寸（taskCheckboxHit/原子块）用后者。

// 随 scale 缩放的确定性 Shaper：advance/度量 = 逻辑常量 × scale（仿真实整形器按图集 dpr 光栅化）。
class ScaledFakeShaper implements Shaper {
  readonly name = 'fake-scaled';
  constructor(private readonly scale: number) {}
  fontMetrics(_style: Style): FontMetrics {
    void _style;
    return { ascent: ASCENT * this.scale, descent: DESCENT * this.scale, lineHeight: LINEH * this.scale };
  }
  shapeChars(chars: StyledChar[]): ShapedChar[] {
    return chars.map(() => ({ advance: ADV * this.scale, glyph: EMPTY_GLYPH }));
  }
}

describe('doc-layout: zoom≠1（dpr=scale）坐标自洽', () => {
  const DEVICE_DPR = 2, ZOOM = 1.5, SCALE = DEVICE_DPR * ZOOM; // scale = 3
  const PADL = 26 * SCALE;
  const optZ = (width: number): DocLayoutOpts => ({ width, padL: PADL, padT: PADL, dpr: SCALE });
  const zoomShaper = new ScaledFakeShaper(SCALE);

  it('caret ↔ hit 在布局坐标系内闭环：每个 offset 命中回自身', () => {
    const L = layoutDoc(docOf(para([text('hello world')]), para([text('second')])), zoomShaper, resolver, optZ(2000));
    for (const ln of L.lines) {
      for (let off = ln.startOffset; off <= ln.endOffset; off++) {
        const c = caretAt(L, { block: ln.block, offset: off }, 'after')!;
        const midY = (c.top + c.bottom) / 2;
        expect(hitTestDoc(L, c.x, midY)).toEqual({ block: ln.block, offset: off });
      }
    }
  });

  it('屏幕 CSS → 布局换算必须 ×设备 dpr（×scale 会按 zoom 双重放大、命中漂移）', () => {
    const L = layoutDoc(docOf(para([text('abcdef')])), zoomShaper, resolver, optZ(2000));
    const pos: Pos = { block: 0, offset: 4 };
    const c = caretAt(L, pos)!;
    // 屏幕 CSS 位置 = 布局 px ÷ deviceDpr（布局 px 即 canvas 物理 px）
    const cssX = c.x / DEVICE_DPR, cssY = ((c.top + c.bottom) / 2) / DEVICE_DPR;
    // 正确换算（eventXY：×deviceDpr）命中原 offset
    expect(hitTestDoc(L, cssX * DEVICE_DPR, cssY * DEVICE_DPR)).toEqual(pos);
    // 错误换算（×scale）：x 被多放大 zoom 倍 → 命中漂移到别的 offset
    expect(hitTestDoc(L, cssX * SCALE, cssY * SCALE)).not.toEqual(pos);
  });

  it('原子块 overlay 盒按 scale 产出：尺寸 = attrs 逻辑值 × scale，且与保留行几何一致', () => {
    const L = layoutDoc(
      docOf({ type: 'image', attrs: { src: 'x.png', width: 100, height: 50 }, inlines: [text('')] }),
      zoomShaper, resolver, optZ(2000),
    );
    const box = L.overlays[0];
    expect(box.w).toBe(100 * SCALE);
    expect(box.h).toBe(50 * SCALE);
    const ln = L.lines.find((l) => l.block === 0)!;
    expect(box.y).toBe(ln.top);
    expect(ln.bottom - ln.top).toBe(box.h); // canvas 预留高度 = 盒高（屏幕上同 ÷deviceDpr 对齐）
  });

  it('formula 实测高度以逻辑 px 回填：保留高度 = measuredH × scale（覆盖层 ÷scale 即还原闭环）', () => {
    const L = layoutDoc(
      docOf({ type: 'formula', attrs: { latex: 'x', measuredH: 80 }, inlines: [text('')] }),
      zoomShaper, resolver, optZ(2000),
    );
    expect(L.overlays[0].h).toBe(80 * SCALE);
  });

  it('task_item 勾选栏边界：首行起始 x = padL + indent×scale（taskCheckboxHit 同式）', () => {
    const blk = block('task_item', [text('todo')]);
    const L = layoutDoc(docOf(blk), zoomShaper, resolver, optZ(2000));
    const indent = resolver.resolveBlock(blk).indent;
    expect(indent).toBeGreaterThan(0);
    expect(L.lines[0].xs[0]).toBe(PADL + indent * SCALE);
  });

  it('行内原子盒按 scale 产出，且左缘与 caret 同步（行内图片覆盖层对齐）', () => {
    const L = layoutDoc(
      docOf(para([text('a'), inlineAtom('image', { src: 'x', width: 25, height: 20 }), text('b')])),
      zoomShaper, resolver, optZ(2000),
    );
    const box = L.inlineOverlays[0];
    expect(box.w).toBe(25 * SCALE);
    expect(box.h).toBe(20 * SCALE);
    expect(box.x).toBe(caretAt(L, { block: 0, offset: 1 })!.x);
  });
});
