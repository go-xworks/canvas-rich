// 工具栏（ui 层）：Lucide 内联图标 + 亮色主题（CSS 变量 --rte-*）+ 分组 + 颜色/高亮下拉面板。
// Preflight 已禁用，按钮需显式中和默认样式（appearance-none/border-0/bg-transparent）。
// active 态用「浅蓝 wash + 蓝前景」（important 修饰压过基础类），非实心填充。
// 分层：仅回调装配层句柄，不直接触碰 model。
import { icon } from './icons';

/**
 * 工具栏向装配层回调的句柄集合：每个按钮/控件触发对应编辑意图。
 * @public
 */
export interface ToolbarHandlers {
  undo(): void; redo(): void;
  setBlock(value: string): void;
  toggleMark(type: string): void;
  setFontSize(size: string | null): void;
  setFontFamily(family: string | null): void;
  toggleSuperscript(): void;
  toggleSubscript(): void;
  setColor(hex: string | null): void;
  setHighlight(hex: string | null): void;
  toggleLink(): void;
  clearFormat(): void;
  setAlign(a: string): void;
  toggleDir(): void;
  toggleShaper(): void;
  importDoc(): void;
  exportDoc(): void;
  insertImage(): void;
  insertFormula(): void;
  insertTable(rows: number, cols: number): void;
  focusEditor(): void;
}

/**
 * 工具栏的当前可视状态快照，用于驱动按钮 active/disabled 与块类型/方向回填。
 * @public
 */
export interface ToolbarState {
  marks: Record<string, boolean>;
  blockValue: string;
  fontSize: string;   // 当前生效字号（行内 mark 覆盖则为该值，否则块默认字号）
  fontFamily: string; // 当前生效字体族命名值（'default' 表示块默认）
  align: string;
  dir: string;
  canUndo: boolean; canRedo: boolean;
  shaperShort: string;
}

/**
 * 已创建工具栏的句柄：用最新状态刷新按钮可视态。
 * @public
 */
export interface Toolbar { refresh(s: ToolbarState): void }

const HOST = 'flex flex-wrap items-center gap-1 px-3 py-1.5 bg-[var(--rte-chrome-bg)] '
  + 'border-b border-[var(--rte-chrome-border)] font-sans select-none';
const GROUP = 'flex items-center gap-0.5 pr-1.5 mr-0.5 border-r border-[var(--rte-chrome-border)] '
  + 'last:border-r-0 last:mr-0 last:pr-0';
const BTN = 'w-[30px] h-[30px] rounded-md bg-transparent border-0 appearance-none '
  + 'text-[var(--rte-chrome-fg)] cursor-pointer inline-flex items-center justify-center '
  + 'transition-colors duration-150 hover:bg-[var(--rte-chrome-hover)] '
  + 'disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent';
const PANEL = 'absolute left-0 top-[34px] z-50 p-2 bg-[var(--rte-overlay-bg)] '
  + 'border border-[var(--rte-overlay-border)] rounded-lg shadow-[var(--rte-shadow)] hidden';
const SWATCH = 'w-[22px] h-[22px] rounded-[5px] border border-black/15 cursor-pointer p-0 '
  + 'appearance-none transition-transform hover:scale-110';

const SWATCHES = ['#1f2430', '#ef4444', '#f97316', '#eab308', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];

// 字号预设（px）；选中即写入 fontSize 行内 mark，清除恢复块默认字号。
const FONT_SIZES = ['12', '14', '16', '18', '20', '24', '28', '32'];
// 字体族命名值 → 显示名；'default' 为「默认/系统」（清除行内 mark，回退块主题）。
const FONT_FAMILIES: [string, string][] = [
  ['default', '默认 / 系统'], ['serif', '衬线'], ['monospace', '等宽'], ['heiti', '黑体'], ['kaiti', '楷体'],
];

// 下拉菜单项（行选择）通用样式。
const MENU_ITEM = 'w-full text-left px-2.5 h-[28px] rounded-md bg-transparent border-0 appearance-none '
  + 'text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer inline-flex items-center whitespace-nowrap '
  + 'hover:bg-[var(--rte-chrome-hover)]';
