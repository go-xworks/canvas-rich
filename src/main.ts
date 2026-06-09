/**
 * 编辑器装配入口（editor/ui 层）：组装文档模型、整形器、布局、渲染循环、
 * 输入(键鼠/IME/剪贴板)与 UI(工具栏/菜单/覆盖层)，驱动 requestAnimationFrame 主循环。
 */
import './styles/tw.css';
import 'katex/dist/katex.min.css';
import { GlyphAtlas } from './text/glyph-atlas';
import { createRenderer } from './render/create-renderer';
import type { Renderer } from './render/renderer';
import { Quad } from './render/renderer';
import { Shaper } from './text/shaper';
import { CanvasShaper } from './text/canvas-shaper';
import { HarfBuzzShaper } from './text/harfbuzz-shaper';
import { Doc, BlockType, MarkType, block, para, text, isAtomBlock } from './model/schema';
import { RichDoc, Pos, comparePos } from './model/rich-document';
import { StyleResolver } from './model/style-resolver';
import { C } from './model/palette';
import { layoutDoc, caretAt, caretLine, nearestLine, hitTestDoc, selectionRects, DocLayout, LineBox } from './text/doc-layout';
import { createToolbar, Toolbar } from './ui/toolbar';
import { createOutputPanel } from './ui/output-panel';
import { createContextMenu, MenuItem } from './ui/context-menu';
import { createPromptDialog } from './ui/prompt';
import { createImageDialog } from './ui/image-dialog';
import { createOverlayManager } from './ui/overlays';
import { createAriaTree } from './ui/aria';
import { commands, keymap, keyCombo } from './editor/commands';
import { setupClipboard } from './editor/clipboard';
import { parseMarkdown, parseHtml } from './editor/import';

// 默认整形器：'canvas'（系统字体，含 CJK，立即可用）或 'harfbuzz'（Roboto，真整形，Latin）
const DEFAULT_SHAPER: 'canvas' | 'harfbuzz' = 'canvas';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ime = document.getElementById('ime') as HTMLTextAreaElement;
const ariaTree = createAriaTree(canvas, ime);
let tableFocused = false; // 表格单元格编辑中（暂停 canvas 光标 / 不抢回 ime）

let dpr = Math.max(1, window.devicePixelRatio || 1);
const atlas = new GlyphAtlas(document.createElement('canvas'), dpr);
let renderer!: Renderer;
const resolver = new StyleResolver();

const canvasShaper = new CanvasShaper(atlas);
let hbShaper: HarfBuzzShaper | null = null;
let activeShaper: Shaper = canvasShaper;
let toolbar: Toolbar | null = null;

// —— 初始文档（标题/段落/多 mark/列表/对齐/引用）——
const DEMO_IMG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150"><rect width="560" height="150" rx="10" fill="#eef2ff"/><circle cx="80" cy="75" r="40" fill="#2563eb"/><text x="150" y="84" font-family="system-ui" font-size="24" fill="#1f2430">图片块（DOM 覆盖层渲染）</text></svg>');

