import { describe, it, expect } from 'vitest';
import { createAtomDialogs, AtomDialogs } from '../atom-dialogs';
import type { PromptOptions } from '../prompt';
import { RichDoc } from '../../model/rich-document';
import { block, para, text, Doc, BlockType } from '../../model/schema';
import { loadUserTemplates, USER_TEMPLATES_KEY } from '../../model/templates';

// 原子块/文档级弹层族（main.ts 下沉）的纯逻辑测试：注入桩 dialog（队列应答）与真实 RichDoc，
// 验证「取值 → 写文档 → afterEdit/announce → 焦点交还」编排与取消路径。node 环境，无 DOM。

interface Harness {
  rd: RichDoc;
  dialogs: AtomDialogs;
  prompts: (string | null)[];        // promptDialog.ask 的应答队列（耗尽则返回 null=取消）
  promptCalls: PromptOptions[];      // ask 实参记录（断言标题/预填值）
  log: { afterEdit: number; announces: string[]; focus: number };
  setImage(src: string | null): void;
  setSignature(src: string | null): void;
}

function harness(doc: Doc): Harness {
  const rd = new RichDoc(doc);
  rd.setSel(rd.docEnd());
  const prompts: (string | null)[] = [];
  const promptCalls: PromptOptions[] = [];
  let imageSrc: string | null = null;
  let signatureSrc: string | null = null;
  const log = { afterEdit: 0, announces: [] as string[], focus: 0 };
  const dialogs = createAtomDialogs({
    rd,
    promptDialog: { ask: async (opts) => { promptCalls.push(opts); return prompts.length ? prompts.shift()! : null; }, destroy: () => {} },
    imageDialog: { open: async () => imageSrc, destroy: () => {} },
    signatureDialog: { open: async () => signatureSrc, destroy: () => {} },
    afterEdit: () => { log.afterEdit++; },
    announce: (m) => { log.announces.push(m); },
    focusEditor: () => { log.focus++; },
  });
  return {
    rd, dialogs, prompts, promptCalls, log,
    setImage: (s) => { imageSrc = s; },
    setSignature: (s) => { signatureSrc = s; },
  };
}

const baseDoc = (): Doc => ({ blocks: [para([text('hello')])] });
const findBlock = (rd: RichDoc, type: BlockType) => rd.doc.blocks.find((b) => b.type === type);

