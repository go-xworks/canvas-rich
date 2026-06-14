// 文档树 schema：blocks（块级）+ inlines（行内）+ marks（行内区间属性）。
// inline 支持 TextRun（文本段）与 InlineAtom（行内原子，如行内图片）；
// 行内原子占 1 个 UTF-16 offset、不可分割，随文字断行/光标移动。
import { isList, isAtom, isKnownBlockType } from './block-specs';

/**
 * 行内原子的占位字符（U+FFFC OBJECT REPLACEMENT CHARACTER）。
 * 让 InlineAtom 复用 TextRun 的 `text` 计量路径：blockText/blockTextLen 等按 text.length
 * 累加时，原子天然占 1 个 UTF-16 offset，无需为每处计量分支特判。 @public
 */
export const ATOM_PLACEHOLDER = '￼';

/** 行内区间属性（mark）的类型枚举。 @public */
export type MarkType =
  | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'highlight' | 'code' | 'color' | 'link'
  | 'fontFamily' | 'fontSize' | 'superscript' | 'subscript';
// 规范化排序用的固定次序：使「同内容」的 marks 数组有唯一表示，便于相等比较与合并。
// fontFamily/fontSize 排在字符外观类之后、装饰类之前；上/下标互斥，放末尾装饰段。
const MARK_ORDER: MarkType[] = [
  'fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough',
  'highlight', 'code', 'color', 'superscript', 'subscript', 'link',
];
// 非包含 mark：在其右边界打字「不」继承（link/code 末尾继续输入不会被染色）。
const NON_INCLUSIVE: ReadonlySet<MarkType> = new Set<MarkType>(['link', 'code']);

/** 单个行内 mark：类型 + 可选属性（如 color/link 的值）。 @public */
export interface Mark { type: MarkType; attrs?: Record<string, string> }

/** 文本段：携带一组 marks 的纯文本片段，行内序列的最小单元。 @public */
export interface TextRun { kind: 'text'; text: string; marks: Mark[] }

/** 行内原子的种类（当前仅行内图片；预留 mention 等扩展）。 @public */
export type InlineAtomKind = 'image';
/** 行内原子属性（行内图片：src + 可选显示尺寸 CSS px）。 @public */
export interface InlineAtomAttrs { src?: string; width?: number; height?: number }
/**
 * 行内原子：嵌入文字行内、占 1 个 UTF-16 offset 的不可分割单元（如行内图片）。
 * `text` 恒为 ATOM_PLACEHOLDER（长度 1），复用 TextRun 的偏移计量路径；
 * `marks` 类型固定为 `readonly []`（空只读元组）：在类型层强制「原子不参与字符级 mark」
 * 的不变量——既不能写入也无法变异，构造器/拷贝路径只能给空数组。区别于块级 image 原子块。 @public
 */
export interface InlineAtom { kind: 'atom'; atom: InlineAtomKind; attrs: InlineAtomAttrs; text: string; marks: readonly [] }
/** 行内节点联合类型：文本段或行内原子。 @public */
export type Inline = TextRun | InlineAtom;

/** 类型守卫：判定行内节点是否为行内原子。 @public */
export function isInlineAtom(inl: Inline): inl is InlineAtom { return inl.kind === 'atom'; }

/** 块级节点的类型枚举。 @public */
export type BlockType = 'paragraph' | 'heading' | 'bullet_item' | 'ordered_item' | 'task_item' | 'blockquote' | 'code_block' | 'image' | 'formula' | 'table' | 'toc' | 'shape' | 'audio' | 'video' | 'iframe' | 'attachment' | 'signature' | 'seal' | 'textbox';

/** 形状原子块支持的几何种类（attrs.shape）。 @public */
export type ShapeKind =
  | 'line' | 'rect' | 'rounded-rect' | 'ellipse' | 'triangle' | 'diamond' | 'star' | 'arrow' | 'divider';
