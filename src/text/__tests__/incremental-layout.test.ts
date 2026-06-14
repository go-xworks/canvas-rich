import { describe, it, expect } from 'vitest';
import { layoutDoc, selectionRects, visibleLineRange, DocLayoutOpts } from '../doc-layout';
import { BlockLayoutCache, LayoutEpoch } from '../block-layout-cache';
import { paginateLayout, PaginateOpts } from '../paginate';
import { Shaper, ShapedChar } from '../shaper';
import { FontMetrics } from '../glyph-atlas';
import { StyledChar, Style, GlyphInfo } from '../../types';
import { StyleResolver } from '../../model/style-resolver';
import { Doc, block, para, text, inlineAtom } from '../../model/schema';
import { RichDoc, Pos } from '../../model/rich-document';
import { blockVersion } from '../../model/block-version';

// 增量布局等价性测试（P0-1 铁律：正确性优先）：
// 同一文档、同一确定性 Shaper 下，「持久块缓存的增量布局」与「无缓存全量布局」全字段 deep-equal。
// 两路径共用同一构建/物化代码 → 差异只可能来自缓存陈旧（version 打点遗漏 / orderedNum 失配 /
// epoch 漏失效），故 500 步随机编辑序列即是对 model 层全部写点的对抗式审计。

const ADV = 10;
const ASCENT = 12,
  DESCENT = 4,
  LINEH = 16;

// 非 empty 字形（让 glyphs 真实进入布局产物，覆盖字形几何的等价比较）；共享常量 → 引用与 deep-equal 均成立。
const GLYPH: GlyphInfo = {
  u0: 0,
  v0: 0,
  u1: 0.05,
  v1: 0.05,
  page: 0,
  w: 8,
  h: 12,
  bearingX: 1,
  bearingY: 10,
  advance: ADV,
  empty: false,
};

class FakeShaper implements Shaper {
  readonly name = 'fake';
  fontMetrics(_style: Style): FontMetrics {
    void _style;
    return { ascent: ASCENT, descent: DESCENT, lineHeight: LINEH };
  }
  shapeChars(chars: StyledChar[]): ShapedChar[] {
    return chars.map(() => ({ advance: ADV, glyph: GLYPH }));
  }
}

// 计数 Shaper：包一层 FakeShaper 记 shapeChars 调用次数（性能哨兵：单块编辑只应整形受影响块）。
class CountingShaper implements Shaper {
  readonly name = 'counting';
  calls = 0;
  private inner = new FakeShaper();
  fontMetrics(style: Style): FontMetrics {
    return this.inner.fontMetrics(style);
  }
  shapeChars(chars: StyledChar[]): ShapedChar[] {
    this.calls++;
    return this.inner.shapeChars(chars);
  }
}

// mulberry32：确定性 PRNG（种子固定 → 失败可复现）。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const resolver = new StyleResolver();
const shaper = new FakeShaper();
const OPT: DocLayoutOpts = { width: 320, padL: 20, padT: 20, dpr: 1 };
const EPOCH = (s: Shaper = shaper): LayoutEpoch => ({
  width: OPT.width,
  padL: OPT.padL,
  padT: OPT.padT,
  scale: OPT.dpr,
  shaper: s,
  theme: 'light',
  atlasGen: 0,
});
const P_OPTS: PaginateOpts = {
  pageX: 4,
  pageW: 300,
  pageH: 200,
  marginTop: 16,
  marginBottom: 16,
  gap: 12,
  padT: 28,
};

