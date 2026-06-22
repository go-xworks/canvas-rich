import { RichDoc } from '../model/rich-document';
import { BlockType, MarkType, ShapeKind } from '../model/schema';

// 命令注册表（统一命令总线）：键盘 keymap / 工具栏 item / 右键菜单三路都经命名命令派发，
// 不各自硬编码调用 RichDoc。命令是对 CommandContext 的纯变更/委托；afterEdit/聚焦由派发方统一收尾
// （自收尾命令例外，见 SELF_FINALIZING）。带 UI 的命令委托装配层 ctx.dialogs，纯视图命令委托 ctx.view。
// 分层：editor（命令派发层，连接 UI 与 model；不 import ui，装配面经 CommandContext 注入）。

/**
 * 命令参数：带值命令（字号/字体/颜色/对齐/块类型/行距/段距/字距/表格/形状/模板/媒体）的载荷联合。
 * 无参命令忽略第二参；null 表示「清除」（如清除字号 mark）。
 * @public
 */
export type CommandArg = string | number | null | { rows: number; cols: number };

/**
 * 命令执行上下文：文档模型 + 装配层弹层/视图服务的最小注入面，
 * 替代旧 ToolbarHandlers 胖接口（40 方法）。命令实现层与三路派发共用，装配层一次性构造并注入。
 * @public
 */
export interface CommandContext {
  /** 文档编辑模型（命令直接变更）。 */
  rd: RichDoc;
  /**
   * 统一收尾：goalX 复位 + 跟随光标 + 重排/广播（= 装配层 afterEdit）。
   * 命令变更后由派发方调用一次；命令体内部不调（自收尾命令除外，其 dialogs/view 实现已内含）。
   */
  afterEdit: () => void;
  /** 读屏播报。 */
  announce: (msg: string) => void;
  /** 把焦点交还编辑器（IME 代理）。 */
  focusEditor: () => void;
  /** 派发任意命令（含带参）。带参命令第二参透传。 */
  exec: (id: string, arg?: CommandArg) => void;
  /** 弹层/对话框（带异步 UI 的命令委托装配层；其实现自含 afterEdit/聚焦/播报）。 */
  dialogs: {
    toggleLink: () => void | Promise<void>;
    insertImage: () => void | Promise<void>;
    insertInlineImage: () => void | Promise<void>;
    insertFormula: () => void | Promise<void>;
    insertTable: (rows: number, cols: number) => void;
    insertMedia: (kind: 'audio' | 'video' | 'iframe') => void | Promise<void>;
    insertAttachment: () => void | Promise<void>;
    insertSignature: () => void | Promise<void>;
    insertSeal: () => void | Promise<void>;
    insertTextbox: () => void;
    saveTemplate: () => void | Promise<void>;
    importDoc: () => void | Promise<void>;
  };
  /** 视图服务（无 rd 变更，不入撤销栈，其实现自带收尾）。 */
  view: {
    toggleShaper: () => void;
    toggleTheme: () => void;
    setViewMode: (m: 'web' | 'word') => void;
    exportDoc: () => void;
    applyTemplate: (name: string) => void;
    /** 当前可选模板名列表（内置 + 用户），模板下拉打开时同步拉取。 */
    templateNames: () => string[];
    /**
     * 当前光标所在视觉行的块号与行首/行尾块内偏移（软换行下非块首尾）；
     * 布局未就绪时 null。行首尾导航/删至行首（nav.lineStart/End、delete.toLineStart）消费。
     */
    caretLineBounds: () => { block: number; startOffset: number; endOffset: number } | null;
    /** 打开查找/替换浮条（mod+f；自含聚焦，命中高亮/跳转由查找条维护）。 */
    openFind: () => void;
    /** 打印 / 导出 PDF（mod+p；隐藏 iframe + toHtml 全文 + 打印 CSS，系统对话框可存 PDF）。 */
    printDoc: () => void;
  };
}

/**
 * 一个命令：对上下文执行变更（纯模型变更或委托弹层/视图）。无参命令忽略第二参。
 * @public
 */
export type Command = (ctx: CommandContext, arg?: CommandArg) => void;

