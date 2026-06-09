import { describe, it, expect } from 'vitest';
import { RichDoc } from '../rich-document';
import { Doc, block, para, text, isListType } from '../schema';
import { meta, isList, continuesOnEnter, liftOnBackspace } from '../block-specs';
import { StyleResolver } from '../style-resolver';
import { toHtml, toMarkdown } from '../export';

// 集群 B（块级）：H3–H6 标题级别、task_item 任务列表行为 + toggleTaskChecked、
// 以及 heading/task_item 的 HTML/MD 导出映射。
const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });
const R = new StyleResolver();

describe('H3–H6 标题级别', () => {
  it('setBlockType heading level 3..6 写入 attrs.level', () => {
    for (const lv of [3, 4, 5, 6] as const) {
      const rd = new RichDoc(doc(para([text('T')])));
      rd.setSel({ block: 0, offset: 0 });
      rd.setBlockType('heading', { level: lv });
      expect(rd.doc.blocks[0].type).toBe('heading');
      expect(rd.doc.blocks[0].attrs.level).toBe(lv);
    }
  });

  it('heading 主题按 level 给逐级递减的字号、统一加粗', () => {
    const sizes = [1, 2, 3, 4, 5, 6].map((lv) =>
      meta('heading').theme({ level: lv as 1 | 2 | 3 | 4 | 5 | 6 }).base.fontSize);
    expect(sizes).toEqual([32, 24, 20, 18, 16, 15]);
    // 严格递减
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    // 全部加粗
    for (const lv of [1, 2, 3, 4, 5, 6])
      expect(meta('heading').theme({ level: lv as 1 | 2 | 3 | 4 | 5 | 6 }).base.bold).toBe(true);
  });

  it('resolveBlock 对 H3 解析出 fontSize 20、加粗', () => {
    const h3 = block('heading', [text('x')], { level: 3 });
    const rb = R.resolveBlock(h3);
    expect(rb.base.fontSize).toBe(20);
    expect(rb.base.bold).toBe(true);
  });

  it('非法 level 夹回 1..6', () => {
    expect(meta('heading').theme({ level: 0 as unknown as 1 }).base.fontSize).toBe(32);
    expect(meta('heading').theme({ level: 9 as unknown as 6 }).base.fontSize).toBe(15);
  });
});

describe('task_item 块行为', () => {
  it('注册为列表类：list / continuesOnEnter / liftOnBackspace', () => {
    expect(isList('task_item')).toBe(true);
    expect(isListType('task_item')).toBe(true);
    expect(continuesOnEnter('task_item')).toBe(true);
    expect(liftOnBackspace('task_item')).toBe(true);
    expect(meta('task_item').defaultAfter).toBe('task_item');
  });

  it('marker 由 attrs.checked 决定 ☐ / ☑', () => {
    expect(meta('task_item').theme({}).marker).toBe('☐');
    expect(meta('task_item').theme({ checked: false }).marker).toBe('☐');
    expect(meta('task_item').theme({ checked: true }).marker).toBe('☑');
  });

  it('setBlockType task_item 后回车在非空项续同类型', () => {
    const rd = new RichDoc(doc(para([text('todo')])));
    rd.setSel({ block: 0, offset: 0 });
    rd.setBlockType('task_item');
    rd.setSel({ block: 0, offset: 4 });
    rd.enter();
    expect(rd.blockCount).toBe(2);
    expect(rd.doc.blocks[1].type).toBe('task_item');
  });

  it('空 task_item 回车降级为段落（跳出列表）', () => {
    const rd = new RichDoc(doc(block('task_item', [text('')])));
    rd.setSel({ block: 0, offset: 0 });
    rd.enter();
    expect(rd.blockCount).toBe(1);
    expect(rd.doc.blocks[0].type).toBe('paragraph');
  });

  it('块首 Backspace 把 task_item 降级为段落（不合并）', () => {
    const rd = new RichDoc(doc(para([text('x')]), block('task_item', [text('item')])));
    rd.setSel({ block: 1, offset: 0 });
    rd.backspace();
    expect(rd.blockCount).toBe(2);
    expect(rd.doc.blocks[1].type).toBe('paragraph');
  });
});

describe('toggleTaskChecked', () => {
  it('切换 checked 并可撤销', () => {
    const rd = new RichDoc(doc(block('task_item', [text('a')], { checked: false })));
    rd.toggleTaskChecked(0);
    expect(rd.doc.blocks[0].attrs.checked).toBe(true);
    rd.toggleTaskChecked(0);
    expect(rd.doc.blocks[0].attrs.checked).toBe(false);
    // 进撤销栈：撤销最后一次切换 → 回到 true
    rd.undo();
    expect(rd.doc.blocks[0].attrs.checked).toBe(true);
  });

  it('undefined checked 视作未勾选，切换后为 true', () => {
    const rd = new RichDoc(doc(block('task_item', [text('a')])));
    rd.toggleTaskChecked(0);
    expect(rd.doc.blocks[0].attrs.checked).toBe(true);
  });

  it('对非 task_item 块无操作（不进撤销栈）', () => {
    const rd = new RichDoc(doc(para([text('a')])));
    rd.toggleTaskChecked(0);
    expect(rd.doc.blocks[0].attrs.checked).toBeUndefined();
    expect(rd.canUndo).toBe(false);
  });
});

describe('export: 标题级别与任务列表映射', () => {
  it('HTML: heading level 1..6 → h1..h6', () => {
    const html = toHtml(doc(
      block('heading', [text('A')], { level: 1 }),
      block('heading', [text('C')], { level: 3 }),
      block('heading', [text('F')], { level: 6 }),
    ));
    expect(html).toContain('<h1>A</h1>');
    expect(html).toContain('<h3>C</h3>');
    expect(html).toContain('<h6>F</h6>');
  });

  it('Markdown: heading level 3/4/5/6 → ###/####/#####/######', () => {
    const md = toMarkdown(doc(
      block('heading', [text('a')], { level: 3 }),
      block('heading', [text('b')], { level: 4 }),
      block('heading', [text('c')], { level: 5 }),
      block('heading', [text('d')], { level: 6 }),
    ));
    expect(md).toContain('### a');
    expect(md).toContain('#### b');
    expect(md).toContain('##### c');
    expect(md).toContain('###### d');
  });

  it('Markdown: task_item → GFM - [ ] / - [x]', () => {
    const md = toMarkdown(doc(
      block('task_item', [text('open')], { checked: false }),
      block('task_item', [text('done')], { checked: true }),
    ));
    expect(md).toContain('- [ ] open');
    expect(md).toContain('- [x] done');
  });

  it('HTML: task_item 合并为 <ul class="task-list"> 含 disabled checkbox', () => {
    const html = toHtml(doc(
      block('task_item', [text('open')], { checked: false }),
      block('task_item', [text('done')], { checked: true }),
    ));
    expect(html).toContain('<ul class="task-list">');
    expect(html).toContain('<input type="checkbox" disabled /> open');
    expect(html).toContain('<input type="checkbox" disabled checked /> done');
  });
});
