import { Doc } from '../model/schema';
import { scanToc } from '../model/toc';

// 大纲面板（Tailwind 工具类）：列出文档全部 heading，按 level 缩进，点击跳转。
// 分层：ui（呈现层，调用 model/toc.scanToc 只读扫描，不修改文档）。

/**
 * 大纲面板句柄：以最新文档刷新 heading 列表。
 * @internal
 */
export interface Outline {
  update(doc: Doc): void;
}

/**
 * 大纲面板回调集合。
 * onJump：点击某条目时回调其 heading 块下标，宿主据此移动光标 / 滚入视口。
 * @internal
 */
export interface OutlineHooks {
  onJump(blockIndex: number): void;
}

const ITEM =
  'block w-full text-left bg-transparent border-0 appearance-none cursor-pointer rounded-md px-2 py-1 text-[13px] text-[var(--rte-chrome-fg)] truncate hover:bg-[var(--rte-chrome-hover)]';
const EMPTY = 'px-2 py-2 text-[12px] text-[var(--rte-muted)]';

/**
 * 创建大纲面板：挂入 host，扫描文档 heading 渲染可点击列表。
 * 列表按标题 level 左缩进；点击条目调用 onJump(blockIndex)。
 * 注意：只读扫描（scanToc(doc, false)），不给 heading 补 id，避免在面板刷新时产生文档副作用。
 * @internal
 */
export function createOutline(host: HTMLElement, hooks: OutlineHooks): Outline {
  const list = document.createElement('div');
  list.className = 'flex flex-col gap-0.5 p-1.5 overflow-auto';
  host.appendChild(list);

  return {
    update(doc: Doc) {
      const entries = scanToc(doc, false);
      list.replaceChildren();
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = EMPTY;
        empty.textContent = '暂无标题';
        list.appendChild(empty);
        return;
      }
      for (const e of entries) {
        const btn = document.createElement('button');
        btn.className = ITEM;
        btn.textContent = e.text || '（空标题）';
        btn.style.paddingLeft = 8 + (e.level - 1) * 12 + 'px';
        btn.title = e.text;
        btn.onclick = () => hooks.onJump(e.block);
        list.appendChild(btn);
      }
    },
  };
}