/** 判定块类型是否为列表项（委托块行为注册表 SSOT）。 @public */
// 委托给块行为注册表（SSOT），避免多处重复枚举
export function isListType(t: BlockType): boolean { return isList(t); }
/** 判定块类型是否为原子块（不可编辑内联文本）。 @public */
export function isAtomBlock(t: BlockType): boolean { return isAtom(t); }
let _idc = 0;
/** 生成进程内单调递增的稳定块 id。 @public */
export function genBlockId(): string { return 'blk' + (++_idc); } // 稳定块 id（覆盖层按 id 缓存，跨 undo 不丢）

/** 块级水平对齐：左/中/右 + 两端对齐(justify)/分散对齐(distribute)。 @public */
export type BlockAlign = 'left' | 'center' | 'right' | 'justify' | 'distribute';

/**
 * 表格合并区：以锚点单元格 (r,c) 为左上角、跨 rowspan 行 × colspan 列的矩形。
 * 锚点格保留内容并渲染为 td[rowSpan][colSpan]；被覆盖的格不渲染。 @public
 */
export interface CellMerge { r: number; c: number; rowspan: number; colspan: number }

/**
 * 表格单元格（v2 富文本）：行内序列承载完整 marks（粗/斜/下划线/删除线/高亮/颜色/代码/
 * 链接/字号/字体族）；换行 = inlines 文本中的 '\n'（覆盖层渲染为 <br>）。 @public
 */
export interface TableCell { inlines: Inline[] }

/** 列表/任务项嵌套深度上限（0..MAX_LIST_DEPTH）。 @public */
export const MAX_LIST_DEPTH = 5;

/** 块级属性集合（id/对齐/书写方向/段落排版/原子块专属字段等）。 @public */
export interface BlockAttrs {
  id?: string;                          // 稳定 id（原子块覆盖层缓存键 / heading 锚点 / TOC 跳转目标）
  level?: 1 | 2 | 3 | 4 | 5 | 6; align?: BlockAlign;
  depth?: number;                       // 列表/任务项嵌套深度（0..MAX_LIST_DEPTH，缩进 = 基础 + depth*step）
  checked?: boolean;                    // task_item：勾选态（marker ☐/☑）
  dir?: 'ltr' | 'rtl';                  // 书写方向（文字方向）
  // —— 段落排版（覆盖块主题默认；未设置则回退主题值）——
  lineHeight?: number;                  // 行距倍数（1 / 1.15 / 1.5 / 2），乘以行自然行高
  spaceBefore?: number; spaceAfter?: number; // 段前/段后间距（逻辑 px，覆盖主题默认）
  indent?: number;                      // 左缩进（逻辑 px，覆盖主题默认）
  letterSpacing?: number;               // 字间距（逻辑 px，逐元素 advance 追加）
  src?: string; width?: number; height?: number;  // image / shape / audio / video / iframe / attachment / signature（媒体或 iframe URL / 签名 PNG dataURL + 显示尺寸 CSS px）
  name?: string;                        // attachment（文件名，渲染文件卡片标题 + 下载链接 download 属性）
  text?: string;                        // seal（印章文字：单位/公司名，沿圆环弧排布，随之重绘 SVG）
  content?: string;                     // textbox（可编辑浮动文本框的纯文本内容 v1；contenteditable 回写）
  shape?: ShapeKind;                    // shape（几何种类，Canvas2D 描边/填充绘制）
  latex?: string;                       // formula
  rows?: TableCell[][];                 // table（v2：富文本单元格，cell.inlines 携带行内 marks 与 '\n' 换行）
  colWidths?: number[];                 // table：各列宽（逻辑 px，缺省等分/auto；拖拽列边界提交）
  rowHeights?: number[];                // table：各行高（逻辑 px，缺省 auto；拖拽行边界提交）
  merges?: CellMerge[];                 // table：合并区（锚点 r/c + rowspan/colspan），被覆盖格不渲染
  measuredH?: number;                   // 覆盖层实测高度（逻辑 px），回填给布局
}
/** 块级节点：类型 + 属性 + 行内序列。 @public */
export interface Block { type: BlockType; attrs: BlockAttrs; inlines: Inline[] }

