import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, para, text } from '../schema';

// 集群B：原子块双击「再编辑」的模型支撑 —— 通用 updateAtomAttrs（浅合并 attrs + 进撤销栈）。
// DOM 双击交互（overlays/main）由 tsc + build 把关；此处只验模型层语义。

const docOf = (...blocks: Doc['blocks']): Doc => ({ blocks });

describe('RichDoc.updateAtomAttrs', () => {
  it('合并部分 attrs，仅改指定字段（公式 latex），保留其余属性（id/尺寸）', () => {
    const rd = new RichDoc(docOf(para([text('p0')])));
    rd.insertFormula('a');
    const before = rd.doc.blocks[1];
    const id = before.attrs.id;
    rd.updateAtomAttrs(1, { latex: 'E=mc^2' });
    const after = rd.doc.blocks[1];
    expect(after.type).toBe('formula');
    expect(after.attrs.latex).toBe('E=mc^2');
    expect(after.attrs.id).toBe(id); // 稳定 id 不被覆盖（覆盖层缓存键）
  });

  it('改印章文字（text）只动该字段，保留默认宽高', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertSeal('旧公司');
    const w = rd.doc.blocks[1].attrs.width;
    const h = rd.doc.blocks[1].attrs.height;
    rd.updateAtomAttrs(1, { text: '新公司' });
    expect(rd.doc.blocks[1].attrs.text).toBe('新公司');
    expect(rd.doc.blocks[1].attrs.width).toBe(w);
    expect(rd.doc.blocks[1].attrs.height).toBe(h);
  });

  it('改媒体源（src）合并到 attrs', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertVideo('https://a/old.mp4');
    rd.updateAtomAttrs(1, { src: 'https://a/new.mp4' });
    expect(rd.doc.blocks[1].attrs.src).toBe('https://a/new.mp4');
    expect(rd.doc.blocks[1].attrs.width).toBe(480); // 视频默认尺寸保留
  });

  it('附件可同时改 src + name', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertAttachment('https://a/old.pdf', '旧.pdf');
    rd.updateAtomAttrs(1, { src: 'https://a/new.pdf', name: '新.pdf' });
    expect(rd.doc.blocks[1].attrs.src).toBe('https://a/new.pdf');
    expect(rd.doc.blocks[1].attrs.name).toBe('新.pdf');
  });

  it('进撤销栈：undo 还原旧值，redo 复用新值', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertFormula('old');
    rd.updateAtomAttrs(1, { latex: 'new' });
    expect(rd.doc.blocks[1].attrs.latex).toBe('new');
    rd.undo();
    expect(rd.doc.blocks[1].attrs.latex).toBe('old');
    rd.redo();
    expect(rd.doc.blocks[1].attrs.latex).toBe('new');
  });

  it('undo 后旧快照不被后续修改污染（snapshot 前已 cloneDoc，合并产新 attrs 对象）', () => {
    const rd = new RichDoc(docOf(para([text('x')])));
    rd.insertSeal('A');
    rd.updateAtomAttrs(1, { text: 'B' });
    rd.updateAtomAttrs(1, { text: 'C' });
    expect(rd.doc.blocks[1].attrs.text).toBe('C');
    rd.undo();
    expect(rd.doc.blocks[1].attrs.text).toBe('B');
    rd.undo();
    expect(rd.doc.blocks[1].attrs.text).toBe('A');
  });

  it('非原子块（段落）调用被忽略，不进撤销栈', () => {
    const rd = new RichDoc(docOf(para([text('hi')])));
    const canUndoBefore = rd.canUndo;
    rd.updateAtomAttrs(0, { latex: 'x' });
    expect(rd.doc.blocks[0].attrs.latex).toBeUndefined();
    expect(rd.canUndo).toBe(canUndoBefore); // 未快照
  });

  it('块号越界被忽略', () => {
    const rd = new RichDoc(docOf(para([text('hi')])));
    expect(() => rd.updateAtomAttrs(99, { latex: 'x' })).not.toThrow();
    expect(rd.canUndo).toBe(false);
  });
});
