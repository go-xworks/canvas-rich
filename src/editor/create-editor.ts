/**
 * 编辑器工厂（editor/ui 装配层）：`createEditor(target, options)` 在 target 容器内程序化构建外壳、
 * 组装文档模型/整形器/布局/渲染循环，接线输入(键鼠/IME/剪贴板)与 UI(工具栏/菜单/弹层/覆盖层/面板)，
 * 驱动 requestAnimationFrame 主循环，返回命令式实例句柄 {@link EditorInstance}。
 *
 * @remarks
 * 库化（对标 CM6 EditorView / PM EditorView）：旧 src/main.ts 的模块级单体（写死 index.html 外壳 +
 * 模块级可变单例 + 一次性装配）整体迁入本工厂闭包——所有可变状态进闭包，同页多实例互不串扰；
 * 无状态注册表（commands/keymap/SELF_FINALIZING/NAV_AFFINITY/VIEW_ONLY/纯函数/版面常量）保模块级 import。
 * 外壳 DOM 由 editor/editor-shell 程序化构建（替代 mustEl(id) 全局抓取）。
 *
 * 已知多实例局限（model/palette.ts 的 C 是模块级可变全局，applyCanvasTheme 原地改写）：
 * **主题进程级共享**——同页多实例无法各自独立主题，setTheme 影响全页所有实例（最后调用胜出）。
 * 真正修复需把 C 改 per-instance 注入（独立重构），本批不做。见 setTheme/toggleTheme 处标注。
 *
 * 清理（destroy）现状：RAF/所有 window·document·canvas·ime·editorEl 监听(AbortController)/ResizeObserver/
 * 草稿防抖(autosaver.flush 已清计时器)/beforeunload/外壳 DOM(含覆盖层·dropLine·dragCaretEl·canvas·ime)
 * 均已清理。body/head 级门户（context-menu/output-panel/dialogs/aria 镜像 + overlays·aria 的 head <style>）
 * 与其 document 级监听亦经各 UI 工厂的 destroy() 一并回收（见 instance.destroy），反复 mount/unmount 不累积。
 * 仅 tooltip 层是页面级单例（installTooltips 的 installed 守卫，一页装一次、跨实例共享），不计 per-instance 回收。
 *
 * 分层：本文件是 composition root（装配根），按 CONVENTIONS §6「装配层例外」获准 import `ui/`
 * 聚合工具栏/弹层/覆盖层/面板成实例——这是唯一被许可的向上依赖，仅限本文件与 editor-shell.ts；
 * editor/ 其余模块仍受单向规则约束（不 import ui/，装配面经 CommandContext 注入）。仅装配，业务下沉。
 */
import '../styles/lib.css'; // 库样式入口（shell 外壳 + chrome 用到的 tailwind utility；cssCodeSplit:false 合并为 style.css，sideEffects 保不被 tree-shake）
import { GlyphAtlas } from '../text/glyph-atlas';
import { createRenderer } from '../render/create-renderer';
import type { Renderer } from '../render/renderer';
import { Quad } from '../render/renderer';
import { Shaper } from '../text/shaper';
import { CanvasShaper } from '../text/canvas-shaper';
import { HarfBuzzShaper } from '../text/harfbuzz-shaper';
import { MarkType, isAtomBlock, Doc, cloneDoc } from '../model/schema';
import { createDemoDoc } from '../model/demo-doc';
import { BUILTIN_TEMPLATES, loadUserTemplates, userTemplateToDocTemplate, DocTemplate } from '../model/templates';
import { loadDraft, saveDraft, createAutosaver } from '../model/persistence';
import { RichDoc, Pos, comparePos } from '../model/rich-document';
import { inlineAtomSrcAt } from '../model/inlines';
import { StyleResolver } from '../model/style-resolver';
import { C, applyCanvasTheme, activeTheme, ThemeName } from '../model/palette';
import { layoutDoc, caretAt, caretLine, nearestLine, hitTestDoc, selectionRects, visibleLineRange, DocLayout } from '../text/doc-layout';
import { BlockLayoutCache } from '../text/block-layout-cache';
import { paginateLayout, PageRect } from '../text/paginate';
import { clamp } from '../shared/util';
import { sanitizeLinkHref } from '../shared/url';
import { createToolbar, Toolbar, ToolbarState } from '../ui/toolbar';
import { buildToolbarState, isToolbarStateEqual } from '../ui/toolbar-state';
import { createOutputPanel } from '../ui/output-panel';
import { createContextMenu, MenuItem } from '../ui/context-menu';
import { createPromptDialog } from '../ui/prompt';
import { createImageDialog } from '../ui/image-dialog';
import { createSignatureDialog } from '../ui/signature-dialog';
import { createAtomDialogs } from '../ui/atom-dialogs';
import { createOverlayManager } from '../ui/overlays';
import { createAriaTree } from '../ui/aria';
import { createOutline, Outline } from '../ui/outline';
import { createStatusBar, StatusBar } from '../ui/status-bar';
import { commands, keymap, keyCombo, SELF_FINALIZING, NAV_AFFINITY, VIEW_ONLY, READONLY_SAFE, CommandContext, CommandArg } from './commands';
import { TouchGesture, pointerDist, pinchZoom, visibleCanvasHeightDev, decayVelocity, exceedsThreshold, DRAG_TEXT_MIN_PX } from './touch';
import { wordRangeAt } from '../model/word-boundary';
import { createSelectionHandles, SelectionHandleState } from '../ui/selection-handles';
import { createFindBar } from '../ui/find-bar';
import { printDoc } from '../ui/print';
import { createEmitter, EditorEvent, Unsub } from './events';
import { setupClipboard } from './clipboard';
import { affinityAt, gapAtY, gapYDevice, tocLineHit, taskCheckboxHit } from './hit-testing';
import { toHtml, toMarkdown, toJson } from '../model/export';
import { parseHtml, parseMarkdown } from './import';
import { createShell } from './editor-shell';
import { normalizeEditorOptions } from './normalize-options';

// —— 公共类型（库面，由 src/index.ts re-export）——

/** 视图模式：web 连续滚动 / word A4 分页。 @public */
export type ViewMode = 'web' | 'word';
/** 整形器选择：canvas 系统字体（含 CJK，立即可用）/ harfbuzz 真整形（Roboto，Latin）。 @public */
export type ShaperKind = 'canvas' | 'harfbuzz';

