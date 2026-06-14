import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import {
  MIN_CELL_PX,
  tableColCount,
  normalizeRect,
  mergesIntersect,
  sanitizeMerges,
  adjustMergesOnInsertRow,
  adjustMergesOnDeleteRow,
  adjustMergesOnInsertCol,
  adjustMergesOnDeleteCol,
} from '../table-utils';
import { Doc, Block, CellMerge, cellsFromStrings, cellText } from '../schema';

// —— helpers ——
// 富单元格迁移：构造仍用字符串二维数组（经 cellsFromStrings 升格），断言经 rowsText 摘回纯文本。
const tableBlock = (rows: string[][]): Block => ({
  type: 'table',
  attrs: { rows: cellsFromStrings(rows), id: 'tbl' },
  inlines: [{ kind: 'text', text: '', marks: [] }],
});
const rdWithTable = (rows: string[][]): RichDoc => new RichDoc({ blocks: [tableBlock(rows)] } as Doc);
const attrsOf = (rd: RichDoc) => rd.doc.blocks[0].attrs;
const rowsText = (rd: RichDoc): string[][] => (attrsOf(rd).rows ?? []).map((row) => row.map(cellText));

describe('tableColCount', () => {
  it('returns the widest row length (tolerates ragged rows)', () => {
    expect(tableColCount(cellsFromStrings([['a', 'b'], ['c']]))).toBe(2);
    expect(tableColCount([])).toBe(0);
  });
});

describe('normalizeRect', () => {
  it('orders endpoints into a top-left anchored rect', () => {
    expect(normalizeRect(2, 3, 0, 1, 5, 5)).toEqual({ r: 0, c: 1, rowspan: 3, colspan: 3 });
  });
  it('clamps out-of-range endpoints to the table bounds', () => {
    expect(normalizeRect(-2, -3, 99, 99, 3, 4)).toEqual({ r: 0, c: 0, rowspan: 3, colspan: 4 });
  });
  it('returns null for an empty table', () => {
    expect(normalizeRect(0, 0, 1, 1, 0, 0)).toBeNull();
    expect(normalizeRect(0, 0, 1, 1, 3, 0)).toBeNull();
  });
  it('a single cell yields a 1x1 rect', () => {
    expect(normalizeRect(1, 1, 1, 1, 3, 3)).toEqual({ r: 1, c: 1, rowspan: 1, colspan: 1 });
  });
});

describe('mergesIntersect', () => {
  const m = (r: number, c: number, rs: number, cs: number): CellMerge => ({ r, c, rowspan: rs, colspan: cs });
  it('detects overlapping rectangles', () => {
    expect(mergesIntersect(m(0, 0, 2, 2), m(1, 1, 2, 2))).toBe(true);
  });
  it('reports adjacent (non-overlapping) rectangles as disjoint', () => {
    expect(mergesIntersect(m(0, 0, 1, 2), m(0, 2, 1, 2))).toBe(false);
    expect(mergesIntersect(m(0, 0, 2, 1), m(2, 0, 2, 1))).toBe(false);
  });
});

describe('sanitizeMerges（导出/渲染前防御，集群3）', () => {
  const m = (r: number, c: number, rs: number, cs: number): CellMerge => ({ r, c, rowspan: rs, colspan: cs });

  it('passes in-range merges through unchanged (new objects, input untouched)', () => {
    const input = [m(0, 1, 2, 1)];
    const out = sanitizeMerges(input, 3, 3);
    expect(out).toEqual([m(0, 1, 2, 1)]);
    expect(out[0]).not.toBe(input[0]);
  });

  it('clamps spans that overflow the table bounds (and lifts spans < 1 to 1)', () => {
    expect(sanitizeMerges([m(1, 1, 9, 9)], 3, 4)).toEqual([m(1, 1, 2, 3)]);
    expect(sanitizeMerges([m(0, 0, 0, -2)], 2, 2)).toEqual([m(0, 0, 1, 1)]);
  });

  it('drops merges whose anchor lies outside the table (incl. negative)', () => {
    expect(sanitizeMerges([m(5, 0, 2, 2), m(0, 9, 1, 2), m(-1, 0, 2, 2)], 3, 3)).toEqual([]);
  });

  it('drops everything for an empty table', () => {
    expect(sanitizeMerges([m(0, 0, 2, 2)], 0, 0)).toEqual([]);
  });
});

