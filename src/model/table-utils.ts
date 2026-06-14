import { CellMerge, TableCell } from './schema';
import { clamp } from '../shared/util';

/**
 * 表格纯工具：列数统计 / 合并矩形规范化 / 合并区相交判定 + 最小尺寸常量。
 * 位于 model 层，无副作用、只读入参，供 rich-document（编辑操作）与 ui/overlays（拖拽/合并交互）复用。
 * 从 rich-document.ts 抽出，使表格几何计算与编辑模型解耦、便于独立单测。
 */

/** 表格单元格/列宽/行高的最小尺寸（逻辑 px）。拖拽与合并 clamp 共用。 @public */
export const MIN_CELL_PX = 24;

/** 取表格的列数（按最宽行，容忍参差行长）。 @public */
export function tableColCount(rows: TableCell[][]): number {
  let n = 0;
  for (const row of rows) if (row.length > n) n = row.length;
  return n;
}

/**
 * 规范化合并矩形：min/max 排序两端点、clamp 到 [0,rowCount)×[0,colCount)，
 * 返回锚点在左上的 CellMerge；表格为空（行/列为 0）时返回 null。 @public
 */
export function normalizeRect(
  r0: number, c0: number, r1: number, c1: number, rowCount: number, colCount: number,
): CellMerge | null {
  if (rowCount <= 0 || colCount <= 0) return null;
  const rt = clamp(Math.min(r0, r1), 0, rowCount - 1);
  const rb = clamp(Math.max(r0, r1), 0, rowCount - 1);
  const cl = clamp(Math.min(c0, c1), 0, colCount - 1);
  const cr = clamp(Math.max(c0, c1), 0, colCount - 1);
  return { r: rt, c: cl, rowspan: rb - rt + 1, colspan: cr - cl + 1 };
}

/** 判定两个合并区的矩形是否相交（用于合并时剔除被卷入的旧区，维持互不重叠不变量）。 @public */
export function mergesIntersect(a: CellMerge, b: CellMerge): boolean {
  return a.r < b.r + b.rowspan && b.r < a.r + a.rowspan
    && a.c < b.c + b.colspan && b.c < a.c + a.colspan;
}

/**
 * 导出/渲染前的合并区防御：丢弃锚点越界（含负数）的合并区，行/列跨度 clamp 到表格边界内（≥1）。
 * rows 与 merges 不一致（历史文档/外部直接构造）时，避免产出 colspan/rowspan 超出表格的破损
 * HTML，或把不存在的格子标记为「被覆盖」而吞掉真实单元格。返回新数组（不改入参）。 @public
 */
export function sanitizeMerges(merges: CellMerge[], rowCount: number, colCount: number): CellMerge[] {
  const out: CellMerge[] = [];
  for (const m of merges) {
    if (m.r < 0 || m.c < 0 || m.r >= rowCount || m.c >= colCount) continue;
    out.push({
      r: m.r, c: m.c,
      rowspan: clamp(m.rowspan, 1, rowCount - m.r),
      colspan: clamp(m.colspan, 1, colCount - m.c),
    });
  }
  return out;
}

// —— 增删行列时的合并区调整（纯函数，无副作用；不依赖具体 rows 内容）——
// 约定：插入在「索引 at 之前」插一条新行/列（原 at 及之后整体后移一位）；删除移除索引 at 的整行/列。
// 退化为 1×1 的合并区在调整后被丢弃（与 mergeCells 不记录 1×1 的不变量一致）。

/**
 * 在第 `at` 行前插入一行后，调整合并区集合。
 * 锚点在插入位置及之后的合并区，锚点行 +1（整体下移）；
 * 插入位置落在合并区行跨度「内部」（anchor < at ≤ anchor+rowspan-1）的，rowspan +1（被撑开）；
 * 其余不变。返回新数组（不改入参）。 @public
 */
export function adjustMergesOnInsertRow(merges: CellMerge[], at: number): CellMerge[] {
  return merges.map((m) => {
    if (at <= m.r) return { ...m, r: m.r + 1 };               // 插在锚点上方/同行：整体下移
    if (at < m.r + m.rowspan) return { ...m, rowspan: m.rowspan + 1 }; // 插在跨度内部：撑高一行
    return { ...m };                                          // 插在合并区下方：不变
  });
}

/**
 * 删除第 `at` 行后，调整合并区集合。
 * 删除行在合并区上方（at < anchor）的，锚点行 -1；
 * 落在合并区行跨度内（anchor ≤ at < anchor+rowspan）的，rowspan -1（被删掉一行）；
 * 调整后退化为 1×1 的合并区被丢弃。其余不变。返回新数组（不改入参）。 @public
 */
export function adjustMergesOnDeleteRow(merges: CellMerge[], at: number): CellMerge[] {
  const out: CellMerge[] = [];
  for (const m of merges) {
    let { r, rowspan } = m;
    if (at < r) r -= 1;                                       // 删在锚点上方：整体上移
    else if (at < r + rowspan) rowspan -= 1;                  // 删在跨度内（含锚点行）：收缩一行
    if (rowspan >= 1 && (rowspan > 1 || m.colspan > 1)) out.push({ ...m, r, rowspan }); // 丢弃退化为 1×1 的区
  }
  return out;
}

/**
 * 在第 `at` 列前插入一列后，调整合并区集合（与 {@link adjustMergesOnInsertRow} 列向对称）。
 * 锚点在插入位置及之后的，锚点列 +1；插入落在列跨度内部的，colspan +1；其余不变。 @public
 */
export function adjustMergesOnInsertCol(merges: CellMerge[], at: number): CellMerge[] {
  return merges.map((m) => {
    if (at <= m.c) return { ...m, c: m.c + 1 };
    if (at < m.c + m.colspan) return { ...m, colspan: m.colspan + 1 };
    return { ...m };
  });
}

/**
 * 删除第 `at` 列后，调整合并区集合（与 {@link adjustMergesOnDeleteRow} 列向对称）。
 * 删在锚点左侧的锚点列 -1；落在列跨度内的 colspan -1；调整后退化为 1×1 的丢弃。 @public
 */
export function adjustMergesOnDeleteCol(merges: CellMerge[], at: number): CellMerge[] {
  const out: CellMerge[] = [];
  for (const m of merges) {
    let { c, colspan } = m;
    if (at < c) c -= 1;                                       // 删在锚点左侧：整体左移
    else if (at < c + colspan) colspan -= 1;                  // 删在跨度内（含锚点列）：收缩一列
    if (colspan >= 1 && (colspan > 1 || m.rowspan > 1)) out.push({ ...m, c, colspan }); // 丢弃退化为 1×1 的区
  }
  return out;
}
