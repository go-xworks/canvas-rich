import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DRAFT_KEY, DRAFT_DEBOUNCE_MS, serializeDraft, parseDraft, loadDraft, saveDraft, clearDraft, createAutosaver,
} from '../persistence';
import { Doc, para, text, block, cell } from '../schema';
import type { Pos } from '../rich-document';

// 文档草稿持久化：序列化/反序列化 round-trip、损坏 JSON 安全回退、配额降级、防抖调度器。

// node 环境无 localStorage：装一个最小内存 Storage 垫片（同 templates.test 模式）。
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

const sampleDoc = (): Doc => ({
  blocks: [
    block('heading', [text('标题', [{ type: 'bold' }])], { level: 2 }),
    para([text('正文', [{ type: 'color', attrs: { color: '#ff0000' } }])]),
    block('table', [text('')], { rows: [[cell('a'), cell('b')], [cell(''), cell('d')]] }),
  ],
});
const A: Pos = { block: 1, offset: 1 };
const F: Pos = { block: 1, offset: 2 };

describe('serializeDraft / parseDraft round-trip', () => {
  it('doc + 选区 + savedAt 完整往返（深结构等价）', () => {
    const doc = sampleDoc();
    const d = parseDraft(serializeDraft(doc, A, F, 1234));
    expect(d).not.toBeNull();
    expect(d!.doc).toEqual(doc);
    expect(d!.anchor).toEqual(A);
    expect(d!.focus).toEqual(F);
    expect(d!.savedAt).toBe(1234);
  });

  it('损坏 JSON / 非对象 / 无 blocks → null（安全回退）', () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('')).toBeNull();
    expect(parseDraft('{not json')).toBeNull();
    expect(parseDraft('42')).toBeNull();
    expect(parseDraft('[]')).toBeNull();
    expect(parseDraft('{"doc":{"blocks":"oops"}}')).toBeNull();
    expect(parseDraft('{"doc":{"blocks":[]}}')).toBeNull(); // 空文档草稿无意义 → 回退演示文档
  });

  it('畸形块被剔除（warn）、合法块保留；全部畸形 → null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const raw = JSON.stringify({
        doc: {
          blocks: [
            { type: 'paragraph', attrs: {}, inlines: [{ kind: 'text', text: 'ok', marks: [] }] },
            { type: 'nope', attrs: {}, inlines: [] },                  // 未注册类型
            { type: 'paragraph', attrs: {} },                          // 缺 inlines
            { type: 'paragraph', attrs: null, inlines: [] },           // attrs 非对象
            { type: 'table', attrs: { rows: 'broken' }, inlines: [] }, // rows 畸形
          ],
        },
        anchor: A, focus: F, savedAt: 1,
      });
      const d = parseDraft(raw);
      expect(d!.doc.blocks).toHaveLength(1);
      expect(d!.doc.blocks[0].inlines[0].text).toBe('ok');
      expect(warn).toHaveBeenCalled();

      const allBad = JSON.stringify({ doc: { blocks: [{ type: 'x' }] }, anchor: A, focus: F });
      expect(parseDraft(allBad)).toBeNull();
    } finally { warn.mockRestore(); }
  });

  it('选区端点畸形 → 回退文首 {0,0}', () => {
    const raw = JSON.stringify({ doc: sampleDoc(), anchor: { block: 'x' }, focus: null });
    const d = parseDraft(raw);
    expect(d!.anchor).toEqual({ block: 0, offset: 0 });
    expect(d!.focus).toEqual({ block: 0, offset: 0 });
  });

  it('合法块的空 inlines 补一个空文本段（block 不变量）', () => {
    const raw = JSON.stringify({ doc: { blocks: [{ type: 'paragraph', attrs: {}, inlines: [] }] }, anchor: A, focus: F });
    const d = parseDraft(raw);
    expect(d!.doc.blocks[0].inlines).toHaveLength(1);
    expect(d!.doc.blocks[0].inlines[0].text).toBe('');
  });
});

describe('saveDraft / loadDraft / clearDraft（localStorage）', () => {
  beforeEach(() => { ensureLocalStorage(); clearDraft(); });

  it('保存后可恢复（round-trip 经真实存储）', () => {
    const doc = sampleDoc();
    expect(saveDraft(doc, A, F)).toBe(true);
    const d = loadDraft();
    expect(d!.doc).toEqual(doc);
    expect(d!.anchor).toEqual(A);
    expect(d!.focus).toEqual(F);
  });

  it('无草稿 → null；clearDraft 后 → null', () => {
    expect(loadDraft()).toBeNull();
    saveDraft(sampleDoc(), A, F);
    clearDraft();
    expect(loadDraft()).toBeNull();
  });

  it('存储内容被破坏 → loadDraft 安全回退 null', () => {
    localStorage.setItem(DRAFT_KEY, '{broken');
    expect(loadDraft()).toBeNull();
  });

  it('写入抛出（QuotaExceeded）→ 降级跳过：console.warn + 返回 false，不抛出', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 直接替换实例方法模拟配额错误（垫片/浏览器实例均适用）
    const store = localStorage;
    const orig = store.setItem.bind(store);
    store.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      expect(saveDraft(sampleDoc(), A, F)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      store.setItem = orig;
      warn.mockRestore();
    }
  });
});

describe('createAutosaver（防抖调度器）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('schedule 标脏；静默 DRAFT_DEBOUNCE_MS 后落盘一次并复位脏标记', () => {
    const persist = vi.fn(() => true);
    const states: boolean[] = [];
    const saver = createAutosaver(persist, (d) => states.push(d));
    saver.schedule();
    expect(saver.dirty).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(saver.dirty).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('窗内连续 schedule 防抖合并为一次落盘', () => {
    const persist = vi.fn(() => true);
    const saver = createAutosaver(persist);
    saver.schedule();
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 100);
    saver.schedule(); // 重置计时
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 100);
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flush 立即落盘并取消待定计时；干净时 flush 恒 true 且不落盘', () => {
    const persist = vi.fn(() => true);
    const saver = createAutosaver(persist);
    expect(saver.flush()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    saver.schedule();
    expect(saver.flush()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2);
    expect(persist).toHaveBeenCalledTimes(1); // 计时已取消，无第二次
  });

  it('persist 失败（配额）→ 保持脏标记，flush 返回 false', () => {
    const persist = vi.fn(() => false);
    const saver = createAutosaver(persist);
    saver.schedule();
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect(saver.dirty).toBe(true);  // 落盘失败：仍脏
    expect(saver.flush()).toBe(false);
  });
});
