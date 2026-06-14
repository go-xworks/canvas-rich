import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BUILTIN_TEMPLATES, GOV_RED, loadUserTemplates, saveUserTemplate,
  userTemplateToDocTemplate, USER_TEMPLATES_KEY,
} from '../templates';
import { Doc, BlockType, getMark, blockTextLen } from '../schema';
import { isAtom } from '../block-specs';

// 合法 Doc 判定：至少一块、每块类型已注册、每块至少一个 inline（block() 不变量）、
// 非原子块文本块的 inline 均为 text run。
const KNOWN_TYPES: BlockType[] = [
  'paragraph', 'heading', 'bullet_item', 'ordered_item', 'task_item',
  'blockquote', 'code_block', 'image', 'formula', 'table', 'toc', 'shape',
];
function expectValidDoc(d: Doc): void {
  expect(d.blocks.length).toBeGreaterThan(0);
  for (const b of d.blocks) {
    expect(KNOWN_TYPES).toContain(b.type);
    expect(b.inlines.length).toBeGreaterThan(0);
    for (const inl of b.inlines) expect(inl.kind).toBe('text');
    if (b.type === 'heading') expect(typeof b.attrs.level).toBe('number');
  }
}

describe('内置模板 build() 产出合法 Doc', () => {
  it('四种内置模板齐备且名称唯一', () => {
    const names = BUILTIN_TEMPLATES.map((t) => t.name);
    expect(names).toEqual(['空白', '红头文件', '会议纪要', '简历']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每个模板 build() 都是合法 Doc 且每次返回新对象', () => {
    for (const tpl of BUILTIN_TEMPLATES) {
      const a = tpl.build();
      const b = tpl.build();
      expectValidDoc(a);
      expect(a).not.toBe(b);            // 新对象，互不共享引用
      expect(a.blocks).not.toBe(b.blocks);
    }
  });

  it('空白模板：单个空段落', () => {
    const d = BUILTIN_TEMPLATES[0].build();
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0].type).toBe('paragraph');
    expect(blockTextLen(d.blocks[0])).toBe(0);
  });

  it('红头文件：居中红色 H1 标题 + 含居右落款/日期', () => {
    const d = BUILTIN_TEMPLATES[1].build();
    const head = d.blocks[0];
    expect(head.type).toBe('heading');
    expect(head.attrs.level).toBe(1);
    expect(head.attrs.align).toBe('center');
    // 标题文字带红色 color mark
    const colorMark = getMark(head.inlines[0].marks, 'color');
    expect(colorMark?.attrs?.color).toBe(GOV_RED);
    // 至少有两个居右块（落款 + 日期）
    const rightCount = d.blocks.filter((b) => b.attrs.align === 'right').length;
    expect(rightCount).toBeGreaterThanOrEqual(2);
  });

  it('会议纪要：含居中 H1 + 列表项', () => {
    const d = BUILTIN_TEMPLATES[2].build();
    expect(d.blocks[0].type).toBe('heading');
    expect(d.blocks.some((b) => b.type === 'bullet_item')).toBe(true);
    expect(d.blocks.some((b) => b.type === 'ordered_item')).toBe(true);
  });

  it('简历：含 H1 + 多个 H2 分节 + 列表', () => {
    const d = BUILTIN_TEMPLATES[3].build();
    expect(d.blocks[0].type).toBe('heading');
    expect(d.blocks.filter((b) => b.type === 'heading' && b.attrs.level === 2).length).toBeGreaterThanOrEqual(3);
    expect(d.blocks.some((b) => b.type === 'bullet_item')).toBe(true);
  });
});

// node 环境无 localStorage：装一个最小内存 Storage 垫片，真实跑通持久化逻辑。
function ensureLocalStorage(): void {
  const g = globalThis as unknown as { localStorage?: Storage };
  if (g.localStorage) return;
  const mem = new Map<string, string>();
  g.localStorage = {
    get length() { return mem.size; },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
  } as Storage;
}

