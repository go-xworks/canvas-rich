// 工具栏构件渲染器（ui 层）：8 个 kind → Renderer（item + ctx → MountedItem）+ 共享 DOM 构件函数
// （图标钮 / 通用下拉 / 标签下拉 / 数字输入 + 各类面板填充器）。对 h/closers/focusEditor/icon 的依赖经
// 显式 ToolbarContext 注入。DOM 结构与类令牌逐字搬自 src/ui/toolbar.original.ts，视觉零变化。
import { icon } from '../icons';
import {
  BTN, BTN_TEXT, PANEL, SWATCH, MENU_ITEM, HEX_INPUT, SWATCHES, BLOCK_DEFS, setOn,
} from './tokens';
import type {
  ToolbarContext, ToolbarState, ToolbarItem, MountedItem, Renderer, ItemKind,
  IconButtonItem, TextButtonItem, LabelDropdownItem, ColorDropdownItem,
  GridDropdownItem, MenuDropdownItem, TemplateDropdownItem, NumInputItem,
} from './types';

/** 构建方形图标按钮（28px）：BTN 类 + title + aria-label + 内联图标。 @internal */
export function iconBtn(name: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = BTN; b.title = title; b.type = 'button';
  b.setAttribute('aria-label', title);
  b.innerHTML = icon(name);
  return b;
}

/**
 * 通用下拉：触发钮 + 面板（panel 由 fill 填充）。withChevron=true 时带小三角并自适应宽度。
 * 返回 { box, trigger }：box 为挂载容器，trigger 暴露给 refresh 用于 active 态切换。
 * @internal
 */
export function makeDropdown(
  ctx: ToolbarContext,
  triggerIcon: string, title: string,
  fill: (panel: HTMLElement, close: () => void) => void, withChevron = true,
): { box: HTMLDivElement; trigger: HTMLButtonElement } {
  const box = document.createElement('div'); box.className = 'relative inline-flex';
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.title = title; trigger.setAttribute('aria-label', title);
  trigger.className = BTN + (withChevron ? ' w-auto px-1.5 gap-0.5' : '');
  trigger.innerHTML = withChevron ? icon(triggerIcon) + icon('chevron-down', 12) : icon(triggerIcon);
  const panel = document.createElement('div'); panel.className = PANEL;
  const close = (): void => panel.classList.add('hidden');
  ctx.registerCloser(close);
  trigger.onmousedown = (e) => e.stopPropagation(); // 不让 document 关闭逻辑提前触发
  trigger.onclick = (e) => {
    e.preventDefault();
    const wasOpen = !panel.classList.contains('hidden');
    ctx.closeAllPanels();
    if (!wasOpen) panel.classList.remove('hidden');
  };
  panel.onmousedown = (e) => e.stopPropagation(); // 面板内交互不关闭
  fill(panel, close);
  box.append(trigger, panel);
  return { box, trigger };
}

/**
 * 文本标签下拉：触发钮显示当前值（如字号/字体族），返回 setLabel 供 refresh 回填。
 * @internal
 */
export function makeLabelDropdown(
  ctx: ToolbarContext,
  initialLabel: string, title: string, minW: string,
  fill: (panel: HTMLElement, close: () => void) => void,
): { box: HTMLDivElement; setLabel: (s: string) => void } {
  const box = document.createElement('div'); box.className = 'relative inline-flex';
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.title = title; trigger.setAttribute('aria-label', title);
  trigger.className = BTN + ` w-auto ${minW} px-2 gap-1 justify-between text-[13px]`;
  const label = document.createElement('span'); label.className = 'truncate'; label.textContent = initialLabel;
  trigger.append(label);
  trigger.insertAdjacentHTML('beforeend', icon('chevron-down', 12));
  const panel = document.createElement('div'); panel.className = PANEL;
  const close = (): void => panel.classList.add('hidden');
  ctx.registerCloser(close);
  trigger.onmousedown = (e) => e.stopPropagation();
  trigger.onclick = (e) => {
    e.preventDefault();
    const wasOpen = !panel.classList.contains('hidden');
    ctx.closeAllPanels();
    if (!wasOpen) panel.classList.remove('hidden');
  };
  panel.onmousedown = (e) => e.stopPropagation();
  fill(panel, close);
  box.append(trigger, panel);
  return { box, setLabel: (s: string) => { label.textContent = s; } };
}