const mark =
  (t: MarkType): Command =>
  (ctx) =>
    ctx.rd.toggleMark(t);

/** 缩进增/减命令的步长（逻辑 px）。 @public */
export const INDENT_STEP = 24;

/**
 * 命名命令注册表：命令名 → 对上下文的变更，供键盘/工具栏/右键菜单统一派发。
 * @public
 */
export const commands: Record<string, Command> = {
  // —— 行内 mark ——
  'mark.bold': mark('bold'),
  'mark.italic': mark('italic'),
  'mark.underline': mark('underline'),
  'mark.strikethrough': mark('strikethrough'),
  'mark.highlight': mark('highlight'),
  'mark.code': mark('code'),
  'mark.superscript': (ctx) => ctx.rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']),
  'mark.subscript': (ctx) => ctx.rd.toggleExclusiveMark('subscript', ['superscript', 'subscript']),
  // —— 带值 mark（null → clearMark；语义复刻旧装配层守卫）——
  'fontSize.set': (ctx, arg) =>
    arg ? ctx.rd.setMark('fontSize', { size: arg as string }) : ctx.rd.clearMark('fontSize'),
  'fontFamily.set': (ctx, arg) =>
    arg && arg !== 'default'
      ? ctx.rd.setMark('fontFamily', { fontFamily: arg as string })
      : ctx.rd.clearMark('fontFamily'),
  'color.set': (ctx, arg) => (arg ? ctx.rd.setMark('color', { color: arg as string }) : ctx.rd.clearMark('color')),
  'highlight.set': (ctx, arg) =>
    arg ? ctx.rd.setMark('highlight', { color: arg as string }) : ctx.rd.clearMark('highlight'),
  'format.clear': (ctx) => ctx.rd.clearMarks(),
  // —— 块类型 ——
  'block.set': (ctx, arg) => {
    if (arg == null) return; // 下拉清除项守卫（复刻旧 onPick if(v)）
    const m = /^heading([1-6])$/.exec(arg as string);
    if (m) ctx.rd.setBlockType('heading', { level: Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6 });
    else ctx.rd.setBlockType(arg as BlockType);
  },
  'block.paragraph': (ctx) => ctx.rd.setBlockType('paragraph'),
  'block.h1': (ctx) => ctx.rd.setBlockType('heading', { level: 1 }),
  'block.h2': (ctx) => ctx.rd.setBlockType('heading', { level: 2 }),
  'block.h3': (ctx) => ctx.rd.setBlockType('heading', { level: 3 }),
  'block.h4': (ctx) => ctx.rd.setBlockType('heading', { level: 4 }),
  'block.h5': (ctx) => ctx.rd.setBlockType('heading', { level: 5 }),
  'block.h6': (ctx) => ctx.rd.setBlockType('heading', { level: 6 }),
  'block.bullet': (ctx) => ctx.rd.setBlockType('bullet_item'),
  'block.ordered': (ctx) => ctx.rd.setBlockType('ordered_item'),
  'block.task': (ctx) => ctx.rd.setBlockType('task_item'),
  'block.quote': (ctx) => ctx.rd.setBlockType('blockquote'),
  'block.code': (ctx) => ctx.rd.setBlockType('code_block'),
  // —— 对齐 / 方向 / 缩进 ——
  'align.left': (ctx) => ctx.rd.setAlign('left'),
  'align.center': (ctx) => ctx.rd.setAlign('center'),
  'align.right': (ctx) => ctx.rd.setAlign('right'),
  'align.justify': (ctx) => ctx.rd.setAlign('justify'),
  'align.distribute': (ctx) => ctx.rd.setAlign('distribute'),
  // dir.toggle 读 focusBlock()（夹住块索引，与旧装配层 toggleDir 一致，更稳）
  'dir.toggle': (ctx) => ctx.rd.setDir(ctx.rd.focusBlock().attrs.dir === 'rtl' ? 'ltr' : 'rtl'),
  'indent.inc': (ctx) => ctx.rd.adjustIndent(INDENT_STEP),
  'indent.dec': (ctx) => ctx.rd.adjustIndent(-INDENT_STEP),
  'list.indent': (ctx) => ctx.rd.indentList(),
  'list.outdent': (ctx) => ctx.rd.outdentList(),
  // —— 段落间距（带值；下拉/数字输入透传）——
  // 行距下拉透传字符串（如 '1.5'）：命令体 parseFloat（复刻旧 onPick if(v) setLineHeight(parseFloat(v))）。
  'lineHeight.set': (ctx, arg) => {
    if (arg == null) return;
    ctx.rd.setLineHeight(typeof arg === 'number' ? arg : parseFloat(arg as string));
  },
  'space.before.set': (ctx, arg) => ctx.rd.setSpaceBefore(arg as number),
  'space.after.set': (ctx, arg) => ctx.rd.setSpaceAfter(arg as number),
  'letterSpacing.set': (ctx, arg) => ctx.rd.setLetterSpacing(arg as number),
  // —— 历史 / 选择 ——
  'history.undo': (ctx) => ctx.rd.undo(),
  'history.redo': (ctx) => ctx.rd.redo(),
  'select.all': (ctx) => ctx.rd.selectAll(),
  // —— 修饰键导航（⌥ 词跳转 / ⌘ 行首尾）：arg==='extend'（⇧）时扩展选区；
  // 仅移动选区不改文档，派发方按 NAV_AFFINITY 以 afterNav 收尾（重绘不重排），不追加 afterEdit。——
  'nav.wordLeft': (ctx, arg) => ctx.rd.setSel(ctx.rd.posWordLeft(ctx.rd.focus), arg === 'extend'),
  'nav.wordRight': (ctx, arg) => ctx.rd.setSel(ctx.rd.posWordRight(ctx.rd.focus), arg === 'extend'),
  'nav.lineStart': (ctx, arg) => {
    const ln = ctx.view.caretLineBounds();
    if (ln) ctx.rd.setSel({ block: ln.block, offset: ln.startOffset }, arg === 'extend');
  },
  'nav.lineEnd': (ctx, arg) => {
    const ln = ctx.view.caretLineBounds();
    if (ln) ctx.rd.setSel({ block: ln.block, offset: ln.endOffset }, arg === 'extend');
  },
  // —— 修饰键删除（⌥⌫ 删词 / ⌥Del 前向删词 / ⌘⌫ 删至视觉行首）：普通模型命令，派发方追加 afterEdit ——
  'delete.wordBack': (ctx) => ctx.rd.deleteWordBack(),
  'delete.wordForward': (ctx) => ctx.rd.deleteWordForward(),
  'delete.toLineStart': (ctx) => {
    const ln = ctx.view.caretLineBounds();
    // 布局未就绪/行块与焦点块不符（理论不可达）时退回块首
    ctx.rd.deleteToLineStart(ln && ln.block === ctx.rd.focus.block ? ln.startOffset : 0);
  },
  // —— 查找/替换（只读视图命令，见 VIEW_ONLY）——
  'find.open': (ctx) => ctx.view.openFind(),
  // —— 打印 / 导出 PDF（只读视图命令，见 VIEW_ONLY：派发方不追加 afterEdit——
  // 否则 ⌘F/⌘P 无内容变更也 markDirty → 自动保存标脏重写草稿 + 整文档 relayout，
  // 且 followCaret=true 会把滚离光标的视口拽回光标行）——
  'doc.print': (ctx) => ctx.view.printDoc(),
  // —— 直接变更模型的插入命令（非自收尾：afterEdit 由派发方追加；命令体仅播报）——
  'insert.toc': (ctx) => {
    ctx.rd.insertToc();
    ctx.announce('已插入目录');
  },
  'insert.shape': (ctx, arg) => {
    ctx.rd.insertShape(arg as ShapeKind);
    ctx.announce('已插入形状');
  },
  // —— 弹层委托命令（自收尾：dialogs 实现内含 afterEdit/聚焦/播报）——
  'link.toggle': (ctx) => ctx.dialogs.toggleLink(),
  'insert.image': (ctx) => ctx.dialogs.insertImage(),
  'insert.inlineImage': (ctx) => ctx.dialogs.insertInlineImage(),
  'insert.formula': (ctx) => ctx.dialogs.insertFormula(),
  'insert.table': (ctx, arg) => {
    const { rows, cols } = arg as { rows: number; cols: number };
    ctx.dialogs.insertTable(rows, cols);
  },
  'insert.audio': (ctx) => ctx.dialogs.insertMedia('audio'),
  'insert.video': (ctx) => ctx.dialogs.insertMedia('video'),
  'insert.iframe': (ctx) => ctx.dialogs.insertMedia('iframe'),
  'insert.attachment': (ctx) => ctx.dialogs.insertAttachment(),
  'insert.signature': (ctx) => ctx.dialogs.insertSignature(),
  'insert.seal': (ctx) => ctx.dialogs.insertSeal(),
  'insert.textbox': (ctx) => ctx.dialogs.insertTextbox(),
  'template.save': (ctx) => ctx.dialogs.saveTemplate(),
  'doc.import': (ctx) => ctx.dialogs.importDoc(),
  // —— 视图委托命令（自收尾：view 实现内含 markDirty/聚焦/播报）——
  'template.apply': (ctx, arg) => ctx.view.applyTemplate(arg as string),
  'doc.export': (ctx) => ctx.view.exportDoc(),
  'view.web': (ctx) => ctx.view.setViewMode('web'),
  'view.word': (ctx) => ctx.view.setViewMode('word'),
  'shaper.toggle': (ctx) => ctx.view.toggleShaper(),
  'theme.toggle': (ctx) => ctx.view.toggleTheme(),
};