/** createEditor 选项（全部可选；缺省复刻现 demo 行为）。 @public */
export interface EditorOptions {
  /** 初始文档（DocJSON）。三选一优先级：initialDoc > initialHTML > initialMarkdown；都缺省时用草稿(persistDraft)或演示样张。 */
  initialDoc?: Doc;
  /** 以 HTML 串初始化（内部经 parseHtml）。 */
  initialHTML?: string;
  /** 以 Markdown 串初始化（内部经 parseMarkdown）。 */
  initialMarkdown?: string;
  /** 初始主题（默认 'light'）。注意全局 palette 限制：主题进程级共享，多实例最后调用胜出。 */
  theme?: ThemeName;
  /** 初始视图模式（默认 'web'）。 */
  viewMode?: ViewMode;
  /** 默认整形器（默认 'canvas'；'harfbuzz' 异步就绪前回退 canvas）。 */
  shaper?: ShaperKind;
  /**
   * 只读：屏蔽一切文档变更——原始输入（键入/删除/粘贴/IME/拖放/勾选）与命令总线
   * （键盘快捷键/工具栏/右键菜单/程序化 `exec`）的变更命令（mark/block/align/history/insert/delete/template…）
   * 均拦截；保留选择/滚动/导航/缩放与只读命令（查找/打印/全选/导出）。
   * 视图/主题等编辑器操作仍可经实例方法 `setViewMode`/`setTheme` 调整（不经命令总线）。默认 false。
   */
  readOnly?: boolean;
  /** UI 外壳开关（默认全 true，复刻现 demo 整套外壳）。关掉的部件不建 DOM 不接线。 */
  chrome?: {
    /** 顶部 Ribbon 工具栏。 */ toolbar?: boolean;
    /** 左侧大纲面板（含折叠按钮）。 */ outline?: boolean;
    /** 底部状态栏（字数/缩放）。 */ statusBar?: boolean;
    /** 右键菜单。 */ contextMenu?: boolean;
    /** 查找/替换浮条。 */ findBar?: boolean;
  };
  /** localStorage 草稿自动保存/恢复（默认 true，复刻现 demo）。多实例消费者应显式置 false 避免 key 冲突。 */
  persistDraft?: boolean;
}

/** createEditor 返回的实例句柄（命令式 API + 事件，零框架依赖）。 @public */
export interface EditorInstance {
  /** 库自建外壳的根元素（供消费者样式定位）。 */
  readonly dom: HTMLElement;
  /** 派发命名命令（id 见 editor/commands 命令表；带参命令透传 arg）。等价工具栏/键盘三路总线。 */
  exec(id: string, arg?: CommandArg): void;
  /**
   * 取当前文档：返回**内部活引用**（非拷贝，故零分配）——请勿就地改写，否则破坏内部态；
   * 改文档一律走 setDoc/setHTML/setMarkdown 或 exec。需独立可改副本时消费者自行 `structuredClone`/`toJson`。
   */
  getDoc(): Doc;
  /** 整文档替换（进撤销栈，光标置文末）。 */
  setDoc(doc: Doc): void;
  /** 导出当前文档为 HTML（model/export.toHtml）。 */
  getHTML(): string;
  /** 以 HTML 串替换文档（editor/import.parseHtml → setDoc）。 */
  setHTML(html: string): void;
  /** 导出当前文档为 Markdown（model/export.toMarkdown）。 */
  getMarkdown(): string;
  /** 以 Markdown 串替换文档（editor/import.parseMarkdown → setDoc）。 */
  setMarkdown(md: string): void;
  /** 导出当前文档为 JSON 串（model/export.toJson）。与 getHTML/getMarkdown 对称。 */
  getJSON(): string;
  /** 以 JSON 串（toJson 产物）替换文档（JSON.parse → setDoc）。与 setHTML/setMarkdown 对称。 */
  setJSON(json: string): void;
  /** 订阅编辑器事件（doc:changed/selection:changed/view:changed），返回退订句柄。 */
  on(ev: EditorEvent, fn: () => void): Unsub;
  /** 退订（与 on 对称的便利别名）。 */
  off(ev: EditorEvent, fn: () => void): void;
  /** 把焦点交还编辑器（聚焦内部 IME 代理）。 */
  focus(): void;
  /** 切换视图模式（web/word）。 */
  setViewMode(m: ViewMode): void;
  /** 设置功能性缩放（0.5..2，clamp）。 */
  setZoom(z: number): void;
  /** 切换/设置主题（受全局 palette 限制：进程级共享，多实例最后调用胜出）。 */
  setTheme(name: ThemeName): void;
  /**
   * 彻底销毁：停 RAF、断所有 window/document/canvas 监听、disconnect ResizeObserver、落盘草稿、
   * 移除外壳 DOM 与 body/head 级门户（右键菜单/导出面板/弹层/ARIA 镜像/overlays·aria 样式）及其 document 监听。
   * 幂等（重复调用 no-op）。销毁后实例不可用。tooltip 为页面级单例不回收（见类头注）。
   */
  destroy(): void;
}

/**
 * 在 target 容器内建编辑器外壳并装配一个可编辑实例。
 * @param target - 宿主容器（库在其内建 toolbar/outline/editor/canvas/status-bar/ime 外壳）。
 * @param options - 可选初始化项（缺省复刻现 demo）。
 * @returns 命令式实例句柄。
 * @public
 */
