# GPU 富文本引擎 · 原型

用 **TypeScript + `<canvas>` + WebGL2/WebGPU** 自绘的富文本编辑内核 —— 取 IQ Option `glengine`
那套「字形 → 图集 → GPU 贴图四边形」的精华路线，不依赖 DOM 排版、不依赖浏览器文本控件，
并在其上自建文档树、位置模型、样式解析与块级布局。

## 运行

```bash
cd rich-text-engine
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build
npm test         # vitest（262 个单测）
```

## 能力

- **默认亮色（白底）主题**：统一主题令牌——canvas 渲染色集中在 `model/palette.ts` 的 `C`，
  DOM 外壳色集中在 `index.html` 的 `--rte-*` CSS 变量；改一处即可换肤（暗色模式预留）。文本对比度过 WCAG AA。
- **工具栏**（真 DOM/CSS，**Lucide 内联线性图标**）：撤销/重做、块类型图标按钮组(¶/H1/H2/列表/编号/引用/代码)、
  粗/斜/下划线/删除线/行内代码/链接、文字色与高亮色**下拉面板**、清除格式、左中右对齐 + 文字方向、
  图片/公式/表格、整形器、导出；分组细线分隔、active 用浅蓝 wash + 蓝前景，按钮**实时反映选区状态**。
- **GPU 自绘**：字形用 Canvas2D / HarfBuzz 轮廓光栅进 2048² 图集，WebGL2/WebGPU 单 shader 批量合成。
- **双整形器**（F2 / 工具栏切换）：`Canvas`（系统字体，含 CJK）/ `HarfBuzz`（Roboto，真整形：连字/字距）。
- **文档树**：blocks（段落 / **标题 H1–H6** / 项目符号 / 编号列表 / **任务列表** / 引用 / 代码块 / 图片）+ inlines（TextRun）+ marks。
- **行内 marks**：粗 / 斜 / 下划线 / 删除线 / 文字背景高亮 / 颜色 / 代码 / 链接 / **上标 / 下标 / 字体族 / 字号**（行内 mark，优先级 mark>block>default），区间存储 + 规范化合并。
- **字符排印**（工具栏，对标 Word）：**字体族**下拉(默认/衬线/等宽/黑体/楷体)、**字号**下拉(12–32+默认)、**上标/下标**(字号×0.8 + 基线偏移)、文字色/高亮支持**自定义 hex 输入**。
- **块级布局**：**标题分 6 级**(`⌘⌥1..6`)、项目符号与编号（自动重排）、**任务列表(☐/☑ 复选框,点击切换)**、缩进、对齐、块间距、（连续）代码块背景、下划线/删除线/高亮装饰。
- **图片 / 公式 / 表格**：原子块统一以 DOM 覆盖层渲染（随布局/滚动同步、自适应高度回填）——
  图片(`<img>`)、公式(**KaTeX** 离线渲染)、表格(可编辑单元格 + Tab 导航 + 模型同步)。
- **插入体验**：图片支持**本地上传 / 拖拽到弹层 / 拖拽到编辑器落点 / 粘贴(截图)** 四种方式 + URL + 预览；
  表格用**可视网格选择器**(悬停选 N 行 × M 列,点击插入)替代填数字；公式/链接用应用内弹层(非原生 prompt)。
- **图片操作**：选中后**拖角手柄缩放**(锁定宽高比、夹到内容宽)、**拖动本体重排**(落点指示线 + 移到任意块间);
  尺寸/位置进撤销栈,按 `align` 左/中/右定位。
- **无障碍**：平行 ARIA 语义树（H1/H2/P/UL/OL/PRE/IMG/TABLE/BLOCKQUOTE 镜像）+ canvas `aria-hidden` + `aria-live` 播报。
- **文字方向（BiDi）+ 多语言**：完整 Unicode 双向算法（bidi-js + L2 视觉重排）——LTR/RTL 混排正确排序、`dir` 属性、`⌘⇧D` 切换、BiDi 光标列。
  HarfBuzz 模式按**脚本→字体回退**（Latin→Roboto、希伯来→Noto Hebrew、阿拉伯→Noto Arabic），**阿拉伯语连写整形**正确（HarfBuzz 整段 shaping）。
