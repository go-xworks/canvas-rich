import { Doc, Block, blockText, genBlockId } from './schema';

// 目录（TOC）扫描：从文档树抽取全部 heading，生成目录条目（标题文本 + 级别 + 目标块号 + 锚 id）。
// heading 块缺 id 时就地补一个稳定 id（供锚点/跨引用复用）。
// 分层位置：model 层，纯函数对文档树读/补 id，被 doc-layout（渲染目录行）与 export（输出目录）复用。

/**
 * 目录中的一条：来自某个 heading 块。
 * level：标题级别（1..6，用于按级缩进）；
 * text：标题纯文本；
 * block：该 heading 在文档中的块下标（点击/跳转目标）；
 * id：该 heading 的稳定锚 id（与 attrs.id 一致）。
 * @public
 */
export interface TocEntry { level: number; text: string; block: number; id: string }

/** 把 heading 级别夹回 1..6（缺省 1）。 @internal */
function headingLevel(b: Block): number {
  const l = b.attrs.level ?? 1;
  return l < 1 ? 1 : l > 6 ? 6 : l;
}

/**
 * 确保某 heading 块带有稳定锚 id：缺失则就地赋一个并返回；已有则原样返回。
 * 注意：会写入 `block.attrs.id`（副作用），调用方需在可变文档上调用。
 * @public
 */
export function ensureHeadingId(b: Block): string {
  if (!b.attrs.id) b.attrs.id = genBlockId();
  return b.attrs.id;
}

/**
 * 扫描文档全部 heading，按文档序生成目录条目。
 * 为每个缺 id 的 heading 就地补一个稳定 id（默认开启；只读扫描可传 assignIds=false）。
 * @public
 */
export function scanToc(doc: Doc, assignIds = true): TocEntry[] {
  const entries: TocEntry[] = [];
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    if (b.type !== 'heading') continue;
    const id = assignIds ? ensureHeadingId(b) : (b.attrs.id ?? '');
    entries.push({ level: headingLevel(b), text: blockText(b), block: i, id });
  }
  return entries;
}
