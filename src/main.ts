/**
 * 编辑器装配入口（editor/ui 层）：组装文档模型、整形器、布局、渲染循环，
 * 接线输入(键鼠/IME/剪贴板)与 UI(工具栏/菜单/弹层/覆盖层/面板)，驱动 requestAnimationFrame 主循环。
 *
 * @remarks
 * 职责清单（CONVENTIONS §6：仅装配，业务下沉）：DOM 外壳/DPR/缩放与视图模式、滚动与光标跟随、
 * 渲染循环（frame/relayout）、事件接线（指针/键盘/IME/滚轮/拖放）、各 UI 模块的依赖注入组装。
 * 已下沉：命中辅助 → editor/hit-testing；原子块/导入/存模板弹层族 → ui/atom-dialogs；
 * 工具栏状态构建与脏检查 → ui/toolbar-state；演示文档 → model/demo-doc。
 * 已下沉（抽象①）：统一命令总线——键盘/工具栏/右键三路经 dispatch → editor/commands 命令表派发，
 * 旧 ToolbarHandlers 胖接口（40 方法）删除，工具栏改注入 ToolbarDeps（exec/focusEditor/templateNames）。
 * 后续重构 TODO（审计标注的暂缓项，风险较高，留待专项重构）：
 *  - TODO: BlockAttrs 按块族拆分（schema 的 attrs 大杂烩 → 判别联合）；
 *  - TODO: ui/overlays 按原子种类拆文件（god module 倾向）。
 *  - TODO(批F审查第11项·装配层回弹 708→1157 行)：触屏控制器下沉——touchPoints/pinch/
 *    panVelocity/惯性 rAF 循环连同 onTouchDown/Move/Up 收进 editor/ 触屏控制器
 *    （注入 setZoom/scrollBy/posAtDevice 回调），main 只留事件转发；
 *  - TODO(同上)：拖文本 pending→drag→drop 状态机（pendingSelDown/dragTextActive/dropPos）
 *    与选区手柄几何换算（selectionHandleState）同法下沉 editor/。
 */
import './styles/shell.css'; // 外壳样式（自 index.html 内联 <style> 外置；CSP 友好，先于 tw.css 保持原级联序）
import './styles/tw.css';
import 'katex/dist/katex.min.css';
import { GlyphAtlas } from './text/glyph-atlas';
import { createRenderer } from './render/create-renderer';
import type { Renderer } from './render/renderer';
import { Quad } from './render/renderer';
import { Shaper } from './text/shaper';
import { CanvasShaper } from './text/canvas-shaper';
import { HarfBuzzShaper } from './text/harfbuzz-shaper';
import { MarkType, isAtomBlock } from './model/schema';
import { createDemoDoc } from './model/demo-doc';
import { BUILTIN_TEMPLATES, loadUserTemplates, userTemplateToDocTemplate, DocTemplate } from './model/templates';
import { loadDraft, saveDraft, createAutosaver } from './model/persistence';
import { RichDoc, Pos, comparePos } from './model/rich-document';
import { inlineAtomSrcAt } from './model/inlines';
import { StyleResolver } from './model/style-resolver';
import { C, applyCanvasTheme, activeTheme, ThemeName } from './model/palette';
import { layoutDoc, caretAt, caretLine, nearestLine, hitTestDoc, selectionRects, visibleLineRange, DocLayout } from './text/doc-layout';
import { BlockLayoutCache } from './text/block-layout-cache';
import { paginateLayout, PageRect } from './text/paginate';
import { clamp } from './shared/util';
import { sanitizeLinkHref } from './shared/url';
import { createToolbar, Toolbar, ToolbarState } from './ui/toolbar';
import { buildToolbarState, isToolbarStateEqual } from './ui/toolbar-state';
import { createOutputPanel } from './ui/output-panel';
import { createContextMenu, MenuItem } from './ui/context-menu';
import { createPromptDialog } from './ui/prompt';
import { createImageDialog } from './ui/image-dialog';
import { createSignatureDialog } from './ui/signature-dialog';
import { createAtomDialogs } from './ui/atom-dialogs';
import { createOverlayManager } from './ui/overlays';
import { createAriaTree } from './ui/aria';
import { createOutline, Outline } from './ui/outline';
import { createStatusBar, StatusBar } from './ui/status-bar';
import { commands, keymap, keyCombo, SELF_FINALIZING, NAV_AFFINITY, VIEW_ONLY, CommandContext, CommandArg } from './editor/commands';
import { TouchGesture, pointerDist, pinchZoom, visibleCanvasHeightDev, decayVelocity, exceedsThreshold, DRAG_TEXT_MIN_PX } from './editor/touch';
import { wordRangeAt } from './model/word-boundary';
import { createSelectionHandles, SelectionHandleState } from './ui/selection-handles';
import { createFindBar } from './ui/find-bar';
import { printDoc } from './ui/print';
import { createEmitter } from './editor/events';
import { setupClipboard } from './editor/clipboard';
import { affinityAt, gapAtY, gapYDevice, tocLineHit, taskCheckboxHit } from './editor/hit-testing';
import { mustEl } from './ui/dom';

// 默认整形器：'canvas'（系统字体，含 CJK，立即可用）或 'harfbuzz'（Roboto，真整形，Latin）
const DEFAULT_SHAPER: 'canvas' | 'harfbuzz' = 'canvas';

const canvas = mustEl<HTMLCanvasElement>('c');
const ime = mustEl<HTMLTextAreaElement>('ime');
const ariaTree = createAriaTree(canvas, ime);
let tableFocused = false; // 表格单元格编辑中（暂停 canvas 光标 / 不抢回 ime）

let dpr = Math.max(1, window.devicePixelRatio || 1);
const atlas = new GlyphAtlas(() => document.createElement('canvas'), dpr);
let renderer!: Renderer;
const resolver = new StyleResolver();

const canvasShaper = new CanvasShaper(atlas);
let hbShaper: HarfBuzzShaper | null = null;
let activeShaper: Shaper = canvasShaper;
let toolbar: Toolbar | null = null;

// —— 初始文档：优先恢复 localStorage 自动保存的草稿（doc + 选区，model/persistence），
// 无草稿/草稿损坏时回退演示样张（标题/段落/多 mark/列表/对齐/引用，见 model/demo-doc）——
const draft = loadDraft();
const rd = new RichDoc(draft ? draft.doc : createDemoDoc());
if (draft) {
  rd.setSel(draft.anchor);          // setSel 内部 clamp：草稿选区越界时夹回合法范围
  rd.setSel(draft.focus, true);
} else {
  rd.setSel(rd.docEnd());
}

// —— 类型化事件总线（抽象③ Observer）：内容变 / 选区变 / 视图变 三类时机经命名事件广播，
// 订阅者在 start() 内注册、回调内自读当前 rd/zoom/viewMode。afterEdit/viewChanged/视图切换只 emit，
// 不再各自硬编码逐个 sync（旧 onContentChanged 单回调下沉为 doc:changed 订阅者，见下）。
const bus = createEmitter();

// —— 布局缓存 ——
let cached: DocLayout | null = null;
let dirty = true;
// 帧门控：任何可见状态变化（重排/滚动/选区/光标相位/覆盖层高度自发变化）置位；
// 静止帧零分配、零上传、零绘制、零 overlays sync（见 frame() 早退分支）。
let needRender = true;
// 块级布局缓存：layoutDoc 按 (blockVersion, orderedNum) 命中复用文本块几何；
// epoch（宽度/内边距/比例/整形器/主题/图集代）任一变化 beginPass 整体失效。
const layoutCache = new BlockLayoutCache();
// 可见行二分索引（重排帧自 cached.lines 提取一次；滚动帧零分配二分）。
let lineTops = new Float64Array(0);
let lineBottoms = new Float64Array(0);
let goalX: number | null = null;
let caretAffinity: 'before' | 'after' = 'after'; // 软换行点光标贴哪一行
let scrollY = 0;            // 内容垂直滚动（设备 px）
let followCaret = false;    // 编辑/移动后把光标滚入视口
let scrollDrag: { startY: number; startScroll: number } | null = null;

// —— 装配层 UI 常量（逻辑 px / ms；使用处 ×dpr 折算设备 px）——
/** web 视图内容四周内边距（逻辑 px）。 */
const PAD = 26;
/** 光标闪烁周期（ms）：每周期前 {@link CARET_BLINK_VISIBLE_MS} 可见，其余隐藏。 */
const CARET_BLINK_PERIOD_MS = 1060;
/** 光标闪烁周期内的可见时长（ms）。 */
const CARET_BLINK_VISIBLE_MS = 600;
/** 文本光标条宽（逻辑 px）。 */
const CARET_W = 2;
/** 文本光标相对行盒的上下内缩（逻辑 px），避免与上下行装饰贴边。 */
const CARET_INSET = 2;
/** 光标跟随滚动（ensureCaretVisible）时与视口上下边保留的边距（逻辑 px）。 */
const CARET_FOLLOW_MARGIN = 10;
/** 滚动条拇指最小高（逻辑 px）：超长文档下拇指不缩成一点。 */
const SCROLLBAR_MIN_THUMB = 30;
/** 滚动条拇指宽（逻辑 px）。 */
const SCROLLBAR_W = 5;
/** 滚动条拇指右缘到画布右缘的距离（逻辑 px）。 */
const SCROLLBAR_RIGHT = 7;
/** 画布右缘的滚动条命中带宽（逻辑 px）：pointerdown 落在带内视为拖滚动条。 */
const SCROLLBAR_HIT_W = 14;
/** 滚动条拇指不透明度：拖动中 / 静止。 */
const SCROLLBAR_ALPHA_ACTIVE = 0.34;
const SCROLLBAR_ALPHA_IDLE = 0.2;
/** PageUp/Down 每次滚动视口高的比例（留 10% 重叠便于阅读衔接）。 */
const PAGE_SCROLL_RATIO = 0.9;
/** 滚轮 deltaMode=DOM_DELTA_LINE（行模式）每行折算 CSS px。 */
const WHEEL_LINE_PX = 16;