/**
 * 自收尾命令集合：其 dialogs/view 实现内部已调 afterEdit/markDirty/announce/focus，
 * 派发方对这些 id 只 exec 不再追加 afterEdit，否则双重收尾（双重排/双播报）。
 * 普通模型命令（含直接变更模型的 insert.toc / insert.shape）由派发方统一 `exec(id); afterEdit()`。
 * 注意：insert.toc / insert.shape 直接改 rd 且命令体不调 afterEdit，故**不**入此集合——
 * 其重排须由派发方追加 afterEdit（命令体仅 announce）；只有委托 dialogs/view 的命令才自收尾。
 * @public
 */
export const SELF_FINALIZING: ReadonlySet<string> = new Set([
  'link.toggle',
  'insert.image',
  'insert.inlineImage',
  'insert.formula',
  'insert.table',
  'insert.audio',
  'insert.video',
  'insert.iframe',
  'insert.attachment',
  'insert.signature',
  'insert.seal',
  'insert.textbox',
  'template.apply',
  'template.save',
  'doc.import',
  'doc.export',
  'view.web',
  'view.word',
  'shaper.toggle',
  'theme.toggle',
]);

/**
 * 只读视图命令集合（第三类收尾）：不改文档、不动选区焦点语义，实现内已自带所需刷新
 * （find.open 的命中跳转走注入的 afterNav；doc.print 纯只读 iframe）。派发方对这些 id
 * 不追加 afterEdit 也不 afterNav——追加 afterEdit 会产生可观察副作用：markDirty →
 * autosaver 标脏闪「未保存」并重写 localStorage 草稿、多余整文档 relayout、
 * followCaret=true 令 ⌘P 后视口跳回光标行。与 SELF_FINALIZING 的区别：后者实现内
 * 显式调 afterEdit/markDirty 收尾，本集合则「无需任何收尾」。
 * @public
 */
