import { describe, it, expect } from 'vitest';
import { RichDoc, comparePos, Pos } from '../rich-document';
import { Doc, block, para, text, blockText } from '../schema';

// —— helpers ——
const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });
const rdOf = (...blocks: Doc['blocks']) => new RichDoc(doc(...blocks));
// 每块文本数组，便于断言结构
const docText = (rd: RichDoc): string[] => rd.doc.blocks.map((b) => blockText(b));

describe('comparePos', () => {
  it('compares offset within the same block', () => {
    expect(comparePos({ block: 0, offset: 1 }, { block: 0, offset: 3 })).toBe(-1);
    expect(comparePos({ block: 0, offset: 3 }, { block: 0, offset: 1 })).toBe(1);
    expect(comparePos({ block: 0, offset: 2 }, { block: 0, offset: 2 })).toBe(0);
  });

  it('compares block index across blocks (ignores offset)', () => {
    expect(comparePos({ block: 0, offset: 99 }, { block: 1, offset: 0 })).toBe(-1);
    expect(comparePos({ block: 2, offset: 0 }, { block: 1, offset: 99 })).toBe(1);
  });
});

describe('posRight / posLeft across blocks', () => {
  it('posRight at block end moves to next block offset 0', () => {
    const rd = rdOf(para([text('ab')]), para([text('cd')]));
    // at end of block 0
    const p: Pos = { block: 0, offset: 2 };
    expect(rd.posRight(p)).toEqual({ block: 1, offset: 0 });
    // within block advances by one grapheme
    expect(rd.posRight({ block: 0, offset: 0 })).toEqual({ block: 0, offset: 1 });
    // at doc end stays put
    expect(rd.posRight({ block: 1, offset: 2 })).toEqual({ block: 1, offset: 2 });
  });

  it('posLeft at block start moves to previous block end', () => {
    const rd = rdOf(para([text('ab')]), para([text('cd')]));
    expect(rd.posLeft({ block: 1, offset: 0 })).toEqual({ block: 0, offset: 2 });
    // within block steps back by one grapheme
    expect(rd.posLeft({ block: 1, offset: 2 })).toEqual({ block: 1, offset: 1 });
    // at doc start stays put
    expect(rd.posLeft({ block: 0, offset: 0 })).toEqual({ block: 0, offset: 0 });
  });
});

describe('insertText', () => {
  it('inserts inside a block and advances the caret', () => {
    const rd = rdOf(para([text('ad')]));
    rd.setSel({ block: 0, offset: 1 });
    rd.insertText('bc');
    expect(docText(rd)).toEqual(['abcd']);
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
    expect(rd.isCollapsed).toBe(true);
  });

  it('inherits bold when inserting at the end of a fully-bold run (merges into one run)', () => {
    const rd = rdOf(para([text('ab', [{ type: 'bold' }])]));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertText('c');
    expect(docText(rd)).toEqual(['abc']);
    // all three chars are bold and merged into a single inline run
    const inlines = rd.doc.blocks[0].inlines;
    expect(inlines.length).toBe(1);
    expect(inlines[0].text).toBe('abc');
    expect(inlines[0].marks.some((m) => m.type === 'bold')).toBe(true);
    expect(rd.markActive('bold')).toBe(true);
  });
});

describe('backspace', () => {
  it('deletes one grapheme before the caret within a block', () => {
    const rd = rdOf(para([text('abc')]));
    rd.setSel({ block: 0, offset: 3 });
    rd.backspace();
    expect(docText(rd)).toEqual(['ab']);
    expect(rd.focus).toEqual({ block: 0, offset: 2 });
  });

  it('at offset 0 of block 1 merges with the previous block', () => {
    const rd = rdOf(para([text('abc')]), para([text('def')]));
    rd.setSel({ block: 1, offset: 0 });
    rd.backspace();
    expect(rd.blockCount).toBe(1);
    expect(docText(rd)).toEqual(['abcdef']);
    // caret lands at the previous block's original length
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
  });

  it('at the start of a bullet_item lifts it to a paragraph (no merge)', () => {
    const rd = rdOf(para([text('x')]), block('bullet_item', [text('item')]));
    rd.setSel({ block: 1, offset: 0 });
    rd.backspace();
    expect(rd.blockCount).toBe(2);
    expect(rd.doc.blocks[1].type).toBe('paragraph');
    expect(docText(rd)).toEqual(['x', 'item']);
  });
});

