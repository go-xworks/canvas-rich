import { Doc } from '../model/schema';
import { toHtml, toMarkdown, toJson } from '../model/export';

// 导出面板（Tailwind 工具类）：HTML / Markdown / JSON，可复制。
// 分层：ui（呈现层，调用 model/export 渲染文本，不修改文档）。
type Fmt = 'html' | 'md' | 'json';

const TAB =
  'px-3 py-1.5 rounded-md bg-transparent border-0 appearance-none text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer hover:bg-[var(--rte-chrome-hover)]';
const TAB_ON = 'bg-[var(--rte-active-bg)]! text-[var(--rte-active-fg)]!';
const ACT =
  'px-3 py-1.5 rounded-md border border-[var(--rte-overlay-border)] bg-transparent text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer appearance-none hover:bg-[var(--rte-chrome-hover)]';

/**
 * 导出面板句柄：以指定文档打开面板并渲染当前格式；销毁（移除 body 门户节点 + document 监听）。
 * @internal
 */
export interface OutputPanel {
  open(doc: Doc): void;
  destroy(): void;
}

/**
 * 创建模态导出面板（HTML/Markdown/JSON 切换 + 复制 + 关闭），关闭时回调 onClosed。
 * @internal
 */
export function createOutputPanel(onClosed: () => void): OutputPanel {
  const wrap = document.createElement('div');
  wrap.className = 'fixed inset-0 bg-[var(--rte-scrim)] hidden items-center justify-center z-[50]';
  const panel = document.createElement('div');
  panel.className =
    'w-[min(820px,92vw)] h-[min(70vh,640px)] bg-[var(--rte-overlay-bg)] border border-[var(--rte-overlay-border)] rounded-[10px] flex flex-col overflow-hidden font-sans text-[13px] text-[var(--rte-text)] shadow-[var(--rte-shadow)]';
  const header = document.createElement('div');
  header.className = 'flex items-center gap-1.5 px-3 py-2.5 border-b border-[var(--rte-chrome-border)]';
  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.spellcheck = false;
  ta.className =
    'flex-1 m-0 border-0 p-3 bg-[var(--rte-code-bg)] text-[var(--rte-code-text)] font-mono text-[12.5px] leading-[1.5] resize-none outline-none whitespace-pre overflow-auto';
  panel.append(header, ta);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);

  let curDoc: Doc | null = null;
  let fmt: Fmt = 'html';
  const render = () => {
    if (curDoc) ta.value = fmt === 'html' ? toHtml(curDoc) : fmt === 'md' ? toMarkdown(curDoc) : toJson(curDoc);
  };

  const tab = (f: Fmt, label: string) => {
    const b = document.createElement('button');
    b.className = TAB;
    b.textContent = label;
    b.onclick = () => {
      fmt = f;
      render();
      syncTabs();
    };
    return b;
  };
  const tabs: Record<Fmt, HTMLButtonElement> = {
    html: tab('html', 'HTML'),
    md: tab('md', 'Markdown'),
    json: tab('json', 'JSON'),
  };
  const syncTabs = () => {
    for (const f of Object.keys(tabs) as Fmt[]) tabs[f].className = TAB + (f === fmt ? ' ' + TAB_ON : '');
  };

  const copyBtn = document.createElement('button');
  copyBtn.className = ACT;
  copyBtn.textContent = '复制';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
      copyBtn.textContent = '已复制';
      setTimeout(() => (copyBtn.textContent = '复制'), 1200);
    } catch {
      ta.select();
      if (document.execCommand) document.execCommand('copy');
    }
  };
  const closeBtn = document.createElement('button');
  closeBtn.className = ACT;
  closeBtn.textContent = '关闭';
  const close = () => {
    wrap.classList.add('hidden');
    wrap.classList.remove('flex');
    onClosed();
  };
  closeBtn.onclick = close;
  const sp = document.createElement('div');
  sp.className = 'flex-1';
  header.append(tabs.html, tabs.md, tabs.json, sp, copyBtn, closeBtn);

  wrap.addEventListener('mousedown', (e) => {
    if (e.target === wrap) close();
  });
  const onDocKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !wrap.classList.contains('hidden')) close();
  };
  document.addEventListener('keydown', onDocKeyDown);

  return {
    open(doc: Doc) {
      curDoc = doc;
      render();
      syncTabs();
      wrap.classList.remove('hidden');
      wrap.classList.add('flex');
      ta.scrollTop = 0;
    },
    destroy() {
      document.removeEventListener('keydown', onDocKeyDown);
      wrap.remove();
    },
  };
}
