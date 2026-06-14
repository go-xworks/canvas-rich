import { describe, it, expect } from 'vitest';
import { keyCombo, keymap, commands, SELF_FINALIZING, VIEW_ONLY, READONLY_SAFE, NAV_AFFINITY, INDENT_STEP } from '../commands';
import { RichDoc } from '../../model/rich-document';
import { Doc, para, text } from '../../model/schema';
import { makeCtx } from './make-ctx';

// 命令派发层纯逻辑单测：keyCombo 组合键规范化（修饰顺序/mod 等价/小写不变量）、
// keymap↔commands 接线完整性、代表性命令对模型的实际作用、自收尾集合一致性。
// CommandContext 测试桩共享自 ./make-ctx（三份拷贝抽取，CONVENTIONS §4）。

// 构造一个最小键盘事件（仅 keyCombo 需要的字段）。
const ev = (
  key: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
): { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string } => ({
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  key,
});

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('keyCombo', () => {
  it('无修饰键：仅小写后的 key', () => {
    expect(keyCombo(ev('a'))).toBe('a');
    expect(keyCombo(ev('Enter'))).toBe('enter');
  });

  it('metaKey 与 ctrlKey 都映射为 mod 前缀（跨平台等价）', () => {
    expect(keyCombo(ev('b', { meta: true }))).toBe('mod+b');
    expect(keyCombo(ev('b', { ctrl: true }))).toBe('mod+b');
    // 两者同按也只产生一个 mod
    expect(keyCombo(ev('b', { meta: true, ctrl: true }))).toBe('mod+b');
  });

  it('修饰顺序固定为 mod+alt+shift+key', () => {
    expect(keyCombo(ev('1', { meta: true, alt: true }))).toBe('mod+alt+1');
    expect(keyCombo(ev('z', { meta: true, shift: true }))).toBe('mod+shift+z');
    // 全修饰：顺序稳定，与传入位无关
    expect(keyCombo(ev('K', { shift: true, alt: true, ctrl: true }))).toBe('mod+alt+shift+k');
  });

  it('key 统一小写（大写字母 / shift 组合命中 keymap）', () => {
    expect(keyCombo(ev('L', { meta: true, shift: true }))).toBe('mod+shift+l');
    expect(keymap[keyCombo(ev('L', { meta: true, shift: true }))]).toBe('align.left');
  });

  it('单独修饰键本身（如仅 Shift）：mod 取决于 meta/ctrl，不因 shift 凭空生成 mod', () => {
    expect(keyCombo(ev('A', { shift: true }))).toBe('shift+a');
  });
});

describe('keymap ↔ commands 接线完整性', () => {
  it('keymap 每个目标命令名都在 commands 注册表中存在', () => {
    for (const [combo, name] of Object.entries(keymap)) {
      expect(commands[name], `keymap["${combo}"] → "${name}" 未注册`).toBeTypeOf('function');
    }
  });

  it('典型快捷键解析到预期命令', () => {
    expect(keymap[keyCombo(ev('b', { meta: true }))]).toBe('mark.bold');
    expect(keymap[keyCombo(ev('z', { ctrl: true }))]).toBe('history.undo');
    expect(keymap[keyCombo(ev('z', { ctrl: true, shift: true }))]).toBe('history.redo');
    expect(keymap[keyCombo(ev('0', { meta: true, alt: true }))]).toBe('block.paragraph');
  });
});

describe('代表性命令对模型的实际作用', () => {
  it('mark.bold 切换选区加粗', () => {
    const rd = new RichDoc(doc(para([text('hi')])));
    rd.selectAll();
    commands['mark.bold'](makeCtx(rd));
    expect(rd.markActive('bold')).toBe(true);
  });

  it('block.h2 把焦点块设为二级标题', () => {
    const rd = new RichDoc(doc(para([text('t')])));
    rd.setSel({ block: 0, offset: 0 });
    commands['block.h2'](makeCtx(rd));
    expect(rd.doc.blocks[0].type).toBe('heading');
    expect(rd.doc.blocks[0].attrs.level).toBe(2);
  });

  it('indent.inc / indent.dec 以 INDENT_STEP 为步长增减缩进', () => {
    const rd = new RichDoc(doc(para([text('t')])));
    const ctx = makeCtx(rd);
    rd.setSel({ block: 0, offset: 0 });
    commands['indent.inc'](ctx);
    expect(rd.doc.blocks[0].attrs.indent).toBe(INDENT_STEP);
    commands['indent.dec'](ctx);
    expect(rd.doc.blocks[0].attrs.indent).toBe(0);
  });

  it('dir.toggle 在 ltr/rtl 间切换焦点块方向', () => {
    const rd = new RichDoc(doc(para([text('t')])));
    const ctx = makeCtx(rd);
    rd.setSel({ block: 0, offset: 0 });
    commands['dir.toggle'](ctx);
    expect(rd.doc.blocks[0].attrs.dir).toBe('rtl');
    commands['dir.toggle'](ctx);
    expect(rd.doc.blocks[0].attrs.dir).toBe('ltr');
  });
});

