// 查找/替换浮条（ui 层）：⌘F 开启、Esc 关闭；输入即全文匹配（model/find 纯函数），
// 命中列表暴露给渲染帧画 canvas 高亮；Enter/⇧Enter 下/上一个命中（选中并滚入视口）；
// 替换当前/全部经 RichDoc.replaceTextRange / replaceAllTextRanges（单次撤销）。
// 分层：ui 外壳，消费 model 的纯函数与编辑原语，收尾回调由装配层注入。
import { RichDoc } from '../model/rich-document';
import { findMatches, FindMatch } from '../model/find';

/** 查找条的装配层注入面：模型 + 三类收尾回调。 @internal */
export interface FindBarDeps {
  /** 文档编辑模型（匹配读 doc，替换走单次撤销原语）。 */
  rd: RichDoc;
  /** 命中跳转收尾：光标滚入视口 + 重绘（不重排）。 */
  afterNav: () => void;
  /** 替换提交收尾：重排 + 广播（doc:changed）。 */
  afterEdit: () => void;
  /** 关闭后把焦点交还编辑器（IME 代理）。 */
  focusEditor: () => void;
  /** 命中集/当前命中变化（渲染帧需重绘高亮）。 */
  onMatchesChanged: () => void;
  /** 打印通路（⌘P 在浮条内按下时转调——原生打印对 canvas 正文输出空白，不可外溢给浏览器）。 */
  printDoc: () => void;
}

/** 查找条句柄：开关 + 命中查询（渲染帧画高亮）+ 文档变更后的命中重算。 @internal */
export interface FindBar {
  /** 打开查找条（可带初始查询，如当前选区文本），聚焦查询输入框并立即匹配。 */
  open(initialQuery?: string): void;
  /** 关闭查找条：清空命中、焦点交还编辑器。 */
  close(): void;
  /** 查找条是否打开。 */
  isOpen(): boolean;
  /** 当前命中列表（渲染帧画高亮用；未打开/空查询为空数组）。 */
  matches(): readonly FindMatch[];
  /** 当前命中下标（-1 = 无当前命中；渲染帧据此跳过当前命中的底色）。 */
  currentIndex(): number;
  /** 文档变更后重算命中（装配层 doc:changed 订阅调用；不移动选区）。 */
  refresh(): void;
  /** 跳到下一个命中（循环）。 */
  next(): void;
  /** 跳到上一个命中（循环）。 */
  prev(): void;
}

// 控件样式（--rte-* 主题变量，与 prompt/工具栏一致）。
const INPUT_CLS = 'h-[26px] px-2 rounded-md border border-[var(--rte-overlay-border)] '
  + 'bg-[var(--rte-canvas)] text-[var(--rte-text)] text-[12px] outline-none appearance-none '
  + 'focus:border-[var(--rte-accent)]';
const BTN_CLS = 'px-1.5 h-[24px] rounded border-0 bg-transparent text-[12px] text-[var(--rte-chrome-fg)] '
  + 'cursor-pointer appearance-none hover:bg-[var(--rte-chrome-hover)] disabled:opacity-40';

/**
 * 创建挂到 host（编辑器容器）右上角的查找/替换浮条，返回 {@link FindBar} 句柄。
 * @internal
 */