describe('mergeCells', () => {
  it('normalizes the rect, joins non-empty contents into the anchor, clears others', () => {
    const rd = rdWithTable([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
      ['G', 'H', 'I'],
    ]);
    // pass endpoints out of order to exercise normalization
    rd.mergeCells(0, 1, 1, 0, 0);
    const a = attrsOf(rd);
    expect(a.merges).toEqual([{ r: 0, c: 0, rowspan: 2, colspan: 2 }]);
    // anchor holds joined non-empty cells (row-major), covered cells cleared
    expect(rowsText(rd)).toEqual([
      ['A B D E', '', 'C'],
      ['', '', 'F'],
      ['G', 'H', 'I'],
    ]);
  });

  it('ignores a degenerate 1x1 merge (records nothing, no snapshot)', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.mergeCells(0, 0, 0, 0, 0);
    expect(attrsOf(rd).merges).toBeUndefined();
    expect(rd.canUndo).toBe(false);
  });

  it('clamps endpoints beyond the table bounds before merging', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.mergeCells(0, 0, 0, 99, 99); // (0,0)..(1,1) after clamp → whole table
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 2, colspan: 2 }]);
    expect(rowsText(rd)).toEqual([
      ['A B C D', ''],
      ['', ''],
    ]);
  });

  it('removes an old merge that the new rect intersects (no overlap invariant)', () => {
    const rd = rdWithTable([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
      ['G', 'H', 'I'],
    ]);
    rd.mergeCells(0, 0, 0, 0, 1); // merge (0,0)-(0,1) horizontally
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 1, colspan: 2 }]);
    rd.mergeCells(0, 0, 0, 1, 1); // larger rect overlapping the first
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 2, colspan: 2 }]);
  });

  it('undo restores rows and merges to the pre-merge state', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    const before = rowsText(rd);
    rd.mergeCells(0, 0, 0, 1, 1);
    expect(attrsOf(rd).merges).toHaveLength(1);
    rd.undo();
    expect(attrsOf(rd).merges).toBeUndefined();
    expect(rowsText(rd)).toEqual(before);
  });

  it('does nothing on a non-table block', () => {
    const rd = new RichDoc({
      blocks: [{ type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'x', marks: [] }] }],
    } as Doc);
    rd.mergeCells(0, 0, 0, 1, 1);
    expect(rd.canUndo).toBe(false);
  });
});

describe('splitCell', () => {
  it('removes the merge at the anchor, restoring independent cells', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.mergeCells(0, 0, 0, 1, 1);
    expect(attrsOf(rd).merges).toHaveLength(1);
    rd.splitCell(0, 0, 0);
    expect(attrsOf(rd).merges).toEqual([]);
  });

  it('is a no-op (no snapshot) when (r,c) is not a merge anchor', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.mergeCells(0, 0, 0, 1, 1); // anchor at (0,0)
    const undoDepthBefore = rd.canUndo;
    rd.splitCell(0, 1, 1); // not an anchor
    expect(attrsOf(rd).merges).toHaveLength(1);
    expect(undoDepthBefore).toBe(true);
  });

  it('undo re-applies the merge after a split', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.mergeCells(0, 0, 0, 1, 1);
    rd.splitCell(0, 0, 0);
    expect(attrsOf(rd).merges).toEqual([]);
    rd.undo();
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 2, colspan: 2 }]);
  });
});

