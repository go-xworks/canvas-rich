import { describe, it, expect } from 'vitest';
import { buildPrintHtml, PRINT_CSS } from '../print';
import { commands, keymap, SELF_FINALIZING, VIEW_ONLY } from '../../editor/commands';
import { RichDoc } from '../../model/rich-document';
import { Doc, block, para, text, cell } from '../../model/schema';
import { toHtml } from '../../model/export';
import { makeCtx } from '../../editor/__tests__/make-ctx';

// 打印 / 导出 PDF 通路的 node 纯逻辑测试：buildPrintHtml（完整可打印 HTML 文档字符串）与
// 命令总线接线（mod+p → doc.print → view.printDoc）。iframe 装载/print() 编排触碰 DOM，
// 按本仓约定（node 环境无 jsdom）由浏览器实测核对，不在此覆盖。
// CommandContext 测试桩共享自 editor/__tests__/make-ctx（三份拷贝抽取，CONVENTIONS §4）。

const doc = (...blocks: Doc['blocks']): Doc => ({ blocks });

const sample = doc(
  block('heading', [text('年度报告')], { level: 1, id: 'h-1' }),
  para([text('正文段落')]),
  block('code_block', [text('const a = 1;')], {}),
  block('table', [], { rows: [[cell('甲'), cell('乙')]] }),
);

describe('buildPrintHtml：完整可打印 HTML 文档', () => {
  it('是含 <style>（打印 CSS）与 toHtml 全文的独立 HTML 文档', () => {
    const html = buildPrintHtml(sample);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain(`<style>${PRINT_CSS}</style>`);
    expect(html).toContain(toHtml(sample)); // 正文 = model/export 的 toHtml 输出，逐字嵌入
    expect(html).toContain('<h1 id="h-1">年度报告</h1>');
    expect(html).toContain('<pre><code>const a = 1;</code></pre>');
    expect(html).toContain('<td>甲</td><td>乙</td>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('标题入 <title> 并转义（缺省「文档」）', () => {
    expect(buildPrintHtml(sample)).toContain('<title>文档</title>');
    expect(buildPrintHtml(sample, 'A <"&> B')).toContain('<title>A &lt;&quot;&amp;&gt; B</title>');
  });

  it('打印 CSS 含 A4 @page 与正文/表格/代码块/图片关键规则', () => {
    expect(PRINT_CSS).toContain('@page { size: A4; margin: 17mm; }');
    expect(PRINT_CSS).toContain('font: 19px/1.5 system-ui, sans-serif;'); // 正文对齐编辑器默认 19px
    expect(PRINT_CSS).toContain('border-collapse: collapse');
    expect(PRINT_CSS).toContain('td { border: 1px solid');
    expect(PRINT_CSS).toContain('img, svg, video { max-width: 100%;');
    expect(PRINT_CSS).toContain('pre { background: #f4f5f7;');
    expect(PRINT_CSS).toContain('print-color-adjust: exact;');
  });
});

describe('命令总线接线：mod+p → doc.print → view.printDoc', () => {
  it('keymap["mod+p"] → doc.print 且命令已注册', () => {
    expect(keymap['mod+p']).toBe('doc.print');
    expect(commands['doc.print']).toBeTypeOf('function');
  });

  it('doc.print 委托 view.printDoc，且非自收尾（keymap 目标统一由派发方收尾）', () => {
    const ctx = makeCtx(new RichDoc(doc(para([text('t')]))));
    commands['doc.print'](ctx);
    expect(ctx.calls).toEqual(['printDoc']); // 仅委托视图服务，不触碰模型/弹层
    expect(SELF_FINALIZING.has('doc.print')).toBe(false); // 与 find.open 同模式（keymap↔SELF_FINALIZING 互斥）
    // 只读视图命令：派发方不追加 afterEdit（否则 ⌘P 标脏自动保存 + 整文档重排 + 视口跳回光标）
    expect(VIEW_ONLY.has('doc.print')).toBe(true);
    expect(VIEW_ONLY.has('find.open')).toBe(true);
  });
});
