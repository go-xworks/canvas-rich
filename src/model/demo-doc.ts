/**
 * 初始演示文档（model 层）：标题/多 mark 段落/嵌套列表/代码块/图片/公式/表格/对齐/引用/RTL/BiDi
 * 的功能展示样张。自 main.ts 下沉的纯数据构建，装配层启动时调用一次。
 */
import { Doc, block, para, text, cellsFromStrings } from './schema';

// 演示图片：内联 SVG data URL（无外部资源依赖，离线可用）。
const DEMO_IMG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150"><rect width="560" height="150" rx="10" fill="#eef2ff"/><circle cx="80" cy="75" r="40" fill="#2563eb"/><text x="150" y="84" font-family="system-ui" font-size="24" fill="#1f2430">图片块（DOM 覆盖层渲染）</text></svg>');

/**
 * 构建初始演示文档（每次调用产生全新对象，可安全交给可变的 RichDoc）。
 * @public
 */
export function createDemoDoc(): Doc {
  return {
    blocks: [
      block('heading', [text('Rich Text Engine')], { level: 1 }),
      block('heading', [text('Document tree · marks · block layout')], { level: 2 }),
      para([
        text('A paragraph mixing '),
        text('bold', [{ type: 'bold' }]),
        text(', '),
        text('italic', [{ type: 'italic' }]),
        text(', '),
        text('underline', [{ type: 'underline' }]),
        text(', '),
        text('strike', [{ type: 'strikethrough' }]),
        text(', '),
        text('highlight', [{ type: 'highlight' }]),
        text(', '),
        text('green', [{ type: 'color', attrs: { color: '#5ad17a' } }]),
        text(', '),
        text('code', [{ type: 'code' }]),
        text(', and a '),
        text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        text('. Long enough to wrap across lines so you can select across them.'),
      ]),
      block('bullet_item', [text('Bullet one — select across lines, then toggle marks.')]),
      block('bullet_item', [text('Nested child — Tab 缩进 / Shift+Tab 取消缩进')], { depth: 1 }),
      block('bullet_item', [text('Bullet two — '), text('bold tail', [{ type: 'bold' }])]),
      block('ordered_item', [text('First numbered item.')]),
      block('ordered_item', [text('Second numbered item — auto-numbered.')]),
      block('code_block', [text("function shape(text, font) {")]),
      block('code_block', [text("  return harfbuzz.shape(text, font);  // 多行代码块连续背景")]),
      block('code_block', [text("}")]),
      { type: 'image', attrs: { src: DEMO_IMG, height: 150 }, inlines: [text('')] },
      { type: 'formula', attrs: { latex: 'E = mc^2 \\quad\\quad \\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' }, inlines: [text('')] },
      { type: 'table', attrs: { rows: cellsFromStrings([['功能', '状态'], ['公式 (KaTeX)', '✓'], ['表格 (可编辑)', '✓ 双击单元格']]) }, inlines: [text('')] },
      para([text('A centered paragraph.')], { align: 'center' }),
      block('blockquote', [text('A blockquote: italic and muted.')]),
      { type: 'paragraph', attrs: { dir: 'rtl' }, inlines: [text('שלום עולם — פסקה מימין לשמאל (RTL ⌘⇧D)')] },
      { type: 'paragraph', attrs: { dir: 'rtl' }, inlines: [text('مرحبا بالعالم — فقرة عربية متصلة الحروف (HarfBuzz)')] },
      para([text('Mixed BiDi: English with עברית מוטבעת inside, back to English.')]),
      para([text('Edit me. Use the toolbar, or type / Enter / Backspace.')]),
    ],
  };
}