const doc: Doc = {
  blocks: [
    block('heading', [text('Rich Text Engine')], { level: 1 }),
    block('heading', [text('Document tree · marks · block layout')], { level: 2 }),
    para([
      text('A paragraph mixing '),
      text('bold', [{ type: 'bold' }]),
      text(', '),
      text('italic', [{ type: 'italic' }]),
      text(', '),
      text('underline', [{ type: 'underline' }]),
      text(', '),
      text('strike', [{ type: 'strikethrough' }]),
      text(', '),
      text('highlight', [{ type: 'highlight' }]),
      text(', '),
      text('green', [{ type: 'color', attrs: { color: '#5ad17a' } }]),
      text(', '),
      text('code', [{ type: 'code' }]),
      text(', and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
      text('. Long enough to wrap across lines so you can select across them.'),
    ]),
    block('bullet_item', [text('Bullet one — select across lines, then toggle marks.')]),
    block('bullet_item', [text('Bullet two — '), text('bold tail', [{ type: 'bold' }])]),
    block('ordered_item', [text('First numbered item.')]),
    block('ordered_item', [text('Second numbered item — auto-numbered.')]),
    block('code_block', [text("function shape(text, font) {")]),
    block('code_block', [text("  return harfbuzz.shape(text, font);  // 多行代码块连续背景")]),
    block('code_block', [text("}")]),
    { type: 'image', attrs: { src: DEMO_IMG, height: 150 }, inlines: [text('')] },
    { type: 'formula', attrs: { latex: 'E = mc^2 \\quad\\quad \\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' }, inlines: [text('')] },
    { type: 'table', attrs: { rows: [['功能', '状态'], ['公式 (KaTeX)', '✓'], ['表格 (可编辑)', '✓ 双击单元格']] }, inlines: [text('')] },
    para([text('A centered paragraph.')], { align: 'center' }),
    block('blockquote', [text('A blockquote: italic and muted.')]),
    { type: 'paragraph', attrs: { dir: 'rtl' }, inlines: [text('שלום עולם — פסקה מימין לשמאל (RTL ⌘⇧D)')] },
    { type: 'paragraph', attrs: { dir: 'rtl' }, inlines: [text('مرحبا بالعالم — فقرة عربية متصلة الحروف (HarfBuzz)')] },
    para([text('Mixed BiDi: English with עברית מוטבעת inside, back to English.')]),
    para([text('Edit me. Use the toolbar, or type / Enter / Backspace.')]),
  ],
};
const rd = new RichDoc(doc);
rd.setSel(rd.docEnd());

// —— 布局缓存 ——
let cached: DocLayout | null = null;
let dirty = true;
let goalX: number | null = null;
let caretAffinity: 'before' | 'after' = 'after'; // 软换行点光标贴哪一行
let scrollY = 0;            // 内容垂直滚动（设备 px）
let followCaret = false;    // 编辑/移动后把光标滚入视口
let scrollDrag: { startY: number; startScroll: number } | null = null;
const PAD = 26;
function relayout() {
  cached = layoutDoc(rd.doc, activeShaper, resolver, { width: canvas.width, padL: PAD * dpr, padT: PAD * dpr, dpr });
  dirty = false;
}
// 仅视图变化（选择/导航/滚动）：重绘但不重排（布局不依赖选区）
function viewChanged() { resetBlink(); syncToolbar(); }
// 内容变化：触发重排（relayout）+ 更新无障碍镜像
function markDirty() { dirty = true; resetBlink(); syncToolbar(); ariaTree.update(rd.doc); }
function afterNav(aff: 'before' | 'after') { goalX = null; caretAffinity = aff; followCaret = true; viewChanged(); }
function afterEdit() { goalX = null; caretAffinity = 'after'; followCaret = true; markDirty(); }

// —— 滚动 ——
function docPixelHeight() { return (cached ? cached.contentHeight : 0) + 2 * PAD * dpr; }
function clampScroll() { scrollY = Math.max(0, Math.min(Math.max(0, docPixelHeight() - canvas.height), scrollY)); }
function ensureCaretVisible() {
  if (!cached) return;
  const c = caretAt(cached, rd.focus, caretAffinity); if (!c) return;
  const m = 10 * dpr;
  if (c.top - scrollY < m) scrollY = c.top - m;
  else if (c.bottom - scrollY > canvas.height - m) scrollY = c.bottom - canvas.height + m;
  clampScroll();
}
function scrollbarThumb(): { x: number; y: number; w: number; h: number } | null {
  const docH = docPixelHeight();
  if (docH <= canvas.height + 1) return null;
  const trackH = canvas.height;
  const thumbH = Math.max(30 * dpr, trackH * canvas.height / docH);
  const maxScroll = docH - canvas.height;
  const thumbY = maxScroll > 0 ? (scrollY / maxScroll) * (trackH - thumbH) : 0;
  return { x: canvas.width - 7 * dpr, y: thumbY, w: 5 * dpr, h: thumbH };
}
// 命中落点的 affinity：落在某行的 endOffset 且同块存在以该 offset 起始的下一行 → 'before'
function affinityAt(pos: Pos, ln: LineBox | null): 'before' | 'after' {
  if (ln && pos.offset === ln.endOffset && cached!.lines.some((l) => l.block === ln.block && l !== ln && l.startOffset === pos.offset)) return 'before';
  return 'after';
}
// 光标是否停在被「节点选中」的原子块上（图片/公式/表格）
function isFocusAtom(): boolean { return rd.isCollapsed && isAtomBlock(rd.doc.blocks[rd.focus.block]?.type); }

function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  renderer.resize(canvas.width, canvas.height);
  dirty = true;
}
window.addEventListener('resize', resize);

