// 工具栏类型契约（ui 层）：可视状态快照、声明式 item 判别联合（以 command:id 引用统一命令总线）、
// 渲染上下文与渲染器签名。仅依赖 DOM 类型 + ToolbarState + 命令 id 字符串，零 model 依赖——
// 便于 node 环境单测谓词纯函数。ItemKind 用字符串字面量联合（isolatedModules:true 禁 const enum，
// 亦符合本仓「仅位标志用 enum」惯例）。旧 ToolbarHandlers 胖接口（40 方法）已删除，
// 工具栏不再持行为 bag，改经 ctx.exec 派发命名命令（editor/commands.CommandContext）。

/**
 * 命令参数（与 editor/commands.CommandArg 同形）：带值控件经 ctx.exec(id, arg) 透传载荷。
 * 在 ui 层就地声明以维持 ui→editor 无类型反向依赖（值域一致：字符串/数字/null/表格维度）。
 * @internal
 */
export type ToolbarCommandArg = string | number | null | { rows: number; cols: number };

/**
 * 工具栏的当前可视状态快照，用于驱动按钮 active/disabled 与块类型/方向回填。
 * @internal
 */
export interface ToolbarState {
  marks: Record<string, boolean>;
  blockValue: string;
  fontSize: string; // 当前生效字号（行内 mark 覆盖则为该值，否则块默认字号）
  fontFamily: string; // 当前生效字体族命名值（'default' 表示块默认）
  color: string | null; // 当前生效文字色 hex（无 color mark 时 null）
  highlight: string | null; // 当前生效高亮色 hex（无 highlight mark 时 null）
  align: string;
  dir: string;
  lineHeight: string; // 当前块行距倍数字符串（'1' / '1.15' / '1.5' / '2'，无则块默认）
  spaceBefore: number; // 当前块段前间距（逻辑 px）
  spaceAfter: number; // 当前块段后间距（逻辑 px）
  letterSpacing: number; // 当前块字间距（逻辑 px）
  canUndo: boolean;
  canRedo: boolean;
  shaperShort: string;
  theme: 'light' | 'dark'; // 当前主题，驱动主题切换按钮的图标（月亮/太阳）/文案/active 态
  viewMode: 'web' | 'word'; // 当前视图模式，驱动视图页签两按钮的 active 回填
}

/**
 * 已创建工具栏的句柄：用最新状态刷新按钮可视态；运行时追加 item；销毁解绑。
 * @internal
 */
export interface Toolbar {
  /** 用最新状态快照刷新全部已挂载控件的可视态。 */
  refresh(s: ToolbarState): void;
  /** 运行时追加一个声明式控件（按 item.tab/group/row 落位），返回注销函数。 */
  register(item: ToolbarItem): () => void;
  /** 销毁工具栏：清空已挂载控件的刷新句柄（document 监听沿用低风险绑定逻辑）。 */
  destroy(): void;
}

/** 控件落点的页签键。`trailing` = 不属任何 ribbon、常驻页签栏右端（导出钮）。 @internal */
export type ToolbarTab = 'start' | 'insert' | 'view' | 'trailing';

/**
 * 控件类型字符串字面量联合（kind → Renderer 的判别键）。
 * @internal
 */
export type ItemKind =
  | 'icon-button'
  | 'text-button'
  | 'label-dropdown'
  | 'color-dropdown'
  | 'grid-dropdown'
  | 'menu-dropdown'
  | 'template-dropdown'
  | 'num-input';

/** 全部 item 共有的落位 + 标识字段。 @internal */
export interface ItemBase {
  /** 全局唯一控件 id。 */
  id: string;
  /** 落点页签。 */
  tab: ToolbarTab;
  /** 落点功能组名（用于装配层定位，与 GroupSpec.group 对应）。 */
  group: string;
}

/**
 * 图标命令钮：mark/align/list/block 快捷钮 + 所有插入钮 + 撤销/重做。
 * active 走 setOn（蓝 wash）；disabled 走原生 el.disabled（勿用 setOn，否则画成蓝 wash 改视觉）。
 * @internal
 */
export interface IconButtonItem extends ItemBase {
  kind: 'icon-button';
  iconName: string;
  title: string;
  /** 点击派发的命令 id（经 ctx.exec）。 */
  command: string;
  /** 固定带参（如分隔线钮 command:'insert.shape', arg:'divider'）；省略则不带参。 */
  arg?: ToolbarCommandArg;
  active?(s: ToolbarState): boolean;
  disabled?(s: ToolbarState): boolean;
}

/**
 * 文字命令钮（带文案）：导入/导出/视图/整形器/主题。
 * dynamic 返回整段 html（icon + span），refresh 顺序钉死：先 dynamic 设 innerHTML 再 active 设 class。
 * @internal
 */
export interface TextButtonItem extends ItemBase {
  kind: 'text-button';
  iconName?: string;
  text?: string;
  title: string;
  className?: string;
  /** 点击派发的命令 id（经 ctx.exec）。 */
  command: string;
  active?(s: ToolbarState): boolean;
  dynamic?(s: ToolbarState, icon: (name: string, size?: number) => string): { html: string };
}

