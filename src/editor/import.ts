// 导入解析（editor 层）：Markdown / HTML 文本 → 文档树（schema 的 Doc）。
// 与 model/export.ts 互为逆向：标题/列表/任务/引用/代码块/分隔线 + 块级图片/表格，
// 行内 marks（粗/斜/删/码/高亮/链接/下划线/上下标/字体族/字号）与行内图片原子。
// 块级行解析为纯函数；行内 marks 用一遍递归扫描。无法识别的内容降级为段落纯文本。
// 分层：editor（把外部格式桥接进 model；仅依赖 model 的构造器/归一化，不触碰 UI）。
import {
  Doc,
  Block,
  BlockType,
  BlockAttrs,
  Inline,
  Mark,
  MarkType,
  CellMerge,
  TableCell,
  block as mkBlock,
  text as mkText,
  inlineAtom as mkInlineAtom,
  cell as mkCell,
  cellsFromStrings,
  fontSizeFromCss,
} from '../model/schema';
import { normalizeInlines, normalizeCellInlines } from '../model/inlines';
import { markTypeOfTag, isSafeCssColor, isSafeFontFamily } from '../model/mark-html';
import { sanitizeLinkHref } from '../shared/url';

// —— 行内 marks 解析（Markdown 与 HTML 内联回退共用）——

// 行内分隔符规格：定界符 → 一组 mark 类型。长定界符优先（*** 先于 **，** 先于 *）。
// 顺序即匹配优先级；code(`) 单独处理（内部不再解析其它 marks）。
const INLINE_DELIMS: { open: string; close: string; types: MarkType[] }[] = [
  { open: '***', close: '***', types: ['bold', 'italic'] },
  { open: '___', close: '___', types: ['bold', 'italic'] },
  { open: '**', close: '**', types: ['bold'] },
  { open: '__', close: '__', types: ['bold'] },
  { open: '~~', close: '~~', types: ['strikethrough'] },
  { open: '==', close: '==', types: ['highlight'] },
  { open: '*', close: '*', types: ['italic'] },
  { open: '_', close: '_', types: ['italic'] },
];

