/**
 * 工具栏状态快照（ui 层）：从文档/样式解析器只读构建 ToolbarState（buildToolbarState），
 * 并提供快照等价比较（isToolbarStateEqual）作 refresh 前的脏检查 —— 状态未变则装配层
 * 跳过整栏 70+ 控件的 DOM 回填（每键入/拖动帧的性能点）。自 main.ts 下沉的纯读逻辑。
 */
import type { RichDoc } from '../model/rich-document';
import type { StyleResolver } from '../model/style-resolver';
import type { ToolbarState } from './toolbar';

/**
 * buildToolbarState 的视图环境入参：不来自文档本身的展示态（整形器名/主题/视图模式）。
 * @public
 */
export interface ToolbarViewEnv {
  shaperShort: string;
  theme: 'light' | 'dark';
  viewMode: 'web' | 'word';
}

/**
 * 焦点块的工具栏「块类型」下拉值：heading 拼上级别（`heading1`..`heading6`，级别夹回 1..6），
 * 其余块直接返回块类型名。
 * @public
 */
export function blockValueOf(rd: RichDoc): string {
  const b = rd.focusBlock();
  if (b.type === 'heading') { const l = b.attrs.level ?? 1; return 'heading' + (l < 1 ? 1 : l > 6 ? 6 : l); }
  return b.type;
}

/**
 * 当前生效字号（字符串）：有 fontSize 行内 mark 取其值，否则回退焦点块主题默认字号（取整）。
 * @returns 字号像素值的字符串形式（如 `"16"`）
 * @public
 */
export function activeFontSize(rd: RichDoc, resolver: StyleResolver): string {
  const fs = rd.activeMarks().find((m) => m.type === 'fontSize');
  if (fs?.attrs?.size) return fs.attrs.size;
  return String(Math.round(resolver.resolveBlock(rd.focusBlock()).base.fontSize));
}

/**
 * 当前生效字体族的命名值：有 fontFamily 行内 mark 取其命名值，否则 `'default'`（随块主题）。
 * @public
 */
export function activeFontFamily(rd: RichDoc): string {
  return rd.activeMarks().find((m) => m.type === 'fontFamily')?.attrs?.fontFamily ?? 'default';
}

/** 当前生效文字色 hex：有 color 行内 mark 取其 attrs.color，否则 null（无显式色，按主题默认）。@public */
export function activeColor(rd: RichDoc): string | null {
  return rd.activeMarks().find((m) => m.type === 'color')?.attrs?.color ?? null;
}

/** 当前生效高亮色 hex：有 highlight 行内 mark 取其 attrs.color，否则 null。@public */
export function activeHighlight(rd: RichDoc): string | null {
  return rd.activeMarks().find((m) => m.type === 'highlight')?.attrs?.color ?? null;
}

/**
 * 从文档当前选区/焦点块只读构建工具栏状态快照（不改文档、不触发重排）。
 * @param view - 展示态环境（整形器名/主题/视图模式），由装配层传入
 * @public
 */
export function buildToolbarState(rd: RichDoc, resolver: StyleResolver, view: ToolbarViewEnv): ToolbarState {
  const blk = rd.focusBlock();
  return {
    marks: {
      bold: rd.markActive('bold'), italic: rd.markActive('italic'),
      underline: rd.markActive('underline'), strikethrough: rd.markActive('strikethrough'),
      highlight: rd.markActive('highlight'), code: rd.markActive('code'), link: rd.markActive('link'),
      superscript: rd.markActive('superscript'), subscript: rd.markActive('subscript'),
    },
    blockValue: blockValueOf(rd),
    fontSize: activeFontSize(rd, resolver),
    fontFamily: activeFontFamily(rd),
    color: activeColor(rd),
    highlight: activeHighlight(rd),
    align: blk.attrs.align ?? 'left',
    dir: blk.attrs.dir ?? 'ltr',
    lineHeight: blk.attrs.lineHeight != null ? String(blk.attrs.lineHeight) : '1',
    spaceBefore: blk.attrs.spaceBefore ?? 0,
    spaceAfter: blk.attrs.spaceAfter ?? 0,
    letterSpacing: blk.attrs.letterSpacing ?? 0,
    canUndo: rd.canUndo, canRedo: rd.canRedo,
    shaperShort: view.shaperShort,
    theme: view.theme,
    viewMode: view.viewMode,
  };
}

// ToolbarState 除 marks 外的标量字段全集：Record<…, true> 强制穷举 —— 新增字段漏列会编译报错，
// 防止脏检查漏比导致工具栏「该刷不刷」。
const SCALAR_KEY_SET: Record<Exclude<keyof ToolbarState, 'marks'>, true> = {
  blockValue: true, fontSize: true, fontFamily: true, color: true, highlight: true,
  align: true, dir: true, lineHeight: true, spaceBefore: true, spaceAfter: true,
  letterSpacing: true, canUndo: true, canRedo: true, shaperShort: true, theme: true, viewMode: true,
};
const SCALAR_KEYS = Object.keys(SCALAR_KEY_SET) as Exclude<keyof ToolbarState, 'marks'>[];

/**
 * 两份工具栏状态快照是否等价：标量字段逐一 `===`；marks 为对象需逐键比较（键集 + 布尔值）。
 * 供装配层 refresh 前的脏检查 —— 等价则跳过 DOM 更新。
 * @public
 */
export function isToolbarStateEqual(a: ToolbarState, b: ToolbarState): boolean {
  for (const k of SCALAR_KEYS) if (a[k] !== b[k]) return false;
  const ak = Object.keys(a.marks), bk = Object.keys(b.marks);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a.marks[k] !== b.marks[k]) return false;
  return true;
}
