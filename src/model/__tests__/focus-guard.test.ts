import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, block, para, text, isBlockEmpty } from '../schema';

// 集群5 健壮性回归：RichDoc 构造保证 blockCount ≥ 1（空文档补空段落），
// 以及 focusBlock() 统一 focus 块取用入口（块下标 clamp，恒返回非空块）。
// 防回归——下游（main 工具栏/方向切换/光标原子判定）曾直接索引 doc.blocks[focus.block]，
// 空文档或越界 focus 下会取到 undefined 而崩溃。

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('RichDoc constructor blockCount invariant', () => {
  it('backfills an empty paragraph for an empty document', () => {
    const rd = new RichDoc({ blocks: [] });
    expect(rd.blockCount).toBe(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
    expect(isBlockEmpty(rd.doc.blocks[0])).toBe(true);
  });

  it('keeps a non-empty document untouched', () => {
    const rd = new RichDoc(doc(para([text('hello')]), para([text('world')])));
    expect(rd.blockCount).toBe(2);
    expect(rd.blockStr(0)).toBe('hello');
    expect(rd.blockStr(1)).toBe('world');
  });

  it('exposes a usable docEnd even for a backfilled empty document', () => {
    const rd = new RichDoc({ blocks: [] });
    expect(rd.docEnd()).toEqual({ block: 0, offset: 0 });
  });
});

describe('focusBlock', () => {
  it('returns the block at the focus index', () => {
    const rd = new RichDoc(doc(para([text('aaa')]), block('heading', [text('H')], { level: 2 })));
    rd.setSel({ block: 1, offset: 0 });
    expect(rd.focusBlock().type).toBe('heading');
    expect(rd.focusBlock().attrs.level).toBe(2);
  });

  it('clamps an out-of-range focus block to the last block', () => {
    const rd = new RichDoc(doc(para([text('only')])));
    // 直接写越界 focus（绕过 setSel 的 clamp），验证 focusBlock 自身仍夹回合法块
    rd.focus = { block: 99, offset: 0 };
    expect(rd.focusBlock().type).toBe('paragraph');
    expect(rd.focusBlock()).toBe(rd.doc.blocks[0]);
  });

  it('clamps a negative focus block to the first block', () => {
    const rd = new RichDoc(doc(para([text('a')]), para([text('b')])));
    rd.focus = { block: -5, offset: 0 };
    expect(rd.focusBlock()).toBe(rd.doc.blocks[0]);
  });

  it('never returns undefined on the backfilled empty document', () => {
    const rd = new RichDoc({ blocks: [] });
    rd.focus = { block: 7, offset: 3 };
    expect(rd.focusBlock()).toBe(rd.doc.blocks[0]);
    expect(rd.focusBlock().type).toBe('paragraph');
  });
});
