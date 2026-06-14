/**
 * 布局命中辅助（editor 层）：caret affinity 判定、块纵向边界、块间隙落点（拖拽重排）、
 * 目录行 / 任务勾选栏命中。自 main.ts 下沉的纯函数 —— 全部显式入参
 * （layout / doc / resolver / padL / scale），不携带任何闭包状态，便于单测。
 * 坐标契约：px / cy 均为布局坐标（设备 px，cy 已加 scrollY 的内容纵坐标）。
 */
import type { Doc } from '../model/schema';
import type { Pos } from '../model/rich-document';
import type { StyleResolver } from '../model/style-resolver';
import type { DocLayout, LineBox } from '../text/doc-layout';

/**
 * 命中落点的 caret affinity：落在某行的 endOffset 且同块存在以该 offset 起始的
 * 下一行（软换行点）→ `'before'`（光标贴上一行行尾），否则 `'after'`。
 * @param layout - 当前布局（null 安全：无布局时恒 `'after'`）
 * @param pos - 命中得到的文档位置
 * @param ln - 命中点最近的布局行（可空）
 * @public
 */
export function affinityAt(layout: DocLayout | null, pos: Pos, ln: LineBox | null): 'before' | 'after' {
  if (
    layout &&
    ln &&
    pos.offset === ln.endOffset &&
    layout.lines.some((l) => l.block === ln.block && l !== ln && l.startOffset === pos.offset)
  )
    return 'before';
  return 'after';
}

/**
 * 块 b 的内容纵向边界（设备 px）：取该块全部布局行的 top 最小 / bottom 最大。
 * 块无任何行（或无布局）时返回 null。
 * @public
 */
export function blockBounds(layout: DocLayout | null, b: number): { top: number; bottom: number } | null {
  if (!layout) return null;
  let top = Infinity,
    bottom = -Infinity;
  for (const l of layout.lines)
    if (l.block === b) {
      top = Math.min(top, l.top);
      bottom = Math.max(bottom, l.bottom);
    }
  return isFinite(top) ? { top, bottom } : null;
}

/**
 * 纵坐标 pyDevice（内容坐标，设备 px）命中的「块间隙」号：落在块 b 垂直中线之上
 * → 间隙 b（插到 b 前）；全部块之下 → blockCount（插到末块后）。拖拽重排落点用。
 * @public
 */
export function gapAtY(layout: DocLayout | null, blockCount: number, pyDevice: number): number {
  for (let b = 0; b < blockCount; b++) {
    const bb = blockBounds(layout, b);
    if (bb && pyDevice < (bb.top + bb.bottom) / 2) return b;
  }
  return blockCount;
}

/**
 * 块间隙号 → 落点指示线的纵坐标（内容坐标，设备 px）：间隙 g < blockCount 取块 g 的
 * top，末间隙取末块 bottom；无布局信息回退 0。
 * @public
 */
export function gapYDevice(layout: DocLayout | null, blockCount: number, gap: number): number {
  const bb = gap >= blockCount ? blockBounds(layout, blockCount - 1) : blockBounds(layout, gap);
  return bb ? (gap >= blockCount ? bb.bottom : bb.top) : 0;
}

/**
 * 命中目录(toc)块生成的标题行（携带 tocTarget）→ 返回目标 heading 块号，否则 -1。
 * @param cy - 内容纵坐标（设备 px，已加滚动偏移）
 * @public
 */
export function tocLineHit(layout: DocLayout | null, cy: number): number {
  if (!layout) return -1;
  for (const ln of layout.lines) {
    if (ln.tocTarget === undefined) continue;
    if (cy >= ln.top && cy <= ln.bottom) return ln.tocTarget;
  }
  return -1;
}

/**
 * 命中任务列表项的 checkbox 标记（首行、内容左侧的标记栏）→ 返回块下标，否则 -1。
 * @param doc - 当前文档（按行回查块类型）
 * @param resolver - 样式解析器（取块 indent，逻辑 px）
 * @param padL - 当前布局左内边距（设备 px）
 * @param scale - 有效渲染比例（dpr×zoom；indent 逻辑 px → ×scale 进布局坐标系）
 * @public
 */
export function taskCheckboxHit(
  layout: DocLayout | null,
  doc: Doc,
  resolver: StyleResolver,
  padL: number,
  scale: number,
  px: number,
  cy: number,
): number {
  if (!layout) return -1;
  for (const ln of layout.lines) {
    if (cy < ln.top || cy > ln.bottom) continue;
    const blk = doc.blocks[ln.block];
    if (!blk || blk.type !== 'task_item') continue;
    // 仅首行有标记；标记画在内容左侧（x0 = contentLeft + indent）的标记栏内
    const isFirstLine = ln.startOffset === 0;
    if (!isFirstLine) continue;
    const x0 = padL + resolver.resolveBlock(blk).indent * scale;
    if (px < x0) return ln.block;
    return -1;
  }
  return -1;
}
