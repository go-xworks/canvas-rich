// 工具栏样式令牌与数据常量（ui 层）：集中全部 Tailwind 类令牌、控件定义表与 setOn 切换器，
// 作为「视觉零变化」的地基——任何字符串漂移即视觉回归。自 src/ui/toolbar.ts 逐字符切出。
// 分层：纯样式/数据常量，无 DOM 操作（除 setOn 仅切 class），不依赖 model。

// —— 样式令牌（集中一处，便于全局微调精致度）——
// 外壳：竖向堆叠（页签栏 + Ribbon），底部一道分隔与正文区隔开。
/** 工具栏宿主外壳类。 @internal */
export const HOST = 'flex flex-col bg-[var(--rte-chrome-bg)] border-b border-[var(--rte-chrome-border)] '
  + 'font-sans select-none';
// 页签栏：一行文字页签，右端常驻区。
/** 页签栏容器类。 @internal */
export const TABBAR = 'flex items-stretch gap-0.5 px-2 h-[34px] border-b border-[var(--rte-chrome-border)]';
// 单个页签：文字按钮，active 时底部蓝下划线 + 蓝字。
/** 单个页签按钮类。 @internal */
export const TAB = 'relative px-3 h-full bg-transparent border-0 appearance-none cursor-pointer '
  + 'text-[13px] text-[var(--rte-muted)] inline-flex items-center transition-colors '
  + 'hover:text-[var(--rte-chrome-fg)]';
// active 页签：蓝字 + 底部 2px 蓝条（伪元素用内联 span 实现）。
/** active 页签附加类。 @internal */
export const TAB_ON = 'text-[var(--rte-active-fg)]! ';
// Ribbon 面板：横向功能组，~2 行高（72px），窄屏 flex-wrap 兜底。
/** Ribbon 面板容器类。 @internal */
export const RIBBON = 'flex flex-wrap items-stretch gap-0 px-2 py-1.5 min-h-[64px]';
// 功能组：纵向容纳两行控件，组间细竖线分隔（最后一组不画线）。
/** 功能组容器类。 @internal */
export const GROUP = 'flex items-center gap-1 px-2 self-stretch border-r border-[var(--rte-chrome-border)] '
  + 'last:border-r-0';
// 组内两行紧凑布局容器。
/** 组内两行布局容器类。 @internal */
export const GROUP_ROWS = 'flex flex-col gap-1 justify-center';
/** 行容器类。 @internal */
export const ROW = 'flex items-center gap-0.5';
// 方形图标按钮（28px，圆角）。
/** 方形图标按钮类。 @internal */
export const BTN = 'w-[28px] h-[28px] rounded-md bg-transparent border-0 appearance-none '
  + 'text-[var(--rte-chrome-fg)] cursor-pointer inline-flex items-center justify-center '
  + 'transition-colors duration-150 hover:bg-[var(--rte-chrome-hover)] '
  + 'disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent';
// 文字按钮（导入/导出/整形器等带文案）。
/** 文字按钮类（继承 BTN）。 @internal */
export const BTN_TEXT = BTN + ' w-auto px-2 gap-1 text-[12px]';
/** 下拉面板容器类。 @internal */
export const PANEL = 'absolute left-0 top-[32px] z-50 p-2 bg-[var(--rte-overlay-bg)] '
  + 'border border-[var(--rte-overlay-border)] rounded-lg shadow-[var(--rte-shadow)] hidden';
/** 颜色色块按钮类。 @internal */
export const SWATCH = 'w-[22px] h-[22px] rounded-[5px] border border-black/15 cursor-pointer p-0 '
  + 'appearance-none transition-transform hover:scale-110';

/** 文字色/高亮预设色板（8 色）。 @internal */
export const SWATCHES = ['#1f2430', '#ef4444', '#f97316', '#eab308', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];

// 字号预设（px）；选中即写入 fontSize 行内 mark，清除恢复块默认字号。
/** 字号预设（px 字符串）。 @internal */
export const FONT_SIZES = ['12', '14', '16', '18', '20', '24', '28', '32'];
// 字体族命名值 → 显示名；'default' 为「默认/系统」（清除行内 mark，回退块主题）。
/** 字体族命名值 → 显示名映射。 @internal */
export const FONT_FAMILIES: [string, string][] = [
  ['default', '默认 / 系统'], ['serif', '衬线'], ['monospace', '等宽'], ['heiti', '黑体'], ['kaiti', '楷体'],
];
// 行距倍数预设（value 为倍数字符串，label 为显示名）。
/** 行距倍数预设（value 倍数字符串，label 显示名）。 @internal */
export const LINE_HEIGHTS: [string, string][] = [
  ['1', '单倍'], ['1.15', '1.15'], ['1.5', '1.5 倍'], ['2', '双倍'],
];
// 形状下拉项：[kind, 图标名, 显示名]（9 种，与 schema.ShapeKind 一致）。
/** 形状下拉项定义：[kind, 图标名, 显示名]（9 种）。 @internal */
export const SHAPE_DEFS: [string, string, string][] = [
  ['line', 'sh-line', '直线'], ['rect', 'sh-rect', '矩形'], ['rounded-rect', 'sh-rounded', '圆角矩形'],
  ['ellipse', 'sh-ellipse', '椭圆'], ['triangle', 'sh-triangle', '三角形'], ['diamond', 'sh-diamond', '菱形'],
  ['star', 'sh-star', '五角星'], ['arrow', 'sh-arrow', '箭头'], ['divider', 'sh-divider', '分隔线'],
];