// 种子文档：heading / 有序列表链 / 连续代码块 / toc / 表格 / 块图片 / 行内图片 / 任务项 / RTL / 多 mark。
function buildSeedDoc(): Doc {
  return {
    blocks: [
      block('heading', [text('标题一')], { level: 1 }),
      para([text('hello 世界 '), text('bold', [{ type: 'bold' }]), text(' 后续')]),
      block('ordered_item', [text('第一项')]),
      block('ordered_item', [text('第二项')]),
      block('ordered_item', [text('第三项')]),
      block('code_block', [text('const a = 1;')]),
      block('code_block', [text('const b = 2;')]),
      block('toc', [text('')]),
      block('heading', [text('שלום')], { level: 2, dir: 'rtl' }),
      block('task_item', [text('待办')], { checked: false }),
      block('bullet_item', [text('圆点项')]),
      { type: 'table', attrs: { rows: [[{ inlines: [text('a')] }, { inlines: [text('b')] }]] }, inlines: [text('')] },
      { type: 'image', attrs: { src: 'x.png', width: 80, height: 40 }, inlines: [text('')] },
      para([text('图前 '), inlineAtom('image', { src: 'i.png', width: 24, height: 18 }), text(' 图后')]),
      para([text('aa bb cc dd ee ff gg hh')], { align: 'justify' }),
      block('blockquote', [text('引用文字'), text('线', [{ type: 'underline' }, { type: 'strikethrough' }])]),
    ],
  };
}

// 随机编辑操作集：覆盖 RichDoc 全部主要写路径（version 打点审计面）。
const INSERT_POOL = ['x', 'ab ', '中文', '🙂', ' ', 'word 词', 'q'];
function applyRandomEdit(rd: RichDoc, rng: () => number): void {
  const ri = (n: number) => Math.floor(rng() * n);
  const randPos = (): Pos => {
    const b = ri(rd.blockCount);
    return { block: b, offset: ri(rd.blockLen(b) + 1) };
  };
  const randSel = () => {
    rd.setSel(randPos());
    rd.setSel(randPos(), true);
  };
  const ops: (() => void)[] = [
    () => {
      rd.setSel(randPos());
      rd.insertText(INSERT_POOL[ri(INSERT_POOL.length)]);
    },
    () => {
      rd.setSel(randPos());
      rd.backspace();
    },
    () => {
      rd.setSel(randPos());
      rd.del();
    },
    () => {
      rd.setSel(randPos());
      rd.enter();
    },
    () => {
      randSel();
      rd.toggleMark('bold');
    },
    () => {
      randSel();
      rd.toggleMark('underline');
    },
    () => {
      randSel();
      rd.toggleMark('highlight');
    },
    () => {
      randSel();
      rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']);
    },
    () => {
      randSel();
      rd.setMark('color', { color: '#ff0000' });
    },
    () => {
      randSel();
      rd.clearMarks();
    },
    () => {
      randSel();
      rd.setBlockType('heading', { level: ([1, 2, 3] as const)[ri(3)] });
    },
    () => {
      randSel();
      rd.setBlockType('code_block');
    },
    () => {
      randSel();
      rd.setBlockType('ordered_item');
    },
    () => {
      randSel();
      rd.setBlockType('paragraph');
    },
    () => {
      randSel();
      rd.setAlign('justify');
    },
    () => {
      randSel();
      rd.setAlign('center');
    },
    () => {
      randSel();
      rd.setIndent(ri(40));
    },
    () => {
      randSel();
      rd.setLineHeight(1 + rng());
    },
    () => {
      randSel();
      rd.setSpaceBefore(ri(24));
    },
    () => {
      randSel();
      rd.setLetterSpacing(ri(4));
    },
    () => {
      randSel();
      rd.setDir(rng() < 0.5 ? 'rtl' : 'ltr');
    },
    () => {
      randSel();
      rd.indentList();
    },
    () => {
      randSel();
      rd.outdentList();
    },
    () => rd.moveBlock(ri(rd.blockCount), ri(rd.blockCount + 1)),
    () => {
      randSel();
      rd.backspace();
    }, // 选区删除（跨块时走 deleteSel 合并路径）
    () => rd.toggleTaskChecked(ri(rd.blockCount)),
    () => {
      rd.setSel(randPos());
      rd.insertTable(2, 2);
    },
    () => {
      rd.setSel(randPos());
      rd.insertInlineImage('z.png', 20, 16);
    },
    () => rd.setColWidth(ri(rd.blockCount), 0, 60 + ri(40)),
    () => rd.mergeCells(ri(rd.blockCount), 0, 0, 1, 1),
    () => rd.updateAtomAttrs(ri(rd.blockCount), { width: 60 + ri(60) }),
    () => {
      rd.setMeasuredHeight(ri(rd.blockCount), 80 + ri(80));
    },
    () => rd.deleteBlock(ri(rd.blockCount)),
    // —— 真实写路径补全（批F审查第5项）：IME 组合 transient 通道 / 富文本粘贴 /
    // 全部替换（逐块累计偏移）/ 拖文本（快照弹栈技巧）——确保未来回归时等价套件报警 ——
    () => {
      // IME 组合提交：begin → update×k → end（updateComposition 不进撤销栈、带临时 underline）
      rd.setSel(randPos());
      rd.beginComposition();
      rd.updateComposition('p');
      rd.updateComposition('pi');
      rd.endComposition('拼音');
    },
    () => {
      // IME 组合取消：end('') 弹回起始快照
      rd.setSel(randPos());
      rd.beginComposition();
      rd.updateComposition('z');
      rd.endComposition('');
    },
    () => {
      // 富文本粘贴：单块/多块/原子首块三分支（随机片段形态）
      rd.setSel(randPos());
      const frags: Doc[] = [
        { blocks: [para([text('粘贴 '), text('bold', [{ type: 'bold' }])])] },
        { blocks: [block('heading', [text('H')], { level: 2 }), para([text('body')])] },
        {
          blocks: [
            { type: 'image', attrs: { src: 'p.png', width: 40, height: 30 }, inlines: [text('')] },
            para([text('after')]),
          ],
        },
      ];
      rd.insertFragment(frags[ri(frags.length)]);
    },
    () => {
      // 全部替换：同块多区间逐块累计偏移（区间无效时方法内自滤）
      const b = ri(rd.blockCount);
      const len = rd.blockLen(b);
      const ranges = [{ block: b, start: 0, end: Math.min(1, len) }];
      if (len >= 4) ranges.push({ block: b, start: 2, end: 4 });
      rd.replaceAllTextRanges(ranges, INSERT_POOL[ri(INSERT_POOL.length)]);
    },
    () => {
      randSel();
      rd.moveSelTo(randPos());
    }, // 拖拽移动选中文本（无效落点自返 false）
    () => rd.undo(),
    () => rd.redo(),
  ];
  ops[ri(ops.length)]();
}

