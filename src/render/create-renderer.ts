import { Renderer } from './renderer';
import { WebGPURenderer } from './webgpu-renderer';
import { WebGL2Renderer } from './webgl2-renderer';

// render 层入口：按后端能力选择并构造具体 Renderer，向上层屏蔽 WebGPU/WebGL2 差异。

/** 创建渲染器：WebGPU 优先，初始化失败时降级到 WebGL2。 @public */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  if (navigator.gpu) {
    try {
      const r = await WebGPURenderer.create(canvas);
      console.log('[renderer] 使用 WebGPU 后端');
      return r;
    } catch (e) {
      console.warn('[renderer] WebGPU 初始化失败，降级到 WebGL2:', e);
    }
  }
  console.log('[renderer] 使用 WebGL2 后端');
  return new WebGL2Renderer(canvas);
}
