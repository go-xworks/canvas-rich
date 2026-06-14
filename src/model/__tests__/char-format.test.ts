import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text, getMark, hasMarkType } from '../schema';
import { toHtml, toMarkdown } from '../export';

// 字符格式集群 A 的模型/导出行为：上标↔下标互斥切换、fontSize/fontFamily mark 落点、
// 以及 sup/sub/font 的 HTML/MD 导出映射。
const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

// 选区覆盖第 0 块的 [from,to)
function selectAllOf(rd: RichDoc): void {
  rd.setSel({ block: 0, offset: 0 });
  rd.setSel({ block: 0, offset: rd.blockLen(0) }, true);
}

describe('toggleExclusiveMark: 上标 ↔ 下标互斥', () => {
  it('开上标 → 再开下标：上标被移除，仅余下标', () => {
    const rd = new RichDoc(doc(para([text('x')])));
    selectAllOf(rd);
    rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']);
    expect(rd.markActive('superscript')).toBe(true);
    rd.toggleExclusiveMark('subscript', ['superscript', 'subscript']);
    expect(rd.markActive('subscript')).toBe(true);
    expect(rd.markActive('superscript')).toBe(false);
  });

  it('再次切换同一标 → 关闭', () => {
    const rd = new RichDoc(doc(para([text('x')])));
    selectAllOf(rd);
    rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']);
    rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']);
    expect(rd.markActive('superscript')).toBe(false);
  });

  it('折叠光标下：互斥写入 storedMarks', () => {
    const rd = new RichDoc(doc(para([text('x')])));
    rd.setSel({ block: 0, offset: 1 });
    rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']);
    expect(hasMarkType(rd.storedMarks ?? [], 'superscript')).toBe(true);
    rd.toggleExclusiveMark('subscript', ['superscript', 'subscript']);
    expect(hasMarkType(rd.storedMarks ?? [], 'subscript')).toBe(true);
    expect(hasMarkType(rd.storedMarks ?? [], 'superscript')).toBe(false);
  });

  it('互斥切换在选区下只产生一步撤销', () => {
    const rd = new RichDoc(doc(para([text('hello')])));
    selectAllOf(rd);
    rd.toggleExclusiveMark('superscript', ['superscript', 'subscript']);
    const before = rd.doc.blocks[0].inlines[0].marks.map((m) => m.type).sort();
    // 切到下标：应为单次快照，撤销一步回到上标态
    rd.toggleExclusiveMark('subscript', ['superscript', 'subscript']);
    rd.undo();
    const after = rd.doc.blocks[0].inlines[0].marks.map((m) => m.type).sort();
    expect(after).toEqual(before); // 回到「仅上标」
  });
});

describe('setMark: fontSize / fontFamily 写入 attrs', () => {
  it('fontSize mark 的 size 进 attrs', () => {
    const rd = new RichDoc(doc(para([text('abc')])));
    selectAllOf(rd);
    rd.setMark('fontSize', { size: '24' });
    expect(getMark(rd.doc.blocks[0].inlines[0].marks, 'fontSize')?.attrs?.size).toBe('24');
  });

  it('fontFamily mark 的 fontFamily 进 attrs，clearMark 清除', () => {
    const rd = new RichDoc(doc(para([text('abc')])));
    selectAllOf(rd);
    rd.setMark('fontFamily', { fontFamily: 'serif' });
    expect(getMark(rd.doc.blocks[0].inlines[0].marks, 'fontFamily')?.attrs?.fontFamily).toBe('serif');
    selectAllOf(rd);
    rd.clearMark('fontFamily');
    expect(hasMarkType(rd.doc.blocks[0].inlines[0].marks, 'fontFamily')).toBe(false);
  });
});

describe('export: 上标/下标/字体映射', () => {
  it('HTML: superscript → <sup>, subscript → <sub>', () => {
    const html = toHtml(doc(para([
      text('E=mc'), text('2', [{ type: 'superscript' }]),
      text(' H'), text('2', [{ type: 'subscript' }]), text('O'),
    ])));
    expect(html).toContain('<sup>2</sup>');
    expect(html).toContain('<sub>2</sub>');
  });

  it('Markdown: sup/sub 回退为 HTML 标签', () => {
    const md = toMarkdown(doc(para([
      text('x'), text('2', [{ type: 'superscript' }]),
      text(' y'), text('n', [{ type: 'subscript' }]),
    ])));
    expect(md).toContain('<sup>2</sup>');
    expect(md).toContain('<sub>n</sub>');
  });

  it('HTML: fontFamily/fontSize → inline span style', () => {
    const html = toHtml(doc(para([
      text('big', [{ type: 'fontSize', attrs: { size: '28' } }]),
      text('serif', [{ type: 'fontFamily', attrs: { fontFamily: 'serif' } }]),
    ])));
    expect(html).toContain('font-size:28px');
    expect(html).toContain('font-family:serif');
  });

});