describe('setColWidth / setRowHeight', () => {
  it('sets a column width, padding colWidths to the column count', () => {
    const rd = rdWithTable([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
    ]);
    rd.setColWidth(0, 1, 120);
    expect(attrsOf(rd).colWidths).toEqual([0, 120, 0]);
  });

  it('clamps width and height to the minimum cell size', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.setColWidth(0, 0, 5);
    rd.setRowHeight(0, 1, 1);
    expect(attrsOf(rd).colWidths![0]).toBe(MIN_CELL_PX);
    expect(attrsOf(rd).rowHeights![1]).toBe(MIN_CELL_PX);
  });

  it('rounds fractional pixel values', () => {
    const rd = rdWithTable([['A', 'B']]);
    rd.setColWidth(0, 0, 100.7);
    expect(attrsOf(rd).colWidths![0]).toBe(101);
  });

  it('ignores out-of-range column/row indices (no snapshot)', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.setColWidth(0, 9, 100);
    rd.setRowHeight(0, 9, 100);
    expect(rd.canUndo).toBe(false);
    expect(attrsOf(rd).colWidths).toBeUndefined();
    expect(attrsOf(rd).rowHeights).toBeUndefined();
  });

  it('undo restores the previous column widths', () => {
    const rd = rdWithTable([['A', 'B']]);
    rd.setColWidth(0, 0, 80);
    expect(attrsOf(rd).colWidths).toEqual([80, 0]);
    rd.undo();
    expect(attrsOf(rd).colWidths).toBeUndefined();
  });
});

// —— merges 调整纯函数（增删行列）——
const m = (r: number, c: number, rs: number, cs: number): CellMerge => ({ r, c, rowspan: rs, colspan: cs });

describe('adjustMergesOnInsertRow', () => {
  it('shifts an anchor down when the row is inserted at or above it', () => {
    expect(adjustMergesOnInsertRow([m(2, 0, 1, 2)], 2)).toEqual([m(3, 0, 1, 2)]); // 同行：下移
    expect(adjustMergesOnInsertRow([m(2, 0, 1, 2)], 0)).toEqual([m(3, 0, 1, 2)]); // 上方：下移
  });
  it('grows the rowspan when the row is inserted inside the span', () => {
    // 合并区占行 1..2（rowspan 2），在第 2 行前插入 → 跨度内 → 撑高到 3 行
    expect(adjustMergesOnInsertRow([m(1, 0, 2, 2)], 2)).toEqual([m(1, 0, 3, 2)]);
  });
  it('leaves a merge below the insertion untouched', () => {
    expect(adjustMergesOnInsertRow([m(0, 0, 1, 2)], 3)).toEqual([m(0, 0, 1, 2)]);
  });
  it('does not mutate the input array or its members', () => {
    const input = [m(2, 0, 1, 1)];
    const snap = JSON.parse(JSON.stringify(input));
    adjustMergesOnInsertRow(input, 0);
    expect(input).toEqual(snap);
  });
});

describe('adjustMergesOnDeleteRow', () => {
  it('shifts an anchor up when a row above it is deleted', () => {
    expect(adjustMergesOnDeleteRow([m(2, 0, 1, 2)], 0)).toEqual([m(1, 0, 1, 2)]);
  });
  it('shrinks the rowspan when a row inside the span is deleted', () => {
    expect(adjustMergesOnDeleteRow([m(1, 0, 3, 2)], 2)).toEqual([m(1, 0, 2, 2)]); // 跨度内删一行
    expect(adjustMergesOnDeleteRow([m(1, 0, 3, 2)], 1)).toEqual([m(1, 0, 2, 2)]); // 删锚点行：收缩
  });
  it('drops a merge that degenerates to 1x1 after deletion', () => {
    // 2 行 × 1 列的合并区，删掉其中一行 → 1×1 → 移除
    expect(adjustMergesOnDeleteRow([m(0, 0, 2, 1)], 0)).toEqual([]);
  });
  it('keeps a merge that stays multi-column even when rowspan drops to 1', () => {
    // 2 行 × 2 列，删一行 → 1 行 × 2 列：仍是合并区，保留
    expect(adjustMergesOnDeleteRow([m(0, 0, 2, 2)], 0)).toEqual([m(0, 0, 1, 2)]);
  });
  it('leaves a merge below the deleted row untouched', () => {
    expect(adjustMergesOnDeleteRow([m(0, 0, 1, 2)], 4)).toEqual([m(0, 0, 1, 2)]);
  });
});