- **样式**：Tailwind v4(`@tailwindcss/vite`，禁用 Preflight)重构工具栏/右键菜单/导出面板等 chrome。
- **架构**：领域插件化注册表（SSOT）——块行为/主题（blockSpecs）、命令+keymap（commands）、剪贴板（clipboard）模块化；
  加新块/命令只需注册一处。图集满载自动复位逐出；选择/导航只重绘不重排。
- **编辑**：点击/拖拽选区（跨块）、grapheme 光标移动、上下移动（goalX）、软换行 affinity、
  Enter 拆块、Backspace 块首合并/降级、Delete 并块、mark 切换/设置、块类型切换、对齐、撤销/重做、IME 中文输入。
- **滚动**：滚轮 / PageUp·Down / 拖拽滚动条；编辑或移动光标时自动滚入视口。
- **剪贴板 + 右键菜单**：剪切/复制/粘贴（多行粘贴自动拆块）、右键弹出格式化 + 剪贴板 + 导出菜单（含 active 状态）。
- **导出**：HTML / Markdown / JSON（列表/代码块分组、对齐、marks 映射），可复制。
- **导入**：**Markdown / HTML 解析**（`editor/import.ts`，与 export 互逆）——标题 H1–6 / 列表 / 任务 / 引用 / 代码块 / 行内 marks / 链接 / 分隔线 → 文档树；工具栏「导入」弹层粘贴即转。

## 架构（对应 glengine 分层）

> 文件名遵循 kebab-case（见 `CONVENTIONS.md` §1）。分层依赖单向向下：ui → editor → text → render → model → shared。

```
shared/util.ts          跨层纯工具（@vue/shared 风格）：clamp / lowerBoundIndex / NOOP
model/schema.ts         文档树 schema：Block / TextRun / Mark + 工具
model/inlines.ts        行内区间操作：normalize / slice / insert / delete / applyMark / marksAt
model/rich-document.ts  编辑模型 RichDoc：Pos{block,offset} + 选区 + 所有编辑命令 + 撤销
model/style-resolver.ts 「CSS 转换」：主题表 + 语义/marks → 具体 Style + 块版面参数
model/grapheme.ts       grapheme 切分与边界（光标/删除最小单位）
model/block-specs.ts    块行为+主题注册表（SSOT）：atom/list/continuesOnEnter/defaultAfter/theme
model/palette.ts        共享调色板 + 块主题类型
model/export.ts         文档树 → HTML / Markdown / JSON
text/shaper.ts          整形器接口（CanvasShaper / HarfBuzzShaper）
text/glyph-atlas.ts     字形图集：Canvas2D 光栅 + 货架打包 + GPU 上传源（画布由装配层注入）
text/line-break.ts      纯断行算法（可单测）
text/doc-layout.ts      块级布局：元素展开→断行→定位→LineBox；caretAt / hitTest / 选区矩形
text/bidi.ts            Unicode 双向算法（UBA）：embedding levels + L2 视觉重排
render/{webgl2,webgpu}-renderer.ts  两个 GPU 后端（create-renderer 工厂：WebGPU 优先，降级 WebGL2）
render/quad-mesh.ts     两后端共用的顶点网格组装（Quad→6 顶点×8 float，缓冲扩容）
editor/commands.ts      命令注册表 + keymap（键盘/工具栏/右键统一派发）
editor/clipboard.ts     剪贴板 copy/cut/paste（多行粘贴拆块）
editor/import.ts        Markdown / HTML 解析 → 文档树（与 export 互逆）
ui/icons.ts             内联 Lucide 线性图标（stroke=currentColor，可染色/缩放）
ui/toolbar.ts           工具栏（DOM/CSS + Lucide 图标）：命令按钮组 + 颜色/高亮下拉 + 选区状态反映
ui/context-menu.ts      右键菜单（DOM）
ui/output-panel.ts      导出面板（DOM）：HTML/MD/JSON 切换 + 复制
ui/prompt.ts            应用内输入弹层（替代原生 prompt/alert）：Promise 返回，链接/公式输入
ui/image-dialog.ts      图片插入弹层：本地上传/拖拽 + URL + 实时预览
ui/overlays.ts          原子块覆盖层：图片 / KaTeX 公式 / 可编辑表格（按 block 身份缓存 + 高度回填）
ui/aria.ts              平行 ARIA 无障碍树 + live region
styles/tw.css           Tailwind v4 入口（分层导入，禁用 Preflight）
main.ts                 装配：外壳布局 / DPR / 滚动 / 输入(含 IME, affinity, 剪贴板) / 渲染循环 / 工具栏接线
```

