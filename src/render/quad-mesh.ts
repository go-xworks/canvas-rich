import { Quad } from './renderer';

// 顶点网格组装：WebGL2 / WebGPU 两个后端共用（消除重复的顶点布局 + 三角形展开 + 缓冲扩容）。
// 分层位置：render 层内部工具，被两个后端复用，不对外导出语义。

/** 每个顶点的 float 数（x,y,u,v,r,g,b,a），决定顶点缓冲 stride。 @internal */
export const FLOATS_PER_VERT = 8; // x,y,u,v,r,g,b,a
/** 每个 quad 展开成的顶点数（两个三角形）。 @internal */
export const VERTS_PER_QUAD = 6;  // 两个三角形：左上/右上/左下 + 右上/右下/左下

function push(buf: Float32Array, o: number, x: number, y: number, u: number, v: number, r: number, g: number, b: number, a: number): number {
  buf[o] = x; buf[o + 1] = y; buf[o + 2] = u; buf[o + 3] = v;
  buf[o + 4] = r; buf[o + 5] = g; buf[o + 6] = b; buf[o + 7] = a;
  return o + 8;
}

// 把每个 Quad 展开成 6 顶点×8 float。复用 reuse 缓冲，不够大则按 1.5× 扩容。
// 返回 { buf, used }：buf 可能是新扩容的（调用方应回写保存），used 为写入的 float 数；
// 上传时取 buf.subarray(0, used)，顶点数 = used / FLOATS_PER_VERT。
// 不变量：每个 quad 顶点顺序固定（左上→右上→左下 + 右上→右下→左下），三角形绕序与两个后端的剔除/拓扑设置一致。
/** 将 Quad 列表展开为交错顶点数组，按需 1.5× 扩容并复用缓冲。 @internal */
export function buildQuadMesh(quads: Quad[], reuse: Float32Array<ArrayBuffer>): { buf: Float32Array<ArrayBuffer>; used: number } {
  const need = quads.length * VERTS_PER_QUAD * FLOATS_PER_VERT;
  const buf = reuse.length < need ? new Float32Array(Math.ceil(need * 1.5)) : reuse;
  let o = 0;
  for (const q of quads) {
    const { x, y, w, h, u0, v0, u1, v1, r, g, b, a } = q;
    o = push(buf, o, x, y, u0, v0, r, g, b, a);
    o = push(buf, o, x + w, y, u1, v0, r, g, b, a);
    o = push(buf, o, x, y + h, u0, v1, r, g, b, a);
    o = push(buf, o, x + w, y, u1, v0, r, g, b, a);
    o = push(buf, o, x + w, y + h, u1, v1, r, g, b, a);
    o = push(buf, o, x, y + h, u0, v1, r, g, b, a);
  }
  return { buf, used: o };
}