// 解析一行管道表格为单元格文本数组（去首尾 |，按未转义 | 切分，trim 每格）。
function parseTableRow(line: string): string[] {
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      buf += inner[i + 1];
      i++;
      continue;
    } // \| 转义
    if (ch === '|') {
      cells.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

// 把各行补齐到最大列数（缺格补空串），保证矩形 rows。
function padTableRows(rows: string[][]): string[][] {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return rows.map((r) => (r.length < cols ? [...r, ...Array(cols - r.length).fill('')] : r));
}

// 管道表格单元格内的 <br>（GFM 表格唯一的换行表示）：与 export 的「'\n' → <br>」互逆还原。
const RE_CELL_BR = /<br\s*\/?>/gi;

// 把一段行内 Markdown 文本解析为携带 marks 的 Inline[]；base 为外层已累积的 marks。
function parseInlineMd(src: string, base: Mark[] = []): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) {
      out.push(mkText(buf, base));
      buf = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // 转义：反斜杠后一个字符按字面输出
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    // 行内代码：`code`（内部不解析其它 marks）
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push(mkText(src.slice(i + 1, end), addMark(base, 'code')));
        i = end + 1;
        continue;
      }
    }
    // 行内图片：![alt](url) → 行内原子（与 export 的 runMd 互逆）
    if (ch === '!' && src[i + 1] === '[') {
      const img = matchImage(src, i);
      if (img) {
        flush();
        out.push(mkInlineAtom('image', { src: img.src }));
        i = img.end;
        continue;
      }
    }
    // 链接：[text](url)
    if (ch === '[') {
      const link = matchLink(src, i);
      if (link) {
        flush();
        // href 危险协议（javascript: 等）拒绝：仅丢链接 mark，保留内层文本，不丢内容
        const safe = sanitizeLinkHref(link.href);
        const inner = parseInlineMd(link.text, safe ? addMark(base, 'link', { href: safe }) : base);
        out.push(...inner);
        i = link.end;
        continue;
      }
    }
    // 强调/删除/高亮定界符
    const delim = matchDelim(src, i);
    if (delim) {
      flush();
      const next = delim.types.reduce((acc, t) => addMark(acc, t), base);
      out.push(...parseInlineMd(delim.inner, next));
      i = delim.end;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// 安全解码 URL 百分号转义（%20 等）；非法序列原样返回，避免抛错破坏导入。
function decodeHref(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// 在 [start] 处尝试匹配 [text](href)，成功返回内容与结束位置（href 经 decodeURIComponent 解码）。
function matchLink(src: string, start: number): { text: string; href: string; end: number } | null {
  let depth = 0,
    j = start;
  for (; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  const close = src.indexOf(')', j + 2);
  if (close < 0) return null;
  return { text: src.slice(start + 1, j), href: decodeHref(src.slice(j + 2, close)), end: close + 1 };
}

// 在 [start]（指向 '!'）处尝试匹配 ![alt](src)，成功返回图片源与结束位置（src 经解码）。
function matchImage(src: string, start: number): { src: string; end: number } | null {
  const link = matchLink(src, start + 1); // 复用 [alt](url) 解析，再前移一位吃掉 '!'
  return link ? { src: link.href, end: link.end } : null;
}

// 在 [start] 处尝试匹配成对定界符，返回内部文本、mark 类型组与结束位置。
function matchDelim(src: string, start: number): { inner: string; types: MarkType[]; end: number } | null {
  for (const d of INLINE_DELIMS) {
    if (!src.startsWith(d.open, start)) continue;
    const from = start + d.open.length;
    const end = src.indexOf(d.close, from);
    if (end < 0 || end === from) continue; // 无闭合或内容为空：当作普通字符
    return { inner: src.slice(from, end), types: d.types, end: end + d.close.length };
  }
  return null;
}

// 在 marks 上叠加一个（同类型去重），不可变返回。
function addMark(base: Mark[], type: MarkType, attrs?: Record<string, string>): Mark[] {
  const mark: Mark = attrs ? { type, attrs } : { type };
  return [...base.filter((m) => m.type !== type), mark];
}

// —— Markdown 块级解析 ——

// 单行块前缀的正则（在去掉缩进后匹配）。
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_BULLET = /^[-*+]\s+(.*)$/;
const RE_TASK = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const RE_ORDERED = /^\d+[.)]\s+(.*)$/;
const RE_QUOTE = /^>\s?(.*)$/;
const RE_HR = /^(?:---+|\*\*\*+|___+)$/;
const RE_FENCE = /^(?:```|~~~)(.*)$/;
// 独占一行的图片 ![alt](url) → 块级 image（与 export 的 case 'image' 互逆）。
const RE_IMAGE_BLOCK = /^!\[[^\]]*\]\(([^)]*)\)$/;
// 管道表格行：以 | 开头/结尾、含至少一个 |（GFM）。
const RE_TABLE_ROW = /^\|.*\|$/;
// 表格分隔行（表头下方）：单元仅由 - : 空白与 | 组成，且至少含一个 -。
const RE_TABLE_SEP = /^\|(?:\s*:?-+:?\s*\|)+$/;

/**
 * 把 Markdown 文本解析为文档树。
 * 支持：# 标题、- / * / + 无序、1. 有序、- [ ] / - [x] 任务、> 引用、``` 代码块、
 * --- 分隔线、独占一行的 ![](url) 块级图片、| 管道表格，以及行内
 * **粗** *斜* ~~删~~ `码` ==高亮== [文](url) 与 ![](url) 行内图片原子。
 * 无法识别的行降级为段落纯文本。空文档回退为单个空段落。
 * @public
 */
export function parseMarkdown(md: string): Doc {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  // TODO(②): 块级 Markdown 解析是顺序正则瀑布（RE_HEADING…），判定依赖行级正则与前瞻、与块 type 非一一映射，
  //   不宜强收进 block-specs 注册表（会破 round-trip）。导出已表驱动化（export.ts BLOCK_EXPORTERS），
  //   导入侧暂保现状；若未来纳入须保管道表格 <br>/嵌套列表 depth/危险协议链接的往返一致。
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // 围栏代码块：```lang ... ```（每行一个 code_block，连续合并由 export 处理）
    const fence = RE_FENCE.exec(trimmed);
    if (fence) {
      i++;
      let any = false;
      while (i < lines.length && !RE_FENCE.test(lines[i].trim())) {
        blocks.push(mkBlock('code_block', [mkText(lines[i])]));
        any = true;
        i++;
      }
      if (i < lines.length) i++; // 跳过收尾围栏
      if (!any) blocks.push(mkBlock('code_block', [mkText('')])); // 空围栏：留一个空代码行
      continue;
    }

    // 空行：分块分隔，跳过
    if (trimmed === '') {
      i++;
      continue;
    }

    // 分隔线
    if (RE_HR.test(trimmed)) {
      blocks.push(mkBlock('paragraph', [mkText('———')]));
      i++;
      continue;
    }

    // 管道表格：当前行是表格行且下一行是分隔行（GFM 表头规则）。
    if (RE_TABLE_ROW.test(trimmed) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1].trim())) {
      const rows: string[][] = [parseTableRow(trimmed)];
      i += 2; // 跳过表头与分隔行
      while (i < lines.length && RE_TABLE_ROW.test(lines[i].trim())) {
        rows.push(parseTableRow(lines[i].trim()));
        i++;
      }
      // 单元格内 <br> → '\n'（与 toMarkdown 导出互逆，换行保真）；cellsFromStrings 产纯文本
      // 富单元格，天然满足「td 不承载行内原子」不变量（见 normalizeCellInlines）。
      const cellRows = padTableRows(rows).map((r) => r.map((s) => s.replace(RE_CELL_BR, '\n')));
      blocks.push(mkBlock('table', [], { rows: cellsFromStrings(cellRows) }));
      continue;
    }

    // 独占一行的图片 → 块级 image
    const imgBlock = RE_IMAGE_BLOCK.exec(trimmed);
    if (imgBlock) {
      blocks.push(mkBlock('image', [], { src: decodeHref(imgBlock[1]) }));
      i++;
      continue;
    }

    // 标题
    const h = RE_HEADING.exec(trimmed);
    if (h) {
      const level = Math.min(6, h[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push(mkBlock('heading', parseInlineMd(h[2]), { level }));
      i++;
      continue;
    }

    // 引用（连续 > 行合并为一个 blockquote 块的多行 → v1 每行一块）
    const q = RE_QUOTE.exec(trimmed);
    if (q) {
      blocks.push(mkBlock('blockquote', parseInlineMd(q[1])));
      i++;
      continue;
    }

    // 任务项（必须先于无序列表判断，因 task 是 bullet 的特例）
    const task = RE_TASK.exec(trimmed);
    if (task) {
      const checked = task[1] !== ' ';
      blocks.push(mkBlock('task_item', parseInlineMd(task[2]), { checked }));
      i++;
      continue;
    }

    // 有序列表
    const ol = RE_ORDERED.exec(trimmed);
    if (ol) {
      blocks.push(mkBlock('ordered_item', parseInlineMd(ol[1])));
      i++;
      continue;
    }

    // 无序列表
    const ul = RE_BULLET.exec(trimmed);
    if (ul) {
      blocks.push(mkBlock('bullet_item', parseInlineMd(ul[1])));
      i++;
      continue;
    }

    // 默认：段落（行内 marks）
    blocks.push(mkBlock('paragraph', parseInlineMd(trimmed)));
    i++;
  }
  return blocks.length ? { blocks } : { blocks: [mkBlock('paragraph', [])] };
}

// —— HTML 解析（仅浏览器：依赖全局 DOMParser）——

// 标签 → 块类型映射（不在表内的块级元素降级为段落）。
// 注：此表已是块级 HTML 解析的表驱动雏形（与 export.ts 的 BLOCK_EXPORTERS 对偶）；walkBlocks 的 if(tag===…)
// 仍含 ul/ol/table/img/hr 等需特殊遍历的分支，本步②不进一步收口（保 round-trip）。
const HTML_BLOCK_TAG: Record<string, BlockType> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  blockquote: 'blockquote',
  li: 'bullet_item',
  pre: 'code_block',
};
// 内联标签 → mark 类型：查 model/markHtml 的 SSOT 表（markTypeOfTag，同义标签归并）。

// 判定全局是否存在 DOMParser（浏览器有；node 测试环境无）。
function hasDomParser(): boolean {
  return typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'function';
}

/**
 * 把 HTML 文本解析为文档树（仅浏览器：需要全局 DOMParser）。
 * 支持 h1–h6 / p / ul / ol / li / blockquote / pre·code / table / img（块级及行内）/
 * strong / em / u / s / a / mark / code / sup / sub / span[style]（color/font-family/font-size）等。
 * 无 DOMParser（如 node 测试）时退化为按可见文本切段。无法识别的块降级为段落。
 * @public
 */
export function parseHtml(html: string): Doc {
  if (!hasDomParser()) return fallbackHtml(html);
  const DP = (globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser;
  const dom = new DP().parseFromString(html, 'text/html');
  const blocks: Block[] = [];
  walkBlocks(dom.body, blocks);
  return blocks.length ? { blocks } : { blocks: [mkBlock('paragraph', [])] };
}

// 遍历块级容器，收集块（递归进入 div/section/article 等容器）。
function walkBlocks(root: Node, out: Block[]): void {
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3 /* text */) {
      const t = (node.textContent ?? '').trim();
      if (t) out.push(mkBlock('paragraph', [mkText(t)]));
      continue;
    }
    if (node.nodeType !== 1 /* element */) continue;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'ul' || tag === 'ol') {
      walkList(el, out, tag);
      continue;
    }
    if (tag === 'table') {
      walkTable(el, out);
      continue;
    }
    if (tag === 'img') {
      out.push(mkBlock('image', [], imgBlockAttrs(el)));
      continue;
    } // 独立成段的图片 → 块级
    if (tag === 'hr') {
      out.push(mkBlock('paragraph', [mkText('———')]));
      continue;
    }
    if (tag === 'br') continue;

    const blockType = HTML_BLOCK_TAG[tag];
    if (blockType === 'heading') {
      const level = Math.min(6, Math.max(1, Number(tag[1]))) as 1 | 2 | 3 | 4 | 5 | 6;
      out.push(mkBlock('heading', parseInlineHtml(el, []), { level }));
      continue;
    }
    if (tag === 'pre') {
      pushCodeBlock(el, out);
      continue;
    }
    if (blockType === 'blockquote') {
      out.push(mkBlock('blockquote', parseInlineHtml(el, [])));
      continue;
    }
    if (blockType === 'paragraph') {
      out.push(mkBlock('paragraph', parseInlineHtml(el, []), alignOf(el)));
      continue;
    }
    if (tag === 'li') {
      out.push(mkBlock('bullet_item', parseInlineHtml(el, [])));
      continue;
    } // 游离 <li>
    // 容器类（div/section/article 等）：递归其子节点
    if (hasBlockChild(el)) {
      walkBlocks(el, out);
      continue;
    }
    // 其余块级：降级为段落纯文本
    const inl = parseInlineHtml(el, []);
    out.push(mkBlock('paragraph', inl));
  }
}

