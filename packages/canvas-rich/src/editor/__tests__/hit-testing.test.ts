import { describe, it, expect } from 'vitest';
import { affinityAt, blockBounds, gapAtY, gapYDevice, tocLineHit, taskCheckboxHit } from '../hit-testing';
import { block, para, text, Doc } from '../../model/schema';
import { StyleResolver } from '../../model/style-resolver';
import type { DocLayout, LineBox } from '../../text/doc-layout';

// 构造最小布局行：只填命中逻辑会读的字段，其余给惰性默认值。
function line(p: Partial<LineBox> & { block: number; top: number; bottom: number }): LineBox {
  return {
    baseline: p.top,
    startOffset: 0,
    endOffset: 0,
    offsets: [],
    xs: [],
    minX: 0,
    maxX: 0,
    rtl: false,
    ...p,
  };
}
function layoutOf(lines: LineBox[]): DocLayout {
  return {
    backgrounds: [],
    highlights: [],
    glyphs: [],
    decorations: [],
    overlays: [],
    inlineOverlays: [],
    lines,
    contentHeight: 0,
    contentRight: 0,
    dpr: 1,
  };
}

describe('affinityAt（软换行点光标贴行判定）', () => {
  // 块 0 在 offset 5 处软换行：行 1 = [0,5)，行 2 = [5,10)
  const l1 = line({ block: 0, top: 0, bottom: 20, startOffset: 0, endOffset: 5 });
  const l2 = line({ block: 0, top: 20, bottom: 40, startOffset: 5, endOffset: 10 });
  const L = layoutOf([l1, l2]);

  it('落在上一行行尾且存在以该 offset 起始的下一行 → before', () => {
    expect(affinityAt(L, { block: 0, offset: 5 }, l1)).toBe('before');
  });

  it('同一 offset 但最近行是下一行（行首）→ after', () => {
    expect(affinityAt(L, { block: 0, offset: 5 }, l2)).toBe('after');
  });

  it('块末行行尾（无后继行）→ after', () => {
    expect(affinityAt(L, { block: 0, offset: 10 }, l2)).toBe('after');
  });

  it('无布局 / 无最近行 → after', () => {
    expect(affinityAt(null, { block: 0, offset: 5 }, l1)).toBe('after');
    expect(affinityAt(L, { block: 0, offset: 5 }, null)).toBe('after');
  });
});

describe('blockBounds / gapAtY / gapYDevice（拖拽重排间隙）', () => {
  // 三块：0 = [0,10]，1 = 两行 [10,20]+[20,30]，2 = [30,40]
  const L = layoutOf([
    line({ block: 0, top: 0, bottom: 10 }),
    line({ block: 1, top: 10, bottom: 20 }),
    line({ block: 1, top: 20, bottom: 30, startOffset: 3, endOffset: 6 }),
    line({ block: 2, top: 30, bottom: 40 }),
  ]);
  const N = 3;

  it('blockBounds 跨多行取 top 最小 / bottom 最大', () => {
    expect(blockBounds(L, 1)).toEqual({ top: 10, bottom: 30 });
  });

  it('blockBounds：无行的块 / 无布局 → null', () => {
    expect(blockBounds(L, 9)).toBeNull();
    expect(blockBounds(null, 0)).toBeNull();
  });

  it('gapAtY：落在块垂直中线之上 → 插到该块前', () => {
    expect(gapAtY(L, N, 4)).toBe(0); // 4 < 块0中线 5
    expect(gapAtY(L, N, 6)).toBe(1); // 6 < 块1中线 20
    expect(gapAtY(L, N, 21)).toBe(2); // 21 < 块2中线 35
  });

  it('gapAtY：全部块之下 → blockCount（末尾间隙）', () => {
    expect(gapAtY(L, N, 36)).toBe(3);
    expect(gapAtY(L, N, 999)).toBe(3);
  });

  it('gapYDevice：中间间隙取目标块 top，末间隙取末块 bottom', () => {
    expect(gapYDevice(L, N, 1)).toBe(10);
    expect(gapYDevice(L, N, 3)).toBe(40);
  });

  it('gapYDevice：无布局信息回退 0', () => {
    expect(gapYDevice(null, N, 1)).toBe(0);
    expect(gapYDevice(layoutOf([]), N, 1)).toBe(0);
  });
});

describe('tocLineHit（目录标题行命中）', () => {
  const L = layoutOf([
    line({ block: 0, top: 0, bottom: 20 }), // 无 tocTarget：跳过
    line({ block: 1, top: 20, bottom: 40, tocTarget: 7 }),
    line({ block: 1, top: 40, bottom: 60, tocTarget: 9 }),
  ]);

  it('命中携带 tocTarget 的行 → 返回目标块号（含上下边界）', () => {
    expect(tocLineHit(L, 30)).toBe(7);
    expect(tocLineHit(L, 20)).toBe(7);
    expect(tocLineHit(L, 60)).toBe(9);
  });

  it('命中无 tocTarget 的行 / 落空 / 无布局 → -1', () => {
    expect(tocLineHit(L, 10)).toBe(-1);
    expect(tocLineHit(L, 999)).toBe(-1);
    expect(tocLineHit(null, 30)).toBe(-1);
  });
});

describe('taskCheckboxHit（任务勾选标记栏命中）', () => {
  const doc: Doc = {
    blocks: [para([text('plain paragraph')]), block('task_item', [text('todo item that wraps')])],
  };
  const resolver = new StyleResolver();
  const padL = 26,
    scale = 2;
  // 标记栏右缘 = padL + indent×scale（与实现同源换算，验证的是判定分支本身）
  const x0 = padL + resolver.resolveBlock(doc.blocks[1]).indent * scale;
  const L = layoutOf([
    line({ block: 0, top: 0, bottom: 20 }),
    line({ block: 1, top: 20, bottom: 40, startOffset: 0, endOffset: 10 }),
    line({ block: 1, top: 40, bottom: 60, startOffset: 10, endOffset: 20 }), // 软换行第二行
  ]);

  it('任务项首行、标记栏内（px < x0）→ 返回块下标', () => {
    expect(taskCheckboxHit(L, doc, resolver, padL, scale, x0 - 1, 30)).toBe(1);
  });

  it('任务项首行但落在内容区（px ≥ x0）→ -1', () => {
    expect(taskCheckboxHit(L, doc, resolver, padL, scale, x0, 30)).toBe(-1);
    expect(taskCheckboxHit(L, doc, resolver, padL, scale, x0 + 50, 30)).toBe(-1);
  });

  it('任务项的软换行后续行（startOffset > 0）无标记 → -1', () => {
    expect(taskCheckboxHit(L, doc, resolver, padL, scale, x0 - 1, 50)).toBe(-1);
  });

  it('非任务块的行 → -1', () => {
    expect(taskCheckboxHit(L, doc, resolver, padL, scale, x0 - 1, 10)).toBe(-1);
  });

  it('纵向落空 / 无布局 → -1', () => {
    expect(taskCheckboxHit(L, doc, resolver, padL, scale, x0 - 1, 999)).toBe(-1);
    expect(taskCheckboxHit(null, doc, resolver, padL, scale, x0 - 1, 30)).toBe(-1);
  });
});
