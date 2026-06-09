// 文档树 schema：blocks（块级）+ inlines（行内）+ marks（行内区间属性）。
// 本迭代 inline 仅支持 TextRun（文本段）；行内原子对象（图片/mention）为后续扩展，
// 位置模型已按「原子占 1 offset」预留，但暂不落地渲染。
import { isList, isAtom } from './block-specs';

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
/** 行内节点联合类型（本迭代仅 TextRun，预留原子对象扩展）。 @public */
export type Inline = TextRun;

/** 块级节点的类型枚举。 @public */
export type BlockType = 'paragraph' | 'heading' | 'bullet_item' | 'ordered_item' | 'task_item' | 'blockquote' | 'code_block' | 'image' | 'formula' | 'table';
/** 判定块类型是否为列表项（委托块行为注册表 SSOT）。 @public */
// 委托给块行为注册表（SSOT），避免多处重复枚举
export function isListType(t: BlockType): boolean { return isList(t); }
/** 判定块类型是否为原子块（不可编辑内联文本）。 @public */
export function isAtomBlock(t: BlockType): boolean { return isAtom(t); }
let _idc = 0;
/** 生成进程内单调递增的稳定块 id。 @public */
export function genBlockId(): string { return 'blk' + (++_idc); } // 稳定块 id（覆盖层按 id 缓存，跨 undo 不丢）

/** 块级属性集合（id/对齐/书写方向/原子块专属字段等）。 @public */
export interface BlockAttrs {
  id?: string;                          // 稳定 id（原子块覆盖层缓存键）
  level?: 1 | 2 | 3 | 4 | 5 | 6; align?: 'left' | 'center' | 'right';
  checked?: boolean;                    // task_item：勾选态（marker ☐/☑）
  dir?: 'ltr' | 'rtl';                  // 书写方向（文字方向）
  src?: string; width?: number; height?: number;  // image（显示尺寸，CSS px）
  latex?: string;                       // formula
  rows?: string[][];                    // table（v1：纯文本单元格）
  measuredH?: number;                   // 覆盖层实测高度（逻辑 px），回填给布局
}
/** 块级节点：类型 + 属性 + 行内序列。 @public */
export interface Block { type: BlockType; attrs: BlockAttrs; inlines: Inline[] }

/** 文档根节点：块的有序列表。 @public */
export interface Doc { blocks: Block[] }

// —— 构造器 ——
/** 构造一个文本段，marks 自动规范化排序。 @public */
export const text = (s: string, marks: Mark[] = []): TextRun => ({ kind: 'text', text: s, marks: sortMarks(marks) });
/** 构造一个块；空行内序列回退为单个空文本段以承载光标。 @public */
export const block = (type: BlockType, inlines: Inline[], attrs: BlockAttrs = {}): Block =>
  ({ type, attrs, inlines: inlines.length ? inlines : [text('')] });
/** 构造一个段落块（block 的便捷封装）。 @public */
export const para = (inlines: Inline[], attrs: BlockAttrs = {}): Block => block('paragraph', inlines, attrs);

// —— marks 工具 ——
/** 判定 mark 是否为包含型（右边界打字会继承；link/code 不继承）。 @public */
export function isInclusive(t: MarkType): boolean { return !NON_INCLUSIVE.has(t); }

/** 按固定次序排序 marks，使同内容数组有唯一表示便于比较。 @public */
export function sortMarks(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
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

/** 判定两组 marks 是否相等；不变量：存储已排序，故按位逐项比较即可。 @public */
// 集合相等（与顺序无关；存储已排序，这里按位比即可）
export function marksEqual(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!markEqual(a[i], b[i])) return false;
  return true;
}

/** 判定一组 marks 是否含某类型。 @public */
export function hasMarkType(marks: Mark[], type: MarkType): boolean {
  return marks.some((m) => m.type === type);
}
/** 取某类型的 mark（不存在返回 undefined）。 @public */
export function getMark(marks: Mark[], type: MarkType): Mark | undefined {
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

/** 深拷贝整个文档（块/属性/行内段/marks 全部新建，互不共享引用）。 @public */
export function cloneDoc(d: Doc): Doc {
  return { blocks: d.blocks.map((b) => ({ type: b.type, attrs: { ...b.attrs }, inlines: b.inlines.map((r) => ({ kind: 'text', text: r.text, marks: r.marks.map((m) => ({ type: m.type, attrs: m.attrs ? { ...m.attrs } : undefined })) })) })) };
}
