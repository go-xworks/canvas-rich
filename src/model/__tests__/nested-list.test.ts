import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, block, para, MAX_LIST_DEPTH } from '../schema';
import { clampDepth, bulletMarker, LIST_DEPTH_STEP } from '../block-specs';
import { StyleResolver } from '../style-resolver';

// 嵌套列表：depth 的 clamp、indent/outdent 选区行为、主题缩进随 depth 递增、bullet 符号轮换。

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });
const rdOf = (...blocks: Doc['blocks']) => new RichDoc(doc(...blocks));
const depths = (rd: RichDoc): (number | undefined)[] => rd.doc.blocks.map((b) => b.attrs.depth);

describe('clampDepth', () => {
  it('夹回 [0, MAX_LIST_DEPTH]', () => {
    expect(clampDepth(-3)).toBe(0);
    expect(clampDepth(0)).toBe(0);
    expect(clampDepth(2)).toBe(2);
    expect(clampDepth(MAX_LIST_DEPTH)).toBe(MAX_LIST_DEPTH);
    expect(clampDepth(MAX_LIST_DEPTH + 5)).toBe(MAX_LIST_DEPTH);
  });
  it('undefined / 非有限值归 0，浮点向下取整', () => {
    expect(clampDepth(undefined)).toBe(0);
    expect(clampDepth(NaN)).toBe(0);
    expect(clampDepth(Infinity)).toBe(0); // 非有限值 → 0
    expect(clampDepth(2.9)).toBe(2);
  });
});

describe('bulletMarker 轮换', () => {
  it('按 depth 三级循环 •/◦/▪', () => {
    expect(bulletMarker(0)).toBe('•');
    expect(bulletMarker(1)).toBe('◦');
    expect(bulletMarker(2)).toBe('▪');
    expect(bulletMarker(3)).toBe('•'); // 循环
  });
});

describe('indentList / outdentList depth clamp', () => {
  it('indentList 在 bullet 项上 +1，夹到 MAX_LIST_DEPTH 不再增长', () => {
    const rd = rdOf(block('bullet_item', []));
    rd.setSel({ block: 0, offset: 0 });
    for (let i = 0; i < MAX_LIST_DEPTH + 3; i++) rd.indentList();
    expect(rd.doc.blocks[0].attrs.depth).toBe(MAX_LIST_DEPTH);
  });

  it('outdentList 夹到 0 不为负', () => {
    const rd = rdOf(block('bullet_item', [], { depth: 1 }));
    rd.setSel({ block: 0, offset: 0 });
    rd.outdentList();
    expect(rd.doc.blocks[0].attrs.depth).toBe(0);
    rd.outdentList();
    expect(rd.doc.blocks[0].attrs.depth).toBe(0);
  });

  it('仅作用于选区内的 list/task 块，跳过段落', () => {
    const rd = rdOf(para([]), block('bullet_item', []), block('task_item', []));
    rd.anchor = { block: 0, offset: 0 };
    rd.focus = { block: 2, offset: 0 };
    rd.indentList();
    expect(depths(rd)).toEqual([undefined, 1, 1]); // 段落不动
  });

  it('选区内无任何 list/task 块时不入撤销栈', () => {
    const rd = rdOf(para([]));
    rd.setSel({ block: 0, offset: 0 });
    expect(rd.canUndo).toBe(false);
    rd.indentList();
    expect(rd.canUndo).toBe(false); // 无变更 → 无快照
  });

  it('一次 indent 多块 + undo 单步回退', () => {
    const rd = rdOf(block('bullet_item', []), block('bullet_item', []));
    rd.anchor = { block: 0, offset: 0 };
    rd.focus = { block: 1, offset: 0 };
    rd.indentList();
    expect(depths(rd)).toEqual([1, 1]);
    rd.undo();
    expect(depths(rd)).toEqual([undefined, undefined]);
  });

  it('focusIsList 反映焦点块类型', () => {
    const rd = rdOf(para([]), block('bullet_item', []));
    rd.setSel({ block: 0, offset: 0 });
    expect(rd.focusIsList()).toBe(false);
    rd.setSel({ block: 1, offset: 0 });
    expect(rd.focusIsList()).toBe(true);
  });
});

describe('depth → 主题缩进', () => {
  const R = new StyleResolver();
  it('bullet 缩进 = 基础 + depth*LIST_DEPTH_STEP', () => {
    const base = R.resolveBlock(block('bullet_item', [])).indent;
    const d2 = R.resolveBlock(block('bullet_item', [], { depth: 2 })).indent;
    expect(d2).toBe(base + 2 * LIST_DEPTH_STEP);
  });
  it('ordered / task 同样随 depth 加深', () => {
    const ob = R.resolveBlock(block('ordered_item', [])).indent;
    const o1 = R.resolveBlock(block('ordered_item', [], { depth: 1 })).indent;
    expect(o1).toBe(ob + LIST_DEPTH_STEP);
    const tb = R.resolveBlock(block('task_item', [])).indent;
    const t3 = R.resolveBlock(block('task_item', [], { depth: 3 })).indent;
    expect(t3).toBe(tb + 3 * LIST_DEPTH_STEP);
  });
  it('attrs.indent 显式覆盖优先于 depth 计算', () => {
    const rbo = R.resolveBlock(block('bullet_item', [], { depth: 4, indent: 7 }));
    expect(rbo.indent).toBe(7);
  });
  it('bullet 符号随 depth 轮换写入主题 marker', () => {
    expect(R.resolveBlock(block('bullet_item', [], { depth: 0 })).marker).toBe('•');
    expect(R.resolveBlock(block('bullet_item', [], { depth: 1 })).marker).toBe('◦');
  });
});
