// 渲染器抽象：当前提供 WebGL2 实现，接口保持后端无关，
// 之后可再加一个 WebGPU 后端而不动上层布局/模型代码。
// 分层位置：render 层的后端无关契约，被 editor/ui 通过 createRenderer 消费。

/** 一个待绘制的纹理四边形（位置、uv、顶点色、所在图集页），渲染层的最小绘制单元。 @public */
export interface Quad {
  x: number; y: number; w: number; h: number;      // 设备 px，左上角 + 尺寸
  u0: number; v0: number; u1: number; v1: number;  // 纹理 uv
  r: number; g: number; b: number; a: number;      // 顶点色 0..1
  page: number;                                    // 图集页号（纯色矩形固定 0 —— 白块恒在 page 0）
}

/** 图集页内的轴对齐矩形（设备 px，左上原点），脏区子上传的区域描述。 @public */
export interface AtlasRect { x: number; y: number; w: number; h: number }

/**
 * 后端无关的渲染器契约：负责尺寸、多页图集上传与四边形批量绘制。
 * render 按 Quad.page 的相邻同页段分批绑定页纹理绘制，严格保序（不跨段重排，
 * 背景→选区→字形→装饰→光标的 z 序与 AA 混色顺序不变）。 @public
 */
export interface Renderer {
  /**
   * 后端报告「设备/上下文已丢失且本实例不可恢复」的信号（如 WebGPU `device.lost`）。
   * 装配层应在 resolve 后重建渲染器并整页重传图集。WebGL2 经 canvas 的
   * `webglcontextlost/restored` 事件恢复（装配层监听），此字段缺省。 @public
   */
  readonly lost?: Promise<void>;
  resize(w: number, h: number): void;
  /** 上传指定图集页：rect 给出仅需更新的子区域；省略或该页 GPU 纹理尚未建立时整页上传。 @public */
  uploadAtlasPage(page: number, source: TexImageSource, rect?: AtlasRect): void;
  /** 销毁页号 ≥ keep 的图集 GPU 纹理（图集 setDpr 收缩页数后回收显存）。 @public */
  dropAtlasPages(keep: number): void;
  render(quads: Quad[], clear: [number, number, number, number]): void;
}
