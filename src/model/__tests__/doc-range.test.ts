import { describe, it, expect } from 'vitest';
import { sliceDocRange } from '../doc-range';
import { toHtml } from '../export';
import { Doc, Block, TableCell, para, block, text, cell, hasMarkType, blockText, cellText } from '../schema';

// 文档区间切片（model/doc-range.sliceDocRange）：剪贴板富复制的数据源。
// 跨块/含表格/含原子块切片 + 与 toHtml 的串接。
// （toHtml→parseHtml 的完整 round-trip 见 editor/__tests__/clipboard-roundtrip.test.ts。）

const doc = (...blocks: Block[]): Doc => ({ blocks });

describe('sliceDocRange — 同块/跨块', () => {
  it('同块部分切片：偏移精确且保留 marks', () => {
    const d = doc(para([text('he', [{ type: 'bold' }]), text('llo')]));
    const frag = sliceDocRange(d, { block: 0, offset: 1 }, { block: 0, offset: 4 });
    expect(frag.blocks.length).toBe(1);
    expect(blockText(frag.blocks[0])).toBe('ell');
    expect(hasMarkType(frag.blocks[0].inlines[0].marks, 'bold')).toBe(true); // 'e' 保留 bold
  });

  it('跨块：首块切尾、末块切头、中间块整块，类型/attrs 保留', () => {
    const d = doc(
      block('heading', [text('Title')], { level: 2 }),
      para([text('middle')]),
      para([text('world')]),
    );
    const frag = sliceDocRange(d, { block: 0, offset: 2 }, { block: 2, offset: 3 });
    expect(frag.blocks.map(blockText)).toEqual(['tle', 'middle', 'wor']);
    expect(frag.blocks[0].type).toBe('heading');
    expect(frag.blocks[0].attrs.level).toBe(2);
  });

  it('from/to 无序时自动交换；越界偏移夹回', () => {
    const d = doc(para([text('abc')]));
    const frag = sliceDocRange(d, { block: 0, offset: 99 }, { block: 0, offset: 1 });
    expect(blockText(frag.blocks[0])).toBe('bc');
  });
});

describe('sliceDocRange — 原子块/表格', () => {
  it('范围内的图片原子块整块保留 attrs', () => {
    const d = doc(
      para([text('a')]),
      block('image', [text('')], { src: 'data:image/png;base64,x', width: 120 }),
      para([text('b')]),
    );
    const frag = sliceDocRange(d, { block: 0, offset: 0 }, { block: 2, offset: 1 });
    expect(frag.blocks.length).toBe(3);
    expect(frag.blocks[1].type).toBe('image');
    expect(frag.blocks[1].attrs.src).toBe('data:image/png;base64,x');
    expect(frag.blocks[1].attrs.width).toBe(120);
  });

  it('范围内的表格整块保留且与原文档零共享（深拷隔离）', () => {
    const rows: TableCell[][] = [[cell('r0c0'), cell('r0c1')], [cell('r1c0'), cell('r1c1')]];
    const d = doc(para([text('a')]), block('table', [text('')], { rows, merges: [{ r: 0, c: 0, rowspan: 1, colspan: 2 }] }), para([text('b')]));
    const frag = sliceDocRange(d, { block: 0, offset: 1 }, { block: 2, offset: 0 });
    const t = frag.blocks[1];
    expect(t.type).toBe('table');
    expect(t.attrs.rows!.length).toBe(2);
    expect(cellText(t.attrs.rows![0][0])).toBe('r0c0');
    expect(t.attrs.merges).toEqual([{ r: 0, c: 0, rowspan: 1, colspan: 2 }]);
    // 变异隔离：改切片不影响原文档
    t.attrs.rows![0][0].inlines = [text('CHANGED')];
    expect(cellText(d.blocks[1].attrs.rows![0][0])).toBe('r0c0');
  });

  it('切片与原文档零共享行内引用', () => {
    const d = doc(para([text('hello', [{ type: 'bold' }])]));
    const frag = sliceDocRange(d, { block: 0, offset: 0 }, { block: 0, offset: 5 });
    const run = frag.blocks[0].inlines[0];
    expect(run).not.toBe(d.blocks[0].inlines[0]);
    expect(run.marks).not.toBe(d.blocks[0].inlines[0].marks);
  });
});

describe('sliceDocRange → toHtml（剪贴板 text/html 通道）', () => {
  it('marks/块结构落到 HTML 标签', () => {
    const d = doc(
      block('heading', [text('标题')], { level: 1 }),
      para([text('粗', [{ type: 'bold' }]), text('斜', [{ type: 'italic' }])]),
    );
    const html = toHtml(sliceDocRange(d, { block: 0, offset: 0 }, { block: 1, offset: 2 }));
    expect(html).toContain('<h1');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<em>斜</em>');
  });

  it('表格切片落到 <table>/<td>', () => {
    const d = doc(block('table', [text('')], { rows: [[cell('A'), cell('B')]] }), para([text('x')]));
    const html = toHtml(sliceDocRange(d, { block: 0, offset: 0 }, { block: 1, offset: 1 }));
    expect(html).toContain('<table>');
    expect(html).toContain('<td>A</td>');
  });
});
