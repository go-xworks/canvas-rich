// 导入解析（editor 层）：Markdown / HTML 文本 → 文档树（schema 的 Doc）。
// 与 model/export.ts 互为逆向：标题/列表/任务/引用/代码块/分隔线 + 行内 marks（粗/斜/删/码/高亮/链接）。
// 块级行解析为纯函数；行内 marks 用一遍递归扫描。无法识别的内容降级为段落纯文本。
// 分层：editor（把外部格式桥接进 model；仅依赖 model 的构造器/归一化，不触碰 UI）。
import {
  Doc, Block, BlockType, BlockAttrs, Inline, Mark, MarkType,
  block as mkBlock, text as mkText,
} from '../model/schema';
import { normalizeInlines } from '../model/inlines';

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

// 把一段行内 Markdown 文本解析为携带 marks 的 Inline[]；base 为外层已累积的 marks。
function parseInlineMd(src: string, base: Mark[] = []): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = (): void => { if (buf) { out.push(mkText(buf, base)); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // 转义：反斜杠后一个字符按字面输出
    if (ch === '\\' && i + 1 < src.length) { buf += src[i + 1]; i += 2; continue; }
    // 行内代码：`code`（内部不解析其它 marks）
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push(mkText(src.slice(i + 1, end), addMark(base, 'code')));
        i = end + 1; continue;
      }
    }
    // 链接：[text](url)
    if (ch === '[') {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const inner = parseInlineMd(link.text, addMark(base, 'link', { href: link.href }));
        out.push(...inner);
        i = link.end; continue;
      }
    }
    // 强调/删除/高亮定界符
    const delim = matchDelim(src, i);
    if (delim) {
      flush();
      const next = delim.types.reduce((acc, t) => addMark(acc, t), base);
      out.push(...parseInlineMd(delim.inner, next));
      i = delim.end; continue;
    }
    buf += ch; i++;
  }
  flush();
  return out;
}

// 在 [start] 处尝试匹配 [text](href)，成功返回内容与结束位置。
function matchLink(src: string, start: number): { text: string; href: string; end: number } | null {
  let depth = 0, j = start;
  for (; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']') { depth--; if (depth === 0) break; }
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  const close = src.indexOf(')', j + 2);
  if (close < 0) return null;
  return { text: src.slice(start + 1, j), href: src.slice(j + 2, close), end: close + 1 };
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

/**
 * 把 Markdown 文本解析为文档树。
 * 支持：# 标题、- / * / + 无序、1. 有序、- [ ] / - [x] 任务、> 引用、``` 代码块、
 * --- 分隔线，以及行内 **粗** *斜* ~~删~~ `码` ==高亮== [文](url)。
 * 无法识别的行降级为段落纯文本。空文档回退为单个空段落。
 * @public
 */
export function parseMarkdown(md: string): Doc {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
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
        blocks.push(mkBlock('code_block', [mkText(lines[i])])); any = true;
        i++;
      }
      if (i < lines.length) i++; // 跳过收尾围栏
      if (!any) blocks.push(mkBlock('code_block', [mkText('')])); // 空围栏：留一个空代码行
      continue;
    }

    // 空行：分块分隔，跳过
    if (trimmed === '') { i++; continue; }

    // 分隔线
    if (RE_HR.test(trimmed)) { blocks.push(mkBlock('paragraph', [mkText('———')])); i++; continue; }

    // 标题
    const h = RE_HEADING.exec(trimmed);
    if (h) {
      const level = Math.min(6, h[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push(mkBlock('heading', parseInlineMd(h[2]), { level }));
      i++; continue;
    }

    // 引用（连续 > 行合并为一个 blockquote 块的多行 → v1 每行一块）
    const q = RE_QUOTE.exec(trimmed);
    if (q) { blocks.push(mkBlock('blockquote', parseInlineMd(q[1]))); i++; continue; }

    // 任务项（必须先于无序列表判断，因 task 是 bullet 的特例）
    const task = RE_TASK.exec(trimmed);
    if (task) {
      const checked = task[1] !== ' ';
      blocks.push(mkBlock('task_item', parseInlineMd(task[2]), { checked }));
      i++; continue;
    }

    // 有序列表
    const ol = RE_ORDERED.exec(trimmed);
    if (ol) { blocks.push(mkBlock('ordered_item', parseInlineMd(ol[1]))); i++; continue; }

    // 无序列表
    const ul = RE_BULLET.exec(trimmed);
    if (ul) { blocks.push(mkBlock('bullet_item', parseInlineMd(ul[1]))); i++; continue; }

    // 默认：段落（行内 marks）
    blocks.push(mkBlock('paragraph', parseInlineMd(trimmed)));
    i++;
  }
  return blocks.length ? { blocks } : { blocks: [mkBlock('paragraph', [])] };
}