export function createEditor(target: HTMLElement, options: EditorOptions = {}): EditorInstance {
  // —— 选项归一化（纯函数，node 可测，见 normalize-options）——
  const {
    showToolbar, showOutline, showStatusBar, enableContextMenu, showFindBar,
    persistDraft, readOnly, defaultShaper: DEFAULT_SHAPER,
  } = normalizeEditorOptions(options);

  // —— 装配层 UI 常量（逻辑 px / ms；使用处 ×dpr 折算设备 px）——
  const PAD = 26;
  const CARET_BLINK_PERIOD_MS = 1060;
  const CARET_BLINK_VISIBLE_MS = 600;
  const CARET_W = 2;
  const CARET_INSET = 2;
  const CARET_FOLLOW_MARGIN = 10;
  const SCROLLBAR_MIN_THUMB = 30;
  const SCROLLBAR_W = 5;
  const SCROLLBAR_RIGHT = 7;
  const SCROLLBAR_HIT_W = 14;
  const SCROLLBAR_ALPHA_ACTIVE = 0.34;
  const SCROLLBAR_ALPHA_IDLE = 0.2;
  const PAGE_SCROLL_RATIO = 0.9;
  const WHEEL_LINE_PX = 16;
  // word 视图页面几何（逻辑 px）：A4 @96dpi 794×1123，页内边距 64，页缝 24。
  const PAGE_W = 794;
  const PAGE_H = 1123;
  const PAGE_MARGIN = 64;
  const PAGE_GAP = 24;
  const PAGE_MIN_X = 8;
  const PAGE_SHADOW_W = 2;
  const PAGE_SHADOW_ALPHA = 0.18;
  const ZOOM_MIN = 0.5, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
  const MOD_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']);

  // —— 销毁/监听统一管理 ——
  // 所有 window/document/canvas/ime/editorEl 监听经 ac.signal 一次性断开（destroy 调 ac.abort()）。
  const ac = new AbortController();
  const sig = ac.signal;
  let destroyed = false;
  let rafId = 0;

  // —— 外壳 DOM：程序化构建（替代旧 index.html + mustEl(id)）——
  const shell = createShell(target, { toolbar: showToolbar, outline: showOutline, statusBar: showStatusBar });
  const canvas = shell.canvas;
  const ime = shell.ime;
  const editorEl = shell.editorEl;
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

  // —— 初始主题（option.theme；进程级全局，见类头注） ——
  if (options.theme) {
    applyCanvasTheme(options.theme);
    document.documentElement.dataset.theme = options.theme;
  }
  // —— 初始文档：优先级 initialDoc > initialHTML > initialMarkdown > 草稿(persistDraft) > 演示样张 ——
  function initialDocAndSel(): { doc: Doc; sel: { anchor: Pos; focus: Pos } | null } {
    // initialDoc 深拷贝：取得文档所有权但不就地改写消费者源对象（与实例 setDoc / RichDoc.setDoc 一致）。
    // 其余路径（parseHtml/parseMarkdown/loadDraft/createDemoDoc）已产出全新对象，无别名风险。
    if (options.initialDoc) return { doc: cloneDoc(options.initialDoc), sel: null };
    if (options.initialHTML !== undefined) return { doc: parseHtml(options.initialHTML), sel: null };
    if (options.initialMarkdown !== undefined) return { doc: parseMarkdown(options.initialMarkdown), sel: null };
    if (persistDraft) {
      const draft = loadDraft();
      if (draft) return { doc: draft.doc, sel: { anchor: draft.anchor, focus: draft.focus } };
    }
    return { doc: createDemoDoc(), sel: null };
  }
  const init = initialDocAndSel();
  const rd = new RichDoc(init.doc);
  if (init.sel) {
    rd.setSel(init.sel.anchor);          // setSel 内部 clamp：草稿选区越界时夹回合法范围
    rd.setSel(init.sel.focus, true);
  } else {
    rd.setSel(rd.docEnd());
  }

  // —— 类型化事件总线（抽象③ Observer）——
  const bus = createEmitter();

  // —— 布局缓存 ——
  let cached: DocLayout | null = null;
  let dirty = true;
  let needRender = true;
  const layoutCache = new BlockLayoutCache();
  let lineTops = new Float64Array(0);
  let lineBottoms = new Float64Array(0);
  let goalX: number | null = null;
  let caretAffinity: 'before' | 'after' = 'after';
  let scrollY = 0;
  let followCaret = false;
  let scrollDrag: { startY: number; startScroll: number } | null = null;

  // —— 视图模式与功能性缩放 ——
  let viewMode: ViewMode = options.viewMode ?? 'web';
  let zoom = 1;
  let pages: PageRect[] = [];
  let layoutPadL = PAD * dpr;
  let appliedScale = dpr;

  function applyRenderScale() {
    const s = dpr * zoom;
    if (s === appliedScale) return;
    appliedScale = s;
    atlas.setDpr(s);
    if (renderer) renderer.dropAtlasPages(1);
    hbShaper?.setDpr(s);
    dirty = true;
  }
  function setZoom(z: number) {
    const next = clamp(Math.round(z * 100) / 100, ZOOM_MIN, ZOOM_MAX);
    if (next === zoom) return;
    zoom = next;
    applyRenderScale();
    viewModeChanged();
  }
  function setViewModeInternal(m: ViewMode) {
    if (m === viewMode) return;
    viewMode = m;
    followCaret = true;
    viewModeChanged();
  }

  function relayout() {
    const scale = dpr * zoom;
    if (viewMode === 'word') {
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
    const lns = cached.lines;
    lineTops = new Float64Array(lns.length);
    lineBottoms = new Float64Array(lns.length);
    for (let i = 0; i < lns.length; i++) { lineTops[i] = lns[i].top; lineBottoms[i] = lns[i].bottom; }
    dirty = false;
  }
  function viewChanged() { bus.emit('selection:changed'); }
  function markDirty() { bus.emit('doc:changed'); }
  function viewModeChanged() { bus.emit('view:changed'); }
  function afterNav(aff: 'before' | 'after') { goalX = null; caretAffinity = aff; followCaret = true; viewChanged(); }
  function afterEdit() { goalX = null; caretAffinity = 'after'; followCaret = true; markDirty(); }

  // —— 滚动 ——
  function docPixelHeight() {
    if (!cached) return 0;
    return viewMode === 'word' ? cached.contentHeight : cached.contentHeight + 2 * PAD * dpr * zoom;
  }
  function clampScroll() { scrollY = Math.round(Math.max(0, Math.min(Math.max(0, docPixelHeight() - canvas.height), scrollY))); }
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
    const viewH = effectiveViewHeightDev();
    if (c.top - scrollY < m) scrollY = c.top - m;
    else if (c.bottom - scrollY > viewH - m) scrollY = c.bottom - viewH + m;
    clampScroll();
  }
  const onViewportShift = () => {
    if (document.activeElement !== ime || tableFocused) return;
    followCaret = true;
    needRender = true;
  };
  window.visualViewport?.addEventListener('resize', onViewportShift, { signal: sig });
  window.visualViewport?.addEventListener('scroll', onViewportShift, { signal: sig });
  function scrollbarThumb(): { x: number; y: number; w: number; h: number } | null {
    const docH = docPixelHeight();
    if (docH <= canvas.height + 1) return null;
    const trackH = canvas.height;
    const thumbH = Math.max(SCROLLBAR_MIN_THUMB * dpr, trackH * canvas.height / docH);
    const maxScroll = docH - canvas.height;
    const thumbY = maxScroll > 0 ? (scrollY / maxScroll) * (trackH - thumbH) : 0;
    return { x: canvas.width - SCROLLBAR_RIGHT * dpr, y: thumbY, w: SCROLLBAR_W * dpr, h: thumbH };
  }
  function isFocusAtom(): boolean { return rd.isCollapsed && isAtomBlock(rd.focusBlock().type); }

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    applyRenderScale();
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    renderer.resize(canvas.width, canvas.height);
    dirty = true;
  }
  window.addEventListener('resize', resize, { signal: sig });
  const editorResizeObserver = new ResizeObserver(() => { if (renderer && !destroyed) resize(); });

  let blinkStart = performance.now();
  function resetBlink() { blinkStart = performance.now(); }
  function caretVisible() { return ((performance.now() - blinkStart) % CARET_BLINK_PERIOD_MS) < CARET_BLINK_VISIBLE_MS; }

  // —— GPU 上下文丢失恢复 ——
  let rebuildingRenderer = false;
  async function rebuildRenderer(): Promise<void> {
    if (rebuildingRenderer || destroyed) return;
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
  function watchRendererLost(): void {
    renderer.lost?.then(() => { if (destroyed) return; console.warn('[renderer] GPU 设备丢失，重建渲染器'); void rebuildRenderer(); });
  }
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('[renderer] WebGL 上下文丢失'); }, { signal: sig });
  canvas.addEventListener('webglcontextrestored', () => { void rebuildRenderer(); }, { signal: sig });

  // —— 渲染循环 ——
  let lastScrollY = -1;
  let lastCaretOn: boolean | null = null;
  let lastSelSig = '';
  const quads: Quad[] = [];

  function frame() {
    if (destroyed) return; // 销毁后早退：停止主循环（rafId 已 cancel，双保险）
    if (dirty || !cached) { relayout(); needRender = true; }
    if (atlas.consumeReset()) { dirty = true; needRender = true; }
    const L = cached!;
    if (followCaret) { ensureCaretVisible(); followCaret = false; }
    clampScroll();
    const caretOn = rd.isCollapsed && caretVisible() && !tableFocused && !isFocusAtom();
    const selSig = `${rd.anchor.block}:${rd.anchor.offset}:${rd.focus.block}:${rd.focus.offset}:${scrollDrag ? 1 : 0}:${caretAffinity}`;
    if (scrollY !== lastScrollY || caretOn !== lastCaretOn || selSig !== lastSelSig) needRender = true;
    if (!needRender) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    for (const d of atlas.takeDirtyPages()) renderer.uploadAtlasPage(d.page, d.canvas, d.rect);
    const wu = atlas.whiteUV;
    quads.length = 0;
    const solid = (x: number, y: number, w: number, h: number, c: [number, number, number, number]) => {
      const x0 = Math.round(x), y0 = Math.round(y - scrollY);
      const x1 = Math.round(x + w), y1 = Math.round(y - scrollY + h);
      quads.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, u0: wu.u, v0: wu.v, u1: wu.u, v1: wu.v, r: c[0], g: c[1], b: c[2], a: c[3], page: 0 });
    };
    const solidScreen = (x: number, y: number, w: number, h: number, c: [number, number, number, number]) => {
      const x0 = Math.round(x), y0 = Math.round(y);
      const x1 = Math.round(x + w), y1 = Math.round(y + h);
      quads.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, u0: wu.u, v0: wu.v, u1: wu.u, v1: wu.v, r: c[0], g: c[1], b: c[2], a: c[3], page: 0 });
    };

    const viewBottom = scrollY + canvas.height;
    const [i0, i1] = visibleLineRange(lineTops, lineBottoms, scrollY, viewBottom);
    const yVisible = (top: number, h: number) => top + h >= scrollY && top <= viewBottom;

    const isWord = viewMode === 'word';
    if (isWord) {
      const shadow: [number, number, number, number] = [0, 0, 0, PAGE_SHADOW_ALPHA];
      const sw = PAGE_SHADOW_W * dpr;
      for (const pg of pages) {
        if (!yVisible(pg.y, pg.h + sw)) continue;
        solid(pg.x + pg.w, pg.y + sw, sw, pg.h, shadow);
        solid(pg.x + sw, pg.y + pg.h, pg.w, sw, shadow);
        solid(pg.x, pg.y, pg.w, pg.h, C.bg);
      }
    }

    for (const bg of L.backgrounds) { if (yVisible(bg.y, bg.h)) solid(bg.x, bg.y, bg.w, bg.h, bg.color); }
    for (let i = i0; i < i1; i++) {
      const ln = L.lines[i];
      for (let k = ln.hlStart ?? 0, e = ln.hlEnd ?? 0; k < e; k++) { const hl = L.highlights[k]; solid(hl.x, hl.y, hl.w, hl.h, hl.color); }
    }
    const fMatches = findBar.matches();
    if (fMatches.length) {
      const blockLo = L.lines[i0]?.block ?? 0;
      const blockHi = i1 > i0 ? L.lines[i1 - 1].block : -1;
      const fCur = findBar.currentIndex();
      for (let mi = 0; mi < fMatches.length; mi++) {
        if (mi === fCur) continue;
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
    const focusAtom = isFocusAtom();
    if (caretOn) {
      const c = caretAt(L, rd.focus, caretAffinity);
      if (c) {
        solid(c.x, c.top + CARET_INSET * dpr, Math.max(1, Math.round(CARET_W * dpr)), (c.bottom - c.top) - 2 * CARET_INSET * dpr, C.caret);
        const cr = canvas.getBoundingClientRect();
        ime.style.left = Math.round(cr.left + c.x / dpr) + 'px';
        ime.style.top = Math.round(cr.top + (c.top - scrollY) / dpr) + 'px';
      }
    }
    const th = scrollbarThumb();
    if (th) solidScreen(th.x, th.y, th.w, th.h, [1, 1, 1, scrollDrag ? SCROLLBAR_ALPHA_ACTIVE : SCROLLBAR_ALPHA_IDLE]);

    renderer.render(quads, isWord ? C.pageGap : C.bg);
    overlayMgr.sync(rd.doc, L.overlays, scrollY, L.dpr, focusAtom && !tableFocused ? rd.focus.block : -1);
    overlayMgr.syncInline(L.inlineOverlays, inlineImageSrc, scrollY, L.dpr);
    selHandles.sync(selectionHandleState(L));
    lastScrollY = scrollY; lastCaretOn = caretOn; lastSelSig = selSig;
    needRender = false;
    rafId = requestAnimationFrame(frame);
  }

  // —— 原子块覆盖层（图片 / 公式 / 表格）——
  const overlayMgr = createOverlayManager(editorEl, {
    onTableEdit: () => { if (readOnly) return; markDirty(); },
    onTextboxEdit: () => { if (readOnly) return; markDirty(); },
    onAtomEdit: (blockIndex, kind) => { if (readOnly) return; atomDialogs.editAtom(blockIndex, kind); },
    onMeasured: (blockIndex, hLogical) => { if (rd.setMeasuredHeight(blockIndex, hLogical)) dirty = true; },
    onMeasuredResize: () => { needRender = true; },
    onCellFocus: (blockIndex) => { tableFocused = true; rd.setSel({ block: blockIndex, offset: 0 }); },
    onCellBlur: () => { tableFocused = false; ime.focus({ preventScroll: true }); },
    onImageResize: (blockIndex, w, h) => { if (readOnly) return; rd.setImageSize(blockIndex, w, h); afterEdit(); },
    onBlockMove: (blockIndex, clientY, phase) => { if (readOnly) return; handleBlockMove(blockIndex, clientY, phase); },
    onColResize: (blockIndex, col, w) => { if (readOnly) return; rd.setColWidth(blockIndex, col, w); afterEdit(); },
    onRowResize: (blockIndex, row, h) => { if (readOnly) return; rd.setRowHeight(blockIndex, row, h); afterEdit(); },
    onTableMerge: (blockIndex, r0, c0, r1, c1) => { if (readOnly) return; rd.mergeCells(blockIndex, r0, c0, r1, c1); afterEdit(); },
    onTableSplit: (blockIndex, r, c) => { if (readOnly) return; rd.splitCell(blockIndex, r, c); afterEdit(); },
    onTableRowOp: (blockIndex, row, op) => {
      if (readOnly) return;
      if (op === 'delete') rd.deleteRow(blockIndex, row); else rd.insertRow(blockIndex, row, op);
      afterEdit();
    },
    onTableColOp: (blockIndex, col, op) => {
      if (readOnly) return;
      if (op === 'delete') rd.deleteCol(blockIndex, col); else rd.insertCol(blockIndex, col, op);
      afterEdit();
    },
  });

  function inlineImageSrc(box: { block: number; offset: number }): string {
    const blk = rd.doc.blocks[box.block];
    return blk ? inlineAtomSrcAt(blk.inlines, box.offset) : '';
  }

  // —— 图片拖动重排：落点指示线 + 提交 ——
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

  // —— 指针（鼠标/触控笔 + 触屏分流）——
  let dragging = false;
  let lastPointerType = 'mouse';
  function eventXY(e: PointerEvent | MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    return { px: (e.clientX - rect.left) * dpr, py: (e.clientY - rect.top) * dpr };
  }
  function posAtDevice(px: number, py: number): Pos {
    if (!cached) return { block: 0, offset: 0 };
    const cy = py + scrollY;
    const pos = hitTestDoc(cached, px, cy);
    caretAffinity = affinityAt(cached, pos, nearestLine(cached, cy));
    return pos;
  }
  function posFromEvent(e: PointerEvent | MouseEvent): Pos {
    const { px, py } = eventXY(e);
    return posAtDevice(px, py);
  }
  function overScrollbar(px: number): boolean { return !!scrollbarThumb() && px >= canvas.width - SCROLLBAR_HIT_W * dpr; }
  function posWithinSelection(pos: Pos): boolean {
    if (rd.isCollapsed) return false;
    const { from, to } = rd.range();
    return comparePos(pos, from) >= 0 && comparePos(pos, to) <= 0;
  }
  function selectWordAt(pos: Pos) {
    const r = wordRangeAt(rd.blockStr(pos.block), pos.offset);
    rd.setSel({ block: pos.block, offset: r.start });
    rd.setSel({ block: pos.block, offset: r.end }, true);
  }

  // —— 触屏手势状态 ——
  const touchPoints = new Map<number, { x: number; y: number }>();
  let pinch: { d0: number; zoom0: number } | null = null;
  let gesturePointerId = -1;
  let panVelocity = 0;
  let lastPanTime = 0;
  const touchGesture = new TouchGesture({
    onLongPress: (x, y) => {
      const pos = posAtDevice(x, y);
      if (!posWithinSelection(pos)) selectWordAt(pos);
      navigator.vibrate?.(10);
      viewChanged();
    },
  });
  let inertiaV = 0;
  let inertiaLastT = 0;
  let inertiaRunning = false;
  function stopInertia() { inertiaV = 0; }
  function inertiaStep() {
    if (destroyed || !inertiaV || touchGesture.mode !== 'idle' || pinch) { inertiaRunning = false; return; }
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
      touchGesture.cancel();
      gesturePointerId = -1;
      const [a, b] = [...touchPoints.values()];
      pinch = { d0: pointerDist(a.x, a.y, b.x, b.y), zoom0: zoom };
      return;
    }
    if (touchPoints.size > 2 || pinch) return;
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
      scrollY -= r.dy;
      clampScroll();
      needRender = true;
      const now = performance.now();
      const dt = Math.max(1, now - lastPanTime);
      lastPanTime = now;
      panVelocity = 0.8 * panVelocity + 0.2 * (r.dy * 16.7 / dt);
    } else if (r.mode === 'select') {
      rd.setSel(posAtDevice(px, py), true);
      viewChanged();
    }
  }
  function onTouchTap(e: PointerEvent) {
    const { px, py } = eventXY(e);
    const tocHit = tocLineHit(cached, py + scrollY);
    if (tocHit >= 0) { rd.setSel({ block: tocHit, offset: 0 }); afterNav('after'); return; }
    const taskHit = taskCheckboxHit(cached, rd.doc, resolver, layoutPadL, dpr * zoom, px, py + scrollY);
    if (taskHit >= 0) { if (!readOnly) { rd.toggleTaskChecked(taskHit); afterEdit(); } return; }
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
    if (mode === 'pending') onTouchTap(e);
    else if (mode === 'pan') startInertia(panVelocity);
    else if (mode === 'select') showContextMenu(e.clientX, e.clientY);
  }

  // —— 选区内按下不摧毁选区 + 拖拽移动文本 ——
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
    stopInertia();
    if (e.pointerType === 'touch') { onTouchDown(e); return; }
    ime.focus({ preventScroll: true });
    const { px, py } = eventXY(e);
    if (overScrollbar(px)) { scrollDrag = { startY: py, startScroll: scrollY }; canvas.setPointerCapture(e.pointerId); return; }
    const tocHit = tocLineHit(cached, py + scrollY);
    if (tocHit >= 0) { rd.setSel({ block: tocHit, offset: 0 }); afterNav('after'); canvas.setPointerCapture(e.pointerId); return; }
    const taskHit = taskCheckboxHit(cached, rd.doc, resolver, layoutPadL, dpr * zoom, px, py + scrollY);
    if (taskHit >= 0) { if (!readOnly) { rd.toggleTaskChecked(taskHit); afterEdit(); } canvas.setPointerCapture(e.pointerId); return; }
    const pos = posFromEvent(e);
    if (e.metaKey || e.ctrlKey) {
      const href = rd.linkHrefAt(pos);
      if (href && /^(https?:|mailto:)/i.test(href.trim())) {
        window.open(href.trim(), '_blank', 'noopener,noreferrer');
        canvas.setPointerCapture(e.pointerId); return;
      }
    }
    if (e.button !== 0) {
      if (!posWithinSelection(pos)) { rd.setSel(pos); viewChanged(); }
      return;
    }
    if (!e.shiftKey && posWithinSelection(pos)) {
      pendingSelDown = { pos, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    rd.setSel(pos, e.shiftKey);
    dragging = true; goalX = null;
    canvas.setPointerCapture(e.pointerId);
    viewChanged();
  }, { signal: sig });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') { onTouchMove(e); return; }
    if (scrollDrag) { scrollY = scrollDrag.startScroll + (eventXY(e).py - scrollDrag.startY) * (docPixelHeight() / canvas.height); clampScroll(); return; }
    if (pendingSelDown) {
      if (!readOnly && !dragTextActive && exceedsThreshold(e.clientX - pendingSelDown.x, e.clientY - pendingSelDown.y, DRAG_TEXT_MIN_PX)) dragTextActive = true;
      if (dragTextActive) { dropPos = posFromEvent(e); syncDragCaret(); }
      return;
    }
    if (dragging) { rd.setSel(posFromEvent(e), true); viewChanged(); }
  }, { signal: sig });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') { onTouchUp(e); return; }
    if (pendingSelDown) {
      const clickPos = pendingSelDown.pos;
      const commitDrop = dragTextActive ? dropPos : null;
      resetDragText();
      if (commitDrop) {
        if (rd.moveSelTo(commitDrop)) afterEdit(); else viewChanged();
      } else {
        rd.setSel(clickPos);
        viewChanged();
      }
    }
    dragging = false; scrollDrag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
  }, { signal: sig });
  canvas.addEventListener('pointercancel', (e) => {
    touchPoints.delete(e.pointerId);
    if (touchPoints.size < 2) pinch = null;
    if (e.pointerId === gesturePointerId) { gesturePointerId = -1; touchGesture.cancel(); }
    dragging = false;
    scrollDrag = null;
    resetDragText();
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
  }, { signal: sig });
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (lastPointerType === 'touch') return;
    if (e.detail !== 2 && e.detail !== 3) return;
    const pos = posFromEvent(e);
    if (e.detail === 2) selectWordAt(pos);
    else { rd.setSel({ block: pos.block, offset: 0 }); rd.setSel({ block: pos.block, offset: rd.blockLen(pos.block) }, true); }
    pendingSelDown = null;
    dragging = false;
    goalX = null;
    viewChanged();
  }, { signal: sig });

  // —— 触屏选区手柄 ——
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

  // 滚轮滚动；ctrl+wheel = 功能性缩放
  editorEl.addEventListener('wheel', (e) => {
    if (e.ctrlKey) { setZoom(zoom - e.deltaY * 0.01); e.preventDefault(); return; }
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= WHEEL_LINE_PX; else if (e.deltaMode === 2) d *= canvas.clientHeight;
    scrollY += d * dpr; clampScroll(); e.preventDefault();
  }, { passive: false, signal: sig });

  // 右键菜单
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (lastPointerType === 'touch') return;
    if (!enableContextMenu) return;
    ime.focus({ preventScroll: true });
    const pos = posFromEvent(e);
    if (rd.isCollapsed) rd.setSel(pos);
    else { const { from, to } = rd.range(); if (comparePos(pos, from) < 0 || comparePos(pos, to) > 0) rd.setSel(pos); }
    viewChanged();
    showContextMenu(e.clientX, e.clientY);
  }, { signal: sig });

  // —— 拖拽图片到编辑器 ——
  editorEl.addEventListener('dragover', (e) => {
    if (readOnly) return;
    if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  }, { signal: sig });
  editorEl.addEventListener('drop', (e) => {
    if (readOnly) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    e.preventDefault();
    try { rd.setSel(posFromEvent(e)); } catch { /* 落点解析失败则用当前光标 */ }
    const reader = new FileReader();
    reader.onload = () => { rd.insertImage(String(reader.result)); afterEdit(); ariaTree.announce('已插入图片'); };
    reader.readAsDataURL(file);
  }, { signal: sig });

  // —— 行首/行尾、上下移动 ——
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
  ime.addEventListener('keydown', (e) => {
    if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return;
    const meta = e.metaKey || e.ctrlKey;
    const ext = e.shiftKey;
    if ((e.altKey || meta) && MOD_NAV_KEYS.has(e.key)) {
      const navCmd = keymap[keyCombo(e)];
      if (navCmd) { dispatch(navCmd, ext ? 'extend' : null); e.preventDefault(); return; }
    }
    switch (e.key) {
      case 'ArrowLeft': rd.setSel(rd.posLeft(rd.focus), ext); afterNav('before'); e.preventDefault(); return;
      case 'ArrowRight': rd.setSel(rd.posRight(rd.focus), ext); afterNav('after'); e.preventDefault(); return;
      case 'ArrowUp': moveVertical(-1, ext); e.preventDefault(); return;
      case 'ArrowDown': moveVertical(1, ext); e.preventDefault(); return;
      case 'Home': { const ln = lineOfCaret(); if (ln) rd.setSel({ block: ln.block, offset: ln.startOffset }, ext); afterNav('after'); e.preventDefault(); return; }
      case 'End': { const ln = lineOfCaret(); if (ln) rd.setSel({ block: ln.block, offset: ln.endOffset }, ext); afterNav('before'); e.preventDefault(); return; }
      case 'Backspace': if (readOnly) { e.preventDefault(); return; } if (isFocusAtom()) rd.deleteBlock(rd.focus.block); else rd.backspace(); afterEdit(); e.preventDefault(); return;
      case 'Delete': if (readOnly) { e.preventDefault(); return; } if (isFocusAtom()) rd.deleteBlock(rd.focus.block); else rd.del(); afterEdit(); e.preventDefault(); return;
      case 'Enter': if (readOnly) { e.preventDefault(); return; } rd.enter(); afterEdit(); e.preventDefault(); return;
      case 'Tab':
        if (readOnly) { e.preventDefault(); return; }
        if (rd.focusIsList()) { if (e.shiftKey) rd.outdentList(); else rd.indentList(); afterEdit(); e.preventDefault(); }
        return;
      case 'PageUp': scrollY -= canvas.height * PAGE_SCROLL_RATIO; clampScroll(); e.preventDefault(); return;
      case 'PageDown': scrollY += canvas.height * PAGE_SCROLL_RATIO; clampScroll(); e.preventDefault(); return;
      case 'F2': toggleShaper(); e.preventDefault(); return;
      case 'Escape': if (findBar.isOpen()) { findBar.close(); e.preventDefault(); } return;
    }
    if (!meta) return;
    if (!e.altKey && (e.key === '=' || e.key === '+')) { setZoom(zoom + ZOOM_STEP); e.preventDefault(); return; }
    if (!e.altKey && e.key === '-') { setZoom(zoom - ZOOM_STEP); e.preventDefault(); return; }
    if (!e.altKey && e.key === '0') { setZoom(1); e.preventDefault(); return; }
    if (e.key.toLowerCase() === 'k') { if (!readOnly) dispatch('link.toggle'); e.preventDefault(); return; }
    const cmd = keymap[keyCombo(e)];
    if (cmd) { dispatch(cmd); e.preventDefault(); return; }
  }, { signal: sig });

  // 文本输入（非 IME 路径）
  ime.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    if (ie.isComposing || rd.isComposing) return;
    const t = ime.value;
    ime.value = '';
    if (readOnly) return;
    if (t) { rd.insertText(t); afterEdit(); }
  }, { signal: sig });

  // —— IME 组合中间态 ——
  ime.addEventListener('compositionstart', () => { if (readOnly) return; rd.beginComposition(); afterEdit(); }, { signal: sig });
  ime.addEventListener('compositionupdate', (e) => { if (readOnly) return; rd.updateComposition(e.data ?? ''); afterEdit(); }, { signal: sig });
  ime.addEventListener('compositionend', (e) => {
    if (readOnly) { ime.value = ''; return; }
    rd.endComposition(e.data ?? '');
    ime.value = '';
    afterEdit();
  }, { signal: sig });

  // —— 剪贴板 ——
  const clip = setupClipboard(ime, rd, afterEdit);

  // —— 右键菜单内容 ——
  function showContextMenu(clientX: number, clientY: number) {
    const sel = !rd.isCollapsed;
    const mark = (label: string, type: MarkType, cmd: string, key?: string): MenuItem =>
      ({ label, key, active: rd.markActive(type), action: () => dispatch(cmd) });
    const items: MenuItem[] = [
      { label: '剪切', key: '⌘X', disabled: !sel || readOnly, action: () => clip.cut() },
      { label: '复制', key: '⌘C', disabled: !sel, action: () => clip.copy() },
      { label: '粘贴', key: '⌘V', disabled: readOnly, action: () => clip.paste() },
      { separator: true },
      mark('粗体', 'bold', 'mark.bold', '⌘B'), mark('斜体', 'italic', 'mark.italic', '⌘I'), mark('下划线', 'underline', 'mark.underline', '⌘U'), mark('删除线', 'strikethrough', 'mark.strikethrough'), mark('高亮', 'highlight', 'mark.highlight'),
      { label: rd.markActive('link') ? '移除链接' : '插入链接…', key: '⌘K', active: rd.markActive('link'), action: () => dispatch('link.toggle') },
      { separator: true },
      { label: '全选', key: '⌘A', action: () => dispatch('select.all') },
      { label: '导出…', action: () => dispatch('doc.export') },
    ];
    ctxMenu.show(clientX, clientY, items);
  }

  // —— 链接弹层 ——
  async function doToggleLink() {
    if (rd.markActive('link')) { rd.clearMark('link'); afterEdit(); return; }
    const url = await promptDialog.ask({ title: '插入链接', value: 'https://', placeholder: 'https://example.com' });
    if (url) {
      const safe = sanitizeLinkHref(url);
      if (safe) { rd.setMark('link', { href: safe }); afterEdit(); }
      else ariaTree.announce('链接已拒绝：不支持的协议');
    }
    ime.focus({ preventScroll: true });
  }

  // —— 模板 ——
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
  // 主题切换：palette.C 是模块级可变全局——多实例下 setTheme 影响全页所有实例（最后调用胜出）。
  // 见类头注「已知多实例局限」；真正修复需 per-instance palette 注入（独立重构，本批不做）。
  function toggleTheme() {
    const next: ThemeName = activeTheme() === 'dark' ? 'light' : 'dark';
    applyCanvasTheme(next);
    document.documentElement.dataset.theme = next;
    viewModeChanged();
  }
  function setThemeInternal(name: ThemeName) {
    applyCanvasTheme(name);
    document.documentElement.dataset.theme = name;
    viewModeChanged();
  }

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
  const atomDialogs = createAtomDialogs({
    rd, promptDialog, imageDialog, signatureDialog, afterEdit,
    announce: (msg) => ariaTree.announce(msg),
    focusEditor: () => ime.focus({ preventScroll: true }),
  });

  // —— 统一命令总线 ——
  const focusEditor = (): void => ime.focus({ preventScroll: true });
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
      toggleShaper, toggleTheme, setViewMode: setViewModeInternal,
      exportDoc: () => outputPanel.open(rd.doc),
      applyTemplate,
      templateNames: () => allTemplates().map((t) => t.name),
      caretLineBounds: () => {
        const ln = lineOfCaret();
        return ln ? { block: ln.block, startOffset: ln.startOffset, endOffset: ln.endOffset } : null;
      },
      openFind: () => {
        const { from, to } = rd.range();
        findBar.open(!rd.isCollapsed && from.block === to.block ? rd.selectedText() : undefined);
      },
      printDoc: () => printDoc(rd.doc, document.title),
    },
  };
  function dispatch(id: string, arg?: CommandArg): void {
    // 只读守卫：readOnly 下命令总线只放行「非变更」命令——查找/打印(VIEW_ONLY)、
    // 词/行导航(NAV_AFFINITY)、全选、导出。其余（mark/block/align/history/insert/delete/template…）
    // 一律拦截。覆盖键盘 keymap、工具栏 exec、右键菜单与程序化 instance.exec 全部入口
    // （原 878-880 的修饰键导航早派发分支也经此 dispatch，自动受守卫覆盖）。
    if (readOnly && !READONLY_SAFE.has(id) && !(id in NAV_AFFINITY)) return;
    commands[id](commandCtx, arg);
    const aff = NAV_AFFINITY[id];
    if (aff) { afterNav(aff); return; }
    if (VIEW_ONLY.has(id)) return;
    if (!SELF_FINALIZING.has(id)) afterEdit();
  }

  if (showToolbar && shell.toolbarEl) {
    toolbar = createToolbar(shell.toolbarEl, {
      exec: (id, arg) => dispatch(id, arg as CommandArg),
      focusEditor,
      templateNames: () => allTemplates().map((t) => t.name),
    });
  }

  // —— 面板装配 ——
  function jumpToBlock(blockIndex: number) {
    if (blockIndex < 0 || blockIndex >= rd.blockCount) return;
    rd.setSel({ block: blockIndex, offset: 0 });
    afterNav('after');
    ime.focus({ preventScroll: true });
  }
  const outline: Outline | null = showOutline && shell.leftBody
    ? createOutline(shell.leftBody, { onJump: jumpToBlock })
    : null;
  const statusBar: StatusBar | null = showStatusBar && shell.statusBarEl
    ? createStatusBar(shell.statusBarEl, {
        onZoomDelta: (deltaPct) => setZoom(zoom + deltaPct / 100),
        onZoomReset: () => setZoom(1),
      })
    : null;
  const findBar = createFindBar(editorEl, {
    rd,
    afterNav: () => afterNav('after'),
    afterEdit,
    focusEditor,
    onMatchesChanged: () => { needRender = true; },
    printDoc: () => dispatch('doc.print'),
  });

  function syncPanels() {
    outline?.update(rd.doc);
    statusBar?.update(rd.doc, zoom * 100, viewMode === 'word' ? '页面' : '网页');
  }

  // —— 文档自动保存（persistDraft 开关）——
  const autosaver = persistDraft
    ? createAutosaver(
        () => !rd.isComposing && saveDraft(rd.doc, rd.anchor, rd.focus),
        (dirtyDraft) => statusBar?.setSaveState(!dirtyDraft),
      )
    : null;
  if (autosaver) {
    window.addEventListener('beforeunload', (e) => {
      if (!autosaver.dirty) return;
      if (autosaver.flush()) return;
      e.preventDefault();
      e.returnValue = '';
    }, { signal: sig });
  }

  function subscribeBus() {
    const onDoc = () => { dirty = true; resetBlink(); syncToolbar(); ariaTree.update(rd.doc); syncPanels(); };
    bus.on('doc:changed', onDoc);
    if (autosaver) bus.on('doc:changed', () => { if (!rd.isComposing) autosaver.schedule(); });
    if (showFindBar) bus.on('doc:changed', () => findBar.refresh());
    bus.on('selection:changed', () => { resetBlink(); syncToolbar(); });
    bus.on('view:changed', onDoc);
  }

  // 折叠按钮接线
  if (showOutline && shell.leftPanel && shell.leftCollapse) {
    const leftPanel = shell.leftPanel;
    shell.leftCollapse.addEventListener('click', () => leftPanel.classList.toggle('collapsed'), { signal: sig });
  }

  async function start() {
    subscribeBus();
    renderer = await createRenderer(canvas);
    if (destroyed) return; // 异步就绪期间已销毁：不再观察/起帧
    watchRendererLost();
    resize();
    editorResizeObserver.observe(editorEl);
    ime.focus({ preventScroll: true });
    rafId = requestAnimationFrame(frame);
    syncToolbar();
    syncPanels();
    try {
      hbShaper = await HarfBuzzShaper.create(atlas, appliedScale);
      if (destroyed) return;
      if (DEFAULT_SHAPER === 'harfbuzz') activeShaper = hbShaper;
      markDirty();
      console.log('[shaper] HarfBuzz 就绪');
    } catch (err) {
      if (destroyed) return;
      console.warn('[shaper] HarfBuzz 加载失败，保持 Canvas：', err);
      syncToolbar();
    }
  }
  void start();

  // —— 实例句柄 ——
  function setDocInternal(doc: Doc) {
    rd.setDoc(doc);
    afterEdit();
  }
  return {
    dom: shell.root,
    exec: (id, arg) => dispatch(id, arg),
    getDoc: () => rd.doc,
    setDoc: setDocInternal,
    getHTML: () => toHtml(rd.doc),
    setHTML: (html) => setDocInternal(parseHtml(html)),
    getMarkdown: () => toMarkdown(rd.doc),
    setMarkdown: (md) => setDocInternal(parseMarkdown(md)),
    getJSON: () => toJson(rd.doc),
    setJSON: (json) => setDocInternal(JSON.parse(json) as Doc),
    on: (ev, fn) => bus.on(ev, fn),
    off: (ev, fn) => bus.off(ev, fn),
    focus: () => ime.focus({ preventScroll: true }),
    setViewMode: setViewModeInternal,
    setZoom,
    setTheme: setThemeInternal,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // 1) 停 RAF 主循环（frame/inertiaStep 首行已 destroyed 早退，双保险 cancel）
      if (rafId) cancelAnimationFrame(rafId);
      // 2) 一次性断开所有 window/document/canvas/ime/editorEl 监听
      ac.abort();
      // 3) 断编辑器容器尺寸观察
      editorResizeObserver.disconnect();
      // 4) 草稿落盘并清防抖计时（flush 内部 clearTimeout）
      autosaver?.flush();
      // 5) 回收 body/head 级门户与各 UI 工厂的 document 级监听（每个工厂自带 destroy）：
      //    ctxMenu(body 菜单 + document mousedown/keydown + window blur)、outputPanel(body 面板 + document keydown)、
      //    ariaTree(head <style> + body 镜像/live)、prompt/image/signature(各 body scrim)、
      //    overlayMgr(head <style> + 定位层及缓存原子块 DOM)。
      overlayMgr.destroy();
      ariaTree.destroy();
      outputPanel.destroy();
      ctxMenu.destroy();
      promptDialog.destroy();
      imageDialog.destroy();
      signatureDialog.destroy();
      // 6) 移除外壳 DOM（含 dropLine/dragCaretEl/canvas/ime 随子树回收）
      shell.root.remove();
      // 注：tooltip 层（ui/tooltip installTooltips）是页面级单例（installed 守卫，一页仅装一次，
      // 跨实例共享），非 per-instance 门户——反复 create/destroy 不累积，故无需在此回收。
    },
  };
}
