/**
 * 原子块与文档级弹层族（ui 层）：插入图片/行内图片/公式/表格/音频/视频/内嵌网页/附件/签名/
 * 印章/文本框、双击原子块「再编辑」(editAtom)，以及导入 Markdown/HTML、存为模板的弹层编排。
 * 自 main.ts 下沉：依赖注入（rd / promptDialog / imageDialog / signatureDialog / afterEdit /
 * announce / focusEditor）组装，main 只接线；不直接触碰 DOM，弹层细节由注入的 dialog 句柄承担。
 */
import type { RichDoc } from '../model/rich-document';
import { saveUserTemplate } from '../model/templates';
import { parseMarkdown, parseHtml } from '../editor/import';
import type { PromptDialog } from './prompt';
import type { ImageDialog } from './image-dialog';
import type { SignatureDialog } from './signature-dialog';

/** 媒体 src 弹层支持的原子种类（音频/视频/内嵌网页）。@public */
export type MediaSrcKind = 'audio' | 'video' | 'iframe';

// 媒体 src 弹层配置表：插入与双击「再编辑」共用同一份文案/占位/写回方法（配置驱动，消除逐 kind 重复样板）。
const MEDIA_SRC_CONFIG: Record<MediaSrcKind, { label: string; placeholder: string; insert(rd: RichDoc, src: string): void }> = {
  audio: { label: '音频', placeholder: 'https://example.com/audio.mp3', insert: (rd, src) => rd.insertAudio(src) },
  video: { label: '视频', placeholder: 'https://example.com/video.mp4', insert: (rd, src) => rd.insertVideo(src) },
  iframe: { label: '内嵌网页', placeholder: 'https://example.com', insert: (rd, src) => rd.insertIframe(src) },
};

/**
 * 弹层族的注入依赖：文档句柄、三类弹层、编辑后回调、无障碍播报与焦点交还。
 * @public
 */
export interface AtomDialogDeps {
  rd: RichDoc;
  promptDialog: PromptDialog;
  imageDialog: ImageDialog;
  signatureDialog: SignatureDialog;
  /** 编辑提交后的统一收尾（重排/光标滚入视口），由装配层注入。 */
  afterEdit(): void;
  /** 无障碍 live region 播报。 */
  announce(msg: string): void;
  /** 弹层关闭后把焦点交还编辑器 IME 代理。 */
  focusEditor(): void;
}

/**
 * 原子块弹层族句柄：insert* 一族 + 双击再编辑 editAtom。
 * @public
 */
export interface AtomDialogs {
  insertImage(): Promise<void>;
  insertInlineImage(): Promise<void>;
  insertFormula(): Promise<void>;
  insertMedia(kind: MediaSrcKind): Promise<void>;
  insertAttachment(): Promise<void>;
  insertSignature(): Promise<void>;
  insertSeal(): Promise<void>;
  insertTextbox(): void;
  insertTable(rows: number, cols: number): void;
  editAtom(blockIndex: number, kind: string): Promise<void>;
  importDoc(): Promise<void>;
  saveTemplate(): Promise<void>;
}

/**
 * 组装原子块弹层族：每个动作 = 弹层取值 → 写回文档（进撤销栈）→ afterEdit + 播报 → 焦点交还。
 * 取消（弹层返回 null/空）不写文档，但仍交还焦点。
 * @public
 */
