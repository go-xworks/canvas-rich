import { Renderer, Quad } from './renderer';
import { FLOATS_PER_VERT, VERTS_PER_QUAD, buildQuadMesh } from './quad-mesh';

// render 层的 WebGL2 后端实现：编译着色器、管理 VAO/纹理并批量绘制四边形。

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
  private tex: WebGLTexture;
  private uRes: WebGLUniformLocation;
  private cpu = new Float32Array(0);
  private w = 1; private h = 1;

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

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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

  /** 把字形/白块图集上传到 GPU 纹理。 @public */
  uploadAtlas(source: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** 清屏并将一批四边形展开为顶点后一次性绘制。 @public */
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
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, used), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, quads.length * VERTS_PER_QUAD);
    gl.bindVertexArray(null);
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const v = this.compile(gl.VERTEX_SHADER, vs);
    const f = this.compile(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram()!;
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('compile: ' + gl.getShaderInfoLog(s));
    return s;
  }
}
