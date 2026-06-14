// ui 层：全局悬停提示（hover tooltip）。为带 data-tip-* 的元素显示「名称 + 快捷键 + 用法说明」浮层。
// 比原生 title 更快出现、可样式化、可多行；亮色主题用 --rte-* 令牌。事件委托到 document，
// 与具体控件结构解耦——任何调用 attachTooltip 的元素都会自动获得提示。
// 分层：纯 DOM 控件，不依赖 model。

/** 一条提示的内容：名称、可选快捷键、可选一句话用法说明。 @public */
export interface TooltipSpec {
  title: string;
  shortcut?: string;
  desc?: string;
}

/**
 * 给元素附加 tooltip 数据（由全局提示层读取展示），并同步原生 `title` 作为无障碍/兜底。
 * @public
 */
export function attachTooltip(el: HTMLElement, spec: TooltipSpec): void {
  el.dataset.tipTitle = spec.title;
  if (spec.shortcut) el.dataset.tipKey = spec.shortcut; else delete el.dataset.tipKey;
  if (spec.desc) el.dataset.tipDesc = spec.desc; else delete el.dataset.tipDesc;
  el.title = spec.shortcut ? `${spec.title} ${spec.shortcut}` : spec.title;
}

let installed = false;

/**
 * 安装全局悬停提示层（幂等）：委托监听 document，悬停带 `data-tip-title` 的元素延时后显示浮层。
 * @param delay 悬停到显示的延时（ms），默认 350。
 * @public
 */
export function installTooltips(delay = 350): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  const tip = document.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.style.cssText = 'position:fixed;z-index:90;max-width:260px;padding:7px 10px;border-radius:7px;'
    + 'background:var(--rte-overlay-bg,#fff);color:var(--rte-text,#1f2430);'
    + 'border:1px solid var(--rte-overlay-border,#e3e5e9);box-shadow:var(--rte-shadow,0 8px 24px rgba(15,17,23,.12));'
    + 'font:12px/1.45 system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .12s;display:none';
  document.body.appendChild(tip);

  let timer = 0;
  let cur: HTMLElement | null = null;

  const hide = (): void => {
    cur = null;
    if (timer) { clearTimeout(timer); timer = 0; }
    tip.style.opacity = '0';
    tip.style.display = 'none';
  };

  const show = (el: HTMLElement): void => {
    const title = el.dataset.tipTitle ?? '';
    if (!title) return;
    tip.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;font-weight:600;white-space:nowrap';
    const t = document.createElement('span'); t.textContent = title; head.appendChild(t);
    if (el.dataset.tipKey) {
      const k = document.createElement('span'); k.textContent = el.dataset.tipKey;
      k.style.cssText = 'margin-left:auto;color:var(--rte-muted,#6b7280);font-weight:500;font-size:11px';
      head.appendChild(k);
    }
    tip.appendChild(head);
    if (el.dataset.tipDesc) {
      const d = document.createElement('div'); d.textContent = el.dataset.tipDesc;
      d.style.cssText = 'margin-top:3px;color:var(--rte-muted,#6b7280);white-space:normal';
      tip.appendChild(d);
    }
    // 先显示量尺寸，再贴元素下方并夹到视口内（下方放不下则翻到上方）
    tip.style.display = 'block'; tip.style.opacity = '0';
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let x = Math.max(6, Math.min(r.left, window.innerWidth - tr.width - 6));
    let y = r.bottom + 6;
    if (y + tr.height > window.innerHeight - 6) y = r.top - tr.height - 6;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    requestAnimationFrame(() => { if (cur === el) tip.style.opacity = '1'; });
  };

  document.addEventListener('mouseover', (e) => {
    const t = e.target as HTMLElement | null;
    const el = t && t.closest ? (t.closest('[data-tip-title]') as HTMLElement | null) : null;
    if (!el || el === cur) return;
    cur = el;
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => { if (cur === el) show(el); }, delay);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target as HTMLElement | null;
    const el = t && t.closest ? t.closest('[data-tip-title]') : null;
    if (el && el === cur) hide();
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
}
