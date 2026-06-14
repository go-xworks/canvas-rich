import { describe, it, expect } from 'vitest';
import {
  text,
  inlineAtom,
  isInlineAtom,
  cloneDoc,
  cloneInline,
  blockText,
  blockTextLen,
  para,
  Inline,
  ATOM_PLACEHOLDER,
  InlineAtom,
} from '../schema';
import {
  normalizeInlines,
  sliceInlines,
  insertText,
  deleteRange,
  splitInlines,
  applyMark,
  marksAt,
  rangeHasMark,
} from '../inlines';

// 行内原子（行内图片）单测：占 1 UTF-16 offset、不可分割。
// 摘要工具：每段 -> [text|'(atom)', marks 类型集合]
const img = (src: string) => inlineAtom('image', { src });
const summary = (inls: Inline[]): [string, string][] =>
  inls.map((r) => [isInlineAtom(r) ? '(atom)' : r.text, r.marks.map((m) => m.type).join(',')]);
const bold = [{ type: 'bold' as const }];

describe('schema: 行内原子构造与守卫', () => {
  it('inlineAtom 占 1 offset（text=占位符，长度 1），marks 恒空', () => {
    const a = img('x.png');
    expect(isInlineAtom(a)).toBe(true);
    expect(a.text).toBe(ATOM_PLACEHOLDER);
    expect(a.text.length).toBe(1);
    expect(a.marks).toEqual([]);
    expect(a.attrs.src).toBe('x.png');
  });

  it('blockText/blockTextLen 把行内原子计为 1 个 offset', () => {
    const b = para([text('ab'), img('x'), text('cd')]);
    expect(blockTextLen(b)).toBe(5); // a b (atom) c d
    expect(blockText(b).length).toBe(5);
  });

  it('cloneInline / cloneDoc 保留原子身份（不退化为文本段）', () => {
    const a = img('x.png');
    const c = cloneInline(a);
    expect(isInlineAtom(c)).toBe(true);
    expect((c as InlineAtom).attrs.src).toBe('x.png');
    expect(c).not.toBe(a); // 新对象
    expect((c as InlineAtom).attrs).not.toBe(a.attrs); // attrs 深拷贝

    const doc = { blocks: [para([text('a'), img('y'), text('b')])] };
    const cd = cloneDoc(doc);
    const inls = cd.blocks[0].inlines;
    expect(isInlineAtom(inls[1])).toBe(true);
    expect((inls[1] as InlineAtom).attrs.src).toBe('y');
  });
});

describe('inlines: normalize 不合并/不删除原子', () => {
  it('原子原样保留，不与相邻同 marks 文本合并', () => {
    expect(summary(normalizeInlines([text('a'), img('x'), text('b')]))).toEqual([
      ['a', ''],
      ['(atom)', ''],
      ['b', ''],
    ]);
  });

  it('两个相邻原子各自保留（互不合并）', () => {
    expect(summary(normalizeInlines([img('x'), img('y')]))).toEqual([
      ['(atom)', ''],
      ['(atom)', ''],
    ]);
  });
});

describe('inlines: slice 把原子当不可分 1 长度单元', () => {
  // 序列 'ab' + atom + 'cd'，全长 5；offset 2 = atom 左缘，offset 3 = atom 右缘
  const seq = (): Inline[] => [text('ab'), img('x'), text('cd')];

  it('切到原子左缘 [0,2) 不含原子', () => {
    expect(summary(sliceInlines(seq(), 0, 2))).toEqual([['ab', '']]);
  });

  it('切含原子 [2,3) 得到整个原子', () => {
    const out = sliceInlines(seq(), 2, 3);
    expect(out.length).toBe(1);
    expect(isInlineAtom(out[0])).toBe(true);
  });

  it('跨原子切 [1,4) 得到 b + atom + c，原子保持身份', () => {
    expect(summary(sliceInlines(seq(), 1, 4))).toEqual([
      ['b', ''],
      ['(atom)', ''],
      ['c', ''],
    ]);
    const out = sliceInlines(seq(), 1, 4);
    expect(isInlineAtom(out[1])).toBe(true);
  });

  it('切到原子内部不可能（长度 1）：[2,3) 即整段，永不半切', () => {
    // 任何与原子相交的区间都恰好覆盖其 [2,3)
    const out = sliceInlines(seq(), 0, 3);
    expect(summary(out)).toEqual([
      ['ab', ''],
      ['(atom)', ''],
    ]);
  });
});