let blinkStart = performance.now();
function resetBlink() { blinkStart = performance.now(); }
function caretVisible() { return ((performance.now() - blinkStart) % 1060) < 600; }

// —— 渲染循环 ——
function frame() {
  if (dirty || !cached) relayout();
  if (atlas.consumeReset()) dirty = true; // 图集复位 → 下一帧重排，重栅本帧前已放置的字形
  const L = cached!;
  if (followCaret) { ensureCaretVisible(); followCaret = false; }
  clampScroll();
  if (atlas.dirty) { renderer.uploadAtlas(atlas.canvas); atlas.clearDirty(); }
  const wu = atlas.whiteUV;
  const quads: Quad[] = [];
  // 内容坐标（自动减去 scrollY）
  const solid = (x: number, y: number, w: number, h: number, c: [number, number, number, number]) =>
    quads.push({ x, y: y - scrollY, w, h, u0: wu.u, v0: wu.v, u1: wu.u, v1: wu.v, r: c[0], g: c[1], b: c[2], a: c[3] });
  // 屏幕坐标（不随滚动，画滚动条）
  const solidScreen = (x: number, y: number, w: number, h: number, c: [number, number, number, number]) =>
    quads.push({ x, y, w, h, u0: wu.u, v0: wu.v, u1: wu.u, v1: wu.v, r: c[0], g: c[1], b: c[2], a: c[3] });

  for (const bg of L.backgrounds) solid(bg.x, bg.y, bg.w, bg.h, bg.color);
  for (const hl of L.highlights) solid(hl.x, hl.y, hl.w, hl.h, hl.color); // 文字背景
  if (!rd.isCollapsed) {
    const { from, to } = rd.range();
    for (const r of selectionRects(L, from, to)) solid(r.x, r.y, r.w, r.h, r.color);
  }
  for (const g of L.glyphs) {
    quads.push({
      x: g.penX, y: g.baselineY - g.info.bearingY - scrollY, w: g.info.w, h: g.info.h,
      u0: g.info.u0, v0: g.info.v0, u1: g.info.u1, v1: g.info.v1,
      r: g.color[0], g: g.color[1], b: g.color[2], a: g.color[3],
    });
  }
  for (const u of L.decorations) solid(u.x, u.y, u.w, u.h, u.color);
  // 光标：原子块（图片/公式/表格）走「节点选中外框」(在覆盖层上画)，不画等高文本光标
  const focusAtom = rd.isCollapsed && isAtomBlock(rd.doc.blocks[rd.focus.block]?.type);
  if (rd.isCollapsed && caretVisible() && !tableFocused && !focusAtom) {
    const c = caretAt(L, rd.focus, caretAffinity);
    if (c) {
      solid(c.x, c.top + 2 * dpr, Math.max(1, Math.round(2 * dpr)), (c.bottom - c.top) - 4 * dpr, C.caret);
      ime.style.left = Math.round(c.x / dpr) + 'px';
      ime.style.top = Math.round((c.top - scrollY) / dpr) + 'px';
    }
  }
  // 滚动条
  const th = scrollbarThumb();
  if (th) solidScreen(th.x, th.y, th.w, th.h, [1, 1, 1, scrollDrag ? 0.34 : 0.2]);

  renderer.render(quads, C.bg);
  overlayMgr.sync(rd.doc, L.overlays, scrollY, dpr, focusAtom && !tableFocused ? rd.focus.block : -1);
  requestAnimationFrame(frame);
}