// —— 视图模式（web=连续滚动 / word=A4 分页）与功能性缩放（0.5..2）——
// word 视图页面几何（逻辑 px）：A4 @96dpi 794×1123，页内边距 64，页缝 24。
const PAGE_W = 794;
const PAGE_H = 1123;
const PAGE_MARGIN = 64;
const PAGE_GAP = 24;
/** 窄屏时页面距画布左右的最小边距（逻辑 px）。 */
const PAGE_MIN_X = 8;
/** 纸面右/下投影宽（逻辑 px）与不透明度。 */
const PAGE_SHADOW_W = 2;
const PAGE_SHADOW_ALPHA = 0.18;
const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
let viewMode: 'web' | 'word' = 'web';
let zoom = 1;
let pages: PageRect[] = [];        // word 视图各页纸面矩形（relayout 回填）
let layoutPadL = PAD * dpr;        // 当前布局左内边距（设备 px），任务勾选栏命中复用
let appliedScale = dpr;            // 图集 / HarfBuzz 当前生效的渲染比例（构造时 = dpr）

/**
 * 把有效渲染比例（dpr×zoom）同步到字形图集与 HarfBuzz 整形器：
 * 布局与字形光栅必须共用同一比例，否则字距与排版错位。比例未变零开销；
 * 变化时图集整体复位（consumeReset → 下一帧重排重栅），同时修掉「换屏(dpr 变)不重栅」旧疾。
 */
function applyRenderScale() {
  const s = dpr * zoom;
  if (s === appliedScale) return;
  appliedScale = s;
  atlas.setDpr(s); // 内部页数收缩回 1（zoom 会话峰值不常驻）
  if (renderer) renderer.dropAtlasPages(1); // GPU 侧同步回收多余页纹理
  hbShaper?.setDpr(s);
  dirty = true;
}
/** 设置功能性缩放：clamp 到 0.5..2（避免浮点漂移先取整到百分位），重设渲染比例并重排。 */
function setZoom(z: number) {
  const next = clamp(Math.round(z * 100) / 100, ZOOM_MIN, ZOOM_MAX);
  if (next === zoom) return;
  zoom = next;
  applyRenderScale();
  viewModeChanged();
}
/** 切换视图模式（web 连续滚动 / word A4 分页），光标随重排滚入视口。 */
function setViewMode(m: 'web' | 'word') {
  if (m === viewMode) return;
  viewMode = m;
  followCaret = true;
  viewModeChanged();
}

function relayout() {
  const scale = dpr * zoom; // 布局与图集/整形器共用的有效渲染比例
  if (viewMode === 'word') {
    // word 视图：页面水平居中（窄屏留 8px 最小边距），内容区 = 页面减四边距；
    // padT = 页缝 + 上边距（paginateLayout 据此反推首页页顶），布局后按页切分平移。
    const pageWDev = PAGE_W * scale;
    const pageX = Math.max(PAGE_MIN_X * scale, (canvas.width - pageWDev) / 2);
    layoutPadL = pageX + PAGE_MARGIN * scale;
    const opt = { width: 2 * pageX + pageWDev, padL: layoutPadL, padT: (PAGE_GAP + PAGE_MARGIN) * scale, dpr: scale };
    layoutCache.beginPass({ width: opt.width, padL: opt.padL, padT: opt.padT, scale, shaper: activeShaper, theme: activeTheme(), atlasGen: atlas.generation });
    const raw = layoutDoc(rd.doc, activeShaper, resolver, opt, layoutCache);
    const paged = paginateLayout(raw, {
      pageX, pageW: pageWDev, pageH: PAGE_H * scale,
      marginTop: PAGE_MARGIN * scale, marginBottom: PAGE_MARGIN * scale,
      gap: PAGE_GAP * scale, padT: (PAGE_GAP + PAGE_MARGIN) * scale,
    });
    cached = paged.layout;
    pages = paged.pages;
  } else {
    layoutPadL = PAD * scale;
    const opt = { width: canvas.width, padL: layoutPadL, padT: PAD * scale, dpr: scale };
    layoutCache.beginPass({ width: opt.width, padL: opt.padL, padT: opt.padT, scale, shaper: activeShaper, theme: activeTheme(), atlasGen: atlas.generation });
    cached = layoutDoc(rd.doc, activeShaper, resolver, opt, layoutCache);
    pages = [];
  }
  // 可见行二分索引：lines 的 top/bottom 随文档序单调（块间距 ≥0；paginate 平移单调不减）。
  const lns = cached.lines;
  lineTops = new Float64Array(lns.length);
  lineBottoms = new Float64Array(lns.length);
  for (let i = 0; i < lns.length; i++) { lineTops[i] = lns[i].top; lineBottoms[i] = lns[i].bottom; }
  dirty = false;
}
// —— 三类变化时机经事件总线广播（订阅者在 start() 注册，见下）——
// 仅视图/选区变化（选择/导航/滚动）：重绘 + 工具栏回填，不重排（布局不依赖选区）。
function viewChanged() { bus.emit('selection:changed'); }
// 内容变化：重排（relayout）+ ARIA 镜像 + 面板（大纲/状态栏）刷新。旧 markDirty 的五件事
// （dirty/resetBlink/syncToolbar/ariaTree/syncPanels）下沉为 doc:changed 订阅者；markDirty 退化为
// 薄封装，故覆盖层 onTableEdit/onTextboxEdit 等现有直调点零改（zeroChangeRisk: markDirty 解耦）。
function markDirty() { bus.emit('doc:changed'); }
// 视图模式/缩放/整形器/主题切换：dirty + 重绘 + 工具栏/状态栏回填（dirty 置位在各 setter 内）。
function viewModeChanged() { bus.emit('view:changed'); }
function afterNav(aff: 'before' | 'after') { goalX = null; caretAffinity = aff; followCaret = true; viewChanged(); }
function afterEdit() { goalX = null; caretAffinity = 'after'; followCaret = true; markDirty(); }

// —— 滚动 ——
// word：分页布局的 contentHeight 已是「末页底 + 页缝」的总像素高（从 0 起）；web：内容高 + 上下 PAD。
function docPixelHeight() {
  if (!cached) return 0;
  return viewMode === 'word' ? cached.contentHeight : cached.contentHeight + 2 * PAD * dpr * zoom;
}
// 像素对齐：scrollY 取整（滚轮/触控板可停在分数 px，分数滚动 + LINEAR 采样会让整屏文字常驻模糊）。
function clampScroll() { scrollY = Math.round(Math.max(0, Math.min(Math.max(0, docPixelHeight() - canvas.height), scrollY))); }
// visualViewport 适配（批E）：虚拟键盘弹出只缩 visual viewport（layout viewport 不变），
// 光标跟随的视口下界用「键盘上沿」换算的有效可视高（无 visualViewport / 完全遮挡时回退全高）。
function effectiveViewHeightDev(): number {
  const vv = window.visualViewport;
  if (!vv) return canvas.height;
  const h = visibleCanvasHeightDev(canvas.getBoundingClientRect().top, canvas.height, vv.offsetTop, vv.height, dpr);
  return h > 0 ? h : canvas.height;
}
function ensureCaretVisible() {
  if (!cached) return;
  const c = caretAt(cached, rd.focus, caretAffinity); if (!c) return;
  const m = CARET_FOLLOW_MARGIN * dpr;
  const viewH = effectiveViewHeightDev(); // 键盘弹出时 < canvas.height：光标行滚出遮挡区
  if (c.top - scrollY < m) scrollY = c.top - m;
  else if (c.bottom - scrollY > viewH - m) scrollY = c.bottom - viewH + m;
  clampScroll();
}
// 键盘弹出/收起、可视视口平移：焦点在编辑器时把光标行重新滚入可视区
const onViewportShift = () => {
  if (document.activeElement !== ime || tableFocused) return;
  followCaret = true;
  needRender = true;
};
window.visualViewport?.addEventListener('resize', onViewportShift);
window.visualViewport?.addEventListener('scroll', onViewportShift);
function scrollbarThumb(): { x: number; y: number; w: number; h: number } | null {
  const docH = docPixelHeight();
  if (docH <= canvas.height + 1) return null;
  const trackH = canvas.height;
  const thumbH = Math.max(SCROLLBAR_MIN_THUMB * dpr, trackH * canvas.height / docH);
  const maxScroll = docH - canvas.height;
  const thumbY = maxScroll > 0 ? (scrollY / maxScroll) * (trackH - thumbH) : 0;
  return { x: canvas.width - SCROLLBAR_RIGHT * dpr, y: thumbY, w: SCROLLBAR_W * dpr, h: thumbH };
}
// 光标是否停在被「节点选中」的原子块上（图片/公式/表格）
function isFocusAtom(): boolean { return rd.isCollapsed && isAtomBlock(rd.focusBlock().type); }

