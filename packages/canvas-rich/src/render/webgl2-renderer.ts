import { Renderer, Quad, AtlasRect } from './renderer';
import { FLOATS_PER_VERT, VERTS_PER_QUAD, buildQuadMesh, buildPageRuns } from './quad-mesh';

// render 层的 WebGL2 后端实现：编译着色器、管理 VAO/多页图集纹理并按相邻同页分批绘制四边形。

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;   // 设备 px
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aColor;
uniform vec2 uResolution;
out vec2 vUV;
out vec4 vColor;
void main() {
  vec2 clip = aPos / uResolution * 2.0 - 1.0;
  clip.y = -clip.y;                 // 屏幕 y 向下，clip y 向上
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  float cov = texture(uTex, vUV).a;   // 图集以 alpha 存覆盖率；白块 alpha=1 → 纯色
  outColor = vec4(vColor.rgb, vColor.a * cov);
}`;

/** Renderer 的 WebGL2 实现，作为 WebGPU 不可用时的回退后端。 @public */
export class WebGL2Renderer implements Renderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private tex: (WebGLTexture | null)[] = []; // 每图集页一张纹理，惰性创建
  private uRes: WebGLUniformLocation;
  private cpu = new Float32Array(0);
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;

    this.prog = this.link(VERT, FRAG);
    this.uRes = gl.getUniformLocation(this.prog, 'uResolution')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  /** 更新视口尺寸与分辨率 uniform 所用的宽高（下限 1px）。 @public */
  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.gl.viewport(0, 0, this.w, this.h);
  }

  /** 上传一页字形/白块图集：首次（或省略 rect）整页 texImage2D，其后仅脏矩形 texSubImage2D 子区上传。 @public */
  uploadAtlasPage(page: number, source: TexImageSource, rect?: AtlasRect): void {
    const gl = this.gl;
    let t = this.tex[page];
    const fresh = !t;
    if (!t) t = this.tex[page] = this.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (fresh || !rect) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return;
    }
    // WebGL2 对 DOM 源支持 unpack 子区：ROW_LENGTH/SKIP_PIXELS/SKIP_ROWS 选出源画布上的脏矩形
    const srcW = (source as { width: number }).width;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, srcW);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, rect.x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, rect.y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.w, rect.h, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }

  /** 销毁页号 ≥ keep 的图集纹理（图集 setDpr 收缩页数后回收显存）。 @public */
  dropAtlasPages(keep: number): void {
    for (let i = keep; i < this.tex.length; i++) {
      const t = this.tex[i];
      if (t) this.gl.deleteTexture(t);
    }
    if (this.tex.length > keep) this.tex.length = Math.max(0, keep);
  }

  /** 清屏并将一批四边形展开为顶点，一次上传后按相邻同页分批绘制（严格保序）。 @public */
  render(quads: Quad[], clear: [number, number, number, number]): void {
    const gl = this.gl;
    const { buf, used } = buildQuadMesh(quads, this.cpu);
    this.cpu = buf; // 回写可能扩容后的缓冲

    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (quads.length === 0) return;

    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this.w, this.h);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, used), gl.DYNAMIC_DRAW);
    // 按相邻同页切 run、严格保序分批 draw：不跨段重排，z 序与 AA 混色顺序与单纹理时代一致
    for (const run of buildPageRuns(quads)) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[run.page] ?? (this.tex[run.page] = this.createTexture()));
      gl.drawArrays(gl.TRIANGLES, run.start * VERTS_PER_QUAD, run.count * VERTS_PER_QUAD);
    }
    gl.bindVertexArray(null);
  }

  // 建一张图集页纹理（采样参数与单页时代一致）；内容由 uploadAtlasPage 填充。
  // 防御：render 先于上传遇到未知页时也建纹理并清成 1×1 透明，避免采样不完整纹理。
  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return t;
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const v = this.compile(gl.VERTEX_SHADER, vs);
    const f = this.compile(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('compile: ' + gl.getShaderInfoLog(s));
    return s;
  }
}