/** 文档根节点：块的有序列表。 @public */
export interface Doc { blocks: Block[] }

// —— 构造器 ——
/** 构造一个文本段，marks 自动规范化排序。 @public */
export const text = (s: string, marks: Mark[] = []): TextRun => ({ kind: 'text', text: s, marks: sortMarks(marks) });
/** 构造一个行内原子（占 1 offset、不可分割）；text 固定为占位符、marks 恒空。 @public */
export const inlineAtom = (atom: InlineAtomKind, attrs: InlineAtomAttrs): InlineAtom =>
  ({ kind: 'atom', atom, attrs: { ...attrs }, text: ATOM_PLACEHOLDER, marks: [] as const });
/** 构造一个块；空行内序列回退为单个空文本段以承载光标。 @public */
export const block = (type: BlockType, inlines: Inline[], attrs: BlockAttrs = {}): Block =>
  ({ type, attrs, inlines: inlines.length ? inlines : [text('')] });
/** 构造一个段落块（block 的便捷封装）。 @public */
export const para = (inlines: Inline[], attrs: BlockAttrs = {}): Block => block('paragraph', inlines, attrs);
/** 构造一个表格单元格：以纯文本初始化（缺省空格子，inlines 为单个空文本段承载光标）。 @public */
export const cell = (textStr = ''): TableCell => ({ inlines: [text(textStr)] });

// —— 表格单元格工具 ——
/** 拼接单元格内所有行内段的纯文本（'\n' 即单元格内换行）。 @public */
export function cellText(c: TableCell): string {
  let s = '';
  for (const inl of c.inlines) s += inl.text;
  return s;
}
/** 把纯文本二维数组升格为富单元格二维数组（迁移/导入/插入空表共用入口）。 @public */
export function cellsFromStrings(rows: string[][]): TableCell[][] {
  return rows.map((row) => row.map((s) => cell(s)));
}
/**
 * 判定富单元格是否为「空」：纯文本全空白 **且** 不含行内原子。
 * mergeCells 等「空格子可丢弃」的路径必须用本判定——含行内原子的格子即便无可见文字也承载内容，
 * 不得静默丢弃；仅靠 `cellText().trim()` 依赖「原子占位符恰好非空白」的巧合，这里把不变量写显式。 @public
 */
export function isCellEmpty(c: TableCell): boolean {
  return !c.inlines.some(isInlineAtom) && cellText(c).trim() === '';
}

/**
 * 把 CSS font-size 值解析为 fontSize mark 的 attrs.size（裸数值字符串）。
 * 不变量：attrs.size 恒为裸数值——序列化端（export 的 HTML/单元格片段）拼 `${size}px`、
 * 解析端剥 px，两边恰互逆；带其它单位（pt/em 等，仅可能来自外部粘贴）的值不可表示，
 * 返回 null（调用方不产 mark），避免 size 混入单位、再序列化拼成 '12ptpx' 破坏互逆。 @public
 */
export function fontSizeFromCss(cssValue: string): string | null {
  const size = cssValue.replace(/px$/, '').trim();
  return size && /^[0-9]+(?:\.[0-9]+)?$/.test(size) ? size : null;
}

/** 深拷贝单个表格单元格（inlines/marks/attrs 全部新建，互不共享引用）。 @public */
export function cloneCell(c: TableCell): TableCell {
  return { inlines: c.inlines.map(cloneInline) };
}

// —— marks 工具 ——
/**
 * 取某 mark 类型在规范化排序中的次序权（越小越靠前；未登记类型回退 -1，排最前）。
 * 封装内部 {@link MARK_ORDER}，使外部按权排序而非直接触碰常量。 @public
 */
export function markOrder(t: MarkType): number { return MARK_ORDER.indexOf(t); }

/**
 * 判定 mark 是否为「非包含型」：在其右边界打字**不**继承（link/code）。
 * 封装内部 {@link NON_INCLUSIVE}；与 {@link isInclusive} 互为反义。 @public
 */
export function isNonInclusive(t: MarkType): boolean { return NON_INCLUSIVE.has(t); }

