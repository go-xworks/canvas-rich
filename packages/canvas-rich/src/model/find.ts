// 全文查找（model 层纯函数）：在文档块文本上做大小写不敏感的纯文本匹配，
// 产出块内 [start,end) 命中区间，供查找条高亮/跳转与替换（RichDoc.replace*）消费。
import { Doc, blockText, isAtomBlock } from './schema';

/** 单个查找命中：块号 + 块内 UTF-16 区间 [start,end)。 @public */
export interface FindMatch {
  block: number;
  start: number;
  end: number;
}

/**
 * 全文查找（纯函数）：逐块在纯文本上匹配 query，大小写不敏感（toLowerCase 双侧折叠），
 * 块内从左到右、非重叠推进；原子块（图片/表格等，无可检索文本）跳过；空查询返回空。
 * 行内原子的占位符（U+FFFC）参与块文本，天然阻断「跨原子」的伪匹配。
 * 大小写折叠会改变长度的稀有字符（如 'İ'）：该块退化为区分大小写匹配，保证偏移精确。
 * @public
 */
export function findMatches(doc: Doc, query: string): FindMatch[] {
  const out: FindMatch[] = [];
  if (!query) return out;
  const q = query.toLowerCase();
  for (let bi = 0; bi < doc.blocks.length; bi++) {
    const b = doc.blocks[bi];
    if (isAtomBlock(b.type)) continue;
    const textStr = blockText(b);
    if (!textStr) continue;
    const lower = textStr.toLowerCase();
    // 折叠不改长度（绝大多数文本）才能用折叠串的偏移；否则退回原串精确匹配
    const foldable = lower.length === textStr.length;
    const hay = foldable ? lower : textStr;
    const needle = foldable ? q : query;
    if (!needle || needle.length > hay.length) continue;
    let at = hay.indexOf(needle);
    while (at >= 0) {
      out.push({ block: bi, start: at, end: at + needle.length });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return out;
}
