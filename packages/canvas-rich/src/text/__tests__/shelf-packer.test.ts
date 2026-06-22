import { describe, it, expect } from 'vitest';
import { ShelfPacker, PackSlot, unionRect } from '../shelf-packer';

// 多页货架打包纯算术的不变量测试（node 环境，零 canvas 依赖）：
// 槽位互不重叠/不越界、行满换架、架满开新页（已放槽位有效）、达上限 null、reset 复位、
// maxContent 夹紧边界上必然成功、unionRect 脏区并集。

// 确定性伪随机（mulberry32），保证随机打包测试可复现
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAD = 2;

// 含 PAD 边距的占位盒是否重叠（同页才比较）
function overlaps(a: { slot: PackSlot; w: number; h: number }, b: { slot: PackSlot; w: number; h: number }): boolean {
  if (a.slot.page !== b.slot.page) return false;
  const ax0 = a.slot.ox - PAD,
    ay0 = a.slot.oy - PAD,
    ax1 = a.slot.ox + a.w + PAD,
    ay1 = a.slot.oy + a.h + PAD;
  const bx0 = b.slot.ox - PAD,
    by0 = b.slot.oy - PAD,
    bx1 = b.slot.ox + b.w + PAD,
    by1 = b.slot.oy + b.h + PAD;
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
}

describe('ShelfPacker: 槽位分配不变量', () => {
  it('随机尺寸序列：所有槽位（含边距）互不重叠且不越页界', () => {
    const packer = new ShelfPacker(256, 4, PAD);
    const rng = mulberry32(42);
    const placed: { slot: PackSlot; w: number; h: number }[] = [];
    for (let i = 0; i < 1000; i++) {
      const w = 1 + Math.floor(rng() * 50);
      const h = 1 + Math.floor(rng() * 50);
      const slot = packer.alloc(w, h);
      if (!slot) break; // 4 页全满
      // 不越界（含 PAD 边距）
      expect(slot.ox - PAD).toBeGreaterThanOrEqual(0);
      expect(slot.oy - PAD).toBeGreaterThanOrEqual(0);
      expect(slot.ox + w + PAD).toBeLessThanOrEqual(256);
      expect(slot.oy + h + PAD).toBeLessThanOrEqual(256);
      expect(slot.page).toBeLessThan(4);
      placed.push({ slot, w, h });
    }
    expect(placed.length).toBeGreaterThan(50); // 4×256² 至少能放下几十个 ≤50px 槽
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
  });

  it('行满换架：penX 回卷、penY 按架高推进', () => {
    const packer = new ShelfPacker(64, 1, PAD);
    const a = packer.alloc(30, 10)!;
    expect(a).toEqual({ page: 0, ox: 4, oy: 4 });
    const b = packer.alloc(30, 10)!; // 36+34 > 64 → 换架
    expect(b).toEqual({ page: 0, ox: 4, oy: 18 }); // penY = 2 + (10+2*PAD)
  });

  it('架满开新页：新槽落到下一页，已放槽位坐标不受影响', () => {
    const packer = new ShelfPacker(64, 2, PAD);
    const a = packer.alloc(58, 58)!; // 占满整页（maxContent=58）
    expect(a).toEqual({ page: 0, ox: 4, oy: 4 });
    const b = packer.alloc(30, 30)!;
    expect(b).toEqual({ page: 1, ox: 4, oy: 4 }); // 开新页，page0 不动
    expect(packer.pageCount).toBe(2);
  });

  it('达页数上限返回 null（不自行复位）；reset 后回到单页空状态', () => {
    const packer = new ShelfPacker(64, 2, PAD);
    expect(packer.alloc(58, 58)).not.toBeNull(); // 填满 page0
    expect(packer.alloc(58, 58)).not.toBeNull(); // 填满 page1
    expect(packer.alloc(30, 30)).toBeNull(); // 两页全满 → null
    expect(packer.pageCount).toBe(2);
    packer.reset();
    expect(packer.pageCount).toBe(1);
    expect(packer.alloc(30, 30)).toEqual({ page: 0, ox: 4, oy: 4 });
  });

  it('maxContent 边界尺寸在空页上必然成功（夹紧光栅的容量担保）', () => {
    const packer = new ShelfPacker(2048, 8, PAD);
    expect(packer.maxContent).toBe(2048 - PAD * 3);
    const slot = packer.alloc(packer.maxContent, packer.maxContent);
    expect(slot).toEqual({ page: 0, ox: 4, oy: 4 });
    // 第二个同尺寸槽放不进 page0 → 开新页仍成功
    expect(packer.alloc(packer.maxContent, packer.maxContent)).toEqual({ page: 1, ox: 4, oy: 4 });
  });

  it('超过 maxContent 或非正尺寸直接返回 null（调用方需先夹紧）', () => {
    const packer = new ShelfPacker(64, 8, PAD);
    expect(packer.alloc(packer.maxContent + 1, 10)).toBeNull();
    expect(packer.alloc(10, packer.maxContent + 1)).toBeNull();
    expect(packer.alloc(0, 10)).toBeNull();
    expect(packer.alloc(10, -1)).toBeNull();
    expect(packer.pageCount).toBe(1); // 失败不开页
  });
});

describe('unionRect: 脏区并集', () => {
  it('空基底返回 b 的拷贝（不共享引用）', () => {
    const b = { x: 1, y: 2, w: 3, h: 4 };
    const u = unionRect(null, b);
    expect(u).toEqual(b);
    expect(u).not.toBe(b);
  });

  it('相离矩形并集为包围盒', () => {
    expect(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 30, w: 5, h: 5 })).toEqual({ x: 0, y: 0, w: 25, h: 35 });
  });

  it('包含关系并集为外接矩形本身', () => {
    expect(unionRect({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 5, h: 5 })).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
  });
});
