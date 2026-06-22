/**
 * 编辑器选项归一化（纯函数，无 DOM）：把消费者传入的可选 {@link EditorOptions}
 * 折算为装配层实际使用的确定值——chrome 各开关的 `!== false` 默认开语义、
 * persistDraft/readOnly 默认、shaper 缺省。抽离自 create-editor 顶部内联逻辑，
 * 使「默认值/各开关分支」可在 node 环境纯单测（装配主体随后才触 DOM）。
 *
 * 分层：editor（编辑装配层；纯结构，不 import ui/text/render，不触 DOM）。
 */
import type { EditorOptions, ShaperKind } from './create-editor';

/**
 * 归一化后的确定选项：所有 chrome 开关与默认值已折算为布尔/具体值，装配层直接消费。
 * @public
 */
export interface NormalizedEditorOptions {
  /** 顶部工具栏是否建（chrome.toolbar !== false）。 */
  showToolbar: boolean;
  /** 左侧大纲面板是否建（chrome.outline !== false）。 */
  showOutline: boolean;
  /** 底部状态栏是否建（chrome.statusBar !== false）。 */
  showStatusBar: boolean;
  /** 右键菜单是否接线（chrome.contextMenu !== false）。 */
  enableContextMenu: boolean;
  /** 查找/替换浮条是否建（chrome.findBar !== false）。 */
  showFindBar: boolean;
  /** localStorage 草稿自动保存/恢复（persistDraft !== false）。 */
  persistDraft: boolean;
  /** 只读（readOnly === true）。 */
  readOnly: boolean;
  /** 默认整形器（options.shaper ?? 'canvas'）。 */
  defaultShaper: ShaperKind;
}

/**
 * 把 {@link EditorOptions} 折算为 {@link NormalizedEditorOptions}。
 * 不变量：chrome 各开关缺省/缺 chrome 对象时一律默认 true（复刻现 demo 整套外壳）；
 * persistDraft 默认 true、readOnly 默认 false、shaper 默认 'canvas'。
 * @public
 */
export function normalizeEditorOptions(options: EditorOptions = {}): NormalizedEditorOptions {
  const chrome = options.chrome ?? {};
  return {
    showToolbar: chrome.toolbar !== false,
    showOutline: chrome.outline !== false,
    showStatusBar: chrome.statusBar !== false,
    enableContextMenu: chrome.contextMenu !== false,
    showFindBar: chrome.findBar !== false,
    persistDraft: options.persistDraft !== false,
    readOnly: options.readOnly === true,
    defaultShaper: options.shaper ?? 'canvas',
  };
}
