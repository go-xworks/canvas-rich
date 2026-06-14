import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseHtml, withSpanStyle } from '../import';
import { Block, BlockAttrs, Inline, TableCell, cellText } from '../../model/schema';
import { toMarkdown, toHtml } from '../../model/export';

// 把块摘成易断言形式：[类型, 纯文本, attrs]。
const blockSummary = (b: Block): { type: string; text: string; attrs: BlockAttrs } => ({
  type: b.type,
  text: b.inlines.map((r) => r.text).join(''),
  attrs: b.attrs,
});
// 把行内段摘成 [text, "type1,type2"] 列表（marks 类型集合）。
const inlineSummary = (inls: Inline[]): [string, string][] =>
  inls.map((r) => [r.text, r.marks.map((m) => m.type).join(',')]);
// 把富单元格 rows 摘回纯文本二维数组（断言迁移：rows 已升级为 TableCell[][]）。
const rowsText = (rows: TableCell[][] | undefined): string[][] =>
  (rows ?? []).map((row) => row.map(cellText));

describe('parseMarkdown — 块级', () => {
  it('标题 # .. ###### → heading level 1-6', () => {
    const doc = parseMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6');
    expect(doc.blocks.map((b) => [b.type, b.attrs.level])).toEqual([
      ['heading', 1], ['heading', 2], ['heading', 3],
      ['heading', 4], ['heading', 5], ['heading', 6],
    ]);
    expect(doc.blocks[0].inlines.map((r) => r.text).join('')).toBe('H1');
  });

  it('无序列表 -/*/+ → bullet_item', () => {
    const doc = parseMarkdown('- a\n* b\n+ c');
    expect(doc.blocks.map(blockSummary).map((b) => [b.type, b.text])).toEqual([
      ['bullet_item', 'a'], ['bullet_item', 'b'], ['bullet_item', 'c'],
    ]);
  });

  it('有序列表 1. 2) → ordered_item', () => {
    const doc = parseMarkdown('1. one\n2) two');
    expect(doc.blocks.map((b) => b.type)).toEqual(['ordered_item', 'ordered_item']);
    expect(doc.blocks[1].inlines.map((r) => r.text).join('')).toBe('two');
  });

  it('任务列表 - [ ] / - [x] → task_item + checked', () => {
    const doc = parseMarkdown('- [ ] todo\n- [x] done\n- [X] DONE');
    expect(doc.blocks.map((b) => [b.type, b.attrs.checked])).toEqual([
      ['task_item', false], ['task_item', true], ['task_item', true],
    ]);
    expect(doc.blocks[0].inlines.map((r) => r.text).join('')).toBe('todo');
  });

  it('引用 > → blockquote', () => {
    const doc = parseMarkdown('> quoted line');
    expect(blockSummary(doc.blocks[0])).toMatchObject({ type: 'blockquote', text: 'quoted line' });
  });

  it('围栏代码块 ``` → 逐行 code_block', () => {
    const doc = parseMarkdown('```js\nconst a = 1;\nconst b = 2;\n```');
    expect(doc.blocks.map((b) => b.type)).toEqual(['code_block', 'code_block']);
    expect(doc.blocks.map((b) => b.inlines[0].text)).toEqual(['const a = 1;', 'const b = 2;']);
  });

  it('代码块内不解析行内 marks', () => {
    const doc = parseMarkdown('```\n**not bold**\n```');
    expect(doc.blocks[0].inlines[0].text).toBe('**not bold**');
    expect(doc.blocks[0].inlines[0].marks).toEqual([]);
  });

  it('分隔线 --- → 段落占位', () => {
    const doc = parseMarkdown('above\n\n---\n\nbelow');
    expect(doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(doc.blocks[1].inlines[0].text).toBe('———');
  });

  it('空行分隔多个段落', () => {
    const doc = parseMarkdown('para one\n\npara two');
    expect(doc.blocks.map((b) => b.inlines[0].text)).toEqual(['para one', 'para two']);
  });

  it('空输入 → 单个空段落', () => {
    const doc = parseMarkdown('');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].type).toBe('paragraph');
  });
});

