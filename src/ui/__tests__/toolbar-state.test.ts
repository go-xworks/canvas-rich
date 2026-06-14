import { describe, it, expect } from 'vitest';
import {
  buildToolbarState,
  isToolbarStateEqual,
  blockValueOf,
  activeFontSize,
  activeFontFamily,
  activeColor,
  activeHighlight,
} from '../toolbar-state';
import type { ToolbarState } from '../toolbar';
import { RichDoc } from '../../model/rich-document';
import { StyleResolver } from '../../model/style-resolver';
import { block, para, text, Doc } from '../../model/schema';

// 工具栏状态构建（main.ts 只读查询下沉）与脏检查等价比较的纯逻辑测试（node 环境，无 DOM）。

const resolver = new StyleResolver();
const VIEW = { shaperShort: 'Canvas', theme: 'light' as const, viewMode: 'web' as const };

function docOf(): Doc {
  return {
    blocks: [
      block('heading', [text('Title')], { level: 2 }),
      para([text('plain '), text('bold', [{ type: 'bold' }])]),
      para([
        text('styled', [
          { type: 'fontSize', attrs: { size: '22' } },
          { type: 'fontFamily', attrs: { fontFamily: 'serif' } },
          { type: 'color', attrs: { color: '#ff0000' } },
          { type: 'highlight', attrs: { color: '#ffff00' } },
        ]),
      ]),
    ],
  };
}

describe('blockValueOf', () => {
  it('heading 拼级别，级别 clamp 到 1..6', () => {
    const rd = new RichDoc({ blocks: [block('heading', [text('h')], { level: 2 })] });
    rd.setSel({ block: 0, offset: 0 });
    expect(blockValueOf(rd)).toBe('heading2');
    const rd2 = new RichDoc({ blocks: [block('heading', [text('h')], { level: 9 as 1 })] });
    expect(blockValueOf(rd2)).toBe('heading6');
  });

  it('非 heading 块直接返回类型名', () => {
    const rd = new RichDoc({ blocks: [block('blockquote', [text('q')])] });
    expect(blockValueOf(rd)).toBe('blockquote');
  });
});

describe('active* 只读查询', () => {
  it('无显式 mark：字号回退块默认、字体族 default、颜色/高亮 null', () => {
    const rd = new RichDoc(docOf());
    rd.setSel({ block: 1, offset: 1 });
    const blkFs = Math.round(resolver.resolveBlock(rd.focusBlock()).base.fontSize);
    expect(activeFontSize(rd, resolver)).toBe(String(blkFs));
    expect(activeFontFamily(rd)).toBe('default');
    expect(activeColor(rd)).toBeNull();
    expect(activeHighlight(rd)).toBeNull();
  });

  it('选区命中 fontSize/fontFamily/color/highlight mark 时取 mark 值', () => {
    const rd = new RichDoc(docOf());
    rd.setSel({ block: 2, offset: 0 });
    rd.setSel({ block: 2, offset: 6 }, true); // 选中 'styled' 整段
    expect(activeFontSize(rd, resolver)).toBe('22');
    expect(activeFontFamily(rd)).toBe('serif');
    expect(activeColor(rd)).toBe('#ff0000');
    expect(activeHighlight(rd)).toBe('#ffff00');
  });
});

describe('buildToolbarState', () => {
  it('汇总 marks/块值/块属性默认值与视图环境', () => {
    const rd = new RichDoc(docOf());
    rd.setSel({ block: 1, offset: 6 });
    rd.setSel({ block: 1, offset: 10 }, true); // 选中 'bold' 文本
    const s = buildToolbarState(rd, resolver, VIEW);
    expect(s.marks.bold).toBe(true);
    expect(s.marks.italic).toBe(false);
    expect(s.blockValue).toBe('paragraph');
    expect(s.align).toBe('left');
    expect(s.dir).toBe('ltr');
    expect(s.lineHeight).toBe('1');
    expect(s.spaceBefore).toBe(0);
    expect(s.spaceAfter).toBe(0);
    expect(s.letterSpacing).toBe(0);
    expect(s.canUndo).toBe(false);
    expect(s.shaperShort).toBe('Canvas');
    expect(s.theme).toBe('light');
    expect(s.viewMode).toBe('web');
  });

  it('编辑后 canUndo 翻转 → 快照随之变化（脏检查不会卡住撤销钮）', () => {
    const rd = new RichDoc(docOf());
    rd.setSel(rd.docEnd());
    const before = buildToolbarState(rd, resolver, VIEW);
    rd.insertText('x');
    const after = buildToolbarState(rd, resolver, VIEW);
    expect(before.canUndo).toBe(false);
    expect(after.canUndo).toBe(true);
    expect(isToolbarStateEqual(before, after)).toBe(false);
  });
});

describe('isToolbarStateEqual（refresh 前脏检查）', () => {
  function snap(): ToolbarState {
    const rd = new RichDoc(docOf());
    rd.setSel({ block: 1, offset: 1 });
    return buildToolbarState(rd, resolver, VIEW);
  }

  it('独立构建的两份相同状态（marks 对象不同引用）→ 等价', () => {
    expect(isToolbarStateEqual(snap(), snap())).toBe(true);
  });

  it('标量字段（含 null 色值）差异 → 不等价', () => {
    const a = snap();
    expect(isToolbarStateEqual(a, { ...snap(), blockValue: 'heading1' })).toBe(false);
    expect(isToolbarStateEqual(a, { ...snap(), color: '#000000' })).toBe(false);
    expect(isToolbarStateEqual(a, { ...snap(), viewMode: 'word' })).toBe(false);
    expect(isToolbarStateEqual(a, { ...snap(), theme: 'dark' })).toBe(false);
  });

  it('marks 逐键比较：布尔值翻转或键集不同 → 不等价', () => {
    const a = snap();
    const flipped = snap();
    flipped.marks = { ...flipped.marks, bold: !a.marks.bold };
    expect(isToolbarStateEqual(a, flipped)).toBe(false);
    const extra = snap();
    extra.marks = { ...extra.marks, custom: true };
    expect(isToolbarStateEqual(a, extra)).toBe(false);
  });
});