export function createFindBar(host: HTMLElement, deps: FindBarDeps): FindBar {
  const bar = document.createElement('div');
  bar.setAttribute('role', 'search');
  bar.setAttribute('aria-label', '查找与替换');
  bar.className = 'absolute top-2 right-6 z-40 hidden items-center gap-1 px-2 py-1.5 rounded-lg font-sans '
    + 'bg-[var(--rte-overlay-bg)] border border-[var(--rte-overlay-border)] shadow-[var(--rte-shadow)]';

  const queryInput = document.createElement('input');
  queryInput.type = 'text'; queryInput.placeholder = '查找'; queryInput.spellcheck = false;
  queryInput.setAttribute('aria-label', '查找');
  queryInput.className = INPUT_CLS + ' w-[150px]';
  const countEl = document.createElement('span');
  countEl.className = 'text-[11px] text-[var(--rte-muted)] min-w-[44px] text-center tabular-nums select-none';
  countEl.textContent = '0/0';
  const mkBtn = (label: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
    b.className = BTN_CLS;
    return b;
  };
  const prevBtn = mkBtn('↑', '上一个（⇧Enter）');
  const nextBtn = mkBtn('↓', '下一个（Enter）');
  const sep = document.createElement('span');
  sep.className = 'w-px h-[18px] bg-[var(--rte-overlay-border)] mx-0.5';
  const replaceInput = document.createElement('input');
  replaceInput.type = 'text'; replaceInput.placeholder = '替换为'; replaceInput.spellcheck = false;
  replaceInput.setAttribute('aria-label', '替换为');
  replaceInput.className = INPUT_CLS + ' w-[120px]';
  const replaceBtn = mkBtn('替换', '替换当前命中');
  const replaceAllBtn = mkBtn('全部', '全部替换（单次撤销）');
  const closeBtn = mkBtn('✕', '关闭（Esc）');
  bar.append(queryInput, countEl, prevBtn, nextBtn, sep, replaceInput, replaceBtn, replaceAllBtn, closeBtn);
  host.appendChild(bar);

  let openState = false;
  let query = '';
  let matches: FindMatch[] = [];
  let current = -1;

  const updateCount = (): void => {
    countEl.textContent = `${current >= 0 ? current + 1 : 0}/${matches.length}`;
  };

  // 重算命中（不移动选区）：当前下标越界则夹回，命中集变化通知重绘。
  const recompute = (): void => {
    matches = openState && query ? findMatches(deps.rd.doc, query) : [];
    if (current >= matches.length) current = matches.length - 1;
    updateCount();
    deps.onMatchesChanged();
  };

  // 跳到第 i 个命中（循环回绕）：选中命中区间（anchor=起点、focus=终点）并滚入视口。
  const jumpTo = (i: number): void => {
    if (matches.length === 0) { current = -1; updateCount(); deps.onMatchesChanged(); return; }
    current = ((i % matches.length) + matches.length) % matches.length;
    const m = matches[current];
    deps.rd.setSel({ block: m.block, offset: m.start });
    deps.rd.setSel({ block: m.block, offset: m.end }, true);
    updateCount();
    deps.afterNav();
    deps.onMatchesChanged();
  };

  // 从当前光标位置起的第一个命中（打开/改写查询时的初始定位）。
  const firstMatchFromCaret = (): number => {
    const { from } = deps.rd.range();
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (m.block > from.block || (m.block === from.block && m.start >= from.offset)) return i;
    }
    return 0;
  };

  const search = (): void => {
    recompute();
    if (matches.length) jumpTo(firstMatchFromCaret());
    else { current = -1; updateCount(); }
  };

  const replaceCurrent = (): void => {
    if (matches.length === 0) return;
    if (current < 0 || current >= matches.length) { jumpTo(firstMatchFromCaret()); return; }
    const idx = current;
    const m = matches[idx];
    deps.rd.replaceTextRange(m.block, m.start, m.end, replaceInput.value);
    deps.afterEdit(); // doc:changed → 装配层调 refresh() 重算命中
    jumpTo(idx); // 命中列表已缩一位：同下标即「下一个」
  };

  const replaceAll = (): void => {
    if (matches.length === 0) return;
    deps.rd.replaceAllTextRanges(matches, replaceInput.value);
    deps.afterEdit(); // refresh() 经 doc:changed 重算（通常清零）
  };

  const api: FindBar = {
    open(initialQuery) {
      openState = true;
      bar.classList.remove('hidden');
      bar.classList.add('flex');
      if (initialQuery) queryInput.value = initialQuery;
      query = queryInput.value;
      search();
      queryInput.focus();
      queryInput.select();
    },
    close() {
      if (!openState) return;
      openState = false;
      bar.classList.add('hidden');
      bar.classList.remove('flex');
      matches = [];
      current = -1;
      deps.onMatchesChanged();
      deps.focusEditor();
    },
    isOpen: () => openState,
    matches: () => matches,
    currentIndex: () => current,
    refresh: () => { if (openState && query) recompute(); },
    next: () => jumpTo(current + 1),
    prev: () => jumpTo(current - 1),
  };

  // —— 事件接线 ——
  queryInput.addEventListener('input', () => { query = queryInput.value; search(); });
  // 浮条内键盘不进编辑器；Esc 关闭对全条生效。⌘F/⌘P 在浮条内也接管并 preventDefault——
  // 焦点在查找/替换输入框时不得外溢给浏览器（原生查找条对 canvas 正文无效、原生打印输出空白，
  // 即缺陷 39/48 堵住的入口；焦点在编辑器时由 ime keydown 接管）：⌘F 重新聚焦查询框并全选，
  // ⌘P 转调注入的打印通路。
  bar.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      queryInput.focus();
      queryInput.select();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      deps.printDoc();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  });
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) api.prev(); else api.next(); }
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
  });
  prevBtn.addEventListener('click', () => api.prev());
  nextBtn.addEventListener('click', () => api.next());
  replaceBtn.addEventListener('click', () => replaceCurrent());
  replaceAllBtn.addEventListener('click', () => replaceAll());
  closeBtn.addEventListener('click', () => api.close());

  return api;
}
