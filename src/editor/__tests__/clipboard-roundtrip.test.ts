import { describe, it, expect } from 'vitest';
import { parseHtml } from '../import';
import { sliceDocRange } from '../../model/doc-range';
import { toHtml } from '../../model/export';
import { RichDoc } from '../../model/rich-document';
import { Doc, Block, para, block, text, cell, hasMarkType, blockText, cellText } from '../../model/schema';

// 剪贴板富文本 round-trip（editor 层）：copy 侧 sliceDocRange→toHtml 与 paste 侧
// parseHtml→insertFragment 的串接。完整 HTML 往返需 DOMParser，node 环境按 import.test
// 同模式跳过（设计性跳过）；node 可达部分验证「toHtml 产物 → 退化解析 → 插入」链路不丢文本。

const doc = (...blocks: Block[]): Doc => ({ blocks });

// HTML round-trip：完整验证需 DOMParser（浏览器），node 测试环境跳过（与 import.test 同模式）。
const hasDom = typeof (globalThis as { DOMParser?: unknown }).DOMParser === 'function';
const describeHtml = hasDom ? describe : describe.skip;

describeHtml('sliceDocRange → toHtml → parseHtml round-trip（浏览器 DOMParser 路径）', () => {
  it('文本与 marks 往返保真', () => {
    const d = doc(para([text('he', [{ type: 'bold' }]), text('llo')]));
    const back = parseHtml(toHtml(sliceDocRange(d, { block: 0, offset: 0 }, { block: 0, offset: 5 })));
    expect(blockText(back.blocks[0])).toBe('hello');
    expect(hasMarkType(back.blocks[0].inlines[0].marks, 'bold')).toBe(true);
  });

  it('标题/表格结构往返保真', () => {
    const d = doc(
      block('heading', [text('T')], { level: 3 }),
      block('table', [text('')], { rows: [[cell('A'), cell('B')]] }),
    );
    const back = parseHtml(toHtml(sliceDocRange(d, { block: 0, offset: 0 }, { block: 1, offset: 0 })));
    expect(back.blocks[0].type).toBe('heading');
    expect(back.blocks[0].attrs.level).toBe(3);
    const tbl = back.blocks.find((b) => b.type === 'table');
    expect(tbl).toBeDefined();
    expect(cellText(tbl!.attrs.rows![0][0])).toBe('A');
  });

  it('内部复制→粘贴（insertFragment）保 marks', () => {
    const src = new RichDoc(doc(para([text('粗体字', [{ type: 'bold' }])])));
    const html = toHtml(sliceDocRange(src.doc, { block: 0, offset: 0 }, { block: 0, offset: 3 }));
    const dst = new RichDoc(doc(para([text('xy')])));
    dst.setSel({ block: 0, offset: 1 });
    dst.insertFragment(parseHtml(html));
    expect(blockText(dst.doc.blocks[0])).toBe('x粗体字y');
    const mid = dst.doc.blocks[0].inlines.find((r) => r.text === '粗体字');
    expect(mid && hasMarkType(mid.marks, 'bold')).toBe(true);
  });
});

describe('toHtml 产物 → 退化解析（node 无 DOMParser）不丢文本', () => {
  it('粘贴链路在无 DOMParser 环境降级为纯文本段落但内容完整', () => {
    const d = doc(block('heading', [text('标题')], { level: 1 }), para([text('正文')]));
    const html = toHtml(sliceDocRange(d, { block: 0, offset: 0 }, { block: 1, offset: 2 }));
    const back = parseHtml(html); // node：fallbackHtml 剥标签按行切段
    const all = back.blocks.map(blockText).join('\n');
    expect(all).toContain('标题');
    expect(all).toContain('正文');
  });
});