describe('增量布局等价性：随机编辑序列 deep-equal（全量 vs 增量）', () => {
  for (const seed of [7, 1234]) {
    it(`seed=${seed}：250 步随机编辑后每步 inc === full（含 word 视图分页）`, () => {
      const cache = new BlockLayoutCache();
      const rd = new RichDoc(buildSeedDoc());
      rd.setSel(rd.docEnd());
      const rng = mulberry32(seed);
      for (let step = 0; step < 250; step++) {
        applyRandomEdit(rd, rng);
        cache.beginPass(EPOCH());
        const inc = layoutDoc(rd.doc, shaper, resolver, OPT, cache); // 跨步持久复用
        const full = layoutDoc(rd.doc, shaper, resolver, OPT); // 无缓存基准
        expect(inc).toEqual(full);
        // word 视图等价：paginate 对 lines/glyphs 1:1 平移映射，per-line 区间下标保持有效
        expect(paginateLayout(inc, P_OPTS)).toEqual(paginateLayout(full, P_OPTS));
      }
    });
  }
});

describe('增量布局定向用例', () => {
  it('① 有序列表中段插删/改类型 → 编号链重算（orderedNum 指纹失配自动重建）', () => {
    const cache = new BlockLayoutCache();
    const rd = new RichDoc({
      blocks: [
        block('ordered_item', [text('aa')]),
        block('ordered_item', [text('bb')]),
        block('ordered_item', [text('cc')]),
      ],
    });
    cache.beginPass(EPOCH());
    layoutDoc(rd.doc, shaper, resolver, OPT, cache); // 暖缓存
    // 中段改类型 → 后续编号 3→1
    rd.setSel({ block: 1, offset: 0 });
    rd.setBlockType('paragraph');
    cache.beginPass(EPOCH());
    expect(layoutDoc(rd.doc, shaper, resolver, OPT, cache)).toEqual(layoutDoc(rd.doc, shaper, resolver, OPT));
    // 中段删除 → 编号链上移
    rd.deleteBlock(1);
    cache.beginPass(EPOCH());
    expect(layoutDoc(rd.doc, shaper, resolver, OPT, cache)).toEqual(layoutDoc(rd.doc, shaper, resolver, OPT));
    // 头部插入有序项 → 全链重编号
    rd.setSel({ block: 0, offset: 0 });
    rd.enter();
    rd.setSel({ block: 0, offset: 0 });
    rd.setBlockType('ordered_item');
    cache.beginPass(EPOCH());
    expect(layoutDoc(rd.doc, shaper, resolver, OPT, cache)).toEqual(layoutDoc(rd.doc, shaper, resolver, OPT));
  });

  it('② 连续代码块共享背景跨缓存命中边界正确合并', () => {
    const cache = new BlockLayoutCache();
    const rd = new RichDoc({
      blocks: [block('code_block', [text('l1')]), block('code_block', [text('l2')]), para([text('after')])],
    });
    cache.beginPass(EPOCH());
    layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    // 只编辑第二个代码块（第一块缓存命中）：合并背景仍是一整条且与全量一致
    rd.setSel({ block: 1, offset: 2 });
    rd.insertText('22');
    cache.beginPass(EPOCH());
    const inc = layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    const full = layoutDoc(rd.doc, shaper, resolver, OPT);
    expect(inc).toEqual(full);
    expect(inc.backgrounds.length).toBe(1); // 连续代码块共用一条背景
    // 中间插段落打断连续性 → 两条背景
    rd.setSel({ block: 0, offset: rd.blockLen(0) });
    rd.enter();
    rd.setSel({ block: 1, offset: 0 });
    rd.setBlockType('paragraph');
    cache.beginPass(EPOCH());
    const inc2 = layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    expect(inc2).toEqual(layoutDoc(rd.doc, shaper, resolver, OPT));
    expect(inc2.backgrounds.length).toBe(2);
  });

  it('③ 编辑 heading 文本/level/移动后 toc 行与 tocTarget 更新（toc 永不缓存）', () => {
    const cache = new BlockLayoutCache();
    const rd = new RichDoc({
      blocks: [
        block('heading', [text('AA')], { level: 1 }),
        block('toc', [text('')]),
        para([text('body')]),
        block('heading', [text('BB')], { level: 2 }),
      ],
    });
    cache.beginPass(EPOCH());
    layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    // 改标题文本
    rd.setSel({ block: 0, offset: 2 });
    rd.insertText('xx');
    cache.beginPass(EPOCH());
    let inc = layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    expect(inc).toEqual(layoutDoc(rd.doc, shaper, resolver, OPT));
    const tocLines = inc.lines.filter((l) => l.block === 1);
    expect(tocLines.map((l) => l.tocTarget)).toEqual([0, 3]);
    // 移动末尾 heading 到文首 → tocTarget 块号随 splice 漂移后仍正确（块号装配层重盖）
    rd.moveBlock(3, 0);
    cache.beginPass(EPOCH());
    inc = layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    expect(inc).toEqual(layoutDoc(rd.doc, shaper, resolver, OPT));
    expect(inc.lines.filter((l) => l.block === 2).map((l) => l.tocTarget)).toEqual([0, 1]);
  });

  it('④ epoch 任一字段变化（width/scale/theme/shaper/atlasGen）→ 缓存整体失效全量重建', () => {
    const counting = new CountingShaper();
    const cache = new BlockLayoutCache();
    const doc: Doc = { blocks: [para([text('one')]), para([text('two')]), para([text('three')])] };
    const epochOf = (over: Partial<LayoutEpoch>): LayoutEpoch => ({ ...EPOCH(counting), ...over });

    cache.beginPass(epochOf({}));
    layoutDoc(doc, counting, resolver, OPT, cache);
    const warm = counting.calls;
    expect(warm).toBe(3); // 3 个文本块各 1 次整形

    // epoch 不变：全命中，零整形
    cache.beginPass(epochOf({}));
    layoutDoc(doc, counting, resolver, OPT, cache);
    expect(counting.calls).toBe(warm);

    // 逐字段变化 → 每次全量重建（再 +3）
    let expected = warm;
    for (const over of [
      { atlasGen: 1 },
      { theme: 'dark' },
      { scale: 2 },
      { width: OPT.width + 8 },
      { shaper: new FakeShaper() as Shaper },
    ] as Partial<LayoutEpoch>[]) {
      cache.beginPass(epochOf(over));
      layoutDoc(doc, counting, resolver, OPT, cache);
      expected += 3;
      expect(counting.calls).toBe(expected);
      cache.beginPass(epochOf({})); // 回基准 epoch（又一次全清重建）
      layoutDoc(doc, counting, resolver, OPT, cache);
      expected += 3;
      expect(counting.calls).toBe(expected);
    }
  });

  it('⑤ 性能哨兵：单块编辑后仅受影响块被重新整形', () => {
    const counting = new CountingShaper();
    const cache = new BlockLayoutCache();
    const rd = new RichDoc({
      blocks: [para([text('p0')]), para([text('p1')]), para([text('p2')]), para([text('p3')]), para([text('p4')])],
    });
    cache.beginPass(EPOCH(counting));
    layoutDoc(rd.doc, counting, resolver, OPT, cache);
    counting.calls = 0;
    rd.setSel({ block: 2, offset: 2 });
    rd.insertText('X');
    cache.beginPass(EPOCH(counting));
    const inc = layoutDoc(rd.doc, counting, resolver, OPT, cache);
    expect(counting.calls).toBe(1); // 只有被编辑块重新整形
    expect(inc).toEqual(layoutDoc(rd.doc, new FakeShaper(), resolver, OPT));
  });

  it('blockVersion：touch 后版本失配 → cache.get 返回 null；未 touch 命中同一引用', () => {
    const cache = new BlockLayoutCache();
    const rd = new RichDoc({ blocks: [para([text('zz')])] });
    const blk = rd.doc.blocks[0];
    cache.beginPass(EPOCH());
    layoutDoc(rd.doc, shaper, resolver, OPT, cache);
    const v0 = blockVersion(blk);
    expect(cache.get(blk, v0, 0)).not.toBeNull();
    rd.setSel({ block: 0, offset: 0 });
    rd.insertText('a'); // touch → 版本前进
    expect(blockVersion(blk)).toBeGreaterThan(v0);
    // 以当前版本查询：缓存几何仍是旧版本（geom.version=v0）→ 失配返回 null（陈旧不命中）
    expect(cache.get(blk, blockVersion(blk), 0)).toBeNull();
  });
});