export const VIEW_ONLY: ReadonlySet<string> = new Set(['find.open', 'doc.print']);

/**
 * 只读安全命令集合（readOnly 下命令总线放行）：不改文档、纯只读/选择/导出。
 * = VIEW_ONLY（find.open/doc.print）∪ {select.all, doc.export}。
 * 词/行导航（{@link NAV_AFFINITY} 的 nav.*）同样只移动选区不改文档，由装配层守卫单独按
 * `id in NAV_AFFINITY` 放行（不并入本集合，避免与 affinity 收尾职责耦合）。
 * 其余命令（mark/block/align/indent/history/insert/delete/template/view 切换…）均视为变更，
 * readOnly 下一律拦截。注意 view.web/word、theme.toggle、shaper.toggle 虽不改文档，
 * 但属「编辑器视图操作」，readOnly（只读呈现）下按现 demo 选项语义不主动暴露，故归入被拦截集。
 * @public
 */
export const READONLY_SAFE: ReadonlySet<string> = new Set(['find.open', 'doc.print', 'select.all', 'doc.export']);

/**
 * 导航命令 → 光标 affinity 的收尾映射。命中本表的命令仅移动选区（不改文档），
 * 派发方以 afterNav(affinity)（光标跟随 + 重绘，不重排）收尾、不追加 afterEdit。
 * affinity 消歧软换行边界：词左/行首落点贴目标行行首（after），词右/行尾贴所在行行尾（before）。
 * @public
 */
