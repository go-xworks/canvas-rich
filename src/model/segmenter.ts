// Intl.Segmenter 最小本地类型 + 获取函数（model 层共享）：Intl.Segmenter 未必在当前 TS lib 中，
// 此处集中声明（避免 any）。grapheme.ts 与 word-boundary.ts 此前各持一份同构拷贝
//（SegmenterCtor 形状两处重复维护）——CONVENTIONS §4「第 2 次复制即抽取」收敛于此。

/**
 * Intl.Segmenter 分段数据的最小面：grapheme 粒度只消费 segment；
 * word 粒度另读 index（段起始 UTF-16 偏移）与 isWordLike（空白/标点为 false）。
 * @public
 */
export interface SegmentData { segment: string; index: number; isWordLike?: boolean }

/** Intl.Segmenter 实例最小面。 @public */
export interface IntlSegmenter { segment(input: string): Iterable<SegmentData>; }

/** Intl.Segmenter 构造器最小面（new (locales?, { granularity })）。 @public */
export interface SegmenterCtor {
  new (locales?: string | string[], options?: { granularity?: 'grapheme' | 'word' | 'sentence' }): IntlSegmenter;
}

/**
 * 按粒度创建 UAX#29 分段器；环境不支持 Intl.Segmenter 时返回 null（调用方自带回退：
 * grapheme → 码位切分，word → 词字符类扫描）。
 * @public
 */
export function createSegmenter(granularity: 'grapheme' | 'word'): IntlSegmenter | null {
  const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity }) : null;
}