// —— 原子块覆盖层（图片 / 公式 / 表格）——
const editorEl = document.getElementById('editor')!;
const overlayMgr = createOverlayManager(editorEl, {
  onTableEdit: () => { markDirty(); },
  onMeasured: (blockIndex, hLogical) => { if (rd.setMeasuredHeight(blockIndex, hLogical)) dirty = true; },
  onCellFocus: () => { tableFocused = true; },
  onCellBlur: () => { tableFocused = false; ime.focus({ preventScroll: true }); },
  onImageResize: (blockIndex, w, h) => { rd.setImageSize(blockIndex, w, h); afterEdit(); },
  onBlockMove: (blockIndex, clientY, phase) => handleBlockMove(blockIndex, clientY, phase),
});

// —— 图片拖动重排：落点指示线 + 提交 ——
const dropLine = document.createElement('div');
dropLine.style.cssText = 'position:absolute;left:8px;right:8px;height:2px;border-radius:1px;background:var(--rte-accent);display:none;pointer-events:none;z-index:30';
editorEl.appendChild(dropLine);
let dropTarget = -1;
function blockBounds(b: number): { top: number; bottom: number } | null {
  if (!cached) return null;
  let top = Infinity, bottom = -Infinity;
  for (const l of cached.lines) if (l.block === b) { top = Math.min(top, l.top); bottom = Math.max(bottom, l.bottom); }
  return isFinite(top) ? { top, bottom } : null;
}
function gapAtY(pyDevice: number): number {
  const n = rd.blockCount;
  for (let b = 0; b < n; b++) { const bb = blockBounds(b); if (bb && pyDevice < (bb.top + bb.bottom) / 2) return b; }
  return n;
}
function gapYDevice(gap: number): number {
  const bb = gap >= rd.blockCount ? blockBounds(rd.blockCount - 1) : blockBounds(gap);
  return bb ? (gap >= rd.blockCount ? bb.bottom : bb.top) : 0;
}
function handleBlockMove(from: number, clientY: number, phase: 'move' | 'drop') {
  const rect = canvas.getBoundingClientRect();
  const gap = gapAtY((clientY - rect.top) * dpr + scrollY);
  if (phase === 'move') {
    dropTarget = gap;
    dropLine.style.top = ((gapYDevice(gap) - scrollY) / dpr) + 'px';
    dropLine.style.display = '';
  } else {
    dropLine.style.display = 'none';
    if (dropTarget >= 0) { rd.moveBlock(from, dropTarget); afterEdit(); }
    dropTarget = -1;
  }
}

// —— 鼠标 ——
let dragging = false;
function eventXY(e: PointerEvent | MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  return { px: (e.clientX - rect.left) * dpr, py: (e.clientY - rect.top) * dpr };
}
function posFromEvent(e: PointerEvent | MouseEvent): Pos {
  if (!cached) return { block: 0, offset: 0 };
  const { px, py } = eventXY(e);
  const cy = py + scrollY; // 屏幕 → 内容坐标
  const pos = hitTestDoc(cached, px, cy);
  caretAffinity = affinityAt(pos, nearestLine(cached, cy));
  return pos;
}
function overScrollbar(px: number): boolean { return !!scrollbarThumb() && px >= canvas.width - 14 * dpr; }

// 命中任务列表项的 checkbox 标记（首行、内容左侧的标记栏）→ 返回块下标，否则 -1。
function taskCheckboxHit(px: number, cy: number): number {
  if (!cached) return -1;
  for (const ln of cached.lines) {
    if (cy < ln.top || cy > ln.bottom) continue;
    const blk = rd.doc.blocks[ln.block];
    if (!blk || blk.type !== 'task_item') continue;
    // 仅首行有标记；标记画在内容左侧（x0 = contentLeft + indent）的标记栏内
    const isFirstLine = ln.startOffset === 0;
    if (!isFirstLine) continue;
    const x0 = PAD * dpr + resolver.resolveBlock(blk).indent * dpr;
    if (px < x0) return ln.block;
    return -1;
  }
  return -1;
}

