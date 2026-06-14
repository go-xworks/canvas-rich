import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, Block, para, block, text, inlineAtom, hasMarkType, blockText } from '../schema';

// RichDoc.insertFragment：富文本粘贴的「片段插入」原语。
// 单文本块行内并入 / 多块拆当前块插入 / 原子块独立成块 / 空段落承接片段类型 / 单次撤销。

const doc = (...blocks: Block[]): Doc => ({ blocks });

describe('单文本块片段', () => {
  it('行内并入当前块，保 marks，光标落在插入末尾', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertFragment(doc(para([text('XY', [{ type: 'bold' }])])));
    expect(blockText(rd.doc.blocks[0])).toBe('heXYllo');
    const mid = rd.doc.blocks[0].inlines.find((r) => r.text === 'XY');
    expect(mid && hasMarkType(mid.marks, 'bold')).toBe(true);
    expect(rd.focus).toEqual({ block: 0, offset: 4 });
    expect(rd.doc.blocks.length).toBe(1);
  });

  it('含行内原子的片段并入后原子保留', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.insertFragment(doc(para([text('x'), inlineAtom('image', { src: 's' }), text('y')])));
    const b = rd.doc.blocks[0];
    expect(blockText(b)).toBe('ax￼yb');
    expect(b.inlines.some((r) => r.kind === 'atom')).toBe(true);
  });

  it('单次撤销恢复', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertFragment(doc(para([text('XY')])));
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('hello');
    expect(rd.canUndo).toBe(false);
  });
});

describe('多块片段', () => {
  it('拆当前块：首块并入前半、尾块承接后半，光标在粘贴内容末尾', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertFragment(doc(para([text('AA')]), para([text('BB')])));
    expect(rd.doc.blocks.map(blockText)).toEqual(['heAA', 'BBllo']);
    expect(rd.focus).toEqual({ block: 1, offset: 2 });
  });

  it('中间块独立保留类型（标题/列表）', () => {
    const rd = new RichDoc(doc(para([text('xy')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.insertFragment(doc(
      para([text('A')]),
      block('heading', [text('H')], { level: 2 }),
      block('bullet_item', [text('L')]),
    ));
    expect(rd.doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'heading', 'bullet_item']);
    expect(rd.doc.blocks.map(blockText)).toEqual(['xA', 'H', 'Ly']);
    expect(rd.doc.blocks[1].attrs.level).toBe(2);
  });

  it('多块插入为单次撤销', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertFragment(doc(para([text('AA')]), para([text('BB')])));
    rd.undo();
    expect(rd.doc.blocks.map(blockText)).toEqual(['hello']);
    expect(rd.canUndo).toBe(false);
  });

  it('有选区先删再插（同一条撤销）', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.setSel({ block: 0, offset: 4 }, true);
    rd.insertFragment(doc(para([text('X')])));
    expect(blockText(rd.doc.blocks[0])).toBe('hXo');
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('hello');
  });
});

describe('原子块片段', () => {
  it('片段中的图片块独立成块并换新 id（覆盖层缓存不串）', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertFragment(doc(block('image', [text('')], { src: 'data:,x', id: 'blk-from-clipboard' })));
    expect(rd.doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(rd.doc.blocks.map(blockText)).toEqual(['he', '', 'llo']);
    expect(rd.doc.blocks[1].attrs.src).toBe('data:,x');
    expect(rd.doc.blocks[1].attrs.id).toBeTruthy();
    expect(rd.doc.blocks[1].attrs.id).not.toBe('blk-from-clipboard');
    expect(rd.focus).toEqual({ block: 2, offset: 0 }); // 承接段落起点 = 粘贴内容末尾
  });

  it('光标停在原子块上：整片段插到其后', () => {
    const rd = new RichDoc(doc(block('image', [text('')], { src: '' })));
    rd.setSel({ block: 0, offset: 0 });
    rd.insertFragment(doc(para([text('x')]), para([text('y')])));
    expect(rd.doc.blocks.map((b) => b.type)).toEqual(['image', 'paragraph', 'paragraph']);
    expect(rd.doc.blocks.map(blockText)).toEqual(['', 'x', 'y']);
    expect(rd.focus).toEqual({ block: 2, offset: 1 });
  });

  it('片段与文档零共享：粘贴后改片段不影响文档', () => {
    const rd = new RichDoc(doc(para([text('ab')])));
    rd.setSel({ block: 0, offset: 1 });
    const frag = doc(para([text('X', [{ type: 'bold' }])]));
    rd.insertFragment(frag);
    frag.blocks[0].inlines[0].text = 'MUTATED';
    expect(blockText(rd.doc.blocks[0])).toBe('aXb');
  });
});

describe('空段落承接片段类型', () => {
  it('当前块为空段落：整体采用片段首块类型/属性（标题粘贴不降级）', () => {
    const rd = new RichDoc(doc(para([])));
    rd.setSel({ block: 0, offset: 0 });
    rd.insertFragment(doc(block('heading', [text('T')], { level: 2 })));
    expect(rd.doc.blocks.length).toBe(1);
    expect(rd.doc.blocks[0].type).toBe('heading');
    expect(rd.doc.blocks[0].attrs.level).toBe(2);
    expect(blockText(rd.doc.blocks[0])).toBe('T');
  });

  it('非空段落不改类型', () => {
    const rd = new RichDoc(doc(para([text('a')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.insertFragment(doc(block('heading', [text('T')], { level: 2 })));
    expect(rd.doc.blocks[0].type).toBe('paragraph');
    expect(blockText(rd.doc.blocks[0])).toBe('aT');
  });

  it('空片段无操作（不入撤销栈）', () => {
    const rd = new RichDoc(doc(para([text('a')])));
    rd.insertFragment({ blocks: [] });
    expect(rd.canUndo).toBe(false);
  });
});