export const NAV_AFFINITY: Readonly<Record<string, 'before' | 'after'>> = {
  'nav.wordLeft': 'after',
  'nav.wordRight': 'before',
  'nav.lineStart': 'after',
  'nav.lineEnd': 'before',
};

/**
 * 快捷键组合串 → 命令名映射（mod = ⌘/Ctrl；修饰顺序固定 mod+alt+shift+key）。
 * @public
 */
// 快捷键 → 命令名（mod = ⌘/Ctrl；修饰顺序固定 mod+alt+shift+key）
export const keymap: Record<string, string> = {
  'mod+b': 'mark.bold',
  'mod+i': 'mark.italic',
  'mod+u': 'mark.underline',
  'mod+e': 'align.center',
  'mod+shift+l': 'align.left',
  'mod+shift+r': 'align.right',
  'mod+shift+d': 'dir.toggle',
  'mod+z': 'history.undo',
  'mod+shift+z': 'history.redo',
  'mod+y': 'history.redo',
  'mod+a': 'select.all',
  'mod+alt+1': 'block.h1',
  'mod+alt+2': 'block.h2',
  'mod+alt+3': 'block.h3',
  'mod+alt+4': 'block.h4',
  'mod+alt+5': 'block.h5',
  'mod+alt+6': 'block.h6',
  'mod+alt+0': 'block.paragraph',
  'mod+alt+8': 'block.bullet',
  'mod+alt+9': 'block.ordered',
  'mod+alt+t': 'block.task',
  'mod+alt+q': 'block.quote',
  // —— 修饰键导航/删除（keydown 对 ←/→/⌫/Del 的修饰组合先查本表，未注册组合落回无修饰 switch，
  // 见 main.ts）。⇧ 扩展选区经 arg='extend' 传入，同一命令注册 ±shift 两个组合。——
  'alt+arrowleft': 'nav.wordLeft',
  'alt+shift+arrowleft': 'nav.wordLeft',
  'alt+arrowright': 'nav.wordRight',
  'alt+shift+arrowright': 'nav.wordRight',
  'mod+arrowleft': 'nav.lineStart',
  'mod+shift+arrowleft': 'nav.lineStart',
  'mod+arrowright': 'nav.lineEnd',
  'mod+shift+arrowright': 'nav.lineEnd',
  'alt+backspace': 'delete.wordBack',
  'alt+delete': 'delete.wordForward',
  'mod+backspace': 'delete.toLineStart',
  // —— 查找/替换 ——
  'mod+f': 'find.open',
  // —— 打印 / 导出 PDF（preventDefault 接管浏览器默认打印——canvas 正文不在 DOM，原生打印只得空白）——
  'mod+p': 'doc.print',
};

/**
 * 由键盘事件算出规范化组合键串，用于在 {@link keymap} 中查表。
 * 不变量：修饰顺序固定 mod+alt+shift+key，key 统一小写。
 * @public
 */
// 由键盘事件算出组合键串
export function keyCombo(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
}): string {
  return (
    (e.metaKey || e.ctrlKey ? 'mod+' : '') +
    (e.altKey ? 'alt+' : '') +
    (e.shiftKey ? 'shift+' : '') +
    e.key.toLowerCase()
  );
}