// 解析 ul/ol（含 GFM 任务列表）为列表项块。
function walkList(listEl: Element, out: Block[], listTag: 'ul' | 'ol'): void {
  for (const li of Array.from(listEl.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    const checkbox = li.querySelector('input[type="checkbox"]');
    if (checkbox) {
      const checked = (checkbox as HTMLInputElement).hasAttribute('checked');
      out.push(mkBlock('task_item', parseInlineHtml(li, [], checkbox), { checked }));
      continue;
    }
    const type: BlockType = listTag === 'ol' ? 'ordered_item' : 'bullet_item';
    out.push(mkBlock(type, parseInlineHtml(li, [])));
  }
}

// 取块级 <img> 的属性（src 解码 + 可选 width/height 数值），构造 image 块 attrs。
function imgBlockAttrs(el: Element): BlockAttrs {
  return { src: decodeHref(el.getAttribute('src') ?? ''), ...imgDims(el) };
}

/**
 * 解析 <table> 为 table 块（与 export 的合并区输出互逆）。
 * 逐 <tr> 取 <th>/<td>，单元格经 parseInlineHtml 解析为富内容（保 marks，<br> → '\n' 换行），
 * 再经 normalizeCellInlines 过滤行内原子——不变量「td 不承载行内原子」：parseInlineHtml 会把
 * <img> 产成行内图片原子，混入 cell 会在首次单元格编辑回写时静默丢失，故在产 cell 处即过滤。
 * 按 colspan/rowspan 在网格中占位：被跨格覆盖的位置补空格子、
 * 锚点格记 merges（rowspan/colspan>1 时）。最终 rows 补齐为矩形。
 */
function walkTable(tableEl: Element, out: Block[]): void {
  const trs = Array.from(tableEl.querySelectorAll('tr'));
  const grid: TableCell[][] = [];
  const merges: CellMerge[] = [];
  const occupied = new Set<string>(); // "r,c" 已被先前 rowspan 占用
  for (let r = 0; r < trs.length; r++) {
    if (!grid[r]) grid[r] = [];
    let c = 0;
    for (const cellEl of Array.from(trs[r].children)) {
      const tag = cellEl.tagName.toLowerCase();
      if (tag !== 'td' && tag !== 'th') continue;
      while (occupied.has(`${r},${c}`) || grid[r][c] !== undefined) c++; // 跳过被占/已填列
      const colspan = Math.max(1, Number(cellEl.getAttribute('colspan')) || 1);
      const rowspan = Math.max(1, Number(cellEl.getAttribute('rowspan')) || 1);
      // 单元格内 <br> 保留为换行；过滤行内原子（td 不承载行内原子，见 normalizeCellInlines）
      grid[r][c] = { inlines: normalizeCellInlines(parseInlineHtml(cellEl, [], null, '\n')) };
      if (colspan > 1 || rowspan > 1) merges.push({ r, c, rowspan, colspan });
      // 标记本格覆盖的其余网格位置（锚点除外）为空格子占位
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr;
          if (!grid[rr]) grid[rr] = [];
          grid[rr][c + dc] = mkCell();
          occupied.add(`${rr},${c + dc}`);
        }
      }
      c += colspan;
    }
  }
  // 把稀疏网格补成矩形（undefined → 空格子）
  const cols = grid.reduce((n, row) => Math.max(n, row.length), 0);
  const rows = grid.map((row) => Array.from({ length: cols }, (_, i) => row[i] ?? mkCell()));
  if (!rows.length) return;
  out.push(mkBlock('table', [], merges.length ? { rows, merges } : { rows }));
}

