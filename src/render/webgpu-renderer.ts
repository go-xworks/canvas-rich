/// <reference types="@webgpu/types" />
import { Renderer, Quad } from './renderer';
import { FLOATS_PER_VERT, VERTS_PER_QUAD, buildQuadMesh } from './quad-mesh';

// render 层的 WebGPU 后端实现：管理 device/pipeline/纹理并批量绘制四边形，作为首选后端。

// WGSL：顶点把设备 px → clip，片元用图集 alpha 当覆盖率（与 WebGL2 版一致）。
const WGSL = `
struct Uniforms { uResolution: vec2<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs(@location(0) aPos: vec2<f32>,
      @location(1) aUV: vec2<f32>,
      @location(2) aColor: vec4<f32>) -> VSOut {
  var out: VSOut;
  var clip = aPos / u.uResolution * 2.0 - 1.0;
  clip.y = -clip.y;                 // 屏幕 y 向下，clip y 向上
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.uv = aUV;
  out.color = aColor;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let cov = textureSample(atlas, samp, in.uv).a;   // 图集以 alpha 存覆盖率
  return vec4<f32>(in.color.rgb, in.color.a * cov);
}
`;


/** Renderer 的 WebGPU 实现，作为首选后端（构造经 async create）。 @public */
export class WebGPURenderer implements Renderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private uniformBuf: GPUBuffer;

  private vbo: GPUBuffer | null = null;
  private vboFloats = 0;       // 当前 vbo 容量（以 float 计）
  private cpu = new Float32Array(0);

  private tex: GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private bindGroup: GPUBindGroup | null = null;

  private w = 1;
  private h = 1;

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
    uniformBuf: GPUBuffer,
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.pipeline = pipeline;
    this.sampler = sampler;
    this.uniformBuf = uniformBuf;
  }

  /** 异步初始化 adapter/device/pipeline 等资源并返回实例；不可用时抛错。 @public */
  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer> {
    if (!navigator.gpu) throw new Error('WebGPU 不可用');
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU context 获取失败');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter 获取失败');
    const device = await adapter.requestDevice();

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });

    const module = device.createShaderModule({ code: WGSL });

    const stride = FLOATS_PER_VERT * 4;
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: stride,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },   // aPos
            { shaderLocation: 1, offset: 8, format: 'float32x2' },   // aUV
            { shaderLocation: 2, offset: 16, format: 'float32x4' },  // aColor
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format,
          // 标准 src_alpha / one_minus_src_alpha，与 WebGL2 blendFunc 一致
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const uniformBuf = device.createBuffer({
      size: 16, // vec2<f32> + padding（uniform 最小 16 字节对齐）
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return new WebGPURenderer(device, context, format, pipeline, sampler, uniformBuf);
  }

  /** 更新分辨率 uniform 所用的宽高（画布像素尺寸由 canvas 自身决定，下限 1px）。 @public */
  resize(w: number, h: number): void {
    // WebGPU 画布像素尺寸由 canvas.width/height 决定，这里只更新 uniform 用的分辨率。
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  /** 上传图集到纹理；尺寸变化时重建纹理与 bindGroup，否则复用。 @public */
  uploadAtlas(source: TexImageSource): void {
    const device = this.device;
    const width = (source as { width: number }).width;
    const height = (source as { height: number }).height;

    // 首次或尺寸变化时（重新）创建纹理与 bindGroup，否则复用。
    if (!this.tex || this.texW !== width || this.texH !== height) {
      this.tex?.destroy();
      this.tex = device.createTexture({
        size: { width, height },
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.COPY_DST
          | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.texW = width;
      this.texH = height;
      this.bindGroup = device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuf } },
          { binding: 1, resource: this.tex.createView() },
          { binding: 2, resource: this.sampler },
        ],
      });
    }

    // copyExternalImageToTexture：图集左上对应纹理 (0,0)，与 WebGL2（未翻转 Y）一致。
    device.queue.copyExternalImageToTexture(
      { source: source as GPUCopyExternalImageSource },
      { texture: this.tex },
      { width, height },
    );
  }

  /** 编码一个渲染 pass：clear 后将一批四边形展开为顶点并绘制。 @public */
  render(quads: Quad[], clear: [number, number, number, number]): void {
    const device = this.device;

    // 展开顶点（与 WebGL2 共用 buildQuadMesh）
    const { buf, used: o } = buildQuadMesh(quads, this.cpu);
    this.cpu = buf; // 回写可能扩容后的缓冲

    // 更新 uniform（分辨率）
    device.queue.writeBuffer(this.uniformBuf, 0, new Float32Array([this.w, this.h]));

    // 复用顶点缓冲，不够大就重建（writeBuffer 要求 4 字节对齐，float 已满足）
    const vertexCount = quads.length * VERTS_PER_QUAD;
    if (vertexCount > 0) {
      if (!this.vbo || this.vboFloats < o) {
        this.vbo?.destroy();
        this.vboFloats = Math.ceil(o * 1.5);
        this.vbo = device.createBuffer({
          size: this.vboFloats * 4,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      device.queue.writeBuffer(this.vbo, 0, buf.buffer, buf.byteOffset, o * 4);
    }

    const view = this.context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    // quads 为空也已执行一次 clear；有内容才绘制。
    if (vertexCount > 0 && this.vbo && this.bindGroup) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.vbo);
      pass.draw(vertexCount);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