function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  applyRenderScale(); // 换屏致 dpr 变化 → 图集/整形器按新比例重栅（顺带修掉旧疾）
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  renderer.resize(canvas.width, canvas.height);
  dirty = true;
}
window.addEventListener('resize', resize);
// 编辑器容器尺寸变化（含左大纲面板折叠/展开导致的宽度变化，无 window resize 事件）→ 同步 canvas。
// renderer 在 start() 内创建后才挂观察；观察前先做一次保护性判断。
const editorResizeObserver = new ResizeObserver(() => { if (renderer) resize(); });

let blinkStart = performance.now();
function resetBlink() { blinkStart = performance.now(); }
function caretVisible() { return ((performance.now() - blinkStart) % CARET_BLINK_PERIOD_MS) < CARET_BLINK_VISIBLE_MS; }

// —— GPU 上下文丢失恢复（驱动更新/GPU 进程崩溃/休眠唤醒/移动端后台回收）——
// WebGL2：canvas 事件对（lost 必须 preventDefault 才会派发 restored）；WebGPU：renderer.lost（device.lost）。
// 恢复 = 重建渲染器 → 图集整页重传（CPU 画布数据无损，无需重栅）→ dirty 强制重排重绘。
let rebuildingRenderer = false;
async function rebuildRenderer(): Promise<void> {
  if (rebuildingRenderer) return;
  rebuildingRenderer = true;
  try {
    renderer = await createRenderer(canvas);
    renderer.resize(canvas.width, canvas.height);
    for (const p of atlas.fullPages()) renderer.uploadAtlasPage(p.page, p.canvas);
    watchRendererLost();
    dirty = true;
    needRender = true;
    console.log('[renderer] 上下文已恢复，渲染器重建完成');
  } catch (err) {
    console.warn('[renderer] 上下文恢复失败：', err);
  } finally {
    rebuildingRenderer = false;
  }
}
/** 订阅当前渲染器的设备丢失信号（WebGPU device.lost；WebGL2 走 canvas 事件，此字段缺省）。 */
function watchRendererLost(): void {
  renderer.lost?.then(() => { console.warn('[renderer] GPU 设备丢失，重建渲染器'); void rebuildRenderer(); });
}
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('[renderer] WebGL 上下文丢失'); });
canvas.addEventListener('webglcontextrestored', () => { void rebuildRenderer(); });

// —— 渲染循环 ——
// 帧门控签名存档（帧首比对、渲染帧尾更新）：滚动位置 / 光标可见相位 / 选区签名。
let lastScrollY = -1;
let lastCaretOn: boolean | null = null;
let lastSelSig = '';
// quads 复用：模块级数组，渲染帧首 length=0，消除每帧 new 数组（对象池/扁平数组留作后续优化）。
const quads: Quad[] = [];

function frame() {
  if (dirty || !cached) { relayout(); needRender = true; }
  if (atlas.consumeReset()) { dirty = true; needRender = true; } // 图集复位 → 下一帧重排，重栅本帧前已放置的字形
  const L = cached!;
  if (followCaret) { ensureCaretVisible(); followCaret = false; }
  clampScroll();
  // —— 静止帧判定：滚动/光标相位/选区（含滚动条拖拽态——拇指 alpha）任一变化才重绘 ——
  const caretOn = rd.isCollapsed && caretVisible() && !tableFocused && !isFocusAtom();
  // caretAffinity 纳入签名：软换行边界同 offset 两侧点击仅翻转 affinity（Pos 不变），
  // 漏掉会让光标停留旧视觉行直到 blink 相位兜底重绘（IME 候选框定位同窗口期不更新）。
  const selSig = `${rd.anchor.block}:${rd.anchor.offset}:${rd.focus.block}:${rd.focus.offset}:${scrollDrag ? 1 : 0}:${caretAffinity}`;
  if (scrollY !== lastScrollY || caretOn !== lastCaretOn || selSig !== lastSelSig) needRender = true;
  if (!needRender) {
    // 静止帧：零分配、零上传、零绘制、零 overlays sync（两后端 canvas 不重绘即保留上次合成画面；
    // measured 覆盖层的自发高度变化由 ResizeObserver 置 needRender 兜底，不再每帧轮询 offsetHeight）。
    requestAnimationFrame(frame);
    return;
  }
  // 仅上传有新字形写入的页的脏矩形子区（替代旧「单布尔 + 整图重传」，新字形不再付 16.7MB 全量）
  for (const d of atlas.takeDirtyPages()) renderer.uploadAtlasPage(d.page, d.canvas, d.rect);
  const wu = atlas.whiteUV;
  quads.length = 0;
  // 内容坐标（自动减去 scrollY）；纯色矩形固定 page 0 —— 白块恒在 page 0。
  // 像素对齐：四缘各自取整（共享边取整一致 → 相邻矩形无缝），整数贴放消除 LINEAR 半像素发糊。
  const solid = (x: number, y: number, w: number, h: number, c: [number, number, number, number]) => {
    const x0 = Math.round(x), y0 = Math.round(y - scrollY);
    const x1 = Math.round(x + w), y1 = Math.round(y - scrollY + h);
    quads.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, u0: wu.u, v0: wu.v, u1: wu.u, v1: wu.v, r: c[0], g: c[1], b: c[2], a: c[3], page: 0 });
  };
  // 屏幕坐标（不随滚动，画滚动条）
  const solidScreen = (x: number, y: number, w: number, h: number, c: [number, number, number, number]) => {
    const x0 = Math.round(x), y0 = Math.round(y);
    const x1 = Math.round(x + w), y1 = Math.round(y + h);
    quads.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, u0: wu.u, v0: wu.v, u1: wu.u, v1: wu.v, r: c[0], g: c[1], b: c[2], a: c[3], page: 0 });
  };

  // —— 视口剔除：可见行窗口二分（lines top/bottom 单调），只为可见行推几何 ——
  const viewBottom = scrollY + canvas.height;
  const [i0, i1] = visibleLineRange(lineTops, lineBottoms, scrollY, viewBottom);
  const yVisible = (top: number, h: number) => top + h >= scrollY && top <= viewBottom;

  // word 视图：clear 用页缝色，先为每页画纸面（C.bg）+ 右/下 2px 半透明投影，再画内容
  const isWord = viewMode === 'word';
  if (isWord) {
    const shadow: [number, number, number, number] = [0, 0, 0, PAGE_SHADOW_ALPHA];
    const sw = PAGE_SHADOW_W * dpr;
    for (const pg of pages) {
      if (!yVisible(pg.y, pg.h + sw)) continue; // 页数少：线性 y 相交过滤即可
      solid(pg.x + pg.w, pg.y + sw, sw, pg.h, shadow); // 右投影
      solid(pg.x + sw, pg.y + pg.h, pg.w, sw, shadow); // 下投影
      solid(pg.x, pg.y, pg.w, pg.h, C.bg);             // 纸面
    }
  }

  for (const bg of L.backgrounds) { if (yVisible(bg.y, bg.h)) solid(bg.x, bg.y, bg.w, bg.h, bg.color); } // 连续代码块背景：条数少，线性过滤
  // 文字背景高亮 → 选区 → 字形 → 装饰：保持全局 z 序，各几何按行区间分趟推可见段
  for (let i = i0; i < i1; i++) {
    const ln = L.lines[i];
    for (let k = ln.hlStart ?? 0, e = ln.hlEnd ?? 0; k < e; k++) { const hl = L.highlights[k]; solid(hl.x, hl.y, hl.w, hl.h, hl.color); }
  }
  // 查找命中高亮：可见行窗内逐命中产矩形（复用 selectionRects 几何），当前命中由选区层（上方）突出
  const fMatches = findBar.matches();
  if (fMatches.length) {
    const blockLo = L.lines[i0]?.block ?? 0;
    const blockHi = i1 > i0 ? L.lines[i1 - 1].block : -1;
    const fCur = findBar.currentIndex();
    for (let mi = 0; mi < fMatches.length; mi++) {
      if (mi === fCur) continue; // 当前命中即选区：跳过底色避免双 wash 叠深
      const m = fMatches[mi];
      if (m.block < blockLo || m.block > blockHi) continue;
      for (const r of selectionRects(L, { block: m.block, offset: m.start }, { block: m.block, offset: m.end }, i0, i1))
        solid(r.x, r.y, r.w, r.h, C.findMatch);
    }
  }
  if (!rd.isCollapsed) {
    const { from, to } = rd.range();
    for (const r of selectionRects(L, from, to, i0, i1)) solid(r.x, r.y, r.w, r.h, r.color);
  }
  for (let i = i0; i < i1; i++) {
    const ln = L.lines[i];
    for (let k = ln.glyphStart ?? 0, e = ln.glyphEnd ?? 0; k < e; k++) {
      const g = L.glyphs[k];
      // 字形位图已按设备像素光栅：x/y 各自独立取整（不累计——RTL/justify 下无字距漂移），整数贴放=逐像素拷贝零模糊
      quads.push({
        x: Math.round(g.penX), y: Math.round(g.baselineY - g.info.bearingY - scrollY), w: g.info.w, h: g.info.h,
        u0: g.info.u0, v0: g.info.v0, u1: g.info.u1, v1: g.info.v1,
        r: g.color[0], g: g.color[1], b: g.color[2], a: g.color[3], page: g.info.page,
      });
    }
  }
  for (let i = i0; i < i1; i++) {
    const ln = L.lines[i];
    for (let k = ln.decoStart ?? 0, e = ln.decoEnd ?? 0; k < e; k++) { const u = L.decorations[k]; solid(u.x, u.y, u.w, u.h, u.color); }
  }
  // 光标：原子块（图片/公式/表格）走「节点选中外框」(在覆盖层上画)，不画等高文本光标
  const focusAtom = isFocusAtom();
  if (caretOn) {
    const c = caretAt(L, rd.focus, caretAffinity);
    if (c) {
      solid(c.x, c.top + CARET_INSET * dpr, Math.max(1, Math.round(CARET_W * dpr)), (c.bottom - c.top) - 2 * CARET_INSET * dpr, C.caret);
      // IME 代理是 fixed 定位（视口坐标系）：候选窗位置 = canvas 视口偏移 + 布局坐标 ÷ 设备 dpr。
      // 布局 px 即 canvas 物理 px，屏幕 CSS = ÷dpr（zoom 已含在布局坐标里；÷scale 会在 zoom≠1 时错位）；
      // 此前缺 canvas 偏移（工具栏高/左侧栏宽），候选窗在任意 zoom 下均偏移——一并修正。
      const cr = canvas.getBoundingClientRect();
      ime.style.left = Math.round(cr.left + c.x / dpr) + 'px';
      ime.style.top = Math.round(cr.top + (c.top - scrollY) / dpr) + 'px';
    }
  }
  // 滚动条
  const th = scrollbarThumb();
  if (th) solidScreen(th.x, th.y, th.w, th.h, [1, 1, 1, scrollDrag ? SCROLLBAR_ALPHA_ACTIVE : SCROLLBAR_ALPHA_IDLE]);

  renderer.render(quads, isWord ? C.pageGap : C.bg);
  // 覆盖层换算用布局比例 L.dpr（= dpr×zoom，本帧布局实际所用）：盒坐标 ÷scale 还原逻辑 px，
  // 再由覆盖层 transform scale(zoom) 放大 → 与 canvas 内容对齐，且 DOM 覆盖层随 zoom 同步缩放。
  // 不剔除：overlayMgr 以「seen 集合差」删除 DOM 条目，剔除会销毁滚出视口的 iframe/视频/编辑态；量级小，全量传入。
  overlayMgr.sync(rd.doc, L.overlays, scrollY, L.dpr, focusAtom && !tableFocused ? rd.focus.block : -1);
  // 行内图片覆盖层：按 block:offset 把覆盖盒映射回行内原子的 src
  overlayMgr.syncInline(L.inlineOverlays, inlineImageSrc, scrollY, L.dpr);
  // 触屏选区手柄：随渲染帧跟布局/滚动（批E P1-2）
  selHandles.sync(selectionHandleState(L));
  lastScrollY = scrollY; lastCaretOn = caretOn; lastSelSig = selSig;
  needRender = false;
  requestAnimationFrame(frame);
}