// 把 <pre>（可含 <code>）拆成逐行 code_block。
function pushCodeBlock(pre: Element, out: Block[]): void {
  const codeEl = pre.querySelector('code') ?? pre;
  const text = codeEl.textContent ?? '';
  for (const line of text.replace(/\n$/, '').split('\n')) out.push(mkBlock('code_block', [mkText(line)]));
}

// 元素是否含块级子元素（决定是否作为容器递归）。
function hasBlockChild(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    const t = c.tagName.toLowerCase();
    if (
      t in HTML_BLOCK_TAG ||
      t === 'ul' ||
      t === 'ol' ||
      t === 'table' ||
      t === 'div' ||
      t === 'section' ||
      t === 'article'
    )
      return true;
  }
  return false;
}

// 取元素的 text-align 对齐（仅 center/right 生效）。
function alignOf(el: Element): BlockAttrs {
  const a = (el as HTMLElement).style?.textAlign;
  return a === 'center' || a === 'right' ? { align: a } : {};
}

/**
 * withSpanStyle 读取的最小元素结构（style 子集）：浏览器 HTMLElement 天然满足，
 * node 单测可用纯对象构造（无需 DOM）。 @public
 */
export interface SpanStyleSource {
  style?: { color?: string; fontFamily?: string; fontSize?: string };
}

