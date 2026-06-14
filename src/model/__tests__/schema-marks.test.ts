import { describe, it, expect } from 'vitest';
import {
  markOrder, isNonInclusive, isInclusive, sortMarks, inlineAtom, cloneInline, MarkType, Mark, InlineAtom,
} from '../schema';

// schema marks helper 单测：markOrder/isNonInclusive 封装内部常量、与 sortMarks/isInclusive 的一致性，
// 以及行内原子 marks 的 readonly [] 空不变量。

describe('markOrder', () => {
  it('已登记类型返回非负次序权，且 fontFamily/fontSize 排在外观/装饰类之前', () => {
    expect(markOrder('fontFamily')).toBe(0);
    expect(markOrder('fontSize')).toBe(1);
    expect(markOrder('bold')).toBeGreaterThan(markOrder('fontSize'));
    // link 排在装饰段末尾
    expect(markOrder('link')).toBeGreaterThan(markOrder('color'));
  });

  it('sortMarks 与 markOrder 次序一致（同内容唯一表示）', () => {
    const unsorted: Mark[] = [{ type: 'link' }, { type: 'bold' }, { type: 'fontSize' }];
    const sorted = sortMarks(unsorted);
    const orders = sorted.map((m) => markOrder(m.type));
    // 升序排列
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(sorted.map((m) => m.type)).toEqual(['fontSize', 'bold', 'link']);
  });
});

describe('isNonInclusive / isInclusive', () => {
  it('link 与 code 为非包含型，其余为包含型', () => {
    expect(isNonInclusive('link')).toBe(true);
    expect(isNonInclusive('code')).toBe(true);
    expect(isNonInclusive('bold')).toBe(false);
    expect(isNonInclusive('color')).toBe(false);
  });

  it('isInclusive 与 isNonInclusive 严格互为反义', () => {
    const all: MarkType[] = [
      'bold', 'italic', 'underline', 'strikethrough', 'highlight', 'code', 'color', 'link',
      'fontFamily', 'fontSize', 'superscript', 'subscript',
    ];
    for (const t of all) expect(isInclusive(t)).toBe(!isNonInclusive(t));
  });
});

describe('行内原子 marks 空不变量', () => {
  it('构造与深拷贝后 marks 恒为空数组', () => {
    const a = inlineAtom('image', { src: 'x.png' });
    expect(a.marks).toEqual([]);
    const c = cloneInline(a) as InlineAtom;
    expect(c.marks).toEqual([]);
    expect(c.marks).not.toBe(a.marks); // 拷贝不共享同一数组引用
  });
});