canvas.addEventListener('pointerdown', (e) => {
  ime.focus({ preventScroll: true });
  const { px, py } = eventXY(e);
  if (overScrollbar(px)) { scrollDrag = { startY: py, startScroll: scrollY }; canvas.setPointerCapture(e.pointerId); return; }
  // 点击任务项 checkbox 标记栏 → 切换勾选态（不进入选区拖拽）
  const taskHit = taskCheckboxHit(px, py + scrollY);
  if (taskHit >= 0) { rd.toggleTaskChecked(taskHit); afterEdit(); canvas.setPointerCapture(e.pointerId); return; }
  rd.setSel(posFromEvent(e), e.shiftKey);
  dragging = true; goalX = null;
  canvas.setPointerCapture(e.pointerId);
  viewChanged();
});
canvas.addEventListener('pointermove', (e) => {
  if (scrollDrag) { scrollY = scrollDrag.startScroll + (eventXY(e).py - scrollDrag.startY) * (docPixelHeight() / canvas.height); clampScroll(); return; }
  if (dragging) { rd.setSel(posFromEvent(e), true); viewChanged(); }
});
canvas.addEventListener('pointerup', (e) => { dragging = false; scrollDrag = null; try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ } });
// 阻止画布在 mousedown 时夺走 ime 焦点（否则点击后键盘方向键失效）
canvas.addEventListener('mousedown', (e) => e.preventDefault());

// 滚轮滚动
document.getElementById('editor')!.addEventListener('wheel', (e) => {
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= canvas.clientHeight;
  scrollY += d * dpr; clampScroll(); e.preventDefault();
}, { passive: false });

// 右键菜单
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
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
  caretAffinity = affinityAt(pos, nearestLine(cached, targetY));
  rd.setSel(pos, extend);
  viewChanged();
}

// —— 键盘 ——
ime.addEventListener('keydown', (e) => {
  if (e.isComposing || (e as unknown as { keyCode: number }).keyCode === 229) return; // IME 组合期间把按键交还输入法
  const meta = e.metaKey || e.ctrlKey;
  const ext = e.shiftKey;
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
    case 'PageUp': scrollY -= canvas.height * 0.9; clampScroll(); e.preventDefault(); return;
    case 'PageDown': scrollY += canvas.height * 0.9; clampScroll(); e.preventDefault(); return;
    case 'F2': toggleShaper(); e.preventDefault(); return;
  }
  if (!meta) return;
  if (e.key.toLowerCase() === 'k') { doToggleLink(); e.preventDefault(); return; } // 链接需弹窗，留装配层
  // 复制/剪切/粘贴(mod+c/x/v)不在 keymap → 放行给 ime 的 clipboard 事件
  const cmd = keymap[keyCombo(e)];
  if (cmd) { commands[cmd](rd); afterEdit(); e.preventDefault(); return; }
});

// 文本输入 + IME 提交
ime.addEventListener('input', (e) => {
  const ie = e as InputEvent;
  if (ie.isComposing) return;
  const t = ime.value;
  ime.value = '';
  if (t) { rd.insertText(t); afterEdit(); }
});

// —— 剪贴板（独立模块）——
const clip = setupClipboard(ime, rd, afterEdit);

