import { describe, it, expect } from 'vitest';
import {
  normalizeInlines,
  normalizeCellInlines,
  sliceInlines,
  insertText,
  deleteRange,
  splitInlines,
  applyMark,
  rangeHasMark,
  marksAt,
  inlineAtomSrcAt,
} from '../inlines';
import { text, inlineAtom, Inline } from '../schema';

// 把 Inline[] 摘成易断言形式：每段 -> [text, "type1,type2,..."]（marks 类型集合，逗号连接）
const summary = (inls: Inline[]): [string, string][] => inls.map((r) => [r.text, r.marks.map((m) => m.type).join(',')]);

const bold = [{ type: 'bold' as const }];
const link = (href: string) => [{ type: 'link' as const, attrs: { href } }];

describe('normalizeInlines', () => {
  it('合并相邻同 marks 的文本段', () => {
    expect(summary(normalizeInlines([text('a'), text('b')]))).toEqual([['ab', '']]);
  });

  it('不合并相邻不同 marks 的文本段', () => {
    expect(summary(normalizeInlines([text('a', bold), text('b')]))).toEqual([
      ['a', 'bold'],
      ['b', ''],
    ]);
  });

  it('删除空文本段', () => {
    expect(summary(normalizeInlines([text('a'), text(''), text('b')]))).toEqual([['ab', '']]);
  });

  it('全空输入归一化为单个空文本段', () => {
    expect(summary(normalizeInlines([]))).toEqual([['', '']]);
    expect(summary(normalizeInlines([text(''), text('')]))).toEqual([['', '']]);
  });

  it('marksEqual 与顺序无关：[bold,italic] 与 [italic,bold] 应能合并', () => {
    // text() 会对 marks 排序，两段内容上 marks 集合相同即可合并为一段
    const a = text('a', [{ type: 'bold' }, { type: 'italic' }]);
    const b = text('b', [{ type: 'italic' }, { type: 'bold' }]);
    const out = normalizeInlines([a, b]);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('ab');
    expect(out[0].marks.map((m) => m.type).sort()).toEqual(['bold', 'italic']);
  });
});

describe('normalizeCellInlines（td 不承载行内原子，集群3）', () => {
  it('剔除行内原子并合并被其隔开的同 marks 文本段', () => {
    const out = normalizeCellInlines([text('a'), inlineAtom('image', { src: 'x.png' }), text('b')]);
    expect(summary(out)).toEqual([['ab', '']]);
  });

  it('仅含原子的序列归一化为单个空段（承载光标）', () => {
    expect(summary(normalizeCellInlines([inlineAtom('image', { src: 'x.png' })]))).toEqual([['', '']]);
  });

  it('文本段的 marks 原样保留（仅过滤原子，不动文本）', () => {
    const out = normalizeCellInlines([text('a', bold), inlineAtom('image', {}), text('b', bold)]);
    expect(summary(out)).toEqual([['ab', 'bold']]);
  });
});

describe('sliceInlines', () => {
  it('取子串并保留 marks', () => {
    const inls = [text('hello', bold)];
    expect(summary(sliceInlines(inls, 1, 3))).toEqual([['el', 'bold']]);
  });

  it('跨多个 run 的切片各自保留 marks', () => {
    const inls = [text('ab', bold), text('cd'), text('ef', link('x'))];
    // 全长 6；切 [1,5) -> 'b'(bold) 'cd'() 'e'(link)
    expect(summary(sliceInlines(inls, 1, 5))).toEqual([
      ['b', 'bold'],
      ['cd', ''],
      ['e', 'link'],
    ]);
  });

  it('空区间归一化为单个空段', () => {
    expect(summary(sliceInlines([text('abc')], 2, 2))).toEqual([['', '']]);
  });
});

describe('insertText / deleteRange / splitInlines', () => {
  it('insertText 在中间插入', () => {
    const inls = [text('ad')];
    expect(summary(insertText(inls, 1, 'bc', []))).toEqual([['abcd', '']]);
  });

  it('insertText 带 marks 的插入不会与相邻无 mark 段合并', () => {
    const inls = [text('ad')];
    expect(summary(insertText(inls, 1, 'X', bold))).toEqual([
      ['a', ''],
      ['X', 'bold'],
      ['d', ''],
    ]);
  });

  it('deleteRange 删除中间', () => {
    const inls = [text('abcd')];
    expect(summary(deleteRange(inls, 1, 3))).toEqual([['ad', '']]);
  });

  it('splitInlines 在 at 处切两半', () => {
    const inls = [text('abcd', bold)];
    const [left, right] = splitInlines(inls, 2);
    expect(summary(left)).toEqual([['ab', 'bold']]);
    expect(summary(right)).toEqual([['cd', 'bold']]);
  });
});

