import type { BlockType, BlockAttrs, Block, Doc } from './schema';
import { MAX_LIST_DEPTH } from './schema';
import { C, FONT_UI, FONT_MONO, BlockTheme } from './palette';

// 块注册表（单一信息源 SSOT）：行为 + 主题。
// 新增一个块类型 = 在此注册一条规格，richDocument / schema / styleResolver / docLayout 查表，
// 不再各处 switch(type)。「领域插件化」的核心抽象。
// 分层位置：model 层的块规格 SSOT，是块行为与主题的权威来源。

/**
 * 原子块覆盖层规格（SSOT）：布局尺寸策略 + 默认尺寸 + 交互能力。
 * docLayout（原子块占位框）/ richDocument（insert* 默认尺寸）/ overlays（手柄与高度回填）统一查表，
 * 不再各处按 kind 写三元链/布尔链。
 * - `sizing`：'explicit' = 显示尺寸取 attrs.width/height（缺省查 defaultW/defaultH，按 align 定位）；
 *   'fullWidth' = 满内容宽 + fixedHeight 固定高度；'measured' = 满内容宽 + 实测高度回填（缺省 defaultH）。
 * - `defaultW` 缺省（如 image）表示默认满内容宽。
 * - `resizable`：覆盖层是否带右下角缩放手柄 + 拖动重排。
 * @public
 */
export interface OverlaySpec {
  defaultW?: number; // 默认显示宽（CSS px）；缺省 = 满内容宽
  defaultH?: number; // 默认显示高（CSS px）；measured 下为实测回填前的占位高
  sizing: 'explicit' | 'fullWidth' | 'measured';
  resizable: boolean;
  fixedHeight?: number; // fullWidth 专用：固定高度（CSS px）
}

/**
 * 导出辅助：转义 + 已配置的行内/单元格渲染器，供块导出钩子复用（实现注入自 export.ts）。
 * block-specs 仅声明此契约（纯类型，无实现），实现在 export.ts 闭包内构造并随每次导出传入，
 * 故 block-specs 不引入 mark-html/seal/toc/table-utils 等依赖，保持 model 层 SSOT 纯净。
 * @public
 */
export interface ExportHelpers {
  escHtml: (s: string) => string;
  escAttr: (s: string) => string;
  inlinesHtml: (b: Block) => string; // = b.inlines.map(runHtml).join('')
  inlinesMd: (b: Block) => string;
  alignAttr: (b: Block) => string;
  doc: Doc; // toc 等需扫描全文
}

/**
 * 单块导出钩子（Strategy）：b + helpers → 该块的 HTML/MD 片段（单块单 out 元素）。
 * 仅承接「单块单出口」分支；列表/任务/代码块等跨块聚类合并不走钩子（留在 export 循环顶部），
 * 否则会断裂连续 <ul>/<ol>/<pre> 合并与有序续号（见 export.ts 聚类判定）。
 * @public
 */
export type BlockExporter = {
  html?: (b: Block, h: ExportHelpers) => string;
  md?: (b: Block, h: ExportHelpers) => string;
};

/** 单个块类型的完整规格：编辑行为标志位 + 主题工厂。 @public */
export interface BlockMeta {
  atom: boolean; // 原子块（DOM 覆盖层，光标走「节点选中」）
  list: boolean; // 列表类（自动编号/项目符号）
  continuesOnEnter: boolean; // Enter 保持同类型；为空时回车退出降级为段落
  liftOnBackspace: boolean; // 块首 Backspace 先降级为段落（不与上一块合并）
  splitAtStart: boolean; // 行首拆块：上方插空段落、内容保留原类型（标题/引用）
  defaultAfter: BlockType; // Enter 在行中/行尾拆分时，后半块的类型
  overlay?:
    | 'image'
    | 'formula'
    | 'table'
    | 'shape'
    | 'audio'
    | 'video'
    | 'iframe'
    | 'attachment'
    | 'signature'
    | 'seal'
    | 'textbox'; // 原子块对应的覆盖层类型
  overlaySpec?: OverlaySpec; // 原子块覆盖层规格（仅 atom:true 的块填表）
  exporter?: BlockExporter; // 单块导出钩子（插件扩展点）：export 主循环优先查 meta.exporter，回退内置 BLOCK_EXPORTERS；内置块留空走注册表
  theme(attrs: BlockAttrs): BlockTheme; // 块主题（字体/字号/缩进/间距/标记/背景）
}