describe('insert* 弹层族', () => {
  it('insertMedia(audio)：取 URL → 插入音频块 + afterEdit + 播报 + 还焦', async () => {
    const h = harness(baseDoc());
    h.prompts.push('https://x/a.mp3');
    await h.dialogs.insertMedia('audio');
    expect(findBlock(h.rd, 'audio')?.attrs.src).toBe('https://x/a.mp3');
    expect(h.promptCalls[0].title).toBe('插入音频');
    expect(h.promptCalls[0].value).toBe('https://'); // 插入路径预填协议前缀
    expect(h.log).toMatchObject({ afterEdit: 1, focus: 1 });
    expect(h.log.announces).toEqual(['已插入音频']);
  });

  it('insertMedia 取消（null）：不写文档、无 afterEdit，但仍还焦', async () => {
    const h = harness(baseDoc());
    await h.dialogs.insertMedia('video');
    expect(findBlock(h.rd, 'video')).toBeUndefined();
    expect(h.log).toMatchObject({ afterEdit: 0, focus: 1 });
    expect(h.log.announces).toEqual([]);
  });

  it('insertFormula：取 LaTeX（多行弹层）→ 插入公式块', async () => {
    const h = harness(baseDoc());
    h.prompts.push('a^2 + b^2');
    await h.dialogs.insertFormula();
    expect(findBlock(h.rd, 'formula')?.attrs.latex).toBe('a^2 + b^2');
    expect(h.promptCalls[0].multiline).toBe(true);
  });

  it('insertImage / insertInlineImage：经 imageDialog 取 src', async () => {
    const h = harness(baseDoc());
    h.setImage('https://x/img.png');
    await h.dialogs.insertImage();
    expect(findBlock(h.rd, 'image')?.attrs.src).toBe('https://x/img.png');
    expect(h.log.announces).toEqual(['已插入图片']);
    await h.dialogs.insertInlineImage();
    expect(h.log.announces).toEqual(['已插入图片', '已插入行内图片']);
  });

  it('insertAttachment：两段弹层（链接 + 文件名），文件名 trim、空名转 undefined', async () => {
    const h = harness(baseDoc());
    h.prompts.push('https://x/f.pdf', '  file.pdf  ');
    await h.dialogs.insertAttachment();
    const att = findBlock(h.rd, 'attachment');
    expect(att?.attrs.src).toBe('https://x/f.pdf');
    expect(att?.attrs.name).toBe('file.pdf');

    const h2 = harness(baseDoc());
    h2.prompts.push('https://x/g.pdf', '');
    await h2.dialogs.insertAttachment();
    expect(findBlock(h2.rd, 'attachment')?.attrs.name).toBeUndefined();
  });

  it('insertAttachment 第一步取消：不再问文件名、不写文档', async () => {
    const h = harness(baseDoc());
    await h.dialogs.insertAttachment();
    expect(h.promptCalls.length).toBe(1);
    expect(findBlock(h.rd, 'attachment')).toBeUndefined();
    expect(h.log).toMatchObject({ afterEdit: 0, focus: 1 });
  });

  it('insertSeal：印章文字 trim 后插入；纯空白视为取消', async () => {
    const h = harness(baseDoc());
    h.prompts.push('  某某公司  ');
    await h.dialogs.insertSeal();
    expect(findBlock(h.rd, 'seal')?.attrs.text).toBe('某某公司');

    const h2 = harness(baseDoc());
    h2.prompts.push('   ');
    await h2.dialogs.insertSeal();
    expect(findBlock(h2.rd, 'seal')).toBeUndefined();
    expect(h2.log.afterEdit).toBe(0);
  });

  it('insertSignature：经 signatureDialog 取 PNG dataURL', async () => {
    const h = harness(baseDoc());
    h.setSignature('data:image/png;base64,abc');
    await h.dialogs.insertSignature();
    expect(findBlock(h.rd, 'signature')?.attrs.src).toBe('data:image/png;base64,abc');
    expect(h.log.announces).toEqual(['已插入电子签名']);
  });

  it('insertTextbox：无弹层直插（不抢焦点，与原 main 接线一致）', () => {
    const h = harness(baseDoc());
    h.dialogs.insertTextbox();
    expect(findBlock(h.rd, 'textbox')).toBeDefined();
    expect(h.log).toMatchObject({ afterEdit: 1, focus: 0 });
    expect(h.log.announces).toEqual(['已插入文本框']);
  });

  it('insertTable：按行列数直插并播报', () => {
    const h = harness(baseDoc());
    h.dialogs.insertTable(2, 3);
    const tbl = findBlock(h.rd, 'table');
    expect(tbl?.attrs.rows?.length).toBe(2);
    expect(tbl?.attrs.rows?.[0].length).toBe(3);
    expect(h.log.announces).toEqual(['已插入 2 行 3 列表格']);
    expect(h.log.focus).toBe(1);
  });
});

