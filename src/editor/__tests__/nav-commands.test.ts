import { describe, it, expect } from 'vitest';
import { commands, keymap, keyCombo, NAV_AFFINITY, SELF_FINALIZING } from '../commands';
import { RichDoc } from '../../model/rich-document';
import { Doc, Block, para, block, text, blockText } from '../../model/schema';
import { makeCtx } from './make-ctx';

// 修饰键导航/删除命令（批 D 缺陷①修复）：⌥←/→ 词跳转、⌘←/→ 行首尾、⌥⌫/⌥Del 删词、⌘⌫ 删至行首。
// 覆盖：keymap 注册完备性、NAV_AFFINITY 一致性、命令对模型/视图注入面的实际作用、
// RichDoc 词级 API 的跨块语义与原子块守卫。
// CommandContext 测试桩共享自 ./make-ctx（caretLineBounds 经第二参注入）。

const doc = (...blocks: Block[]): Doc => ({ blocks });

describe('keymap 注册完备性（修饰键导航/删除/查找）', () => {
  it.each([
    ['alt+arrowleft', 'nav.wordLeft'], ['alt+shift+arrowleft', 'nav.wordLeft'],
    ['alt+arrowright', 'nav.wordRight'], ['alt+shift+arrowright', 'nav.wordRight'],
    ['mod+arrowleft', 'nav.lineStart'], ['mod+shift+arrowleft', 'nav.lineStart'],
    ['mod+arrowright', 'nav.lineEnd'], ['mod+shift+arrowright', 'nav.lineEnd'],
    ['alt+backspace', 'delete.wordBack'], ['alt+delete', 'delete.wordForward'],
    ['mod+backspace', 'delete.toLineStart'],
    ['mod+f', 'find.open'],
  ])('keymap["%s"] → %s 且已注册', (combo, name) => {
    expect(keymap[combo]).toBe(name);
    expect(commands[name]).toBeTypeOf('function');
  });

  it('keyCombo 解析真实按键事件到组合串（⌥←/⌘⌫）', () => {
    expect(keyCombo({ metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, key: 'ArrowLeft' })).toBe('alt+arrowleft');
    expect(keyCombo({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'Backspace' })).toBe('mod+backspace');
    expect(keyCombo({ metaKey: false, ctrlKey: false, altKey: true, shiftKey: true, key: 'ArrowRight' })).toBe('alt+shift+arrowright');
  });
});

describe('NAV_AFFINITY 一致性', () => {
  it('每个导航命令：已注册、在 keymap 中可达、非自收尾、affinity 合法', () => {
    for (const [id, aff] of Object.entries(NAV_AFFINITY)) {
      expect(commands[id], `${id} 未注册`).toBeTypeOf('function');
      expect(Object.values(keymap)).toContain(id);
      expect(SELF_FINALIZING.has(id), `${id} 不应自收尾（派发方 afterNav 收尾）`).toBe(false);
      expect(['before', 'after']).toContain(aff);
    }
  });

  it('删除类命令不在 NAV_AFFINITY（派发方追加 afterEdit）', () => {
    for (const id of ['delete.wordBack', 'delete.wordForward', 'delete.toLineStart']) {
      expect(NAV_AFFINITY[id]).toBeUndefined();
    }
  });
});

describe('导航命令对模型的实际作用', () => {
  it('nav.wordLeft / nav.wordRight 按词移动；arg="extend" 扩展选区', () => {
    const rd = new RichDoc(doc(para([text('foo bar')])));
    rd.setSel({ block: 0, offset: 7 });
    const ctx = makeCtx(rd);
    commands['nav.wordLeft'](ctx);
    expect(rd.focus).toEqual({ block: 0, offset: 4 });
    expect(rd.isCollapsed).toBe(true);
    commands['nav.wordLeft'](ctx, 'extend');
    expect(rd.focus).toEqual({ block: 0, offset: 0 });
    expect(rd.anchor).toEqual({ block: 0, offset: 4 }); // 扩展保留 anchor
    rd.setSel({ block: 0, offset: 0 });
    commands['nav.wordRight'](ctx);
    expect(rd.focus).toEqual({ block: 0, offset: 3 });
  });

  it('nav.lineStart / nav.lineEnd 用视觉行边界（软换行下非块首尾）', () => {
    const rd = new RichDoc(doc(para([text('0123456789')])));
    rd.setSel({ block: 0, offset: 7 });
    const ctx = makeCtx(rd, { block: 0, startOffset: 5, endOffset: 9 });
    commands['nav.lineStart'](ctx);
    expect(rd.focus).toEqual({ block: 0, offset: 5 });
    rd.setSel({ block: 0, offset: 7 });
    commands['nav.lineEnd'](ctx, 'extend');
    expect(rd.focus).toEqual({ block: 0, offset: 9 });
    expect(rd.anchor).toEqual({ block: 0, offset: 7 });
  });

  it('布局未就绪（caretLineBounds=null）：行首尾导航无操作不抛错', () => {
    const rd = new RichDoc(doc(para([text('abc')])));
    rd.setSel({ block: 0, offset: 1 });
    const ctx = makeCtx(rd, null);
    commands['nav.lineStart'](ctx);
    commands['nav.lineEnd'](ctx);
    expect(rd.focus).toEqual({ block: 0, offset: 1 });
  });
});

