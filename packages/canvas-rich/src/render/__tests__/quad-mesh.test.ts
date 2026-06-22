import { describe, it, expect } from 'vitest';
import { Quad } from '../renderer';
import { buildPageRuns, buildQuadMesh, FLOATS_PER_VERT, VERTS_PER_QUAD } from '../quad-mesh';

// 按页分批 draw 的纯算术测试：run 切分必须严格保序（不跨段重排），
// 这是「背景→选区→字形→装饰→光标」z 序与 AA 混色顺序正确性的前提。

const quad = (page: number): Quad => ({
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  u0: 0,
  v0: 0,
  u1: 1,
  v1: 1,
  r: 1,
  g: 1,
  b: 1,
  a: 1,
  page,
});

describe('buildPageRuns: 相邻同页切段（保序）', () => {
  it('空列表 → 空 run', () => {
    expect(buildPageRuns([])).toEqual([]);
  });

  it('全部同页 → 单段全量', () => {
    expect(buildPageRuns([quad(0), quad(0), quad(0)])).toEqual([{ page: 0, start: 0, count: 3 }]);
  });

  it('混页序列：只在页号变化处切段，绝不重排（同页号可出现在多段）', () => {
    const quads = [quad(0), quad(0), quad(1), quad(0), quad(2), quad(2)];
    expect(buildPageRuns(quads)).toEqual([
      { page: 0, start: 0, count: 2 },
      { page: 1, start: 2, count: 1 },
      { page: 0, start: 3, count: 1 }, // page0 第二段：保序，不与首段合并
      { page: 2, start: 4, count: 2 },
    ]);
  });

  it('run 区间无缝覆盖整个 quads 数组（顶点下标可直接乘 VERTS_PER_QUAD）', () => {
    const quads = [quad(3), quad(1), quad(1), quad(0), quad(3), quad(3), quad(3)];
    const runs = buildPageRuns(quads);
    let next = 0;
    for (const r of runs) {
      expect(r.start).toBe(next);
      next += r.count;
    }
    expect(next).toBe(quads.length);
  });
});

describe('buildQuadMesh: page 字段不进顶点流', () => {
  it('顶点 stride 仍为 8 float（page 由分批绑定纹理承载，不占顶点属性）', () => {
    const quads = [quad(0), quad(5)];
    const { used } = buildQuadMesh(quads, new Float32Array(0));
    expect(used).toBe(quads.length * VERTS_PER_QUAD * FLOATS_PER_VERT);
    expect(FLOATS_PER_VERT).toBe(8);
  });
});