// —— 原子块覆盖层（图片 / 公式 / 表格）——
const editorEl = mustEl('editor');
const overlayMgr = createOverlayManager(editorEl, {
  onTableEdit: () => { markDirty(); },
  onTextboxEdit: () => { markDirty(); },
  onAtomEdit: (blockIndex, kind) => { atomDialogs.editAtom(blockIndex, kind); },
  onMeasured: (blockIndex, hLogical) => { if (rd.setMeasuredHeight(blockIndex, hLogical)) dirty = true; },
  // measured 覆盖层（公式/表格）静止期自发高度变化（KaTeX 字体晚到/图片加载）：
  // 置 needRender → 下一渲染帧 sync 统一重读 offsetHeight 回填（替代旧每帧轮询）。
  onMeasuredResize: () => { needRender = true; },
  // 单元格/文本框取焦：暂停 canvas 光标，并把模型选区同步到该原子块——否则选区停在点表格前的
  // 陈旧块（如紧邻公式），结构操作（增删行列等）blur 后选中环会错落到那个块上。
  onCellFocus: (blockIndex) => { tableFocused = true; rd.setSel({ block: blockIndex, offset: 0 }); },
  onCellBlur: () => { tableFocused = false; ime.focus({ preventScroll: true }); },
  onImageResize: (blockIndex, w, h) => { rd.setImageSize(blockIndex, w, h); afterEdit(); },
  onBlockMove: (blockIndex, clientY, phase) => handleBlockMove(blockIndex, clientY, phase),
  onColResize: (blockIndex, col, w) => { rd.setColWidth(blockIndex, col, w); afterEdit(); },
  onRowResize: (blockIndex, row, h) => { rd.setRowHeight(blockIndex, row, h); afterEdit(); },
  onTableMerge: (blockIndex, r0, c0, r1, c1) => { rd.mergeCells(blockIndex, r0, c0, r1, c1); afterEdit(); },
  onTableSplit: (blockIndex, r, c) => { rd.splitCell(blockIndex, r, c); afterEdit(); },
  onTableRowOp: (blockIndex, row, op) => {
    if (op === 'delete') rd.deleteRow(blockIndex, row); else rd.insertRow(blockIndex, row, op);
    afterEdit();
  },
  onTableColOp: (blockIndex, col, op) => {
    if (op === 'delete') rd.deleteCol(blockIndex, col); else rd.insertCol(blockIndex, col, op);
    afterEdit();
  },
});

// 行内图片覆盖盒 → 其 src：按累计 offset 在块内定位行内原子（纯查询下沉 model/inlines）。
function inlineImageSrc(box: { block: number; offset: number }): string {
  const blk = rd.doc.blocks[box.block];
  return blk ? inlineAtomSrcAt(blk.inlines, box.offset) : '';
}

// —— 图片拖动重排：落点指示线 + 提交（间隙计算下沉 editor/hit-testing）——
const dropLine = document.createElement('div');
dropLine.style.cssText = 'position:absolute;left:8px;right:8px;height:2px;border-radius:1px;background:var(--rte-accent);display:none;pointer-events:none;z-index:30';
editorEl.appendChild(dropLine);
let dropTarget = -1;
function handleBlockMove(from: number, clientY: number, phase: 'move' | 'drop') {
  const rect = canvas.getBoundingClientRect();
  const gap = gapAtY(cached, rd.blockCount, (clientY - rect.top) * dpr + scrollY);
  if (phase === 'move') {
    dropTarget = gap;
    dropLine.style.top = ((gapYDevice(cached, rd.blockCount, gap) - scrollY) / dpr) + 'px';
    dropLine.style.display = '';
  } else {
    dropLine.style.display = 'none';
    if (dropTarget >= 0) { rd.moveBlock(from, dropTarget); afterEdit(); }
    dropTarget = -1;
  }
}

// —— 指针（鼠标/触控笔 + 触屏分流，批E）——
// 坐标换算契约：布局 px 与 canvas 物理 px 同一坐标系（canvas.width = CSS 宽 × 设备 dpr；
// zoom 放大的是布局坐标系内的内容，已含在坐标值里）。故屏幕 CSS ↔ 布局 = ×/÷ 设备 dpr；
// 逻辑 px ↔ 布局 = ×/÷ scale（dpr×zoom）。命中/光标用前者，logical 尺寸（indent 等）用后者。
let dragging = false;
let lastPointerType = 'mouse'; // 最近一次 pointerdown 的指针类型：选区手柄显隐 / contextmenu 仲裁
function eventXY(e: PointerEvent | MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  return { px: (e.clientX - rect.left) * dpr, py: (e.clientY - rect.top) * dpr };
}
// 设备坐标（canvas 物理 px）→ 文档位置（顺带回写 caretAffinity）
function posAtDevice(px: number, py: number): Pos {
  if (!cached) return { block: 0, offset: 0 };
  const cy = py + scrollY; // 屏幕 → 内容坐标
  const pos = hitTestDoc(cached, px, cy);
  caretAffinity = affinityAt(cached, pos, nearestLine(cached, cy));
  return pos;
}
function posFromEvent(e: PointerEvent | MouseEvent): Pos {
  const { px, py } = eventXY(e);
  return posAtDevice(px, py);
}
function overScrollbar(px: number): boolean { return !!scrollbarThumb() && px >= canvas.width - SCROLLBAR_HIT_W * dpr; }
// 位置是否落在当前非折叠选区内（含端点）
function posWithinSelection(pos: Pos): boolean {
  if (rd.isCollapsed) return false;
  const { from, to } = rd.range();
  return comparePos(pos, from) >= 0 && comparePos(pos, to) <= 0;
}
// 按词选中 pos 所在词（Intl.Segmenter word 粒度，复用 model/word-boundary）
function selectWordAt(pos: Pos) {
  const r = wordRangeAt(rd.blockStr(pos.block), pos.offset);
  rd.setSel({ block: pos.block, offset: r.start });
  rd.setSel({ block: pos.block, offset: r.end }, true);
}

