import { describe, it, expect } from 'vitest';
import { domToInlines, CellDomNode } from '../cell-dom';
import { Inline, Mark, text } from '../../model/schema';
import { inlinesToCellHtml } from '../../model/export';

// domToInlines 纯解析单测：CellDomNode 是 DOM Node 的结构子集，node 环境用纯对象构造树即可，
// 无需真实 DOM/DOMParser（与 import.test.ts 的 HTML 解析 skip 门控不同，这里恒可跑）。

// —— 结构节点构造器 ——
const t = (s: string): CellDomNode => ({ nodeType: 3, textContent: s, childNodes: [] });
const el = (
  tag: string, children: CellDomNode[],
  opts: { attrs?: Record<string, string>; style?: { color?: string; fontSize?: string; fontFamily?: string } } = {},
): CellDomNode => ({
  nodeType: 1, tagName: tag, textContent: null, childNodes: children,
  getAttribute: (name: string) => opts.attrs?.[name] ?? null,
  style: opts.style,
});
const td = (...children: CellDomNode[]): CellDomNode => el('TD', children);

// 摘成 [text, "type1,type2"] 列表便于断言。
const summary = (inls: Inline[]): [string, string][] =>
  inls.map((r) => [r.text, r.marks.map((m) => m.type).join(',')]);

describe('domToInlines — 文本与标签 marks', () => {
  it('plain text becomes a single unmarked run', () => {
    expect(summary(domToInlines(td(t('hello'))))).toEqual([['hello', '']]);
  });

  it('maps STRONG/B/EM/I/U/S/STRIKE/DEL/MARK/CODE/SUP/SUB to marks', () => {
    const root = td(
      el('STRONG', [t('a')]), el('EM', [t('b')]), el('U', [t('c')]),
      el('DEL', [t('d')]), el('MARK', [t('e')]), el('CODE', [t('f')]),
      el('SUP', [t('g')]), el('SUB', [t('h')]),
    );
    expect(summary(domToInlines(root))).toEqual([
      ['a', 'bold'], ['b', 'italic'], ['c', 'underline'], ['d', 'strikethrough'],
      ['e', 'highlight'], ['f', 'code'], ['g', 'superscript'], ['h', 'subscript'],
    ]);
  });

  it('treats B/I/STRIKE synonyms identically and merges adjacent same-marks runs', () => {
    const root = td(el('STRONG', [t('a')]), el('B', [t('b')]));
    expect(summary(domToInlines(root))).toEqual([['ab', 'bold']]); // normalizeInlines 合并
    expect(summary(domToInlines(td(el('S', [t('x')]), el('STRIKE', [t('y')])))))
      .toEqual([['xy', 'strikethrough']]);
  });

  it('stacks marks across nesting (strong > em)', () => {
    const root = td(el('STRONG', [el('EM', [t('x')])]));
    const [run] = domToInlines(root);
    expect(run.text).toBe('x');
    expect(run.marks.map((m) => m.type).sort()).toEqual(['bold', 'italic']);
  });

  it('ignores unknown tags but recurses into their children', () => {
    const root = td(el('FONT', [t('a'), el('STRONG', [t('b')])]));
    expect(summary(domToInlines(root))).toEqual([['a', ''], ['b', 'bold']]);
  });
});

describe('domToInlines — span 样式与链接', () => {
  it('reads span style color / font-family / font-size (px stripped)', () => {
    const root = td(el('SPAN', [t('x')], { style: { color: 'red', fontFamily: 'Georgia', fontSize: '24px' } }));
    const [run] = domToInlines(root);
    expect(run.marks).toEqual([
      { type: 'fontFamily', attrs: { fontFamily: 'Georgia' } },
      { type: 'fontSize', attrs: { size: '24' } },
      { type: 'color', attrs: { color: 'red' } },
    ]);
  });

  it('restores a link mark from span[data-href] (cell-html degraded link)', () => {
    const root = td(el('SPAN', [t('L')], { attrs: { 'data-href': 'https://e.com' } }));
    const [run] = domToInlines(root);
    expect(run.marks).toEqual([{ type: 'link', attrs: { href: 'https://e.com' } }]);
  });

  it('reads a pasted real <a href> as a link mark', () => {
    const root = td(el('A', [t('L')], { attrs: { href: 'https://x.io' } }));
    const [run] = domToInlines(root);
    expect(run.marks).toEqual([{ type: 'link', attrs: { href: 'https://x.io' } }]);
  });

  it('accepts a bare numeric font-size, rejects non-px units (pt/em — invariant: size 恒裸数值)', () => {
    const bare = domToInlines(td(el('SPAN', [t('x')], { style: { fontSize: '24' } })));
    expect(bare[0].marks).toEqual([{ type: 'fontSize', attrs: { size: '24' } }]);
    const pt = domToInlines(td(el('SPAN', [t('x')], { style: { fontSize: '12pt' } })));
    expect(pt[0].marks).toEqual([]); // 非 px 单位不产 mark（否则再写出拼成 '12ptpx' 破坏互逆）
    const em = domToInlines(td(el('SPAN', [t('x')], { style: { fontSize: '1.5em' } })));
    expect(em[0].marks).toEqual([]);
  });
});

