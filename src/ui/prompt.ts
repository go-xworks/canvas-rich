// 应用内输入弹层（ui 层）：替代原生 window.prompt/alert/confirm。
// 亮色主题（--rte-* 变量）、Promise 返回、Enter 确认 / Esc 取消 / 点遮罩关闭、role=dialog 可达。
// 分层：纯 DOM 控件，不依赖 model。

/** ask 的参数：标题、默认值、占位、确定按钮文案、是否多行（LaTeX 等）。 @internal */
export interface PromptOptions {
  title: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  multiline?: boolean;
}

/** 输入弹层句柄：弹出并解析为用户输入（取消返回 null）；销毁（移除 body 门户节点）。 @internal */
export interface PromptDialog {
  ask(opts: PromptOptions): Promise<string | null>;
  destroy(): void;
}

/**
 * 创建挂到 document.body 的单例输入弹层，返回可重复调用的 ask()。
 * @internal
 */
export function createPromptDialog(): PromptDialog {
  const scrim = document.createElement('div');
  scrim.className = 'fixed inset-0 bg-[var(--rte-scrim)] hidden items-center justify-center z-[70]';
  const card = document.createElement('div');
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
  card.className = 'w-[min(440px,92vw)] bg-[var(--rte-overlay-bg)] border border-[var(--rte-overlay-border)] '
    + 'rounded-[10px] shadow-[var(--rte-shadow)] flex flex-col overflow-hidden font-sans';
  const titleEl = document.createElement('div');
  titleEl.className = 'px-4 pt-4 pb-2 text-[14px] font-medium text-[var(--rte-text)]';
  const body = document.createElement('div'); body.className = 'px-4';
  const footer = document.createElement('div'); footer.className = 'px-4 py-3 flex justify-end gap-2';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.textContent = '取消';
  cancelBtn.className = 'px-3 py-1.5 rounded-md border border-[var(--rte-overlay-border)] bg-transparent '
    + 'text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer appearance-none hover:bg-[var(--rte-chrome-hover)]';
  const okBtn = document.createElement('button');
  okBtn.type = 'button'; okBtn.textContent = '确定';
  okBtn.className = 'px-3.5 py-1.5 rounded-md border-0 bg-[var(--rte-accent)] text-white text-[13px] '
    + 'cursor-pointer appearance-none hover:opacity-90';
  footer.append(cancelBtn, okBtn);
  card.append(titleEl, body, footer);
  scrim.appendChild(card);
  document.body.appendChild(scrim);

  let resolver: ((v: string | null) => void) | null = null;
  let field: HTMLInputElement | HTMLTextAreaElement | null = null;

  const close = (v: string | null): void => {
    if (!resolver) return;
    const r = resolver; resolver = null;
    scrim.classList.add('hidden'); scrim.classList.remove('flex');
    body.innerHTML = ''; field = null;
    r(v);
  };

  cancelBtn.onclick = (e) => { e.preventDefault(); close(null); };
  okBtn.onclick = (e) => { e.preventDefault(); close(field ? field.value : null); };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(null); });

  return {
    ask(opts: PromptOptions): Promise<string | null> {
      if (resolver) close(null); // 已有打开的先取消
      return new Promise<string | null>((resolve) => {
        resolver = resolve;
        titleEl.textContent = opts.title;
        okBtn.textContent = opts.okLabel ?? '确定';
        body.innerHTML = '';
        const f: HTMLInputElement | HTMLTextAreaElement =
          opts.multiline ? document.createElement('textarea') : document.createElement('input');
        f.value = opts.value ?? '';
        if (opts.placeholder) f.placeholder = opts.placeholder;
        f.spellcheck = false;
        f.setAttribute('aria-label', opts.title);
        const base = 'w-full px-2.5 py-2 rounded-md border border-[var(--rte-overlay-border)] '
          + 'bg-[var(--rte-canvas)] text-[var(--rte-text)] text-[13px] outline-none appearance-none '
          + 'focus:border-[var(--rte-accent)]';
        if (opts.multiline) {
          (f as HTMLTextAreaElement).rows = 3;
          f.className = base + ' font-mono resize-none leading-[1.5]';
        } else {
          (f as HTMLInputElement).type = 'text';
          f.className = base + ' h-[34px]';
        }
        f.onkeydown = (e) => {
          e.stopPropagation(); // 不让编辑器键盘逻辑介入
          if (e.key === 'Escape') { e.preventDefault(); close(null); }
          else if (e.key === 'Enter' && (!opts.multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); close(f.value); }
        };
        body.appendChild(f);
        field = f;
        scrim.classList.remove('hidden'); scrim.classList.add('flex');
        // rAF：在工具栏 wrap 的同步 focusEditor 之后再抢焦点；选中默认值便于直接覆盖
        requestAnimationFrame(() => { f.focus(); if (f.value) f.select(); });
      });
    },
    destroy() {
      close(null); // 解决可能挂起的 ask（避免悬空 Promise）
      scrim.remove();
    },
  };
}