describe('parseMarkdown — 行内 marks', () => {
  it('**粗** *斜* ~~删~~ `码` ==高亮==', () => {
    const doc = parseMarkdown('a **b** c *d* e ~~f~~ g `h` i ==j==');
    expect(inlineSummary(doc.blocks[0].inlines)).toEqual([
      ['a ', ''], ['b', 'bold'], [' c ', ''], ['d', 'italic'], [' e ', ''],
      ['f', 'strikethrough'], [' g ', ''], ['h', 'code'], [' i ', ''], ['j', 'highlight'],
    ]);
  });

  it('__粗__ 与 _斜_ 下划线定界符', () => {
    const doc = parseMarkdown('__bold__ and _italic_');
    expect(inlineSummary(doc.blocks[0].inlines)).toEqual([
      ['bold', 'bold'], [' and ', ''], ['italic', 'italic'],
    ]);
  });

  it('嵌套 ***粗斜***', () => {
    const doc = parseMarkdown('***x***');
    const m = doc.blocks[0].inlines[0].marks.map((mm) => mm.type).sort();
    expect(doc.blocks[0].inlines[0].text).toBe('x');
    expect(m).toEqual(['bold', 'italic']);
  });

  it('链接 [文](url) → link mark + href', () => {
    const doc = parseMarkdown('see [docs](https://example.com) here');
    const inl = doc.blocks[0].inlines;
    const link = inl.find((r) => r.text === 'docs');
    expect(link?.marks[0]).toEqual({ type: 'link', attrs: { href: 'https://example.com' } });
  });

  it('链接内仍解析强调', () => {
    const doc = parseMarkdown('[**bold link**](https://x.io)');
    const r = doc.blocks[0].inlines[0];
    expect(r.text).toBe('bold link');
    expect(r.marks.map((m) => m.type).sort()).toEqual(['bold', 'link']);
    expect(r.marks.find((m) => m.type === 'link')?.attrs).toEqual({ href: 'https://x.io' });
  });

  it('危险协议链接 [x](javascript:…) 丢弃 link mark、保留内层文本', () => {
    const doc = parseMarkdown('a [evil](javascript:alert(1)) b');
    const inl = doc.blocks[0].inlines;
    const evil = inl.find((r) => r.text === 'evil'); // 文本保留
    expect(evil).toBeTruthy();
    expect(evil?.marks.some((m) => m.type === 'link')).toBe(false); // 但无 link mark
    // 导出 HTML 不含可点 <a>（导入端已拦截，导出端再防一层）
    expect(toHtml(doc)).not.toContain('javascript:');
    expect(toHtml(doc)).not.toContain('<a ');
  });

  it('toHtml 对程序化构造的危险 href 兜底不产 <a>（导出防线）', () => {
    // 绕过导入直接构造带危险 href 的 link mark，验证导出端独立防护
    const doc = parseMarkdown('x');
    doc.blocks[0].inlines = [{ kind: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }];
    const html = toHtml(doc);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('x'); // 文本仍在
  });

  it('转义 \\* 不触发斜体', () => {
    const doc = parseMarkdown('a \\*b\\* c');
    expect(doc.blocks[0].inlines.map((r) => r.text).join('')).toBe('a *b* c');
    expect(doc.blocks[0].inlines.every((r) => r.marks.length === 0)).toBe(true);
  });

  it('无闭合定界符按字面保留', () => {
    const doc = parseMarkdown('a *b c');
    expect(inlineSummary(doc.blocks[0].inlines)).toEqual([['a *b c', '']]);
  });

  it('行内图片 ![](url) → 行内原子（kind=atom）', () => {
    const doc = parseMarkdown('pic ![](https://e.com/x.png) here');
    const inls = doc.blocks[0].inlines;
    const atom = inls.find((r) => r.kind === 'atom');
    expect(atom).toBeDefined();
    expect(atom!.kind).toBe('atom');
    if (atom!.kind === 'atom') {
      expect(atom!.atom).toBe('image');
      expect(atom!.attrs.src).toBe('https://e.com/x.png');
    }
    // 块仍是段落（图片在行内文本中，未独占一行）
    expect(doc.blocks[0].type).toBe('paragraph');
  });

  it('链接 href 经 decodeURIComponent 解码（%20→空格）', () => {
    const doc = parseMarkdown('[L](https://e.com/a%20b%2Fc)');
    const link = doc.blocks[0].inlines.find((r) => r.kind === 'text' && r.text === 'L');
    expect(link?.marks.find((m) => m.type === 'link')?.attrs).toEqual({ href: 'https://e.com/a b/c' });
  });
});

