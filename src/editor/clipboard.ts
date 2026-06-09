import { RichDoc } from '../model/rich-document';

// 剪贴板：copy/cut/paste 事件 + 命令式 do* 接口（供右键菜单）。从 main 抽出，独立可测。
// 分层：editor（编辑装配层，桥接浏览器剪贴板与 model）。

/**
 * 命令式剪贴板接口：供右键菜单等主动触发复制/剪切/粘贴。
 * @public
 */
export interface Clipboard { copy(): Promise<void>; cut(): Promise<void>; paste(): Promise<void> }

/**
 * 在 IME 文本域上挂接 copy/cut/paste 事件，并返回命令式剪贴板接口。
 * 不变量：多行粘贴按 \n 拆块（首段不换行，其后每段先 enter 再插入）。
 * @public
 */
export function setupClipboard(ime: HTMLTextAreaElement, rd: RichDoc, afterEdit: () => void): Clipboard {
  // 多行粘贴 → 按 \n 拆块
  const pasteText = (t: string) => {
    if (!t) return;
    t.replace(/\r\n?/g, '\n').split('\n').forEach((seg, i) => { if (i > 0) rd.enter(); if (seg) rd.insertText(seg); });
    afterEdit();
  };
  // 剪贴板里的图片文件 → 以 data URL 插入
  const pasteImage = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => { rd.insertImage(String(reader.result)); afterEdit(); };
    reader.readAsDataURL(file);
  };

  ime.addEventListener('copy', (e) => { const t = rd.selectedText(); if (!t) return; e.preventDefault(); e.clipboardData?.setData('text/plain', t); });
  ime.addEventListener('cut', (e) => { const t = rd.selectedText(); if (!t) return; e.preventDefault(); e.clipboardData?.setData('text/plain', t); rd.backspace(); afterEdit(); });
  ime.addEventListener('paste', (e) => {
    e.preventDefault();
    const img = [...(e.clipboardData?.items ?? [])].find((it) => it.type.startsWith('image/'));
    const file = img?.getAsFile();
    if (file) { pasteImage(file); return; } // 优先图片（截图/复制的图）
    pasteText(e.clipboardData?.getData('text/plain') ?? '');
  });

  return {
    async copy() { const t = rd.selectedText(); if (t) { try { await navigator.clipboard.writeText(t); } catch { /* */ } } },
    async cut() { const t = rd.selectedText(); if (!t) return; try { await navigator.clipboard.writeText(t); } catch { /* */ } rd.backspace(); afterEdit(); },
    async paste() { try { pasteText(await navigator.clipboard.readText()); } catch { /* */ } },
  };
}
