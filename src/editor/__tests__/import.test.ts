import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseHtml } from '../import';
import { Block, BlockAttrs, Inline } from '../../model/schema';
import { toMarkdown } from '../../model/export';

// 把块摘成易断言形式：[类型, 纯文本, attrs]。
const blockSummary = (b: Block): { type: string; text: string; attrs: BlockAttrs } => ({
  type: b.type,
  text: b.inlines.map((r) => r.text).join(''),
  attrs: b.attrs,
});
// 把行内段摘成 [text, "type1,type2"] 列表（marks 类型集合）。
const inlineSummary = (inls: Inline[]): [string, string][] =>
  inls.map((r) => [r.text, r.marks.map((m) => m.type).join(',')]);

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

  it('转义 \\* 不触发斜体', () => {
    const doc = parseMarkdown('a \\*b\\* c');
    expect(doc.blocks[0].inlines.map((r) => r.text).join('')).toBe('a *b* c');
    expect(doc.blocks[0].inlines.every((r) => r.marks.length === 0)).toBe(true);
  });

  it('无闭合定界符按字面保留', () => {
    const doc = parseMarkdown('a *b c');
    expect(inlineSummary(doc.blocks[0].inlines)).toEqual([['a *b c', '']]);
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
