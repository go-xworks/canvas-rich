import { describe, it, expect } from 'vitest';
import { RichDoc, posAfterRangeDelete, Pos } from '../rich-document';
import { Doc, block, para, text, blockText } from '../schema';

// 拖拽移动文本最小版（批E P3-6）：moveSelTo 把非折叠选区移动到落点，单次 undo；
// posAfterRangeDelete 为删除选区后落点坐标的纯折算（落点恒在区间外，由调用方保证）。

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });
const rdOf = (...blocks: Doc['blocks']) => new RichDoc(doc(...blocks));
const docText = (rd: RichDoc): string[] => rd.doc.blocks.map((b) => blockText(b));
const sel = (rd: RichDoc, a: Pos, f: Pos) => { rd.setSel(a); rd.setSel(f, true); };

describe('posAfterRangeDelete — 删除区间后的落点折算', () => {
  const from: Pos = { block: 1, offset: 2 };
  const to: Pos = { block: 1, offset: 5 };
  it('区间之前（含 from 自身）不变', () => {
    expect(posAfterRangeDelete({ block: 0, offset: 9 }, from, to)).toEqual({ block: 0, offset: 9 });
    expect(posAfterRangeDelete({ block: 1, offset: 1 }, from, to)).toEqual({ block: 1, offset: 1 });
    expect(posAfterRangeDelete({ block: 1, offset: 2 }, from, to)).toEqual({ block: 1, offset: 2 });
  });
  it('同块区间之后：offset 前移删除量', () => {
    expect(posAfterRangeDelete({ block: 1, offset: 8 }, from, to)).toEqual({ block: 1, offset: 5 });
  });
  it('跨块区间：to 同块折算到 from 块、更后的块号整体前移', () => {
    const f: Pos = { block: 1, offset: 2 };
    const t: Pos = { block: 3, offset: 4 };
    expect(posAfterRangeDelete({ block: 3, offset: 6 }, f, t)).toEqual({ block: 1, offset: 4 }); // 2 + (6-4)
    expect(posAfterRangeDelete({ block: 5, offset: 7 }, f, t)).toEqual({ block: 3, offset: 7 }); // 块号 -2
  });
});

describe('moveSelTo — 同块移动', () => {
  it('向后移动：落点 offset 随删除前移，移动后选中被移文本', () => {
    const rd = rdOf(para([text('abcdef')]));
    sel(rd, { block: 0, offset: 0 }, { block: 0, offset: 2 }); // 选 "ab"
    expect(rd.moveSelTo({ block: 0, offset: 4 })).toBe(true);  // 落到 "cd|ef"
    expect(docText(rd)).toEqual(['cdabef']);
    expect(rd.range()).toEqual({ from: { block: 0, offset: 2 }, to: { block: 0, offset: 4 } });
  });
  it('向前移动：落点在选区之前不折算', () => {
    const rd = rdOf(para([text('abcdef')]));
    sel(rd, { block: 0, offset: 4 }, { block: 0, offset: 6 }); // 选 "ef"
    expect(rd.moveSelTo({ block: 0, offset: 1 })).toBe(true);  // 落到 "a|bcd"
    expect(docText(rd)).toEqual(['aefbcd']);
    expect(rd.range()).toEqual({ from: { block: 0, offset: 1 }, to: { block: 0, offset: 3 } });
  });
  it('保留 marks（行内片段经 insertFragment 通道）', () => {
    const rd = rdOf(para([text('xy'), text('BO', [{ type: 'bold' }]), text('z')]));
    sel(rd, { block: 0, offset: 2 }, { block: 0, offset: 4 }); // 选粗体 "BO"
    expect(rd.moveSelTo({ block: 0, offset: 5 })).toBe(true);
    expect(docText(rd)).toEqual(['xyzBO']);
    const last = rd.doc.blocks[0].inlines.find((i) => i.text.includes('BO'));
    expect(last?.marks.some((m) => m.type === 'bold')).toBe(true);
  });
});