// —— 触屏手势状态（批E P0-3/P1-4/P3-5）——
const touchPoints = new Map<number, { x: number; y: number }>(); // 活动 touch 指针（设备 px）
let pinch: { d0: number; zoom0: number } | null = null;          // 双指捏合基线（起始距/起始 zoom）
let gesturePointerId = -1;                                       // 单指判型中的指针 id
let panVelocity = 0;                                             // 平移速度低通（设备 px/帧）
let lastPanTime = 0;
// 长按（500ms 静止，运行时计时经可注入调度器）→ 选区模式。方案（批E 第5项，单一路径）：
// 长按落点在现有选区内 → 保留选区，否则选词；继续拖动可调整选区；松手在指位弹上下文菜单
// —— iOS 不派发非链接长按 contextmenu 的兜底；Android 合成的 contextmenu 按 lastPointerType 压掉防双弹。
const touchGesture = new TouchGesture({
  onLongPress: (x, y) => {
    const pos = posAtDevice(x, y);
    if (!posWithinSelection(pos)) selectWordAt(pos);
    navigator.vibrate?.(10);
    viewChanged();
  },
});
// 惯性滚动：pan 松手后按速度衰减续滚（任何新触摸/捏合即停）
let inertiaV = 0;
let inertiaLastT = 0;
let inertiaRunning = false;
function stopInertia() { inertiaV = 0; }
function inertiaStep() {
  if (!inertiaV || touchGesture.mode !== 'idle' || pinch) { inertiaRunning = false; return; }
  const now = performance.now();
  const dt = now - inertiaLastT;
  inertiaLastT = now;
  scrollY -= inertiaV * (dt / 16.7);
  clampScroll();
  needRender = true;
  inertiaV = decayVelocity(inertiaV, dt);
  if (inertiaV) requestAnimationFrame(inertiaStep); else inertiaRunning = false;
}
function startInertia(v: number) {
  inertiaV = v;
  if (!inertiaRunning && decayVelocity(v, 0) !== 0) {
    inertiaRunning = true;
    inertiaLastT = performance.now();
    requestAnimationFrame(inertiaStep);
  }
}

function onTouchDown(e: PointerEvent) {
  const { px, py } = eventXY(e);
  touchPoints.set(e.pointerId, { x: px, y: py });
  canvas.setPointerCapture(e.pointerId);
  stopInertia();
  if (touchPoints.size === 2) {
    // 双指 → 捏合缩放：取消单指判型（长按停表），以当前两指距为基线跟手缩放
    touchGesture.cancel();
    gesturePointerId = -1;
    const [a, b] = [...touchPoints.values()];
    pinch = { d0: pointerDist(a.x, a.y, b.x, b.y), zoom0: zoom };
    return;
  }
  if (touchPoints.size > 2 || pinch) return; // 第三指/捏合中：忽略
  gesturePointerId = e.pointerId;
  panVelocity = 0;
  lastPanTime = performance.now();
  touchGesture.down(px, py);
}
function onTouchMove(e: PointerEvent) {
  const pt = touchPoints.get(e.pointerId);
  if (!pt) return;
  const { px, py } = eventXY(e);
  pt.x = px; pt.y = py;
  if (pinch) {
    if (touchPoints.size >= 2) {
      const [a, b] = [...touchPoints.values()];
      setZoom(pinchZoom(pinch.zoom0, pinch.d0, pointerDist(a.x, a.y, b.x, b.y), ZOOM_MIN, ZOOM_MAX));
    }
    return;
  }
  if (e.pointerId !== gesturePointerId) return;
  const r = touchGesture.move(px, py);
  if (r.mode === 'pan') {
    // 单指拖动 = 平移滚动（跟手）：内容随指尖移动
    scrollY -= r.dy;
    clampScroll();
    needRender = true;
    const now = performance.now();
    const dt = Math.max(1, now - lastPanTime);
    lastPanTime = now;
    panVelocity = 0.8 * panVelocity + 0.2 * (r.dy * 16.7 / dt); // 速度低通（设备 px/帧）
  } else if (r.mode === 'select') {
    rd.setSel(posAtDevice(px, py), true); // 长按后继续拖动 = 调整选区
    viewChanged();
  }
}
// 触屏 tap：与桌面单击同语义（toc 跳转 / 任务勾选 / 定位光标并取焦弹软键盘）
function onTouchTap(e: PointerEvent) {
  const { px, py } = eventXY(e);
  const tocHit = tocLineHit(cached, py + scrollY);
  if (tocHit >= 0) { rd.setSel({ block: tocHit, offset: 0 }); afterNav('after'); return; }
  const taskHit = taskCheckboxHit(cached, rd.doc, resolver, layoutPadL, dpr * zoom, px, py + scrollY);
  if (taskHit >= 0) { rd.toggleTaskChecked(taskHit); afterEdit(); return; }
  ime.focus({ preventScroll: true });
  rd.setSel(posAtDevice(px, py));
  goalX = null;
  viewChanged();
}
function onTouchUp(e: PointerEvent) {
  touchPoints.delete(e.pointerId);
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* 未捕获时忽略 */ }
  if (pinch) { if (touchPoints.size < 2) pinch = null; return; }
  if (e.pointerId !== gesturePointerId) return;
  gesturePointerId = -1;
  const mode = touchGesture.up();
  if (mode === 'pending') onTouchTap(e);                       // 快速点按
  else if (mode === 'pan') startInertia(panVelocity);          // 平移松手 → 惯性
  else if (mode === 'select') showContextMenu(e.clientX, e.clientY); // 长按选词/调整 → 松手弹菜单
}

// —— 选区内按下不摧毁选区 + 拖拽移动文本最小版（批E P3-6，mouse/pen）——
// pending：pointerup 无移动才折叠到按下处；拖动 ≥ DRAG_TEXT_MIN_PX 进入拖文本模式
// （落点显示 caret 指示线，松手把选区文本移到落点，单次 undo —— rd.moveSelTo）。
let pendingSelDown: { pos: Pos; x: number; y: number } | null = null;
let dragTextActive = false;
let dropPos: Pos | null = null;
const dragCaretEl = document.createElement('div');
dragCaretEl.style.cssText = 'position:absolute;width:2px;background:var(--rte-accent);display:none;pointer-events:none;z-index:30';
editorEl.appendChild(dragCaretEl);
function syncDragCaret() {
  const c = dropPos && cached ? caretAt(cached, dropPos, caretAffinity) : null;
  if (!c) { dragCaretEl.style.display = 'none'; return; }
  dragCaretEl.style.left = (c.x / dpr) + 'px';
  dragCaretEl.style.top = ((c.top - scrollY) / dpr) + 'px';
  dragCaretEl.style.height = ((c.bottom - c.top) / dpr) + 'px';
  dragCaretEl.style.display = '';
}
function resetDragText() {
  pendingSelDown = null;
  dragTextActive = false;
  dropPos = null;
  dragCaretEl.style.display = 'none';
}

