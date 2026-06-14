import { Doc, blockTextLen } from './schema';

// 文档统计：段落数 / 字符数等纯函数，供状态栏（ui/status-bar）展示。
// 分层位置：model 层，纯函数只读文档树，不产生副作用，便于单测。

/**
 * 文档统计结果：块（段落）总数与字符总数。
 * blocks：文档中块的总数（含原子块）；
 * chars：拼接全部块文本后的字符长度（原子块文本通常为空，计 0）。
 * @public
 */
export interface DocStats {
  blocks: number;
  chars: number;
}

/**
 * 统计文档块数与字符数（纯函数，只读）。
 * 字符数 = 各块内行内文本长度之和（与 `blockText` 拼接长度一致）。
 * @public
 */
export function docStats(doc: Doc): DocStats {
  let chars = 0;
  for (const b of doc.blocks) chars += blockTextLen(b);
  return { blocks: doc.blocks.length, chars };
}

/**
 * 文档字符总数（各块行内文本长度之和）。
 * @public
 */
export function docCharCount(doc: Doc): number {
  let n = 0;
  for (const b of doc.blocks) n += blockTextLen(b);
  return n;
}