describe('inlines: insert / delete / split 与原子', () => {
  it('在原子右侧插入文本（offset 3）', () => {
    const inls: Inline[] = [text('ab'), img('x')]; // 全长 3
    const out = insertText(inls, 3, 'Z', []);
    expect(summary(out)).toEqual([
      ['ab', ''],
      ['(atom)', ''],
      ['Z', ''],
    ]);
  });

  it('在原子左侧插入文本（offset 2）不切原子（与左侧同 marks 文本合并）', () => {
    const inls: Inline[] = [text('ab'), img('x')];
    const out = insertText(inls, 2, 'Z', []);
    // 'Z' 无 marks，与左侧 'ab' 合并为 'abZ'；原子原样保留在其后
    expect(summary(out)).toEqual([
      ['abZ', ''],
      ['(atom)', ''],
    ]);
    expect(isInlineAtom(out[1])).toBe(true);
  });

  it('在原子左侧插入带 marks 文本（不与无 mark 文本合并、不切原子）', () => {
    const inls: Inline[] = [text('ab'), img('x')];
    const out = insertText(inls, 2, 'Z', bold);
    expect(summary(out)).toEqual([
      ['ab', ''],
      ['Z', 'bold'],
      ['(atom)', ''],
    ]);
    expect(isInlineAtom(out[2])).toBe(true);
  });

  it('删除原子 [2,3) 整体移除', () => {
    const inls: Inline[] = [text('ab'), img('x'), text('cd')];
    const out = deleteRange(inls, 2, 3);
    expect(summary(out)).toEqual([['abcd', '']]); // 原子删后左右文本合并
  });

  it('删除一个码元即删整个原子（原子不可半删）', () => {
    const inls: Inline[] = [img('x'), text('cd')]; // 原子在 [0,1)
    expect(summary(deleteRange(inls, 0, 1))).toEqual([['cd', '']]);
  });

  it('split 在原子边界两侧切分', () => {
    const inls: Inline[] = [text('ab'), img('x'), text('cd')];
    const [l1, r1] = splitInlines(inls, 2); // 原子左缘
    expect(summary(l1)).toEqual([['ab', '']]);
    expect(isInlineAtom(r1[0])).toBe(true);
    const [l2, r2] = splitInlines(inls, 3); // 原子右缘
    expect(isInlineAtom(l2[1])).toBe(true);
    expect(summary(r2)).toEqual([['cd', '']]);
  });
});

describe('inlines: applyMark / rangeHasMark 跳过原子', () => {
  it('给跨原子区间加 bold：原子不被染色（保持原子身份、无 marks）', () => {
    const inls: Inline[] = [text('ab'), img('x'), text('cd')];
    const out = applyMark(inls, 0, 5, { type: 'bold' }, true);
    // a b -> bold, atom 不变, c d -> bold
    expect(summary(out)).toEqual([
      ['ab', 'bold'],
      ['(atom)', ''],
      ['cd', 'bold'],
    ]);
    expect(isInlineAtom(out[1])).toBe(true);
  });

  it('rangeHasMark：区间含原子（无 mark）→ 非全覆盖返回 false', () => {
    const inls: Inline[] = [text('ab', bold), img('x'), text('cd', bold)];
    expect(rangeHasMark(inls, 0, 5, 'bold')).toBe(false); // 原子无 bold
    expect(rangeHasMark(inls, 0, 2, 'bold')).toBe(true); // 不含原子区间全覆盖
  });

  it('marksAt：原子右缘打字不继承原子的（空）marks，回退文本段语义', () => {
    // 'ab'(bold) + atom，offset 3（原子右缘）：左侧是原子（marks 空）
    const inls: Inline[] = [text('ab', bold), img('x')];
    expect(marksAt(inls, 3).map((m) => m.type)).toEqual([]); // 原子无 marks
  });
});
