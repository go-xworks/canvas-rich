import { describe, it, expect } from 'vitest';
import {
  Doc, Block, TableCell, TextRun, cell, cellText, cellsFromStrings, cloneCell, cloneDoc, text,
  inlineAtom, isCellEmpty, isInlineAtom,
} from '../schema';
import { RichDoc } from '../rich-document';
import { toHtml, toMarkdown, inlinesToCellHtml } from '../export';

// 表格富单元格（集群2）：cell 构造器/取文/升格/深拷、撤销隔离、富合并、行列增删空格子、
// 导出 HTML（marks/<br>/转义）与 MD 降级、inlinesToCellHtml 的编辑态片段渲染。

const tableBlock = (rows: TableCell[][]): Block => ({ type: 'table', attrs: { rows, id: 'tbl' }, inlines: [text('')] });
const rdWith = (rows: TableCell[][]): RichDoc => new RichDoc({ blocks: [tableBlock(rows)] });
const rowsOf = (rd: RichDoc): TableCell[][] => rd.doc.blocks[0].attrs.rows!;

describe('cell / cellText / cellsFromStrings', () => {
  it('cell() builds an empty rich cell holding a single empty run', () => {
    expect(cell()).toEqual({ inlines: [{ kind: 'text', text: '', marks: [] }] });
  });

  it('cell(str) seeds the cell with plain text', () => {
    expect(cellText(cell('你好'))).toBe('你好');
  });

  it('cellText concatenates all runs (marks ignored, \\n preserved)', () => {
    const c: TableCell = { inlines: [text('a', [{ type: 'bold' }]), text('\nb')] };
    expect(cellText(c)).toBe('a\nb');
  });

  it('cellsFromStrings lifts a string grid into independent rich cells', () => {
    const rows = cellsFromStrings([['a', 'b'], ['c', '']]);
    expect(rows.map((r) => r.map(cellText))).toEqual([['a', 'b'], ['c', '']]);
    expect(rows[0][0]).not.toBe(rows[0][1]); // 每格独立对象
    expect(rows[1][1].inlines).toHaveLength(1); // 空格子保留空段承载光标
  });

  it('cloneCell deep-copies inlines and marks', () => {
    const src: TableCell = { inlines: [text('x', [{ type: 'color', attrs: { color: '#f00' } }])] };
    const copy = cloneCell(src);
    expect(copy).toEqual(src);
    expect(copy.inlines[0]).not.toBe(src.inlines[0]);
    expect(copy.inlines[0].marks[0]).not.toBe(src.inlines[0].marks[0]);
  });
});

describe('cloneDoc — 表格 rows 深拷（撤销隔离）', () => {
  it('clones every cell and its inlines (no shared references)', () => {
    const d: Doc = { blocks: [tableBlock(cellsFromStrings([['A', 'B']]))] };
    const c = cloneDoc(d);
    const orig = d.blocks[0].attrs.rows![0][0];
    const copy = c.blocks[0].attrs.rows![0][0];
    expect(copy).toEqual(orig);
    expect(copy).not.toBe(orig);
    expect(copy.inlines[0]).not.toBe(orig.inlines[0]);
    (copy.inlines[0] as TextRun).text = 'MUTATED';
    expect(cellText(orig)).toBe('A'); // 改副本不影响原文档
  });

  it('in-place cell writeback (overlay input pattern) does not pollute the undo stack', () => {
    const rd = rdWith(cellsFromStrings([['A', 'B'], ['C', 'D']]));
    rd.setColWidth(0, 0, 100); // 任意进撤销栈的操作（快照在前）
    // 模拟覆盖层 input 回写：直接给当前 rows 赋新 cell 对象（不经撤销栈）
    rowsOf(rd)[0][0] = { inlines: [text('EDITED', [{ type: 'bold' }])] };
    expect(cellText(rowsOf(rd)[0][0])).toBe('EDITED');
    rd.undo();
    expect(cellText(rowsOf(rd)[0][0])).toBe('A'); // 快照与当前态不共享 cell 引用
  });
});

describe('isCellEmpty — 判空不变量（集群3）', () => {
  it('treats blank text (spaces / pure \\n) as empty', () => {
    expect(isCellEmpty(cell())).toBe(true);
    expect(isCellEmpty({ inlines: [text('  ')] })).toBe(true);
    expect(isCellEmpty({ inlines: [text('\n')] })).toBe(true);
    expect(isCellEmpty({ inlines: [text(' \n ', [{ type: 'bold' }])] })).toBe(true); // marks 不改变判空
  });

  it('treats any non-blank text as non-empty', () => {
    expect(isCellEmpty(cell('a'))).toBe(false);
    expect(isCellEmpty({ inlines: [text(' x \n')] })).toBe(false);
  });

  it('treats a cell holding an inline atom as non-empty (content must not be swallowed)', () => {
    expect(isCellEmpty({ inlines: [inlineAtom('image', { src: 'x.png' })] })).toBe(false);
  });
});

