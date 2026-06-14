import { describe, it, expect } from 'vitest';
import { scanToc, ensureHeadingId } from '../toc';
import { RichDoc } from '../rich-document';
import { Doc, block, para, text } from '../schema';
import { toHtml, toMarkdown } from '../export';

// TOC：heading 自动补稳定 id、scanToc 扫描生成条目、insertToc、导出目录与锚点。

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('ensureHeadingId', () => {
  it('缺 id 时就地补一个稳定 id，已有则不变', () => {
    const h = block('heading', [text('A')], { level: 1 });
    expect(h.attrs.id).toBeUndefined();
    const id1 = ensureHeadingId(h);
    expect(id1).toBeTruthy();
    expect(h.attrs.id).toBe(id1);
    const id2 = ensureHeadingId(h); // 幂等
    expect(id2).toBe(id1);
  });
});

describe('scanToc', () => {
  it('按文档序抽取全部 heading（文本/级别/块号/id）', () => {
    const d = doc(
      block('heading', [text('Intro')], { level: 1 }),
      para([text('body')]),
      block('heading', [text('Details')], { level: 2 }),
      block('heading', [text('Sub')], { level: 3 }),
    );
    const entries = scanToc(d, true);
    expect(entries.map((e) => e.text)).toEqual(['Intro', 'Details', 'Sub']);
    expect(entries.map((e) => e.level)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.block)).toEqual([0, 2, 3]);
    // 每条都带稳定 id，且与块 attrs.id 一致
    for (const e of entries) {
      expect(e.id).toBeTruthy();
      expect(d.blocks[e.block].attrs.id).toBe(e.id);
    }
  });

  it('级别夹回 1..6', () => {
    const d = doc(block('heading', [text('X')], { level: 1 }));
    d.blocks[0].attrs.level = 9 as unknown as 1; // 越界
    expect(scanToc(d, true)[0].level).toBe(6);
  });

  it('assignIds=false 时不写入 id（只读扫描）', () => {
    const d = doc(block('heading', [text('A')], { level: 1 }));
    const entries = scanToc(d, false);
    expect(d.blocks[0].attrs.id).toBeUndefined();
    expect(entries[0].id).toBe('');
  });

  it('无 heading 时返回空数组', () => {
    expect(scanToc(doc(para([text('only body')])), true)).toEqual([]);
  });
});

describe('RichDoc.insertToc', () => {
  it('在焦点块之后插入一个 toc 块并把光标移上去', () => {
    const rd = new RichDoc(doc(block('heading', [text('H')], { level: 1 }), para([text('p')])));
    rd.setSel({ block: 0, offset: 0 });
    rd.insertToc();
    expect(rd.blockCount).toBe(3);
    expect(rd.doc.blocks[1].type).toBe('toc');
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
    expect(rd.canUndo).toBe(true);
  });
});

describe('export TOC + heading id', () => {
  it('toHtml：toc 块输出 nav 标题链接，heading 带 id 锚点', () => {
    const d = doc(
      block('heading', [text('Title')], { level: 1, id: 'h-title' }),
      { type: 'toc', attrs: {}, inlines: [text('')] },
      block('heading', [text('More')], { level: 2, id: 'h-more' }),
    );
    const html = toHtml(d);
    expect(html).toContain('<h1 id="h-title">Title</h1>');
    expect(html).toContain('<nav class="toc"');
    expect(html).toContain('<a href="#h-title">Title</a>');
    expect(html).toContain('<a href="#h-more">More</a>');
  });

  it('toMarkdown：toc 块输出按级缩进的标题列表', () => {
    const d = doc(
      block('heading', [text('Top')], { level: 1 }),
      { type: 'toc', attrs: {}, inlines: [text('')] },
      block('heading', [text('Nested')], { level: 2 }),
    );
    const md = toMarkdown(d);
    expect(md).toContain('- Top');
    expect(md).toContain('  - Nested'); // level 2 → 缩进 2 空格
  });
});

describe('export 列表 depth 缩进', () => {
  it('toMarkdown 按 depth 缩进列表项（每级 2 空格）', () => {
    const d = doc(
      block('bullet_item', [text('a')]),
      block('bullet_item', [text('b')], { depth: 1 }),
      block('bullet_item', [text('c')], { depth: 2 }),
    );
    const md = toMarkdown(d);
    expect(md).toContain('- a');
    expect(md).toContain('  - b');
    expect(md).toContain('    - c');
  });

  it('toHtml 按 depth 给 li 加 margin-left', () => {
    const d = doc(
      block('bullet_item', [text('a')]),
      block('bullet_item', [text('b')], { depth: 2 }),
    );
    const html = toHtml(d);
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('margin-left:3em'); // depth 2 → 2 * 1.5em
  });
});