describe('带值命令读 arg 的行为（含 null 清除/守卫语义）', () => {
  const setup = () => {
    const rd = new RichDoc(doc(para([text('hi')])));
    rd.selectAll();
    return { rd, ctx: makeCtx(rd) };
  };

  it('fontSize.set 设值/清除', () => {
    const { rd, ctx } = setup();
    commands['fontSize.set'](ctx, '24');
    expect(rd.markActive('fontSize')).toBe(true);
    commands['fontSize.set'](ctx, null);
    expect(rd.markActive('fontSize')).toBe(false);
  });

  it('fontFamily.set 的 "default" 等同清除', () => {
    const { rd, ctx } = setup();
    commands['fontFamily.set'](ctx, 'serif');
    expect(rd.markActive('fontFamily')).toBe(true);
    commands['fontFamily.set'](ctx, 'default');
    expect(rd.markActive('fontFamily')).toBe(false);
  });

  it('color.set / highlight.set 设值与 null 清除', () => {
    const { rd, ctx } = setup();
    commands['color.set'](ctx, '#2563eb');
    expect(rd.markActive('color')).toBe(true);
    commands['color.set'](ctx, null);
    expect(rd.markActive('color')).toBe(false);
    commands['highlight.set'](ctx, '#ff0');
    expect(rd.markActive('highlight')).toBe(true);
    commands['highlight.set'](ctx, null);
    expect(rd.markActive('highlight')).toBe(false);
  });

  it('block.set 解析 heading1..6，且 null 守卫不改块类型', () => {
    const rd = new RichDoc(doc(para([text('t')])));
    const ctx = makeCtx(rd);
    rd.setSel({ block: 0, offset: 0 });
    commands['block.set'](ctx, 'heading3');
    expect(rd.doc.blocks[0].type).toBe('heading');
    expect(rd.doc.blocks[0].attrs.level).toBe(3);
    commands['block.set'](ctx, null); // 守卫：不变更
    expect(rd.doc.blocks[0].type).toBe('heading');
    commands['block.set'](ctx, 'blockquote');
    expect(rd.doc.blocks[0].type).toBe('blockquote');
  });

  it('lineHeight.set 设倍数，null 守卫', () => {
    const rd = new RichDoc(doc(para([text('t')])));
    const ctx = makeCtx(rd);
    rd.setSel({ block: 0, offset: 0 });
    commands['lineHeight.set'](ctx, 1.5);
    expect(rd.doc.blocks[0].attrs.lineHeight).toBe(1.5);
    commands['lineHeight.set'](ctx, null); // 守卫：不变更
    expect(rd.doc.blocks[0].attrs.lineHeight).toBe(1.5);
  });
});

describe('委托命令落到 dialogs / view（不直接改模型）', () => {
  it('link.toggle / insert.* 委托到 dialogs', () => {
    const ctx = makeCtx(new RichDoc(doc(para([text('t')]))));
    commands['link.toggle'](ctx);
    commands['insert.image'](ctx);
    commands['insert.table'](ctx, { rows: 3, cols: 4 });
    commands['insert.audio'](ctx);
    expect(ctx.calls).toContain('toggleLink');
    expect(ctx.calls).toContain('insertImage');
    expect(ctx.calls).toContain('insertTable:3x4');
    expect(ctx.calls).toContain('insertMedia:audio');
  });

  it('view.* / template.apply / doc.export 委托到 view', () => {
    const ctx = makeCtx(new RichDoc(doc(para([text('t')]))));
    commands['view.word'](ctx);
    commands['theme.toggle'](ctx);
    commands['template.apply'](ctx, '空白');
    commands['doc.export'](ctx);
    expect(ctx.calls).toContain('setViewMode:word');
    expect(ctx.calls).toContain('toggleTheme');
    expect(ctx.calls).toContain('applyTemplate:空白');
    expect(ctx.calls).toContain('exportDoc');
  });
});

