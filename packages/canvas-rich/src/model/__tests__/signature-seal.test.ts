import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text } from '../schema';
import { isAtom } from '../block-specs';
import { toHtml, toMarkdown } from '../export';
import { sealSvg } from '../seal';

// 集群A：电子签名 / 印章原子块的插入（RichDoc）与导出映射（HTML / Markdown）。

const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='; // 手绘签名 PNG dataURL 占位

describe('RichDoc.insertSignature', () => {
  it('在光标块后插入 signature 原子块，带 src + 默认宽高（可缩放）+ 稳定 id，光标落其上', () => {
    const rd = new RichDoc(docOf(para([text('p0')]), para([text('p1')])));
    rd.setSel({ block: 0, offset: 2 });
    rd.insertSignature(PNG);
    expect(rd.doc.blocks).toHaveLength(3);
    const s = rd.doc.blocks[1];
    expect(s.type).toBe('signature');
    expect(isAtom(s.type)).toBe(true);
    expect(s.attrs.src).toBe(PNG);
    expect(typeof s.attrs.width).toBe('number');
    expect(typeof s.attrs.height).toBe('number');
    expect(typeof s.attrs.id).toBe('string'); // 覆盖层缓存键
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('插入进撤销栈，undo 移除签名', () => {
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.insertSignature(PNG);
    expect(rd.doc.blocks).toHaveLength(2);
    rd.undo();
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });
});

describe('RichDoc.insertSeal', () => {
  it('在光标块后插入 seal 原子块，带 text + 默认宽高 + 稳定 id，光标落其上', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertSeal('某某有限公司');
    expect(rd.doc.blocks).toHaveLength(2);
    const seal = rd.doc.blocks[1];
    expect(seal.type).toBe('seal');
    expect(isAtom(seal.type)).toBe(true);
    expect(seal.attrs.text).toBe('某某有限公司');
    expect(typeof seal.attrs.width).toBe('number');
    expect(typeof seal.attrs.height).toBe('number');
    expect(typeof seal.attrs.id).toBe('string');
    expect(rd.focus).toEqual({ block: 1, offset: 0 });
  });

  it('插入进撤销栈，undo 移除印章', () => {
    const rd = new RichDoc(docOf(para([text('a')])));
    rd.insertSeal('公司');
    expect(rd.doc.blocks).toHaveLength(2);
    rd.undo();
    expect(rd.doc.blocks).toHaveLength(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });
});

describe('export: signature → HTML / Markdown', () => {
  it('HTML：signature → <img alt="签名"> 带 src + 宽高', () => {
    const html = toHtml(docOf({ type: 'signature', attrs: { src: PNG, width: 220, height: 90 }, inlines: [text('')] }));
    expect(html).toContain(`<img src="${PNG}" width="220" height="90" alt="签名" />`);
  });

  it('HTML：src 中的引号/尖括号被转义（防注入）', () => {
    const html = toHtml(docOf({ type: 'signature', attrs: { src: 'a"><script>' }, inlines: [text('')] }));
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('Markdown：signature → 图片语法 ![签名](src)', () => {
    const md = toMarkdown(docOf({ type: 'signature', attrs: { src: PNG }, inlines: [text('')] }));
    expect(md).toContain(`![签名](${PNG})`);
  });
});

describe('export: seal → HTML / Markdown', () => {
  it('HTML：seal → 内联红色公章 SVG（与 sealSvg 一致，含印章文字）', () => {
    const html = toHtml(docOf({ type: 'seal', attrs: { text: '测试公司' }, inlines: [text('')] }));
    expect(html).toContain(sealSvg('测试公司'));
    expect(html).toContain('测试公司');
    expect(html).toContain('<svg');
  });

  it('HTML：无文字的 seal 输出占位文本（不产空 SVG）', () => {
    const html = toHtml(docOf({ type: 'seal', attrs: {}, inlines: [text('')] }));
    expect(html).toContain('[印章]');
  });

  it('Markdown：seal → 占位文本 [印章：文字]', () => {
    const md = toMarkdown(docOf({ type: 'seal', attrs: { text: '某某公司' }, inlines: [text('')] }));
    expect(md).toContain('[印章：某某公司]');
  });
});
