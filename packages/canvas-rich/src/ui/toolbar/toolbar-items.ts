// 工具栏声明式清单（ui 层）：TOOLBAR_GROUPS 按 tab→group→row 逐条描述 54 控件，是「新增功能 = 改这里」
// 的单一真相源。tab→group→row 顺序与两行布局逐字照搬 src/ui/toolbar.original.ts（媒体组形状在 row1、
// 公式在 row2 等非直觉布局必须保真，任何串行改变视觉换行）。三个 label 纯查找函数置此供谓词复用。
import {
  FONT_SIZES,
  FONT_FAMILIES,
  LINE_HEIGHTS,
  SHAPE_DEFS,
  BLOCK_DEFS,
  LIST_DEFS,
  MARK_DEFS,
  ALIGN_DEFS,
  BTN_TEXT,
} from './tokens';
import type { GroupSpec, ToolbarItem } from './types';

/** 段落数字输入定义：[标签, 标题(含 px 单位)]。标题经 tipDescKey 归一须命中 TIP_DESC。 @internal */
export const NUM_INPUT_DEFS: [string, string][] = [
  ['段前', '段前间距 (px)'],
  ['段后', '段后间距 (px)'],
  ['字距', '字间距 (px)'],
];

/** 当前字体族命名值 → 显示名（缺失回退第一项）。 @internal */
export function familyLabelOf(v: string): string {
  return FONT_FAMILIES.find(([val]) => val === v)?.[1] ?? FONT_FAMILIES[0][1];
}
/** 当前块类型值 → 下拉短名（缺失回退第一项）。 @internal */
export function blockNameOf(v: string): string {
  return BLOCK_DEFS.find(([val]) => val === v)?.[3] ?? BLOCK_DEFS[0][3];
}
/** 当前行距倍数值 → 显示名（缺失回退第一项）。 @internal */
export function lineHeightLabelOf(v: string): string {
  return LINE_HEIGHTS.find(([val]) => val === v)?.[1] ?? LINE_HEIGHTS[0][1];
}

// —— 由 DEFS 派生的 item 片段（零硬编码漂移）——

/** 列表块值 → 专用无参命令 id（固定值快捷钮经专用命令，避免下拉式带值）。 */
const LIST_CMD: Record<string, string> = {
  bullet_item: 'block.bullet',
  ordered_item: 'block.ordered',
  task_item: 'block.task',
};

/** 行内 mark 快捷钮（B/I/U/S/code）：每个 mark 经专用命令 mark.<type>。 */
const markItems: ToolbarItem[] = MARK_DEFS.map(([type, ic, title]) => ({
  kind: 'icon-button',
  id: `mark-${type}`,
  tab: 'start',
  group: '字体',
  iconName: ic,
  title,
  command: `mark.${type}`,
  active: (s) => !!s.marks[type],
}));

/** 对齐快捷钮（左/中/右/两端/分散）：经专用命令 align.<a>。 */
const alignItems: ToolbarItem[] = ALIGN_DEFS.map(([a, ic, title]) => ({
  kind: 'icon-button',
  id: `align-${a}`,
  tab: 'start',
  group: '段落',
  iconName: ic,
  title,
  command: `align.${a}`,
  active: (s) => s.align === a,
}));

/** 列表快捷钮（项目/编号/任务）：经专用命令 block.bullet/ordered/task。 */
const listItems: ToolbarItem[] = LIST_DEFS.map(([val, ic, title]) => ({
  kind: 'icon-button',
  id: `list-${val}`,
  tab: 'start',
  group: '段落',
  iconName: ic,
  title,
  command: LIST_CMD[val],
  active: (s) => s.blockValue === val,
}));

/** 块类型下拉的选项（短名）与项图标（与 BLOCK_DEFS 同序派生）。 */
const blockOptions: [string, string][] = BLOCK_DEFS.map(([val, , , short]) => [val, short]);
/** 形状菜单项（由 SHAPE_DEFS 派生，含 divider）。 */
const shapeMenuItems = SHAPE_DEFS.map(([value, iconName, label]) => ({ value, iconName, label }));

/**
 * 声明式控件清单：54 控件按 tab→group→两行布局描述。rows 顺序逐字照搬源文件，禁止串行。
 * 新增功能 = 往对应 group.rows 加一条描述符。
 * @internal
 */