canvas.addEventListener('pointerdown', (e) => {
  lastPointerType = e.pointerType;
  stopInertia(); // 任何新按下截停惯性续滚（含混合设备上的鼠标/笔）
  // 触屏分流（批E P0-3）：touch 不立即定位光标/拖选区，先进手势判型（平移/长按/点按）
  if (e.pointerType === 'touch') { onTouchDown(e); return; }
  ime.focus({ preventScroll: true });
  const { px, py } = eventXY(e);
  if (overScrollbar(px)) { scrollDrag = { startY: py, startScroll: scrollY }; canvas.setPointerCapture(e.pointerId); return; }
  // 点击目录(toc)标题行 → 光标跳到目标 heading 块首并滚入视口（不进入选区拖拽）
  const tocHit = tocLineHit(cached, py + scrollY);
  if (tocHit >= 0) { rd.setSel({ block: tocHit, offset: 0 }); afterNav('after'); canvas.setPointerCapture(e.pointerId); return; }
  // 点击任务项 checkbox 标记栏 → 切换勾选态（不进入选区拖拽）
  const taskHit = taskCheckboxHit(cached, rd.doc, resolver, layoutPadL, dpr * zoom, px, py + scrollY);
  if (taskHit >= 0) { rd.toggleTaskChecked(taskHit); afterEdit(); canvas.setPointerCapture(e.pointerId); return; }
  const pos = posFromEvent(e);
  // ⌘/Ctrl + 点击链接 → 新标签打开（普通点击仍只定位光标，便于编辑）；仅放行 http/https/mailto，防 javascript: 注入
  if (e.metaKey || e.ctrlKey) {
    const href = rd.linkHrefAt(pos);
    if (href && /^(https?:|mailto:)/i.test(href.trim())) {
      window.open(href.trim(), '_blank', 'noopener,noreferrer');
      canvas.setPointerCapture(e.pointerId); return;
    }
  }
  // 非主键（右键/中键）不进拖选/pending 路径：选区内按下保持选区不动（交给 contextmenu——
  // 否则其 pointerup 走 pendingSelDown 折叠分支，右键菜单「剪切/复制」构建时可用、点击时已无选区）；
  // 选区外保持「移动光标」语义后即返回，不置 dragging/pendingSelDown。
  if (e.button !== 0) {
    if (!posWithinSelection(pos)) { rd.setSel(pos); viewChanged(); }
    return;
  }
  // 选区内按下（批E P3-6）：不立即重设选区，pending 等待 up 折叠 / 拖动进入拖文本
  if (!e.shiftKey && posWithinSelection(pos)) {
    pendingSelDown = { pos, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  rd.setSel(pos, e.shiftKey);
  dragging = true; goalX = null;
  canvas.setPointerCapture(e.pointerId);
  viewChanged();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') { onTouchMove(e); return; }
  if (scrollDrag) { scrollY = scrollDrag.startScroll + (eventXY(e).py - scrollDrag.startY) * (docPixelHeight() / canvas.height); clampScroll(); return; }
  if (pendingSelDown) {
    if (!dragTextActive && exceedsThreshold(e.clientX - pendingSelDown.x, e.clientY - pendingSelDown.y, DRAG_TEXT_MIN_PX)) dragTextActive = true;
    if (dragTextActive) { dropPos = posFromEvent(e); syncDragCaret(); }
    return;
  }
  if (dragging) { rd.setSel(posFromEvent(e), true); viewChanged(); }
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') { onTouchUp(e); return; }
  if (pendingSelDown) {
    const clickPos = pendingSelDown.pos;
    const commitDrop = dragTextActive ? dropPos : null;
    resetDragText();
    if (commitDrop) {
      if (rd.moveSelTo(commitDrop)) afterEdit(); else viewChanged(); // 落点在选区内/原子块 → 不动作
    } else {
      rd.setSel(clickPos); // 无移动 → 折叠到按下处
      viewChanged();
    }
  }
  dragging = false; scrollDrag = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
});
// pointercancel（系统手势接管/来电/掌缘误触）：与 pointerup 同路复位全部拖拽态（修 P2 状态泄漏）
canvas.addEventListener('pointercancel', (e) => {
  touchPoints.delete(e.pointerId);
  if (touchPoints.size < 2) pinch = null;
  if (e.pointerId === gesturePointerId) { gesturePointerId = -1; touchGesture.cancel(); }
  dragging = false;
  scrollDrag = null;
  resetDragText();
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
});
// 阻止画布在 mousedown 时夺走 ime 焦点（否则点击后键盘方向键失效）；
// 双击选词 / 三击选段（批E P1-2）：用 mousedown 的 detail 连击计数（pointerdown 按规范 detail 恒 0）。
canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  if (lastPointerType === 'touch') return; // 触屏 tap 合成的 mouse 事件：手势路径已处理
  if (e.detail !== 2 && e.detail !== 3) return;
  const pos = posFromEvent(e);
  if (e.detail === 2) selectWordAt(pos); // 双击 = 选词
  else { rd.setSel({ block: pos.block, offset: 0 }); rd.setSel({ block: pos.block, offset: rd.blockLen(pos.block) }, true); } // 三击 = 选段（块）
  // 多击已消费本次按下：撤销 pointerdown 设下的拖选/待折叠状态，保住词/段选区
  pendingSelDown = null;
  dragging = false;
  goalX = null;
  viewChanged();
});

// —— 触屏选区手柄（批E P1-2）：非折叠选区 + 触屏交互时显示两个圆头手柄（44px 命中区）——
const selHandles = createSelectionHandles(editorEl, {
  posAtClient: (cx, cy) => {
    const rect = canvas.getBoundingClientRect();
    return posAtDevice((cx - rect.left) * dpr, (cy - rect.top) * dpr);
  },
  onDrag: (anchorPos, focusPos) => {
    rd.setSel(anchorPos);
    rd.setSel(focusPos, true);
    followCaret = true;
    viewChanged();
  },
});
// 渲染帧手柄几何（CSS px，editor 容器系）：选区首取 'after'、尾取 'before' 贴软换行正确行
function selectionHandleState(L: DocLayout): SelectionHandleState {
  const { from, to } = rd.range();
  const visible = (lastPointerType === 'touch' && !rd.isCollapsed && !tableFocused) || selHandles.dragging();
  if (!visible) return { visible: false, start: null, end: null, startPos: from, endPos: to };
  const cf = caretAt(L, from, 'after');
  const ct = caretAt(L, to, 'before');
  return {
    visible,
    start: cf ? { x: cf.x / dpr, top: (cf.top - scrollY) / dpr, bottom: (cf.bottom - scrollY) / dpr } : null,
    end: ct ? { x: ct.x / dpr, top: (ct.top - scrollY) / dpr, bottom: (ct.bottom - scrollY) / dpr } : null,
    startPos: from,
    endPos: to,
  };
}

// 滚轮滚动；ctrl+wheel（Mac 触控板捏合 / Ctrl+滚轮）= 功能性缩放（批E P1-4 桌面侧）
editorEl.addEventListener('wheel', (e) => {
  if (e.ctrlKey) { setZoom(zoom - e.deltaY * 0.01); e.preventDefault(); return; }
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= WHEEL_LINE_PX; else if (e.deltaMode === 2) d *= canvas.clientHeight;
  scrollY += d * dpr; clampScroll(); e.preventDefault();
}, { passive: false });

// 右键菜单
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Android 触屏长按合成的 contextmenu：触屏路径在 pointerup 弹菜单（见 onTouchUp），此处只压默认菜单防双弹
  if (lastPointerType === 'touch') return;
  ime.focus({ preventScroll: true });
  const pos = posFromEvent(e);
  if (rd.isCollapsed) rd.setSel(pos);                                  // 无选区 → 光标移到点击处
  else { const { from, to } = rd.range(); if (comparePos(pos, from) < 0 || comparePos(pos, to) > 0) rd.setSel(pos); } // 选区外 → 移动
  viewChanged();
  showContextMenu(e.clientX, e.clientY);
});

// —— 拖拽图片到编辑器：落点定位光标后以 data URL 插入 ——
editorEl.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
});
editorEl.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  e.preventDefault();
  try { rd.setSel(posFromEvent(e)); } catch { /* 落点解析失败则用当前光标 */ }
  const reader = new FileReader();
  reader.onload = () => { rd.insertImage(String(reader.result)); afterEdit(); ariaTree.announce('已插入图片'); };
  reader.readAsDataURL(file);
});

// —— 行首/行尾、上下移动（用布局行 + goalX）——
function lineOfCaret() {
  return cached ? caretLine(cached, rd.focus, caretAffinity) : null;
}
function moveVertical(dir: number, extend: boolean) {
  if (!cached) return;
  const c = caretAt(cached, rd.focus, caretAffinity); if (!c) return;
  if (goalX == null) goalX = c.x;
  const targetY = dir < 0 ? c.top - 1 : c.bottom + 1;
  const pos = hitTestDoc(cached, goalX, targetY);
  caretAffinity = affinityAt(cached, pos, nearestLine(cached, targetY));
  rd.setSel(pos, extend);
  viewChanged();
}

// —— 键盘 ——
// ⌥/⌘ 修饰的导航/删除键集合：keydown 对这些键先查 keymap 命令表（修复：旧 switch 在修饰键
// 检查前无条件拦截，⌥←/→ 词跳转、⌘←/→ 行首尾、⌥⌫/⌥Del 删词、⌘⌫ 删至行首全部退化单字符）。
const MOD_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']);
ime.addEventListener('keydown', (e) => {
  if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return; // IME 组合期间把按键交还输入法
  const meta = e.metaKey || e.ctrlKey;
  const ext = e.shiftKey;
  // 修饰键导航/删除：先查命令表派发（⇧ 扩展选区经 arg='extend' 传给 nav.*）；
  // 未注册组合（如 ⌘↑）落回下方 switch，保持既有行为。
  if ((e.altKey || meta) && MOD_NAV_KEYS.has(e.key)) {
    const navCmd = keymap[keyCombo(e)];
    if (navCmd) { dispatch(navCmd, ext ? 'extend' : null); e.preventDefault(); return; }
  }
  // 导航
  switch (e.key) {
    case 'ArrowLeft': rd.setSel(rd.posLeft(rd.focus), ext); afterNav('before'); e.preventDefault(); return;
    case 'ArrowRight': rd.setSel(rd.posRight(rd.focus), ext); afterNav('after'); e.preventDefault(); return;
    case 'ArrowUp': moveVertical(-1, ext); e.preventDefault(); return;
    case 'ArrowDown': moveVertical(1, ext); e.preventDefault(); return;
    case 'Home': { const ln = lineOfCaret(); if (ln) rd.setSel({ block: ln.block, offset: ln.startOffset }, ext); afterNav('after'); e.preventDefault(); return; }
    case 'End': { const ln = lineOfCaret(); if (ln) rd.setSel({ block: ln.block, offset: ln.endOffset }, ext); afterNav('before'); e.preventDefault(); return; }
    case 'Backspace': if (isFocusAtom()) rd.deleteBlock(rd.focus.block); else rd.backspace(); afterEdit(); e.preventDefault(); return;
    case 'Delete': if (isFocusAtom()) rd.deleteBlock(rd.focus.block); else rd.del(); afterEdit(); e.preventDefault(); return;
    case 'Enter': rd.enter(); afterEdit(); e.preventDefault(); return;
    case 'Tab':
      // 焦点在列表/任务项：Tab/Shift+Tab → 嵌套加深/减一级（否则放行给浏览器/焦点移动）
      if (rd.focusIsList()) { if (e.shiftKey) rd.outdentList(); else rd.indentList(); afterEdit(); e.preventDefault(); }
      return;
    case 'PageUp': scrollY -= canvas.height * PAGE_SCROLL_RATIO; clampScroll(); e.preventDefault(); return;
    case 'PageDown': scrollY += canvas.height * PAGE_SCROLL_RATIO; clampScroll(); e.preventDefault(); return;
    case 'F2': toggleShaper(); e.preventDefault(); return;
    case 'Escape': if (findBar.isOpen()) { findBar.close(); e.preventDefault(); } return; // 焦点在编辑器时也可 Esc 关查找条
  }
  if (!meta) return;
  // 功能性缩放 mod+= / mod+- / mod+0（preventDefault 压掉浏览器默认页面缩放；alt 组合留给块类型命令）
  if (!e.altKey && (e.key === '=' || e.key === '+')) { setZoom(zoom + ZOOM_STEP); e.preventDefault(); return; }
  if (!e.altKey && e.key === '-') { setZoom(zoom - ZOOM_STEP); e.preventDefault(); return; }
  if (!e.altKey && e.key === '0') { setZoom(1); e.preventDefault(); return; }
  if (e.key.toLowerCase() === 'k') { dispatch('link.toggle'); e.preventDefault(); return; } // 链接需弹窗（自收尾命令）
  // 复制/剪切/粘贴(mod+c/x/v)不在 keymap → 放行给 ime 的 clipboard 事件
  const cmd = keymap[keyCombo(e)];
  if (cmd) { dispatch(cmd); e.preventDefault(); return; }
});