describe('moveSelTo — 跨块与拒绝路径', () => {
  it('跨块选区移动到后方块', () => {
    const rd = rdOf(para([text('abc')]), para([text('def')]), para([text('ghi')]));
    sel(rd, { block: 0, offset: 1 }, { block: 1, offset: 2 }); // 选 "bc\nde"
    expect(rd.moveSelTo({ block: 2, offset: 3 })).toBe(true);  // 落到 "ghi" 尾
    // 删除合并后文档为 ["af", "ghi"]，落点折算为块1尾 → 拆块插入
    expect(docText(rd).join('|')).toBe('af|ghibc|de');
  });
  it('落点在选区内（含端点）→ false 不动作', () => {
    const rd = rdOf(para([text('abcdef')]));
    sel(rd, { block: 0, offset: 1 }, { block: 0, offset: 4 });
    expect(rd.moveSelTo({ block: 0, offset: 2 })).toBe(false);
    expect(rd.moveSelTo({ block: 0, offset: 1 })).toBe(false); // from 端点
    expect(rd.moveSelTo({ block: 0, offset: 4 })).toBe(false); // to 端点
    expect(docText(rd)).toEqual(['abcdef']);
    expect(rd.canUndo).toBe(false); // 拒绝路径不污染撤销栈
  });
  it('选区折叠 / 选区或落点涉原子块 → false', () => {
    const rd = rdOf(para([text('abc')]), block('image', [], { src: 'x' }), para([text('def')]));
    expect(rd.moveSelTo({ block: 2, offset: 1 })).toBe(false); // 折叠
    sel(rd, { block: 0, offset: 0 }, { block: 1, offset: 0 }); // 区间含原子块
    expect(rd.moveSelTo({ block: 2, offset: 1 })).toBe(false);
    sel(rd, { block: 0, offset: 0 }, { block: 0, offset: 2 });
    expect(rd.moveSelTo({ block: 1, offset: 0 })).toBe(false); // 落点为原子块
    expect(docText(rd)[0]).toBe('abc');
  });
});

describe('moveSelTo — 单次撤销', () => {
  it('一次 undo 直回拖动前（文档与选区），redo 重做移动', () => {
    const rd = rdOf(para([text('abcdef')]));
    sel(rd, { block: 0, offset: 0 }, { block: 0, offset: 2 });
    expect(rd.moveSelTo({ block: 0, offset: 4 })).toBe(true);
    expect(docText(rd)).toEqual(['cdabef']);
    rd.undo();
    expect(docText(rd)).toEqual(['abcdef']); // 单步即还原（无「删除后中间态」残留）
    rd.redo();
    expect(docText(rd)).toEqual(['cdabef']);
    rd.undo();
    expect(docText(rd)).toEqual(['abcdef']);
    expect(rd.canUndo).toBe(false); // 整个移动只占一条撤销记录
  });

  it('撤销栈满（200 上限触发 shift）时仍单次 undo 还原（中间态按栈顶弹）', () => {
    const rd = rdOf(para([text('abcdef')]));
    for (let i = 0; i < 205; i++) { rd.setSel({ block: 0, offset: 0 }); rd.insertText('x'); } // setSel 断合并 → 每次独立快照
    rd.setSel({ block: 0, offset: 205 });
    rd.setSel({ block: 0, offset: 207 }, true); // 选 "ab"（x 连段之后的可辨别字符）
    const before = docText(rd)[0];
    expect(rd.moveSelTo({ block: 0, offset: 0 })).toBe(true); // 移到串首
    expect(docText(rd)[0]).not.toBe(before);
    expect(docText(rd)[0].startsWith('ab')).toBe(true);
    rd.undo();
    expect(docText(rd)[0]).toBe(before); // 一步还原，无「删除后中间态」残留
  });
});
