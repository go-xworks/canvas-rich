// 表格单元格 contenteditable DOM → 行内序列（editor 层）：覆盖层 td 的 input 回写解析端，
// 与 model/export 的 inlinesToCellHtml 互逆。按「结构子集」类型化（CellDomNode），
// 真实 DOM Node 天然满足，node 测试环境可用纯对象构造树做单测（无需 DOM）。
import { Inline, Mark, text as mkText, withMark, fontSizeFromCss } from '../model/schema';
import { markTypeOfTag, isSafeCssColor, isSafeFontFamily } from '../model/mark-html';
import { normalizeCellInlines } from '../model/inlines';
import { sanitizeLinkHref } from '../shared/url';

/**
 * domToInlines 可遍历的最小节点结构（DOM Node/Element 的结构子集）。
 * 只声明遍历所需字段：nodeType/textContent/childNodes 必备，元素字段（tagName/
 * getAttribute/style）可选——浏览器传 HTMLElement 即满足，node 单测用纯对象即可。 @public
 */
export interface CellDomNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<CellDomNode>;
  tagName?: string;
  getAttribute?(name: string): string | null;
  style?: { color?: string; fontSize?: string; fontFamily?: string };
}

// 标签 → mark 类型：查 model/markHtml 的 SSOT 表（markTypeOfTag 大小写不敏感，同义标签归并）。
// 视为「行边界」的容器标签：进入前若已有内容则补 '\n'（contenteditable 的 Enter 可能产 div/p 包行）。
const CELL_BLOCK_BOUNDARY = new Set(['DIV', 'P']);

/**
 * 把表格单元格 contenteditable 的 DOM 子树解析回 Inline[]（input 回写入口）。
 * 文本节点按当前 marks 栈产 TextRun；STRONG/B→bold、EM/I→italic、U→underline、
 * S/STRIKE/DEL→strikethrough、MARK→highlight、CODE→code、SUP/SUB→上/下标、
 * SPAN 读 style 的 color/font-size/font-family 与 data-href（还原 link）、A 读 href、
 * BR→'\n'、DIV/P 边界→'\n'；未知标签忽略本体但递归其子。结果经 normalizeCellInlines
 * 归一（过滤行内原子 + 合并同 marks 段、空时保留空段承载光标）——本函数是产 cell 的
 * 回写路径，须维持「td 不承载行内原子」不变量（见 model/inlines 的 normalizeCellInlines）。 @public
 */
export function domToInlines(root: CellDomNode): Inline[] {
  const out: Inline[] = [];
  walkCellNode(root, [], out);
  return normalizeCellInlines(out);
}

// 递归遍历：marks 为当前祖先标签累积的 mark 栈（不可变传递）。
function walkCellNode(node: CellDomNode, marks: Mark[], out: Inline[]): void {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 3 /* text */) {
      const t = child.textContent ?? '';
      if (t) out.push(mkText(t, marks));
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue;
    const tag = (child.tagName ?? '').toUpperCase();
    if (tag === 'BR') {
      // div/p 行尾的占位 <br>（contenteditable 用以撑住空行）不计换行：行边界本身已产 '\n'，
      // 否则 `A<div><br></div><div>B</div>`（三行：A/空/B）会多算一个换行。
      const parentTag = (node.tagName ?? '').toUpperCase();
      const isTrailingPlaceholder = CELL_BLOCK_BOUNDARY.has(parentTag) && i === node.childNodes.length - 1;
      if (!isTrailingPlaceholder) out.push(mkText('\n', marks));
      continue;
    }
    if (CELL_BLOCK_BOUNDARY.has(tag)) {
      // div/p 包行：非首块前补换行（contenteditable 中 `A<div>B</div>` 表示两行）
      if (out.length > 0) out.push(mkText('\n', marks));
      walkCellNode(child, marks, out);
      continue;
    }
    let next = marks;
    if (tag === 'SPAN') {
      const href = sanitizeLinkHref(child.getAttribute?.('data-href') ?? ''); // 编辑态链接降级 span 的回读
      if (href) next = withMark(next, { type: 'link', attrs: { href } });
      next = withCellSpanStyle(next, child);
    }
    if (tag === 'A') {
      const href = sanitizeLinkHref(child.getAttribute?.('href') ?? ''); // 粘贴等场景的真实 <a>，危险协议丢弃
      if (href) next = withMark(next, { type: 'link', attrs: { href } });
    }
    const markType = markTypeOfTag(tag);
    if (markType) next = withMark(next, { type: markType });
    walkCellNode(child, next, out); // 未知标签：忽略本体、递归其子（next === marks）
  }
}

// 从 span 的 style 叠加外观 marks：color / font-family→fontFamily / font-size→fontSize（剥 px）。
// 与 export.inlinesToCellHtml 的写出形式互逆：color/fontFamily 原值往返；fontSize 写出恒为
// `font-size:<裸数值>px`，回读经 fontSizeFromCss 剥 px 且校验裸数值——非 px 单位（pt/em，
// 仅可能来自外部粘贴）不产 mark，否则 size 混入单位、再写出拼成 '12ptpx' 即破坏互逆。
// 值白名单（mark-html）与 editor/import 的 withSpanStyle 同规：颜色限 #hex/rgb()/具名色、
// 字体族限安全字符集——单元格内粘贴的非法值（CSS 元字符）不产 mark，堵住回写路径的注入入口。
function withCellSpanStyle(base: Mark[], el: CellDomNode): Mark[] {
  const st = el.style;
  if (!st) return base;
  let marks = base;
  if (st.color && isSafeCssColor(st.color)) marks = withMark(marks, { type: 'color', attrs: { color: st.color } });
  if (st.fontFamily && isSafeFontFamily(st.fontFamily)) marks = withMark(marks, { type: 'fontFamily', attrs: { fontFamily: st.fontFamily } });
  if (st.fontSize) {
    const size = fontSizeFromCss(st.fontSize);
    if (size) marks = withMark(marks, { type: 'fontSize', attrs: { size } });
  }
  return marks;
}