describe('adjustMergesOnInsertCol', () => {
  it('shifts an anchor right when the col is inserted at or left of it', () => {
    expect(adjustMergesOnInsertCol([m(0, 2, 2, 1)], 2)).toEqual([m(0, 3, 2, 1)]);
    expect(adjustMergesOnInsertCol([m(0, 2, 2, 1)], 0)).toEqual([m(0, 3, 2, 1)]);
  });
  it('grows the colspan when the col is inserted inside the span', () => {
    expect(adjustMergesOnInsertCol([m(0, 1, 2, 2)], 2)).toEqual([m(0, 1, 2, 3)]);
  });
  it('leaves a merge to the right of the insertion untouched', () => {
    expect(adjustMergesOnInsertCol([m(0, 0, 2, 1)], 3)).toEqual([m(0, 0, 2, 1)]);
  });
});

describe('adjustMergesOnDeleteCol', () => {
  it('shifts an anchor left when a col left of it is deleted', () => {
    expect(adjustMergesOnDeleteCol([m(0, 2, 1, 2)], 0)).toEqual([m(0, 1, 1, 2)]);
  });
  it('shrinks the colspan when a col inside the span is deleted', () => {
    expect(adjustMergesOnDeleteCol([m(0, 1, 2, 3)], 2)).toEqual([m(0, 1, 2, 2)]);
    expect(adjustMergesOnDeleteCol([m(0, 1, 2, 3)], 1)).toEqual([m(0, 1, 2, 2)]); // 删锚点列
  });
  it('drops a merge that degenerates to 1x1 after deletion', () => {
    expect(adjustMergesOnDeleteCol([m(0, 0, 1, 2)], 0)).toEqual([]);
  });
  it('keeps a merge that stays multi-row even when colspan drops to 1', () => {
    expect(adjustMergesOnDeleteCol([m(0, 0, 2, 2)], 0)).toEqual([m(0, 0, 2, 1)]);
  });
});

