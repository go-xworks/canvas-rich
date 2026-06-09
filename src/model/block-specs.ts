import type { BlockType, BlockAttrs } from './schema';
import { C, FONT_UI, FONT_MONO, BlockTheme } from './palette';

// 块注册表（单一信息源 SSOT）：行为 + 主题。
// 新增一个块类型 = 在此注册一条规格，richDocument / schema / styleResolver / docLayout 查表，
// 不再各处 switch(type)。「领域插件化」的核心抽象。
// 分层位置：model 层的块规格 SSOT，是块行为与主题的权威来源。

/** 单个块类型的完整规格：编辑行为标志位 + 主题工厂。 @public */
export interface BlockMeta {
  atom: boolean;             // 原子块（DOM 覆盖层，光标走「节点选中」）
  list: boolean;            // 列表类（自动编号/项目符号）
  continuesOnEnter: boolean; // Enter 保持同类型；为空时回车退出降级为段落
  liftOnBackspace: boolean;  // 块首 Backspace 先降级为段落（不与上一块合并）
  splitAtStart: boolean;     // 行首拆块：上方插空段落、内容保留原类型（标题/引用）
  defaultAfter: BlockType;   // Enter 在行中/行尾拆分时，后半块的类型
  overlay?: 'image' | 'formula' | 'table'; // 原子块对应的覆盖层类型
  theme(attrs: BlockAttrs): BlockTheme;     // 块主题（字体/字号/缩进/间距/标记/背景）
}

const para = (size: number, color = C.light, opts: Partial<BlockTheme> = {}): BlockTheme =>
  ({ base: { fontFamily: FONT_UI, fontSize: size, bold: false, italic: false, color }, indent: 0, spaceBefore: 4, spaceAfter: 4, marker: null, ordered: false, background: null, ...opts });

const P: Omit<BlockMeta, 'theme'> = { atom: false, list: false, continuesOnEnter: false, liftOnBackspace: false, splitAtStart: false, defaultAfter: 'paragraph' };

// 标题 H1–H6：字号逐级递减、统一加粗；颜色 H1 用 title、H2–H6 用 h2（均过白底 AA）。
// 间距随级别收窄；非法 level 夹回 1..6。
const HEADING_SIZE: Record<number, number> = { 1: 32, 2: 24, 3: 20, 4: 18, 5: 16, 6: 15 };
function headingTheme(level: number): BlockTheme {
  const lv = level < 1 ? 1 : level > 6 ? 6 : level;
  const size = HEADING_SIZE[lv];
  const color = lv === 1 ? C.title : C.h2;
  // 间距：H1 最大，逐级线性收窄到 H6 的最小值。
  const spaceBefore = Math.max(8, 20 - (lv - 1) * 2);
  const spaceAfter = Math.max(4, 7 - (lv - 1));
  return { base: { fontFamily: FONT_UI, fontSize: size, bold: true, italic: false, color }, indent: 0, spaceBefore, spaceAfter, marker: null, ordered: false, background: null };
}

/** 全部块类型到其规格的注册表（SSOT）。 @public */
export const blockMeta: Record<BlockType, BlockMeta> = {
  paragraph: { ...P, theme: () => para(19) },
  heading: {
    ...P, liftOnBackspace: true, splitAtStart: true, defaultAfter: 'paragraph',
    theme: (a) => headingTheme(a.level ?? 1),
  },
  bullet_item: { ...P, list: true, continuesOnEnter: true, liftOnBackspace: true, defaultAfter: 'bullet_item', theme: () => para(19, C.light, { indent: 30, spaceBefore: 2, spaceAfter: 2, marker: '•' }) },
  ordered_item: { ...P, list: true, continuesOnEnter: true, liftOnBackspace: true, defaultAfter: 'ordered_item', theme: () => para(19, C.light, { indent: 34, spaceBefore: 2, spaceAfter: 2, ordered: true }) },
  task_item: { ...P, list: true, continuesOnEnter: true, liftOnBackspace: true, defaultAfter: 'task_item', theme: (a) => para(19, C.light, { indent: 30, spaceBefore: 2, spaceAfter: 2, marker: a.checked ? '☑' : '☐' }) },
  blockquote: { ...P, liftOnBackspace: true, splitAtStart: true, defaultAfter: 'blockquote', theme: () => ({ base: { fontFamily: FONT_UI, fontSize: 19, bold: false, italic: true, color: C.muted }, indent: 22, spaceBefore: 6, spaceAfter: 6, marker: null, ordered: false, background: null }) },
  code_block: { ...P, continuesOnEnter: true, liftOnBackspace: true, defaultAfter: 'code_block', theme: () => ({ base: { fontFamily: FONT_MONO, fontSize: 16, bold: false, italic: false, color: C.codeText }, indent: 14, spaceBefore: 6, spaceAfter: 6, marker: null, ordered: false, background: C.codeBg }) },
  image: { ...P, atom: true, overlay: 'image', theme: () => para(19) },
  formula: { ...P, atom: true, overlay: 'formula', theme: () => para(19) },
  table: { ...P, atom: true, overlay: 'table', theme: () => para(19) },
};

/** 查表取块规格；未注册类型回退到段落基线 P。 @public */
export const meta = (t: BlockType): BlockMeta => blockMeta[t] ?? P;
/** 是否为原子块（DOM 覆盖层 + 节点选中）。 @public */
export const isAtom = (t: BlockType): boolean => meta(t).atom;
/** 是否为列表类块（自动编号/项目符号）。 @public */
export const isList = (t: BlockType): boolean => meta(t).list;
/** Enter 是否保持同类型。 @public */
export const continuesOnEnter = (t: BlockType): boolean => meta(t).continuesOnEnter;
/** 块首 Backspace 是否先降级为段落。 @public */
export const liftOnBackspace = (t: BlockType): boolean => meta(t).liftOnBackspace;
/** 是否在行首拆块（上方插空段落、内容保留原类型）。 @public */
export const splitAtStart = (t: BlockType): boolean => meta(t).splitAtStart;
/** 行中/行尾拆分时后半块的类型。 @public */
export const defaultAfter = (t: BlockType): BlockType => meta(t).defaultAfter;
