import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { para, text, Block } from '../schema';
import { meta, isAtom, continuesOnEnter, defaultAfter, splitAtStart, liftOnBackspace } from '../block-specs';

const img = (): Block => ({ type: 'image', attrs: { src: 'x' }, inlines: [text('')] });
const rdOf = (blocks: Block[]) => new RichDoc({ blocks });

describe('原子块边界护栏（修复确认 bug：del/backspace 静默删除原子块）', () => {
  it('Delete 在文本末尾、下一块是图片 → 选中图片而非合并删除', () => {
    const rd = rdOf([para([text('text')]), img()]);
    rd.setSel({ block: 0, offset: 4 });
    rd.del();
    expect(rd.doc.blocks.length).toBe(2);
    expect(rd.doc.blocks[1].type).toBe('image');
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });
  it('Backspace 在文本块首、上一块是图片 → 选中图片而非合并', () => {
    const rd = rdOf([img(), para([text('text')])]);
    rd.setSel({ block: 1, offset: 0 });
    rd.backspace();
    expect(rd.doc.blocks.length).toBe(2);
    expect(rd.doc.blocks[0].type).toBe('image');
    expect(rd.focus).toEqual({ block: 0, offset: 0 });
  });
  it('deleteBlock 删除原子块；删到空保留一个段落', () => {
    const rd = rdOf([img()]);
    rd.deleteBlock(0);
    expect(rd.doc.blocks.length).toBe(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });
});

describe('块行为注册表（SSOT）', () => {
  it('atom / list / continuesOnEnter / defaultAfter / splitAtStart / liftOnBackspace 一致', () => {
    expect(isAtom('image')).toBe(true);
    expect(isAtom('formula')).toBe(true);
    expect(isAtom('paragraph')).toBe(false);
    expect(meta('bullet_item').list).toBe(true);
    expect(continuesOnEnter('code_block')).toBe(true);
    expect(continuesOnEnter('ordered_item')).toBe(true);
    expect(continuesOnEnter('heading')).toBe(false);
    expect(defaultAfter('heading')).toBe('paragraph');
    expect(defaultAfter('blockquote')).toBe('blockquote'); // 保留原行为
    expect(splitAtStart('heading')).toBe(true);
    expect(splitAtStart('paragraph')).toBe(false);
    expect(liftOnBackspace('blockquote')).toBe(true);
    expect(liftOnBackspace('paragraph')).toBe(false);
  });
});
