import { describe, it, expect } from 'vitest';
import { splitGraphemes, clusterBoundaries, nextBoundary, prevBoundary } from '../grapheme';

// grapheme 切分与边界（光标/删除最小单位）。原 document.test.ts 的 splitGraphemes 用例迁移至此，
// 改测规范来源 grapheme.ts（document.ts 已作为死模块删除）。
describe('splitGraphemes', () => {
  it('splits ASCII into individual characters', () => {
    expect(splitGraphemes('abc')).toEqual(['a', 'b', 'c']);
  });

  it('splits Chinese into individual characters', () => {
    expect(splitGraphemes('你好世界')).toEqual(['你', '好', '世', '界']);
  });

  it('keeps an emoji + skin-tone modifier together (or degrades safely)', () => {
    const parts = splitGraphemes('👍🏽');
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.join('')).toBe('👍🏽');
    if ((Intl as any).Segmenter) expect(parts.length).toBe(1);
  });

  it('keeps a regional-indicator flag together (or degrades safely)', () => {
    const parts = splitGraphemes('🇨🇳');
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.join('')).toBe('🇨🇳');
    if ((Intl as any).Segmenter) expect(parts.length).toBe(1);
  });

  it('round-trips mixed content via join', () => {
    const text = 'a你👍🏽b';
    const parts = splitGraphemes(text);
    expect(parts.length).toBeGreaterThanOrEqual(1);
    expect(parts.join('')).toBe(text);
  });

  it('returns an empty array for empty input', () => {
    expect(splitGraphemes('')).toEqual([]);
  });
});

describe('clusterBoundaries / nextBoundary / prevBoundary', () => {
  it('includes 0 and the end offset', () => {
    expect(clusterBoundaries('abc')).toEqual([0, 1, 2, 3]);
  });

  it('treats a multi-unit grapheme as one boundary step', () => {
    // 👍🏽 占 4 个 UTF-16 单元，但只是一个簇 → 边界为 [0, 4]
    const b = clusterBoundaries('👍🏽');
    expect(b[0]).toBe(0);
    expect(b[b.length - 1]).toBe('👍🏽'.length);
    if ((Intl as any).Segmenter) expect(b).toEqual([0, '👍🏽'.length]);
  });

  it('nextBoundary moves to the next cluster edge', () => {
    expect(nextBoundary('abc', 0)).toBe(1);
    expect(nextBoundary('abc', 2)).toBe(3);
    expect(nextBoundary('abc', 3)).toBe(3); // 末尾不越界
  });

  it('nextBoundary skips a whole multi-unit grapheme', () => {
    const s = 'a👍🏽b';
    if ((Intl as any).Segmenter) expect(nextBoundary(s, 1)).toBe(1 + '👍🏽'.length);
  });

  it('prevBoundary moves to the previous cluster edge', () => {
    expect(prevBoundary('abc', 3)).toBe(2);
    expect(prevBoundary('abc', 1)).toBe(0);
    expect(prevBoundary('abc', 0)).toBe(0); // 开头不越界
  });
});
