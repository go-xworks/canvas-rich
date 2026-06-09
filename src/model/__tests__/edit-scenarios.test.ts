import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { para, text, blockText, blockTextLen, marksEqual, MarkType, BlockType, Block } from '../schema';

const rdOf = (blocks: Block[]) => new RichDoc({ blocks });
const docText = (rd: RichDoc) => rd.doc.blocks.map((b) => blockText(b));

// —— 不变量：任何编辑后都应成立 ——
function checkInvariants(rd: RichDoc): string | null {
  const blocks = rd.doc.blocks;
  if (blocks.length < 1) return '文档无块';
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.inlines.length < 1) return `块${bi} 无 inline`;
    for (let i = 0; i < b.inlines.length; i++) {
      const r = b.inlines[i];
      if (b.inlines.length > 1 && r.text === '') return `块${bi} 多段里有空段（未归一化）`;
      if (i > 0 && marksEqual(b.inlines[i - 1].marks, r.marks)) return `块${bi} 相邻同 marks 段未合并`;
    }
  }
  for (const [name, p] of [['anchor', rd.anchor], ['focus', rd.focus]] as const) {
    if (p.block < 0 || p.block >= blocks.length) return `${name}.block 越界 ${p.block}`;
    if (p.offset < 0 || p.offset > blockTextLen(blocks[p.block])) return `${name}.offset 越界 ${p.offset}`;
  }
  return null;
}

describe('插入场景', () => {
  it('空文档插入', () => {
    const rd = rdOf([para([])]);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('hi');
    expect(docText(rd)).toEqual(['hi']);
  });
  it('在选中的原子块上打字 → 在其后新建段落（不污染原子块）', () => {
    const rd = rdOf([{ type: 'image', attrs: { src: 'x' }, inlines: [text('')] }]);
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('abc');
    expect(rd.doc.blocks.length).toBe(2);
    expect(rd.doc.blocks[0].type).toBe('image');
    expect(blockText(rd.doc.blocks[0])).toBe('');     // 图片块未被污染
    expect(rd.doc.blocks[1].type).toBe('paragraph');
    expect(blockText(rd.doc.blocks[1])).toBe('abc');
  });
  it('选区跨越原子块删除 → 整体删除', () => {
    const rd = rdOf([para([text('abc')]), { type: 'image', attrs: { src: 'x' }, inlines: [text('')] }, para([text('xyz')])]);
    rd.setSel({ block: 0, offset: 1 });
    rd.setSel({ block: 2, offset: 2 }, true);
    rd.backspace();
    expect(rd.doc.blocks.length).toBe(1);
    expect(blockText(rd.doc.blocks[0])).toBe('az');
  });
  it('各位置插入原子块', () => {
    const rd = rdOf([para([text('abc')])]);
    rd.setSel({ block: 0, offset: 2 });
    rd.insertFormula('x^2');
    expect(rd.doc.blocks[1].type).toBe('formula');
    expect(checkInvariants(rd)).toBeNull();
  });
});

// —— 模糊测试：随机编辑序列 + 不变量 ——
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const MARKS: MarkType[] = ['bold', 'italic', 'underline', 'strikethrough', 'highlight', 'code', 'link'];
const BLOCKS: BlockType[] = ['paragraph', 'heading', 'bullet_item', 'ordered_item', 'blockquote', 'code_block'];

describe('模糊测试（随机编辑序列 → 不变量恒成立）', () => {
  for (let seed = 1; seed <= 80; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const rd = rdOf([para([text('Hello world')])]);
      const ops: string[] = [];
      for (let step = 0; step < 60; step++) {
        const bi = Math.floor(r() * rd.blockCount);
        rd.setSel({ block: bi, offset: Math.floor(r() * (rd.blockLen(bi) + 1)) });
        if (r() < 0.4) { const b2 = Math.floor(r() * rd.blockCount); rd.setSel({ block: b2, offset: Math.floor(r() * (rd.blockLen(b2) + 1)) }, true); }
        const op = r();
        if (op < 0.20) { rd.insertText('ab'); ops.push('ins'); }
        else if (op < 0.30) { rd.backspace(); ops.push('bs'); }
        else if (op < 0.40) { rd.del(); ops.push('del'); }
        else if (op < 0.50) { rd.enter(); ops.push('ent'); }
        else if (op < 0.60) { rd.toggleMark(MARKS[Math.floor(r() * MARKS.length)]); ops.push('mark'); }
        else if (op < 0.68) { rd.setBlockType(BLOCKS[Math.floor(r() * BLOCKS.length)]); ops.push('blk'); }
        else if (op < 0.73) { rd.insertImage('x'); ops.push('img'); }
        else if (op < 0.77) { rd.insertTable(2, 2); ops.push('tbl'); }
        else if (op < 0.81) { rd.insertFormula('x'); ops.push('fx'); }
        else if (op < 0.87) { rd.setDir(r() < 0.5 ? 'rtl' : 'ltr'); ops.push('dir'); }
        else if (op < 0.94) { rd.undo(); ops.push('undo'); }
        else { rd.redo(); ops.push('redo'); }
        const err = checkInvariants(rd);
        if (err) throw new Error(`seed ${seed} step ${step}(${ops[ops.length - 1]}): ${err}\nops=${ops.join(',')}`);
      }
    });
  }
});

describe('撤销/重做 round-trip（每步都快照的操作：insert/enter）', () => {
  for (let seed = 1; seed <= 30; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed * 7 + 3);
      const rd = rdOf([para([text('start')])]);
      const N = 25;
      const initial = JSON.stringify(rd.doc.blocks.map((b) => ({ t: b.type, x: blockText(b) })));
      for (let i = 0; i < N; i++) {
        const bi = Math.floor(r() * rd.blockCount);
        rd.setSel({ block: bi, offset: Math.floor(r() * (rd.blockLen(bi) + 1)) });
        if (r() < 0.6) rd.insertText('z'); else rd.enter(); // 两者都必然快照
      }
      const final = JSON.stringify(rd.doc.blocks.map((b) => ({ t: b.type, x: blockText(b) })));
      for (let i = 0; i < N; i++) rd.undo();
      expect(JSON.stringify(rd.doc.blocks.map((b) => ({ t: b.type, x: blockText(b) })))).toBe(initial);
      for (let i = 0; i < N; i++) rd.redo();
      expect(JSON.stringify(rd.doc.blocks.map((b) => ({ t: b.type, x: blockText(b) })))).toBe(final);
    });
  }
});
