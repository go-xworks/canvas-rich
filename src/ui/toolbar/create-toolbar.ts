// 工具栏工厂（ui 层）：构 ctx → 建 tabbar / 3 ribbon / selectTab / underline 外壳 → 遍历声明式清单
// TOOLBAR_GROUPS（RENDERERS 渲染 + 按 tab→group→row 落位 + 收 refresh 句柄）→ refresh 退化为
// 「for (const r of handles) r(s)」一视同仁 → enrichTooltips(host) → trailing 导出钮常驻页签栏右端。
// DOM 结构与装配顺序逐字照搬 src/ui/toolbar.original.ts，行为/视觉零变化；对外契约 createToolbar/Toolbar 稳定。
import { icon } from '../icons';
import { HOST, TABBAR, TAB, TAB_ON, RIBBON, GROUP, GROUP_ROWS, ROW, GROUP_NAME, TAB_DEFS } from './tokens';
import { enrichTooltips } from './tooltips';
import { RENDERERS } from './renderers';
import { TOOLBAR_GROUPS } from './toolbar-items';
import type {
  ToolbarState, Toolbar, ToolbarContext, ToolbarItem, MountedItem, GroupSpec, ToolbarTab, ToolbarCommandArg,
} from './types';

/**
 * 装配层注入工具栏的最小命令面：派发命名命令 + 回焦 + 模板名拉取。
 * 取代旧 ToolbarHandlers 胖接口（40 方法）；与 editor/commands.CommandContext 结构兼容（取其子集）。
 * @internal
 */
export interface ToolbarDeps {
  /** 派发命名命令（经统一命令总线 → editor/commands）。 */
  exec(id: string, arg?: ToolbarCommandArg): void;
  /** 把焦点交还编辑器。 */
  focusEditor(): void;
  /** 当前可选模板名列表（模板下拉打开时重建项拉取）。 */
  templateNames(): string[];
}

/** 三个 ribbon 页签键（trailing 不建 ribbon，单独常驻页签栏）。 */
const RIBBON_TABS: ToolbarTab[] = ['start', 'insert', 'view'];

// 所有下拉面板的关闭器；单一 document 监听实现「点外部即关」。逐字搬自源（模块级 + 每次 createToolbar 重置）。
const closers: Array<() => void> = [];
function closeAllPanels(): void { for (const c of closers) c(); }
let docClickBound = false;

/**
 * 在宿主元素内构建工具栏 DOM 并绑定句柄，返回可刷新 / 可运行时追加控件 / 可销毁的工具栏句柄。
 * @param host - 工具栏宿主元素（其 className/innerHTML 会被接管）
 * @param deps - 装配层注入的命令面（exec/focusEditor/templateNames）
 * @param manifest - 声明式控件清单（默认 TOOLBAR_GROUPS，可注入自定义清单）
 * @internal
 */