### 位置模型
`Pos = { block, offset }`，offset 为块内拼接文本的 UTF-16 偏移 ∈ [0, blockTextLen]；
`comparePos` 先块后偏移；光标移动/删除按 **grapheme** 步进；软换行点用 `affinity('before'|'after')` 消歧。

### marks 与块操作（要点）
- marks 区间存储，每次编辑后 `normalizeInlines`（合并相邻同-marks、删空段、固定序）。
- 打字继承左侧 marks，`link`/`code` 为非包含（右边界与块首不继承）。
- Enter：空列表项→降级段落；标题/引用行首→上方插空段落且内容保留原类型；标题中/尾拆→后半降级段落。
- Backspace 块首：样式块（标题/列表/引用）先降级为段落，否则与上块合并（继承上块块属性 + 归一化）。

## 质量

- **262 单元测试**全绿（按 Vue3 风格归集于各目录 `__tests__/`，7 个 HTML 解析测试在 node 无 DOMParser 时跳过），含 **80 种子×60 操作模糊测试**（随机编辑 + 不变量恒成立）+ **30 撤销/重做 round-trip** + 插入场景 + grapheme 边界 + 字符格式/块级/Markdown 导入。
- 经多轮**架构审计（workflow，对照 50 项坏味道）** 与对抗式 bug 核实，已修复确认缺陷。
- 对抗式复审（对照 12 条编辑器内核陷阱）确认并修复 5 个真 bug：块首非包含 mark 继承、软换行 affinity、空块选区高亮、IME keydown 守卫、标题行首 Enter 降级。
- **DRY**：选区遍历（`eachSelRange`/`eachSelBlock`，消 6 处重复）、顶点组装（`quad-mesh`，两后端共用）、跨层工具（`shared/util`）、调色板/块规格/命令/剪贴板均已抽公共方法。

## 工程规范（见 `CONVENTIONS.md`）

对齐 **Vue3 核心（vuejs/core）+ Next.js（vercel/next.js）** 的代码工程约定，经 workflow 多 agent 审计（154 项）后落地：
- **文件命名**：统一 kebab-case（裁决两仓冲突，理由见 §0：跨平台大小写安全 + Next 对齐）。
- **文档注释**：每个 export 符号补 TSDoc + `@public/@internal`（新增 161 处），每文件模块头标注分层位置。
- **模块划分/复用**：删 2 个死模块（`layout.ts`/`document.ts`）；核心层（model/text/render/shared）零 UI 依赖——`glyph-atlas` 画布改由装配层注入；新增最底层 `shared/`。
- **函数设计**：补 39 处显式返回类型；拆分多职责方法（`insertText`/`enter` 抽私有 helper）。

## 后续

- **表格增强**：单元格富文本(marks)、合并(colspan/rowspan)、跨单元格矩形选区。
- **BiDi 增强**：阿拉伯连写整形 + 希伯来已支持（脚本→字体回退）；待办：带元音阿拉伯语的组合标记定位（多字形/簇）、跨方向边界选区多矩形、视觉光标键。
- **富文本粘贴**：HTML → marks（带白名单清洗）。
- **增量重排**：块级 LineBox 缓存（当前已分离视图/内容脏标，进一步可只重排脏块）。
- 行内对象（mention chip）：位置模型已按「原子占 1 offset」预留。
- 大文档用扁平数组（编辑 O(n)）→ rope / piece-table；增量重排（只重排脏块）；视口虚拟化。
- HarfBuzz 已配 Latin(Roboto)/希伯来/阿拉伯字体回退；CJK/emoji 需再配 CJK 字体（回退表 `fallbacks` 可直接扩展）；协同（CRDT/OT）。
