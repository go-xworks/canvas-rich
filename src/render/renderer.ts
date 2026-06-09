// 渲染器抽象：当前提供 WebGL2 实现，接口保持后端无关，
// 之后可再加一个 WebGPU 后端而不动上层布局/模型代码。
// 分层位置：render 层的后端无关契约，被 editor/ui 通过 createRenderer 消费。

/** 一个待绘制的纹理四边形（位置、uv、顶点色），渲染层的最小绘制单元。 @public */
export interface Quad {
  x: number; y: number; w: number; h: number;      // 设备 px，左上角 + 尺寸
  u0: number; v0: number; u1: number; v1: number;  // 纹理 uv
  r: number; g: number; b: number; a: number;      // 顶点色 0..1
}

/** 后端无关的渲染器契约：负责尺寸、图集上传与四边形批量绘制。 @public */
export interface Renderer {
  resize(w: number, h: number): void;
  uploadAtlas(source: TexImageSource): void;
  render(quads: Quad[], clear: [number, number, number, number]): void;
}