// 颜色/高亮面板底部 hex 输入。
const HEX_INPUT = 'mt-1.5 w-full h-[26px] px-2 rounded-md border border-[var(--rte-overlay-border)] '
  + 'bg-transparent text-[var(--rte-chrome-fg)] text-[12px] outline-none focus:border-[var(--rte-accent)] '
  + 'placeholder:text-[var(--rte-muted)] tabular-nums';

// active：浅蓝 wash 底 + 蓝前景（important 压过同层基础类的 transparent / chrome-fg）
function setOn(el: HTMLElement, on: boolean): void {
  el.classList.toggle('bg-[var(--rte-active-bg)]!', on);
  el.classList.toggle('text-[var(--rte-active-fg)]!', on);
}

// 所有下拉面板的关闭器；单一 document 监听实现「点外部即关」。
const closers: Array<() => void> = [];
function closeAllPanels(): void { for (const c of closers) c(); }
let docClickBound = false;

/**
 * 在宿主元素内构建工具栏 DOM 并绑定句柄，返回可刷新的工具栏句柄。
 * @public
 */
export function createToolbar(host: HTMLElement, h: ToolbarHandlers): Toolbar {
  host.className = HOST;
  host.innerHTML = '';
  if (!docClickBound) { docClickBound = true; document.addEventListener('mousedown', closeAllPanels); }

  // —— 基础构件 ——
  const grp = (): HTMLDivElement => { const g = document.createElement('div'); g.className = GROUP; host.appendChild(g); return g; };
  const wrap = (fn: () => void) => (e: Event) => { e.preventDefault(); fn(); h.focusEditor(); };
  const iconBtn = (name: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = BTN; b.title = title; b.type = 'button';
    b.setAttribute('aria-label', title);
    b.innerHTML = icon(name);
    return b;
  };

  // 通用下拉：触发钮 + 面板（panel 由 fill 填充）。withChevron=true 时带小三角并自适应宽度。
  const makeDropdown = (
    triggerIcon: string, title: string,
    fill: (panel: HTMLElement, close: () => void) => void, withChevron = true,
  ): HTMLDivElement => {
    const box = document.createElement('div'); box.className = 'relative inline-flex';
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.title = title; trigger.setAttribute('aria-label', title);
    trigger.className = BTN + (withChevron ? ' w-auto px-1.5 gap-0.5' : '');
    trigger.innerHTML = withChevron ? icon(triggerIcon) + icon('chevron-down', 12) : icon(triggerIcon);
    const panel = document.createElement('div'); panel.className = PANEL;
    const close = (): void => panel.classList.add('hidden');
    closers.push(close);
    trigger.onmousedown = (e) => e.stopPropagation(); // 不让 document 关闭逻辑提前触发
    trigger.onclick = (e) => {
      e.preventDefault();
      const wasOpen = !panel.classList.contains('hidden');
      closeAllPanels();
      if (!wasOpen) panel.classList.remove('hidden');
    };
    panel.onmousedown = (e) => e.stopPropagation(); // 面板内交互不关闭
    fill(panel, close);
    box.append(trigger, panel);
    return box;
  };

  // 文本标签下拉：触发钮显示当前值（如字号/字体族），返回 setLabel 供 refresh 回填。
  const makeLabelDropdown = (
    initialLabel: string, title: string, minW: string,
    fill: (panel: HTMLElement, close: () => void) => void,
  ): { box: HTMLDivElement; setLabel: (s: string) => void } => {
    const box = document.createElement('div'); box.className = 'relative inline-flex';
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.title = title; trigger.setAttribute('aria-label', title);
    trigger.className = BTN + ` w-auto ${minW} px-2 gap-1 justify-between text-[13px]`;
    const label = document.createElement('span'); label.className = 'truncate'; label.textContent = initialLabel;
    trigger.append(label);
    trigger.insertAdjacentHTML('beforeend', icon('chevron-down', 12));
    const panel = document.createElement('div'); panel.className = PANEL;
    const close = (): void => panel.classList.add('hidden');
    closers.push(close);
    trigger.onmousedown = (e) => e.stopPropagation();
    trigger.onclick = (e) => {
      e.preventDefault();
      const wasOpen = !panel.classList.contains('hidden');
      closeAllPanels();
      if (!wasOpen) panel.classList.remove('hidden');
    };
    panel.onmousedown = (e) => e.stopPropagation();
    fill(panel, close);
    box.append(trigger, panel);
    return { box, setLabel: (s: string) => { label.textContent = s; } };
  };

  // 颜色面板填充：swatch 网格 + 清除项
  const swatchFill = (onPick: (hex: string | null) => void) => (panel: HTMLElement, close: () => void): void => {
    const grid = document.createElement('div'); grid.className = 'grid grid-cols-4 gap-1.5';
    for (const c of SWATCHES) {
      const s = document.createElement('button');
      s.type = 'button'; s.className = SWATCH; s.style.background = c; s.title = c;
      s.onclick = (e) => { e.preventDefault(); onPick(c); close(); h.focusEditor(); };
      grid.appendChild(s);
    }
    const clearItem = document.createElement('button');
    clearItem.type = 'button';
    clearItem.className = 'mt-1.5 w-full h-[26px] rounded-md border border-[var(--rte-overlay-border)] '
      + 'bg-transparent text-[var(--rte-chrome-fg)] text-[12px] cursor-pointer inline-flex items-center '
      + 'justify-center gap-1 whitespace-nowrap hover:bg-[var(--rte-chrome-hover)]';
    clearItem.innerHTML = icon('x', 13) + '<span>清除</span>';
    clearItem.onclick = (e) => { e.preventDefault(); onPick(null); close(); h.focusEditor(); };
    // 自定义 hex 输入：回车应用（parseHex 在 model 层校验非法值回退）
    const hex = document.createElement('input');
    hex.type = 'text'; hex.className = HEX_INPUT; hex.placeholder = '#2563eb'; hex.spellcheck = false;
    hex.setAttribute('aria-label', '自定义十六进制颜色');
    hex.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = hex.value.trim();
      if (v) { onPick(v); hex.value = ''; close(); h.focusEditor(); }
    };
    panel.append(grid, hex, clearItem);
  };

  // 行选择菜单填充：options=[value,label][] + 可选清除项；onPick(value|null)。
  const menuFill = (
    options: [string, string][], onPick: (value: string | null) => void,
    clearLabel: string | null,
  ) => (panel: HTMLElement, close: () => void): void => {
    panel.classList.add('min-w-[120px]', 'flex', 'flex-col', 'gap-0.5');
    for (const [value, label] of options) {
      const item = document.createElement('button');
      item.type = 'button'; item.className = MENU_ITEM; item.textContent = label;
      item.dataset.value = value;
      item.onclick = (e) => { e.preventDefault(); onPick(value); close(); h.focusEditor(); };
      panel.appendChild(item);
    }
    if (clearLabel) {
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = MENU_ITEM + ' mt-0.5 border-t border-[var(--rte-overlay-border)] rounded-none text-[var(--rte-muted)]';
      clr.textContent = clearLabel;
      clr.onclick = (e) => { e.preventDefault(); onPick(null); close(); h.focusEditor(); };
      panel.appendChild(clr);
    }
  };

  // 表格网格选择器填充：悬停高亮 N 行 × M 列，点击插入（替代「填 3x3 文本」）
  const tableGridFill = (onPick: (rows: number, cols: number) => void) => (panel: HTMLElement, close: () => void): void => {
    const COLS = 10, ROWS = 8;
    const label = document.createElement('div');
    label.className = 'text-[12px] text-[var(--rte-muted)] text-center mb-1.5 tabular-nums';
    label.textContent = '选择尺寸';
    const grid = document.createElement('div');
    grid.className = 'grid gap-[3px]'; grid.style.gridTemplateColumns = `repeat(${COLS}, 16px)`;
    const cells: HTMLDivElement[] = [];
    const CELL = 'w-4 h-4 rounded-[2px] border ';
    const paint = (r: number, c: number): void => {
      for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
        const on = i <= r && j <= c;
        cells[i * COLS + j].className = CELL + (on
          ? 'border-[var(--rte-accent)] bg-[var(--rte-active-bg)]'
          : 'border-[var(--rte-overlay-border)] bg-transparent');
      }
      label.textContent = `${r + 1} 行 × ${c + 1} 列`;
    };
    for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
      const cell = document.createElement('div');
      cell.className = CELL + 'border-[var(--rte-overlay-border)] cursor-pointer';
      cell.onmouseenter = () => paint(i, j);
      cell.onclick = (e) => { e.preventDefault(); onPick(i + 1, j + 1); close(); h.focusEditor(); };
      cells.push(cell); grid.appendChild(cell);
    }
    panel.append(label, grid);
  };

  // —— 1. 历史 ——
  const g1 = grp();
  const undo = iconBtn('undo-2', '撤销 ⌘Z'); const redo = iconBtn('redo-2', '重做 ⌘⇧Z');
  undo.onclick = wrap(h.undo); redo.onclick = wrap(h.redo); g1.append(undo, redo);

  // —— 2. 块类型（带图标的单选按钮组）——
  const g2 = grp();
  const blockDefs: [string, string, string][] = [
    ['paragraph', 'pilcrow', '正文 ⌘⌥0'],
    ['heading1', 'heading-1', '标题 1 ⌘⌥1'], ['heading2', 'heading-2', '标题 2 ⌘⌥2'],
    ['heading3', 'heading-3', '标题 3 ⌘⌥3'], ['heading4', 'heading-4', '标题 4 ⌘⌥4'],
    ['heading5', 'heading-5', '标题 5 ⌘⌥5'], ['heading6', 'heading-6', '标题 6 ⌘⌥6'],
    ['bullet_item', 'list', '项目符号 ⌘⌥8'], ['ordered_item', 'list-ordered', '编号列表 ⌘⌥9'],
    ['task_item', 'list-checks', '任务列表 ⌘⌥T'],
    ['blockquote', 'quote', '引用 ⌘⌥Q'], ['code_block', 'square-code', '代码块'],
  ];
  const blockBtns: Record<string, HTMLButtonElement> = {};
  for (const [val, ic, title] of blockDefs) {
    const b = iconBtn(ic, title); b.setAttribute('aria-pressed', 'false');
    b.onclick = wrap(() => h.setBlock(val)); blockBtns[val] = b; g2.appendChild(b);
  }

  // —— 2b. 字体族 + 字号（行内 mark 覆盖块主题）——
  const gFont = grp();
  const familyLabelOf = (v: string): string => FONT_FAMILIES.find(([val]) => val === v)?.[1] ?? FONT_FAMILIES[0][1];
  const familyDD = makeLabelDropdown(
    FONT_FAMILIES[0][1], '字体族', 'min-w-[92px]',
    menuFill(FONT_FAMILIES, (v) => h.setFontFamily(v), null),
  );
  const sizeDD = makeLabelDropdown(
    '19', '字号', 'min-w-[58px]',
    menuFill(FONT_SIZES.map((s) => [s, s] as [string, string]), (v) => h.setFontSize(v), '默认字号'),
  );
  gFont.append(familyDD.box, sizeDD.box);

  // —— 3. 行内 marks ——
  const g3 = grp();
  const markDefs: [string, string, string][] = [
    ['bold', 'bold', '粗体 ⌘B'], ['italic', 'italic', '斜体 ⌘I'], ['underline', 'underline', '下划线 ⌘U'],
    ['strikethrough', 'strikethrough', '删除线'], ['code', 'code', '行内代码'],
  ];
  const markBtns: Record<string, HTMLButtonElement> = {};
  for (const [type, ic, title] of markDefs) {
    const b = iconBtn(ic, title); b.onclick = wrap(() => h.toggleMark(type)); markBtns[type] = b; g3.appendChild(b);
  }
  const supBtn = iconBtn('superscript', '上标'); supBtn.onclick = wrap(h.toggleSuperscript); g3.appendChild(supBtn);
  const subBtn = iconBtn('subscript', '下标'); subBtn.onclick = wrap(h.toggleSubscript); g3.appendChild(subBtn);
  const linkBtn = iconBtn('link', '链接 ⌘K'); linkBtn.onclick = wrap(h.toggleLink); g3.appendChild(linkBtn);

  // —— 4. 颜色 / 高亮 / 清除格式 ——
  const g4 = grp();
  g4.appendChild(makeDropdown('baseline', '文字颜色', swatchFill(h.setColor)));
  g4.appendChild(makeDropdown('highlighter', '高亮颜色', swatchFill(h.setHighlight)));
  const clearFmt = iconBtn('eraser', '清除格式'); clearFmt.onclick = wrap(h.clearFormat); g4.appendChild(clearFmt);

  // —— 5. 段落：对齐 + 文字方向 ——
  const g5 = grp();
  const alignDefs: [string, string, string][] = [
    ['left', 'align-left', '左对齐 ⌘⇧L'], ['center', 'align-center', '居中 ⌘E'], ['right', 'align-right', '右对齐 ⌘⇧R'],
  ];
  const alignBtns: Record<string, HTMLButtonElement> = {};
  for (const [a, ic, title] of alignDefs) {
    const b = iconBtn(ic, title); b.onclick = wrap(() => h.setAlign(a)); alignBtns[a] = b; g5.appendChild(b);
  }
  const dirBtn = iconBtn('arrow-left-right', '文字方向 LTR / RTL ⌘⇧D'); dirBtn.onclick = wrap(h.toggleDir); g5.appendChild(dirBtn);

  // —— 6. 插入 ——
  const g6 = grp();
  const imgBtn = iconBtn('image', '插入图片'); imgBtn.onclick = wrap(h.insertImage);
  const fxBtn = iconBtn('sigma', '插入公式 (KaTeX / LaTeX)'); fxBtn.onclick = wrap(h.insertFormula);
  const tblDropdown = makeDropdown('table', '插入表格', tableGridFill(h.insertTable), false);
  g6.append(imgBtn, fxBtn, tblDropdown);

  // —— 7. 右侧：整形器 + 导出 ——
  const spacer = document.createElement('div'); spacer.className = 'flex-1'; host.appendChild(spacer);
  const g7 = grp();
  const shaperBtn = document.createElement('button');
  shaperBtn.type = 'button'; shaperBtn.className = BTN + ' w-auto px-2 gap-1';
  shaperBtn.title = '整形器 Canvas / HarfBuzz · F2（HarfBuzz：阿拉伯/希伯来等复杂连字整形）';
  shaperBtn.onclick = wrap(h.toggleShaper);
  const importBtn = document.createElement('button');
  importBtn.type = 'button'; importBtn.className = BTN + ' w-auto px-2 gap-1';
  importBtn.title = '导入 Markdown / HTML（粘贴文本，替换当前文档）';
  importBtn.innerHTML = icon('file-input') + '<span class="text-[12px]">导入</span>';
  importBtn.onclick = wrap(h.importDoc);
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button'; exportBtn.className = BTN + ' w-auto px-2 gap-1';
  exportBtn.title = '导出 HTML / Markdown / JSON';
  exportBtn.innerHTML = icon('download') + '<span class="text-[12px]">导出</span>';
  exportBtn.onclick = wrap(h.exportDoc);
  g7.append(shaperBtn, importBtn, exportBtn);

  return {
    refresh(s: ToolbarState): void {
      undo.disabled = !s.canUndo; redo.disabled = !s.canRedo;
      for (const [val, b] of Object.entries(blockBtns)) {
        const on = s.blockValue === val; setOn(b, on); b.setAttribute('aria-pressed', String(on));
      }
      for (const [type, b] of Object.entries(markBtns)) setOn(b, !!s.marks[type]);
      setOn(supBtn, !!s.marks.superscript); setOn(subBtn, !!s.marks.subscript);
      setOn(linkBtn, !!s.marks.link);
      sizeDD.setLabel(s.fontSize);
      familyDD.setLabel(familyLabelOf(s.fontFamily));
      for (const [a, b] of Object.entries(alignBtns)) setOn(b, s.align === a);
      setOn(dirBtn, s.dir === 'rtl');
      shaperBtn.innerHTML = icon('languages') + `<span class="text-[12px]">${s.shaperShort}</span>`;
    },
  };
}