/**
 * 从 <span style> 叠加外观 marks：color / font-family→fontFamily / font-size→fontSize。
 * 读 CSSStyleDeclaration（DOMParser 已归一化 style 字符串），与 export 的三层 span 互逆。
 * 值白名单（mark-html）：颜色限 #hex/rgb()/具名色、字体族限安全字符集——非法值不产 mark，
 * 与导出端跳过 span style 构成对称的双端防线（杜绝 'x;position:fixed' 类 CSS 注入入库）。
 * @internal 导出仅为 node 单测可达（生产路径只经 parseHtml 内部调用）。
 */
export function withSpanStyle(base: Mark[], el: SpanStyleSource): Mark[] {
  let marks = base;
  const st = el.style;
  if (!st) return marks;
  if (st.color && isSafeCssColor(st.color)) marks = addMark(marks, 'color', { color: st.color });
  if (st.fontFamily && isSafeFontFamily(st.fontFamily))
    marks = addMark(marks, 'fontFamily', { fontFamily: st.fontFamily });
  // CSS font-size 形如 "16px"；经 fontSizeFromCss 剥 px 存裸数值（非 px 单位不产 mark，
  // 保「attrs.size 恒裸数值 ↔ 序列化端拼 px」互逆不变量，见 schema.fontSizeFromCss）。
  if (st.fontSize) {
    const size = fontSizeFromCss(st.fontSize);
    if (size) marks = addMark(marks, 'fontSize', { size });
  }
  return marks;
}

