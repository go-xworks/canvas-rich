// 文档区间切片（model 层纯函数）：把 [from,to] 选区切出为独立 Doc 片段，
// 是剪贴板富文本复制（editor/clipboard → toHtml）与片段插入（RichDoc.insertFragment）的数据源。
import {
  Doc,
  Block,
  block as mkBlock,
  blockTextLen,
  cloneBlockAttrs,
  cloneInline,
  cloneDoc,
  isAtomBlock,
} from './schema';
import { sliceInlines } from './inlines';
import { Pos, comparePos } from './rich-document';

/**
 * 把文档的 [from,to] 区间切为独立 Doc 片段：首/末文本块按 offset 切行内子区间（保 marks 与
 * 行内原子），中间块整块保留；原子块（图片/表格等，文本长恒 0）整块保留 attrs。
 * 产物经 {@link cloneDoc} 深拷，与原文档零共享引用（剪贴板/片段插入安全）。
 * from/to 无序时自动交换；越界块号/偏移被夹回合法范围。
 * @public
 */
export function sliceDocRange(doc: Doc, from: Pos, to: Pos): Doc {
  if (comparePos(from, to) > 0) {
    const t = from;
    from = to;
    to = t;
  }
  const blocks: Block[] = [];
  const lastBi = Math.min(to.block, doc.blocks.length - 1);
  for (let bi = Math.max(0, from.block); bi <= lastBi; bi++) {
    const b = doc.blocks[bi];
    // 原子块（无文本，offset 恒 0）：选区覆盖即整块保留（attrs 含表格 rows/图片 src 等）
    if (isAtomBlock(b.type)) {
      blocks.push({ type: b.type, attrs: cloneBlockAttrs(b.attrs), inlines: b.inlines.map(cloneInline) });
      continue;
    }
    const len = blockTextLen(b);
    const s = bi === from.block ? Math.min(Math.max(0, from.offset), len) : 0;
    const e = bi === to.block ? Math.min(Math.max(0, to.offset), len) : len;
    blocks.push(mkBlock(b.type, sliceInlines(b.inlines, s, e), cloneBlockAttrs(b.attrs)));
  }
  // 深拷收尾：sliceInlines 的产物与源段共享 marks 数组引用，整体 cloneDoc 保证零共享
  return cloneDoc({ blocks });
}
