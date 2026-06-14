import { commands, CommandContext, CommandArg } from '../commands';
import { RichDoc } from '../../model/rich-document';

// 共享 CommandContext 测试桩（CONVENTIONS §4「第 2 次复制即抽取」：此前 commands.test /
// nav-commands.test / print.test 各拷贝一份 dialogs 12 键 + view 9 键的 ~30 行 stub，
// CommandContext 加字段需同步改 3 处）。仅供 __tests__ 引用，不参与产物构建。

/** 视觉行边界注入形状（nav.lineStart/lineEnd、delete.toLineStart 消费）。 */
export interface CtxLineBounds { block: number; startOffset: number; endOffset: number }

/**
 * 构造最小 CommandContext：纯模型命令只用 ctx.rd；dialogs/view 均为可观察 no-op 记录器——
 * 调用名依序推入 calls 供断言（带参命令含参数指纹，如 `insertTable:3x4` / `setViewMode:word` /
 * `insertMedia:audio` / `applyTemplate:名` / `announce:消息`）；exec 内联递归派发；
 * caretLineBounds 经第二参注入（默认 null = 布局未就绪）。
 */
export function makeCtx(rd: RichDoc, lineBounds: CtxLineBounds | null = null): CommandContext & { calls: string[] } {
  const calls: string[] = [];
  const log = (id: string) => () => { calls.push(id); };
  const ctx: CommandContext & { calls: string[] } = {
    rd, calls,
    afterEdit: log('afterEdit'),
    announce: (m) => { calls.push('announce:' + m); },
    focusEditor: log('focusEditor'),
    exec: (id: string, arg?: CommandArg) => { commands[id](ctx, arg); },
    dialogs: {
      toggleLink: log('toggleLink'), insertImage: log('insertImage'),
      insertInlineImage: log('insertInlineImage'), insertFormula: log('insertFormula'),
      insertTable: (r, c) => { calls.push(`insertTable:${r}x${c}`); },
      insertMedia: (k) => { calls.push('insertMedia:' + k); },
      insertAttachment: log('insertAttachment'), insertSignature: log('insertSignature'),
      insertSeal: log('insertSeal'), insertTextbox: log('insertTextbox'),
      saveTemplate: log('saveTemplate'), importDoc: log('importDoc'),
    },
    view: {
      toggleShaper: log('toggleShaper'), toggleTheme: log('toggleTheme'),
      setViewMode: (m) => { calls.push('setViewMode:' + m); },
      exportDoc: log('exportDoc'),
      applyTemplate: (n) => { calls.push('applyTemplate:' + n); },
      templateNames: () => [],
      caretLineBounds: () => lineBounds,
      openFind: log('openFind'),
      printDoc: log('printDoc'),
    },
  };
  return ctx;
}