describe('SELF_FINALIZING 集合一致性', () => {
  it('集合中每个 id 都是已注册命令', () => {
    for (const id of SELF_FINALIZING) {
      expect(commands[id], `SELF_FINALIZING "${id}" 未注册`).toBeTypeOf('function');
    }
  });

  it('keymap 目标命令均非自收尾（键盘命令由派发方统一 afterEdit）', () => {
    for (const name of Object.values(keymap)) {
      expect(SELF_FINALIZING.has(name), `keymap 目标 "${name}" 不应在 SELF_FINALIZING`).toBe(false);
    }
  });
});

describe('VIEW_ONLY 集合一致性（只读视图命令：派发方不追加任何收尾）', () => {
  it('集合中每个 id 都是已注册命令', () => {
    for (const id of VIEW_ONLY) {
      expect(commands[id], `VIEW_ONLY "${id}" 未注册`).toBeTypeOf('function');
    }
  });

  it('与 SELF_FINALIZING 互斥（语义不同：自收尾在实现内、只读无需收尾）', () => {
    for (const id of VIEW_ONLY) {
      expect(SELF_FINALIZING.has(id), `"${id}" 不应同时在 SELF_FINALIZING`).toBe(false);
    }
  });

  it('find.open / doc.print 在集合中（⌘F/⌘P 不得 markDirty 标脏自动保存）', () => {
    expect(VIEW_ONLY.has('find.open')).toBe(true);
    expect(VIEW_ONLY.has('doc.print')).toBe(true);
  });

  it('只读命令仅委托 view，不触碰模型/不调 afterEdit', () => {
    const ctx = makeCtx(new RichDoc(doc(para([text('t')]))));
    commands['find.open'](ctx);
    commands['doc.print'](ctx);
    expect(ctx.calls).toEqual(['openFind', 'printDoc']);
  });
});

describe('READONLY_SAFE — 只读命令总线放行集合（dispatch 守卫据此放行）', () => {
  it('恰含 VIEW_ONLY ∪ {select.all, doc.export}', () => {
    expect([...READONLY_SAFE].sort()).toEqual(['doc.export', 'doc.print', 'find.open', 'select.all']);
  });

  it('包含全部 VIEW_ONLY 命令（查找/打印）', () => {
    for (const id of VIEW_ONLY) expect(READONLY_SAFE.has(id)).toBe(true);
  });

  it('不含任何变更命令（mark/block/align/history/insert/delete/template）', () => {
    const mutating = [
      'mark.bold', 'mark.italic', 'mark.underline', 'block.h1', 'block.bullet',
      'align.center', 'history.undo', 'history.redo', 'indent.inc', 'list.indent',
      'insert.image', 'insert.table', 'insert.toc', 'delete.wordBack', 'delete.toLineStart',
      'template.apply', 'link.toggle', 'format.clear', 'view.word', 'theme.toggle',
    ];
    for (const id of mutating) expect(READONLY_SAFE.has(id)).toBe(false);
  });

  it('NAV_AFFINITY（词/行导航）不并入 READONLY_SAFE（守卫另按 id in NAV_AFFINITY 放行）', () => {
    for (const id of Object.keys(NAV_AFFINITY)) expect(READONLY_SAFE.has(id)).toBe(false);
  });

  it('readOnly 放行判定 = READONLY_SAFE.has(id) || (id in NAV_AFFINITY)；覆盖只读应放行的全部命令', () => {
    const allowed = (id: string) => READONLY_SAFE.has(id) || (id in NAV_AFFINITY);
    // 只读下应放行：查找/打印/全选/导出 + 词左右/行首尾导航
    for (const id of ['find.open', 'doc.print', 'select.all', 'doc.export',
      'nav.wordLeft', 'nav.wordRight', 'nav.lineStart', 'nav.lineEnd']) {
      expect(allowed(id)).toBe(true);
    }
    // 只读下应拦截：代表性变更命令
    for (const id of ['mark.bold', 'history.undo', 'block.h1', 'delete.wordBack', 'insert.image']) {
      expect(allowed(id)).toBe(false);
    }
  });
});