describe('del', () => {
  it('deletes the next grapheme within a block', () => {
    const rd = rdOf(para([text('abc')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.del();
    expect(docText(rd)).toEqual(['bc']);
    expect(rd.focus).toEqual({ block: 0, offset: 0 });
  });

  it('at the end of a block merges the next block into it', () => {
    const rd = rdOf(para([text('abc')]), para([text('def')]));
    rd.setSel({ block: 0, offset: 3 });
    rd.del();
    expect(rd.blockCount).toBe(1);
    expect(docText(rd)).toEqual(['abcdef']);
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
  });
});

describe('enter', () => {
  it('splits a paragraph in the middle into two paragraphs', () => {
    const rd = rdOf(para([text('abcd')]));
    rd.setSel({ block: 0, offset: 2 });
    rd.enter();
    expect(rd.blockCount).toBe(2);
    expect(docText(rd)).toEqual(['ab', 'cd']);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
    expect(rd.doc.blocks[1].type).toBe('paragraph');
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('at the end of a heading creates a paragraph as the new block', () => {
    const rd = rdOf(block('heading', [text('Title')], { level: 1 }));
    rd.setSel({ block: 0, offset: 5 });
    rd.enter();
    expect(rd.blockCount).toBe(2);
    expect(rd.doc.blocks[0].type).toBe('heading');
    expect(rd.doc.blocks[1].type).toBe('paragraph');
    expect(docText(rd)).toEqual(['Title', '']);
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('on an empty bullet_item lifts it to a paragraph without adding a block', () => {
    const rd = rdOf(block('bullet_item', [text('')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.enter();
    expect(rd.blockCount).toBe(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
    expect(docText(rd)).toEqual(['']);
  });
});

describe('cross-block selection delete', () => {
  it('insertText over a cross-block selection merges into one block', () => {
    const rd = rdOf(para([text('hello')]), para([text('world')]));
    rd.setSel({ block: 0, offset: 3 });
    rd.setSel({ block: 1, offset: 2 }, true); // anchor {0,3} .. focus {1,2}
    expect(rd.isCollapsed).toBe(false);
    rd.insertText('');
    // insertText('') is a no-op; drive the deletion via a real insertion instead
    rd.insertText('X');
    expect(rd.blockCount).toBe(1);
    expect(docText(rd)).toEqual(['helXrld']);
  });

  it('backspace over a cross-block selection merges into one block', () => {
    const rd = rdOf(para([text('hello')]), para([text('world')]));
    rd.setSel({ block: 0, offset: 3 });
    rd.setSel({ block: 1, offset: 2 }, true);
    rd.backspace();
    expect(rd.blockCount).toBe(1);
    expect(docText(rd)).toEqual(['helrld']);
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
  });
});

describe('toggleMark on a selection', () => {
  it('adds bold to a selection, then removes it', () => {
    const rd = rdOf(para([text('abcd')]));
    rd.setSel({ block: 0, offset: 1 });
    rd.setSel({ block: 0, offset: 3 }, true); // select "bc"
    expect(rd.markActive('bold')).toBe(false);
    rd.toggleMark('bold');
    expect(rd.markActive('bold')).toBe(true);
    // toggling again over the same (fully-covered) selection removes it
    rd.toggleMark('bold');
    expect(rd.markActive('bold')).toBe(false);
    expect(docText(rd)).toEqual(['abcd']);
  });
});

describe('undo / redo', () => {
  it('undo restores text after an insert, redo re-applies it', () => {
    const rd = rdOf(para([text('')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('hello');
    expect(docText(rd)).toEqual(['hello']);
    rd.undo();
    expect(docText(rd)).toEqual(['']);
    rd.redo();
    expect(docText(rd)).toEqual(['hello']);
  });
});

// 段落排版块级 setter：覆盖选区每块的 attrs，进撤销栈（snapshot），可 undo。
describe('段落排版 setter（块级，进撤销栈）', () => {
  it('setLineHeight 设置选区各块行距，undo 还原', () => {
    const rd = rdOf(para([text('a')]), para([text('b')]));
    rd.selectAll();
    rd.setLineHeight(1.5);
    expect(rd.doc.blocks.map((b) => b.attrs.lineHeight)).toEqual([1.5, 1.5]);
    rd.undo();
    expect(rd.doc.blocks.map((b) => b.attrs.lineHeight)).toEqual([undefined, undefined]);
  });

  it('setSpaceBefore / setSpaceAfter 夹到 ≥0', () => {
    const rd = rdOf(para([text('a')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.setSpaceBefore(12);
    rd.setSpaceAfter(20);
    expect(rd.doc.blocks[0].attrs.spaceBefore).toBe(12);
    expect(rd.doc.blocks[0].attrs.spaceAfter).toBe(20);
    rd.setSpaceBefore(-5);
    expect(rd.doc.blocks[0].attrs.spaceBefore).toBe(0);
  });

  it('setIndent 设置左缩进，夹到 ≥0', () => {
    const rd = rdOf(para([text('a')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.setIndent(48);
    expect(rd.doc.blocks[0].attrs.indent).toBe(48);
    rd.setIndent(-10);
    expect(rd.doc.blocks[0].attrs.indent).toBe(0);
  });

  it('adjustIndent 以当前缩进为基线增减，夹到 ≥0', () => {
    const rd = rdOf(para([text('a')], { indent: 10 }), para([text('b')]));
    rd.selectAll();
    rd.adjustIndent(24);
    expect(rd.doc.blocks.map((b) => b.attrs.indent)).toEqual([34, 24]); // 第二块从 0 起
    rd.adjustIndent(-100);
    expect(rd.doc.blocks.map((b) => b.attrs.indent)).toEqual([0, 0]);
  });

  it('setLetterSpacing 设置字间距（≥0）', () => {
    const rd = rdOf(para([text('a')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.setLetterSpacing(3);
    expect(rd.doc.blocks[0].attrs.letterSpacing).toBe(3);
    rd.setLetterSpacing(-1);
    expect(rd.doc.blocks[0].attrs.letterSpacing).toBe(0);
  });

  it('setAlign 支持 justify / distribute，undo 还原', () => {
    const rd = rdOf(para([text('a')]));
    rd.setSel({ block: 0, offset: 0 });
    rd.setAlign('justify');
    expect(rd.doc.blocks[0].attrs.align).toBe('justify');
    rd.setAlign('distribute');
    expect(rd.doc.blocks[0].attrs.align).toBe('distribute');
    rd.undo();
    expect(rd.doc.blocks[0].attrs.align).toBe('justify');
  });
});

describe('setDoc — 取得所有权但不就地改写消费者源对象（与 replaceDoc 一致克隆）', () => {
  it('setDoc 后编辑不改写传入的源 Doc（深拷贝隔离）', () => {
    const rd = rdOf(para([text('orig')]));
    const source: Doc = doc(para([text('hello')]));
    rd.setDoc(source);
    rd.setSel(rd.docEnd());
    rd.insertText(' world');
    // 内部已改写
    expect(blockText(rd.doc.blocks[0])).toBe('hello world');
    // 源对象不受影响（克隆隔离），可安全复用
    expect(blockText(source.blocks[0])).toBe('hello');
    expect(rd.doc).not.toBe(source);
    expect(rd.doc.blocks[0]).not.toBe(source.blocks[0]);
  });

  it('setDoc 光标置文末、进撤销栈（undo 回原文档）', () => {
    const rd = rdOf(para([text('A')]));
    rd.setDoc(doc(para([text('xyz')])));
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('A');
  });

  it('setDoc 空文档回退为单空段落', () => {
    const rd = rdOf(para([text('A')]));
    rd.setDoc({ blocks: [] });
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });
});