describe('mergeCells — 富内容连接', () => {
  it('joins non-empty cells with single-space runs, preserving marks and \\n', () => {
    const rows: TableCell[][] = [
      [{ inlines: [text('A', [{ type: 'bold' }])] }, { inlines: [text('B\nb')] }],
      [cell(), { inlines: [text('D', [{ type: 'italic' }])] }],
    ];
    const rd = rdWith(rows);
    rd.mergeCells(0, 0, 0, 1, 1);
    const anchor = rowsOf(rd)[0][0];
    expect(cellText(anchor)).toBe('A B\nb D');
    // marks 保留：首段仍是 bold，末段仍是 italic
    expect(anchor.inlines[0].marks.map((m) => m.type)).toEqual(['bold']);
    expect(anchor.inlines[anchor.inlines.length - 1].marks.map((m) => m.type)).toEqual(['italic']);
    // 其余格清空
    expect(cellText(rowsOf(rd)[0][1])).toBe('');
    expect(cellText(rowsOf(rd)[1][1])).toBe('');
  });

  it('whitespace-only cells are treated as empty (not joined)', () => {
    const rd = rdWith([[cell('A'), { inlines: [text('  ')] }], [cell('C'), cell()]]);
    rd.mergeCells(0, 0, 0, 1, 1);
    expect(cellText(rowsOf(rd)[0][0])).toBe('A C');
  });

  it('a pure "\\n" cell counts as empty (no stray separator joined in)', () => {
    const rd = rdWith([[cell('A'), { inlines: [text('\n')] }], [cell('C'), cell()]]);
    rd.mergeCells(0, 0, 0, 1, 1);
    expect(cellText(rowsOf(rd)[0][0])).toBe('A C');
  });

  it('a cell holding only an inline atom is NOT dropped (isCellEmpty invariant)', () => {
    const rd = rdWith([[cell('A'), { inlines: [inlineAtom('image', { src: 'x.png' })] }]]);
    rd.mergeCells(0, 0, 0, 0, 1);
    const anchor = rowsOf(rd)[0][0];
    expect(anchor.inlines.some(isInlineAtom)).toBe(true); // 原子内容并入锚点，未被静默吞掉
    expect(cellText(anchor).startsWith('A ')).toBe(true); // 与前一格以空格连接
  });

  it('undo restores rich cell contents and marks', () => {
    const rd = rdWith([[{ inlines: [text('A', [{ type: 'bold' }])] }, cell('B')]]);
    rd.mergeCells(0, 0, 0, 0, 1);
    rd.undo();
    const a = rowsOf(rd)[0][0];
    expect(cellText(a)).toBe('A');
    expect(a.inlines[0].marks.map((m) => m.type)).toEqual(['bold']);
    expect(cellText(rowsOf(rd)[0][1])).toBe('B');
  });
});

describe('行列增删 — 空富格子', () => {
  it('insertRow fills the new row with independent empty cells', () => {
    const rd = rdWith(cellsFromStrings([['A', 'B']]));
    rd.insertRow(0, 0, 'below');
    const row = rowsOf(rd)[1];
    expect(row.map(cellText)).toEqual(['', '']);
    expect(row[0]).not.toBe(row[1]);
  });

  it('insertCol fills the new column with empty cells, keeping rich neighbours intact', () => {
    const rd = rdWith([[{ inlines: [text('A', [{ type: 'bold' }])] }, cell('B')]]);
    rd.insertCol(0, 0, 'right');
    expect(rowsOf(rd)[0].map(cellText)).toEqual(['A', '', 'B']);
    expect(rowsOf(rd)[0][0].inlines[0].marks.map((m) => m.type)).toEqual(['bold']);
  });

  it('deleteRow / deleteCol keep remaining rich cells untouched', () => {
    const rd = rdWith([
      [{ inlines: [text('A', [{ type: 'italic' }])] }, cell('B')],
      [cell('C'), cell('D')],
    ]);
    rd.deleteRow(0, 1);
    rd.deleteCol(0, 1);
    expect(rowsOf(rd).map((r) => r.map(cellText))).toEqual([['A']]);
    expect(rowsOf(rd)[0][0].inlines[0].marks.map((m) => m.type)).toEqual(['italic']);
  });
});

