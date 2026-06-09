import { RichDoc } from '../model/rich-document';
import { MarkType } from '../model/schema';

// 命令注册表（解耦：键盘/工具栏/右键菜单都经命名命令派发，不各自硬编码调用 RichDoc）。
// 命令是纯模型变更 (rd) => void；装配层负责 afterEdit/聚焦。参数化命令（颜色/链接/插入）留在装配层（含弹窗）。
// 分层：editor（命令派发层，连接 UI 与 model）。

/**
 * 一个无参命令：对给定文档执行纯模型变更，不负责聚焦或重排。
 * @public
 */
export type Command = (rd: RichDoc) => void;

const mark = (t: MarkType): Command => (rd) => rd.toggleMark(t);

/**
 * 命名命令注册表：命令名 → 纯模型变更，供键盘/工具栏/右键菜单统一派发。
 * @public
 */
export const commands: Record<string, Command> = {
  'mark.bold': mark('bold'),
  'mark.italic': mark('italic'),
  'mark.underline': mark('underline'),
  'mark.strikethrough': mark('strikethrough'),
  'mark.highlight': mark('highlight'),
  'mark.code': mark('code'),
  'mark.superscript': (rd) => rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']),
  'mark.subscript': (rd) => rd.toggleExclusiveMark('subscript', ['superscript', 'subscript']),
  'block.paragraph': (rd) => rd.setBlockType('paragraph'),
  'block.h1': (rd) => rd.setBlockType('heading', { level: 1 }),
  'block.h2': (rd) => rd.setBlockType('heading', { level: 2 }),
  'block.h3': (rd) => rd.setBlockType('heading', { level: 3 }),
  'block.h4': (rd) => rd.setBlockType('heading', { level: 4 }),
  'block.h5': (rd) => rd.setBlockType('heading', { level: 5 }),
  'block.h6': (rd) => rd.setBlockType('heading', { level: 6 }),
  'block.bullet': (rd) => rd.setBlockType('bullet_item'),
  'block.ordered': (rd) => rd.setBlockType('ordered_item'),
  'block.task': (rd) => rd.setBlockType('task_item'),
  'block.quote': (rd) => rd.setBlockType('blockquote'),
  'block.code': (rd) => rd.setBlockType('code_block'),
  'align.left': (rd) => rd.setAlign('left'),
  'align.center': (rd) => rd.setAlign('center'),
  'align.right': (rd) => rd.setAlign('right'),
  'dir.toggle': (rd) => rd.setDir(rd.doc.blocks[rd.focus.block].attrs.dir === 'rtl' ? 'ltr' : 'rtl'),
  'history.undo': (rd) => rd.undo(),
  'history.redo': (rd) => rd.redo(),
  'select.all': (rd) => rd.selectAll(),
};

/**
 * 快捷键组合串 → 命令名映射（mod = ⌘/Ctrl；修饰顺序固定 mod+alt+shift+key）。
 * @public
 */
// 快捷键 → 命令名（mod = ⌘/Ctrl；修饰顺序固定 mod+alt+shift+key）
export const keymap: Record<string, string> = {
  'mod+b': 'mark.bold', 'mod+i': 'mark.italic', 'mod+u': 'mark.underline',
  'mod+e': 'align.center', 'mod+shift+l': 'align.left', 'mod+shift+r': 'align.right',
  'mod+shift+d': 'dir.toggle',
  'mod+z': 'history.undo', 'mod+shift+z': 'history.redo', 'mod+y': 'history.redo',
  'mod+a': 'select.all',
  'mod+alt+1': 'block.h1', 'mod+alt+2': 'block.h2', 'mod+alt+3': 'block.h3',
  'mod+alt+4': 'block.h4', 'mod+alt+5': 'block.h5', 'mod+alt+6': 'block.h6',
  'mod+alt+0': 'block.paragraph',
  'mod+alt+8': 'block.bullet', 'mod+alt+9': 'block.ordered', 'mod+alt+t': 'block.task',
  'mod+alt+q': 'block.quote',
};

/**
 * 由键盘事件算出规范化组合键串，用于在 {@link keymap} 中查表。
 * 不变量：修饰顺序固定 mod+alt+shift+key，key 统一小写。
 * @public
 */
// 由键盘事件算出组合键串
export function keyCombo(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string }): string {
  return (e.metaKey || e.ctrlKey ? 'mod+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase();
}