export const TOOLBAR_GROUPS: GroupSpec[] = [
  // ============ 开始页签 ============
  // —— 历史组（撤销 / 重做）——
  {
    tab: 'start',
    group: '历史',
    name: '历史',
    rows: [
      [
        {
          kind: 'icon-button',
          id: 'undo',
          tab: 'start',
          group: '历史',
          iconName: 'undo-2',
          title: '撤销 ⌘Z',
          command: 'history.undo',
          disabled: (s) => !s.canUndo,
        },
      ],
      [
        {
          kind: 'icon-button',
          id: 'redo',
          tab: 'start',
          group: '历史',
          iconName: 'redo-2',
          title: '重做 ⌘⇧Z',
          command: 'history.redo',
          disabled: (s) => !s.canRedo,
        },
      ],
    ],
  },
  // —— 字体组：字体族 + 字号 / B I U S 上下标 行内代码 / 文字色 高亮 清除 ——
  {
    tab: 'start',
    group: '字体',
    name: '字体',
    rows: [
      [
        {
          kind: 'label-dropdown',
          id: 'font-family',
          tab: 'start',
          group: '字体',
          title: '字体族',
          initialLabel: FONT_FAMILIES[0][1],
          minW: 'min-w-[92px]',
          options: FONT_FAMILIES,
          clearLabel: null,
          command: 'fontFamily.set',
          labelOf: (s) => familyLabelOf(s.fontFamily),
        },
        {
          kind: 'label-dropdown',
          id: 'font-size',
          tab: 'start',
          group: '字体',
          title: '字号',
          initialLabel: '19',
          minW: 'min-w-[58px]',
          options: FONT_SIZES.map((sz) => [sz, sz] as [string, string]),
          clearLabel: '默认字号',
          command: 'fontSize.set',
          labelOf: (s) => s.fontSize,
        },
      ],
      [
        ...markItems,
        {
          kind: 'icon-button',
          id: 'superscript',
          tab: 'start',
          group: '字体',
          iconName: 'superscript',
          title: '上标',
          command: 'mark.superscript',
          active: (s) => !!s.marks.superscript,
        },
        {
          kind: 'icon-button',
          id: 'subscript',
          tab: 'start',
          group: '字体',
          iconName: 'subscript',
          title: '下标',
          command: 'mark.subscript',
          active: (s) => !!s.marks.subscript,
        },
        {
          kind: 'color-dropdown',
          id: 'color',
          tab: 'start',
          group: '字体',
          iconName: 'baseline',
          title: '文字颜色',
          command: 'color.set',
          isActive: (s) => s.color !== null,
        },
        {
          kind: 'color-dropdown',
          id: 'highlight',
          tab: 'start',
          group: '字体',
          iconName: 'highlighter',
          title: '高亮颜色',
          command: 'highlight.set',
          isActive: (s) => s.highlight !== null,
        },
        {
          kind: 'icon-button',
          id: 'clear-format',
          tab: 'start',
          group: '字体',
          iconName: 'eraser',
          title: '清除格式',
          command: 'format.clear',
        },
      ],
    ],
  },
  // —— 段落组：块类型下拉 / 对齐5 + 方向 / 列表3 引用 缩进± / 行距 段前 段后 字距 ——
  {
    tab: 'start',
    group: '段落',
    name: '段落',
    rows: [
      [
        {
          kind: 'label-dropdown',
          id: 'block-type',
          tab: 'start',
          group: '段落',
          title: '块类型',
          initialLabel: BLOCK_DEFS[0][3],
          minW: 'min-w-[88px]',
          options: blockOptions,
          withIcons: true,
          command: 'block.set',
          labelOf: (s) => blockNameOf(s.blockValue),
        },
        ...alignItems,
        {
          kind: 'icon-button',
          id: 'dir',
          tab: 'start',
          group: '段落',
          iconName: 'arrow-left-right',
          title: '文字方向 LTR / RTL ⌘⇧D',
          command: 'dir.toggle',
          active: (s) => s.dir === 'rtl',
        },
      ],
      [
        ...listItems,
        {
          kind: 'icon-button',
          id: 'quote',
          tab: 'start',
          group: '段落',
          iconName: 'quote',
          title: '引用 ⌘⌥Q',
          command: 'block.quote',
          active: (s) => s.blockValue === 'blockquote',
        },
        {
          kind: 'icon-button',
          id: 'indent-dec',
          tab: 'start',
          group: '段落',
          iconName: 'indent-decrease',
          title: '减少缩进',
          command: 'indent.dec',
        },
        {
          kind: 'icon-button',
          id: 'indent-inc',
          tab: 'start',
          group: '段落',
          iconName: 'indent-increase',
          title: '增加缩进',
          command: 'indent.inc',
        },
        {
          kind: 'label-dropdown',
          id: 'line-height',
          tab: 'start',
          group: '段落',
          title: '行距',
          initialLabel: LINE_HEIGHTS[0][1],
          minW: 'min-w-[68px]',
          options: LINE_HEIGHTS,
          clearLabel: null,
          command: 'lineHeight.set',
          labelOf: (s) => lineHeightLabelOf(s.lineHeight),
        },
        {
          kind: 'num-input',
          id: 'space-before',
          tab: 'start',
          group: '段落',
          label: NUM_INPUT_DEFS[0][0],
          numTitle: NUM_INPUT_DEFS[0][1],
          command: 'space.before.set',
          valueOf: (s) => s.spaceBefore,
        },
        {
          kind: 'num-input',
          id: 'space-after',
          tab: 'start',
          group: '段落',
          label: NUM_INPUT_DEFS[1][0],
          numTitle: NUM_INPUT_DEFS[1][1],
          command: 'space.after.set',
          valueOf: (s) => s.spaceAfter,
        },
        {
          kind: 'num-input',
          id: 'letter-spacing',
          tab: 'start',
          group: '段落',
          label: NUM_INPUT_DEFS[2][0],
          numTitle: NUM_INPUT_DEFS[2][1],
          command: 'letterSpacing.set',
          valueOf: (s) => s.letterSpacing,
        },
      ],
    ],
  },

  // ============ 插入页签 ============
  // —— 媒体组：row1=图片/行内图/形状/音频/视频/签名，row2=公式/表格/iframe/附件/印章/文本框 ——
  {
    tab: 'insert',
    group: '媒体',
    name: '媒体',
    rows: [
      [
        {
          kind: 'icon-button',
          id: 'image',
          tab: 'insert',
          group: '媒体',
          iconName: 'image',
          title: '插入图片（块级）',
          command: 'insert.image',
        },
        {
          kind: 'icon-button',
          id: 'inline-image',
          tab: 'insert',
          group: '媒体',
          iconName: 'image-plus',
          title: '插入行内图片（随文字流动）',
          command: 'insert.inlineImage',
        },
        {
          kind: 'menu-dropdown',
          id: 'shape',
          tab: 'insert',
          group: '媒体',
          triggerIcon: 'shapes',
          title: '插入形状',
          withChevron: false,
          items: shapeMenuItems,
          command: 'insert.shape',
        },
        {
          kind: 'icon-button',
          id: 'audio',
          tab: 'insert',
          group: '媒体',
          iconName: 'audio-lines',
          title: '插入音频（URL）',
          command: 'insert.audio',
        },
        {
          kind: 'icon-button',
          id: 'video',
          tab: 'insert',
          group: '媒体',
          iconName: 'video',
          title: '插入视频（URL）',
          command: 'insert.video',
        },
        {
          kind: 'icon-button',
          id: 'signature',
          tab: 'insert',
          group: '媒体',
          iconName: 'signature',
          title: '插入电子签名（手写画板）',
          command: 'insert.signature',
        },
      ],
      [
        {
          kind: 'icon-button',
          id: 'formula',
          tab: 'insert',
          group: '媒体',
          iconName: 'sigma',
          title: '插入公式 (KaTeX / LaTeX)',
          command: 'insert.formula',
        },
        {
          kind: 'grid-dropdown',
          id: 'table',
          tab: 'insert',
          group: '媒体',
          iconName: 'table',
          title: '插入表格',
          command: 'insert.table',
        },
        {
          kind: 'icon-button',
          id: 'iframe',
          tab: 'insert',
          group: '媒体',
          iconName: 'globe',
          title: '插入内嵌网页（iframe / URL）',
          command: 'insert.iframe',
        },
        {
          kind: 'icon-button',
          id: 'attachment',
          tab: 'insert',
          group: '媒体',
          iconName: 'paperclip',
          title: '插入附件（URL + 文件名）',
          command: 'insert.attachment',
        },
        {
          kind: 'icon-button',
          id: 'seal',
          tab: 'insert',
          group: '媒体',
          iconName: 'stamp',
          title: '插入印章（红色公章 + 文字）',
          command: 'insert.seal',
        },
        {
          kind: 'icon-button',
          id: 'textbox',
          tab: 'insert',
          group: '媒体',
          iconName: 'text-box',
          title: '插入文本框（可编辑浮动文本框）',
          command: 'insert.textbox',
        },
      ],
    ],
  },
  // —— 引用组：链接 / 目录 TOC / 分隔线 ——
  {
    tab: 'insert',
    group: '引用',
    name: '引用',
    rows: [
      [
        {
          kind: 'icon-button',
          id: 'link',
          tab: 'insert',
          group: '引用',
          iconName: 'link',
          title: '链接 ⌘K',
          command: 'link.toggle',
          active: (s) => !!s.marks.link,
        },
        {
          kind: 'icon-button',
          id: 'toc',
          tab: 'insert',
          group: '引用',
          iconName: 'list-tree',
          title: '插入目录（自动汇总标题）',
          command: 'insert.toc',
        },
      ],
      [
        {
          kind: 'icon-button',
          id: 'divider',
          tab: 'insert',
          group: '引用',
          iconName: 'sh-divider',
          title: '插入分隔线',
          command: 'insert.shape',
          arg: 'divider',
        },
      ],
    ],
  },
  // —— 模板组：模板下拉（含「设为模板…」）/ 导入 ——
  {
    tab: 'insert',
    group: '模板',
    name: '模板',
    rows: [
      [
        {
          kind: 'template-dropdown',
          id: 'template',
          tab: 'insert',
          group: '模板',
          triggerIcon: 'layout-template',
          title: '模板',
        },
      ],
      [
        {
          kind: 'text-button',
          id: 'import',
          tab: 'insert',
          group: '模板',
          iconName: 'file-input',
          text: '导入',
          title: '导入 Markdown / HTML（粘贴文本，替换当前文档）',
          command: 'doc.import',
        },
      ],
    ],
  },

  // ============ 视图页签 ============
  // —— 视图模式组：web 视图 / word 视图。active 态由 refresh 回填。——
  {
    tab: 'view',
    group: '视图模式',
    name: '视图模式',
    rows: [
      [
        {
          kind: 'text-button',
          id: 'view-web',
          tab: 'view',
          group: '视图模式',
          iconName: 'globe-2',
          text: 'web视图',
          title: 'web视图（连续滚动，不分页）',
          command: 'view.web',
          active: (s) => s.viewMode === 'web',
        },
      ],
      [
        {
          kind: 'text-button',
          id: 'view-word',
          tab: 'view',
          group: '视图模式',
          iconName: 'file-text',
          text: 'word视图',
          title: 'word视图（A4 分页 + 页缝）',
          command: 'view.word',
          active: (s) => s.viewMode === 'word',
        },
      ],
    ],
  },
  // —— 整形器组：动态文案随 shaperShort 切换 ——
  {
    tab: 'view',
    group: '整形器',
    name: '整形器',
    rows: [
      [
        {
          kind: 'text-button',
          id: 'shaper',
          tab: 'view',
          group: '整形器',
          title: '整形器 Canvas / HarfBuzz · F2（HarfBuzz：阿拉伯/希伯来等复杂连字整形）',
          command: 'shaper.toggle',
          dynamic: (s, icon) => ({ html: icon('languages') + `<span>${s.shaperShort}</span>` }),
        },
      ],
    ],
  },
  // —— 主题组：动态 icon+文案+active。refresh 先 dynamic 设 innerHTML 再 active 设 class。——
  {
    tab: 'view',
    group: '主题',
    name: '主题',
    rows: [
      [
        {
          kind: 'text-button',
          id: 'theme',
          tab: 'view',
          group: '主题',
          title: '切换暗色 / 亮色主题',
          command: 'theme.toggle',
          active: (s) => s.theme === 'dark',
          dynamic: (s, icon) => {
            const toDark = s.theme === 'light';
            return { html: icon(toDark ? 'moon' : 'sun') + `<span>${toDark ? '暗色' : '亮色'}</span>` };
          },
        },
      ],
    ],
  },

  // —— 打印组：打印 / 导出 PDF（隐藏 iframe + toHtml + 打印 CSS，系统对话框可存 PDF）——
  {
    tab: 'view',
    group: '打印',
    name: '打印',
    rows: [
      [
        {
          kind: 'text-button',
          id: 'print',
          tab: 'view',
          group: '打印',
          iconName: 'printer',
          text: '打印',
          title: '打印 / 导出 PDF ⌘P',
          command: 'doc.print',
        },
      ],
    ],
  },

  // ============ 常驻页签栏右端（不属任何 ribbon）============
  {
    tab: 'trailing',
    group: '导出',
    rows: [
      [
        {
          kind: 'text-button',
          id: 'export',
          tab: 'trailing',
          group: '导出',
          iconName: 'download',
          text: '导出',
          title: '导出 HTML / Markdown / JSON',
          className: BTN_TEXT + ' self-center',
          command: 'doc.export',
        },
      ],
    ],
  },
];
