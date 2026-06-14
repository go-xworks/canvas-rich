import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, block, para, text, isInlineAtom, blockTextLen, InlineAtom } from '../schema';

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });
const rdOf = (...blocks: Doc['blocks']) => new RichDoc(doc(...blocks));

describe('RichDoc.insertInlineImage', () => {
  it('在光标处插入行内图片，占 1 offset，光标右移 1', () => {
    const rd = rdOf(para([text('abcd')]));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertInlineImage('x.png');
    const inls = rd.doc.blocks[0].inlines;
    // 'ab' + atom + 'cd'
    expect(inls.length).toBe(3);
    expect(isInlineAtom(inls[1])).toBe(true);
    expect((inls[1] as InlineAtom).attrs.src).toBe('x.png');
    expect(blockTextLen(rd.doc.blocks[0])).toBe(5);
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
  });

  it('插入到块首与块尾均可', () => {
    const rd = rdOf(para([text('ab')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.insertInlineImage('h');
    expect(isInlineAtom(rd.doc.blocks[0].inlines[0])).toBe(true);
    expect(rd.focus.offset).toBe(1);

    rd.setSel({ block: 0, offset: blockTextLen(rd.doc.blocks[0]) });
    rd.insertInlineImage('t');
    const inls = rd.doc.blocks[0].inlines;
    expect(isInlineAtom(inls[inls.length - 1])).toBe(true);
  });

  it('有选区时先删再插（替换选中文本）', () => {
    const rd = rdOf(para([text('abcd')]));
    rd.anchor = { block: 0, offset: 1 };
    rd.focus = { block: 0, offset: 3 }; // 选中 'bc'
    rd.insertInlineImage('x');
    // 'a' + atom + 'd'
    const inls = rd.doc.blocks[0].inlines;
    expect(inls.length).toBe(3);
    expect(isInlineAtom(inls[1])).toBe(true);
    expect(blockTextLen(rd.doc.blocks[0])).toBe(3); // a + atom(1) + d
  });

  it('光标右移/左移把行内图片当 1 grapheme 跨越', () => {
    const rd = rdOf(para([text('ab')]));
    rd.setSel({ block: 0, offset: 1 });
    rd.insertInlineImage('x'); // 'a' + atom + 'b'，光标在 offset 2
    // 左移一次 → 跨过原子到 offset 1
    const left = rd.posLeft(rd.focus);
    expect(left).toEqual({ block: 0, offset: 1 });
    // 从 offset 1 右移一次 → 跨过原子到 offset 2
    const right = rd.posRight({ block: 0, offset: 1 });
    expect(right).toEqual({ block: 0, offset: 2 });
  });

  it('退格删除整张行内图片（不可半删）', () => {
    const rd = rdOf(para([text('ab')]));
    rd.setSel({ block: 0, offset: 1 });
    rd.insertInlineImage('x'); // 'a' + atom + 'b'，光标 offset 2（原子右缘）
    rd.backspace();
    expect(rd.doc.blocks[0].inlines.some(isInlineAtom)).toBe(false);
    expect(blockTextLen(rd.doc.blocks[0])).toBe(2); // 'ab'
  });

  it('停在原子块上插入行内图片 → 在其后新建段落承载', () => {
    const rd = rdOf(
      para([text('p')]),
      block('image', [text('')], { src: 'block.png' }),
    );
    rd.setSel({ block: 1, offset: 0 }); // 选中块级图片
    rd.insertInlineImage('inl.png');
    // 新段落插在块级图片之后
    expect(rd.blockCount).toBe(3);
    expect(rd.doc.blocks[2].type).toBe('paragraph');
    expect(isInlineAtom(rd.doc.blocks[2].inlines[0])).toBe(true);
    expect(rd.focus).toEqual({ block: 2, offset: 1 });
  });

  it('undo 恢复插入前状态（行内图片消失）', () => {
    const rd = rdOf(para([text('abcd')]));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertInlineImage('x');
    expect(rd.doc.blocks[0].inlines.some(isInlineAtom)).toBe(true);
    rd.undo();
    expect(rd.doc.blocks[0].inlines.some(isInlineAtom)).toBe(false);
    expect(blockTextLen(rd.doc.blocks[0])).toBe(4);
  });
});
