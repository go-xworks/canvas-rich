import 'canvas-rich/style.css';
import 'katex/dist/katex.min.css';
import { createEditor } from 'canvas-rich';

const demo = document.getElementById('site-editor');
if (demo) {
  createEditor(demo, {
    shaper: 'canvas',
    theme: 'light',
    viewMode: 'word',
    initialMarkdown:
      '# canvas-rich\n\n一个 GPU Canvas 富文本编辑内核。\n\n- WebGL2 / WebGPU 渲染\n- Markdown、HTML、JSON 导入导出\n- 表格、公式、图片、形状与分页\n\n> 官网直接以库消费者方式创建这个实例。',
  });
}