describe('导出 — 表格富单元格', () => {
  it('toHtml renders cell marks, converts \\n to <br>, and escapes raw HTML', () => {
    const rows: TableCell[][] = [[
      { inlines: [text('B', [{ type: 'bold' }]), text('\na<b')] },
      { inlines: [text('L', [{ type: 'link', attrs: { href: 'https://e.com' } }])] },
    ]];
    const html = toHtml({ blocks: [tableBlock(rows)] });
    expect(html).toContain('<td><strong>B</strong><br>a&lt;b</td>');
    expect(html).toContain('<td><a href="https://e.com">L</a></td>');
  });

  it('toHtml keeps colspan/rowspan output for merged rich tables', () => {
    const rd = rdWith(cellsFromStrings([['A', 'B'], ['C', 'D']]));
    rd.mergeCells(0, 0, 0, 0, 1);
    const html = toHtml(rd.doc);
    expect(html).toContain('<td colspan="2">A B</td>');
  });

  it('toMarkdown degrades cells to plain text, preserving \\n as <br> (GFM)', () => {
    const rows: TableCell[][] = [
      [cell('h1'), { inlines: [text('h2', [{ type: 'bold' }])] }],
      [{ inlines: [text('a\nb')] }, cell('c')],
    ];
    const md = toMarkdown({ blocks: [tableBlock(rows)] });
    expect(md).toBe('| h1 | h2 |\n| --- | --- |\n| a<br>b | c |');
  });

  it('toHtml clamps an oversized merge to the table bounds (no out-of-range colspan/rowspan)', () => {
    const doc: Doc = { blocks: [{ type: 'table', attrs: { rows: cellsFromStrings([['A', 'B'], ['C', 'D']]), merges: [{ r: 0, c: 0, rowspan: 9, colspan: 9 }], id: 'tbl' }, inlines: [text('')] }] };
    const html = toHtml(doc);
    expect(html).toContain('<td colspan="2" rowspan="2">A</td>'); // 跨度 clamp 到 2×2
    expect(html).not.toContain('colspan="9"');
    expect(html).not.toContain('rowspan="9"');
  });

  it('toHtml drops a merge whose anchor lies outside the rows (cells stay intact)', () => {
    const doc: Doc = { blocks: [{ type: 'table', attrs: { rows: cellsFromStrings([['A', 'B']]), merges: [{ r: 5, c: 0, rowspan: 2, colspan: 2 }], id: 'tbl' }, inlines: [text('')] }] };
    const html = toHtml(doc);
    expect(html).toContain('<td>A</td><td>B</td>'); // 越界合并区被忽略，不吞真实格子
    expect(html).not.toContain('colspan');
  });
});

describe('inlinesToCellHtml — 编辑态单元格片段', () => {
  it('escapes text and wraps appearance marks', () => {
    const out = inlinesToCellHtml([text('<x>&', [{ type: 'bold' }, { type: 'italic' }])]);
    expect(out).toBe('<em><strong>&lt;x&gt;&amp;</strong></em>'); // 包裹序同导出 HTML（bold 先裹、italic 在外）
  });

  it('converts \\n to <br>', () => {
    expect(inlinesToCellHtml([text('a\nb')])).toBe('a<br>b');
  });

  it('renders color/fontSize/fontFamily as style spans', () => {
    const out = inlinesToCellHtml([text('x', [
      { type: 'color', attrs: { color: '#ff0000' } },
      { type: 'fontSize', attrs: { size: '24' } },
      { type: 'fontFamily', attrs: { fontFamily: 'Georgia' } },
    ])]);
    expect(out).toBe('<span style="color:#ff0000"><span style="font-size:24px"><span style="font-family:Georgia">x</span></span></span>');
  });

  it('degrades link to span[data-href] (no clickable <a>, no inline style to misparse)', () => {
    const out = inlinesToCellHtml([text('L', [{ type: 'link', attrs: { href: 'https://e.com/?a="b"' } }])]);
    expect(out).toBe('<span data-href="https://e.com/?a=&quot;b&quot;">L</span>');
    expect(out).not.toContain('<a ');
  });

  it('drops inline atoms (cells do not host inline images)', () => {
    const out = inlinesToCellHtml([
      text('a'),
      { kind: 'atom', atom: 'image', attrs: { src: 'x.png' }, text: '￼', marks: [] },
      text('b'),
    ]);
    expect(out).toBe('ab');
  });
});