describe('visibleLineRange：可见行窗口二分（±1 行缓冲）', () => {
  // 10 行，每行高 20：行 i = [i*20, i*20+20)
  const tops = Float64Array.from({ length: 10 }, (_, i) => i * 20);
  const bottoms = Float64Array.from({ length: 10 }, (_, i) => i * 20 + 20);

  it('视口覆盖中段 → 窗口含相交行 ±1 缓冲', () => {
    // 视口 [50, 130)：相交行 2..6（top<130 且 bottom>50），缓冲后 [1, 8)
    expect(visibleLineRange(tops, bottoms, 50, 130)).toEqual([1, 8]);
  });

  it('视口在文档顶 → i0 夹到 0', () => {
    // 视口 [0, 40)：相交行 0..1；top 恰等于视口底的行 2 多含一行（设计内无害）+1 缓冲 → [0, 4)
    expect(visibleLineRange(tops, bottoms, 0, 40)).toEqual([0, 4]);
  });

  it('视口越过文档底 → i1 夹到行数', () => {
    expect(visibleLineRange(tops, bottoms, 180, 400)).toEqual([8, 10]);
  });

  it('视口完全在文档下方 → 空窗（仅尾部缓冲行）', () => {
    const [i0, i1] = visibleLineRange(tops, bottoms, 1000, 1200);
    expect(i1).toBe(10);
    expect(i1 - i0).toBeLessThanOrEqual(1); // 至多尾部 1 行缓冲
  });

  it('空 lines → [0,0)', () => {
    expect(visibleLineRange(new Float64Array(0), new Float64Array(0), 0, 100)).toEqual([0, 0]);
  });

  it('行边界恰落在视口边 → 不漏行（含缓冲）', () => {
    // 视口 [40, 60)：恰为行 2 的 [top, bottom)；行 2 必在窗内
    const [i0, i1] = visibleLineRange(tops, bottoms, 40, 60);
    expect(i0).toBeLessThanOrEqual(2);
    expect(i1).toBeGreaterThan(2);
  });
});