describe('applyMark / rangeHasMark', () => {
  it('加粗 [0,2) 把单段切成命中段(bold) + 其余', () => {
    const inls = [text('abcd')];
    const out = applyMark(inls, 0, 2, { type: 'bold' }, true);
    expect(summary(out)).toEqual([
      ['ab', 'bold'],
      ['cd', ''],
    ]);
  });

  it('applyMark add=false 去掉之前加的 mark', () => {
    const inls = [text('abcd')];
    const added = applyMark(inls, 0, 2, { type: 'bold' }, true);
    const removed = applyMark(added, 0, 2, { type: 'bold' }, false);
    // 去掉后 'ab' 无 mark，与 'cd' 合并
    expect(summary(removed)).toEqual([['abcd', '']]);
  });

  it('rangeHasMark：全覆盖返回 true', () => {
    const inls = [text('abcd', bold)];
    expect(rangeHasMark(inls, 0, 4, 'bold')).toBe(true);
    expect(rangeHasMark(inls, 1, 3, 'bold')).toBe(true);
  });

  it('rangeHasMark：部分覆盖返回 false', () => {
    const inls = [text('ab', bold), text('cd')];
    expect(rangeHasMark(inls, 0, 4, 'bold')).toBe(false);
    // 命中区间内一部分有一部分没有
    expect(rangeHasMark(inls, 1, 3, 'bold')).toBe(false);
  });

  it('rangeHasMark：空区间返回 false', () => {
    const inls = [text('abcd', bold)];
    expect(rangeHasMark(inls, 2, 2, 'bold')).toBe(false);
  });

  it('applyMark 命中段在 run 中间时切成左外/中/右外三段，仅中段带新 mark', () => {
    const inls = [text('abcde')];
    const out = applyMark(inls, 1, 4, { type: 'bold' }, true);
    expect(summary(out)).toEqual([
      ['a', ''],
      ['bcd', 'bold'],
      ['e', ''],
    ]);
  });
});

describe('marksAt（打字继承）', () => {
  it('bold 段内部继承 bold', () => {
    const inls = [text('abcd', bold)];
    expect(marksAt(inls, 2).map((m) => m.type)).toEqual(['bold']);
  });

  it('bold 段右边界继承 bold（inclusive）', () => {
    // 全文为 bold，offset=4 落在 bold 段右缘
    const inls = [text('abcd', bold)];
    expect(marksAt(inls, 4).map((m) => m.type)).toEqual(['bold']);
  });

  it('link 段右边界不继承（non-inclusive）→ []', () => {
    // 'ab'(link) + 'cd'()，offset=2 在 link 右边界、普通段左边界
    const inls = [text('ab', link('x')), text('cd')];
    expect(marksAt(inls, 2).map((m) => m.type)).toEqual([]);
  });

  it('link 段右边界且右侧仍是 link 时继续继承', () => {
    // 整段都是同一 link，offset=2 右边界但右侧段也含 link -> 继承
    const inls = [text('ab', link('x')), text('cd', link('x'))];
    expect(marksAt(inls, 2).map((m) => m.type)).toEqual(['link']);
  });

  it('offset=0（块首）以右侧段 marks 为主', () => {
    const inls = [text('ab', bold), text('cd')];
    expect(marksAt(inls, 0).map((m) => m.type)).toEqual(['bold']);
  });
});

describe('inlineAtomSrcAt（行内原子 src 查询，main.ts 覆盖层映射下沉）', () => {
  it('offset 恰为行内原子起始 → 返回其 src', () => {
    const inls: Inline[] = [text('ab'), inlineAtom('image', { src: 'data:img' }), text('cd')];
    expect(inlineAtomSrcAt(inls, 2)).toBe('data:img');
  });

  it('offset 落在文本段上（即使后面存在原子）→ 空串', () => {
    const inls: Inline[] = [text('ab'), inlineAtom('image', { src: 'data:img' })];
    expect(inlineAtomSrcAt(inls, 0)).toBe('');
    expect(inlineAtomSrcAt(inls, 1)).toBe('');
    expect(inlineAtomSrcAt(inls, 3)).toBe(''); // 原子之后（序列末尾）
  });

  it('原子 src 缺省 → 空串兜底', () => {
    const inls: Inline[] = [inlineAtom('image', {})];
    expect(inlineAtomSrcAt(inls, 0)).toBe('');
  });

  it('块首原子（offset 0）命中', () => {
    const inls: Inline[] = [inlineAtom('image', { src: 'u' }), text('x')];
    expect(inlineAtomSrcAt(inls, 0)).toBe('u');
  });
});
