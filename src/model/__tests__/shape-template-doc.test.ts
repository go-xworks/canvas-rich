import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text, blockText } from '../schema';
import { isAtom } from '../block-specs';

const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('RichDoc.replaceDoc', () => {
  it('替换 blocks、光标归位文首、进撤销栈', () => {
    const rd = new RichDoc(docOf(para([text('old1')]), para([text('old2')])));
    rd.setSel({ block: 1, offset: 4 });
    const next = docOf(para([text('new')]), para([text('tail')]));
    rd.replaceDoc(next);
    expect(rd.doc.blocks.map((b) => blockText(b))).toEqual(['new', 'tail']);
    // 光标归位文首
    expect(rd.focus).toEqual({ block: 0, offset: 0 });
    expect(rd.isCollapsed).toBe(true);
    // 进撤销栈：undo 恢复旧文档
    expect(rd.canUndo).toBe(true);
    rd.undo();
    expect(rd.doc.blocks.map((b) => blockText(b))).toEqual(['old1', 'old2']);
  });

  it('深拷贝传入 Doc：改动原 Doc 不影响已替换文档', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    const src = docOf(para([text('src')]));
    rd.replaceDoc(src);
    src.blocks[0].inlines[0].text = 'mutated';
    expect(blockText(rd.doc.blocks[0])).toBe('src'); // 未被外部 mutation 影响
  });

  it('空文档回退为单个空段落', () => {
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.replaceDoc({ blocks: [] });
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
    expect(blockText(rd.doc.blocks[0])).toBe('');
    expect(rd.focus).toEqual({ block: 0, offset: 0 });
  });
});

describe('RichDoc.insertShape', () => {
  it('在光标块后插入 shape 原子块，attrs.shape 正确、带稳定 id、光标落其上', () => {
    const rd = new RichDoc(docOf(para([text('p0')]), para([text('p1')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertShape('triangle');
    expect(rd.doc.blocks).toHaveLength(3);
    const shape = rd.doc.blocks[1];
    expect(shape.type).toBe('shape');
    expect(isAtom(shape.type)).toBe(true);
    expect(shape.attrs.shape).toBe('triangle');
    expect(typeof shape.attrs.width).toBe('number');
    expect(typeof shape.attrs.height).toBe('number');
    expect(typeof shape.attrs.id).toBe('string'); // 覆盖层缓存键
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('line / divider 默认更扁（height < 非线性形状）', () => {
    const rd = new RichDoc(docOf(para([text('')])));
    rd.insertShape('line');
    const lineH = rd.doc.blocks[1].attrs.height!;
    const rd2 = new RichDoc(docOf(para([text('')])));
    rd2.insertShape('rect');
    const rectH = rd2.doc.blocks[1].attrs.height!;
    expect(lineH).toBeLessThan(rectH);
  });

  it('插入进撤销栈，undo 移除形状', () => {
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.insertShape('star');
    expect(rd.doc.blocks).toHaveLength(2);
    rd.undo();
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });
});