export function createToolbar(
  host: HTMLElement, deps: ToolbarDeps, manifest: GroupSpec[] = TOOLBAR_GROUPS,
): Toolbar {
  host.className = HOST;
  host.innerHTML = '';
  closers.length = 0; // 重建工具栏时丢弃旧面板关闭器，避免悬挂引用（逐字搬自源）。
  if (!docClickBound) { docClickBound = true; document.addEventListener('mousedown', closeAllPanels); }

  // —— 渲染上下文：item 的点击/选值经 ctx.exec 派发命名命令（不再持行为 bag）——
  const ctx: ToolbarContext = {
    exec: deps.exec, focusEditor: deps.focusEditor, templateNames: deps.templateNames, icon,
    wrap: (fn) => (e) => { e.preventDefault(); fn(); deps.focusEditor(); },
    registerCloser: (close) => closers.push(close),
    closeAllPanels,
  };

  // —— 已挂载控件的刷新句柄（refresh 对其一视同仁遍历，不含任何控件知识）——
  const handles: Array<(s: ToolbarState) => void> = [];
  const mount = (item: ToolbarItem): MountedItem => {
    const m = RENDERERS[item.kind](item as never, ctx);
    if (m.refresh) handles.push(m.refresh);
    return m;
  };

  // —— Ribbon 外壳：每个页签一块面板（首块可见，其余 hidden）——
  const ribbons: Record<string, HTMLElement> = {};
  for (const tab of RIBBON_TABS) {
    const r = document.createElement('div');
    r.className = tab === 'start' ? RIBBON : RIBBON + ' hidden';
    ribbons[tab] = r;
  }

  // —— 遍历清单：按 tab→group→row 渲染并落位（顺序逐字照搬源两行布局）——
  // trailing 组（导出）不进 ribbon，单独收集供页签栏右端常驻。
  const trailingEls: HTMLElement[] = [];
  for (const g of manifest) {
    if (g.tab === 'trailing') {
      for (const item of g.rows.flat()) trailingEls.push(mount(item).el);
      continue;
    }
    const rowEls: HTMLElement[] = [];
    for (const itemRow of g.rows) {
      const r = document.createElement('div'); r.className = ROW;
      for (const item of itemRow) r.appendChild(mount(item).el);
      rowEls.push(r);
    }
    ribbons[g.tab].appendChild(makeGroupEl(rowEls, g.name));
  }

  // —— 页签栏（文字页签 + 右端常驻 trailing 控件）——
  const tabbar = document.createElement('div'); tabbar.className = TABBAR;
  tabbar.setAttribute('role', 'tablist');
  const tabBtns: Record<string, HTMLButtonElement> = {};
  let activeTab = 'start';
  const underline = (on: boolean): string => on
    ? '<span class="absolute left-2 right-2 -bottom-px h-[2px] rounded bg-[var(--rte-active-fg)]"></span>' : '';
  const selectTab = (key: string): void => {
    activeTab = key;
    for (const [k, btn] of Object.entries(tabBtns)) {
      const on = k === key;
      btn.className = TAB + (on ? ' ' + TAB_ON : '');
      btn.setAttribute('aria-selected', String(on));
      btn.querySelector('span.absolute')?.remove();
      if (on) btn.insertAdjacentHTML('beforeend', underline(true));
      ribbons[k].classList.toggle('hidden', !on);
    }
    closeAllPanels();
  };
  for (const [key, label] of TAB_DEFS) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = TAB; btn.textContent = label;
    btn.setAttribute('role', 'tab');
    btn.onmousedown = (e) => e.stopPropagation();
    btn.onclick = (e) => { e.preventDefault(); selectTab(key); };
    tabBtns[key] = btn; tabbar.appendChild(btn);
  }
  // 右端常驻：trailing 控件（导出，任意页签可见），前置 flex-1 spacer。
  const tabSpacer = document.createElement('div'); tabSpacer.className = 'flex-1';
  tabbar.append(tabSpacer, ...trailingEls);

  host.append(tabbar, ribbons.start, ribbons.insert, ribbons.view);
  selectTab(activeTab);
  enrichTooltips(host); // 把每个控件的 title 升级为「名称 + 快捷键 + 用法」悬停提示

  return {
    refresh(s: ToolbarState): void { for (const r of handles) r(s); },
    register(item): () => void {
      const m = RENDERERS[item.kind](item as never, ctx);
      const target = item.tab === 'trailing' ? tabbar : ribbons[item.tab] ?? tabbar;
      target.appendChild(m.el);
      enrichTooltips(target); // 追加项的 tooltip 升级（installTooltips/attachTooltip 幂等）
      if (m.refresh) handles.push(m.refresh);
      return () => {
        m.dispose?.();
        m.el.remove();
        if (m.refresh) { const i = handles.indexOf(m.refresh); if (i >= 0) handles.splice(i, 1); }
      };
    },
    destroy(): void { handles.length = 0; },
  };
}

/** 构建一个功能组：纵向容器内放任意行（el），可选底部组名小字。逐字搬自源 makeGroup。 */
function makeGroupEl(rows: HTMLElement[], name?: string): HTMLDivElement {
  const g = document.createElement('div'); g.className = GROUP;
  const col = document.createElement('div'); col.className = GROUP_ROWS;
  col.append(...rows);
  g.appendChild(col);
  if (name) { const n = document.createElement('div'); n.className = GROUP_NAME; n.textContent = name; g.appendChild(n); }
  return g;
}
