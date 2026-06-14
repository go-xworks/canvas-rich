import { describe, it, expect } from 'vitest';
import { docStats, docCharCount } from '../doc-stats';
import { scanToc } from '../toc';
import { Doc, block, para, text } from '../schema';

// 文档统计（段落数/字数）与 heading 列表提取（scanToc）纯函数单测，供状态栏/大纲面板复用。

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('docStats', () => {
  it('空文档：0 段 0 字', () => {
    expect(docStats(doc())).toEqual({ blocks: 0, chars: 0 });
  });

  it('段落数 = 块数（含原子块），字数 = 各块文本长度之和', () => {
    const d = doc(
      block('heading', [text('标题')], { level: 1 }), // 2 字
      para([text('hello '), text('world', [{ type: 'bold' }])]), // 11 字（含空格）
      block('bullet_item', [text('item')]), // 4 字
      { type: 'image', attrs: { src: 'x' }, inlines: [text('')] }, // 原子块，0 字但计入块数
    );
    const s = docStats(d);
    expect(s.blocks).toBe(4);
    expect(s.chars).toBe(2 + 11 + 4 + 0);
  });

  it('docCharCount 与 docStats.chars 一致', () => {
    const d = doc(para([text('abc')]), para([text('de')]));
    expect(docCharCount(d)).toBe(5);
    expect(docCharCount(d)).toBe(docStats(d).chars);
  });

  it('多行内段拼接长度正确', () => {
    const d = doc(para([text('a'), text('bb'), text('ccc')]));
    expect(docStats(d)).toEqual({ blocks: 1, chars: 6 });
  });
});

describe('heading 列表提取（scanToc 只读）', () => {
  it('按文档序抽取 heading 文本/级别/块号，跳过非 heading', () => {
    const d = doc(
      block('heading', [text('Intro')], { level: 1 }),
      para([text('body')]),
      block('heading', [text('Details')], { level: 2 }),
      block('bullet_item', [text('x')]),
      block('heading', [text('Sub')], { level: 3 }),
    );
    const entries = scanToc(d, false);
    expect(entries.map((e) => e.text)).toEqual(['Intro', 'Details', 'Sub']);
    expect(entries.map((e) => e.level)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.block)).toEqual([0, 2, 4]);
  });

  it('无 heading → 空列表', () => {
    const d = doc(para([text('a')]), block('bullet_item', [text('b')]));
    expect(scanToc(d, false)).toEqual([]);
  });

  it('只读扫描（assignIds=false）不给 heading 写入 id（无副作用）', () => {
    const h = block('heading', [text('A')], { level: 1 });
    const d = doc(h);
    scanToc(d, false);
    expect(h.attrs.id).toBeUndefined();
  });
});
