import { RichDoc } from '../model/rich-document';
import { sliceDocRange } from '../model/doc-range';
import { toHtml } from '../model/export';
import { parseHtml } from './import';

// 剪贴板：copy/cut/paste 事件 + 命令式 do* 接口（供右键菜单）。从 main 抽出，独立可测。
// 富文本双格式：copy/cut 同时写 text/plain 与 text/html（选区片段经 sliceDocRange→toHtml，
// 保 marks/块结构）；paste 优先读 text/html（parseHtml→insertFragment，单次撤销），无 html 退回纯文本。
// 分层：editor（编辑装配层，桥接浏览器剪贴板与 model）。

/**
 * 命令式剪贴板接口：供右键菜单等主动触发复制/剪切/粘贴。
 * @public
 */
export interface Clipboard {
  copy(): Promise<void>;
  cut(): Promise<void>;
  paste(): Promise<void>;
}

/**
 * 在 IME 文本域上挂接 copy/cut/paste 事件，并返回命令式剪贴板接口。
 * 不变量：纯文本多行粘贴按 \n 拆块（首段不换行，其后每段先 enter 再插入）；
 * HTML 粘贴经 insertFragment 单次撤销；copy/cut 同时写 text/plain 与 text/html。
 * @public
 */
export function setupClipboard(ime: HTMLTextAreaElement, rd: RichDoc, afterEdit: () => void): Clipboard {
  // 选区 → HTML 片段（marks/块结构/表格/原子块全保留），供 text/html 通道。
  const selectionHtml = (): string => {
    const { from, to } = rd.range();
    return toHtml(sliceDocRange(rd.doc, from, to));
  };
  // 多行粘贴 → 按 \n 拆块。粘贴是独立撤销单元：前后均断开连续输入合并，
  // 避免粘贴与紧邻的打字被合并进同一条撤销记录。
  const pasteText = (t: string) => {
    if (!t) return;
    rd.breakUndoCoalescing();
    t.replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((seg, i) => {
        if (i > 0) rd.enter();
        if (seg) rd.insertText(seg);
      });
    rd.breakUndoCoalescing();
    afterEdit();
  };
  // HTML 粘贴 → 解析为文档片段后在光标处插入（保 marks/块结构；insertFragment 自身单次撤销）。
  const pasteHtml = (html: string) => {
    rd.insertFragment(parseHtml(html));
    afterEdit();
  };
  // 剪贴板里的图片文件 → 以 data URL 插入
  const pasteImage = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      rd.insertImage(String(reader.result));
      afterEdit();
    };
    reader.readAsDataURL(file);
  };
  // copy/cut 共用：双格式写入剪贴板事件（无选区返回 false 放行默认行为）。
  const writeSelection = (e: ClipboardEvent): boolean => {
    const t = rd.selectedText();
    if (!t) return false;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', t);
    e.clipboardData?.setData('text/html', selectionHtml());
    return true;
  };

  ime.addEventListener('copy', (e) => {
    writeSelection(e);
  });
  ime.addEventListener('cut', (e) => {
    if (writeSelection(e)) {
      rd.backspace();
      afterEdit();
    }
  });
  ime.addEventListener('paste', (e) => {
    e.preventDefault();
    const img = [...(e.clipboardData?.items ?? [])].find((it) => it.type.startsWith('image/'));
    const file = img?.getAsFile();
    if (file) {
      pasteImage(file);
      return;
    } // 优先图片（截图/复制的图）
    const html = e.clipboardData?.getData('text/html') ?? '';
    if (html) {
      pasteHtml(html);
      return;
    } // 富文本：Word/Docs/网页/编辑器内部复制
    pasteText(e.clipboardData?.getData('text/plain') ?? '');
  });

  // 异步 API（右键菜单路径）：双格式写入（无 ClipboardItem 的环境退回纯文本）。
  const writeSelectionAsync = async (): Promise<boolean> => {
    const t = rd.selectedText();
    if (!t) return false;
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([t], { type: 'text/plain' }),
            'text/html': new Blob([selectionHtml()], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(t);
      }
    } catch {
      /* 权限拒绝等：静默（与事件路径不可用时的旧行为一致） */
    }
    return true;
  };

  return {
    async copy() {
      await writeSelectionAsync();
    },
    async cut() {
      if (await writeSelectionAsync()) {
        rd.backspace();
        afterEdit();
      }
    },
    async paste() {
      // 优先读富文本（clipboard.read 需权限，被拒/不支持时退回纯文本通道）
      try {
        if (navigator.clipboard?.read) {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes('text/html')) {
              pasteHtml(await (await item.getType('text/html')).text());
              return;
            }
          }
        }
      } catch {
        /* 权限拒绝/不支持：落回 readText */
      }
      try {
        pasteText(await navigator.clipboard.readText());
      } catch {
        /* */
      }
    },
  };
}
