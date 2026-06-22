import { describe, it, expect } from 'vitest';
import { nextWordBoundary, prevWordBoundary, wordRangeAt } from '../word-boundary';

// 词边界基元（UAX#29 word 粒度）：⌥←/→ 词跳转、⌥⌫/⌥Del 删词的偏移计量。
// 语义：next = 严格大于 offset 的下一个「词尾」；prev = 严格小于 offset 的上一个「词首」；
// 空白/标点一并跨过；无词时 next 返回串长、prev 返回 0。

describe('nextWordBoundary — 拉丁词', () => {
  const s = 'foo bar baz';
  it('词内/词首 → 当前词尾', () => {
    expect(nextWordBoundary(s, 0)).toBe(3);
    expect(nextWordBoundary(s, 1)).toBe(3);
    expect(nextWordBoundary(s, 4)).toBe(7);
  });
  it('词尾/空白中 → 跨过空白到下一词尾', () => {
    expect(nextWordBoundary(s, 3)).toBe(7);
    expect(nextWordBoundary(s, 8)).toBe(11);
  });
  it('末词尾之后无词 → 串长', () => {
    expect(nextWordBoundary(s, 11)).toBe(11);
    expect(nextWordBoundary('  hi  ', 4)).toBe(6); // 尾随空白一并跨过
  });
});

describe('prevWordBoundary — 拉丁词', () => {
  const s = 'foo bar baz';
  it('词内/词尾 → 当前词首', () => {
    expect(prevWordBoundary(s, 11)).toBe(8);
    expect(prevWordBoundary(s, 5)).toBe(4);
  });
  it('词首/空白中 → 跨过空白到上一词首', () => {
    expect(prevWordBoundary(s, 8)).toBe(4);
    expect(prevWordBoundary(s, 4)).toBe(0);
    expect(prevWordBoundary(s, 3)).toBe(0);
  });
  it('首词之前无词 → 0', () => {
    expect(prevWordBoundary(s, 0)).toBe(0);
    expect(prevWordBoundary('  hi  ', 2)).toBe(0); // 前导空白一并跨过
  });
});

describe('标点与空白跨越', () => {
  it('标点不算词：跨过标点定位到词边界', () => {
    const s = 'a, b';
    expect(nextWordBoundary(s, 0)).toBe(1);
    expect(nextWordBoundary(s, 1)).toBe(4); // 跨过 ", " 到 'b' 词尾
    expect(prevWordBoundary(s, 4)).toBe(3);
    expect(prevWordBoundary(s, 3)).toBe(0); // 跨过 ", " 到 'a' 词首
  });
  it('前导空白中 next → 首词词尾', () => {
    expect(nextWordBoundary('  hi  ', 0)).toBe(4);
  });
});

describe('CJK 词典分词（Intl.Segmenter word 粒度）', () => {
  it('中文按词推进（你好|世界）', () => {
    expect(nextWordBoundary('你好世界', 0)).toBe(2);
    expect(nextWordBoundary('你好世界', 2)).toBe(4);
    expect(nextWordBoundary('你好世界', 1)).toBe(2); // 词内 → 当前词尾
    expect(prevWordBoundary('你好世界', 4)).toBe(2);
    expect(prevWordBoundary('你好世界', 3)).toBe(2);
    expect(prevWordBoundary('你好世界', 2)).toBe(0);
  });
  it('中英混排跨空格', () => {
    const s = 'hello 世界';
    expect(nextWordBoundary(s, 0)).toBe(5);
    expect(nextWordBoundary(s, 5)).toBe(8);
    expect(prevWordBoundary(s, 8)).toBe(6);
    expect(prevWordBoundary(s, 6)).toBe(0);
  });
});

describe('不可分割单元与边界条件', () => {
  it('emoji（surrogate + 修饰符序列）不被劈开', () => {
    const s = '👍🏽x'; // 👍🏽 占 4 个 UTF-16 单元
    expect(nextWordBoundary(s, 0)).toBe(5); // 跨过非词 emoji 到 'x' 词尾
    expect(nextWordBoundary(s, 1)).toBe(5); // 不会落在 emoji 内部
    expect(prevWordBoundary(s, 5)).toBe(4);
  });
  it('行内原子占位符（U+FFFC）按非词跨过', () => {
    const s = 'foo￼bar';
    expect(nextWordBoundary(s, 0)).toBe(3);
    expect(nextWordBoundary(s, 3)).toBe(7);
    expect(prevWordBoundary(s, 7)).toBe(4);
    expect(prevWordBoundary(s, 5)).toBe(4);
  });
  it('空串恒为 0', () => {
    expect(nextWordBoundary('', 0)).toBe(0);
    expect(prevWordBoundary('', 0)).toBe(0);
  });
});

describe('wordRangeAt — 双击/长按选词区间', () => {
  const s = 'foo bar baz';
  it('词内/词首 → 当前词 [start,end)', () => {
    expect(wordRangeAt(s, 5)).toEqual({ start: 4, end: 7 });
    expect(wordRangeAt(s, 4)).toEqual({ start: 4, end: 7 });
    expect(wordRangeAt(s, 0)).toEqual({ start: 0, end: 3 });
  });
  it('词尾边界（词｜空白）偏向左侧词；串尾取末词', () => {
    expect(wordRangeAt(s, 3)).toEqual({ start: 0, end: 3 });
    expect(wordRangeAt(s, 11)).toEqual({ start: 8, end: 11 });
  });
  it('CJK 词典分词（Intl.Segmenter）', () => {
    const r = wordRangeAt('你好世界', 1);
    expect(r.start).toBe(0);
    expect(r.end).toBeGreaterThan(0); // 词典差异容忍：至少切出含 offset 的词段
    expect(r.end).toBeLessThanOrEqual(4);
  });
  it('空白/标点段内 → 选该段自身（与浏览器双击空白一致）', () => {
    const r = wordRangeAt('a   b', 2); // 三连空格中间
    expect(r.start).toBe(1);
    expect(r.end).toBe(4);
  });
  it('空串与越界 offset 安全', () => {
    expect(wordRangeAt('', 0)).toEqual({ start: 0, end: 0 });
    expect(wordRangeAt('hi', 99)).toEqual({ start: 0, end: 2 });
    expect(wordRangeAt('hi', -1)).toEqual({ start: 0, end: 2 });
  });
});
