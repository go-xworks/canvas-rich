# canvas-rich

> GPU 自绘的 **canvas 富文本编辑内核** · A GPU-rendered rich text editor engine on HTML `<canvas>`.

[![CI](https://github.com/go-xworks/canvas-rich/actions/workflows/ci.yml/badge.svg)](https://github.com/go-xworks/canvas-rich/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

用 **TypeScript + `<canvas>` + WebGL2/WebGPU** 自绘的富文本编辑内核 —— 取 IQ Option `glengine`
那套「字形 → 图集 → GPU 贴图四边形」的精华路线，不依赖 DOM 排版、不依赖浏览器文本控件，
并在其上自建文档树、位置模型、样式解析与块级布局。

## 运行

```bash
cd rich-text-engine
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build
npm test         # vitest（1039 个单测，1019 通过 + 20 跳过）
```

## 能力

- **默认亮色（白底）主题**：统一主题令牌——canvas 渲染色集中在 `model/palette.ts` 的 `C`，
  DOM 外壳色集中在 `index.html` 的 `--rte-*` CSS 变量；改一处即可换肤（暗色模式预留）。文本对比度过 WCAG AA。
- **工具栏 = JitWord 风分页签 Ribbon**（真 DOM/CSS，**Lucide 内联线性图标**）：页签 **开始 / 插入 / 视图**（active 蓝下划线）、
  功能组**细竖线分隔 + 组名小字 + 两行紧凑**；开始(历史/字体/段落)、插入(媒体/引用/模板)、视图(整形器)；导出常驻右上。
  active 用浅蓝 wash + 蓝前景，按钮**实时反映选区状态**；**悬停提示**(`ui/tooltip.ts`)显示「名称 + 快捷键 + 用法说明」。
- **GPU 自绘**：字形用 Canvas2D / HarfBuzz 轮廓光栅进**多页 2048² 图集**（满载按需扩页、超 2048px 巨字形夹紧光栅、新增字形仅上传 per-page 脏矩形），WebGL2/WebGPU 单 shader 批量合成。
- **双整形器**（F2 / 工具栏切换）：`Canvas`（系统字体，含 CJK）/ `HarfBuzz`（Roboto，真整形：连字/字距）。
- **文档树**：blocks（段落 / **标题 H1–H6** / 项目符号 / 编号列表 / **任务列表** / 引用 / 代码块 / 图片）+ inlines（TextRun）+ marks。
- **行内 marks**：粗 / 斜 / 下划线 / 删除线 / 文字背景高亮 / 颜色 / 代码 / 链接 / **上标 / 下标 / 字体族 / 字号**（行内 mark，优先级 mark>block>default），区间存储 + 规范化合并。
- **字符排印**（工具栏，对标 Word）：**字体族**下拉(默认/衬线/等宽/黑体/楷体)、**字号**下拉(12–32+默认)、**上标/下标**(字号×0.8 + 基线偏移)、文字色/高亮支持**自定义 hex 输入**。
- **块级布局**：**标题分 6 级**(`⌘⌥1..6`)、项目符号与编号（自动重排）、**任务列表(☐/☑ 复选框,点击切换)**、缩进、对齐、块间距、（连续）代码块背景、下划线/删除线/高亮装饰。
- **段落排版**（P1，对标 Word）：**行距**(1/1.15/1.5/2)、**段前/段后距**、**首行/段落缩进 +/-**、**字间距**、**两端对齐 justify / 分散对齐 distribute**（均进撤销栈、caret/选区同步）。
- **嵌套列表**：`Tab/Shift+Tab` 调 depth(0–5)，bullet 标记按层轮换 •/◦/▪，缩进随层递进。
- **目录 TOC**：`目录` 块自动扫描全文标题生成,**点击条目跳转**到对应标题并滚入视口;heading 自动锚点 id。
- **模板 + 形状**：内置模板(空白/**红头公文**/会议纪要/简历) + 「设为模板」存本地;**9 种形状**(线/矩形/圆角/椭圆/三角/菱形/星/箭头/分隔线,Canvas2D 自绘 + 缩放手柄)。
- **行内图片**：图片可作**行内原子**(占 1 offset、随文断行/光标移动),区别于块级图片。
- **链接跳转**：**⌘/Ctrl+点击**外链新标签打开(协议白名单 http/https/mailto,防注入);普通点击仍定位光标编辑。
- **面板/大纲/状态栏**：左**大纲**面板(标题树,点击跳转,可折叠)、底部**状态栏**(段落数/字数/缩放/视图)。
- **图片 / 公式 / 表格**：原子块统一以 DOM 覆盖层渲染（随布局/滚动同步、自适应高度回填）——
  图片(`<img>`)、公式(**KaTeX** 离线渲染)、表格(可编辑单元格 + Tab 导航 + 模型同步)。
- **表格增强**：**合并/拆分单元格**(区域选择 + 浮动条,colspan/rowspan,导出保真)、**拖动改列宽/行高**(边界手柄);触控(pointer 事件)兼容;**增删行/列**(浮动条,自动调整合并区,保留最小 1×1)。
- **媒体对象**(原子块 + 覆盖层)：**音频 / 视频 / 内嵌网页(iframe,sandbox)/ 附件**(文件卡片 + 下载);视频/iframe 可缩放;导出 `<audio>/<video>/<iframe>/<a download>`。
- **暗色模式**：一键切换(视图页签)——canvas 渲染色(`palette` LIGHT/DARK 令牌)+ DOM 外壳(`--rte-*` `[data-theme=dark]`)成对换肤,文本/选区/光标/代码块/面板/弹层全跟随,无白底残留。
- **视图模式**：**web 视图**(连续滚动)/ **word 视图**(A4 794×1123 分页:纸张居中 + 页缝 + 投影,`text/paginate.ts` 纯函数后处理分页,光标/选区/覆盖层同步平移)。
- **功能性缩放**：50–200%(步进 10%),`⌘+/−/0` + 状态栏 −/%/＋;核心是**有效渲染比例 = dpr×zoom 同步给图集与整形器重栅**,布局与光栅共比例、字距零错位(顺带修复换屏不重栅)。
- **表格单元格富文本(v2)**：`TableCell{inlines}` 携带完整行内 marks 与**单元格内换行**;contenteditable 双向同步(出向 `inlinesToCellHtml`/入向 `editor/cell-dom.ts` 的 `domToInlines` 互逆),单元格内 `⌘B/I/U`、Enter 换行;合并/导入/导出全保真。
- **公文对象**：**电子签名**(手写画板弹层 → PNG 原子块)、**印章**(`model/seal.ts` 从文字生成红色圆形公章 SVG:外环弧排文字 + 五角星)、**文本框**(可编辑浮动框,contenteditable 覆盖层 + 内容同步,可缩放/拖动)。
- **插入体验**：图片支持**本地上传 / 拖拽到弹层 / 拖拽到编辑器落点 / 粘贴(截图)** 四种方式 + URL + 预览；
  表格用**可视网格选择器**(悬停选 N 行 × M 列,点击插入)替代填数字；公式/链接用应用内弹层(非原生 prompt)。
- **图片操作**：选中后**拖角手柄缩放**(锁定宽高比、夹到内容宽)、**拖动本体重排**(落点指示线 + 移到任意块间);
  尺寸/位置进撤销栈,按 `align` 左/中/右定位。
- **无障碍**：平行 ARIA 语义树（H1/H2/P/UL/OL/PRE/IMG/TABLE/BLOCKQUOTE 镜像）+ canvas `aria-hidden` + `aria-live` 播报。
- **文字方向（BiDi）+ 多语言**：完整 Unicode 双向算法（bidi-js + L2 视觉重排）——LTR/RTL 混排正确排序、`dir` 属性、`⌘⇧D` 切换、BiDi 光标列。
  HarfBuzz 模式按**脚本→字体回退**（Latin→Roboto、希伯来→Noto Hebrew、阿拉伯→Noto Arabic），**阿拉伯语连写整形**正确（HarfBuzz 整段 shaping）。
- **样式**：Tailwind v4(`@tailwindcss/vite`，禁用 Preflight)重构工具栏/右键菜单/导出面板等 chrome。
- **架构（GoF 模式落地，少而精）**：领域插件化注册表（SSOT）——块行为/主题（blockSpecs）、**块导出（export 的 `BLOCK_EXPORTERS` + `meta.exporter`，Strategy-over-Visitor）**、剪贴板（clipboard）、
  **工具栏（声明式贡献清单 `ui/toolbar/`：item 描述符 + 渲染器穷举注册表 + 通用 refresh + 运行时 `register()`）** 均模块化；
  **统一命令总线（`editor/commands`：`CommandContext` + 命令表，键盘/工具栏/右键三路同 id 派发，Command + Mediator）**；
  **类型化事件发射器（`editor/events`：doc/selection/view:changed，Observer——面板/工具栏/ARIA/状态栏订阅）**。
  加新块/命令/**工具项**只需注册一处（工具栏加按钮 = 往 `toolbar-items.ts` 加一条描述符；新块导出 = 往 `block-specs` 加钩子）。
  已天然具备 Strategy(Shaper/Renderer)/Bridge/Factory/Flyweight(字形图集)/Composite(文档树)/Memento(撤销快照)/Adapter(导入导出)。
  图集满载自动扩页（多页 + 巨字形夹紧 + per-page 脏矩形上传）；选择/导航只重绘不重排；
  编辑走**块级布局缓存增量重排**（blockVersion 失效 + epoch 整体失效，undo/redo 结构共享保命中）+ **视口剔除**（可见行窗口二分，静止帧零分配零绘制）。
- **编辑**：点击/拖拽选区（跨块）、grapheme 光标移动、上下移动（goalX）、软换行 affinity、
  Enter 拆块、Backspace 块首合并/降级、Delete 并块、mark 切换/设置、块类型切换、对齐、撤销/重做、IME 中文输入。
- **滚动**：滚轮 / PageUp·Down / 拖拽滚动条 / 触屏单指平移 + 惯性；编辑或移动光标时自动滚入视口。
- **剪贴板 + 右键菜单**：剪切/复制/粘贴（多行粘贴自动拆块）、右键弹出格式化 + 剪贴板 + 导出菜单（含 active 状态）。
- **导出**：HTML / Markdown / JSON（列表/代码块分组、对齐、marks 映射），可复制。
- **导入**：**Markdown / HTML 解析**（`editor/import.ts`，与 export 互逆）——标题 H1–6 / 列表 / 任务 / 引用 / 代码块 / 行内 marks / 链接 / 分隔线 → 文档树；工具栏「导入」弹层粘贴即转。
- **查找/替换**：`⌘F` 浮条（`ui/find-bar` + `model/find`）——全文命中 canvas 底色高亮、Enter/⇧Enter 循环跳转、替换当前/全部（单次撤销）；编辑后命中自动重算。
- **打印 / 导出 PDF**：`⌘P`（`ui/print`）——toHtml 全文 + 打印 CSS 装入隐藏 iframe 走系统打印对话框（可另存 PDF），绕开 canvas 正文对原生打印输出空白的问题。
- **自动保存与草稿恢复**：`doc:changed` 防抖 ~800ms 把 doc+选区落 localStorage（`model/persistence`），启动时恢复；beforeunload 先同步落盘、失败才拦截确认；IME 组合中间态不落盘。
- **触屏**：单指平移滚动（跟手 + 惯性续滚）、长按选词 + 拖动调整选区（触觉反馈）、选区圆头手柄（44px 命中）、双指捏合缩放、tap 定位光标弹软键盘、visualViewport 虚拟键盘避让（`editor/touch` 纯逻辑可测）。
- **指针/键盘编辑增强**：双击选词 / 三击选段、`⌥←/→` 词跳转、`⌥⌫/⌥Del` 删词、`⌘⌫` 删至行首（Intl.Segmenter 词边界）、选区内按下拖拽**移动选中文本**（落点指示线，单次撤销）、连续输入**撤销合并**（时间窗内一条记录）。
- **IME 组合中间态预览**：组合串经 transient 通道临时入文档参与布局渲染（带组合下划线），不进撤销栈；提交收尾为单次可撤销记录。
- **GPU 上下文丢失恢复**：WebGL2 事件对 / WebGPU `device.lost` → 重建渲染器 + 图集整页重传（CPU 画布无损，无需重栅），编辑器不再永久白屏。

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
model/toc.ts            目录扫描：heading 锚点 id + 生成 TOC 条目
model/templates.ts      文档模板库（红头公文/会议纪要/简历）+ 本地用户模板
model/doc-stats.ts      文档统计（段落数/字数）纯函数
model/table-utils.ts    表格纯工具：列数/矩形规范化/合并区相交判定
model/seal.ts           印章 SVG 生成（外环弧排文字 + 五角星，从文字生成红色公章）
text/shaper.ts          整形器接口（CanvasShaper / HarfBuzzShaper）
text/glyph-atlas.ts     字形图集：Canvas2D 光栅 + 货架打包 + GPU 上传源（画布由装配层注入）
text/line-break.ts      纯断行算法（可单测）
text/doc-layout.ts      块级布局：元素展开→断行→定位→LineBox；caretAt / hitTest / 选区矩形
text/bidi.ts            Unicode 双向算法（UBA）：embedding levels + L2 视觉重排
text/paginate.ts        word 视图分页器（纯函数）：断点表 + 二分平移全部几何 + 产出页矩形
render/{webgl2,webgpu}-renderer.ts  两个 GPU 后端（create-renderer 工厂：WebGPU 优先，降级 WebGL2）
render/quad-mesh.ts     两后端共用的顶点网格组装（Quad→6 顶点×8 float，缓冲扩容）
editor/commands.ts      统一命令总线：CommandContext + 命令表(含带参) + keymap；键盘/工具栏/右键三路同 id 派发
editor/events.ts        类型化事件发射器(Observer)：doc/selection/view:changed；on/emit/unsub
editor/clipboard.ts     剪贴板 copy/cut/paste（多行粘贴拆块）
editor/import.ts        Markdown / HTML 解析 → 文档树（与 export 互逆）
editor/cell-dom.ts      表格单元格 contenteditable DOM → Inline[]（标签→marks、BR/DIV→换行）
ui/icons.ts             内联 Lucide 线性图标（stroke=currentColor，可染色/缩放）
ui/dom.ts               DOM 取元素小工具：mustEl(id) 断言存在，缺失 fail-fast 抛带 id 错误
ui/toolbar.ts           工具栏对外 barrel（re-export createToolbar/类型/tooltips/NUM_INPUT_DEFS，契约稳定）
ui/toolbar/             工具栏插件化注册表（声明式贡献模型，新增功能 = 往清单加一条描述符）
  ├ toolbar-items.ts    ★ 声明式清单 TOOLBAR_GROUPS：53 控件按 tab→group→row 描述（加功能改这里）
  ├ types.ts            ItemKind 判别联合 / ToolbarItem 描述符 / ToolbarContext / Renderer / 状态契约
  ├ renderers.ts        8 种 item kind 的渲染器 + RENDERERS 穷举映射（icon/text/label/color/grid/menu/template/num）
  ├ create-toolbar.ts   核心：遍历清单→渲染→落位→收 refresh；refresh 退化为遍历谓词；register() 运行时扩展
  ├ tokens.ts           Tailwind 类令牌 + 数据常量（视觉 SSOT）
  └ tooltips.ts         tipParse/tipDescKey/TIP_DESC/enrichTooltips（名称+快捷键+用法）
ui/tooltip.ts           全局悬停提示：名称 + 快捷键 + 用法说明（替代原生 title）
ui/context-menu.ts      右键菜单（DOM）
ui/output-panel.ts      导出面板（DOM）：HTML/MD/JSON 切换 + 复制
ui/prompt.ts            应用内输入弹层（替代原生 prompt/alert）：Promise 返回，链接/公式输入
ui/image-dialog.ts      图片插入弹层：本地上传/拖拽 + URL + 实时预览
ui/signature-dialog.ts  电子签名画板弹层：pointer 手绘 → PNG dataURL
ui/overlays.ts          原子块覆盖层：图片 / KaTeX 公式 / 可编辑表格（按 block 身份缓存 + 高度回填）
ui/aria.ts              平行 ARIA 无障碍树 + live region
ui/outline.ts           左侧大纲面板：标题树 + 点击跳转
ui/status-bar.ts        底部状态栏：段落数/字数/缩放/视图
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

- **1039 单元测试**（1019 通过 / 20 个依赖 DOMParser 等浏览器 API 的在 node 环境按设计跳过；按 Vue3 风格归集于各目录 `__tests__/`），含 **80 种子×60 操作模糊测试**（随机编辑 + 不变量恒成立）+ **增量布局等价性套件**（随机编辑序列下「块缓存增量」与「全量重排」全字段 deep-equal，操作池覆盖 IME 组合/富文本粘贴/全部替换/拖文本/undo·redo）+ **30 撤销/重做 round-trip** + 字符/段落排版/嵌套列表/TOC/模板/表格合并/Markdown·HTML 导入导出 round-trip。
- 经多轮**架构审计（workflow，对照 50 项坏味道）** 与对抗式 bug 核实，已修复确认缺陷。
- **深层 bug 审计（6 域 × 34 agent 并行 + 对抗式核实，39 发现 / 27 确认含 1 P0）后串行修复**：工具栏色/行距/间距 active 不同步、块降级/拆分/切类型丢失排版属性、import/export 字体字号/图片/表格不保真、RTL 多行选区边界、表格触控事件、main 越界守卫等全部修复（+79 测试）；2 项 doc-layout 经核实不影响用户、加注释保留。
- 对抗式复审（对照 12 条编辑器内核陷阱）确认并修复 5 个真 bug：块首非包含 mark 继承、软换行 affinity、空块选区高亮、IME keydown 守卫、标题行首 Enter 降级。
- **DRY**：选区遍历（`eachSelRange`/`eachSelBlock`，消 6 处重复）、顶点组装（`quad-mesh`，两后端共用）、跨层工具（`shared/util`）、调色板/块规格/命令/剪贴板均已抽公共方法。
- **第二轮审计（6 域 workflow + 对抗式核实，49 发现 / 31 确认）后串行修复**：
  - **功能性缩放坐标自洽**——覆盖层 / IME / 缩放手柄在 `zoom≠1` 下错位的根因（设备 dpr 与布局 scale 混用）修复，web + word 两视图、70/100/150% 三档实测对齐（+12 测试）。
  - **URL 安全**——`shared/url.ts` 协议白名单（媒体 src 按场景）+ 行内链接 href 危险协议黑名单（`sanitizeLinkHref` 拦 `javascript:`/`vbscript:`/`data:`/`file:`，放行 mailto/锚点/相对），导入 / 弹层 / 导出 / 单元格回写四处共用；iframe sandbox 去 `allow-same-origin`（+23 测试）。
- **CSP**：`index.html` 不含内联 `<style>/<script>`（外壳样式外置 `src/styles/shell.css`，构建后随 bundle 产出外链 css）——宿主可启用不带 `style-src 'unsafe-inline'` 的严格 CSP 运行核心（canvas 正文渲染与 KaTeX/运行时 CSSOM 不受 style-src 管控）；HarfBuzz wasm 需 `script-src 'wasm-unsafe-eval'`（缺失时自动回退 Canvas 整形器）。注：表格/原子块覆盖层与打印 iframe 的运行时注入样式仍为内联 `<style>`，严格 CSP 下打印通路已经构造样式表（CSSOM）兜底，覆盖层样式的 nonce 支持留作后续。
  - **表格富单元格**——`mergeCells` 判空改 `isCellEmpty`（不再静默吞含原子/marks 的空白格）、「td 不承载行内原子」不变量化、结构操作前焦点收口、MD 换行 `<br>` 保真、merges 越界防御（+22 测试）。
  - **SSOT 去重**——原子块覆盖层规格进 `block-specs`（消 doc-layout/rich-document/overlays 三处重复）、mark↔HTML 标签映射统一为 `mark-html`、overlays build 样板与 main prompt 模式收敛（约 120 行重复消除，+15 测试）。
  - **`main.ts` 装配瘦身**（当轮 927→684 行）：命中辅助→`editor/hit-testing`、原子块弹层族→`ui/atom-dialogs`、工具栏状态构建/脏检查→`ui/toolbar-state`、演示文档→`model/demo-doc`；`syncToolbar` 浅比较跳过无变更刷新（+50 测试）。注：后续批次接入触屏/拖文本/查找/打印后装配层回弹至 ~1160 行，触屏控制器与拖文本状态机下沉已立项（见 `main.ts` 头部 TODO）。
  - **规范清理**：整形器三模块补模块头注释；icons 死键清理（7 键 + `hasIcon` 校验）；`main.ts` 魔法数常量化；DOM 取元素改 fail-fast `mustEl`（`ui/dom.ts`）；style-resolver `as number` 改 typeof 收窄。
- **工具栏插件化重构**（设计评审 workflow + 实现 + 3 agent 对抗式保真 diff，零漂移）：746 行单体工厂 → 声明式贡献注册表
  （`ui/toolbar/`：item 描述符 + 8 种渲染器穷举表 + 通用 refresh + 运行时 `register()`），**对外 barrel 保契约、`main.ts` 与测试零改、视觉/行为零变化**（浏览器 12 项 parity 逐项实测：三页签布局/active/下拉互斥/颜色 hex/表格网格悬停/主题动态图标/tooltip 升级/撤销 disabled）。「加一个工具栏按钮」从碰 ~6 处降为往 `toolbar-items.ts` 加一条描述符（+12 测试）。
- **表格单元格增删光标错位修复**：单元格 `contenteditable` 拦截点击、不穿透 canvas → 模型选区从不同步到表格块，结构操作 blur 后选中环错落到相邻原子块（如公式）。修复为聚焦单元格时把模型选区同步到该块（镜像 canvas hitTest 对其他原子块的行为），文本框同类问题一并修。
- **三大设计模式抽象**（设计 workflow + 串行实现 + 对抗式保真 diff，保行为零变化）：
  - **Strategy-over-Visitor**：`export.ts` 的 `switch(block.type)` 收进 `BLOCK_EXPORTERS` 注册表 + `block-specs` 的 `meta.exporter` 插件扩展点（聚类合并块 ul/ol/pre 仍留主循环），HTML/MD/JSON 输出**字节级不变**（临时 diff 副本 + 字节探针测试佐证），新增块类型只改 `block-specs` 一处。
  - **Command + Mediator 命令总线**：消解工具栏 40 方法胖接口 `ToolbarHandlers` → 小 `CommandContext`；键盘 keymap、工具栏 item(`command:id`)、右键菜单**三路经同一命令表派发**（带参命令如字号/颜色/表格维度/模板名经 `exec(id,arg)`）。浏览器实测：⌘E 居中、工具栏切换、右键菜单同命令一致。
  - **Observer 事件发射器**：`editor/events.ts`，`afterEdit/afterNav/视图变更` 改 `emit`，工具栏/大纲/状态栏/ARIA 改**订阅**，解 `main.ts` 手动逐个 sync（脏检查 `isToolbarStateEqual` 仍生效）。

## 工程规范（见 `CONVENTIONS.md`）

对齐 **Vue3 核心（vuejs/core）+ Next.js（vercel/next.js）** 的代码工程约定，经 workflow 多 agent 审计（154 项）后落地：
- **文件命名**：统一 kebab-case（裁决两仓冲突，理由见 §0：跨平台大小写安全 + Next 对齐）。
- **文档注释**：每个 export 符号补 TSDoc + `@public/@internal`（新增 161 处），每文件模块头标注分层位置。
- **模块划分/复用**：删 2 个死模块（`layout.ts`/`document.ts`）；核心层（model/text/render/shared）零 UI 依赖——`glyph-atlas` 画布改由装配层注入；新增最底层 `shared/`。
- **函数设计**：补 39 处显式返回类型；拆分多职责方法（`insertText`/`enter` 抽私有 helper）。

## 后续

- **表格增强**：合并/拆分(colspan/rowspan)、列宽行高拖动已做；待办：单元格内富文本(marks/换行)、行列增删。
- **BiDi 增强**：阿拉伯连写整形 + 希伯来已支持（脚本→字体回退）；待办：带元音阿拉伯语的组合标记定位（多字形/簇）、跨方向边界选区多矩形、视觉光标键。
- **富文本粘贴**：HTML → marks（带白名单清洗）。
- 行内对象（mention chip）：位置模型已按「原子占 1 offset」预留。
- 大文档用扁平数组（编辑 O(n)）→ rope / piece-table。（增量重排与视口剔除已落地：`text/block-layout-cache` 块级缓存 + 可见行窗口二分。）
- HarfBuzz 已配 Latin(Roboto)/希伯来/阿拉伯字体回退；CJK/emoji 需再配 CJK 字体（回退表 `fallbacks` 可直接扩展）；协同（CRDT/OT）。

## 贡献

欢迎 Issue 与 PR。开始前请阅读：

- [贡献指南 `CONTRIBUTING.md`](CONTRIBUTING.md) — 本地开发、三门验证（`typecheck` + `test` + `build`）、提交规范、PR 流程。
- [工程规范 `CONVENTIONS.md`](CONVENTIONS.md) — 函数/模块/命名/文档注释约定（对齐 Vue3 核心 + Next.js）。
- [行为准则 `CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
- 安全漏洞请按 [`SECURITY.md`](SECURITY.md) 私密报告，勿公开提交 Issue。

变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

[MIT](LICENSE) © go-xworks