describe('insertRow', () => {
  it('inserts an empty row above the given row, aligned to the column count', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.insertRow(0, 1, 'above');
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['', ''],
      ['C', 'D'],
    ]);
  });
  it('inserts an empty row below the given row', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.insertRow(0, 0, 'below');
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['', ''],
      ['C', 'D'],
    ]);
  });
  it('splices a 0 (auto) into rowHeights at the insertion index', () => {
    const rd = rdWithTable([['A'], ['B'], ['C']]);
    rd.setRowHeight(0, 0, 40); // rowHeights = [40, 0, 0]
    rd.insertRow(0, 0, 'below'); // insert at index 1
    expect(attrsOf(rd).rowHeights).toEqual([40, 0, 0, 0]);
  });
  it('grows a merge whose span contains the insertion point', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
      ['E', 'F'],
    ]);
    rd.mergeCells(0, 0, 0, 2, 0); // column 0, rows 0..2 → rowspan 3
    rd.insertRow(0, 1, 'above'); // insert inside the span
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 4, colspan: 1 }]);
  });
  it('ignores an out-of-range row index (no snapshot)', () => {
    const rd = rdWithTable([['A'], ['B']]);
    rd.insertRow(0, 9, 'below');
    expect(rd.canUndo).toBe(false);
  });
  it('undo restores the original rows', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.insertRow(0, 0, 'below');
    rd.undo();
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('deleteRow', () => {
  it('removes the given row', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
      ['E', 'F'],
    ]);
    rd.deleteRow(0, 1);
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['E', 'F'],
    ]);
  });
  it('splices the corresponding rowHeights entry out', () => {
    const rd = rdWithTable([['A'], ['B'], ['C']]);
    rd.setRowHeight(0, 1, 50); // rowHeights = [0, 50, 0]
    rd.deleteRow(0, 1);
    expect(attrsOf(rd).rowHeights).toEqual([0, 0]);
  });
  it('shrinks a merge spanning the deleted row', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
      ['E', 'F'],
    ]);
    rd.mergeCells(0, 0, 0, 2, 0); // rowspan 3 on column 0
    rd.deleteRow(0, 1);
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 2, colspan: 1 }]);
  });
  it('refuses to delete the last remaining row (no snapshot)', () => {
    const rd = rdWithTable([['A', 'B']]);
    rd.deleteRow(0, 0);
    expect(rowsText(rd)).toEqual([['A', 'B']]);
    expect(rd.canUndo).toBe(false);
  });
  it('undo restores the deleted row', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.deleteRow(0, 0);
    rd.undo();
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('insertCol', () => {
  it('inserts an empty column to the left of the given column', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.insertCol(0, 1, 'left');
    expect(rowsText(rd)).toEqual([
      ['A', '', 'B'],
      ['C', '', 'D'],
    ]);
  });
  it('inserts an empty column to the right of the given column', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.insertCol(0, 0, 'right');
    expect(rowsText(rd)).toEqual([
      ['A', '', 'B'],
      ['C', '', 'D'],
    ]);
  });
  it('splices a 0 (auto) into colWidths at the insertion index', () => {
    const rd = rdWithTable([['A', 'B', 'C']]);
    rd.setColWidth(0, 0, 60); // colWidths = [60, 0, 0]
    rd.insertCol(0, 0, 'right'); // insert at index 1
    expect(attrsOf(rd).colWidths).toEqual([60, 0, 0, 0]);
  });
  it('grows a merge whose span contains the insertion point', () => {
    const rd = rdWithTable([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
    ]);
    rd.mergeCells(0, 0, 0, 0, 2); // row 0, cols 0..2 → colspan 3
    rd.insertCol(0, 1, 'left'); // insert inside the span
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 1, colspan: 4 }]);
  });
  it('ignores an out-of-range column index (no snapshot)', () => {
    const rd = rdWithTable([['A', 'B']]);
    rd.insertCol(0, 9, 'right');
    expect(rd.canUndo).toBe(false);
  });
  it('undo restores the original columns', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.insertCol(0, 0, 'right');
    rd.undo();
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
});

describe('deleteCol', () => {
  it('removes the given column from every row', () => {
    const rd = rdWithTable([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
    ]);
    rd.deleteCol(0, 1);
    expect(rowsText(rd)).toEqual([
      ['A', 'C'],
      ['D', 'F'],
    ]);
  });
  it('splices the corresponding colWidths entry out', () => {
    const rd = rdWithTable([['A', 'B', 'C']]);
    rd.setColWidth(0, 1, 70); // colWidths = [0, 70, 0]
    rd.deleteCol(0, 1);
    expect(attrsOf(rd).colWidths).toEqual([0, 0]);
  });
  it('shrinks a merge spanning the deleted column', () => {
    const rd = rdWithTable([
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
    ]);
    rd.mergeCells(0, 0, 0, 0, 2); // colspan 3 on row 0
    rd.deleteCol(0, 1);
    expect(attrsOf(rd).merges).toEqual([{ r: 0, c: 0, rowspan: 1, colspan: 2 }]);
  });
  it('refuses to delete the last remaining column (no snapshot)', () => {
    const rd = rdWithTable([['A'], ['B']]);
    rd.deleteCol(0, 0);
    expect(rowsText(rd)).toEqual([['A'], ['B']]);
    expect(rd.canUndo).toBe(false);
  });
  it('undo restores the deleted column', () => {
    const rd = rdWithTable([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    rd.deleteCol(0, 0);
    rd.undo();
    expect(rowsText(rd)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });
  it('does nothing on a non-table block', () => {
    const rd = new RichDoc({
      blocks: [{ type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'x', marks: [] }] }],
    } as Doc);
    rd.deleteCol(0, 0);
    rd.insertRow(0, 0, 'below');
    expect(rd.canUndo).toBe(false);
  });
});