/** 颜色面板填充：swatch 网格 + hex 输入 + 清除项。 @internal */
export function swatchFill(
  ctx: ToolbarContext, onPick: (hex: string | null) => void,
) {
  return (panel: HTMLElement, close: () => void): void => {
    const grid = document.createElement('div'); grid.className = 'grid grid-cols-4 gap-1.5';
    for (const c of SWATCHES) {
      const s = document.createElement('button');
      s.type = 'button'; s.className = SWATCH; s.style.background = c; s.title = c;
      s.onclick = (e) => { e.preventDefault(); onPick(c); close(); ctx.focusEditor(); };
      grid.appendChild(s);
    }
    const clearItem = document.createElement('button');
    clearItem.type = 'button';
    clearItem.className = 'mt-1.5 w-full h-[26px] rounded-md border border-[var(--rte-overlay-border)] '
      + 'bg-transparent text-[var(--rte-chrome-fg)] text-[12px] cursor-pointer inline-flex items-center '
      + 'justify-center gap-1 whitespace-nowrap hover:bg-[var(--rte-chrome-hover)]';
    clearItem.innerHTML = icon('x', 13) + '<span>清除</span>';
    clearItem.onclick = (e) => { e.preventDefault(); onPick(null); close(); ctx.focusEditor(); };
    // 自定义 hex 输入：回车应用（parseHex 在 model 层校验非法值回退）
    const hex = document.createElement('input');
    hex.type = 'text'; hex.className = HEX_INPUT; hex.placeholder = '#2563eb'; hex.spellcheck = false;
    hex.setAttribute('aria-label', '自定义十六进制颜色');
    hex.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = hex.value.trim();
      if (v) { onPick(v); hex.value = ''; close(); ctx.focusEditor(); }
    };
    panel.append(grid, hex, clearItem);
  };
}

/** 行选择菜单填充：options=[value,label][] + 可选清除项；onPick(value|null)。 @internal */
export function menuFill(
  ctx: ToolbarContext,
  options: [string, string][], onPick: (value: string | null) => void,
  clearLabel: string | null,
) {
  return (panel: HTMLElement, close: () => void): void => {
    panel.classList.add('min-w-[120px]', 'flex', 'flex-col', 'gap-0.5');
    for (const [value, label] of options) {
      const item = document.createElement('button');
      item.type = 'button'; item.className = MENU_ITEM; item.textContent = label;
      item.dataset.value = value;
      item.onclick = (e) => { e.preventDefault(); onPick(value); close(); ctx.focusEditor(); };
      panel.appendChild(item);
    }
    if (clearLabel) {
      const clr = document.createElement('button');
      clr.type = 'button';
      clr.className = MENU_ITEM + ' mt-0.5 border-t border-[var(--rte-overlay-border)] rounded-none text-[var(--rte-muted)]';
      clr.textContent = clearLabel;
      clr.onclick = (e) => { e.preventDefault(); onPick(null); close(); ctx.focusEditor(); };
      panel.appendChild(clr);
    }
  };
}

/** 块类型行选择菜单（带图标的下拉项）。onPick(val) 派发块类型命令。 @internal */
export function blockMenuFill(ctx: ToolbarContext, onPick: (value: string) => void) {
  return (panel: HTMLElement, close: () => void): void => {
    panel.classList.add('min-w-[150px]', 'flex', 'flex-col', 'gap-0.5');
    for (const [val, ic, , short] of BLOCK_DEFS) {
      const item = document.createElement('button');
      item.type = 'button'; item.className = MENU_ITEM + ' gap-2';
      item.dataset.value = val;
      item.innerHTML = icon(ic, 16) + `<span>${short}</span>`;
      item.onclick = (e) => { e.preventDefault(); onPick(val); close(); ctx.focusEditor(); };
      panel.appendChild(item);
    }
  };
}

/** 表格网格选择器填充：悬停高亮 N 行 × M 列，点击插入。 @internal */
export function tableGridFill(
  ctx: ToolbarContext, onPick: (rows: number, cols: number) => void,
) {
  return (panel: HTMLElement, close: () => void): void => {
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
      cell.onclick = (e) => { e.preventDefault(); onPick(i + 1, j + 1); close(); ctx.focusEditor(); };
      cells.push(cell); grid.appendChild(cell);
    }
    panel.append(label, grid);
  };
}

/** 模板下拉填充：每次打开按 templateNames() 重建项；末尾「设为模板…」。 @internal */
export function tplFill(ctx: ToolbarContext) {
  return (panel: HTMLElement, close: () => void): void => {
    panel.classList.add('min-w-[150px]', 'flex', 'flex-col', 'gap-0.5');
    const rebuild = (): void => {
      panel.innerHTML = '';
      for (const name of ctx.templateNames()) {
        const item = document.createElement('button');
        item.type = 'button'; item.className = MENU_ITEM; item.textContent = name;
        item.onclick = (e) => { e.preventDefault(); ctx.exec('template.apply', name); close(); ctx.focusEditor(); };
        panel.appendChild(item);
      }
      const save = document.createElement('button');
      save.type = 'button';
      save.className = MENU_ITEM + ' mt-0.5 border-t border-[var(--rte-overlay-border)] rounded-none gap-2 text-[var(--rte-accent)]';
      save.innerHTML = icon('save', 15) + '<span>设为模板…</span>';
      save.onclick = (e) => { e.preventDefault(); close(); ctx.exec('template.save'); };
      panel.appendChild(save);
    };
    rebuild();
    (panel as HTMLElement & { rebuild?: () => void }).rebuild = rebuild;
  };
}

