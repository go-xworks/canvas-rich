import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text } from '../schema';
import { isAtom } from '../block-specs';
import { toHtml, toMarkdown } from '../export';

// 集群B：可编辑浮动文本框原子块（textbox）的插入（RichDoc）与导出映射（HTML / Markdown）。
// DOM 编辑交互（contenteditable 回写）由 tsc + build 把关，此处只验证模型与序列化。

const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('RichDoc.insertTextbox', () => {
  it('在光标块后插入 textbox 原子块，带默认宽高 + 空内容 + 稳定 id，光标落其上', () => {
    const rd = new RichDoc(docOf(para([text('p0')]), para([text('p1')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertTextbox();
    expect(rd.doc.blocks).toHaveLength(3);
    const tb = rd.doc.blocks[1];
    expect(tb.type).toBe('textbox');
    expect(isAtom(tb.type)).toBe(true);
    expect(tb.attrs.content).toBe('');
    expect(tb.attrs.width).toBe(240);
    expect(tb.attrs.height).toBe(80);
    expect(typeof tb.attrs.id).toBe('string'); // 覆盖层缓存键
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('可带初始内容插入', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertTextbox('你好，文本框');
    const tb = rd.doc.blocks[1];
    expect(tb.type).toBe('textbox');
    expect(tb.attrs.content).toBe('你好，文本框');
  });

  it('插入进撤销栈，undo 移除文本框', () => {
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.insertTextbox('hi');
    expect(rd.doc.blocks).toHaveLength(2);
    rd.undo();
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });

  it('停在原子块上时在其后新建段落承载（不塞进原子块）', () => {
    // 复用 insertText 的原子块分支语义：先插文本框（光标落其上），再插另一个文本框。
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.insertTextbox('first');
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
    rd.insertTextbox('second');
    // 第二个文本框插在第一个之后
    expect(rd.doc.blocks).toHaveLength(3);
    expect(rd.doc.blocks[1].attrs.content).toBe('first');
    expect(rd.doc.blocks[2].attrs.content).toBe('second');
  });
});

describe('export: textbox → HTML', () => {
  it('textbox → <div class="textbox">content</div>', () => {
    const html = toHtml(docOf({ type: 'textbox', attrs: { content: '一段文字' }, inlines: [text('')] }));
    expect(html).toContain('<div class="textbox">一段文字</div>');
  });

  it('内容为空时输出空文本框 div', () => {
    const html = toHtml(docOf({ type: 'textbox', attrs: {}, inlines: [text('')] }));
    expect(html).toContain('<div class="textbox"></div>');
  });

  it('换行 \\n 转 <br>', () => {
    const html = toHtml(docOf({ type: 'textbox', attrs: { content: '第一行\n第二行' }, inlines: [text('')] }));
    expect(html).toContain('<div class="textbox">第一行<br>第二行</div>');
  });

  it('内容中的尖括号/and 符被转义（防注入）', () => {
    const html = toHtml(docOf({ type: 'textbox', attrs: { content: '<script>&"' }, inlines: [text('')] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;&amp;');
  });
});

describe('export: textbox → Markdown（兜底为段落）', () => {
  it('textbox → 纯文本段落', () => {
    const md = toMarkdown(
      docOf(
        para([text('before')]),
        { type: 'textbox', attrs: { content: '文本框内容' }, inlines: [text('')] },
        para([text('after')]),
      ),
    );
    expect(md).toContain('文本框内容');
    // 段落用空行分隔（toMarkdown join '\n\n'）
    expect(md).toContain('before\n\n文本框内容\n\nafter');
  });

  it('空内容文本框输出空段落', () => {
    const md = toMarkdown(docOf({ type: 'textbox', attrs: {}, inlines: [text('')] }));
    expect(md).toBe('');
  });
});