/** 判定 mark 是否为包含型（右边界打字会继承；link/code 不继承）。 @public */
export function isInclusive(t: MarkType): boolean { return !isNonInclusive(t); }

/** 按固定次序排序 marks，使同内容数组有唯一表示便于比较。 @public */
export function sortMarks(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => markOrder(a.type) - markOrder(b.type));
}

/** 判定两个 mark 是否相等（类型 + attrs 逐键比较）。 @public */
export function markEqual(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  const ka = a.attrs ? Object.keys(a.attrs) : [];
  const kb = b.attrs ? Object.keys(b.attrs) : [];
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a.attrs![k] !== (b.attrs ? b.attrs[k] : undefined)) return false;
  return true;
}

/**
 * 判定两组 marks 是否相等；不变量：存储已排序，故按位逐项比较即可。
 * 入参为 `readonly`：兼容行内原子的 `readonly []` marks，纯读不变异。 @public
 */
// 集合相等（与顺序无关；存储已排序，这里按位比即可）
export function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!markEqual(a[i], b[i])) return false;
  return true;
}

/** 判定一组 marks 是否含某类型（纯读，接受 `readonly` 兼容原子空 marks）。 @public */
export function hasMarkType(marks: readonly Mark[], type: MarkType): boolean {
  return marks.some((m) => m.type === type);
}
/** 取某类型的 mark（不存在返回 undefined；纯读，接受 `readonly`）。 @public */
export function getMark(marks: readonly Mark[], type: MarkType): Mark | undefined {
  return marks.find((m) => m.type === type);
}

/** 在 marks 上加/更新一个 mark（同类型唯一，attrs 走更新语义）。 @public */
// 在一组 marks 上「加/更新」一个 mark（同类型唯一，attrs 走更新语义）
export function withMark(marks: Mark[], mark: Mark): Mark[] {
  return sortMarks([...marks.filter((m) => m.type !== mark.type), mark]);
}
/** 从 marks 中移除某类型。 @public */
// 移除某类型
export function withoutMark(marks: Mark[], type: MarkType): Mark[] {
  return marks.filter((m) => m.type !== type);
}

// —— 块文本 ——
/** 拼接块内所有行内段的纯文本。 @public */
export function blockText(b: Block): string {
  let s = '';
  for (const inl of b.inlines) s += inl.text;
  return s;
}
/** 块内文本总字符长度。 @public */
export function blockTextLen(b: Block): number {
  let n = 0;
  for (const inl of b.inlines) n += inl.text.length;
  return n;
}
/** 判定块是否为空（文本总长为 0）。 @public */
export function isBlockEmpty(b: Block): boolean {
  return blockTextLen(b) === 0; // 仅文本：总长 0 即空（无空 inline 残留歧义，靠 normalize 保证）
}

/** 深拷贝单个行内节点（文本段或行内原子），marks/attrs 全部新建。 @public */
export function cloneInline(r: Inline): Inline {
  // 原子：marks 不变量恒为空（readonly []），无需拷贝标记
  if (isInlineAtom(r)) return { kind: 'atom', atom: r.atom, attrs: { ...r.attrs }, text: r.text, marks: [] };
  const marks = r.marks.map((m) => ({ type: m.type, attrs: m.attrs ? { ...m.attrs } : undefined }));
  return { kind: 'text', text: r.text, marks };
}

/**
 * 深拷贝块属性：浅拷标量字段之上，对引用型字段（表格 rows 的每个 cell.inlines、
 * colWidths/rowHeights/merges）逐项新建——撤销快照与当前态不得共享任何可变引用，
 * 否则覆盖层就地回写单元格会污染撤销栈。 @public
 */
export function cloneBlockAttrs(attrs: BlockAttrs): BlockAttrs {
  const out: BlockAttrs = { ...attrs };
  if (attrs.rows) out.rows = attrs.rows.map((row) => row.map(cloneCell));
  if (attrs.colWidths) out.colWidths = [...attrs.colWidths];
  if (attrs.rowHeights) out.rowHeights = [...attrs.rowHeights];
  if (attrs.merges) out.merges = attrs.merges.map((m) => ({ ...m }));
  return out;
}