const para = (size: number, color = C.light, opts: Partial<BlockTheme> = {}): BlockTheme => ({
  base: { fontFamily: FONT_UI, fontSize: size, bold: false, italic: false, color },
  indent: 0,
  spaceBefore: 4,
  spaceAfter: 4,
  marker: null,
  ordered: false,
  background: null,
  ...opts,
});

const P: Omit<BlockMeta, 'theme'> = {
  atom: false,
  list: false,
  continuesOnEnter: false,
  liftOnBackspace: false,
  splitAtStart: false,
  defaultAfter: 'paragraph',
};

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
  return {
    base: { fontFamily: FONT_UI, fontSize: size, bold: true, italic: false, color },
    indent: 0,
    spaceBefore,
    spaceAfter,
    marker: null,
    ordered: false,
    background: null,
  };
}

/** 列表/任务项每加深一级的缩进步长（逻辑 px）。 @public */
export const LIST_DEPTH_STEP = 28;
// 无序列表项符号按 depth 轮换（实心圆 / 空心圆 / 实心方块），三级循环。
const BULLET_MARKERS = ['•', '◦', '▪'];
/** 把任意 depth 夹回合法区间 [0, MAX_LIST_DEPTH]（非有限值归 0）。 @public */
export function clampDepth(depth: number | undefined): number {
  if (!Number.isFinite(depth)) return 0;
  const d = Math.floor(depth as number);
  return d < 0 ? 0 : d > MAX_LIST_DEPTH ? MAX_LIST_DEPTH : d;
}
/** 取无序列表第 depth 级的项目符号（按 BULLET_MARKERS 轮换）。 @public */
export function bulletMarker(depth: number): string {
  const d = clampDepth(depth);
  return BULLET_MARKERS[d % BULLET_MARKERS.length];
}