// 下拉菜单项（行选择）通用样式。
/** 下拉菜单项通用类。 @internal */
export const MENU_ITEM = 'w-full text-left px-2.5 h-[28px] rounded-md bg-transparent border-0 appearance-none '
  + 'text-[var(--rte-chrome-fg)] text-[13px] cursor-pointer inline-flex items-center whitespace-nowrap '
  + 'hover:bg-[var(--rte-chrome-hover)]';
// 颜色/高亮面板底部 hex 输入。
/** 颜色/高亮面板底部 hex 输入类。 @internal */
export const HEX_INPUT = 'mt-1.5 w-full h-[26px] px-2 rounded-md border border-[var(--rte-overlay-border)] '
  + 'bg-transparent text-[var(--rte-chrome-fg)] text-[12px] outline-none focus:border-[var(--rte-accent)] '
  + 'placeholder:text-[var(--rte-muted)] tabular-nums';
// 组名小字（JitWord 风格组标题，居中置于组底部）。
/** 组名小字类。 @internal */
export const GROUP_NAME = 'text-[10px] leading-none text-[var(--rte-muted)] text-center pt-0.5';

// —— 控件定义表（模块级常量，避免在工厂内重复构建）——

/** 页签定义：[key, 显示名]。 @internal */
export const TAB_DEFS: [string, string][] = [
  ['start', '开始'], ['insert', '插入'], ['view', '视图'],
];

/** 块类型下拉定义：[value, 图标名, 标题(含快捷键), 下拉/标签短名]。 @internal */
export const BLOCK_DEFS: [string, string, string, string][] = [
  ['paragraph', 'pilcrow', '正文 ⌘⌥0', '正文'],
  ['heading1', 'heading-1', '标题 1 ⌘⌥1', '标题 1'], ['heading2', 'heading-2', '标题 2 ⌘⌥2', '标题 2'],
  ['heading3', 'heading-3', '标题 3 ⌘⌥3', '标题 3'], ['heading4', 'heading-4', '标题 4 ⌘⌥4', '标题 4'],
  ['heading5', 'heading-5', '标题 5 ⌘⌥5', '标题 5'], ['heading6', 'heading-6', '标题 6 ⌘⌥6', '标题 6'],
  ['blockquote', 'quote', '引用 ⌘⌥Q', '引用'], ['code_block', 'square-code', '代码块', '代码块'],
];

/** 列表块快捷按钮定义：[value, 图标名, 标题]。 @internal */
export const LIST_DEFS: [string, string, string][] = [
  ['bullet_item', 'list', '项目符号 ⌘⌥8'], ['ordered_item', 'list-ordered', '编号列表 ⌘⌥9'],
  ['task_item', 'list-checks', '任务列表 ⌘⌥T'],
];

/** 行内 mark 定义：[type, 图标名, 标题]。 @internal */
export const MARK_DEFS: [string, string, string][] = [
  ['bold', 'bold', '粗体 ⌘B'], ['italic', 'italic', '斜体 ⌘I'], ['underline', 'underline', '下划线 ⌘U'],
  ['strikethrough', 'strikethrough', '删除线'], ['code', 'code', '行内代码'],
];

/** 对齐方式定义：[value, 图标名, 标题]。 @internal */
export const ALIGN_DEFS: [string, string, string][] = [
  ['left', 'align-left', '左对齐 ⌘⇧L'], ['center', 'align-center', '居中 ⌘E'], ['right', 'align-right', '右对齐 ⌘⇧R'],
  ['justify', 'align-justify', '两端对齐'], ['distribute', 'align-distribute', '分散对齐'],
];

// active：浅蓝 wash 底 + 蓝前景（important 压过同层基础类的 transparent / chrome-fg）
/**
 * 切换元素 active 可视态（浅蓝 wash 底 + 蓝前景，important 压过基础类）。
 * @internal
 */
export function setOn(el: HTMLElement, on: boolean): void {
  el.classList.toggle('bg-[var(--rte-active-bg)]!', on);
  el.classList.toggle('text-[var(--rte-active-fg)]!', on);
}
