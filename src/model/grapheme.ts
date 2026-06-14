// 按 grapheme cluster 切分（emoji/组合字符不被劈开）。光标移动/删除以此为最小单位。
// 分层位置：model 层的文本计量基元，供编辑/选区按字符簇推进。
import { createSegmenter } from './segmenter';

/** UAX#29 字符簇切分器（最小类型声明共享自 ./segmenter）；环境不支持 Intl.Segmenter 时为 null，splitGraphemes 回退到码位切分。 @internal */
const segmenter = createSegmenter('grapheme');

/**
 * 切分为 grapheme cluster 数组；优先 Intl.Segmenter，缺失时回退到码位切分。
 * 依据：组合字符/emoji ZWJ 序列须作为单簇，不能被劈开。
 * @public
 */
export function splitGraphemes(textStr: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(textStr), (s) => s.segment);
  return Array.from(textStr);
}

/** 返回字符串里所有「字符簇边界」的 UTF-16 偏移（含 0 与末尾，单调递增）。 @public */
export function clusterBoundaries(textStr: string): number[] {
  const bounds = [0];
  let off = 0;
  for (const g of splitGraphemes(textStr)) { off += g.length; bounds.push(off); }
  return bounds;
}

/** 返回严格大于 offset 的下一个簇边界；越界时返回串长。 @public */
export function nextBoundary(textStr: string, offset: number): number {
  for (const b of clusterBoundaries(textStr)) if (b > offset) return b;
  return textStr.length;
}
/** 返回严格小于 offset 的上一个簇边界；不存在时返回 0。 @public */
export function prevBoundary(textStr: string, offset: number): number {
  let prev = 0;
  for (const b of clusterBoundaries(textStr)) { if (b >= offset) return prev; prev = b; }
  return prev;
}
