import { describe, it, expect } from 'vitest';
import { findMatches } from '../find';
import { RichDoc } from '../rich-document';
import { Doc, Block, para, block, text, inlineAtom, hasMarkType, blockText } from '../schema';

// 全文查找（model/find 纯函数）与替换原语（RichDoc.replaceTextRange / replaceAllTextRanges）：
// 跨 run 匹配、大小写不敏感、原子块跳过、非重叠推进；替换继承首字符 marks、单次撤销。

const doc = (...blocks: Block[]): Doc => ({ blocks });

describe('findMatches', () => {
  it('跨 run 匹配（marks 拆开的文本段在块文本上连续）', () => {
    const d = doc(para([text('he', [{ type: 'bold' }]), text('llo world')]));
    expect(findMatches(d, 'hello')).toEqual([{ block: 0, start: 0, end: 5 }]);
  });

  it('大小写不敏感（默认折叠）', () => {
    const d = doc(para([text('Hello World')]));
    expect(findMatches(d, 'hello')).toEqual([{ block: 0, start: 0, end: 5 }]);
    expect(findMatches(d, 'WORLD')).toEqual([{ block: 0, start: 6, end: 11 }]);
  });

  it('块内非重叠、从左到右推进', () => {
    const d = doc(para([text('aaa')]));
    expect(findMatches(d, 'aa')).toEqual([{ block: 0, start: 0, end: 2 }]);
    const d2 = doc(para([text('cat cat cat')]));
    expect(findMatches(d2, 'cat').map((m) => m.start)).toEqual([0, 4, 8]);
  });

  it('跨多块逐块匹配（块号正确）', () => {
    const d = doc(para([text('foo')]), para([text('xfoo')]));
    expect(findMatches(d, 'foo')).toEqual([
      { block: 0, start: 0, end: 3 },
      { block: 1, start: 1, end: 4 },
    ]);
  });

  it('原子块（图片/表格）跳过', () => {
    const d = doc(block('image', [text('')], { src: 'data:image/png;base64,img' }), para([text('img')]));
    expect(findMatches(d, 'img')).toEqual([{ block: 1, start: 0, end: 3 }]);
  });

  it('行内原子占位符阻断跨原子伪匹配', () => {
    const d = doc(para([text('a'), inlineAtom('image', { src: 's' }), text('b')]));
    expect(findMatches(d, 'ab')).toEqual([]);
  });

  it('CJK 匹配', () => {
    const d = doc(para([text('今天天气不错，天气真好')]));
    expect(findMatches(d, '天气').map((m) => m.start)).toEqual([2, 7]);
  });

  it('空查询/无命中返回空数组', () => {
    const d = doc(para([text('abc')]));
    expect(findMatches(d, '')).toEqual([]);
    expect(findMatches(d, 'zzz')).toEqual([]);
  });
});

describe('RichDoc.replaceTextRange', () => {
  it('替换文本继承区间首字符处 marks', () => {
    const rd = new RichDoc(doc(para([text('AB', [{ type: 'bold' }]), text('cd')])));
    rd.replaceTextRange(0, 0, 4, 'x');
    const b = rd.doc.blocks[0];
    expect(blockText(b)).toBe('x');
    expect(b.inlines[0].kind).toBe('text');
    expect(hasMarkType(b.inlines[0].marks, 'bold')).toBe(true);
  });

  it('区间首字符无 mark 则替换文本无 mark', () => {
    const rd = new RichDoc(doc(para([text('cd'), text('AB', [{ type: 'bold' }])])));
    rd.replaceTextRange(0, 0, 4, 'x');
    expect(blockText(rd.doc.blocks[0])).toBe('x');
    expect(rd.doc.blocks[0].inlines[0].marks).toEqual([]);
  });

  it('单次撤销恢复原文', () => {
    const rd = new RichDoc(doc(para([text('hello world')])));
    rd.replaceTextRange(0, 6, 11, '世界');
    expect(blockText(rd.doc.blocks[0])).toBe('hello 世界');
    expect(rd.canUndo).toBe(true);
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('hello world');
    expect(rd.canUndo).toBe(false); // 仅一条记录
  });

  it('光标落在替换文本末尾', () => {
    const rd = new RichDoc(doc(para([text('abc')])));
    rd.replaceTextRange(0, 1, 2, 'XY');
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
    expect(rd.isCollapsed).toBe(true);
  });
});

describe('RichDoc.replaceAllTextRanges', () => {
  it('同块多命中：等长/变长替换均偏移正确', () => {
    const rd = new RichDoc(doc(para([text('cat cat cat')])));
    rd.replaceAllTextRanges(findMatches(rd.doc, 'cat'), 'tiger');
    expect(blockText(rd.doc.blocks[0])).toBe('tiger tiger tiger');
  });

  it('缩短替换（删除式）偏移正确', () => {
    const rd = new RichDoc(doc(para([text('aXXbXXc')])));
    rd.replaceAllTextRanges(findMatches(rd.doc, 'XX'), '');
    expect(blockText(rd.doc.blocks[0])).toBe('abc');
  });

  it('跨多块替换 + 单次撤销', () => {
    const rd = new RichDoc(doc(para([text('foo bar')]), para([text('bar foo')])));
    rd.replaceAllTextRanges(findMatches(rd.doc, 'foo'), 'qux');
    expect(blockText(rd.doc.blocks[0])).toBe('qux bar');
    expect(blockText(rd.doc.blocks[1])).toBe('bar qux');
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('foo bar');
    expect(blockText(rd.doc.blocks[1])).toBe('bar foo');
    expect(rd.canUndo).toBe(false); // 全部替换 = 一条撤销记录
  });

  it('逐区间继承各自首字符 marks', () => {
    const rd = new RichDoc(doc(para([text('cat ', [{ type: 'bold' }]), text('cat')])));
    rd.replaceAllTextRanges(findMatches(rd.doc, 'cat'), 'dog');
    const b = rd.doc.blocks[0];
    expect(blockText(b)).toBe('dog dog');
    expect(hasMarkType(b.inlines[0].marks, 'bold')).toBe(true); // 'dog '（首命中承袭 bold）
    const last = b.inlines[b.inlines.length - 1];
    expect(hasMarkType(last.marks, 'bold')).toBe(false); // 第二命中无 mark
  });

  it('原子块/越界区间跳过；全为非法时不入撤销栈', () => {
    const rd = new RichDoc(doc(block('image', [text('')], { src: '' }), para([text('ab')])));
    rd.replaceAllTextRanges(
      [
        { block: 0, start: 0, end: 1 },
        { block: 1, start: 0, end: 99 },
      ],
      'x',
    );
    expect(rd.canUndo).toBe(false);
    expect(blockText(rd.doc.blocks[1])).toBe('ab');
  });

  it('光标落在文档序最后一个替换的末尾', () => {
    const rd = new RichDoc(doc(para([text('cat cat')])));
    rd.replaceAllTextRanges(findMatches(rd.doc, 'cat'), 'dog');
    expect(rd.focus).toEqual({ block: 0, offset: 7 });
  });
});