// 文本输入（非 IME 路径）。组合期间的 input 一律忽略（isComposing 标志 + rd.isComposing 双保险），
// 避免与 composition 事件双插；组合提交文本由 compositionend 收尾（含 ime.value 兜底冲洗）。
ime.addEventListener('input', (e) => {
  const ie = e as InputEvent;
  if (ie.isComposing || rd.isComposing) return;
  const t = ime.value;
  ime.value = '';
  if (t) { rd.insertText(t); afterEdit(); }
});

// —— IME 组合中间态（compositionstart/update/end）——
// 组合串经 RichDoc transient 通道临时入文档参与布局渲染（带下划线 mark 走 decorations 管线），
// update 不进撤销栈；end 收尾为单次可撤销提交并冲洗 ime.value——Safari/Firefox 与 Chrome 的
// input/compositionend 次序差异下，提交文本不再滞留 textarea 至下次按键。
ime.addEventListener('compositionstart', () => { rd.beginComposition(); afterEdit(); });
ime.addEventListener('compositionupdate', (e) => { rd.updateComposition(e.data ?? ''); afterEdit(); });
ime.addEventListener('compositionend', (e) => {
  rd.endComposition(e.data ?? '');
  ime.value = ''; // 兜底冲洗：组合提交串只经上行落文档，不让浏览器把它留在隐藏 textarea
  afterEdit();
});

// —— 剪贴板（独立模块）——
const clip = setupClipboard(ime, rd, afterEdit);

// —— 右键菜单内容 ——
function showContextMenu(clientX: number, clientY: number) {
  const sel = !rd.isCollapsed;
  // 右键 mark 项亦经统一命令总线（dispatch）：与键盘/工具栏同路收尾，active 态读模型。
  const mark = (label: string, type: MarkType, cmd: string, key?: string): MenuItem =>
    ({ label, key, active: rd.markActive(type), action: () => dispatch(cmd) });
  const items: MenuItem[] = [
    { label: '剪切', key: '⌘X', disabled: !sel, action: () => clip.cut() },
    { label: '复制', key: '⌘C', disabled: !sel, action: () => clip.copy() },
    { label: '粘贴', key: '⌘V', action: () => clip.paste() },
    { separator: true },
    mark('粗体', 'bold', 'mark.bold', '⌘B'), mark('斜体', 'italic', 'mark.italic', '⌘I'), mark('下划线', 'underline', 'mark.underline', '⌘U'), mark('删除线', 'strikethrough', 'mark.strikethrough'), mark('高亮', 'highlight', 'mark.highlight'),
    { label: rd.markActive('link') ? '移除链接' : '插入链接…', key: '⌘K', active: rd.markActive('link'), action: () => dispatch('link.toggle') },
    { separator: true },
    { label: '全选', key: '⌘A', action: () => dispatch('select.all') },
    { label: '导出…', action: () => dispatch('doc.export') },
  ];
  ctxMenu.show(clientX, clientY, items);
}

// —— 链接弹层（应用内弹层，不使用原生 prompt；keydown/右键/工具栏三处共用，留装配层）——
async function doToggleLink() {
  if (rd.markActive('link')) { rd.clearMark('link'); afterEdit(); return; }
  const url = await promptDialog.ask({ title: '插入链接', value: 'https://', placeholder: 'https://example.com' });
  if (url) {
    // 危险协议（javascript: 等）拒绝写入，提示用户而非静默失败
    const safe = sanitizeLinkHref(url);
    if (safe) { rd.setMark('link', { href: safe }); afterEdit(); }
    else ariaTree.announce('链接已拒绝：不支持的协议');
  }
  ime.focus({ preventScroll: true });
}

// —— 模板：内置 + 用户（localStorage）合并列表 ——
function allTemplates(): DocTemplate[] {
  return [...BUILTIN_TEMPLATES, ...loadUserTemplates().map(userTemplateToDocTemplate)];
}
function applyTemplate(name: string) {
  const tpl = allTemplates().find((t) => t.name === name);
  if (!tpl) return;
  rd.replaceDoc(tpl.build());
  afterEdit();
  ariaTree.announce(`已应用模板：${name}`);
  ime.focus({ preventScroll: true });
}
function toggleShaper() {
  if (!hbShaper) return;
  activeShaper = activeShaper === canvasShaper ? hbShaper : canvasShaper;
  viewModeChanged();
}
/**
 * 在亮 / 暗主题间一键切换：
 * 1) {@link applyCanvasTheme} 原地改写 canvas 调色板 C（文本/选区/光标/代码块底等）；
 * 2) 设 `documentElement.dataset.theme` → index.html 的 `html[data-theme="dark"]` 接管 `--rte-*`，
 *    令工具栏/面板/弹层/原子块覆盖层（图片/公式/表格 — 其 CSS 全用 `--rte-*`）一并换肤；
 * 3) {@link viewModeChanged}（emit view:changed）触发重排（块主题重读 C.*）+ 重绘（clear color = C.bg），canvas 即以新色呈现。
 */
function toggleTheme() {
  const next: ThemeName = activeTheme() === 'dark' ? 'light' : 'dark';
  applyCanvasTheme(next);
  document.documentElement.dataset.theme = next;
  viewModeChanged();
}
/**
 * 同步工具栏可视态：构建状态快照（ui/toolbar-state），与上次快照等价则跳过 refresh ——
 * 脏检查令每键入/拖动帧不再全量回填 70+ 控件 DOM（audit 性能点）。
 */
let lastToolbarState: ToolbarState | null = null;
function syncToolbar() {
  if (!toolbar) return;
  const state = buildToolbarState(rd, resolver, {
    shaperShort: activeShaper === canvasShaper ? 'Canvas' : (hbShaper ? 'HarfBuzz' : '加载中'),
    theme: activeTheme(),
    viewMode,
  });
  if (lastToolbarState && isToolbarStateEqual(lastToolbarState, state)) return;
  lastToolbarState = state;
  toolbar.refresh(state);
}
const outputPanel = createOutputPanel(() => ime.focus({ preventScroll: true }));
const ctxMenu = createContextMenu();
const promptDialog = createPromptDialog();
const imageDialog = createImageDialog();
const signatureDialog = createSignatureDialog();
// 原子块弹层族（插入/再编辑）：依赖注入组装（ui/atom-dialogs），main 只接线。
const atomDialogs = createAtomDialogs({
  rd, promptDialog, imageDialog, signatureDialog, afterEdit,
  announce: (msg) => ariaTree.announce(msg),
  focusEditor: () => ime.focus({ preventScroll: true }),
});