export function createAtomDialogs(deps: AtomDialogDeps): AtomDialogs {
  const { rd, promptDialog, imageDialog, signatureDialog, afterEdit, announce, focusEditor } = deps;
  // 统一的媒体 src 弹层：插入（current 缺省 → 'https://'）与再编辑（预填当前值）共用。
  const promptForSrc = (title: string, placeholder: string, current?: string): Promise<string | null> =>
    promptDialog.ask({ title, value: current ?? 'https://', placeholder });

  return {
    async insertImage() {
      const src = await imageDialog.open(); // 富弹层：本地上传/拖拽 + URL + 预览
      if (src) { rd.insertImage(src); afterEdit(); announce('已插入图片'); }
      focusEditor();
    },
    async insertInlineImage() {
      const src = await imageDialog.open(); // 复用图片弹层（本地/URL/预览）
      if (src) { rd.insertInlineImage(src); afterEdit(); announce('已插入行内图片'); }
      focusEditor();
    },
    async insertFormula() {
      const tex = await promptDialog.ask({ title: '插入公式（LaTeX）', value: 'e = mc^2', placeholder: '\\frac{a}{b}', multiline: true });
      if (tex) { rd.insertFormula(tex); afterEdit(); announce('已插入公式'); }
      focusEditor();
    },
    // 媒体对象：音频 / 视频 / 内嵌网页(iframe)，均经 promptDialog 取 URL。
    async insertMedia(kind: MediaSrcKind) {
      const cfg = MEDIA_SRC_CONFIG[kind];
      const src = await promptForSrc(`插入${cfg.label}`, cfg.placeholder);
      if (src) { cfg.insert(rd, src); afterEdit(); announce(`已插入${cfg.label}`); }
      focusEditor();
    },
    async insertAttachment() {
      const src = await promptDialog.ask({ title: '插入附件', value: 'https://', placeholder: 'https://example.com/file.pdf' });
      if (!src) { focusEditor(); return; }
      const name = await promptDialog.ask({ title: '附件文件名', placeholder: 'file.pdf', okLabel: '插入' });
      rd.insertAttachment(src, name?.trim() || undefined); afterEdit(); announce('已插入附件');
      focusEditor();
    },
    // 电子签名：弹画板手绘 → 确定产 PNG dataURL → 作为签名原子块插入。
    async insertSignature() {
      const src = await signatureDialog.open();
      if (src) { rd.insertSignature(src); afterEdit(); announce('已插入电子签名'); }
      focusEditor();
    },
    // 印章：promptDialog 取印章文字（单位/公司名）→ 插入印章原子块（覆盖层生成红色公章 SVG）。
    async insertSeal() {
      const text = await promptDialog.ask({ title: '插入印章', placeholder: '某某有限公司', okLabel: '生成' });
      if (text && text.trim()) { rd.insertSeal(text.trim()); afterEdit(); announce('已插入印章'); }
      focusEditor();
    },
    insertTextbox() {
      rd.insertTextbox(); afterEdit(); announce('已插入文本框');
    },
    // 表格经工具栏网格选择器直接给出行列数（无弹层，归口原子插入族统一收尾）。
    insertTable(rows: number, cols: number) {
      rd.insertTable(rows, cols); afterEdit(); announce(`已插入 ${rows} 行 ${cols} 列表格`);
      focusEditor();
    },
    /**
     * 双击原子块「再编辑」：覆盖层 onAtomEdit 回调入口。按 kind 复用对应弹层预填当前值取新值，
     * 经 RichDoc.updateAtomAttrs 合并写回 attrs（进撤销栈）。
     * textbox/shape/table 不走此路（textbox 直接编辑、shape 暂不可编内容、table 单元格内联编辑）。
     */
    async editAtom(blockIndex: number, kind: string) {
      const blk = rd.doc.blocks[blockIndex];
      if (!blk) return;
      const a = blk.attrs;
      switch (kind) {
        case 'formula': {
          const latex = await promptDialog.ask({ title: '编辑公式（LaTeX）', value: a.latex ?? '', placeholder: '\\frac{a}{b}', multiline: true });
          if (latex !== null) { rd.updateAtomAttrs(blockIndex, { latex }); afterEdit(); announce('已更新公式'); }
          break;
        }
        case 'seal': {
          const text = await promptDialog.ask({ title: '编辑印章', value: a.text ?? '', placeholder: '某某有限公司', okLabel: '生成' });
          if (text !== null && text.trim()) { rd.updateAtomAttrs(blockIndex, { text: text.trim() }); afterEdit(); announce('已更新印章'); }
          break;
        }
        case 'iframe': case 'audio': case 'video': {
          // 媒体 src 再编辑：与插入共用 MEDIA_SRC_CONFIG 文案/占位，弹层预填当前值
          const cfg = MEDIA_SRC_CONFIG[kind];
          const src = await promptForSrc(`编辑${cfg.label}`, cfg.placeholder, a.src);
          if (src) { rd.updateAtomAttrs(blockIndex, { src }); afterEdit(); announce(`已更新${cfg.label}`); }
          break;
        }
        case 'attachment': {
          const src = await promptDialog.ask({ title: '编辑附件链接', value: a.src ?? 'https://', placeholder: 'https://example.com/file.pdf' });
          if (src) {
            const name = await promptDialog.ask({ title: '附件文件名', value: a.name ?? '', placeholder: 'file.pdf', okLabel: '保存' });
            rd.updateAtomAttrs(blockIndex, { src, name: name?.trim() || undefined });
            afterEdit(); announce('已更新附件');
          }
          break;
        }
        case 'image': {
          const src = await imageDialog.open(); // 复用图片弹层（本地/URL/预览）
          if (src) { rd.updateAtomAttrs(blockIndex, { src }); afterEdit(); announce('已更新图片'); }
          break;
        }
        case 'signature': {
          const src = await signatureDialog.open(); // 重画签名
          if (src) { rd.updateAtomAttrs(blockIndex, { src }); afterEdit(); announce('已更新电子签名'); }
          break;
        }
        default: break; // shape/table/textbox 不走再编辑弹层
      }
      focusEditor();
    },
    // 导入：弹多行输入，粘贴 Markdown/HTML，解析为 Doc 后整文档替换（光标置文末）。
    // 含 HTML 标签则按 HTML 解析，否则按 Markdown。
    async importDoc() {
      const src = await promptDialog.ask({
        title: '导入 Markdown / HTML（替换当前文档）',
        placeholder: '# 标题\n\n- 列表\n\n**粗体** *斜体* [链接](https://…)',
        okLabel: '导入',
        multiline: true,
      });
      if (src && src.trim()) {
        const looksHtml = /<\/?[a-z][\s\S]*>/i.test(src);
        rd.setDoc(looksHtml ? parseHtml(src) : parseMarkdown(src));
        afterEdit();
        announce('已导入文档');
      }
      focusEditor();
    },
    // 存为用户模板（localStorage）：弹名称输入，空名/取消不保存；不改文档故无 afterEdit。
    async saveTemplate() {
      const name = await promptDialog.ask({ title: '设为模板', placeholder: '模板名称', okLabel: '保存' });
      if (name && name.trim()) {
        saveUserTemplate(name.trim(), rd.doc);
        announce(`已保存模板：${name.trim()}`);
      }
      focusEditor();
    },
  };
}
