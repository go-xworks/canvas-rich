import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, BlockAttrs, block, para, text } from '../schema';

// 集群 2：块操作（降级 / 拆块 / 切类型）应保留与块类型无关的段落排版属性
// （align/lineHeight/spaceBefore/spaceAfter/indent/letterSpacing/dir），
// 并丢弃块类型专属字段（level/checked/depth/src/latex/rows 等）。
const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

// 一组覆盖全部被保留字段的排版属性，便于断言「全保留」。
const FMT = {
  align: 'center',
  lineHeight: 1.5,
  spaceBefore: 8,
  spaceAfter: 12,
  indent: 24,
  letterSpacing: 2,
  dir: 'rtl',
} as const;

function expectFmtPreserved(attrs: BlockAttrs): void {
  expect(attrs.align).toBe('center');
  expect(attrs.lineHeight).toBe(1.5);
  expect(attrs.spaceBefore).toBe(8);
  expect(attrs.spaceAfter).toBe(12);
  expect(attrs.indent).toBe(24);
  expect(attrs.letterSpacing).toBe(2);
  expect(attrs.dir).toBe('rtl');
}

describe('liftToParagraph 保留排版属性（空列表项/代码行回车降级）', () => {
  it('空 task_item 回车降级为段落，保留 align/lineHeight/indent/dir 等', () => {
    const rd = new RichDoc(doc(block('task_item', [text('')], { ...FMT, checked: true, depth: 2 })));
    rd.setSel({ block: 0, offset: 0 });
    rd.enter();
    expect(rd.blockCount).toBe(1);
    const blk = rd.doc.blocks[0];
    expect(blk.type).toBe('paragraph');
    expectFmtPreserved(blk.attrs);
    // 块类型专属字段被丢弃
    expect(blk.attrs.checked).toBeUndefined();
    expect(blk.attrs.depth).toBeUndefined();
  });

  it('块首 Backspace 把样式块降级为段落，保留排版属性', () => {
    const rd = new RichDoc(doc(para([text('x')]), block('heading', [text('H')], { ...FMT, level: 2 })));
    rd.setSel({ block: 1, offset: 0 });
    rd.backspace();
    const blk = rd.doc.blocks[1];
    expect(blk.type).toBe('paragraph');
    expectFmtPreserved(blk.attrs);
    expect(blk.attrs.level).toBeUndefined();
  });
});

describe('splitBlockAtCaret 后半块保留排版属性', () => {
  it('段落中间回车，后半块继承全部排版属性', () => {
    const rd = new RichDoc(doc(para([text('hello')], { ...FMT })));
    rd.setSel({ block: 0, offset: 2 });
    rd.enter();
    expect(rd.blockCount).toBe(2);
    const back = rd.doc.blocks[1];
    expect(back.type).toBe('paragraph');
    expectFmtPreserved(back.attrs);
  });

  it('列表项中间回车，后半块续同类型并保留排版属性', () => {
    const rd = new RichDoc(doc(block('bullet_item', [text('todo')], { ...FMT, depth: 1 })));
    rd.setSel({ block: 0, offset: 2 });
    rd.enter();
    const back = rd.doc.blocks[1];
    expect(back.type).toBe('bullet_item');
    expectFmtPreserved(back.attrs);
    // 块专属 depth 不随排版 helper 保留（续块从空 attrs 起算）
    expect(back.attrs.depth).toBeUndefined();
  });

  it('行首拆样式块：上方留空段、内容块保持原类型并保留全部原 attrs', () => {
    // heading 的 splitAtStart 为 true：offset 0 回车 → 当前块变空段落、内容下移保持 heading
    const rd = new RichDoc(doc(block('heading', [text('Title')], { ...FMT, level: 3 })));
    rd.setSel({ block: 0, offset: 0 });
    rd.enter();
    expect(rd.blockCount).toBe(2);
    const top = rd.doc.blocks[0];
    const content = rd.doc.blocks[1];
    // 上方空段落只保留排版属性（不带 level）
    expect(top.type).toBe('paragraph');
    expectFmtPreserved(top.attrs);
    expect(top.attrs.level).toBeUndefined();
    // 内容块保持 heading 且保留 level 等完整原 attrs
    expect(content.type).toBe('heading');
    expect(content.attrs.level).toBe(3);
    expectFmtPreserved(content.attrs);
  });
});

describe('setBlockType 保留未显式传入的排版属性', () => {
  it('切到 heading：未传入的排版属性保留，传入 level 生效', () => {
    const rd = new RichDoc(doc(para([text('T')], { ...FMT })));
    rd.setSel({ block: 0, offset: 0 });
    rd.setBlockType('heading', { level: 2 });
    const blk = rd.doc.blocks[0];
    expect(blk.type).toBe('heading');
    expect(blk.attrs.level).toBe(2);
    expectFmtPreserved(blk.attrs);
  });

  it('传入 attrs 覆盖同名排版属性（align 以传入为准）', () => {
    const rd = new RichDoc(doc(para([text('T')], { ...FMT })));
    rd.setSel({ block: 0, offset: 0 });
    rd.setBlockType('paragraph', { align: 'right' });
    const blk = rd.doc.blocks[0];
    expect(blk.attrs.align).toBe('right'); // 传入优先
    expect(blk.attrs.lineHeight).toBe(1.5); // 未传入则保留
    expect(blk.attrs.indent).toBe(24);
    expect(blk.attrs.dir).toBe('rtl');
  });

  it('切类型丢弃源块的块专属字段（level/checked/depth）', () => {
    const rd = new RichDoc(doc(block('task_item', [text('x')], { ...FMT, checked: true, depth: 3 })));
    rd.setSel({ block: 0, offset: 0 });
    rd.setBlockType('paragraph');
    const blk = rd.doc.blocks[0];
    expect(blk.type).toBe('paragraph');
    expect(blk.attrs.checked).toBeUndefined();
    expect(blk.attrs.depth).toBeUndefined();
    expectFmtPreserved(blk.attrs);
  });
});

describe('撤销恢复排版属性', () => {
  it('setBlockType 后撤销恢复原段落类型与排版', () => {
    const rd = new RichDoc(doc(para([text('T')], { ...FMT })));
    rd.setSel({ block: 0, offset: 0 });
    rd.setBlockType('heading', { level: 1 });
    expect(rd.doc.blocks[0].type).toBe('heading');
    rd.undo();
    const blk = rd.doc.blocks[0];
    expect(blk.type).toBe('paragraph');
    expect(blk.attrs.level).toBeUndefined();
    expectFmtPreserved(blk.attrs);
  });

  it('段落拆块后撤销合回单块且保留排版', () => {
    const rd = new RichDoc(doc(para([text('hello')], { ...FMT })));
    rd.setSel({ block: 0, offset: 2 });
    rd.enter();
    expect(rd.blockCount).toBe(2);
    rd.undo();
    expect(rd.blockCount).toBe(1);
    expectFmtPreserved(rd.doc.blocks[0].attrs);
  });
});