describe('paginate 契约：per-line 几何区间在分页平移后保持有效', () => {
  it('分页后每行 [glyphStart, glyphEnd) 的字形 baselineY 仍落在该行 (top, bottom) 内', () => {
    const doc: Doc = {
      blocks: Array.from({ length: 30 }, (_, i) => para([text(`paragraph ${i} 内容文字`)])),
    };
    const L = layoutDoc(doc, shaper, resolver, OPT);
    const { layout: paged, pages } = paginateLayout(L, P_OPTS);
    expect(pages.length).toBeGreaterThan(1); // 确实发生了分页平移
    // lines/glyphs 为 1:1 平移映射 → 区间下标有效：每行区间内字形的基线在行盒内
    let checked = 0;
    for (const ln of paged.lines) {
      for (let k = ln.glyphStart ?? 0, e = ln.glyphEnd ?? 0; k < e; k++) {
        const g = paged.glyphs[k];
        expect(g.baselineY).toBeGreaterThan(ln.top);
        expect(g.baselineY).toBeLessThan(ln.bottom);
        checked++;
      }
    }
    expect(checked).toBe(paged.glyphs.length); // 区间并集覆盖全部字形（无遗漏/重叠错位）
    // 平移单调不减 → lines top/bottom 单调性保持（visibleLineRange 对 word 视图可用）
    for (let i = 1; i < paged.lines.length; i++) {
      expect(paged.lines[i].top).toBeGreaterThanOrEqual(paged.lines[i - 1].top);
      expect(paged.lines[i].bottom).toBeGreaterThanOrEqual(paged.lines[i - 1].bottom);
    }
  });
});

describe('selectionRects 行窗参数：窗口结果 = 全量结果中落在窗内的行', () => {
  it('行窗内逐行矩形与全量一致；缺省参数 = 全量（旧调用兼容）', () => {
    const doc: Doc = {
      blocks: [para([text('aaaa bbbb cccc dddd eeee ffff')]), para([text('gggg hhhh')])],
    };
    const L = layoutDoc(doc, shaper, resolver, { width: 120, padL: 10, padT: 0, dpr: 1 });
    expect(L.lines.length).toBeGreaterThan(3);
    const from: Pos = { block: 0, offset: 0 };
    const to: Pos = { block: 1, offset: 5 };
    const full = selectionRects(L, from, to);
    expect(selectionRects(L, from, to, 0, L.lines.length)).toEqual(full);
    // 任意子窗：结果 = 全量中 y 落在子窗行 [top,bottom) 的子集（行序保持）
    const i0 = 1,
      i1 = 3;
    const windowed = selectionRects(L, from, to, i0, i1);
    const tops = new Set(L.lines.slice(i0, i1).map((l) => Math.round(l.top)));
    expect(windowed).toEqual(full.filter((r) => tops.has(r.y)));
  });
});
