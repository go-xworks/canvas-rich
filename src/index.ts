/**
 * 公共入口（库 barrel）：对标 ProseMirror / CodeMirror6 / Lexical / TipTap——
 * 核心库给一个容器、自建 DOM 外壳、暴露 `createEditor()` 工厂 + 实例句柄。
 *
 * @remarks
 * 只导出稳定公共面（@public）：`createEditor` + 实例/选项类型 + 文档模型读写类型与构造器 +
 * 命令参数类型 + 事件类型 + 主题名 + 纯导入导出函数。
 * 保持 @internal 不导出：UI 工厂（toolbar/overlays/dialogs/…）、RichDoc、渲染/布局内核
 * （StyleResolver/GlyphAtlas/createRenderer/layoutDoc/Shaper）、palette.C（可变全局）、mustEl、main 入口。
 * 理由：发布面越小越稳——首版只承诺 createEditor + 模型读写 + 事件 + 纯函数，内核留改空间不破 SemVer。
 */

// —— 工厂 + 实例/选项类型 ——
export { createEditor } from './editor/create-editor';
export type { EditorOptions, EditorInstance, ViewMode, ShaperKind } from './editor/create-editor';

// —— 文档模型类型（消费者读 getDoc 结果 / 构造 initialDoc 用）——
export type {
  Doc, Block, Inline, Mark, BlockType, MarkType, BlockAttrs, BlockAlign,
  TableCell, CellMerge, InlineAtom, InlineAtomKind, InlineAtomAttrs, TextRun, ShapeKind,
} from './model/schema';
export type { Style } from './types';

// —— 文档构造器（消费者构造 initialDoc 用）——
export { block, para, text, inlineAtom, cell, cellsFromStrings } from './model/schema';

// —— 演示文档（examples 与库消费者都可能想要内置样张）——
export { createDemoDoc } from './model/demo-doc';

// —— 命令面类型（命令 id 是字符串字面量，文档化/README 列举，不导出枚举对象以免锁死内部命令表）——
export type { CommandArg } from './editor/commands';

// —— 事件类型 ——
export type { EditorEvent, Unsub, Emitter } from './editor/events';

// —— 主题名 ——
export type { ThemeName } from './model/palette';

// —— 导入导出便利函数（纯函数 @public；消费者可在实例外用）——
export { toHtml, toMarkdown, toJson } from './model/export';
export { parseHtml, parseMarkdown } from './editor/import';
