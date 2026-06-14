import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, Block, para, block, text, hasMarkType, blockText } from '../schema';

// IME 组合 transient 编辑通道（RichDoc.begin/update/endComposition）：
// begin 快照一次，update 全量替换组合区间不再快照（不进撤销栈）、临时段带 underline 装饰，
// end 收尾为单次可撤销提交；取消（提交空串且未实质改动）弹出起始快照。

const doc = (...blocks: Block[]): Doc => ({ blocks });

describe('组合生命周期', () => {
  it('begin→update×n→end：中间态实时入文档，提交为最终串', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.beginComposition();
    expect(rd.isComposing).toBe(true);
    rd.updateComposition('n');
    expect(blockText(rd.doc.blocks[0])).toBe('abn');
    rd.updateComposition('ni');
    expect(blockText(rd.doc.blocks[0])).toBe('abni');
    rd.updateComposition('nih');
    expect(blockText(rd.doc.blocks[0])).toBe('abnih');
    rd.endComposition('你');
    expect(rd.isComposing).toBe(false);
    expect(blockText(rd.doc.blocks[0])).toBe('ab你');
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
  });

  it('组合串可收缩（退格候选）', () => {
    const rd = new RichDoc(doc(para([text('x')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.beginComposition();
    rd.updateComposition('abc');
    rd.updateComposition('a');
    expect(blockText(rd.doc.blocks[0])).toBe('xa');
    rd.endComposition('啊');
    expect(blockText(rd.doc.blocks[0])).toBe('x啊');
  });

  it('中间态带 underline 装饰 mark，提交后不残留', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.beginComposition();
    rd.updateComposition('ni');
    const interim = rd.doc.blocks[0].inlines.find((r) => r.text === 'ni');
    expect(interim).toBeDefined();
    expect(hasMarkType(interim!.marks, 'underline')).toBe(true);
    rd.endComposition('你');
    for (const r of rd.doc.blocks[0].inlines) expect(hasMarkType(r.marks, 'underline')).toBe(false);
  });
});

describe('撤销粒度（不进撤销栈的中间态）', () => {
  it('整个组合 = 单条撤销记录', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.beginComposition();
    rd.updateComposition('n');
    rd.updateComposition('ni');
    rd.endComposition('你');
    expect(rd.canUndo).toBe(true);
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('ab'); // 一步回到组合前
    expect(rd.canUndo).toBe(false);                 // 中间态没有额外记录
    rd.redo();
    expect(blockText(rd.doc.blocks[0])).toBe('ab你');
  });

  it('取消组合（提交空串且未实质改动）：文档还原且撤销栈不留无效记录', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.beginComposition();
    rd.updateComposition('nihao');
    rd.endComposition('');
    expect(blockText(rd.doc.blocks[0])).toBe('ab');
    expect(rd.canUndo).toBe(false);
  });

  it('组合替换选区：选区删除与提交同属一条记录；取消也保留删除', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.setSel({ block: 0, offset: 4 }, true); // 选中 'ell'
    rd.beginComposition();
    expect(blockText(rd.doc.blocks[0])).toBe('ho');
    rd.updateComposition('x');
    rd.endComposition('呃');
    expect(blockText(rd.doc.blocks[0])).toBe('h呃o');
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('hello'); // 单步回滚（含选区删除）
    // 取消路径：选区删除已实质改动文档 → 快照保留可撤销
    const rd2 = new RichDoc(doc(para([text('hello')])));
    rd2.setSel({ block: 0, offset: 1 });
    rd2.setSel({ block: 0, offset: 4 }, true);
    rd2.beginComposition();
    rd2.endComposition('');
    expect(blockText(rd2.doc.blocks[0])).toBe('ho');
    expect(rd2.canUndo).toBe(true);
    rd2.undo();
    expect(blockText(rd2.doc.blocks[0])).toBe('hello');
  });
});

describe('marks 继承与原子块', () => {
  it('提交文本继承组合起点的 storedMarks/左继承 marks', () => {
    const rd = new RichDoc(doc(para([text('a', [{ type: 'bold' }])])));
    rd.setSel({ block: 0, offset: 1 });
    rd.beginComposition();
    rd.updateComposition('x');
    rd.endComposition('x');
    const b = rd.doc.blocks[0];
    expect(blockText(b)).toBe('ax');
    expect(b.inlines.length).toBe(1); // 同 marks 归一合并
    expect(hasMarkType(b.inlines[0].marks, 'bold')).toBe(true);
  });

  it('光标停在原子块上：组合在其后新建段落承载', () => {
    const rd = new RichDoc(doc(block('image', [text('')], { src: '' })));
    rd.setSel({ block: 0, offset: 0 });
    rd.beginComposition();
    rd.updateComposition('ni');
    rd.endComposition('你');
    expect(rd.doc.blocks.length).toBe(2);
    expect(rd.doc.blocks[0].type).toBe('image');
    expect(rd.doc.blocks[1].type).toBe('paragraph');
    expect(blockText(rd.doc.blocks[1])).toBe('你');
  });

  it('非组合期 update/end 无操作', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.updateComposition('x');
    rd.endComposition('x');
    expect(blockText(rd.doc.blocks[0])).toBe('ab');
    expect(rd.canUndo).toBe(false);
  });
});