describe('editAtom（双击再编辑）', () => {
  const formulaDoc = (): Doc => ({ blocks: [para([text('p')]), block('formula', [text('')], { latex: 'a' })] });

  it('formula：弹层预填当前 latex，提交即写回（空串也允许）', async () => {
    const h = harness(formulaDoc());
    h.prompts.push('x + y');
    await h.dialogs.editAtom(1, 'formula');
    expect(h.promptCalls[0].value).toBe('a');
    expect(h.rd.doc.blocks[1].attrs.latex).toBe('x + y');
    expect(h.log.announces).toEqual(['已更新公式']);

    const h2 = harness(formulaDoc());
    h2.prompts.push('');
    await h2.dialogs.editAtom(1, 'formula');
    expect(h2.rd.doc.blocks[1].attrs.latex).toBe(''); // '' ≠ null：仍提交
  });

  it('formula 取消（null）：不写回、无播报，但仍还焦', async () => {
    const h = harness(formulaDoc());
    await h.dialogs.editAtom(1, 'formula');
    expect(h.rd.doc.blocks[1].attrs.latex).toBe('a');
    expect(h.log).toMatchObject({ afterEdit: 0, focus: 1 });
  });

  it('媒体（audio）：弹层预填当前 src，写回 attrs.src', async () => {
    const doc: Doc = { blocks: [block('audio', [text('')], { src: 'https://old.mp3' })] };
    const h = harness(doc);
    h.prompts.push('https://new.mp3');
    await h.dialogs.editAtom(0, 'audio');
    expect(h.promptCalls[0].title).toBe('编辑音频');
    expect(h.promptCalls[0].value).toBe('https://old.mp3');
    expect(h.rd.doc.blocks[0].attrs.src).toBe('https://new.mp3');
    expect(h.log.announces).toEqual(['已更新音频']);
  });

  it('seal：trim 写回；纯空白不写', async () => {
    const doc: Doc = { blocks: [block('seal', [text('')], { text: '旧章' })] };
    const h = harness(doc);
    h.prompts.push(' 新章 ');
    await h.dialogs.editAtom(0, 'seal');
    expect(h.rd.doc.blocks[0].attrs.text).toBe('新章');

    h.prompts.push('   ');
    await h.dialogs.editAtom(0, 'seal');
    expect(h.rd.doc.blocks[0].attrs.text).toBe('新章'); // 空白不覆盖
  });

  it('attachment：链接 + 文件名两段，空名写回 undefined', async () => {
    const doc: Doc = { blocks: [block('attachment', [text('')], { src: 'https://x/old.pdf', name: 'old.pdf' })] };
    const h = harness(doc);
    h.prompts.push('https://x/new.pdf', '');
    await h.dialogs.editAtom(0, 'attachment');
    expect(h.rd.doc.blocks[0].attrs.src).toBe('https://x/new.pdf');
    expect(h.rd.doc.blocks[0].attrs.name).toBeUndefined();
  });

  it('块号越界：直接返回（无弹层、无还焦），不抛错', async () => {
    const h = harness(baseDoc());
    await h.dialogs.editAtom(99, 'formula');
    expect(h.promptCalls.length).toBe(0);
    expect(h.log).toMatchObject({ afterEdit: 0, focus: 0 });
  });

  it('不支持的 kind（shape/table/textbox）：仅还焦，不弹层', async () => {
    const h = harness(baseDoc());
    await h.dialogs.editAtom(0, 'shape');
    expect(h.promptCalls.length).toBe(0);
    expect(h.log).toMatchObject({ afterEdit: 0, focus: 1 });
  });
});

describe('importDoc / saveTemplate（文档级弹层）', () => {
  it('importDoc：Markdown 文本解析后整文档替换并播报', async () => {
    const h = harness(baseDoc());
    h.prompts.push('# Hi\n\ntext');
    await h.dialogs.importDoc();
    expect(h.rd.doc.blocks[0].type).toBe('heading');
    expect(h.log.announces).toEqual(['已导入文档']);
    expect(h.log).toMatchObject({ afterEdit: 1, focus: 1 });
  });

  it('importDoc：取消或纯空白不替换文档', async () => {
    const h = harness(baseDoc());
    h.prompts.push('   \n  ');
    await h.dialogs.importDoc();
    expect(h.rd.doc.blocks[0].inlines[0].text).toBe('hello');
    expect(h.log.afterEdit).toBe(0);
  });

  it('saveTemplate：trim 名称保存到用户模板并播报；取消不保存', async () => {
    // node 无 localStorage：装最小内存垫片（与 templates.test.ts 同法）
    const g = globalThis as unknown as { localStorage?: Storage };
    if (!g.localStorage) {
      const store = new Map<string, string>();
      g.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: () => null,
        get length() { return store.size; },
      } as Storage;
    }
    g.localStorage!.removeItem(USER_TEMPLATES_KEY);

    const h = harness(baseDoc());
    h.prompts.push('  我的模板  ');
    await h.dialogs.saveTemplate();
    expect(loadUserTemplates().map((t) => t.name)).toContain('我的模板');
    expect(h.log.announces).toEqual(['已保存模板：我的模板']);
    expect(h.log.afterEdit).toBe(0); // 不改文档

    const h2 = harness(baseDoc());
    await h2.dialogs.saveTemplate();
    expect(h2.log.announces).toEqual([]);
    expect(h2.log.focus).toBe(1);
    g.localStorage!.removeItem(USER_TEMPLATES_KEY);
  });
});