// 取 <img> 的 width/height 属性（数值，CSS px）；缺省/非法不输出对应键。
function imgDims(el: Element): { width?: number; height?: number } {
  const dims: { width?: number; height?: number } = {};
  const w = Number(el.getAttribute('width'));
  const h = Number(el.getAttribute('height'));
  if (Number.isFinite(w) && w > 0) dims.width = w;
  if (Number.isFinite(h) && h > 0) dims.height = h;
  return dims;
}

// 递归把元素的行内子树解析为 Inline[]；skip 跳过指定节点（如任务复选框）；
// brText 为 <br> 的落地文本：段落语境降级为空格（块模型无段内换行），表格单元格传 '\n' 保留换行。
function parseInlineHtml(el: Node, base: Mark[], skip?: Node | null, brText = ' '): Inline[] {
  const out: Inline[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (skip && node === skip) continue;
    if (node.nodeType === 3) {
      const t = node.textContent ?? '';
      if (t) out.push(mkText(t, base));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === 'br') {
      out.push(mkText(brText, base));
      continue;
    }
    if (tag === 'img') {
      const src = decodeHref(child.getAttribute('src') ?? '');
      out.push(mkInlineAtom('image', { src, ...imgDims(child) }));
      continue;
    }
    if (tag === 'a') {
      const safe = sanitizeLinkHref(decodeHref(child.getAttribute('href') ?? ''));
      const next = safe ? addMark(base, 'link', { href: safe }) : base; // 危险协议丢链接 mark、留文本
      out.push(...parseInlineHtml(child, next, null, brText));
      continue;
    }
    if (tag === 'span') {
      out.push(...parseInlineHtml(child, withSpanStyle(base, child as HTMLElement), null, brText));
      continue;
    }
    const mark = markTypeOfTag(tag);
    if (mark) {
      out.push(...parseInlineHtml(child, addMark(base, mark), null, brText));
      continue;
    }
    // 未知内联：透传子节点
    out.push(...parseInlineHtml(child, base, null, brText));
  }
  return normalizeInlines(out);
}

// 无 DOMParser 的退化路径：剥标签、按双换行/换行切段，纯文本段落。
function fallbackHtml(html: string): Doc {
  const stripped = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  const blocks = stripped
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => mkBlock('paragraph', [mkText(s)]));
  return blocks.length ? { blocks } : { blocks: [mkBlock('paragraph', [])] };
}
