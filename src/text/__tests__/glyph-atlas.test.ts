import { describe, it, expect } from 'vitest';
import { GlyphAtlas } from '../glyph-atlas';
import { Style } from '../../types';

// GlyphAtlas 多页行为测试（node 环境）：构造注入假 canvas 工厂 + 测试用小页尺寸，
// 覆盖 页溢出开新页 / 字形跨页查询 / 巨字形夹紧不触发复位 / 达页上限整体复位兜底 /
// per-page 脏矩形 / setDpr 收缩页数。Canvas2D 光栅本身（像素正确性）留浏览器实测。

// —— 假 Canvas2D：只实现 GlyphAtlas 用到的成员，度量可按字符配置 ——
interface FakeBox { adv: number; left: number; right: number; asc: number; desc: number }

class FakeCtx {
  font = '';
  textBaseline = '';
  textAlign = '';
  fillStyle = '';
  fillTextCalls: { ch: string; x: number; y: number }[] = [];
  fillRectCalls: { x: number; y: number; w: number; h: number }[] = [];
  scaleCalls: number[] = [];
  measureCalls = 0;

  constructor(private measure: (ch: string) => FakeBox) {}

  clearRect(_x: number, _y: number, _w: number, _h: number): void { void _x; }
  save(): void {}
  restore(): void {}
  translate(_x: number, _y: number): void { void _x; }
  scale(kx: number, _ky: number): void { void _ky; this.scaleCalls.push(kx); }
  fillRect(x: number, y: number, w: number, h: number): void { this.fillRectCalls.push({ x, y, w, h }); }
  fillText(ch: string, x: number, y: number): void { this.fillTextCalls.push({ ch, x, y }); }
  measureText(ch: string): TextMetrics {
    this.measureCalls++;
    const b = this.measure(ch);
    return {
      width: b.adv,
      actualBoundingBoxLeft: b.left,
      actualBoundingBoxRight: b.right,
      actualBoundingBoxAscent: b.asc,
      actualBoundingBoxDescent: b.desc,
      fontBoundingBoxAscent: b.asc,
      fontBoundingBoxDescent: b.desc,
    } as TextMetrics;
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly ctx: FakeCtx;
  constructor(measure: (ch: string) => FakeBox) { this.ctx = new FakeCtx(measure); }
  getContext(_id: string, _opts?: unknown): FakeCtx { void _id; return this.ctx; }
}

// 默认度量：每字符 30×30 的方盒（adv=30）；空格无可见像素
const box30 = (ch: string): FakeBox =>
  ch === ' ' ? { adv: 10, left: 0, right: 0, asc: 0, desc: 0 } : { adv: 30, left: 0, right: 30, asc: 30, desc: 0 };

const STYLE: Style = { fontFamily: 'fake', fontSize: 20, bold: false, italic: false, color: [1, 1, 1, 1] };

// 测试图集：pageSize=64（PAD=2 → maxContent=58），白块占首槽 (4,4)
function makeAtlas(measure: (ch: string) => FakeBox, maxPages: number, pageSize = 64): { atlas: GlyphAtlas; canvases: FakeCanvas[] } {
  const canvases: FakeCanvas[] = [];
  const factory = () => {
    const c = new FakeCanvas(measure);
    canvases.push(c);
    return c as unknown as HTMLCanvasElement;
  };
  return { atlas: new GlyphAtlas(factory, 1, { pageSize, maxPages }), canvases };
}

describe('GlyphAtlas: 多页分配', () => {
  it('页满开新页：已放字形不动、不触发整体复位', () => {
    const { atlas } = makeAtlas(box30, 8);
    // page0：白块后放下 'A'（penX=8 → ox=10），'B' 行/架均放不下 → 开 page1
    const a = atlas.getGlyph('A', STYLE);
    expect(a.page).toBe(0);
    const b = atlas.getGlyph('B', STYLE);
    expect(b.page).toBe(1);
    expect(atlas.pageCount).toBe(2);
    expect(atlas.consumeReset()).toBe(false); // 开新页 ≠ 复位
    expect(atlas.generation).toBe(0);
    expect(a.exhausted).toBeUndefined();
    expect(b.exhausted).toBeUndefined();
  });

  it('字形跨页查询：缓存命中返回原对象，UV/页号稳定', () => {
    const { atlas, canvases } = makeAtlas(box30, 8);
    const a1 = atlas.getGlyph('A', STYLE);
    const b1 = atlas.getGlyph('B', STYLE);
    const a2 = atlas.getGlyph('A', STYLE);
    const b2 = atlas.getGlyph('B', STYLE);
    expect(a2).toBe(a1); // 同一引用（缓存命中，不重栅）
    expect(b2).toBe(b1);
    expect(a2.page).toBe(0);
    expect(b2.page).toBe(1);
    // 每字符只 fillText 一次（A 在 page0 画布、B 在 page1 画布）
    expect(canvases[0].ctx.fillTextCalls.map((c) => c.ch)).toEqual(['A']);
    expect(canvases[1].ctx.fillTextCalls.map((c) => c.ch)).toEqual(['B']);
  });

  it('空白字符：empty 占位、page=0、不占槽位', () => {
    const { atlas } = makeAtlas(box30, 8);
    const sp = atlas.getGlyph(' ', STYLE);
    expect(sp.empty).toBe(true);
    expect(sp.page).toBe(0);
    expect(sp.advance).toBe(10);
    expect(atlas.pageCount).toBe(1);
  });
});

describe('GlyphAtlas: 巨字形夹紧（不触发 reset 风暴）', () => {
  it('超页字形降采样光栅：度量存全尺寸、UV 不超 maxContent、零复位', () => {
    // 200×100 字形 > 单页 64：k = 58/200，槽位 58×29
    const giant = (ch: string): FakeBox => (ch === 'G' ? { adv: 200, left: 0, right: 200, asc: 100, desc: 0 } : box30(ch));
    const { atlas, canvases } = makeAtlas(giant, 8);
    const g = atlas.getGlyph('G', STYLE);
    expect(g.exhausted).toBeUndefined(); // 任何尺寸都能分配成功
    expect(g.empty).toBe(false);
    expect(g.w).toBe(200); // 度量存全尺寸（渲染 quad 取全尺寸，GPU 放大小位图）
    expect(g.h).toBe(100);
    expect((g.u1 - g.u0) * 64).toBeLessThanOrEqual(58); // 位图被夹进 maxContent
    expect((g.v1 - g.v0) * 64).toBeLessThanOrEqual(58);
    expect(canvases[0].ctx.scaleCalls).toEqual([58 / 200]); // 降采样绘制
    expect(atlas.consumeReset()).toBe(false); // 尺寸性失败路径已消亡：不清图、不复位
    expect(atlas.generation).toBe(0);
    // 缓存命中：巨字形不会每次布局重清图集（旧 :156-165 雪崩路径）
    expect(atlas.getGlyph('G', STYLE)).toBe(g);
  });
});

describe('GlyphAtlas: 达页上限整体复位兜底', () => {
  it('全部页满 → resetAll：generation++、consumeReset=true、白块重画、新字形分配成功、旧缓存清空', () => {
    // pageSize=64 每页放 1 个 30×30（白块同架后再无第二架空间），maxPages=2 → 第 3 个字形触发复位
    const { atlas, canvases } = makeAtlas(box30, 2);
    const before = ['A', 'B'].map((ch) => atlas.getGlyph(ch, STYLE));
    expect(before.every((g) => !g.exhausted)).toBe(true);
    expect(atlas.pageCount).toBe(2);
    expect(atlas.consumeReset()).toBe(false);
    const whiteDrawsBefore = canvases[0].ctx.fillRectCalls.length;

    const e = atlas.getGlyph('C', STYLE); // 两页全满 → 整体复位后重试
    expect(e.exhausted).toBeUndefined(); // 复位后必成功
    expect(e.page).toBe(0);
    expect(atlas.generation).toBe(1);
    expect(atlas.consumeReset()).toBe(true); // 上层据此触发重排重栅
    expect(atlas.consumeReset()).toBe(false); // 取后即清

    // 白块重画在同一槽位 → whiteUV 保持有效
    const calls = canvases[0].ctx.fillRectCalls;
    expect(calls.length).toBe(whiteDrawsBefore + 1);
    expect(calls[calls.length - 1]).toEqual(calls[0]);

    // 旧缓存清空：再取 'A' 会重栅（fillText 次数增长），且分配出新槽位
    const fills = canvases[0].ctx.fillTextCalls.length + canvases[1].ctx.fillTextCalls.length;
    const a2 = atlas.getGlyph('A', STYLE);
    expect(a2.exhausted).toBeUndefined();
    expect(canvases[0].ctx.fillTextCalls.length + canvases[1].ctx.fillTextCalls.length).toBe(fills + 1);
  });
});

describe('GlyphAtlas: per-page 脏矩形', () => {
  it('takeDirtyPages 返回各页脏区并集（含 PAD 边距）并清空；无新写入时返回空', () => {
    const { atlas, canvases } = makeAtlas(box30, 8);
    atlas.getGlyph('A', STYLE); // page0（白块 + A）
    atlas.getGlyph('B', STYLE); // page1
    const dirty = atlas.takeDirtyPages();
    expect(dirty.map((d) => d.page)).toEqual([0, 1]);
    // page0：白块槽 (4,4,2,2) ∪ A 槽 (10,4,30,30)，含 PAD → {2,2,40,34}
    expect(dirty[0].rect).toEqual({ x: 2, y: 2, w: 40, h: 34 });
    expect(dirty[0].canvas).toBe(canvases[0] as unknown as HTMLCanvasElement);
    // page1：B 槽 (4,4,30,30) 含 PAD → {2,2,34,34}
    expect(dirty[1].rect).toEqual({ x: 2, y: 2, w: 34, h: 34 });
    expect(atlas.takeDirtyPages()).toEqual([]); // 取后即清
    atlas.getGlyph('C', STYLE); // page1 也满 → 开 page2 → 仅 page2 脏
    expect(atlas.takeDirtyPages().map((d) => d.page)).toEqual([2]);
  });
});

describe('GlyphAtlas: setDpr', () => {
  it('比例变化整体复位并收缩回 1 页；比例未变零开销', () => {
    const { atlas } = makeAtlas(box30, 8);
    atlas.getGlyph('A', STYLE);
    atlas.getGlyph('B', STYLE);
    expect(atlas.pageCount).toBe(2);
    atlas.consumeReset();
    const gen = atlas.generation;

    atlas.setDpr(1); // 未变：零开销
    expect(atlas.generation).toBe(gen);
    expect(atlas.consumeReset()).toBe(false);
    expect(atlas.pageCount).toBe(2);

    atlas.setDpr(2); // 变化：全清 + 页数收缩
    expect(atlas.pageCount).toBe(1);
    expect(atlas.generation).toBe(gen + 1);
    expect(atlas.consumeReset()).toBe(true);
    const a = atlas.getGlyph('A', STYLE); // 新比例重栅
    expect(a.exhausted).toBeUndefined();
  });
});

describe('GlyphAtlas: addGlyphById（HarfBuzz 路径）', () => {
  it('draw 收到所在页上下文与槽位；缓存命中不重绘；巨字形同样夹紧', () => {
    const { atlas, canvases } = makeAtlas(box30, 8);
    let drawCount = 0;
    let drawCtx: unknown = null;
    const info = { w: 30, h: 30, bearingX: 0, bearingY: 30, advance: 30, empty: false };
    const g1 = atlas.addGlyphById('hb:r:1:20', info, (ctx, ox, oy) => { drawCount++; drawCtx = ctx; void ox; void oy; });
    expect(g1.page).toBe(0);
    expect(drawCount).toBe(1);
    expect(drawCtx).toBe(canvases[0].ctx);
    const g2 = atlas.addGlyphById('hb:r:1:20', info, () => { drawCount++; });
    expect(g2).toBe(g1); // 缓存命中
    expect(drawCount).toBe(1);

    // 巨字形：槽位夹紧、draw 在缩放系内执行、度量存全尺寸
    const big = { w: 200, h: 100, bearingX: 0, bearingY: 100, advance: 200, empty: false };
    const g3 = atlas.addGlyphById('hb:r:2:999', big, () => {});
    expect(g3.exhausted).toBeUndefined();
    expect(g3.w).toBe(200);
    expect((g3.u1 - g3.u0) * 64).toBeLessThanOrEqual(58);
    expect(canvases[g3.page].ctx.scaleCalls).toContain(58 / 200);
    expect(atlas.consumeReset()).toBe(false);
  });
});
