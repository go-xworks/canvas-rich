import bidiFactory from 'bidi-js';

// text 层：Unicode 双向算法（UBA）封装。把逻辑序元素按 BiDi level 重排成视觉序，供 doc-layout 排版用。
const bidi = bidiFactory();

/** 匹配 RTL 码位（希伯来/阿拉伯及相关标点），跳过纯 LTR 文本的 BiDi 开销。 @internal */
const RTL_PATTERN = /[֐-׿؀-ۿ܀-ݏࢠ-ࣿיִ-﷿ﹰ-﻿]/;
/** 文本是否可能需要 BiDi 处理（基方向 RTL，或含任一 RTL 码位）。 @public */
export function mayBeBidi(text: string, baseRtl: boolean): boolean {
  return baseRtl || RTL_PATTERN.test(text);
}

/**
 * 计算每个字符的 embedding level（逻辑序）。
 * @param base 段落基方向
 * @public
 */
export function embeddingLevels(text: string, base: 'ltr' | 'rtl'): number[] {
  if (!text) return [];
  return Array.from(bidi.getEmbeddingLevels(text, base).levels) as number[];
}

/**
 * UBA 阶段 L2 重排：输入各元素 level（逻辑序），返回视觉序映射 `order`，
 * 其中 `order[v]` = 视觉位置 v 应放置的逻辑下标。纯 LTR（全偶 level）原样返回。
 * @public
 */
export function visualOrder(levels: number[]): number[] {
  const n = levels.length;
  const order = Array.from({ length: n }, (_, i) => i);
  let maxL = 0, minOdd = Infinity;
  for (const l of levels) { if (l > maxL) maxL = l; if (l % 2 && l < minOdd) minOdd = l; }
  if (!isFinite(minOdd)) return order; // 全偶（纯 LTR）→ 不重排
  for (let lvl = maxL; lvl >= minOdd; lvl--) {
    let i = 0;
    while (i < n) {
      if (levels[i] >= lvl) {
        let j = i; while (j + 1 < n && levels[j + 1] >= lvl) j++;
        let a = i, b = j; while (a < b) { const t = order[a]; order[a] = order[b]; order[b] = t; a++; b--; }
        i = j + 1;
      } else i++;
    }
  }
  return order;
}