/**
 * 文本标签下拉：字体族/字号/块类型/行距。触发钮显示当前值，labelOf 回填。
 * withIcons=true（块类型）走带 icon 的项渲染。
 * @internal
 */
export interface LabelDropdownItem extends ItemBase {
  kind: 'label-dropdown';
  title: string;
  initialLabel: string;
  minW: string;
  options: [string, string][];
  clearLabel?: string | null;
  withIcons?: boolean;
  /** 选中项/清除项派发的命令 id；renderer 经 ctx.exec(command, value|null) 透传选值。 */
  command: string;
  labelOf(s: ToolbarState): string;
}

/**
 * 颜色下拉：文字色/高亮。触发钮带 chevron（withChevron 默认 true，绝不可设 false）。
 * @internal
 */
export interface ColorDropdownItem extends ItemBase {
  kind: 'color-dropdown';
  iconName: string;
  title: string;
  /** swatch/清除项/hex 输入派发的命令 id；renderer 经 ctx.exec(command, hex|null) 透传。 */
  command: string;
  isActive(s: ToolbarState): boolean;
}

/**
 * 网格下拉：表格（8×10，withChevron=false）。无 refresh。
 * @internal
 */
export interface GridDropdownItem extends ItemBase {
  kind: 'grid-dropdown';
  iconName: string;
  title: string;
  /** 点选网格派发的命令 id；renderer 经 ctx.exec(command, {rows,cols}) 透传维度。 */
  command: string;
}

/**
 * 菜单下拉：形状（shapes 图标，withChevron=false）。无 refresh。
 * @internal
 */
export interface MenuDropdownItem extends ItemBase {
  kind: 'menu-dropdown';
  triggerIcon: string;
  title: string;
  withChevron: boolean;
  items: { value: string; iconName?: string; label: string }[];
  /** 点选菜单项派发的命令 id；renderer 经 ctx.exec(command, opt.value) 透传选值。 */
  command: string;
}

/**
 * 模板下拉：运行时按 templateNames() 重建项，末项「设为模板…」。无 refresh，双监听两段式时序。
 * @internal
 */
export interface TemplateDropdownItem extends ItemBase {
  kind: 'template-dropdown';
  triggerIcon: string;
  title: string;
}

/**
 * 紧凑数字输入：段前/段后/字距。聚焦守卫；回车/失焦提交。
 * @internal
 */
export interface NumInputItem extends ItemBase {
  kind: 'num-input';
  label: string;
  numTitle: string;
  /** 失焦/回车提交派发的命令 id；renderer 经 ctx.exec(command, px) 透传数值。 */
  command: string;
  valueOf(s: ToolbarState): number;
}

/** 全部声明式控件的判别联合。 @internal */
export type ToolbarItem =
  | IconButtonItem
  | TextButtonItem
  | LabelDropdownItem
  | ColorDropdownItem
  | GridDropdownItem
  | MenuDropdownItem
  | TemplateDropdownItem
  | NumInputItem;

/** 单组的一行控件。 @internal */
export type ItemRow = ToolbarItem[];

/**
 * 功能组规格：tab 下的一个组，含组名小字与两行控件布局。
 * rows 顺序逐字照搬源两行布局——任何串行改变视觉换行。
 * @internal
 */
export interface GroupSpec {
  tab: ToolbarTab;
  group: string;
  name?: string;
  rows: ItemRow[];
}

/**
 * 渲染上下文：核心透传给 renderer 的依赖（不再把 40 方法胖接口直接喂给核心）。
 * @internal
 */
export interface ToolbarContext {
  /** 派发命名命令（含带参）：item 的点击/选值经此进入统一命令总线。 */
  exec: (id: string, arg?: ToolbarCommandArg) => void;
  /** 把焦点交还编辑器（各填充器收尾、wrap 收尾用）。 */
  focusEditor: () => void;
  /** 当前可选模板名列表（模板下拉打开时重建项直接拉取）。 */
  templateNames: () => string[];
  /** 从 ui/icons 注入，便于单测/避免全局耦合。 */
  icon: (name: string, size?: number) => string;
  /** = 源 wrap：preventDefault → fn → focusEditor，统一收尾回焦。 */
  wrap: (fn: () => void) => (e: Event) => void;
  /** 面板关闭器注册到本实例 closers。 */
  registerCloser: (close: () => void) => void;
  /** 关本实例全部面板。 */
  closeAllPanels: () => void;
}

/**
 * 已挂载控件：DOM 元素 + 可选刷新回调（无 active/label/value 的纯命令钮不实现）+ 可选 dispose。
 * @internal
 */
export interface MountedItem {
  el: HTMLElement;
  refresh?(s: ToolbarState): void;
  dispose?(): void;
}

/**
 * 渲染器签名：item + ctx → 已挂载控件。kind → Renderer 经穷举映射 RENDERERS 分发。
 * @internal
 */
export type Renderer<I extends ToolbarItem = ToolbarItem> = (item: I, ctx: ToolbarContext) => MountedItem;
