import { describe, it, expect } from 'vitest';
import { RichDoc, Pos } from '../rich-document';
import { Doc, Block, Mark, block, text, blockText } from '../schema';

// —— helpers ——
const doc = (...blocks: Block[]): Doc => ({ blocks });
const rdOf = (...blocks: Block[]) => new RichDoc(doc(...blocks));
const docTypes = (rd: RichDoc) => rd.doc.blocks.map((b) => b.type);
const docText = (rd: RichDoc) => rd.doc.blocks.map((b) => blockText(b));

// 找到块内所有命中某 mark 的段
const runsWithMark = (b: Block, type: string) => b.inlines.filter((r) => r.marks.some((m) => m.type === type));
const getMark = (b: Block, type: string): Mark | undefined => {
  for (const r of b.inlines) {
    const m = r.marks.find((mk) => mk.type === type);
    if (m) return m;
  }
  return undefined;
};
const pos = (blockIdx: number, offset: number): Pos => ({ block: blockIdx, offset });
// 设置选区 [from,to)
const select = (rd: RichDoc, from: Pos, to: Pos) => {
  rd.anchor = from;
  rd.setSel(to, true);
};

describe('setMark / clearMark color', () => {
  it('setMark color 给选区命中段带 color mark，clearMark 去掉', () => {
    const rd = rdOf(block('paragraph', [text('hello')]));
    select(rd, pos(0, 0), pos(0, 5));
    rd.setMark('color', { color: '#ff0000' });

    const colored = runsWithMark(rd.doc.blocks[0], 'color');
    expect(colored.length).toBeGreaterThan(0);
    expect(getMark(rd.doc.blocks[0], 'color')!.attrs).toEqual({ color: '#ff0000' });
    // 全文都被染色
    expect(colored.map((r) => r.text).join('')).toBe('hello');

    // 去掉
    select(rd, pos(0, 0), pos(0, 5));
    rd.clearMark('color');
    expect(runsWithMark(rd.doc.blocks[0], 'color')).toHaveLength(0);
    expect(blockText(rd.doc.blocks[0])).toBe('hello');
  });
});

describe('setMark link update 语义', () => {
  it('两次 setMark link 在同段只留一个 link 且 href 更新为后者', () => {
    const rd = rdOf(block('paragraph', [text('linktext')]));
    select(rd, pos(0, 0), pos(0, 8));
    rd.setMark('link', { href: 'x' });
    expect(getMark(rd.doc.blocks[0], 'link')!.attrs).toEqual({ href: 'x' });

    select(rd, pos(0, 0), pos(0, 8));
    rd.setMark('link', { href: 'y' });

    // 每个含 link 的段只有一个 link mark（不叠加），且 href === 'y'
    const linked = runsWithMark(rd.doc.blocks[0], 'link');
    expect(linked.length).toBeGreaterThan(0);
    for (const r of linked) {
      const linkMarks = r.marks.filter((m) => m.type === 'link');
      expect(linkMarks).toHaveLength(1);
      expect(linkMarks[0].attrs).toEqual({ href: 'y' });
    }
  });
});

describe('折叠光标 setMark 写 storedMarks 并影响下次 insertText', () => {
  it('setMark bold 后 insertText 的字带 bold', () => {
    const rd = rdOf(block('paragraph', [text('ab')]));
    // 折叠光标置于末尾
    rd.setSel(pos(0, 2));
    expect(rd.isCollapsed).toBe(true);

    rd.setMark('bold');
    expect(rd.storedMarks).not.toBeNull();
    expect(rd.storedMarks!.some((m) => m.type === 'bold')).toBe(true);

    rd.insertText('X');
    expect(blockText(rd.doc.blocks[0])).toBe('abX');
    // 新插入的 'X' 那段带 bold
    const boldRuns = runsWithMark(rd.doc.blocks[0], 'bold');
    expect(boldRuns.map((r) => r.text).join('')).toBe('X');
    // storedMarks 在插入后被清空
    expect(rd.storedMarks).toBeNull();
  });
});