describe('删除命令对模型的实际作用', () => {
  it('delete.wordBack 删光标前一个词', () => {
    const rd = new RichDoc(doc(para([text('foo bar')])));
    rd.setSel({ block: 0, offset: 7 });
    commands['delete.wordBack'](makeCtx(rd));
    expect(blockText(rd.doc.blocks[0])).toBe('foo ');
    expect(rd.focus).toEqual({ block: 0, offset: 4 });
  });

  it('delete.wordForward 删光标后一个词', () => {
    const rd = new RichDoc(doc(para([text('foo bar')])));
    rd.setSel({ block: 0, offset: 0 });
    commands['delete.wordForward'](makeCtx(rd));
    expect(blockText(rd.doc.blocks[0])).toBe(' bar');
  });

  it('delete.toLineStart 删到视觉行首（软换行偏移）', () => {
    const rd = new RichDoc(doc(para([text('0123456789')])));
    rd.setSel({ block: 0, offset: 7 });
    commands['delete.toLineStart'](makeCtx(rd, { block: 0, startOffset: 4, endOffset: 9 }));
    expect(blockText(rd.doc.blocks[0])).toBe('0123789'); // 删 [4,7)，行首前内容保留
    expect(rd.focus).toEqual({ block: 0, offset: 4 });
  });

  it('find.open 委托到 view.openFind', () => {
    const ctx = makeCtx(new RichDoc(doc(para([text('t')]))));
    commands['find.open'](ctx);
    expect(ctx.calls).toContain('openFind');
  });
});

describe('RichDoc 词级 API（跨块/原子块守卫/撤销粒度）', () => {
  it('posWordLeft/Right 跨块衔接', () => {
    const rd = new RichDoc(doc(para([text('foo')]), para([text('bar')])));
    expect(rd.posWordLeft({ block: 1, offset: 0 })).toEqual({ block: 0, offset: 3 });
    expect(rd.posWordRight({ block: 0, offset: 3 })).toEqual({ block: 1, offset: 0 });
  });

  it('deleteWordBack 块首退回 backspace 语义（与上块合并）', () => {
    const rd = new RichDoc(doc(para([text('foo')]), para([text('bar')])));
    rd.setSel({ block: 1, offset: 0 });
    rd.deleteWordBack();
    expect(rd.doc.blocks.length).toBe(1);
    expect(blockText(rd.doc.blocks[0])).toBe('foobar');
  });

  it('deleteWordBack/Forward 停在原子块上：删整块（不与邻块串删）', () => {
    const rd = new RichDoc(doc(para([text('a')]), block('image', [text('')], { src: '' }), para([text('b')])));
    rd.setSel({ block: 1, offset: 0 });
    rd.deleteWordBack();
    expect(rd.doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('deleteWordBack 删 CJK 词（词典分词）', () => {
    const rd = new RichDoc(doc(para([text('今天天气')])));
    rd.setSel({ block: 0, offset: 4 });
    rd.deleteWordBack();
    expect(blockText(rd.doc.blocks[0])).toBe('今天');
  });

  it('词删除是独立撤销记录（不与连续输入合并）', () => {
    const rd = new RichDoc(doc(para([text('foo bar')])));
    rd.setSel({ block: 0, offset: 7 });
    rd.deleteWordBack();
    rd.undo();
    expect(blockText(rd.doc.blocks[0])).toBe('foo bar');
  });

  it('deleteToLineStart 已在行首无操作（不入撤销栈）', () => {
    const rd = new RichDoc(doc(para([text('abc')])));
    rd.setSel({ block: 0, offset: 0 });
    rd.deleteToLineStart(0);
    expect(rd.canUndo).toBe(false);
  });
});