// —— 右键菜单内容 ——
function showContextMenu(clientX: number, clientY: number) {
  const sel = !rd.isCollapsed;
  const mark = (label: string, type: MarkType, key?: string): MenuItem =>
    ({ label, key, active: rd.markActive(type), action: () => { rd.toggleMark(type); afterEdit(); } });
  const items: MenuItem[] = [
    { label: '剪切', key: '⌘X', disabled: !sel, action: () => clip.cut() },
    { label: '复制', key: '⌘C', disabled: !sel, action: () => clip.copy() },
    { label: '粘贴', key: '⌘V', action: () => clip.paste() },
    { separator: true },
    mark('粗体', 'bold', '⌘B'), mark('斜体', 'italic', '⌘I'), mark('下划线', 'underline', '⌘U'), mark('删除线', 'strikethrough'), mark('高亮', 'highlight'),
    { label: rd.markActive('link') ? '移除链接' : '插入链接…', key: '⌘K', active: rd.markActive('link'), action: doToggleLink },
    { separator: true },
    { label: '全选', key: '⌘A', action: () => { rd.selectAll(); afterEdit(); } },
    { label: '导出…', action: () => outputPanel.open(rd.doc) },
  ];
  ctxMenu.show(clientX, clientY, items);
}

// —— 工具栏（输入用应用内弹层，不使用原生 prompt/alert）——
async function doToggleLink() {
  if (rd.markActive('link')) { rd.clearMark('link'); afterEdit(); return; }
  const url = await promptDialog.ask({ title: '插入链接', value: 'https://', placeholder: 'https://example.com' });
  if (url) { rd.setMark('link', { href: url }); afterEdit(); }
  ime.focus({ preventScroll: true });
}
async function doInsertImage() {
  const src = await imageDialog.open(); // 富弹层：本地上传/拖拽 + URL + 预览
  if (src) { rd.insertImage(src); afterEdit(); ariaTree.announce('已插入图片'); }
  ime.focus({ preventScroll: true });
}
async function doInsertFormula() {
  const tex = await promptDialog.ask({ title: '插入公式（LaTeX）', value: 'e = mc^2', placeholder: '\\frac{a}{b}', multiline: true });
  if (tex) { rd.insertFormula(tex); afterEdit(); ariaTree.announce('已插入公式'); }
  ime.focus({ preventScroll: true });
}
// 导入：弹多行输入，粘贴 Markdown/HTML，解析为 Doc 后整文档替换（光标置文末）。
// 含 HTML 标签则按 HTML 解析，否则按 Markdown。
async function doImport() {
  const src = await promptDialog.ask({
    title: '导入 Markdown / HTML（替换当前文档）',
    placeholder: '# 标题\n\n- 列表\n\n**粗体** *斜体* [链接](https://…)',
    okLabel: '导入',
    multiline: true,
  });
  if (src && src.trim()) {
    const looksHtml = /<\/?[a-z][\s\S]*>/i.test(src);
    rd.setDoc(looksHtml ? parseHtml(src) : parseMarkdown(src));
    afterEdit();
    ariaTree.announce('已导入文档');
  }
  ime.focus({ preventScroll: true });
}
// 表格经工具栏网格选择器直接给出行列数
function doInsertTable(rows: number, cols: number) {
  rd.insertTable(rows, cols); afterEdit(); ariaTree.announce(`已插入 ${rows} 行 ${cols} 列表格`);
  ime.focus({ preventScroll: true });
}
function toggleShaper() {
  if (!hbShaper) return;
  activeShaper = activeShaper === canvasShaper ? hbShaper : canvasShaper;
  markDirty();
}
function blockValueOf(): string {
  const b = rd.doc.blocks[rd.focus.block];
  if (b.type === 'heading') { const l = b.attrs.level ?? 1; return 'heading' + (l < 1 ? 1 : l > 6 ? 6 : l); }
  return b.type;
}
// 当前生效字号：有 fontSize 行内 mark 取其值，否则块主题默认字号（取整成字符串）
function activeFontSize(): string {
  const fs = rd.activeMarks().find((m) => m.type === 'fontSize');
  if (fs?.attrs?.size) return fs.attrs.size;
  const blk = rd.doc.blocks[rd.focus.block];
  return String(Math.round(resolver.resolveBlock(blk).base.fontSize));
}
// 当前生效字体族命名值：有 fontFamily 行内 mark 取其命名值，否则 'default'（块默认）
function activeFontFamily(): string {
  return rd.activeMarks().find((m) => m.type === 'fontFamily')?.attrs?.fontFamily ?? 'default';
}
function syncToolbar() {
  if (!toolbar) return;
  toolbar.refresh({
    marks: {
      bold: rd.markActive('bold'), italic: rd.markActive('italic'),
      underline: rd.markActive('underline'), strikethrough: rd.markActive('strikethrough'),
      highlight: rd.markActive('highlight'), code: rd.markActive('code'), link: rd.markActive('link'),
      superscript: rd.markActive('superscript'), subscript: rd.markActive('subscript'),
    },
    blockValue: blockValueOf(),
    fontSize: activeFontSize(),
    fontFamily: activeFontFamily(),
    align: rd.doc.blocks[rd.focus.block].attrs.align ?? 'left',
    dir: rd.doc.blocks[rd.focus.block].attrs.dir ?? 'ltr',
    canUndo: rd.canUndo, canRedo: rd.canRedo,
    shaperShort: activeShaper === canvasShaper ? 'Canvas' : (hbShaper ? 'HarfBuzz' : '加载中'),
  });
}
const outputPanel = createOutputPanel(() => ime.focus({ preventScroll: true }));
const ctxMenu = createContextMenu();
const promptDialog = createPromptDialog();
const imageDialog = createImageDialog();
toolbar = createToolbar(document.getElementById('toolbar')!, {
  undo: () => { rd.undo(); afterEdit(); },
  redo: () => { rd.redo(); afterEdit(); },
  setBlock: (v) => {
    const hm = /^heading([1-6])$/.exec(v);
    if (hm) rd.setBlockType('heading', { level: Number(hm[1]) as 1 | 2 | 3 | 4 | 5 | 6 });
    else rd.setBlockType(v as BlockType);
    afterEdit();
  },
  toggleMark: (t) => { rd.toggleMark(t as MarkType); afterEdit(); },
  setFontSize: (size) => { if (size) rd.setMark('fontSize', { size }); else rd.clearMark('fontSize'); afterEdit(); },
  setFontFamily: (family) => { if (family && family !== 'default') rd.setMark('fontFamily', { fontFamily: family }); else rd.clearMark('fontFamily'); afterEdit(); },
  toggleSuperscript: () => { rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']); afterEdit(); },
  toggleSubscript: () => { rd.toggleExclusiveMark('subscript', ['superscript', 'subscript']); afterEdit(); },
  setColor: (hex) => { if (hex) rd.setMark('color', { color: hex }); else rd.clearMark('color'); afterEdit(); },
  setHighlight: (hex) => { if (hex) rd.setMark('highlight', { color: hex }); else rd.clearMark('highlight'); afterEdit(); },
  toggleLink: doToggleLink,
  clearFormat: () => { rd.clearMarks(); afterEdit(); },
  setAlign: (a) => { rd.setAlign(a as 'left' | 'center' | 'right'); afterEdit(); },
  toggleDir: () => { rd.setDir(rd.doc.blocks[rd.focus.block].attrs.dir === 'rtl' ? 'ltr' : 'rtl'); afterEdit(); },
  toggleShaper,
  importDoc: doImport,
  exportDoc: () => outputPanel.open(rd.doc),
  insertImage: doInsertImage,
  insertFormula: doInsertFormula,
  insertTable: doInsertTable,
  focusEditor: () => ime.focus({ preventScroll: true }),
});

async function start() {
  renderer = await createRenderer(canvas);
  resize();
  ime.focus({ preventScroll: true });
  requestAnimationFrame(frame);
  syncToolbar();
  try {
    hbShaper = await HarfBuzzShaper.create(atlas, dpr);
    if (DEFAULT_SHAPER === 'harfbuzz') activeShaper = hbShaper;
    markDirty();
    console.log('[shaper] HarfBuzz 就绪');
  } catch (err) {
    console.warn('[shaper] HarfBuzz 加载失败，保持 Canvas：', err);
    syncToolbar();
  }
}
start();