/**
 * 紧凑数字输入（段前/段后/字距）：失焦或回车提交，px；前缀小标签 + 末尾单位。
 * 返回 { box, setValue }：setValue 供 refresh 切块时回填当前块数值（不抢正在编辑的焦点）。
 * @internal
 */
export function numInput(
  ctx: ToolbarContext,
  label: string, title: string, onCommit: (px: number) => void,
): { box: HTMLDivElement; setValue: (px: number) => void } {
  const box = document.createElement('div');
  box.className = 'inline-flex items-center gap-1 h-[26px] px-1.5 rounded-md '
    + 'border border-[var(--rte-overlay-border)] focus-within:border-[var(--rte-accent)]';
  const tag = document.createElement('span');
  tag.className = 'text-[11px] text-[var(--rte-muted)] whitespace-nowrap'; tag.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '0'; inp.step = '1'; inp.title = title;
  inp.setAttribute('aria-label', title);
  inp.className = 'w-[34px] h-full bg-transparent text-[var(--rte-chrome-fg)] text-[12px] '
    + 'outline-none border-0 tabular-nums text-right';
  const unit = document.createElement('span');
  unit.className = 'text-[11px] text-[var(--rte-muted)]'; unit.textContent = 'px';
  const commit = (): void => {
    const n = parseFloat(inp.value);
    if (Number.isFinite(n)) { onCommit(Math.max(0, n)); ctx.focusEditor(); }
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  inp.onchange = commit;
  inp.onmousedown = (e) => e.stopPropagation();
  box.append(tag, inp, unit);
  // 回填：仅在该输入未聚焦时改值，避免覆盖用户正在键入的内容。
  const setValue = (px: number): void => {
    if (document.activeElement === inp) return;
    const next = String(Math.round(px));
    if (inp.value !== next) inp.value = next;
  };
  return { box, setValue };
}

// ============================================================
//  8 个 kind → Renderer（item + ctx → MountedItem）
// ============================================================

/**
 * 图标命令钮渲染器：active 走 setOn（蓝 wash）；disabled 走原生 el.disabled（不可用 setOn，
 * 否则画成蓝 wash 改视觉）。无 active/disabled 谓词则不带 refresh（核心遍历自动跳过）。
 * @internal
 */
export function renderIconButton(item: IconButtonItem, ctx: ToolbarContext): MountedItem {
  const b = iconBtn(item.iconName, item.title);
  b.onclick = ctx.wrap(() => ctx.exec(item.command, item.arg));
  const { active, disabled } = item;
  const refresh = (active || disabled)
    ? (s: ToolbarState): void => {
      if (disabled) b.disabled = disabled(s);
      if (active) setOn(b, active(s));
    }
    : undefined;
  return { el: b, refresh };
}

/**
 * 文字命令钮渲染器：BTN_TEXT 类。refresh 顺序钉死——先 dynamic 设 innerHTML 再 active 设 class
 * （class 在 root、innerHTML 改子节点，互不吞）。无 dynamic/active 则不带 refresh。
 * @internal
 */
export function renderTextButton(item: TextButtonItem, ctx: ToolbarContext): MountedItem {
  const b = document.createElement('button');
  b.type = 'button'; b.className = item.className ?? BTN_TEXT;
  b.title = item.title; b.setAttribute('aria-label', item.title);
  // 初始内容：dynamic 控件由 refresh 回填；静态控件按 iconName + text 装配。
  if (!item.dynamic) {
    b.innerHTML = (item.iconName ? ctx.icon(item.iconName) : '')
      + (item.text != null ? `<span>${item.text}</span>` : '');
  }
  b.onclick = ctx.wrap(() => ctx.exec(item.command));
  const { dynamic, active } = item;
  const refresh = (dynamic || active)
    ? (s: ToolbarState): void => {
      if (dynamic) b.innerHTML = dynamic(s, ctx.icon).html; // 先 innerHTML
      if (active) setOn(b, active(s));                      // 再 class
    }
    : undefined;
  return { el: b, refresh };
}

/**
 * 文本标签下拉渲染器：withIcons=true（块类型）走带 icon 的项渲染，否则纯文字 menuFill（可选 clear）。
 * refresh 调 labelOf 回填触发钮文本。
 * @internal
 */
export function renderLabelDropdown(item: LabelDropdownItem, ctx: ToolbarContext): MountedItem {
  const fill = item.withIcons
    ? blockMenuFill(ctx, (v) => ctx.exec(item.command, v))
    : menuFill(ctx, item.options, (v) => ctx.exec(item.command, v), item.clearLabel ?? null);
  const dd = makeLabelDropdown(ctx, item.initialLabel, item.title, item.minW, fill);
  return {
    el: dd.box,
    refresh: (s) => dd.setLabel(item.labelOf(s)),
  };
}

/**
 * 颜色下拉渲染器：触发钮带 chevron（makeDropdown 默认 withChevron=true，绝不可设 false）。
 * 触发钮 active 随 isActive。
 * @internal
 */
export function renderColorDropdown(item: ColorDropdownItem, ctx: ToolbarContext): MountedItem {
  const dd = makeDropdown(ctx, item.iconName, item.title, swatchFill(ctx, (hex) => ctx.exec(item.command, hex)));
  return {
    el: dd.box,
    refresh: (s) => setOn(dd.trigger, item.isActive(s)),
  };
}

/**
 * 网格下拉渲染器：表格 8×10，触发钮 withChevron=false（仅 icon）。无 refresh。
 * @internal
 */
export function renderGridDropdown(item: GridDropdownItem, ctx: ToolbarContext): MountedItem {
  const dd = makeDropdown(
    ctx, item.iconName, item.title,
    tableGridFill(ctx, (rows, cols) => ctx.exec(item.command, { rows, cols })), false,
  );
  return { el: dd.box };
}

/**
 * 菜单下拉渲染器：形状（shapes 图标，withChevron=false）。无 refresh。
 * 项点击派发 ctx.exec(item.command, opt.value)；图标/标签照 item.items（由 SHAPE_DEFS 派生）。
 * @internal
 */
export function renderMenuDropdown(item: MenuDropdownItem, ctx: ToolbarContext): MountedItem {
  const fill = (panel: HTMLElement, close: () => void): void => {
    panel.classList.add('min-w-[140px]', 'flex', 'flex-col', 'gap-0.5');
    for (const opt of item.items) {
      const el = document.createElement('button');
      el.type = 'button'; el.className = MENU_ITEM + ' gap-2';
      el.innerHTML = (opt.iconName ? ctx.icon(opt.iconName, 16) : '') + `<span>${opt.label}</span>`;
      el.onclick = (e) => { e.preventDefault(); ctx.exec(item.command, opt.value); close(); ctx.focusEditor(); };
      panel.appendChild(el);
    }
  };
  const dd = makeDropdown(ctx, item.triggerIcon, item.title, fill, item.withChevron);
  return { el: dd.box };
}

/**
 * 模板下拉渲染器：tplFill（运行时重建）+ 双监听两段式时序——trigger 先 makeDropdown.onclick
 * (toggle hidden)，再额外 addEventListener('click') 在面板已打开时 rebuild()。不可合并成单 onclick。
 * 无 refresh。
 * @internal
 */
export function renderTemplateDropdown(item: TemplateDropdownItem, ctx: ToolbarContext): MountedItem {
  const dd = makeDropdown(ctx, item.triggerIcon, item.title, tplFill(ctx), false);
  // 打开下拉时刷新模板列表（用户模板可能在运行中新增）。保留源两段式时序。
  dd.trigger.addEventListener('click', () => {
    const panel = dd.box.querySelector('.absolute') as (HTMLElement & { rebuild?: () => void }) | null;
    if (panel && !panel.classList.contains('hidden')) panel.rebuild?.();
  });
  return { el: dd.box };
}

/**
 * 紧凑数字输入渲染器：聚焦守卫在 numInput.setValue 内（activeElement===inp 时 return）。
 * refresh 调 valueOf 回填当前块数值。
 * @internal
 */
export function renderNumInput(item: NumInputItem, ctx: ToolbarContext): MountedItem {
  const ni = numInput(ctx, item.label, item.numTitle, (px) => ctx.exec(item.command, px));
  return {
    el: ni.box,
    refresh: (s) => ni.setValue(item.valueOf(s)),
  };
}

/**
 * kind → Renderer 穷举映射：缺一种 kind 编译不过（[K in ItemKind] 强制补齐）。
 * 第三方引入新 kind 时先扩本表，再 register。
 * @internal
 */
export const RENDERERS: { [K in ItemKind]: Renderer<Extract<ToolbarItem, { kind: K }>> } = {
  'icon-button': renderIconButton,
  'text-button': renderTextButton,
  'label-dropdown': renderLabelDropdown,
  'color-dropdown': renderColorDropdown,
  'grid-dropdown': renderGridDropdown,
  'menu-dropdown': renderMenuDropdown,
  'template-dropdown': renderTemplateDropdown,
  'num-input': renderNumInput,
};