/**
 * 深拷贝整个文档（块/属性/行内段/marks 全部新建，互不共享引用）。
 * 表格 rows 经 {@link cloneBlockAttrs} 逐 cell 深拷（单元格编辑不污染撤销栈）。 @public
 */
export function cloneDoc(d: Doc): Doc {
  return { blocks: d.blocks.map((b) => ({ type: b.type, attrs: cloneBlockAttrs(b.attrs), inlines: b.inlines.map(cloneInline) })) };
}

// —— 反序列化防线（localStorage 草稿 / 用户模板 / 外部 JSON）——
// cloneDoc/cloneBlockAttrs 对 inlines、表格 rows、colWidths/rowHeights/merges 做 map/展开，
// 畸形结构会同步抛 TypeError；不可信来源的块在进入文档树前必须经下列形状校验。

// 行内节点形状：text 段须有字符串 text + marks 数组；原子须有字符串 text + attrs 对象。
function isInlineShape(v: unknown): v is Inline {
  if (!v || typeof v !== 'object') return false;
  const r = v as { kind?: unknown; text?: unknown; marks?: unknown; attrs?: unknown };
  if (r.kind === 'text') return typeof r.text === 'string' && Array.isArray(r.marks);
  if (r.kind === 'atom') return typeof r.text === 'string' && !!r.attrs && typeof r.attrs === 'object';
  return false;
}
// 表格单元格形状：inlines 为合法行内节点数组。
function isCellShape(v: unknown): v is TableCell {
  if (!v || typeof v !== 'object') return false;
  const c = v as { inlines?: unknown };
  return Array.isArray(c.inlines) && c.inlines.every(isInlineShape);
}
// 普通对象（非 null、非数组）。
function isPlainObjectShape(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 校验未知值是否具备合法 Block 形状：type 已注册（{@link isKnownBlockType}）、attrs 为对象、
 * inlines 为合法行内节点数组；引用型 attrs 字段（表格 rows/colWidths/rowHeights/merges）
 * 结构正确——这些字段会被 cloneBlockAttrs map/展开，畸形即同步抛错。 @public
 */
export function isBlockShape(v: unknown): v is Block {
  if (!isPlainObjectShape(v)) return false;
  const b = v as { type?: unknown; attrs?: unknown; inlines?: unknown };
  if (typeof b.type !== 'string' || !isKnownBlockType(b.type)) return false;
  if (!isPlainObjectShape(b.attrs)) return false;
  if (!Array.isArray(b.inlines) || !b.inlines.every(isInlineShape)) return false;
  const a = b.attrs as BlockAttrs;
  if (a.rows !== undefined && !(Array.isArray(a.rows) && a.rows.every((row) => Array.isArray(row) && row.every(isCellShape)))) return false;
  if (a.colWidths !== undefined && !Array.isArray(a.colWidths)) return false;
  if (a.rowHeights !== undefined && !Array.isArray(a.rowHeights)) return false;
  if (a.merges !== undefined && !(Array.isArray(a.merges) && a.merges.every(isPlainObjectShape))) return false;
  return true;
}

/**
 * 把不可信来源的块数组清洗为合法 Block[]：畸形块（{@link isBlockShape} 未通过）丢弃并
 * console.warn；合法块的空 inlines 补单个空文本段（block() 构造不变量「每块 ≥1 inline」），
 * 消除 applyTemplate/草稿恢复经 cloneDoc 的崩溃面。 @public
 */
export function sanitizeStoredBlocks(value: unknown, source = '文档'): Block[] {
  if (!Array.isArray(value)) return [];
  const out: Block[] = [];
  let dropped = 0;
  for (const item of value) {
    if (isBlockShape(item)) out.push(item.inlines.length ? item : { ...item, inlines: [text('')] });
    else dropped++;
  }
  if (dropped > 0) console.warn(`[schema] ${source}：丢弃 ${dropped} 个畸形块（结构校验未通过）`);
  return out;
}