// —— 统一命令总线（抽象①）：键盘 keymap / 工具栏 item / 右键菜单三路共用的命令上下文 ——
// 命令实现在 editor/commands；装配层在此构造 ctx（rd + 弹层/视图最小注入面）并经 dispatch 收尾。
const focusEditor = (): void => ime.focus({ preventScroll: true });
/** 命令执行上下文：模型 + 弹层（dialogs）/ 视图（view）服务。三路派发共用，自收尾命令的实现内含 afterEdit。 */
const commandCtx: CommandContext = {
  rd, afterEdit, announce: (msg) => ariaTree.announce(msg), focusEditor,
  exec: (id, arg) => dispatch(id, arg),
  dialogs: {
    toggleLink: doToggleLink,
    insertImage: atomDialogs.insertImage,
    insertInlineImage: atomDialogs.insertInlineImage,
    insertFormula: atomDialogs.insertFormula,
    insertTable: atomDialogs.insertTable,
    insertMedia: (kind) => atomDialogs.insertMedia(kind),
    insertAttachment: atomDialogs.insertAttachment,
    insertSignature: atomDialogs.insertSignature,
    insertSeal: atomDialogs.insertSeal,
    insertTextbox: atomDialogs.insertTextbox,
    saveTemplate: atomDialogs.saveTemplate,
    importDoc: atomDialogs.importDoc,
  },
  view: {
    toggleShaper, toggleTheme, setViewMode,
    exportDoc: () => outputPanel.open(rd.doc),
    applyTemplate,
    templateNames: () => allTemplates().map((t) => t.name),
    // 行首尾导航/删至行首消费的视觉行（lineOfCaret 已含 caretAffinity 消歧）
    caretLineBounds: () => {
      const ln = lineOfCaret();
      return ln ? { block: ln.block, startOffset: ln.startOffset, endOffset: ln.endOffset } : null;
    },
    // 查找条：选区为单块文本时预填查询
    openFind: () => {
      const { from, to } = rd.range();
      findBar.open(!rd.isCollapsed && from.block === to.block ? rd.selectedText() : undefined);
    },
    // 打印/导出 PDF：toHtml 全文 + 打印 CSS 进隐藏 iframe，系统对话框可存 PDF（ui/print）。
    printDoc: () => printDoc(rd.doc, document.title),
  },
};
/**
 * 三路统一派发接缝：执行命名命令后按命令类别收尾——
 * 导航命令（NAV_AFFINITY 命中）走 afterNav(affinity)（光标跟随 + 重绘，不重排）；
 * 只读视图命令（VIEW_ONLY：find.open/doc.print）不追加任何收尾——追加 afterEdit 会
 * 标脏自动保存（⌘F/⌘P 闪「未保存」并重写草稿）、多余整文档重排、视口跳回光标行；
 * 其余「非自收尾」命令追加一次 afterEdit（goalX 复位 + 跟随 + 重排/广播）；
 * 自收尾命令（弹层/视图/insert.toc/insert.shape）其实现内部已收尾，故跳过避免双重排/双播报。
 */
function dispatch(id: string, arg?: CommandArg): void {
  commands[id](commandCtx, arg);
  const aff = NAV_AFFINITY[id];
  if (aff) { afterNav(aff); return; }
  if (VIEW_ONLY.has(id)) return;
  if (!SELF_FINALIZING.has(id)) afterEdit();
}

toolbar = createToolbar(mustEl('toolbar'), {
  exec: (id, arg) => dispatch(id, arg as CommandArg),
  focusEditor,
  templateNames: () => allTemplates().map((t) => t.name),
});

// —— 面板装配（左大纲 / 状态栏；纯 UI 外壳，不改 model/doc-layout）——
// jumpToBlock：光标跳到目标 heading 块首并滚入视口（复用 afterNav 的 followCaret 机制）。
function jumpToBlock(blockIndex: number) {
  if (blockIndex < 0 || blockIndex >= rd.blockCount) return;
  rd.setSel({ block: blockIndex, offset: 0 });
  afterNav('after');
  ime.focus({ preventScroll: true });
}
const outline: Outline = createOutline(mustEl('left-body'), { onJump: jumpToBlock });
// 状态栏：缩放区可交互（− / 百分比回 100% / ＋，步进 10%），回调收敛到 setZoom。
const statusBar: StatusBar = createStatusBar(mustEl('status-bar'), {
  onZoomDelta: (deltaPct) => setZoom(zoom + deltaPct / 100),
  onZoomReset: () => setZoom(1),
});
// —— 查找/替换浮条（ui/find-bar）：命中列表供渲染帧画 canvas 高亮；
// 跳转走 afterNav（重绘不重排）、替换走 afterEdit；命中集变化置 needRender 重绘。——
const findBar = createFindBar(editorEl, {
  rd,
  afterNav: () => afterNav('after'),
  afterEdit,
  focusEditor,
  onMatchesChanged: () => { needRender = true; },
  printDoc: () => dispatch('doc.print'), // 浮条内 ⌘P 与编辑器同路（VIEW_ONLY 收尾）
});

/** 刷新所有面板（编辑/导入/模板替换后调用）。纯读 rd.doc，不触发重排。 */
function syncPanels() {
  outline.update(rd.doc);
  statusBar.update(rd.doc, zoom * 100, viewMode === 'word' ? '页面' : '网页');
}

// —— 文档自动保存（model/persistence）：doc:changed 防抖 ~800ms 落盘 localStorage 草稿，
// 状态栏显示 已保存/未保存；写入失败（配额）由 saveDraft 降级跳过（warn），脏标记保留待重试。
const autosaver = createAutosaver(
  // IME 组合中间态免疫：组合期间 persist 返回 false（保持脏标记不落盘）——未提交拼音串
  // 带临时 underline mark 的 transient 文本一旦写入草稿，恢复后会成为带下划线的正式正文
  //（sanitizeStoredBlocks 视 underline 为合法 mark 不会过滤）。覆盖两条写入路径：
  // 防抖计时器在组合中触发、beforeunload 的 flush。endComposition 的 afterEdit 会再次
  // schedule，提交后的保存不丢。
  () => !rd.isComposing && saveDraft(rd.doc, rd.anchor, rd.focus),
  (dirtyDraft) => statusBar.setSaveState(!dirtyDraft),
);
// 卸载防护：localStorage 写入是同步的，先尝试立即落盘——成功则无丢失、不打扰；
// 仍有未保存变更（写入失败/配额/IME 组合中——persist 对组合中间态返回 false）才拦截，
// 弹浏览器原生「确定离开？」确认框。
window.addEventListener('beforeunload', (e) => {
  if (!autosaver.dirty) return;
  if (autosaver.flush()) return;
  e.preventDefault();
  e.returnValue = ''; // 旧版 Chrome 协议：需设置 returnValue 才弹确认框
});

/**
 * 注册事件总线订阅（抽象③）。订阅矩阵（回调内自读 rd/zoom/viewMode 当前态）：
 * - `doc:changed`：dirty 重排 + resetBlink + 工具栏回填（脏检查）+ ARIA 镜像 + 面板（大纲/状态栏）——
 *   即旧 markDirty 五件事（含旧 onContentChanged=syncPanels）；编辑/导入/模板替换/表格文本框直改后触发。
 * - `selection:changed`：resetBlink + 工具栏回填，不重排、不更 ARIA/面板（= 旧 viewChanged）；选区/导航后触发。
 * - `view:changed`：与 doc:changed 同套（dirty 重排 + 重绘换色/分页 + 工具栏 viewMode/theme/shaper 回填 +
 *   状态栏视图名/缩放 + ARIA 镜像）；缩放/视图模式/整形器/主题切换后触发。三者均经 syncToolbar 的
 *   lastToolbarState 脏检查，避免每帧全量刷控件（性能 parity）。
 */
function subscribeBus() {
  const onDoc = () => { dirty = true; resetBlink(); syncToolbar(); ariaTree.update(rd.doc); syncPanels(); };
  bus.on('doc:changed', onDoc);
  // 自动保存：仅内容变更触发（视图/选区不标脏）；IME 组合中间态不标脏不闪「未保存」
  //（compositionstart/update 也走 afterEdit→doc:changed），提交由 endComposition 的 afterEdit 再 schedule。
  bus.on('doc:changed', () => { if (!rd.isComposing) autosaver.schedule(); });
  bus.on('doc:changed', () => findBar.refresh());    // 查找条打开时：编辑/替换后重算命中（不移动选区）
  bus.on('selection:changed', () => { resetBlink(); syncToolbar(); });
  bus.on('view:changed', onDoc); // 视图切换与内容变化收尾同套（含 dirty/ariaTree/面板），保零行为变化
}

// 折叠按钮接线（toggle .collapsed；折叠后 ResizeObserver 会同步 canvas 尺寸）。
const leftPanel = mustEl('left-panel');
mustEl('left-collapse').addEventListener('click', () => leftPanel.classList.toggle('collapsed'));

async function start() {
  subscribeBus(); // 先注册总线订阅（早于首帧与 HarfBuzz 异步回调，确保后续 emit 均有订阅者）
  renderer = await createRenderer(canvas);
  watchRendererLost(); // WebGPU 设备丢失 → 重建渲染器（WebGL2 走 canvas 事件对）
  resize();
  editorResizeObserver.observe(editorEl);
  ime.focus({ preventScroll: true });
  requestAnimationFrame(frame);
  syncToolbar();
  syncPanels();
  try {
    hbShaper = await HarfBuzzShaper.create(atlas, appliedScale); // 与图集共用有效渲染比例（dpr×zoom）
    if (DEFAULT_SHAPER === 'harfbuzz') activeShaper = hbShaper;
    markDirty();
    console.log('[shaper] HarfBuzz 就绪');
  } catch (err) {
    console.warn('[shaper] HarfBuzz 加载失败，保持 Canvas：', err);
    syncToolbar();
  }
}
start();