describe('inlinesToCellHtml ↔ domToInlines — CSS 值形式互逆（集群3）', () => {
  it('color/fontSize/fontFamily 经写出的 style 形式回读还原原 marks（size 仍为裸数值）', () => {
    const marks: Mark[] = [
      { type: 'color', attrs: { color: '#ff0000' } },
      { type: 'fontSize', attrs: { size: '24' } },
      { type: 'fontFamily', attrs: { fontFamily: 'Georgia' } },
    ];
    const html = inlinesToCellHtml([text('x', marks)]);
    // 写出形式锚定：fontSize 带 px 后缀、color/fontFamily 原值
    expect(html).toBe('<span style="color:#ff0000"><span style="font-size:24px"><span style="font-family:Georgia">x</span></span></span>');
    // 按写出的嵌套 span/style 构造等价 DOM 树（浏览器解析后的 style 对象形态），回读应还原原 marks
    const root = td(el('SPAN', [
      el('SPAN', [
        el('SPAN', [t('x')], { style: { fontFamily: 'Georgia' } }),
      ], { style: { fontSize: '24px' } }),
    ], { style: { color: '#ff0000' } }));
    const [run] = domToInlines(root);
    expect(run.text).toBe('x');
    expect(run.marks).toEqual(text('x', marks).marks); // 同规范化排序逐项相等；size 无 px 残留
  });

  it('小数字号同样互逆（13.5 ↔ 13.5px）', () => {
    const html = inlinesToCellHtml([text('x', [{ type: 'fontSize', attrs: { size: '13.5' } }])]);
    expect(html).toBe('<span style="font-size:13.5px">x</span>');
    const [run] = domToInlines(td(el('SPAN', [t('x')], { style: { fontSize: '13.5px' } })));
    expect(run.marks).toEqual([{ type: 'fontSize', attrs: { size: '13.5' } }]);
  });
});

describe('domToInlines — 换行（BR 与 DIV/P 行边界）', () => {
  it('BR becomes \\n', () => {
    const out = domToInlines(td(t('a'), el('BR', []), t('b')));
    expect(out.map((r) => r.text).join('')).toBe('a\nb');
  });

  it('DIV-wrapped lines are joined with \\n (no leading newline for the first line)', () => {
    const out = domToInlines(td(el('DIV', [t('A')]), el('DIV', [t('B')])));
    expect(out.map((r) => r.text).join('')).toBe('A\nB');
    const mixed = domToInlines(td(t('A'), el('DIV', [t('B')])));
    expect(mixed.map((r) => r.text).join('')).toBe('A\nB');
  });

  it('an empty line (<div><br></div>) counts once: boundary \\n kept, placeholder BR skipped', () => {
    const out = domToInlines(td(t('A'), el('DIV', [el('BR', [])]), el('DIV', [t('B')])));
    expect(out.map((r) => r.text).join('')).toBe('A\n\nB');
  });

  it('keeps a trailing BR at the cell root (round-trip stable with inlinesToCellHtml)', () => {
    const out = domToInlines(td(t('A'), el('BR', [])));
    expect(out.map((r) => r.text).join('')).toBe('A\n');
  });

  it('a BR inside marks carries them harmlessly (merged by normalize)', () => {
    const out = domToInlines(td(el('STRONG', [t('a'), el('BR', []), t('b')])));
    expect(summary(out)).toEqual([['a\nb', 'bold']]);
  });
});

describe('domToInlines — 归一化', () => {
  it('an empty cell yields a single empty run (caret holder)', () => {
    expect(domToInlines(td())).toEqual([{ kind: 'text', text: '', marks: [] }]);
  });

  it('skips empty text nodes and non-element/non-text nodes (e.g. comments)', () => {
    const comment: CellDomNode = { nodeType: 8, textContent: 'c', childNodes: [] };
    expect(summary(domToInlines(td(t(''), comment, t('x'))))).toEqual([['x', '']]);
  });
});

describe('domToInlines — span style 值白名单（回写路径防 CSS 注入）', () => {
  it('注入 color/fontFamily（含 ; : ( )）不产 mark，文本保留', () => {
    const root = td(el('SPAN', [t('x')], {
      style: { color: 'red;position:fixed', fontFamily: 'Arial;background:url(http://evil)' },
    }));
    expect(summary(domToInlines(root))).toEqual([['x', '']]);
  });

  it('合法值照常产 mark（hex / rgb() / 引号族名）', () => {
    const root = td(el('SPAN', [t('x')], {
      style: { color: 'rgb(1, 2, 3)', fontFamily: '"Microsoft YaHei", sans-serif' },
    }));
    const [run] = domToInlines(root);
    expect(run.marks.map((m) => m.type).sort()).toEqual(['color', 'fontFamily']);
  });

  it('非法值往返单元格 HTML 不产 style（与 inlinesToCellHtml 导出防线对称）', () => {
    const inl: Inline[] = [text('x', [{ type: 'color', attrs: { color: 'x;position:fixed' } } as Mark])];
    expect(inlinesToCellHtml(inl)).toBe('x');
  });
});