/** 全部块类型到其规格的注册表（SSOT）。 @public */
export const blockMeta: Record<BlockType, BlockMeta> = {
  paragraph: { ...P, theme: () => para(19) },
  heading: {
    ...P,
    liftOnBackspace: true,
    splitAtStart: true,
    defaultAfter: 'paragraph',
    theme: (a) => headingTheme(a.level ?? 1),
  },
  bullet_item: {
    ...P,
    list: true,
    continuesOnEnter: true,
    liftOnBackspace: true,
    defaultAfter: 'bullet_item',
    theme: (a) =>
      para(19, C.light, {
        indent: 30 + clampDepth(a.depth) * LIST_DEPTH_STEP,
        spaceBefore: 2,
        spaceAfter: 2,
        marker: bulletMarker(a.depth ?? 0),
      }),
  },
  ordered_item: {
    ...P,
    list: true,
    continuesOnEnter: true,
    liftOnBackspace: true,
    defaultAfter: 'ordered_item',
    theme: (a) =>
      para(19, C.light, {
        indent: 34 + clampDepth(a.depth) * LIST_DEPTH_STEP,
        spaceBefore: 2,
        spaceAfter: 2,
        ordered: true,
      }),
  },
  task_item: {
    ...P,
    list: true,
    continuesOnEnter: true,
    liftOnBackspace: true,
    defaultAfter: 'task_item',
    theme: (a) =>
      para(19, C.light, {
        indent: 30 + clampDepth(a.depth) * LIST_DEPTH_STEP,
        spaceBefore: 2,
        spaceAfter: 2,
        marker: a.checked ? '☑' : '☐',
      }),
  },
  blockquote: {
    ...P,
    liftOnBackspace: true,
    splitAtStart: true,
    defaultAfter: 'blockquote',
    theme: () => ({
      base: { fontFamily: FONT_UI, fontSize: 19, bold: false, italic: true, color: C.muted },
      indent: 22,
      spaceBefore: 6,
      spaceAfter: 6,
      marker: null,
      ordered: false,
      background: null,
    }),
  },
  code_block: {
    ...P,
    continuesOnEnter: true,
    liftOnBackspace: true,
    defaultAfter: 'code_block',
    theme: () => ({
      base: { fontFamily: FONT_MONO, fontSize: 16, bold: false, italic: false, color: C.codeText },
      indent: 14,
      spaceBefore: 6,
      spaceAfter: 6,
      marker: null,
      ordered: false,
      background: C.codeBg,
    }),
  },
  // 覆盖层规格逐 kind 对照原 docLayout/richDocument/overlays 的散落常量填表（行为零变化）：
  // image 无 defaultW = 默认满内容宽、defaultH 200；audio/attachment 固定高 54/64；formula/table 实测回填（占位 52/120）。
  image: {
    ...P,
    atom: true,
    overlay: 'image',
    overlaySpec: { defaultH: 200, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  formula: {
    ...P,
    atom: true,
    overlay: 'formula',
    overlaySpec: { defaultH: 52, sizing: 'measured', resizable: false },
    theme: () => para(19),
  },
  table: {
    ...P,
    atom: true,
    overlay: 'table',
    overlaySpec: { defaultH: 120, sizing: 'measured', resizable: false },
    theme: () => para(19),
  },
  shape: {
    ...P,
    atom: true,
    overlay: 'shape',
    overlaySpec: { defaultW: 200, defaultH: 120, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  // 媒体原子块：音频/视频/内嵌网页(iframe)/附件，均走 DOM 覆盖层渲染（复用 image/shape 模式）。
  audio: {
    ...P,
    atom: true,
    overlay: 'audio',
    overlaySpec: { sizing: 'fullWidth', resizable: false, fixedHeight: 54 },
    theme: () => para(19),
  },
  video: {
    ...P,
    atom: true,
    overlay: 'video',
    overlaySpec: { defaultW: 480, defaultH: 270, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  iframe: {
    ...P,
    atom: true,
    overlay: 'iframe',
    overlaySpec: { defaultW: 480, defaultH: 270, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  attachment: {
    ...P,
    atom: true,
    overlay: 'attachment',
    overlaySpec: { sizing: 'fullWidth', resizable: false, fixedHeight: 64 },
    theme: () => para(19),
  },
  // 电子签名 / 印章原子块：签名走 <img>（手绘 PNG，类 image 可缩放）；印章走内联 SVG（随文字重绘）。
  signature: {
    ...P,
    atom: true,
    overlay: 'signature',
    overlaySpec: { defaultW: 220, defaultH: 90, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  seal: {
    ...P,
    atom: true,
    overlay: 'seal',
    overlaySpec: { defaultW: 120, defaultH: 120, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  // 文本框：可编辑浮动文本框，走 contenteditable 覆盖层（复用表格单元格的内容同步模式）。
  textbox: {
    ...P,
    atom: true,
    overlay: 'textbox',
    overlaySpec: { defaultW: 240, defaultH: 80, sizing: 'explicit', resizable: true },
    theme: () => para(19),
  },
  // 目录：非原子块，布局时扫描全文 heading 动态生成行；自身无内联文本。
  toc: { ...P, theme: () => para(16, C.muted, { spaceBefore: 8, spaceAfter: 8 }) },
};

/** 查表取块规格；未注册类型回退到段落基线 P。 @public */
export const meta = (t: BlockType): BlockMeta => blockMeta[t] ?? P;
/** 判定任意字符串是否为已注册的块类型（反序列化/外部 JSON 校验入口）。 @public */
export function isKnownBlockType(t: string): t is BlockType {
  return t in blockMeta;
}
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

// 未注册覆盖层规格的兜底：与历史行为一致（未知原子块按「满宽 + 实测回填」处理，无手柄）。
const FALLBACK_OVERLAY_SPEC: OverlaySpec = { sizing: 'measured', resizable: false };
/** 查表取原子块覆盖层规格；未填表的类型回退到 measured 兜底（满宽 + 实测回填，无手柄）。 @public */
export const overlaySpecOf = (t: BlockType): OverlaySpec => meta(t).overlaySpec ?? FALLBACK_OVERLAY_SPEC;
/**
 * 插入原子块时的默认尺寸 attrs（width/height，CSS px）：来自 overlaySpec 的 defaultW/defaultH。
 * 无显式默认宽的 kind（如 image 满内容宽）或非原子块返回 {}（attrs 不写尺寸键）。 @public
 */
export function atomSizeAttrs(t: BlockType): { width?: number; height?: number } {
  const s = meta(t).overlaySpec;
  return s && s.defaultW !== undefined && s.defaultH !== undefined ? { width: s.defaultW, height: s.defaultH } : {};
}