describe('用户模板存取（localStorage）', () => {
  beforeEach(() => { ensureLocalStorage(); try { localStorage.removeItem(USER_TEMPLATES_KEY); } catch { /* no ls */ } });

  it('保存后可读回，同名覆盖', () => {
    const doc1: Doc = { blocks: [{ type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'A', marks: [] }] }] };
    const doc2: Doc = { blocks: [{ type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'B', marks: [] }] }] };
    saveUserTemplate('我的模板', doc1);
    let list = loadUserTemplates();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('我的模板');
    expect(list[0].doc.blocks[0].inlines[0].text).toBe('A');
    // 同名覆盖
    list = saveUserTemplate('我的模板', doc2);
    expect(list).toHaveLength(1);
    expect(loadUserTemplates()[0].doc.blocks[0].inlines[0].text).toBe('B');
  });

  it('损坏的存储内容回退为空数组', () => {
    try {
      localStorage.setItem(USER_TEMPLATES_KEY, '{not json');
      expect(loadUserTemplates()).toEqual([]);
      localStorage.setItem(USER_TEMPLATES_KEY, '{"a":1}'); // 非数组
      expect(loadUserTemplates()).toEqual([]);
    } catch { /* 无 localStorage 环境跳过 */ }
  });

  it('userTemplateToDocTemplate 转换出可 build 的 DocTemplate', () => {
    const doc: Doc = { blocks: [{ type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'Z', marks: [] }] }] };
    const dt = userTemplateToDocTemplate({ name: 'T', doc });
    expect(dt.name).toBe('T');
    expectValidDoc(dt.build());
    expect(dt.build().blocks[0].inlines[0].text).toBe('Z');
  });
});

describe('shape 块类型已注册为原子', () => {
  it('isAtom(shape) === true', () => {
    expect(isAtom('shape')).toBe(true);
  });
});

// 用户模板反序列化逐块校验（防被篡改/跨版本损坏的条目使 applyTemplate→cloneDoc 崩溃）。
describe('用户模板反序列化逐块校验', () => {
  beforeEach(() => { ensureLocalStorage(); try { localStorage.removeItem(USER_TEMPLATES_KEY); } catch { /* no ls */ } });

  const VALID_BLOCK = { type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'ok', marks: [] }] };

  it('被篡改的畸形块被剔除（warn），合法块保留；cloneDoc 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify([{
        name: 'T',
        doc: {
          blocks: [
            VALID_BLOCK,
            { type: 'paragraph', attrs: {} },                          // 缺 inlines → cloneDoc 原会 TypeError
            { type: 'evil', attrs: {}, inlines: [] },                  // 未注册类型
            { type: 'paragraph', attrs: 'x', inlines: [] },            // attrs 非对象
            { type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 1 }] }, // 行内畸形
            { type: 'table', attrs: { rows: [['no-cell']] }, inlines: [] },         // rows 畸形
          ],
        },
      }]));
      const list = loadUserTemplates();
      expect(list).toHaveLength(1);
      expect(list[0].doc.blocks).toHaveLength(1);
      expect(list[0].doc.blocks[0].inlines[0].text).toBe('ok');
      expect(warn).toHaveBeenCalled();
      // applyTemplate 链路核心（replaceDoc→cloneDoc）对清洗后的 doc 不抛
      const { cloneDoc } = await import('../schema');
      expect(() => cloneDoc(list[0].doc)).not.toThrow();
    } finally { warn.mockRestore(); }
  });

  it('全部块畸形的条目整条跳过（warn）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify([
        { name: '坏', doc: { blocks: [{ type: 'paragraph' }] } },
        { name: '好', doc: { blocks: [VALID_BLOCK] } },
      ]));
      const list = loadUserTemplates();
      expect(list.map((t) => t.name)).toEqual(['好']);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('条目级畸形（name 非串 / doc 非对象 / blocks 非数组）静默跳过', () => {
    localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify([
      null, 42, { name: 7, doc: { blocks: [VALID_BLOCK] } },
      { name: 'x', doc: 'nope' }, { name: 'y', doc: { blocks: 'nope' } },
      { name: 'z', doc: { blocks: [VALID_BLOCK] } },
    ]));
    const list = loadUserTemplates();
    expect(list.map((t) => t.name)).toEqual(['z']);
  });

  it('合法块的空 inlines 补空文本段（block 不变量，光标可承载）', () => {
    localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify([{
      name: 'E', doc: { blocks: [{ type: 'paragraph', attrs: {}, inlines: [] }] },
    }]));
    const list = loadUserTemplates();
    expect(list[0].doc.blocks[0].inlines).toHaveLength(1);
    expect(list[0].doc.blocks[0].inlines[0].text).toBe('');
  });
});
