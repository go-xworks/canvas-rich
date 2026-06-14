// 打印 / 导出 PDF 通路（ui 层）：正文经 GPU 自绘不在 DOM，浏览器直接 ⌘P 只能得到外壳截图/空白；
// 本模块复用 model/export 的 toHtml 全文序列化 + 打印 CSS（A4 @page、正文/标题/列表/表格/代码块样式，
// 与编辑器亮色主题视觉接近），写入隐藏 iframe 后调 contentWindow.print() ——
// 用户在系统打印对话框选择打印机或「存储为 PDF」。
// 分层：ui 外壳，仅消费 model 纯函数；buildPrintHtml 为纯字符串函数（node 可测），iframe 编排自管生命周期。
import { Doc } from '../model/schema';
import { toHtml } from '../model/export';

/**
 * 打印页样式：A4 @page（边距 17mm ≈ word 视图 PAGE_MARGIN 64px@96dpi）+ 各块类型样式。
 * 字号/字体/行距/代码块底色对齐 model/block-specs 与 palette 的亮色主题（正文 19px system-ui、
 * H1..H6 32/24/20/18/16/15、代码块 16px mono 底 #f4f5f7、引用斜体弱化）；打印恒为纸面亮色。
 * @internal
 */
export const PRINT_CSS = `
@page { size: A4; margin: 17mm; }
html, body { margin: 0; padding: 0; background: #fff; }
body {
  font: 19px/1.5 system-ui, sans-serif;
  color: #1f2430;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
p { margin: 6px 0; }
h1, h2, h3, h4, h5, h6 { font-weight: 700; break-after: avoid; }
h1 { font-size: 32px; margin: 20px 0 8px; }
h2 { font-size: 24px; margin: 18px 0 7px; }
h3 { font-size: 20px; margin: 16px 0 6px; }
h4 { font-size: 18px; margin: 14px 0 5px; }
h5 { font-size: 16px; margin: 12px 0 4px; }
h6 { font-size: 15px; margin: 10px 0 4px; }
blockquote { margin: 8px 0; padding: 2px 0 2px 14px; border-left: 3px solid #e8e9ec; color: #6b7280; font-style: italic; }
pre { background: #f4f5f7; color: #2d3138; font: 16px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 10px 14px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: break-word; break-inside: avoid; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4f5f7; padding: 0 3px; border-radius: 3px; }
pre code { background: none; padding: 0; }
ul, ol { margin: 4px 0; padding-left: 30px; }
ul.task-list { list-style: none; padding-left: 26px; }
table { border-collapse: collapse; margin: 8px 0; break-inside: avoid; }
td { border: 1px solid #c9ccd3; padding: 4px 8px; vertical-align: top; }
img, svg, video { max-width: 100%; height: auto; break-inside: avoid; }
iframe { max-width: 100%; border: 1px solid #e8e9ec; }
a { color: #2563eb; }
.textbox { border: 1px solid #e3e5e9; border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
nav.toc ul { list-style: none; padding-left: 0; margin: 4px 0; }
nav.toc a { color: #1f2430; text-decoration: none; }
`;

// 标题转义（仅 <title> 文本位需要的三元 + 引号；正文转义由 model/export 自含）。
const escTitle = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 把文档树包装为可独立打印的完整 HTML 文档字符串（toHtml 全文 + {@link PRINT_CSS}）。
 * 纯函数（node 可测）；iframe 装载与 print() 编排见 {@link printDoc}。
 * @param doc 文档树
 * @param title 打印文档标题（系统对话框/PDF 文件名提示；转义后入 <title>）
 * @internal
 */
export function buildPrintHtml(doc: Doc, title = '文档'): string {
  return (
    '<!doctype html>\n<html lang="zh">\n<head>\n<meta charset="utf-8" />\n' +
    `<title>${escTitle(title)}</title>\n<style>${PRINT_CSS}</style>\n</head>\n<body>\n` +
    `${toHtml(doc)}\n</body>\n</html>`
  );
}

/** 图片落定等待上限（ms）：跨域/坏链/慢图超时后照常打印，不无限阻塞。 */
const IMAGE_SETTLE_TIMEOUT_MS = 3000;
/** afterprint 未派发时的 iframe 兜底回收时限（ms）。 */
const CLEANUP_FALLBACK_MS = 60_000;

// 当前在用的打印 iframe（单飞：新打印先回收旧帧，避免重复 print 对话框/泄漏）。
let activeFrame: HTMLIFrameElement | null = null;

function removeActiveFrame(): void {
  activeFrame?.remove();
  activeFrame = null;
}

// 等待 iframe 文档内所有图片「落定」：load 或 error 均算（跨域被拒/坏链走 error，不阻塞打印），超时兜底。
function whenImagesSettled(d: Document, timeoutMs: number): Promise<void> {
  const pending = Array.from(d.images).filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const timer = setTimeout(resolve, timeoutMs);
    const settle = (): void => {
      if (--left === 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const img of pending) {
      img.addEventListener('load', settle, { once: true });
      img.addEventListener('error', settle, { once: true });
    }
  });
}

// 严格 CSP（style-src 无 'unsafe-inline'）下 srcdoc 继承宿主 CSP，内联 <style> 被拦截：
// 经构造样式表（CSSOM 注入不受 style-src 管控）补一份等价规则兜底；常规宿主下规则重复无视觉差异。
function adoptPrintCss(win: Window, fdoc: Document): void {
  try {
    const sheet = new (win as Window & typeof globalThis).CSSStyleSheet();
    sheet.replaceSync(PRINT_CSS);
    fdoc.adoptedStyleSheets = [...fdoc.adoptedStyleSheets, sheet];
  } catch {
    /* 旧引擎无构造样式表：维持 <style> 路径 */
  }
}

// iframe onload 后的打印编排：补 CSSOM 样式 → 等图片落定 → focus + print → afterprint/超时回收。
async function firePrint(frame: HTMLIFrameElement): Promise<void> {
  const win = frame.contentWindow;
  const fdoc = frame.contentDocument;
  if (!win || !fdoc) {
    removeActiveFrame();
    return;
  }
  adoptPrintCss(win, fdoc);
  await whenImagesSettled(fdoc, IMAGE_SETTLE_TIMEOUT_MS);
  if (frame !== activeFrame) return; // 等待期间被更新的打印替换
  win.addEventListener(
    'afterprint',
    () => {
      if (frame === activeFrame) removeActiveFrame();
    },
    { once: true },
  );
  // 兜底回收：部分引擎 print() 立即返回且 afterprint 不可靠；超时后移除（系统对话框已持有快照）。
  setTimeout(() => {
    if (frame === activeFrame) removeActiveFrame();
  }, CLEANUP_FALLBACK_MS);
  try {
    win.focus();
    win.print();
  } catch {
    removeActiveFrame();
  }
}

/**
 * 打印 / 导出 PDF：把 {@link buildPrintHtml} 的完整文档写入隐藏 iframe（srcdoc），
 * onload 后等图片落定再调 contentWindow.print()——系统对话框中可选「存储为 PDF」。
 * 打印结束（afterprint）或兜底超时后自动移除 iframe；重复调用先回收上一帧。
 * @param doc 文档树
 * @param title 打印文档标题（默认「文档」）
 * @internal
 */
export function printDoc(doc: Doc, title?: string): void {
  removeActiveFrame();
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  frame.srcdoc = buildPrintHtml(doc, title);
  frame.addEventListener('load', () => {
    void firePrint(frame);
  });
  activeFrame = frame;
  document.body.appendChild(frame);
}
