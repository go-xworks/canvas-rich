import { Doc } from '../model/schema';
import { docStats } from '../model/doc-stats';

// 底部状态栏（Tailwind 工具类）：段落数 / 字数 / 可交互缩放（− / 百分比 / ＋）/ 视图模式名。
// 分层：ui（呈现层，调用 model/doc-stats 只读统计；缩放经 hooks 回调装配层，自身不持有缩放状态）。

/**
 * 状态栏的交互回调：缩放步进与复位由装配层实现（clamp / 重排 / 重栅都在装配层）。
 * @internal
 */
export interface StatusBarHooks {
  /** 缩放步进：deltaPct 为百分比增量（如 +10 / -10）。 */
  onZoomDelta(deltaPct: number): void;
  /** 缩放复位到 100%。 */
  onZoomReset(): void;
}

/**
 * 状态栏句柄：以最新文档、缩放百分比与视图模式名刷新展示。
 * @internal
 */
export interface StatusBar {
  /** 刷新状态栏。zoom 为缩放百分比（如 100 表示 100%）；view 为视图模式标签（网页/页面）。 */
  update(doc: Doc, zoom: number, view?: string): void;
  /** 设置保存指示：true=已保存（草稿已落盘），false=未保存（有未落盘变更，脏标记）。 */
  setSaveState(saved: boolean): void;
}

const SEG = 'inline-flex items-center gap-1 text-[12px] text-[var(--rte-muted)]';
const VAL = 'text-[var(--rte-chrome-fg)] tabular-nums';
// 缩放小按钮（−/＋/百分比）：方形透明底，hover 提亮，不抢编辑器焦点。
const ZBTN = 'w-[20px] h-[20px] rounded bg-transparent border-0 appearance-none cursor-pointer '
  + 'inline-flex items-center justify-center text-[13px] leading-none text-[var(--rte-chrome-fg)] '
  + 'hover:bg-[var(--rte-chrome-hover)]';

/**
 * 创建底部状态栏：挂入 host，显示段落数 / 字数 / 缩放（可交互步进与复位）/ 视图模式。
 * @internal
 */
export function createStatusBar(host: HTMLElement, hooks: StatusBarHooks): StatusBar {
  const bar = document.createElement('div');
  bar.className = 'flex items-center gap-4 px-3 h-7 bg-[var(--rte-chrome-bg)] border-t border-[var(--rte-chrome-border)] select-none';

  const seg = (label: string): { wrap: HTMLDivElement; val: HTMLSpanElement } => {
    const wrap = document.createElement('div'); wrap.className = SEG;
    const lab = document.createElement('span'); lab.textContent = label;
    const val = document.createElement('span'); val.className = VAL;
    wrap.append(lab, val);
    return { wrap, val };
  };
  const zoomBtn = (text: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = ZBTN; b.textContent = text; b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // 不让点击夺走 ime 焦点
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    return b;
  };

  const paras = seg('段落');
  const words = seg('字数');
  // 保存指示（简洁小字）：已保存=弱化灰；未保存=强调色脏标记（自动保存 debounce 期间/写入失败时）。
  const save = document.createElement('span');
  save.className = 'inline-flex items-center text-[12px] text-[var(--rte-muted)]';
  save.textContent = '已保存';
  // 缩放控件：−（-10%）/ 百分比（点击回 100%）/ ＋（+10%）。
  const zoomWrap = document.createElement('div'); zoomWrap.className = SEG;
  const zoomLab = document.createElement('span'); zoomLab.textContent = '缩放';
  const minus = zoomBtn('−', '缩小 10%（⌘-）', () => hooks.onZoomDelta(-10));
  const pct = zoomBtn('100%', '恢复 100%（⌘0）', () => hooks.onZoomReset());
  pct.className = ZBTN + ' w-auto px-1 text-[12px] tabular-nums';
  const plus = zoomBtn('＋', '放大 10%（⌘+）', () => hooks.onZoomDelta(10));
  zoomWrap.append(zoomLab, minus, pct, plus);
  const sp = document.createElement('div'); sp.className = 'flex-1';
  const view = seg('视图');
  bar.append(paras.wrap, words.wrap, save, zoomWrap, sp, view.wrap);
  host.appendChild(bar);

  return {
    update(doc: Doc, zoomPct: number, viewMode = '网页') {
      const s = docStats(doc);
      paras.val.textContent = String(s.blocks);
      words.val.textContent = String(s.chars);
      pct.textContent = Math.round(zoomPct) + '%';
      view.val.textContent = viewMode;
    },
    setSaveState(saved: boolean) {
      save.textContent = saved ? '已保存' : '未保存';
      save.style.color = saved ? '' : 'var(--rte-accent)';
    },
  };
}
