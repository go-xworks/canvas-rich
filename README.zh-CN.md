# canvas-rich

> [English](README.md) · **简体中文**

> GPU 自绘的 **canvas 富文本编辑内核** · A GPU-rendered rich text editor engine on HTML `<canvas>`.

[![CI](https://github.com/go-xworks/canvas-rich/actions/workflows/ci.yml/badge.svg)](https://github.com/go-xworks/canvas-rich/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://go-xworks.github.io/canvas-rich/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

canvas-rich 用 TypeScript + `<canvas>` + WebGL2/WebGPU 自绘整个编辑器：字形经图集光栅成 GPU 贴图四边形，
不依赖 DOM 排版、不依赖浏览器文本控件，并在其上自建文档树、位置模型、样式解析与块级布局。

**🔗 在线示例：https://go-xworks.github.io/canvas-rich/**

## 特性

- **GPU 自绘** — 字形进多页 2048² 图集，WebGL2/WebGPU 单 shader 批量合成；GPU 上下文丢失自动恢复。
- **文档模型** — 19 种块（标题 / 列表 / 任务 / 引用 / 代码块 / 表格 / 媒体 / 公式 / 形状…）+ 12 种行内 marks。
- **排版** — 块级布局、段落行距/间距/缩进/对齐、嵌套列表、目录、Unicode BiDi 双向算法、HarfBuzz 复杂文字整形与脚本字体回退。
- **视图** — web 连续滚动 / word A4 分页；50–200% 功能性缩放；亮 / 暗主题。
- **编辑** — 跨块选区、词级导航、双击选词、拖拽移动文本、撤销合并、IME 组合中间态预览。
- **工具** — 查找 / 替换（⌘F）、富文本剪贴板、打印 / 导出 PDF（⌘P）、localStorage 自动保存与草稿恢复。
- **触屏** — 单指滚动 + 惯性、长按选词、选区手柄、双指捏合缩放、虚拟键盘避让。
- **导入导出** — Markdown / HTML / JSON（互逆）。
- **性能** — 块级增量布局缓存（编辑只重排受影响块）+ 视口剔除（静止帧零开销）。
- **零框架依赖** — 纯 TypeScript，可嵌入任意技术栈。

## 快速开始

> 需要 Node ≥ 20。本仓库分两层：`src/` 是核心库，`examples/` 是消费库的示例站点。

```bash
npm install
npm run dev        # 起示例站点 http://localhost:5173
npm run build      # 构建库：dist/index.js + dist/style.css + dist/index.d.ts
npm test           # 单元测试
```

## 作为库使用

核心库对标 ProseMirror / CodeMirror 6 / Lexical：传入一个容器，库自建 DOM 外壳，
工厂 `createEditor(target, options)` 返回命令式实例句柄。

```ts
import { createEditor } from 'canvas-rich';
import 'canvas-rich/style.css';

const editor = createEditor(document.getElementById('app')!, {
  initialMarkdown: '# Hello\n\nStart typing…',
  theme: 'light',          // 'light' | 'dark'
  viewMode: 'web',         // 'web' | 'word'
});

editor.exec('mark.bold');                            // 派发命令
editor.on('doc:changed', () => console.log(editor.getMarkdown()));
editor.setHTML('<h1>New</h1>');                      // 拿/灌内容：get/set + HTML/Markdown/JSON/Doc
editor.destroy();                                    // 彻底销毁，回收全部 DOM 与监听
```

`EditorInstance` 提供 `exec / getDoc / setDoc / getHTML / setHTML / getMarkdown / setMarkdown /
getJSON / setJSON / on / off / focus / setViewMode / setZoom / setTheme / destroy`。
完整选项见 [`createEditor` 的 TSDoc](src/editor/create-editor.ts)。

> **运行时资源**：HarfBuzz 整形（`shaper:'harfbuzz'`）需在站点根 `/fonts/` 提供 Roboto / Noto 字体；
> 公式需 `import 'katex/dist/katex.min.css'`。默认 `canvas` 整形器无此依赖。
> **已知局限**：主题色板为进程级全局，同页多实例暂无法各自独立主题。

## 架构

分层单向向下 `ui → editor → text → render → model → shared`，核心层零 UI / DOM 依赖。

```
model/    文档树 schema、编辑模型 RichDoc、样式解析、导入导出、块行为注册表
text/     整形器接口、字形图集、断行、块级布局、BiDi、分页
render/   WebGL2 / WebGPU 后端（工厂择优降级）
editor/   命令总线、事件发射器、剪贴板、命中测试、createEditor 工厂
ui/       工具栏（声明式贡献清单）、覆盖层、面板、弹层、查找条（内部实现）
shared/   跨层纯工具
```

设计要点：**统一命令总线**（键盘 / 工具栏 / 右键三路同 id 派发）、**类型化事件发射器**（Observer）、
**插件化注册表**（块行为 / 块导出 / 工具栏贡献项各只注册一处）。

## 贡献

欢迎 Issue 与 PR。安全问题请按 [`SECURITY.zh-CN.md`](SECURITY.zh-CN.md) 私密报告。变更记录见 [`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md)。

## 许可

[MIT](LICENSE) © go-xworks