describe('parseMarkdown — 块级图片与表格', () => {
  it('独占一行的 ![](url) → 块级 image', () => {
    const doc = parseMarkdown('above\n\n![](https://e.com/pic.png)\n\nbelow');
    expect(doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(doc.blocks[1].attrs.src).toBe('https://e.com/pic.png');
  });

  it('块级图片 url 同样解码', () => {
    const doc = parseMarkdown('![](https://e.com/a%20b.png)');
    expect(doc.blocks[0].type).toBe('image');
    expect(doc.blocks[0].attrs.src).toBe('https://e.com/a b.png');
  });

  it('管道表格 → table 块（rows 矩形）', () => {
    const doc = parseMarkdown('| h1 | h2 |\n| --- | --- |\n| a | b |\n| c | d |');
    expect(doc.blocks[0].type).toBe('table');
    expect(rowsText(doc.blocks[0].attrs.rows)).toEqual([['h1', 'h2'], ['a', 'b'], ['c', 'd']]);
  });

  it('表格行列数不齐 → 补空串成矩形', () => {
    const doc = parseMarkdown('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |');
    expect(rowsText(doc.blocks[0].attrs.rows)).toEqual([['a', 'b', 'c'], ['1', '2', '']]);
  });

  it('缺分隔行的管道行不识别为表格（降级段落）', () => {
    const doc = parseMarkdown('| a | b |\n| c | d |');
    expect(doc.blocks.every((b) => b.type === 'paragraph')).toBe(true);
  });

  it('单元格内 <br>（含 <br/> 与大写）还原为 \\n（与导出互逆）', () => {
    const doc = parseMarkdown('| a<br>b | c<br/>d |\n| --- | --- |\n| e<BR>f |  |');
    expect(rowsText(doc.blocks[0].attrs.rows)).toEqual([['a\nb', 'c\nd'], ['e\nf', '']]);
  });

  it('含换行单元格的 MD 表格 round-trip 保真（\\n ↔ <br>）', () => {
    const md = '| a<br>b | c |\n| --- | --- |\n| d | e<br><br>f |';
    const doc = parseMarkdown(md);
    expect(rowsText(doc.blocks[0].attrs.rows)).toEqual([['a\nb', 'c'], ['d', 'e\n\nf']]);
    expect(toMarkdown(doc)).toBe(md); // 导出端 '\n' → '<br>'，往返幂等
  });
});

describe('parseMarkdown ↔ toMarkdown round-trip', () => {
  // toMarkdown 以空行分隔每个块（含相邻列表项），故 round-trip 用其规范形式做幂等校验。
  const canonical = [
    '# Title',
    'Body with **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.com).',
    '- bullet one',
    '- bullet two',
    '1. first',
    '2. second',
    '- [ ] open task',
    '- [x] done task',
    '> a quote',
    '```\nline a\nline b\n```',
  ].join('\n\n');

  it('标题/列表/任务/引用/代码/行内 marks 解析后再导出回相同 Markdown', () => {
    expect(toMarkdown(parseMarkdown(canonical))).toBe(canonical);
  });

  it('块类型与 attrs 正确还原', () => {
    const doc = parseMarkdown(canonical);
    expect(doc.blocks.map((b) => b.type)).toEqual([
      'heading', 'paragraph', 'bullet_item', 'bullet_item',
      'ordered_item', 'ordered_item', 'task_item', 'task_item',
      'blockquote', 'code_block', 'code_block',
    ]);
    expect(doc.blocks[0].attrs.level).toBe(1);
    expect(doc.blocks.filter((b) => b.type === 'task_item').map((b) => b.attrs.checked)).toEqual([false, true]);
  });

  // 集群3：fontFamily/fontSize（<span style> 兜底）、上/下标、下划线、高亮、图片、表格全程 MD↔MD 幂等。
  const extras = [
    'Font <span style="font-family:Georgia">serif</span> and size <span style="font-size:24px">big</span>.',
    'Math H<sub>2</sub>O and E=mc<sup>2</sup> plus <u>under</u> and ==hl==.',
    '![](https://e.com/block.png)',
    'Line with ![](https://e.com/inline.png) inside.',
    '| h1 | h2 |\n| --- | --- |\n| a | b |',
  ].join('\n\n');

  it('fontFamily/fontSize/上下标/下划线/高亮/图片/表格 round-trip 幂等', () => {
    expect(toMarkdown(parseMarkdown(extras))).toBe(extras);
  });

  it('行内 fontFamily/fontSize mark 经 <span style> 兜底往返不丢', () => {
    // toMarkdown 把 fontFamily/fontSize 落为 <span style>，再次 parseMarkdown 视作字面文本但幂等。
    const md = toMarkdown(parseMarkdown('x <span style="font-size:18px">y</span> z'));
    expect(md).toBe('x <span style="font-size:18px">y</span> z');
  });

  it('行内/块级图片与表格的块类型还原', () => {
    const doc = parseMarkdown(extras);
    expect(doc.blocks.map((b) => b.type)).toEqual([
      'paragraph', 'paragraph', 'image', 'paragraph', 'table',
    ]);
    expect(doc.blocks[2].attrs.src).toBe('https://e.com/block.png');
    expect(doc.blocks[3].inlines.some((r) => r.kind === 'atom')).toBe(true);
    expect(rowsText(doc.blocks[4].attrs.rows)).toEqual([['h1', 'h2'], ['a', 'b']]);
  });
});

// HTML：仅在存在 DOMParser（浏览器）时完整验证；node 测试环境验证退化路径。
const hasDom = typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'function';
const describeHtml = hasDom ? describe : describe.skip;

describeHtml('parseHtml — 浏览器 DOMParser 路径', () => {
  it('h1-h6 / p / blockquote', () => {
    const doc = parseHtml('<h1>T</h1><h3>S</h3><p>body</p><blockquote>q</blockquote>');
    expect(doc.blocks.map((b) => [b.type, b.attrs.level ?? null, b.inlines.map((r) => r.text).join('')])).toEqual([
      ['heading', 1, 'T'], ['heading', 3, 'S'], ['paragraph', null, 'body'], ['blockquote', null, 'q'],
    ]);
  });

  it('ul / ol / li → bullet_item / ordered_item', () => {
    const doc = parseHtml('<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
    expect(doc.blocks.map((b) => [b.type, b.inlines.map((r) => r.text).join('')])).toEqual([
      ['bullet_item', 'a'], ['bullet_item', 'b'], ['ordered_item', 'c'],
    ]);
  });

  it('GFM 任务列表 checkbox → task_item + checked', () => {
    const doc = parseHtml('<ul><li><input type="checkbox" disabled /> open</li>'
      + '<li><input type="checkbox" disabled checked /> done</li></ul>');
    expect(doc.blocks.map((b) => [b.type, b.attrs.checked, b.inlines.map((r) => r.text).join('').trim()])).toEqual([
      ['task_item', false, 'open'], ['task_item', true, 'done'],
    ]);
  });

  it('pre>code → 逐行 code_block', () => {
    const doc = parseHtml('<pre><code>x = 1\ny = 2</code></pre>');
    expect(doc.blocks.map((b) => [b.type, b.inlines[0].text])).toEqual([
      ['code_block', 'x = 1'], ['code_block', 'y = 2'],
    ]);
  });

  it('strong/em/u/s/code/mark/sup/sub 行内 marks', () => {
    const doc = parseHtml('<p><strong>b</strong><em>i</em><u>u</u><s>s</s>'
      + '<code>c</code><mark>h</mark><sup>p</sup><sub>q</sub></p>');
    expect(inlineSummary(doc.blocks[0].inlines)).toEqual([
      ['b', 'bold'], ['i', 'italic'], ['u', 'underline'], ['s', 'strikethrough'],
      ['c', 'code'], ['h', 'highlight'], ['p', 'superscript'], ['q', 'subscript'],
    ]);
  });

  it('a[href] → link mark', () => {
    const doc = parseHtml('<p>see <a href="https://x.io">docs</a></p>');
    const link = doc.blocks[0].inlines.find((r) => r.text === 'docs');
    expect(link?.marks[0]).toEqual({ type: 'link', attrs: { href: 'https://x.io' } });
  });

  it('a[href] 经 decodeURIComponent 解码（%20→空格）', () => {
    const doc = parseHtml('<p><a href="https://x.io/a%20b">L</a></p>');
    const link = doc.blocks[0].inlines.find((r) => r.text === 'L');
    expect(link?.marks.find((m) => m.type === 'link')?.attrs).toEqual({ href: 'https://x.io/a b' });
  });

  it('span style font-family → fontFamily mark', () => {
    const doc = parseHtml('<p><span style="font-family:Georgia">g</span></p>');
    const r = doc.blocks[0].inlines.find((x) => x.text === 'g');
    expect(r?.marks.find((m) => m.type === 'fontFamily')?.attrs).toEqual({ fontFamily: 'Georgia' });
  });

  it('span style font-size → fontSize mark（剥 px 单位）', () => {
    const doc = parseHtml('<p><span style="font-size:24px">b</span></p>');
    const r = doc.blocks[0].inlines.find((x) => x.text === 'b');
    expect(r?.marks.find((m) => m.type === 'fontSize')?.attrs).toEqual({ size: '24' });
  });

  it('span style color 仍解析为 color mark', () => {
    const doc = parseHtml('<p><span style="color:red">r</span></p>');
    const r = doc.blocks[0].inlines.find((x) => x.text === 'r');
    expect(r?.marks.find((m) => m.type === 'color')).toBeDefined();
  });

  it('行内 <img> → 行内原子（带 width/height 数值）', () => {
    const doc = parseHtml('<p>a<img src="https://e.com/x.png" width="40" height="30" alt="">b</p>');
    const atom = doc.blocks[0].inlines.find((r) => r.kind === 'atom');
    expect(atom?.kind).toBe('atom');
    if (atom?.kind === 'atom') {
      expect(atom.atom).toBe('image');
      expect(atom.attrs).toEqual({ src: 'https://e.com/x.png', width: 40, height: 30 });
    }
    expect(doc.blocks[0].type).toBe('paragraph');
  });

  it('独立 <img> → 块级 image', () => {
    const doc = parseHtml('<img src="https://e.com/block.png" alt="" />');
    expect(doc.blocks[0].type).toBe('image');
    expect(doc.blocks[0].attrs.src).toBe('https://e.com/block.png');
  });

  it('<table> colspan/rowspan → table 块 + merges（网格重建）', () => {
    const doc = parseHtml(
      '<table>'
      + '<tr><td colspan="2">A</td><td>B</td></tr>'
      + '<tr><td rowspan="2">C</td><td>D</td><td>E</td></tr>'
      + '<tr><td>F</td><td>G</td></tr>'
      + '</table>',
    );
    expect(doc.blocks[0].type).toBe('table');
    expect(rowsText(doc.blocks[0].attrs.rows)).toEqual([['A', '', 'B'], ['C', 'D', 'E'], ['', 'F', 'G']]);
    expect(doc.blocks[0].attrs.merges).toEqual([
      { r: 0, c: 0, rowspan: 1, colspan: 2 },
      { r: 1, c: 0, rowspan: 2, colspan: 1 },
    ]);
  });

  it('简单 <table> 无合并 → 仅 rows', () => {
    const doc = parseHtml('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    expect(rowsText(doc.blocks[0].attrs.rows)).toEqual([['a', 'b'], ['c', 'd']]);
    expect(doc.blocks[0].attrs.merges).toBeUndefined();
  });

  it('toHtml→parseHtml 往返保 fontFamily/fontSize/上标/高亮（idempotent）', () => {
    const html = toHtml(parseHtml(
      '<p>p <span style="font-family:Georgia">s</span> '
      + '<span style="font-size:24px">b</span> <sup>u</sup> <mark>h</mark></p>',
    ));
    expect(toHtml(parseHtml(html))).toBe(html);
  });

  it('toHtml→parseHtml 表格往返幂等（含 colspan/rowspan）', () => {
    const html = toHtml(parseHtml(
      '<table>'
      + '<tr><td colspan="2">A</td><td>B</td></tr>'
      + '<tr><td rowspan="2">C</td><td>D</td><td>E</td></tr>'
      + '<tr><td>F</td><td>G</td></tr>'
      + '</table>',
    ));
    expect(toHtml(parseHtml(html))).toBe(html);
  });

  it('未识别块降级为段落纯文本', () => {
    const doc = parseHtml('<figure>caption text</figure>');
    expect(doc.blocks[0].type).toBe('paragraph');
    expect(doc.blocks[0].inlines.map((r) => r.text).join('')).toContain('caption text');
  });
});

describe('parseHtml — 无 DOMParser 退化路径', () => {
  it('剥标签按块切段（node 环境）', () => {
    if (hasDom) return; // 浏览器走 DOM 路径，跳过退化断言
    const doc = parseHtml('<h1>Title</h1><p>one</p><p>two</p>');
    expect(doc.blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(doc.blocks.map((b) => b.inlines[0].text)).toEqual(['Title', 'one', 'two']);
  });
});

describe('withSpanStyle — 导入端 style 值白名单（node 直测，无需 DOMParser）', () => {
  it('注入值（CSS 元字符）不产 color/fontFamily mark；合法 fontSize 仍剥 px 产 mark', () => {
    const marks = withSpanStyle([], {
      style: { color: 'x;position:fixed', fontFamily: 'Arial;inset:0', fontSize: '24px' },
    });
    expect(marks.map((m) => m.type)).toEqual(['fontSize']);
    expect(marks[0].attrs).toEqual({ size: '24' });
  });

  it('合法值照常产 mark（rgb() 颜色 + 引号族名）', () => {
    const marks = withSpanStyle([], {
      style: { color: 'rgb(31, 36, 48)', fontFamily: '"PingFang SC", sans-serif' },
    });
    expect(marks.map((m) => m.type).sort()).toEqual(['color', 'fontFamily']);
  });

  it('无 style / 空值：原样返回 base', () => {
    expect(withSpanStyle([], {})).toEqual([]);
    expect(withSpanStyle([], { style: {} })).toEqual([]);
  });
});