// —— HTML 解析（仅浏览器：依赖全局 DOMParser）——

// 标签 → 块类型映射（不在表内的块级元素降级为段落）。
const HTML_BLOCK_TAG: Record<string, BlockType> = {
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  p: 'paragraph', blockquote: 'blockquote', li: 'bullet_item', pre: 'code_block',
};
// 内联标签 → mark 类型（同义标签归并）。
const HTML_INLINE_MARK: Record<string, MarkType> = {
  strong: 'bold', b: 'bold', em: 'italic', i: 'italic', u: 'underline',
  s: 'strikethrough', strike: 'strikethrough', del: 'strikethrough',
  mark: 'highlight', code: 'code', sup: 'superscript', sub: 'subscript',
};

// 判定全局是否存在 DOMParser（浏览器有；node 测试环境无）。
function hasDomParser(): boolean {
  return typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'function';
}

/**
 * 把 HTML 文本解析为文档树（仅浏览器：需要全局 DOMParser）。
 * 支持 h1–h6 / p / ul / ol / li / blockquote / pre·code / strong / em / u / s / a / mark / code / sup / sub 等。
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

    if (tag === 'ul' || tag === 'ol') { walkList(el, out, tag); continue; }
    if (tag === 'hr') { out.push(mkBlock('paragraph', [mkText('———')])); continue; }
    if (tag === 'br') continue;

    const blockType = HTML_BLOCK_TAG[tag];
    if (blockType === 'heading') {
      const level = Math.min(6, Math.max(1, Number(tag[1]))) as 1 | 2 | 3 | 4 | 5 | 6;
      out.push(mkBlock('heading', parseInlineHtml(el, []), { level }));
      continue;
    }
    if (tag === 'pre') { pushCodeBlock(el, out); continue; }
    if (blockType === 'blockquote') { out.push(mkBlock('blockquote', parseInlineHtml(el, []))); continue; }
    if (blockType === 'paragraph') {
      out.push(mkBlock('paragraph', parseInlineHtml(el, []), alignOf(el)));
      continue;
    }
    if (tag === 'li') { out.push(mkBlock('bullet_item', parseInlineHtml(el, []))); continue; } // 游离 <li>
    // 容器类（div/section/article 等）：递归其子节点
    if (hasBlockChild(el)) { walkBlocks(el, out); continue; }
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
    if (t in HTML_BLOCK_TAG || t === 'ul' || t === 'ol' || t === 'div' || t === 'section' || t === 'article') return true;
  }
  return false;
}

// 取元素的 text-align 对齐（仅 center/right 生效）。
function alignOf(el: Element): BlockAttrs {
  const a = (el as HTMLElement).style?.textAlign;
  return a === 'center' || a === 'right' ? { align: a } : {};
}

// 递归把元素的行内子树解析为 Inline[]；skip 跳过指定节点（如任务复选框）。
function parseInlineHtml(el: Node, base: Mark[], skip?: Node | null): Inline[] {
  const out: Inline[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (skip && node === skip) continue;
    if (node.nodeType === 3) { const t = node.textContent ?? ''; if (t) out.push(mkText(t, base)); continue; }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === 'br') { out.push(mkText(' ', base)); continue; }
    if (tag === 'a') {
      const href = child.getAttribute('href') ?? '';
      out.push(...parseInlineHtml(child, addMark(base, 'link', { href })));
      continue;
    }
    if (tag === 'span') {
      const color = (child as HTMLElement).style?.color;
      const next = color ? addMark(base, 'color', { color }) : base;
      out.push(...parseInlineHtml(child, next));
      continue;
    }
    const mark = HTML_INLINE_MARK[tag];
    if (mark) { out.push(...parseInlineHtml(child, addMark(base, mark))); continue; }
    // 未知内联：透传子节点
    out.push(...parseInlineHtml(child, base));
  }
  return normalizeInlines(out);
}

// 无 DOMParser 的退化路径：剥标签、按双换行/换行切段，纯文本段落。
function fallbackHtml(html: string): Doc {
  const stripped = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const blocks = stripped.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((s) => mkBlock('paragraph', [mkText(s)]));
  return blocks.length ? { blocks } : { blocks: [mkBlock('paragraph', [])] };
}