describe('toggleMark strikethrough', () => {
  it('在选区加/去删除线', () => {
    const rd = rdOf(block('paragraph', [text('strike')]));
    select(rd, pos(0, 0), pos(0, 6));
    rd.toggleMark('strikethrough');
    expect(
      runsWithMark(rd.doc.blocks[0], 'strikethrough')
        .map((r) => r.text)
        .join(''),
    ).toBe('strike');

    // 再 toggle 去掉
    select(rd, pos(0, 0), pos(0, 6));
    rd.toggleMark('strikethrough');
    expect(runsWithMark(rd.doc.blocks[0], 'strikethrough')).toHaveLength(0);
  });
});

describe('ordered_item Enter 行为', () => {
  it('非空 ordered_item 中间回车 → 拆成两个 ordered_item', () => {
    const rd = rdOf(block('ordered_item', [text('onetwo')]));
    rd.setSel(pos(0, 3)); // 'one|two'
    rd.enter();
    expect(rd.blockCount).toBe(2);
    expect(docTypes(rd)).toEqual(['ordered_item', 'ordered_item']);
    expect(docText(rd)).toEqual(['one', 'two']);
  });

  it('空 ordered_item 回车 → 降级 paragraph，blockCount 不变', () => {
    const rd = rdOf(block('ordered_item', [text('')]));
    rd.setSel(pos(0, 0));
    const before = rd.blockCount;
    rd.enter();
    expect(rd.blockCount).toBe(before);
    expect(docTypes(rd)).toEqual(['paragraph']);
  });
});

describe('code_block Enter 行为', () => {
  it('非空 code_block 中间回车 → 后半仍是 code_block', () => {
    const rd = rdOf(block('code_block', [text('abcd')]));
    rd.setSel(pos(0, 2));
    rd.enter();
    expect(rd.blockCount).toBe(2);
    expect(docTypes(rd)).toEqual(['code_block', 'code_block']);
    expect(docText(rd)).toEqual(['ab', 'cd']);
  });
});

describe('块首 Backspace 降级', () => {
  it('ordered_item 块首 Backspace → 降级 paragraph，blockCount 不变', () => {
    const rd = rdOf(block('ordered_item', [text('item')]));
    rd.setSel(pos(0, 0));
    const before = rd.blockCount;
    rd.backspace();
    expect(rd.blockCount).toBe(before);
    expect(docTypes(rd)).toEqual(['paragraph']);
    expect(docText(rd)).toEqual(['item']);
  });

  it('code_block 块首 Backspace → 降级 paragraph，blockCount 不变', () => {
    const rd = rdOf(block('code_block', [text('code')]));
    rd.setSel(pos(0, 0));
    const before = rd.blockCount;
    rd.backspace();
    expect(rd.blockCount).toBe(before);
    expect(docTypes(rd)).toEqual(['paragraph']);
    expect(docText(rd)).toEqual(['code']);
  });
});

describe('canUndo / canRedo', () => {
  it('初始 canUndo=false；一次编辑后 true；undo 后 canRedo=true', () => {
    const rd = rdOf(block('paragraph', [text('ab')]));
    expect(rd.canUndo).toBe(false);
    expect(rd.canRedo).toBe(false);

    rd.setSel(pos(0, 2));
    rd.insertText('c');
    expect(rd.canUndo).toBe(true);
    expect(rd.canRedo).toBe(false);

    rd.undo();
    expect(rd.canRedo).toBe(true);
  });
});

describe('setBlockType', () => {
  it("setBlockType('heading',{level:2}) 生效", () => {
    const rd = rdOf(block('paragraph', [text('title')]));
    rd.setSel(pos(0, 0));
    rd.setBlockType('heading', { level: 2 });
    expect(rd.doc.blocks[0].type).toBe('heading');
    expect(rd.doc.blocks[0].attrs.level).toBe(2);
  });

  it("setBlockType('ordered_item') 生效", () => {
    const rd = rdOf(block('paragraph', [text('x')]));
    rd.setSel(pos(0, 0));
    rd.setBlockType('ordered_item');
    expect(rd.doc.blocks[0].type).toBe('ordered_item');
  });

  it("setBlockType('code_block') 生效", () => {
    const rd = rdOf(block('paragraph', [text('y')]));
    rd.setSel(pos(0, 0));
    rd.setBlockType('code_block');
    expect(rd.doc.blocks[0].type).toBe('code_block');
  });
});
