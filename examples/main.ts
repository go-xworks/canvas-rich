/**
 * 示例入口（纯调用方）：演示如何把核心库当作「可被 import 的库」消费——
 * 引入容器、调用 `createEditor` 工厂、库在容器内自建外壳并返回实例句柄。
 *
 * @remarks
 * 与库消费者写法逐字一致：`import { createEditor } from '../src'`（发布后即 `from 'canvas-rich'`）。
 * 划分（见 spec demoMigration）：
 * - 库侧（create-editor 内部）：草稿优先恢复→演示样张回退、模板切换、HarfBuzz 异步就绪、
 *   主题/缩放/视图模式——全部由 EditorOptions 驱动，示例零接线即复现现 demo。
 * - 示例侧（本文件）：仅 `createEditor(app, options)` 一行 + 引入样式。
 *   外壳 + chrome（tailwind utility）样式 = 库的 `src/styles/lib.css`（发布后为 `import 'canvas-rich/style.css'`，
 *   由 tsdown 的 tailwind 插件编译 + 作用域化到 .canvas-rich + 压缩成 dist/style.css）；
 *   dev 下示例直接吃源码（@tailwindcss/vite 产全局未作用域 utility），故在此 import 同一入口经 Vite 插件供样式。
 *   katex 样式因库 external katex，提供责任在调用方（见 README「作为库使用」）。
 */
import '../src/styles/lib.css'; // 外壳 + chrome 样式（= 发布物 'canvas-rich/style.css'）
import 'katex/dist/katex.min.css'; // 库 external katex，公式样式由调用方引（dev 与发布消费者一致）
import { createEditor } from '../src';

const app = document.getElementById('app');
if (!app) throw new Error('[examples] 找不到 #app 容器');

// 复刻现 demo：草稿优先恢复→演示样张回退（库内部 persistDraft 逻辑），canvas 整形器，全 chrome。
// 不传 initialDoc：库内部 loadDraft() 命中则用草稿，否则回退 createDemoDoc()。
createEditor(app, { persistDraft: true, shaper: 'canvas' });
