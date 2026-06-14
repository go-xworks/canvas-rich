// 工具栏（ui 层）barrel：JitWord 风格分页签 Ribbon 的对外契约稳定入口。
// 单体工厂已重构为「声明式贡献注册表」架构（tokens / tooltips / types / renderers / toolbar-items /
// create-toolbar）；本文件退化为纯 barrel，re-export 调用方与测试依赖的符号，保证 main.ts 与
// toolbar.test.ts 一行不改（二者均 import 自 '../toolbar'）。新增功能改 ./toolbar/toolbar-items.ts。
// 抽象①：旧 ToolbarHandlers 胖接口已删除，装配层改注入 ToolbarDeps（exec/focusEditor/templateNames）。
export { createToolbar } from './toolbar/create-toolbar';
export type { ToolbarDeps } from './toolbar/create-toolbar';
export type { Toolbar, ToolbarState } from './toolbar/types';
export { tipParse, tipDescKey, TIP_DESC } from './toolbar/tooltips';
export { NUM_INPUT_DEFS } from './toolbar/toolbar-items';
