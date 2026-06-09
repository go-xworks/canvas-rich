// 通用右键菜单（Tailwind 工具类）。show(x,y,items) 在坐标处弹出。
// 分层：ui（呈现层，纯 DOM 控件，不依赖 model）。

/**
 * 右键菜单项：可执行项（含禁用/勾选/快捷键提示）或分隔线。
 * @public
 */
export type MenuItem =
  | { label: string; action: () => void; disabled?: boolean; active?: boolean; key?: string }
  | { separator: true };

/**
 * 右键菜单句柄：在坐标处弹出、隐藏、查询开合状态。
 * @public
 */
export interface ContextMenu { show(x: number, y: number, items: MenuItem[]): void; hide(): void; isOpen(): boolean }

const MENU = 'fixed min-w-[184px] bg-[var(--rte-overlay-bg)] border border-[var(--rte-overlay-border)] rounded-lg p-1 ' +
  'shadow-[var(--rte-shadow)] text-[13px] font-sans text-[var(--rte-text)] z-[60] hidden';
const ITEM = 'flex items-center gap-2 px-2.5 py-1.5 rounded-[5px] whitespace-nowrap';
const ITEM_ON = 'cursor-pointer hover:bg-[var(--rte-active-bg)] hover:text-[var(--rte-active-fg)]';
const ITEM_OFF = 'opacity-40 cursor-default';

/**
 * 创建挂到 document.body 的右键菜单，自动处理外点/Esc/失焦关闭与边界翻转定位。
 * @public
 */
export function createContextMenu(): ContextMenu {
  const menu = document.createElement('div'); menu.className = MENU; document.body.appendChild(menu);

  const hide = () => menu.classList.add('hidden');
  const isOpen = () => !menu.classList.contains('hidden');

  document.addEventListener('mousedown', (e) => { if (isOpen() && !menu.contains(e.target as Node)) hide(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('blur', hide);

  return {
    isOpen, hide,
    show(x, y, items) {
      menu.innerHTML = '';
      for (const it of items) {
        if ('separator' in it) {
          const s = document.createElement('div'); s.className = 'h-px my-1 mx-1.5 bg-[var(--rte-chrome-border)]'; menu.appendChild(s); continue;
        }
        const el = document.createElement('div');
        el.className = ITEM + ' ' + (it.disabled ? ITEM_OFF : ITEM_ON);
        const chk = document.createElement('span'); chk.className = 'w-[14px] text-center opacity-90'; chk.textContent = it.active ? '✓' : '';
        const lbl = document.createElement('span'); lbl.textContent = it.label;
        el.append(chk, lbl);
        if (it.key) { const k = document.createElement('span'); k.className = 'ml-auto opacity-60 text-[12px]'; k.textContent = it.key; el.appendChild(k); }
        if (!it.disabled) el.onmousedown = (e) => { e.preventDefault(); hide(); it.action(); };
        menu.appendChild(el);
      }
      menu.classList.remove('hidden');
      const w = menu.offsetWidth, hgt = menu.offsetHeight;
      menu.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - hgt - 6) + 'px';
    },
  };
}
